#!/usr/bin/env node
/**
 * PERF-085-LONG — safe, synthetic plan-recorder stress benchmark.
 *
 * This is NOT a cold resume benchmark: it exercises only the plan projection
 * recorder through SshTui, without persistence, provider calls or real session
 * data. Record the actual Host/restore/first-frame timings separately in the
 * private PERF-085-LONG-R1 protocol. Do not compare absolute times across CI.
 */
import { performance } from 'node:perf_hooks'
import { SshTui } from '../lib/tui.js'

function makeTui() {
  const ctx = { get() { return undefined }, on() { return () => {} } }
  const agent = {
    id: 'synthetic-benchmark', status: 'idle', options: {},
    session: { id: 'synthetic-benchmark', events: [] },
    cancel() {}, steer() {}, followup() {},
  }
  return new SshTui(ctx, agent, { sessionId: agent.id, headlessDisplay: true, color: false })
}

function run(eventCount) {
  const tui = makeTui()
  let relevant = 0
  let ordinary = 0
  const start = performance.now()
  for (let seq = 0; seq < eventCount; seq += 1) {
    const slot = seq % 5
    const call = Math.floor(seq / 5)
    if (slot === 0) {
      const isPlan = call % 300 === 0
      if (isPlan) relevant += 1
      else ordinary += 1
      tui.recordPlanEvent({
        type: 'tool/call', seq,
        data: {
          name: isPlan ? 'exit_plan_mode' : 'shell',
          callId: 'call-' + call,
          arguments: isPlan ? '{"plan":"# synthetic"}' : '{}',
        },
      })
    } else if (slot === 1) {
      tui.recordPlanEvent({
        type: 'tool/result', seq,
        data: {
          message: {
            source: { callId: 'call-' + call },
            content: [{ type: 'text', text: 'synthetic result' }],
            isError: false,
          },
        },
      })
    } else {
      tui.recordPlanEvent({ type: 'assistant/message', seq, data: {} })
    }
  }
  const elapsed = performance.now() - start
  const expected = relevant * 2
  if (tui.planEvents.length !== expected) {
    throw new Error('planEvents=' + tui.planEvents.length + ' expected=' + expected)
  }
  if (tui.planArtifacts.length === 0) {
    throw new Error('synthetic exit_plan_mode review was not projected')
  }
  return {
    events: eventCount,
    planCalls: relevant,
    unrelatedToolCalls: ordinary,
    planEvents: tui.planEvents.length,
    elapsedMs: Math.round(elapsed * 100) / 100,
    microsecondsPerEvent: Math.round(elapsed * 1000 / eventCount * 100) / 100,
  }
}

console.log(JSON.stringify({
  benchmark: 'plan-recorder-only',
  node: process.version,
  profile: 'synthetic',
  samples: [5000, 20000, 55000].map(run),
}, null, 2))
