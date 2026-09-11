import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createConnection, createServer } from 'node:net'
import {
  detachFromSshSession,
  DisplayHost,
  displaySockExists,
  FRAME_HELLO,
  FRAME_STDIN,
  FRAME_STDOUT,
  FRAME_RESIZE,
  FrameReader,
  decodeResize,
  encodeFrame,
  encodeResize,
  encodeRtt,
  decodeRtt,
  FRAME_RTT,
  hostArgvForSession,
  isPipePath,
  probeDisplaySock,
  sessionErrPath,
  sessionSockPath,
  waitForDisplaySock,
} from '../lib/display-sock.js'
import { parseSessionLock } from '../lib/session-lock.js'

test('encode/decode frames round-trip stdin and resize', () => {
  const reader = new FrameReader()
  const blob = Buffer.concat([
    encodeFrame(FRAME_STDIN, Buffer.from('abc')),
    encodeResize(120, 40),
    encodeFrame(FRAME_HELLO),
  ])
  const frames = reader.push(blob)
  assert.equal(frames.length, 3)
  assert.equal(frames[0].type, FRAME_STDIN)
  assert.equal(frames[0].payload.toString(), 'abc')
  assert.equal(frames[1].type, FRAME_RESIZE)
  assert.deepEqual(decodeResize(frames[1].payload), { columns: 120, rows: 40 })
  assert.equal(frames[2].type, FRAME_HELLO)
})

test('encode/decode rtt frames', () => {
  const reader = new FrameReader()
  const frames = reader.push(Buffer.concat([
    encodeRtt(90),
    encodeRtt(undefined),
  ]))
  assert.equal(frames[0].type, FRAME_RTT)
  assert.equal(decodeRtt(frames[0].payload), 90)
  assert.equal(decodeRtt(frames[1].payload), undefined)
})

test('FrameReader buffers a split header', () => {
  const reader = new FrameReader()
  const full = encodeFrame(FRAME_STDOUT, Buffer.from('hi'))
  assert.deepEqual(reader.push(full.subarray(0, 3)), [])
  const rest = reader.push(full.subarray(3))
  assert.equal(rest.length, 1)
  assert.equal(rest[0].payload.toString(), 'hi')
})

test('detachFromSshSession replaces launcher SIGTERM with an ignore handler', () => {
  const launcher = []
  const previous = process.listeners('SIGTERM').slice()
  const launcherFn = () => { launcher.push('launcher') }
  process.removeAllListeners('SIGTERM')
  process.on('SIGTERM', launcherFn)
  try {
    detachFromSshSession()
    assert.equal(process.listeners('SIGTERM').includes(launcherFn), false)
    process.emit('SIGTERM')
    assert.deepEqual(launcher, [])
  } finally {
    process.removeAllListeners('SIGTERM')
    for (const fn of previous) process.on('SIGTERM', fn)
  }
})

test('hostArgvForSession pins --resume=id and drops picker flags', () => {
  const argv = hostArgvForSession('sid-1', ['/usr/lib/node/dsh', '--profile', 'tui', '--resume'], [])
  assert.equal(argv.includes('--resume'), false)
  assert.ok(argv.includes('--resume=sid-1'))
  const withId = hostArgvForSession('sid-2', ['dsh', '--profile', 'tui', 'resume', 'old'], [])
  assert.equal(withId.includes('resume'), false)
  assert.equal(withId.includes('old'), false)
  assert.ok(withId.includes('--resume=sid-2'))
})

test('sessionSockPath sanitizes ids next to the lock dir', () => {
  assert.equal(
    sessionSockPath('main-session/../evil id', '/tmp/dsh-home', 'linux'),
    join('/tmp/dsh-home', 'tui-socks', 'main-session_.._evil_id.sock'),
  )
})

test('sessionSockPath uses a named pipe on win32', () => {
  const path = sessionSockPath('main-session/../evil id', 'C:\\Users\\me\\.dsh', 'win32')
  // Node only accepts \\.\pipe\... on Windows; a drive-letter path fails to bind.
  assert.ok(isPipePath(path), path)
  assert.ok(path.startsWith('\\\\.\\pipe\\dsh-tui-'), path)
  assert.ok(!path.includes('/'), 'pipe names are backslash-only')
  assert.ok(!path.includes('..'), 'no parent-directory sequence in the flat pipe namespace')
  assert.ok(path.length <= 200, `pipe name too long: ${path.length}`)
  // Two DSH_HOMEs, or two sessions, must never share one machine-wide pipe.
  assert.notEqual(path, sessionSockPath('main-session/../evil id', 'C:\\other\\.dsh', 'win32'))
  assert.notEqual(path, sessionSockPath('other-session', 'C:\\Users\\me\\.dsh', 'win32'))
  // Host and relay are separate processes: the name must be deterministic.
  assert.equal(path, sessionSockPath('main-session/../evil id', 'C:\\Users\\me\\.dsh', 'win32'))
})

test('sessionSockPath keeps long ids in-limit and distinct on win32', () => {
  const long = 'x'.repeat(400)
  const a = sessionSockPath(`${long}-a`, 'C:\\home\\.dsh', 'win32')
  const b = sessionSockPath(`${long}-b`, 'C:\\home\\.dsh', 'win32')
  assert.ok(a.length <= 200, `pipe name too long: ${a.length}`)
  assert.ok(b.length <= 200, `pipe name too long: ${b.length}`)
  assert.notEqual(a, b, 'truncation must not collapse distinct sessions')
})

test('isPipePath recognizes Windows pipe spellings only', () => {
  assert.equal(isPipePath('\\\\.\\pipe\\dsh-tui-x'), true)
  assert.equal(isPipePath('//./pipe/dsh-tui-x'), true)
  assert.equal(isPipePath('\\\\?\\pipe\\dsh-tui-x'), true)
  assert.equal(isPipePath(join(tmpdir(), 'tui-socks', 'x.sock')), false)
  assert.equal(isPipePath('/tmp/tui-socks/x.sock'), false)
})

// On Windows fs.access() is what used to make startup time out: it returns
// ENOENT for a live pipe. A pipe-shaped path must therefore be probed with a
// connect, never treated as a file — a plain file that merely looks like a pipe
// must not count as a ready channel.
test('displaySockExists connect-probes pipe-shaped paths', { skip: process.platform === 'win32' }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const cwd = process.cwd()
  process.chdir(home)
  try {
    const pipeish = '\\\\.\\pipe\\dsh-tui-fake'
    await writeFile(pipeish, '')
    assert.equal(await displaySockExists(pipeish), false, 'a regular file is not a listening pipe')
  } finally {
    process.chdir(cwd)
    await rm(home, { recursive: true, force: true })
  }
})

test('sessionErrPath is a real file on both platforms', () => {
  // POSIX keeps the historical <sock>.err next to the socket.
  assert.equal(
    sessionErrPath('s', '/tmp/dsh-home', 'linux'),
    `${sessionSockPath('s', '/tmp/dsh-home', 'linux')}.err`,
  )
  const win = sessionErrPath('s', 'C:\\home\\.dsh', 'win32')
  assert.equal(win.startsWith(join('C:\\home\\.dsh', 'tui-socks')), true, win)
  assert.match(win, /s-[0-9a-f]{8}\.err$/u)
  assert.equal(isPipePath(win), false, 'host stderr cannot be captured into a pipe name')
  // A long id stays inside the Windows path budget, and the digest keeps the
  // file from becoming a reserved device name.
  const long = sessionErrPath('x'.repeat(400), 'C:\\home\\.dsh', 'win32')
  assert.ok(long.length < 120, `${long.length}: ${long}`)
  assert.match(sessionErrPath('CON', 'C:\\home\\.dsh', 'win32'), /CON-[0-9a-f]{8}\.err$/u)
})

test('waitForDisplaySock fails fast when the host exits first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const sock = sessionSockPath('exit-watch', home)
  const errFile = sessionErrPath('exit-watch', home)
  await mkdir(dirname(errFile), { recursive: true })
  await writeFile(errFile, 'host boom\n')
  const exitWatch = { exited: Promise.resolve(3), dispose: () => {} }
  const started = Date.now()
  await assert.rejects(
    () => waitForDisplaySock(sock, 5_000, process.pid, errFile, exitWatch),
    error => error instanceof Error
      && error.message.includes('exited before display socket appeared')
      && error.message.includes('exit code 3')
      && error.message.includes('host boom'),
  )
  assert.ok(Date.now() - started < 3_000, 'a dead host must not burn the whole timeout')
  await rm(home, { recursive: true, force: true })
})

test('waitForDisplaySock sees a listening host, including over a win32 pipe', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  // sessionSockPath resolves to a named pipe on Windows: this asserts that the
  // readiness check is a connect probe there, not fs.access (which never sees
  // a pipe and used to produce "host display socket did not appear").
  const path = sessionSockPath('ready-session', home)
  assert.equal(await displaySockExists(path), false)
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: () => {},
    onAttach: () => {},
  })
  await host.listen()
  await waitForDisplaySock(path, 3_000, process.pid)
  assert.equal(await displaySockExists(path), true)
  await host.close()
  assert.equal(await displaySockExists(path), false)
  await rm(home, { recursive: true, force: true })
})

test('waitForDisplaySock reports host stderr when the pid dies first', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const sock = join(home, 'missing.sock')
  const errFile = `${sock}.err`
  await writeFile(errFile, 'host boom\n')
  const deadPid = 2 ** 22 - 1
  await assert.rejects(
    () => waitForDisplaySock(sock, 400, deadPid, errFile),
    error => error instanceof Error
      && error.message.includes(`pid ${deadPid} exited before display socket appeared`)
      && error.message.includes('host boom'),
  )
  await rm(home, { recursive: true, force: true })
})

test('parseSessionLock keeps sock and paused state', () => {
  const parsed = parseSessionLock(JSON.stringify({
    pid: 12,
    sessionId: 's1',
    sock: '/tmp/s1.sock',
    state: 'paused',
    disconnectPolicy: 'pause',
    agentStatus: 'idle',
  }))
  assert.equal(parsed?.sock, '/tmp/s1.sock')
  assert.equal(parsed?.state, 'paused')
  assert.equal(parsed?.disconnectPolicy, 'pause')
})

test('DisplayHost ignores a connect with no HELLO (liveness probe)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const path = sessionSockPath('probe', home)
  const attaches = []
  const detaches = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: () => { detaches.push(1) },
    onAttach: () => { attaches.push(1) },
  })
  await host.listen()
  const probe = createConnection(path)
  await new Promise((resolve, reject) => {
    probe.once('connect', resolve)
    probe.once('error', reject)
  })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(attaches.length, 0)
  assert.equal(host.attached, false)
  probe.destroy()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(detaches.length, 0)
  await host.close()
  await rm(home, { recursive: true, force: true })
})

test('DisplayHost delivers HELLO then RESIZE from one chunk', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const path = sessionSockPath('hello-resize', home)
  const resizes = []
  const attaches = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: (columns, rows) => { resizes.push([columns, rows]) },
    onDetach: () => {},
    onAttach: () => { attaches.push(1) },
  })
  await host.listen()
  const client = createConnection(path)
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  client.write(Buffer.concat([
    encodeFrame(FRAME_HELLO),
    encodeResize(140, 42),
  ]))
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(attaches.length, 1)
  assert.deepEqual(resizes, [[140, 42]])
  client.destroy()
  await host.close()
  await rm(home, { recursive: true, force: true })
})

test('DisplayHost claims HELLO and kicks the previous relay', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const path = sessionSockPath('kick', home)
  const stdin = []
  const detaches = []
  const attaches = []
  const host = new DisplayHost(path, {
    onStdin: (bytes) => { stdin.push(bytes.toString()) },
    onResize: () => {},
    onDetach: (info) => { detaches.push(info) },
    onAttach: () => { attaches.push(1) },
  })
  await host.listen()
  const first = createConnection(path)
  await new Promise((resolve, reject) => {
    first.once('connect', resolve)
    first.once('error', reject)
  })
  first.write(encodeFrame(FRAME_HELLO))
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(attaches.length, 1)
  assert.equal(host.attached, true)
  first.write(encodeFrame(FRAME_STDIN, Buffer.from('k')))
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(stdin, ['k'])
  const second = createConnection(path)
  await new Promise((resolve, reject) => {
    second.once('connect', resolve)
    second.once('error', reject)
  })
  second.write(encodeFrame(FRAME_HELLO))
  await new Promise(resolve => setTimeout(resolve, 40))
  // The kick is reported as a replacement, never as a bare detach: a bare
  // detach would idle-exit a leftover Host the user just reattached to.
  assert.deepEqual(detaches, [{ replaced: true }])
  assert.equal(attaches.length, 2)
  assert.equal(host.attached, true)
  // The reattached relay drives the same session.
  second.write(encodeFrame(FRAME_STDIN, Buffer.from('j')))
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(stdin, ['k', 'j'])
  second.destroy()
  first.destroy()
  await host.close()
  await rm(home, { recursive: true, force: true })
})

test('DisplayHost handles multiple resize events smoothly as window enlarges', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-sock-'))
  const path = sessionSockPath('resize', home)
  const resizes = []
  const attaches = []
  const detaches = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: (columns, rows) => { resizes.push([columns, rows]) },
    onDetach: () => { detaches.push(1) },
    onAttach: () => { attaches.push(1) },
  })
  await host.listen()
  const client = createConnection(path)
  await new Promise((resolve, reject) => {
    client.once('connect', resolve)
    client.once('error', reject)
  })
  // Initial connect with 80x24
  client.write(Buffer.concat([
    encodeFrame(FRAME_HELLO),
    encodeResize(80, 24),
  ]))
  await new Promise(resolve => setTimeout(resolve, 40))
  // Enlarging window multiple steps: 120x40, 160x60, 200x80
  client.write(encodeResize(120, 40))
  client.write(encodeResize(160, 60))
  client.write(encodeResize(200, 80))
  await new Promise(resolve => setTimeout(resolve, 40))

  assert.equal(attaches.length, 1)
  assert.equal(detaches.length, 0)
  assert.deepEqual(resizes, [[80, 24], [120, 40], [160, 60], [200, 80]])
  client.destroy()
  await host.close()
  await rm(home, { recursive: true, force: true })
})

// A killed Host leaves its `.sock` file behind. `fs.access` reported that as
// ready, so the launcher attached to a dead peer and the first reconnect died
// with `write EPIPE` (and the picker listed it as `可接入`).
test('a leftover socket file is not a ready channel', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-stale-'))
  const path = join(home, 'stale.sock')
  // Exactly what a killed Host leaves behind: the directory entry without a
  // listener (Node unlinks on a clean close, so create the leftover directly).
  await writeFile(path, '')
  assert.equal(existsSync(path), true)
  assert.equal(await displaySockExists(path), false, 'an entry without a listener is not ready')
  assert.equal(await probeDisplaySock(path, 200), false)
  // A waiting launcher must not treat that entry as the Host coming up.
  const waiting = waitForDisplaySock(path, 1_500, process.pid)
  const early = await Promise.race([
    waiting.then(() => 'ready'),
    new Promise(resolve => setTimeout(() => resolve('still-waiting'), 400)),
  ])
  assert.equal(early, 'still-waiting')
  const host = new DisplayHost(path, {
    onStdin: () => {}, onResize: () => {}, onDetach: () => {}, onAttach: () => {},
  })
  await host.listen()
  await waiting
  assert.equal(await displaySockExists(path), true)
  await host.close()
  await rm(home, { recursive: true, force: true })
})
