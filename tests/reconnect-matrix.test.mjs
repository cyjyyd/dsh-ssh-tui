import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'

import { createAttacher } from '../lib/attach.js'
import { DisplayHost, isPipePath, runDisplayRelay, sessionSockPath } from '../lib/display-sock.js'
import { CURSOR_POSITION_REQUEST } from '../lib/terminal-input.js'

/**
 * The drop matrix, before any behavior change: what a link that drops N times
 * must never do.
 *
 * 0.5.9's incident was a launcher/relay fight — a replaced window retried,
 * the retry claimed the display back, and the two kicked each other in a loop
 * while every lap repainted the screen and echoed stale cursor replies into the
 * prompt. The single-drop case is covered in reconnect-e2e; these are the
 * repeated drops, which is where a retry policy is most likely to regress into
 * a fight. Every case runs unattended, so the manual probing that incident
 * needed becomes a test run.
 *
 * The invariants asserted after every cycle:
 *
 *   1. the replaced window exits 0 with reason `replaced`, and never spawns a
 *      competing Host;
 *   2. exactly one window holds the display, and the Host says so;
 *   3. every keystroke typed in a window reaches the Host exactly once — no
 *      duplicate delivery from a retry, no loss across the handover;
 *   4. no cursor-probe answer outlives its probe (the `^[[17;1R` garbage).
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A terminal at the end of a link that answers a cursor request one RTT later. */
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

/** One SSH window: the real attacher driving the real relay over a fake TTY. */
function window(sock) {
  const terminal = sshTerminal({ staleReply: true })
  const exits = []
  const spawned = []
  const reasons = []
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
      return { sock, pid: 1, exitWatch: { dispose: () => {}, exited: Promise.resolve(null) } }
    },
    waitForDisplaySock: async () => {},
    report: () => {},
    exit: code => {
      exits.push(code)
      settle(code)
    },
    messages: {
      connecting: () => 'connecting',
      recovering: () => 'recovering',
      replaced: () => 'replaced',
      flapping: () => 'flapping',
      zombie: () => 'zombie',
    },
  })
  return { attacher, terminal, exits, spawned, reasons, exited }
}

async function withSession(t, id) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-matrix-'))
  const path = sessionSockPath(id, home)
  if (!isPipePath(path)) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  return path
}

/** Wait until `check` holds, or fail with what the caller can show. */
async function waitFor(check, what, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

for (const drops of [1, 3, 5]) {
  test(`${drops} consecutive drops: one window at a time, input neither duplicated nor lost`, { timeout: 60_000 }, async t => {
    const id = `main-session-drops-${drops}`
    const path = await withSession(t, id)
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

    const windows = []
    const firstWindow = window(path)
    windows.push(firstWindow)
    let current = firstWindow.attacher.attachExisting(id, path)
    await waitFor(() => attachLog.length === 1, 'the first attach')
    assert.deepEqual(attachLog, ['attach'])
    assert.equal(host.attached, true)

    // Each drop hands the display to a new window: the old one must leave.
    for (let cycle = 1; cycle <= drops; cycle += 1) {
      const previous = windows[windows.length - 1]
      const next = window(path)
      windows.push(next)
      const nextAttach = next.attacher.attachExisting(id, path)
      await previous.exited
      await delay(60)

      assert.deepEqual(previous.exits, [0], `cycle ${cycle}: the replaced window exits cleanly`)
      assert.deepEqual(previous.spawned, [], `cycle ${cycle}: and never starts a competing Host`)
      assert.deepEqual(previous.reasons, ['replaced'], `cycle ${cycle}: because the Host said so`)
      assert.equal(next.exits.length, 0, `cycle ${cycle}: the new window keeps the display`)
      assert.equal(host.attached, true, `cycle ${cycle}: the Host still has exactly one display`)

      // Typing in the window that owns the display arrives exactly once.
      const line = `c${cycle}\r`
      next.terminal.stdin.write(line)
      await waitFor(() => received.join('').includes(`c${cycle}\r`), `cycle ${cycle}: the keystroke reaches the Host`)
      assert.equal(
        received.join('').split(`c${cycle}\r`).length - 1,
        1,
        `cycle ${cycle}: delivered once, not twice`,
      )
      current = nextAttach
    }

    assert.deepEqual(
      attachLog,
      ['attach', ...Array.from({ length: drops }, () => ['replaced', 'attach']).flat()],
      'every drop is one replace plus one attach: no fight, no extra claim',
    )
    assert.equal(received.join(''), Array.from({ length: drops }, (_, index) => `c${index + 1}\r`).join(''),
      'the keystrokes are exactly the ones typed, in order')

    await host.close()
    await Promise.all([...windows.map(entry => entry.exited), current])
  })
}
