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
}

/** Everything the classifier reads. `platform` and `env` are injectable. */
export interface TerminalProbe {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

/** Capability names a user may force on or off through `DSH_TUI_TERM_CAPS`. */
const TOGGLEABLE = ['mouse', 'mouseSgr', 'mouseDrag', 'bracketedPaste', 'alternateScreen', 'osc52', 'osc8', 'title'] as const

/** `no-mouse,osc52=false,no-alternateScreen` → the overrides to apply. */
export function parseCapsOverride(raw: string): Partial<Record<(typeof TOGGLEABLE)[number], boolean>> {
  const out: Partial<Record<(typeof TOGGLEABLE)[number], boolean>> = {}
  for (const piece of raw.split(/[\s,]+/u)) {
    const token = piece.trim()
    if (token === '') continue
    const [rawName, rawValue] = token.split('=')
    const name = (rawName ?? '').trim()
    const negated = name.startsWith('no-')
    const key = (negated ? name.slice(3) : name) as (typeof TOGGLEABLE)[number]
    if (!TOGGLEABLE.includes(key)) continue
    if (negated) out[key] = false
    else if (rawValue === undefined) out[key] = true
    else out[key] = !['0', 'false', 'off', 'no'].includes(rawValue.trim().toLowerCase())
  }
  return out
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
  if (term === 'linux') return { family: 'linux-console', label: 'Linux virtual console' }

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
    // No WT_SESSION on Windows: conhost — the classic console host. It may or
    // may not have VT processing enabled (that is a per-console flag this
    // process cannot read), which is why the capability table is conservative.
    return { family: 'windows-console', label: 'Windows console (conhost)' }
  }
  if (term === '' ) return { family: 'unknown', label: 'unknown (TERM unset)' }
  if (term.includes('xterm') || term.includes('rxvt') || term.includes('alacritty') || term.includes('kitty') || term.includes('wezterm')) {
    return { family: 'xterm', label: `${term}` }
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

  const base: Omit<TerminalCapabilities, 'family' | 'label' | 'colors'> = {
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
        bracketedPaste: true, alternateScreen: true,
        osc52: false, osc8: false, title: true,
      })
      break
    case 'vte':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // OSC 52 arrived in VTE 0.52; OSC 8 in 0.50. Older VTE is still around
        // on long-term distributions, so the version decides.
        osc52: (numericVersion(env.VTE_VERSION) ?? 0) >= 5200,
        osc8: (numericVersion(env.VTE_VERSION) ?? 0) >= 5000,
        title: true,
      })
      break
    case 'konsole':
      Object.assign(base, {
        mouse: true, mouseSgr: true, mouseDrag: true,
        bracketedPaste: true, alternateScreen: true,
        // OSC 52 landed in Konsole 21.12, and KONSOLE_VERSION is YYMMDD
        // (`230800` is 23.08), so the comparison is against 211200.
        osc52: (numericVersion(env.KONSOLE_VERSION) ?? 0) >= 211200,
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
  Object.assign(base, parseCapsOverride(env.DSH_TUI_TERM_CAPS ?? ''))
  if (base.mouse === false) {
    base.mouseSgr = false
    base.mouseDrag = false
  }

  return { family, label, colors, ...base }
}

/**
 * Terminals where OSC 52 cannot work at all, so a clipboard write must be
 * followed by an explanation.
 *
 * Deliberately narrower than `osc52 === false`: xterm and tmux are only
 * *unpromised* (both work once configured), and a dumb or unlabelled terminal
 * gets the benefit of the doubt. Nagging on all of them would turn a one-off
 * surprise into permanent noise.
 */
export function osc52Impossible(caps: TerminalCapabilities): boolean {
  return caps.family === 'windows-console' || caps.family === 'linux-console' || caps.family === 'screen'
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
