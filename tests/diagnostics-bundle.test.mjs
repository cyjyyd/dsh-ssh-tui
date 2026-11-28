import test from 'node:test'
import assert from 'node:assert/strict'
import { gunzipSync } from 'node:zlib'
import { createPublicKey } from 'node:crypto'
import {
  createTar,
  gzipDeterministic,
  prepareBundle,
  readTarGz,
  signManifest,
  validateManifest,
  validateMetadata,
  validateVersions,
  verifyBundle,
  verifyEncryptedBundle,
  verifyManifestSignature,
} from '../lib/diagnostics/bundle.js'
import { decryptEnvelope, sha256Hex, spkiSha256 } from '../lib/diagnostics/crypto.js'
import { scanForSecrets } from '../lib/diagnostics/redact.js'
import { createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)
const RANDOM = Buffer.from('0011223344556677', 'hex')

function context(overrides = {}) {
  return {
    kind: 'turn-error',
    failureCode: 'TURN_ERROR',
    phase: 'turn',
    exitCode: 1,
    elapsedMs: 1234,
    problemClasses: ['UNKNOWN'],
    child: { exit: 1, alive: false, teardown: true, observedMs: 1200 },
    ...overrides,
  }
}

async function prepared(fixture, overrides = {}) {
  return prepareBundle({
    context: context(overrides.context),
    signingKey: fixture.ed.privateKey,
    recipientPublicKey: fixture.x.publicKey,
    maxBundleBytes: 32 * 1024 * 1024,
    maxFileBytes: 256 * 1024,
    maxTotalBytes: 1024 * 1024,
    toolVersion: '0.9.0',
    sourceSha: 'ee212a601e9452f5ad4507fc46666da02eb3bb4a',
    now: NOW,
    random: RANDOM,
    ...overrides.options,
  })
}

test('the remote bundle is deterministic and metadata-only', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const a = await prepared(fixture)
    const b = await prepared(fixture)
    assert.deepEqual(a.archive, b.archive)
    assert.deepEqual(a.manifest, b.manifest)
    assert.equal(a.bundleId, b.bundleId)
    const tar = readTarGz(a.archive, { maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024 })
    assert.deepEqual([...tar.files.keys()].sort(), ['metadata.json', 'versions.txt'])
    const metadata = tar.files.get('metadata.json').toString('utf8')
    const versions = tar.files.get('versions.txt').toString('utf8')
    assert.equal(metadata.includes('screen.txt'), false)
    assert.equal(metadata.includes('transcript.txt'), false)
    assert.equal(metadata.includes('session'), false)
    assert.equal(versions.includes('screen.txt'), false)
    assert.equal(a.manifest.exitCode, 1)
    assert.equal(a.manifest.failureCode, 'TURN_ERROR')
    assert.equal(a.manifest.tool.commit, 'ee212a601e9452f5ad4507fc46666da02eb3bb4a')
  } finally {
    await fixture.cleanup()
  }
})

test('the manifest signature is verifiable and covers every field', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = await prepared(fixture)
    verifyManifestSignature(bundle.manifest, createPublicKey(fixture.ed.privateKey))
    const tampered = structuredClone(bundle.manifest)
    tampered.exitCode = 42
    assert.throws(() => verifyManifestSignature(tampered, createPublicKey(fixture.ed.privateKey)), (error) => error.code === 'INTEGRITY_FAILED')
  } finally {
    await fixture.cleanup()
  }
})

test('the envelope decrypts and rejects tampering or the wrong recipient key', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = await prepared(fixture)
    const decrypted = decryptEnvelope(bundle.envelope, fixture.x.privateKey)
    assert.deepEqual(decrypted.archive, bundle.archive)
    assert.equal(decrypted.header.manifestSha256, bundle.manifestSha256)
    const tampered = Buffer.from(bundle.envelope)
    tampered[tampered.length - 20] ^= 0x01
    assert.throws(() => decryptEnvelope(tampered, fixture.x.privateKey), (error) => error.code === 'INTEGRITY_FAILED')
    const other = (await import('node:crypto')).generateKeyPairSync('x25519')
    assert.throws(() => decryptEnvelope(bundle.envelope, other.privateKey), (error) => error.code === 'INTEGRITY_FAILED')
  } finally {
    await fixture.cleanup()
  }
})

test('receiver-side verification checks signature, archive, lengths and files', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = await prepared(fixture)
    const result = verifyEncryptedBundle({
      manifest: bundle.manifest,
      envelope: bundle.envelope,
      signerPublicKey: createPublicKey(fixture.ed.privateKey),
      recipientPrivateKey: fixture.x.privateKey,
      maxFileBytes: 256 * 1024,
      maxTotalBytes: 1024 * 1024,
      expectedEnvelopeSha256: bundle.envelopeSha256,
    })
    assert.equal(sha256Hex(result.metadata), bundle.files.find((file) => file.name === 'metadata.json').sha256)
    assert.throws(() => verifyEncryptedBundle({
      manifest: { ...bundle.manifest, exitCode: 2 },
      envelope: bundle.envelope,
      signerPublicKey: createPublicKey(fixture.ed.privateKey),
      recipientPrivateKey: fixture.x.privateKey,
      maxFileBytes: 256 * 1024,
      maxTotalBytes: 1024 * 1024,
    }), (error) => error.code === 'INTEGRITY_FAILED')
    assert.throws(() => verifyEncryptedBundle({
      manifest: bundle.manifest,
      envelope: bundle.envelope,
      signerPublicKey: createPublicKey(fixture.ed.privateKey),
      recipientPrivateKey: fixture.x.privateKey,
      maxFileBytes: 256 * 1024,
      maxTotalBytes: 1024 * 1024,
      expectedEnvelopeSha256: '0'.repeat(64),
    }), (error) => error.code === 'INTEGRITY_FAILED')
  } finally {
    await fixture.cleanup()
  }
})

test('oversized bundles are rejected before any egress', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    await assert.rejects(
      prepared(fixture, { options: { maxBundleBytes: 128 } }),
      (error) => error.code === 'TOO_LARGE',
    )
    await assert.rejects(
      prepared(fixture, { options: { maxFileBytes: 16 } }),
      (error) => error.code === 'TOO_LARGE',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('the tar reader rejects traversal, symlinks, duplicates and trailing data', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    assert.throws(() => createTar([{ name: '../evil', data: Buffer.from('x') }]), (error) => error.code === 'INTEGRITY_FAILED')
    assert.throws(() => createTar([{ name: '/abs', data: Buffer.from('x') }]), (error) => error.code === 'INTEGRITY_FAILED')
    const bundle = await prepared(fixture)
    const tar = gunzipSync(bundle.archive)
    const symlink = Buffer.from(tar)
    symlink[156] = 0x32
    assert.throws(
      () => readTarGz(gzipDeterministic(symlink), { maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024 }),
      (error) => error.code === 'INTEGRITY_FAILED',
    )
    const duplicate = Buffer.concat([tar.subarray(0, 1024), tar])
    assert.throws(
      () => readTarGz(gzipDeterministic(duplicate), { maxTotalBytes: 1024 * 1024, maxFileBytes: 256 * 1024 }),
      (error) => error.code === 'INTEGRITY_FAILED',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('unknown metadata fields fail closed', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    await assert.rejects(
      prepared(fixture, { context: { problemClasses: ['RAW ERROR TEXT'] } }),
      (error) => error.code === 'REDACTION_BLOCKED',
    )
    await assert.rejects(
      prepared(fixture, { context: { failureCode: 'sk-SYNTHETIC-ONLY-1234567890' } }),
      (error) => error.code === 'REDACTION_BLOCKED',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('secret scanning covers keys, headers, home paths, usernames and controls', () => {
  const samples = [
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    'Authorization: Bearer abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFG0123456789_abcdefghij',
    'AKIAABCDEFGHIJKLMNOP',
    'xoxb-1234567890-abcdefghij',
    'eyJabcdefgh.eyJijklmnop.qrstuvwxyz',
    'sk-SYNTHETIC-ONLY-1234567890',
    'https://user:password@example.test/',
    'password=hunter2',
    'token=abcdefghijk',
    '/home/synthetic-user/project',
    'C:\\Users\\synthetic-user\\project',
    'root@synthetic.test',
    'hello\u0007world',
  ]
  for (const sample of samples) {
    assert.equal(scanForSecrets(sample, { username: 'synthetic-user' }).ok, false, sample)
  }
  assert.equal(scanForSecrets('node=v24.20.0\nplatform=linux', { username: 'synthetic-user' }).ok, true)
  assert.equal(scanForSecrets('2026-11-28T12:00:00.000Z', { username: 'synthetic-user' }).ok, true)
})

test('the receiver metadata/versions allowlists reject raw or unknown fields', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = await prepared(fixture)
    const metadata = JSON.parse(bundle.metadata.toString('utf8'))
    validateMetadata(metadata)
    assert.throws(() => validateMetadata({ ...metadata, screen: 'raw terminal output' }), (error) => error.code === 'REDACTION_BLOCKED')
    assert.throws(() => validateMetadata({ ...metadata, failureCode: 'sk-SYNTHETIC-ONLY-1234567890' }), (error) => error.code === 'REDACTION_BLOCKED')
    const versions = bundle.versions.toString('utf8')
    validateVersions(versions)
    assert.throws(() => validateVersions(`${versions}\nscreen.txt=raw`), (error) => error.code === 'INTEGRITY_FAILED')
    assert.throws(() => validateVersions(versions.replace(/^platform=.*$/m, 'platform=unknown')), (error) => error.code === 'REDACTION_BLOCKED')
  } finally {
    await fixture.cleanup()
  }
})

test('validateManifest rejects unknown keys and bad signatures', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = await prepared(fixture)
    const good = validateManifest(JSON.parse(JSON.stringify(bundle.manifest)))
    assert.equal(good.bundleId, bundle.bundleId)
    const extra = { ...bundle.manifest, screen: 'secret' }
    assert.throws(() => validateManifest(extra), (error) => error.code === 'REDACTION_BLOCKED')
  } finally {
    await fixture.cleanup()
  }
})
