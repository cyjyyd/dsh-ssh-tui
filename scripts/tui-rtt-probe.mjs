#!/usr/bin/env node
/**
 * Link-quality probe: does the footer chip follow the link, or the moment the
 * session attached? And does it still follow it when the relay attaches *while
 * the session log is being read*?
 *
 * It used to be the moment. The round-trip was measured once, in the attach
 * handshake, and both the chip and the paint cadence — and the per-frame byte
 * budget that goes with the cadence — were derived from that single number for
 * the rest of the session. A user on a flaky link could watch `SSH ●○○○ 450ms`
 * from the first second to the last while the link had been fine for hours, and
 * the TUI stayed at its slowest paint tier with it.
 *
 * So the relay re-measures on its own cadence and the Host takes the median of
 * the last few measurements. This probe plays a terminal that is slow for the
 * first few seconds and fast afterwards — the entry the report describes — and
 * reads the chip out of the real PTY output.
 *
 * Phase 2 is the same question in the shape that actually regressed. A resumed
 * session with history composes *no frame at all* until its log has been read
 * (B2.4), which is exactly the window the relay attaches inside; a fix in that
 * window that wrote its own bytes (`?1049h`, a splash) was measured to leave the
 * chip on its `○○○○ 160ms` placeholder for the rest of the session — reported
 * from the field as "the link never recovered after a resume". So this phase
 * resumes a session whose log takes seconds to rebuild and asserts three things
 * at once: the screen never goes blank once the launcher has drawn on it, the
 * transcript lands, and the chip lands *measured* afterwards.
 *
 * Usage:
 *   PROBE_HOME=<throwaway home> node scripts/tui-rtt-probe.mjs
 *   node scripts/probe-home.mjs --probe --script tui-rtt-probe.mjs
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const { sessionLockLookupPaths } = await import(pathToFileURL(join(REPO, 'lib/session-lock.js')).href)
const { screen: newGrid } = await import(pathToFileURL(join(REPO, 'tests/screen.mjs')).href)
// The fixture: a durable log with history, so phase 2 has a load window to test
// in. Reading it is the harness's contract — see that module's header.
const { projectKey, writeSessionWithHistory } = await import(
  pathToFileURL(join(REPO, 'scripts/session-fixture.mjs')).href
)

const home = process.env.PROBE_HOME ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '/root', '.dsh')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function loadPty() {
  try {
    const resolved = require.resolve('node-pty', { paths: [process.cwd()] })
    const mod = await import(pathToFileURL(resolved).href)
    return mod.default ?? mod
  } catch {
    return undefined
  }
}

const pty = await loadPty()
if (pty === undefined) {
  // Not a pass: without node-pty nothing here ran. `verify-batch.mjs` reports a
  // `SKIP:` line as SKIP (never as PASS) and closes the run with INCOMPLETE.
  console.log('SKIP: node-pty is not available in this checkout')
  process.exit(0)
}

/** Control sequences the probe watches for. */
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const plain = text => text.replace(CSI, '')
/** Every `SSH ●●●○ 90ms` the footer painted, in order. */
const chips = text => [...plain(text).matchAll(/SSH ([●○]{4}) (\d+)ms/gu)]
  .map(match => ({ pips: match[1], ms: Number(match[2]) }))

/**
 * How long the simulated link is bad in phase 1; the relay's first recheck is at
 * the configured cadence, and the report's complaint was a chip stuck from the
 * attach moment.
 */
const SLOW_MS = 6_000
const replyDelayMs = startedAt => () => (Date.now() - startedAt < SLOW_MS ? 450 : 3)
/**
 * Phase 2's log. The window this phase tests is "how much replay is still owed
 * when the relay attaches", and that grows with the log: measured on this machine,
 * a 5000-event log leaves ~0.5s of it (too little to tell a same-tick entry from
 * an eager one) while a 20000-event log leaves ~3.5s — the black window a reader
 * reported as "1-3 seconds". Sizing the fixture to the shape that was reported is
 * what makes the assertion below able to fail.
 */
const HISTORY_EVENTS = 20_000
/** A screen entry this long before the transcript landed was not same-tick. */
const ENTRY_TOLERANCE_MS = 1_500

async function lockPid(sessionId) {
  for (const path of sessionLockLookupPaths(sessionId, home)) {
    try {
      return JSON.parse(await readFile(path, 'utf8')).pid
    } catch {
      // No lock at this name yet.
    }
  }
  return undefined
}

async function killHostByLock(sessionId) {
  try {
    const pid = await lockPid(sessionId)
    if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/**
 * A window that answers the relay's cursor probes, plus a real terminal grid, so
 * the probe can assert what the reader *sees* and not only which bytes arrived.
 */
function openWindow(sessionId, replyDelayFor) {
  const started = Date.now()
  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: home,
      TERM: 'xterm-256color',
      DSH_TUI_NO_UPDATE_CHECK: '1',
      SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
      SSH_TTY: '/dev/pts/9',
    },
  })
  const grid = newGrid(100, 30)
  const window = { term, startedAt: started, output: '', answered: 0, exited: undefined, entries: [] }
  let ready = Promise.resolve()
  term.onData(chunk => {
    const atChunk = window.output.length
    for (const match of chunk.matchAll(/\x1b\[\?1049h/gu)) {
      window.entries.push({ at: Date.now() - started, index: atChunk + match.index })
    }
    window.output += chunk
    // One reply per request, delayed by the simulated link: a 450ms link misses
    // the relay's first window, which is exactly what made the attach measurement
    // read as slow (or miss entirely).
    const requests = window.output.split('\x1b[6n').length - 1
    while (window.answered < requests) {
      window.answered += 1
      setTimeout(() => {
        try {
          term.write('\x1b[17;1R')
        } catch {
          // The window is gone.
        }
      }, replyDelayFor(window.startedAt))
    }
    ready = ready.then(() => grid.write(chunk)).catch(() => {})
  })
  term.onExit(({ exitCode }) => { window.exited = exitCode })
  /** The visible screen, blank rows dropped. */
  window.screen = async () => {
    await ready
    return grid.grid().map(row => row.replace(/\s+$/u, '')).filter(row => row !== '').join('\n')
  }
  window.chips = () => chips(window.output)
  window.kill = () => {
    try { term.kill() } catch { /* already gone */ }
  }
  return window
}

const problems = []
const check = (condition, message) => { if (!condition) problems.push(message) }

// ── phase 1: a fresh session on a link that starts slow and gets fast ────────

const freshSessionId = `main-session-${randomUUID()}`
const fresh = openWindow(freshSessionId, replyDelayMs(Date.now()))
for (let wait = 0; wait < 300 && (await lockPid(freshSessionId)) === undefined; wait += 1) await delay(100)
let freshSeen = []
for (let wait = 0; wait < 60; wait += 1) {
  await delay(1_000)
  freshSeen = fresh.chips()
  if (freshSeen.some(chip => chip.ms <= 50 && chip.pips === '●●●●')) break
}
{
  // The first chip of all is the placeholder painted before any measurement lands
  // (four hollow pips); the measurement itself is the first one after it.
  const first = freshSeen.find(chip => chip.pips !== '○○○○')
  const last = freshSeen.at(-1)
  if (freshSeen.length === 0) problems.push('the footer never painted a link chip')
  if (first === undefined) problems.push('the chip never showed a measured link')
  if (last === undefined || last.ms > 50 || last.pips !== '●●●●') {
    problems.push(`the chip never caught up with the fast link (last ${JSON.stringify(last)})`)
  }
  if (plain(fresh.output).includes('[17;1R')) problems.push('a cursor reply leaked onto the screen as text')
  if (fresh.answered < 2) problems.push('the link was never re-measured at all')
  if (first !== undefined && first.ms < 300) {
    // Not an assertion: a slow attach can also be missed outright, and the recheck
    // filling it in is the same fix. Seeing it is the more informative run.
    console.log(`(phase 1 caught the slow attach measurement: ${first.ms}ms)`)
  }
}
console.log(`phase 1 — cursor requests answered: ${fresh.answered}`)
console.log(`phase 1 — chips: ${JSON.stringify(freshSeen.slice(0, 6))}`)
fresh.kill()
await killHostByLock(freshSessionId)

// ── phase 2: the same question on a resume that has a log to read ────────────

const historySessionId = `main-session-${randomUUID()}`
const eventText = 'synthetic event'
const lastEventText = `${eventText} ${HISTORY_EVENTS - 1}`
writeSessionWithHistory(home, historySessionId, {
  events: HISTORY_EVENTS,
  cwd: process.cwd(),
  text: `${eventText} {n}`,
})
const resumed = openWindow(historySessionId, () => 3)
const timeline = []
let drewSomething = false
let blankAfterDraw = 0
let loadingLineAt
let landedAt
let corruptAt
for (let tick = 0; tick < 1_200; tick += 1) {
  await delay(100)
  const now = tick * 100
  const seen = await resumed.screen()
  if (seen !== '') drewSomething = true
  // The bug this phase exists for: the relay's screen entry cleared the buffer the
  // launcher had drawn into, and no frame followed until the log had been read, so
  // the reader stared at nothing. Once anything has been drawn, the screen must
  // never be empty again until the transcript lands.
  if (drewSomething && seen === '') {
    blankAfterDraw += 1
    timeline.push(`${now}ms BLANK`)
  }
  if (/载入历史会话|Loading history/u.test(seen)) loadingLineAt ??= now
  if (/corrupt/u.test(seen)) { corruptAt = now; break }
  if (seen.includes(lastEventText)) { landedAt = now; break }
}
// The chip the reader is left with: read it off the *screen*, not off a byte
// slice after the landing frame. The landing frame is where the chip usually
// appears first — slicing after it would miss the very row being asserted — and
// what matters is the last state a repaint left behind. The placeholder it must
// not be left on is `○○○○ 160ms`: the configured cadence, not a measurement.
let finalChip
const chipSamples = []
for (let wait = 0; wait < 150 && landedAt !== undefined; wait += 1) {
  await delay(100)
  const found = chips(await resumed.screen())
  if (found.length > 0) {
    finalChip = found.at(-1)
    if (chipSamples.at(-1) !== JSON.stringify(finalChip)) chipSamples.push(JSON.stringify(finalChip))
  }
  if (finalChip?.pips === '●●●●') break
}
resumed.kill()
await killHostByLock(historySessionId)
await rm(join(home, 'sessions', projectKey(process.cwd()), historySessionId), { recursive: true, force: true })

console.log(`phase 2 — landing at ${landedAt ?? 'never'}ms, loading line at ${loadingLineAt ?? 'never'}ms, ${HISTORY_EVENTS} events`)
console.log(`phase 2 — chips after landing: ${chipSamples.join(' → ') || 'none'}`)
if (timeline.length > 0) console.log(`phase 2 — ${timeline.length} blank sample(s): ${timeline.slice(0, 6).join(', ')}`)

if (corruptAt !== undefined) {
  // The fixture is the probe's own; if the harness refuses it, this phase tested
  // nothing. Failing (never skipping) is what keeps that honest.
  problems.push('the synthetic history could not be read: the resumed window reports a corrupt log')
}
if (landedAt === undefined && corruptAt === undefined) {
  problems.push(`the resumed session never showed its transcript (last screen: ${JSON.stringify((await resumed.screen()).slice(-200))})`)
}
if (landedAt !== undefined && loadingLineAt === undefined) {
  problems.push('the launcher\'s loading line was never on screen, so this run had no load window to test in')
}
if (blankAfterDraw > 0) {
  problems.push(`the screen went blank ${blankAfterDraw} time(s) while the log was being read: ${timeline.slice(0, 3).join(', ')}`)
}
// The launcher draws the first entry — the splash lives in that screen — and the
// Host draws every one after it. A Host entry *is* a clear on a terminal already
// in the alternate screen, so it may only be written in the same tick as the
// content it clears for; written at attach instead, it wipes the loading line and
// leaves an empty window for as long as the log takes (measured: 3.5s of black on
// a 20k-event session). The tolerance is the probe's own sampling interval.
// Entry 0 is the launcher's splash; every later one is the Host's.
const hostEntries = resumed.entries.slice(1)
const lateEntries = hostEntries.filter(entry => landedAt !== undefined && landedAt - entry.at > ENTRY_TOLERANCE_MS)
if (lateEntries.length > 0) {
  problems.push(`a screen entry was written ${Math.round((landedAt - lateEntries[0].at) / 1000)}s before the transcript landed, so it cleared the window it could not repaint: ${JSON.stringify(lateEntries[0])}`)
}
if (resumed.entries.length < 2) {
  problems.push(`the resumed window never entered the alternate screen from the Host (entries: ${JSON.stringify(resumed.entries)})`)
}
if (finalChip === undefined) {
  problems.push('the resumed session never painted a link chip after its transcript landed')
} else if (finalChip.pips !== '●●●●' || finalChip.ms >= 100) {
  problems.push(`the chip was left on its placeholder after the resume (${JSON.stringify(finalChip)}; a measurement lands well under 100ms on this simulated link)`)
}

if (problems.length === 0) {
  console.log('OK: the link chip follows the link instead of the attach moment')
  process.exit(0)
}
console.log('FAIL')
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(1)
