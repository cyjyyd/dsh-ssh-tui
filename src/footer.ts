/**
 * Footer stats, status identity, context-pressure chips, and `/status` report.
 */

import { t } from './i18n/index.js'
import { pinEmojiCells, truncateAnsiToWidth, visibleWidth } from './term-text.js'
import { describeSubagentFit, subagentIdentitySgr, subagentProviderDiffers } from './subagent-model.js'
import { downgradeSgr, type ColorDepth } from './color-depth.js'
import {
  commandCodeSourceFor, formatQuotaStatusLine, openCodeSourceFor,
  type QuotaPeriod, type QuotaSnapshot, type QuotaSource,
} from './quota.js'
import type { DisconnectPolicyName } from './transcript-types.js'

export const WAIT_INDICATOR_MS = 8000
/** Compact token count, matching the web stats line (517 / 12.2K / 1.2M). */
export function formatTokens(n: number): string {
  const scaled = (value: number): string =>
    value >= 100 ? String(Math.round(value)) : String(Math.round(value * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/**
 * Prompt occupancy of the next request, from DSH `contextPressure`.
 * Provider-agnostic: uses the routed model's advertised window, not a
 * hardcoded xAI size. Compaction-basic still owns in-turn pressure at 80%.
 */
export const CONTEXT_PRESSURE_WARN_RATIO = 0.8
export const CONTEXT_PRESSURE_DANGER_RATIO = 0.95
/** Idle auto-compact starts here so recovery finishes before the 80% in-turn trigger. */
export const CONTEXT_IDLE_COMPACT_RATIO = 0.72

export interface ContextPressureSample {
  usedTokens: number
  contextWindow: number
}

export interface ContextPressureView {
  usedTokens: number
  contextWindow: number
  percent: number
  level: 'ok' | 'warn' | 'danger'
}

/** Prompt-side occupancy of one usage sample: uncached input plus cache traffic. */
export function promptPressureTokens(usage: {
  inputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/** Prefer the next-request projection; fall back to last-request pressure. */
export function contextPressureUsedTokens(pressure: {
  projectedTokens?: number
  pressureTokens?: number
} | undefined): number | undefined {
  if (pressure === undefined) return undefined
  if (typeof pressure.projectedTokens === 'number' && Number.isFinite(pressure.projectedTokens)) {
    return Math.max(0, pressure.projectedTokens)
  }
  if (typeof pressure.pressureTokens === 'number' && Number.isFinite(pressure.pressureTokens)) {
    return Math.max(0, pressure.pressureTokens)
  }
  return undefined
}

export function parseContextPressure(value: unknown): ContextPressureSample | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const raw = value as {
    projectedTokens?: unknown
    pressureTokens?: unknown
    contextWindow?: unknown
  }
  const window = typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow)
    ? raw.contextWindow
    : undefined
  if (window === undefined || window <= 0) return undefined
  const used = contextPressureUsedTokens({
    ...(typeof raw.projectedTokens === 'number' ? { projectedTokens: raw.projectedTokens } : {}),
    ...(typeof raw.pressureTokens === 'number' ? { pressureTokens: raw.pressureTokens } : {}),
  })
  if (used === undefined) return undefined
  return { usedTokens: used, contextWindow: window }
}

export function contextPressureView(sample: ContextPressureSample): ContextPressureView {
  const percent = (sample.usedTokens / sample.contextWindow) * 100
  return {
    usedTokens: sample.usedTokens,
    contextWindow: sample.contextWindow,
    percent,
    level: percent >= CONTEXT_PRESSURE_DANGER_RATIO * 100
      ? 'danger'
      : percent >= CONTEXT_PRESSURE_WARN_RATIO * 100
        ? 'warn'
        : 'ok',
  }
}

/**
 * 8-segment Braille ring. Empty `⣀`; full `⣿`. Width is always 1 cell.
 * Index is `ceil(percent / 12.5)` clamped to 0..8.
 */
export const CONTEXT_RING_EMPTY = '⣀'
export const CONTEXT_RING_SEGMENTS = ['⣀', '⠉', '⠋', '⠛', '⠞', '⠟', '⠿', '⡿', '⣿'] as const
/** The full cell of the same Braille family, for bars built like the ring. */
export const CONTEXT_RING_FULL = '⣿'

export function formatContextPressureRing(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return CONTEXT_RING_EMPTY
  const filled = Math.min(8, Math.max(0, Math.ceil(percent / 12.5)))
  return CONTEXT_RING_SEGMENTS[filled] ?? '⣿'
}

export function contextPressureRingColor(level: ContextPressureView['level']): string {
  if (level === 'danger') return '31'
  if (level === 'warn') return '33'
  return '32'
}

export function formatContextPressureChip(view: ContextPressureView, color = false): string {
  const ring = formatContextPressureRing(view.percent)
  const painted = color
    ? `\x1b[${contextPressureRingColor(view.level)}m${ring}\x1b[0m`
    : ring
  return t('footer.contextRing', {
    ring: painted,
    used: formatTokens(view.usedTokens),
    window: formatTokens(view.contextWindow),
    percent: Math.round(view.percent),
  })
}

export function formatContextPressureStatusLine(view: ContextPressureView | undefined): string {
  if (view === undefined) return t('status.contextNone')
  return t('status.contextLine', {
    used: formatTokens(view.usedTokens),
    window: formatTokens(view.contextWindow),
    percent: view.percent.toFixed(1),
    level: t(`status.contextLevel.${view.level}`),
  })
}

export function contextPressureAlertText(view: ContextPressureView): string {
  const vars = {
    used: formatTokens(view.usedTokens),
    window: formatTokens(view.contextWindow),
    percent: view.percent.toFixed(0),
  }
  return view.level === 'danger'
    ? t('context.alertDanger', vars)
    : t('context.alertWarn', vars)
}

export function shouldIdleAutoCompact(view: ContextPressureView | undefined): boolean {
  if (view === undefined) return false
  return view.usedTokens / view.contextWindow >= CONTEXT_IDLE_COMPACT_RATIO
}

/** Compact duration, matching the web stats line (45.2s / 2m42s). */
export function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

export function formatTokensPerSecond(tokensPerSecond: number): string {
  // A slow step (a few tokens over tens of seconds) still decoded something;
  // rounding that to "0 tok/s" reads as a stalled model.
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond <= 0) return '0 tok/s'
  if (tokensPerSecond < 0.5) return '<1 tok/s'
  return `${Math.round(tokensPerSecond)} tok/s`
}
export function providerShortCode(provider: string): string {
  const id = provider.trim()
  if (id === 'deepseek-official' || id === 'deepseek') return t('route.deepseek')
  if (id === 'xai' || id === 'grok' || id.startsWith('xai-')) return 'SuperGrok'
  if (id === 'opencode-go') return 'OpenCode Go'
  if (id === 'opencode') return 'OpenCode Zen'
  return id
}

export interface FooterStatsInput {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Stats groups in drop order (last is dropped first when the row is too wide). */
export function footerStatsGroups(stats: FooterStatsInput): string[] {
  const groups: string[] = []
  if (stats.steps > 0) groups.push(t('footer.turnsSteps', { turns: stats.turns, steps: stats.steps }))
  const billedInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  if (billedInput > 0 || stats.outputTokens > 0) {
    groups.push(t('footer.tokens', { input: formatTokens(billedInput), output: formatTokens(stats.outputTokens) }))
  }
  const speeds: string[] = []
  if (stats.decodeMs > 0 && stats.decodeTokens > 0) {
    speeds.push(formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1_000)))
  } else if (stats.ttftSteps > 0) {
    speeds.push(t('footer.ttft', { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }))
  }
  if (speeds.length > 0) groups.push(speeds.join(' '))
  const durations: string[] = []
  if (stats.llmMs > 0) durations.push(t('footer.llmMs', { duration: formatDuration(stats.llmMs) }))
  if (stats.toolMs > 0) durations.push(t('footer.toolMs', { duration: formatDuration(stats.toolMs) }))
  if (durations.length > 0) groups.push(durations.join(' '))
  if (billedInput > 0) groups.push(t('footer.cacheHit', { percent: Math.round(stats.cacheReadTokens / billedInput * 100) }))
  return groups
}

/**
 * One group in the status strip, with the graphic-only form a narrow terminal
 * keeps. `priority` orders the losses: 0 is the last thing to go.
 */
export interface FooterChip {
  id: string
  /** Glyph plus text: what a wide terminal shows. */
  long: string
  /** Glyph only, or `''` for a group that is pure text. */
  short: string
  priority: number
}

/**
 * Fit an ordered strip into `width` cells, losing text before graphics.
 *
 * The old fitter dropped whole groups from the end, so a narrow terminal lost
 * the ⚠ and the context ring — the two signals that say something is wrong —
 * while keeping long numeric groups. Two passes now: every chip trades its text
 * for its glyph in reverse priority order, and only then do whole groups go,
 * again lowest priority first. The result never exceeds the width.
 *
 * Chips may carry SGR accents (the link pips, the ⚠) and the caller may pass a
 * styled separator, so both the measurement and the final cut are ANSI-aware:
 * feeding styled text to a plain-text truncator strips the accent's `ESC` and
 * leaves its `[32m` body on the grid.
 */
export function fitFooterChips(chips: readonly FooterChip[], width: number, separator = ' │ '): string {
  const limit = Math.max(1, width)
  const state = chips
    .filter(chip => chip.long !== '' || chip.short !== '')
    .map(chip => ({ chip, full: true, present: true }))
  const render = (): string => state
    .filter(entry => entry.present)
    .map(entry => (entry.full ? entry.chip.long : entry.chip.short))
    .filter(text => text !== '')
    .join(separator)
  // Budget the way it will be painted: the frame pins a symbol like ⚠ with a
  // variation selector and a reserving space, so the raw string measures one or
  // two cells narrower than the row it becomes. Fitting the unpinned text left
  // a row that overflowed the terminal by exactly that much.
  const used = (): number => visibleWidth(pinEmojiCells(render()))
  const byLeastImportant = [...state].sort((a, b) => b.chip.priority - a.chip.priority)
  for (const entry of byLeastImportant) {
    if (used() <= limit) break
    entry.full = false
  }
  for (const entry of byLeastImportant) {
    if (used() <= limit) break
    entry.present = false
  }
  if (state.length > 0 && state.every(entry => !entry.present)) {
    // Nothing fits, not even the glyphs. Keeping the most important group and
    // letting the clip shorten it beats handing the user a blank row: a ⚠ cut
    // to one cell still says the install is broken.
    const best = [...state].sort((a, b) => a.chip.priority - b.chip.priority)[0]
    if (best !== undefined) {
      best.present = true
      best.full = false
    }
  }
  return truncateAnsiToWidth(render(), limit)
}

/**
 * The roster's health as a chip: absent means `/mode` cannot switch presets and
 * the preset-owned tools are missing. It leads the strip and keeps its glyph
 * longest, because it is the one group that reports a broken install.
 */
export function footerHealthChip(missing: boolean, color = false): FooterChip | undefined {
  if (!missing) return undefined
  const glyph = color ? `\x1b[33m⚠\x1b[0m` : '⚠'
  return {
    id: 'health',
    long: `${glyph} ${t('footer.rosterMissing')}`,
    short: glyph,
    priority: 0,
  }
}

export function fitFooterStatsLine(chip: string, groups: readonly string[], width: number): string {
  const kept = [...groups]
  const render = (): string => kept.length === 0 ? chip : `${chip} │ ${kept.join(' │ ')}`
  while (kept.length > 0 && visibleWidth(render()) > width) kept.pop()
  return truncateAnsiToWidth(render(), Math.max(1, width))
}

export type FooterActivityKind =
  | 'plan-review'
  | 'waiting'
  | 'compacting'
  | 'retry'
  | 'subagents'
  | 'tools'
  | 'plan-open'
  | 'plan-pending'
  | 'goal'
  | 'waiting-llm'
  | 'idle'

export interface FooterStatusInput {
  running: boolean
  planReview: boolean
  waitingQuestion: boolean
  compacting: boolean
  retry?: { retry: number; maxRetries: number }
  subagents: number
  tools: number
  planLeftOpen: boolean
  planPending: boolean
  planActive: boolean
  goalPhase?: 'active' | 'paused' | 'blocked'
  idleMs: number
  model: string
  effort?: string
  preset?: string
  provider: string
  parentModel: string
  subModel: string
  /** Explicit `/submodel` provider override; undefined means "inherit parent". */
  subProvider?: string
  /** Explicit `/subeffort` override for subagent children. */
  subEffort?: string
  quotaCode?: string
  quotaPercent?: number
  /** Which rolling window `quotaPercent` belongs to: tagged `5Hr`/`1Wk`/`1Mo`. */
  quotaPeriod?: QuotaPeriod
  /** The provider has a quota surface but no reading yet: paint `░░░░░░░░ ?%`. */
  quotaUnknown?: boolean
  contextChip?: string
  balanceText?: string
  search?: { index: number; total: number }
  foldedInput: boolean
  multiLineInput: boolean
  queued: number
  cwdLabel?: string
  compactView?: boolean
}

export function footerActivity(input: FooterStatusInput): { kind: FooterActivityKind; text: string } {
  if (input.planReview) return { kind: 'plan-review', text: t('footer.planReview') }
  if (input.waitingQuestion) return { kind: 'waiting', text: t('footer.waiting') }
  if (input.compacting) return { kind: 'compacting', text: t('footer.compacting') }
  // Only a running turn can be retrying: a chip left over from a finished turn
  // (a missed event, or a retry of a background request such as the session
  // title) must not hide the state the user is actually in.
  if (input.running && input.retry !== undefined) {
    return { kind: 'retry', text: t('footer.retry', { retry: input.retry.retry, max: input.retry.maxRetries }) }
  }
  if (input.subagents > 0) return { kind: 'subagents', text: t('footer.subagents', { count: input.subagents }) }
  if (input.running && input.tools > 0) return { kind: 'tools', text: t('footer.tools', { count: input.tools }) }
  if (input.planLeftOpen) return { kind: 'plan-open', text: t('footer.planOpen') }
  if (input.planPending) return { kind: 'plan-pending', text: t('footer.planSwitching') }
  if (input.planActive) return { kind: 'plan-pending', text: t('footer.planMode') }
  if (input.goalPhase === 'active') return { kind: 'goal', text: t('footer.goalActive') }
  if (input.goalPhase === 'paused') return { kind: 'goal', text: t('footer.goalPaused') }
  if (input.goalPhase === 'blocked') return { kind: 'goal', text: t('footer.goalBlocked') }
  if (input.running && input.idleMs > WAIT_INDICATOR_MS) {
    return { kind: 'waiting-llm', text: t('footer.waitSeconds', { seconds: Math.floor(input.idleMs / 1000) }) }
  }
  if (input.running) return { kind: 'idle', text: t('footer.running') }
  return { kind: 'idle', text: t('footer.idle') }
}

/** Short remaining-quota bar: 8 pips, filled from the left. */
export function formatQuotaBar(remainingPercent: number, width = 8): string {
  const remaining = Math.max(0, Math.min(100, remainingPercent))
  const filled = Math.round(remaining / 100 * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/**
 * `sub:<model>` chip for the identity row: `sub:grok-4.5`, or
 * `sub:grok-4.5(xhigh)` when an explicit `/subeffort` is set.
 *
 * It shows the model name only, like the parent's own chip, unless `/submodel`
 * pinned a different provider — then `sub:xai/grok-4.5` so the foreign route
 * is visible on the identity row as well as the recolored chip.
 */
export function subagentRouteLabel(model: string, provider?: string, effort?: string): string {
  const id = shortModelName(model)
  if (id === '') return ''
  const suffix = effort === undefined || effort.trim() === '' ? '' : `(${effort.trim()})`
  const host = provider === undefined || provider.trim() === '' ? '' : `${provider.trim()}/`
  return `sub:${host}${id}${suffix}`
}

/**
 * Paint the `sub:` chip on an otherwise muted status line.
 *
 * Only a *foreign* route is accented: cyan when `/submodel` pinned a supplier
 * the parent is not on. A child that follows the parent (or that was pinned
 * back onto the parent's own provider) keeps the identity row's mute — the
 * accent means "this route is not your parent's", and spending it on every
 * child made the following case look pinned.
 *
 * The mute (`90`) is reopened after the chip so the rest of the identity row
 * stays dim.
 */
export function paintFooterSubagentChip(
  line: string,
  chip: string,
  foreign: boolean,
  muteSgr = '90',
  depth: ColorDepth = 'truecolor',
): string {
  if (!foreign || chip === '' || !line.includes(chip)) return line
  const code = downgradeSgr(subagentIdentitySgr(true), depth)
  if (code === '') return line
  const mute = muteSgr === '' ? '0' : muteSgr
  return line.replace(chip, `\x1b[${code}m${chip}\x1b[0m\x1b[${mute}m`)
}

export function footerSubagentForeign(input: Pick<FooterStatusInput, 'provider' | 'subProvider'>): boolean {
  return subagentProviderDiffers(input.provider, input.subProvider)
}

/**
 * The model as the footer shows it: the model's own name, without a
 * `provider/model` route prefix.
 *
 * Some providers carry the vendor in the model id (`xai/grok-4.6`,
 * `deepseek-official/deepseek-v4-flash`). The route is worth a row in the header
 * and in `/status`; in the status line it spent cells on something the reader
 * already knows, and it pushed the quota badge towards the drop edge.
 * `sub:` routes keep their provider on purpose — that is a *different* route
 * from the parent's, and hiding it would make the two indistinguishable.
 */
export function shortModelName(model: string): string {
  const id = model.trim()
  const slash = id.lastIndexOf('/')
  if (slash < 0) return id
  const tail = id.slice(slash + 1).trim()
  // A trailing slash (or a bare `/`) leaves nothing to show: keep the original.
  return tail === '' ? id : tail
}

export function footerIdentityParts(input: FooterStatusInput): string[] {
  const parts: string[] = []
  if (input.compactView === true) parts.push(`[${t('view.footerCompact')}]`)
  if (input.preset !== undefined && input.preset !== '') parts.push(`[${input.preset}]`)
  if (input.cwdLabel !== undefined && input.cwdLabel !== '') parts.push(input.cwdLabel)
  const modelName = shortModelName(input.model)
  const effort = input.effort === undefined || input.effort.trim() === '' ? '' : input.effort.trim()
  const model = [modelName, effort].filter(part => part !== '').join(' ')
  if (model !== '') parts.push(model)
  if (input.balanceText !== undefined && input.balanceText !== '') {
    parts.push(input.balanceText)
  }
  if (input.quotaUnknown === true) {
    parts.push(formatQuotaUnknown())
  } else if (input.quotaPercent !== undefined) {
    parts.push(formatFooterQuota(input.quotaPercent, input.quotaCode, input.quotaPeriod))
  }
  if (input.contextChip !== undefined && input.contextChip !== '') parts.push(input.contextChip)
  // The subagent route is what every child inherits, so it is always on the
  // line again (hiding it when it repeated the parent model read as a
  // regression) — but it sits after the quota/context chips, which are live
  // operational signals and should be the last thing a narrow row drops.
  const sub = subagentRouteLabel(input.subModel, input.subProvider, input.subEffort)
  if (sub !== '') parts.push(sub)
  if (input.search !== undefined) parts.push(t('footer.search', { index: input.search.index + 1, total: input.search.total }))
  if (input.foldedInput) parts.push(t('footer.inputFolded'))
  else if (input.multiLineInput) parts.push(t('footer.multiLine'))
  if (input.queued > 0) parts.push(t('footer.queued', { count: input.queued }))
  return parts
}

/**
 * `SuperGrok 5Hr ███████░ 82%` — short plan badge, the window the number belongs
 * to, then the bar.
 *
 * The tags are fixed technical labels (`5Hr` / `1Wk` / `1Mo`) rather than
 * localized words: they sit in a footer that is already fighting for cells, and
 * a window tag that changes with the locale would be unreadable in a screenshot
 * or a bug report. Everything else about the window (label, reset time, detail)
 * stays in `/quota`.
 */
export function formatFooterQuota(percent: number, code?: string, period?: QuotaPeriod): string {
  const bar = `${formatQuotaBar(percent)} ${percent.toFixed(0)}%`
  const tag = quotaWindowTag(period)
  const name = code === undefined ? '' : code.trim()
  return [name, tag, bar].filter(part => part !== '').join(' ')
}

/**
 * The quota widget before the first reading arrives, or while the provider
 * cannot be reached: an empty bar and a question mark.
 *
 * Deliberately not `0%`: an unreachable quota API is not a used-up quota, and a
 * number the footer cannot back up is worse than no number. The bar is there
 * from the first frame so the row does not jump when the reading lands.
 */
export function formatQuotaUnknown(): string {
  return `${formatQuotaBar(0)} ?%`
}

/** Fixed-width tag for the window a footer quota number belongs to. */
export function quotaWindowTag(period: QuotaPeriod | undefined): string {
  if (period === 'hourly') return '5Hr'
  if (period === 'weekly') return '1Wk'
  if (period === 'monthly') return '1Mo'
  return ''
}

/**
 * The badge the footer shows instead of the billing plan's own label:
 * `SuperGrok`, `OC·GO` (OpenCode Go), `CC·GOAT` (Command Code Goat),
 * `A2` (AIClient2API panel: the upstream subscription, e.g. Google AI Pro).
 *
 * The long names live in `/quota`; this one has to survive next to a model id.
 * Without a `source` (a hand-built snapshot) the plan label is matched instead,
 * so old callers and tests keep a sensible badge.
 */
export function shortQuotaPlanName(snapshot: { plan: string; source?: QuotaSource }): string {
  const plan = snapshot.plan.trim()
  if (snapshot.source === 'supergrok') return 'SuperGrok'
  if (snapshot.source === 'opencode-go') return 'OC·GO'
  if (snapshot.source === 'command-code') {
    const tier = plan === '' || plan.toLowerCase() === 'command code' ? '' : plan.toUpperCase()
    return tier === '' ? 'CC' : `CC·${tier}`
  }
  // The panel label is the upstream plan (a Google AI tier, an account email…),
  // which is exactly what does not fit here; the provider type already tells the
  // user which mount of the proxy this is.
  if (snapshot.source === 'aiclient2api') return 'A2'
  if (/supergrok/iu.test(plan)) return 'SuperGrok'
  if (/opencode/iu.test(plan)) return 'OC·GO'
  if (/goat/iu.test(plan)) return 'CC·GOAT'
  return plan
}

/**
 * Drop the Go / SuperGrok plan name from a quota identity part, keeping the
 * remaining-percent bar. Returns true when a part was rewritten.
 */
export function dropFooterQuotaPlanName(parts: string[]): boolean {
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined) continue
    const barAt = part.search(/[█░]{8} \d+%$/)
    if (barAt <= 0) continue
    // The window tag is the last thing before the bar and survives the badge:
    // `SuperGrok 5Hr ███ 82%` narrows to `5Hr ███ 82%`, not to a bare bar.
    const tag = /(?:5Hr|1Wk|1Mo)$/u.exec(part.slice(0, barAt).trimEnd())?.[0]
    parts[index] = tag === undefined ? part.slice(barAt) : `${tag} ${part.slice(barAt)}`
    return true
  }
  return false
}

export function fitFooterStatusLine(activity: string, identity: readonly string[], width: number): string {
  const kept = [...identity]
  const render = (): string => kept.length === 0 ? activity : `${activity}  ${kept.join(' · ')}`
  if (visibleWidth(render()) > width) dropFooterQuotaPlanName(kept)
  while (kept.length > 0 && visibleWidth(render()) > width) kept.pop()
  return truncateAnsiToWidth(render(), Math.max(1, width))
}

export interface StatusReportInput {
  sessionId: string
  pluginVersion: string
  provider: string
  model: string
  effort?: string
  agentStatus: string
  preset: string
  activeSubagents: number
  plan: 'off' | 'pending' | 'on'
  paint: string
  disconnect?: DisconnectPolicyName
  waitingQuestions: number
  quota?: QuotaSnapshot
  context?: ContextPressureView
  parentModel?: string
  subProvider?: string
  subModel: string
  cwd?: string
}

/** Lines printed by `/status` — SSH first-boot diagnostics, no extra command. */
export function formatStatusReport(input: StatusReportInput): string[] {
  const route = describeProviderRoute(input.provider)
  const effort = input.effort === undefined ? '' : ` (${input.effort})`
  const fit = describeSubagentFit({
    parentProvider: input.provider,
    parentModel: input.parentModel,
    subProvider: input.subProvider,
    subModel: input.subModel,
  })
  return [
    `session: ${input.sessionId}`,
    `plugin: dsh-ssh-tui ${input.pluginVersion}`,
    `cwd: ${input.cwd ?? ''}`,
    `route: ${input.provider}/${input.model}${effort}`,
    `provider: ${route.kind}`,
    `status: ${input.agentStatus}`,
    `preset: ${input.preset}`,
    `subagents: ${input.activeSubagents}`,
    fit.line,
    `plan: ${input.plan}`,
    formatQuotaStatusLine(input.quota),
    formatContextPressureStatusLine(input.context),
    `paint: ${input.paint}`,
    `disconnect: ${input.disconnect ?? 'pause'}`,
    input.waitingQuestions > 0 ? `questions: waiting ${input.waitingQuestions}` : 'questions: none',
  ]
}

/** Human-facing kind for a live LLM route. */
export function describeProviderRoute(provider: string): { kind: string; short: string } {
  const id = provider.trim()
  if (id === 'deepseek-official' || id === 'deepseek') {
    return { kind: t('route.deepseek'), short: t('route.deepseek') }
  }
  if (id === 'xai' || id === 'grok' || id.startsWith('xai-')) {
    return { kind: t('route.supergrokKind'), short: t('route.supergrokShort') }
  }
  if (id === 'opencode-go') return { kind: t('route.go'), short: t('route.go') }
  if (id === 'opencode') return { kind: t('route.zen'), short: t('route.zen') }
  return { kind: t('route.registered'), short: id }
}

/** Routes that authenticate without a harness API-key credential. */
export function providerUsesLocalOAuth(provider: string): boolean {
  const id = provider.trim()
  return id === 'xai' || id === 'grok' || id.startsWith('xai-')
}

/**
 * Whether a provider has a quota surface at all, without asking it.
 *
 * The footer paints a quota widget from the first frame — an empty bar and `?%`
 * until a reading arrives — so it needs to tell "this provider will have one"
 * from "this provider reports a balance instead" (DeepSeek) or nothing at all.
 * Every branch is a synchronous settings read, so a repaint never does IO.
 */
export function providerHasQuotaSurface(provider: string, llmPiAiSection: unknown): boolean {
  const id = provider.trim()
  if (id === '') return false
  if (providerUsesLocalOAuth(id)) return true
  if (commandCodeSourceFor(id, llmPiAiSection) !== null) return true
  const source = openCodeSourceFor(id, llmPiAiSection)
  return source !== null && source.flavor === 'go'
}
