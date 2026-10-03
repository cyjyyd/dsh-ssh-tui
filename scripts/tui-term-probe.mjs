#!/usr/bin/env node
/**
 * Terminal-capability probe: boot the real TUI once per terminal and assert the
 * control sequences that terminal would actually receive.
 *
 * `tests/terminal-caps.test.mjs` pins the table (which terminal claims what);
 * this pins the *wiring* — that the mouse, bracketed paste, the alternate screen
 * and the clipboard hint follow the table rather than being emitted
 * unconditionally, which is how they shipped for years.
 *
 * The terminals are simulated with the environment markers they really export
 * (`VTE_VERSION`, `KONSOLE_VERSION`, `STY`, `WT_SESSION`), so the POSIX profiles
 * run anywhere. The two Windows profiles need a real `win32` platform and are
 * therefore skipped on Linux — the Windows CI leg runs them.
 *
 * Usage:
 *   PROBE_HOME=<throwaway home> node scripts/tui-term-probe.mjs
 *   node scripts/probe-home.mjs --probe --script tui-term-probe.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import process from 'node:process'

const require = createRequire(import.meta.url)
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = require.resolve('@deepseek-ai/dsh/lib/bin.js')
const { IS_WINDOWS } = await import(pathToFileURL(join(REPO, 'lib', 'platform.js')).href)

/**
 * One profile per terminal, with the escapes it must and must not receive.
 *
 * `mouse`/`paste`/`alt` are the mode-setting sequences; `1006h` is the SGR
 * encoding a drag needs; `hint` is the OSC 52 explanation that must appear
 * exactly where the clipboard cannot work at all.
 */
const PROFILES = [
  {
    name: 'GNOME Terminal (VTE 0.70)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', VTE_VERSION: '7000', TERM_PROGRAM: 'gnome-terminal', DSH_TUI_NO_GLYPH_PROBE: '1' },
    // VTE never implemented OSC 52, so this is the terminal where the caveat
    // matters most — the case the first version of this table got wrong.
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'XFCE Terminal (VTE 0.70)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', VTE_VERSION: '7000', TERM_PROGRAM: 'xfce4-terminal', DSH_TUI_NO_GLYPH_PROBE: '1' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Konsole 23.08 (before OSC 52)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', KONSOLE_VERSION: '230800', DSH_TUI_NO_GLYPH_PROBE: '1' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Konsole 24.12 (OSC 52 landed here)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', KONSOLE_VERSION: '241200', DSH_TUI_NO_GLYPH_PROBE: '1' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: false },
  },
  {
    name: 'tmux',
    env: { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,1,0', DSH_TUI_NO_GLYPH_PROBE: '1' },
    // tmux forwards OSC 52 only with `set-clipboard on`, so it is unpromised and
    // the user is told once.
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'screen',
    env: { TERM: 'screen-256color', STY: '1234.pts-0.host', DSH_TUI_NO_GLYPH_PROBE: '1' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Linux virtual console',
    // A Linux VT only exists on a POSIX host: on Windows the same TERM can only
    // come from a wrapper, and the platform wins (see terminal-caps.ts), so the
    // profile is skipped there rather than asserting a state that cannot occur.
    posixOnly: true,
    env: { TERM: 'linux', DSH_TUI_NO_GLYPH_PROBE: '1' },
    expect: { mouse: false, sgr: false, paste: false, alt: false, clipboardHint: true },
  },
  {
    name: 'dumb terminal',
    env: { TERM: 'dumb', DSH_TUI_NO_GLYPH_PROBE: '1' },
    // An unlabelled terminal keeps the baseline (the escapes are ignored where
    // unsupported) but is promised no clipboard, so it gets the caveat once.
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Windows Terminal',
    win32Only: true,
    env: { WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000', COLORTERM: 'truecolor', DSH_TUI_NO_GLYPH_PROBE: '1' },
    // TERM is unset here on purpose: that is what Windows Terminal reports, and
    // reading it as "no terminal" is what turned Windows black and white.
    expect: { term: '', mouse: true, sgr: true, paste: true, alt: true, clipboardHint: false },
  },
  {
    name: 'Windows console (conhost)',
    win32Only: true,
    env: { SESSIONNAME: 'Console', DSH_TUI_NO_GLYPH_PROBE: '1' },
    // No bracketed paste: conhost only gained `?2004` in Windows 11 22H2.
    expect: { term: '', mouse: true, sgr: true, paste: false, alt: true, clipboardHint: true },
  },
  {
    name: 'Windows console (conhost, legacy codepage)',
    win32Only: true,
    // A console whose output code page is not UTF-8: `platform.ts` reads that
    // from the environment and swaps the chrome for ASCII, which is the one
    // Windows case where the new meters must draw `#`/`.`/`*`/`o` instead of
    // `█`/`░`/`●`/`○`.
    env: { SESSIONNAME: 'Console', DSH_TUI_ASCII: '1', DSH_TUI_NO_GLYPH_PROBE: '1' },
    expect: { term: '', mouse: true, sgr: true, paste: false, alt: true, clipboardHint: true, asciiChrome: true },
  },
]

/**
 * The screen as the terminal holds it, rebuilt from the byte stream.
 *
 * The painter addresses rows absolutely (`\x1b[<row>;1H`) and a later write wins, so the
 * whole output reconstructs the current screen. Splitting the stream on addresses — the
 * older way — assumed one chunk is one row, which stopped being true when the painter
 * began returning the caret after every row it writes (a multi-line logo row arrives as
 * a single chunk).
 */
function screenRows(text) {
  const rows = new Map()
  const pattern = /\x1b\[(\d+);1H([\s\S]*?)(?=\x1b\[\d+;1H|\x1b\[\?7h|$)/gu
  for (const match of text.matchAll(pattern)) rows.set(Number(match[1]), plain(match[2] ?? ''))
  return rows
}

function plain(text) {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/gu, '').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/gu, '')
}

async function loadPty() {
  try {
    return await import(pathToFileURL(require.resolve('node-pty', { paths: [process.cwd()] })).href)
      .then(mod => mod.default ?? mod)
  } catch {
    return undefined
  }
}

/** Boot one TUI under `profile`, drive `/copy error`, and return its bytes. */
async function probeProfile(pty, { env: extra, name, expect }) {
  const home = process.env.PROBE_HOME ?? process.env.DSH_HOME
  if (home === undefined || home === '') throw new Error('PROBE_HOME (or DSH_HOME) must point at a throwaway profile')
  const env = {
    ...process.env,
    DSH_HOME: home,
    // Deterministic: no update prompt, and the profile's own language wins.
    DSH_TUI_NO_UPDATE_CHECK: '1',
    ...extra,
  }
  // Every profile here simulates a *local* terminal (it sets that emulator's own
  // markers), so the ambient SSH markers have to go: run from an SSH session —
  // or from a jump host, which is the whole point of the plugin — the TUI
  // otherwise reads itself as remote, where it deliberately keeps the clipboard
  // caveat quiet, and every profile that expects the caveat fails. The unit test
  // clears the same three for the same reason (tests/copy-text.test.mjs).
  for (const key of ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']) delete env[key]
  // An unset TERM is the Windows case; deleting it here reproduces that rather
  // than inheriting the runner's.
  if (expect.term === '') delete env.TERM

  const sessionId = `main-session-${randomUUID()}`
  const term = pty.spawn(process.execPath, [CLI, '--profile', 'tui', `--resume=${sessionId}`], {
    name: env.TERM ?? 'xterm-256color',
    cols: 100,
    rows: 30,
    cwd: process.cwd(),
    env,
  })
  let output = ''
  term.onData(chunk => { output += chunk })
  const waitFor = async (predicate, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(output)) return true
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error(`${name}: timed out waiting for ${label}\n--- captured ---\n${plain(output).slice(-800)}`)
  }
  try {
    await waitFor(text => text.includes('DeepSeek Harness'), 90_000, 'the boot banner')
    // A report is a Screen since B2.1 (AD-7): it leaves no row behind, so the copy
    // path that replaced a `diag` row is gone — the copy *key* is now the only way
    // to the report's text (which is also why the Screen carries it at all). What
    // this probe really checks is the clipboard behaviour of each terminal profile,
    // and that is the same key either way.
    term.write('/diag\r')
    await waitFor(text => /判定链|verdict chain/u.test(text), 30_000, 'the /diag report')
    await new Promise(resolve => setTimeout(resolve, 500))
    const before = output.length
    term.write('\x1b[99;6u')
    if (expect.clipboardHint) {
      await waitFor(text => text.slice(before).includes('OSC 52'), 20_000, 'the /copy explanation')
    } else {
      // Nothing to wait for where the hint must *not* appear: give the frame time to
      // arrive, then assert its absence on the whole transcript.
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
    term.write('\x1b')
    await new Promise(resolve => setTimeout(resolve, 500))
    term.write('/exit\r')
    await new Promise(resolve => { const t = setTimeout(resolve, 8_000); term.onExit(() => { clearTimeout(t); resolve() }) })
  } catch (error) {
    try { term.kill() } catch { /* already gone */ }
    throw error
  } finally {
    // ConPTY keeps handles that outlive the child, and this probe starts nine
    // windows in one process: without disposing each one the script finishes its
    // work and then never exits (which is exactly how the first Windows run of
    // this probe hung with every profile already reported OK).
    try { term.kill() } catch { /* already gone */ }
  }
  return output
}

/**
 * What the status row must look like in one terminal's bytes.
 *
 * The footer pass replaced the old telemetry dump with a row of meters, so the
 * probe checks the row itself rather than only the mode switches around it. Rows
 * are addressed absolutely (`CSI row;col H`) and never newline-separated, so the
 * output is split on the addressing sequences: taking the last newline-delimited
 * line would silently concatenate the transcript, both footer rows and the
 * prompt into one string and assert against that.
 */
function checkStatusRow(profile, output) {
  const problems = []
  const want = (condition, message) => { if (!condition) problems.push(message) }
  const chunks = output
    .split(/\x1b\[\d+;\d+H/u)
    .map(plain)
    // The status row is the one carrying the link chip and the group separator, in
    // whichever glyph set that terminal decodes (`│` on UTF-8, `|` on an ASCII console —
    // the same swap the rest of the chrome makes). Single-line matches win: a frame that
    // arrives as one newline-separated batch also contains the row, and answering with
    // that batch would be answering with the whole screen.
    .filter(line => /\bSSH\b|本机|本地|local/u.test(line) && (line.includes('│') || line.includes('|')))
  const single = chunks.filter(line => !line.includes('\n'))
  const painted = single.length > 0 ? single : chunks
  want(painted.length > 0, 'the status row never painted')
  const row = painted.at(-1) ?? ''
  // `DSH_TUI_ASCII=1` in the environment covers every profile at once, which is
  // how the ASCII row is acceptance-tested on a POSIX PTY (the conhost profile
  // that declares it natively only runs on the Windows leg).
  const ascii = profile.expect.asciiChrome === true || process.env.DSH_TUI_ASCII === '1'
  // The link chip leads with the label, then four pips. Which of the four are
  // filled depends on whether this PTY answered the CSI-6n probe — a probe that
  // missed its window reports "unknown", which is four hollow circles — so the
  // row is checked for the *glyph set*, not for a particular measurement.
  const mark = ascii ? '[*o]' : '[●○]'
  want(
    new RegExp(`(?:SSH|本机|本地|local)\\s+${mark}{4}\\s`, 'u').test(row),
    `the link chip leads with four pips: ${JSON.stringify(row.slice(0, 120))}`,
  )
  want(
    new RegExp(`${mark}{4}`, 'u').test(row),
    `the pips use the ${ascii ? 'ASCII' : 'Unicode'} glyph set: ${JSON.stringify(row.slice(0, 120))}`,
  )
  if (ascii) {
    // The ASCII console must not receive a single UTF-8 chrome glyph: the meters
    // are the newest place one could leak from.
    want(!/[●○█░]/u.test(row), `no UTF-8 chrome on an ASCII console: ${JSON.stringify(row.slice(0, 120))}`)
  }
  // The counters that left the default row really left it.
  for (const gone of ['轮 ·', '缓存命中', 'cache hit']) {
    want(!row.includes(gone), `"${gone}" is still on the status row: ${JSON.stringify(row.slice(0, 160))}`)
  }
  return problems
}

function checkProfile(profile, output) {
  const problems = []
  const has = needle => output.includes(needle)
  const want = (condition, message) => { if (!condition) problems.push(message) }
  const mode = (final, label, expected) =>
    want(has(`\x1b[?${final}`) === expected, `${label} should ${expected ? '' : 'not '}be enabled (\x1b[?${final})`)

  mode('1000h', 'mouse reporting', profile.expect.mouse)
  mode('1006h', 'SGR mouse encoding', profile.expect.sgr)
  mode('2004h', 'bracketed paste', profile.expect.paste)
  mode('1049h', 'alternate screen', profile.expect.alt)
  if (profile.expect.mouse === false) {
    want(!has('\x1b[?1002h'), 'no drag reporting without a mouse')
  }
  problems.push(...checkStatusRow(profile, output))
  // The /copy report always goes out; the explanation only where the clipboard
  // cannot work at all.
  want(plain(output).includes('OSC 52') === profile.expect.clipboardHint,
    profile.expect.clipboardHint
      ? 'the /copy explanation must appear where OSC 52 cannot work'
      : 'no clipboard explanation where OSC 52 may work')
  return problems
}

async function main() {
  const pty = await loadPty()
  if (pty === undefined) {
    if (process.env.PROBE_REQUIRE_PTY === '1') {
      console.log('FAIL: node-pty is unavailable, so the TUI cannot be driven on a PTY here (PROBE_REQUIRE_PTY=1)')
      return 1
    }
    console.log('SKIP: node-pty is unavailable, so the TUI cannot be driven on a PTY here')
    return 0
  }
  const profiles = PROFILES.filter(profile =>
    (profile.win32Only !== true || IS_WINDOWS) && (profile.posixOnly !== true || !IS_WINDOWS))
  const skipped = PROFILES.filter(profile =>
    (profile.win32Only === true && !IS_WINDOWS) || (profile.posixOnly === true && IS_WINDOWS))
  console.log(`probing ${profiles.length} terminal profiles${skipped.length === 0 ? '' : ` (${skipped.length} platform-specific skipped)`}`)

  const failures = []
  for (const profile of profiles) {
    try {
      const output = await probeProfile(pty, profile)
      const problems = checkProfile(profile, output)
      if (problems.length === 0) {
        console.log(`  ✓ ${profile.name}`)
      } else {
        console.error(`FAIL: ${profile.name}`)
        for (const problem of problems) console.error(`  - ${problem}`)
        failures.push(profile.name)
      }
    } catch (error) {
      console.error(`FAIL: ${profile.name}`)
      console.error(`  - ${error instanceof Error ? error.message : String(error)}`)
      failures.push(profile.name)
    }
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} profile(s) failed: ${failures.join(', ')}`)
    return 1
  }
  console.log(`OK: ${profiles.length} terminal profiles emitted exactly their capabilities`)
  return 0
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const code = await main()
  // Explicit, for the same reason: a standalone diagnostic must not be held open
  // by a terminal handle it no longer needs.
  process.exit(code)
}
