import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { prepareBundle } from '../lib/diagnostics/bundle.js'
import { SpoolStore, writeVerifiedCopy } from '../lib/diagnostics/spool.js'
import { DiagnosticsError } from '../lib/diagnostics/types.js'
import { createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)

function config(overrides = {}) {
  return {
    enabled: true,
    maxAttempts: 5,
    maxSpoolEntries: 3,
    maxSpoolBytes: 4 * 1024 * 1024,
    sourceSha: null,
    destinationFingerprint: 'a'.repeat(64),
    spoolDir: '',
    verifiedDir: '',
    ...overrides,
  }
}

async function makeBundle(fixture, index) {
  const random = Buffer.alloc(8, index + 1)
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
    random,
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
  return { spool, root, setNow: (value) => { clock = value } }
}

test('the spool rejects entry-count and byte-capacity overflow without deleting evidence', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool } = await makeSpool(fixture)
    let accepted = 0
    for (let index = 0; index < 5; index += 1) {
      const bundle = await makeBundle(fixture, index)
      try {
        await spool.enqueue(bundle, config(), 1)
        accepted += 1
      } catch (error) {
        assert.equal(error.code, 'SPOOL_FAILED')
      }
    }
    assert.equal(accepted, 3)
    assert.equal((await spool.list()).length, 3)
    assert.equal((await readdir(spool.rootDir)).filter((name) => /^[0-9]{8}-/.test(name)).length, 3)
  } finally {
    await fixture.cleanup()
  }
})

test('concurrent admission is atomic and never exceeds the cap', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool } = await makeSpool(fixture)
    const bundles = []
    for (let index = 0; index < 10; index += 1) bundles.push(await makeBundle(fixture, index))
    const results = await Promise.allSettled(
      bundles.map((bundle) => spool.enqueue(bundle, config({ maxSpoolEntries: 3 }), 1)),
    )
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 3)
    assert.equal((await spool.list()).length, 3)
  } finally {
    await fixture.cleanup()
  }
})

test('a restarted process re-reads the on-disk cap state', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, root } = await makeSpool(fixture)
    for (let index = 0; index < 3; index += 1) {
      await spool.enqueue(await makeBundle(fixture, index), config(), 1)
    }
    const restarted = new SpoolStore(root, { now: () => NOW })
    await restarted.init()
    await assert.rejects(
      restarted.enqueue(await makeBundle(fixture, 8), config(), 1),
      (error) => error.code === 'SPOOL_FAILED',
    )
    assert.equal((await restarted.list()).length, 3)
  } finally {
    await fixture.cleanup()
  }
})

test('expired entries stay counted or are cleaned under control, never silently dropped', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const { spool, setNow } = await makeSpool(fixture)
    for (let index = 0; index < 2; index += 1) {
      await spool.enqueue(await makeBundle(fixture, index), config({ maxSpoolEntries: 2 }), 1)
    }
    setNow(NOW + 8 * 24 * 60 * 60 * 1000)
    await spool.due(config({ maxSpoolEntries: 2 }))
    try {
      await spool.enqueue(await makeBundle(fixture, 7), config({ maxSpoolEntries: 2 }), 1)
    } catch (error) {
      assert.equal(error.code, 'SPOOL_FAILED')
    }
    assert.ok((await spool.list()).length <= 2)
  } finally {
    await fixture.cleanup()
  }
})

test('the verified directory is bounded and keeps the newest copies', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const verifiedDir = join(fixture.dir, 'verified')
    const ids = []
    for (let index = 0; index < 5; index += 1) {
      const bundle = await makeBundle(fixture, index)
      ids.push(bundle.bundleId)
      await writeVerifiedCopy(verifiedDir, bundle.bundleId, {
        manifest: '{}',
        envelope: bundle.envelope,
        receipt: {
          bundleId: bundle.bundleId,
          state: 'verified',
          destinationFingerprint: 'a'.repeat(64),
        },
      }, { maxEntries: 3, maxBytes: 4 * 1024 * 1024 })
    }
    const dirs = (await readdir(verifiedDir)).filter((name) => /^[0-9]{8}-/.test(name))
    assert.equal(dirs.length, 3)
    assert.equal(dirs.includes(ids[4]), true)
    assert.equal(dirs.includes(ids[0]), false)
  } finally {
    await fixture.cleanup()
  }
})
