/**
 * Test/reference mTLS receiver for the diagnostics handoff.
 *
 * It is intentionally small and in-memory: it exercises the same wire
 * contract as a deployable receiver (mTLS + SPKI pins + Ed25519 request
 * signatures + replay cache + one-time session tokens + chunked resume +
 * envelope/manifest verification) without touching a real endpoint.
 */
import { createServer } from 'node:https'
import { randomBytes } from 'node:crypto'
import { canonicalJson, sha256Hex } from '../../lib/diagnostics/crypto.js'
import {
  validateManifest,
  verifyEncryptedBundle,
  verifyManifestSignature,
} from '../../lib/diagnostics/bundle.js'
import { DiagnosticsError } from '../../lib/diagnostics/types.js'
import {
  DIAG_ERROR_CODES,
  DIAG_ERROR_HEADER,
  ReplayCache,
  SessionStore,
  checkNonce,
  checkTimestamp,
  checkToken,
  peerSpki,
  signSessionResponse,
  verifyRequest,
  verifySessionRequest,
} from '../../lib/diagnostics/protocol.js'

const MAX_JSON = 64 * 1024
const MAX_CHUNK = 4 * 1024 * 1024

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function header(req, name) {
  const value = req.headers[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function send(res, status, body = '', headers = {}) {
  res.writeHead(status, {
    'content-length': Buffer.byteLength(body),
    ...headers,
  })
  res.end(body)
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  send(res, status, body, { 'content-type': 'application/json', ...headers })
}

function authFailure(error) {
  if (error instanceof DiagnosticsError) {
    return Object.assign(new Error(error.code), { status: 401, diagCode: error.code })
  }
  return error
}

function conflict(message) {
  return Object.assign(new Error(message), { status: 409 })
}

export class DiagnosticsMockServer {
  constructor(options) {
    this.options = options
    this.now = options.now ?? (() => Date.now())
    this.replay = new ReplayCache({ now: this.now })
    this.sessions = new SessionStore({ now: this.now })
    this.bundles = new Map()
    this.idempotency = new Map()
    this.connectionCount = 0
    this.requestCount = 0
    this.clientSpki = options.clientSpki ?? ''
    this.clientEd25519PublicKey = options.clientEd25519PublicKey
    this.manifestPublicKey = options.manifestPublicKey ?? options.clientEd25519PublicKey
    this.serverEd25519PrivateKey = options.serverEd25519PrivateKey
    this.recipientPrivateKey = options.recipientPrivateKey
    this.maxBundleBytes = options.maxBundleBytes ?? 32 * 1024 * 1024
    this.maxFileBytes = options.maxFileBytes ?? 1024 * 1024
    this.maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024
    this.tamperManifest = options.tamperManifest === true
    this.redirectManifest = options.redirectManifest === true
    this.rejectSession = options.rejectSession === true
    this.fakeReplayBody = options.fakeReplayBody === true
    this.dropFirstChunk = options.dropFirstChunk === true
    this.dropped = false
    this.server = createServer({
      key: options.serverKeyPem,
      cert: options.serverCertPem,
      ca: options.caPem,
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    }, (req, res) => {
      this.requestCount += 1
      void this.handle(req, res).catch((error) => {
        if (this.options.debug === true) console.error('mock-server', req.method, req.url, error)
        if (res.headersSent) {
          res.destroy()
          return
        }
        const status = Number.isInteger(error?.status) ? error.status : 500
        const diagCode = typeof error?.diagCode === 'string' && DIAG_ERROR_CODES.includes(error.diagCode)
          ? error.diagCode
          : undefined
        if (diagCode !== undefined) {
          sendJson(res, status, { error: diagCode.toLowerCase() }, { [DIAG_ERROR_HEADER]: diagCode })
          return
        }
        sendJson(res, status, { error: 'server-error' })
      })
    })
    this.server.on('secureConnection', (socket) => {
      this.connectionCount += 1
      try {
        const spki = peerSpki(socket)
        if (this.clientSpki !== '' && spki !== this.clientSpki) socket.destroy()
      } catch {
        socket.destroy()
      }
    })
  }

  async start(port = 0) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', resolve)
    })
    return { host: '127.0.0.1', port: this.server.address().port }
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve))
  }

  auth(req, body, operation, bundleId) {
    try {
      const token = header(req, 'x-dsh-diag-token') ?? ''
      const nonce = header(req, 'x-dsh-diag-nonce') ?? ''
      const timestamp = Number(header(req, 'x-dsh-diag-timestamp') ?? '0')
      const signature = header(req, 'x-dsh-diag-signature') ?? ''
      const offset = Number(header(req, 'upload-offset') ?? '0')
      checkToken(token)
      checkNonce(nonce)
      checkTimestamp(timestamp, this.now())
      if (!this.replay.remember(nonce)) throw new DiagnosticsError('AUTH_REPLAY_REFUSED')
      const grant = this.sessions.get(token, operation, bundleId, this.clientSpki)
      const bodySha256 = body === undefined ? null : sha256Hex(body)
      verifyRequest(this.clientEd25519PublicKey, {
        method: req.method,
        path: req.url,
        bodySha256,
        uploadOffset: Number.isSafeInteger(offset) ? offset : 0,
        nonce,
        timestamp,
        token,
      }, signature)
      return { grant, offset }
    } catch (error) {
      throw authFailure(error)
    }
  }

  bindIdempotency(key, input) {
    if (key === undefined) return undefined
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
      throw Object.assign(new Error('bad-idempotency-key'), { status: 400 })
    }
    const existing = this.idempotency.get(key)
    if (existing !== undefined) {
      if (existing.bundleId !== input.bundleId ||
        existing.operation !== input.operation ||
        existing.identity !== input.identity) {
        throw conflict('idempotency-conflict')
      }
      if (input.digest !== undefined && existing.digest !== undefined && existing.digest !== input.digest) {
        throw conflict('idempotency-digest-conflict')
      }
      if (input.manifestSha256 !== undefined && existing.manifestSha256 !== undefined &&
        existing.manifestSha256 !== input.manifestSha256) {
        throw conflict('idempotency-manifest-conflict')
      }
      if (input.digest !== undefined) existing.digest = input.digest
      if (input.manifestSha256 !== undefined) existing.manifestSha256 = input.manifestSha256
      return existing
    }
    const entry = { ...input }
    this.idempotency.set(key, entry)
    return entry
  }

  async handle(req, res) {
    const url = new URL(req.url, 'http://localhost')
    if (url.search !== '') return sendJson(res, 400, { error: 'query-not-allowed' })
    const path = url.pathname
    if (req.method === 'POST' && path === '/v1/session') return await this.handleSession(req, res)
    const match = /^\/v1\/diagnostics\/([0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16})(?:\/(manifest|bundle|finalize))?$/.exec(path)
    if (match === null) return sendJson(res, 404, { error: 'not-found' })
    const bundleId = match[1]
    const suffix = match[2]
    if (req.method === 'HEAD' && suffix === undefined) return await this.handleHead(req, res, bundleId)
    if (req.method === 'PUT' && suffix === undefined) return await this.handlePut(req, res, bundleId)
    if (req.method === 'POST' && suffix === 'finalize') return await this.handleFinalize(req, res, bundleId)
    if (req.method === 'GET' && suffix === 'manifest') return await this.handleManifest(req, res, bundleId)
    if (req.method === 'GET' && suffix === 'bundle') return await this.handleBundle(req, res, bundleId)
    return sendJson(res, 405, { error: 'method-not-allowed' })
  }

  async handleSession(req, res) {
    const body = await readBody(req, MAX_JSON)
    if (this.rejectSession) {
      return sendJson(res, 401, { error: 'auth-failed' }, { [DIAG_ERROR_HEADER]: 'AUTH_FAILED' })
    }
    if (this.fakeReplayBody) return sendJson(res, 401, { error: 'AUTH_REPLAY_REFUSED' })
    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'bad-json' })
    }
    if (parsed === null || typeof parsed !== 'object') return sendJson(res, 400, { error: 'bad-body' })
    if (parsed.operation !== 'upload' && parsed.operation !== 'download') return sendJson(res, 400, { error: 'bad-op' })
    if (typeof parsed.bundleId !== 'string' || !/^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(parsed.bundleId)) {
      return sendJson(res, 400, { error: 'bad-id' })
    }
    if (!Number.isSafeInteger(parsed.timestamp)) return sendJson(res, 400, { error: 'bad-time' })
    let socketSpki
    try {
      checkTimestamp(parsed.timestamp, this.now())
      checkNonce(parsed.clientNonce)
      if (!this.replay.remember(parsed.clientNonce)) throw new DiagnosticsError('AUTH_REPLAY_REFUSED')
      socketSpki = peerSpki(req.socket)
      if (socketSpki !== this.clientSpki) throw new DiagnosticsError('AUTH_FAILED')
      if (parsed.clientSpkiSha256 !== socketSpki) throw new DiagnosticsError('AUTH_FAILED')
      verifySessionRequest(this.clientEd25519PublicKey, {
        operation: parsed.operation,
        bundleId: parsed.bundleId,
        clientNonce: parsed.clientNonce,
        timestamp: parsed.timestamp,
        clientSpkiSha256: parsed.clientSpkiSha256,
      }, parsed.signature)
    } catch (error) {
      throw authFailure(error)
    }
    const token = randomBytes(32).toString('base64url')
    const expiresAt = this.now() + 5 * 60 * 1000
    const serverNonce = randomBytes(18).toString('base64url')
    this.sessions.issue({
      token,
      operation: parsed.operation,
      bundleId: parsed.bundleId,
      clientSpkiSha256: socketSpki,
      expiresAt,
      usedNonces: new Set(),
      consumed: false,
    })
    const serverSignature = signSessionResponse(this.serverEd25519PrivateKey, {
      token,
      expiresAt,
      serverNonce,
      clientNonce: parsed.clientNonce,
    })
    return sendJson(res, 200, { token, expiresAt, serverNonce, serverSignature })
  }

  async handleHead(req, res, bundleId) {
    const body = undefined
    this.auth(req, body, 'upload', bundleId)
    const state = this.bundles.get(bundleId)
    const headers = {
      'x-dsh-upload-offset': String(state?.chunks.length ?? 0),
      'x-dsh-upload-complete': state?.complete === true ? '1' : '0',
    }
    send(res, 200, '', headers)
  }

  async handlePut(req, res, bundleId) {
    const body = await readBody(req, MAX_CHUNK)
    const { offset } = this.auth(req, body, 'upload', bundleId)
    const idempotencyKey = header(req, 'idempotency-key')
    if (idempotencyKey !== undefined) {
      this.bindIdempotency(idempotencyKey, {
        bundleId,
        operation: 'upload',
        identity: peerSpki(req.socket),
      })
    }
    if (body.length > MAX_CHUNK) return sendJson(res, 413, { error: 'chunk-too-large' })
    let state = this.bundles.get(bundleId)
    if (state === undefined) {
      state = { chunks: Buffer.alloc(0), complete: false, manifest: null, envelope: null, envelopeSha256: null }
      this.bundles.set(bundleId, state)
    }
    if (offset !== state.chunks.length) {
      return sendJson(res, 409, { error: 'offset-mismatch', offset: state.chunks.length })
    }
    if (state.complete) {
      return sendJson(res, 200, { complete: true, envelopeSha256: state.envelopeSha256 })
    }
    if (state.chunks.length + body.length > this.maxBundleBytes) return sendJson(res, 413, { error: 'too-large' })
    state.chunks = Buffer.concat([state.chunks, body])
    if (this.dropFirstChunk && !this.dropped) {
      this.dropped = true
      res.destroy()
      return
    }
    return send(res, 200, '', { 'x-dsh-upload-offset': String(state.chunks.length) })
  }

  async handleFinalize(req, res, bundleId) {
    const body = await readBody(req, MAX_JSON * 4)
    const { grant } = this.auth(req, body, 'upload', bundleId)
    let parsed
    try {
      parsed = JSON.parse(body.toString('utf8'))
    } catch {
      return sendJson(res, 400, { error: 'bad-json' })
    }
    let state = this.bundles.get(bundleId)
    if (state === undefined) return sendJson(res, 404, { error: 'no-upload' })
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.envelopeSha256 !== 'string') {
      return sendJson(res, 400, { error: 'bad-finalize' })
    }
    const idempotencyKey = header(req, 'idempotency-key')
    const identity = peerSpki(req.socket)
    if (idempotencyKey !== undefined) {
      this.bindIdempotency(idempotencyKey, {
        bundleId,
        operation: 'upload',
        identity,
        digest: parsed.envelopeSha256,
      })
    }
    if (state.complete) {
      if (idempotencyKey !== undefined) {
        this.bindIdempotency(idempotencyKey, {
          bundleId,
          operation: 'upload',
          identity,
          digest: state.envelopeSha256,
          manifestSha256: sha256Hex(canonicalJson(state.manifest)),
        })
      }
      return sendJson(res, 200, { manifest: state.manifest, envelopeSha256: state.envelopeSha256, envelopeBytes: state.envelope.length })
    }
    if (sha256Hex(state.chunks) !== parsed.envelopeSha256) return sendJson(res, 422, { error: 'envelope-sha' })
    let manifest
    try {
      manifest = validateManifest(parsed.manifest)
      verifyManifestSignature(manifest, this.manifestPublicKey)
    } catch {
      return sendJson(res, 422, { error: 'manifest-signature' })
    }
    if (manifest.bundleId !== bundleId) return sendJson(res, 422, { error: 'bundle-id' })
    try {
      verifyEncryptedBundle({
        manifest,
        envelope: state.chunks,
        signerPublicKey: this.manifestPublicKey,
        recipientPrivateKey: this.recipientPrivateKey,
        maxFileBytes: this.maxFileBytes,
        maxTotalBytes: this.maxTotalBytes,
        expectedEnvelopeSha256: parsed.envelopeSha256,
      })
    } catch {
      return sendJson(res, 422, { error: 'envelope-integrity' })
    }
    if (idempotencyKey !== undefined) {
      this.bindIdempotency(idempotencyKey, {
        bundleId,
        operation: 'upload',
        identity,
        digest: parsed.envelopeSha256,
        manifestSha256: sha256Hex(canonicalJson(manifest)),
      })
    }
    state.manifest = manifest
    state.envelope = state.chunks
    state.envelopeSha256 = parsed.envelopeSha256
    state.complete = true
    this.sessions.consume(grant)
    return sendJson(res, 201, {
      manifest,
      envelopeSha256: state.envelopeSha256,
      envelopeBytes: state.envelope.length,
    })
  }

  async handleManifest(req, res, bundleId) {
    const { grant } = this.auth(req, undefined, 'download', bundleId)
    if (this.redirectManifest) {
      this.sessions.consume(grant)
      res.writeHead(302, { location: 'https://example.invalid/manifest' })
      return res.end()
    }
    const state = this.bundles.get(bundleId)
    if (state?.complete !== true) return sendJson(res, 404, { error: 'not-found' })
    let manifest = state.manifest
    if (this.tamperManifest) manifest = { ...manifest, exitCode: manifest.exitCode === null ? 42 : (manifest.exitCode + 1) % 256 }
    this.sessions.consume(grant)
    return sendJson(res, 200, manifest)
  }

  async handleBundle(req, res, bundleId) {
    const { grant } = this.auth(req, undefined, 'download', bundleId)
    const state = this.bundles.get(bundleId)
    if (state?.complete !== true) return sendJson(res, 404, { error: 'not-found' })
    this.sessions.consume(grant)
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': state.envelope.length,
      'x-dsh-envelope-sha256': state.envelopeSha256,
    })
    res.end(state.envelope)
  }
}
