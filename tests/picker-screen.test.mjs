/**
 * Screen-level guardrail for the launch picker.
 *
 * The picker borrows the terminal the TUI is about to use: it paints over the
 * alternate screen, and a frame left behind (or an alternate screen never given
 * back) is the "history picker flashes over my session" bug. Byte assertions
 * cannot see that; these replay the picker's real output into a terminal grid.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { showSessionPicker } from '../lib/picker.js'
import { screen } from './screen.mjs'
import { terminalCapabilities } from '../lib/terminal-caps.js'

/** A terminal with every capability, so a test asserts the full sequence set
 *  instead of inheriting whatever TERM the runner happens to have. */
const fullTerminal = () => terminalCapabilities({ env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }, platform: 'linux' })


const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu

function pickerStreams(cols = 60, rows = 12) {
  const writes = []
  const listeners = new Map()
  const stdout = {
    columns: cols,
    rows,
    write: (chunk) => { writes.push(String(chunk)); return true },
    on: (event, handler) => { listeners.set(event, [...(listeners.get(event) ?? []), handler]) },
    removeListener: (event, handler) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(entry => entry !== handler))
    },
    emit: (event) => { for (const handler of listeners.get(event) ?? []) handler() },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  }
  const stdinHandlers = []
  const stdin = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    on: (event, handler) => { if (event === 'data') stdinHandlers.push(handler) },
    removeListener: (event, handler) => {
      const at = stdinHandlers.indexOf(handler)
      if (event === 'data' && at >= 0) stdinHandlers.splice(at, 1)
    },
  }
  const type = (text) => { for (const handler of [...stdinHandlers]) handler(Buffer.from(text)) }
  return { stdout, stdin, writes, type, listeners }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(predicate, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`timed out waiting for ${label}`)
}

function listingContext(sessions) {
  return {
    ctx: { get: (key) => key === 'sessionPersistence' ? {} : undefined },
    // One steady page, like the real pager's first read.
    openPager: async () => ({
      page: async () => ({ sessions, remaining: 0, done: true }),
      complete: async () => sessions,
    }),
  }
}

const SESSIONS = [
  { id: 'main-session-aaaa', label: '修复绘制残留', updatedAt: 3, cwd: '/root/a' },
  { id: 'main-session-bbbb', label: '写兼容护栏', updatedAt: 2, cwd: '/root/b' },
]

test('a cancelled picker gives the alternate screen back with the transcript intact', async () => {
  const io = pickerStreams(60, 12)
  const { ctx, openPager } = listingContext(SESSIONS)
  // The picker's screen ownership is what is under test, so the terminal is
  // declared rather than taken from the runner's environment.
  const settled = showSessionPicker(ctx, false, undefined, { ...io, openPager, terminalCaps: fullTerminal() })
  await waitFor(() => io.writes.join('').includes('修复绘制残留'), 'the first listing')
  io.type('\x1b')                       // Esc: cancel (the 60 ms hold releases it)
  assert.equal(await settled, null)

  // The TUI was already on screen when the picker started; it must come back.
  const term = screen(60, 12)
  await term.write('live transcript line\r\n> prompt')
  const leaveAt = io.writes.findIndex(write => write.includes('\x1b[?1049l'))
  assert.equal(leaveAt > 0, true, 'the picker switches to the alternate screen and leaves it again')
  for (const write of io.writes.slice(0, leaveAt)) await term.write(write)
  assert.equal(term.bufferType, 'alternate', 'the picker owns the alternate screen')
  const picked = term.grid().join('\n')
  assert.match(picked, /修复绘制残留/u, 'the list is painted')
  assert.equal(picked.includes('live transcript line'), false, 'the transcript is not under the picker')

  for (const write of io.writes.slice(leaveAt)) await term.write(write)
  assert.equal(term.bufferType, 'normal', 'the picker hands the normal screen back')
  assert.match(term.grid().join('\n'), /live transcript line/u, 'and nothing erased it')

  // A settled picker must stay settled: the launcher keeps this TTY as the
  // display relay, so a late resize must not repaint the dead picker.
  const painted = io.writes.length
  io.stdout.emit('resize')
  io.stdout.emit('resize')
  assert.equal(io.writes.length, painted, 'a settled picker paints nothing')
})

test('a session a window holds is painted as attached, and Enter asks before taking it over', async () => {
  const io = pickerStreams(72, 14)
  const rows = [
    { id: 'main-session-live', label: '窗口里的会话', updatedAt: 4, cwd: '/root/live', attach: { pid: 4242, sock: '/root/.dsh/tui-socks/live.sock', state: 'attached' } },
    { id: 'main-session-left', label: '断线留下的会话', updatedAt: 3, cwd: '/root/left', attach: { pid: 7, sock: '/root/.dsh/tui-socks/left.sock', state: 'paused' } },
  ]
  const { ctx, openPager } = listingContext(rows)
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager, terminalCaps: fullTerminal() })
  await waitFor(() => io.writes.join('').includes('窗口里的会话'), 'the first listing')

  // Replay everything the picker wrote onto a grid: this is what the user sees,
  // and the whole bug was the *word* on that line.
  const painted = async () => {
    const term = screen(72, 14)
    for (const write of io.writes) await term.write(write)
    return term.grid().join('\n').replace(ANSI, '')
  }
  const first = await painted()
  assert.match(first, /已接入 · pid 4242/u, 'a session with a live relay says so')
  assert.match(first, /可接入 · pid 7 · 已暂停/u, 'a Host left by a dropped link keeps the drop wording')

  // Enter on that row must not attach: it asks, on the same screen, and the
  // picker stays open.
  io.type('\r')
  await waitFor(() => io.writes.length > 2, 'the confirmation frame')
  const asking = await painted()
  assert.match(asking, /已被 pid 4242 接入/u)
  assert.match(asking, /按 y \/ Enter 接管/u)
  assert.match(asking, /窗口里的会话/u, 'the list is still there')

  // Any other key cancels and leaves that window alone.
  io.type('n')
  await waitFor(() => !io.writes.at(-1).includes('按 y'), 'the cancelled frame')
  const cancelled = await painted()
  assert.equal(/按 y \/ Enter 接管/u.test(cancelled), false, 'the question is cleared off the screen')
  assert.match(cancelled, /已接入 · pid 4242/u, 'and the list is back')

  // `y` confirms: the picker settles with the attach the takeover needs.
  io.type('\r')
  await waitFor(() => io.writes.at(-1).includes('按 y'), 'the question again')
  io.type('y')
  assert.deepEqual(await settled, { kind: 'attach', id: 'main-session-live', sock: '/root/.dsh/tui-socks/live.sock' })
})

test('a resize while the picker is live repaints one clean frame, not a stack', async () => {
  const io = pickerStreams(60, 12)
  const { ctx, openPager } = listingContext(SESSIONS)
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })
  await waitFor(() => io.writes.join('').includes('修复绘制残留'), 'the first listing')

  const before = io.writes.length
  io.stdout.emit('resize')
  await waitFor(() => io.writes.length > before, 'the resize repaint')
  abort.abort()
  await settled

  const term = screen(60, 12)
  await term.write('live transcript line\r\n> prompt')
  const leaveAt = io.writes.findIndex(write => write.includes('\x1b[?1049l'))
  for (const write of io.writes.slice(0, leaveAt)) await term.write(write)
  const painted = term.grid().join('\n').replace(ANSI, '')
  for (const label of ['修复绘制残留', '写兼容护栏']) {
    const seen = painted.split(label).length - 1
    assert.equal(seen, 1, `${label} must appear exactly once on the repainted screen`)
  }
  assert.equal(painted.includes('live transcript line'), false, 'the picker still owns the screen')
})

// The user-visible half of the lazy read: while the first page is being read
// the screen shows the loading line and nothing else — no session whose title
// is still an id — and the page then lands in one frame with the sessions it
// could not show yet counted below.
test('the first screen waits for real titles and shows what is left to read', async () => {
  const io = pickerStreams(60, 12)
  const page = [
    { id: 'main-session-aaaa', label: '修复绘制残留', updatedAt: 3, cwd: '/root/a' },
    { id: 'main-session-bbbb', label: '写兼容护栏', updatedAt: 2, cwd: '/root/b' },
  ]
  let release = () => {}
  const gate = new Promise(resolve => { release = resolve })
  let firstCall = true
  const openPager = async () => ({
    page: async () => {
      if (firstCall) {
        firstCall = false
        await gate
      }
      return { sessions: page, remaining: 7, done: false }
    },
    complete: async () => page,
  })
  const ctx = { get: (key) => key === 'sessionPersistence' ? {} : undefined }
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, openPager })

  const loading = screen(60, 12)
  await loading.write('live transcript line\r\n> prompt')
  for (const write of io.writes) await loading.write(write)
  const pendingScreen = loading.grid().join('\n')
  assert.match(pendingScreen, /正在读取历史会话/u, 'the loading line is up')
  assert.equal(pendingScreen.includes('修复绘制残留'), false, 'no session before its title is known')
  assert.equal(pendingScreen.includes('main-session-aaaa'), false, 'and never a raw id')

  release()
  await new Promise(resolve => setTimeout(resolve, 20))
  const steady = screen(60, 12)
  await steady.write('live transcript line\r\n> prompt')
  for (const write of io.writes) await steady.write(write)
  const painted = steady.grid().join('\n')
  assert.match(painted, /修复绘制残留/u, 'the steady page is painted')
  assert.match(painted, /写兼容护栏/u)
  assert.match(painted, /还有 7 条未加载/u, 'and the user is told what is not loaded yet')
  assert.match(painted, /继续加载更早的会话/u, 'with the key that reads it')
  assert.equal(io.stdout.listenerCount('resize'), 1, 'the picker is still live')

  abort.abort()
  await settled
})
