import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import {
  detachFromSshSession,
  DisplayHost,
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
  sessionSockPath,
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
    sessionSockPath('main-session/../evil id', '/tmp/dsh-home'),
    join('/tmp/dsh-home', 'tui-socks', 'main-session_.._evil_id.sock'),
  )
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
  const path = join(home, 'tui-socks', 's.sock')
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
  const path = join(home, 'tui-socks', 's.sock')
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
  const path = join(home, 'tui-socks', 's.sock')
  const stdin = []
  const detaches = []
  const attaches = []
  const host = new DisplayHost(path, {
    onStdin: (bytes) => { stdin.push(bytes.toString()) },
    onResize: () => {},
    onDetach: () => { detaches.push(1) },
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
  assert.ok(detaches.length >= 1)
  assert.equal(attaches.length, 2)
  second.destroy()
  first.destroy()
  await host.close()
  await rm(home, { recursive: true, force: true })
})
