import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'

import { DisplayHost, displaySockExists, isPipePath, runDisplayRelay, sessionSockPath } from '../lib/display-sock.js'
import { CURSOR_POSITION_REQUEST } from '../lib/terminal-input.js'
import { SshTui } from '../lib/tui.js'

/**
 * A dropped link repaints the screen; it must never rewrite the transcript.
 *
 * The screen and the transcript are different things, and conflating them is
 * how a reconnect starts duplicating output: the new window has to be painted
 * from scratch (that is expected), while the row array behind it must come out
 * of the handover byte for byte the same. These cases attach and kick three
 * windows onto one live TUI and assert the row array is append-only throughout —
 * a reattach adds no row, loses none, and duplicates none — and that the new
 * window is actually painted with what the transcript holds.
 *
 * Phase 0 of the disconnect work: no product behavior is changed here.
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitUntil(check, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

/** A terminal at the end of an SSH link; it answers the cursor probe late. */
function sshTerminal() {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  const stdout = {
    isTTY: true,
    columns: 100,
    rows: 30,
    writes: '',
    write(chunk) {
      const text = String(chunk)
      stdout.writes += text
      if (text.includes(CURSOR_POSITION_REQUEST)) setTimeout(() => stdin.write('\x1b[5;1R'), 20)
      return true
    },
    on() {},
    off() {},
    removeListener() {},
  }
  return { stdin, stdout }
}

/**
 * Attach a window and wait until it has been painted the text it must show.
 *
 * The first bytes on the wire are the relay's own RTT probe (which the fake
 * terminal answers a round-trip later), so "something was written" is not the
 * same as "the screen was painted".
 */
async function attachWindow(sock, expectText) {
  const window = openWindow(sock)
  await waitUntil(
    () => window.terminal.stdout.writes.includes(expectText),
    `a painted frame containing ${JSON.stringify(expectText)}`,
    10_000,
  )
  return window
}

/** One SSH window attached to the live Host, plus what it was sent. */
function openWindow(sock) {
  const terminal = sshTerminal()
  let settle
  const ended = new Promise(resolve => { settle = resolve })
  const relay = runDisplayRelay(sock, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: true,
  }).then(result => {
    settle(result)
    return result
  })
  return { terminal, relay, ended }
}

/** The transcript as the tests fingerprint it: kind and text of every row. */
const fingerprint = rows => JSON.stringify(rows.map(row => `${row.kind}:${String(row.text ?? '')}`))

async function withLiveTui(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-transcript-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home
  // A key in the environment keeps the first-run wizard from opening a dialog
  // over the transcript this test is about.
  process.env.DEEPSEEK_API_KEY = 'sk-transcript-test'
  t.after(async () => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = previousKey
    await rm(home, { recursive: true, force: true })
  })
  const sessionId = 'main-session-transcript'
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: sessionId, options: {}, status: 'idle', session: { id: sessionId, events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId, color: false, headlessDisplay: true })
  t.after(() => tui.dispose())
  const sock = sessionSockPath(sessionId, home)
  if (!isPipePath(sock)) await mkdir(dirname(sock), { recursive: true, mode: 0o700 })
  tui.start()
  await waitUntil(() => displaySockExists(sock), 'the display channel to listen')
  return { tui, sock }
}

test('three consecutive reattachments leave the transcript append-only', { timeout: 60_000 }, async t => {
  const { tui, sock } = await withLiveTui(t)
  const live = []
  // Registered after the helper's dispose hook, so it runs first: a window left
  // attached would make the Host wait for it forever.
  t.after(async () => {
    for (const window of live) window.terminal.stdin.end()
    await Promise.all(live.map(window => window.ended))
  })
  const pushed = 5
  for (let index = 0; index < pushed; index += 1) tui.rows.push({ kind: 'system', text: `row-${index}` })
  const initial = fingerprint(tui.rows)
  const initialCount = tui.rows.length

  const windows = []
  live.push(...windows)
  let previous = undefined
  let baseline = initial
  let baselineCount = initialCount
  for (let cycle = 1; cycle <= 3; cycle += 1) {
    const window = await attachWindow(sock, `row-${pushed - 1}`)
    windows.push(window)
    live.push(window)

    assert.equal(fingerprint(tui.rows), baseline, `cycle ${cycle}: attaching adds no row and rewrites none`)
    assert.equal(tui.rows.length, baselineCount, `cycle ${cycle}: the row count is untouched`)
    assert.ok(
      window.terminal.stdout.writes.includes(`row-${pushed - 1}`),
      `cycle ${cycle}: the new window is painted with what the transcript holds`,
    )

    if (previous !== undefined) {
      const result = await previous.ended
      assert.equal(result.reason, 'replaced', `cycle ${cycle}: the window it replaced was told why`)
    }

    // New output keeps arriving between drops; it may only ever append.
    const before = fingerprint(tui.rows)
    tui.rows.push({ kind: 'system', text: `cycle-${cycle}` })
    const after = fingerprint(tui.rows)
    assert.notEqual(after, before, `cycle ${cycle}: the new row landed`)
    assert.equal(
      after.startsWith(before.slice(0, -1)),
      true,
      `cycle ${cycle}: the previous transcript is a prefix of the new one`,
    )
    assert.equal(tui.rows.filter(row => String(row.text) === `cycle-${cycle}`).length, 1, `cycle ${cycle}: appended once`)
    baseline = fingerprint(tui.rows)
    baselineCount = tui.rows.length
    previous = window
  }

  assert.equal(tui.rows.length, initialCount + 3, 'three drops, three new rows, nothing else')

})

test('a window that drops mid-transcript is repainted from the rows, not from a replay', { timeout: 60_000 }, async t => {
  const { tui, sock } = await withLiveTui(t)
  const windows = []
  t.after(async () => {
    for (const window of windows) window.terminal.stdin.end()
    await Promise.all(windows.map(window => window.ended))
  })
  const first = await attachWindow(sock, 'DeepSeek Harness')
  windows.push(first)

  // The transcript grows while the first window is attached, and one of the
  // rows is long enough that a screen repaint and a row replay differ.
  const marker = `MARKER-${'x'.repeat(200)}`
  for (let index = 0; index < 12; index += 1) tui.rows.push({ kind: 'system', text: `line-${index}` })
  tui.rows.push({ kind: 'system', text: marker })
  await delay(120)

  const rowsBefore = fingerprint(tui.rows)
  const second = await attachWindow(sock, 'line-11')
  windows.push(second)
  const replaced = await first.ended
  assert.equal(replaced.reason, 'replaced')

  assert.equal(fingerprint(tui.rows), rowsBefore, 'the handover left the transcript alone')
  assert.equal(
    tui.rows.filter(row => String(row.text) === marker).length,
    1,
    'the long row exists exactly once: a repaint is not a replay',
  )

})

test('closing the display ends the relay without touching the transcript', { timeout: 30_000 }, async t => {
  const { tui, sock } = await withLiveTui(t)
  tui.rows.push({ kind: 'system', text: 'before-close' })
  const window = await attachWindow(sock, 'before-close')
  const before = fingerprint(tui.rows)

  // The TUI closes the Host it owns, which is what /exit does. The window goes
  // first: a Host with a live display waits for it to end.
  window.terminal.stdin.end()
  await window.ended
  await tui.dispose()
  const result = await window.ended
  // The window ended because its input ended; the Host then closed the display.
  assert.equal(['signal', 'goodbye', 'host-closed'].includes(result.reason), true, `relay ended: ${result.reason}`)
  await tui.dispose()
  assert.equal(fingerprint(tui.rows), before, 'closing a display does not rewrite the transcript')
})

/** One real Host used directly, to pin the wire-level expectation of a close. */
test('a directly closed host ends its relay and leaves no frame behind', { timeout: 30_000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-transcript-host-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const sock = sessionSockPath('main-session-transcript-host', home)
  if (!isPipePath(sock)) await mkdir(dirname(sock), { recursive: true, mode: 0o700 })
  let attached = 0
  const host = new DisplayHost(sock, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: () => {},
    onAttach: () => { attached += 1 },
  })
  await host.listen()
  // A bare Host paints nothing until someone sends it a frame, so the attach
  // callback is the arrival signal here.
  const window = openWindow(sock)
  await waitUntil(() => attached === 1, 'the relay to claim the display')
  await host.close()
  const result = await window.ended
  assert.equal(['goodbye', 'host-closed'].includes(result.reason), true, `relay ended on the host's terms: ${result.reason}`)
})
