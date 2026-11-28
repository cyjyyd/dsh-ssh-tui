/**
 * mTLS transport for the diagnostics handoff.
 *
 * Only outbound connections are made. There is no listener, no default
 * endpoint, no redirect following, no HTTP fallback and no static token in a
 * URL. TLS 1.3 is mandatory, the server SPKI is pinned, and every request
 * carries a fresh nonce, timestamp, Ed25519 signature and one-time session
 * token issued over the authenticated channel.
 */
import { request as httpsRequest } from 'node:https'
import { checkServerIdentity as tlsCheckServerIdentity } from 'node:tls'
import { X509Certificate, createPublicKey, type KeyObject } from 'node:crypto'
import { isIP } from 'node:net'
import {
  DEFAULT_CHUNK_BYTES,
  MAX_CHUNK_BYTES,
  BUNDLE_ID_PATTERN,
  checkNonce,
  checkTimestamp,
  checkToken,
  peerSpki,
  signRequest,
  signSessionRequest,
  spkiFromCertificate,
  verifySessionResponse,
  type Operation,
  type SignedRequest,
} from './protocol.js'
import { verifyManifestSignature, validateManifest } from './bundle.js'
import {
  DiagnosticsError,
  type DiagnosticsConfig,
  type DiagnosticsManifest,
  type PreparedBundle,
  type RemoteLocator,
} from './types.js'
import { backoffMs } from './spool.js'
import {
  canonicalJson,
  constantTimeEqual,
  parsePrivateKey,
  parsePublicKey,
  publicKeyId,
  randomToken,
  sha256Hex,
  spkiSha256,
} from './crypto.js'


const SESSION_PATH = '/v1/session'
const MAX_JSON_BYTES = 64 * 1024
const MAX_RESPONSE_SLACK = 64 * 1024

export interface DiagnosticsTransportOptions {
  now?: () => number
  random?: () => number
  chunkBytes?: number
  sleep?: (ms: number) => Promise<void>
}

interface HttpResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

interface SessionGrant {
  token: string
  expiresAt: number
}

function headerValue(headers: HttpResponse['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  if (Array.isArray(value)) return value[0]
  return value
}

function parseJsonBody<T>(body: Buffer, limit = MAX_JSON_BYTES): T {
  if (body.length === 0 || body.length > limit) throw new DiagnosticsError('SERVER_ERROR')
  try {
    return JSON.parse(body.toString('utf8')) as T
  } catch {
    throw new DiagnosticsError('SERVER_ERROR')
  }
}

function statusError(status: number): DiagnosticsError {
  if (status === 401 || status === 403) return new DiagnosticsError('AUTH_FAILED')
  if (status === 404 || status === 410) return new DiagnosticsError('DOWNLOAD_FAILED')
  if (status === 409) return new DiagnosticsError('CLIENT_ERROR')
  if (status === 413) return new DiagnosticsError('TOO_LARGE')
  if (status === 408 || status === 425 || status === 429) return new DiagnosticsError('RATE_LIMITED', { retryable: true })
  if (status >= 500) return new DiagnosticsError('SERVER_ERROR', { retryable: true })
  if (status >= 300 && status < 400) return new DiagnosticsError('REDIRECT_REFUSED')
  return new DiagnosticsError('CLIENT_ERROR')
}

export class DiagnosticsTransport {
  private readonly config: DiagnosticsConfig
  private readonly now: () => number
  private readonly random: () => number
  private readonly chunkBytes: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly signingKey: KeyObject
  private readonly signingPublicKey: KeyObject
  private readonly serverPublicKey: KeyObject
  private readonly clientSpki: string

  constructor(config: DiagnosticsConfig, options: DiagnosticsTransportOptions = {}) {
    this.config = config
    this.now = options.now ?? Date.now
    this.random = options.random ?? Math.random
    this.chunkBytes = Math.max(1024, Math.min(MAX_CHUNK_BYTES, options.chunkBytes ?? DEFAULT_CHUNK_BYTES))
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    if (!config.enabled) throw new DiagnosticsError('DISABLED')
    if (config.certPem === undefined || config.keyPem === undefined || config.caPem === undefined) {
      throw new DiagnosticsError('CONFIG_INVALID')
    }
    if (config.clientEd25519KeyPem === undefined) throw new DiagnosticsError('CONFIG_INVALID')
    this.signingKey = parsePrivateKey(config.clientEd25519KeyPem, 'ed25519')
    this.signingPublicKey = createPublicKey(this.signingKey)
    this.serverPublicKey = parsePublicKey(config.serverEd25519PublicKey, 'ed25519')
    let certificate: X509Certificate
    try {
      certificate = new X509Certificate(config.certPem)
    } catch {
      throw new DiagnosticsError('CONFIG_INVALID')
    }
    this.clientSpki = spkiFromCertificate(certificate)
  }

  manifestPublicKey(): KeyObject {
    return this.signingPublicKey
  }

  private endpointPath(bundleId: string): string {
    if (!BUNDLE_ID_PATTERN.test(bundleId)) throw new DiagnosticsError('CONFIG_INVALID')
    return `/v1/diagnostics/${bundleId}`
  }

  private buildRequestOptions(method: string, path: string, headers: Record<string, string | number>): {
    host: string
    port: number
    method: string
    path: string
    headers: Record<string, string | number>
    ca: string
    cert: string
    key: string
    minVersion: 'TLSv1.3'
    maxVersion: 'TLSv1.3'
    rejectUnauthorized: true
    servername?: string
    lookup: (hostname: string, options: unknown, callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => void
    checkServerIdentity: (hostname: string, cert: { pubkey?: Buffer; raw?: Buffer }) => Error | undefined
  } {
    const config = this.config
    const addresses = config.resolvedAddresses ?? []
    const expectedPin = config.serverSpkiSha256
    const lookup = (
      _hostname: string,
      _options: unknown,
      callback: (error: NodeJS.ErrnoException | null, address: string, family: number) => void,
    ): void => {
      const address = addresses[0]
      if (address === undefined) {
        callback(new DiagnosticsError('CONFIG_INVALID'), '', 0)
        return
      }
      callback(null, address, isIP(address) === 6 ? 6 : 4)
    }
    const checkServerIdentity = (hostname: string, cert: { pubkey?: Buffer; raw?: Buffer }): Error | undefined => {
      const hostError = tlsCheckServerIdentity(hostname, cert as never)
      if (hostError !== undefined) return hostError
      let actual: string
      try {
        actual = spkiSha256(cert).toString('hex')
      } catch {
        return new Error('DSH_TLS_PIN_MISMATCH')
      }
      if (!constantTimeEqual(actual, expectedPin)) {
        const error = new Error('DSH_TLS_PIN_MISMATCH')
        ;(error as NodeJS.ErrnoException).code = 'ERR_DSH_PIN_MISMATCH'
        return error
      }
      return undefined
    }
    const serverName = config.serverName ?? (isIP(config.host) === 0 ? config.host : undefined)
    return {
      host: config.host,
      port: config.port,
      method,
      path,
      headers,
      ca: config.caPem as string,
      cert: config.certPem as string,
      key: config.keyPem as string,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      ...(serverName === undefined ? {} : { servername: serverName }),
      lookup,
      checkServerIdentity,
    }
  }

  private async rawRequest(
    method: string,
    path: string,
    headers: Record<string, string | number>,
    body: Buffer | undefined,
    maxResponseBytes: number,
  ): Promise<HttpResponse> {
    const options = this.buildRequestOptions(method, path, {
      ...headers,
      ...(body === undefined ? {} : { 'content-length': body.length }),
    })
    return await new Promise<HttpResponse>((resolve, reject) => {
      let settled = false
      let secure = false
      let timer: NodeJS.Timeout | undefined
      const finish = (error: DiagnosticsError | undefined, response?: HttpResponse): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        if (error !== undefined) reject(error)
        else if (response !== undefined) resolve(response)
      }
      const req = httpsRequest(options, (res) => {
        const chunks: Buffer[] = []
        let received = 0
        res.on('data', (chunk: Buffer) => {
          received += chunk.length
          if (received > maxResponseBytes) {
            req.destroy(new DiagnosticsError('TOO_LARGE'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          finish(undefined, {
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
        res.on('error', (error) => finish(this.mapNetworkError(error)))
      })
      req.on('socket', (socket) => {
        socket.on('secureConnect', () => {
          secure = true
        })
      })
      req.on('error', (error) => finish(this.mapNetworkError(error, secure)))
      timer = setTimeout(() => {
        req.destroy(new DiagnosticsError('TIMEOUT', { retryable: true }))
      }, this.config.timeoutMs)
      timer.unref?.()
      if (body !== undefined) req.write(body)
      req.end()
    })
  }

  private mapNetworkError(error: unknown, secure = true): DiagnosticsError {
    if (error instanceof DiagnosticsError) return error
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ERR_DSH_PIN_MISMATCH') return new DiagnosticsError('PIN_MISMATCH')
    if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return new DiagnosticsError('TIMEOUT', { retryable: true })
    const text = `${code ?? ''} ${(error as Error | undefined)?.message ?? ''}`
    if (/ERR_SSL|ERR_TLS|CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|ALTNAME|EPROTO/.test(text)) {
      return new DiagnosticsError('TLS_FAILED')
    }
    if (
      code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' ||
      code === 'EHOSTUNREACH' || code === 'EPIPE' || code === 'EAI_AGAIN'
    ) {
      // A reset before the TLS handshake completed is a certificate/auth
      // rejection, not a transient network failure: never retry it.
      if (!secure) return new DiagnosticsError('TLS_FAILED')
      return new DiagnosticsError('NETWORK', { retryable: true })
    }
    return new DiagnosticsError('NETWORK', { retryable: true })
  }

  private async call(
    method: string,
    path: string,
    headers: Record<string, string | number>,
    body: Buffer | undefined,
    maxResponseBytes = MAX_JSON_BYTES,
  ): Promise<HttpResponse> {
    const response = await this.rawRequest(method, path, headers, body, maxResponseBytes)
    if (response.status < 200 || response.status >= 300) throw statusError(response.status)
    return response
  }

  private sessionRequest(operation: Operation, bundleId: string): { body: Buffer; nonce: string } {
    const timestamp = this.now()
    const clientNonce = randomToken(24)
    const request = {
      operation,
      bundleId,
      clientNonce,
      timestamp,
      clientSpkiSha256: this.clientSpki,
    }
    const signature = signSessionRequest(this.signingKey, request)
    const body = Buffer.from(canonicalJson({ ...request, signature }), 'utf8')
    return { body, nonce: clientNonce }
  }

  private async openSession(operation: Operation, bundleId: string): Promise<SessionGrant> {
    const { body } = this.sessionRequest(operation, bundleId)
    const response = await this.call('POST', SESSION_PATH, {
      'content-type': 'application/json',
      accept: 'application/json',
    }, body)
    const parsed = parseJsonBody<{
      token?: unknown
      expiresAt?: unknown
      serverNonce?: unknown
      serverSignature?: unknown
    }>(response.body)
    if (typeof parsed.token !== 'string' || typeof parsed.expiresAt !== 'number' ||
      typeof parsed.serverNonce !== 'string' || typeof parsed.serverSignature !== 'string') {
      throw new DiagnosticsError('SESSION_FAILED')
    }
    checkToken(parsed.token)
    checkNonce(parsed.serverNonce)
    if (!Number.isSafeInteger(parsed.expiresAt) || parsed.expiresAt <= this.now() ||
      parsed.expiresAt > this.now() + 10 * 60 * 1000) {
      throw new DiagnosticsError('SESSION_FAILED')
    }
    const request = JSON.parse(body.toString('utf8')) as { clientNonce: string }
    verifySessionResponse(this.serverPublicKey, {
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      serverNonce: parsed.serverNonce,
      clientNonce: request.clientNonce,
      serverSignature: parsed.serverSignature,
    })
    return { token: parsed.token, expiresAt: parsed.expiresAt }
  }

  private signedHeaders(
    method: string,
    path: string,
    body: Buffer | undefined,
    offset: number,
    token: string,
    extra: Record<string, string | number> = {},
  ): Record<string, string | number> {
    const nonce = randomToken(24)
    const timestamp = this.now()
    const signed: SignedRequest = {
      method,
      path,
      bodySha256: body === undefined ? null : sha256Hex(body),
      uploadOffset: offset,
      nonce,
      timestamp,
      token,
    }
    const signature = signRequest(this.signingKey, signed)
    return {
      ...extra,
      accept: 'application/json',
      'x-dsh-diag-token': token,
      'x-dsh-diag-nonce': nonce,
      'x-dsh-diag-timestamp': String(timestamp),
      'x-dsh-diag-signature': signature,
      'upload-offset': String(offset),
    }
  }

  private async headUpload(bundleId: string, token: string): Promise<{ offset: number; complete: boolean }> {
    const path = this.endpointPath(bundleId)
    const response = await this.rawRequest('HEAD', path, this.signedHeaders('HEAD', path, undefined, 0, token), undefined, MAX_JSON_BYTES)
    if (response.status === 404) return { offset: 0, complete: false }
    if (response.status < 200 || response.status >= 300) throw statusError(response.status)
    const complete = headerValue(response.headers, 'x-dsh-upload-complete') === '1'
    const offsetText = headerValue(response.headers, 'x-dsh-upload-offset') ?? '0'
    const offset = Number(offsetText)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new DiagnosticsError('SERVER_ERROR')
    return { offset, complete }
  }

  async upload(prepared: PreparedBundle): Promise<{ remote: RemoteLocator; downloadedManifest: DiagnosticsManifest; downloadedEnvelope: Buffer }> {
    const path = this.endpointPath(prepared.bundleId)
    const idempotencyKey = prepared.archiveSha256
    let lastError: DiagnosticsError | undefined
    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      try {
        const session = await this.openSession('upload', prepared.bundleId)
        let offset = 0
        const head = await this.headUpload(prepared.bundleId, session.token)
        if (!head.complete) {
          offset = head.offset
          while (offset < prepared.envelope.length) {
            const end = Math.min(prepared.envelope.length, offset + this.chunkBytes)
            const chunk = prepared.envelope.subarray(offset, end)
            const headers = this.signedHeaders('PUT', path, chunk, offset, session.token, {
              'content-type': 'application/octet-stream',
              'idempotency-key': idempotencyKey,
            })
            let response: HttpResponse
            try {
              response = await this.call('PUT', path, headers, chunk, MAX_JSON_BYTES)
            } catch (error) {
              if (error instanceof DiagnosticsError && error.retryable) {
                // Re-discover the durable offset before resuming.
                const resumed = await this.headUpload(prepared.bundleId, session.token)
                if (resumed.complete) break
                if (resumed.offset >= 0 && resumed.offset !== offset) {
                  offset = resumed.offset
                  continue
                }
              }
              throw error
            }
            if (response.status === 201) {
              offset = prepared.envelope.length
              break
            }
            const next = Number(headerValue(response.headers, 'x-dsh-upload-offset') ?? end)
            if (!Number.isSafeInteger(next) || next <= offset || next > prepared.envelope.length) {
              throw new DiagnosticsError('SERVER_ERROR')
            }
            offset = next
          }
        }
        const finalizeBody = Buffer.from(canonicalJson({ manifest: prepared.manifest, envelopeSha256: prepared.envelopeSha256 }), 'utf8')
        const finalize = await this.call('POST', `${path}/finalize`,
          this.signedHeaders('POST', `${path}/finalize`, finalizeBody, prepared.envelope.length, session.token, {
            'content-type': 'application/json',
            'idempotency-key': idempotencyKey,
          }), finalizeBody)
        const completed = parseJsonBody<{ manifest?: unknown; envelopeSha256?: unknown }>(finalize.body)
        if (typeof completed.envelopeSha256 !== 'string' || completed.envelopeSha256 !== prepared.envelopeSha256) {
          throw new DiagnosticsError('INTEGRITY_FAILED')
        }
        const manifest = validateManifest(completed.manifest)
        verifyManifestSignature(manifest, this.signingPublicKey)
        if (canonicalJson(manifest) !== canonicalJson(prepared.manifest)) {
          throw new DiagnosticsError('INTEGRITY_FAILED')
        }
        const downloadedManifest = await this.fetchManifest(prepared.bundleId)
        const downloadedEnvelope = await this.fetchEnvelope(prepared.bundleId)
        if (sha256Hex(downloadedEnvelope) !== prepared.envelopeSha256) throw new DiagnosticsError('INTEGRITY_FAILED')
        if (canonicalJson(downloadedManifest) !== canonicalJson(prepared.manifest)) {
          throw new DiagnosticsError('INTEGRITY_FAILED')
        }
        if (downloadedManifest.archive.sha256 !== prepared.archiveSha256 ||
          downloadedManifest.archive.bytes !== prepared.archive.length) {
          throw new DiagnosticsError('INTEGRITY_FAILED')
        }
        return {
          remote: {
            endpointId: this.config.endpointId,
            port: this.config.port,
            bundleId: prepared.bundleId,
            manifestSha256: prepared.manifestSha256,
            envelopeSha256: prepared.envelopeSha256,
            archiveSha256: prepared.archiveSha256,
            archiveBytes: prepared.archive.length,
          },
          downloadedManifest,
          downloadedEnvelope,
        }
      } catch (error) {
        const mapped = error instanceof DiagnosticsError ? error : new DiagnosticsError('NETWORK', { retryable: true, cause: error })
        lastError = mapped
        if (!mapped.retryable || attempt >= this.config.maxAttempts) throw mapped
        const delay = backoffMs(attempt, this.random)
        await this.sleep(delay)
      }
    }
    throw lastError ?? new DiagnosticsError('NETWORK', { retryable: true })
  }

  async fetchManifest(bundleId: string): Promise<DiagnosticsManifest> {
    const path = `${this.endpointPath(bundleId)}/manifest`
    const session = await this.openSession('download', bundleId)
    const response = await this.call('GET', path, this.signedHeaders('GET', path, undefined, 0, session.token, {
      accept: 'application/json',
    }), undefined)
    const manifest = validateManifest(parseJsonBody(response.body))
    verifyManifestSignature(manifest, this.signingPublicKey)
    if (manifest.bundleId !== bundleId) throw new DiagnosticsError('INTEGRITY_FAILED')
    return manifest
  }

  async fetchEnvelope(bundleId: string): Promise<Buffer> {
    const path = `${this.endpointPath(bundleId)}/bundle`
    const session = await this.openSession('download', bundleId)
    const response = await this.call('GET', path, this.signedHeaders('GET', path, undefined, 0, session.token, {
      accept: 'application/octet-stream',
    }), undefined, this.config.maxBundleBytes + MAX_RESPONSE_SLACK)
    const contentLength = headerValue(response.headers, 'content-length')
    if (contentLength !== undefined && Number(contentLength) !== response.body.length) {
      throw new DiagnosticsError('INTEGRITY_FAILED')
    }
    if (response.body.length === 0 || response.body.length > this.config.maxBundleBytes) {
      throw new DiagnosticsError('TOO_LARGE')
    }
    const advertised = headerValue(response.headers, 'x-dsh-envelope-sha256')
    if (advertised !== undefined && advertised !== sha256Hex(response.body)) {
      throw new DiagnosticsError('INTEGRITY_FAILED')
    }
    return response.body
  }

  /**
   * Extract the peer certificate SPKI for diagnostics/tests without exposing
   * certificate material. The receiver uses the same helper on its socket.
   */
  static peerSpki = peerSpki
}

export function clientSigningKeyId(config: DiagnosticsConfig): string {
  if (config.clientEd25519KeyPem === undefined) throw new DiagnosticsError('CONFIG_INVALID')
  return publicKeyId(createPublicKey(parsePrivateKey(config.clientEd25519KeyPem, 'ed25519')))
}
