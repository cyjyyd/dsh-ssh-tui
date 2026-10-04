#!/usr/bin/env node
/**
 * The link chip when nothing was ever measured — the one shape a ConPTY cannot
 * show, and the one readers reported twice.
 *
 * From the field, with `/diag`: Linux + xterm-256color over SSH, `探测 未知（终端
 * 未回 DSR）`. The terminal does not answer `CSI 6n`, so no round trip is ever
 * measured and the chip sat on `SSH ○○○○ 160ms` — a *paint cadence* printed in
 * the slot where a latency goes, which reads as "160ms away". Two reports came
 * from that ambiguity; `52417b9` made the slot say `未测` / `n/a` instead and kept
 * the cadence on its own `/diag` row.
 *
 * Why this probe exists next to `tui-rtt-probe.mjs`: the PTY probes cannot reach
 * this state on Windows at all. ConPTY answers `CSI 6n` itself, so the probe never
 * sees the request and cannot play a terminal that stays silent (the PTY probe
 * says so and skips that phase). A parent that relays stdin/stdout
 * (`DSH_TUI_DISPLAY=stdio`) *is* the terminal, so it decides — and that is the
 * shape the field report came from. This probe therefore runs two legs against
 * the same throwaway home:
 *
 *   silent   no answer to any `CSI 6n` → `SSH ○○○○ 未测`, `/diag` says 未知
 *   answered one answer per request   → `SSH ●●●● <n>ms`, `/diag` says 已测量
 *
 * The second leg is not decoration: without it, a chip that always said `未测`
 * would pass the first one.
 *
 * Usage:
 *   node scripts/probe-home.mjs --probe --script tui-unmeasured-probe.mjs
 *   PROBE_HOME=~/.dsh node scripts/tui-unmeasured-probe.mjs     # against a real home
 *
 * Exit code 0 means every assertion passed; a failing run prints the frames and
 * the Host's own stderr. No PTY, no mock model, no provider key.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const { screen: newGrid } = await import(pathToFileURL(join(REPO, 'tests', 'screen.mjs')).href)

const BOOT_TIMEOUT_MS = 90_000
const STEP_TIMEOUT_MS = 30_000
const EXIT_TIMEOUT_MS = 20_000
/** What a terminal that does answer takes to reply. */
const PROBE_ANSWER_MS = 5

const WIDTH = 100
const HEIGHT = 30

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu
const plain = text => text.replace(CSI, '').replace(OSC, '')

const home = process.env.PROBE_HOME
if (home === undefined || home === '') {
  // Deliberately not `DSH_HOME`: this probe creates a session, and the convention
  // `PROBE_HOME` is what keeps it away from a real one.
  console.log('FAIL: PROBE_HOME must name a throwaway profile home — build one with')
  console.log('      node scripts/probe-home.mjs --probe --script tui-unmeasured-probe.mjs')
  process.exit(1)
}

const problems = []
/** Fail with what the terminal was showing, which is what a human needs. */
function check(condition, what) {
  if (condition) {
    console.log(`ok: ${what}`)
    return true
  }
  problems.push(what)
  console.log(`FAIL: ${what}`)
  return false
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(25)
  }
  return false
}

/**
 * One boot, with the parent deciding whether to answer the cursor probes.
 *
 * The parent *is* the terminal here: `DSH_TUI_DISPLAY=stdio` hands it the byte
 * stream, and `DSH_TUI_TERM_CAPS` is empty so the capability table comes from the
 * TERM declared below rather than from whatever terminal this script was started
 * in. `DSH_TUI_LANG` is pinned for the same reason: the chip's wording is the
 * thing under test, and it must not depend on the machine's locale setting.
 */
async function runWindow({ answers }) {
  const sessionId = `main-session-${randomUUID()}`
  const child = spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TUI_DISPLAY: 'stdio',
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      COLUMNS: String(WIDTH),
      LINES: String(HEIGHT),
      DSH_TUI_NO_UPDATE_CHECK: '1',
      DSH_TUI_DEBUG: '1',
      DSH_TUI_TERM_CAPS: '',
      DSH_TUI_LANG: 'zh',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const grid = newGrid(WIDTH, HEIGHT)
  let output = ''
  let errors = ''
  let requests = 0
  let answersWritten = 0
  let ready = Promise.resolve()

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += chunk
    requests = output.split('\u001b[6n').length - 1
    if (answers) {
      while (answersWritten < requests) {
        answersWritten += 1
        setTimeout(() => {
          try { child.stdin.write('\u001b[1;1R') } catch { /* the window is gone */ }
        }, PROBE_ANSWER_MS)
      }
    }
    ready = ready.then(() => grid.write(chunk)).catch(() => {})
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { errors += chunk })

  let exitCode
  child.on('exit', code => { exitCode = code })

  const visible = async () => {
    await ready
    return grid.grid().map(row => row.replace(/\s+$/u, '')).filter(row => row !== '')
  }
  const rowsMatching = (rows, pattern) => rows.filter(row => pattern.test(row))

  // 1. The TUI paints at all: the rest of the probe reads a screen, not a promise.
  const painted = await waitFor(() => /─{20,}/u.test(output), BOOT_TIMEOUT_MS)
  // 2. The chip, and the cursor probes the relay sent to get there. The attach
  //    waits out its sampling budget when nothing answers, so this is the slow leg.
  let chip
  const chipDeadline = Date.now() + STEP_TIMEOUT_MS
  while (Date.now() < chipDeadline && chip === undefined) {
    await delay(100)
    chip = (await visible()).find(row => /SSH [●○*o]{4}/u.test(row))
  }
  // 3. `/diag` says what the probe knows, on its own rows.
  let diagRows = []
  child.stdin.write('/diag\r')
  const diagSeen = await waitFor(() => /判定链|verdict chain/u.test(output), STEP_TIMEOUT_MS)
  if (diagSeen) {
    diagRows = rowsMatching(await visible(), /链路|探测|绘制|link|probe|cadence/u)
  }
  const frame = await visible()

  // Leave the report Screen before quitting: a Screen owns the keyboard, so
  // `/exit` typed behind it is a keystroke in the report, not a command.
  child.stdin.write('\u001b')
  await delay(500)
  child.stdin.write('\u0015')
  child.stdin.write('/exit\r')
  const gone = await Promise.race([
    new Promise(resolve => child.on('exit', () => resolve(true))),
    delay(EXIT_TIMEOUT_MS).then(() => false),
  ])
  if (!gone) {
    try { child.kill() } catch { /* already gone */ }
  }

  if (errors.trim() !== '') {
    console.log('--- host/launcher stderr ---')
    for (const line of errors.trim().split('\n').slice(-8)) console.log(`  ${line}`)
  }
  return { painted, chip, diagRows, frame, requests, answersWritten, exitCode, output, errors, sessionId }
}

console.log(`probe home: ${home}`)
console.log(`cli: ${CLI}`)
console.log('')

// ── the field shape: a terminal that never answers ───────────────────────────
console.log('leg 1 — a terminal that never answers `CSI 6n`')
const silent = await runWindow({ answers: false })
check(silent.painted, 'the TUI paints a frame on a pipe')
check(silent.requests > 0, `the relay asked the terminal for its cursor position (${silent.requests} requests)`)
check(silent.answersWritten === 0, 'and nothing answered them')
check(silent.chip !== undefined, 'the footer painted a link chip')
if (silent.chip !== undefined) {
  console.log(`      chip: ${silent.chip}`)
  check(/SSH [○o*]{4}\s+(未测|n\/a)/u.test(silent.chip),
    `an unmeasured link says so in the delay slot: ${JSON.stringify(silent.chip)}`)
  check(!/\d+ms/u.test(silent.chip),
    `and never prints a cadence where the round trip goes: ${JSON.stringify(silent.chip)}`)
}
check(silent.diagRows.some(row => /未测|未知|unknown|n\/a/u.test(row)),
  `\`/diag\` reports the probe as unmeasured (${JSON.stringify(silent.diagRows)})`)
check(silent.diagRows.some(row => /\d+ms/u.test(row)),
  `\`/diag\` keeps the paint cadence on its own row (${JSON.stringify(silent.diagRows)})`)
for (const row of silent.diagRows) console.log(`      ${row}`)
check(silent.exitCode === 0, `the window exits cleanly on /exit (code ${silent.exitCode})`)

// ── the control: the same home, with a terminal that answers ─────────────────
console.log('')
console.log('leg 2 — the same home, with a terminal that answers')
const answered = await runWindow({ answers: true })
check(answered.painted, 'the TUI paints a frame on a pipe')
check(answered.answersWritten > 0, `the parent answered the cursor probes (${answered.answersWritten})`)
check(answered.chip !== undefined, 'the footer painted a link chip')
if (answered.chip !== undefined) {
  console.log(`      chip: ${answered.chip}`)
  check(/SSH [●*]{4}\s+\d+ms/u.test(answered.chip),
    `a measured link reports its measurement: ${JSON.stringify(answered.chip)}`)
  check(!/未测|n\/a/u.test(answered.chip),
    `and is not left looking unmeasured: ${JSON.stringify(answered.chip)}`)
}
check(answered.diagRows.some(row => /已测量|measured/u.test(row)),
  `\`/diag\` reports the probe as measured (${JSON.stringify(answered.diagRows)})`)
for (const row of answered.diagRows) console.log(`      ${row}`)
check(answered.exitCode === 0, `the window exits cleanly on /exit (code ${answered.exitCode})`)

if (problems.length > 0) {
  console.log('')
  console.log(`--- leg 1 frame (${silent.output.length} bytes) ---`)
  for (const row of silent.frame.slice(-12)) console.log(`  ${row}`)
  console.log('')
  console.log(`FAIL: ${problems.length} assertion(s): ${problems.join('; ')}`)
  process.exit(1)
}
console.log('')
console.log('OK: an unanswering terminal reads `未测` with the cadence on the /diag row,')
console.log('    and the same home with an answering terminal reports its measurement')
