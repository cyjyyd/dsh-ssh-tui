/**
 * `/context` model and formatting.
 *
 * The input is one projection-cache checkpoint (or a fail-closed reason) plus the
 * current route and log head. Everything below is pure: no Session, service,
 * filesystem, or network access. That is deliberate — the safety property of the
 * command is that the only read happens in `context-cache.ts`, and everything a
 * test or a repaint touches afterwards is a value.
 *
 * Three rules drive the presentation:
 *   - occupancy is `projectedTokens ?? pressureTokens` and needs a positive
 *     `contextWindow`; missing data is UNKNOWN, never zero;
 *   - a checkpoint that lags the log head, or whose recorded route differs from
 *     the current route, is STALE; a thousand rows of green are not worth one
 *     false "exact";
 *   - the three composition estimates are independent heuristics. They are shown
 *     with `~`, never added to occupancy, and never summed into it.
 *
 * @module dsh-ssh-tui/context-view
 */

import { formatTokens } from './footer-format.js'
import { t } from './i18n/index.js'
import { truncateToWidth } from './term-text.js'
import type { ContextCacheRead, ContextCacheUnavailableReason } from './context-cache.js'

/** A provider/model pair as the shell of the current route. */
export interface ContextRoute {
  provider: string
  model: string
}

/** How trustworthy the checkpoint is relative to this session. */
export type ContextFreshness = 'CACHED' | 'STALE' | 'UNKNOWN'

/** Why a checkpoint is STALE. */
export type ContextStaleReason = 'LAG' | 'ROUTE'

/** Overview page data; missing fields stay missing rather than becoming zero. */
export interface ContextOverview {
  available: boolean
  usedTokens?: number
  usedSource?: 'projected' | 'pressure'
  contextWindow?: number
  percent?: number
  overflow: boolean
  asOfSeq?: number
  headSeq?: number
  lagEvents?: number
  freshness: ContextFreshness
  staleReasons: ContextStaleReason[]
  cachedRoute?: ContextRoute
  currentRoute?: ContextRoute
  routeVerified: boolean
  routeMatches?: boolean
}

/** The three heuristic buckets, with `tokens` missing when the cache omitted it. */
export interface ContextComposition {
  available: boolean
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
  /**
   * Sum of the three estimates, for the relative bar only. It is explicitly not
   * an occupancy value and is never printed as one.
   */
  relativeTotal?: number
}

/** Cumulative provider billing, which is not context occupancy. */
export interface ContextBilling {
  available: boolean
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

/** One normalized `/context` report. */
export interface ContextReport {
  cache: 'AVAILABLE' | 'UNAVAILABLE'
  unavailableReason?: ContextCacheUnavailableReason
  asOfSeq?: number
  headSeq?: number
  overview: ContextOverview
  composition: ContextComposition
  billing: ContextBilling
}

/** Inputs the formatter cannot derive from the checkpoint alone. */
export interface ContextBuildOptions {
  /** Current session log head, when the caller can read it cheaply. */
  headSeq?: number
  /** The route the next request would use. */
  currentRoute?: ContextRoute
}

/** One formatted page. */
export interface ContextFormatted {
  lines: string[]
  copyText: string
}

/** Which in-Screen page is shown. */
export type ContextPage = 1 | 2 | 3

/** Width tiers: full (80-ish), compact (40-ish), narrow (20-ish). */
export type ContextTier = 'full' | 'compact' | 'narrow'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined
}

function token(value: unknown, positive = false): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return undefined
  if (value < 0 || (positive && value === 0)) return undefined
  return value
}

function routeOf(value: unknown): ContextRoute | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

function cachedRouteOf(values: Readonly<Record<string, unknown>>): ContextRoute | undefined {
  const selection = asRecord(values.modelSelection)
  if (selection === undefined) return undefined
  return routeOf(selection.next) ?? routeOf(selection.lastUsed)
}

function sameRoute(left: ContextRoute | undefined, right: ContextRoute | undefined): boolean | undefined {
  if (left === undefined || right === undefined) return undefined
  return left.provider === right.provider && left.model === right.model
}

function statusText(overview: ContextOverview, translate: typeof t, short = false): string {
  if (overview.freshness === 'UNKNOWN') return translate('context.status.unknown')
  if (overview.freshness === 'CACHED') return translate('context.status.cached')
  if (short) return translate('context.status.stale')
  const reasons = overview.staleReasons.map(reason => {
    if (reason === 'ROUTE') return translate('context.stale.route')
    return overview.lagEvents === undefined
      ? translate('context.stale.unverified')
      : translate('context.stale.lag', { count: overview.lagEvents })
  })
  if (reasons.length === 0) return translate('context.status.stale')
  return `${translate('context.status.stale')} (${reasons.join(', ')})`
}

function percentText(percent: number): string {
  const rounded = Math.round(percent * 10) / 10
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`
}

function tierOf(width: number): ContextTier {
  if (width >= 60) return 'full'
  if (width >= 30) return 'compact'
  return 'narrow'
}

function fit(lines: readonly string[], width: number): string[] {
  return lines.map(line => truncateToWidth(line, width))
}

/**
 * Normalize a cache read into the display model.
 *
 * This function never invents a value: an absent or invalid field stays
 * `undefined`, and the formatter turns that into UNKNOWN.
 * @param read - the single cache read.
 * @param options - current route and log head.
 * @returns a pure report model.
 */
export function buildContextReport(read: ContextCacheRead, options: ContextBuildOptions = {}): ContextReport {
  const headSeq = Number.isSafeInteger(options.headSeq) && (options.headSeq ?? -1) >= 0
    ? options.headSeq
    : undefined
  if (read.status === 'unavailable') {
    return {
      cache: 'UNAVAILABLE',
      unavailableReason: read.reason,
      ...(headSeq === undefined ? {} : { headSeq }),
      overview: {
        available: false,
        freshness: 'UNKNOWN',
        staleReasons: [],
        overflow: false,
        routeVerified: false,
        ...(options.currentRoute === undefined ? {} : { currentRoute: options.currentRoute }),
      },
      composition: { available: false },
      billing: { available: false },
    }
  }
  const values = read.values
  const pressure = asRecord(values.contextPressure)
  const projected = token(pressure?.projectedTokens)
  const sampled = token(pressure?.pressureTokens)
  const window = token(pressure?.contextWindow, true)
  const usedTokens = projected ?? sampled
  const usedSource = projected !== undefined ? 'projected' as const : sampled !== undefined ? 'pressure' as const : undefined
  const percent = usedTokens !== undefined && window !== undefined
    ? (usedTokens / window) * 100
    : undefined
  const cachedRoute = cachedRouteOf(values)
  const routeMatches = sameRoute(cachedRoute, options.currentRoute)
  const staleReasons: ContextStaleReason[] = []
  if (usedTokens !== undefined) {
    if (headSeq === undefined || read.asOfSeq < headSeq) staleReasons.push('LAG')
    if (routeMatches === false) staleReasons.push('ROUTE')
  }
  const freshness: ContextFreshness = usedTokens === undefined
    ? 'UNKNOWN'
    : staleReasons.length > 0 ? 'STALE' : 'CACHED'
  const overview: ContextOverview = {
    available: usedTokens !== undefined,
    ...(usedTokens === undefined ? {} : { usedTokens }),
    ...(usedSource === undefined ? {} : { usedSource }),
    ...(window === undefined ? {} : { contextWindow: window }),
    ...(percent === undefined ? {} : { percent }),
    overflow: percent !== undefined && percent > 100,
    asOfSeq: read.asOfSeq,
    ...(headSeq === undefined ? {} : { headSeq }),
    ...(headSeq !== undefined && read.asOfSeq < headSeq ? { lagEvents: headSeq - read.asOfSeq } : {}),
    freshness,
    staleReasons,
    ...(cachedRoute === undefined ? {} : { cachedRoute }),
    ...(options.currentRoute === undefined ? {} : { currentRoute: options.currentRoute }),
    routeVerified: routeMatches !== undefined,
    ...(routeMatches === undefined ? {} : { routeMatches }),
  }

  const breakdown = asRecord(values.contextBreakdown)
  const systemTokens = token(breakdown?.systemTokens)
  const toolsTokens = token(breakdown?.toolsTokens)
  const messageTokens = token(breakdown?.messageTokens)
  const compositionAvailable = systemTokens !== undefined && toolsTokens !== undefined && messageTokens !== undefined
  const composition: ContextComposition = {
    available: compositionAvailable,
    ...(systemTokens === undefined ? {} : { systemTokens }),
    ...(toolsTokens === undefined ? {} : { toolsTokens }),
    ...(messageTokens === undefined ? {} : { messageTokens }),
    ...(compositionAvailable ? { relativeTotal: systemTokens + toolsTokens + messageTokens } : {}),
  }

  const usage = asRecord(values.tokenUsage)
  const totals = asRecord(usage?.totals) ?? usage
  const uncachedInputTokens = token(totals?.uncachedInputTokens)
  const outputTokens = token(totals?.outputTokens)
  const cacheReadTokens = token(totals?.cacheReadTokens)
  const cacheWriteTokens = token(totals?.cacheWriteTokens)
  const billing: ContextBilling = {
    available: uncachedInputTokens !== undefined && outputTokens !== undefined,
    ...(uncachedInputTokens === undefined ? {} : { uncachedInputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
  }

  return {
    cache: 'AVAILABLE',
    asOfSeq: read.asOfSeq,
    ...(headSeq === undefined ? {} : { headSeq }),
    overview,
    composition,
    billing,
  }
}

function progressBar(percent: number, width: number, ascii: boolean): string {
  const cells = Math.max(1, Math.floor(width))
  const clamped = Math.max(0, Math.min(100, percent))
  const filled = Math.min(cells, Math.max(0, Math.round((clamped / 100) * cells)))
  const full = ascii ? '#' : '█'
  const empty = ascii ? '.' : '░'
  return `[${full.repeat(filled)}${empty.repeat(cells - filled)}]`
}

function barWidth(tier: ContextTier, width: number): number {
  if (tier === 'full') return Math.min(36, Math.max(10, width - 14))
  if (tier === 'compact') return Math.min(16, Math.max(6, width - 12))
  return 0
}

function compositionBar(composition: ContextComposition, width: number): string {
  const system = composition.systemTokens ?? 0
  const tools = composition.toolsTokens ?? 0
  const messages = composition.messageTokens ?? 0
  const total = system + tools + messages
  if (total <= 0 || width <= 0) return ''
  const s = Math.floor((system / total) * width)
  const t = Math.floor((tools / total) * width)
  const m = Math.max(0, width - s - t)
  return `[${'S'.repeat(s)}${'T'.repeat(t)}${'M'.repeat(m)}]`
}

function overviewHeader(page: number, translate: typeof t): { full: string; compact: string; narrow: string } {
  return {
    full: `${translate('context.pageLabel', { page })} · ${translate('context.page.overview')} · ${translate('context.readOnly')}`,
    compact: translate('context.compactTitle', { page, name: translate('context.page.overview') }),
    narrow: translate('context.narrowTitle', { page }),
  }
}

function overviewLines(
  report: ContextReport,
  tier: ContextTier,
  width: number,
  expanded: boolean,
  ascii: boolean,
  translate: typeof t,
): string[] {
  const overview = report.overview
  const lines: string[] = []
  const header = overviewHeader(1, translate)
  lines.push(tier === 'narrow' ? header.narrow : tier === 'compact' ? header.compact : header.full)
  if (report.cache === 'UNAVAILABLE') {
    const reason = report.unavailableReason === undefined
      ? translate('context.status.unknown')
      : translate(`context.reason.${report.unavailableReason}`)
    lines.push(translate('context.readFailed', { reason }))
  }
  const route = overview.currentRoute
  if (tier !== 'narrow') {
    lines.push(route === undefined
      ? translate('context.routeUnknown')
      : translate('context.route', { provider: route.provider, model: route.model }))
  }
  if (overview.percent === undefined || overview.usedTokens === undefined || overview.contextWindow === undefined) {
    lines.push(translate('context.occupancyUnknown'))
  } else if (tier === 'narrow') {
    lines.push(translate('context.narrowOccupancy', {
      percent: percentText(overview.percent),
      used: formatTokens(overview.usedTokens),
      window: formatTokens(overview.contextWindow),
    }))
  } else if (tier === 'compact') {
    lines.push(translate('context.occupancyCompact', {
      used: formatTokens(overview.usedTokens),
      window: formatTokens(overview.contextWindow),
      percent: percentText(overview.percent),
    }))
  } else {
    lines.push(translate('context.occupancy', {
      used: formatTokens(overview.usedTokens),
      window: formatTokens(overview.contextWindow),
      percent: percentText(overview.percent),
    }))
  }
  const cells = barWidth(tier, width)
  if (cells > 0 && overview.percent !== undefined) {
    lines.push(`${progressBar(overview.percent, cells, ascii)} ${percentText(overview.percent)}`)
    if (overview.overflow) {
      lines.push(tier === 'compact' ? translate('context.overflowShort') : translate('context.overflow'))
    }
  }
  if (overview.asOfSeq !== undefined) {
    const status = statusText(overview, translate, tier === 'narrow')
    lines.push(tier === 'narrow'
      ? translate('context.narrowAsOf', { asOf: overview.asOfSeq, status })
      : overview.headSeq === undefined
        ? translate('context.asOfNoHead', { asOf: overview.asOfSeq, status })
        : translate('context.asOf', { asOf: overview.asOfSeq, head: overview.headSeq, status }))
  } else {
    lines.push(statusText(overview, translate, tier === 'narrow'))
  }
  if (tier !== 'narrow' && overview.freshness === 'CACHED' && !overview.routeVerified) {
    lines.push(translate('context.routeUnverified'))
  }
  if (tier === 'full') {
    lines.push(translate('context.billing.title'))
    if (report.billing.available) {
      lines.push(translate('context.billing.line', {
        input: report.billing.uncachedInputTokens === undefined ? translate('context.status.unknown') : formatTokens(report.billing.uncachedInputTokens),
        output: report.billing.outputTokens === undefined ? translate('context.status.unknown') : formatTokens(report.billing.outputTokens),
        read: report.billing.cacheReadTokens === undefined ? translate('context.status.unknown') : formatTokens(report.billing.cacheReadTokens),
        write: report.billing.cacheWriteTokens === undefined ? translate('context.status.unknown') : formatTokens(report.billing.cacheWriteTokens),
      }))
    } else {
      lines.push(translate('context.billing.unknown'))
    }
  } else if (tier === 'compact') {
    lines.push(translate('context.billing.title'))
    lines.push(report.billing.available
      ? translate('context.billing.short', {
        input: report.billing.uncachedInputTokens === undefined ? translate('context.status.unknown') : formatTokens(report.billing.uncachedInputTokens),
        output: report.billing.outputTokens === undefined ? translate('context.status.unknown') : formatTokens(report.billing.outputTokens),
      })
      : translate('context.billing.unknown'))
  } else if (report.billing.available) {
    lines.push(translate('context.narrowBilling', {
      input: formatTokens(report.billing.uncachedInputTokens ?? 0),
      output: formatTokens(report.billing.outputTokens ?? 0),
    }))
  }
  if (tier === 'full') lines.push(translate('context.estimateNote'))
  if (expanded) {
    lines.push('')
    lines.push(...(tier === 'narrow'
      ? [translate('context.status.stale'), translate('context.narrowAsOf', {
        asOf: overview.asOfSeq ?? 0,
        status: statusText(overview, translate),
      })]
      : [translate('context.detail.overview'), translate('context.detail.overviewData')]))
  }
  return lines
}

function compositionLines(
  report: ContextReport,
  tier: ContextTier,
  width: number,
  expanded: boolean,
  translate: typeof t,
): string[] {
  const composition = report.composition
  const lines: string[] = []
  const title = tier === 'narrow'
    ? translate('context.narrowTitle', { page: 2 })
    : tier === 'compact'
      ? translate('context.composition.shortTitle')
      : translate('context.composition.title')
  lines.push(title)
  if (!composition.available) {
    lines.push(translate('context.composition.unknown'))
    if (expanded && tier !== 'narrow') lines.push(translate('context.detail.composition'))
    return lines
  }
  const system = composition.systemTokens ?? 0
  const tools = composition.toolsTokens ?? 0
  const messages = composition.messageTokens ?? 0
  if (tier === 'narrow') {
    lines.push(translate('context.composition.narrowSystem', { tokens: formatTokens(system) }))
    lines.push(translate('context.composition.narrowTools', { tokens: formatTokens(tools) }))
    lines.push(translate('context.composition.narrowMessages', { tokens: formatTokens(messages) }))
    lines.push(translate('context.composition.noteShort'))
  } else {
    const short = tier === 'compact'
    lines.push(translate(short ? 'context.composition.shortSystem' : 'context.composition.system', { tokens: formatTokens(system) }))
    lines.push(translate(short ? 'context.composition.shortTools' : 'context.composition.tools', { tokens: formatTokens(tools) }))
    lines.push(translate(short ? 'context.composition.shortMessages' : 'context.composition.messages', { tokens: formatTokens(messages) }))
    const cells = tier === 'full' ? Math.min(32, Math.max(8, width - 12)) : Math.min(16, Math.max(6, width - 12))
    const bar = compositionBar(composition, cells)
    if (bar !== '') lines.push(`${bar} ${translate('context.composition.relative')}`)
    lines.push(translate('context.composition.note'))
  }
  if (expanded) {
    lines.push('')
    lines.push(translate('context.detail.composition'))
  }
  return lines
}

function structureLines(tier: ContextTier, expanded: boolean, translate: typeof t): string[] {
  const lines: string[] = []
  lines.push(tier === 'narrow'
    ? translate('context.narrowTitle', { page: 3 })
    : `${translate('context.pageLabel', { page: 3 })} · ${translate('context.page.structure')}`)
  lines.push(translate('context.structure.unavailable'))
  lines.push(tier === 'full' ? translate('context.structure.why') : translate('context.structure.whyShort'))
  if (expanded && tier === 'full') lines.push(translate('context.detail.page3'))
  return lines
}

/**
 * Render one page for a body width (the width inside the Screen's two-cell
 * margin).
 * @param report - normalized report.
 * @param options - page, inner width and expanded state.
 * @param translate - translator, injectable for tests.
 * @returns bounded, ANSI-free lines and the matching copy text.
 */
export function formatContextReport(
  report: ContextReport,
  options: { page: ContextPage; width: number; expanded?: boolean; ascii?: boolean },
  translate: typeof t = t,
): ContextFormatted {
  const width = Math.max(8, Math.floor(options.width))
  const tier = tierOf(width)
  const expanded = options.expanded === true
  const lines = options.page === 1
    ? overviewLines(report, tier, width, expanded, options.ascii === true, translate)
    : options.page === 2
      ? compositionLines(report, tier, width, expanded, translate)
      : structureLines(tier, expanded, translate)
  const fitted = fit(lines, width)
  return { lines: fitted, copyText: fitted.join('\n') }
}

/**
 * The line-mode text report: all three pages in one copyable block.
 *
 * Line mode has no Screen and no paging keys, so the text path has to carry the
 * whole answer. It is ASCII-barred on purpose (`#`/`.`) for any link that cannot
 * render block glyphs.
 * @param report - normalized report.
 * @param translate - translator, injectable for tests.
 * @returns plain text lines.
 */
export function formatContextTextReport(report: ContextReport, translate: typeof t = t): string[] {
  const lines: string[] = []
  for (const page of [1, 2, 3] as const) {
    if (page > 1) lines.push('')
    lines.push(...formatContextReport(report, { page, width: 80, expanded: true, ascii: true }, translate).lines)
  }
  return lines
}
