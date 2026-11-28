/**
 * Small, dependency-free cryptography and canonicalisation helpers.
 *
 * Everything here is synchronous and uses only `node:crypto`. Keys are never
 * logged, serialised into manifests or included in errors: callers only ever
 * see public-key fingerprints / key ids.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto'
import {
  DiagnosticsError,
  ENVELOPE_ALG,
  ENVELOPE_MAGIC,
  ENVELOPE_VERSION,
  type EnvelopeHeader,
} from './types.js'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ENVELOPE_INFO = 'dsh-diag-envelope-v1'

export function sha256(data: Buffer | string): Buffer {
  return createHash('sha256').update(data).digest()
}

export function sha256Hex(data: Buffer | string): string {
  return sha256(data).toString('hex')
}

export function sha256Base64(data: Buffer | string): string {
  return sha256(data).toString('base64')
}

export function sha256FileId(data: Buffer | string): string {
  return sha256Hex(data).slice(0, 32)
}

export function randomBytesBuffer(size: number): Buffer {
  return randomBytes(size)
}

export function randomToken(size = 32): string {
  return randomBytes(size).toString('base64url')
}

/** Strict base64 decoder: rejects non-canonical input instead of guessing. */
export function decodeBase64(value: string, field: string): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 * 1024) {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  const normalized = value.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  const decoded = Buffer.from(normalized, 'base64')
  if (decoded.toString('base64') !== normalized) throw new DiagnosticsError('CONFIG_INVALID')
  void field
  return decoded
}

/**
 * Deterministic JSON: object keys sorted, no undefined/functions/symbols,
 * finite numbers only. This is the canonical form used for signatures.
 */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const walk = (node: unknown, depth: number): string => {
    if (depth > 32) throw new DiagnosticsError('CONFIG_INVALID')
    if (node === null) return 'null'
    if (typeof node === 'string') return JSON.stringify(node)
    if (typeof node === 'boolean') return node ? 'true' : 'false'
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new DiagnosticsError('CONFIG_INVALID')
      return JSON.stringify(node)
    }
    if (Array.isArray(node)) {
      if (seen.has(node)) throw new DiagnosticsError('CONFIG_INVALID')
      seen.add(node)
      const out = `[${node.map((item) => walk(item, depth + 1)).join(',')}]`
      seen.delete(node)
      return out
    }
    if (typeof node === 'object') {
      const record = node as Record<string, unknown>
      if (seen.has(record)) throw new DiagnosticsError('CONFIG_INVALID')
      seen.add(record)
      const keys = Object.keys(record).sort()
      const parts: string[] = []
      for (const key of keys) {
        const child = record[key]
        if (child === undefined) continue
        if (typeof child === 'function' || typeof child === 'symbol' || typeof child === 'bigint') {
          throw new DiagnosticsError('CONFIG_INVALID')
        }
        parts.push(`${JSON.stringify(key)}:${walk(child, depth + 1)}`)
      }
      seen.delete(record)
      return `{${parts.join(',')}}`
    }
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  return walk(value, 0)
}

export function constantTimeEqual(a: Buffer | string, b: Buffer | string): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a)
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export function normalizeHex(value: string): string {
  return value.trim().toLowerCase().replace(/^sha256[:-]?/, '').replace(/[^0-9a-f]/g, '')
}

export function isHex(value: string, lengths: readonly number[]): boolean {
  return lengths.includes(value.length) && /^[0-9a-f]+$/.test(value)
}

export function parsePublicKey(value: string, kind: 'x25519' | 'ed25519'): KeyObject {
  const text = value.trim()
  if (text.includes('-----BEGIN PUBLIC KEY-----')) {
    try {
      const key = createPublicKey(text)
      if (key.asymmetricKeyType !== kind) throw new Error('wrong key type')
      return key
    } catch {
      throw new DiagnosticsError('CONFIG_INVALID')
    }
  }
  const raw = text.startsWith('raw:') ? text.slice(4) : text
  const decoded = decodeBase64(raw, kind)
  if (decoded.length !== 32) throw new DiagnosticsError('CONFIG_INVALID')
  const prefix = kind === 'x25519' ? X25519_SPKI_PREFIX : ED25519_SPKI_PREFIX
  try {
    const key = createPublicKey({ key: Buffer.concat([prefix, decoded]), format: 'der', type: 'spki' })
    if (key.asymmetricKeyType !== kind) throw new Error('wrong key type')
    return key
  } catch {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
}

export function parsePrivateKey(value: string, kind: 'ed25519' | 'x25519'): KeyObject {
  const text = value.trim()
  try {
    const key = createPrivateKey(text)
    if (key.asymmetricKeyType !== kind) throw new Error('wrong key type')
    return key
  } catch {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
}

export function publicKeyRaw(key: KeyObject): Buffer {
  const publicKey = key.type === 'private' ? createPublicKey(key) : key
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const prefix = publicKey.asymmetricKeyType === 'x25519' ? X25519_SPKI_PREFIX : ED25519_SPKI_PREFIX
  if (der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new DiagnosticsError('CONFIG_INVALID')
  }
  return der.subarray(prefix.length)
}

export function publicKeyId(key: KeyObject): string {
  return sha256Hex(publicKeyRaw(key))
}

export function parsePin(value: string): Buffer {
  const normalized = normalizeHex(value)
  if (!isHex(normalized, [64])) throw new DiagnosticsError('CONFIG_INVALID')
  return Buffer.from(normalized, 'hex')
}

export function spkiSha256(cert: { pubkey?: Buffer; raw?: Buffer } | undefined): Buffer {
  if (cert === undefined) throw new DiagnosticsError('TLS_FAILED')
  // Node's PeerCertificate.pubkey is the raw public key (for EC, an
  // uncompressed point), not the SPKI DER. Parse the certificate itself so the
  // pin is over the same stable SPKI representation everywhere.
  if (cert.raw !== undefined) {
    try {
      const certificate = new X509Certificate(cert.raw)
      return sha256(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    } catch {
      throw new DiagnosticsError('TLS_FAILED')
    }
  }
  if (cert.pubkey === undefined) throw new DiagnosticsError('TLS_FAILED')
  return sha256(cert.pubkey)
}

export function signEd25519(privateKey: KeyObject, payload: Buffer | string): string {
  return sign(null, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), privateKey).toString('base64')
}

export function verifyEd25519(publicKey: KeyObject, payload: Buffer | string, signatureBase64: string): boolean {
  let signature: Buffer
  try {
    signature = decodeBase64(signatureBase64, 'signature')
  } catch {
    return false
  }
  if (signature.length !== 64) return false
  return verify(null, Buffer.isBuffer(payload) ? payload : Buffer.from(payload), publicKey, signature)
}

export interface EncryptEnvelopeInput {
  bundleId: string
  archive: Buffer
  archiveSha256: string
  manifestBytes: Buffer
  manifestSha256: string
  recipientPublicKey: KeyObject
}

export interface EncryptedEnvelope {
  envelope: Buffer
  header: EnvelopeHeader
}

export function encryptEnvelope(input: EncryptEnvelopeInput): EncryptedEnvelope {
  const recipientKeyId = publicKeyId(input.recipientPublicKey)
  const ephemeral = generateKeyPairSync('x25519')
  const salt = randomBytes(16)
  const nonce = randomBytes(12)
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: input.recipientPublicKey })
  const key = Buffer.from(hkdfSync('sha256', shared, salt, ENVELOPE_INFO, 32))
  const header: EnvelopeHeader = {
    v: ENVELOPE_VERSION,
    alg: ENVELOPE_ALG,
    bundleId: input.bundleId,
    recipientKeyId,
    ephemeralPublicKey: publicKeyRaw(ephemeral.publicKey).toString('base64'),
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    archiveSha256: input.archiveSha256,
    archiveBytes: input.archive.length,
    manifestSha256: input.manifestSha256,
    ciphertextBytes: input.archive.length + 16,
  }
  const headerBytes = Buffer.from(canonicalJson(header), 'utf8')
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(headerBytes)
  const ciphertext = Buffer.concat([cipher.update(input.archive), cipher.final(), cipher.getAuthTag()])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(headerBytes.length, 0)
  const envelope = Buffer.concat([
    Buffer.from(ENVELOPE_MAGIC, 'ascii'),
    length,
    headerBytes,
    ciphertext,
  ])
  return { envelope, header }
}

export interface DecryptedEnvelope {
  header: EnvelopeHeader
  archive: Buffer
  archiveSha256: string
  manifestSha256: string
}

export interface InspectedEnvelope {
  header: EnvelopeHeader
  headerBytes: Buffer
  ciphertext: Buffer
}

/** Parse and structurally validate an envelope without decrypting it. */
export function inspectEnvelope(envelope: Buffer): InspectedEnvelope {
  const magic = Buffer.from(ENVELOPE_MAGIC, 'ascii')
  if (envelope.length < magic.length + 4 + 2 + 16) throw new DiagnosticsError('INTEGRITY_FAILED')
  if (!envelope.subarray(0, magic.length).equals(magic)) throw new DiagnosticsError('INTEGRITY_FAILED')
  const headerLength = envelope.readUInt32BE(magic.length)
  if (headerLength < 2 || headerLength > 64 * 1024) throw new DiagnosticsError('INTEGRITY_FAILED')
  const headerStart = magic.length + 4
  if (headerStart + headerLength + 16 > envelope.length) throw new DiagnosticsError('INTEGRITY_FAILED')
  const headerBytes = envelope.subarray(headerStart, headerStart + headerLength)
  let header: EnvelopeHeader
  try {
    header = JSON.parse(headerBytes.toString('utf8')) as EnvelopeHeader
  } catch {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  if (header.v !== ENVELOPE_VERSION || header.alg !== ENVELOPE_ALG) throw new DiagnosticsError('INTEGRITY_FAILED')
  if (header.ciphertextBytes !== envelope.length - headerStart - headerLength) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  if (header.ciphertextBytes !== header.archiveBytes + 16) throw new DiagnosticsError('INTEGRITY_FAILED')
  return { header, headerBytes, ciphertext: envelope.subarray(headerStart + headerLength) }
}

export function decryptEnvelope(envelope: Buffer, recipientPrivateKey: KeyObject): DecryptedEnvelope {
  const parsed = inspectEnvelope(envelope)
  const { header, headerBytes, ciphertext } = parsed
  if (header.recipientKeyId !== publicKeyId(recipientPrivateKey)) throw new DiagnosticsError('INTEGRITY_FAILED')
  let ephemeralKey: KeyObject
  try {
    ephemeralKey = parsePublicKey(header.ephemeralPublicKey, 'x25519')
  } catch {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const salt = decodeBase64(header.salt, 'salt')
  const nonce = decodeBase64(header.nonce, 'nonce')
  if (salt.length !== 16 || nonce.length !== 12) throw new DiagnosticsError('INTEGRITY_FAILED')
  const shared = diffieHellman({ privateKey: recipientPrivateKey, publicKey: ephemeralKey })
  const key = Buffer.from(hkdfSync('sha256', shared, salt, ENVELOPE_INFO, 32))
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const body = ciphertext.subarray(0, ciphertext.length - 16)
  let archive: Buffer
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAAD(headerBytes)
    decipher.setAuthTag(tag)
    archive = Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  const archiveSha256 = sha256Hex(archive)
  if (archiveSha256 !== header.archiveSha256 || archive.length !== header.archiveBytes) {
    throw new DiagnosticsError('INTEGRITY_FAILED')
  }
  return { header, archive, archiveSha256, manifestSha256: header.manifestSha256 }
}

export function makeBundleId(now: number, random: Buffer = randomBytes(8)): string {
  const date = new Date(now)
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const stamp = [
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`,
    pad(date.getUTCMilliseconds(), 3),
  ].join('-')
  return `${stamp}-${random.toString('hex')}`
}
