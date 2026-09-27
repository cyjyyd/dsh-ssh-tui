#!/usr/bin/env node
/**
 * Link-quality probe: does the footer chip follow the link, or the moment the
 * session attached?
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
 * Usage:
 *   PROBE_HOME=<throwaway home> node scripts/tui-rtt-probe.mjs
 *   node scripts/probe-home.mjs --probe --script tui-rtt-probe.mjs
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const { sessionLockLookupPaths } = await import(pathToFileURL(join(REPO, 'lib/session-lock.js')).href)

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
  console.log('SKIP: node-pty is not available in this checkout')
  process.exit(0)
}

/** How long the simulated link is bad; the relay's first recheck is at 8s. */
const SLOW_MS = 6_000

const sessionId = `main-session-${randomUUID()}`
const startedAt = Date.now()
/** Slow for the first seconds, fast afterwards: a jittery entry. */
const replyDelayMs = () => (Date.now() - startedAt < SLOW_MS ? 450 : 3)

const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: home,
  env: {
    ...process.env,
    DSH_HOME: home,
    TERM: 'xterm-256color',
    DSH_TUI_NO_UPDATE_CHECK: '1',
    SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
    SSH_TTY: '/dev/pts/9',
  },
})
let output = ''
let answered = 0
term.onData(chunk => {
  output += chunk
  // One reply per request, delayed by the simulated link: a 450ms link misses
  // the relay's first window, which is exactly what made the attach measurement
  // read as slow (or miss entirely).
  const requests = output.split('\x1b[6n').length - 1
  while (answered < requests) {
    answered += 1
    const wait = replyDelayMs()
    setTimeout(() => {
      try {
        term.write('\x1b[17;1R')
      } catch {
        // The window is gone.
      }
    }, wait)
  }
})

async function lockPid() {
  for (const path of sessionLockLookupPaths(sessionId, home)) {
    try {
      return JSON.parse(await readFile(path, 'utf8')).pid
    } catch {
      // No lock at this name yet.
    }
  }
  return undefined
}

for (let wait = 0; wait < 300 && (await lockPid()) === undefined; wait += 1) await delay(100)

/** Every `SSH ●●●○ 90ms` the footer painted, in order. */
function chips(text) {
  const plain = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
  return [...plain.matchAll(/SSH ([●○]{4}) (\d+)ms/gu)].map(match => ({ pips: match[1], ms: Number(match[2]) }))
}

let seen = []
for (let wait = 0; wait < 60; wait += 1) {
  await delay(1_000)
  seen = chips(output)
  if (seen.some(chip => chip.ms <= 50 && chip.pips === '●●●●')) break
}

// The first chip of all is the placeholder painted before any measurement lands
// (four hollow pips); the measurement itself is the first one after it.
const first = seen.find(chip => chip.pips !== '○○○○')
const last = seen.at(-1)
const plain = output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '')
const problems = []
if (seen.length === 0) problems.push('the footer never painted a link chip')
if (first === undefined) problems.push('the chip never showed a measured link')
if (last === undefined || last.ms > 50 || last.pips !== '●●●●') {
  problems.push(`the chip never caught up with the fast link (last ${JSON.stringify(last)})`)
}
if (plain.includes('[17;1R')) problems.push('a cursor reply leaked onto the screen as text')
if (answered < 2) problems.push('the link was never re-measured at all')

console.log(`cursor requests answered: ${answered}`)
console.log(`chips: ${JSON.stringify(seen.slice(0, 6))}`)
if (first !== undefined && first.ms < 300) {
  // Not an assertion: a slow attach can also be missed outright, and the recheck
  // filling it in is the same fix. Seeing it is the more informative run.
  console.log(`(this run caught the slow attach measurement: ${first.ms}ms)`)
}

term.kill()
try {
  const pid = await lockPid()
  if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
} catch {
  // Already gone.
}

if (problems.length === 0) {
  console.log('OK: the link chip follows the link instead of the attach moment')
  process.exit(0)
}
console.log('FAIL')
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(1)
