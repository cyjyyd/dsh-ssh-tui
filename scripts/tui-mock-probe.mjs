#!/usr/bin/env node
/**
 * Real-PTY probe for a scripted model turn: a synthesized throwaway profile plus
 * a mock OpenAI-compatible server, so the transcript gets an actual assistant
 * reply without a provider key and without spending anyone's tokens.
 *
 * `tui-probe.mjs` runs the user's own profile and deliberately never starts a
 * turn. That leaves the parts of the UI that only exist once a reply is on
 * screen unverified end to end — free-form copy (drag over the reply) and the
 * `/find` highlight. This probe covers exactly those, on a real terminal:
 *
 *   1. boot a throwaway home whose `tui` profile mounts this plugin and nothing
 *      else, then start a turn against the mock model;
 *   2. wait for the scripted reply to be painted;
 *   3. `/find` the token inside it and assert the *token* is the thing wrapped
 *      in reverse video — not the whole card;
 *   4. drag across the reply by feeding the terminal's own mouse reports and
 *      assert the OSC 52 clipboard write carries exactly the dragged text.
 *
 * Usage:
 *   node scripts/tui-mock-probe.mjs [--keep]
 *
 * Exit code 0 means every assertion passed; captured output is printed on
 * failure. node-pty and the mock server are devDependencies: without either,
 * the probe skips instead of failing.
 */
import { lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { fork } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const ROOT = process.cwd()
// `import()` needs a URL, not a path: on Windows `D:\…` is rejected with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, which is what the first Windows CI run hit.
const { sessionLockLookupPaths } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/session-lock.js')).href,
)
// How a window dies is per-platform and lives in one place (see its header for
// why Windows cannot tell "closed" and "crashed" apart).
const { closeWindow, crashWindow, windowDeathNote, IS_WINDOWS } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), 'pty-window.mjs')).href,
)
const { hostBootstrapCommand } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/platform.js')).href,
)

const USAGE = `usage: node scripts/tui-mock-probe.mjs [--busy [--crash]] [--keep] [--cols N] [--rows N]

  (no args)   synthesize a profile, run a scripted turn, verify copy and find
  --busy      run the busy-drop scenario instead: close the window mid-turn the
              way this platform closes it and check the Host survives, then that
              the reconnected window says so
  --crash     with --busy: the TUI process dies abruptly instead (SIGKILL on
              POSIX; on Windows the same TerminateProcess as a window close)
  --keep      leave the throwaway home behind (its path is printed)
  --cols N    terminal width to drive (default 110; narrow widths force wraps)
  --rows N    terminal height to drive (default 32)`

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu
const plain = text => text.replace(CSI, '').replace(OSC, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** A distinctive token inside the reply, so the assertions cannot match chrome. */
const REPLY_TOKEN = 'TOKEN-ALPHA-9'
const REPLY_TEXT = `Deployment notes. Run this first: ${REPLY_TOKEN} --dry-run. Then check the log.`

async function loadModule(name) {
  try {
    return await import(pathToFileURL(require.resolve(name, { paths: [ROOT] })).href).then(mod => mod.default ?? mod)
  } catch {
    return undefined
  }
}

/** Decode every OSC 52 clipboard write the terminal received. */
function clipboardWrites(text) {
  const out = []
  const pattern = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x1b\\/gu
  for (const match of text.matchAll(pattern)) {
    const payload = match[1] ?? ''
    if (payload === '') continue
    out.push(Buffer.from(payload, 'base64').toString('utf8'))
  }
  return out
}

/**
 * The last painted content of each screen row.
 *
 * The painter addresses rows absolutely (`\x1b[<row>;1H`), so the transcript can
 * be reconstructed from the raw stream: that is how the probe knows where the
 * reply sits, which the mouse reports need as coordinates.
 */
function screenRows(text) {
  // Accumulate across frames: the painter only rewrites dirty rows, so the
  // newest frame usually holds the status line and nothing else. Restricting
  // the parse to it (tried in 92cad48) lost the reply entirely — the acceptance
  // run caught it. A row's content ends at the next row marker or at the frame
  // close, which is what keeps a chunk's tail out of the row.
  const rows = new Map()
  const pattern = /\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|\x1b\[\?7h|$)/gu
  for (const match of text.matchAll(pattern)) {
    rows.set(Number(match[1]), plain(match[2] ?? ''))
  }
  return rows
}

/** Where `needle` is on the reconstructed screen: a 1-based row and cell column. */
function locateOnScreen(text, needle) {
  for (const [row, line] of screenRows(text)) {
    const at = line.indexOf(needle)
    if (at !== -1) return { row, column: at + 1 }
  }
  return undefined
}

async function synthesizeHome() {
  // `tmpdir()`, not `/tmp`: on Windows that literal is drive-relative (`C:\tmp`),
  // which need not exist, and `mkdtemp` does not create parents.
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-mock-'))
  const profile = join(home, 'profiles', 'tui')
  await mkdir(join(profile, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-tui-probe',
    private: true,
    dependencies: { 'dsh-ssh-tui': `link:${ROOT}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-ssh-tui'] } },
  }, null, 2)}\n`)
  await writeFile(join(profile, 'cordis.yml'), '[]\n')
  // The plugin's own patch layer: what a real install writes is a superset, but
  // the probe needs no roster to render a reply.
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  // A directory symlink needs SeCreateSymbolicLinkPrivilege on Windows; a
  // junction needs none and resolves identically (`ROOT` is absolute).
  await symlink(ROOT, join(profile, 'node_modules', 'dsh-ssh-tui'), IS_WINDOWS ? 'junction' : 'dir')
  return home
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
    // No lock or already gone.
  }
}

async function removeSessionDir(home, sessionId) {
  let entries
  try {
    entries = await readdir(join(home, 'sessions'), { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.isDirectory()) await rm(join(home, 'sessions', entry.name, sessionId), { recursive: true, force: true })
  }
}

/** The probe only runs against a home whose state lives in one tree. */
function assertHomeIsCoherent(home) {
  for (const name of ['sessions', 'tui-locks', 'tui-socks']) {
    try {
      if (lstatSync(join(home, name)).isSymbolicLink()) throw new Error(`${name} is a symlink`)
    } catch (error) {
      if (error instanceof Error && error.message === `${name} is a symlink`) throw error
    }
  }
}

/**
 * The console a pid is attached to, as Windows sees it — `[]` when it has none.
 *
 * A process can be attached to exactly one console, and the question can only be
 * asked from a process that is not: node-pty ships the agent that does
 * `FreeConsole`/`AttachConsole` + `GetConsoleProcessList` in a child, which is
 * the same call its own `kill()` uses to enumerate a pty's processes. `undefined`
 * means the question could not be asked at all (no node-pty, no agent).
 */
async function consoleProcessList(pid) {
  let agent
  try {
    agent = require.resolve('node-pty/lib/conpty_console_list_agent.js', { paths: [ROOT] })
  } catch {
    return undefined
  }
  return await new Promise(resolve => {
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const child = fork(agent, [String(pid)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(undefined)
    }, 10_000)
    child.once('message', message => {
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      const list = message?.consoleProcessList
      finish(Array.isArray(list) ? list.map(Number) : undefined)
    })
    child.once('error', () => { clearTimeout(timer); finish(undefined) })
    child.once('exit', () => { clearTimeout(timer); finish(undefined) })
  })
}

/** How the Host is started here — the hidden-console bootstrap, or a direct spawn. */
function usesHiddenConsoleBootstrap() {
  return hostBootstrapCommand({
    platform: process.platform,
    execPath: process.execPath,
    argv: ['probe-availability-check'],
    pidFile: join(tmpdir(), 'dsh-tui-mock-probe.pid'),
  }) !== undefined
}

/**
 * The busy drop: lose the terminal while a turn is in flight, then come back.
 *
 * This is the half `tui-drop-probe.mjs` cannot reach — it closes an *idle*
 * session, whose Host exits by policy. Two deaths, and on POSIX they promise the
 * same thing: the turn is running in a Host that was `setsid`'d, so it runs to
 * the end with nobody attached and the next window re-attaches to that same
 * process. The reconnected window then says what happened.
 *
 *   close   the terminal goes away under a running launcher (the user closed
 *           the window, the SSH link dropped).
 *   crash   the launcher process dies abruptly. On Windows both are the same
 *           call (`scripts/pty-window.mjs`) — no signals exist there — so the
 *           assertion is about the Host, never about the manner of death.
 *
 * Windows used to be unable to keep it: the Host there was spawned
 * *non-detached* on purpose (that is what keeps every tool call from flashing a
 * console window, because `detached: true` is DETACHED_PROCESS and Windows then
 * ignores the `CREATE_NO_WINDOW` that `windowsHide` sets), and libuv assigns a
 * non-detached child to its global job object, created with
 * `KILL_ON_JOB_CLOSE` — the launcher went, the job closed, the Host went with it.
 * P1-4 fixed that by starting the Host through the OS PowerShell with
 * `Start-Process -WindowStyle Hidden`, which gives it a console of its own,
 * invisible and outside this job (`hostBootstrapCommand`). So the same
 * assertions run on both platforms now, and Windows additionally proves the
 * *mechanism*: the Host is attached to a console, and it is not the launcher's.
 *
 * On a Windows box without PowerShell the bootstrap is unavailable and the
 * direct spawn is what runs — the old behaviour, deliberately kept as a
 * fallback. That is the one case where this probe asserts the fallback instead,
 * and it says so in the log.
 */
async function runBusyDrop({ pty, CLI, env, home, sessionId, firstWindow, crash, check, waitFor, delay, plain, output }) {
  firstWindow.write('describe the deployment\r')
  await waitFor(() => plain(output()).includes('BUSY-STREAM'), 60_000, 'the streamed reply to start')

  // The drop: no goodbye, no chance for the launcher to hand the terminal back.
  console.log(`window: ${windowDeathNote(crash ? 'crash' : 'close')}`)
  if (crash) crashWindow(firstWindow)
  else closeWindow(firstWindow)
  await delay(2_000)
  // The lock file alone is not proof: a Host that died leaves one behind. Ask
  // the pid whether it is still there. The 0.7.1 name and the digested name
  // both count.
  const lockPid = (await readLock(sessionId, home))?.lock?.pid ?? 0
  const survived = Number.isInteger(lockPid) && lockPid > 0 && isAlive(lockPid)
  console.log(`host after the drop: ${survived ? 'still running (lock held)' : 'gone'}`)
  const bootstrapped = !IS_WINDOWS || usesHiddenConsoleBootstrap()
  if (bootstrapped) {
    check(
      survived,
      `a busy ${crash ? 'crash' : 'window close'} must leave the Host running (pid ${lockPid} is gone)`,
    )
  } else {
    console.log(
      'note: no hidden-console bootstrap on this box (PowerShell not found), so the Host is a '
      + 'direct child and goes down with the launcher; asserting that instead of survival',
    )
    check(
      !survived,
      'without the bootstrap a closed window must not leave a Host behind holding the lock'
      + ` (pid ${lockPid} is still alive)`,
    )
  }

  if (IS_WINDOWS && bootstrapped && survived) {
    // Why the Host survived, not just that it did: it is attached to a console
    // of its own, and that console is not the launcher's. Without this the
    // survival assertion cannot tell the fix apart from a Host that simply has
    // no console at all — which would survive too, and bring back the flashing
    // console windows that the direct spawn exists to avoid. Only a human on a
    // real desktop can confirm the console is *invisible*; this proves it is
    // separate, which is the half that decides survival.
    const launcherConsole = await consoleProcessList(firstWindow.pid)
    const hostConsole = await consoleProcessList(lockPid)
    if (launcherConsole === undefined || hostConsole === undefined) {
      check(false, "the console-ownership check needs node-pty's console-list agent, which did not answer")
    } else {
      check(
        hostConsole.includes(lockPid),
        `the Host (pid ${lockPid}) must be attached to a console; got ${JSON.stringify(hostConsole)}`,
      )
      check(
        !hostConsole.includes(firstWindow.pid),
        "the Host must not share the launcher console: that is what a closed window takes down"
        + ` (launcher ${JSON.stringify(launcherConsole)}, host ${JSON.stringify(hostConsole)})`,
      )
      console.log(`consoles: launcher ${JSON.stringify(launcherConsole)}, host ${JSON.stringify(hostConsole)}`)
    }
  }

  const second = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: 'xterm-256color',
    cols: 110,
    rows: 32,
    cwd: home,
    env,
  })
  let secondOutput = ''
  second.onData(chunk => { secondOutput += chunk })
  try {
    await waitFor(() => secondOutput.includes('DeepSeek Harness'), 60_000, 'the boot banner in the new window')
    if (IS_WINDOWS) {
      // Nothing to re-attach to: this window boots a Host from the log, so there
      // is no gap for a "reconnected" line to report and the partial stream
      // (never flushed) is not in the transcript either. Durability is the
      // promise that still holds on this platform.
      await waitFor(
        () => /空闲|idle/u.test(plain(secondOutput)),
        60_000,
        'the idle status line in the new window',
      )
      check(
        plain(secondOutput).includes('describe the deployment'),
        'the session log must replay what the closed window left behind;'
        + ` screen tail: ${JSON.stringify(plain(secondOutput).slice(-300))}`,
      )
    } else {
      await waitFor(() => plain(secondOutput).includes('已重连 1 次'), 30_000, 'the reconnect notice')
      check(plain(secondOutput).includes('已重连 1 次'), 'the resumed window must say the user was away')
      // The turn kept running in the Host while nobody was attached, so its
      // output is in the transcript the new window repaints.
      check(
        plain(secondOutput).includes('BUSY-STREAM'),
        'the turn that kept running during the gap must be in the repainted transcript',
      )
      const notice = plain(secondOutput).split('\n').find(line => line.includes('已重连 1 次'))
      console.log(`reconnect notice: ${notice?.trim().slice(0, 80)}`)
    }

    second.write('\x15')
    second.write('/exit\r')
    const exitCode = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), 15_000)
      second.onExit(({ exitCode: code }) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    check(exitCode === 0, `the resumed window must exit on /exit (got ${exitCode ?? 'no exit'})`)
  } finally {
    try { second.kill() } catch { /* already gone */ }
  }
}

async function runProbe({ keep, busy, crash, cols, rows }) {
  const pty = await loadModule('node-pty')
  if (pty === undefined) {
    console.log('SKIP: node-pty is unavailable, so the TUI cannot be driven on a PTY here')
    return 0
  }
  const mockModule = await loadModule('@deepseek-ai/dsh-llm-mock-server')
  if (mockModule === undefined || typeof mockModule.startMockLlmServer !== 'function') {
    console.log('SKIP: @deepseek-ai/dsh-llm-mock-server is not installed')
    return 0
  }

  const home = await synthesizeHome()
  assertHomeIsCoherent(home)
  // Busy-drop scenario: the turn is a slow stream, so it is genuinely in flight
  // when the window dies — the state the keep-alive policy exists for.
  const mock = await mockModule.startMockLlmServer(busy
    ? {
        port: 0,
        apiKey: 'sk-tui-mock-probe',
        // A slow stream keeps the turn genuinely in flight while the window dies
        // — the state the keep-alive policy exists for.
        sequence: ['slow_success'],
        successText: `BUSY-STREAM ${'streaming '.repeat(80)}end`,
        chunkSize: 4,
        chunkDelayMs: 120,
        repeatLast: true,
      }
    : {
        port: 0,
        apiKey: 'sk-tui-mock-probe',
        sequence: ['success'],
        successText: REPLY_TEXT,
        repeatLast: true,
      })
  const sessionId = `main-session-${randomUUID()}`
  const env = {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
    DEEPSEEK_BASE_URL: mock.baseURL,
    DEEPSEEK_API_KEY: 'sk-tui-mock-probe',
    // The probe asserts reverse video, so the run has to be a colour terminal:
    // inheriting NO_COLOR — or a `DSH_TUI_COLOR_DEPTH=none` from the caller —
    // would silently switch to the `»` marker path, which is the correct
    // behaviour for a monochrome terminal and the wrong assertion for this one.
    NO_COLOR: '',
    DSH_TUI_COLOR_DEPTH: 'truecolor',
  }
  console.log(`probe home: ${home}${keep ? ' (kept)' : ''}`)
  console.log(`probe session: ${sessionId}`)
  console.log(`mock model: ${mock.baseURL}`)

  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: home,
    env,
  })
  let output = ''
  term.onData(chunk => { output += chunk })

  const waitFor = async (predicate, timeoutMs, what) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(output)) return
      await delay(50)
    }
    throw new Error(`timed out waiting for ${what}\n--- captured ---\n${plain(output).slice(-1500)}`)
  }
  const waitForExit = async timeoutMs => new Promise(resolve => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs)
    term.onExit(({ exitCode }) => {
      clearTimeout(timer)
      resolve(exitCode)
    })
  })

  const problems = []
  const check = (condition, message) => { if (!condition) problems.push(message) }

  try {
    // 1. Boot, then start a real turn against the scripted model.
    await waitFor(text => text.includes('DeepSeek Harness'), 60_000, 'the boot banner')
    await waitFor(text => /空闲|idle/u.test(text), 60_000, 'the idle status line')

    if (busy) {
      await runBusyDrop({
        pty, CLI, env, home, sessionId, output: () => output, firstWindow: term, crash,
        check, waitFor, delay, plain,
      })
      // The verdict is printed here too: returning straight out of the scenario
      // would skip it, and a probe that swallows its own failures is worse than
      // no probe.
      if (problems.length > 0) {
        console.error('FAIL')
        for (const problem of problems) console.error(`  - ${problem}`)
        return 1
      }
      console.log(IS_WINDOWS
        ? `OK: the window ${crash ? 'crash' : 'close'} left no Host behind, and the session came back from its log`
        : `OK: a turn survived the window ${crash ? 'being killed mid-flight' : 'closing mid-flight'},`
          + ' and the resumed window reported it')
      return 0
    }

    term.write('describe the deployment\r')
    await waitFor(text => plain(text).includes(REPLY_TOKEN), 60_000, 'the scripted reply')
    console.log('reply painted')

    // 2. `/find` must mark the token, not the card.
    const beforeFind = output.length
    term.write(`/find ${REPLY_TOKEN}\r`)
    await waitFor(
      text => /\x1b\[7m[^\x1b]*TOKEN-ALPHA-9/u.test(text.slice(beforeFind)),
      20_000,
      'the highlighted match',
    )
    const findSlice = output.slice(beforeFind)
    const highlighted = [...findSlice.matchAll(/\x1b\[7m([\s\S]*?)\x1b\[27m/gu)].map(m => plain(m[1] ?? ''))
    check(
      highlighted.includes(REPLY_TOKEN),
      `/find must highlight the token itself, got ${JSON.stringify(highlighted)}`,
    )
    check(
      highlighted.every(span => span.trim() === REPLY_TOKEN || span.includes(REPLY_TOKEN)),
      `/find must not highlight more than the match: ${JSON.stringify(highlighted)}`,
    )

    // 3. Drag across the reply: press on the token, move right, release.
    const at = locateOnScreen(output, REPLY_TOKEN)
    check(at !== undefined, 'the reply must be locatable on the painted screen')
    if (at !== undefined) {
      // Nine cells past the token: the copy must be the dragged range itself,
      // not the line it sits on.
      const dragTail = ' --dry-ru'
      const DRAGGED = `${REPLY_TOKEN}${dragTail}`
      const endColumn = at.column + REPLY_TOKEN.length + dragTail.length
      const beforeDrag = output.length
      term.write(`\x1b[<0;${at.column};${at.row}M`)
      await delay(60)
      term.write(`\x1b[<32;${endColumn};${at.row}M`)
      await delay(120)
      term.write(`\x1b[<0;${endColumn};${at.row}m`)
      await waitFor(text => /52;[^;]*;[A-Za-z0-9+/=]+\x1b/u.test(text.slice(beforeDrag)), 15_000, 'the drag clipboard write')
      const copied = clipboardWrites(output.slice(beforeDrag))
      check(
        copied.includes(DRAGGED),
        `the drag must copy exactly what it covered (${JSON.stringify(DRAGGED)}),`
        + ` got ${JSON.stringify(copied.map(t => t.slice(0, 80)))}`,
      )
      check(
        copied.every(text => !text.includes('DeepSeek Harness')),
        'the drag must not copy the chrome',
      )
      console.log(`drag copied: ${JSON.stringify(copied.at(-1)?.slice(0, 90))}`)
    }

    // 4. The window still exits on its own terms.
    term.write('\x15')
    term.write('/exit\r')
    const exitCode = await waitForExit(15_000)
    check(exitCode === 0, `the probe window must exit on /exit (got ${exitCode ?? 'no exit within 15s'})`)
  } catch (error) {
    problems.push(String(error.message ?? error))
  } finally {
    try { term.kill() } catch { /* already gone */ }
    await mock.close().catch(() => {})
    if (!keep) {
      await killHostByLock(sessionId, home)
      await removeSessionDir(home, sessionId)
      // Best-effort: on Windows a Host that is still tearing down can hold the
      // directory (EBUSY/EPERM), and failing the probe on its own cleanup would
      // hide the verdict it just printed.
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
        .catch(error => console.log(`(left ${home} behind: ${error.code ?? error.message})`))
    }
  }

  if (problems.length > 0) {
    console.error('FAIL')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('OK: a scripted turn was copied by dragging, and /find marked the match itself')
  return 0
}

function parseArgs(argv) {
  const parsed = { keep: false, busy: false, crash: false, cols: 110, rows: 32 }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--keep') parsed.keep = true
    else if (arg === '--busy') parsed.busy = true
    else if (arg === '--crash') parsed.crash = true
    else if (arg === '--cols') parsed.cols = Number(argv[++index]) || 110
    else if (arg === '--rows') parsed.rows = Number(argv[++index]) || 32
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${arg}\n${USAGE}`)
      process.exit(2)
    }
  }
  return parsed
}

process.exit(await runProbe(parseArgs(process.argv.slice(2))))
