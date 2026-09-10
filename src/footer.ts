/**
 * Footer stats, status identity, context-pressure chips, and `/status` report.
 */

import { t } from './i18n/index.js'
import { displayWidth, truncateToWidth } from './term-text.js'
import { describeSubagentFit } from './subagent-model.js'
import { formatQuotaStatusLine, type QuotaSnapshot } from './quota.js'
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

export function fitFooterStatsLine(chip: string, groups: readonly string[], width: number): string {
  const kept = [...groups]
  const render = (): string => kept.length === 0 ? chip : `${chip} │ ${kept.join(' │ ')}`
  while (kept.length > 0 && displayWidth(render()) > width) kept.pop()
  return truncateToWidth(render(), Math.max(1, width))
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
  subDiffers: boolean
  quotaCode?: string
  quotaPercent?: number
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
  if (input.retry !== undefined) {
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

export function footerIdentityParts(input: FooterStatusInput): string[] {
  const parts: string[] = []
  if (input.compactView === true) parts.push(`[${t('view.footerCompact')}]`)
  if (input.preset !== undefined && input.preset !== '') parts.push(`[${input.preset}]`)
  if (input.cwdLabel !== undefined && input.cwdLabel !== '') parts.push(input.cwdLabel)
  const model = input.effort === undefined ? input.model : `${input.model} ${input.effort}`
  if (model !== '') parts.push(model)
  if (input.subDiffers) parts.push(`sub:${input.subModel}`)
  if (input.balanceText !== undefined && input.balanceText !== '') {
    parts.push(input.balanceText)
  }
  if (input.quotaPercent !== undefined) {
    parts.push(formatFooterQuota(input.quotaPercent, input.quotaCode))
  }
  if (input.contextChip !== undefined && input.contextChip !== '') parts.push(input.contextChip)
  if (input.search !== undefined) parts.push(t('footer.search', { index: input.search.index + 1, total: input.search.total }))
  if (input.foldedInput) parts.push(t('footer.inputFolded'))
  else if (input.multiLineInput) parts.push(t('footer.multiLine'))
  if (input.queued > 0) parts.push(t('footer.queued', { count: input.queued }))
  return parts
}

/** `SuperGrok ███████░ 82%`, or just the bar + percent when `code` is omitted. */
export function formatFooterQuota(percent: number, code?: string): string {
  const bar = `${formatQuotaBar(percent)} ${percent.toFixed(0)}%`
  return code !== undefined && code.trim() !== '' ? `${code.trim()} ${bar}` : bar
}

/**
 * Drop the Go / SuperGrok plan name from a quota identity part, keeping the
 * remaining-percent bar. Returns true when a part was rewritten.
 */
export function dropFooterQuotaPlanName(parts: string[]): boolean {
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]
    if (part === undefined) continue
    const barAt = part.search(/ [█░]+ \d+%$/)
    if (barAt <= 0) continue
    parts[index] = part.slice(barAt + 1)
    return true
  }
  return false
}

export function fitFooterStatusLine(activity: string, identity: readonly string[], width: number): string {
  const kept = [...identity]
  const render = (): string => kept.length === 0 ? activity : `${activity}  ${kept.join(' · ')}`
  if (displayWidth(render()) > width) dropFooterQuotaPlanName(kept)
  while (kept.length > 0 && displayWidth(render()) > width) kept.pop()
  return truncateToWidth(render(), Math.max(1, width))
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
