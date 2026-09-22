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
 *              carries the session id), then lose its terminal the way the
 *              platform does it — SIGHUP on POSIX, ConPTY teardown on Windows
 *              (see `scripts/pty-window.mjs`) — and exit without leaving a
 *              zombie holding the display
 *   window B   `--resume` the same session in a fresh PTY: the transcript must
 *              still be there, typing must reach the prompt, and neither window
 *              may have echoed a cursor reply as `[17;1R`
 *   the Host   killed outright while window B is attached: the launcher must
 *              replace it and re-attach instead of handing the user back to the
 *              shell — the "Host 崩溃" row of the lifecycle spec
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
// `import()` needs a URL, not a path: on Windows `D:\…` is rejected with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, which is what the first Windows CI run hit.
const { sessionLockLookupPaths } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/session-lock.js')).href,
)
// The seam: how a window dies differs per platform, and the spec says which
// primitive each death maps to. One module owns that so the probes cannot drift.
const { closeWindow, windowDeathNote, IS_WINDOWS } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'pty-window.mjs')).href,
)

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
    const mod = await import(pathToFileURL(resolved).href)
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

/** True when the pid still exists (signal 0 is the portable liveness probe). */
function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
    // CI sets PROBE_REQUIRE_PTY: a skipped probe must not read as coverage.
    if (process.env.PROBE_REQUIRE_PTY === '1') {
      console.log('FAIL: node-pty is unavailable, so the TUI cannot be driven on a PTY here (PROBE_REQUIRE_PTY=1)')
      return 1
    }
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
    const window = { label, term, output: '', exited: undefined }
    term.onData(chunk => { window.output += chunk })
    term.onExit(({ exitCode }) => { window.exited = exitCode })
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

  /**
   * The launcher is gone — asked two ways on purpose. Windows can keep the pid
   * answering `kill(pid, 0)` while a handle to it is still open, and node-pty's
   * exit event is the one that carries the code but only arrives once the ConPTY
   * output socket closes. Either answer means the window is not lingering.
   */
  const waitForWindowGone = async (window, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if (window.exited !== undefined) return true
      if (!isAlive(window.term.pid)) return true
      if (Date.now() >= deadline) return false
      await delay(100)
    }
  }

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

    // 2. The link drops: the terminal goes away under a launcher that is still
    //    running. SSH gives it the platform's hangup and nothing else — no
    //    goodbye, no chance to choose its exit. The Host has to survive it, and
    //    the launcher must not stay behind as a zombie holding a dead display.
    console.log(`window A: ${windowDeathNote('close')}`)
    closeWindow(a.term)
    const aGone = await waitForWindowGone(a, 10_000)
    check(
      aGone,
      'the launcher must exit when its terminal goes away instead of lingering as a zombie',
    )
    if (aGone && !IS_WINDOWS) {
      // On POSIX the hangup is a signal the launcher handles: it restores the
      // terminal and leaves 0. Windows has no signal to handle — the ConPTY
      // teardown terminates it — so only "it exited" is promised there.
      check(a.exited === 0, `the hung-up launcher must exit 0 on POSIX (got ${a.exited ?? 'no exit event'})`)
    }
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

    // 6. The Host itself dies while window B is attached. The launcher is
    //    supposed to absorb this on its own: `host-closed` lands inside the
    //    recovery window, so it starts a fresh Host and re-attaches. The user
    //    keeps the window and the transcript instead of being handed back to
    //    the shell with a "flapping" message.
    //
    //    The lock file alone cannot prove the Host is gone — a dead Host leaves
    //    one behind — so ask the pid, then wait for a *live* Host to answer:
    //    each `/status` typed below only comes back if a new Host is serving.
    const beforeCrash = b.output.length
    await killHostByLock(createdSessionId, home)
    let recovered = false
    for (let attempt = 0; attempt < 10 && !recovered; attempt += 1) {
      await delay(2_500)
      b.term.write('/status\r')
      await delay(500)
      recovered = plain(b.output.slice(beforeCrash)).includes(createdSessionId)
    }
    check(recovered, 'a crashed Host must be replaced and re-attached automatically, not left to the user')
    check(
      b.exited === undefined,
      `the attached window must not exit when its Host dies (exited with ${b.exited})`,
    )
    console.log(`host after the crash: ${recovered ? 'replaced and re-attached' : 'never came back'}`)

    // 7. And the window itself still exits cleanly.
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
  console.log('OK: the dropped window was resumed with its transcript, a working prompt, no garbage, and a crashed Host came back on its own')
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
