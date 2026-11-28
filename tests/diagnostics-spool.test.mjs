import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, stat, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareBundle } from '../lib/diagnostics/bundle.js'
import { SpoolStore, backoffMs } from '../lib/diagnostics/spool.js'
import { DiagnosticsError } from '../lib/diagnostics/types.js'
import { createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)

function config(overrides = {}) {
  return {
    enabled: true,
    maxAttempts: 5,
    sourceSha: null,
    destinationFingerprint: 'a'.repeat(64),
    spoolDir: '',
    verifiedDir: '',
    ...overrides,
  }
}

async function makeBundle(fixture) {
  return prepareBundle({
    context: { kind: 'turn-error', failureCode: 'TURN_ERROR', phase: 'turn', exitCode: 1, elapsedMs: 5 },
    signingKey: fixture.ed.privateKey,
    recipientPublicKey: fixture.x.publicKey,
    maxBundleBytes: 1024 * 1024,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 1024 * 1024,
    toolVersion: '0.9.0',
    sourceSha: null,
    now: NOW,
    random: Buffer.from('0011223344556677', 'hex'),
  })
}

async function makeSpool(fixture, options = {}) {
  const root = join(fixture.dir, 'spool')
  let clock = options.now ?? NOW
  const spool = new SpoolStore(root, {
    now: () => clock,
    random: options.random ?? (() => 0.5),
    leaseTtlMs: options.leaseTtlMs ?? 60_000,
  })
  await spool.init()
  return { spool, root, setNow: (value) => { clock = value }, getNow: () => clock }
}

test('enqueue writes 0600 artifacts and a pending receipt', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, root } = await makeSpool(fixture)
    const bundle = await makeBundle(fixture)
    const receipt = await spool.enqueue(bundle, config(), 1)
    assert.equal(receipt.state, 'pending')
    assert.equal(receipt.originalExitCode, 1)
    const dir = join(root, bundle.bundleId)
    if (process.platform !== 'win32') {
      assert.equal((await stat(dir)).mode & 0o777, 0o700)
      for (const name of ['bundle.tar.gz', 'manifest.json', 'envelope.bin', 'receipt.json']) {
        assert.equal((await stat(join(dir, name))).mode & 0o777, 0o600, name)
      }
    }
    const raw = await readFile(join(dir, 'receipt.json'), 'utf8')
    assert.equal(raw.includes('BEGIN'), false)
    assert.equal(raw.includes(fixture.xPublicRaw), false)
  } finally {
    await fixture.cleanup()
  }
})

test('due honors the backoff clock and marks destination changes', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, setNow } = await makeSpool(fixture)
    const bundle = await makeBundle(fixture)
    const receipt = await spool.enqueue(bundle, config(), 1)
    assert.equal((await spool.due(config())).length, 1)
    receipt.state = 'retry'
    receipt.nextRetryAt = NOW + 60_000
    receipt.updatedAt = new Date(NOW).toISOString()
    await spool.update(receipt)
    assert.equal((await spool.due(config())).length, 0)
    setNow(NOW + 120_000)
    assert.equal((await spool.due(config())).length, 1)
    assert.equal((await spool.due(config({ destinationFingerprint: 'b'.repeat(64) }))).length, 0)
    const changed = await spool.read(bundle.bundleId)
    assert.equal(changed.receipt.state, 'destination-changed')
  } finally {
    await fixture.cleanup()
  }
})

test('retryable failures back off and then abandon; permanent failures block', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool } = await makeSpool(fixture)
    const bundle = await makeBundle(fixture)
    const receipt = await spool.enqueue(bundle, config(), 1)
    const network = new DiagnosticsError('NETWORK', { retryable: true })
    for (let attempt = 1; attempt <= 4; attempt++) {
      const updated = await spool.markAttempt(receipt, config(), network)
      assert.equal(updated.state, 'retry')
      assert.equal(updated.attempts, attempt)
      assert.equal(updated.nextRetryAt > NOW, true)
    }
    const abandoned = await spool.markAttempt(receipt, config(), network)
    assert.equal(abandoned.state, 'abandoned')
    const permanent = await spool.markAttempt(receipt, config(), new DiagnosticsError('AUTH_FAILED'))
    assert.equal(permanent.state, 'blocked')
    assert.equal(backoffMs(1, () => 0), 1_000)
    assert.equal(backoffMs(4, () => 0), 8_000)
    assert.equal(backoffMs(9, () => 0), 16_000)
  } finally {
    await fixture.cleanup()
  }
})

test('the lease is exclusive and stale leases are reclaimed', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, root } = await makeSpool(fixture)
    const first = await spool.acquireLease('owner-a')
    assert.notEqual(first, undefined)
    assert.equal(await spool.acquireLease('owner-b'), undefined)
    await spool.releaseLease(first)
    const second = await spool.acquireLease('owner-b')
    assert.equal(second?.owner, 'owner-b')
    await spool.releaseLease(second)
    await writeFile(join(root, '.lease.json'), JSON.stringify({ owner: 'stale', expiresAt: NOW - 1 }))
    const third = await spool.acquireLease('owner-c')
    assert.equal(third?.owner, 'owner-c')
  } finally {
    await fixture.cleanup()
  }
})

test('rate limiting is one per instance per five minutes and three per hour globally', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, setNow } = await makeSpool(fixture)
    assert.equal(await spool.rateLimitAllowed('one'), true)
    assert.equal(await spool.rateLimitAllowed('one'), false)
    setNow(NOW + 301_000)
    assert.equal(await spool.rateLimitAllowed('one'), true)
    assert.equal(await spool.rateLimitAllowed('two'), true)
    assert.equal(await spool.rateLimitAllowed('three'), false)
    setNow(NOW + 3_601_000)
    assert.equal(await spool.rateLimitAllowed('four'), true)
  } finally {
    await fixture.cleanup()
  }
})

test('purge refuses dangerous roots and removes a normal spool', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, root } = await makeSpool(fixture)
    await spool.purge()
    await assert.rejects(stat(root))
    const dangerous = new SpoolStore('/')
    await assert.rejects(dangerous.purge(), (error) => error.code === 'SPOOL_FAILED')
  } finally {
    await fixture.cleanup()
  }
})
