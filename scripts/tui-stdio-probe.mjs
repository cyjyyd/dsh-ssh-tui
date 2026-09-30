#!/usr/bin/env node
/**
 * A pipe parent hosting the TUI: the desktop-shaped end-to-end probe.
 *
 * Every other probe drives a real PTY. This one deliberately does not: the
 * desktop Harness runs Electron as Node, so its launcher has no console, and the
 * question this probe answers is whether a parent that *can* put bytes on a pipe
 * — a PTY panel, an embedder's own terminal widget, a GUI that shells out — can
 * host this TUI by declaring `DSH_TUI_DISPLAY=stdio`. It is the only probe here
 * that would still run on a machine with no terminal at all.
 *
 * It boots the throwaway profile from `probe-home.mjs` with pipes for stdin,
 * stdout and stderr, then checks the three things a parent has to provide:
 *
 *   1. frames: the child paints ANSI on stdout, and the plugin mounted (no
 *      "inactive here" line on stderr);
 *   2. input: a keystroke typed into the pipe shows up in the input box;
 *   3. size: a pipe fires no `resize` event, so the parent reports the new size
 *      as `CSI 8 ; rows ; cols t` and the TUI repaints at that width;
 *   4. and it exits cleanly when the session is told to quit.
 *
 * It also answers the child's cursor probes the way a terminal emulator would
 * (`CSI 6n` → `CSI 1;1R`), because a parent that never answers is a supported
 * but slower shape: the attach then waits out the sampling budget instead.
 *
 * Usage:
 *   node scripts/probe-home.mjs --probe --script tui-stdio-probe.mjs
 *   PROBE_HOME=~/.dsh node scripts/tui-stdio-probe.mjs     # against a real home
 *
 * Exit code 0 means every assertion passed; captured output is printed on
 * failure. No PTY, no mock model, no provider key: the probe never starts a turn.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'

const require = createRequire(import.meta.url)
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const BOOT_TIMEOUT_MS = 90_000
const STEP_TIMEOUT_MS = 20_000
const EXIT_TIMEOUT_MS = 20_000
/** How long a terminal emulator takes to answer a cursor probe. */
const PROBE_ANSWER_MS = 5

const WIDTH = 100
const HEIGHT = 30
const RESIZED_WIDTH = 120

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Control sequences, which are not text: see `plain()`. */
const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu

/**
 * What the parent's terminal widget would actually show.
 *
 * The assertions are about what a reader sees, and the prompt is drawn as
 * `\x1b[36m❯\x1b[0m ` on the colour terminal this probe declares — so a match
 * against the raw byte stream has to know the palette, and does not. Strip the
 * escapes and the row reads `❯ x`, which is the same thing the PTY probe reads
 * (`tui-probe.mjs`).
 */
function plain(text) {
  return text.replace(CSI, '').replace(OSC, '')
}

const home = process.env.PROBE_HOME
if (home === undefined || home === '') {
  // Deliberately not `DSH_HOME`: this probe creates a session, and the
  // convention `PROBE_HOME` is what keeps it away from a real one. (The PTY
  // probe's 2026-09-11 incident was exactly that mistake, one layer down.)
  console.log('FAIL: PROBE_HOME must name a throwaway profile home — build one with')
  console.log('      node scripts/probe-home.mjs --probe --script tui-stdio-probe.mjs')
  process.exit(1)
}

const sessionId = `main-session-${randomUUID()}`
let output = ''
let errors = ''
const failures = []

/** Fail with the tail of what the child painted, which is what a human needs. */
function check(condition, what) {
  if (condition) {
    console.log(`ok: ${what}`)
    return true
  }
  failures.push(what)
  console.log(`FAIL: ${what}`)
  return false
}

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await delay(25)
  }
  return false
}

const child = spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DSH_HOME: home,
    // The switch under test: the parent relays stdin/stdout, so no TTY is needed.
    DSH_TUI_DISPLAY: 'stdio',
    // A pipe reports no terminal of its own, so the parent declares one.
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    COLUMNS: String(WIDTH),
    LINES: String(HEIGHT),
    DSH_TUI_NO_UPDATE_CHECK: '1',
    // The plugin's own account of the attach, the link and the exit, on stderr.
    // Only the failing run prints it, and without it a red run here says "the
    // process did not go" — a frame dump cannot tell a Host that never sent its
    // goodbye from a launcher that re-attached over one.
    DSH_TUI_DEBUG: '1',
    // No capability overrides: the empty value is the spelling for "none", where
    // `{}` is not a token the parser knows (it lands in `/diag` as rejected). The
    // table then comes from the TERM/COLORTERM declared above, so it is the same
    // on every runner — this probe is about the pipe, not about the terminal
    // underneath it, and it must not inherit one from the machine it runs on.
    DSH_TUI_TERM_CAPS: '',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => { output += chunk })
child.stderr.setEncoding('utf8')
child.stderr.on('data', chunk => { errors += chunk })

/** Answer `CSI 6n` like a terminal would, exactly once per request. */
let answered = 0
let watching = 0
const answerProbes = async () => {
  for (;;) {
    const at = output.indexOf('\u001b[6n', watching)
    if (at === -1) return
    watching = at + '\u001b[6n'.length
    answered += 1
    await delay(PROBE_ANSWER_MS)
    if (child.exitCode === null && child.stdin.writable) child.stdin.write('\u001b[1;1R')
  }
}
const probeTimer = setInterval(() => { void answerProbes() }, 20)

let exitCode = null
let exitSignal = null
child.on('exit', (code, signal) => {
  exitCode = code
  exitSignal = signal
})
const exited = new Promise(resolve => child.on('exit', () => resolve()))

console.log(`probe home: ${home}`)
console.log(`probe session: ${sessionId} (created)`)

try {
  // 1. The TUI paints on a pipe at all.
  const painted = await waitFor(
    () => (output.match(/─{20,}/u) ?? []).length > 0,
    BOOT_TIMEOUT_MS,
    'the first frame',
  )
  check(painted, 'the TUI paints a frame on a pipe')
  check(
    !errors.includes('inactive here'),
    'the plugin mounted: stdio mode is not treated as "no terminal"',
  )
  // The probes start with the first frame; the answer loop polls, so give it a
  // moment before calling the terminal silent.
  const probed = await waitFor(() => answered > 0, STEP_TIMEOUT_MS, 'a cursor probe')
  check(probed, `the child probed the terminal and we answered (${answered} answers)`)

  // 2. Keystrokes typed into the pipe reach the input box.
  //
  // The prompt is `❯ ` on a colour terminal and `> ` on a plain one, and this
  // probe declares truecolor (COLORTERM above), so both spellings are accepted:
  // the assertion is about the keystroke landing in the input box, not about
  // which glyph the prompt happens to use. The padding is part of the check —
  // the row is padded to the full width, and a bare `x` could be anything.
  const before = output.length
  child.stdin.write('x')
  const echoed = await waitFor(
    () => /(?:❯|>) x\s{3,}/u.test(plain(output.slice(before))),
    STEP_TIMEOUT_MS,
    'the input echo',
  )
  check(echoed, 'a keystroke on the pipe is painted in the input box')

  // 3. A resize: the parent reports the new size the way a terminal does.
  const beforeResize = output.length
  child.stdin.write(`\u001b[8;${HEIGHT + 10};${RESIZED_WIDTH}t`)
  const resized = await waitFor(
    () => (output.slice(beforeResize).match(/─{110,}/u) ?? []).length > 0,
    STEP_TIMEOUT_MS,
    'a frame at the new width',
  )
  check(resized, `a reported size repaints at ${RESIZED_WIDTH} columns`)
  // The exact report, not `ESC[8;`: a painted row address (`ESC[8;1H`) shares
  // that prefix, and the frames after a resize are full of row addresses.
  check(
    !output.slice(beforeResize).includes(`\u001b[8;${HEIGHT + 10};${RESIZED_WIDTH}t`),
    'the size report is not painted as typing',
  )

  // 4. Quit from the keyboard: the session ends and the child goes. The echo
  // check above left a character in the input box, and `/exit` behind it would
  // be a prompt — a turn, not a command — so clear the line first.
  child.stdin.write('\u007f'.repeat(8))
  child.stdin.write('/exit\r')
  const gone = await Promise.race([exited.then(() => true), delay(EXIT_TIMEOUT_MS).then(() => false)])
  check(gone, 'the TUI exits when told to')
  check(exitCode === 0 && exitSignal === null, `the exit is clean (code ${exitCode}, signal ${exitSignal})`)
} finally {
  clearInterval(probeTimer)
  if (exitCode === null) {
    try { child.kill() } catch { /* already gone */ }
  }
}

/**
 * What the Host process said while this run was going.
 *
 * The Host is a separate process and the launcher spawns it with its stderr on a
 * file under the profile's `tui-socks`, so anything that is really *its* story —
 * a refused lock, a shutdown that never finished, a crash — is invisible in the
 * child's own output. That is the first thing a red run needs.
 */
async function hostStderr(home) {
  try {
    const dir = join(home, 'tui-socks')
    const parts = []
    for (const name of (await readdir(dir)).filter(entry => entry.endsWith('.err'))) {
      const text = await readFile(join(dir, name), 'utf8')
      if (text.trim() !== '') parts.push(`--- ${name} ---\n${text.slice(-4_000)}`)
    }
    return parts.join('\n')
  } catch {
    // No home, no Host, nothing to report.
    return ''
  }
}

if (failures.length > 0) {
  console.log(`\n--- stdout tail (${output.length} bytes, ${answered} probe answers) ---`)
  console.log(JSON.stringify(output.slice(-2_000)))
  console.log('--- stderr tail ---')
  console.log(JSON.stringify(errors.slice(-2_000)))
  const host = await hostStderr(home)
  if (host !== '') {
    console.log('--- host stderr (tui-socks/*.err) ---')
    console.log(host)
  }
  console.log(`\nFAIL: ${failures.length} assertion(s): ${failures.join('; ')}`)
  process.exit(1)
}
console.log('stdio probe: all assertions passed')
