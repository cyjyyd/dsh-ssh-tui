/**
 * Footer layout: the two chrome rows, and the `/status` report that spells the
 * first one out.
 *
 * Layout assembles chips and rows; it does not decide how a chip degrades (that
 * is `footer-budget.ts`) and does not spell a reading (that is
 * `footer-format.ts`). The contract it does own is *where a signal lives*: the
 * status row carries health, activity, speed, quota and context, the workspace
 * row carries metadata, and the counters the status row gave up are answered by
 * {@link formatStatusReport}.
 *
 * @module dsh-ssh-tui/footer-layout
 */

import { t } from './i18n/index.js'
import { pinEmojiCells, truncateAnsiToWidth, visibleWidth } from './term-text.js'
import { describeSubagentFit, subagentProviderDiffers } from './subagent-model.js'
import { activeTheme, themeExtraToken, themeToken } from './theme.js'
import { downgradeSgr, type ColorDepth } from './color-depth.js'
import {
  commandCodeSourceFor, formatQuotaStatusLine, openCodeSourceFor,
  type QuotaPeriod, type QuotaSnapshot,
} from './quota.js'
import { formatRate, type ThroughputView } from './throughput.js'
import { sessionTokenTotal, type SessionStatsRow } from './stats.js'
import type { DisconnectPolicyName } from './transcript-types.js'
import {
  CONTEXT_IDLE_COMPACT_RATIO,
  CONTEXT_PRESSURE_DANGER_RATIO,
  CONTEXT_PRESSURE_WARN_RATIO,
  contextPressureView,
  describeProviderRoute,
  formatContextPressureStatusLine,
  formatDuration,
  formatTokens,
  formatTokensPerSecond,
  shortModelName,
  subagentRouteLabel,
  type ContextPressureView,
} from './footer-format.js'
import type { FooterActivityKind } from './footer-budget.js'

export const WAIT_INDICATOR_MS = 8000

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
/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The status row shows one session total and `/status` prints the counters; this
 * group list was the previous footer's first row, and the only thing still
 * composing it is `statsText()` (itself test-only). Kept exported for 0.8.x.
 */
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
/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The default row stopped using this when the footer became the status row
 * (`docs/plans/footer-debt.md`, D-7): what is left of it is the previous
 * generation's fitting and formatting, kept exported so 0.8.x does not break an
 * importer. New callers want the budget module's `runtimeStrip`, the meters, or
 * `formatStatusReport` for the spelled-out numbers.
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
/**
 * @deprecated Legacy surface, removed in 0.9.
 *
 * The default row stopped using this when the footer became the status row
 * (`docs/plans/footer-debt.md`, D-7): what is left of it is the previous
 * generation's fitting and formatting, kept exported so 0.8.x does not break an
 * importer. New callers want the budget module's `runtimeStrip`, the meters, or
 * `formatStatusReport` for the spelled-out numbers.
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
 * the preset-owned tools are missing. It leads the status row and keeps its glyph
 * longest, because it is the one group that reports a broken install.
 */
export function footerHealthChip(
  missing: boolean,
  color = false,
  /** Which rows are missing: the 0.1.5 roster, or the 0.1.7 agent plane. */
  kind: 'roster' | 'agent-plane' = 'roster',
): FooterChip | undefined {
  if (!missing) return undefined
  const glyph = color ? `\x1b[${themeExtraToken(activeTheme(), 'warn')}m⚠\x1b[0m` : '⚠'
  return {
    id: 'health',
    long: `${glyph} ${t(kind === 'agent-plane' ? 'footer.agentPlaneMissing' : 'footer.rosterMissing')}`,
    short: glyph,
    priority: 0,
  }
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
export function fitFooterStatsLine(chip: string, groups: readonly string[], width: number): string {
  const kept = [...groups]
  const render = (): string => kept.length === 0 ? chip : `${chip} │ ${kept.join(' │ ')}`
  while (kept.length > 0 && visibleWidth(render()) > width) kept.pop()
  return truncateAnsiToWidth(render(), Math.max(1, width))
}

export interface FooterStatusInput {
  running: boolean
  /**
   * What the running tools are: the tool's own short name (`edit`, `terminal`,
   * `search`), the way the transcript's card titles spell it, or a count when
   * several are open at once.
   */
  toolLabel?: string
  planReview: boolean
  waitingQuestion: boolean
  /** A tool call is stopped on a human yes/no. */
  waitingApproval: boolean
  compacting: boolean
  retry?: { retry: number; maxRetries: number }
  subagents: number
  tools: number
  planLeftOpen: boolean
  planPending: boolean
  planActive: boolean
  goalPhase?: 'active' | 'paused' | 'blocked'
  idleMs: number
  /** Reasoning deltas have arrived for the step in flight. */
  streamingReasoning?: boolean
  /** Visible text has started arriving for the step in flight. */
  streamingText?: boolean
  /**
   * Wall clock the current activity began — the open tool call, the running
   * subagents, the compaction, the step's first delta. The row prints it as
   * `· 28s`; without one the chip shows the verb alone rather than borrowing a
   * number that measures something else.
   */
  activityStartedAt?: number
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
  /**
   * The subscription badge for the row's last part (`OpenCode-GO`,
   * `CommandCode-GOAT`), for the routes that have one. See `planRouteBadge`.
   */
  planBadge?: string
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
  // An approval is the one wait that used to read as idle: it is a `confirm`
  // dialog, and the status row only recognised `questions` ones.
  if (input.waitingApproval) return { kind: 'approval', text: t('footer.approval') }
  if (input.compacting) return { kind: 'compacting', text: t('footer.compacting') }
  // Only a running turn can be retrying: a chip left over from a finished turn
  // (a missed event, or a retry of a background request such as the session
  // title) must not hide the state the user is actually in.
  if (input.running && input.retry !== undefined) {
    return { kind: 'retry', text: t('footer.retry', { retry: input.retry.retry, max: input.retry.maxRetries }) }
  }
  if (input.subagents > 0) {
    // `agent · 3m12s`: the verb and the clock. Which child it is (model, effort,
    // role) is the identity row's job — putting `sub:grok-4.7(xhigh)` here broke
    // the row's width on exactly the sessions that spawn the most children.
    return { kind: 'agent', text: t('footer.agent') }
  }
  if (input.running && input.tools > 0) {
    // The tool names itself rather than reporting a count: `⠹ edit · 28s` says
    // what the session is doing, while `工具 1 · 28s` says how many of something
    // unnamed are open. A count only appears when several run at once, where the
    // question "which one" has no single answer.
    const label = input.toolLabel?.trim() ?? ''
    if (label !== '') return { kind: 'tools', text: label }
    return { kind: 'tools', text: t('footer.tools', { count: input.tools }) }
  }
  if (input.planLeftOpen) return { kind: 'plan-open', text: t('footer.planOpen') }
  if (input.planPending) return { kind: 'plan-pending', text: t('footer.planSwitching') }
  if (input.planActive) return { kind: 'plan-pending', text: t('footer.planMode') }
  if (input.goalPhase === 'active') return { kind: 'goal', text: t('footer.goalActive') }
  if (input.goalPhase === 'paused') return { kind: 'goal', text: t('footer.goalPaused') }
  if (input.goalPhase === 'blocked') return { kind: 'goal', text: t('footer.goalBlocked') }
  if (input.running && input.idleMs > WAIT_INDICATOR_MS) {
    return { kind: 'waiting-llm', text: t('footer.waitSeconds', { seconds: Math.floor(input.idleMs / 1000) }) }
  }
  // What the running turn is actually doing. The window before the first token
  // stays `运行中`: calling it 思考中 would claim the model is reasoning when the
  // request may not even have been accepted yet, and would put a decode clock on
  // a step that has decoded nothing.
  if (input.running) {
    if (input.streamingText === true) return { kind: 'reply', text: t('footer.reply') }
    if (input.streamingReasoning === true) return { kind: 'thinking', text: t('footer.thinking') }
    return { kind: 'idle', text: t('footer.running') }
  }
  return { kind: 'idle', text: t('footer.idle') }
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
  muteSgr = themeToken(activeTheme(), 'system'),
  depth: ColorDepth = 'truecolor',
  identitySgr = themeExtraToken(activeTheme(), 'subagent-foreign'),
): string {
  if (!foreign || chip === '' || !line.includes(chip)) return line
  const code = downgradeSgr(identitySgr, depth)
  if (code === '') return line
  const mute = muteSgr === '' ? '0' : muteSgr
  return line.replace(chip, `\x1b[${code}m${chip}\x1b[0m\x1b[${mute}m`)
}

export function footerSubagentForeign(input: Pick<FooterStatusInput, 'provider' | 'subProvider'>): boolean {
  return subagentProviderDiffers(input.provider, input.subProvider)
}

/**
 * The workspace row is **ordered by priority**, and the fitter drops from the
 * right - one mechanism, not two.
 *
 * The row used to be ordered by what a footer has always shown (preset, cwd,
 * route) while the fitter cut the right-most part, so a narrow terminal deleted a
 * queue count while keeping a preset the header already prints. Sorting the parts
 * by how much they are worth puts both rules in one order:
 *
 * 1. `[compact]` - the view mode, the one marker nothing else repeats;
 * 2. `dir:...` - where this session is working, which the header never says;
 * 3. `bal ...` - a reading the row must not lose: on a balance-only provider
 *    (DeepSeek) it is the only one, so it outlives the configuration behind it;
 * 4. `search i/n`, the input's shape, `queued n` - *state*: what the session is
 *    doing right now, which is what the reader needs mid-turn;
 * 5. `sub:...` - configuration, inherited by every child and changed only by
 *    `/submodel`, so it sits after the state; and
 * 6. the subscription badge (`OpenCode-GO`, `CommandCode-GOAT`) - context rather
 *    than action, so it closes the row and is the first part a narrow row gives
 *    up. Losing the last part reads as "the row got shorter", never as a hole in
 *    the middle of it.
 *
 * The preset is deliberately absent: the header prints it permanently.
 */

/** Options for {@link footerIdentityParts}. */
export interface FooterIdentityOptions {
  /**
   * Leave the provider/model/effort out.
   *
   * The header paints the live route permanently, so on the workspace row the
   * parent model is the one piece of information the reader already has — and
   * the piece that used to push the `sub:` chip off a 100-column row.
   */
  omitModel?: boolean
}

/**
 * The workspace row: what this session is, not what it is doing.
 *
 * Quota and context used to live here and now own capacity meters on the row
 * above, so they are deliberately absent: a number painted twice is a number the
 * reader has to check twice. What is left is the configuration the header does
 * not carry — the preset, the working directory, the child route, and the
 * input's own transient state.
 */
export function footerIdentityParts(input: FooterStatusInput, options: FooterIdentityOptions = {}): string[] {
  const parts: string[] = []
  if (input.compactView === true) parts.push(`[${t('view.footerCompact')}]`)
  // The preset is *not* here: the header prints it permanently, so a second copy
  // in a footer fighting for cells bought nothing. The row carries what the header
  // does not - where this session is working, and what is waiting for it.
  if (input.cwdLabel !== undefined && input.cwdLabel !== '') parts.push(input.cwdLabel)
  // A balance-only route (DeepSeek) has no quota window to gauge, so its remaining
  // credit stays as reference metadata rather than pretending to be a capacity
  // meter it cannot fill - and it outlives the configuration below, because on
  // that route it is the row's only reading.
  if (input.balanceText !== undefined && input.balanceText !== '') parts.push(input.balanceText)
  if (options.omitModel !== true) {
    const modelName = shortModelName(input.model)
    const effort = input.effort === undefined || input.effort.trim() === '' ? '' : input.effort.trim()
    const model = [modelName, effort].filter(part => part !== '').join(' ')
    // Only an embedded surface with no header asks for this; `/status` is where
    // the exact route lives, so it sits with the rest of the configuration.
    if (model !== '') parts.push(model)
  }
  if (input.search !== undefined) parts.push(t('footer.search', { index: input.search.index + 1, total: input.search.total }))
  if (input.foldedInput) parts.push(t('footer.inputFolded'))
  else if (input.multiLineInput) parts.push(t('footer.multiLine'))
  if (input.queued > 0) parts.push(t('footer.queued', { count: input.queued }))
  // The child route closes the row: configuration, inherited by every child and
  // changed only by `/submodel`, so it is the first thing a narrow row gives up.
  const sub = subagentRouteLabel(input.subModel, input.subProvider, input.subEffort)
  if (sub !== '') parts.push(sub)
  // The subscription closes the row, behind even the child route: it is the
  // context everything else is billed against, not something the reader acts on,
  // so it is the first part a narrow row discards.
  if (input.planBadge !== undefined && input.planBadge !== '') parts.push(input.planBadge)
  return parts
}

/**
 * Fit the workspace row under `width`.
 *
 * The metadata is secondary by construction: it follows the activity label at a
 * dimmer intensity and is dropped from the right, one part at a time, rather
 * than being allowed to wrap into the status row above it.
 */
export function fitFooterStatusLine(activity: string, identity: readonly string[], width: number): string {
  const kept = [...identity]
  // An empty label means this row carries metadata only (the status row's
  // activity lives one line up), and then the joining spaces go with it: a row
  // that opened with two blank cells read as a layout bug.
  const render = (): string => {
    const parts = kept.filter(part => part !== '')
    if (activity === '') return parts.join(' · ')
    return parts.length === 0 ? activity : `${activity}  ${parts.join(' · ')}`
  }
  // From the right, which is the priority order the parts are already in: the
  // child route goes first, then the row's state, and the working directory last.
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
  /** Session counters: the block the default row gave up (B-footer pass). */
  stats?: SessionStatsRow
  /** Throughput accounting: exact rate and the running estimate. */
  throughput?: ThroughputView
}

/**
 * Lines printed by `/status` — SSH first-boot diagnostics, no extra command.
 *
 * This is where the status row's removed telemetry lives. Turns, steps, model
 * time, tool time, cache hit and the input/output breakdown are session
 * analytics: they answer no question a live operator is asking, which is why
 * they left the default row, and their disappearance would be information loss —
 * so `/status` prints all of them, plus the throughput accounting, in the shapes
 * the row used to use.
 */
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
    ...(input.stats === undefined ? [] : formatStatusStats(input.stats)),
    ...(input.throughput === undefined ? [] : [formatStatusThroughput(input.throughput)]),
    `paint: ${input.paint}`,
    `disconnect: ${input.disconnect ?? 'pause'}`,
    input.waitingQuestions > 0 ? `questions: waiting ${input.waitingQuestions}` : 'questions: none',
  ]
}

/**
 * The stats block `/status` prints: everything the default row gave up.
 *
 * `tokens/sec` here is the exact per-step rate (`decodeTokens / decodeMs`), not
 * the running estimate, and the line says which span it covers: the last step
 * and the session so far are different questions and only one of them is a
 * benchmark.
 */
export function formatStatusStats(stats: SessionStatsRow): string[] {
  const billedInput = stats.inputTokens + stats.cacheReadTokens + stats.cacheWriteTokens
  const total = sessionTokenTotal({
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    reportedTokens: stats.totalTokens,
    reportedSteps: stats.totalTokens > 0 ? 1 : 0,
    unreportedSteps: stats.totalTokens > 0 ? 0 : 1,
    cacheReadTokens: stats.cacheReadTokens,
    cacheWriteTokens: stats.cacheWriteTokens,
  })
  const lines = [
    `turns: ${stats.turns}`,
    `steps: ${stats.steps}`,
    `tokens: in ${formatTokens(billedInput)} · out ${formatTokens(stats.outputTokens)}`
      + (total === undefined
        ? ''
        : ` · total ${formatTokens(total.tokens)} (${total.basis === 'harness' ? 'harness totalTokens' : 'billed parts summed'})`),
    `tokens: cached read ${formatTokens(stats.cacheReadTokens)} · cached write ${formatTokens(stats.cacheWriteTokens)}`,
  ]
  if (billedInput > 0) lines.push(`cache: hit ${Math.round(stats.cacheReadTokens / billedInput * 100)}%`)
  if (stats.llmMs > 0) lines.push(`model time: ${formatDuration(stats.llmMs)}`)
  if (stats.toolMs > 0) lines.push(`tool time: ${formatDuration(stats.toolMs)}`)
  if (stats.ttftSteps > 0) {
    const steps = stats.ttftSteps === 1 ? 'step' : 'steps'
    lines.push(`ttft: ${formatDuration(stats.ttftMs / stats.ttftSteps)} avg over ${stats.ttftSteps} ${steps}`)
  }
  return lines
}

/** One line: what the throughput number means, and which span it covers. */
export function formatStatusThroughput(throughput: ThroughputView): string {
  const parts: string[] = []
  parts.push(throughput.settledRate === undefined
    ? 'tokens/sec: no settled step yet'
    : `tokens/sec: ${formatRate(throughput.settledRate)} (last settled step, output tokens / decode ms)`)
  if (throughput.liveRate !== undefined && throughput.fresh) {
    parts.push(`~${formatRate(throughput.liveRate)} live (estimated from ${throughput.liveChars} streamed chars)`)
  }
  return parts.join(' · ')
}
