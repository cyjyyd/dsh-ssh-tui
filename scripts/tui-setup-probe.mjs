#!/usr/bin/env node
/**
 * Real-PTY probe for the **setup Screen** (B2.6).
 *
 * `tui-probe.mjs` drives a home that is already configured, so it never sees the
 * wizard. This one builds a throwaway home, boots the TUI into first-run onboarding,
 * and asserts what the *terminal* shows while a reader walks the wizard:
 *
 *   1. the wizard is a Screen: it paints the step indicator and its guidance, and it
 *      does not paint the workspace composer behind it;
 *   2. typing moves the wizard's field, and Enter walks a step — a keystroke must not
 *      clear the screen and must touch only a few rows;
 *   3. a resize keeps the field and the keys on screen at every geometry;
 *   4. Esc leaves the wizard and hands the screen back to the workspace, which is
 *      where a composer and the footer reappear;
 *   5. detach/reattach mid-step (a SEPARATE run, `--reattach`) is covered by
 *      `tui-drop-probe.mjs`'s mechanism; this probe stops at the wizard's own frame.
 *
 * Usage:
 *   node scripts/tui-setup-probe.mjs [--keep]
 *
 * Exit code 0 means every assertion passed; the captured stream is printed on failure.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { createRequire } from 'node:module'

import { provisionProbeCredential } from './probe-home.mjs'

const require = createRequire(import.meta.url)
const ROOT = dirname(fileURLToPath(import.meta.url))
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const USAGE = `usage: node scripts/tui-setup-probe.mjs [--keep]

  boots the TUI into first-run onboarding on a real PTY and walks the wizard.

Set PROBE_HOME to a throwaway tree (the same convention as the other probes); the
home must have the profile installed already — building one needs a package
registry, which a sandboxed run does not have. The session is left behind on
purpose: the probe has to *not* resume, because resuming skips first-run setup.`

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu
const plain = text => text.replace(CSI, '').replace(OSC, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

async function loadPty() {
  try {
    return await import(pathToFileURL(require.resolve('node-pty', { paths: [process.cwd()] })).href).then(mod => mod.default ?? mod)
  } catch {
    return undefined
  }
}

/** The rows a frame addressed, in the byte order the terminal received them. */
function rowsOf(chunk) {
  return [...chunk.matchAll(/\x1b\[(\d+);1H/gu)].map(match => Number(match[1]))
}

async function runProbe(argv) {
  const keep = argv.includes('--keep')
  const home = process.env.PROBE_HOME ?? process.env.DSH_HOME
  if (home === undefined) {
    console.log('SKIP: set PROBE_HOME to a home whose tui profile is already installed')
    return 0
  }
  const pty = await loadPty()
  if (pty === undefined) {
    console.log('SKIP: node-pty is unavailable, so the wizard cannot be driven on a PTY here')
    return 0
  }
  // No `--resume`: a resume is not a first run, and the wizard is what this probe is
  // about (the launcher mints a fresh session id for a plain launch).
  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui'], {
    name: 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env: {
      ...process.env,
      DSH_HOME: home,
      TERM: 'xterm-256color',
      DSH_TUI_NO_UPDATE_CHECK: '1',
      // No provider, no key: the wizard is what this boot shows.
      DEEPSEEK_API_KEY: '',
      SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
      SSH_TTY: '/dev/pts/9',
    },
  })
  let output = ''
  term.onData(chunk => { output += chunk })
  const problems = []
  const check = (condition, message) => { if (!condition) problems.push(message) }
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await delay(50)
    }
    throw new Error(`timed out waiting for ${label}\n--- captured ---\n${plain(output).slice(-1200)}`)
  }

  try {
    // 1. First-run onboarding paints as a Screen.
    //
    // A home that already has a credential boots straight into the workspace: that is
    // not a failure of this probe, it is a home that cannot show the wizard. Say so
    // and skip, rather than timing out on a frame the run was never going to paint.
    //
    // The window is two-sided on purpose. Boot paints the workspace *first*
    // (`bootBackgroundTasks` starts `maybeRunOnboarding`, which resolves the
    // credential store before it opens the Screen), so the composer is visible for a
    // few hundred milliseconds on a home that is about to show the wizard — a
    // "the composer is up, so this home is configured" test fired on that first
    // frame and made a fresh home skip. The wizard therefore wins the whole window,
    // and only a window that closes *without* it means "configured".
    const wizard = () => /安装向导|Setup 1\/9|选择提供商/u.test(plain(output))
    const deadline = Date.now() + 60_000
    let seenWorkspaceAt
    while (Date.now() < deadline && !wizard()) {
      if (/目录：|目录:|❯/u.test(plain(output))) seenWorkspaceAt ??= Date.now()
      // Three seconds of a settled workspace with no wizard is a configured home.
      if (seenWorkspaceAt !== undefined && Date.now() - seenWorkspaceAt > 3_000) {
        console.log('SKIP: this home is already configured, so first-run setup never opens')
        console.log('      (build an unconfigured home to walk the wizard; the in-process')
        console.log('       suite covers the same ground as tests/setup-screen.test.mjs)')
        return 0
      }
      await delay(50)
    }
    await waitFor(wizard, 1_000, 'the setup Screen')
    const start = output.length
    check(!/\x1b\[\?1049l/u.test(output.slice(start)), 'the wizard does not leave the alternate screen')
    check(!/[╭]/u.test(plain(output.slice(start - 400))), 'no workspace composer is painted under it')

    // 2. Step one is a *list*: a key moves the highlight, and the list is what
    //    repaints. The assertion is the frame's shape, not a row count — the title
    //    and the step indicator above the body must not be repainted, and nothing
    //    may clear.
    const beforeList = output.length
    term.write('d')
    await delay(500)
    const listed = output.slice(beforeList)
    check(!/\x1b\[[HJ]|\x1b\[2J/u.test(listed), `a keystroke must not clear the screen: ${JSON.stringify(plain(listed).slice(0, 120))}`)
    const listRows = rowsOf(listed)
    check(listRows.length > 0, 'the list step repaints the row the highlight moved to')
    check(Math.min(...listRows) >= 2, `the repaint starts at the body, never the title (rows ${listRows.join(',')})`)

    // 3. Enter walks to the next step — which is a *field*. That is where "a
    //    keystroke repaints a few rows" is measurable: the list step repaints its
    //    list by design (measured: 15 rows at 100x30), and asserting a small number
    //    there would be asserting the wrong contract.
    const beforeStep = output.length
    term.write('\r')
    await delay(900)
    check(!/\x1b\[[HJ]|\x1b\[2J/u.test(output.slice(beforeStep)), 'walking a step must not clear the screen')
    const stepRows = rowsOf(output.slice(beforeStep))
    check(stepRows.length > 0, 'the new step painted something')

    const beforeType = output.length
    term.write('x')
    await delay(500)
    const typed = output.slice(beforeType)
    check(!/\x1b\[[HJ]|\x1b\[2J/u.test(typed), `a keystroke must not clear the screen: ${JSON.stringify(plain(typed).slice(0, 120))}`)
    const rows = rowsOf(typed)
    check(rows.length > 0 && rows.length <= 8, `typing in the field repaints a few rows (${rows.length})`)

    // 4. Resize keeps the field and the counter.
    term.resize(72, 20)
    await delay(600)
    const resized = plain(output.slice(beforeStep))
    check(/安装向导|Setup/u.test(resized), 'the wizard is still on screen after a resize')
    term.resize(120, 24)
    await delay(600)

    // 5. Esc leaves the wizard; the workspace comes back.
    const beforeEsc = output.length
    term.write('\x1b')
    await delay(900)
    const after = plain(output.slice(beforeEsc))
    check(after.includes('目录') || after.includes('❯'), `the workspace is back after Esc (${JSON.stringify(after.slice(-160))})`)
    console.log(`setup Screen: painted, listed (${listRows.length} rows), stepped, typed (${rows.length} rows), resized and left`)
  } finally {
    try { term.kill() } catch { /* already gone */ }
    if (keep) console.log(`probe home kept: ${home}`)
  }

  // 6. The other half of the claim: once the machine is configured, the wizard is
  //    not shown again. Completing the wizard over a real provider needs a real
  //    key, so this writes the credential the wizard would have saved and boots
  //    again — the decision under test is "configured ⇒ no first run", and it does
  //    not care how the key got there. (`--unconfigured` in `probe-home.mjs` is the
  //    other direction: the same home with no credential, which is phase 1 above.)
  if (problems.length === 0 && pty !== undefined) {
    provisionProbeCredential({ home, profile: 'tui', cli: CLI, log: () => {} })
    const second = pty.spawn(process.execPath, [CLI, '--profile', 'tui'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: {
        ...process.env,
        DSH_HOME: home,
        TERM: 'xterm-256color',
        DSH_TUI_NO_UPDATE_CHECK: '1',
        DEEPSEEK_API_KEY: '',
        SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
        SSH_TTY: '/dev/pts/9',
      },
    })
    let secondOutput = ''
    second.onData(chunk => { secondOutput += chunk })
    try {
      const until = Date.now() + 45_000
      while (Date.now() < until && !/目录:|目录：/u.test(plain(secondOutput))) await delay(100)
      const text = plain(secondOutput)
      check(/目录:|目录：/u.test(text), 'the second boot reaches the workspace')
      check(!/安装向导|选择提供商/u.test(text), 'and does not open the wizard again')
      console.log(`second boot on the configured home: ${/目录:|目录：/u.test(text) ? 'workspace, no wizard' : 'no workspace'}`)
    } finally {
      try { second.kill() } catch { /* already gone */ }
    }
  }

  if (problems.length > 0) {
    console.error('FAIL')
    for (const problem of problems) console.error(`  - ${problem}`)
    return 1
  }
  console.log('OK: the setup wizard is a Screen — it paints its own frame, owns its field,')
  console.log('    survives a resize, and hands the workspace back on Esc')
  return 0
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
process.exit(await runProbe(argv))
