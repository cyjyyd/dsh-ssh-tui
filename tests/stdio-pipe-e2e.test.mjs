import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  DisplayHost,
  isPipePath,
  runDisplayRelay,
  sessionSockPath,
} from '../lib/display-sock.js'

/**
 * The TUI over pipes: the desktop's half of the compatibility story.
 *
 * The desktop Harness runs Electron as Node, so its launcher has no console and
 * a terminal profile cannot start under it — that is upstream's problem, and
 * `docs/desktop.md` says so. What this repository owns is the other direction: a
 * parent that *can* put bytes on a pipe (a PTY panel, an embedder's terminal
 * widget, a GUI that shells out) must be able to host this TUI by declaring
 * `DSH_TUI_DISPLAY=stdio`. The relay then has no TTY to lean on:
 *
 *   - `stdin.setRawMode` does not exist on a pipe, and calling it unguarded threw
 *     before the relay could even say hello — the mode was unusable;
 *   - the size has to come from the parent (`COLUMNS`/`LINES`, the relay's
 *     fallback for a stream that reports none) because no pipe fires `resize`;
 *   - a terminal that never answers a cursor probe must not hold the attach.
 *
 * These drive the real relay against a real display host with pipe streams on
 * both ends — as close to the embedder's situation as a test can get without a
 * GUI.
 */
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The parent end: a pipe in, a pipe out, no TTY and no `resize` event. */
function pipeParent(size = { columns: 100, rows: 30 }) {
  const stdin = new PassThrough()
  // Deliberately not a TTY: `isTTY` is undefined and `setRawMode` is missing,
  // exactly like the pipe a GUI parent hands its child.
  let text = ''
  const stdout = {
    columns: size.columns,
    rows: size.rows,
    write(chunk) {
      text += String(chunk)
      return true
    },
    on() {},
    off() {},
    removeListener() {},
  }
  return { stdin, stdout, get text() { return text } }
}

async function withSession(t, id) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-stdio-'))
  const path = sessionSockPath(id, home)
  // Pipes are not files: they need no directory. The Linux socket does.
  if (!isPipePath(path)) await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  t.after(async () => { await rm(home, { recursive: true, force: true }) })
  return path
}

async function waitFor(check, what, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await delay(10)
  }
  assert.fail(`timed out waiting for ${what}`)
}

test('a pipe parent can host the TUI without a TTY anywhere', async t => {
  const path = await withSession(t, 'stdio-pipe')
  const input = []
  const sizes = []
  const rtts = []
  const host = new DisplayHost(path, {
    onStdin: bytes => input.push(bytes.toString('utf8')),
    onResize: (columns, rows) => sizes.push({ columns, rows }),
    onRtt: rttMs => rtts.push(rttMs),
    onMetrics: () => {},
    onDetach: () => {},
    onAttach: () => {},
  })
  await host.listen()
  t.after(() => { void host.close() })

  const parent = pipeParent()
  const relay = runDisplayRelay(path, {
    stdin: parent.stdin,
    stdout: parent.stdout,
    signals: new EventEmitter(),
    ssh: false,
  })

  // The attach is the first assertion: `setRawMode` on a pipe used to throw here,
  // which failed the whole mode before a single frame was painted.
  await waitFor(() => host.attached, 'the host to see the relay attach')
  assert.equal(parent.stdin.isTTY, undefined, 'the parent really is a pipe')

  // The size the parent declared is what the host renders for.
  await waitFor(() => sizes.length > 0, 'the declared size to reach the host')
  assert.deepEqual(sizes[0], { columns: 100, rows: 30 })

  // A keystroke typed on the pipe is delivered to the host as input.
  parent.stdin.write('hi')
  await waitFor(() => input.join('') === 'hi', 'the keystroke to reach the host')

  // The panel is resized: a pipe has no `resize` event, so the parent reports it
  // the way a terminal does. It must reach the host as a size, and it must not
  // arrive as typing.
  parent.stdin.write('\u001b[8;50;160t')
  await waitFor(() => sizes.length > 1, 'the reported size to reach the host')
  assert.deepEqual(sizes.at(-1), { columns: 160, rows: 50 })
  assert.equal(input.join(''), 'hi', 'the size report is not typing')

  // A frame the host paints comes back out of the pipe, escapes and all.
  host.sendStdout(Buffer.from('\u001b[2J\u001b[Hpainted'))
  await waitFor(() => parent.text.includes('painted'), 'the frame to reach the pipe')

  // A terminal that never answers a cursor probe must not hold the attach: the
  // relay reports the measurement (or its absence) instead of waiting out the
  // sampling budget with the screen blank.
  await waitFor(() => rtts.length > 0, 'the host to hear about the link')

  host.sendGoodbye()
  const result = await relay
  assert.equal(result.reason, 'goodbye')
})
