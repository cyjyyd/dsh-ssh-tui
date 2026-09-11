/**
 * The session-stat arithmetic the footer and `/status` stand on: usage that is
 * reported more than once per step, TTFT latching, decode rate, and tool time.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { SessionStatsTracker, emptySessionStats, statsRowOf } from '../lib/stats.js'

test('a step reported twice is counted once, and a changed report replaces it', () => {
  const stats = new SessionStatsTracker()
  stats.recordUsage(1, 1, { inputTokens: 10, outputTokens: 40 })
  stats.recordUsage(1, 1, { inputTokens: 10, outputTokens: 40 })
  assert.equal(stats.snapshot().usage.inputTokens, 10)
  assert.equal(stats.snapshot().usage.outputTokens, 40)
  // The host re-reports the step with a corrected sample: replace, don't add.
  stats.recordUsage(1, 1, { inputTokens: 12, outputTokens: 45 })
  assert.equal(stats.snapshot().usage.inputTokens, 12)
  assert.equal(stats.snapshot().usage.outputTokens, 45)
  // A second step accumulates on top of the first.
  stats.recordUsage(1, 2, { inputTokens: 5, outputTokens: 10 })
  assert.deepEqual(stats.snapshot().usage, {
    inputTokens: 17, outputTokens: 55, cacheReadTokens: 0, cacheWriteTokens: 0,
  })
})

test('missing cache counters count as zero, present ones are kept', () => {
  const stats = new SessionStatsTracker()
  stats.recordUsage(1, 1, { inputTokens: 1, outputTokens: 2 })
  stats.recordUsage(1, 2, { inputTokens: 3, outputTokens: 4, cacheReadTokens: 100, cacheWriteTokens: 7 })
  assert.deepEqual(stats.snapshot().usage, {
    inputTokens: 4, outputTokens: 6, cacheReadTokens: 100, cacheWriteTokens: 7,
  })
})

test('turns count once per turn even when several steps run', () => {
  const stats = new SessionStatsTracker()
  stats.noteStepEnd(1, 1)
  stats.noteStepEnd(1, 2)
  stats.noteStepEnd(1, 3)
  assert.equal(stats.snapshot().turns, 1)
  assert.equal(stats.snapshot().steps, 3)
  stats.noteStepEnd(2, 1)
  assert.equal(stats.snapshot().turns, 2)
  assert.equal(stats.snapshot().steps, 4)
})

test('TTFT latches on the first token and survives later deltas', () => {
  const stats = new SessionStatsTracker()
  stats.noteStepStart(1, 1, 1_000)
  stats.noteFirstToken(1, 1, 1_200)
  stats.noteFirstToken(1, 1, 1_900)        // a later delta must not move the clock
  stats.settleMessage({ turn: 1, step: 1, time: 2_000, outputTokens: 50 })
  const after = stats.snapshot()
  assert.equal(after.ttftMs, 200)
  assert.equal(after.ttftSteps, 1)
  assert.equal(after.llmMs, 1_000)
  assert.equal(after.decodeMs, 800)
  assert.equal(after.decodeTokens, 50)
})

test('the settlement packed stream wins over the live latch', () => {
  const stats = new SessionStatsTracker()
  stats.noteStepStart(1, 1, 1_000)
  // The failed attempt's first token is still latched when the retry settles.
  stats.noteFirstToken(1, 1, 1_100)
  stats.settleMessage({ turn: 1, step: 1, time: 2_000, firstTokenTime: 1_800, outputTokens: 25 })
  const after = stats.snapshot()
  assert.equal(after.ttftMs, 800, 'the settlement owns the clock')
  assert.equal(after.decodeMs, 200, 'decode spans the settled attempt only')
})

test('a token delta for a different step does not latch the open one', () => {
  const stats = new SessionStatsTracker()
  stats.noteStepStart(1, 1, 1_000)
  stats.noteFirstToken(1, 2, 1_100)
  stats.settleMessage({ turn: 1, step: 1, time: 2_000 })
  assert.equal(stats.snapshot().ttftSteps, 0, 'no latch, so no TTFT sample')
  assert.equal(stats.snapshot().llmMs, 1_000, 'the LLM span still settles')
})

test('decode needs a finite, non-negative token count', () => {
  const cases = [undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]
  for (const outputTokens of cases) {
    const stats = new SessionStatsTracker()
    stats.noteStepStart(1, 1, 1_000)
    stats.noteFirstToken(1, 1, 1_200)
    stats.settleMessage({ turn: 1, step: 1, time: 2_000, outputTokens })
    assert.equal(stats.snapshot().decodeTokens, 0, `outputTokens=${String(outputTokens)}`)
    assert.equal(stats.snapshot().ttftSteps, 1, 'TTFT is still known')
  }
})

test('a settlement before the first token cannot report a negative decode span', () => {
  const stats = new SessionStatsTracker()
  stats.noteStepStart(1, 1, 2_000)
  // 0.1.2 replays can hand a packed first-token time from before the step start.
  stats.settleMessage({ turn: 1, step: 1, time: 2_500, firstTokenTime: 1_500, outputTokens: 10 })
  const after = stats.snapshot()
  assert.equal(after.ttftMs, 0, 'clamped at zero')
  assert.equal(after.decodeMs, 1_000, 'decode keeps the real span')
})

test('tool time is added once, and a result that never arrives adds nothing', () => {
  const stats = new SessionStatsTracker()
  stats.noteToolStart('call-1', 1_000)
  stats.noteToolEnd('call-1', 1_250)
  stats.noteToolEnd('call-1', 9_999)       // a duplicate result cannot double count
  assert.equal(stats.snapshot().toolMs, 250)

  stats.noteToolStart('call-2', 2_000)
  stats.noteTurnEnd()                      // the turn ended first: no elapsed time
  stats.noteToolEnd('call-2', 2_500)
  assert.equal(stats.snapshot().toolMs, 250)
})

test('a repeated usage report after step/end counts as a new sample', () => {
  // The dedupe key exists to collapse reports *within* a step; a late report
  // after settlement is the host describing a different step.
  const stats = new SessionStatsTracker()
  stats.recordUsage(1, 1, { inputTokens: 10, outputTokens: 40 })
  stats.noteStepEnd(1, 1)
  stats.recordUsage(1, 1, { inputTokens: 10, outputTokens: 40 })
  assert.equal(stats.snapshot().usage.outputTokens, 80)
})

test('snapshot is a copy', () => {
  const stats = new SessionStatsTracker()
  const snapshot = stats.snapshot()
  snapshot.turns = 99
  snapshot.usage.inputTokens = 99
  assert.equal(stats.snapshot().turns, 0)
  assert.equal(stats.snapshot().usage.inputTokens, 0)
})

test('the flat footer row mirrors the snapshot', () => {
  const stats = new SessionStatsTracker()
  stats.noteStepStart(1, 1, 100)
  stats.noteFirstToken(1, 1, 150)
  stats.noteToolStart('c', 160)
  stats.noteToolEnd('c', 200)
  stats.recordUsage(1, 1, { inputTokens: 7, outputTokens: 8, cacheReadTokens: 9, cacheWriteTokens: 10 })
  // The host order: the settlement lands before step/end closes the step.
  stats.settleMessage({ turn: 1, step: 1, time: 400, outputTokens: 8 })
  stats.noteStepEnd(1, 1)
  assert.deepEqual(statsRowOf(stats.snapshot()), {
    turns: 1,
    steps: 1,
    llmMs: 300,
    toolMs: 40,
    ttftMs: 50,
    ttftSteps: 1,
    decodeMs: 250,
    decodeTokens: 8,
    inputTokens: 7,
    outputTokens: 8,
    cacheReadTokens: 9,
    cacheWriteTokens: 10,
  })
  assert.deepEqual(statsRowOf(emptySessionStats()), {
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    ttftMs: 0,
    ttftSteps: 0,
    decodeMs: 0,
    decodeTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  })
})
