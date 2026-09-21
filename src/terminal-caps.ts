/**
 * What the terminal in front of us can actually do.
 *
 * `color-depth.ts` answers the palette question; this answers the rest of the
 * ones that change what we may safely emit: mouse reporting, bracketed paste,
 * the alternate screen, clipboard writes (OSC 52) and hyperlinks (OSC 8), plus
 * which family of terminal we are talking to.
 *
 * Why it is a module and not a few `if`s: these decisions are made from
 * environment variables that nobody on the team can test by hand for every
 * desktop — GNOME Terminal, XFCE Terminal, Konsole, xterm, tmux, the Linux
 * virtual console, Windows Terminal, a legacy Windows console. So the input is
 * a parameter, the table is data, and `tests/terminal-caps.test.mjs` pins one
 * fixture per family on any platform.
 *
 * The bias is **not** "assume the best". A capability we claim but the terminal
 * lacks costs the user something real: `?1000h` on a console that cannot report
 * SGR coordinates swallows its mouse; OSC 52 where nothing reads it makes
 * `/copy` look like it worked; the alternate screen on a serial console loses
 * the scrollback. Where a terminal is known to be marginal, the answer is no,
 * and `DSH_TUI_TERM_CAPS` is the escape hatch for the user who knows better.
 *
 * @module dsh-ssh-tui/terminal-caps
 */
import { colorDepth, type ColorDepth } from './color-depth.js'

/** Which terminal implementation is on the other end. */
export type TerminalFamily =
  | 'windows-terminal'
  | 'windows-console'
  | 'vte'
  | 'konsole'
  | 'xterm'
  | 'tmux'
  | 'screen'
  | 'linux-console'
  | 'dumb'
  | 'unknown'

/** One terminal's answer to every question this TUI asks of it. */
export interface TerminalCapabilities {
  family: TerminalFamily
  /** A human name for diagnostics (`/diag`), e.g. `GNOME Terminal (VTE 7000)`. */
  label: string
  colors: ColorDepth
  /** Report mouse events at all (`?1000h`). */
  mouse: boolean
  /** Report them as SGR (`?1006h`) instead of the 32-column X10 encoding. */
  mouseSgr: boolean
  /** Report motion while a button is held (`?1002h`), which a drag needs. */
  mouseDrag: boolean
  /** `?2004h`: paste arrives wrapped, so a multi-line paste is one event. */
  bracketedPaste: boolean
  /** `?1049h`: the TUI gets its own screen and restores the scrollback on exit. */
  alternateScreen: boolean
  /** OSC 52 clipboard writes reach the user's own machine. */
  osc52: boolean
  /** OSC 8 hyperlinks are clickable rather than noise. */
  osc8: boolean
  /** OSC 0/2 window-title updates are honoured. */
  title: boolean
  /** `DSH_TUI_TERM_CAPS` tokens that were rejected, for `/diag` to report. */
  ignoredOverrides: readonly string[]
}

/** Everything the classifier reads. `platform` and `env` are injectable. */
export interface TerminalProbe {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/** Capability names a user may force on or off through `DSH_TUI_TERM_CAPS`. */
const TOGGLEABLE = ['mouse', 'mouseSgr', 'mouseDrag', 'bracketedPaste', 'alternateScreen', 'osc52', 'osc8', 'title'] as const

const TRUTHY = new Set(['1', 'true', 'on', 'yes'])
const FALSY = new Set(['0', 'false', 'off', 'no'])

/**
 * Parse `DSH_TUI_TERM_CAPS`.
 *
 * `no-mouse`, `mouse`, `mouse=false` and `mouse = false` all mean what they
 * look like: the `=` binds first, so the spaced spelling cannot silently invert
 * into the opposite answer (it did, and `osc52 = false` then *re-enabled* the
 * clipboard promise). A value outside the two vocabularies, an unknown name or a
 * bare `no-` is rejected rather than guessed, and the rejects are returned so
 * `/diag` can show them — this variable is the only feedback channel a user has
 * when an override does not appear to work.
 */
export function parseCapsOverrideReport(raw: string): {
  overrides: Partial<Record<(typeof TOGGLEABLE)[number], boolean>>
  ignored: string[]
} {
  const overrides: Partial<Record<(typeof TOGGLEABLE)[number], boolean>> = {}
  const ignored: string[] = []
  // Bind `=` before splitting on whitespace: `mouse = false` must not become the
  // bare name `mouse` plus two junk tokens, which read as "on".
  for (const piece of raw.replace(/\s*=\s*/gu, '=').split(/[\s,]+/u)) {
    const token = piece.trim()
    if (token === '') continue
    const [rawName, rawValue] = token.split('=')
    const name = (rawName ?? '').trim()
    const value = rawValue === undefined ? undefined : rawValue.trim().toLowerCase()
    const negated = name.startsWith('no-')
    const key = (negated ? name.slice(3) : name) as (typeof TOGGLEABLE)[number]
    const known = name !== 'no-' && TOGGLEABLE.includes(key)
    if (!known) {
      ignored.push(token)
      continue
    }
    if (negated) {
      // `no-mouse=false` is not a spelling worth guessing at.
      if (value !== undefined) {
        ignored.push(token)
        continue
      }
      overrides[key] = false
      continue
    }
    if (value === undefined || TRUTHY.has(value)) {
      overrides[key] = true
      // Asking for the mouse asks for the whole set the table gives a mouse
      // terminal: SGR (the only encoding this parser reads, so a bare `mouse`
      // would otherwise be cleared by the cascade and appear to do nothing) and
      // held-button motion, without which a drag never arrives. `no-mouseDrag`
      // on its own still opts out of the drag.
      if (key === 'mouse' || key === 'mouseSgr') {
        overrides.mouse = true
        overrides.mouseSgr = true
        if (overrides.mouseDrag === undefined) overrides.mouseDrag = true
      }
      continue
    }
    if (FALSY.has(value)) {
      overrides[key] = false
      continue
    }
    ignored.push(token)
  }
  return { overrides, ignored }
}

/** The overrides alone, for callers that do not report. */
export function parseCapsOverride(raw: string): Partial<Record<(typeof TOGGLEABLE)[number], boolean>> {
  return parseCapsOverrideReport(raw).overrides
}

/** A version-ish number out of `VTE_VERSION` / `KONSOLE_VERSION`, or undefined. */
function numericVersion(raw: string | undefined): number | undefined {
  const text = (raw ?? '').trim()
  if (text === '') return undefined
  const match = /^(\d+)/u.exec(text)
  return match === null ? undefined : Number(match[1])
}

/** `true`/`false` from a boolean-ish env value, or undefined when unset. */
function envFlag(raw: string | undefined): boolean | undefined {
  const text = (raw ?? '').trim().toLowerCase()
  if (text === '') return undefined
  if (['1', 'true', 'on', 'yes'].includes(text)) return true
  if (['0', 'false', 'off', 'no'].includes(text)) return false
  return undefined
}

/**
 * Classify the terminal from the environment.
 *
 * Detection is by the markers terminals actually set: Windows Terminal exports
 * `WT_SESSION`; the VTE family (GNOME Terminal, XFCE Terminal, MATE, Tilix,
 * Terminator, Guake) exports `VTE_VERSION`; Konsole exports `KONSOLE_VERSION`;
 * tmux and screen export `TMUX` / `STY` and set a `tmux*` / `screen*` TERM.
 * Everything else falls back to the TERM name.
 */
export function detectTerminalFamily(probe: TerminalProbe = {}): { family: TerminalFamily; label: string } {
  const env = probe.env ?? process.env
  const platform = probe.platform ?? process.platform
  const term = (env.TERM ?? '').trim().toLowerCase()

  if ((env.TMUX ?? '') !== '' || term.startsWith('tmux')) {
    return { family: 'tmux', label: `tmux (TERM=${term || 'unset'})` }
  }
  if ((env.STY ?? '') !== '' || term.startsWith('screen')) {
    return { family: 'screen', label: `screen (TERM=${term || 'unset'})` }
  }
  if (term === 'dumb') return { family: 'dumb', label: 'dumb terminal (assuming the xterm baseline)' }
  // `linux` (and the old VT names) are POSIX console names: on Windows they can
  // only come from a wrapper, and the capabilities they describe — no mouse, no
  // paste, no alternate screen — are not what the ConPTY behind that wrapper
  // has. The Windows classification below decides instead.
  if (platform !== 'win32' && (term === 'linux' || term === 'vt100' || term === 'vt220')) {
    return { family: 'linux-console', label: 'Linux virtual console' }
  }

  const vte = numericVersion(env.VTE_VERSION)
  if (vte !== undefined) {
    // VTE is the widget, not the app: name the app when it says so.
    const program = (env.TERM_PROGRAM ?? '').trim()
    const app = program !== '' ? program : 'GNOME/XFCE/Fork (VTE)'
    return { family: 'vte', label: `${app} (VTE ${vte})` }
  }
  const konsole = numericVersion(env.KONSOLE_VERSION)
  if (konsole !== undefined) return { family: 'konsole', label: `Konsole (${konsole})` }

  if (platform === 'win32') {
    if ((env.WT_SESSION ?? '').trim() !== '') {
      return { family: 'windows-terminal', label: 'Windows Terminal' }
    }
    // An empty TERM is what PowerShell and cmd.exe report: that is conhost, the
    // classic console host, and it is the one Windows terminal without OSC 52.
    // A *named* TERM means something else is driving the console — Git-Bash and
    // MSYS2 set `xterm-256color`, mintty identifies itself the same way — and
    // those are xterm-family terminals that do more than conhost, so they fall
    // through to the TERM matching below rather than being read as conhost.
    if (term === '') return { family: 'windows-console', label: 'Windows console (conhost)' }
  }
  if (term === '') {
    return platform === 'win32'
      ? { family: 'windows-console', label: 'Windows console (conhost)' }
      : { family: 'unknown', label: 'unknown (TERM unset)' }
  }
  if (term.includes('xterm') || term.includes('rxvt') || term.includes('alacritty') || term.includes('kitty') || term.includes('wezterm')) {
    return { family: 'xterm', label: `${term}` }
  }
  if (platform === 'win32') {
    // A Windows host whose TERM names nothing we know (a wrapper handing us
    // `linux`, or anything else): conhost is what is actually underneath, and
    // `unknown` would claim bracketed paste and hyperlinks this console lacks.
    return { family: 'windows-console', label: 'Windows console (conhost)' }
  }
  return { family: 'unknown', label: term }
}

/**
 * Every capability for the terminal in front of us.
 *
 * `DSH_TUI_TERM_CAPS` overrides individual answers (`no-mouse`, `osc52=false`);
 * `DSH_TUI_NO_ALT_SCREEN` and `DSH_TUI_OSC8` keep working because they came
 * first and are documented.
 */
export function terminalCapabilities(probe: TerminalProbe = {}): TerminalCapabilities {
  const env = probe.env ?? process.env
  const platform = probe.platform ?? process.platform
  const { family, label } = detectTerminalFamily({ env, platform })
  const colors = colorDepth(env, platform)

  const base: Omit<TerminalCapabilities, 'family' | 'label' | 'colors' | 'ignoredOverrides'> = {
    // A terminal that paints nothing is not a terminal we may drive.
    mouse: false,
    mouseSgr: false,
    mouseDrag: false,
    bracketedPaste: false,
    alternateScreen: false,
    osc52: false,
    osc8: false,
    title: false,
  }

  switch (family) {
    case 'windows-terminal':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // Windows Terminal understands OSC 52 from 1.15 on; it is the only
        // Windows host that does, conhost never has. Claiming it there is what
        // makes `/copy` silently useless on the others.
        osc52: true, osc8: true, title: true,
      })
      break
    case 'windows-console':
      Object.assign(base, {
        // conhost has had VT mouse input since Windows 10 1703, and mouse
        // reporting is how cards expand, so it stays on — the same trade every
        // other platform makes. What it genuinely lacks is the OSC pair:
        // conhost never writes the clipboard and ignores hyperlinks, which is
        // what `/copy` has to say out loud there.
        mouse: true, mouseSgr: true, mouseDrag: true,
        // Bracketed paste reached conhost only in 2022-11 (Windows 11 22H2), and
        // Windows 10 is still the PowerShell/cmd case this row is about. The
        // paste path survives without it (a multi-line burst is still treated as
        // one paste), so under-claiming here costs nothing and the matrix stays
        // true for the older console.
        bracketedPaste: false,
        alternateScreen: true,
        osc52: false, osc8: false, title: true,
      })
      break
    case 'vte':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // VTE has never implemented OSC 52: the request is still open upstream
        // (GNOME/vte#125) and the widget only *parses* the sequence. Every VTE
        // desktop shares the gap — GNOME Terminal, XFCE Terminal, MATE, Tilix,
        // Terminator, Ptyxis — which made this the single most common terminal
        // to promise a clipboard write it silently drops. `?` would be kinder
        // than `no`, but the user cannot tell the difference when pasting.
        osc52: false,
        // OSC 8 arrived in VTE 0.50, so long-term distributions can lack it.
        osc8: (numericVersion(env.VTE_VERSION) ?? 0) >= 5000,
        title: true,
      })
      break
    case 'konsole':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // Write-only OSC 52 landed in Konsole 24.12 (KDE bug 372116; the patch
        // was merged 2024-07 and 24.08 missed the cut), and KONSOLE_VERSION is
        // YYMMDD (`241200` is 24.12) — so Kubuntu 22.04/24.04 and Debian 12 all
        // ignore the write. 21.12 was Konsole's OSC 8.
        osc52: (numericVersion(env.KONSOLE_VERSION) ?? 0) >= 241200,
        osc8: true, title: true,
      })
      break
    case 'xterm':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // xterm gates clipboard writes behind `allowWindowOps`, which defaults
        // to off in recent builds; assuming it works is how a user ends up with
        // an empty clipboard and no explanation.
        osc52: false, osc8: true, title: true,
      })
      break
    case 'tmux':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // tmux forwards OSC 52 only with `set -g set-clipboard on`.
        osc52: false, osc8: true, title: true,
      })
      break
    case 'screen':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        osc52: false, osc8: false, title: true,
      })
      break
    case 'linux-console':
      Object.assign(base, {
        mouse: false, mouseSgr: false, mouseDrag: false,
        bracketedPaste: false,
        // Keeping the TUI's own screen here costs the user the console
        // scrollback they navigate with Shift+PgUp.
        alternateScreen: false,
        osc52: false, osc8: false, title: false,
      })
      break
    case 'dumb':
      // A terminal that says `dumb` may still be a capable one behind a wrapper
      // (or a CI pty), and a mode-setting escape it does not understand is
      // ignored, while *not* sending it silently disables the feature. So the
      // baseline stands; only the clipboard and hyperlink promises are dropped,
      // because those are the claims a user cannot verify by looking.
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        osc52: false, osc8: false, title: false,
      })
      break
    case 'unknown':
      // Something we cannot name: assume the xterm baseline except for the two
      // capabilities that cost the user when wrongly claimed.
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        osc52: false, osc8: true, title: true,
      })
      break
  }

  if (envFlag(env.DSH_TUI_NO_ALT_SCREEN) === true) base.alternateScreen = false
  const osc8Flag = envFlag(env.DSH_TUI_OSC8)
  if (osc8Flag !== undefined) base.osc8 = osc8Flag
  const override = parseCapsOverrideReport(env.DSH_TUI_TERM_CAPS ?? '')
  Object.assign(base, override.overrides)
  if (base.mouse === false) {
    base.mouseSgr = false
    base.mouseDrag = false
  }
  if (base.mouseSgr === false) {
    // The parser understands SGR reports only (`\x1b[<b;x;yM`); enabling the
    // legacy X10 encoding would capture the terminal's mouse and deliver events
    // the TUI drops — dead mouse *and* no native selection. So no SGR means no
    // mouse. (Asking for the mouse turns SGR on with it — see the parser — so
    // this only bites when SGR was refused on purpose.)
    base.mouse = false
    base.mouseDrag = false
  }

  return { family, label, colors, ignoredOverrides: override.ignored, ...base }
}

/** Mouse-tracking sequences to enable, in one write. Empty when unsupported. */
export function mouseEnableSequence(caps: TerminalCapabilities): string {
  if (!caps.mouse) return ''
  return `${caps.mouseSgr ? '\x1b[?1006h' : ''}${caps.mouseDrag ? '\x1b[?1002h' : ''}\x1b[?1000h`
}

/** Mouse-tracking sequences to disable. Always safe to emit: `l` on a mode the
 *  terminal never enabled is ignored, and leaving a mode on is not. */
export function mouseDisableSequence(): string {
  return '\x1b[?1000l\x1b[?1002l\x1b[?1006l'
}

/** Bracketed-paste enable/disable, or empty when the terminal lacks it. */
export function bracketedPasteSequence(caps: TerminalCapabilities, on: boolean): string {
  if (!caps.bracketedPaste) return ''
  return on ? '\x1b[?2004h' : '\x1b[?2004l'
}
