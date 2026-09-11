import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createAttacher } from '../lib/attach.js'
import {
  DisplayHost,
  isPipePath,
  runDisplayRelay,
  sessionSockPath,
} from '../lib/display-sock.js'
import { CURSOR_POSITION_REQUEST } from '../lib/terminal-input.js'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A TTY that behaves like a terminal at the end of an SSH link: it answers a
 * cursor-position request one round-trip later, and — like every real terminal
 * — it can still have an answer to an *earlier* request in flight.
 */
function sshTerminal({ rttMs = 30, staleReply = false } = {}) {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  const stdout = {
    isTTY: true,
    columns: 100,
    rows: 30,
    writes: '',
    requests: 0,
    write(chunk) {
      const text = String(chunk)
      stdout.writes += text
      if (text.includes(CURSOR_POSITION_REQUEST)) {
        stdout.requests += 1
        if (staleReply && stdout.requests === 1) stdin.write('\x1b[17;1R')
        setTimeout(() => stdin.write('\x1b[17;1R'), rttMs)
      }
      return true
    },
    on() {},
    off() {},
    removeListener() {},
  }
  return { stdin, stdout }
}

/** One SSH window's launcher: the real attacher over a fake TTY. */
function fakeLauncher(sock, terminal) {
  const exits = []
  const spawned = []
  const reasons = []
  const reports = []
  let settle
  const exited = new Promise(resolve => { settle = resolve })
  const attacher = createAttacher({
    relay: async relaySock => {
      const result = await runDisplayRelay(relaySock, {
        stdin: terminal.stdin,
        stdout: terminal.stdout,
        signals: new EventEmitter(),
        ssh: true,
      })
      reasons.push(result.reason)
      return result
    },
    quiet: () => {},
    inspectLiveHost: async () => undefined,
    spawnHost: () => {
      spawned.push(sock)
      return {
        sock,
        pid: 1,
        exitWatch: { dispose: () => {}, exited: Promise.resolve(null) },
      }
    },
    waitForDisplaySock: async () => {},
    report: message => { reports.push(message) },
    exit: code => {
      exits.push(code)
      settle(code)
    },
    messages: {
      connecting: sessionId => `connecting ${sessionId}`,
      recovering: sessionId => `recovering ${sessionId}`,
      replaced: sessionId => `replaced ${sessionId}`,
      flapping: sessionId => `flapping ${sessionId}`,
      zombie: (sessionId, pid) => `zombie ${sessionId} ${pid}`,
    },
  })
  return { attacher, exits, spawned, reasons, reports, exited }
}

async function withSession(t, id) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-reconnect-'))
  const path = sessionSockPath(id, home)
  if (!isPipePath(path)) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  return path
}

/**
 * The reported bug, end to end: SSH back into a session that is already
 * running. The Host kicks whatever display it had, and the two launchers used
 * to kick each other off it forever — every lap repainting the screen, every
 * lap echoing the replies still in flight as `^[[17;1R`, and neither window
 * accepting input.
 */
test('a reconnect takes the display once, and the old window exits', { timeout: 15_000 }, async t => {
  const path = await withSession(t, 'main-session-reconnect')
  const received = []
  const attachLog = []
  const host = new DisplayHost(path, {
    onStdin: payload => { received.push(payload.toString()) },
    onResize: () => {},
    onDetach: info => { attachLog.push(info?.replaced === true ? 'replaced' : 'detach') },
    onAttach: () => { attachLog.push('attach') },
  })
  await host.listen()
  t.after(() => host.close())

  // Window A holds the session.
  const a = sshTerminal({ staleReply: true })
  const oldWindow = fakeLauncher(path, a)
  const first = oldWindow.attacher.attachExisting('main-session-reconnect', path)
  for (let wait = 0; wait < 300 && attachLog.length === 0; wait += 1) await delay(10)
  assert.deepEqual(attachLog, ['attach'])
  assert.equal(host.attached, true)

  // The user reconnects from a second SSH window.
  const b = sshTerminal({ staleReply: true })
  const newWindow = fakeLauncher(path, b)
  const second = newWindow.attacher.attachExisting('main-session-reconnect', path)
  await oldWindow.exited
  await delay(120)

  assert.deepEqual(oldWindow.exits, [0], 'the replaced window exits')
  assert.deepEqual(oldWindow.spawned, [], 'and never starts a competing Host')
  assert.deepEqual(oldWindow.reasons, ['replaced'], 'because the Host said so')
  assert.equal(newWindow.exits.length, 0, 'the new window keeps the display')
  assert.equal(host.attached, true)
  assert.deepEqual(attachLog, ['attach', 'replaced', 'attach'])

  // What reaches the Host is typing — never a probe answer that outlived the
  // probe that asked for it.
  b.stdin.write('ls')
  await delay(60)
  assert.equal(received.join(''), 'ls', `probe answers must not reach the Host: ${JSON.stringify(received)}`)

  await host.close()
  await Promise.all([first, second])
  assert.deepEqual(newWindow.exits, [0], 'closing the session ends the remaining window')
})

/**
 * The relay measures the link *before* it says HELLO, so the Host's HELLO grace
 * has to outlast that measurement. At 3 s a ~600 ms link (probe budget 2.5 s
 * plus a widened 800 ms window) was reaped as a silent liveness probe: the
 * launcher saw `host-closed`, called it flapping, and the user could not attach
 * at all.
 */
test('a slow link still claims the display', { timeout: 30_000 }, async t => {
  const path = await withSession(t, 'main-session-slow-link')
  const attachLog = []
  const host = new DisplayHost(path, {
    onStdin: () => {},
    onResize: () => {},
    onDetach: () => {},
    onAttach: () => { attachLog.push('attach') },
  })
  await host.listen()
  t.after(() => host.close())

  const terminal = sshTerminal({ rttMs: 600 })
  const relay = runDisplayRelay(path, {
    stdin: terminal.stdin,
    stdout: terminal.stdout,
    signals: new EventEmitter(),
    ssh: true,
  })
  const deadline = Date.now() + 10_000
  while (attachLog.length === 0 && Date.now() < deadline) await delay(50)
  assert.deepEqual(attachLog, ['attach'], 'the slow relay must still claim the display')
  assert.equal(host.attached, true)

  await host.close()
  const result = await relay
  assert.equal(['goodbye', 'host-closed'].includes(result.reason), true,
    `the relay outlived the probe and ended on the Host's terms: ${JSON.stringify(result)}`)
})
