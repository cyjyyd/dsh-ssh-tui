/**
 * Test fixtures for the diagnostics handoff.
 *
 * The PKI is generated fresh in memory for every run, so the repository never
 * carries a private key. Files written to the temp dir are 0600 to exercise the
 * production config loader's permission checks.
 */
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, X509Certificate } from 'node:crypto'
import { spkiFromCertificate } from '../../lib/diagnostics/protocol.js'
import { createTestPki } from './diagnostics-certgen.mjs'

function rawPublicBase64(keyObject) {
  return keyObject.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64')
}

export async function createDiagnosticsFixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-diag-'))
  const pki = createTestPki()
  const material = {
    'ca.crt': pki.caCertPem,
    'ca.key': pki.caKeyPem,
    'server.crt': pki.serverCertPem,
    'server.key': pki.serverKeyPem,
    'client.crt': pki.clientCertPem,
    'client.key': pki.clientKeyPem,
    'second-client.crt': pki.secondClientCertPem,
    'second-client.key': pki.secondClientKeyPem,
    'other-ca.crt': pki.otherCaCertPem,
    'other-server.crt': pki.otherServerCertPem,
    'other-server.key': pki.otherServerKeyPem,
    'other-client.crt': pki.otherClientCertPem,
    'other-client.key': pki.otherClientKeyPem,
  }
  const paths = {}
  for (const [name, data] of Object.entries(material)) {
    const target = join(dir, name)
    await writeFile(target, data, { mode: 0o600 })
    await chmod(target, 0o600).catch(() => {})
    paths[name] = target
  }
  const caPem = pki.caCertPem
  const serverCertPem = pki.serverCertPem
  const serverKeyPem = pki.serverKeyPem
  const clientCertPem = pki.clientCertPem
  const clientKeyPem = pki.clientKeyPem
  const otherCaPem = pki.otherCaCertPem
  const otherServerCertPem = pki.otherServerCertPem
  const otherServerKeyPem = pki.otherServerKeyPem
  const otherClientCertPem = pki.otherClientCertPem
  const otherClientKeyPem = pki.otherClientKeyPem
  const clientSpki = spkiFromCertificate(new X509Certificate(clientCertPem))
  const serverSpki = spkiFromCertificate(new X509Certificate(serverCertPem))
  const otherClientSpki = spkiFromCertificate(new X509Certificate(otherClientCertPem))

  const ed = generateKeyPairSync('ed25519')
  const serverEd = generateKeyPairSync('ed25519')
  const x = generateKeyPairSync('x25519')
  const edPrivatePem = ed.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const serverEdPrivatePem = serverEd.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const xPrivatePem = x.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const edPath = join(dir, 'client-ed25519.key')
  const xPath = join(dir, 'recipient-x25519.key')
  await writeFile(edPath, edPrivatePem, { mode: 0o600 })
  await writeFile(xPath, xPrivatePem, { mode: 0o600 })
  await chmod(edPath, 0o600).catch(() => {})
  await chmod(xPath, 0o600).catch(() => {})

  return {
    dir,
    paths,
    caPem,
    serverCertPem,
    serverKeyPem,
    clientCertPem,
    clientKeyPem,
    otherCaPem,
    otherServerCertPem,
    otherServerKeyPem,
    otherClientCertPem,
    otherClientKeyPem,
    clientSpki,
    serverSpki,
    otherClientSpki,
    ed,
    serverEd,
    x,
    edPrivatePem,
    serverEdPrivatePem,
    xPrivatePem,
    edPath,
    xPath,
    edPublicRaw: rawPublicBase64(ed),
    serverEdPublicRaw: rawPublicBase64(serverEd),
    xPublicRaw: rawPublicBase64(x),
    async cleanup() {
      await rm(dir, { recursive: true, force: true })
    },
  }
}

export function envFor(fixture, overrides = {}) {
  return {
    DSH_DIAGNOSTICS_UPLOAD: '1',
    DSH_DIAGNOSTICS_HOST: '127.0.0.1',
    DSH_DIAGNOSTICS_PORT: '18443',
    DSH_DIAGNOSTICS_CA_FILE: fixture.paths['ca.crt'],
    DSH_DIAGNOSTICS_CERT_FILE: fixture.paths['client.crt'],
    DSH_DIAGNOSTICS_KEY_FILE: fixture.paths['client.key'],
    DSH_DIAGNOSTICS_CLIENT_ED25519_KEY_FILE: fixture.edPath,
    DSH_DIAGNOSTICS_SERVER_SPKI: `sha256:${fixture.serverSpki}`,
    DSH_DIAGNOSTICS_SERVER_ED25519_PUBLIC_KEY: fixture.serverEdPublicRaw,
    DSH_DIAGNOSTICS_RECIPIENT_X25519_PUBLIC_KEY: fixture.xPublicRaw,
    DSH_DIAGNOSTICS_SPOOL_DIR: join(fixture.dir, 'spool'),
    DSH_DIAGNOSTICS_VERIFIED_DIR: join(fixture.dir, 'verified'),
    ...overrides,
  }
}

export async function configFor(fixture, overrides = {}) {
  const { loadDiagnosticsConfig } = await import('../../lib/diagnostics/config.js')
  return await loadDiagnosticsConfig({
    env: envFor(fixture, overrides),
    home: fixture.dir,
    resolveHost: async () => ['127.0.0.1'],
  })
}
