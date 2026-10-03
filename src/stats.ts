/**
 * Session statistics: turns/steps, LLM and tool time, TTFT, decode rate, and
 * token usage.
 *
 * `tui.ts` owns the rendering; this owns the arithmetic. The rules that used to
 * live among the event handlers are what make the footer honest, so they live
 * here with tests instead of inside a 7k-line class:
 *
 * - a repeated usage report for the same step replaces its sample (hosts report
 *   usage per step more than once, and naive adding double counts),
 * - TTFT latches on the *first* token delta of the open step,
 * - the settled `assistant/message` packed stream wins over that latch (a
 *   retried step would otherwise span both attempts and report a rate ~20x off),
 * - decode rate needs a finite, non-negative output token count.
 */
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

import {
  ThroughputTracker,
  type ThroughputView,
} from './throughput.js'

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  /** Sum of the full-call totals the harness itself reported, when it reported one. */
  reportedTokens: number
  /** Steps whose usage carried a harness total. */
  reportedSteps: number
  /** Steps whose usage carried none, so the billed parts had to stand in. */
  unreportedSteps: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** The session-size number the second row shows, and how it was derived. */
export interface SessionTokenTotal {
  tokens: number
  /**
   * `harness` when every usage sample carried the harness's own total; `sum`
   * when some step's billed parts had to be added in instead.
   */
  basis: 'harness' | 'sum'
}

/**
 * How many tokens this session has moved, on the accounting the harness
 * published.
 *
 * The harness is the authority: a `totalTokens` it reports is a full-call total
 * whose parts are defined provider by provider — pi-ai's own adapters build it
 * as prompt + output + cache read + cache write — and re-deriving one from the
 * three prompt counters plus output is exactly the arithmetic that
 * double-counts on a provider that folds cache into its prompt count. So
 * reported totals are summed, and only a step that reported none contributes
 * its billed parts. The basis says which happened, and `/status` prints it.
 */
export function sessionTokenTotal(usage: SessionUsage): SessionTokenTotal | undefined {
  if (usage.reportedSteps === 0 && usage.inputTokens === 0 && usage.outputTokens === 0) return undefined
  const billed = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
  if (usage.unreportedSteps === 0 && usage.reportedSteps > 0) {
    return { tokens: usage.reportedTokens, basis: 'harness' }
  }
  if (usage.reportedSteps === 0) return { tokens: billed, basis: 'sum' }
  return { tokens: usage.reportedTokens + billed, basis: 'sum' }
}


export interface SessionStatsSnapshot {
  turns: number
  steps: number
  llmMs: number
  toolMs: number
  ttftMs: number
  ttftSteps: number
  decodeMs: number
  decodeTokens: number
  /** Tokens and milliseconds of the most recent settled step alone. */
  lastDecodeMs: number
  lastDecodeTokens: number
  /** Decode totals excluding the step that is currently open. */
  settledDecodeMs: number
  settledDecodeTokens: number
  usage: SessionUsage
}

/** Flat view of the same numbers, for the footer's stats line. */
export interface SessionStatsRow {
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
  totalTokens: number
}

export interface OpenStep {
  turn: number
  step: number
}

export function emptySessionUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    reportedTokens: 0,
    reportedSteps: 0,
    unreportedSteps: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

export function emptySessionStats(): SessionStatsSnapshot {
  return {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    lastDecodeMs: 0,
    lastDecodeTokens: 0,
    settledDecodeMs: 0,
    settledDecodeTokens: 0,
    usage: emptySessionUsage(),
  }
}

/** Flatten a snapshot into the legacy stats-row shape. */
export function statsRowOf(stats: SessionStatsSnapshot): SessionStatsRow {
  const total = sessionTokenTotal(stats.usage)
  return {
    turns: stats.turns,
    steps: stats.steps,
    llmMs: stats.llmMs,
    toolMs: stats.toolMs,
    ttftMs: stats.ttftMs,
    ttftSteps: stats.ttftSteps,
    decodeMs: stats.decodeMs,
    decodeTokens: stats.decodeTokens,
    inputTokens: stats.usage.inputTokens,
    outputTokens: stats.usage.outputTokens,
    cacheReadTokens: stats.usage.cacheReadTokens,
    cacheWriteTokens: stats.usage.cacheWriteTokens,
    totalTokens: total?.tokens ?? 0,
  }
}

/**
 * Accumulates the stats the footer and `/status` show as session events arrive.
 * Every method is a no-op for events that do not apply, so callers can forward
 * the raw event stream without checking.
 */
export class SessionStatsTracker {
  private stats: SessionStatsSnapshot = emptySessionStats()
  private openStep: { turn: number; step: number; startTime: number; firstTokenTime: number | null } | undefined
  private readonly usageByStep = new Map<string, SessionUsage>()
  private readonly pendingToolTimes = new Map<string, number>()
  private lastTurn: number | null = null
  /** Live decode estimate for the step currently streaming. */
  private readonly live = new ThroughputTracker()

  /** The step a live chunk belongs to when the host frame carried none. */
  currentStep(): OpenStep | undefined {
    const open = this.openStep
    return open === undefined ? undefined : { turn: open.turn, step: open.step }
  }

  /**
   * The open step's two clocks, for the status row's elapsed suffix.
   *
   * Both are host wall clocks, so a caller may subtract them from `Date.now()`
   * without a translation. `firstTokenAt` is absent until the step's first
   * delta, which is exactly the difference between "the request is out" and
   * "the model is talking".
   */
  stepClocks(): { startedAt?: number; firstTokenAt?: number } {
    const open = this.openStep
    if (open === undefined) return {}
    return {
      startedAt: open.startTime,
      ...(open.firstTokenTime === null ? {} : { firstTokenAt: open.firstTokenTime }),
    }
  }

  /** `step/start`: opens the clock LLM time, TTFT and decode are measured from. */
  noteStepStart(turn: number, step: number, time: number): void {
    this.openStep = { turn, step, startTime: time, firstTokenTime: null }
    this.live.reset()
  }

  /**
   * A live fragment of model output, for the running throughput estimate.
   *
   * The text itself travels: the estimate is tokens per character, and how many
   * tokens a character is worth depends on the script the fragment is written in.
   * @param text - the fragment.
   * @param time - wall clock the fragment arrived at.
   */
  noteDelta(text: string, time: number = Date.now()): void {
    this.live.note(text, time)
  }

  /** The running throughput estimate, settled value included. */
  throughput(now: number = Date.now()): ThroughputView {
    return this.live.view(now)
  }

  /** The first token delta of the open step latches its TTFT clock. */
  noteFirstToken(turn: number, step: number, time: number): void {
    const open = this.openStep
    if (open === undefined || open.turn !== turn || open.step !== step) return
    if (open.firstTokenTime === null) open.firstTokenTime = time
  }

  /** Replace one step's usage sample so a repeated report never double counts. */
  recordUsage(turn: number, step: number, usage: TokenUsage): void {
    const key = `${turn}:${step}`
    const total = usage.totalTokens
    const next: SessionUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      reportedTokens: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? total : 0,
      reportedSteps: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? 1 : 0,
      unreportedSteps: typeof total === 'number' && Number.isFinite(total) && total >= 0 ? 0 : 1,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    const previous = this.usageByStep.get(key)
    const totals = this.stats.usage
    this.stats.usage = {
      inputTokens: totals.inputTokens - (previous?.inputTokens ?? 0) + next.inputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
      reportedTokens: totals.reportedTokens - (previous?.reportedTokens ?? 0) + next.reportedTokens,
      reportedSteps: totals.reportedSteps - (previous?.reportedSteps ?? 0) + next.reportedSteps,
      unreportedSteps: totals.unreportedSteps - (previous?.unreportedSteps ?? 0) + next.unreportedSteps,
      cacheReadTokens: totals.cacheReadTokens - (previous?.cacheReadTokens ?? 0) + next.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens - (previous?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
    }
    this.usageByStep.set(key, next)
  }

  /**
   * `assistant/message`: settle the open step's LLM time, TTFT and decode rate.
   * `firstTokenTime` is the settlement's own packed-stream answer when it has
   * one; `undefined` falls back to the live latch.
   */
  settleMessage(input: {
    turn: number
    step: number
    time: number
    firstTokenTime?: number | undefined
    outputTokens?: number | undefined
  }): void {
    const open = this.openStep
    if (open !== undefined && open.turn === input.turn && open.step === input.step) {
      this.stats.llmMs += Math.max(0, input.time - open.startTime)
      const firstTokenTime = input.firstTokenTime ?? open.firstTokenTime
      if (firstTokenTime !== null && firstTokenTime !== undefined && Number.isFinite(firstTokenTime)) {
        this.stats.ttftMs += Math.max(0, firstTokenTime - open.startTime)
        this.stats.ttftSteps += 1
        const outputTokens = input.outputTokens
        if (typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0) {
          const decodeMs = Math.max(0, input.time - firstTokenTime)
          this.stats.decodeMs += decodeMs
          this.stats.decodeTokens += outputTokens
          this.stats.lastDecodeMs = decodeMs
          this.stats.lastDecodeTokens = outputTokens
          this.stats.settledDecodeMs += decodeMs
          this.stats.settledDecodeTokens += outputTokens
          // The estimate is only as good as the last exact measurement: fold
          // this step's real ratio in before the next one starts streaming.
          this.live.settle(outputTokens, decodeMs)
          this.openStep = undefined
          return
        }
      }
      this.stats.lastDecodeMs = 0
      this.stats.lastDecodeTokens = 0
      this.live.settle(0, 0)
      this.openStep = undefined
    }
  }

  /** `tool/call`: start the tool clock for this call. */
  noteToolStart(callId: string, time: number): void {
    this.pendingToolTimes.set(callId, time)
  }

  /** When a still-open tool call started, for the status row's elapsed suffix. */
  toolStartedAt(callId: string): number | undefined {
    return this.pendingToolTimes.get(callId)
  }

  /** `tool/result`: add the elapsed tool time, once. */
  noteToolEnd(callId: string, time: number): void {
    const dispatchedAt = this.pendingToolTimes.get(callId)
    if (dispatchedAt === undefined) return
    this.stats.toolMs += Math.max(0, time - dispatchedAt)
    this.pendingToolTimes.delete(callId)
  }

  /** `step/end`: count the step, and forget the step's usage dedupe key. */
  noteStepEnd(turn: number, step: number): void {
    if (this.lastTurn !== turn) {
      this.stats.turns += 1
      this.lastTurn = turn
    }
    this.stats.steps += 1
    this.openStep = undefined
    this.live.reset()
    // Usage accounting is complete for this step; the map only exists to
    // deduplicate repeated usage reports during the step.
    this.usageByStep.delete(`${turn}:${step}`)
  }

  /** `turn/end`: a tool whose result never arrived contributes nothing. */
  noteTurnEnd(): void {
    this.pendingToolTimes.clear()
  }

  /** Current totals. A copy: callers cannot disturb the accumulator. */
  snapshot(): SessionStatsSnapshot {
    return { ...this.stats, usage: { ...this.stats.usage } }
  }
}
