import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, chmod, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { loadDiagnosticsConfig, describeDiagnosticsConfig } from '../lib/diagnostics/config.js'
import { createDiagnosticsFixture, envFor } from './helpers/diagnostics-fixture.mjs'

test('diagnostics are disabled by default and need no endpoint', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const config = await loadDiagnosticsConfig({ env: {}, home: fixture.dir })
    assert.equal(config.enabled, false)
    assert.equal(config.port, 18443)
    const status = describeDiagnosticsConfig(config)
    assert.equal(status.enabled, false)
    assert.equal(status.endpointId, null)
  } finally {
    await fixture.cleanup()
  }
})

test('an explicit opt-in plus a complete credential set resolves', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const config = await loadDiagnosticsConfig({
      env: envFor(fixture),
      home: fixture.dir,
      resolveHost: async () => ['127.0.0.1'],
    })
    assert.equal(config.enabled, true)
    assert.equal(config.host, '127.0.0.1')
    assert.equal(config.port, 18443)
    assert.match(config.serverSpkiSha256, /^[0-9a-f]{64}$/)
    assert.match(config.destinationFingerprint, /^[0-9a-f]{64}$/)
    assert.equal(config.resolvedAddresses?.[0], '127.0.0.1')
    assert.deepEqual(config.resolvedAddresses, ['127.0.0.1'])
    const status = describeDiagnosticsConfig(config)
    assert.equal(status.enabled, true)
    assert.equal(JSON.stringify(status).includes(fixture.xPublicRaw), false)
    assert.equal(JSON.stringify(status).includes('BEGIN'), false)
  } finally {
    await fixture.cleanup()
  }
})

test('80/443 and privileged ports are rejected', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    for (const port of ['80', '443', '1023', '65536', '18443.5']) {
      await assert.rejects(
        loadDiagnosticsConfig({
          env: envFor(fixture, { DSH_DIAGNOSTICS_PORT: port }),
          home: fixture.dir,
          resolveHost: async () => ['127.0.0.1'],
        }),
        (error) => error.code === 'CONFIG_INVALID',
        `port ${port}`,
      )
    }
  } finally {
    await fixture.cleanup()
  }
})

test('public endpoints are refused unless explicitly allowed', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    await assert.rejects(
      loadDiagnosticsConfig({
        env: envFor(fixture, { DSH_DIAGNOSTICS_HOST: 'diag.example.com' }),
        home: fixture.dir,
        resolveHost: async () => ['8.8.8.8'],
      }),
      (error) => error.code === 'PUBLIC_ENDPOINT_REFUSED',
    )
    const allowed = await loadDiagnosticsConfig({
      env: envFor(fixture, {
        DSH_DIAGNOSTICS_HOST: 'diag.example.com',
        DSH_DIAGNOSTICS_ALLOW_PUBLIC_ENDPOINT: '1',
      }),
      home: fixture.dir,
      resolveHost: async () => ['8.8.8.8'],
    })
    assert.equal(allowed.enabled, true)
  } finally {
    await fixture.cleanup()
  }
})

test('credential files must be regular and 0600', { skip: process.platform === 'win32' }, async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    await chmod(fixture.paths['client.key'], 0o644)
    await assert.rejects(
      loadDiagnosticsConfig({
        env: envFor(fixture),
        home: fixture.dir,
        resolveHost: async () => ['127.0.0.1'],
      }),
      (error) => error.code === 'CONFIG_INVALID',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('the config file carries paths and pins but no secret values', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const configDir = join(fixture.dir, 'tui-diagnostics')
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    const configPath = join(configDir, 'config.json')
    await writeFile(configPath, JSON.stringify({
      enabled: true,
      host: '127.0.0.1',
      port: 18443,
      caFile: fixture.paths['ca.crt'],
      certFile: fixture.paths['client.crt'],
      keyFile: fixture.paths['client.key'],
      clientEd25519KeyFile: fixture.edPath,
      serverSpkiSha256: fixture.serverSpki,
      serverEd25519PublicKey: fixture.serverEdPublicRaw,
      recipientX25519PublicKey: fixture.xPublicRaw,
      spoolDir: join(fixture.dir, 'spool'),
      verifiedDir: join(fixture.dir, 'verified'),
    }, null, 2), { mode: 0o600 })
    const config = await loadDiagnosticsConfig({
      env: {
        DSH_HOME: fixture.dir,
        DSH_DIAGNOSTICS_HOST: '127.0.0.1',
        DSH_DIAGNOSTICS_PORT: '18443',
        DSH_DIAGNOSTICS_UPLOAD: '1',
      },
      home: fixture.dir,
      resolveHost: async () => ['127.0.0.1'],
    })
    assert.equal(config.enabled, true)
    assert.equal(config.caPem?.includes('BEGIN CERTIFICATE'), true)
  } finally {
    await fixture.cleanup()
  }
})

test('unknown config keys fail closed', async () => {
  const fixture = await createDiagnosticsFixture()
  try {
    const configDir = join(fixture.dir, 'tui-diagnostics')
    await mkdir(configDir, { recursive: true, mode: 0o700 })
    await writeFile(join(configDir, 'config.json'), JSON.stringify({ enabled: true, token: 'do-not-store-me' }))
    await assert.rejects(
      loadDiagnosticsConfig({
        env: { DSH_HOME: fixture.dir, DSH_DIAGNOSTICS_UPLOAD: '1' },
        home: fixture.dir,
        resolveHost: async () => ['127.0.0.1'],
      }),
      (error) => error.code === 'CONFIG_INVALID',
    )
  } finally {
    await fixture.cleanup()
  }
})
