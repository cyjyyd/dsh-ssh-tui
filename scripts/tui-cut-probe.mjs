#!/usr/bin/env node
/**
 * Cut-link probe: does the Host tell "a window is on this session" from "the
 * wire is gone"?
 *
 * This is the difference the resume list got wrong. When an SSH link is cut the
 * server often does not notice: sshd keeps the pty and the launcher keeps its
 * display socket connected (no SIGHUP, no EOF — until TCP keepalive, which can
 * be hours). The lock then still reads `attached`, the picker said 已接入, and a
 * second window could not get in — while the window it was protecting was gone.
 *
 * The only party that can settle it is the terminal at the far end, so the Host
 * asks its relay to round-trip a cursor request, and a resuming window asks the
 * Host. This probe plays that terminal: it answers cursor requests while the
 * "link" is up, then stops answering — the cut-link shape, with every process
 * still running — and asserts the answer follows.
 *
 * Usage:
 *   PROBE_HOME=<throwaway home> node scripts/tui-cut-probe.mjs
 *   node scripts/probe-home.mjs --probe --script tui-cut-probe.mjs
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
const { queryDisplayAttachment } = await import(pathToFileURL(join(REPO, 'lib/display-sock.js')).href)
const { sessionLockLookupPaths } = await import(pathToFileURL(join(REPO, 'lib/session-lock.js')).href)

const home = process.env.PROBE_HOME ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '/root', '.dsh')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** node-pty lives in the harness CLI's tree; without it the probe skips. */
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

const sessionId = `main-session-${randomUUID()}`
/** Whether the "terminal" still answers cursor-position requests. */
let answering = true
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
  // One reply per request: a terminal answers each `CSI 6n` exactly once, and
  // the relay's probe counts on it to tell a live link from a quiet one.
  const requests = output.split('\x1b[6n').length - 1
  while (answered < requests) {
    answered += 1
    if (answering) {
      setTimeout(() => {
        try {
          term.write('\x1b[17;1R')
        } catch {
          // The window is gone; that is what the probe is about to simulate.
        }
      }, 5)
    }
  }
})

async function sockPath() {
  for (const path of sessionLockLookupPaths(sessionId, home)) {
    try {
      return JSON.parse(await readFile(path, 'utf8')).sock
    } catch {
      // No lock at this name yet.
    }
  }
  return undefined
}

const problems = []
let sock
for (let wait = 0; wait < 300 && sock === undefined; wait += 1) {
  await delay(100)
  sock = await sockPath()
}
if (sock === undefined) problems.push('the session never took a lock')

let live
if (sock !== undefined) {
  // Until a relay attaches the answer is `detached`, which is correct — there is
  // no window yet — so poll for the attach rather than asserting the first ask.
  for (let wait = 0; wait < 60; wait += 1) {
    live = await queryDisplayAttachment(sock)
    if (live === 'attached') break
    await delay(500)
  }
  if (live !== 'attached') problems.push(`an answering terminal must read as attached (got ${live})`)
  if (answered === 0) problems.push('the relay never probed the terminal at all')
}

// The cut: every process still runs, only the far end stops answering.
answering = false
const silent = sock === undefined ? undefined : await queryDisplayAttachment(sock)
const again = sock === undefined ? undefined : await queryDisplayAttachment(sock)
if (silent !== 'detached') problems.push(`a silent terminal must read as detached (got ${silent})`)
if (again !== 'detached') problems.push(`and stay detached (got ${again})`)

term.kill()
try {
  const raw = await readFile(sessionLockLookupPaths(sessionId, home)[0], 'utf8')
  const pid = JSON.parse(raw).pid
  if (Number.isInteger(pid) && pid > 0) process.kill(pid, 'SIGKILL')
} catch {
  // No lock, or the Host already went away.
}

if (problems.length === 0) {
  console.log(`OK: live reads attached (${answered} cursor requests answered), a cut reads detached`)
  process.exit(0)
}
console.log('FAIL')
for (const problem of problems) console.log(`  - ${problem}`)
process.exit(1)
