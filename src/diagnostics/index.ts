/**
 * Public entry points for failure-diagnostics handoff.
 *
 * `publishDiagnosticFailure` is the automatic path used by the TUI/boot code.
 * It is a no-op unless the operator explicitly enabled diagnostics, and it
 * never changes the original failure exit code. `fetchDiagnosticBundle` is the
 * download/verify path shared by the CLI and CI.
 */
import { randomBytes } from 'node:crypto'
import { createPublicKey, type KeyObject } from 'node:crypto'
import {
  loadDiagnosticsConfig,
  describeDiagnosticsConfig,
  type ResolveOptions,
} from './config.js'
import {
  DiagnosticsError,
  type DiagnosticPhase,
  type DiagnosticReceipt,
  type DiagnosticsConfig,
  type DiagnosticsManifest,
  type FailureContext,
  type PreparedBundle,
} from './types.js'
import {
  canonicalJson,
  inspectEnvelope,
  parsePrivateKey,
  parsePublicKey,
  publicKeyId,
  sha256Hex,
  verifyEnvelopeBinding,
} from './crypto.js'
import { prepareBundle, validateManifest, verifyEncryptedBundle, verifyManifestSignature } from './bundle.js'
import { SpoolStore, writeVerifiedCopy } from './spool.js'
import { DiagnosticsTransport } from './transport.js'

const DEDUP_WINDOW_MS = 5_000
let instanceId = randomBytes(8).toString('hex')

export interface PublishOptions {
  config?: DiagnosticsConfig
  env?: NodeJS.ProcessEnv
  home?: string
  now?: number
  random?: () => number
  /** Bound the foreground wait; the spool continues in the background. */
  maxWaitMs?: number
  spool?: SpoolStore
  transport?: DiagnosticsTransport
  clientInstanceId?: string
  dedupe?: boolean
  skipRateLimit?: boolean
}

export interface PublishResult {
  state: 'disabled' | 'blocked' | 'queued' | 'uploaded' | 'verified' | 'failed'
  receipt?: DiagnosticReceipt
  errorClass?: string
}

export interface DrainOptions {
  config?: DiagnosticsConfig
  env?: NodeJS.ProcessEnv
  home?: string
  now?: number
  random?: () => number
  spool?: SpoolStore
  transport?: DiagnosticsTransport
  maxEntries?: number
}

export interface FetchOptions {
  config?: DiagnosticsConfig
  env?: NodeJS.ProcessEnv
  home?: string
  transport?: DiagnosticsTransport
  spool?: SpoolStore
  /** Independent expected digest from a trusted channel (reviewer/CI). */
  expectedEnvelopeSha256?: string
  expectedManifestSha256?: string
}

export interface FetchResult {
  state: 'verified' | 'envelope-verified'
  manifest: DiagnosticsManifest
  exitCode: number | null
  manifestSha256: string
  envelopeSha256: string
  verifiedContent: boolean
  verifiedDir: string
}

export interface StatusResult {
  config: Record<string, unknown>
  spool: Record<string, number>
}

export function resetDiagnosticsStateForTests(options: { instanceId?: string } = {}): void {
  instanceId = options.instanceId ?? randomBytes(8).toString('hex')
}

/** Stable identity for one failure signature; the observed time is not part of it. */
export function failureIdentity(context: FailureContext, config: DiagnosticsConfig): string {
  const incidentId = typeof context.incidentId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(context.incidentId)
    ? context.incidentId
    : null
  return sha256Hex(canonicalJson({
    schema: 'dsh-ssh-tui/diagnostics-failure/v1',
    kind: context.kind,
    failureCode: context.failureCode,
    phase: context.phase,
    exitCode: context.exitCode,
    incidentId,
    sourceSha: config.sourceSha ?? null,
    problemClasses: [...new Set(context.problemClasses ?? [])].sort(),
    ci: context.ci === undefined
      ? null
      : { runId: context.ci.runId, jobId: context.ci.jobId, attempt: context.ci.attempt },
  }))
}

function receiptDedupable(receipt: DiagnosticReceipt, now: number): boolean {
  if (receipt.state === 'pending' || receipt.state === 'retry' || receipt.state === 'uploading') return true
  return now - Date.parse(receipt.updatedAt) < DEDUP_WINDOW_MS
}

function dedupedResult(receipt: DiagnosticReceipt): PublishResult {
  const state = receipt.state === 'verified'
    ? 'verified'
    : receipt.state === 'uploaded' || receipt.state === 'envelope-verified'
      ? 'uploaded'
      : receipt.state === 'pending' || receipt.state === 'retry' || receipt.state === 'uploading'
        ? 'queued'
        : receipt.state === 'disabled'
          ? 'disabled'
          : 'failed'
  return { state, receipt, errorClass: 'DEDUPED' }
}

/** Public key used to verify the sender's manifest and envelope binding. */
export function manifestVerificationKey(config: DiagnosticsConfig): KeyObject {
  if (config.clientEd25519PublicKey !== undefined && config.clientEd25519PublicKey.trim() !== '') {
    return parsePublicKey(config.clientEd25519PublicKey, 'ed25519')
  }
  if (config.clientEd25519KeyPem !== undefined) {
    return createPublicKey(parsePrivateKey(config.clientEd25519KeyPem, 'ed25519'))
  }
  throw new DiagnosticsError('CONFIG_INVALID')
}

function asDiagnosticsError(error: unknown): DiagnosticsError {
  if (error instanceof DiagnosticsError) return error
  return new DiagnosticsError('NETWORK', { retryable: true, cause: error })
}

async function makeConfig(options: {
  config?: DiagnosticsConfig
  env?: NodeJS.ProcessEnv
  home?: string
}): Promise<DiagnosticsConfig> {
  if (options.config !== undefined) return options.config
  return await loadDiagnosticsConfig({ env: options.env, home: options.home } satisfies ResolveOptions)
}

async function prepare(
  context: FailureContext,
  config: DiagnosticsConfig,
): Promise<PreparedBundle> {
  if (config.clientEd25519KeyPem === undefined) throw new DiagnosticsError('CONFIG_INVALID')
  const signingKey = parsePrivateKey(config.clientEd25519KeyPem, 'ed25519')
  const recipientPublicKey = parsePublicKey(config.recipientX25519PublicKey, 'x25519')
  return prepareBundle({
    context,
    signingKey,
    recipientPublicKey,
    maxBundleBytes: config.maxBundleBytes,
    maxFileBytes: config.maxFileBytes,
    maxTotalBytes: config.maxTotalBytes,
    toolVersion: config.toolVersion ?? '0.0.0',
    sourceSha: config.sourceSha ?? null,
    ...(context.observedAt === undefined ? {} : { now: context.observedAt }),
  })
}

async function executeUpload(
  prepared: PreparedBundle,
  receipt: DiagnosticReceipt,
  config: DiagnosticsConfig,
  spool: SpoolStore,
  transport: DiagnosticsTransport,
): Promise<PublishResult> {
  try {
    const result = await transport.upload(prepared)
    const verifiedReceipt = await spool.markVerified(receipt, result.remote)
    await writeVerifiedCopy(config.verifiedDir, prepared.bundleId, {
      archive: prepared.archive,
      manifest: canonicalJson(prepared.manifest),
      envelope: prepared.envelope,
      receipt: verifiedReceipt,
    }, { maxEntries: config.maxSpoolEntries, maxBytes: config.maxSpoolBytes })
    return { state: 'verified', receipt: verifiedReceipt }
  } catch (error) {
    const mapped = asDiagnosticsError(error)
    const updated = await spool.markAttempt(receipt, config, mapped)
    return {
      state: updated.state === 'uploaded' ? 'uploaded' : mapped.retryable ? 'queued' : 'failed',
      receipt: updated,
      errorClass: mapped.code,
    }
  }
}

export async function publishDiagnosticFailure(
  context: FailureContext,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const now = options.now ?? context.observedAt ?? Date.now()
  let config: DiagnosticsConfig
  try {
    config = await makeConfig(options)
  } catch (error) {
    return { state: 'blocked', errorClass: asDiagnosticsError(error).code }
  }
  if (!config.enabled) return { state: 'disabled' }

  const failureId = failureIdentity(context, config)
  const spool = options.spool ?? new SpoolStore(config.spoolDir, { now: () => now, random: options.random })
  try {
    const existing = await spool.findByFailureId(failureId, config)
    if (existing !== undefined && receiptDedupable(existing.receipt, now)) {
      return dedupedResult(existing.receipt)
    }
  } catch {
    // A corrupt entry must not stop a new capture; enqueue re-validates under lock.
  }

  let prepared: PreparedBundle
  try {
    prepared = await prepare(context, config)
  } catch (error) {
    const mapped = asDiagnosticsError(error)
    return { state: 'blocked', errorClass: mapped.code }
  }

  let receipt: DiagnosticReceipt
  try {
    receipt = await spool.enqueue(prepared, config, context.exitCode, failureId)
  } catch (error) {
    return { state: 'blocked', errorClass: asDiagnosticsError(error).code }
  }
  if (receipt.bundleId !== prepared.bundleId) return dedupedResult(receipt)

  if (options.skipRateLimit !== true) {
    let allowed: boolean
    try {
      allowed = await spool.rateLimitAllowed(options.clientInstanceId ?? instanceId)
    } catch (error) {
      return { state: 'blocked', receipt, errorClass: asDiagnosticsError(error).code }
    }
    if (!allowed) {
      receipt.state = 'retry'
      receipt.errorClass = 'RATE_LIMITED'
      receipt.nextRetryAt = now + 60_000
      receipt.updatedAt = new Date(now).toISOString()
      await spool.update(receipt)
      return { state: 'queued', receipt, errorClass: 'RATE_LIMITED' }
    }
  }

  let lease
  try {
    lease = await spool.acquireLease()
  } catch (error) {
    return { state: 'blocked', receipt, errorClass: asDiagnosticsError(error).code }
  }
  if (lease === undefined) return { state: 'queued', receipt }

  const transport = options.transport ?? new DiagnosticsTransport(config, {
    now: () => now,
    random: options.random,
  })
  const run = async (): Promise<PublishResult> => {
    try {
      return await executeUpload(prepared, receipt, config, spool, transport)
    } finally {
      await spool.releaseLease(lease)
    }
  }

  if (options.maxWaitMs === undefined) return await run()
  const bounded = await raceDeadline(run(), options.maxWaitMs)
  if (bounded.kind === 'timeout') {
    // The background promise owns the lease and will release it. Its result is
    // intentionally ignored: the process may exit immediately after the boot
    // failure, leaving a durable spool entry for the next start.
    void bounded.pending.catch(() => {})
    return { state: 'queued', receipt }
  }
  return bounded.value
}

async function raceDeadline<T>(promise: Promise<T>, ms: number): Promise<{ kind: 'done'; value: T } | { kind: 'timeout'; pending: Promise<T> }> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<{ kind: 'timeout'; pending: Promise<T> }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout', pending: promise }), ms)
    timer.unref?.()
  })
  const done = promise.then((value) => ({ kind: 'done' as const, value }))
  const result = await Promise.race([done, timeout])
  if (timer !== undefined) clearTimeout(timer)
  return result
}

export async function drainDiagnosticsSpool(options: DrainOptions = {}): Promise<{
  attempted: number
  verified: number
  failed: number
  skipped: number
}> {
  const config = await makeConfig(options)
  if (!config.enabled) return { attempted: 0, verified: 0, failed: 0, skipped: 0 }
  const spool = options.spool ?? new SpoolStore(config.spoolDir, {
    now: options.now === undefined ? undefined : () => options.now as number,
    random: options.random,
  })
  const lease = await spool.acquireLease()
  if (lease === undefined) return { attempted: 0, verified: 0, failed: 0, skipped: 0 }
  const transport = options.transport ?? new DiagnosticsTransport(config, {
    now: options.now === undefined ? undefined : () => options.now as number,
    random: options.random,
  })
  let attempted = 0
  let verified = 0
  let failed = 0
  let skipped = 0
  try {
    const due = (await spool.due(config)).slice(0, options.maxEntries ?? 3)
    for (const entry of due) {
      attempted += 1
      try {
        const prepared = await readPreparedFromSpool(spool, entry.bundleId, config)
        const result = await transport.upload(prepared)
        const updated = await spool.markVerified(entry.receipt, result.remote)
        await writeVerifiedCopy(config.verifiedDir, entry.bundleId, {
          archive: prepared.archive,
          manifest: canonicalJson(prepared.manifest),
          envelope: prepared.envelope,
          receipt: updated,
        }, { maxEntries: config.maxSpoolEntries, maxBytes: config.maxSpoolBytes })
        verified += 1
      } catch (error) {
        const mapped = asDiagnosticsError(error)
        await spool.markAttempt(entry.receipt, config, mapped)
        failed += 1
      }
    }
  } finally {
    await spool.releaseLease(lease)
  }
  skipped = (await spool.stats())['retry'] ?? 0
  return { attempted, verified, failed, skipped }
}

async function readPreparedFromSpool(spool: SpoolStore, bundleId: string, config: DiagnosticsConfig): Promise<PreparedBundle> {
  const archive = await spool.readArtifact(bundleId, 'bundle.tar.gz')
  const envelope = await spool.readArtifact(bundleId, 'envelope.bin')
  const manifestRaw = await spool.readArtifact(bundleId, 'manifest.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(manifestRaw.toString('utf8'))
  } catch {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const manifest = validateManifest(parsed)
  const verificationKey = manifestVerificationKey(config)
  verifyManifestSignature(manifest, verificationKey)
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8')
  const manifestSha256 = sha256Hex(manifestBytes)
  const inspected = inspectEnvelope(envelope)
  verifyEnvelopeBinding(inspected.header, verificationKey)
  if (inspected.header.bundleId !== bundleId ||
    inspected.header.manifestSha256 !== manifestSha256 ||
    inspected.header.archiveSha256 !== manifest.archive.sha256 ||
    inspected.header.archiveBytes !== manifest.archive.bytes) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  // The archive bytes are independently hashed; the signed manifest binds them.
  if (sha256Hex(archive) !== manifest.archive.sha256 || archive.length !== manifest.archive.bytes) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const metadata = await readTarEntry(archive, 'metadata.json', config)
  const versions = await readTarEntry(archive, 'versions.txt', config)
  return {
    bundleId,
    createdAt: manifest.createdAt,
    archive,
    archiveSha256: manifest.archive.sha256,
    files: manifest.files,
    metadata,
    versions,
    manifest,
    manifestBytes,
    manifestSha256,
    envelope,
    envelopeSha256: sha256Hex(envelope),
    envelopeHeader: inspected.header,
  }
}

async function readTarEntry(archive: Buffer, name: 'metadata.json' | 'versions.txt', config: DiagnosticsConfig): Promise<Buffer> {
  const { readTarGz } = await import('./bundle.js')
  const parsed = readTarGz(archive, {
    maxTotalBytes: config.maxTotalBytes,
    maxFileBytes: config.maxFileBytes,
  })
  const data = parsed.files.get(name)
  if (data === undefined) throw new DiagnosticsError('INTEGRITY_FAILED')
  return data
}

export async function fetchDiagnosticBundle(bundleId: string, options: FetchOptions = {}): Promise<FetchResult> {
  if (!/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(bundleId)) throw new DiagnosticsError('CONFIG_INVALID')
  const config = await makeConfig(options)
  if (!config.enabled) throw new DiagnosticsError('NOT_CONFIGURED')
  const verificationKey = manifestVerificationKey(config)
  if (options.transport === undefined && config.clientEd25519KeyPem === undefined) {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  const transport = options.transport ?? new DiagnosticsTransport(config)
  const manifest = await transport.fetchManifest(bundleId)
  const envelope = await transport.fetchEnvelope(bundleId)
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8')
  const manifestSha256 = sha256Hex(manifestBytes)
  const envelopeSha256 = sha256Hex(envelope)
  const inspected = inspectEnvelope(envelope)
  verifyEnvelopeBinding(inspected.header, verificationKey)
  if (inspected.header.bundleId !== bundleId ||
    inspected.header.manifestSha256 !== manifestSha256 ||
    inspected.header.archiveSha256 !== manifest.archive.sha256 ||
    inspected.header.archiveBytes !== manifest.archive.bytes) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }

  const spool = options.spool ?? new SpoolStore(config.spoolDir)
  const local = await spool.read(bundleId).catch(() => undefined)
  const expectedManifestSha256 = options.expectedManifestSha256 ?? local?.receipt.remote?.manifestSha256
  const expectedEnvelopeSha256 = options.expectedEnvelopeSha256 ?? local?.receipt.remote?.envelopeSha256
  if (expectedManifestSha256 !== undefined && expectedManifestSha256 !== manifestSha256) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  if (expectedEnvelopeSha256 !== undefined && expectedEnvelopeSha256 !== envelopeSha256) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const boundToExpected = expectedManifestSha256 !== undefined && expectedEnvelopeSha256 !== undefined

  let verifiedContent = false
  if (boundToExpected && config.recipientX25519PrivateKeyPem !== undefined) {
    const recipientKey = parsePrivateKey(config.recipientX25519PrivateKeyPem, 'x25519')
    verifyEncryptedBundle({
      manifest,
      envelope,
      signerPublicKey: verificationKey,
      recipientPrivateKey: recipientKey,
      maxFileBytes: config.maxFileBytes,
      maxTotalBytes: config.maxTotalBytes,
      expectedEnvelopeSha256: envelopeSha256,
    })
    verifiedContent = true
  }

  const now = new Date().toISOString()
  const receipt: DiagnosticReceipt = {
    schema: 'dsh-ssh-tui/diagnostics-receipt/v1',
    bundleId,
    sourceSha: config.sourceSha ?? null,
    createdAt: manifest.createdAt,
    updatedAt: now,
    state: verifiedContent ? 'verified' : 'envelope-verified',
    attempts: local?.receipt.attempts ?? 0,
    nextRetryAt: null,
    errorClass: null,
    destinationFingerprint: config.destinationFingerprint,
    originalExitCode: manifest.exitCode,
    redaction: manifest.redaction,
    remote: {
      endpointId: config.endpointId,
      port: config.port,
      bundleId,
      manifestSha256,
      envelopeSha256,
      archiveSha256: manifest.archive.sha256,
      archiveBytes: manifest.archive.bytes,
    },
    verifiedAt: now,
  }
  const archive = verifiedContent ? await materializeArchive(manifest, envelope, config, verificationKey) : undefined
  const verifiedDir = await writeVerifiedCopy(config.verifiedDir, bundleId, {
    ...(archive === undefined ? {} : { archive }),
    manifest: canonicalJson(manifest),
    envelope,
    receipt,
  }, { maxEntries: config.maxSpoolEntries, maxBytes: config.maxSpoolBytes })
  return {
    state: verifiedContent ? 'verified' : 'envelope-verified',
    manifest,
    exitCode: manifest.exitCode,
    manifestSha256,
    envelopeSha256,
    verifiedContent,
    verifiedDir,
  }
}

async function materializeArchive(
  manifest: DiagnosticsManifest,
  envelope: Buffer,
  config: DiagnosticsConfig,
  verificationKey: KeyObject,
): Promise<Buffer> {
  if (config.recipientX25519PrivateKeyPem === undefined) throw new DiagnosticsError('CONFIG_INVALID')
  const { decryptEnvelope } = await import('./crypto.js')
  const decrypted = decryptEnvelope(
    envelope,
    parsePrivateKey(config.recipientX25519PrivateKeyPem, 'x25519'),
    verificationKey,
  )
  if (decrypted.archiveSha256 !== manifest.archive.sha256) throw new DiagnosticsError('INTEGRITY_FAILED')
  return decrypted.archive
}

export async function diagnosticsStatus(options: {
  config?: DiagnosticsConfig
  env?: NodeJS.ProcessEnv
  home?: string
} = {}): Promise<StatusResult> {
  const config = await makeConfig(options)
  const spool = new SpoolStore(config.spoolDir)
  return {
    config: describeDiagnosticsConfig(config),
    spool: config.enabled ? await spool.stats() : {},
  }
}

export const DIAGNOSTICS_PHASES: readonly DiagnosticPhase[] = ['startup', 'boot', 'turn', 'probe', 'teardown', 'shutdown', 'unknown']
