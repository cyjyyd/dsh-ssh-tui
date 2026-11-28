import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = new URL('../scripts/diagnostics-cli.mjs', import.meta.url)

function run(args, env = {}) {
  return spawnSync(process.execPath, [CLI.pathname, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
}

test('the CLI explains itself without touching configuration', () => {
  const result = run(['--help'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /diagnostics-cli/)
  assert.match(result.stdout, /publish/)
})

test('status is JSON and disabled by default', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-diag-cli-'))
  try {
    const result = run(['status'], {
      DSH_HOME: home,
      DSH_DIAGNOSTICS_UPLOAD: '0',
    })
    assert.equal(result.status, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.config.enabled, false)
    assert.deepEqual(parsed.spool, {})
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('publish is a no-op success when diagnostics are disabled', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-diag-cli-'))
  try {
    const result = run(['publish', '--failure-code', 'MANUAL_FAILURE'], {
      DSH_HOME: home,
      DSH_DIAGNOSTICS_UPLOAD: '0',
    })
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^diagnostics: disabled/m)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
