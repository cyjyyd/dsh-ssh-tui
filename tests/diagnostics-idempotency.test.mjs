import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareBundle } from '../lib/diagnostics/bundle.js'
import { publishDiagnosticFailure } from '../lib/diagnostics/index.js'
import { DiagnosticsTransport } from '../lib/diagnostics/transport.js'
import { DiagnosticsError } from '../lib/diagnostics/types.js'
import { configFor, createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'
import { DiagnosticsMockServer } from './helpers/diagnostics-server.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)

function context(overrides = {}) {
  return {
    kind: 'turn-error',
    failureCode: 'TURN_ERROR',
    phase: 'turn',
    exitCode: 1,
    elapsedMs: 100,
    problemClasses: ['UNKNOWN'],
    observedAt: NOW,
    ...overrides,
  }
}

function prepared(fixture, random) {
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
    random,
  })
}

async function spoolIds(dir) {
  return (await readdir(dir).catch(() => [])).filter((name) => /^[0-9]{8}-[0-9]{6}-[0-9]{3}-[0-9a-f]{16}$/.test(name))
}

test('a repeated failure has a stable persisted identity across captures', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const config = await configFor(fixture)
    const failing = { async upload() { throw new DiagnosticsError('NETWORK', { retryable: true }) } }
    const first = await publishDiagnosticFailure(context(), {
      config, transport: failing, dedupe: false, skipRateLimit: true, now: NOW,
    })
    const second = await publishDiagnosticFailure(context(), {
      config, transport: failing, dedupe: false, skipRateLimit: true, now: NOW,
    })
    assert.equal(first.receipt?.bundleId, second.receipt?.bundleId)
    assert.equal((await spoolIds(config.spoolDir)).length, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('distinct failure signatures are not merged', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const config = await configFor(fixture)
    const failing = { async upload() { throw new DiagnosticsError('NETWORK', { retryable: true }) } }
    await publishDiagnosticFailure(context({ exitCode: 1 }), {
      config, transport: failing, dedupe: false, skipRateLimit: true, now: NOW,
    })
    await publishDiagnosticFailure(context({ exitCode: 2 }), {
      config, transport: failing, dedupe: false, skipRateLimit: true, now: NOW,
    })
    await publishDiagnosticFailure(context({ failureCode: 'BOOT_ERROR' }), {
      config, transport: failing, dedupe: false, skipRateLimit: true, now: NOW,
    })
    assert.equal((await spoolIds(config.spoolDir)).length, 3)
  } finally {
    await fixture.cleanup()
  }
})

test('the reference receiver binds an idempotency key to one bundle and rejects conflicts', async () => {
  const fixture = await createDiagnosticsFixture()
  const server = new DiagnosticsMockServer({
    caPem: fixture.caPem,
    serverCertPem: fixture.serverCertPem,
    serverKeyPem: fixture.serverKeyPem,
    clientSpki: fixture.clientSpki,
    clientEd25519PublicKey: fixture.ed.publicKey,
    serverEd25519PrivateKey: fixture.serverEd.privateKey,
    recipientPrivateKey: fixture.x.privateKey,
  })
  const { port } = await server.start()
  try {
    const config = await configFor(fixture, { DSH_DIAGNOSTICS_PORT: String(port) })
    const transport = new DiagnosticsTransport(config, { sleep: async () => {} })
    const a = prepared(fixture, Buffer.from('0011223344556677', 'hex'))
    const b = prepared(fixture, Buffer.from('8899aabbccddeeff', 'hex'))
    assert.equal(a.archive.equals(b.archive), true)
    assert.notEqual(a.bundleId, b.bundleId)
    await transport.upload(a)
    await transport.upload(a)
    assert.equal(server.bundles.size, 1)
    await assert.rejects(
      transport.upload(b),
      (error) => error.code === 'CLIENT_ERROR',
    )
    assert.equal(server.bundles.size, 1)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})
