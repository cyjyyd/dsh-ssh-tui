/**
 * Who owns the command line (0.8.2).
 *
 * `@deepseek-ai/dsh-cmdline` hands every app plugin the same argv and lets each parse
 * it with its own grammar; an unknown flag is `program.error`, which exits the
 * process. The desktop application passes `--no-open` (the web app's flag) to its host,
 * so this plugin's startup row rejected it and the host exited 1 — reported by the
 * application as `dsh desktop host exited with 1: error: unknown option '--no-open'`,
 * which is what crashed the desktop build. These cases pin the two signals that make
 * the row step aside, and pin that it does not step aside for a terminal profile.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { apply, anotherAppOwnsCommandLine, inject, SSH_TUI_STARTUP_SERVICE } from '../lib/startup.js'

/** A ctx with just what `apply` touches: `get`, `provide`, and the logger seam. */
function makeCtx({ services = {} } = {}) {
  const provided = []
  const lines = []
  const exits = []
  const ctx = {
    get: name => (name === 'appExit' ? code => exits.push(code) : services[name]),
    provide: (key, value) => { provided.push([key, value]) },
    logger: () => ({ info: message => lines.push(String(message)) }),
  }
  return { ctx, provided, lines, exits }
}

test('a desktop host is not asked to understand the TUI grammar', () => {
  // This runner is not the desktop launcher, so the answer here is "no" — the two
  // signals are checked separately so neither can rot unnoticed.
  assert.equal(anotherAppOwnsCommandLine({ get: () => undefined }), false, 'a plain terminal profile owns its own command line')
  assert.equal(anotherAppOwnsCommandLine({ get: name => (name === 'webStartup' ? {} : undefined) }), true, 'the web app does')

  // The desktop host is simulated by its argv: `app.asar` is one of the three facts
  // `desktopLauncher` reads (`process.versions.electron`, the exe name, the argv).
  const previousArgv = process.argv
  const { ctx, provided, lines, exits } = makeCtx({ services: { cmdlineArgs: { get: () => ['--no-open'] } } })
  try {
    process.argv = ['DeepSeek Harness', 'app.asar', '--no-open']
    apply(ctx)
    assert.equal(provided.length, 0, 'nothing is provided, so no dependent row activates')
    assert.equal(lines.length, 1, 'and it says so in one line')
    assert.match(lines[0], /another app/u)
    // The crash was commander calling the exit seam on `--no-open`, which took the
    // desktop *host* down and the application with it. `--no-open` is never parsed now.
    assert.deepEqual(exits, [], 'the unknown flag never reaches our grammar, so nothing exits')
  } finally {
    process.argv = previousArgv
  }
})

test('a web profile is left alone too, whichever signal arrives first', () => {
  const { ctx, provided, lines, exits } = makeCtx({
    services: { webStartup: { url: 'http://127.0.0.1:1' }, cmdlineArgs: { get: () => ['--no-open'] } },
  })
  apply(ctx)
  assert.equal(provided.length, 0)
  assert.equal(lines.length, 1)
  assert.deepEqual(exits, [], 'a web host keeps its own grammar')
})

test('a terminal profile still gets its grammar', () => {
  // `cmdlineArgs` is what the row injects; the *frame* supplies the launcher's argv.
  // `cmdlineArgs` and `appExit` are the two the launcher must have supplied before the
  // tree mounts; a no-op `appExit` keeps a usage error from ending the test run. The
  // launcher hands over only the *app's* arguments — `--profile tui` is its own flag and
  // never reaches this grammar (which is why it can be parsed at all).
  const launch = args => {
    const { ctx, provided } = makeCtx({ services: { cmdlineArgs: { get: () => args }, appExit: () => {} } })
    apply(ctx)
    return provided
  }
  // The action publishes three things (the identity map, the startup service and the
  // goodbye hint); the one the TUI row injects is the one that must be there.
  const startupOf = provided => provided.find(([key]) => key === SSH_TUI_STARTUP_SERVICE)?.[1]
  const fresh = startupOf(launch([]))
  assert.deepEqual(inject, ['cmdlineArgs'])
  assert.notEqual(fresh, undefined, 'the startup service is provided')
  assert.equal(typeof fresh.sessionId, 'string')
  assert.equal(fresh.resume, false, 'a plain launch is a fresh session')

  const resumed = startupOf(launch(['--resume=main-session-abc']))
  assert.equal(resumed.resume, true, 'and `--resume=<id>` is still understood')
  assert.equal(resumed.sessionId, 'main-session-abc')
})
