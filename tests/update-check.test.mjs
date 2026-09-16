import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
setLocale('zh')

import { EventEmitter } from 'node:events'

import {
  checkForPluginUpdate,
  compareSemver,
  formatUpdateNotice,
  fetchLatestNpmVersion,
  installPluginLatest,
  pluginUpgradeCommand,
  resolveDshInvocation,
  resolvePluginProfileName,
} from '../lib/update-check.js'

test('compareSemver orders dotted versions', () => {
  assert.equal(compareSemver('0.3.4', '0.3.5') < 0, true)
  assert.equal(compareSemver('0.3.5', '0.3.4') > 0, true)
  assert.equal(compareSemver('v0.3.4', '0.3.4'), 0)
  assert.equal(compareSemver('0.4.0', '0.3.9') > 0, true)
})

test('pluginUpgradeCommand pins @latest so pnpm does not keep a lockfile version', () => {
  assert.equal(pluginUpgradeCommand('tui'), 'dsh plugin --profile tui add dsh-ssh-tui@latest')
  assert.equal(resolvePluginProfileName({ DSH_TUI_PROFILE: 'jump' }), 'jump')
})

test('formatUpdateNotice includes the @latest upgrade command', () => {
  const text = formatUpdateNotice('0.3.7', '0.3.10', 'tui')
  assert.match(text, /0\.3\.10/)
  assert.match(text, /当前 0\.3\.7/)
  assert.match(text, /dsh plugin --profile tui add dsh-ssh-tui@latest/)
})

test('fetchLatestNpmVersion returns undefined on HTTP failure', async () => {
  const latest = await fetchLatestNpmVersion(async () => new Response('nope', { status: 500 }))
  assert.equal(latest, undefined)
})

test('checkForPluginUpdate stays quiet when disabled or already current', async () => {
  const previous = process.env.DSH_TUI_NO_UPDATE_CHECK
  process.env.DSH_TUI_NO_UPDATE_CHECK = '1'
  try {
    assert.equal(await checkForPluginUpdate('0.0.1'), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_NO_UPDATE_CHECK
    else process.env.DSH_TUI_NO_UPDATE_CHECK = previous
  }
})

/**
 * The in-app update re-runs the dsh CLI. A bare `spawn('dsh', …)` is fine on
 * POSIX and fails on Windows with `spawn dsh ENOENT`: a global install there is
 * a `dsh.cmd` shim, and CreateProcess does not apply PATHEXT. The fix is to run
 * the CLI this process is already inside — same node, same entry script — and to
 * keep the shell fallback for the case where that entry is not visible.
 */
test('the update re-runs our own dsh entry, not a bare `dsh` from PATH', () => {
  const entry = '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'
  const visible = { execPath: '/usr/bin/node', argv: ['/usr/bin/node', entry, '--profile', 'tui'], exists: () => true }
  assert.deepEqual(resolveDshInvocation({ ...visible, platform: 'linux' }), {
    command: '/usr/bin/node', prefix: [entry], shell: false,
  })
  // Windows is where the bare name broke; the entry path is used there too.
  assert.deepEqual(resolveDshInvocation({ ...visible, platform: 'win32' }), {
    command: '/usr/bin/node', prefix: [entry], shell: false,
  })

  // No visible entry (a bundled CLI, say): `dsh` through a shell — required on
  // Windows for the `.cmd` shim, harmless on POSIX.
  const hidden = { execPath: '/usr/bin/node', argv: ['/usr/bin/node'], exists: () => false }
  assert.deepEqual(resolveDshInvocation({ ...hidden, platform: 'win32' }), {
    command: 'dsh', prefix: [], shell: true,
  })
  assert.deepEqual(resolveDshInvocation({ ...hidden, platform: 'linux' }), {
    command: 'dsh', prefix: [], shell: false,
  })
})

test('installPluginLatest spawns the resolved command and reports its exit', async () => {
  const calls = []
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('added dsh-ssh-tui@0.7.0'))
      child.emit('close', 0)
    })
    return child
  }
  const result = await installPluginLatest('tui', {
    invocation: { command: '/usr/bin/node', prefix: ['/dsh/bin.js'], shell: false },
    spawnFn,
  })
  assert.equal(result.ok, true)
  assert.match(result.output, /0\.7\.0/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, '/usr/bin/node')
  assert.deepEqual(calls[0].args, ['/dsh/bin.js', 'plugin', '--profile', 'tui', 'add', 'dsh-ssh-tui@latest'])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.windowsHide, true)

  // The failure users saw: the spawn itself errors (ENOENT) rather than exiting.
  const broken = new EventEmitter()
  broken.stdout = new EventEmitter()
  broken.stderr = new EventEmitter()
  const failed = await installPluginLatest('tui', {
    invocation: { command: 'dsh', prefix: [], shell: true },
    spawnFn: () => {
      queueMicrotask(() => {
        const error = new Error('spawn dsh ENOENT')
        error.code = 'ENOENT'
        broken.emit('error', error)
      })
      return broken
    },
  })
  assert.equal(failed.ok, false)
  assert.match(failed.output, /ENOENT/)
})
