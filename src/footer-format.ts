/**
 * Presentation formatting: a value in, text out.
 *
 * Pure functions that know nothing about rows or widths, and exist as their own
 * module because the *same* reading is painted in several places (the status row,
 * the workspace row, `/status`, a transcript chip) and those call sites must not
 * each grow their own spelling of it.
 *
 * It also owns the context-pressure reading — parsing DSH's `contextPressure`,
 * its bands, and its alert text. That is a deliberate exception to "formatting
 * only": the chip, the status line and the thresholds are one decision about one
 * number, and splitting them would let the painted level drift from the level
 * compaction acts on.
 *
 * @module dsh-ssh-tui/footer-format
 */

import { t } from './i18n/index.js'
import { activeTheme, themeThresholdToken } from './theme.js'
import {
  commandCodeSourceFor, openCodeSourceFor,
  type QuotaPeriod, type QuotaSource,
} from './quota.js'

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
  return themeThresholdToken(activeTheme(), level === 'danger' ? 'over' : level === 'warn' ? 'warn' : 'ok')
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

/**
 * Compact elapsed time for the activity chip: `28s`, `3m12s`, `1h04m`.
 *
 * Distinct from {@link formatDuration} on purpose: that one is a session
 * statistic (`45.2s`), where a decimal is informative, while this one ticks
 * every second beside a spinner and should move in whole units.
 */
export function formatElapsedShort(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** Compact duration, matching the web stats line (45.2s / 2m42s). */
export function formatDuration(ms: number): string {
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The default row stopped using this when the footer became the status row
 * (`docs/plans/footer-debt.md`, D-7): what is left of it is the previous
 * generation's fitting and formatting, kept exported so 0.8.x does not break an
 * importer. New callers want the budget module's `runtimeStrip`, the meters, or
 * `formatStatusReport` for the spelled-out numbers.
 */
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
/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The default row stopped using this when the footer became the status row
 * (`docs/plans/footer-debt.md`, D-7): what is left of it is the previous
 * generation's fitting and formatting, kept exported so 0.8.x does not break an
 * importer. New callers want the budget module's `runtimeStrip`, the meters, or
 * `formatStatusReport` for the spelled-out numbers.
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
/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The default row stopped using this when the footer became the status row
 * (`docs/plans/footer-debt.md`, D-7): what is left of it is the previous
 * generation's fitting and formatting, kept exported so 0.8.x does not break an
 * importer. New callers want the budget module's `runtimeStrip`, the meters, or
 * `formatStatusReport` for the spelled-out numbers.
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
 * The window tag as an out-of-room row spells it: `5Hr` → `5h`, `1Wk` → `1w`.
 *
 * Deliberately not `toLowerCase()`: the tag encodes two facts in three cells
 * (how many, and which unit), and the unit letter is the one worth keeping —
 * `5hr` costs a cell to repeat that it is hours, which the `h` already said.
 */
export function quotaWindowTagShort(period: QuotaPeriod | undefined): string {
  if (period === 'hourly') return '5h'
  if (period === 'weekly') return '1w'
  if (period === 'monthly') return '1m'
  return ''
}

/**
 * The badge the footer shows instead of the billing plan's own label:
 * `SuperGrok`, `OC·GO` (OpenCode Go), `CC·GOAT` (Command Code Goat).
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
  if (/supergrok/iu.test(plan)) return 'SuperGrok'
  if (/opencode/iu.test(plan)) return 'OC·GO'
  if (/goat/iu.test(plan)) return 'CC·GOAT'
  return plan
}

/**
 * The subscription a session is running on, spelled out for the footer's last
 * part: `OpenCode-GO`, `CommandCode-GOAT`.
 *
 * Only the two generations that carry a *named subscription* get one. SuperGrok
 * already says so in its quota chip's window tag, and DeepSeek is metered (its
 * balance line is the reading), so neither claims a badge here. The spelling is
 * longer than the identity row's old `OC·GO` / `CC·GOAT` on purpose: this one sits
 * at the very end of the row where the least load-bearing part goes, and a reader
 * who still has it on screen reads a plan name rather than an abbreviation.
 *
 * The provider id alone is enough for the Go route; Command Code's *tier* comes
 * from the billing reply, so before the first reading lands the badge names the
 * vendor without claiming a tier it has not seen.
 * @param provider - the live route's provider id.
 * @param snapshot - the quota reading, when it belongs to that provider.
 * @returns the badge, or undefined when this route has none.
 */
export function planRouteBadge(
  provider: string,
  snapshot?: { plan: string; source?: QuotaSource },
): string | undefined {
  const id = provider.trim()
  const source = snapshot?.source
    ?? (id === 'opencode-go' ? 'opencode-go' : id === 'command-code' ? 'command-code' : undefined)
  if (source === 'opencode-go') return 'OpenCode-GO'
  if (source !== 'command-code') return undefined
  const plan = (snapshot?.plan ?? '').trim()
  if (plan === '' || /^command ?code$/iu.test(plan)) {
    // The provider is known and the tier is not: name the vendor, claim nothing.
    return 'CommandCode'
  }
  return `CommandCode-${plan.toUpperCase()}`
}

/**
 * Drop the Go / SuperGrok plan name from a quota identity part, keeping the
 * remaining-percent bar. Returns true when a part was rewritten.
 */
/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The default row stopped using this when the footer became the status row
 * (`docs/plans/footer-debt.md`, D-7): what is left of it is the previous
 * generation's fitting and formatting, kept exported so 0.8.x does not break an
 * importer. New callers want the budget module's `runtimeStrip`, the meters, or
 * `formatStatusReport` for the spelled-out numbers.
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
