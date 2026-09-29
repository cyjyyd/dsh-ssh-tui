import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { desktopLauncher, inactiveNotice, requiredTerminalError, terminalAvailability } from '../lib/platform.js'

/**
 * What the plugin does when there is no terminal.
 *
 * It is a terminal UI, so the host decides whether it can do anything at all:
 * the desktop Harness mounts plugins in a process with no console (Electron as
 * Node), and a pipe has no TTY either. The rule these pin is that a plugin must
 * not be able to break its host: no terminal means one calm log line and nothing
 * mounted — never a thrown entry. The old `throw` surfaced as "1 entry did not
 * activate" and, per the desktop defect report, took the app down with it.
 *
 * The apply-level cases run in a real child process with piped stdio, because
 * that is the only way to be *sure* there is no TTY (the test runner's own stdio
 * depends on how it was started).
 */

const ROOT = join(import.meta.dirname, '..')
const PROBE = `
const logs = []
const ctx = {
  get: () => undefined,
  on: () => () => {},
  effect: () => { throw new Error('the plugin mounted something without a terminal') },
  logger: name => ({ info: message => logs.push(name + ': ' + message) }),
}
import(process.env.PROBE_MODULE).then(async module => {
  module.apply(ctx, { sessionId: 'probe', ...(process.env.PROBE_CONFIG ? JSON.parse(process.env.PROBE_CONFIG) : {}) })
  console.log(JSON.stringify({ ok: true, logs }))
}).catch(error => {
  if (process.env.PROBE_FATAL === '1') throw error
  console.log(JSON.stringify({ ok: false, error: String(error.message ?? error) }))
})
`

/** Run `apply` in a child whose stdio is pipes: no TTY, by construction. */
function applyWithoutTerminal({ argv = [], config, fatal = false } = {}) {
  const result = spawnSync(process.execPath, ['-e', PROBE, ...argv], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PROBE_MODULE: join(ROOT, 'lib', 'index.js'),
      ...(fatal ? { PROBE_FATAL: '1' } : {}),
      ...(config === undefined ? {} : { PROBE_CONFIG: JSON.stringify(config) }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const line = result.stdout.trim().split('\n').at(-1) ?? ''
  let parsed = {}
  try {
    parsed = JSON.parse(line)
  } catch {
    // A fatal run prints no JSON: the throw went to stderr, which is the point.
  }
  return { code: result.status, stderr: result.stderr, ...parsed }
}

test('the availability decision is one small table', () => {
  const tty = { stdinIsTty: true, stdoutIsTty: true, hostProcess: false, desktop: false }
  assert.equal(terminalAvailability(tty), 'terminal')
  // The detached Host has no TTY of its own: its terminal is in the window that
  // attaches, so it must still serve.
  assert.equal(terminalAvailability({ ...tty, hostProcess: true, stdinIsTty: false, stdoutIsTty: false }), 'host-relay')
  assert.equal(terminalAvailability({ ...tty, stdinIsTty: false }), 'no-tty')
  assert.equal(terminalAvailability({ ...tty, stdoutIsTty: false }), 'no-tty', 'both streams matter — the TUI draws on stdout')
  assert.equal(terminalAvailability({ ...tty, stdinIsTty: false, desktop: true }), 'desktop')
  // A TTY under the desktop launcher is not a thing today, but if it ever is, the
  // terminal wins: that is what the plugin is for.
  assert.equal(terminalAvailability({ ...tty, desktop: true }), 'terminal')
})

test('the notice says what is not running, and what to run instead', () => {
  const generic = inactiveNotice('no-tty')
  assert.match(generic, /inactive here/u)
  assert.match(generic, /mounted nothing/u)
  assert.equal(/error|fail/iu.test(generic), false, 'a pipe is not a failure to report')
  const desktop = inactiveNotice('desktop')
  assert.match(desktop, /desktop Harness/u)
  assert.match(desktop, /npm i -g @deepseek-ai\/dsh/u, 'and the one command that brings the TUI back')
  assert.match(desktop, /needs nothing from it/u, 'the desktop app is not missing out')
})

test('without a terminal nothing is mounted and nothing throws', () => {
  const plain = applyWithoutTerminal()
  assert.equal(plain.code, 0, `the process must stay healthy (stderr: ${plain.stderr})`)
  assert.equal(plain.ok, true, 'apply must not throw — a plugin may not break its host')
  const logs = plain.logs ?? []
  assert.equal(logs.length, 1, 'exactly one line, not a warning storm')
  assert.match(logs[0], /^ssh-tui: inactive here/u)
  // The doc name contains "desktop"; the *advice* is what must not be there.
  assert.equal(/desktop Harness/u.test(logs[0]), false, 'a plain pipe is not told about the desktop app')
})

test('under the desktop launcher the line names the desktop, and still mounts nothing', () => {
  // argv carrying the packaged CLI is how the desktop's PATH shim invokes Node.
  const desktop = applyWithoutTerminal({ argv: ['D:/Deepseek-harness/resources/app.asar/dsh/lib/bin.js'] })
  assert.equal(desktop.ok, true)
  assert.equal(desktop.code, 0)
  const line = (desktop.logs ?? [])[0] ?? ''
  assert.match(line, /desktop Harness/u)
  assert.match(line, /dsh web/u, 'it offers what the desktop user actually has')
})

test('requireTerminal restores the hard failure, for callers who want it', () => {
  const strict = applyWithoutTerminal({ config: { requireTerminal: true }, fatal: true })
  assert.notEqual(strict.code, 0, 'an opted-in strict profile fails the process, as the host reports it')
  assert.match(strict.stderr, /TTY|no console|terminal/u, `the reason reaches stderr: ${strict.stderr}`)
})

test('the desktop launcher is recognised, and an ordinary node is not', () => {
  const electron = { electron: '33.0.0', execPath: 'D:/Deepseek-harness/DeepSeek Harness.exe', argv: ['node', 'cli.js'] }
  const asar = { execPath: 'C:/node.exe', argv: ['node', 'D:/Deepseek-harness/resources/app.asar/dsh/lib/bin.js'] }
  const plain = { execPath: '/usr/bin/node', argv: ['node', '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js'] }
  assert.equal(desktopLauncher(electron), true)
  assert.equal(desktopLauncher(asar), true)
  assert.equal(desktopLauncher(plain), false, 'the npm CLI must keep the terminal path')
  assert.equal(desktopLauncher({}), false)
  assert.match(requiredTerminalError(true), /desktop Harness/u)
  assert.match(requiredTerminalError(false), /TTYs/u)
})
