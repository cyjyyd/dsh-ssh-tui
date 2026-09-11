/**
 * Idle-exit and drop-ordering behavior for a Host an SSH drop left behind.
 *
 * A Host is kept alive only while the turn it was dropped in is still running,
 * because it owns the session's kernel write lock (`session.lock`) for its whole
 * life — and that lock is what makes the browser surface refuse the session
 * ("resume failed for session ..."). Once that turn settles, the reason for the
 * leftover Host is gone, so it has to let go: exit after a short window (and let
 * `--resume` reopen the flushed log) instead of holding the session for hours.
 *
 * These drive `SshTui` directly with fake services, the same way the hangup
 * tests in helpers.test.mjs do.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SshTui } from '../lib/tui.js'

function fakeDisplayHost() {
  const host = {
    attached: false,
    sendStdout() { return true },
    sendGoodbye() {},
    close: async () => { host.attached = false },
  }
  return host
}

/** One TUI over fake services, with the observable effects collected. */
function makeTui({ headless = true, flush } = {}) {
  const flushed = []
  const hangups = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { flush: flush ?? (async (session) => { flushed.push(session.id) }) }
      }
      if (name === 'appExit') return (code) => { exits.push(code) }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    headlessDisplay: headless,
    disconnectPolicy: 'continue',
    onHangup: () => { hangups.push('hung') },
  })
  const display = fakeDisplayHost()
  tui.displayHost = display
  return { tui, agent, display, flushed, hangups, exits }
}

function setEnv(name, value) {
  const previous = process.env[name]
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
  return () => {
    if (previous === undefined) delete process.env[name]
    else process.env[name] = previous
  }
}

/** Run `body` with stdout silenced (the TUI paints escape sequences). */
async function quiet(body) {
  const original = process.stdout.write
  process.stdout.write = () => true
  try {
    await body()
  } finally {
    process.stdout.write = original
  }
}

const settle = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

test('a leftover Host exits after the turn it was kept for and frees the session', async () => {
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5')
  const host = makeTui()
  try {
    await host.tui.handleHangup()
    assert.deepEqual(host.hangups, ['hung'], 'a busy drop still keeps the Host')
    assert.deepEqual(host.exits, [], 'the Host stays while the turn runs')

    // The turn ends while nobody is attached: the reason the Host was kept is
    // gone, so it must not hold the session write lock any longer.
    host.agent.status = 'idle'
    host.tui.handleStatus({ agent: host.agent, status: 'idle' })
    assert.deepEqual(host.exits, [], 'the exit waits out the reattach window')

    await settle(80)
    assert.deepEqual(host.exits, [0], 'the idle Host exits on its own')
    assert.deepEqual(host.flushed, ['main-session', 'main-session'], 'the finished turn is flushed before exiting')
    assert.equal(host.tui.disposed, true)
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('a reattach inside the window cancels the idle exit', async () => {
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5000')
  const host = makeTui()
  try {
    await host.tui.handleHangup()
    host.agent.status = 'idle'
    host.tui.handleStatus({ agent: host.agent, status: 'idle' })
    await quiet(async () => { host.tui.attachRelayDisplay() })
    await settle(60)
    assert.equal(host.tui.exiting, false, 'an attached Host must not exit')
    assert.deepEqual(host.exits, [])
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('a hangup that honored a reattach drops the flag instead of swallowing the next drop', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5000')
  const host = makeTui({ flush: async () => { await gate } })
  try {
    await quiet(async () => {
      // The link drops while a turn runs; its flush is still in flight when the
      // user reconnects, so this relay has to be honored by that hangup instead
      // of being disposed with the Host.
      const hangup = host.tui.handleHangup()
      host.tui.attachRelayDisplay()
      assert.equal(host.tui.reattachedDuringHangup, true)
      release()
      await hangup
      assert.deepEqual(host.hangups, [], 'the honored reattach means no leftover Host')
      assert.deepEqual(host.exits, [], 'and no process exit under the live display')
      assert.equal(host.tui.disposed, false)
      // Left set, this flag made every later drop a silent no-op, which left
      // the session lock marked attached/paused while the user was really gone.
      assert.equal(host.tui.reattachedDuringHangup, false, 'the honored reattach must not linger')
    })
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('the next drop is honored after a reattach settled before it', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5000')
  const host = makeTui({ flush: async () => { await gate } })
  try {
    await quiet(async () => {
      // Drop #1 while the turn runs, with a relay arriving during its flush:
      // the hangup honors it and returns without orphaning the Host. The flag
      // it consumed must not be left behind, or the next drop is a silent
      // no-op that leaves the session lock marked attached/paused while the
      // user is really gone.
      const hangup = host.tui.handleHangup()
      host.tui.attachRelayDisplay()
      release()
      await hangup
      assert.equal(host.tui.hostKeptAlive, false)
      assert.equal(host.tui.reattachedDuringHangup, false, 'the honored reattach must not linger')
    })

    // Drop #2, from the reattached state: must still be honored.
    host.tui.handleDisplayDetach()
    await settle()
    assert.deepEqual(host.hangups, ['hung'], 'drop #2 must be honored')
    assert.equal(host.tui.hostKeptAlive, true, 'and it keeps the still-running Host')

    // Drop #3, again from the reattached state: honoring drop #2 set the flag
    // again, so the keep-host path has to clear it or this drop disappears.
    await quiet(async () => { host.tui.attachRelayDisplay() })
    host.tui.handleStatus({ agent: host.agent, status: 'running' })
    host.tui.handleDisplayDetach()
    await settle()
    assert.deepEqual(host.hangups, ['hung', 'hung'], 'drop #3 must be honored too')
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('a turn running again clears the honored reattach that raced a hangup', async () => {
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5000')
  const host = makeTui()
  try {
    // The race this guards: a relay arrived while a hangup was unwinding, so
    // the honored-reattach proxy is set — and a detach followed before any
    // hangup path got to clear it (the detach that cancels a pending hangup
    // returns early). Work starting again proves the race is over, so the flag
    // must not survive to swallow the next drop.
    host.tui.reattachedDuringHangup = true
    host.agent.status = 'running'
    host.tui.handleStatus({ agent: host.agent, status: 'running' })
    assert.equal(host.tui.reattachedDuringHangup, false, 'a running turn clears the stale flag')

    await host.tui.handleHangup()
    assert.deepEqual(host.hangups, ['hung'], 'the drop after the race is honored')
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('every drop after a reattach is honored', async () => {
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5000')
  const host = makeTui()
  try {
    await host.tui.handleHangup()
    assert.deepEqual(host.hangups, ['hung'])

    // A real drop is always preceded by an attach; dropping again while already
    // detached is correctly a no-op.
    await quiet(async () => { host.tui.attachRelayDisplay() })
    host.tui.handleDisplayDetach()
    await settle()
    assert.deepEqual(host.hangups, ['hung', 'hung'], 'the second drop must be honored')

    await quiet(async () => { host.tui.attachRelayDisplay() })
    host.agent.status = 'running'
    host.tui.handleStatus({ agent: host.agent, status: 'running' })
    host.tui.handleDisplayDetach()
    await settle()
    assert.deepEqual(host.hangups, ['hung', 'hung', 'hung'], 'and every drop after it')
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('DSH_TUI_IDLE_EXIT_MS=0 keeps a leftover Host for the legacy six hours', async () => {
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '0')
  const host = makeTui()
  try {
    await host.tui.handleHangup()
    host.agent.status = 'idle'
    host.tui.handleStatus({ agent: host.agent, status: 'idle' })
    await settle(60)
    assert.deepEqual(host.exits, [], 'the exit is opt-out')
    assert.equal(host.tui.exiting, false)
  } finally {
    restore()
    await host.tui.dispose()
  }
})

test('an in-process TUI never arms the idle exit', async () => {
  const restore = setEnv('DSH_TUI_IDLE_EXIT_MS', '5')
  const host = makeTui({ headless: false })
  try {
    await host.tui.handleHangup()
    host.agent.status = 'idle'
    host.tui.handleStatus({ agent: host.agent, status: 'idle' })
    await settle(60)
    assert.deepEqual(host.exits, [], 'only a detached Host owns the session lock')
  } finally {
    restore()
    await host.tui.dispose()
  }
})
