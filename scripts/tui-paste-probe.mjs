#!/usr/bin/env node
/**
 * Real-PTY probe for **paste**, in the workspace and behind the layers.
 *
 * 0.8.2 shipped a wizard whose field silently dropped a pasted API key. Nothing in
 * the harness had ever pasted into it: the probes drove the checkout and typed
 * characters, and the one path a user always takes — copy a key, paste it — was
 * covered only by unit tests that fed the reader a string instead of a terminal.
 * The wizard now has `tui-setup-probe.mjs` (bracketed paste, masked, raw bytes
 * never painted). This is the other half: the layers a user pastes into *after*
 * setup, which the 0.8.4 input-ownership rewrite touched.
 *
 * What "correct" means here is what the reader sees on the grid, because that is
 * what the incidents looked like:
 *
 *   1. a single-line paste lands in the composer (it is a paste, not 26 keys);
 *   2. a multi-line paste is **inserted**, not executed — a pasted stack trace must
 *      not submit on its embedded newlines — and stays one folded composer row;
 *   3. Ctrl+U clears it (the draft belongs to the composer, nothing else);
 *   4. a 4 kB paste is survived: one row, process alive, no full clear;
 *   5. a paste while a **Screen** is up reaches neither the screen nor the composer
 *      behind it, and the screen stays open;
 *   6. an escape-looking **tail inside a paste** (`…\x1bq…`) stays literal: it must
 *      not close the Screen the way a real Esc would — the unit-boundary contract;
 *   7. a paste the same way while the **picker** is up: no leak, picker stays;
 *   8. `/exit` hands the terminal back.
 *
 * Each step also asserts that nothing repainted with a full clear (`ESC[2J`/`ESC[H`),
 * except on ConPTY, which re-emits frames in its own shape — there the functional
 * assertions still run and the shape checks say they were skipped.
 *
 * Usage:
 *   node scripts/tui-paste-probe.mjs [--keep]
 *
 * Set `PROBE_HOME` to a home whose `tui` profile is installed and configured (the
 * same convention as the other probes; `probe-home.mjs --probe --script` builds one).
 * Exit code 0 means every assertion passed; on failure the captured grid is printed.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

// The pty in front may rewrite the frame shape these checks read (see the export).
import { PTY_IS_CONPTY } from './pty-window.mjs'

const require = createRequire(import.meta.url)
const ROOT = dirname(fileURLToPath(import.meta.url))
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const { screen: newGrid } = await import(pathToFileURL(join(ROOT, '../tests/screen.mjs')).href)

/** The grid the PTY's bytes produce: assertions are about what the reader sees. */
async function rowsOf(output) {
  const grid = await newGrid(100, 30)
  await grid.write(output)
  return grid.lines()
}

/**
 * The composer's own rows: below its rule, and only the prompt rows.
 *
 * Not "everything until the footer", because the footer is not one shape: a home
 * with a `/doctor` warning paints `⚠︎ … │ SSH … │ 空闲` where a clean one paints
 * `SSH …`, so a row-based boundary silently swallowed the status row into the
 * draft. The composer body is contiguous and every row of it starts with `>`.
 */
function composerRows(rows) {
  const rule = rows.map((row, index) => [row, index]).filter(([row]) => row.trimStart().startsWith('╭')).at(-1)?.[1]
  if (rule === undefined) return []
  const body = []
  for (let index = rule + 1; index < rows.length; index++) {
    const row = rows[index]
    if (row.trimStart().startsWith('>')) { body.push(row); continue }
    if (row.trim() === '') continue
    break
  }
  return body
}

/** The draft, as text: the field's rows without the `>` prompt or the `│` rule. */
function draftOf(rows) {
  return composerRows(rows).map(row => row.replace(/^\s*[>│] ?/u, '')).join('\n').trim()
}

/** Only the field's prompt rows — a folded draft is exactly one of them. */
function promptRows(rows) {
  return composerRows(rows).filter(row => row.trimStart().startsWith('>'))
}

function fullClearIn(chunk) {
  return /\x1b\[2J|\x1b\[H|\x1b\[J/u.test(chunk)
}

async function loadPty() {
  try {
    const mod = await import(pathToFileURL(require.resolve('node-pty', { paths: [process.cwd()] })).href)
    return mod.default ?? mod
  } catch {
    return undefined
  }
}

async function runProbe(argv) {
  const keep = argv.includes('--keep')
  const home = process.env.PROBE_HOME ?? process.env.DSH_HOME
  if (home === undefined) {
    console.log('SKIP: set PROBE_HOME to a configured home whose tui profile is installed')
    return 0
  }
  const pty = await loadPty()
  if (pty === undefined) {
    console.log('SKIP: node-pty is unavailable, so paste cannot be driven on a PTY here')
    return 0
  }

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
      SSH_CONNECTION: '10.0.0.2 55555 10.0.0.1 22',
      SSH_TTY: '/dev/pts/9',
    },
  })
  let output = ''
  let exited
  term.onData(chunk => { output += chunk })
  term.onExit(event => { exited = event })

  const problems = []
  const check = (condition, message) => { if (!condition) problems.push(message) }
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (await predicate()) return true
      await delay(100)
    }
    const rows = await rowsOf(output)
    throw new Error(`timed out waiting for ${label}\n--- the grid ---\n${rows.map((row, i) => `${String(i + 1).padStart(2)} ${row}`).join('\n')}`)
  }
  const onGrid = pattern => async () => (await rowsOf(output)).some(row => pattern.test(row))
  /** The slice of the stream a step produced — the shape checks read only this. */
  const since = mark => output.slice(mark)

  try {
    // 0. A configured home boots to the workspace, with a composer to paste into. A
    //    home that still needs onboarding is not this probe's subject — the wizard
    //    has its own (which pastes into its field); say so instead of timing out on
    //    a frame this run was never going to paint.
    const wizardUp = onGrid(/安装向导|Setup \d\/9|选择提供商/u)
    const composerUp = onGrid(/╭/u)
    await waitFor(async () => (await wizardUp()) || (await composerUp()), 90_000, 'the workspace composer or the first-run wizard')
    if (await wizardUp()) {
      console.log('SKIP: this home is unconfigured, so the wizard owns the keyboard')
      console.log('      (the wizard paste is `tui-setup-probe.mjs`; this probe is the workspace side)')
      return 0
    }
    // The composer's rule is painted before the first status row settles; wait for
    // the row that says a turn is idle so the paste is not racing the boot.
    await waitFor(onGrid(/空闲|idle/u), 60_000, 'the idle status row')
    let rows = await rowsOf(output)
    check(draftOf(rows) === '', 'the probe needs an empty draft to start from')

    // 1. A single-line paste lands in the composer.
    let mark = output.length
    term.write('\x1b[200~pasted-single-line\x1b[201~')
    await waitFor(async () => draftOf(await rowsOf(output)).includes('pasted-single-line'), 15_000, 'the pasted line in the composer')
    rows = await rowsOf(output)
    check(draftOf(rows) === 'pasted-single-line', `the paste is the whole draft (${JSON.stringify(draftOf(rows))})`)
    if (!PTY_IS_CONPTY) check(!fullClearIn(since(mark)), 'a paste must not clear the screen')
    check(rows.some(row => /空闲|idle/u.test(row)), 'a paste does not submit a turn')

    // 2. A multi-line paste is inserted, not executed: the embedded newlines must
    //    not behave like Enter, and the draft stays one folded row (the composer is
    //    one row tall, so a 40-line paste cannot push the workspace off the screen).
    term.write('\x15')
    await delay(400)
    mark = output.length
    term.write('\x1b[200~first-line\nsecond-line\nthird-line\x1b[201~')
    await delay(1200)
    rows = await rowsOf(output)
    check(draftOf(rows) !== '', 'the multi-line paste did not vanish')
    check(promptRows(rows).length === 1, `a multi-line paste stays one composer row (${promptRows(rows).length})`)
    if (!PTY_IS_CONPTY) check(!fullClearIn(since(mark)), 'a multi-line paste must not clear the screen')
    check(rows.filter(row => /first-line/u.test(row)).length === 0, 'a pasted newline must not submit the draft (the text is not echoed as a turn)')
    check(rows.some(row => /空闲|idle/u.test(row)), 'the session is still idle after a multi-line paste')

    // 3. Ctrl+U clears the draft.
    term.write('\x15')
    await waitFor(async () => draftOf(await rowsOf(output)) === '', 10_000, 'Ctrl+U to clear the draft')

    // 4. A 4 kB paste is survived: one row, alive, no clear. The row is clipped to
    //    the terminal width, so the assertion is the shape, not the text.
    mark = output.length
    term.write(`\x1b[200~${'x'.repeat(4000)}\x1b[201~`)
    await delay(1500)
    rows = await rowsOf(output)
    check(draftOf(rows).length > 0, 'the 4 kB paste reached the composer')
    check(promptRows(rows).length === 1, `a 4 kB paste stays one composer row (${promptRows(rows).length})`)
    if (!PTY_IS_CONPTY) check(!fullClearIn(since(mark)), 'a 4 kB paste must not clear the screen')
    check(exited === undefined, 'the TUI survived the 4 kB paste')
    term.write('\x15')
    await waitFor(async () => draftOf(await rowsOf(output)) === '', 10_000, 'Ctrl+U after the big paste')

    // 5. A paste behind a Screen: the Screen owns the keyboard, so nothing may
    //    reach the composer it is drawn over — and the Screen must stay open.
    term.write('/diag\r')
    await waitFor(onGrid(/判定链|verdict chain/u), 60_000, 'the /diag Screen')
    mark = output.length
    term.write('\x1b[200~PASTED-BEHIND-SCREEN\x1b[201~')
    await delay(1200)
    rows = await rowsOf(output)
    check(!rows.some(row => row.includes('PASTED-BEHIND-SCREEN')), 'a paste behind a Screen is not painted anywhere')
    check(rows.some(row => /判定链|verdict chain/u.test(row)), 'the Screen stays open across the paste')
    if (!PTY_IS_CONPTY) check(!fullClearIn(since(mark)), 'a paste behind a Screen must not clear the screen')
    term.write('\x1b')
    await waitFor(onGrid(/输入 \/help/u), 20_000, 'the workspace back after Esc')
    check(draftOf(await rowsOf(output)) === '', 'the paste behind the Screen never reached the composer')

    // 6. An escape-looking tail **inside** a paste is text, not an Esc: bracketed
    //    paste is one unit, and the unit boundary is what keeps `\x1bq` from closing
    //    the Screen it was pasted into.
    term.write('/diag\r')
    await waitFor(onGrid(/判定链|verdict chain/u), 60_000, 'the /diag Screen (tail case)')
    mark = output.length
    term.write('\x1b[200~tail\x1bqpayload\x1b[201~')
    await delay(1200)
    rows = await rowsOf(output)
    check(rows.some(row => /判定链|verdict chain/u.test(row)), 'an ESC-looking tail inside a paste does not close the Screen')
    check(!rows.some(row => /tail|payload/u.test(row)), 'an ESC-looking tail inside a paste is not painted')
    if (!PTY_IS_CONPTY) check(!fullClearIn(since(mark)), 'the tail paste must not clear the screen')
    term.write('\x1b')
    await waitFor(onGrid(/输入 \/help/u), 20_000, 'the workspace back after the tail case')

    // 7. The picker is the other layer that borrows the keyboard.
    term.write('/view\r')
    await waitFor(onGrid(/工作区视图|Workspace view/u), 20_000, 'the /view picker')
    mark = output.length
    term.write('\x1b[200~PASTED-IN-PICKER\x1b[201~')
    await delay(1000)
    rows = await rowsOf(output)
    check(!rows.some(row => row.includes('PASTED-IN-PICKER')), 'a paste into the picker is not painted anywhere')
    check(rows.some(row => /工作区视图|Workspace view/u.test(row)), 'the picker stays open across the paste')
    if (!PTY_IS_CONPTY) check(!fullClearIn(since(mark)), 'a paste into the picker must not clear the screen')
    term.write('\x1b')
    await waitFor(onGrid(/输入 \/help/u), 20_000, 'the workspace back after the picker')
    check(draftOf(await rowsOf(output)) === '', 'the picker paste never reached the composer')

    // 8. `/exit` hands the terminal back instead of leaving a shell with no prompt.
    term.write('/exit\r')
    await waitFor(async () => exited !== undefined, 20_000, 'the process to exit after /exit')
    check(exited.exitCode === 0, `/exit leaves with code 0 (${exited.exitCode})`)
  } catch (error) {
    problems.push(String(error?.message ?? error))
  } finally {
    if (exited === undefined && !keep) term.kill()
  }

  if (problems.length > 0) {
    console.log('--- captured grid ---')
    const rows = await rowsOf(output)
    for (const [index, row] of rows.entries()) console.log(`${String(index + 1).padStart(2)} ${row}`)
    console.log('--- captured stream (plain, tail) ---')
    console.log(output.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '').slice(-1500))
    for (const problem of problems) console.log(`FAIL: ${problem}`)
    return 1
  }
  console.log('OK: a single-line paste lands in the composer, a multi-line paste is inserted not executed,')
  console.log('    4 kB survives, and a paste behind a Screen, a picker or an ESC-looking tail reaches')
  console.log('    neither the layer nor the composer behind it')
  if (PTY_IS_CONPTY) console.log('note: ConPTY rewrites the frame shape, so the full-clear checks were skipped; the functional assertions ran')
  return 0
}

process.exitCode = await runProbe(process.argv.slice(2))
