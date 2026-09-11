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
    listSessions: async (_persistence, _current, { onUpdate }) => {
      onUpdate({ sessions, pending: false })
      return { sessions, pending: false, complete: sessions }
    },
  }
}

const SESSIONS = [
  { id: 'main-session-aaaa', label: '修复绘制残留', updatedAt: 3, cwd: '/root/a' },
  { id: 'main-session-bbbb', label: '写兼容护栏', updatedAt: 2, cwd: '/root/b' },
]

test('a cancelled picker gives the alternate screen back with the transcript intact', async () => {
  const io = pickerStreams(60, 12)
  const { ctx, listSessions } = listingContext(SESSIONS)
  const settled = showSessionPicker(ctx, false, undefined, { ...io, listSessions })
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

test('a resize while the picker is live repaints one clean frame, not a stack', async () => {
  const io = pickerStreams(60, 12)
  const { ctx, listSessions } = listingContext(SESSIONS)
  const abort = new AbortController()
  const settled = showSessionPicker(ctx, false, abort.signal, { ...io, listSessions })
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
