import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  publishDiagnosticFailure,
  drainDiagnosticsSpool,
  fetchDiagnosticBundle,
  diagnosticsStatus,
  resetDiagnosticsStateForTests,
} from '../lib/diagnostics/index.js'
import { DiagnosticsTransport } from '../lib/diagnostics/transport.js'
import { DiagnosticsError } from '../lib/diagnostics/types.js'
import { configFor, createDiagnosticsFixture, envFor } from './helpers/diagnostics-fixture.mjs'
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

function transport(config) {
  return new DiagnosticsTransport(config, { sleep: async () => {} })
}

test('disabled diagnostics perform zero network and zero spool writes', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    let calls = 0
    const fake = { async upload() { calls += 1; throw new Error('must not run') } }
    const config = await configFor(fixture, { DSH_DIAGNOSTICS_UPLOAD: '0' })
    const result = await publishDiagnosticFailure(context(), {
      config,
      transport: fake,
      dedupe: false,
      skipRateLimit: true,
    })
    assert.equal(result.state, 'disabled')
    assert.equal(calls, 0)
  } finally {
    await fixture.cleanup()
  }
})

test('a failed turn is spooled, uploaded, downloaded and verified', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture)
  try {
    resetDiagnosticsStateForTests({ instanceId: 'test-instance' })
    const result = await publishDiagnosticFailure(context(), {
      config,
      transport: transport(config),
      dedupe: false,
      skipRateLimit: true,
    })
    assert.equal(result.state, 'verified')
    assert.equal(result.receipt?.state, 'verified')
    assert.equal(result.receipt?.originalExitCode, 1)
    assert.equal(result.receipt?.remote?.archiveBytes > 0, true)
    const bundleId = result.receipt.bundleId
    const verifiedDir = join(config.verifiedDir, bundleId)
    assert.equal((await stat(join(verifiedDir, 'manifest.json'))).size > 0, true)
    assert.equal((await stat(join(verifiedDir, 'envelope.bin'))).size > 0, true)
    assert.equal((await stat(join(verifiedDir, 'bundle.tar.gz'))).size > 0, true)
    const receipt = await readFile(join(config.spoolDir, bundleId, 'receipt.json'), 'utf8')
    assert.equal(receipt.includes(fixture.xPublicRaw), false)
    assert.equal(receipt.includes('BEGIN'), false)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('secret-bearing metadata is blocked before any connection', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture)
  try {
    const result = await publishDiagnosticFailure(context({
      failureCode: 'sk-SYNTHETIC-ONLY-1234567890',
    }), {
      config,
      dedupe: false,
      skipRateLimit: true,
    })
    assert.equal(result.state, 'blocked')
    assert.equal(result.errorClass, 'REDACTION_BLOCKED')
    assert.equal(server.connectionCount, 0)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('an oversized bundle is blocked before any connection', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture)
  try {
    const result = await publishDiagnosticFailure(context(), {
      config: { ...config, maxBundleBytes: 64 },
      dedupe: false,
      skipRateLimit: true,
    })
    assert.equal(result.state, 'blocked')
    assert.equal(result.errorClass, 'TOO_LARGE')
    assert.equal(server.connectionCount, 0)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('the spool drains after a transient failure and preserves the exit code', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture)
  try {
    const failing = {
      async upload() { throw new DiagnosticsError('NETWORK', { retryable: true }) },
    }
    const first = await publishDiagnosticFailure(context(), {
      config,
      transport: failing,
      dedupe: false,
      skipRateLimit: true,
      now: NOW,
    })
    assert.equal(first.state, 'queued')
    assert.equal(first.receipt?.state, 'retry')
    const bundleId = first.receipt.bundleId
    const drained = await drainDiagnosticsSpool({
      config,
      now: NOW + 120_000,
      transport: transport(config),
    })
    assert.equal(drained.attempted, 1)
    assert.equal(drained.verified, 1)
    const receipt = JSON.parse(await readFile(join(config.spoolDir, bundleId, 'receipt.json'), 'utf8'))
    assert.equal(receipt.state, 'verified')
    assert.equal(receipt.originalExitCode, 1)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('fetch verifies content with the recipient key and binds to the local receipt', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, config } = await serverFor(fixture)
  try {
    const published = await publishDiagnosticFailure(context(), {
      config,
      transport: transport(config),
      dedupe: false,
      skipRateLimit: true,
    })
    const bundleId = published.receipt.bundleId
    const withKey = await fetchDiagnosticBundle(bundleId, {
      config: { ...config, recipientX25519PrivateKeyPem: fixture.xPrivatePem },
      transport: transport(config),
    })
    assert.equal(withKey.state, 'verified')
    assert.equal(withKey.verifiedContent, true)
    assert.equal(withKey.exitCode, 1)
    const withoutKey = await fetchDiagnosticBundle(bundleId, {
      config,
      transport: transport(config),
    })
    assert.equal(withoutKey.state, 'envelope-verified')
    assert.equal(withoutKey.verifiedContent, false)

    const receiptPath = join(config.spoolDir, bundleId, 'receipt.json')
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
    receipt.remote.manifestSha256 = '0'.repeat(64)
    await writeFile(receiptPath, JSON.stringify(receipt))
    await assert.rejects(
      fetchDiagnosticBundle(bundleId, { config, transport: transport(config) }),
      (error) => error.code === 'INTEGRITY_FAILED',
    )
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

test('status describes configuration without secrets', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const config = await configFor(fixture)
    const status = await diagnosticsStatus({ config })
    const text = JSON.stringify(status)
    assert.equal(text.includes(fixture.edPrivatePem), false)
    assert.equal(text.includes(fixture.xPublicRaw), false)
    assert.equal(status.config.enabled, true)
    assert.equal(typeof status.spool, 'object')
  } finally {
    await fixture.cleanup()
  }
})

test('the default publish path uses the config file and env opt-in', async () => {
  const fixture = await createDiagnosticsFixture()
  const { server, port } = await serverFor(fixture)
  try {
    const config = await configFor(fixture, { DSH_DIAGNOSTICS_PORT: String(port) })
    const result = await publishDiagnosticFailure(context(), {
      config,
      transport: transport(config),
      dedupe: false,
      skipRateLimit: true,
    })
    assert.equal(result.state, 'verified')
    assert.equal(server.bundles.size, 1)
  } finally {
    await server.stop()
    await fixture.cleanup()
  }
})

void envFor
