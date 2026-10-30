#!/usr/bin/env node
/**
 * PERF-085-LONG-R3: synthetic tool-event replay through actual SshTui.
 *
 * Unlike bench-long-plan, this drives applySessionEvent and counts actual
 * questionProjection.stateOf requests. This is NOT full cold Host restoration
 * or an end-to-end resume time measurement; the private clone Gate owns that.
 * No real session data, no network, no external provider or credentials.
 */
import { performance } from 'node:perf_hooks'
import { SshTui } from '../lib/tui.js'

function run(totalEvents) {
  const askIds = []
  const nTools = Math.floor(totalEvents / 2)
  for (let i = 0; i < nTools; i += 1) {
    if (i % 700 === 0) askIds.push('ask-' + i)
  }
  const settled = askIds.map(callId => ({
    callId, answers: [{ id: 'q1', selected: ['synthetic'] }],
  }))
  let stateOfReads = 0
  const ctx = {
    get(name) {
      if (name === 'sessionProjections') return {
        stateOf() {
          stateOfReads += 1
          return { questions: { active: [], settled } }
        },
      }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'synthetic-r3-bench', status: 'idle', options: {},
    session: { id: 'synthetic-r3-bench', events: [] },
    cancel() {}, steer() {}, followup() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: agent.id, headlessDisplay: true, color: false,
  })
  tui.replaying = true
  tui.loadingHistory = true

  const started = performance.now()
  for (let seq = 0; seq < totalEvents; seq += 1) {
    const id = Math.floor(seq / 2)
    const callId = id % 700 === 0 ? 'ask-' + id : 'ordinary-' + id
    const asking = id % 700 === 0
    const event = seq % 2 === 0 ? {
      type: 'tool/call', seq,
      data: {
        name: asking ? 'ask_user_question' : 'shell',
        callId,
        arguments: asking
          ? '{"questions":[{"id":"q1","question":"Synthetic question?","timeout":60000}],"timeout":60000}'
          : '{}',
      },
    } : {
      type: 'tool/result', seq,
      data: {
        message: {
          role: 'tool',
          source: { callId },
          content: [{ type: 'text', text: 'synthetic output' }],
        },
      },
    }
    tui.handleSessionEvent({ id: agent.id }, { ...event, time: 1700000000000 })
  }
  const elapsed = performance.now() - started
  const expectedReads = askIds.length * 2
  if (stateOfReads !== expectedReads) {
    throw new Error('stateOf reads: ' + stateOfReads + ' expected ' + expectedReads)
  }
  if (tui.questionCards.size !== askIds.length) {
    throw new Error('question card identities: ' + tui.questionCards.size + ' expected ' + askIds.length)
  }
  return {
    events: totalEvents,
    expectedQuestionCalls: askIds.length,
    questionProjectionReads: stateOfReads,
    retainedRows: tui.rows.length,
    elapsedMs: Math.round(elapsed * 100) / 100,
  }
}

console.log(JSON.stringify({
  benchmark: 'question-replay-synthetic-through-SshTui',
  node: process.version,
  notFullColdResume: true,
  samples: [5000, 20000, 55000].map(run),
}, null, 2))
