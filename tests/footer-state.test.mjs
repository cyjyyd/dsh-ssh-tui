import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { footerActivity } from '../lib/footer.js'
import { SshTui } from '../lib/tui.js'

/**
 * The footer's activity chip has to keep moving.
 *
 * Two stuck states were reported from a real session:
 *
 * 1. "重试 1/5" stayed on screen long after the retry had recovered, because
 *    `llmRetry` was only cleared by the *next* `turn/start`.
 * 2. A compaction that ended fell back to that same stale retry chip instead of
 *    to 运行中.
 *
 * These read the painted frame, because that is where the user saw it.
 */
setLocale('zh')

function makeTui(status = 'running') {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status,
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return { tui: new SshTui(ctx, agent, { sessionId: 'main-session', color: false }), agent }
}

/** The activity chip: the last 运行中/压缩中/重试/空闲 line, which is the footer. */
function activityLine(tui) {
  const hits = tui.captureFrame(90, 24)
    .map(line => line.replace(/\u001b\[[0-9;]*m/gu, ''))
    .filter(line => /运行中|压缩中|重试|空闲|等待/.test(line))
  return hits.at(-1) ?? ''
}

const send = (tui, agent, type, data) => tui.handleSessionEvent(agent.session, { type, time: Date.now(), data })

test('the retry chip yields as soon as the retry is in flight', () => {
  const { tui, agent } = makeTui()
  send(tui, agent, 'turn/start', { turn: 1 })
  assert.match(activityLine(tui), /运行中/)

  send(tui, agent, 'llm/retry', { retry: 1, maxRetries: 5, delayMs: 800, failure: { message: 'TRANSPORT' } })
  assert.match(activityLine(tui), /重试 1\/5/, 'the backoff is announced')

  // The request is being retried now: the chip must not hold the backoff state
  // until the next turn starts.
  send(tui, agent, 'llm/retry-started', { retry: 1 })
  assert.match(activityLine(tui), /运行中/, 'the chip goes back to the running state')
  assert.doesNotMatch(activityLine(tui), /重试/)
})

test('a retry cannot outlive its turn', () => {
  const { tui, agent } = makeTui()
  send(tui, agent, 'turn/start', { turn: 1 })
  send(tui, agent, 'llm/retry', { retry: 2, maxRetries: 5, delayMs: 400, failure: { message: 'SERVER' } })
  assert.match(activityLine(tui), /重试 2\/5/)

  send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  agent.status = 'idle'
  assert.match(activityLine(tui), /空闲/, 'an idle footer never shows a retry')
})

test('a compaction ending returns to the running state, not to a stale retry', () => {
  const { tui, agent } = makeTui()
  send(tui, agent, 'turn/start', { turn: 1 })
  send(tui, agent, 'llm/retry', { retry: 1, maxRetries: 5, delayMs: 200, failure: { message: 'TRANSPORT' } })
  send(tui, agent, 'llm/retry-started', { retry: 1 })

  send(tui, agent, 'compaction/start', { compactionId: 'c1', turn: 1 })
  assert.match(activityLine(tui), /压缩中/, 'compaction owns the chip while it runs')
  send(tui, agent, 'compaction/end', { compactionId: 'c1', turn: 1 })
  assert.match(activityLine(tui), /运行中/, 'and hands it back to the running turn')
})

test('an idle compaction shows as compacting, then as idle', () => {
  const { tui, agent } = makeTui('idle')
  send(tui, agent, 'compaction/start', { compactionId: 'c2', sourceCommandId: 'cmd-1', turn: null })
  assert.match(activityLine(tui), /压缩中/)
  send(tui, agent, 'compaction/end', { compactionId: 'c2', sourceCommandId: 'cmd-1', turn: null })
  assert.match(activityLine(tui), /空闲/)
})

test('the footer never renders a retry chip while the turn is idle', () => {
  const base = {
    running: false,
    compacting: false,
    subagents: 0,
    tools: 0,
    planLeftOpen: false,
    planPending: false,
    planActive: false,
    idleMs: 0,
    foldedInput: false,
    multiLineInput: false,
    queued: 0,
  }
  assert.equal(footerActivity({ ...base, retry: { retry: 1, maxRetries: 5 } }).kind, 'idle')
  assert.equal(footerActivity({ ...base, running: true, retry: { retry: 1, maxRetries: 5 } }).kind, 'retry')
  assert.equal(footerActivity({ ...base, running: true, compacting: true, retry: { retry: 1, maxRetries: 5 } }).kind, 'compacting')
})
