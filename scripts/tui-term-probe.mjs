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
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', VTE_VERSION: '7000', TERM_PROGRAM: 'gnome-terminal' },
    // VTE never implemented OSC 52, so this is the terminal where the caveat
    // matters most — the case the first version of this table got wrong.
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'XFCE Terminal (VTE 0.70)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', VTE_VERSION: '7000', TERM_PROGRAM: 'xfce4-terminal' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Konsole 23.08 (before OSC 52)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', KONSOLE_VERSION: '230800' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Konsole 24.12 (OSC 52 landed here)',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor', KONSOLE_VERSION: '241200' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: false },
  },
  {
    name: 'tmux',
    env: { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,1,0' },
    // tmux forwards OSC 52 only with `set-clipboard on`, so it is unpromised and
    // the user is told once.
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'screen',
    env: { TERM: 'screen-256color', STY: '1234.pts-0.host' },
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Linux virtual console',
    // A Linux VT only exists on a POSIX host: on Windows the same TERM can only
    // come from a wrapper, and the platform wins (see terminal-caps.ts), so the
    // profile is skipped there rather than asserting a state that cannot occur.
    posixOnly: true,
    env: { TERM: 'linux' },
    expect: { mouse: false, sgr: false, paste: false, alt: false, clipboardHint: true },
  },
  {
    name: 'dumb terminal',
    env: { TERM: 'dumb' },
    // An unlabelled terminal keeps the baseline (the escapes are ignored where
    // unsupported) but is promised no clipboard, so it gets the caveat once.
    expect: { mouse: true, sgr: true, paste: true, alt: true, clipboardHint: true },
  },
  {
    name: 'Windows Terminal',
    win32Only: true,
    env: { WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000', COLORTERM: 'truecolor' },
    // TERM is unset here on purpose: that is what Windows Terminal reports, and
    // reading it as "no terminal" is what turned Windows black and white.
    expect: { term: '', mouse: true, sgr: true, paste: true, alt: true, clipboardHint: false },
  },
  {
    name: 'Windows console (conhost)',
    win32Only: true,
    env: { SESSIONNAME: 'Console' },
    // No bracketed paste: conhost only gained `?2004` in Windows 11 22H2.
    expect: { term: '', mouse: true, sgr: true, paste: false, alt: true, clipboardHint: true },
  },
]

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
    // A fresh profile has no error row, so there would be nothing for
    // `/copy error` to copy: `/diag` first, which the copy path accepts as a
    // diagnostic row.
    term.write('/diag\r')
    await waitFor(text => /判定链|verdict chain/u.test(text), 30_000, 'the /diag report')
    // The clipboard hint is what a user reads after `/copy` on a terminal that
    // cannot write the clipboard; driving the command is the only way to prove
    // it is wired rather than merely declared.
    const before = output.length
    term.write('/copy error\r')
    if (expect.clipboardHint) {
      await waitFor(text => text.slice(before).includes('OSC 52'), 20_000, 'the /copy explanation')
    } else {
      // Nothing to wait for where the hint must *not* appear: give the command
      // time to run, then assert its absence on the whole transcript.
      await new Promise(resolve => setTimeout(resolve, 2_000))
    }
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
