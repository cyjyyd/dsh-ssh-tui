import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpsRequest } from 'node:https'
import { prepareBundle } from '../lib/diagnostics/bundle.js'
import { canonicalJson } from '../lib/diagnostics/crypto.js'
import { signRequest, signSessionRequest } from '../lib/diagnostics/protocol.js'
import { DiagnosticsTransport } from '../lib/diagnostics/transport.js'
import { configFor, createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'
import { DiagnosticsMockServer } from './helpers/diagnostics-server.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)
const RANDOM = Buffer.from('0011223344556677', 'hex')
const BUNDLE_ID = '20261128-120000-000-0011223344556677'

function context() {
  return {
    kind: 'turn-error',
    failureCode: 'TURN_ERROR',
    phase: 'turn',
    exitCode: 1,
    elapsedMs: 1,
    problemClasses: ['UNKNOWN'],
  }
}

function prepared(fixture) {
  return prepareBundle({
    context: context(),
    signingKey: fixture.ed.privateKey,
    recipientPublicKey: fixture.x.publicKey,
    maxBundleBytes: 32 * 1024 * 1024,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 1024 * 1024,
    toolVersion: '0.9.0',
    sourceSha: null,
    now: NOW,
    random: RANDOM,
  })
}

async function serverFor(fixture, overrides = {}) {
  const server = new DiagnosticsMockServer({
    caPem: fixture.caPem,
    serverCertPem: fixture.serverCertPem,
    serverKeyPem: fixture.serverKeyPem,
    clientSpki: fixture.clientSpki,
    clientEd25519PublicKey: fixture.ed.publicKey,
    serverEd25519PrivateKey: fixture.serverEd.privateKey,
    recipientPrivateKey: fixture.x.privateKey,
    ...overrides,
  })
  const { port } = await server.start()
  return { server, port }
}

function raw(fixture, port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest({
      host: '127.0.0.1',
      port,
      path,
      method,
      ca: fixture.caPem,
      cert: fixture.clientCertPem,
      key: fixture.clientKeyPem,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
      headers,
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function sessionBody(fixture, timestamp, nonce) {
  const request = {
    operation: 'upload',
    bundleId: BUNDLE_ID,
    clientNonce: nonce,
    timestamp,
    clientSpkiSha256: fixture.clientSpki,
  }
  return Buffer.from(canonicalJson({
    ...request,
    signature: signSessionRequest(fixture.ed.privateKey, request),
  }), 'utf8')
}

test('a stale session timestamp is a fixed receiver 4xx', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture)
  try {
    const body = sessionBody(fixture, Date.now() - 10 * 60 * 1000, 'stale-timestamp-nonce-0001')
    const response = await raw(fixture, port, 'POST', '/v1/session', {
      'content-type': 'application/json',
      'content-length': body.length,
    }, body)
    assert.equal(response.status, 401)
    assert.equal(response.headers['x-dsh-diag-error'], 'AUTH_REPLAY_REFUSED')
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a replayed session nonce is a fixed receiver 4xx', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture)
  try {
    const body = sessionBody(fixture, Date.now(), 'replayed-session-nonce-0001')
    const headers = { 'content-type': 'application/json', 'content-length': body.length }
    assert.equal((await raw(fixture, port, 'POST', '/v1/session', headers, body)).status, 200)
    const replay = await raw(fixture, port, 'POST', '/v1/session', headers, body)
    assert.equal(replay.status, 401)
    assert.equal(replay.headers['x-dsh-diag-error'], 'AUTH_REPLAY_REFUSED')
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('an expired session token is a fixed receiver 4xx', async () => {
  const fixture = await createDiagnosticsFixture()
  let clock = Date.now()
  const { server, port } = await serverFor(fixture, { now: () => clock })
  try {
    const body = sessionBody(fixture, clock, 'expired-token-nonce-00001')
    const session = await raw(fixture, port, 'POST', '/v1/session', {
      'content-type': 'application/json',
      'content-length': body.length,
    }, body)
    assert.equal(session.status, 200)
    const token = JSON.parse(session.body.toString('utf8')).token
    clock += 301_000
    const path = `/v1/diagnostics/${BUNDLE_ID}`
    const nonce = 'expired-token-request-0001'
    const signed = { method: 'HEAD', path, bodySha256: null, uploadOffset: 0, nonce, timestamp: clock, token }
    const response = await raw(fixture, port, 'HEAD', path, {
      accept: 'application/json',
      'x-dsh-diag-token': token,
      'x-dsh-diag-nonce': nonce,
      'x-dsh-diag-timestamp': String(clock),
      'x-dsh-diag-signature': signRequest(fixture.ed.privateKey, signed),
      'upload-offset': '0',
    })
    assert.equal(response.status, 401)
    assert.equal(response.headers['x-dsh-diag-error'], 'AUTH_REPLAY_REFUSED')
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a replay refusal is terminal and is not retried', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture)
  try {
    const config = await configFor(fixture, {
      DSH_DIAGNOSTICS_PORT: String(port),
      DSH_DIAGNOSTICS_MAX_ATTEMPTS: '5',
    })
    let sleeps = 0
    const transport = new DiagnosticsTransport(config, {
      now: () => Date.now() + 10 * 60 * 1000,
      sleep: async () => { sleeps += 1 },
    })
    await assert.rejects(
      transport.upload(prepared(fixture)),
      (error) => error.code === 'AUTH_REPLAY_REFUSED' && error.retryable === false,
    )
    assert.equal(server.requestCount, 1)
    assert.equal(sleeps, 0)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a remote body cannot mint the trusted replay code', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture, { fakeReplayBody: true })
  try {
    const config = await configFor(fixture, {
      DSH_DIAGNOSTICS_PORT: String(port),
      DSH_DIAGNOSTICS_MAX_ATTEMPTS: '5',
    })
    let sleeps = 0
    const transport = new DiagnosticsTransport(config, { sleep: async () => { sleeps += 1 } })
    await assert.rejects(
      transport.upload(prepared(fixture)),
      (error) => error.code === 'AUTH_FAILED',
    )
    assert.equal(server.requestCount, 1)
    assert.equal(sleeps, 0)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('an invalid signature fails closed as AUTH_FAILED without a 500', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture)
  try {
    const valid = JSON.parse(sessionBody(fixture, Date.now(), 'bad-signature-nonce-00001').toString('utf8'))
    valid.signature = Buffer.alloc(64).toString('base64')
    const body = Buffer.from(canonicalJson(valid), 'utf8')
    const response = await raw(fixture, port, 'POST', '/v1/session', {
      'content-type': 'application/json',
      'content-length': body.length,
    }, body)
    assert.equal(response.status, 401)
    assert.equal(response.headers['x-dsh-diag-error'], 'AUTH_FAILED')
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})
