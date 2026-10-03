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
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { createRequire } from 'node:module'
import { isFormsVersion } from './host-line.mjs'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
/**
 * Whether this is a 0.1.7-or-later host, which composes its agent process-wide
 * and has no terminal preset roster. Read from the launcher itself rather than
 * sniffed from the UI: the probe's preset assertions differ by host line.
 */
const FORMS_HOST = isFormsVersion(require('@deepseek-ai/dsh/package.json').version)
// `import()` needs a URL, not a path: on Windows `D:\…` is rejected with
// ERR_UNSUPPORTED_ESM_URL_SCHEME, which is what the first Windows CI run hit.
const { sessionLockLookupPaths } = await import(
  pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../lib/session-lock.js')).href,
)

const USAGE = `usage: node scripts/tui-probe.mjs [--session <id>] [--keep] [--home <dir>]

  (no args)        boot a throwaway session, resize, /diag, type, /exit
  --session <id>   resume an existing session instead of creating one
  --keep           leave the host running after the probe
  --home <dir>     DSH_HOME to probe (default: $PROBE_HOME / $DSH_HOME / ~/.dsh)
  --line-mode      run with DSH_TUI_LINE_MODE=1 and assert plain appended lines
                   (no alternate screen, no cursor addressing, no repaint)

Set PROBE_HOME to a throwaway tree to keep the probe away from real sessions.`

/** Control sequences the probe watches for. */
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu

/**
 * The status row as the terminal received it.
 *
 * Rows are addressed absolutely and a frame carries no newlines, so the stream is
 * split on the cursor-position sequences rather than on lines: the last newline-
 * delimited chunk is the whole screen and would match anything.
 */
/**
 * The status row, off the screen the terminal holds.
 *
 * Splitting the raw stream on *absolute addresses* was enough while a frame addressed
 * every row exactly once. The painter now hands the caret back after each row it writes
 * (so an IME cannot draw its pre-edit on a content row), which means a chunk between two
 * addresses is not necessarily one row — a multi-line logo row arrives with newlines
 * inside it, and the "row" that came back was a blob containing the logo, the composer
 * and the footer. Reconstructing the screen (`screenRows`) and taking the last row that
 * looks like the status row is what the assertion is actually about.
 */
function statusRowOf(buffer) {
  const chunks = buffer
    .split(/\x1b\[\d+;\d+H/u)
    .map(plain)
    .map(line => line.replace(/\s+$/u, ''))
    .filter(line => /\bSSH\b|本机|本地|local/u.test(line) && (line.includes('│') || line.includes('|')))
  // A chunk is usually one row: the split is on cursor addresses, and the painter
  // addresses every row it writes. The *first* frame of a session arrives as one batch
  // with its rows separated by newlines, and that batch contains the status row too —
  // taking it returned a whole screen (logo, composer, footer) as "the row", which is
  // what the Windows leg reported. Single-line matches win; the batch is the fallback
  // for a terminal whose frames only arrive that way.
  const single = chunks.filter(line => !line.includes('\n'))
  return (single.length > 0 ? single : chunks).at(-1) ?? ''
}

/**
 * The screen as the terminal holds it, rebuilt from the byte stream.
 *
 * The painter addresses rows absolutely (`\x1b[<row>;1H`) and a later write wins,
 * so the whole session's output reconstructs the current screen — which is what an
 * assertion about "what the reader sees" needs when the frame that follows does not
 * re-emit an unchanged row.
 */
function screenRows(text) {
  const rows = new Map()
  const pattern = /\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|\x1b\[\?7h|$)/gu
  for (const match of text.matchAll(pattern)) rows.set(Number(match[1]), plain(match[2] ?? ''))
  return rows
}

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
    const mod = await import(pathToFileURL(resolved).href)
    return mod.default ?? mod
  } catch {
    return undefined
  }
}

/**
 * Kill the detached Host this probe spawned, using the pid from its tui-lock.
 * The Host installs SIGTERM/SIGHUP ignores at startup, so only SIGKILL works.
 */
async function readLock(sessionId, home) {
  for (const path of sessionLockLookupPaths(sessionId, home)) {
    try {
      return JSON.parse(await readFile(path, 'utf8'))
    } catch {
      // Missing at this name; try the 0.7.1 leftover next.
    }
  }
  return undefined
}

async function killHostByLock(sessionId, home) {
  try {
    const lock = await readLock(sessionId, home)
    if (Number.isInteger(lock?.pid) && lock.pid > 0) process.kill(lock.pid, 'SIGKILL')
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

/**
 * Decode every OSC 52 clipboard write the terminal received. `/copy` and the
 * drag-select both end here, so this is the only place that proves the text
 * actually reached the wire rather than just the in-app state.
 */
function clipboardWrites(text) {
  const out = []
  const pattern = /\x1b\]52;[^;]*;([A-Za-z0-9+/=]*)\x1b\\/gu
  for (const match of text.matchAll(pattern)) {
    const payload = match[1] ?? ''
    if (payload === '') continue
    try {
      out.push(Buffer.from(payload, 'base64').toString('utf8'))
    } catch {
      // A malformed payload is the assertion's problem, not the parser's.
    }
  }
  return out
}

async function runProbe({ sessionId, keep, home, lineMode }) {
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
    ...(lineMode === true ? { DSH_TUI_LINE_MODE: '1' } : {}),
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

    if (lineMode === true) {
      // Line mode never paints, so its assertions a    if (lineMode === true) {
      // Line mode never paints, so its assertions are about the shape of the
      // stream: text appended, nothing that moves a cursor, and events the
      // framed painter would have coalesced still present.
      const beforeDiag = output.length
      term.write('/diag\r')
      await waitFor(
        text => /判定链|verdict chain/u.test(text.slice(beforeDiag)),
        30_000,
        'the /diag lines in line mode',
      )
      check(!output.includes('\x1b[?1049h'), 'line mode must not use the alternate screen')
      check(!/\x1b\[\d+;\d+H/u.test(output), 'line mode must not address rows absolutely')
      // `\r\n` is an ordinary newline; a *bare* carriage return is what overwrites the line just written.
      check(!/\r(?!\n)/u.test(output), 'line mode must not use a bare carriage return')
      check(plain(output).includes('DeepSeek Harness'), 'the boot banner still reaches the terminal')
      term.write('\x15')
      term.write('/exit\r')
      const code = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(undefined), 15_000)
        term.onExit(({ exitCode }) => {
          clearTimeout(timer)
          resolve(exitCode)
        })
      })
      check(code === 0, `line mode must exit on /exit (got ${code ?? 'no exit within 15s'})`)
      if (problems.length > 0) {
        console.error('FAIL')
        for (const problem of problems) console.error(`  - ${problem}`)
        return 1
      }
      console.log('OK: line mode appended the session as plain lines, with no cursor control')
      return 0
    }

    await waitFor(text => /空闲|idle/u.test(text), 60_000, 'the idle status line')
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

    // 2b. The frame must follow the terminal's *current* geometry, both ways.
    //
    // A Host composing rows for a width the terminal no longer has is not a
    // cosmetic problem: the columns it still believes in keep whatever was there
    // before, so half the screen stays stale while the other half is repainted —
    // the "window grew and the layout looks half-scaled" report. The relay used
    // to re-send the size it captured at attach, which meant the Host never heard
    // about a resize at all; these reads are what catches that class.
    const sweep = []
    for (const [columns, rows] of [[60, 20], [120, 30], [60, 20], [120, 30]]) {
      const mark = output.length
      term.resize(columns, rows)
      await new Promise(resolve => setTimeout(resolve, 1_000))
      const bytes = output.length - mark
      sweep.push({ columns, bytes, row: statusRowOf(output) })
      check(bytes > 0, `the resize to ${columns}x${rows} produced no repaint`)
      check(sweep.at(-1).row !== '', `no status row after resizing to ${columns}x${rows}`)
    }
    // A wider terminal paints a bigger frame; identical byte counts at 60 and 120
    // columns would mean the Host is still composing for one fixed width.
    check(
      sweep[1].bytes > sweep[0].bytes,
      `the frame must scale with the terminal: ${sweep[0].bytes} bytes at 60 columns,`
      + ` ${sweep[1].bytes} at 120`,
    )
    check(
      sweep[0].row === sweep[2].row && sweep[1].row === sweep[3].row,
      'returning to a size must reproduce the same status row'
      + ` (60: ${JSON.stringify(sweep[0].row)} vs ${JSON.stringify(sweep[2].row)},`
      + ` 120: ${JSON.stringify(sweep[1].row)} vs ${JSON.stringify(sweep[3].row)})`,
    )
    console.log(`resize sweep: ${sweep.map(entry => `${entry.columns}→${entry.bytes}B`).join(' ')}`)

    // 3. /diag answers with the local facts, including the verdict chain.
    //    Since B2.1 a report is a **Screen**: it replaces the workspace, owns the
    //    keyboard and writes nothing to the transcript (AD-7). Typing while one is
    //    up reaches the Screen, not the composer — so every report step below ends
    //    with Esc, which is also what puts the workspace back.
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
    check(/Esc 返回|Esc to return/u.test(diag), 'the Screen must say how to leave it')
    check(/空闲|运行中|idle|running/u.test(diag), 'and keep the runtime strip: is the agent still working')
    // Dismissed with Esc: the workspace comes back, and no report row was written.
    term.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 600))
    check(
      // Asked as "which came last", not "is there a position line in the last N
      // characters": a frame is denser now (the caret returns after every row), so a fixed
      // window can still hold the *previous* Screen's line while the Screen itself is
      // gone, and a reconstructed screen can hold a row the next frame did not repaint.
      // The composer is what the workspace puts back, and it must be the newer of the two.
      (() => {
        const tail = plain(output.slice(beforeDiag))
        const lastPosition = tail.lastIndexOf('全文 ')
        if (lastPosition === -1) return true
        const lastComposer = Math.max(tail.lastIndexOf('╭'), tail.lastIndexOf('❯'))
        return lastComposer > lastPosition
      })(),
      `Esc must leave the report Screen: ${JSON.stringify(plain(output.slice(-200)))}`,
    )

    // 4. /doctor judges the deployment composition, read-only: a report with a
    //    status mark per check and the patch path it read.
    const beforeDoctor = output.length
    term.write('/doctor\r')
    await waitFor(text => {
      const slice = text.slice(beforeDoctor)
      return slice.includes('部署体检') || slice.includes('deployment checkup')
    }, 30_000, 'the /doctor report')
    const doctor = plain(output.slice(beforeDoctor))
    for (const variants of [['结论', 'verdicts'], ['profile 补丁', 'profile patch']]) {
      check(variants.some(needle => doctor.includes(needle)), `/doctor output must mention ${variants.join(' / ')}`)
    }
    check(/[●⚠✖]/u.test(doctor), '/doctor must print a status mark for its checks')
    check(/cordis\.patch\.yml/u.test(doctor), '/doctor must name the profile patch it read')

    // 4b. The copy key reaches the clipboard *from inside the Screen*: it carries
    //     what the Screen shows, which is the report. (Before B2.1 this step typed
    //     `/copy error` at the prompt and read the row the report left behind; the
    //     report no longer leaves one, so the key is now the only way to it — and
    //     the key exists precisely because a Screen covers the input line.)
    const beforeCopy = output.length
    term.write('\x1b[99;6u')
    // The clipboard write is immediate; the Screen's confirmation rides the next
    // painted frame, which the link tier may hold for up to one interval.
    await new Promise(resolve => setTimeout(resolve, 800))
    await waitFor(text => /52;[^;]*;[A-Za-z0-9+/=]+\x1b/u.test(text.slice(beforeCopy)), 20_000, 'the OSC 52 write')
    const copied = clipboardWrites(output.slice(beforeCopy))
    check(copied.length >= 1, 'the copy key inside a Screen must send an OSC 52 write')
    check(
      copied.some(text => /profile 补丁|profile patch|部署体检|deployment checkup/u.test(text)),
      `it must send the report the Screen shows, got: ${JSON.stringify(copied.map(t => t.slice(0, 60)))}`,
    )
    // The Screen says the copy happened: the notice row it would otherwise push is
    // behind the Screen, so silence would read as a failure.
    check(
      /已复制|copied/u.test(plain(output.slice(beforeCopy))),
      'the Screen must confirm the copy on its own row',
    )
    term.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 500))

    // 4c. The mouse modes a drag needs are on the real terminal: `?1000h` alone
    //     reports presses, so a drag would be invisible without `?1002h`.
    check(output.includes('\x1b[?1000h'), 'the probe terminal must be asked for mouse presses')
    check(output.includes('\x1b[?1002h'), 'and for held-button motion, without which a drag never arrives')

    // 5. /preset lists the roster read-only. The bare command opens the
    //    wizard (an interactive picker), so the probe drives the explicit
    //    subcommand: it never writes, which makes it safe on a real profile,
    //    and it proves the authoring surface sees the same presets /mode does.
    //
    //    0.1.7 has no roster for a terminal profile at all (presets became
    //    per-session declarations a surface composes), so there the assertion
    //    is the opposite one: /preset must say so, and must not send the user
    //    after rows that host cannot resolve.
    const beforePreset = output.length
    term.write('/preset list\r')
    if (FORMS_HOST) {
      await waitFor(text => {
        const slice = plain(text.slice(beforePreset))
        return slice.includes('进程级组合代理') || slice.includes('process-wide')
      }, 30_000, 'the /preset missing-service notice')
      const preset = plain(output.slice(beforePreset))
      check(/进程级组合代理|process-wide/u.test(preset), '/preset must explain why this host has no roster')
      check(!/dsh-agent-presets|code-runtime-worker-thread/u.test(preset),
        '/preset must not point at rows 0.1.7 cannot resolve')
    } else {
      await waitFor(text => {
        const slice = text.slice(beforePreset)
        return slice.includes('Agent presets') || slice.includes('preset authoring')
      }, 30_000, 'the /preset list')
      const preset = plain(output.slice(beforePreset))
      check(/Agent presets/u.test(preset), '/preset must print the roster')
      check(/standard/u.test(preset), '/preset must name the shipped presets')
      check(/preset show|\/preset/u.test(preset), '/preset output must show its surface')
    }

    // 5b. /preset show reads one composition through the host's inventory.
    //      There is no composition to read without a roster, which is 5's
    //      branch on a 0.1.7 host.
    if (!FORMS_HOST) {
      const beforeShow = output.length
      term.write('/preset show standard\r')
      // The report is long enough that its title scrolls out of the painted
      // viewport, so the rows themselves are the arrival signal.
      await waitFor(text => /@deepseek-ai\//u.test(text.slice(beforeShow)), 30_000, 'the /preset show rows')
      const shown = plain(output.slice(beforeShow))
      check(/@deepseek-ai\//u.test(shown), '/preset show must list the composition rows')
    }

    // 6. Typing still reaches the input line after all of that.
    const beforeTyping = output.length
    term.write('hello probe')
    await waitFor(text => plain(text.slice(beforeTyping)).includes('hello probe'), 15_000, 'typed text on the prompt')

    // 6b. The live tail: a streamed reply must arrive as many small frames, not as a
    //     series of full clears.
    //
    // Until B2.2 the streaming text was appended to the transcript's own source
    // lines, so every tick moved the window one line and took the `sizeChanged`
    // path — one `\x1b[H\x1b[J` and a whole frame per tick, for as long as the model
    // was writing. This step submits a prompt and measures what the link actually
    // received while the answer was being produced.
    {
      const beforeReply = output.length
      term.write('\r')
      await waitFor(
        text => /回复中|思考中|处理中|运行中|空闲|idle|replying|thinking/u.test(plain(text.slice(beforeReply))),
        15_000,
        'the live activity row while the answer streams',
      )
      // Let the answer stream and settle: the step then measures a window that
      // certainly contains several ticks.
      await new Promise(resolve => setTimeout(resolve, 6_000))
      const streamed = output.slice(beforeReply)
      const clears = [...streamed.matchAll(/\x1b\[H\x1b\[J|\x1b\[2J/gu)].length
      const addressed = [...streamed.matchAll(/\x1b\[\d+;1H/gu)].length
      console.log(`live stream: ${addressed} row writes, ${clears} full clears, ${Buffer.byteLength(streamed)}B`)
      check(addressed > 0, 'the streaming answer must reach the wire')
      // A full clear is allowed for the *settle* (the durable append follows the
      // tail), and for a size change — never once per tick.
      check(
        clears <= 4,
        `streaming must not clear per tick (${clears} clears for ${addressed} row writes)`,
      )
      check(
        addressed >= clears * 4,
        `most of the stream must be incremental (${clears} clears vs ${addressed} row writes)`,
      )
    }

    // 6c. A task interaction is a layer over the transcript, not a piece of it.
    //
    // The observable difference on the wire is the *shape* of a repaint while the
    // interaction is up. Before B1.1 the dialog lived in the transcript's own
    // budget, so every change to it re-windowed the viewport and the frame carried
    // a full clear and every row. Now the layer owns the rows above the composer and
    // nothing else: moving the selection paints those rows, from the layer's top
    // down. (Asking the *first* time also appends the question's card, and that
    // append is an ordinary transcript event — the transcript follow it triggers is
    // not the layer's doing, so the assertions here start after the dialog is up.)
    // `/dialog-test` asks through the real question service, so this needs no model.
    {
      const beforeAsk = output.length
      term.write('\x15/dialog-test\r')
      await waitFor(text => text.slice(beforeAsk).includes('Option A'), 30_000, 'the test question dialog')
      check(
        plain(output.slice(beforeAsk)).includes('Enter'),
        'the dialog must reach the terminal with its key hint',
      )

      const beforeMove = output.length
      term.write('\x1b[B')
      await new Promise(resolve => setTimeout(resolve, 500))
      const moving = output.slice(beforeMove)
      const movedRows = [...moving.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1]))
      check(movedRows.length > 0, 'moving the selection must repaint the layer')
      check(
        movedRows.length <= 12,
        `moving the selection must repaint only the layer (${movedRows.length} rows addressed)`,
      )
      check(
        movedRows.every(row => row >= 5),
        `the repaint must start at the layer, not at the top of the frame (rows ${movedRows.join(',')})`,
      )
      check(
        !/\x1b\[[HJ]|\x1b\[2J/u.test(moving),
        `moving the selection must not clear the screen: ${JSON.stringify(plain(moving).slice(0, 120))}`,
      )

      // Answering closes the layer: the status row leaves the waiting state, and
      // the card the Session keeps says what was answered.
      const beforeAnswer = output.length
      term.write('\r')
      await waitFor(
        text => /已回答|answered/gu.test(plain(text.slice(beforeAnswer))),
        30_000,
        'the answered question card',
      )
      check(
        !/等待回答|waiting/u.test(statusRowOf(output)),
        `the status row must stop saying the task is waiting: ${JSON.stringify(statusRowOf(output))}`,
      )
      await new Promise(resolve => setTimeout(resolve, 300))
      check(
        /dialog answer/u.test(plain(output.slice(beforeAnswer))),
        'the answer must come back through the question service',
      )
    }

    // 6d. A control-plane picker is the same kind of layer (B1.2).
    //
    // `/view` is a menu the plugin opens for itself: nobody is blocked on it and
    // answering it changes the environment, not the task. On the wire it must look
    // like the interaction above — a localised repaint from its own top, no clear,
    // and the composer's boundary still drawn under it.
    {
      const beforeMenu = output.length
      term.write('\x15/view\r')
      await waitFor(text => text.slice(beforeMenu).includes('工作区视图'), 30_000, 'the /view menu')
      check(
        plain(output.slice(beforeMenu)).includes('Enter'),
        'the menu must reach the terminal with its key hint',
      )
      // On the *screen*, not in this frame's bytes: the boundary is unchanged by the
      // menu opening (a layer replaces rows above it), and a row whose content did
      // not change is not rewritten (B2.4 stopped force-repainting the composer
      // rows at all, because the caret and an IME's pre-edit live there). What must
      // hold is that the reader still sees it.
      check(
        [...screenRows(output).values()].some(line => line.includes('╭')),
        'the composer boundary must be on screen with the menu up',
      )

      const beforeMove = output.length
      term.write('\x1b[B')
      await new Promise(resolve => setTimeout(resolve, 500))
      const moving = output.slice(beforeMove)
      const movedRows = [...moving.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1]))
      check(movedRows.length > 0, 'moving the menu highlight must repaint the layer')
      check(
        movedRows.length <= 12,
        `moving the menu highlight must repaint only the layer (${movedRows.length} rows addressed)`,
      )
      check(
        movedRows.every(row => row >= 3),
        `the menu repaint must start at the layer, not at the top of the frame (rows ${movedRows.join(',')})`,
      )
      check(
        !/\x1b\[[HJ]|\x1b\[2J/u.test(moving),
        `moving the menu highlight must not clear the screen: ${JSON.stringify(plain(moving).slice(0, 120))}`,
      )

      // Escape closes it and the transcript rows come back where they were: the
      // menu never owned them, so closing is a repaint, not a re-window. The one
      // thing allowed to clear the screen is a durable transcript row — cancelling
      // a command writes "模式选择已取消。", and that append is ordinary tail-follow
      // (the same rule B1.1 left alone), not the layer coming down.
      const beforeClose = output.length
      term.write('\x1b')
      await new Promise(resolve => setTimeout(resolve, 600))
      const closing = output.slice(beforeClose)
      const cleared = /\x1b\[[HJ]|\x1b\[2J/u.test(closing)
      const appended = /模式选择已取消/u.test(plain(closing))
      check(
        !cleared || appended,
        `closing the menu must not clear the screen unless a durable row was appended: ${JSON.stringify(plain(closing).slice(0, 160))}`,
      )
      console.log(`menu close: ${cleared ? 'cleared (the cancel notice was appended)' : 'partial repaint'}`)
      check(
        appended,
        'cancelling the menu must report itself, so the clear above has a reason',
      )
      check(
        !/等待回答|waiting/u.test(statusRowOf(output)),
        `a menu must not make the task read as waiting: ${JSON.stringify(statusRowOf(output))}`,
      )
      check(
        !/工作区视图/u.test(plain(closing.slice(-4000))),
        'the menu must be gone from the last frame it painted',
      )
    }

    // 6e. A report Screen owns the screen, and its navigation is incremental.
    //
    // This is the B2.1 claim on the wire: opening a Screen may establish the whole
    // frame (the terminal holds an unrelated picture), but *navigating* one must
    // repaint the rows that changed and never clear the screen — the previous
    // inspect overlay passed `sizeChanged: true` on every frame, so every arrow key
    // cost a full clear and a full frame on a weak link.
    {
      // `/help` on purpose: its body is longer than a 30-row terminal's viewport,
      // so PgDn actually moves. (`/status` fits whole, and a page that cannot move
      // correctly paints nothing — which is what this step first measured.)
      const beforeScreen = output.length
      term.write('/help\r')
      await waitFor(text => /全文 \d+–\s?\d+\/\d+|full \d+–\s?\d+\/\d+/u.test(plain(text.slice(beforeScreen))), 30_000, 'the /status Screen')
      const opened = output.slice(beforeScreen)
      check(
        /空闲|运行中|idle|running/u.test(plain(opened)),
        'the Screen must carry the compact runtime strip',
      )
      check(
        /Esc 返回|Esc to return/u.test(plain(opened)),
        'and say how to leave it',
      )

      // One page down: the body moves, the chrome does not.
      const beforeScroll = output.length
      term.write('\x1b[6~')
      await new Promise(resolve => setTimeout(resolve, 700))
      const scrolled = output.slice(beforeScroll)
      const scrolledRows = [...scrolled.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1]))
      check(scrolledRows.length > 0, 'PgDn must repaint the Screen body')
      check(
        scrolledRows.length <= 28,
        `PgDn must repaint the body, not the frame (${scrolledRows.length} rows addressed)`,
      )
      check(
        scrolledRows.every(row => row >= 3),
        `the repaint must start at the body, never at the title (rows ${scrolledRows.join(',')})`,
      )
      check(
        !/\x1b\[[HJ]|\x1b\[2J/u.test(scrolled),
        `scrolling a Screen must not clear it: ${JSON.stringify(plain(scrolled).slice(0, 120))}`,
      )
      console.log(`screen scroll: ${scrolledRows.length} rows, ${Buffer.byteLength(scrolled)}B, no clear`)

      // A resize while a Screen is up: the Screen re-lays out at the new geometry.
      const beforeResize = output.length
      term.resize(72, 24)
      await new Promise(resolve => setTimeout(resolve, 700))
      const resized = plain(output.slice(beforeResize))
      check(
        /全文 \d+–\s?\d+\/\d+|full \d+–\s?\d+\/\d+/u.test(resized),
        `the Screen must survive a resize: ${JSON.stringify(resized.slice(-200))}`,
      )
      // Back to the size the rest of the probe expects.
      term.resize(100, 30)
      await new Promise(resolve => setTimeout(resolve, 700))

      // Esc hands the workspace back: the composer row and the two footer rows are
      // the workspace's own, and the Screen's readout is gone.
      const beforeExit = output.length
      term.write('\x1b')
      await new Promise(resolve => setTimeout(resolve, 800))
      const back = plain(output.slice(beforeExit))
      check(
        !/全文 \d+–\s?\d+\/\d+/u.test(back),
        `Esc must close the Screen: ${JSON.stringify(back.slice(-160))}`,
      )
      check(
        /❯|>/u.test(back),
        `the composer must come back with the workspace: ${JSON.stringify(back.slice(-160))}`,
      )
    }

    // 7. `/exit` hands the terminal back. The launcher's graceful shutdown only
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
      // Ctrl+U clears the composer; step 6 left the probe text in it, and
      // `hello probe/exit` submits a message instead of running the command.
      term.write('\x15')
      term.write('/exit\r')
    })
    // A timeout here has two very different shapes — the command never ran, or
    // it ran and the launcher stayed up — and the bare timeout alone cannot tell
    // them apart. The screen at that moment can: the composer still holding the
    // text means the key never reached the command path, a dialog or an overlay
    // means something swallowed it, and a prompt back with the process alive is
    // the lingering-handle shape this step exists to catch.
    const exitTail = exitCode === undefined
      ? `\n--- screen at the timeout ---\n${plain(output.slice(beforeExit)).split('\n').slice(-8).join('\n')}`
      : ''
    check(exitCode === 0, `the launcher exited on /exit (got ${exitCode === undefined ? 'no exit within 15s' : exitCode})${exitTail}`)
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
  console.log('OK: boot, resize repaint, /diag, /doctor, /copy error, /preset, mouse modes, the interaction layer, the picker layer, typing, the Screen reports, and the /exit handback all behaved')
  return 0
}

function parseArgs(argv) {
  const parsed = {
    sessionId: undefined,
    keep: argv.includes('--keep'),
    lineMode: argv.includes('--line-mode'),
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
