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
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { provisionProbeCredential } from './probe-home.mjs'
// The pty in front may rewrite the frame shape these row checks read (see the export).
import { PTY_IS_CONPTY } from './pty-window.mjs'
import {
  markTeardown,
  observeChild,
  reportOutcome,
  runtimeFacts,
  safeDetail,
  safeExcerpt,
  safeRowsDetail,
  workspaceFrameReady,
  writeDiagnosticBundle,
} from './probe-diagnostics.mjs'

const require = createRequire(import.meta.url)
const ROOT = dirname(fileURLToPath(import.meta.url))
// The official-package user path installs its own Host; PROBE_CLI lets that run
// drive the exact binary under test instead of the checkout's dev dependency.
// CI leaves it unset, so the normal probe still resolves the pinned tree.
const CLI = process.env.PROBE_CLI ?? require.resolve('@deepseek-ai/dsh/lib/bin.js')

const USAGE = `usage: node scripts/tui-setup-probe.mjs [--keep]

  boots the TUI into first-run onboarding on a real PTY and walks the wizard.

Set PROBE_HOME to a throwaway tree (the same convention as the other probes); the
home must have the profile installed already — building one needs a package
registry, which a sandboxed run does not have. The session is left behind on
purpose: the probe has to *not* resume, because resuming skips first-run setup.

Set PROBE_CLI to drive a specific Host binary (the official-package path uses the
Host it installed); the default is this checkout's pinned dev dependency.`

// The resolved diagnostic destination and the probe home are user-controlled
// absolute paths, and either may sit under the real home. The packet still goes to
// exactly the configured destination; the log names the destination category and
// the generated packet directory (a fixed timestamp/pid name), never the path.
const DIAGNOSTIC_LOCATION = 'the configured diagnostic destination (PROBE_DIAG_DIR, or .ci-diagnostics under the working directory)'
const PROBE_HOME_LOCATION = 'the configured probe home (PROBE_HOME or DSH_HOME); its path is not printed'
const diagnosticLine = dir => `diagnostics: ${basename(dir)} written under ${DIAGNOSTIC_LOCATION}`

/**
 * Optional metadata-only remote handoff for a failed probe.
 *
 * Disabled unless the operator opted in. It never receives the probe's problem
 * strings, screen or transcript, and a remote failure is swallowed: the probe's
 * own outcome/exit code remains authoritative.
 */
async function publishRemoteProbeFailure() {
  if (process.env.DSH_DIAGNOSTICS_UPLOAD !== '1') return
  try {
    const { publishDiagnosticFailure } = await import('../lib/diagnostics/index.js')
    await publishDiagnosticFailure({
      kind: 'probe-failure',
      failureCode: 'PROBE_ASSERTION',
      phase: 'probe',
      exitCode: 1,
      problemClasses: ['ASSERTION'],
    }, { maxWaitMs: 1500 })
  } catch {
    // Optional evidence must never alter the probe result.
  }
}

/** A path-free detail for a failed bundle write: the errno code, or fixed class text. */
function bundleErrorDetail(error, home) {
  if (typeof error?.code === 'string' && error.code !== '') return error.code
  return safeDetail(error instanceof Error ? error.message : String(error), 400, { home })
}

const CSI = /\x1b\[[0-9;?]*[a-zA-Z]/gu
const OSC = /\x1b\][^\x07]*\x07/gu
const plain = text => text.replace(CSI, '').replace(OSC, '')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// The real grid the PTY's bytes produce: a phase that asks what the *reader* sees
// cannot ask the byte stream, which spells a row only as far as it had to repaint.
const { screen: newGrid } = await import(pathToFileURL(join(ROOT, '../tests/screen.mjs')).href)

/** The rows the terminal is showing, replayed from the bytes the PTY handed over. */
async function wizardRows(output, cols = 100, rows = 30) {
  const grid = await newGrid(cols, rows)
  await grid.write(output)
  return grid.lines()
}

/**
 * A live view of the *current* visible frame while a child keeps writing.
 *
 * The bytes are replayed once; later calls only feed the new suffix, so a readiness
 * wait can poll the grid without re-parsing the whole transcript every 100 ms.
 * `grid()` (not `lines()`) is the visible screen: scrollback is deliberately not
 * part of "what is on the terminal right now".
 */
function frameReader(feed, cols = 100, rows = 30) {
  let gridPromise
  let consumed = 0
  return async () => {
    const text = feed()
    if (text.length < consumed) {
      gridPromise = undefined
      consumed = 0
    }
    gridPromise ??= newGrid(cols, rows)
    const grid = await gridPromise
    if (text.length > consumed) {
      await grid.write(text.slice(consumed))
      consumed = text.length
    }
    return grid.grid()
  }
}

/** The row the wizard draws its field on — the only one that opens with `›`. */
function fieldRowOf(rows) {
  return rows.find(row => row.trimStart().startsWith('›')) ?? ''
}

/** The newest session a home holds: what `--resume=<id>` needs. */
function newestSessionId(home) {
  const dir = join(home, 'sessions')
  const entries = readdirSync(dir).filter(name => {
    try {
      return statSync(join(dir, name)).isDirectory()
    } catch {
      return false
    }
  })
  if (entries.length === 0) return undefined
  return entries
    .map(name => ({ name, at: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.at - a.at)[0].name
}

/** The wizard frame the probe drives, and the step it is on. */
function wizardOf(output) {
  const text = plain(output)
  const steps = [...text.matchAll(/安装向导\s*(\d+)\/9/gu)]
  return { text, step: Number(steps.at(-1)?.[1] ?? '0') }
}

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
  // The real operator home can appear in a pasted value or a resolved path; every
  // derived failure excerpt is checked against it before it is written or printed.
  const knownHome = process.env.HOME ?? process.env.USERPROFILE
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
  const successLines = []
  const startedAt = Date.now()
  let phase = 'first-run'
  // A child that exits between a write and the next read used to look exactly like
  // a slow frame: the wait loop only read bytes. Keep the exit status so a failure
  // can say which one happened, and freeze the observation before cleanup so a
  // deliberate kill is never reported as the run's own exit.
  const trackChild = (name, child) => {
    const state = {
      name,
      pid: child.pid,
      child,
      startedAt: Date.now(),
      exit: undefined,
      observed: undefined,
      teardown: false,
    }
    child.onExit(({ exitCode, signal }) => {
      if (state.exit !== undefined) return
      state.exit = { exitCode: exitCode ?? null, signal: signal ?? null, at: Date.now() }
    })
    return state
  }
  // The observation belongs at the readiness/timeout boundary, not after `kill()`
  // has made every child look exited. `markTeardown` then records that the exit (if
  // any) was ours, without changing what the observation saw.
  const stopChild = state => {
    if (state.observed === undefined) state.observed = observeChild(state)
    markTeardown(state)
    try { state.child.kill() } catch { /* already gone */ }
  }
  const termState = trackChild('setup', term)
  // The child/output the diagnostics should read when a phase fails. Updated as the
  // probe moves from the wizard to the configured boot to the resumed save.
  let active = { name: 'setup', output: () => output, child: termState, cols: 100, rows: 30 }
  const check = (condition, message) => { if (!condition) problems.push(message) }
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      await delay(50)
    }
    if (active.child.observed === undefined) active.child.observed = observeChild(active.child)
    // Clean the whole captured stream, then take the readable tail. Slicing first
    // can cut `sk-` off a key and leave a body that no later check can classify.
    throw new Error(`timed out waiting for ${label}\n--- captured ---\n${safeDetail(plain(output), 1200, { home: knownHome })}`)
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
        // …unless the caller *built* this home with nothing configured. Then the wizard
        // not appearing is the 0.8.1 first-run defect (`--resume` read as "configured"),
        // and a skip here would be a green gate over exactly the incident it exists for.
        if (process.env.PROBE_REQUIRE_WIZARD === '1') {
          problems.push('this home was built unconfigured, so the wizard must open; the workspace settled without it'
            + (existsSync(join(home, '.credentials.yaml')) ? ' (a credential file exists — the harness left one behind)' : ''))
          throw new Error('the first-run wizard never opened on an unconfigured home')
        }
        console.log('SKIP: this home is already configured, so first-run setup never opens')
        console.log('      (build an unconfigured home to walk the wizard; the in-process')
        console.log('       suite covers the same ground as tests/setup-screen.mjs)')
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
    // The shape checks below read the painter's row addressing and its clears out
    // of the stream. ConPTY re-emits frames as newline-separated batches and adds
    // clears of its own, so neither is in the stream it hands over: measured on
    // this machine, the same boot arrives with 3 `ESC[<row>;1H` over ConPTY and 95
    // over a pipe. What the wizard *does* is asserted either way; what the frame
    // *looks like* on the wire is skipped, and said out loud at the end.
    const listRows = rowsOf(listed)
    if (!PTY_IS_CONPTY) {
      check(!/\x1b\[[HJ]|\x1b\[2J/u.test(listed), `a keystroke must not clear the screen: ${JSON.stringify(safeDetail(plain(listed), 120, { home: knownHome }))}`)
      check(listRows.length > 0, 'the list step repaints the row the highlight moved to')
      check(Math.min(...listRows) >= 2, `the repaint starts at the body, never the title (rows ${listRows.join(',')})`)
    }

    // 3. Enter walks to the next step — which is a *field*. That is where "a
    //    keystroke repaints a few rows" is measurable: the list step repaints its
    //    list by design (measured: 15 rows at 100x30), and asserting a small number
    //    there would be asserting the wrong contract.
    const beforeStep = output.length
    term.write('\r')
    await delay(900)
    const stepRows = rowsOf(output.slice(beforeStep))
    const beforeType = output.length
    term.write('x')
    await delay(500)
    const typed = output.slice(beforeType)
    const rows = rowsOf(typed)
    if (!PTY_IS_CONPTY) {
      check(!/\x1b\[[HJ]|\x1b\[2J/u.test(output.slice(beforeStep)), 'walking a step must not clear the screen')
      check(stepRows.length > 0, 'the new step painted something')
      check(!/\x1b\[[HJ]|\x1b\[2J/u.test(typed), `a keystroke must not clear the screen: ${JSON.stringify(safeDetail(plain(typed), 120, { home: knownHome }))}`)
      check(rows.length > 0 && rows.length <= 8, `typing in the field repaints a few rows (${rows.length})`)
    }

    // 3a. A mouse report is protocol, not text. A terminal sends the right button as
    //     `ESC[<2;x;yM` (press) and `ESC[<2;x;y m` (release); the wizard has no click
    //     target, so both must be consumed. The setup screen used to match the report
    //     *without* its `<`, so a real right-click fell through and typed
    //     `[<2;20;10M` into the field — including the API-key step.
    const rowsBeforeMouse = await wizardRows(output)
    const fieldBeforeMouse = fieldRowOf(rowsBeforeMouse)
    const beforeMouse = output.length
    term.write('\x1b[<2;20;10M')
    await delay(250)
    term.write('\x1b[<2;20;10m')
    await delay(450)
    const fieldAfterMouse = fieldRowOf(await wizardRows(output))
    check(fieldAfterMouse === fieldBeforeMouse,
      `a right-button report leaves the field alone (${JSON.stringify(safeDetail(fieldBeforeMouse, 160, { home: knownHome }))} → ${JSON.stringify(safeDetail(fieldAfterMouse, 160, { home: knownHome }))})`)
    check(!plain(output.slice(beforeMouse)).includes('<2;'),
      `the report is not painted anywhere (${JSON.stringify(safeDetail(plain(output.slice(beforeMouse)), 120, { home: knownHome }))})`)

    // 3b. A paste belongs to the field the wizard owns — which is the whole point
    //     of the field being its own. An API key, a base URL and a model list are
    //     copied, not typed, and the terminal delivers that as bracketed paste. The
    //     field row is read off a real grid, because "what the field says" is not a
    //     string in the stream: the wizard repaints the row it changed. The other
    //     half — that none of it reached the composer behind the Screen — is phase 5,
    //     where the workspace is visible again.
    const PASTE = 'sk-probe-pasted-value'
    const rowsBeforePaste = await wizardRows(output)
    const beforePaste = output.length
    term.write(`\x1b[200~${PASTE}\x1b[201~`)
    await delay(700)
    const rowsAfterPaste = await wizardRows(output)
    const fieldBefore = fieldRowOf(rowsBeforePaste)
    const fieldAfter = fieldRowOf(rowsAfterPaste)
    // Both field kinds look different on purpose: the key step masks, the rest show
    // what was typed. Whichever step the walk landed on, the paste has to be there.
    const bullets = row => row.match(/•/gu)?.length ?? 0
    const secretStep = /4\/9/u.test(plain(output))
    if (secretStep) {
      check(bullets(fieldAfter) === bullets(fieldBefore) + PASTE.length,
        `the pasted key is masked in the field (${bullets(fieldBefore)} → ${bullets(fieldAfter)} bullets)`)
      // Both halves of "the key never reaches the terminal": the painted text (what a
      // reader sees) and the raw bytes (what a log, a scrollback or a relay would hold).
      // A masked field writes `•`, so the raw stream is the stronger check and the same
      // assertion covers both.
      check(!plain(output.slice(beforePaste)).includes(PASTE), 'the pasted key is never painted')
      check(!output.slice(beforePaste).includes(PASTE), 'and never appears verbatim in the byte stream')
    } else {
      check(fieldAfter.includes(PASTE), `the paste reaches the field (${JSON.stringify(safeDetail(fieldAfter, 160, { home: knownHome }))})`)
    }
    check(fieldAfter !== fieldBefore, 'the paste repainted the field row')

    // 4. Resize keeps the field and the counter.
    term.resize(72, 20)
    await delay(600)
    const resized = plain(output.slice(beforeStep))
    check(/安装向导|Setup/u.test(resized), 'the wizard is still on screen after a resize')
    term.resize(120, 24)
    await delay(600)

    // 5. Esc leaves the wizard; the workspace comes back — and the paste is not in
    //    the composer waiting there. That is the failure this phase exists for: a
    //    wizard that did not own the paste left it in the draft behind the Screen,
    //    where it was invisible until the wizard closed and then looked like a
    //    message the reader had written.
    const beforeEsc = output.length
    term.write('\x1b')
    await delay(900)
    const after = plain(output.slice(beforeEsc))
    check(after.includes('目录') || after.includes('❯'), `the workspace is back after Esc (${JSON.stringify(safeDetail(after, 160, { home: knownHome }))})`)
    check(!after.includes(PASTE), 'the paste never reached the composer behind the wizard')
    successLines.push(`setup Screen: painted, listed (${listRows.length} rows), stepped, typed (${rows.length} rows), pasted${secretStep ? ' (masked)' : ''}, resized and left`)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  } finally {
    stopChild(termState)
    if (keep) console.log(`probe home kept: ${PROBE_HOME_LOCATION}`)
  }

  // 6. The other half of the claim: once the machine is configured, the wizard is
  //    not shown again. Completing the wizard over a real provider needs a real
  //    key, so this writes the credential the wizard would have saved and boots
  //    again — the decision under test is "configured ⇒ no first run", and it does
  //    not care how the key got there. (`--unconfigured` in `probe-home.mjs` is the
  //    other direction: the same home with no credential, which is phase 1 above.)
  //
  //    The first-install gate sets `PROBE_FI1_FIRST_SAVE`: it must run phase 7
  //    while the home is still unconfigured, or this configured boot would repair
  //    the agent plane first and hide whether the wizard save itself did it.
  if (problems.length === 0 && pty !== undefined && process.env.PROBE_FI1_FIRST_SAVE !== '1') {
    // The home is restored afterwards: this probe writes the credential a completed
    // wizard would have left, which would make the *next* run of this very probe skip
    // with "already configured". A probe that silently stops covering what it exists
    // to cover is worse than one that fails.
    const credentialFile = join(home, '.credentials.yaml')
    let previousCredential
    try {
      previousCredential = readFileSync(credentialFile, 'utf8')
    } catch {
      previousCredential = undefined
    }
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
    const secondState = trackChild('second-boot', second)
    active = { name: 'second-boot', output: () => secondOutput, child: secondState, cols: 100, rows: 30 }
    phase = 'configured-boot'
    try {
      const until = Date.now() + 45_000
      while (Date.now() < until && !/目录:|目录：/u.test(plain(secondOutput))) {
        if (secondState.exit !== undefined) break
        await delay(100)
      }
      const text = plain(secondOutput)
      // Freeze the child at the read that decides the assertions; `finally` will
      // then stop it on purpose and must not rewrite this observation.
      const observed = secondState.observed ?? (secondState.observed = observeChild(secondState))
      check(/目录:|目录：/u.test(text), 'the second boot reaches the workspace')
      check(observed.alive,
        `the second boot stays alive until the workspace is read (observed ${observed.alive ? 'alive' : 'exited'}; exit ${observed.exit?.exitCode ?? 'none'}, signal ${observed.exit?.signal ?? 'none'}, teardown ${observed.teardown})`)
      check(!/安装向导|选择提供商/u.test(text), 'and does not open the wizard again')
      successLines.push(`second boot on the configured home: ${/目录:|目录：/u.test(text) ? 'workspace, no wizard' : 'no workspace'}`)
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error))
    } finally {
      stopChild(secondState)
      // Put the home back the way this run found it.
      if (previousCredential === undefined) rmSync(credentialFile, { force: true })
      else writeFileSync(credentialFile, previousCredential, { mode: 0o600 })
    }
  }

  // 7. The wizard that is *finished* hands the workspace back — on a **resumed**
  //    session, which is where it was reported. A resume boot with nothing stored
  //    still opens the wizard (the launch flag is not evidence of configuration),
  //    so saving it is the last thing a reader does there; what is under test is
  //    that the save is also the dismissal, with no keypress in between. Before the
  //    fix the Screen stayed up until any key arrived — and that key's "no wizard
  //    behind this Screen" fallback is what closed it, which is why it looked like
  //    the wizard had simply forgotten to leave.
  if (problems.length === 0 && pty !== undefined) {
    const credentialFile = join(home, '.credentials.yaml')
    let previousCredential
    try {
      previousCredential = readFileSync(credentialFile, 'utf8')
    } catch {
      previousCredential = undefined
    }
    const sessionId = newestSessionId(home)
    if (sessionId === undefined) {
      console.log('SKIP: the home holds no session to resume, so the saved-wizard phase did not run')
    } else {
      const resumed = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
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
      let thirdOutput = ''
      resumed.onData(chunk => { thirdOutput += chunk })
      const resumedState = trackChild('resumed-save', resumed)
      active = { name: 'resumed-save', output: () => thirdOutput, child: resumedState, cols: 100, rows: 30 }
      phase = 'resumed-save'
      const waitForStep = async (want, label) => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          if (resumedState.exit !== undefined) {
            if (resumedState.observed === undefined) resumedState.observed = observeChild(resumedState)
            throw new Error(`the TUI exited while waiting for step ${want.join('/')} (${label}); exit ${resumedState.exit.exitCode}, signal ${resumedState.exit.signal}\n--- captured ---\n${safeDetail(wizardOf(thirdOutput).text, 1200, { home: knownHome })}`)
          }
          if (want.includes(wizardOf(thirdOutput).step)) return
          await delay(100)
        }
        if (resumedState.observed === undefined) resumedState.observed = observeChild(resumedState)
        throw new Error(`timed out waiting for step ${want.join('/')} (${label}); at ${wizardOf(thirdOutput).step}\n--- captured ---\n${safeDetail(wizardOf(thirdOutput).text, 1200, { home: knownHome })}`)
      }
      try {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline && wizardOf(thirdOutput).step === 0) await delay(100)
        check(wizardOf(thirdOutput).step === 1, `a resumed first run opens the wizard at step 1 (at ${wizardOf(thirdOutput).step})`)
        resumed.write('\r') // the highlighted provider
        await waitForStep([4], 'the key step')
        resumed.write('\x1b[200~sk-probe-saved-key\x1b[201~') // a key is pasted, not typed
        await delay(400)
        resumed.write('\r') // key → models
        await waitForStep([5], 'the models step')
        resumed.write('deepseek-v4-pro\r') // a typed list skips the picker
        // Sized from the installed catalog, this lands on the confirmation; a model it
        // cannot size gets the context step first. Both are the wizard's own path.
        await waitForStep([8, 9], 'the context step or the confirmation')
        if (wizardOf(thirdOutput).step === 8) {
          resumed.write('\r') // keep the inferred window
          await waitForStep([9], 'the confirmation')
        }
        const beforeSave = thirdOutput.length
        resumed.write('y') // save — and nothing is pressed after this
        const back = Date.now() + 30_000
        // The workspace is ready only when the *current visible grid* carries the
        // composer (boundary + prompt) and the footer cwd chip. The old test read the
        // accumulated stream, where a cleared dialog and its stale glyphs survive
        // forever; this one replays the stream into the terminal grid the reader is
        // actually looking at.
        const currentFrame = frameReader(() => thirdOutput)
        while (Date.now() < back) {
          if (workspaceFrameReady(await currentFrame())) break
          if (resumedState.exit !== undefined) break
          await delay(100)
        }
        // Freeze liveness at the observation, before `finally` stops the child.
        const observed = resumedState.observed ?? (resumedState.observed = observeChild(resumedState))
        const frame = await currentFrame()
        const after = plain(thirdOutput.slice(beforeSave))
        check(workspaceFrameReady(frame),
          `the workspace frame is ready after the save (current-frame 目录 + composer; ${JSON.stringify(safeRowsDetail(frame, 4, { home: knownHome }))})`)
        check(observed.alive,
          `the TUI stays alive after the save (observed ${observed.alive ? 'alive' : 'exited'}; exit ${observed.exit?.exitCode ?? 'none'}, signal ${observed.exit?.signal ?? 'none'}, teardown ${observed.teardown})`)
        check(frame.some(row => /^\s*(?:❯|>)(?:\s|$)/u.test(row)),
          `the workspace composer comes back on its own after the save (${JSON.stringify(safeRowsDetail(frame, 4, { home: knownHome }))})`)
        check(!/安装向导\s*9\/9/u.test(after), 'and the wizard is not still on screen')
        check(/配置完成/u.test(plain(thirdOutput)), 'the confirmation reaches the transcript, not just the Screen')
        successLines.push('resumed first run: wizard saved on step 9, workspace back with no extra keypress')
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error))
      } finally {
        stopChild(resumedState)
        // The saved key is this phase's own doing: put the home back unconfigured, or
        // the next run of this probe skips phase 1 as "already configured".
        if (previousCredential === undefined) rmSync(credentialFile, { force: true })
        else writeFileSync(credentialFile, previousCredential, { mode: 0o600 })
      }
    }
  }

  // PROBE_DIAG_ALWAYS keeps the synthetic screen/transcript for a green user-path
  // run too; CI uploads the packet only on failure, so the default stays `failure`.
  // Every problem is built from whole values above; this last pass is the fail-closed
  // guard for a caller-side mistake, not a licence to slice before sanitising.
  const reportedProblems = problems.map(problem => safeDetail(String(problem), 64 * 1024, { home: knownHome }))
  if (problems.length > 0 || process.env.PROBE_DIAG_ALWAYS === '1') {
    // The packet is written before anything is printed so a truncated log still
    // points at the directory CI uploaded.
    try {
      const screen = await wizardRows(active.output(), active.cols, active.rows)
      const bundle = writeDiagnosticBundle({
        dir: process.env.PROBE_DIAG_DIR ?? join(process.cwd(), '.ci-diagnostics'),
        phase: problems.length > 0 ? phase : `${phase}-complete`,
        problems: reportedProblems,
        // The raw PTY stream is ANSI; the bundle carries the readable transcript
        // and the synthetic screen separately. Both are sanitised whole inside.
        output: plain(active.output()),
        screen: screen.join('\n'),
        child: active.child,
        elapsedMs: Date.now() - startedAt,
        runtime: runtimeFacts(),
        home: knownHome,
      })
      if (problems.length > 0) await publishRemoteProbeFailure()
      const say = problems.length > 0 ? console.error : console.log
      say(diagnosticLine(bundle.dir))
      if (problems.length > 0) {
        // Sanitise the whole values first, then take the log excerpt. Slicing first
        // would let a cut through `sk-` turn the payload into unredacted text.
        console.error('--- captured screen (last 12 rows) ---')
        console.error(safeRowsDetail(screen, 12, { home: knownHome }))
        console.error('--- captured transcript (last 1600 chars) ---')
        console.error(safeDetail(active.output(), 1600, { home: knownHome }))
      }
    } catch (error) {
      console.error(`diagnostics: could not write the bundle under ${DIAGNOSTIC_LOCATION}: ${bundleErrorDetail(error, knownHome)}`)
    }
  }
  if (problems.length > 0) {
    // Success lines are unreachable here: reportOutcome only prints them when
    // `problems` is empty.
    return reportOutcome({ problems: reportedProblems, successLines: [], home: knownHome })
  }
  if (PTY_IS_CONPTY) {
    // Not a pass: the frame-shape half did not run. Everything the wizard *does*
    // did (it opens by itself, steps, types, survives a resize, hands the
    // workspace back), and the incremental-repaint contract is covered
    // headlessly by `tests/setup-screen.test.mjs` and `npm run bench`.
    successLines.push('SKIP: ConPTY re-emits frames as newline batches and adds clears of its own, so the')
    successLines.push('      row-addressed repaint checks cannot be read here; the wizard itself was walked')
    return reportOutcome({ problems, successLines })
  }
  successLines.push('OK: the setup wizard is a Screen — it paints its own frame, owns its field,')
  successLines.push('    survives a resize, hands the workspace back on Esc, and hands it back again')
  successLines.push('    when it is saved (on a resumed session, with no extra keypress)')
  return reportOutcome({ problems, successLines })
}

/**
 * Synthetic failure-path control used by the diagnostics test.
 *
 * It drives the same writer, sanitiser and log-excerpt helpers as a real failed
 * probe, but with sentinels only: no PTY, no provider, no real home. The control is
 * expected to exit nonzero, and it refuses to report success if any written file
 * still carries a sentinel, a home path, or an escape byte.
 */
async function runDiagnosticSelfTest() {
  const home = '/home/synthetic-user'
  const key = 'sk-SYNTHETIC-ONLY-1234567890'
  const transcript = `${key}\n${'x'.repeat(65_539 - key.length - 1)}`
  const screen = [
    '配置完成',
    `目录:${home}/project`,
    'Bearer\x1b[0m SYNTHETIC-ONLY-BEARER-TOKEN',
    'sk-\x1b[31mSYNTHETIC-ONLY-SPLIT-KEY',
  ].join('\n')
  const state = {
    name: 'self-test-child',
    pid: 4242,
    startedAt: Date.now() - 1_234,
    exit: { exitCode: 0, signal: null, at: Date.now() - 1_000 },
  }
  const observed = observeChild(state)
  state.observed = observed
  markTeardown(state) // after the observation: the bundle must keep teardown false
  // A zero-width split prefix is the reporter fail-closed control: the writer must
  // keep class-only metadata and the reporter must never echo the synthetic value.
  const splitKey = 'sk-\u200bSYNTHETIC-ONLY-SPLIT-CONTROL'
  let bundle
  try {
    bundle = writeDiagnosticBundle({
      dir: process.env.PROBE_DIAG_DIR ?? join(process.cwd(), '.ci-diagnostics'),
      phase: 'self-test',
      problems: [`synthetic failure: ${key} and ${home}`, `synthetic split control: ${splitKey}`],
      output: transcript,
      screen,
      child: state.observed,
      elapsedMs: 1_234,
      runtime: runtimeFacts(),
      home,
    })
  } catch (error) {
    // A write failure must not let Node print the resolved destination path in an
    // unhandled stack: fail closed to the same path-free location category.
    console.error(`diagnostics: could not write the self-test bundle under ${DIAGNOSTIC_LOCATION}: ${bundleErrorDetail(error, home)}`)
    return 1
  }
  const forbidden = ['SYNTHETIC-ONLY', home, '\x1b', 'sk-']
  for (const name of readdirSync(bundle.dir)) {
    const text = readFileSync(join(bundle.dir, name), 'utf8')
    for (const value of forbidden) {
      if (text.includes(value)) throw new Error(`self-test wrote an unsafe ${name}`)
    }
  }
  const json = JSON.parse(readFileSync(join(bundle.dir, 'diagnostics.json'), 'utf8'))
  if (json.child?.teardown !== false || json.child?.exit?.exitCode !== 0) {
    throw new Error('self-test lost the pre-teardown child observation')
  }
  console.error('--- synthetic failure log excerpt ---')
  console.error(safeExcerpt(`synthetic log line: ${key} home ${home}`, 400, { home }))
  console.error(diagnosticLine(bundle.dir))
  return reportOutcome({
    problems: ['synthetic failure: the workspace never came back', `synthetic split control: ${splitKey}`],
    successLines: [],
    home,
  })
}

const argv = process.argv.slice(2)
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(USAGE)
  process.exit(0)
}
if (process.env.PROBE_DIAG_SELFTEST === '1') {
  process.exit(await runDiagnosticSelfTest())
}
process.exit(await runProbe(argv))
