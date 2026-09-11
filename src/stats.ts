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

export interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
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
}

export interface OpenStep {
  turn: number
  step: number
}

export function emptySessionUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
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
    usage: emptySessionUsage(),
  }
}

/** Flatten a snapshot into the footer's row shape. */
export function statsRowOf(stats: SessionStatsSnapshot): SessionStatsRow {
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

  /** The step a live chunk belongs to when the host frame carried none. */
  currentStep(): OpenStep | undefined {
    const open = this.openStep
    return open === undefined ? undefined : { turn: open.turn, step: open.step }
  }

  /** `step/start`: opens the clock LLM time, TTFT and decode are measured from. */
  noteStepStart(turn: number, step: number, time: number): void {
    this.openStep = { turn, step, startTime: time, firstTokenTime: null }
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
    const next: SessionUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
    }
    const previous = this.usageByStep.get(key)
    const totals = this.stats.usage
    this.stats.usage = {
      inputTokens: totals.inputTokens - (previous?.inputTokens ?? 0) + next.inputTokens,
      outputTokens: totals.outputTokens - (previous?.outputTokens ?? 0) + next.outputTokens,
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
          this.stats.decodeMs += Math.max(0, input.time - firstTokenTime)
          this.stats.decodeTokens += outputTokens
        }
      }
      this.openStep = undefined
    }
  }

  /** `tool/call`: start the tool clock for this call. */
  noteToolStart(callId: string, time: number): void {
    this.pendingToolTimes.set(callId, time)
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
