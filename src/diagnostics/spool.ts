/**
 * Durable, bounded spool for remote diagnostics.
 *
 * One bundle per directory; `receipt.json` is the state machine and is written
 * atomically. A single-consumer lease prevents two TUI processes from uploading
 * the same bundle. Entries are bound to a destination fingerprint so changing
 * the endpoint or credential pins can never auto-send an old queue to a new
 * destination.
 */
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import {
  DiagnosticsError,
  RECEIPT_SCHEMA,
  type DiagnosticReceipt,
  type DiagnosticsConfig,
  type PreparedBundle,
  type RemoteLocator,
} from './types.js'
import { canonicalJson, sha256Hex } from './crypto.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const MAX_RECEIPT_BYTES = 64 * 1024

export interface Lease {
  owner: string
  expiresAt: number
  path: string
}

export interface SpoolEntry {
  bundleId: string
  dir: string
  receipt: DiagnosticReceipt
}

export interface SpoolOptions {
  now?: () => number
  random?: () => number
  leaseTtlMs?: number
}

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE })
  try {
    await chmod(path, DIR_MODE)
  } catch {
    // Windows has advisory modes; the directory ACL is the real boundary there.
  }
}

export async function writeAtomic(path: string, data: Buffer | string, mode = FILE_MODE): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    if (process.platform === 'win32') {
      // Windows cannot atomically replace an existing file with rename(); remove
      // the old receipt first. The write is still single-consumer (lease).
      await rm(path, { force: true })
    }
    await rename(tmp, path)
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(tmp).catch(() => {})
    throw error instanceof DiagnosticsError ? error : new DiagnosticsError('SPOOL_FAILED', { cause: error })
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeAtomic(path, `${canonicalJson(value)}\n`)
}

function isReceipt(value: unknown): value is DiagnosticReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.schema === RECEIPT_SCHEMA &&
    typeof record.bundleId === 'string' &&
    typeof record.state === 'string' &&
    typeof record.destinationFingerprint === 'string'
}

function validateReceipt(receipt: DiagnosticReceipt): void {
  if (receipt.schema !== RECEIPT_SCHEMA) throw new DiagnosticsError('SPOOL_FAILED')
  if (typeof receipt.bundleId !== 'string' || !/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(receipt.bundleId)) {
    throw new DiagnosticsError('SPOOL_FAILED')
  }
  const states = [
    'pending', 'uploading', 'uploaded', 'verified', 'envelope-verified', 'retry', 'blocked',
    'abandoned', 'destination-changed', 'disabled',
  ]
  if (!states.includes(receipt.state)) throw new DiagnosticsError('SPOOL_FAILED')
  if (!Number.isSafeInteger(receipt.attempts) || receipt.attempts < 0 || receipt.attempts > 100) {
    throw new DiagnosticsError('SPOOL_FAILED')
  }
  if (Buffer.byteLength(canonicalJson(receipt), 'utf8') > MAX_RECEIPT_BYTES) throw new DiagnosticsError('SPOOL_FAILED')
}

export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.min(4, attempt - 1))
  const base = Math.min(16_000, 1_000 * 2 ** exponent)
  return base + Math.floor(random() * Math.min(1_000, Math.floor(base / 2) + 1))
}

export class SpoolStore {
  readonly rootDir: string
  private readonly now: () => number
  private readonly random: () => number
  private readonly leaseTtlMs: number
  private readonly leasePath: string
  private readonly ratePath: string

  constructor(rootDir: string, options: SpoolOptions = {}) {
    this.rootDir = rootDir
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.leaseTtlMs = options.leaseTtlMs ?? 60_000
    this.leasePath = join(rootDir, '.lease.json')
    this.ratePath = join(rootDir, '.rate.json')
  }

  async init(): Promise<void> {
    await ensureDir(this.rootDir)
  }

  entryDir(bundleId: string): string {
    if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(bundleId)) throw new DiagnosticsError('SPOOL_FAILED')
    return join(this.rootDir, bundleId)
  }

  async enqueue(bundle: PreparedBundle, config: DiagnosticsConfig, originalExitCode: number | null): Promise<DiagnosticReceipt> {
    await this.init()
    const dir = this.entryDir(bundle.bundleId)
    try {
      await mkdir(dir, { mode: DIR_MODE })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DiagnosticsError('SPOOL_FAILED')
      throw new DiagnosticsError('SPOOL_FAILED', { cause: error })
    }
    await chmod(dir, DIR_MODE).catch(() => {})
    const nowIso = new Date(this.now()).toISOString()
    const receipt: DiagnosticReceipt = {
      schema: RECEIPT_SCHEMA,
      bundleId: bundle.bundleId,
      sourceSha: config.sourceSha ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
      state: 'pending',
      attempts: 0,
      nextRetryAt: this.now(),
      errorClass: null,
      destinationFingerprint: config.destinationFingerprint,
      originalExitCode,
      redaction: bundle.manifest.redaction,
      remote: null,
      verifiedAt: null,
    }
    validateReceipt(receipt)
    await writeAtomic(join(dir, 'bundle.tar.gz'), bundle.archive)
    await writeAtomic(join(dir, 'manifest.json'), `${canonicalJson(bundle.manifest)}\n`)
    await writeAtomic(join(dir, 'envelope.bin'), bundle.envelope)
    await writeAtomic(join(dir, 'receipt.json'), `${canonicalJson(receipt)}\n`)
    return receipt
  }

  async list(): Promise<SpoolEntry[]> {
    await this.init()
    let names: string[]
    try {
      names = await readdir(this.rootDir)
    } catch {
      return []
    }
    const entries: SpoolEntry[] = []
    for (const name of names.sort()) {
      if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(name)) continue
      try {
        const entry = await this.read(name)
        if (entry !== undefined) entries.push(entry)
      } catch {
        // A corrupt entry is left alone for the owner to inspect; it must never
        // crash a TUI startup.
      }
    }
    return entries
  }

  async read(bundleId: string): Promise<SpoolEntry | undefined> {
    const dir = this.entryDir(bundleId)
    const info = await lstat(dir).catch(() => undefined)
    if (info === undefined || !info.isDirectory() || info.isSymbolicLink()) return undefined
    const raw = await readFile(join(dir, 'receipt.json'), 'utf8').catch(() => undefined)
    if (raw === undefined) return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new DiagnosticsError('SPOOL_FAILED')
    }
    if (!isReceipt(parsed)) throw new DiagnosticsError('SPOOL_FAILED')
    validateReceipt(parsed)
    return { bundleId, dir, receipt: parsed }
  }

  async update(receipt: DiagnosticReceipt): Promise<void> {
    validateReceipt(receipt)
    const dir = this.entryDir(receipt.bundleId)
    await writeJson(join(dir, 'receipt.json'), receipt)
  }

  async readArtifact(bundleId: string, name: 'bundle.tar.gz' | 'manifest.json' | 'envelope.bin'): Promise<Buffer> {
    const dir = this.entryDir(bundleId)
    try {
      return await readFile(join(dir, name))
    } catch (error) {
      throw new DiagnosticsError('SPOOL_FAILED', { cause: error })
    }
  }

  async acquireLease(owner: string = randomBytes(12).toString('hex')): Promise<Lease | undefined> {
    await this.init()
    const expiresAt = this.now() + this.leaseTtlMs
    const body = `${canonicalJson({ owner, expiresAt })}\n`
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(this.leasePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, FILE_MODE)
        try {
          await handle.writeFile(body)
          await handle.sync()
        } finally {
          await handle.close()
        }
        return { owner, expiresAt, path: this.leasePath }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new DiagnosticsError('SPOOL_FAILED', { cause: error })
        }
        const existing = await this.readLease()
        if (existing !== undefined && existing.expiresAt > this.now()) return undefined
        await unlink(this.leasePath).catch(() => {})
      }
    }
    return undefined
  }

  async readLease(): Promise<{ owner: string; expiresAt: number } | undefined> {
    try {
      const raw = await readFile(this.leasePath, 'utf8')
      const parsed = JSON.parse(raw) as { owner?: unknown; expiresAt?: unknown }
      if (typeof parsed.owner !== 'string' || typeof parsed.expiresAt !== 'number') return undefined
      return { owner: parsed.owner, expiresAt: parsed.expiresAt }
    } catch {
      return undefined
    }
  }

  async releaseLease(lease: Lease): Promise<void> {
    const current = await this.readLease()
    if (current?.owner === lease.owner) await unlink(this.leasePath).catch(() => {})
  }

  /**
   * Rate limit: one automatic upload per instance per five minutes and at most
   * three per hour globally. Only timestamps and a random instance id are kept.
   */
  async rateLimitAllowed(instanceId: string): Promise<boolean> {
    await this.init()
    const now = this.now()
    let state: { global: number[]; instances: Record<string, number[]> } = { global: [], instances: {} }
    try {
      const raw = JSON.parse(await readFile(this.ratePath, 'utf8')) as Partial<typeof state>
      if (Array.isArray(raw.global)) {
        state = {
          global: raw.global,
          instances: raw.instances !== null && typeof raw.instances === 'object' ? raw.instances : {},
        }
      }
    } catch {
      // First run.
    }
    state.global = state.global.filter((timestamp) => Number.isFinite(timestamp) && now - timestamp < 3_600_000)
    for (const [key, values] of Object.entries(state.instances)) {
      state.instances[key] = Array.isArray(values) ? values.filter((timestamp) => now - timestamp < 300_000) : []
      if (state.instances[key].length === 0) delete state.instances[key]
    }
    const instance = state.instances[instanceId] ?? []
    if (state.global.length >= 3 || instance.length >= 1) {
      await writeJson(this.ratePath, state)
      return false
    }
    state.global.push(now)
    state.instances[instanceId] = [...instance, now]
    await writeJson(this.ratePath, state)
    return true
  }

  async due(config: DiagnosticsConfig): Promise<SpoolEntry[]> {
    const now = this.now()
    const due: SpoolEntry[] = []
    for (const entry of await this.list()) {
      if (entry.receipt.destinationFingerprint !== config.destinationFingerprint) {
        entry.receipt.state = 'destination-changed'
        entry.receipt.errorClass = 'DESTINATION_CHANGED'
        entry.receipt.nextRetryAt = null
        entry.receipt.updatedAt = new Date(now).toISOString()
        await this.update(entry.receipt)
        continue
      }
      if (!['pending', 'retry', 'uploading'].includes(entry.receipt.state)) continue
      if (now - Date.parse(entry.receipt.createdAt) > 7 * 24 * 60 * 60 * 1000) {
        entry.receipt.state = 'abandoned'
        entry.receipt.errorClass = 'EXPIRED'
        entry.receipt.nextRetryAt = null
        entry.receipt.updatedAt = new Date(now).toISOString()
        await this.update(entry.receipt)
        continue
      }
      if (entry.receipt.nextRetryAt !== null && entry.receipt.nextRetryAt > now) continue
      due.push(entry)
    }
    return due
  }

  async markAttempt(
    receipt: DiagnosticReceipt,
    config: DiagnosticsConfig,
    error: DiagnosticsError,
    options: { retryable?: boolean } = {},
  ): Promise<DiagnosticReceipt> {
    const now = this.now()
    receipt.attempts += 1
    receipt.errorClass = error.code
    receipt.updatedAt = new Date(now).toISOString()
    const retryable = options.retryable ?? error.retryable
    if (retryable && receipt.attempts < config.maxAttempts) {
      receipt.state = 'retry'
      receipt.nextRetryAt = now + backoffMs(receipt.attempts, this.random)
    } else if (retryable) {
      receipt.state = 'abandoned'
      receipt.nextRetryAt = null
    } else {
      receipt.state = 'blocked'
      receipt.nextRetryAt = null
    }
    await this.update(receipt)
    return receipt
  }

  async markVerified(receipt: DiagnosticReceipt, remote: RemoteLocator): Promise<DiagnosticReceipt> {
    receipt.state = 'verified'
    receipt.errorClass = null
    receipt.remote = remote
    receipt.verifiedAt = new Date(this.now()).toISOString()
    receipt.updatedAt = receipt.verifiedAt
    receipt.nextRetryAt = null
    await this.update(receipt)
    return receipt
  }

  async markUploaded(receipt: DiagnosticReceipt, remote: RemoteLocator): Promise<DiagnosticReceipt> {
    receipt.state = 'uploaded'
    receipt.errorClass = null
    receipt.remote = remote
    receipt.updatedAt = new Date(this.now()).toISOString()
    await this.update(receipt)
    return receipt
  }

  async markDisabled(receipt: DiagnosticReceipt): Promise<DiagnosticReceipt> {
    receipt.state = 'disabled'
    receipt.nextRetryAt = null
    receipt.updatedAt = new Date(this.now()).toISOString()
    await this.update(receipt)
    return receipt
  }

  async purge(): Promise<void> {
    const resolved = this.rootDir
    const base = basename(resolved)
    const parent = basename(dirname(resolved))
    const inTmp = resolved.startsWith(`${tmpdir()}${sep}`)
    if (base !== 'spool' || (parent !== 'tui-diagnostics' && !inTmp)) {
      throw new DiagnosticsError('SPOOL_FAILED')
    }
    await rm(resolved, { recursive: true, force: true })
  }

  async stats(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {}
    for (const entry of await this.list()) {
      counts[entry.receipt.state] = (counts[entry.receipt.state] ?? 0) + 1
    }
    return counts
  }
}

/** Write the verified local copy next to the spool. */
export async function writeVerifiedCopy(
  verifiedDir: string,
  bundleId: string,
  files: { archive?: Buffer; manifest: string; envelope: Buffer; receipt: DiagnosticReceipt },
): Promise<string> {
  if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(bundleId)) throw new DiagnosticsError('SPOOL_FAILED')
  const dir = join(verifiedDir, bundleId)
  await ensureDir(verifiedDir)
  await ensureDir(dir)
  if (files.archive !== undefined) await writeAtomic(join(dir, 'bundle.tar.gz'), files.archive)
  await writeAtomic(join(dir, 'manifest.json'), files.manifest)
  await writeAtomic(join(dir, 'envelope.bin'), files.envelope)
  await writeAtomic(join(dir, 'receipt.json'), `${canonicalJson(files.receipt)}\n`)
  return dir
}

export function receiptDigest(receipt: DiagnosticReceipt): string {
  return sha256Hex(canonicalJson(receipt))
}

