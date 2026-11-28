import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDiagnosticsFixture } from './helpers/diagnostics-fixture.mjs'
import { DiagnosticsMockServer } from './helpers/diagnostics-server.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

function probeEnv(fixture, home, diag, fakeCli, overrides = {}) {
  const env = { ...process.env, HOME: home, PROBE_HOME: home, PROBE_CLI: fakeCli, PROBE_REQUIRE_WIZARD: '1', PROBE_DIAG_DIR: diag, DSH_HOME: fixture.dir }
  for (const key of Object.keys(env)) {
    if (key.startsWith('DSH_DIAGNOSTICS_')) delete env[key]
  }
  return { ...env, ...overrides }
}

function writeConfig(fixture, port) {
  const configDir = join(fixture.dir, 'tui-diagnostics')
  mkdirSync(configDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    enabled: true,
    host: '127.0.0.1',
    port,
    caFile: fixture.paths['ca.crt'],
    certFile: fixture.paths['client.crt'],
    keyFile: fixture.paths['client.key'],
    clientEd25519KeyFile: fixture.edPath,
    serverSpkiSha256: `sha256:${fixture.serverSpki}`,
    serverEd25519PublicKey: fixture.serverEdPublicRaw,
    recipientX25519PublicKey: fixture.xPublicRaw,
    spoolDir: join(fixture.dir, 'spool'),
    verifiedDir: join(fixture.dir, 'verified'),
  }, null, 2), { mode: 0o600 })
}

async function runProbe(fixture, overrides) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-diag-probe-'))
  const home = join(root, 'home')
  const diag = join(root, 'diag')
  const fakeCli = join(root, 'fake-tui.mjs')
  mkdirSync(home, { recursive: true })
  writeFileSync(fakeCli, "process.stdout.write('目录:fake\\n'); setInterval(() => {}, 1000)\n")
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(REPO, 'scripts/tui-setup-probe.mjs'), '--keep'], {
      cwd: REPO,
      env: probeEnv(fixture, home, diag, fakeCli, overrides),
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('probe timed out'))
    }, 60_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (status) => {
      clearTimeout(timer)
      resolve({ status, signal: null, stdout, stderr })
    })
  })
  return { result, root }
}

test('config-file enabled:true triggers the probe upload without an env opt-in', async (t) => {
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
  writeConfig(fixture, port)
  const { result, root } = await runProbe(fixture, {})
  try {
    if (/node-pty is unavailable/u.test(result.stdout ?? '')) {
      t.skip('node-pty is unavailable on this host')
      return
    }
    assert.equal(result.status, 1)
    assert.equal(server.bundles.size, 1)
    const state = [...server.bundles.values()][0]
    assert.equal(state.manifest.kind, 'probe-failure')
    assert.equal(state.manifest.failureCode, 'PROBE_ASSERTION')
  } finally {
    rmSync(root, { recursive: true, force: true })
    await server.stop()
    await fixture.cleanup()
  }
})

test('env override 0 wins over the config file and keeps the probe offline', async (t) => {
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
  writeConfig(fixture, port)
  const { result, root } = await runProbe(fixture, { DSH_DIAGNOSTICS_UPLOAD: '0' })
  try {
    if (/node-pty is unavailable/u.test(result.stdout ?? '')) {
      t.skip('node-pty is unavailable on this host')
      return
    }
    assert.equal(result.status, 1)
    assert.equal(server.connectionCount, 0)
    assert.equal(server.bundles.size, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    await server.stop()
    await fixture.cleanup()
  }
})
