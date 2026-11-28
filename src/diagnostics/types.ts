/**
 * Types for the failure-diagnostics remote handoff.
 *
 * The remote bundle is metadata-only: it never carries raw terminal output,
 * transcripts, session identifiers, paths, credentials or free-text errors.
 * Everything that crosses the network is either a fixed enum, a bounded
 * numeric value, a version/hash string, or an opaque encrypted archive.
 */

export const DIAGNOSTICS_SCHEMA = 'dsh-ssh-tui/diagnostics/v1'
export const MANIFEST_SCHEMA = 'dsh-ssh-tui/diagnostics-manifest/v1'
export const ENVELOPE_BINDING_SCHEMA = 'dsh-ssh-tui/diagnostics-envelope/v1'
export const RECEIPT_SCHEMA = 'dsh-ssh-tui/diagnostics-receipt/v1'
export const ENVELOPE_MAGIC = 'DSHENV1\n'
export const ENVELOPE_VERSION = 1
export const ENVELOPE_ALG = 'x25519-hkdf-sha256-aes-256-gcm'
export const SIGNATURE_ALG = 'Ed25519'
export const REDACTION_POLICY = 'dsh-ssh-tui/diagnostics-redaction/v1'
export const DEFAULT_PORT = 18443
export const DEFAULT_MAX_BUNDLE_BYTES = 32 * 1024 * 1024
export const DEFAULT_MAX_FILE_BYTES = 256 * 1024
export const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 10_000
export const DEFAULT_MAX_ATTEMPTS = 5
export const DEFAULT_MAX_SPOOL_ENTRIES = 64
export const DEFAULT_MAX_SPOOL_BYTES = 256 * 1024 * 1024
export const DEFAULT_SPOOL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
export const MIN_PORT = 1024

export type BundleKind = 'turn-error' | 'boot-error' | 'probe-failure'
export type DiagnosticPhase = 'startup' | 'boot' | 'turn' | 'probe' | 'teardown' | 'shutdown' | 'unknown'
export type ProblemClass =
  | 'ASSERTION'
  | 'TIMEOUT'
  | 'PROCESS_EXIT'
  | 'SPAWN_ERROR'
  | 'IO_ERROR'
  | 'PROTOCOL_ERROR'
  | 'AUTH_ERROR'
  | 'UNKNOWN'

export const BUNDLE_KINDS: readonly BundleKind[] = ['turn-error', 'boot-error', 'probe-failure']
export const DIAGNOSTIC_PHASES: readonly DiagnosticPhase[] = ['startup', 'boot', 'turn', 'probe', 'teardown', 'shutdown', 'unknown']
export const PROBLEM_CLASSES: readonly ProblemClass[] = [
  'ASSERTION', 'TIMEOUT', 'PROCESS_EXIT', 'SPAWN_ERROR', 'IO_ERROR', 'PROTOCOL_ERROR', 'AUTH_ERROR', 'UNKNOWN',
]

/** Everything a caller may hand to the capture path. No raw error/session text. */
export interface FailureContext {
  kind: BundleKind
  /** Stable, non-secret code such as `BOOT_ERROR`, `AGENT_ERROR`, `ASSERT_TIMEOUT`. */
  failureCode: string
  phase: DiagnosticPhase
  /** The original failure exit code, preserved in the manifest. */
  exitCode: number | null
  elapsedMs?: number
  problemClasses?: readonly ProblemClass[]
  child?: {
    exit: number | null
    alive: boolean
    teardown: boolean
    observedMs: number
  }
  ci?: {
    runId: number
    jobId: number
    attempt: number
  }
  /** Unix epoch ms; tests inject it. */
  observedAt?: number
  /** Optional caller-scoped incident id; independent events stay distinct. */
  incidentId?: string
}

export interface BundleFile {
  name: string
  bytes: number
  sha256: string
}

export interface ManifestSignature {
  alg: typeof SIGNATURE_ALG
  /** SHA-256 of the signer public key, hex. Never the key itself. */
  keyId: string
  value: string
}

export interface DiagnosticsManifest {
  schema: typeof MANIFEST_SCHEMA
  bundleId: string
  createdAt: string
  kind: BundleKind
  phase: DiagnosticPhase
  failureCode: string
  exitCode: number | null
  elapsedMs: number
  tool: {
    name: 'dsh-ssh-tui'
    version: string
    commit: string | null
  }
  /** Authorized structured source revision; never a path or a raw error. */
  sourceSha: string | null
  runtime: {
    node: string
    platform: string
    arch: string
  }
  archive: {
    name: 'bundle.tar.gz'
    bytes: number
    sha256: string
  }
  files: BundleFile[]
  encryption: {
    alg: typeof ENVELOPE_ALG
    /** SHA-256 of the recipient X25519 public key, hex. */
    recipientKeyId: string
  }
  redaction: {
    policy: typeof REDACTION_POLICY
    ruleset: string
    withheld: number
    blocked: 'NONE' | 'SECRET_SCAN' | 'SIZE_LIMIT' | 'SCHEMA'
  }
  /** Added after canonicalization; not part of the signed payload. */
  signature?: ManifestSignature
}

export interface EnvelopeHeader {
  v: typeof ENVELOPE_VERSION
  alg: typeof ENVELOPE_ALG
  bundleId: string
  recipientKeyId: string
  ephemeralPublicKey: string
  salt: string
  nonce: string
  archiveSha256: string
  archiveBytes: number
  manifestSha256: string
  ciphertextBytes: number
  /** SHA-256 over the AES-GCM ciphertext bytes, bound by the signature below. */
  ciphertextSha256: string
  /** Ed25519 signature over the canonical header plus ciphertextSha256. */
  envelopeSignature: ManifestSignature
}

export interface PreparedBundle {
  bundleId: string
  createdAt: string
  archive: Buffer
  archiveSha256: string
  files: BundleFile[]
  metadata: Buffer
  versions: Buffer
  manifest: DiagnosticsManifest
  /** Canonical signed manifest, before encryption. */
  manifestBytes: Buffer
  manifestSha256: string
  envelope: Buffer
  envelopeSha256: string
  envelopeHeader: EnvelopeHeader
}

export type ReceiptState =
  | 'pending'
  | 'uploading'
  | 'uploaded'
  | 'verified'
  | 'envelope-verified'
  | 'retry'
  | 'blocked'
  | 'abandoned'
  | 'destination-changed'
  | 'disabled'

export interface RemoteLocator {
  /** Hash of endpoint host+port; never the host itself. */
  endpointId: string
  port: number
  bundleId: string
  manifestSha256: string
  envelopeSha256: string
  archiveSha256: string
  archiveBytes: number
}

export interface DiagnosticReceipt {
  schema: typeof RECEIPT_SCHEMA
  bundleId: string
  sourceSha: string | null
  createdAt: string
  updatedAt: string
  state: ReceiptState
  attempts: number
  nextRetryAt: number | null
  errorClass: string | null
  destinationFingerprint: string
  originalExitCode: number | null
  redaction: DiagnosticsManifest['redaction']
  remote: RemoteLocator | null
  verifiedAt: string | null
  /** Stable failure identity; persisted so a restart cannot double-enqueue. */
  failureId?: string
}

export type DiagnosticsErrorCode =
  | 'DISABLED'
  | 'NOT_CONFIGURED'
  | 'CONFIG_INVALID'
  | 'PUBLIC_ENDPOINT_REFUSED'
  | 'TLS_FAILED'
  | 'PIN_MISMATCH'
  | 'AUTH_FAILED'
  | 'SESSION_FAILED'
  | 'AUTH_REPLAY_REFUSED'
  | 'REDIRECT_REFUSED'
  | 'TOO_LARGE'
  | 'REDACTION_BLOCKED'
  | 'INTEGRITY_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'CLIENT_ERROR'
  | 'SPOOL_FAILED'
  | 'DESTINATION_CHANGED'
  | 'UNSUPPORTED'

export class DiagnosticsError extends Error {
  readonly code: DiagnosticsErrorCode
  readonly retryable: boolean

  constructor(code: DiagnosticsErrorCode, options: { retryable?: boolean; cause?: unknown } = {}) {
    // Fixed messages only: never interpolate a URL, token, path or response body.
    super(code)
    this.name = 'DiagnosticsError'
    this.code = code
    this.retryable = options.retryable === true
    if (options.cause !== undefined) this.cause = options.cause
  }
}

export interface DiagnosticsConfig {
  enabled: boolean
  host: string
  port: number
  /** Optional TLS server name for SNI; defaults to the host. */
  serverName?: string
  /** Inline PEM material from an environment variable. */
  caPem?: string
  certPem?: string
  keyPem?: string
  /** File paths are the preferred source; both must be `0600`. */
  caFile?: string
  certFile?: string
  keyFile?: string
  clientEd25519KeyPem?: string
  clientEd25519KeyFile?: string
  /** Sender public key used to verify manifests/envelopes without its private key. */
  clientEd25519PublicKey?: string
  /** Pinned SHA-256 of the server certificate SPKI. */
  serverSpkiSha256: string
  /** Pinned SHA-256 of the client certificate SPKI (checked by the receiver). */
  clientSpkiSha256?: string
  /** Pinned Ed25519 public key used to verify manifests and session replies. */
  serverEd25519PublicKey: string
  /** Receiver X25519 public key used for envelope encryption. */
  recipientX25519PublicKey: string
  /** Optional receiver private key, used by `fetch`/verification tooling. */
  recipientX25519PrivateKeyPem?: string
  maxBundleBytes: number
  maxFileBytes: number
  maxTotalBytes: number
  timeoutMs: number
  maxAttempts: number
  maxSpoolEntries: number
  maxSpoolBytes: number
  allowPublicEndpoint: boolean
  /** Resolved addresses for this endpoint, pinned for the lifetime of a config. */
  resolvedAddresses?: readonly string[]
  spoolDir: string
  verifiedDir: string
  configPath?: string
  sourceSha?: string | null
  toolVersion?: string
  /** Hash over the destination and key pins; spool entries are bound to it. */
  destinationFingerprint: string
  /** Hash of host+port, safe to store in receipts. */
  endpointId: string
}
