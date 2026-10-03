/**
 * Responsive budget policy: how much of the row survives at which width.
 *
 * The row is one ordered list of chips, and this module owns the *degradation
 * ladder* every chip answers to — a single integer level, tried from 0 upward,
 * where each step removes cells in the order of the information priority the row
 * was designed around. Nothing outside this module may decide that a chip is
 * dropped, shortened, or spelled differently.
 *
 * @module dsh-ssh-tui/footer-budget
 */

import { t } from './i18n/index.js'
import { asciiChromeEnabled, pinEmojiCells, truncateAnsiToWidth, visibleWidth } from './term-text.js'
import { activeTheme, themeThresholdToken, themeToken } from './theme.js'
import { accent, downgradeSgr, type ColorDepth } from './color-depth.js'
import { linkQualityOf, linkSignalPips, type PaintLinkKind } from './paint.js'
import type { QuotaPeriod } from './quota.js'
import type { ThroughputView } from './throughput.js'
import {
  CAPACITY_SEGMENTS_MEDIUM,
  CAPACITY_SEGMENTS_WIDE,
  capacityMeter,
  healthMeter,
  performanceValue,
  performanceValueState,
} from './footer-meters.js'
import {
  formatElapsedShort,
  formatTokens,
  quotaWindowTag,
  quotaWindowTagShort,
  type ContextPressureView,
} from './footer-format.js'

export type FooterActivityKind =
  | 'plan-review'
  | 'waiting'
  | 'approval'
  | 'compacting'
  | 'retry'
  | 'agent'
  | 'tools'
  | 'plan-open'
  | 'plan-pending'
  | 'goal'
  | 'thinking'
  | 'reply'
  | 'waiting-llm'
  | 'idle'

/**
 * How the default row paints its link.
 *
 * Deliberately the same four-pip vocabulary `formatLinkQualityChip` established:
 * the thresholds behind it (`linkQualityOf`) were validated against real SSH
 * probes, and a UI pass that re-derived its own numbers would put two
 * contradictory opinions about the same link on the same screen.
 */
export interface FooterStripLink {
  kind: PaintLinkKind
  intervalMs: number
  /** Measured round-trip, when the CSI-6n probe answered. */
  rttMs?: number
  probed: boolean
}

/**
 * The activity chip's input: the verb, and when it started.
 *
 * Deliberately *not* the subject — not the command being run, not the file being
 * edited, not the path being searched. The status row answers "what is happening"
 * (`终端`, `edit`, `thinking`); *which* command, on *which* file, is the
 * transcript card's job, one line up, where the reader can actually read it. A
 * command in the chip also spent the row's cells on the least load-bearing thing
 * on it: a `pytest -x tests/ --maxfail=1` pushed the quota and context meters
 * towards the drop edge, and `/status`-like detail in a status row is exactly the
 * telemetry dump this row was rebuilt to stop being.
 */
export interface FooterStripActivity {
  kind: FooterActivityKind
  text: string
  /** Wall clock the action started; drives the `· 28s` suffix. */
  startedAt?: number
  now?: number
}

export interface FooterStripQuota {
  /** 0–100, remaining. `undefined` paints the empty bar with `?%`. */
  remainingPercent?: number
  period?: QuotaPeriod
}

/** Everything the default status row paints, in the order a glance reads it. */
export interface FooterStripInput {
  link: FooterStripLink
  activity: FooterStripActivity
  throughput?: ThroughputView
  running: boolean
  quota?: FooterStripQuota
  context?: ContextPressureView
  /**
   * Session-cumulative tokens, **only** when the harness published the total
   * itself. Absent means the chip is not painted at all: a total assembled from
   * the billed parts is a different accounting, and `/status` is where the two are
   * told apart (`sessionTokenTotal` returns which one it had).
   */
  totalTokens?: number
  /**
   * The install warning that leads the row, when the profile is missing rows.
   *
   * It is on the *same* ladder as everything else rather than being fitted around
   * it: it used to be composed into a chip strip by `fitFooterChips` and the rest
   * of the row fitted into what was left, which meant two convergence algorithms
   * on one line and a width hand-computed at the call site. It keeps the highest
   * priority, so it is still the last thing a narrow terminal gives up, and only
   * its text degrades — to the glyph, and off the row only at the very end.
   */
  warning?: { long: string; short: string }
  /**
   * The Host-local echo: the last thing this Host confirmed to the reader
   * (`/theme` switched, a preset saved, a copy landed).
   *
   * Not history (AD-13) and not telemetry: it is an acknowledgement, so it is the
   * lowest-priority chip on the row — the first thing a narrow terminal gives up, and
   * never at the cost of the link, the activity, the quota or the context reading.
   */
  echo?: string
  /** Whether the terminal must be painted with ASCII glyphs. */
  ascii?: boolean
  /** Colour depth the accents are downgraded for. */
  depth?: ColorDepth
  /** Paint accents at all. False is the `no-color` terminal. */
  color?: boolean
}

/**
 * A chip on the default row: one signal, painted at one of nine densities.
 *
 * The level is a *degradation ladder*, not a size class. Level 0 is the full
 * form a 160-column terminal shows; each step buys cells from the least
 * load-bearing part of the row. The order is the whole design: the session
 * total goes first, then the activity's subject, then the meters give up cells
 * before they give up their number, and the link keeps its dots almost to the
 * end — because those dots are the one component that says whether the session
 * is alive. A narrow terminal ends up *quieter*, never denser.
 */
export interface FooterStripChip {
  id: string
  /** Component order. Lower is more load-bearing. */
  priority: number
  /** The chip at one degradation level; `''` drops the chip at that level. */
  render: (level: number) => string
}

/**
 * The deepest degradation level any chip understands.
 *
 * Sixteen levels, one per cell of budget, in the priority order the row was
 * designed around. A coarser ladder left the 72–99 range showing the same row as
 * a 100-column terminal, which is the failure mode this exists to avoid: the
 * narrow terminal must get *less*, not merely a compressed copy.
 */
export const FOOTER_STRIP_MAX_LEVEL = 17

/**
 * The level at which the install warning gives up its sentence and keeps its glyph.
 *
 * Late on purpose: a broken install is the one fact on this row that explains
 * *everything else* looking wrong, so it holds its place while the counters, the
 * meters and even the link's own latency shorten around it.
 */
const WARNING_TEXT_LEVEL = 5

/** The default row's group separator, matching the pre-strip footer. */
export const FOOTER_STRIP_SEPARATOR = ' │ '

/** Activity states that are work in progress, and therefore spin. */
const SPINNING_ACTIVITY: ReadonlySet<FooterActivityKind> = new Set<FooterActivityKind>([
  'compacting', 'agent', 'tools', 'retry', 'waiting-llm', 'thinking', 'reply',
])

/**
 * The activity chip's text: `⠹ edit · 28s`, `⠹ thinking · 18s`, `idle`.
 *
 * The spinner is passed in rather than computed here so the row has exactly one
 * clock (`SPINNER` in `tui.ts`), which is what keeps the glyph in step with the
 * transcript's own live rows.
 * @param activity - the current operational state.
 * @param spinner - the frame to show in front of a working state, if any.
 * @param level - degradation level; the glyph and the clock go before the verb.
 */
export function activityMeter(activity: FooterStripActivity, spinner: string, level = 0): string {
  const text = activity.text
  if (text === '') return ''
  // An idle row says `空闲` while there is room. It is the emptiest signal on the
  // row, so it is the first whole chip that can go — "nothing is happening" is
  // also told by a row that stops talking about it.
  if (activity.kind === 'idle') return level >= 10 ? '' : text
  if (activity.kind === 'plan-review' || activity.kind === 'plan-open' || activity.kind === 'waiting') {
    return level >= 16 ? '' : text
  }
  if (level >= 14) return ''
  // The verb survives furthest: it answers "what is happening", the second
  // question the row exists to answer. The spinner is next (it is motion, and
  // motion is what a spinner adds to a verb that is already there), then the
  // elapsed time, then the subject — which is the widest and least load-bearing
  // of the four.
  const verb = level >= 9 ? firstWord(text) : text
  const glyph = SPINNING_ACTIVITY.has(activity.kind) && level <= 6 && spinner !== '' ? `${spinner} ` : ''
  const parts: string[] = [`${glyph}${verb}`]
  const startedAt = activity.startedAt
  if (startedAt !== undefined && level <= 8) {
    parts.push(formatElapsedShort((activity.now ?? Date.now()) - startedAt))
  }
  return parts.join(' · ')
}

/** The verb of a multi-word activity label (`等待回答` has none; `retry 1/5` has one). */
function firstWord(text: string): string {
  const cut = text.search(/[\s·]/u)
  return cut <= 0 ? text : text.slice(0, cut)
}

/**
 * Build the default status row: the ordered chips, degraded to fit `width`.
 *
 * Order is the information priority the row is built around — link health, what
 * is happening, how fast tokens are arriving, what quota is left, how full the
 * context is, and finally how big the session has grown. Turns, steps, model
 * time, tool time and cache hit left this row on purpose: they are session
 * analytics, they answer no question a live operator is asking, and they are all
 * still in `/status`.
 *
 * Nothing here paints threshold colour on throughput: the harness publishes no
 * performance classification, and inventing one would paint a healthy reasoning
 * model red for being deliberate.
 * @param input - the signals, already resolved by the caller.
 * @param width - cells available on the row.
 * @param separator - the (already accented) group separator.
 * @param spinner - current animation frame for working states.
 * @returns the row, never wider than `width`.
 */
export function runtimeStrip(
  input: FooterStripInput,
  width: number,
  separator = FOOTER_STRIP_SEPARATOR,
  spinner = '',
): string {
  const limit = Math.max(1, width)
  const chips = footerStripChips(input, separator, spinner)
  for (let level = 0; level <= FOOTER_STRIP_MAX_LEVEL; level += 1) {
    const row = chips
      .map(chip => chip.render(level))
      .filter(text => text !== '')
      .join(separator)
    if (row === '' || visibleWidth(pinEmojiCells(row)) <= limit) return row
  }
  // Even the one-word row is too wide (a 20-column terminal): the warning wins,
  // because a broken install is the one thing that cannot be read off the screen it
  // broke; otherwise the link signal, which says whether the session is alive.
  const lifeline = chips.find(chip => chip.id === 'warning') ?? chips.find(chip => chip.id === 'link')
  return truncateAnsiToWidth(lifeline?.render(FOOTER_STRIP_MAX_LEVEL) ?? '', limit)
}

/**
 * What a Screen's compact runtime strip reports, in the order it is read.
 *
 * A Screen replaces the whole workspace, so the footer's two rows are gone with
 * it. This is the subset that has to survive: the reader must still be able to
 * answer "is the agent running", "is anything waiting", "is the link alive". It
 * deliberately carries no throughput, no session total, no cwd and no subagent
 * metadata — those are workspace facts about *work*, and a Screen is a place you
 * visit while the work continues (AD-8).
 */
export interface ScreenStripInput {
  activity: FooterStripActivity
  /** Human interactions waiting behind this screen: a question or an approval. */
  waiting: boolean
  /** Messages the reader queued for the agent. */
  queued: number
  /** Agent-initiated questions the reader has not answered yet. */
  queuedQuestions: number
  link: FooterStripLink
  context?: ContextPressureView
  quota?: FooterStripQuota
  ascii?: boolean
  color?: boolean
  depth?: ColorDepth
}

/**
 * The Screen strip: the status row's own chips, a subset, fitted from the back.
 *
 * Rendered with the *same* chip functions the status row uses (`linkChipText`,
 * `activityMeter`, `contextChip`, `quotaChip`), so a Screen cannot drift into a
 * second visual language or a second reading of the same state. Fitting is the
 * opposite of the workspace row's: that row spends its cells on the tail first and
 * degrades everything together, while the Screen strip holds its highest-priority
 * group and drops whole groups from the end (quota, context, link, queued) — the
 * reader is here for the report, and a strip that re-read as it scrolled would be
 * worse than a shorter one.
 * @param input - the runtime facts, all read from the same fields the footer reads.
 * @param width - cells available on the row.
 * @param separator - the (already accented) group separator.
 * @param spinner - current animation frame for working states.
 * @returns the row, never wider than `width`.
 */
export function screenRuntimeStrip(
  input: ScreenStripInput,
  width: number,
  separator = FOOTER_STRIP_SEPARATOR,
  spinner = '',
): string {
  const limit = Math.max(1, width)
  const ascii = input.ascii ?? asciiChromeEnabled()
  const color = input.color ?? true
  const depth = input.depth ?? 'truecolor'
  const pips = linkPips(input.link, color, depth, ascii)
  const windowTag = quotaWindowTag(input.quota?.period)
  const windowTagShort = quotaWindowTagShort(input.quota?.period)
  const queued = input.queuedQuestions > 0
    ? t('screen.waitingBehind', { count: input.queuedQuestions })
    : input.queued > 0 ? t('footer.queued', { count: input.queued }) : ''
  // Priority order, highest first: dropping from the back is then a plain pop.
  const groups: string[] = [
    activityMeter(input.activity, spinner, 0),
    input.waiting ? t('footer.waiting') : queued,
    linkChipText(input.link, pips, 0),
    contextChip(input.context, 0, ascii, color, depth),
    quotaChip(input.quota, windowTag, windowTagShort, 0, ascii, color, depth),
  ].filter(text => text !== '')
  while (groups.length > 0) {
    const row = groups.join(separator)
    if (visibleWidth(pinEmojiCells(row)) <= limit) return row
    groups.pop()
  }
  // Nothing fits — not even the activity verb on a one-word row. Truncating the
  // verb beats an empty strip: 运行中 cut to two cells still says the session is
  // alive, which is the question the strip exists to answer.
  return truncateAnsiToWidth(activityMeter(input.activity, spinner, 0), limit)
}

/** The chips, in priority order, each with its own degradation rule. */
function footerStripChips(
  input: FooterStripInput,
  separator: string,
  spinner: string,
): FooterStripChip[] {
  const ascii = input.ascii ?? asciiChromeEnabled()
  const color = input.color ?? true
  const depth = input.depth ?? 'truecolor'
  const pips = linkPips(input.link, color, depth, ascii)
  const state = performanceValueState(input.throughput, input.running)
  const total = input.totalTokens === undefined ? undefined : sessionTokenChip(input.totalTokens)
  const windowTag = quotaWindowTag(input.quota?.period)
  const windowTagShort = quotaWindowTagShort(input.quota?.period)
  const chips: FooterStripChip[] = []
  if (input.warning !== undefined && input.warning.long !== '') {
    chips.push({
      id: 'warning',
      priority: -1,
      render: level => (level >= WARNING_TEXT_LEVEL
        ? input.warning?.short ?? ''
        : input.warning?.long ?? ''),
    })
  }
  chips.push(
    { id: 'link', priority: 0, render: level => linkChipText(input.link, pips, level) },
    { id: 'activity', priority: 1, render: level => activityMeter(input.activity, spinner, level) },
    {
      id: 'throughput',
      priority: 2,
      render: level => {
        // A running turn with nothing measured yet has no number to show, and
        // says so on a wide row; once cells are scarce the chip goes rather than
        // spending seven of them on an absence. An idle row with no measurement
        // has nothing to report at all — the number only ever describes a step,
        // and there is no step in flight.
        if (state === 'unavailable') {
          if (!input.running || level > 1) return ''
          return `— ${t('strip.tokShort')}`
        }
        if (level >= 16) return ''
        return performanceValue(input.throughput, input.running, {
          state,
          short: level >= 11,
          color: color && state === 'live',
        })
      },
    },
    {
      id: 'quota',
      priority: 3,
      render: level => quotaChip(input.quota, windowTag, windowTagShort, level, ascii, color, depth),
    },
    {
      id: 'context',
      priority: 4,
      render: level => contextChip(input.context, level, ascii, color, depth),
    },
    { id: 'total', priority: 5, render: level => (level >= 1 || total === undefined ? '' : total) },
    {
      id: 'echo',
      // Lowest priority: level 1 is the first squeeze, and the echo is what goes —
      // together with the session total, which is the other non-core group.
      priority: 6,
      render: level => (level >= 1 || input.echo === undefined ? '' : input.echo),
    },
  )
  return chips
}

/**
 * `SSH ●●●● 31ms` → `SSH 31ms` → `SSH`; `SSH ○○○○ 未测` when nothing was measured.
 *
 * The dots are the last thing to go, after even the throughput number: they are
 * this project's signature component and the only cell on the row that reports
 * whether the session is still alive. Latency goes before they do, because the
 * dots already encode it.
 */
function linkChipText(link: FooterStripLink, pips: string, level: number): string {
  // `本地` / `local` on a TTY that is not an SSH session, the same word
  // `formatLinkQualityChip` has always used: a row that said `SSH` on a local
  // terminal was claiming a link nobody measured.
  const label = t(link.kind === 'local' ? 'paint.localLabel' : 'strip.link')
  const delay = link.kind === 'local' ? `${link.intervalMs}ms` : linkDelay(link)
  if (level >= 17) return label
  if (level >= 12 || pips === '') return delay === '' ? label : `${label} ${delay}`
  return `${label} ${pips}${delay === '' ? '' : ` ${delay}`}`
}

/** The SSH pips, coloured by the project's existing link-quality thresholds. */
function linkPips(link: FooterStripLink, color: boolean, depth: ColorDepth, ascii: boolean): string {
  // A local terminal has no link health to report: the chip keeps its label, as
  // `formatLinkQualityChip` has always painted it.
  if (link.kind === 'local') return ''
  const quality = linkQualityOf(link.kind, link.probed ? link.rttMs : undefined)
  const filled = linkSignalPips(quality)
  const raw = healthMeter(filled, { ascii })
  if (!color) return raw
  const token = filled <= 0
    ? themeToken(activeTheme(), 'system')
    : filled === 1
      ? themeThresholdToken(activeTheme(), 'over')
      : filled === 2
        ? themeThresholdToken(activeTheme(), 'warn')
        : themeThresholdToken(activeTheme(), 'ok')
  return accent(raw, token, depth)
}


/** The measured round-trip, or the marker that says there is not one. */
function linkDelay(link: FooterStripLink): string {
  if (link.probed && link.rttMs !== undefined && Number.isFinite(link.rttMs)) {
    return `${Math.round(link.rttMs)}ms`
  }
  return t('strip.linkUnmeasured')
}

/**
 * `5Hr ████████ 82%` → `5Hr █████ 82%` → `5Hr 82%` → `5h 82%`.
 *
 * The bar is a capacity, so it gives up cells before it gives up its number:
 * eight segments, then five, then none. The window tag is fixed-width technical
 * text (`5Hr` / `1Wk` / `1Mo`) and survives until the row is genuinely out of
 * room, because a percentage with no window is unreadable in a bug report.
 */
function quotaChip(
  quota: FooterStripQuota | undefined,
  windowTag: string,
  windowTagShort: string,
  level: number,
  ascii: boolean,
  color: boolean,
  depth: ColorDepth,
): string {
  if (quota === undefined || level >= 16) return ''
  return capacityMeter(quota.remainingPercent, {
    label: level >= 11 ? windowTagShort : windowTag,
    basis: 'remaining',
    quota: true,
    segments: level >= 4 ? CAPACITY_SEGMENTS_MEDIUM : CAPACITY_SEGMENTS_WIDE,
    percentOnly: level >= 8,
    ascii,
    color,
    depth,
  }).text
}

/** `CTX ███████ 61% · 610K/1M` → `CTX ███████ 61%` → `CTX 61%` → `ctx 61%`. */
function contextChip(
  context: ContextPressureView | undefined,
  level: number,
  ascii: boolean,
  color: boolean,
  depth: ColorDepth,
): string {
  if (context === undefined || level >= 15) return ''
  const label = level >= 11 ? t('strip.ctxShort') : t('strip.ctx')
  return capacityMeter(context.percent, {
    label,
    basis: 'used',
    segments: level >= 3 ? CAPACITY_SEGMENTS_MEDIUM : CAPACITY_SEGMENTS_WIDE,
    percentOnly: level >= 6,
    ascii,
    color,
    depth,
    ...(level <= 2
      // The session ratio is detail the widest rows can afford; the percent
      // stays outside it, so `CTX ███████ 61% · 610K/1M` degrades to
      // `CTX ███████ 61%` without the number moving.
      ? {
        detail: t('strip.ctxDetail', {
          used: formatTokens(context.usedTokens),
          window: formatTokens(context.contextWindow),
        }),
      }
      : {}),
  }).text
}

/** `Tok 36.8M` — the session total, the first chip a narrow row gives up. */
function sessionTokenChip(tokens: number): string | undefined {
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined
  return t('strip.total', { tokens: formatTokens(tokens) })
}
