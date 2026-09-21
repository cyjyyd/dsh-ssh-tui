import test from 'node:test'
import assert from 'node:assert/strict'

import {
  bracketedPasteSequence, detectTerminalFamily, mouseDisableSequence, mouseEnableSequence,
  parseCapsOverride, parseCapsOverrideReport, terminalCapabilities,
} from '../lib/terminal-caps.js'

/**
 * One fixture per terminal a user actually has in front of them.
 *
 * The point of this file is that none of these machines are needed to run it:
 * every terminal is an environment, the classifier takes that environment as a
 * parameter, and the Windows branches run on Linux (see docs/platform.md for
 * why that rule exists). The environments below are the real markers each
 * terminal exports — `WT_SESSION` for Windows Terminal, `VTE_VERSION` for the
 * GNOME/XFCE/Fork family, `KONSOLE_VERSION`, `TMUX`, `STY`.
 *
 * What is pinned is not only "we detect it" but "we claim exactly the
 * capabilities it has": a capability claimed wrongly is worse than one missed,
 * because the sequence is emitted and the terminal either ignores it (the user
 * thinks `/copy` worked) or swallows the mouse.
 */

/** Windows Terminal, the only Windows host with OSC 52 and OSC 8. */
const WINDOWS_TERMINAL = {
  WT_SESSION: '9d0f5b6a-0000-4000-8000-000000000000',
  COLORTERM: 'truecolor',
  SESSIONNAME: 'Console',
}

/** conhost: no WT_SESSION, no TERM — the state a PowerShell window is in. */
const WINDOWS_CONSOLE = { SESSIONNAME: 'Console' }

/** GNOME Terminal 3.44 (VTE 0.70) under a UTF-8 locale. */
const GNOME_TERMINAL = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  VTE_VERSION: '7000',
  TERM_PROGRAM: 'gnome-terminal',
  LANG: 'zh_CN.UTF-8',
}

/** XFCE Terminal: same VTE widget, another desktop. */
const XFCE_TERMINAL = {
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  VTE_VERSION: '7000',
  TERM_PROGRAM: 'xfce4-terminal',
}

/** An old VTE (0.48, e.g. a long-term distribution): no OSC 52 and no OSC 8. */
const OLD_VTE = { TERM: 'xterm', VTE_VERSION: '4800' }

const KONSOLE = { TERM: 'xterm-256color', COLORTERM: 'truecolor', KONSOLE_VERSION: '250400' }
const OLD_KONSOLE = { TERM: 'xterm-256color', KONSOLE_VERSION: '210400' }
const XTERM = { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
const TMUX = { TERM: 'tmux-256color', TMUX: '/tmp/tmux-1000/default,1234,0', COLORTERM: 'truecolor' }
const SCREEN = { TERM: 'screen-256color', STY: '1234.pts-0.host' }
const LINUX_CONSOLE = { TERM: 'linux' }
const DUMB = { TERM: 'dumb' }

const caps = (env, platform = 'linux') => terminalCapabilities({ env, platform })

test('Windows Terminal is detected and gets the full sequence set', () => {
  const c = caps(WINDOWS_TERMINAL, 'win32')
  assert.equal(c.family, 'windows-terminal')
  assert.equal(c.label, 'Windows Terminal')
  assert.equal(c.colors, 'truecolor')
  assert.deepEqual(
    [c.mouse, c.mouseSgr, c.mouseDrag, c.bracketedPaste, c.alternateScreen, c.osc52, c.osc8, c.title],
    [true, true, true, true, true, true, true, true],
  )
})

test('a legacy Windows console keeps the mouse but loses clipboard and links', () => {
  const c = caps(WINDOWS_CONSOLE, 'win32')
  assert.equal(c.family, 'windows-console')
  assert.equal(c.label, 'Windows console (conhost)')
  // Claiming OSC 52 here is what made `/copy` look successful on a console that
  // never writes the clipboard.
  assert.equal(c.osc52, false)
  assert.equal(c.osc8, false)
  // Mouse stays on: conhost has had VT mouse input since Windows 10 1703, and
  // mouse reporting is how cards expand.
  assert.equal(c.mouse, true)
  assert.equal(c.mouseSgr, true)
  // Bracketed paste only reached conhost in 2022-11 (Windows 11 22H2), and the
  // PowerShell/cmd case this row is about is usually older than that.
  assert.equal(c.bracketedPaste, false)
  // An empty TERM on Windows is normal, so colour must survive it.
  assert.notEqual(c.colors, 'none')
})

test('the VTE family is never promised OSC 52, whatever its version', () => {
  // VTE has never implemented it (GNOME/vte#125 is still open, and the widget
  // only parses the sequence). Claiming it here was the worst case in the whole
  // table: GNOME Terminal is the most common Linux desktop terminal, so the
  // promise reached the most users and `/copy` reported a copy nobody made.
  for (const [env, program] of [[GNOME_TERMINAL, 'gnome-terminal'], [XFCE_TERMINAL, 'xfce4-terminal']]) {
    const c = caps(env)
    assert.equal(c.family, 'vte')
    assert.match(c.label, new RegExp(program, 'u'))
    assert.match(c.label, /VTE 7000/u)
    assert.equal(c.osc52, false, `${program} ignores OSC 52`)
    assert.equal(c.osc8, true, 'OSC 8 has been in VTE since 0.50')
    assert.equal(c.mouseSgr, true)
    assert.equal(c.alternateScreen, true)
  }
  assert.equal(caps(OLD_VTE).osc52, false)
  assert.equal(caps(OLD_VTE).osc8, false, 'OSC 8 predates 0.50 only on ancient VTE')
  assert.equal(caps(OLD_VTE).mouse, true)
})

test('Konsole is recognised, and OSC 52 needs 24.12', () => {
  assert.equal(caps(KONSOLE).family, 'konsole')
  assert.equal(caps(KONSOLE).osc52, true, '24.12 is where the write-only patch shipped')
  assert.equal(caps(OLD_KONSOLE).osc52, false, '21.04 predates it by three years')
  // The boundary itself: 24.08 missed the cut, 24.12 made it.
  assert.equal(caps({ TERM: 'xterm-256color', KONSOLE_VERSION: '240800' }).osc52, false)
  assert.equal(caps({ TERM: 'xterm-256color', KONSOLE_VERSION: '241200' }).osc52, true)
})

test('tmux and screen are recognised through their own markers', () => {
  const inTmux = caps(TMUX)
  assert.equal(inTmux.family, 'tmux')
  // tmux forwards OSC 52 only when the user turned `set-clipboard` on, so it is
  // not promised; everything else is forwarded.
  assert.equal(inTmux.osc52, false)
  assert.equal(inTmux.mouseSgr, true)
  assert.equal(inTmux.bracketedPaste, true)

  const inScreen = caps(SCREEN)
  assert.equal(inScreen.family, 'screen')
  assert.equal(inScreen.osc52, false)
  assert.equal(inScreen.osc8, false)
})

test('the Linux virtual console loses the mouse and keeps its scrollback', () => {
  const c = caps(LINUX_CONSOLE)
  assert.equal(c.family, 'linux-console')
  assert.deepEqual(
    [c.mouse, c.bracketedPaste, c.alternateScreen, c.osc52, c.osc8, c.title],
    [false, false, false, false, false, false],
  )
  // It still paints, with the 8-colour palette.
  assert.equal(c.colors, '8')
})

test('a dumb terminal keeps the baseline but is promised no clipboard', () => {
  // `TERM=dumb` is what a wrapper, a CI pty or an unlabelled terminal reports.
  // Dropping to nothing would silently disable the mouse and the alternate
  // screen on a terminal that may well handle them — and a mode-setting escape
  // an unsupported terminal does not understand is ignored, which costs
  // nothing. The promises a user cannot verify by looking are the ones dropped.
  const c = caps(DUMB)
  assert.equal(c.family, 'dumb')
  assert.equal(c.mouse, true)
  assert.equal(c.bracketedPaste, true)
  assert.equal(c.alternateScreen, true)
  assert.equal(c.osc52, false)
  assert.equal(c.osc8, false)
  assert.equal(c.title, false)
  // Colour is a different question: NO_COLOR and `dumb` mean what they say.
  assert.equal(c.colors, 'none')
})

test('an unrecognised TERM keeps the xterm baseline but not the clipboard promise', () => {
  const c = caps({ TERM: 'weird-terminal-9000' })
  assert.equal(c.family, 'unknown')
  assert.equal(c.mouse, true)
  assert.equal(c.osc52, false, 'an unknown terminal is never promised OSC 52')
})

test('the emitted sequences match the declared capabilities', () => {
  const full = caps(WINDOWS_TERMINAL, 'win32')
  assert.equal(mouseEnableSequence(full), '\x1b[?1006h\x1b[?1002h\x1b[?1000h')
  assert.equal(bracketedPasteSequence(full, true), '\x1b[?2004h')

  const console_ = caps(LINUX_CONSOLE)
  assert.equal(mouseEnableSequence(console_), '', 'no mouse sequences where there is no mouse')
  assert.equal(bracketedPasteSequence(console_, true), '')

  // Disabling is always emitted: leaving a mode on after exit is the failure
  // that hurts, and `l` on a mode that was never enabled is ignored.
  assert.equal(mouseDisableSequence(), '\x1b[?1000l\x1b[?1002l\x1b[?1006l')

})

test('user overrides beat detection, in both directions', () => {
  assert.equal(caps({ ...GNOME_TERMINAL, DSH_TUI_TERM_CAPS: 'no-mouse' }).mouse, false)
  // Forcing the mouse on a terminal we judged SGR-less brings SGR with it: the
  // parser reads SGR reports only, so a bare `mouse` would otherwise be cleared
  // and look like the override did nothing.
  const forced = caps({ ...LINUX_CONSOLE, DSH_TUI_TERM_CAPS: 'mouse' })
  assert.equal(forced.mouse, true)
  assert.equal(forced.mouseSgr, true)
  assert.equal(mouseEnableSequence(forced), '\x1b[?1006h\x1b[?1002h\x1b[?1000h')
  assert.equal(caps({ ...GNOME_TERMINAL, DSH_TUI_TERM_CAPS: 'osc52=false' }).osc52, false)
  assert.equal(caps({ ...LINUX_CONSOLE, DSH_TUI_TERM_CAPS: 'alternateScreen' }).alternateScreen, true)
  // Turning the mouse off drops the modes that only make sense with it.
  const off = caps({ ...GNOME_TERMINAL, DSH_TUI_TERM_CAPS: 'no-mouse' })
  assert.equal(off.mouseSgr, false)
  assert.equal(off.mouseDrag, false)
  // The older documented switch still works.
  assert.equal(caps({ ...GNOME_TERMINAL, DSH_TUI_NO_ALT_SCREEN: '1' }).alternateScreen, false)
  assert.equal(caps({ ...GNOME_TERMINAL, DSH_TUI_OSC8: '0' }).osc8, false)
})

test('the override parser accepts the documented spellings and rejects the rest', () => {
  assert.deepEqual(parseCapsOverride('no-mouse'), { mouse: false })
  assert.deepEqual(parseCapsOverride('mouse=0'), { mouse: false })
  // `mouse` carries the set the table gives a mouse terminal (SGR + drag).
  assert.deepEqual(parseCapsOverride('mouse=yes, osc8=off'), { mouse: true, mouseSgr: true, mouseDrag: true, osc8: false })
  assert.deepEqual(parseCapsOverride('mouse,no-mouseDrag'), { mouse: true, mouseSgr: true, mouseDrag: false })
  // The spaced spelling used to invert the meaning: `mouse = false` parsed as
  // the bare name `mouse`, i.e. true, and `osc52 = false` re-enabled the very
  // promise the user was trying to withdraw.
  assert.deepEqual(parseCapsOverride('mouse = false'), { mouse: false })
  assert.deepEqual(parseCapsOverride('osc52 = false'), { osc52: false })
  assert.deepEqual(parseCapsOverride(' no-mouse , osc52 = off '), { mouse: false, osc52: false })
  // A value outside the two vocabularies, an unknown name and a dangling `no-`
  // are refused rather than guessed.
  for (const bad of ['mouse=maybe', 'mouse=', 'mouse==false', 'nonsense', 'no-', 'no-no-mouse', 'MOUSE=false']) {
    assert.deepEqual(parseCapsOverride(bad), {}, `"${bad}" must not be guessed at`)
  }
  assert.deepEqual(parseCapsOverride(''), {})
})

test('rejected override tokens are reported, not swallowed', () => {
  // `/diag` is the only place a user can find out why their override did nothing.
  const report = parseCapsOverrideReport('no-mouse,mouse=maybe,bogus,osc52=false')
  assert.deepEqual(report.overrides, { mouse: false, osc52: false })
  assert.deepEqual(report.ignored, ['mouse=maybe', 'bogus'])
  assert.deepEqual(caps({ TERM: 'xterm-256color', DSH_TUI_TERM_CAPS: 'bogus,no-osc8' }).ignoredOverrides, ['bogus'])
})

test('the classifier names the family for the diagnostics line', () => {
  // Every assertion states the platform: the same environment means different
  // things on Windows (an empty TERM is normal there) and on POSIX.
  assert.equal(detectTerminalFamily({ env: GNOME_TERMINAL, platform: 'linux' }).label, 'gnome-terminal (VTE 7000)')
  assert.equal(detectTerminalFamily({ env: WINDOWS_CONSOLE, platform: 'win32' }).label, 'Windows console (conhost)')
  assert.equal(detectTerminalFamily({ env: { TERM: 'xterm-256color' }, platform: 'linux' }).family, 'xterm')
})

test('a named TERM on Windows is that terminal, not conhost', () => {
  // Git-Bash, MSYS2 and mintty all set TERM and none of them export WT_SESSION:
  // reading them as conhost would drop OSC 52 and mislabel every /diag report.
  const gitBash = detectTerminalFamily({ env: { TERM: 'xterm-256color' }, platform: 'win32' })
  assert.equal(gitBash.family, 'xterm')
  const caps = terminalCapabilities({ env: { TERM: 'xterm-256color' }, platform: 'win32' })
  assert.equal(caps.family, 'xterm')
  // …while PowerShell and cmd.exe stay conhost.
  assert.equal(terminalCapabilities({ env: {}, platform: 'win32' }).family, 'windows-console')
  // A POSIX console name on Windows can only be a wrapper: reading it as the
  // Linux console would drop the mouse, paste and the alternate screen on a
  // ConPTY that has all three.
  assert.equal(terminalCapabilities({ env: { TERM: 'linux' }, platform: 'win32' }).family, 'windows-console')
  assert.equal(terminalCapabilities({ env: { TERM: 'linux' }, platform: 'linux' }).family, 'linux-console')
})

test('the clipboard caveat follows the capability, and an override silences it', () => {
  // The TUI shows the caveat once per session whenever `osc52` is false — which
  // now includes the VTE desktops, because that is where the silent empty
  // clipboard actually happens. What is pinned here is that the flag the TUI
  // reads is the one the override changes.
  const unpromised = [caps(WINDOWS_CONSOLE, 'win32'), caps(GNOME_TERMINAL), caps(XTERM), caps(TMUX), caps(DUMB)]
  for (const c of unpromised) assert.equal(c.osc52, false, `${c.family} is not promised OSC 52`)
  for (const env of [WINDOWS_TERMINAL, { ...WINDOWS_CONSOLE, DSH_TUI_TERM_CAPS: 'osc52' }, { ...GNOME_TERMINAL, DSH_TUI_TERM_CAPS: 'osc52' }]) {
    const platform = env === WINDOWS_TERMINAL ? 'win32' : 'linux'
    assert.equal(caps(env, platform).osc52, true, 'the flag can be turned on deliberately')
  }
})

test('a mouse without SGR is no mouse, because the parser reads SGR only', () => {
  // Enabling `?1000h` without `?1006h` captures the terminal's mouse and then
  // drops every report: the user loses native selection *and* gets nothing.
  const legacy = caps({ TERM: 'xterm-256color', DSH_TUI_TERM_CAPS: 'no-mouseSgr' })
  assert.equal(legacy.mouseSgr, false)
  assert.equal(legacy.mouse, false)
  assert.equal(legacy.mouseDrag, false)
  assert.equal(mouseEnableSequence(legacy), '')
})
