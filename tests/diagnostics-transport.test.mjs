import test from 'node:test'
import assert from 'node:assert/strict'
import { request as httpsRequest } from 'node:https'
import { createPublicKey } from 'node:crypto'
import { prepareBundle, verifyEncryptedBundle } from '../lib/diagnostics/bundle.js'
import { DiagnosticsTransport } from '../lib/diagnostics/transport.js'
import { signSessionRequest } from '../lib/diagnostics/protocol.js'
import { canonicalJson } from '../lib/diagnostics/crypto.js'
import { configFor, createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'
import { DiagnosticsMockServer } from './helpers/diagnostics-server.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)
const RANDOM = Buffer.from('0011223344556677', 'hex')

function context(overrides = {}) {
  return {
    kind: 'turn-error',
    failureCode: 'TURN_ERROR',
    phase: 'turn',
    exitCode: 1,
    elapsedMs: 250,
    problemClasses: ['UNKNOWN'],
    ...overrides,
  }
}

function preparedFor(fixture, overrides = {}) {
  return prepareBundle({
    context: context(overrides.context),
    signingKey: fixture.ed.privateKey,
    recipientPublicKey: fixture.x.publicKey,
    maxBundleBytes: overrides.maxBundleBytes ?? 32 * 1024 * 1024,
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
  const config = await configFor(fixture, { DSH_DIAGNOSTICS_PORT: String(port) })
  return { server, config, port }
}

function transportFor(config, overrides = {}) {
  return new DiagnosticsTransport(config, { sleep: async () => {}, ...overrides })
}

test('mTLS upload round-trips the signed manifest and envelope', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture)
  try {
    const bundle = preparedFor(fixture)
    const result = await transportFor(config).upload(bundle)
    assert.equal(result.remote.bundleId, bundle.bundleId)
    assert.equal(result.remote.envelopeSha256, bundle.envelopeSha256)
    assert.equal(result.downloadedManifest.exitCode, 1)
    assert.deepEqual(result.downloadedEnvelope, bundle.envelope)
    const verified = verifyEncryptedBundle({
      manifest: result.downloadedManifest,
      envelope: result.downloadedEnvelope,
      signerPublicKey: createPublicKey(fixture.ed.privateKey),
      recipientPrivateKey: fixture.x.privateKey,
      maxFileBytes: 256 * 1024,
      maxTotalBytes: 1024 * 1024,
    })
    assert.equal(verified.metadata.length > 0, true)
    assert.equal(server.requestCount > 0, true)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a client certificate from the wrong CA is rejected before any upload', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server } = await serverFor(fixture)
  try {
    const config = await configFor(fixture, {
      DSH_DIAGNOSTICS_PORT: String(server.server.address().port),
      DSH_DIAGNOSTICS_CERT_FILE: fixture.paths['other-client.crt'],
      DSH_DIAGNOSTICS_KEY_FILE: fixture.paths['other-client.key'],
    })
    await assert.rejects(
      transportFor(config).upload(preparedFor(fixture)),
      (error) => ['TLS_FAILED', 'NETWORK', 'AUTH_FAILED'].includes(error.code),
    )
    assert.equal(server.bundles.size, 0)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a valid client certificate with the wrong SPKI pin is rejected by the receiver', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server } = await serverFor(fixture)
  try {
    const config = await configFor(fixture, {
      DSH_DIAGNOSTICS_PORT: String(server.server.address().port),
      DSH_DIAGNOSTICS_CERT_FILE: fixture.paths['second-client.crt'],
      DSH_DIAGNOSTICS_KEY_FILE: fixture.paths['second-client.key'],
    })
    await assert.rejects(
      transportFor(config).upload(preparedFor(fixture)),
      (error) => ['TLS_FAILED', 'NETWORK', 'AUTH_FAILED'].includes(error.code),
    )
    assert.equal(server.bundles.size, 0)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a server certificate from an untrusted CA is rejected', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture, {
    serverCertPem: fixture.otherServerCertPem,
    serverKeyPem: fixture.otherServerKeyPem,
  })
  try {
    await assert.rejects(
      transportFor(config).upload(preparedFor(fixture)),
      (error) => ['TLS_FAILED', 'NETWORK'].includes(error.code),
    )
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a server SPKI that does not match the pin is rejected', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server } = await serverFor(fixture)
  try {
    const config = await configFor(fixture, {
      DSH_DIAGNOSTICS_PORT: String(server.server.address().port),
      DSH_DIAGNOSTICS_SERVER_SPKI: '0'.repeat(64),
    })
    await assert.rejects(
      transportFor(config).upload(preparedFor(fixture)),
      (error) => error.code === 'PIN_MISMATCH',
    )
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('the receiver rejects a replayed session nonce', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture)
  try {
    const request = {
      operation: 'upload',
      bundleId: '20261128-120000-000-0011223344556677',
      clientNonce: 'nonce-for-replay-test-0001',
      timestamp: Date.now(),
      clientSpkiSha256: fixture.clientSpki,
    }
    const body = canonicalJson({ ...request, signature: signSessionRequest(fixture.ed.privateKey, request) })
    const send = () => new Promise((resolve, reject) => {
      const req = httpsRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/session',
        method: 'POST',
        ca: fixture.caPem,
        cert: fixture.clientCertPem,
        key: fixture.clientKeyPem,
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      req.on('error', reject)
      req.end(body)
    })
    assert.equal(await send(), 200)
    assert.equal(await send(), 401)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('a tampered manifest is rejected after upload', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture, { tamperManifest: true })
  try {
    await assert.rejects(
      transportFor(config).upload(preparedFor(fixture)),
      (error) => ['INTEGRITY_FAILED', 'PIN_MISMATCH'].includes(error.code),
    )
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('an interrupted chunk upload resumes from the durable offset', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture, { dropFirstChunk: true })
  try {
    const result = await transportFor(config).upload(preparedFor(fixture))
    assert.equal(result.downloadedManifest.exitCode, 1)
    assert.equal(server.connectionCount >= 2, true)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('an authentication failure is permanent and is not retried', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture, { rejectSession: true })
  try {
    await assert.rejects(
      transportFor(config).upload(preparedFor(fixture)),
      (error) => error.code === 'AUTH_FAILED',
    )
    assert.equal(server.requestCount, 1)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('redirects are refused rather than followed', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture, { redirectManifest: true })
  try {
    await assert.rejects(
      transportFor(config).fetchManifest('20261128-120000-000-0011223344556677'),
      (error) => error.code === 'REDIRECT_REFUSED',
    )
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('oversized bundles are rejected before any connection', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    assert.throws(
      () => preparedFor(fixture, { maxBundleBytes: 64 }),
      (error) => error.code === 'TOO_LARGE',
    )
  } finally {
    await fixture.cleanup()
  }
})
