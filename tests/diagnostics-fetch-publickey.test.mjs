import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { prepareBundle } from '../lib/diagnostics/bundle.js'
import { fetchDiagnosticBundle } from '../lib/diagnostics/index.js'
import { configFor, createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)
const RANDOM = Buffer.from('0011223344556677', 'hex')

function prepared(fixture) {
  return prepareBundle({
    context: {
      kind: 'turn-error', failureCode: 'TURN_ERROR', phase: 'turn', exitCode: 1,
      elapsedMs: 1, problemClasses: ['UNKNOWN'],
    },
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

test('fetch verifies the sender manifest with a public key, not the sender private key', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = prepared(fixture)
    const requester = generateKeyPairSync('ed25519')
    const requesterPem = requester.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const config = await configFor(fixture, {
      DSH_DIAGNOSTICS_CLIENT_ED25519_KEY_PEM: requesterPem,
    })
    const withPublic = {
      ...config,
      clientEd25519PublicKey: fixture.edPublicRaw,
      recipientX25519PrivateKeyPem: fixture.xPrivatePem,
    }
    const fake = {
      async fetchManifest() { return bundle.manifest },
      async fetchEnvelope() { return bundle.envelope },
    }
    const result = await fetchDiagnosticBundle(bundle.bundleId, {
      config: withPublic,
      transport: fake,
      expectedManifestSha256: bundle.manifestSha256,
      expectedEnvelopeSha256: bundle.envelopeSha256,
    })
    assert.equal(result.state, 'verified')
    assert.equal(result.verifiedContent, true)
    assert.equal(result.manifest.exitCode, 1)
  } finally {
    await fixture.cleanup()
  }
})

test('a public-key-only verifier does not need the sender signing key', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = prepared(fixture)
    const config = await configFor(fixture)
    const publicOnly = {
      ...config,
      clientEd25519KeyPem: undefined,
      clientEd25519PublicKey: fixture.edPublicRaw,
    }
    const fake = {
      async fetchManifest() { return bundle.manifest },
      async fetchEnvelope() { return bundle.envelope },
    }
    const result = await fetchDiagnosticBundle(bundle.bundleId, { config: publicOnly, transport: fake })
    assert.equal(result.state, 'envelope-verified')
    assert.equal(result.verifiedContent, false)
  } finally {
    await fixture.cleanup()
  }
})

test('a forged manifest is rejected even when only the public key is present', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = prepared(fixture)
    const config = await configFor(fixture)
    const publicOnly = {
      ...config,
      clientEd25519KeyPem: undefined,
      clientEd25519PublicKey: fixture.edPublicRaw,
    }
    const forged = structuredClone(bundle.manifest)
    forged.exitCode = 42
    const fake = {
      async fetchManifest() { return forged },
      async fetchEnvelope() { return bundle.envelope },
    }
    await assert.rejects(
      fetchDiagnosticBundle(bundle.bundleId, { config: publicOnly, transport: fake }),
      (error) => error.code === 'INTEGRITY_FAILED',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('a missing independent receipt cannot claim verified content', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const bundle = prepared(fixture)
    const config = await configFor(fixture)
    const withPrivate = {
      ...config,
      clientEd25519PublicKey: fixture.edPublicRaw,
      recipientX25519PrivateKeyPem: fixture.xPrivatePem,
    }
    const fake = {
      async fetchManifest() { return bundle.manifest },
      async fetchEnvelope() { return bundle.envelope },
    }
    const result = await fetchDiagnosticBundle(bundle.bundleId, { config: withPrivate, transport: fake })
    assert.equal(result.state, 'envelope-verified')
    assert.equal(result.verifiedContent, false)
  } finally {
    await fixture.cleanup()
  }
})
