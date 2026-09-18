#!/usr/bin/env node
/**
 * Scripted PTY acceptance probe for a dropped link.
 *
 * `tests/reconnect-matrix.test.mjs` and `tests/transcript-across-drops.test.mjs`
 * cover the relay/host contract and the row array in-process. What they cannot
 * cover is the product promise a user actually makes: kill the window (the SSH
 * drop), come back with the same command, and find the session as it was —
 * same transcript, a working prompt, and no cursor-reply garbage on screen.
 * That needs a real PTY and the real `dsh --profile tui`, because the TUI owns
 * the terminal (alternate screen, hangup signals, its own exit paths) and takes
 * a test runner's process down with it when started in-process.
 *
 * What it drives:
 *
 *   window A   boot the throwaway session, run /status (a short report that
 *              carries the session id), then die by SIGKILL — no goodbye, no
 *              chance to hand the terminal back: the drop as SSH delivers it
 *   window B   `--resume` the same session in a fresh PTY: the transcript must
 *              still be there, typing must reach the prompt, and neither window
 *              may have echoed a cursor reply as `[17;1R`
 *
 * Usage:
 *   node scripts/tui-drop-probe.mjs                 # create a throwaway session
 *   node scripts/tui-drop-probe.mjs --session <id>  # drive an existing one (kept)
 *   node scripts/tui-drop-probe.mjs --keep          # leave the host running
 *   node scripts/tui-drop-probe.mjs --home <dir>    # DSH_HOME to probe
 *
 * Exit code 0 means every assertion passed; the captured output is printed on
 * failure so a CI log carries the evidence.
 */
import { lstatSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const { sessionLockLookupPaths } = await import(join(dirname(fileURLToPath(import.meta.url)), '../lib/session-lock.js'))

const USAGE = `usage: node scripts/tui-drop-probe.mjs [--session <id>] [--keep] [--home <dir>]

  (no args)        create a throwaway session, drop the window, resume it
  --session <id>   resume an existing session instead of creating one
  --keep           leave the host running after the probe
  --home <dir>     DSH_HOME to probe (default: $PROBE_HOME / $DSH_HOME / ~/.dsh)`

/** Control sequences the probe watches for. */
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu

function plain(text) {
  return text.replace(CSI, '').replace(OSC, '')
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * node-pty ships in the harness CLI's tree (its `dsh` package depends on it),
 * so a normal checkout has it. Optional here: a machine without a built
 * node-pty skips the probe instead of failing.
 */
async function loadPty() {
  try {
    const resolved = require.resolve('node-pty', { paths: [process.cwd()] })
    const mod = await import(resolved)
    return mod.default ?? mod
  } catch {
    return undefined
  }
}

/** Kill the detached Host this probe spawned, by the pid in its tui-lock. */
async function readLock(sessionId, home) {
  for (const path of sessionLockLookupPaths(sessionId, home)) {
    try {
      return { path, lock: JSON.parse(await readFile(path, 'utf8')) }
    } catch {
      // Missing at this name; try the 0.7.1 leftover next.
    }
  }
  return undefined
}

async function killHostByLock(sessionId, home) {
  try {
    const held = await readLock(sessionId, home)
    const pid = held?.lock?.pid
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
  } catch {
    // No lock or already gone: nothing to clean.
  }
}

/** Remove the probe's own session directory, whatever cwd slug holds it. */
async function removeSessionDir(home, sessionId) {
  let entries
  try {
    entries = await readdir(join(home, 'sessions'), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    await rm(join(home, 'sessions', entry.name, sessionId), { recursive: true, force: true })
  }
}

/** The probe may only run against a home whose state all lives in one tree. */
function assertHomeIsCoherent(home) {
  for (const name of ['sessions', 'tui-locks', 'tui-socks']) {
    let stats
    try {
      stats = lstatSync(join(home, name))
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${join(home, name)} is a symlink; the probe may only run against a home whose `
        + 'sessions/, tui-locks/ and tui-socks/ all live in the same tree',
      )
    }
  }
}

async function runProbe({ sessionId, keep, home }) {
  const pty = await loadPty()
  if (pty === undefined) {
    console.log('SKIP: node-pty is unavailable, so the TUI cannot be driven on a PTY here')
    return 0
  }
  assertHomeIsCoherent(home)
  const createdSessionId = sessionId ?? `main-session-${randomUUID()}`
  const env = {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
  }
  console.log(`probe home: ${home}`)
  console.log(`probe session: ${createdSessionId}${sessionId === undefined ? ' (created, removed on exit)' : ' (existing, kept)'}`)

  const windows = []
  const openWindow = label => {
    const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${createdSessionId}`], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env,
    })
    const window = { label, term, output: '' }
    term.onData(chunk => { window.output += chunk })
    windows.push(window)
    return window
  }
  const waitForOutput = async (window, predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(window.output)) return
      await delay(50)
    }
    throw new Error(
      `timed out waiting for ${what} in window ${window.label}\n`
      + `--- captured ---\n${plain(window.output).slice(-1200)}`,
    )
  }
  const waitForExit = async (window, timeoutMs) => new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    window.term.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })

  const problems = []
  const check = (condition, message) => {
    if (!condition) problems.push(message)
  }

  try {
    // 1. Window A boots and the session answers a command.
    const a = openWindow('A')
    await waitForOutput(a, text => text.includes('DeepSeek Harness'), 60_000, 'the boot banner')
    await waitForOutput(a, text => /空闲|idle/u.test(text), 60_000, 'the idle status line')
    const beforeStatus = a.output.length
    a.term.write('/status\r')
    await waitForOutput(
      a,
      text => text.slice(beforeStatus).includes(createdSessionId),
      30_000,
      'the /status report naming the session',
    )
    const aShowsSession = plain(a.output).includes(createdSessionId)
    check(aShowsSession, 'window A must show the session id in its transcript')

    // 2. The link drops: the whole window dies without a goodbye. SSH gives the
    //    launcher no chance to hand the terminal back, and this is what the Host
    //    has to survive.
    a.term.kill('SIGKILL')
    await delay(2_000)
    // An idle session whose window died is allowed to let its Host go: the
    // policy keeps a Host only while a turn is running. Either way the session
    // must come back — from the surviving Host, or by replaying its log — so
    // this is recorded, not asserted.
    const hostSurvived = (await readLock(createdSessionId, home)) !== undefined
    console.log(`host after the drop: ${hostSurvived ? 'still running (lock held)' : 'exited (idle, no display)'}`)

    // 3. Window B resumes the same session: the transcript comes back.
    const b = openWindow('B')
    await waitForOutput(b, text => text.includes('DeepSeek Harness'), 60_000, 'the boot banner in window B')
    await waitForOutput(b, text => /空闲|idle/u.test(text), 60_000, 'the idle status line in window B')
    await waitForOutput(
      b,
      text => plain(text).includes(createdSessionId),
      15_000,
      'the resumed transcript in window B',
    )
    check(
      plain(b.output).includes(createdSessionId),
      'window B must be repainted with the transcript the dropped window left behind',
    )

    // 4. The prompt still reaches the Host, and the Host answers it.
    const beforeTyping = b.output.length
    b.term.write('hello drop probe')
    await waitForOutput(
      b,
      text => plain(text.slice(beforeTyping)).includes('hello drop probe'),
      15_000,
      'typed text on the prompt',
    )
    check(
      plain(b.output.slice(beforeTyping)).includes('hello drop probe'),
      'typing must reach the prompt after a drop',
    )

    // 5. Neither window may have echoed a cursor reply as `[17;1R`.
    const garbage = /\[17;1R/u.test(plain(a.output)) || /\[17;1R/u.test(plain(b.output))
    check(!garbage, 'a cursor reply must never be echoed into the prompt')

    // 6. And the window itself still exits cleanly.
    const beforeExit = b.output.length
    b.term.write('\x15')
    b.term.write('/exit\r')
    const exitCode = await waitForExit(b, 15_000)
    check(exitCode === 0, `the resumed window must exit on /exit (got ${exitCode ?? 'no exit within 15s'})`)
    check(
      b.output.slice(beforeExit).includes('\x1b[?1049l'),
      'the resumed window must hand the alternate screen back',
    )
  } catch (error) {
    problems.push(String(error.message ?? error))
  } finally {
    for (const window of windows) {
      try { window.term.kill() } catch { /* already gone */ }
    }
    // Only clean up a session this probe created and named. `--session X`
    // resumes an existing session, so X is never removed here.
    if (!keep && sessionId === undefined) {
      await killHostByLock(createdSessionId, home)
      await removeSessionDir(home, createdSessionId)
    }
  }

  if (problems.length > 0) {
    console.error('FAIL')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('OK: the dropped window was resumed with its transcript, a working prompt, and no garbage')
  return 0
}

function parseArgs(argv) {
  const parsed = { sessionId: undefined, keep: false, home: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--session') parsed.sessionId = argv[++index]
    else if (arg === '--keep') parsed.keep = true
    else if (arg === '--home') parsed.home = argv[++index]
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n${USAGE}`)
      process.exit(2)
    }
  }
  parsed.home ??= process.env.PROBE_HOME ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return parsed
}

process.exit(await runProbe(parseArgs(process.argv.slice(2))))
