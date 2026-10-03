/**
 * The TUI's colour system: semantic roles, and the palettes that fill them.
 *
 * Three rules shape this file, and each one came from a product that had to
 * learn it the hard way:
 *
 * 1. **Primary text takes the terminal's own foreground.** Forcing `37` looks
 *    right on a dark terminal and is unreadable on a light one; Codex's own TUI
 *    style guide says "most of the time, just use the default foreground colour"
 *    and warns against unchecked custom foregrounds. So assistant text and tool
 *    output carry *no* colour token at all.
 * 2. **A theme is a role table, not a palette.** Callers ask for `error`, not for
 *    red — that is what lets the monochrome theme keep bold/underline while it
 *    drops colour, and what lets a low-colour terminal (`color-depth.ts`)
 *    downgrade by hue family without any theme knowing about it.
 * 3. **A theme must survive 8 colours and no colour.** Every token here is
 *    emitted as ordinary SGR and passes through `downgradeSgr`, so a `38;2;…`
 *    token on a 256- or 16-colour terminal becomes the nearest hue its palette
 *    has. `mono` goes further and never emits colour at all — the shape of the
 *    line (bold, dim, underline) is what carries meaning, which is exactly what
 *    Gemini CLI's first-class `no-color` theme does.
 *
 * @module dsh-ssh-tui/theme
 */
import type { DisplayKind } from './transcript-types.js'

/**
 * Roles that are not transcript rows: subagent chips, warning glyphs, links.
 *
 * They live here rather than as constants beside their callers for one reason: a
 * colour literal anywhere outside this module is a colour the palettes cannot
 * reach, and `tests/theme.test.mjs` fails over exactly that.
 */
export type ExtraRole =
  | 'subagent-self'
  | 'subagent-foreign'
  | 'warn'
  | 'link'
  | 'accent'
  | 'notice'
  | 'md-bold'
  | 'md-italic'
  | 'md-code'
  | 'md-link'
  | 'md-muted'
  | 'md-h1'
  | 'md-h2'
  | 'md-h3'
  | 'md-quote'
  | 'md-rule'
  | 'tool-running'
  | 'tool-ok'

/** One palette. Tokens are SGR parameter strings, without the escape. */
export interface Theme {
  /** Key used by `/theme`, `DSH_TUI_THEME`, and the `theme` setting. */
  name: string
  /** Order in `/theme` output; lower is closer to the original look. */
  rank: number
  /** Row role → SGR parameters. A missing role falls back to `default`'s. */
  tokens: Partial<Record<DisplayKind, string>>
  /** Diff emphasis uses a second, brighter variant of the same fill. */
  emphasis?: Partial<Record<DisplayKind, string>>
  /** Non-row roles. */
  extra?: Partial<Record<ExtraRole, string>>
}

/**
 * The original palette, kept recognisably itself.
 *
 * Two tokens changed when the role table arrived: `assistant` and the tool rows
 * used to be `37` (forced white), which is invisible on a light terminal. They
 * are now unpainted, i.e. the terminal's default foreground.
 */
const DEFAULT_THEME: Theme = {
  name: 'default',
  rank: 0,
  tokens: {
    user: '36',
    assistant: '',
    reasoning: '2;3',
    brand: '1;38;2;77;107;253',
    tool: '',
    'tool-result': '',
    'diff-add': '38;2;122;168;116;48;2;18;42;24',
    'diff-del': '38;2;196;122;122;48;2;48;20;20',
    'diff-path': '1;36',
    'todo-done': '2;32',
    'todo-active': '1;36',
    'todo-failed': '31',
    'todo-skipped': '2;33',
    'todo-pending': '90',
    'plan-dock': '38;5;180',
    'setup-step': '1;36',
    'setup-choice': '33',
    'setup-field': '1;37',
    'subagent-header': '38;5;141',
    diag: '2;36',
    error: '31',
    system: '90',
  },
  emphasis: {
    'diff-add': '38;2;198;232;190;48;2;34;72;44',
    'diff-del': '38;2;246;206;206;48;2;86;34;34',
  },
  extra: {
    'subagent-self': '38;5;141',
    'subagent-foreign': '38;5;80',
    warn: '33',
    link: '36',
    accent: '36',
    notice: '36',
    'md-bold': '1;97',
    'md-italic': '3;37',
    'md-code': '36',
    'md-link': '4;36',
    'md-muted': '2;37',
    'md-h1': '1;4;97',
    'md-h2': '1;4;36',
    'md-h3': '1;36',
    'md-quote': '3;37',
    'md-rule': '90',
    'tool-running': '33',
    'tool-ok': '32',
  },
}

/** Catppuccin Mocha — the palette most of the ecosystem's themes start from. */
const CATPPUCCIN_THEME: Theme = {
  name: 'catppuccin',
  rank: 1,
  tokens: {
    user: '38;2;137;180;250',
    assistant: '',
    reasoning: '2;3',
    brand: '1;38;2;203;166;247',
    tool: '',
    'tool-result': '',
    'diff-add': '38;2;166;227;161;48;2;30;58;38',
    'diff-del': '38;2;243;139;168;48;2;74;32;42',
    'diff-path': '1;38;2;137;180;250',
    'todo-done': '2;38;2;166;227;161',
    'todo-active': '1;38;2;137;180;250',
    'todo-failed': '38;2;243;139;168',
    'todo-skipped': '2;38;2;249;226;175',
    'todo-pending': '38;2;108;112;134',
    'plan-dock': '38;2;250;179;135',
    'setup-step': '1;36',
    'setup-choice': '33',
    'setup-field': '1;37',
    'subagent-header': '38;2;203;166;247',
    diag: '2;38;2;148;226;213',
    error: '38;2;243;139;168',
    system: '38;2;166;173;200',
  },
  emphasis: {
    'diff-add': '38;2;205;255;199;48;2;48;92;58',
    'diff-del': '38;2;255;190;200;48;2;102;45;58',
  },
  extra: {
    'subagent-self': '38;2;203;166;247',
    'subagent-foreign': '38;2;148;226;213',
    warn: '38;2;249;226;175',
    link: '38;2;137;180;250',
    accent: '38;2;137;180;250',
    notice: '38;2;148;226;213',
    'md-bold': '1;38;2;205;214;244',
    'md-italic': '3;38;2;180;190;254',
    'md-code': '38;2;148;226;213',
    'md-link': '4;38;2;137;180;250',
    'md-muted': '2;38;2;166;173;200',
    'md-h1': '1;4;38;2;205;214;244',
    'md-h2': '1;4;38;2;137;180;250',
    'md-h3': '1;38;2;137;180;250',
    'md-quote': '3;38;2;166;173;200',
    'md-rule': '38;2;108;112;134',
    'tool-running': '38;2;249;226;175',
    'tool-ok': '38;2;166;227;161',
  },
}

/** Gruvbox Dark — warmer, and the other half of the popular pair. */
const GRUVBOX_THEME: Theme = {
  name: 'gruvbox',
  rank: 2,
  tokens: {
    user: '38;2;131;165;152',
    assistant: '',
    reasoning: '2;3',
    brand: '1;38;2;211;134;155',
    tool: '',
    'tool-result': '',
    'diff-add': '38;2;184;187;38;48;2;38;58;32',
    'diff-del': '38;2;251;73;52;48;2;66;32;32',
    'diff-path': '1;38;2;131;165;152',
    'todo-done': '2;38;2;184;187;38',
    'todo-active': '1;38;2;250;189;47',
    'todo-failed': '38;2;251;73;52',
    'todo-skipped': '2;38;2;250;189;47',
    'todo-pending': '38;2;146;131;116',
    'plan-dock': '38;2;254;128;25',
    'setup-step': '1;36',
    'setup-choice': '33',
    'setup-field': '1;37',
    'subagent-header': '38;2;211;134;155',
    diag: '2;38;2;142;192;124',
    error: '38;2;251;73;52',
    system: '38;2;168;153;132',
  },
  emphasis: {
    'diff-add': '38;2;215;218;70;48;2;58;84;48',
    'diff-del': '38;2;255;120;100;48;2;92;44;44',
  },
  extra: {
    'subagent-self': '38;2;211;134;155',
    'subagent-foreign': '38;2;142;192;124',
    warn: '38;2;250;189;47',
    link: '38;2;131;165;152',
    accent: '38;2;250;189;47',
    notice: '38;2;142;192;124',
    'md-bold': '1;38;2;235;219;178',
    'md-italic': '3;38;2;168;153;132',
    'md-code': '38;2;142;192;124',
    'md-link': '4;38;2;131;165;152',
    'md-muted': '2;38;2;168;153;132',
    'md-h1': '1;4;38;2;235;219;178',
    'md-h2': '1;4;38;2;131;165;152',
    'md-h3': '1;38;2;131;165;152',
    'md-quote': '3;38;2;168;153;132',
    'md-rule': '38;2;146;131;116',
    'tool-running': '38;2;250;189;47',
    'tool-ok': '38;2;184;187;38',
  },
}

/**
 * No colour at all, and no loss of structure.
 *
 * Every difference the colour palette carries is carried here by an attribute
 * instead: failures are bold-underlined, secondary text is dim, the diff path is
 * underlined. A monochrome theme that simply emptied the palette would make
 * these rows indistinguishable, which is the mistake Gemini CLI avoided by
 * shipping `no-color` as a first-class theme rather than as a flag.
 */
const MONO_THEME: Theme = {
  name: 'mono',
  rank: 3,
  tokens: {
    user: '1',
    assistant: '',
    reasoning: '2;3',
    brand: '1',
    tool: '',
    'tool-result': '',
    'diff-add': '1',
    'diff-del': '2',
    'diff-path': '4',
    'todo-done': '2',
    'todo-active': '1',
    'todo-failed': '1;4',
    'todo-skipped': '2;3',
    'todo-pending': '2',
    'plan-dock': '1',
    'setup-step': '1',
    'setup-choice': '4',
    'setup-field': '',
    'subagent-header': '4',
    diag: '2;3',
    error: '1;4',
    system: '2',
  },
  extra: {
    'subagent-self': '4',
    'subagent-foreign': '2;3',
    warn: '1',
    link: '4',
    accent: '1',
    notice: '2;3',
    'md-bold': '1',
    'md-italic': '3',
    'md-code': '2;3',
    'md-link': '4',
    'md-muted': '2',
    'md-h1': '1;4',
    'md-h2': '1;4',
    'md-h3': '1',
    'md-quote': '3',
    'md-rule': '2',
    'tool-running': '2;3',
    'tool-ok': '2',
  },
}

export const THEMES: readonly Theme[] = [DEFAULT_THEME, CATPPUCCIN_THEME, GRUVBOX_THEME, MONO_THEME]

/** Every theme name, in the order `/theme` lists them. */
export function themeNames(): string[] {
  return [...THEMES].sort((a, b) => a.rank - b.rank).map(theme => theme.name)
}

/**
 * Resolve a theme name.
 * @param name - a name from the environment, the settings file, or `/theme`.
 * @returns the theme, or undefined when the name is unknown (the caller decides
 *   whether to fall back quietly — a typo in a settings file should not crash a
 *   session, but `/theme bogus` has to say so).
 */
export function themeByName(name: string | undefined): Theme | undefined {
  const wanted = String(name ?? '').trim().toLowerCase()
  if (wanted === '') return undefined
  return THEMES.find(theme => theme.name === wanted)
}

/** The theme a `DSH_TUI_THEME`/`theme` value selects, defaulting to `default`. */
export function resolveTheme(name: string | undefined): Theme {
  return themeByName(name) ?? DEFAULT_THEME
}

/**
 * The palette the session is currently painting with.
 *
 * Pure renderers — the footer, the plan dock, tool cards, markdown — are not
 * handed a TUI instance, so without this they would each have to be passed one
 * down through every call, or worse, quietly paint the default palette while the
 * user has chosen another. The TUI publishes its choice here on construction and
 * on `/theme`, and those renderers read it.
 */
let ACTIVE_THEME: Theme = DEFAULT_THEME

/**
 * Publish the active palette.
 * @param name - the theme name, as resolved from the environment or settings.
 * @returns the theme that is now active.
 */
export function setActiveTheme(name: string | undefined): Theme {
  ACTIVE_THEME = resolveTheme(name)
  return ACTIVE_THEME
}

/** The active palette, for renderers that have no session handle. */
export function activeTheme(): Theme {
  return ACTIVE_THEME
}

/**
 * The SGR parameters for one row role.
 * @param theme - the active theme.
 * @param kind - the display role being painted.
 * @returns SGR parameters without the escape, or `''` for "leave it to the
 *   terminal" (which is what primary text wants).
 */
export function themeToken(theme: Theme, kind: DisplayKind): string {
  const own = theme.tokens[kind]
  if (own !== undefined) return own
  return DEFAULT_THEME.tokens[kind] ?? ''
}

/**
 * The SGR parameters for a changed word inside a diff row.
 * @param theme - the active theme.
 * @param kind - `diff-add` or `diff-del`.
 * @returns the emphasised variant, or undefined when the theme has none.
 */
export function themeEmphasisToken(theme: Theme, kind: DisplayKind): string | undefined {
  return theme.emphasis?.[kind] ?? DEFAULT_THEME.emphasis?.[kind]
}

/**
 * The SGR parameters for a non-row role.
 * @param theme - the active theme.
 * @param role - the extra role requested.
 * @returns SGR parameters without the escape.
 */
export function themeExtraToken(theme: Theme, role: ExtraRole): string {
  return theme.extra?.[role] ?? DEFAULT_THEME.extra?.[role] ?? ''
}

/** A threshold level used by the status area's gauges. */
export type ThresholdLevel = 'ok' | 'warn' | 'over'

/**
 * The token for a gauge threshold: context usage, a quota window, a spend bar.
 *
 * One vocabulary for all of them, so a reader learns it once — under 70% is
 * fine, 70–89% is worth noting, 90% and up is a problem. The numbers behind the
 * levels live in the status area; the colours live here, and `mono` answers with
 * attributes instead of giving up the distinction.
 * @param theme - the active theme.
 * @param level - which threshold the gauge is in.
 * @returns SGR parameters without the escape.
 */
export function themeThresholdToken(theme: Theme, level: ThresholdLevel): string {
  if (level === 'ok') return themeToken(theme, 'todo-done')
  if (level === 'warn') return theme.extra?.warn ?? DEFAULT_THEME.extra?.warn ?? ''
  return themeToken(theme, 'error')
}

/** Whether one token asks for colour at all (as opposed to an attribute). */
function tokenPaintsColour(token: string): boolean {
  return /(?:^|;)(?:3[0-9]|4[0-9]|9[0-7]|38|48)(?:;|$)/u.test(token)
}

/**
 * Whether a theme paints colour at all.
 * @param theme - the active theme.
 * @returns false for `mono`, whose tokens are attributes only.
 */
export function themeHasColour(theme: Theme): boolean {
  const tokens = [...Object.values(theme.tokens), ...Object.values(theme.extra ?? {})]
  return tokens.some(token => tokenPaintsColour(token))
}
