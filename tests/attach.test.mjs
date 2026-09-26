import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ATTACH_RECOVERY_WINDOW_MS,
  RECOVERY_BACKOFF_MS,
  attachPeerVanished,
  createAttacher,
  recoveryDelay,
} from '../lib/attach.js'

/** An attacher with scripted relay outcomes and a fake clock. */
function harness(options = {}) {
  const reports = []
  const exits = []
  const spawned = []
  const reconnects = []
  const relayResults = [...(options.relays ?? [])]
  let clock = 1_000
  const events = []
  const attacher = createAttacher({
    relay: async (sock, seed = '') => {
      events.push(`relay:${sock}${seed === '' ? '' : `+${seed}`}`)
      const next = relayResults.shift()
      if (next === undefined) throw new Error(`no scripted relay result for ${sock}`)
      clock += next.tookMs ?? 0
      if (next.error !== undefined) throw next.error
      return { reason: next.reason }
    },
    quiet: () => { events.push('quiet') },
    beginCapture: () => { events.push('capture:start') },
    endCapture: () => { events.push('capture:stop'); return options.seed ?? '' },
    inspectLiveHost: async () => options.live?.(),
    spawnHost: sessionId => {
      spawned.push(sessionId)
      events.push('spawned')
      return {
        sock: `spawned:${sessionId}`,
        pid: 4242,
        exitWatch: { dispose: () => {}, exited: Promise.resolve(null) },
      }
    },
    waitForDisplaySock: async () => {},
    report: message => { reports.push(message) },
    exit: code => { exits.push(code) },
    messages: {
      connecting: sessionId => `connecting ${sessionId}`,
      recovering: sessionId => `recovering ${sessionId}`,
      replaced: sessionId => `replaced ${sessionId}`,
      flapping: sessionId => `flapping ${sessionId}`,
      zombie: (sessionId, pid) => `zombie ${sessionId} ${pid}`,
      attached: (sessionId, pid) => `attached ${sessionId} ${pid}`,
    },
    now: () => clock,
    burst: options.burst,
    debug: options.debug,
    backoff: options.backoff,
    random: options.random ?? (() => 0),
    onReconnected: info => { reconnects.push(info) },
  })
  return { attacher, reports, exits, spawned, events, reconnects, tick: ms => { clock += ms } }
}

test('a kick from a newer display is an exit, not a retry', async () => {
  const h = harness({ relays: [{ reason: 'replaced' }] })
  await h.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(h.exits, [0], 'the replaced launcher exits quietly')
  assert.deepEqual(h.spawned, [], 'and must never start another Host')
  assert.equal(h.attacher.recoveries, 0, 'a replacement is not a recovery')
  // Silence is the point: this window's link is usually the dead one, so
  // anything written here is flushed onto that terminal when it comes back.
  assert.deepEqual(h.reports, [], 'a kicked launcher writes nothing to its own terminal')
  // And the reply its probe is still owed is swallowed before the TTY goes back
  // to the shell, which would otherwise echo `^[[17;1R` over the prompt.
  assert.equal(h.events.at(-1), 'quiet', 'the TTY is quieted again before exiting')
})

test('a goodbye also drains the probe reply before handing the TTY back', async () => {
  const h = harness({ relays: [{ reason: 'goodbye' }] })
  await h.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(h.exits, [0])
  assert.equal(h.events.at(-1), 'quiet', 'the shell must not echo a late cursor reply')
})

test('a kicked launcher reports only under DSH_TUI_DEBUG=1', async () => {
  const h = harness({ relays: [{ reason: 'replaced' }], debug: true })
  await h.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(h.exits, [0])
  assert.equal(h.reports.some(line => line.startsWith('replaced')), true)
})

test('a goodbye exits without respawning', async () => {
  const h = harness({ relays: [{ reason: 'goodbye' }] })
  await h.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(h.exits, [0])
  assert.deepEqual(h.spawned, [])
})

// The original bug: the Host was mid-dispose, the first attach was accepted
// and then closed, and a manual second attempt was the only way in.
test('a Host that closes right after accepting is retried once', async () => {
  const h = harness({
    relays: [{ reason: 'host-closed' }, { reason: 'goodbye' }],
    live: () => undefined,
  })
  await h.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(h.spawned, ['main-session'], 'the retry starts a fresh Host')
  assert.equal(h.events.includes('quiet'), true, 'the TTY is quieted before the retry')
  assert.deepEqual(h.exits, [0])
})

test('a vanished peer is retried, a real fault is not', async () => {
  // `write EPIPE` early in an attach is the mid-dispose Host racing us.
  const epipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  const recovered = harness({ relays: [{ error: epipe, tookMs: 20 }, { reason: 'goodbye' }] })
  await recovered.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(recovered.spawned, ['main-session'])
  assert.deepEqual(recovered.exits, [0])
  // The failed relay restored cooked mode on its way out; every recovery path
  // has to quiet the TTY again or an in-flight cursor reply is echoed over the
  // screen as `^[[17;1R` for the whole wait.
  const quietBeforeRecovery = recovered.events.indexOf('quiet')
  assert.ok(quietBeforeRecovery !== -1, 'the retry quiets the terminal')
  assert.ok(recovered.events.indexOf('relay:main-session') < quietBeforeRecovery)

  const failing = harness({ relays: [{ error: Object.assign(new Error('nope'), { code: 'EACCES' }) }] })
  await assert.rejects(() => failing.attacher.attachExisting('main-session', 'sock-a'), /nope/)
  assert.deepEqual(failing.spawned, [], 'a non-peer error must surface, not respawn')

  // The same EPIPE after the recovery window is a real problem, not a Host
  // that was on its way out.
  const lateEpipe = harness({
    relays: [{ error: epipe, tookMs: ATTACH_RECOVERY_WINDOW_MS + 1 }],
  })
  await assert.rejects(() => lateEpipe.attacher.attachExisting('main-session', 'sock-a'), /write EPIPE/)
  assert.deepEqual(lateEpipe.spawned, [])

  // And so is a Host that stays up for a while and only then closes.
  const lateClose = harness({ relays: [{ reason: 'host-closed', tookMs: ATTACH_RECOVERY_WINDOW_MS + 1 }] })
  await lateClose.attacher.attachExisting('main-session', 'sock-a')
  assert.deepEqual(lateClose.exits, [0])
  assert.deepEqual(lateClose.spawned, [], 'too late to be a mid-dispose Host')
})

// Two launchers that both keep retrying push each other off the display in a
// loop; this breaker covers a leftover launcher that predates FRAME_REPLACED.
test('a burst of recoveries stops instead of fighting forever', async () => {
  const h = harness({
    relays: [
      { reason: 'host-closed' }, { reason: 'goodbye' },
      { reason: 'host-closed' }, { reason: 'goodbye' },
      { reason: 'host-closed' }, { reason: 'goodbye' },
      { reason: 'host-closed' }, { reason: 'goodbye' },
    ],
    burst: { windowMs: 60_000, limit: 3 },
  })
  for (let round = 0; round < 3; round += 1) {
    await h.attacher.attachExisting('main-session', `sock-${round}`)
  }
  assert.equal(h.attacher.recoveries, 3)
  await assert.rejects(
    () => h.attacher.attachExisting('main-session', 'sock-final'),
    /flapping main-session/,
  )
  assert.equal(h.spawned.length, 3, 'the fourth burst attempt is refused before spawning')
})

// The breaker counts recoveries inside a window; once the window has passed
// the launcher may try again (a flapping SSH link must not disable recovery
// for the rest of the session).
test('the recovery burst window expires', async () => {
  const h = harness({
    relays: [
      { reason: 'host-closed' }, { reason: 'goodbye' },
      { reason: 'host-closed' }, { reason: 'goodbye' },
      { reason: 'host-closed' }, { reason: 'goodbye' },
      { reason: 'host-closed' }, { reason: 'goodbye' },
    ],
    burst: { windowMs: 1_000, limit: 2 },
  })
  for (let round = 0; round < 2; round += 1) {
    await h.attacher.attachExisting('main-session', `sock-${round}`)
  }
  await assert.rejects(() => h.attacher.attachExisting('main-session', 'sock-blocked'), /flapping/)
  h.tick(1_500)
  await h.attacher.attachExisting('main-session', 'sock-later')
  assert.deepEqual(h.exits.at(-1), 0, 'a new window allows recovery again')
})

test('attachOrSpawn uses a live Host instead of starting a second one', async () => {
  const h = harness({
    relays: [{ reason: 'goodbye' }],
    live: () => ({ kind: 'attachable', sock: 'live-sock', pid: 7 }),
  })
  await h.attacher.attachOrSpawn('main-session')
  assert.deepEqual(h.spawned, [], 'never spawn while a Host is listening')
  assert.equal(h.events.includes('relay:live-sock'), true)
})

test('attachOrSpawn spawns and waits when nothing is alive', async () => {
  const h = harness({ relays: [{ reason: 'goodbye' }], live: () => undefined })
  await h.attacher.attachOrSpawn('main-session')
  assert.deepEqual(h.spawned, ['main-session'])
  assert.equal(h.events.includes('relay:spawned:main-session'), true)
})

// A fresh Host takes a moment; keystrokes typed meanwhile used to be dropped
// on the floor. They are captured and handed to the relay instead.
test('typing during a Host boot is carried into the relay', async () => {
  const h = harness({ relays: [{ reason: 'goodbye' }], live: () => undefined, seed: 'early' })
  await h.attacher.attachOrSpawn('main-session')
  const started = h.events.indexOf('capture:start')
  const stopped = h.events.indexOf('capture:stop')
  assert.ok(started !== -1 && stopped !== -1, 'the capture is started and stopped')
  assert.equal(h.events[started - 1], 'spawned', 'capture starts right after spawning')
  assert.equal(h.events.includes('relay:spawned:main-session+early'), true,
    'the captured burst reaches the relay')
})

test('a live Host attach does not need a capture', async () => {
  const h = harness({
    relays: [{ reason: 'goodbye' }],
    live: () => ({ kind: 'attachable', sock: 'live-sock', pid: 7 }),
  })
  await h.attacher.attachOrSpawn('main-session')
  assert.equal(h.events.includes('capture:start'), false)
  assert.equal(h.events.includes('relay:live-sock'), true)
})

test('a zombie lock is reported instead of racing for the session', async () => {
  const h = harness({
    relays: [],
    live: () => ({ kind: 'zombie', sock: 'dead-sock', pid: 99 }),
  })
  await assert.rejects(() => h.attacher.attachOrSpawn('main-session'), /zombie main-session 99/)
  assert.deepEqual(h.spawned, [])
})

test('attachOrSpawn refuses a session a window is on, instead of kicking it', async () => {
  // This is the path a `--resume=<id>` launch and any script reach. There is
  // nobody here to confirm a takeover with, and attaching anyway silently
  // replaced the display the user was typing into.
  const h = harness({
    relays: [{ reason: 'goodbye' }],
    live: () => ({ kind: 'attachable', sock: 'live-sock', pid: 7, state: 'attached' }),
  })
  await assert.rejects(() => h.attacher.attachOrSpawn('main-session'), /attached main-session 7/)
  assert.deepEqual(h.spawned, [], 'and it must not start a second Host either')
  assert.equal(h.events.includes('relay:live-sock'), false, 'no relay was opened')
  assert.deepEqual(h.exits, [], 'the refusal is an error, not a quiet exit')
})

test('attachOrSpawn still reattaches a Host whose window is gone', async () => {
  for (const state of ['paused', 'running-detached', undefined]) {
    const h = harness({
      relays: [{ reason: 'goodbye' }],
      live: () => ({ kind: 'attachable', sock: 'leftover-sock', pid: 7, ...(state === undefined ? {} : { state }) }),
    })
    await h.attacher.attachOrSpawn('main-session')
    assert.equal(h.events.includes('relay:leftover-sock'), true, String(state))
    assert.deepEqual(h.spawned, [], String(state))
  }
})

test('the picker-confirmed takeover attaches without asking again', async () => {
  // `attachExisting` is what the picker calls once the user confirmed, and what
  // a recovery uses. The guard lives in `attachOrSpawn` alone, so a window that
  // really is gone can still be taken over.
  const h = harness({
    relays: [{ reason: 'goodbye' }],
    live: () => ({ kind: 'attachable', sock: 'live-sock', pid: 7, state: 'attached' }),
  })
  await h.attacher.attachExisting('main-session', 'live-sock')
  assert.equal(h.events.includes('relay:live-sock'), true)
  assert.deepEqual(h.exits, [0])
})

test('attachPeerVanished only accepts a vanished peer inside the window', () => {
  const epipe = Object.assign(new Error('x'), { code: 'EPIPE' })
  const reset = Object.assign(new Error('x'), { code: 'ECONNRESET' })
  const refused = Object.assign(new Error('x'), { code: 'ECONNREFUSED' })
  const destroyed = Object.assign(new Error('x'), { code: 'ERR_STREAM_DESTROYED' })
  const other = Object.assign(new Error('x'), { code: 'EACCES' })
  for (const error of [epipe, reset, refused, destroyed]) {
    assert.equal(attachPeerVanished(error, 10), true)
    assert.equal(attachPeerVanished(error, ATTACH_RECOVERY_WINDOW_MS), false)
  }
  assert.equal(attachPeerVanished(other, 10), false)
  assert.equal(attachPeerVanished(new Error('plain'), 10), false)
})

// The backoff schedule: one run gets the whole thing, so a link that flaps for
// half a minute is no longer cut off after three tries.
test('the retry backoff grows, is jittered, and is capped', () => {
  assert.deepEqual([...RECOVERY_BACKOFF_MS], [250, 500, 1_000, 2_000, 4_000])
  // A jitter of 0 takes the low half, 1 the full nominal wait.
  assert.equal(recoveryDelay(0, () => 0), 125)
  assert.equal(recoveryDelay(0, () => 1), 250)
  assert.equal(recoveryDelay(2, () => 1), 1_000)
  for (let attempt = 0; attempt < RECOVERY_BACKOFF_MS.length; attempt += 1) {
    const low = recoveryDelay(attempt, () => 0)
    const high = recoveryDelay(attempt, () => 1)
    assert.ok(low <= high, `attempt ${attempt} keeps its bounds`)
  }
  // Past the schedule the last wait repeats rather than growing without bound.
  assert.equal(recoveryDelay(99, () => 1), 4_000)
})

test('a run retries through the schedule and reports the reconnect', async () => {
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  // The initial attach fails, then the run's own attempts: two of them fail and
  // the third reaches a Host that stays up.
  const h = harness({
    backoff: [0, 0, 0],
    relays: [
      { error: epipe(), tookMs: 20 },
      { error: epipe(), tookMs: 20 }, { error: epipe(), tookMs: 20 },
      { reason: 'goodbye' },
    ],
  })
  await h.attacher.attachExisting('main-session', 'sock-a')
  assert.equal(h.spawned.length, 3, 'every attempt in the run spawned a Host')
  assert.deepEqual(h.exits, [0], 'the third one succeeded and the window ran to its end')
  assert.deepEqual(
    h.reconnects,
    [{ attempts: 2, elapsedMs: 40 }],
    'the run reports how many retries it needed and how long the whole run took',
  )
  // One run is one burst entry, however many attempts it needed.
  assert.equal(h.attacher.recoveries, 1)
})

test('a run gives up only after the whole schedule, then says flapping', async () => {
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  const h = harness({
    backoff: [0, 0, 0],
    // The initial attach plus one failure per scheduled attempt.
    relays: [
      { error: epipe(), tookMs: 20 }, { error: epipe(), tookMs: 20 },
      { error: epipe(), tookMs: 20 }, { error: epipe(), tookMs: 20 },
    ],
  })
  await assert.rejects(() => h.attacher.attachExisting('main-session', 'sock-a'), /flapping main-session/)
  assert.equal(h.spawned.length, 3, 'every attempt in the schedule was tried before giving up')
  assert.deepEqual(h.reconnects, [], 'nothing recovered, so nothing is reported')
})

test('a real fault still ends the run on the spot', async () => {
  const h = harness({
    backoff: [0, 0, 0],
    relays: [
      { error: Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }), tookMs: 20 },
      { error: Object.assign(new Error('nope'), { code: 'EACCES' }) },
    ],
  })
  await assert.rejects(() => h.attacher.attachExisting('main-session', 'sock-a'), /nope/)
  assert.equal(h.spawned.length, 1, 'the schedule does not swallow a real failure')
})

test('the burst breaker counts runs, not attempts', async () => {
  const epipe = () => Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
  const h = harness({
    backoff: [0, 0, 0],
    burst: { windowMs: 60_000, limit: 1 },
    relays: [
      { error: epipe(), tookMs: 20 }, { error: epipe(), tookMs: 20 },
      { error: epipe(), tookMs: 20 }, { error: epipe(), tookMs: 20 },
      // The refused run still fails its initial attach before asking to recover.
      { error: epipe(), tookMs: 20 },
    ],
  })
  await assert.rejects(() => h.attacher.attachExisting('main-session', 'sock-a'), /flapping/)
  assert.equal(h.spawned.length, 3, 'the single allowed run still spent its whole schedule')
  await assert.rejects(
    () => h.attacher.attachExisting('main-session', 'sock-b'),
    /flapping/,
    'a second run inside the window is refused before spawning',
  )
  assert.equal(h.spawned.length, 3, 'and it spawns nothing')
})
