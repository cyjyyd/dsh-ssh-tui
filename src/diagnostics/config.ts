/**
 * Diagnostics configuration.
 *
 * Default is off. Enabling requires an explicit env opt-in plus a complete
 * endpoint/credential set. The config file (when used) contains only host,
 * port, file paths and public pins — never a token or private key.
 */
import { readFileSync, lstatSync } from 'node:fs'
import { readFile, lstat } from 'node:fs/promises'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BUNDLE_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_SPOOL_BYTES,
  DEFAULT_MAX_SPOOL_ENTRIES,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  DiagnosticsError,
  MIN_PORT,
  type DiagnosticsConfig,
} from './types.js'
import {
  canonicalJson,
  normalizeHex,
  parsePin,
  parsePrivateKey,
  parsePublicKey,
  publicKeyId,
  sha256Hex,
} from './crypto.js'
import { COMMIT_PATTERN, HASH_PATTERN, VERSION_PATTERN } from './redact.js'

const CONFIG_KEYS = [
  'enabled', 'host', 'port', 'serverName', 'caFile', 'certFile', 'keyFile',
  'clientEd25519KeyFile', 'clientEd25519PublicKey', 'serverSpkiSha256', 'clientSpkiSha256',
  'serverEd25519PublicKey', 'recipientX25519PublicKey', 'recipientX25519PrivateKeyFile',
  'maxBundleBytes', 'maxFileBytes', 'maxTotalBytes', 'timeoutMs', 'maxAttempts',
  'maxSpoolEntries', 'maxSpoolBytes', 'allowPublicEndpoint', 'spoolDir', 'verifiedDir',
] as const

const ENV = {
  upload: 'DSH_DIAGNOSTICS_UPLOAD',
  config: 'DSH_DIAGNOSTICS_CONFIG',
  host: 'DSH_DIAGNOSTICS_HOST',
  port: 'DSH_DIAGNOSTICS_PORT',
  serverName: 'DSH_DIAGNOSTICS_SERVER_NAME',
  caFile: 'DSH_DIAGNOSTICS_CA_FILE',
  certFile: 'DSH_DIAGNOSTICS_CERT_FILE',
  keyFile: 'DSH_DIAGNOSTICS_KEY_FILE',
  caPem: 'DSH_DIAGNOSTICS_CA_PEM',
  certPem: 'DSH_DIAGNOSTICS_CERT_PEM',
  keyPem: 'DSH_DIAGNOSTICS_KEY_PEM',
  clientEd25519KeyFile: 'DSH_DIAGNOSTICS_CLIENT_ED25519_KEY_FILE',
  clientEd25519KeyPem: 'DSH_DIAGNOSTICS_CLIENT_ED25519_KEY_PEM',
  clientEd25519PublicKey: 'DSH_DIAGNOSTICS_CLIENT_ED25519_PUBLIC_KEY',
  serverSpki: 'DSH_DIAGNOSTICS_SERVER_SPKI',
  clientSpki: 'DSH_DIAGNOSTICS_CLIENT_SPKI',
  serverEd25519PublicKey: 'DSH_DIAGNOSTICS_SERVER_ED25519_PUBLIC_KEY',
  recipientX25519PublicKey: 'DSH_DIAGNOSTICS_RECIPIENT_X25519_PUBLIC_KEY',
  recipientX25519PrivateKeyFile: 'DSH_DIAGNOSTICS_RECIPIENT_X25519_PRIVATE_KEY_FILE',
  recipientX25519PrivateKeyPem: 'DSH_DIAGNOSTICS_RECIPIENT_X25519_PRIVATE_KEY_PEM',
  maxBundleBytes: 'DSH_DIAGNOSTICS_MAX_BUNDLE_BYTES',
  maxFileBytes: 'DSH_DIAGNOSTICS_MAX_FILE_BYTES',
  maxTotalBytes: 'DSH_DIAGNOSTICS_MAX_TOTAL_BYTES',
  timeoutMs: 'DSH_DIAGNOSTICS_TIMEOUT_MS',
  maxAttempts: 'DSH_DIAGNOSTICS_MAX_ATTEMPTS',
  maxSpoolEntries: 'DSH_DIAGNOSTICS_MAX_SPOOL_ENTRIES',
  maxSpoolBytes: 'DSH_DIAGNOSTICS_MAX_SPOOL_BYTES',
  allowPublic: 'DSH_DIAGNOSTICS_ALLOW_PUBLIC_ENDPOINT',
  spoolDir: 'DSH_DIAGNOSTICS_SPOOL_DIR',
  verifiedDir: 'DSH_DIAGNOSTICS_VERIFIED_DIR',
  sourceSha: 'DSH_TUI_COMMIT',
  home: 'DSH_HOME',
} as const

interface FileConfig {
  enabled?: boolean
  host?: string
  port?: number
  serverName?: string
  caFile?: string
  certFile?: string
  keyFile?: string
  clientEd25519KeyFile?: string
  clientEd25519PublicKey?: string
  serverSpkiSha256?: string
  clientSpkiSha256?: string
  serverEd25519PublicKey?: string
  recipientX25519PublicKey?: string
  recipientX25519PrivateKeyFile?: string
  maxBundleBytes?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  timeoutMs?: number
  maxAttempts?: number
  maxSpoolEntries?: number
  maxSpoolBytes?: number
  allowPublicEndpoint?: boolean
  spoolDir?: string
  verifiedDir?: string
}

export interface ResolveOptions {
  env?: NodeJS.ProcessEnv
  home?: string
  /** Tests inject a fake resolver; production uses dns.lookup. */
  resolveHost?: (host: string) => Promise<string[]>
}

function boolEnv(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  throw new DiagnosticsError('CONFIG_INVALID')
}

function intValue(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new DiagnosticsError('CONFIG_INVALID')
  return parsed
}

function readTextFileBounded(path: string, label: string): string {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink() || !info.isFile()) throw new DiagnosticsError('CONFIG_INVALID')
    if (info.size <= 0 || info.size > 1024 * 1024) throw new DiagnosticsError('CONFIG_INVALID')
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
      throw new DiagnosticsError('CONFIG_INVALID')
    }
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error instanceof DiagnosticsError) throw error
    throw new DiagnosticsError('CONFIG_INVALID', { cause: error })
  }
}

function pickPem(
  env: NodeJS.ProcessEnv,
  pemKey: string,
  fileKey: string,
  configFile: string | undefined,
  label: string,
): string | undefined {
  const inline = env[pemKey]
  if (inline !== undefined && inline.trim() !== '') {
    if (!/-----BEGIN [A-Z ]+-----/.test(inline)) throw new DiagnosticsError('CONFIG_INVALID')
    return inline
  }
  const file = env[fileKey] ?? configFile
  if (file !== undefined && file.trim() !== '') return readTextFileBounded(file, label)
  return undefined
}

export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[ENV.home]
  return explicit !== undefined && explicit.trim() !== '' ? explicit : homedir()
}

export function toolVersion(): string {
  try {
    const raw = readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')
    const parsed = JSON.parse(raw) as { version?: unknown }
    if (typeof parsed.version === 'string' && VERSION_PATTERN.test(parsed.version)) return parsed.version
  } catch {
    // Installed layouts always have package.json next to lib; tests may not.
  }
  return '0.0.0'
}

function fileConfigPath(env: NodeJS.ProcessEnv): string {
  const explicit = env[ENV.config]
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  return join(resolveDshHome(env), 'tui-diagnostics', 'config.json')
}

async function readConfigFile(path: string): Promise<FileConfig> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new DiagnosticsError('CONFIG_INVALID')
  for (const key of Object.keys(parsed)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) throw new DiagnosticsError('CONFIG_INVALID')
  }
  return parsed as FileConfig
}

function cleanHost(value: string): string {
  const host = value.trim()
  if (host.length === 0 || host.length > 253) throw new DiagnosticsError('CONFIG_INVALID')
  if (/[\s/?#@]/.test(host) || host.includes('://') || host.includes('\\')) throw new DiagnosticsError('CONFIG_INVALID')
  if (host.startsWith('[') || host.endsWith(']')) throw new DiagnosticsError('CONFIG_INVALID')
  if (host.includes(':') && isIP(host) !== 6) throw new DiagnosticsError('CONFIG_INVALID')
  return host
}

function parseSpki(value: string): string {
  const normalized = normalizeHex(value)
  if (!HASH_PATTERN.test(normalized)) throw new DiagnosticsError('CONFIG_INVALID')
  parsePin(normalized)
  return normalized
}

function isPrivateIp(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split('.').map((part) => Number(part))
    const [a, b] = parts
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 100 && b >= 64 && b <= 127) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 198 && (b === 18 || b === 19)) return true
    if (a >= 224) return true
    return false
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true
    if (lower.startsWith('ff')) return true
    if (lower.startsWith('::ffff:')) return isPrivateIp(lower.slice('::ffff:'.length))
    return false
  }
  return false
}

async function defaultResolve(host: string): Promise<string[]> {
  if (isIP(host) !== 0) return [host]
  let timer: NodeJS.Timeout | undefined
  try {
    const records = await Promise.race([
      lookup(host, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DiagnosticsError('CONFIG_INVALID')), 5_000)
        timer.unref?.()
      }),
    ])
    return records.map((record) => record.address)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function disabledConfig(env: NodeJS.ProcessEnv, home: string, sourceSha: string | null): DiagnosticsConfig {
  return {
    enabled: false,
    host: '',
    port: DEFAULT_PORT,
    serverSpkiSha256: '',
    serverEd25519PublicKey: '',
    recipientX25519PublicKey: '',
    maxBundleBytes: DEFAULT_MAX_BUNDLE_BYTES,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: DEFAULT_MAX_TOTAL_BYTES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    maxSpoolEntries: DEFAULT_MAX_SPOOL_ENTRIES,
    maxSpoolBytes: DEFAULT_MAX_SPOOL_BYTES,
    allowPublicEndpoint: false,
    spoolDir: env[ENV.spoolDir] ?? join(home, 'tui-diagnostics', 'spool'),
    verifiedDir: env[ENV.verifiedDir] ?? join(home, 'tui-diagnostics', 'verified'),
    sourceSha,
    toolVersion: toolVersion(),
    destinationFingerprint: sha256Hex('disabled'),
    endpointId: sha256Hex('disabled').slice(0, 32),
  }
}

export async function loadDiagnosticsConfig(options: ResolveOptions = {}): Promise<DiagnosticsConfig> {
  const env = options.env ?? process.env
  const home = options.home ?? resolveDshHome(env)
  const sourceShaRaw = env[ENV.sourceSha]
  const sourceSha = sourceShaRaw !== undefined && COMMIT_PATTERN.test(sourceShaRaw) ? sourceShaRaw : null
  const envEnabled = boolEnv(env[ENV.upload])
  const configPath = fileConfigPath(env)
  const file = await readConfigFile(configPath)
  const enabled = envEnabled ?? file.enabled === true
  if (!enabled) return disabledConfig(env, home, sourceSha)

  const host = cleanHost(env[ENV.host] ?? file.host ?? '')
  const port = intValue(env[ENV.port] ?? file.port, DEFAULT_PORT, MIN_PORT, 65535)
  if (port === 80 || port === 443) throw new DiagnosticsError('CONFIG_INVALID')
  const serverName = env[ENV.serverName] ?? file.serverName
  if (serverName !== undefined && (serverName.length === 0 || /[\s/?#@\\]/.test(serverName))) {
    throw new DiagnosticsError('CONFIG_INVALID')
  }

  const serverSpkiSha256 = parseSpki(env[ENV.serverSpki] ?? file.serverSpkiSha256 ?? '')
  const clientSpkiSha256 = env[ENV.clientSpki] ?? file.clientSpkiSha256
  const clientSpki = clientSpkiSha256 === undefined || clientSpkiSha256 === '' ? undefined : parseSpki(clientSpkiSha256)
  const serverEd25519PublicKey = env[ENV.serverEd25519PublicKey] ?? file.serverEd25519PublicKey ?? ''
  const recipientX25519PublicKey = env[ENV.recipientX25519PublicKey] ?? file.recipientX25519PublicKey ?? ''
  parsePublicKey(serverEd25519PublicKey, 'ed25519')
  parsePublicKey(recipientX25519PublicKey, 'x25519')

  const caMaterial = pickPem(env, ENV.caPem, ENV.caFile, file.caFile, 'ca')
  const certMaterial = pickPem(env, ENV.certPem, ENV.certFile, file.certFile, 'cert')
  const keyMaterial = pickPem(env, ENV.keyPem, ENV.keyFile, file.keyFile, 'key')
  if (caMaterial === undefined || certMaterial === undefined || keyMaterial === undefined) {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  const clientKeyMaterial = pickPem(
    env,
    ENV.clientEd25519KeyPem,
    ENV.clientEd25519KeyFile,
    file.clientEd25519KeyFile,
    'ed25519-key',
  )
  if (clientKeyMaterial === undefined) throw new DiagnosticsError('CONFIG_INVALID')
  const signingKey = parsePrivateKey(clientKeyMaterial, 'ed25519')
  const signingKeyId = publicKeyId(signingKey)
  const clientEd25519PublicKeyRaw = env[ENV.clientEd25519PublicKey] ?? file.clientEd25519PublicKey
  if (clientEd25519PublicKeyRaw !== undefined && typeof clientEd25519PublicKeyRaw !== 'string') {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  const clientEd25519PublicKey = clientEd25519PublicKeyRaw === undefined || clientEd25519PublicKeyRaw.trim() === ''
    ? undefined
    : parsePublicKey(clientEd25519PublicKeyRaw, 'ed25519')
  const verificationKeyId = clientEd25519PublicKey === undefined ? signingKeyId : publicKeyId(clientEd25519PublicKey)
  const recipientKeyId = publicKeyId(parsePublicKey(recipientX25519PublicKey, 'x25519'))
  const recipientPrivateMaterial = env[ENV.recipientX25519PrivateKeyPem] !== undefined
    ? (env[ENV.recipientX25519PrivateKeyPem] as string)
    : (env[ENV.recipientX25519PrivateKeyFile] ?? file.recipientX25519PrivateKeyFile) !== undefined
      ? readTextFileBounded(env[ENV.recipientX25519PrivateKeyFile] ?? (file.recipientX25519PrivateKeyFile as string), 'recipient-key')
      : undefined
  if (recipientPrivateMaterial !== undefined && recipientPrivateMaterial.trim() !== '') {
    parsePrivateKey(recipientPrivateMaterial, 'x25519')
  }

  const allowPublicEndpoint = boolEnv(env[ENV.allowPublic]) ?? file.allowPublicEndpoint === true
  let addresses: string[]
  try {
    addresses = await (options.resolveHost ?? defaultResolve)(host)
  } catch {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  if (addresses.length === 0) throw new DiagnosticsError('CONFIG_INVALID')
  if (!allowPublicEndpoint && addresses.some((address) => !isPrivateIp(address))) {
    throw new DiagnosticsError('PUBLIC_ENDPOINT_REFUSED')
  }

  const maxBundleBytes = intValue(
    env[ENV.maxBundleBytes] ?? file.maxBundleBytes,
    DEFAULT_MAX_BUNDLE_BYTES,
    1024,
    32 * 1024 * 1024,
  )
  const maxFileBytes = intValue(
    env[ENV.maxFileBytes] ?? file.maxFileBytes,
    DEFAULT_MAX_FILE_BYTES,
    256,
    1024 * 1024,
  )
  const maxTotalBytes = intValue(
    env[ENV.maxTotalBytes] ?? file.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    1024,
    4 * 1024 * 1024,
  )
  if (maxTotalBytes > maxBundleBytes) throw new DiagnosticsError('CONFIG_INVALID')
  const timeoutMs = intValue(env[ENV.timeoutMs] ?? file.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 60_000)
  const maxAttempts = intValue(env[ENV.maxAttempts] ?? file.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 10)
  const maxSpoolEntries = intValue(
    env[ENV.maxSpoolEntries] ?? file.maxSpoolEntries,
    DEFAULT_MAX_SPOOL_ENTRIES,
    1,
    1024,
  )
  const maxSpoolBytes = intValue(
    env[ENV.maxSpoolBytes] ?? file.maxSpoolBytes,
    DEFAULT_MAX_SPOOL_BYTES,
    1024 * 1024,
    4 * 1024 * 1024 * 1024,
  )
  if (maxSpoolBytes < maxBundleBytes) throw new DiagnosticsError('CONFIG_INVALID')
  const spoolDir = env[ENV.spoolDir] ?? file.spoolDir ?? join(home, 'tui-diagnostics', 'spool')
  const verifiedDir = env[ENV.verifiedDir] ?? file.verifiedDir ?? join(home, 'tui-diagnostics', 'verified')

  const fingerprintInput = {
    host,
    port,
    serverSpkiSha256,
    clientSpkiSha256: clientSpki ?? '',
    serverEd25519KeyId: publicKeyId(parsePublicKey(serverEd25519PublicKey, 'ed25519')),
    recipientKeyId,
    signingKeyId,
    verificationKeyId,
  }
  const destinationFingerprint = sha256Hex(canonicalJson(fingerprintInput))
  const endpointId = sha256Hex(`${host}:${port}`).slice(0, 32)

  return {
    enabled: true,
    host,
    port,
    ...(serverName === undefined ? {} : { serverName }),
    caPem: caMaterial,
    certPem: certMaterial,
    keyPem: keyMaterial,
    ...(env[ENV.caFile] === undefined && file.caFile === undefined ? {} : { caFile: env[ENV.caFile] ?? file.caFile }),
    ...(env[ENV.certFile] === undefined && file.certFile === undefined ? {} : { certFile: env[ENV.certFile] ?? file.certFile }),
    ...(env[ENV.keyFile] === undefined && file.keyFile === undefined ? {} : { keyFile: env[ENV.keyFile] ?? file.keyFile }),
    clientEd25519KeyPem: clientKeyMaterial,
    ...(clientEd25519PublicKey === undefined ? {} : { clientEd25519PublicKey: clientEd25519PublicKeyRaw }),
    ...(env[ENV.clientEd25519KeyFile] === undefined && file.clientEd25519KeyFile === undefined
      ? {}
      : { clientEd25519KeyFile: env[ENV.clientEd25519KeyFile] ?? file.clientEd25519KeyFile }),
    serverSpkiSha256,
    ...(clientSpki === undefined ? {} : { clientSpkiSha256: clientSpki }),
    serverEd25519PublicKey,
    recipientX25519PublicKey,
    ...(recipientPrivateMaterial === undefined || recipientPrivateMaterial.trim() === ''
      ? {}
      : { recipientX25519PrivateKeyPem: recipientPrivateMaterial }),
    maxBundleBytes,
    maxFileBytes,
    maxTotalBytes,
    timeoutMs,
    maxAttempts,
    maxSpoolEntries,
    maxSpoolBytes,
    allowPublicEndpoint,
    resolvedAddresses: addresses,
    spoolDir,
    verifiedDir,
    configPath,
    sourceSha,
    toolVersion: toolVersion(),
    destinationFingerprint,
    endpointId,
  }
}

/** Strict, non-secret view for status output. */
export function describeDiagnosticsConfig(config: DiagnosticsConfig): Record<string, unknown> {
  return {
    enabled: config.enabled,
    endpointId: config.enabled ? config.endpointId : null,
    port: config.enabled ? config.port : null,
    maxBundleBytes: config.maxBundleBytes,
    maxAttempts: config.maxAttempts,
    maxSpoolEntries: config.maxSpoolEntries,
    maxSpoolBytes: config.maxSpoolBytes,
    allowPublicEndpoint: config.allowPublicEndpoint,
    spoolDir: config.spoolDir,
    destinationFingerprint: config.enabled ? config.destinationFingerprint.slice(0, 16) : null,
  }
}

export const DIAGNOSTICS_CONFIG_KEYS = CONFIG_KEYS
