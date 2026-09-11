#!/usr/bin/env node
/**
 * Scripted PTY acceptance probe: runs the real TUI on a real terminal, drives
 * key presses and resizes, and asserts what the *terminal* ends up showing.
 *
 * `npm test` covers the paint math on a headless screen grid; this covers the
 * parts that only exist end to end — a session that boots, a resize that must
 * not resurrect a finished screen, and a `/diag` report on a live session.
 * Unlike `scripts/pty-acceptance.py` (which drives the display relay with fake
 * launchers), this drives `dsh --profile tui` itself.
 *
 * Usage:
 *   node scripts/tui-probe.mjs            # boot, resize, /diag
 *   node scripts/tui-probe.mjs --session <id>   # resume a specific session
 *   node scripts/tui-probe.mjs --keep     # leave the session's host running
 *
 * Exit code 0 means every assertion passed. The captured output is printed on
 * failure so a CI log carries the evidence.
 */
import { lstatSync } from 'node:fs'
import { readdir, readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const USAGE = `usage: node scripts/tui-probe.mjs [--session <id>] [--keep] [--home <dir>]

  (no args)        boot a throwaway session, resize, /diag, type, /exit
  --session <id>   resume an existing session instead of creating one
  --keep           leave the host running after the probe
  --home <dir>     DSH_HOME to probe (default: $PROBE_HOME / $DSH_HOME / ~/.dsh)

Set PROBE_HOME to a throwaway tree to keep the probe away from real sessions.`

/** Control sequences the probe watches for. */
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu

function plain(text) {
  return text.replace(CSI, '').replace(OSC, '')
}

/**
 * node-pty ships in the harness CLI's tree (its `dsh` package depends on it),
 * so a normal checkout has it. It is optional here: a machine without a built
 * node-pty skips the probe instead of failing CI.
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

/**
 * Kill the detached Host this probe spawned, using the pid from its tui-lock.
 * The Host installs SIGTERM/SIGHUP ignores at startup, so only SIGKILL works.
 */
async function killHostByLock(sessionId, home) {
  try {
    const lock = JSON.parse(await readFile(join(home, 'tui-locks', `${sessionId}.json`), 'utf8'))
    if (Number.isInteger(lock.pid) && lock.pid > 0) process.kill(lock.pid, 'SIGKILL')
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

/**
 * The 2026-09-11 incident shape: `sessions/` aliased to the real home while
 * `tui-locks/`/`tui-socks/` stayed in the throwaway one. The Host then holds a
 * real session's write lease while its lock is invisible to the user's picker,
 * and every new Host fails with "already owned by an active write handle".
 * A probe must fail closed on that layout instead of reproducing it.
 */
function assertHomeIsCoherent(home) {
  for (const name of ['sessions', 'tui-locks', 'tui-socks']) {
    let stats
    try {
      stats = lstatSync(join(home, name))
    } catch {
      continue // Missing is fine: the launcher creates it as needed.
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `${join(home, name)} is a symlink; the probe may only run against a home whose `
        + 'sessions/, tui-locks/ and tui-socks/ all live in the same tree '
        + '(a split home leaves an invisible Host holding a real session lock)',
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
  // The TUI needs a profile tree, which lives in the user's DSH_HOME. The probe
  // reuses it (`PROBE_HOME`/`DSH_HOME` override) and creates its own session in
  // it, so it never touches an existing one unless `--session` names it.
  assertHomeIsCoherent(home)
  // A fresh session is addressed by an id this probe minted itself. The launcher
  // treats `--resume=<missing id>` as "create that id", so cleanup never has to
  // guess: the only session it may touch is the one it named. (The 2026-09-11
  // incident came from the other approach — scraping the first session id out of
  // the PTY output and deleting it, which deleted the *resumed* session.)
  const createdSessionId = sessionId ?? `main-session-${randomUUID()}`
  const env = {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    // A deterministic terminal: no update prompts, no colour differences.
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
  }
  console.log(`probe home: ${home}`)
  console.log(`probe session: ${createdSessionId}${sessionId === undefined ? ' (created, removed on exit)' : ' (existing, kept)'}`)

  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${createdSessionId}`], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env,
  })

  let output = ''
  term.onData(chunk => {
    output += chunk
  })
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(output)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`timed out waiting for ${label}\n--- captured ---\n${plain(output).slice(-1500)}`)
  }

  const problems = []
  const check = (condition, message) => {
    if (!condition) problems.push(message)
  }

  try {
    // 1. The TUI boots and paints its chrome.
    await waitFor(text => text.includes('DeepSeek Harness'), 60_000, 'the boot banner')
    await waitFor(text => /空闲|idle/u.test(text), 60_000, 'the idle status line')

    // 2. A resize must resize the frame, not resurrect an earlier screen. The
    //    historical bug repainted a finished picker on every SIGWINCH.
    const beforeResize = output.length
    term.resize(72, 24)
    await new Promise(resolve => setTimeout(resolve, 1200))
    const afterResize = output.slice(beforeResize)
    check(afterResize.length > 0, 'the resize produced a repaint')
    check(
      !/选择要恢复的历史会话/u.test(plain(afterResize)),
      'the resize must not repaint the finished session picker',
    )

    // 3. /diag answers with the local facts, including the verdict chain.
    //    Back to the boot size first: at 24 rows the report's head (the version
    //    line) scrolls out of the painted viewport and never reaches the wire.
    term.resize(100, 30)
    await new Promise(resolve => setTimeout(resolve, 400))
    const beforeDiag = output.length
    term.write('/diag\r')
    await waitFor(text => text.slice(beforeDiag).includes('判定链') || text.slice(beforeDiag).includes('verdict chain'), 30_000, 'the /diag verdict chain')
    const diag = plain(output.slice(beforeDiag))
    // /diag is localized: each fact may arrive in either catalog.
    for (const variants of [['版本', 'versions'], ['显示通道', 'display channel'], ['Host']]) {
      check(variants.some(needle => diag.includes(needle)), `/diag output must mention ${variants.join(' / ')}`)
    }

    // 4. Typing still reaches the input line after all of that.
    const beforeTyping = output.length
    term.write('hello probe')
    await waitFor(text => plain(text.slice(beforeTyping)).includes('hello probe'), 15_000, 'typed text on the prompt')

    // 5. `/exit` hands the terminal back. The launcher's graceful shutdown only
    //    sets process.exitCode, and a lingering watcher handle used to keep it
    //    alive in front of a shell that never got its prompt back — the user
    //    could only recover by dropping SSH. The relay must also leave the
    //    alternate screen.
    const beforeExit = output.length
    const exitCode = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), 15_000)
      term.onExit(({ exitCode: code }) => {
        clearTimeout(timer)
        resolve(code)
      })
      // Ctrl+U clears the composer; step 4 left the probe text in it, and
      // `hello probe/exit` submits a message instead of running the command.
      term.write('\x15')
      term.write('/exit\r')
    })
    check(exitCode === 0, `the launcher exited on /exit (got ${exitCode === undefined ? 'no exit within 15s' : exitCode})`)
    check(output.slice(beforeExit).includes('\x1b[?1049l'), 'the relay handed the alternate screen back')
  } catch (error) {
    problems.push(String(error.message ?? error))
  } finally {
    term.kill()
    // Only clean up a session this probe created and named. `--session X`
    // resumes an existing session, so X is never removed here — deleting the
    // resumed session's directory is what destroyed a live session's log on
    // 2026-09-11. Kill the detached Host first (it ignores SIGTERM), or it
    // keeps the write handle on a deleted log.
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
  console.log('OK: boot, resize repaint, /diag, typing, and the /exit handback all behaved')
  return 0
}

function parseArgs(argv) {
  const parsed = {
    sessionId: undefined,
    keep: argv.includes('--keep'),
    home: process.env.PROBE_HOME ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '/root', '.dsh'),
    help: argv.includes('--help') || argv.includes('-h'),
  }
  const read = (flag) => {
    const at = argv.indexOf(flag)
    if (at === -1) return undefined
    const value = argv[at + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`${flag} needs a value`)
      process.exit(2)
    }
    return value
  }
  const explicitHome = read('--home')
  const session = read('--session')
  if (explicitHome !== undefined) parsed.home = explicitHome
  if (session !== undefined) parsed.sessionId = session
  return parsed
}

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(USAGE)
  process.exit(0)
}
try {
  process.exit(await runProbe(args))
} catch (error) {
  console.error(`probe refused to run: ${error.message ?? error}`)
  process.exit(2)
}
