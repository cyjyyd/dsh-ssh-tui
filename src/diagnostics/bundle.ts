/**
 * Build the metadata-only failure bundle and its signed manifest.
 *
 * The local four-file diagnostic bundle is deliberately not reused. The remote
 * archive contains exactly two generated JSON/text files derived from typed
 * fields; terminal output, transcripts, session ids, paths, free-text errors
 * and credentials never enter this module.
 */
import { gzipSync, gunzipSync } from 'node:zlib'
import { arch, platform, release, type } from 'node:os'
import { crc32 } from 'node:zlib'
import type { KeyObject } from 'node:crypto'
import {
  DIAGNOSTICS_SCHEMA,
  DiagnosticsError,
  ENVELOPE_ALG,
  MANIFEST_SCHEMA,
  REDACTION_POLICY,
  SIGNATURE_ALG,
  type BundleFile,
  type DiagnosticsManifest,
  type FailureContext,
  type PreparedBundle,
} from './types.js'
import {
  canonicalJson,
  decryptEnvelope,
  encryptEnvelope,
  inspectEnvelope,
  makeBundleId,
  publicKeyId,
  sha256Hex,
  signEd25519,
  verifyEd25519,
  verifyEnvelopeBinding,
} from './crypto.js'
import {
  ARCH_PATTERN,
  BUNDLE_ID_PATTERN,
  COMMIT_PATTERN,
  FAILURE_CODE_PATTERN,
  HASH_PATTERN,
  PLATFORM_PATTERN,
  VERSION_PATTERN,
  assertExactKeys,
  assertNoSecrets,
  assertRecord,
  boundedBool,
  boundedInt,
  boundedString,
  boundedText,
  enumValue,
  problemClasses,
} from './redact.js'
import { BUNDLE_KINDS, DIAGNOSTIC_PHASES } from './types.js'

export const REMOTE_FILE_NAMES = ['metadata.json', 'versions.txt'] as const
const TAR_BLOCK = 512
const MAX_MANIFEST_BYTES = 64 * 1024

export interface PrepareBundleOptions {
  context: FailureContext
  signingKey: KeyObject
  recipientPublicKey: KeyObject
  maxBundleBytes: number
  maxFileBytes: number
  maxTotalBytes: number
  toolVersion: string
  sourceSha?: string | null
  now?: number
  random?: Buffer
}

export function buildMetadata(context: FailureContext): Buffer {
  const child = context.child === undefined
    ? undefined
    : (() => {
      assertRecord(context.child, ['exit', 'alive', 'teardown', 'observedMs'], 'child')
      return {
        exit: context.child.exit === null ? null : boundedInt(context.child.exit, 0, 255),
        alive: boundedBool(context.child.alive),
        teardown: boundedBool(context.child.teardown),
        observedMs: boundedInt(context.child.observedMs, 0, 86_400_000),
      }
    })()
  const ci = context.ci === undefined
    ? undefined
    : (() => {
      assertRecord(context.ci, ['runId', 'jobId', 'attempt'], 'ci')
      return {
        runId: boundedInt(context.ci.runId, 1, Number.MAX_SAFE_INTEGER),
        jobId: boundedInt(context.ci.jobId, 1, Number.MAX_SAFE_INTEGER),
        attempt: boundedInt(context.ci.attempt, 1, 1000),
      }
    })()
  const metadata = {
    schema: DIAGNOSTICS_SCHEMA,
    kind: enumValue(context.kind, BUNDLE_KINDS),
    phase: enumValue(context.phase, DIAGNOSTIC_PHASES),
    failureCode: boundedString(context.failureCode, FAILURE_CODE_PATTERN, 3, 64),
    exitCode: context.exitCode === null ? null : boundedInt(context.exitCode, 0, 255),
    elapsedMs: boundedInt(context.elapsedMs ?? 0, 0, 86_400_000),
    problemClasses: problemClasses(context.problemClasses),
    ...(child === undefined ? {} : { child }),
    ...(ci === undefined ? {} : { ci }),
  }
  const text = canonicalJson(metadata)
  assertNoSecrets(text)
  return Buffer.from(text, 'utf8')
}

export function buildVersions(input: {
  toolVersion: string
  sourceSha?: string | null
  createdAt: string
}): Buffer {
  void input.toolVersion
  void input.sourceSha
  const lines = [
    `node=${process.version}`,
    `npm=${agentVersion('npm')}`,
    `pnpm=${agentVersion('pnpm')}`,
    `os=${type()} ${release()}`,
    `created=${input.createdAt}`,
  ]
  const text = lines.join('\n')
  assertNoSecrets(text)
  return Buffer.from(text, 'utf8')
}

/** Read a package-manager version from the npm-compatible user agent, or `unknown`. */
function agentVersion(name: 'npm' | 'pnpm'): string {
  const agent = process.env.npm_config_user_agent ?? ''
  const match = new RegExp(`(?:^|\\s)${name}/([0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)(?:\\s|$)`).exec(agent)
  return match?.[1] ?? 'unknown'
}

function octal(value: number, width: number): string {
  const text = value.toString(8)
  if (text.length > width - 1) throw new DiagnosticsError('TOO_LARGE')
  return `${'0'.repeat(width - 1 - text.length)}${text}\0`
}

function checksum(block: Buffer): number {
  let sum = 0
  for (let i = 0; i < block.length; i++) sum += block[i]
  return sum
}

function tarHeader(name: string, size: number): Buffer {
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new DiagnosticsError('INTEGRITY_FAILED')
  const header = Buffer.alloc(TAR_BLOCK, 0)
  header.write(name, 0, 'utf8')
  header.write(octal(0o600, 8), 100, 'ascii')
  header.write(octal(0, 8), 108, 'ascii')
  header.write(octal(0, 8), 116, 'ascii')
  header.write(octal(size, 12), 124, 'ascii')
  header.write(octal(0, 12), 136, 'ascii')
  header.write('        ', 148, 'ascii')
  header.write('0', 156, 'ascii')
  header.write('ustar\0', 257, 'ascii')
  header.write('00', 263, 'ascii')
  // uname/gname stay empty; devmajor/devminor are zeroed by the buffer.
  const sum = checksum(header)
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii')
  return header
}

/** Deterministic ustar writer: sorted entries, zeroed mtime/uid/gid, mode 0600. */
export function createTar(files: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const names = files.map((file) => file.name)
  if (new Set(names).size !== names.length) throw new DiagnosticsError('INTEGRITY_FAILED')
  const sorted = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const chunks: Buffer[] = []
  for (const file of sorted) {
    chunks.push(tarHeader(file.name, file.data.length))
    chunks.push(file.data)
    const remainder = file.data.length % TAR_BLOCK
    if (remainder !== 0) chunks.push(Buffer.alloc(TAR_BLOCK - remainder, 0))
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0))
  return Buffer.concat(chunks)
}

/** Gzip with a fixed header and no filename/mtime, so equal input is byte-identical. */
export function gzipDeterministic(input: Buffer): Buffer {
  const deflated = gzipSync(input, { level: 9 })
  const header = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03])
  // Recompute the trailer over the original data to keep gzip self-consistent.
  const trailer = Buffer.alloc(8)
  trailer.writeUInt32LE(crc32(input) >>> 0, 0)
  trailer.writeUInt32LE(input.length >>> 0, 4)
  const body = deflated.subarray(10, deflated.length - 8)
  return Buffer.concat([header, body, trailer])
}

export interface ParsedTar {
  files: Map<string, Buffer>
}

/** Strict ustar reader used by the download verifier and tests. */
export function readTarGz(archive: Buffer, options: { maxTotalBytes: number; maxFileBytes: number; maxFiles?: number }): ParsedTar {
  let raw: Buffer
  try {
    raw = gunzipSync(archive, { maxOutputLength: options.maxTotalBytes + TAR_BLOCK * 8 })
  } catch {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const files = new Map<string, Buffer>()
  let offset = 0
  let total = 0
  const maxFiles = options.maxFiles ?? 8
  while (offset + TAR_BLOCK <= raw.length) {
    const header = raw.subarray(offset, offset + TAR_BLOCK)
    offset += TAR_BLOCK
    if (header.every((byte) => byte === 0)) {
      // The first zero block begins the end marker; a second must follow.
      if (offset + TAR_BLOCK > raw.length) throw new DiagnosticsError('INTEGRITY_FAILED')
      const second = raw.subarray(offset, offset + TAR_BLOCK)
      if (!second.every((byte) => byte === 0)) throw new DiagnosticsError('INTEGRITY_FAILED')
      if (offset + TAR_BLOCK < raw.length && !raw.subarray(offset + TAR_BLOCK).every((byte) => byte === 0)) {
        throw new DiagnosticsError('INTEGRITY_FAILED')
      }
      break
    }
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === '.' || name === '..' || name.includes('/')) {
      throw new DiagnosticsError('INTEGRITY_FAILED')
    }
    if (header[156] !== 0x30) throw new DiagnosticsError('INTEGRITY_FAILED')
    const sizeText = header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new DiagnosticsError('INTEGRITY_FAILED')
    const size = Number.parseInt(sizeText, 8)
    if (!Number.isSafeInteger(size) || size < 0 || size > options.maxFileBytes) {
      throw new DiagnosticsError('TOO_LARGE')
    }
    const storedChecksum = Number.parseInt(header.subarray(148, 156).toString('ascii').replace(/\0.*$/, '').trim(), 8)
    const checkHeader = Buffer.from(header)
    checkHeader.fill(0x20, 148, 156)
    if (checksum(checkHeader) !== storedChecksum) throw new DiagnosticsError('INTEGRITY_FAILED')
    if (offset + size > raw.length) throw new DiagnosticsError('INTEGRITY_FAILED')
    if (files.has(name)) throw new DiagnosticsError('INTEGRITY_FAILED')
    if (files.size >= maxFiles) throw new DiagnosticsError('TOO_LARGE')
    total += size
    if (total > options.maxTotalBytes) throw new DiagnosticsError('TOO_LARGE')
    files.set(name, Buffer.from(raw.subarray(offset, offset + size)))
    offset += size
    const pad = size % TAR_BLOCK
    if (pad !== 0) offset += TAR_BLOCK - pad
    if (offset > raw.length) throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  return { files }
}

export function manifestFiles(metadata: Buffer, versions: Buffer): BundleFile[] {
  return [
    { name: 'metadata.json', bytes: metadata.length, sha256: sha256Hex(metadata) },
    { name: 'versions.txt', bytes: versions.length, sha256: sha256Hex(versions) },
  ]
}

export function prepareBundle(options: PrepareBundleOptions): PreparedBundle {
  const now = options.now ?? Date.now()
  const createdAt = new Date(now).toISOString()
  const bundleId = makeBundleId(now, options.random)
  if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new DiagnosticsError('CONFIG_INVALID')
  const metadata = buildMetadata(options.context)
  const versions = buildVersions({
    toolVersion: options.toolVersion,
    sourceSha: options.sourceSha,
    createdAt,
  })
  for (const file of [metadata, versions]) {
    if (file.length > options.maxFileBytes) throw new DiagnosticsError('TOO_LARGE')
  }
  const tar = createTar([
    { name: 'metadata.json', data: metadata },
    { name: 'versions.txt', data: versions },
  ])
  if (tar.length > options.maxTotalBytes) throw new DiagnosticsError('TOO_LARGE')
  const archive = gzipDeterministic(tar)
  if (archive.length > options.maxBundleBytes) throw new DiagnosticsError('TOO_LARGE')
  const archiveSha256 = sha256Hex(archive)
  const files = manifestFiles(metadata, versions)
  const recipientKeyId = publicKeyId(options.recipientPublicKey)
  const unsigned: DiagnosticsManifest = {
    schema: MANIFEST_SCHEMA,
    bundleId,
    createdAt,
    kind: options.context.kind,
    phase: options.context.phase,
    failureCode: options.context.failureCode,
    exitCode: options.context.exitCode,
    elapsedMs: options.context.elapsedMs ?? 0,
    tool: {
      name: 'dsh-ssh-tui',
      version: boundedString(options.toolVersion, VERSION_PATTERN, 1, 64),
      commit: options.sourceSha === undefined || options.sourceSha === null
        ? null
        : boundedString(options.sourceSha, COMMIT_PATTERN, 7, 64),
    },
    sourceSha: options.sourceSha === undefined || options.sourceSha === null
      ? null
      : boundedString(options.sourceSha, COMMIT_PATTERN, 7, 64),
    runtime: {
      node: process.version,
      platform: platform(),
      arch: arch(),
    },
    archive: { name: 'bundle.tar.gz', bytes: archive.length, sha256: archiveSha256 },
    files,
    encryption: { alg: ENVELOPE_ALG, recipientKeyId },
    redaction: {
      policy: REDACTION_POLICY,
      ruleset: 'v1',
      withheld: 0,
      blocked: 'NONE',
    },
  }
  const manifest = signManifest(unsigned, options.signingKey)
  const manifestBytes = Buffer.from(canonicalJson(manifest), 'utf8')
  if (manifestBytes.length > MAX_MANIFEST_BYTES) throw new DiagnosticsError('TOO_LARGE')
  const manifestSha256 = sha256Hex(manifestBytes)
  const { envelope, header } = encryptEnvelope({
    bundleId,
    archive,
    archiveSha256,
    manifestBytes,
    manifestSha256,
    recipientPublicKey: options.recipientPublicKey,
    signingKey: options.signingKey,
  })
  if (envelope.length > options.maxBundleBytes) throw new DiagnosticsError('TOO_LARGE')
  return {
    bundleId,
    createdAt,
    archive,
    archiveSha256,
    files,
    metadata,
    versions,
    manifest,
    manifestBytes,
    manifestSha256,
    envelope,
    envelopeSha256: sha256Hex(envelope),
    envelopeHeader: header,
  }
}

export function signManifest(manifest: DiagnosticsManifest, signingKey: KeyObject): DiagnosticsManifest {
  const unsigned = { ...manifest }
  delete unsigned.signature
  const value = signEd25519(signingKey, canonicalJson(unsigned))
  return {
    ...unsigned,
    signature: {
      alg: SIGNATURE_ALG,
      keyId: publicKeyId(signingKey),
      value,
    },
  }
}

export function verifyManifestSignature(manifest: DiagnosticsManifest, publicKey: KeyObject): void {
  const signature = manifest.signature
  if (signature === undefined || signature.alg !== SIGNATURE_ALG) throw new DiagnosticsError('INTEGRITY_FAILED')
  if (signature.keyId !== publicKeyId(publicKey)) throw new DiagnosticsError('PIN_MISMATCH')
  const unsigned = { ...manifest }
  delete unsigned.signature
  if (!verifyEd25519(publicKey, canonicalJson(unsigned), signature.value)) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
}

const MANIFEST_KEYS = [
  'schema', 'bundleId', 'createdAt', 'kind', 'phase', 'failureCode', 'exitCode', 'elapsedMs',
  'tool', 'sourceSha', 'runtime', 'archive', 'files', 'encryption', 'redaction', 'signature',
] as const

export function validateManifest(value: unknown): DiagnosticsManifest {
  const record = assertRecord(value, MANIFEST_KEYS, 'manifest')
  if (record.schema !== MANIFEST_SCHEMA) throw new DiagnosticsError('INTEGRITY_FAILED')
  const bundleId = boundedString(record.bundleId, BUNDLE_ID_PATTERN, 1, 64)
  const createdAt = boundedString(record.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 24, 24)
  const kind = enumValue(record.kind, BUNDLE_KINDS)
  const phase = enumValue(record.phase, DIAGNOSTIC_PHASES)
  const failureCode = boundedString(record.failureCode, FAILURE_CODE_PATTERN, 3, 64)
  const exitCode = record.exitCode === null ? null : boundedInt(record.exitCode, 0, 255)
  const elapsedMs = boundedInt(record.elapsedMs, 0, 86_400_000)

  const tool = assertRecord(record.tool, ['name', 'version', 'commit'], 'tool')
  if (tool.name !== 'dsh-ssh-tui') throw new DiagnosticsError('INTEGRITY_FAILED')
  const toolVersion = boundedString(tool.version, VERSION_PATTERN, 1, 64)
  const commit = tool.commit === null ? null : boundedString(tool.commit, COMMIT_PATTERN, 7, 64)
  const sourceSha = record.sourceSha === undefined || record.sourceSha === null
    ? null
    : boundedString(record.sourceSha, COMMIT_PATTERN, 7, 64)

  const runtime = assertRecord(record.runtime, ['node', 'platform', 'arch'], 'runtime')
  const nodeVersion = boundedString(runtime.node, /^v\d+\.\d+\.\d+$/, 6, 32)
  const platformValue = boundedString(runtime.platform, PLATFORM_PATTERN, 3, 16)
  const archValue = boundedString(runtime.arch, ARCH_PATTERN, 2, 16)

  const archive = assertRecord(record.archive, ['name', 'bytes', 'sha256'], 'archive')
  if (archive.name !== 'bundle.tar.gz') throw new DiagnosticsError('INTEGRITY_FAILED')
  const archiveBytes = boundedInt(archive.bytes, 1, 64 * 1024 * 1024)
  const archiveSha256 = boundedString(archive.sha256, HASH_PATTERN, 64, 64)

  if (!Array.isArray(record.files) || record.files.length !== REMOTE_FILE_NAMES.length) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const files: BundleFile[] = []
  for (const raw of record.files) {
    const file = assertRecord(raw, ['name', 'bytes', 'sha256'], 'file')
    const name = enumValue(file.name, REMOTE_FILE_NAMES)
    files.push({
      name,
      bytes: boundedInt(file.bytes, 1, 1024 * 1024),
      sha256: boundedString(file.sha256, HASH_PATTERN, 64, 64),
    })
  }
  const names = files.map((file) => file.name).sort()
  if (names.join(',') !== [...REMOTE_FILE_NAMES].sort().join(',')) throw new DiagnosticsError('INTEGRITY_FAILED')

  const encryption = assertRecord(record.encryption, ['alg', 'recipientKeyId'], 'encryption')
  if (encryption.alg !== ENVELOPE_ALG) throw new DiagnosticsError('INTEGRITY_FAILED')
  const recipientKeyId = boundedString(encryption.recipientKeyId, HASH_PATTERN, 64, 64)

  const redaction = assertRecord(record.redaction, ['policy', 'ruleset', 'withheld', 'blocked'], 'redaction')
  if (redaction.policy !== REDACTION_POLICY) throw new DiagnosticsError('INTEGRITY_FAILED')
  const ruleset = boundedString(redaction.ruleset, /^[a-z0-9.-]{1,32}$/, 1, 32)
  const withheld = boundedInt(redaction.withheld, 0, 1_000_000)
  const blocked = enumValue(redaction.blocked, ['NONE', 'SECRET_SCAN', 'SIZE_LIMIT', 'SCHEMA'] as const)

  const signature = assertRecord(record.signature, ['alg', 'keyId', 'value'], 'signature')
  if (signature.alg !== SIGNATURE_ALG) throw new DiagnosticsError('INTEGRITY_FAILED')
  const keyId = boundedString(signature.keyId, HASH_PATTERN, 64, 64)
  const signatureValue = boundedString(signature.value, /^[A-Za-z0-9+/]{86}==$/, 86, 88)

  const manifest: DiagnosticsManifest = {
    schema: MANIFEST_SCHEMA,
    bundleId,
    createdAt,
    kind,
    phase,
    failureCode,
    exitCode,
    elapsedMs,
    tool: { name: 'dsh-ssh-tui', version: toolVersion, commit },
    sourceSha,
    runtime: { node: nodeVersion, platform: platformValue, arch: archValue },
    archive: { name: 'bundle.tar.gz', bytes: archiveBytes, sha256: archiveSha256 },
    files,
    encryption: { alg: ENVELOPE_ALG, recipientKeyId },
    redaction: { policy: REDACTION_POLICY, ruleset, withheld, blocked },
    signature: { alg: SIGNATURE_ALG, keyId, value: signatureValue },
  }
  const serialized = canonicalJson(manifest)
  assertNoSecrets(serialized)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_MANIFEST_BYTES) throw new DiagnosticsError('TOO_LARGE')
  return manifest
}

const METADATA_KEYS = [
  'schema', 'kind', 'phase', 'failureCode', 'exitCode', 'elapsedMs', 'problemClasses', 'child', 'ci',
] as const

/** Strict receiver-side allowlist for metadata.json. */
export function validateMetadata(value: unknown): void {
  const record = assertRecord(value, METADATA_KEYS, 'metadata')
  if (record.schema !== DIAGNOSTICS_SCHEMA) throw new DiagnosticsError('INTEGRITY_FAILED')
  enumValue(record.kind, BUNDLE_KINDS)
  enumValue(record.phase, DIAGNOSTIC_PHASES)
  boundedString(record.failureCode, FAILURE_CODE_PATTERN, 3, 64)
  if (record.exitCode !== null) boundedInt(record.exitCode, 0, 255)
  boundedInt(record.elapsedMs, 0, 86_400_000)
  if (!Array.isArray(record.problemClasses)) throw new DiagnosticsError('INTEGRITY_FAILED')
  problemClasses(record.problemClasses)
  if (record.child !== undefined) {
    const child = assertRecord(record.child, ['exit', 'alive', 'teardown', 'observedMs'], 'child')
    if (child.exit !== null) boundedInt(child.exit, 0, 255)
    boundedBool(child.alive)
    boundedBool(child.teardown)
    boundedInt(child.observedMs, 0, 86_400_000)
  }
  if (record.ci !== undefined) {
    const ci = assertRecord(record.ci, ['runId', 'jobId', 'attempt'], 'ci')
    boundedInt(ci.runId, 1, Number.MAX_SAFE_INTEGER)
    boundedInt(ci.jobId, 1, Number.MAX_SAFE_INTEGER)
    boundedInt(ci.attempt, 1, 1000)
  }
  assertNoSecrets(canonicalJson(record))
}

/** Strict receiver-side allowlist for versions.txt. */
export function validateVersions(text: string): void {
  const lines = text.split('\n').filter((line) => line !== '')
  if (lines.length !== 5) throw new DiagnosticsError('INTEGRITY_FAILED')
  const allowed = new Set(['node', 'npm', 'pnpm', 'os', 'created'])
  const seen = new Set<string>()
  for (const line of lines) {
    const index = line.indexOf('=')
    if (index <= 0) throw new DiagnosticsError('INTEGRITY_FAILED')
    const key = line.slice(0, index)
    const value = line.slice(index + 1)
    if (!allowed.has(key) || seen.has(key)) throw new DiagnosticsError('INTEGRITY_FAILED')
    seen.add(key)
    if (key === 'node') boundedString(value, /^v\d+\.\d+\.\d+$/, 6, 32)
    else if (key === 'npm' || key === 'pnpm') {
      if (value !== 'unknown') boundedString(value, /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, 1, 64)
    } else if (key === 'os') boundedString(value, /^[A-Za-z_]+ [0-9A-Za-z._+~:-]+$/, 3, 128)
    else if (key === 'created') {
      boundedString(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 24, 24)
    }
  }
  if (seen.size !== allowed.size) throw new DiagnosticsError('INTEGRITY_FAILED')
  assertNoSecrets(text)
}

export interface VerifyBundleOptions {
  manifest: DiagnosticsManifest
  archive: Buffer
  /** Pinned key of the sender that signed the manifest. */
  signerPublicKey: KeyObject
  maxFileBytes: number
  maxTotalBytes: number
}

/** Receiver-side verification: signature, archive hash, file hashes/lengths. */
export function verifyBundle(options: VerifyBundleOptions): { metadata: Buffer; versions: Buffer } {
  const manifest = validateManifest(options.manifest)
  if (manifest.signature === undefined) throw new DiagnosticsError('INTEGRITY_FAILED')
  verifyManifestSignature(manifest, options.signerPublicKey)
  const archiveSha256 = sha256Hex(options.archive)
  if (archiveSha256 !== manifest.archive.sha256 || options.archive.length !== manifest.archive.bytes) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const parsed = readTarGz(options.archive, {
    maxTotalBytes: options.maxTotalBytes,
    maxFileBytes: options.maxFileBytes,
  })
  for (const file of manifest.files) {
    const data = parsed.files.get(file.name)
    if (data === undefined || data.length !== file.bytes || sha256Hex(data) !== file.sha256) {
      throw new DiagnosticsError('INTEGRITY_FAILED')
    }
  }
  if (parsed.files.size !== manifest.files.length) throw new DiagnosticsError('INTEGRITY_FAILED')
  const metadata = parsed.files.get('metadata.json') as Buffer
  const versions = parsed.files.get('versions.txt') as Buffer
  let metadataValue: unknown
  try {
    metadataValue = JSON.parse(metadata.toString('utf8'))
  } catch {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  validateMetadata(metadataValue)
  validateVersions(versions.toString('utf8'))
  return { metadata, versions }
}

export function verifyEncryptedBundle(input: {
  manifest: DiagnosticsManifest
  envelope: Buffer
  signerPublicKey: KeyObject
  recipientPrivateKey: KeyObject
  maxFileBytes: number
  maxTotalBytes: number
  /** Independent digest of the exact envelope bytes; never optional. */
  expectedEnvelopeSha256: string
}): { metadata: Buffer; versions: Buffer } {
  const manifest = validateManifest(input.manifest)
  if (typeof input.expectedEnvelopeSha256 !== 'string' ||
    !HASH_PATTERN.test(input.expectedEnvelopeSha256) ||
    sha256Hex(input.envelope) !== input.expectedEnvelopeSha256) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const inspected = inspectEnvelope(input.envelope)
  verifyEnvelopeBinding(inspected.header, input.signerPublicKey)
  verifyManifestSignature(manifest, input.signerPublicKey)
  if (inspected.header.bundleId !== manifest.bundleId) throw new DiagnosticsError('INTEGRITY_FAILED')
  if (inspected.header.manifestSha256 !== sha256Hex(canonicalJson(manifest))) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  if (inspected.header.archiveSha256 !== manifest.archive.sha256 ||
    inspected.header.archiveBytes !== manifest.archive.bytes) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  if (manifest.encryption.recipientKeyId !== publicKeyId(input.recipientPrivateKey)) {
    throw new DiagnosticsError('PIN_MISMATCH')
  }
  const decrypted = decryptEnvelope(input.envelope, input.recipientPrivateKey, input.signerPublicKey)
  if (decrypted.header.manifestSha256 !== sha256Hex(canonicalJson(manifest))) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  if (decrypted.header.bundleId !== manifest.bundleId) throw new DiagnosticsError('INTEGRITY_FAILED')
  return verifyBundle({
    manifest,
    archive: decrypted.archive,
    signerPublicKey: input.signerPublicKey,
    maxFileBytes: input.maxFileBytes,
    maxTotalBytes: input.maxTotalBytes,
  })
}
