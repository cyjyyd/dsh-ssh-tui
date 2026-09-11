import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  CURSOR_POSITION_REQUEST,
  TerminalInputFilter,
  TerminalInputGuard,
  TerminalInputPump,
  detectSshSession,
  stripCursorReplies,
} from '../lib/terminal-input.js'
import {
  DisplayHost,
  FRAME_GOODBYE,
  FRAME_HELLO,
  FRAME_REPLACED,
  FRAME_STDIN,
  FRAME_STDOUT,
  FrameReader,
  encodeFrame,
  isPipePath,
  runDisplayRelay,
  sessionSockPath,
} from '../lib/display-sock.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A TTY-shaped stdin: `read()` and `data` events, like the real thing. */
function fakeStdin() {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  return stdin
}

function fakeStdout() {
  const stdout = {
    isTTY: true,
    columns: 100,
    rows: 30,
    text: '',
    write(chunk) {
      stdout.text += String(chunk)
      return true
    },
    on() {},
    off() {},
    removeListener() {},
  }
  return stdout
}

/**
 * A terminal that answers CSI 6n after `replyDelayMs`. `onRequest` runs as the
 * request is written, which is where a test injects a reply that was already
 * in flight (a previous launcher's probe) or a keystroke.
 */
function scriptedTerminal({ replyDelayMs, onRequest } = {}) {
  const stdin = fakeStdin()
  const stdout = fakeStdout()
  let requests = 0
  stdout.write = chunk => {
    const text = String(chunk)
    stdout.text += text
    if (text.includes(CURSOR_POSITION_REQUEST)) {
      requests += 1
      onRequest?.(requests, stdin)
      if (replyDelayMs !== undefined) {
        setTimeout(() => stdin.write('\x1b[17;1R'), replyDelayMs)
      }
    }
    return true
  }
  return { stdin, stdout, requests: () => requests }
}

test('the input filter removes cursor replies wherever they appear', () => {
  const filter = new TerminalInputFilter()
  assert.deepEqual(filter.push('\x1b[17;1R'), { forward: '', replies: 1 })
  assert.deepEqual(filter.push('a\x1b[17;1Rb'), { forward: 'ab', replies: 1 })
  // DECXCPR (`CSI ? row;col R`) is a reply too.
  assert.deepEqual(filter.push('\x1b[?4;9R'), { forward: '', replies: 1 })
  assert.deepEqual(filter.push('hi'), { forward: 'hi', replies: 0 })
})

// The slow-SSH split: ESC arrives in one read and the digits in the next. The
// old escape handling saw the digits as typing and the prompt showed `17;1R`.
test('a reply split across reads never becomes visible text', () => {
  const filter = new TerminalInputFilter()
  assert.deepEqual(filter.push('\x1b'), { forward: '', replies: 0 })
  assert.deepEqual(filter.push('[17;1R'), { forward: '', replies: 1 })
  assert.deepEqual(filter.push('ok\x1b[1'), { forward: 'ok', replies: 0 })
  assert.equal(filter.pending, true)
  assert.deepEqual(filter.push('2;34R!'), { forward: '!', replies: 1 })
})

test('the filter holds a partial reply but releases it as typing', () => {
  const filter = new TerminalInputFilter()
  // `ESC [ A` is an arrow key, not a reply: it must pass straight through.
  assert.deepEqual(filter.push('\x1b[A'), { forward: '\x1b[A', replies: 0 })
  assert.equal(filter.pending, false)
  // A half-arrived escape is held, then handed over when the window passes.
  assert.deepEqual(filter.push('\x1b[1'), { forward: '', replies: 0 })
  assert.equal(filter.pending, true)
  assert.equal(filter.flush(), '\x1b[1')
  assert.equal(filter.pending, false)
})

test('stripCursorReplies reports what it removed', () => {
  assert.deepEqual(stripCursorReplies('x\x1b[1;2Ry'), { text: 'xy', replies: 1 })
  assert.deepEqual(stripCursorReplies('plain'), { text: 'plain', replies: 0 })
})

// The probe used to accept the first reply it saw, whatever it answered. An
// answer already in flight came back in ~2 ms — and the *real* answer to this
// request then landed in the prompt as `[17;1R`.
test('an SSH probe ignores a reply that was already in flight', async () => {
  const terminal = scriptedTerminal({ replyDelayMs: 30 })
  const typed = []
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: text => typed.push(text),
  })
  // A dead launcher's answer, still queued when this relay starts.
  terminal.stdin.write('\x1b[17;1R')
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.ok(rtt !== undefined && rtt >= 20, `expected the real round-trip, got ${String(rtt)}`)
  assert.deepEqual(typed, [], 'a probe answer must never be delivered as typing')
})

// An answer that arrives *during* our window, not before it. It used to be
// accepted as the measurement (~2 ms) while the honest answer was still on its
// way; the next request must therefore wait for the line to go quiet.
test('an answer that arrives mid-window does not shorten the next sample', async () => {
  const terminal = scriptedTerminal({
    replyDelayMs: 55,
    onRequest: (count, stdin) => {
      if (count === 1) setTimeout(() => stdin.write('\x1b[17;1R'), 10)
    },
  })
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: () => {},
  })
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.ok(rtt !== undefined && rtt >= 30, `expected the 55ms link, got ${String(rtt)}ms`)
})

// A request queued behind a full-screen repaint reported the repaint
// (1900 ms on a 50 ms link). The first answer must be allowed to be late
// without deciding the result.
test('a first answer stuck behind a repaint does not become the measurement', async () => {
  const terminal = scriptedTerminal({
    replyDelayMs: 45,
    onRequest: (count, stdin) => {
      if (count === 1) {
        // Override the 45ms answer with a late one for the first request only.
        setTimeout(() => stdin.write('\x1b[17;1R'), 600)
      }
    },
  })
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: () => {},
    sampleTimeoutMs: 700,
    budgetMs: 3_000,
  })
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.ok(rtt !== undefined && rtt < 200, `expected the 45ms link, got ${String(rtt)}ms`)
})

// The reply to the last request, a duplicate, or one from a launcher that died
// mid-probe arrives *after* the measurement is over. It must be swallowed for
// as long as the attachment lasts, not forwarded to the Host.
test('a late reply after the probe is dropped, not typed into the prompt', async () => {
  const terminal = scriptedTerminal({ replyDelayMs: 15 })
  const typed = []
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: text => typed.push(text),
  })
  pump.start()
  await pump.measure()
  terminal.stdin.write('\x1b[41;7R')
  terminal.stdin.write('\x1b[42;8R')
  await delay(30)
  pump.stop()
  assert.deepEqual(typed, [])
})

test('typing during the probe is kept and delivered', async () => {
  const terminal = scriptedTerminal({
    replyDelayMs: 20,
    onRequest: (count, stdin) => {
      if (count === 1) stdin.write('ls\r')
      if (count === 2) stdin.write('\x1b[5;9R')
    },
  })
  const typed = []
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: text => typed.push(text),
  })
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.ok(rtt !== undefined)
  assert.equal(typed.join(''), 'ls\r')
})

// Several answers from a dead launcher at once: the median and the relative
// outlier filter still have to land on the link, not on the leftovers.
test('a burst of stale answers does not move the measurement', async () => {
  const terminal = scriptedTerminal({
    replyDelayMs: 55,
    onRequest: (count, stdin) => {
      if (count !== 1) return
      for (const offset of [3, 4, 5, 6, 7, 8]) {
        setTimeout(() => stdin.write('\x1b[17;1R'), offset)
      }
    },
  })
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: () => {},
  })
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.ok(rtt !== undefined && rtt >= 30, `expected the 55ms link, got ${String(rtt)}ms`)
})

// `ssh localhost` answers in about 2 ms. The old absolute "below 5 ms is a
// stale reply" floor reported "unknown" for the whole session there.
test('an honest fast SSH link is still measured', async () => {
  const terminal = scriptedTerminal({ replyDelayMs: 2 })
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: () => {},
  })
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.ok(rtt !== undefined && rtt < 20, `expected the 2ms link, got ${String(rtt)}ms`)
})

// Queued bytes are consumed exactly once. `read()` re-emits `data` for the
// chunk it returns, so a drain that used it while the listener was attached
// delivered a typed `hi` to the Host twice.
test('queued typing is delivered once, not twice', async () => {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  stdin.write('hi')
  stdin.pause()
  const stdout = { isTTY: true, columns: 100, rows: 30, write: () => true, on() {}, off() {}, removeListener() {} }
  const typed = []
  const pump = new TerminalInputPump({
    stdin,
    stdout,
    ssh: false,
    onInput: text => typed.push(text),
    sampleTimeoutMs: 20,
  })
  pump.start()
  await pump.measure()
  pump.stop()
  assert.equal(typed.join(''), 'hi', 'one keystroke burst must not be doubled')
  stdin.destroy()
})

// A lone Escape is typing. The filter holds a half-arrived reply briefly, so
// this is also the test that the hold is released and not swallowed forever.
test('a lone escape is released after the hold', async () => {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  const stdout = { isTTY: true, columns: 100, rows: 30, write: () => true, on() {}, off() {}, removeListener() {} }
  const typed = []
  const pump = new TerminalInputPump({
    stdin,
    stdout,
    ssh: false,
    onInput: text => typed.push(text),
    holdMs: 20,
    sampleTimeoutMs: 20,
  })
  pump.start()
  stdin.write('\x1b')
  await delay(60)
  pump.stop()
  assert.equal(typed.join(''), '\x1b', 'the escape key must reach the Host')
  stdin.destroy()
})

test('a terminal that never answers reports unknown, not 0 ms', async () => {
  const terminal = scriptedTerminal({})
  const pump = new TerminalInputPump({
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    ssh: true,
    onInput: () => {},
    sampleTimeoutMs: 20,
  })
  pump.start()
  const rtt = await pump.measure()
  pump.stop()
  assert.equal(rtt, undefined)
  assert.equal(terminal.requests(), 2, 'two silent windows are enough to give up')
})

test('detectSshSession reads the sshd environment', () => {
  assert.equal(detectSshSession({ SSH_CONNECTION: 'a b c d' }), true)
  assert.equal(detectSshSession({ SSH_TTY: '/dev/pts/0' }), true)
  assert.equal(detectSshSession({}), false)
})

// The TUI and the picker turn bytes into keystrokes; a leaked reply there is a
// `[17;1R` typed into the prompt (or a query nobody wrote in the picker).
test('a guard gives the key handler typing only', async () => {
  const typed = []
  const guard = new TerminalInputGuard(text => typed.push(text), 20)
  guard.push('a\x1b[17;1Rb')
  assert.deepEqual(typed, ['ab'], 'the reply is removed from the middle')
  guard.push('\x1b[1')                     // half-arrived reply
  assert.deepEqual(typed, ['ab'], 'a partial reply is held, not typed')
  guard.release()
  assert.deepEqual(typed, ['ab', '\x1b[1'], 'and released as typing when its window passes')
  guard.push('\x1b')
  await delay(40)
  assert.deepEqual(typed, ['ab', '\x1b[1', '\x1b'], 'the hold timer releases it by itself')
  guard.stop()
})

async function listenOn(t, sessionId) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-term-'))
  const path = sessionSockPath(sessionId, home)
  // Pipes need no directory; a socket file needs the state directory first.
  if (!isPipePath(path)) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  t.after(async () => {
    await rm(home, { recursive: true, force: true })
  })
  return { home, path }
}

/** Collect stdin frames and answer the handshake like a real Host. */
function fakeHost(server, onFrame, t) {
  const state = { sawHello: false, stdin: [], socket: undefined }
  const open = new Set()
  // A real Host hangs up every connection when it exits; a fake one that leaves
  // its sockets open keeps the test process (and so `npm test`) alive after the
  // last assertion — `server.close()` alone waits for open sockets forever.
  t?.after(() => {
    for (const socket of open) socket.destroy()
  })
  server.on('connection', socket => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
    const reader = new FrameReader()
    socket.on('data', chunk => {
      let frames
      try {
        frames = reader.push(chunk)
      } catch {
        return
      }
      for (const frame of frames) {
        if (frame.type === FRAME_HELLO) {
          state.sawHello = true
          state.socket = socket
        } else if (frame.type === FRAME_STDIN) {
          state.stdin.push(frame.payload.toString())
        }
        onFrame?.(frame, socket, state)
      }
    })
  })
  return state
}

test('the relay filters replies end to end and never loses a keystroke', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'relay-filter')
  const server = createServer(() => {})
  const host = fakeHost(server, undefined, t)
  await new Promise(resolve => server.listen(path, resolve))
  t.after(() => server.close())

  const terminal = scriptedTerminal({
    replyDelayMs: 25,
    onRequest: (count, stdin) => {
      if (count === 1) stdin.write('\x1b[17;1R')
      if (count === 2) stdin.write('ls\r')
    },
  })
  const relay = runDisplayRelay(path, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: true,
  })
  for (let wait = 0; wait < 300 && !host.sawHello; wait += 1) await delay(10)
  assert.equal(host.sawHello, true, 'the relay must hand over with a HELLO')
  terminal.stdin.write('\x1b[41;7R')       // a reply that outlived the probe
  // Poll instead of sleeping a fixed amount: a loaded machine can deliver late.
  for (let wait = 0; wait < 300 && !host.stdin.includes('ls\r'); wait += 1) await delay(10)
  assert.deepEqual(host.stdin, ['ls\r'], 'only real typing reaches the Host')
  host.socket.write(encodeFrame(FRAME_GOODBYE))
  const result = await relay
  assert.equal(result.reason, 'goodbye')
})

// A relay that has to capture typing before it exists: the launcher keeps what
// is typed while a fresh Host boots and hands it over as the relay's seed.
test('typing captured before the relay existed reaches the Host', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'relay-seed')
  const server = createServer(() => {})
  const host = fakeHost(server, undefined, t)
  await new Promise(resolve => server.listen(path, resolve))
  t.after(() => server.close())
  const terminal = scriptedTerminal({ replyDelayMs: 5 })
  const relay = runDisplayRelay(path, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: true,
    seed: 'early',
  })
  for (let wait = 0; wait < 300 && !host.sawHello; wait += 1) await delay(10)
  for (let wait = 0; wait < 300 && !host.stdin.includes('early'); wait += 1) await delay(10)
  assert.deepEqual(host.stdin, ['early'], 'the captured burst is delivered once, after HELLO')
  host.socket.write(encodeFrame(FRAME_GOODBYE))
  assert.equal((await relay).reason, 'goodbye')
})

test('a replaced relay reports it instead of re-attaching', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'relay-replaced')
  const server = createServer(() => {})
  const host = fakeHost(server, (frame, socket) => {
    if (frame.type === FRAME_HELLO) socket.write(encodeFrame(FRAME_REPLACED))
  }, t)
  await new Promise(resolve => server.listen(path, resolve))
  t.after(() => server.close())
  const terminal = scriptedTerminal({ replyDelayMs: 5 })
  const result = await runDisplayRelay(path, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: false,
  })
  assert.equal(result.reason, 'replaced')
  assert.equal(host.sawHello, true)
  // …and it hangs up. A relay that returns while its socket is still open keeps
  // the launcher's event loop alive after the last frame (the `npm test` hang
  // this assertion was born from), even though it must not write a byte.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the replaced relay left its display link open')), 1_000)
    host.socket.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
  })
})

// The kicked window's link is usually the dead one (that is why the user is
// resuming in another window), so anything it writes sits in that connection
// and is flushed onto the terminal when the link comes back: the user sees
// escape bytes and "taken over by another terminal" over the top of the new
// session. A replaced relay must therefore write nothing at all.
// The launcher prints "attaching…" while it waits for a live Host; the relay
// erases that line right before the Host's first paint, so the picker's screen
// does not sit frozen for the whole measurement.
test('an announced relay erases the status line before the first paint', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'relay-announce')
  const server = createServer(() => {})
  const host = fakeHost(server, (frame, socket) => {
    if (frame.type === FRAME_HELLO) socket.write(encodeFrame(FRAME_GOODBYE))
  }, t)
  await new Promise(resolve => server.listen(path, resolve))
  t.after(() => server.close())
  const terminal = scriptedTerminal({ replyDelayMs: 5 })
  const result = await runDisplayRelay(path, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: false,
    announce: true,
  })
  assert.equal(result.reason, 'goodbye')
  assert.equal(terminal.stdout.text.includes('\r\x1b[2K'), true, 'the waiting line is erased')
})

test('a replaced relay leaves its terminal untouched', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'relay-replaced-silent')
  const server = createServer(() => {})
  const host = fakeHost(server, (frame, socket) => {
    if (frame.type === FRAME_HELLO) socket.write(encodeFrame(FRAME_REPLACED))
  }, t)
  await new Promise(resolve => server.listen(path, resolve))
  t.after(() => server.close())
  const terminal = scriptedTerminal({ replyDelayMs: 5 })
  const result = await runDisplayRelay(path, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: false,
  })
  assert.equal(result.reason, 'replaced')
  const written = terminal.stdout.text
  assert.equal(written.includes('\x1b[?1049l'), false, 'no alt-screen exit on a replaced relay')
  assert.equal(written.includes('\x1b[2J'), false, 'no screen clear on a replaced relay')
  assert.equal(written.includes('\x1b[?1000l'), false, 'no mouse-mode reset on a replaced relay')
})

// Two SSH windows on one session used to kick each other off the display in a
// loop: the loser saw a bare `close`, reported `host-closed`, and re-attached.
test('a newer Display is told it replaced the old one', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'host-replaced')
  const detaches = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: info => detaches.push(info ?? {}),
    onAttach: () => {},
  })
  await host.listen()
  t.after(() => host.close())

  const first = createConnection(path)
  await new Promise((resolve, reject) => {
    first.once('connect', resolve)
    first.once('error', reject)
  })
  const firstFrames = []
  const firstReader = new FrameReader()
  first.on('data', chunk => { firstFrames.push(...firstReader.push(chunk)) })
  first.write(encodeFrame(FRAME_HELLO))
  await delay(50)
  assert.equal(host.attached, true)

  const second = createConnection(path)
  await new Promise((resolve, reject) => {
    second.once('connect', resolve)
    second.once('error', reject)
  })
  second.write(encodeFrame(FRAME_HELLO))
  await delay(80)

  assert.equal(firstFrames.some(frame => frame.type === FRAME_REPLACED), true,
    'the kicked relay must learn why it was dropped')
  assert.equal(firstFrames.some(frame => frame.type === FRAME_HELLO), true)
  assert.equal(host.attached, true, 'the new Display owns the session')
  assert.equal(detaches.length, 1)
  assert.equal(detaches[0].replaced, true, 'a replacement is not an SSH hangup')
  // And the Host keeps painting to the new relay.
  assert.equal(host.sendStdout(Buffer.from('frame')), true)
  const painted = []
  const secondReader = new FrameReader()
  second.on('data', chunk => { painted.push(...secondReader.push(chunk)) })
  await delay(30)
  assert.equal(painted.some(frame => frame.type === FRAME_STDOUT), true)
  // A replaced socket's `close` must not be read as the *new* display leaving.
  first.destroy()
  await delay(60)
  assert.equal(detaches.length, 1, 'the replaced socket cannot detach its successor')
  assert.equal(host.attached, true)
  assert.equal(host.sendStdout(Buffer.from('still here')), true)
  second.destroy()
})

// The relay measures before HELLO, so a slow link can keep a connection silent
// for over a second; the Host must still let it claim the display.
test('a late HELLO still claims the display', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'host-late-hello')
  const attaches = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: () => {},
    onAttach: () => { attaches.push(1) },
  }, { helloGraceMs: 2_000 })
  await host.listen()
  t.after(() => host.close())
  const client = createConnection(path)
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  await delay(700)                       // longer than the old 400 ms grace
  assert.deepEqual(attaches, [], 'silence alone must not claim the display')
  client.write(encodeFrame(FRAME_HELLO))
  await delay(80)
  assert.deepEqual(attaches, [1], 'the late HELLO still claims it')
  assert.equal(host.attached, true)
  client.destroy()
})

test('a silent connection is dropped without claiming the display', { timeout: 10_000 }, async t => {
  const { path } = await listenOn(t, 'host-silent-probe')
  const attaches = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: () => {},
    onAttach: () => { attaches.push(1) },
  }, { helloGraceMs: 60 })
  await host.listen()
  t.after(() => host.close())
  const client = createConnection(path)
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  await delay(200)
  assert.deepEqual(attaches, [])
  assert.equal(host.attached, false)
  client.destroy()
})
