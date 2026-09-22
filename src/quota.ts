/**
 * OpenCode / SuperGrok / DeepSeek quota and prepaid-balance parsers.
 */

import { t } from './i18n/index.js'

/** A recognized OpenCode provider route, used by /usage and /quota. */
export type OpenCodeFlavor = 'zen' | 'go'

export interface OpenCodeSource {
  provider: string
  flavor: OpenCodeFlavor
  label: string
  apiKeyEnv: string
  baseURL?: string
}

export interface LlmPiAiProviderProfile {
  displayName?: unknown
  apiKeyEnv?: unknown
  baseURL?: unknown
  api?: unknown
  models?: unknown
  reasoning?: unknown
}

export interface LlmPiAiSection {
  providers?: Record<string, LlmPiAiProviderProfile>
}

/** Build per-model reasoningEfforts from a provider-level reasoning default. */
export function reasoningEffortsForDefault(reasoning: unknown): Record<string, string | null> | undefined {
  if (typeof reasoning !== 'string') return undefined
  const level = reasoning.trim()
  if (level === '' || level === 'off') return undefined
  return { off: null, [level]: level }
}

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage'
export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'
export const SUPERGROK_BILLING_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits'
export const DEEPSEEK_PUBLIC_BASE_URL = 'https://api.deepseek.com'
/**
 * Command Code's billing surface sits on the API root, not under the
 * `/provider/v1` route its chat requests use, so these are fixed: a configured
 * base URL only decides whether the canonical host is the right one to ask.
 */
export const COMMAND_CODE_BASE_URL = 'https://api.commandcode.ai'
export const COMMAND_CODE_CREDITS_URL = `${COMMAND_CODE_BASE_URL}/alpha/billing/credits`
export const COMMAND_CODE_SUBSCRIPTIONS_URL = `${COMMAND_CODE_BASE_URL}/alpha/billing/subscriptions`
export const COMMAND_CODE_USAGE_URL = `${COMMAND_CODE_BASE_URL}/alpha/usage/summary`
/** OpenAI-completions gateways: probe these relative to the configured base URL. */
export const OPENAI_COMPAT_BALANCE_PATHS = [
  '/user/balance',
  '/dashboard/billing/credit_grants',
  '/v1/dashboard/billing/credit_grants',
  '/v1/dashboard/billing/subscription',
] as const
const QUOTA_ALERT_THRESHOLDS = [50, 25, 10, 5] as const
/** Remaining % at or below this is “close” and uses the faster cadence. */
const QUOTA_NEAR_THRESHOLD_PERCENT = 55

/**
 * Classify the currently selected provider as an OpenCode route. Built-in
 * `opencode`/`opencode-go` ids are recognized directly, and custom llm-pi-ai
 * routes are recognized by their `opencode.ai` base URL.
 */
export function openCodeSourceFor(provider: string, llmPiAiSection: unknown): OpenCodeSource | null {
  const section = llmPiAiSection as LlmPiAiSection | null | undefined
  const profile = section?.providers?.[provider]
  const baseURL = typeof profile?.baseURL === 'string' ? profile.baseURL : undefined
  const lowerBase = baseURL?.toLowerCase() ?? ''
  const isGo = provider === 'opencode-go' || lowerBase.includes('opencode.ai/zen/go')
  const isZen = provider === 'opencode' || (lowerBase.includes('opencode.ai/zen') && !isGo)
  if (!isGo && !isZen) return null

  const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== ''
    ? profile.apiKeyEnv
    : provider === 'opencode'
      ? 'OPENCODE_API_KEY'
      : provider === 'opencode-go'
        ? 'OPENCODE_GO_API_KEY'
        : `${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`
  const label = typeof profile?.displayName === 'string' && profile.displayName.trim() !== ''
    ? profile.displayName
    : isGo ? 'OpenCode Go' : 'OpenCode Zen'

  return {
    provider,
    flavor: isGo ? 'go' : 'zen',
    label,
    apiKeyEnv,
    ...(baseURL === undefined ? {} : { baseURL }),
  }
}

/** A recognized Command Code route, used by the quota poller. */
export interface CommandCodeSource {
  provider: string
  apiKeyEnv: string
  label: string
}

const COMMAND_CODE_PROVIDER_IDS: ReadonlySet<string> = new Set(['command-code', 'commandcode'])
const COMMAND_CODE_CANONICAL_BASES: ReadonlySet<string> = new Set([
  COMMAND_CODE_BASE_URL,
  `${COMMAND_CODE_BASE_URL}/provider/v1`,
])

/**
 * Classify one route as Command Code's quota surface.
 *
 * Recognized by provider id or by a canonical base URL. The billing requests
 * always target the canonical host, so a lookalike base URL never receives the
 * credential even when the route keeps Command Code's provider id.
 * @param provider - the selected provider route.
 * @param llmPiAiSection - the `llm-pi-ai` settings section, if readable.
 * @returns the credential reference to use, or `null` for another provider.
 */
export function commandCodeSourceFor(provider: string, llmPiAiSection: unknown): CommandCodeSource | null {
  const section = llmPiAiSection as LlmPiAiSection | null | undefined
  const profile = section?.providers?.[provider]
  const rawBase = typeof profile?.baseURL === 'string' ? profile.baseURL.replace(/\/+$/u, '') : ''
  if (!COMMAND_CODE_PROVIDER_IDS.has(provider) && !COMMAND_CODE_CANONICAL_BASES.has(rawBase.toLowerCase())) {
    return null
  }
  const apiKeyEnv = typeof profile?.apiKeyEnv === 'string' && profile.apiKeyEnv.trim() !== ''
    ? profile.apiKeyEnv.trim()
    : 'COMMAND_CODE_API_KEY'
  const label = typeof profile?.displayName === 'string' && profile.displayName.trim() !== ''
    ? profile.displayName.trim()
    : 'Command Code'
  return { provider, apiKeyEnv, label }
}

interface OpenCodeGoUsageWindow {
  status?: string
  percent?: number
  resetsAt?: string
}

interface OpenCodeGoUsagePayload {
  usage?: {
    rolling?: OpenCodeGoUsageWindow
    weekly?: OpenCodeGoUsageWindow
    monthly?: OpenCodeGoUsageWindow
  }
}

function openCodeGoUsageWindow(value: unknown): OpenCodeGoUsageWindow | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  return {
    ...(typeof raw.status === 'string' ? { status: raw.status } : {}),
    ...(typeof raw.percent === 'number' && Number.isFinite(raw.percent) ? { percent: raw.percent } : {}),
    ...(typeof raw.resetsAt === 'string' ? { resetsAt: raw.resetsAt } : {}),
  }
}

/** A days/hours/minutes/seconds relative duration for quota reset times. */
function formatRelativeDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60)}m`
  }
  return `${Math.floor(seconds / 86400)}d${Math.floor(seconds % 86400 / 3600)}h`
}

/** One compact `████░░ 40.0% · 正常 · 约 2m 后重置` line for a Go limit. */
function formatOpenCodeGoWindow(label: string, value: unknown): string {
  const window = openCodeGoUsageWindow(value)
  const percent = window?.percent === undefined
    ? null
    : Math.max(0, Math.min(100, window.percent))
  const state = window?.status === 'rate-limited'
    ? t('quota.throttled')
    : window?.status === 'ok'
      ? t('quota.ok')
      : window?.status ?? t('quota.unknown')
  const parts: string[] = [label]
  if (percent !== null) {
    const barWidth = 16
    const filled = Math.round(percent / 100 * barWidth)
    parts.push(`${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)} ${percent.toFixed(1)}%`)
  }
  parts.push(state)
  if (window?.resetsAt !== undefined) {
    const reset = new Date(window.resetsAt)
    if (!Number.isNaN(reset.getTime())) {
      const until = reset.getTime() - Date.now()
      parts.push(until > 0
        ? t('quota.resetInFull', { duration: formatRelativeDuration(until), when: reset.toLocaleString() })
        : t('quota.resetAt', { when: reset.toLocaleString() }))
    }
  }
  return `  ${parts.join(' · ')}`
}

export type QuotaPeriod = 'hourly' | 'weekly' | 'monthly' | 'unknown'

/**
 * Which billing surface a snapshot came from. The footer shows a short plan
 * badge (`SuperGrok` / `OC·GO` / `CC·GOAT` / `A2`), and the provider string
 * alone is not enough to tell them apart.
 */
export type QuotaSource = 'supergrok' | 'opencode-go' | 'command-code' | 'aiclient2api'

export interface QuotaWindow {
  label: string
  period: QuotaPeriod
  /** Remaining percent of the window (100 = unused). */
  remainingPercent: number
  resetsAt?: string
  /** Extra human-readable fact beside the percent, e.g. remaining USD credits. */
  detail?: string
}

export interface QuotaSnapshot {
  provider: string
  plan: string
  /** Billing surface, for the footer's short badge. Absent on hand-built snapshots. */
  source?: QuotaSource
  windows: QuotaWindow[]
}

export function remainingPercentFromUsed(usedPercent: number): number {
  if (!Number.isFinite(usedPercent)) return 100
  return Math.max(0, Math.min(100, Math.round((100 - usedPercent) * 10) / 10))
}

/** Cross a remaining-percent threshold from above (50 / 25 / 10 / 5).
 *  Only the tightest (lowest) crossed threshold is returned, so one drop
 *  never paints 50/25/10 as three identical warnings. */
export function crossedQuotaThresholds(previousRemaining: number | undefined, remaining: number): number[] {
  const crossed = QUOTA_ALERT_THRESHOLDS.filter(threshold =>
    remaining <= threshold && (previousRemaining === undefined || previousRemaining > threshold))
  if (crossed.length === 0) return []
  return [crossed[crossed.length - 1] as number]
}

export function quotaAlertText(snapshot: QuotaSnapshot, window: QuotaWindow): string {
  const reset = window.resetsAt === undefined ? '' : `（${formatQuotaReset(window.resetsAt)}）`
  return t('quota.alert', {
    plan: snapshot.plan,
    period: quotaPeriodLabel(window.period),
    percent: window.remainingPercent.toFixed(0),
    reset,
  })
}

/**
 * How often to re-fetch quota or prepaid balance, counted in model steps.
 * Default is every 10 steps. Near a remaining-percent threshold, hourly
 * windows refresh every 4 steps.
 */
export function quotaRefreshEverySteps(window: QuotaWindow | undefined): number {
  if (window === undefined) return 10
  const near = window.remainingPercent <= QUOTA_NEAR_THRESHOLD_PERCENT
  if (window.period === 'hourly' && near) return 4
  return 10
}

/** @deprecated Same cadence as {@link quotaRefreshEverySteps}; the name predates step accounting. */
export const quotaRefreshEveryTurns = quotaRefreshEverySteps

function quotaPeriodLabel(period: QuotaPeriod): string {
  if (period === 'hourly') return t('quota.periodHourly')
  if (period === 'weekly') return t('quota.periodWeekly')
  if (period === 'monthly') return t('quota.periodMonthly')
  return t('quota.periodUnknown')
}

function formatQuotaReset(iso: string): string {
  const reset = new Date(iso)
  if (Number.isNaN(reset.getTime())) return iso
  const until = reset.getTime() - Date.now()
  return until > 0
    ? t('quota.resetIn', { duration: formatRelativeDuration(until) })
    : t('quota.resetAt', { when: reset.toLocaleString() })
}

export function parseSuperGrokBilling(payload: unknown): QuotaSnapshot {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(t('quota.supergrokUnrecognized'))
  }
  const root = payload as Record<string, unknown>
  const cfg = root.config
  if (cfg === null || typeof cfg !== 'object') {
    throw new Error(t('quota.supergrokUnrecognized'))
  }
  const config = cfg as Record<string, unknown>
  const usedRaw = config.creditUsagePercent ?? config.credit_usage_percent
  const used = typeof usedRaw === 'number' && Number.isFinite(usedRaw) ? usedRaw : 0
  const periodRaw = config.currentPeriod ?? config.current_period
  const periodObj = periodRaw !== null && typeof periodRaw === 'object' ? periodRaw as Record<string, unknown> : undefined
  const type = typeof periodObj?.type === 'string' ? periodObj.type : ''
  const period: QuotaPeriod = type.includes('WEEKLY') ? 'weekly' : type.includes('MONTHLY') ? 'monthly' : 'unknown'
  const end = typeof periodObj?.end === 'string'
    ? periodObj.end
    : typeof config.billingPeriodEnd === 'string'
      ? config.billingPeriodEnd
      : typeof config.billing_period_end === 'string'
        ? config.billing_period_end
        : undefined
  const plan = typeof root.subscription_tier === 'string' && root.subscription_tier.trim() !== ''
    ? root.subscription_tier.trim()
    : typeof root.subscriptionTier === 'string' && root.subscriptionTier.trim() !== ''
      ? root.subscriptionTier.trim()
      : 'SuperGrok'
  return {
    provider: 'xai',
    plan,
    source: 'supergrok',
    windows: [{
      label: period === 'monthly' ? t('quota.windowMonthly') : t('quota.windowWeekly'),
      period: period === 'unknown' ? 'weekly' : period,
      remainingPercent: remainingPercentFromUsed(used),
      ...(end === undefined ? {} : { resetsAt: end }),
    }],
  }
}

export function parseOpenCodeGoQuota(payload: unknown, provider: string): QuotaSnapshot {
  const raw = payload as OpenCodeGoUsagePayload | null | undefined
  const usage = raw?.usage
  if (usage === null || usage === undefined) throw new Error(t('quota.unrecognized'))
  const windows: QuotaWindow[] = []
  const push = (label: string, period: QuotaPeriod, value: unknown): void => {
    const window = openCodeGoUsageWindow(value)
    if (window?.percent === undefined) return
    windows.push({
      label,
      period,
      remainingPercent: remainingPercentFromUsed(window.percent),
      ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
    })
  }
  push(t('quota.windowHourly'), 'hourly', usage.rolling)
  push(t('quota.windowWeekly'), 'weekly', usage.weekly)
  push(t('quota.windowMonthly'), 'monthly', usage.monthly)
  if (windows.length === 0) throw new Error(t('quota.unrecognized'))
  return { provider, plan: 'OpenCode Go', source: 'opencode-go', windows }
}

/** One Command Code rolling window: `{ cap, used, resetAt }` off /alpha/billing/credits. */
function commandCodeRollingWindow(value: unknown): { remainingPercent: number; resetsAt?: string } | undefined {
  const row = recordOf(value)
  const cap = commandCodeNumber(row?.cap)
  const used = commandCodeNumber(row?.used)
  if (cap === undefined || used === undefined || cap <= 0 || used < 0) return undefined
  const resetsAt = commandCodeIso(row?.resetAt)
  return {
    remainingPercent: remainingPercentFromUsed(used / cap * 100),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

/** A finite number field, or `undefined`. */
function commandCodeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Command Code reports reset times as epoch milliseconds; QuotaWindow carries ISO strings. */
function commandCodeIso(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** Prefer the nested `data` shell when the outer object is only an envelope. */
function commandCodeBody(value: unknown): Record<string, unknown> | undefined {
  const root = recordOf(value)
  return recordOf(root?.data) ?? root
}

/** Sum the remaining credit pools Command Code reports, or undefined when none is numeric. */
function commandCodeRemainingCredits(pools: Record<string, unknown> | undefined): number | undefined {
  const values = [pools?.monthlyCredits, pools?.purchasedCredits, pools?.freeCredits]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  if (values.length === 0) return undefined
  return values.reduce((sum, value) => sum + Math.max(0, value), 0)
}

/** Period spend in USD credits from `/alpha/usage/summary`. */
function commandCodePeriodSpend(summary: unknown): number | undefined {
  const body = commandCodeBody(summary)
  for (const key of ['totalCost', 'totalMonthlyCredits', 'totalCredits'] as const) {
    const value = commandCodeNumber(body?.[key])
    if (value !== undefined && value >= 0) return value
  }
  return undefined
}

/** The billing-period start used to scope the spend query, when reported. */
export function commandCodePeriodStart(subscription: unknown): string | undefined {
  const value = commandCodeBody(subscription)?.currentPeriodStart
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** The billing-period end, used as the credit window's reset time. */
function commandCodePeriodEnd(subscription: unknown): string | undefined {
  const value = commandCodeBody(subscription)?.currentPeriodEnd
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/** `/alpha/billing/subscriptions` planId as a footer-sized label. */
function commandCodePlanLabel(subscription: unknown): string {
  const planId = commandCodeBody(subscription)?.planId
  if (typeof planId !== 'string' || planId.trim() === '') return 'Command Code'
  const trimmed = planId.trim()
  const tail = trimmed.slice(trimmed.lastIndexOf('-') + 1)
  return tail === '' ? 'Command Code' : tail.toUpperCase()
}

export interface CommandCodeQuotaPayload {
  /** Required `/alpha/billing/credits` reply. */
  credits: unknown
  /** Optional `/alpha/billing/subscriptions` reply, for the plan and period. */
  subscription?: unknown
  /** Optional `/alpha/usage/summary` reply, for period spend. */
  summary?: unknown
}

/**
 * Parse Command Code's credits reply into the shared quota snapshot.
 *
 * The rolling five-hour and weekly windows report used/cap; the credit pool
 * reports a remaining USD balance, which becomes a third window whose percent
 * divides period spend by spend plus remaining balance.
 * @param payload - the billing replies already fetched.
 * @param provider - the route the snapshot is labeled with.
 * @throws Error when no window could be read.
 */
export function parseCommandCodeQuota(payload: CommandCodeQuotaPayload, provider: string): QuotaSnapshot {
  const body = commandCodeBody(payload.credits)
  if (body === undefined) throw new Error(t('quota.unrecognized'))
  const limits = recordOf(body.windowLimits)
  const windows: QuotaWindow[] = []
  const fiveHour = commandCodeRollingWindow(limits?.fiveHour)
  if (fiveHour !== undefined) windows.push({ label: t('quota.windowHourly'), period: 'hourly', ...fiveHour })
  const weekly = commandCodeRollingWindow(limits?.weekly)
  if (weekly !== undefined) windows.push({ label: t('quota.windowWeekly'), period: 'weekly', ...weekly })
  const remainingCredits = commandCodeRemainingCredits(recordOf(body.credits))
  if (remainingCredits !== undefined) {
    const spent = commandCodePeriodSpend(payload.summary)
    const limit = spent === undefined ? undefined : spent + remainingCredits
    const resetsAt = commandCodePeriodEnd(payload.subscription)
    windows.push({
      label: t('quota.windowCredits'),
      period: 'monthly',
      remainingPercent: limit === undefined || limit <= 0 ? 100 : remainingPercentFromUsed(spent! / limit * 100),
      detail: `$${remainingCredits.toFixed(2)}`,
      ...(resetsAt === undefined ? {} : { resetsAt }),
    })
  }
  if (windows.length === 0) throw new Error(t('quota.unrecognized'))
  return { provider, plan: commandCodePlanLabel(payload.subscription), source: 'command-code', windows }
}

export function formatQuotaSnapshot(snapshot: QuotaSnapshot): string {
  const lines = [t('quota.snapshotHeader', { plan: snapshot.plan, provider: snapshot.provider })]
  for (const window of snapshot.windows) {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent))
    const barWidth = 16
    const filled = Math.round(remaining / 100 * barWidth)
    const reset = window.resetsAt === undefined ? '' : ` · ${formatQuotaReset(window.resetsAt)}`
    const detail = window.detail === undefined ? '' : ` · ${window.detail}`
    const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`
    lines.push(t('quota.snapshotWindow', {
      label: window.label,
      bar,
      percent: remaining.toFixed(1),
      reset: `${reset}${detail}`,
    }))
  }
  return lines.join('\n')
}

/** Compact `/status` quota line: tightest window first, then the rest. */
export function formatQuotaStatusLine(snapshot: QuotaSnapshot | undefined): string {
  if (snapshot === undefined || snapshot.windows.length === 0) return 'quota: none'
  const tightest = tightestQuotaWindow(snapshot)
  const ordered = tightest === undefined
    ? snapshot.windows
    : [tightest, ...snapshot.windows.filter(window => window !== tightest)]
  const parts = ordered.map(window => {
    const remaining = Math.max(0, Math.min(100, window.remainingPercent))
    return `${window.label} ${remaining.toFixed(0)}%`
  })
  return `quota: ${snapshot.plan} ${parts.join(' · ')}`
}

/** Tightest remaining window — used for threshold alerts. */
export function tightestQuotaWindow(snapshot: QuotaSnapshot): QuotaWindow | undefined {
  return snapshot.windows.reduce<QuotaWindow | undefined>((best, window) => {
    if (best === undefined || window.remainingPercent < best.remainingPercent) return window
    return best
  }, undefined)
}

/**
 * The window the footer shows by default: the *finest* one, not the tightest.
 *
 * A five-hour cap is what runs out first inside a working session, so it is the
 * number a glance should find; a monthly window at 12% would otherwise hide a
 * five-hour window at 3%. Ties (and a provider that reports only one window)
 * fall back to the lowest remaining percent.
 */
export function preferredQuotaWindow(snapshot: QuotaSnapshot): QuotaWindow | undefined {
  // `unknown` ranks last, so a provider that reports one unnamed window never
  // shadows a named one; it is only shown when it is all there is.
  const rank: Record<QuotaPeriod, number> = { hourly: 0, weekly: 1, monthly: 2, unknown: 3 }
  return snapshot.windows.reduce<QuotaWindow | undefined>((best, window) => {
    if (best === undefined) return window
    if (rank[window.period] !== rank[best.period]) return rank[window.period] < rank[best.period] ? window : best
    return window.remainingPercent < best.remainingPercent ? window : best
  }, undefined)
}

/** Render the OpenCode Go quota payload as a transcript block. */
export function formatOpenCodeGoUsage(payload: unknown, source: OpenCodeSource): string {
  return formatQuotaSnapshot(parseOpenCodeGoQuota(payload, source.provider))
}

export interface AccountBalanceLine {
  label: string
  amount: string
  currency?: string
}

export interface AccountBalanceSnapshot {
  provider: string
  plan: string
  available?: boolean
  lines: AccountBalanceLine[]
  sourcePath?: string
}

export function joinUrl(base: string, path: string): string {
  const root = base.replace(/\/+$/u, '')
  const suffix = path.startsWith('/') ? path : `/${path}`
  if (root.endsWith('/v1') && suffix.startsWith('/v1/')) return `${root}${suffix.slice(3)}`
  return `${root}${suffix}`
}

export function parseDeepSeekBalance(payload: unknown, provider = 'deepseek-official'): AccountBalanceSnapshot {
  if (payload === null || typeof payload !== 'object') {
    throw new Error(t('quota.deepseekUnrecognized'))
  }
  const raw = payload as Record<string, unknown>
  const infos = Array.isArray(raw.balance_infos) ? raw.balance_infos : []
  const lines: AccountBalanceLine[] = []
  for (const item of infos) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const currency = typeof row.currency === 'string' ? row.currency : undefined
    const total = typeof row.total_balance === 'string' ? row.total_balance : typeof row.total_balance === 'number' ? String(row.total_balance) : undefined
    if (total === undefined) continue
    lines.push({
      label: t('balance.available'),
      amount: total,
      ...(currency === undefined ? {} : { currency }),
    })
    const granted = typeof row.granted_balance === 'string' ? row.granted_balance : undefined
    const topped = typeof row.topped_up_balance === 'string' ? row.topped_up_balance : undefined
    if (granted !== undefined) lines.push({ label: t('balance.granted'), amount: granted, ...(currency === undefined ? {} : { currency }) })
    if (topped !== undefined) lines.push({ label: t('balance.topped'), amount: topped, ...(currency === undefined ? {} : { currency }) })
  }
  if (lines.length === 0) throw new Error(t('quota.deepseekUnrecognized'))
  return {
    provider,
    plan: t('route.deepseek'),
    available: typeof raw.is_available === 'boolean' ? raw.is_available : undefined,
    lines,
    sourcePath: '/user/balance',
  }
}

function numberish(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Best-effort parse of OpenAI-compatible credit/balance JSON. */
export function parseOpenAiCompatibleBalance(payload: unknown, provider: string, path: string): AccountBalanceSnapshot | undefined {
  const raw = recordOf(payload)
  if (raw === undefined) return undefined
  const lines: AccountBalanceLine[] = []
  const totalGranted = numberish(raw.total_granted)
  const totalUsed = numberish(raw.total_used)
  const totalAvailable = numberish(raw.total_available)
  if (totalAvailable !== undefined) lines.push({ label: t('balance.remaining'), amount: totalAvailable, currency: 'USD' })
  if (totalGranted !== undefined) lines.push({ label: t('balance.total'), amount: totalGranted, currency: 'USD' })
  if (totalUsed !== undefined) lines.push({ label: t('balance.used'), amount: totalUsed, currency: 'USD' })
  const hardLimit = numberish(raw.hard_limit_usd ?? raw.hard_limit)
  const softLimit = numberish(raw.soft_limit_usd ?? raw.soft_limit)
  if (hardLimit !== undefined) lines.push({ label: t('balance.hard'), amount: hardLimit, currency: 'USD' })
  if (softLimit !== undefined) lines.push({ label: t('balance.soft'), amount: softLimit, currency: 'USD' })
  const data = recordOf(raw.data) ?? raw
  const balance = numberish(data.balance ?? data.total_balance ?? data.credit ?? data.credits ?? data.quota)
  if (lines.length === 0 && balance !== undefined) {
    lines.push({ label: t('balance.generic'), amount: balance, currency: typeof data.currency === 'string' ? data.currency : undefined })
  }
  if (Array.isArray(raw.balance_infos)) {
    try {
      return { ...parseDeepSeekBalance(raw, provider), plan: provider, sourcePath: path }
    } catch {
      // Not DeepSeek-shaped despite the field name.
    }
  }
  if (lines.length === 0) return undefined
  return { provider, plan: provider, lines, sourcePath: path }
}

/** Compact footer chip: `余额 86.42 CNY`. Prefers remaining/available lines. */
export function formatFooterBalance(snapshot: AccountBalanceSnapshot): string | undefined {
  const preferred = snapshot.lines.find(line =>
    /剩余|可用|余额|available|remaining|credit/iu.test(line.label))
    ?? snapshot.lines[0]
  if (preferred === undefined) return undefined
  const amount = preferred.amount.trim()
  if (amount === '') return undefined
  const currency = preferred.currency === undefined || preferred.currency === '' ? '' : ` ${preferred.currency}`
  return t('footer.balance', { amount: `${amount}${currency}` })
}

export function formatAccountBalance(snapshot: AccountBalanceSnapshot): string {
  const header = [t('balance.header', { plan: snapshot.plan, provider: snapshot.provider })]
  if (snapshot.available === false) header.push(t('balance.unavailable'))
  for (const line of snapshot.lines) {
    const currency = line.currency === undefined ? '' : ` ${line.currency}`
    header.push(`  ${line.label} · ${line.amount}${currency}`)
  }
  if (snapshot.sourcePath !== undefined) header.push(t('balance.source', { path: snapshot.sourcePath }))
  return header.join('\n')
}

/** Extract a safe human-readable message from an OpenCode error payload. */
export function openCodeApiErrorMessage(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const raw = payload as Record<string, unknown>
  const error = raw.error
  if (typeof error === 'string' && error.trim() !== '') return error.trim()
  if (typeof error === 'object' && error !== null) {
    const message = (error as Record<string, unknown>).message
    if (typeof message === 'string' && message.trim() !== '') return message.trim()
  }
  if (typeof raw.message === 'string' && raw.message.trim() !== '') return raw.message.trim()
  return ''
}

/**
 * AIClient2API (A2) — the self-hosted proxy that turns client-only plans
 * (Antigravity / Gemini CLI, Kiro, Codex, Grok) into an OpenAI-compatible API,
 * serving each provider under `/<providerType>/v1`.
 *
 * Its quota surface is the **panel**, not the AI route: `POST /api/login`
 * exchanges the admin password for a dynamic token, and
 * `GET /api/usage/<providerType>` answers with the upstream subscription's own
 * windows — for `gemini-antigravity` that is the Google AI plan's per-model
 * quota. The AI key cannot read it (A2 answers 401 "please login first"), so
 * this source carries its own credential refs.
 *
 * The types are A2's `MODEL_PROVIDER` values (src/utils/constants.js upstream);
 * only the routing prefix decides recognition, so a lookalike gateway under the
 * same path shape is asked, answers something else, and is reported as
 * unreadable rather than silently mis-shown.
 */
export const AICLIENT2API_PROVIDER_TYPES: ReadonlySet<string> = new Set([
  'gemini-antigravity',
  'gemini-cli-oauth',
  'claude-kiro-oauth',
  'openai-codex-oauth',
  'grok-web',
  'grok-cli-oauth',
  'openai-custom',
  'openaiResponses-custom',
  'claude-custom',
  'openai-qwen-oauth',
  'openai-iflow',
  'atlascloud',
  'qiniu',
  'fenno',
  'forward-api',
])

/** Panel admin password; exchanged for a token on demand. */
export const AICLIENT2API_PASSWORD_ENV = 'AICLIENT2API_PASSWORD'
/** A panel token copied from the browser session, when no password is stored. */
export const AICLIENT2API_TOKEN_ENV = 'AICLIENT2API_TOKEN'
export const AICLIENT2API_LOGIN_PATH = '/api/login'

/** `GET /api/usage/<providerType>`: the provider's own subscription windows. */
export function aiClient2ApiUsagePath(providerType: string): string {
  return `/api/usage/${encodeURIComponent(providerType)}`
}

export interface AiClient2ApiSource {
  provider: string
  /** Panel origin, e.g. `https://agy.wdsky.top`. */
  origin: string
  /** A2 provider type taken from the route, e.g. `gemini-antigravity`. */
  providerType: string
  label: string
  passwordEnv: string
  tokenEnv: string
}

/**
 * Classify one route as an A2 provider mount (`<origin>/<providerType>/v1`).
 * @param provider - the selected provider route.
 * @param llmPiAiSection - the `llm-pi-ai` settings section, if readable.
 * @returns the panel coordinates to ask, or `null` for another provider.
 */
export function aiClient2ApiSourceFor(provider: string, llmPiAiSection: unknown): AiClient2ApiSource | null {
  const section = llmPiAiSection as LlmPiAiSection | null | undefined
  const profile = section?.providers?.[provider]
  const baseURL = typeof profile?.baseURL === 'string' ? profile.baseURL.trim() : ''
  if (baseURL === '') return null
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    return null
  }
  const segments = url.pathname.split('/').filter(segment => segment !== '')
  if (segments.length !== 2) return null
  const providerType = (segments[0] ?? '').toLowerCase()
  const version = (segments[1] ?? '').toLowerCase()
  if (!AICLIENT2API_PROVIDER_TYPES.has(providerType)) return null
  if (version !== 'v1' && version !== 'v1beta') return null
  const label = typeof profile?.displayName === 'string' && profile.displayName.trim() !== ''
    ? profile.displayName.trim()
    : `AIClient2API · ${providerType}`
  return {
    provider,
    origin: url.origin,
    providerType,
    label,
    passwordEnv: AICLIENT2API_PASSWORD_ENV,
    tokenEnv: AICLIENT2API_TOKEN_ENV,
  }
}

/** One A2 instance inside `GET /api/usage/<providerType>`. */
interface AiClient2ApiInstance {
  name?: string
  success?: boolean
  error?: string | null
  usage?: {
    summary?: { plan?: unknown; resetAt?: unknown; userTier?: unknown }
    user?: { email?: unknown }
    items?: unknown
  } | null
}

function aiClient2ApiInstanceList(payload: unknown): AiClient2ApiInstance[] {
  const root = recordOf(payload)
  const instances = root?.instances
  return Array.isArray(instances) ? instances.filter((entry): entry is AiClient2ApiInstance =>
    typeof entry === 'object' && entry !== null) : []
}

/** A finite number from a JSON value, whatever type the panel sent it as. */
function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** A2's item percent is *used*; the shared window type wants what is left. */
function aiClient2ApiItemWindow(label: string, value: unknown): QuotaWindow | undefined {
  const item = recordOf(value)
  if (item === undefined) return undefined
  const explicitRemaining = finiteNumber(item.remainingPercent)
  const used = finiteNumber(item.used)
  const limit = finiteNumber(item.limit)
  const usedPercent = finiteNumber(item.percent)
    ?? (used !== undefined && limit !== undefined && limit > 0 ? used / limit * 100 : undefined)
  const remainingPercent = explicitRemaining
    ?? (usedPercent === undefined ? undefined : remainingPercentFromUsed(usedPercent))
  if (remainingPercent === undefined) return undefined
  const resetAt = typeof item.resetAt === 'string' && item.resetAt.trim() !== '' ? item.resetAt.trim() : undefined
  return {
    label,
    period: 'unknown',
    remainingPercent,
    ...(resetAt === undefined ? {} : { resetsAt: resetAt }),
  }
}

/**
 * Parse `GET /api/usage/<providerType>` into the shared quota snapshot.
 *
 * Every successful instance contributes its per-model windows; with more than
 * one account in the pool each label is prefixed with the instance name, so two
 * accounts' `gemini-3-pro` rows do not look like a duplicate of one.
 * @param payload - the panel reply.
 * @param provider - the route the snapshot is labeled with.
 * @throws Error when the reply carries no readable quota at all.
 */
export function parseAiClient2ApiUsage(payload: unknown, provider: string): QuotaSnapshot {
  const instances = aiClient2ApiInstanceList(payload)
  if (instances.length === 0) throw new Error(t('quota.unrecognized'))
  const usable = instances.filter(instance => instance.success === true && instance.usage != null)
  if (usable.length === 0) {
    const reason = instances.map(instance => instance.error).find(error => typeof error === 'string' && error !== '')
    throw new Error(reason ?? t('quota.unrecognized'))
  }
  const windows: QuotaWindow[] = []
  let plan = ''
  for (const instance of usable) {
    const items = instance.usage?.items
    if (!Array.isArray(items)) continue
    const prefix = usable.length > 1 && typeof instance.name === 'string' && instance.name.trim() !== ''
      ? `${instance.name.trim()} · `
      : ''
    for (const item of items) {
      const record = recordOf(item)
      if (record === undefined) continue
      const label = typeof record.label === 'string' && record.label.trim() !== ''
        ? record.label.trim()
        : typeof record.id === 'string' ? record.id.trim() : ''
      if (label === '') continue
      const window = aiClient2ApiItemWindow(`${prefix}${label}`, record)
      if (window !== undefined) windows.push(window)
    }
    if (plan === '') {
      const summary = instance.usage?.summary
      plan = typeof summary?.plan === 'string' && summary.plan.trim() !== ''
        ? summary.plan.trim()
        : (typeof instance.usage?.user?.email === 'string' ? instance.usage.user.email.trim() : '')
    }
  }
  if (windows.length === 0) throw new Error(t('quota.unrecognized'))
  return { provider, plan: plan === '' ? 'AIClient2API' : plan, source: 'aiclient2api', windows }
}
