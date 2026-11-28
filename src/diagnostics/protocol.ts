/**
 * Wire protocol helpers shared by the client and the reference receiver.
 *
 * Identity is cryptographic: mTLS certificate + SPKI pin, an Ed25519 signature
 * on every request, a timestamp window and a nonce replay cache. The bearer
 * value is a short-lived, one-time session token issued over mTLS; it never
 * appears in a URL and is never logged.
 */
import type { KeyObject } from 'node:crypto'
import type { X509Certificate } from 'node:crypto'
import { DiagnosticsError } from './types.js'
import { sha256Hex, signEd25519, verifyEd25519 } from './crypto.js'

export const SESSION_TTL_MS = 5 * 60 * 1000
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,96}$/
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
export const BUNDLE_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/
export const UPLOAD_PATH_PATTERN = /^\/v1\/diagnostics\/[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024
export const DEFAULT_CHUNK_BYTES = 1024 * 1024

export type Operation = 'upload' | 'download'

export interface SessionRequest {
  operation: Operation
  bundleId: string
  clientNonce: string
  timestamp: number
  clientSpkiSha256: string
}

export interface SessionGrant {
  token: string
  operation: Operation
  bundleId: string
  clientSpkiSha256: string
  expiresAt: number
  usedNonces: Set<string>
  consumed: boolean
}

export function sessionRequestPayload(request: SessionRequest): string {
  return [
    'dsh-diag-session-request-v1',
    request.operation,
    request.bundleId,
    request.clientNonce,
    String(request.timestamp),
    request.clientSpkiSha256,
  ].join('\n')
}

export function sessionResponsePayload(input: {
  token: string
  expiresAt: number
  serverNonce: string
  clientNonce: string
}): string {
  return [
    'dsh-diag-session-response-v1',
    sha256Hex(input.token),
    String(input.expiresAt),
    input.serverNonce,
    input.clientNonce,
  ].join('\n')
}

export interface SignedRequest {
  method: string
  path: string
  bodySha256: string | null
  uploadOffset: number
  nonce: string
  timestamp: number
  token: string
}

export function requestPayload(request: SignedRequest): string {
  return [
    'dsh-diag-request-v1',
    request.method.toUpperCase(),
    request.path,
    request.bodySha256 ?? '-',
    String(request.uploadOffset),
    request.nonce,
    String(request.timestamp),
    sha256Hex(request.token),
  ].join('\n')
}

export function signSessionRequest(key: KeyObject, request: SessionRequest): string {
  return signEd25519(key, sessionRequestPayload(request))
}

export function verifySessionRequest(publicKey: KeyObject, request: SessionRequest, signature: string): void {
  if (!verifyEd25519(publicKey, sessionRequestPayload(request), signature)) {
    throw new DiagnosticsError('AUTH_FAILED')
  }
}

export function signSessionResponse(key: KeyObject, input: {
  token: string
  expiresAt: number
  serverNonce: string
  clientNonce: string
}): string {
  return signEd25519(key, sessionResponsePayload(input))
}

export function verifySessionResponse(publicKey: KeyObject, response: {
  token: string
  expiresAt: number
  serverNonce: string
  clientNonce: string
  serverSignature: string
}): void {
  if (!verifyEd25519(publicKey, sessionResponsePayload(response), response.serverSignature)) {
    throw new DiagnosticsError('SESSION_FAILED')
  }
}

export function signRequest(key: KeyObject, request: SignedRequest): string {
  return signEd25519(key, requestPayload(request))
}

export function verifyRequest(publicKey: KeyObject, request: SignedRequest, signature: string): void {
  if (!verifyEd25519(publicKey, requestPayload(request), signature)) {
    throw new DiagnosticsError('AUTH_FAILED')
  }
}

export function checkTimestamp(timestamp: number, now: number = Date.now()): void {
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) {
    throw new DiagnosticsError('REPLAY_REJECTED')
  }
}

export function checkNonce(nonce: string): void {
  if (!NONCE_PATTERN.test(nonce)) throw new DiagnosticsError('AUTH_FAILED')
}

export function checkToken(token: string): void {
  if (!TOKEN_PATTERN.test(token)) throw new DiagnosticsError('AUTH_FAILED')
}

export class ReplayCache {
  private readonly seen = new Map<string, number>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(options: { ttlMs?: number; now?: () => number } = {}) {
    this.ttlMs = options.ttlMs ?? MAX_CLOCK_SKEW_MS
    this.now = options.now ?? Date.now
  }

  /** Returns false when the nonce was already used (replay). */
  remember(nonce: string): boolean {
    const now = this.now()
    for (const [key, expiry] of this.seen) {
      if (expiry <= now) this.seen.delete(key)
    }
    if (this.seen.has(nonce)) return false
    this.seen.set(nonce, now + this.ttlMs)
    return true
  }

  get size(): number {
    return this.seen.size
  }
}

export class SessionStore {
  private readonly grants = new Map<string, SessionGrant>()
  private readonly now: () => number

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now
  }

  issue(grant: SessionGrant): void {
    this.grants.set(grant.token, grant)
  }

  /** Validate, bind and return the grant. The token is not consumed here. */
  get(token: string, operation: Operation, bundleId: string, clientSpkiSha256: string): SessionGrant {
    const grant = this.grants.get(token)
    if (grant === undefined) throw new DiagnosticsError('AUTH_FAILED')
    if (grant.consumed || grant.expiresAt <= this.now()) {
      this.grants.delete(token)
      throw new DiagnosticsError('AUTH_FAILED')
    }
    if (grant.operation !== operation || grant.bundleId !== bundleId) throw new DiagnosticsError('AUTH_FAILED')
    if (grant.clientSpkiSha256 !== clientSpkiSha256) throw new DiagnosticsError('AUTH_FAILED')
    return grant
  }

  consume(grant: SessionGrant): void {
    grant.consumed = true
    this.grants.delete(grant.token)
  }

  purge(): void {
    const now = this.now()
    for (const [token, grant] of this.grants) {
      if (grant.expiresAt <= now) this.grants.delete(token)
    }
  }

  get size(): number {
    return this.grants.size
  }
}

export function spkiFromCertificate(certificate: X509Certificate): string {
  try {
    const der = certificate.publicKey.export({ type: 'spki', format: 'der' })
    return sha256Hex(der)
  } catch {
    throw new DiagnosticsError('TLS_FAILED')
  }
}

export function peerSpki(socket: { getPeerX509Certificate?: () => X509Certificate | undefined; getPeerCertificate?: () => { pubkey?: Buffer; raw?: Buffer } }): string {
  try {
    const certificate = socket.getPeerX509Certificate?.()
    if (certificate !== undefined) return spkiFromCertificate(certificate)
  } catch {
    // Fall through to the legacy peer certificate shape.
  }
  const peer = socket.getPeerCertificate?.()
  if (peer?.pubkey === undefined) throw new DiagnosticsError('TLS_FAILED')
  return sha256Hex(peer.pubkey)
}
