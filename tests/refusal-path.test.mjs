import test from 'node:test'
import assert from 'node:assert/strict'

import { classifyAuthFailure, isContentRefusedFailure } from '../lib/auth-failure.js'
import { streamUsage } from '../lib/dsh-compat.js'
import { SshTui } from '../lib/tui.js'

/**
 * rc.4 turns a content refusal into a first-class failure:
 *
 *   DeepSeek refused to answer under its content safety review[: <explanation>]
 *
 * The explanation is provider text, so it may itself contain words the auth
 * classifier looks for ("unauthorized", "quota", "forbidden"). The refusal
 * prefix is the authoritative class: it must never produce auth advice or the
 * opt-in auth retry, and the usage rc.4 now emits before the error must survive
 * both the live path and a replay of the durable `assistant/attempt`.
 */

const REFUSAL = 'DeepSeek refused to answer under its content safety review'
const REFUSAL_EXPLAINED = `${REFUSAL}: blocked: synthetic policy test`
// The refusal explanation is provider text: this one quotes words that the auth
// classifier treats as a credential problem when it sees them alone.
const REFUSAL_AUTH_WORDS = `${REFUSAL}: blocked: unauthorized use of copyrighted material`

function makeTui() {
  const credentials = { resolve: async () => ({ value: 'x'.repeat(20) }), describe: async () => ({ configured: true }) }
  const ctx = { get: name => (name === 'credentials' ? credentials : undefined), on() { return () => {} } }
  const calls = []
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
    followup(message) { calls.push(message) },
    steer(message) { calls.push(message) },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.write = () => {}
  return { tui, agent, calls }
}

const send = (tui, agent, type, data) =>
  tui.handleSessionEvent(agent.session, { type, time: Date.now(), data })
const textRows = tui => tui.rows.filter(row => row.kind === 'system' || row.kind === 'error').map(row => String(row.text ?? ''))
const flush = () => new Promise(resolve => setImmediate(resolve))

/** Drive the live refusal shape: draft, usage chunk, then the failed turn. */
function liveRefusal(tui, agent, message) {
  send(tui, agent, 'turn/start', { turn: 1 })
  send(tui, agent, 'step/start', { turn: 1, step: 1 })
  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 10, chunk: { type: 'text-delta', index: 0, text: 'draft before refusal' } },
  })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 11, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } } },
  })
  send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message, code: 'CONTENT_REFUSED' } } })
}

test('a live refusal keeps its billed usage and shows the provider explanation', () => {
  const { tui, agent } = makeTui()
  liveRefusal(tui, agent, REFUSAL_EXPLAINED)
  assert.deepEqual(
    { input: tui.stats.usage.inputTokens, output: tui.stats.usage.outputTokens, total: tui.stats.usage.reportedTokens },
    { input: 12, output: 5, total: 17 },
    'the usage chunk that precedes the error is counted',
  )
  const said = textRows(tui).join('\n')
  assert.match(said, /Turn 1 failed: DeepSeek refused to answer under its content safety review: blocked: synthetic policy test/u)
  assert.doesNotMatch(said, /retryauth|重试一次|提供商拒绝|没有可用的/u, 'a refusal is not an auth failure')
  assert.equal(tui.streaming, undefined, 'the partial draft is not left streaming')
  assert.equal(tui.rows.some(row => row.kind === 'assistant'), false, 'no partial assistant row is committed')
})

test('a refusal explanation cannot masquerade as an auth failure or trigger the auth retry', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  process.env.DSH_TUI_RETRY_PROVIDER_AUTH = 'on'
  try {
    const { tui, agent, calls } = makeTui()
    liveRefusal(tui, agent, REFUSAL_AUTH_WORDS)
    await flush()
    assert.equal(calls.length, 0, 'the opt-in auth retry must not resend a content refusal')
    const said = textRows(tui).join('\n')
    assert.doesNotMatch(said, /retryauth|重试一次|提供商拒绝了|没有可用的/u)
    assert.match(said, /content safety review: blocked: unauthorized/u, 'the refusal itself stays visible')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

test('a refusal with auth-shaped words is not classified as an auth failure', () => {
  assert.equal(classifyAuthFailure(REFUSAL), undefined)
  assert.equal(classifyAuthFailure(REFUSAL_EXPLAINED), undefined)
  assert.equal(classifyAuthFailure(REFUSAL_AUTH_WORDS), undefined, 'the explanation must not override the refusal class')
  // The guard is narrow: real auth failures still classify.
  assert.equal(classifyAuthFailure('OpenAI API error (403): Authentication failed')?.origin, 'provider')
  assert.equal(isContentRefusedFailure(REFUSAL), true)
  assert.equal(isContentRefusedFailure(`  ${REFUSAL}: blocked: anything`), true)
  assert.equal(isContentRefusedFailure('DeepSeek Messages stream: unsupported stop reason refusal'), false)
  assert.equal(isContentRefusedFailure(''), false)
})

test('streamUsage reads the last well-formed usage chunk from a packed attempt', () => {
  const packed = [
    { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } } },
    { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['x'] },
    // A later, un-totalled sample wins, matching recordUsage's replacement rule.
    { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 13, outputTokens: 6 } } },
    { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'CONTENT_REFUSED' } } } },
  ]
  assert.deepEqual(streamUsage(packed), { inputTokens: 13, outputTokens: 6 })
  assert.deepEqual(streamUsage([{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1 } } }]), undefined)
  assert.equal(streamUsage(undefined), undefined)
  assert.equal(streamUsage({}), undefined)
})

test('streamUsage rejects malformed counters and keeps the last valid sample', () => {
  const chunk = usage => ({ type: 'chunk', chunk: { type: 'usage', usage } })
  const valid = {
    inputTokens: 12, outputTokens: 5,
    totalTokens: 17, cacheReadTokens: 2, cacheWriteTokens: 3, reasoningTokens: 1,
  }
  const malformed = [
    { inputTokens: -1, outputTokens: 0 },
    { inputTokens: 1.5, outputTokens: 0 },
    { inputTokens: Number.NaN, outputTokens: 0 },
    { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 },
    { inputTokens: 0, outputTokens: -1 },
    { inputTokens: 0, outputTokens: 1.5 },
    { inputTokens: 0, outputTokens: Number.NaN },
    { inputTokens: 0, outputTokens: 0, totalTokens: -1 },
    { inputTokens: 0, outputTokens: 0, totalTokens: 1.5 },
    { inputTokens: 0, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { inputTokens: 0, outputTokens: 0, totalTokens: null },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: -1 },
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: '2' },
    { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 2.5 },
    { inputTokens: 0, outputTokens: 0, reasoningTokens: Number.NaN },
  ]
  for (const bad of malformed) {
    assert.deepEqual(
      streamUsage([chunk(valid), chunk(bad)]),
      valid,
      `a malformed sample must not displace the last valid one: ${JSON.stringify(bad)}`,
    )
  }
  // The safe-integer boundary is still a well-formed sample.
  const boundary = { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 }
  assert.deepEqual(streamUsage([chunk(boundary)]), boundary)
  assert.equal(
    streamUsage([chunk({ inputTokens: 0, outputTokens: 0, totalTokens: -1 })]),
    undefined,
    'a stream with only malformed samples has no usage to replay',
  )
})

test('streamUsage keeps absent optionals absent and present zeros present', () => {
  const chunk = usage => ({ type: 'chunk', chunk: { type: 'usage', usage } })
  assert.deepEqual(
    streamUsage([chunk({ inputTokens: 1, outputTokens: 2 })]),
    { inputTokens: 1, outputTokens: 2 },
    'no optional counter is fabricated as zero',
  )
  assert.deepEqual(
    streamUsage([chunk({ inputTokens: 1, outputTokens: 2, totalTokens: 0 })]),
    { inputTokens: 1, outputTokens: 2, totalTokens: 0 },
    'an explicit zero is a real reported total, not an absent one',
  )
  assert.deepEqual(
    streamUsage([chunk({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 })]),
    { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  )
})

test('a replayed attempt without a harness total keeps its billed parts', () => {
  const { tui, agent } = makeTui()
  tui.replaying = true
  try {
    send(tui, agent, 'turn/start', { turn: 1 })
    send(tui, agent, 'step/start', { turn: 1, step: 1 })
    send(tui, agent, 'assistant/attempt', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 10 } } }],
    })
    send(tui, agent, 'step/end', { turn: 1, step: 1 })
    // An attempt with no usage chunk at all must contribute nothing.
    send(tui, agent, 'turn/start', { turn: 2 })
    send(tui, agent, 'step/start', { turn: 2, step: 1 })
    send(tui, agent, 'assistant/attempt', {
      turn: 2,
      step: 1,
      stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['no usage here'] }],
    })
    send(tui, agent, 'step/end', { turn: 2, step: 1 })
  } finally {
    tui.replaying = false
  }
  const usage = tui.stats.usage
  assert.deepEqual(
    {
      input: usage.inputTokens,
      output: usage.outputTokens,
      reported: usage.reportedTokens,
      unreportedSteps: usage.unreportedSteps,
    },
    { input: 5, output: 10, reported: 0, unreportedSteps: 1 },
    'the un-totalled attempt is billed from its parts; the empty attempt adds nothing',
  )
})

test('a refusal turn does not duplicate tools or leak its draft into the next turn', () => {
  const { tui, agent } = makeTui()
  send(tui, agent, 'turn/start', { turn: 1 })
  send(tui, agent, 'step/start', { turn: 1, step: 1 })
  send(tui, agent, 'tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"path":"a"}' })
  send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: REFUSAL_EXPLAINED, code: 'CONTENT_REFUSED' } } })
  assert.equal(tui.openToolCalls.size, 0, 'turn/end clears the failed turn call state')
  const toolRows = tui.rows.filter(row => row.kind === 'tool').length

  send(tui, agent, 'turn/start', { turn: 2 })
  send(tui, agent, 'step/start', { turn: 2, step: 1 })
  send(tui, agent, 'assistant/message', {
    turn: 2, step: 1,
    message: { content: [{ type: 'text', text: 'second answer' }] },
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  })
  const assistant = tui.rows.filter(row => row.kind === 'assistant')
  assert.equal(assistant.length, 1)
  assert.match(String(assistant[0].text), /second answer/u)
  assert.equal(tui.rows.filter(row => row.kind === 'tool').length, toolRows, 'no tool call is replayed into the next turn')
  assert.equal(tui.rows.some(row => row.kind === 'assistant' && /draft before refusal/u.test(String(row.text ?? ''))), false)
})

test('a replayed rc.4 refusal keeps the usage stored in assistant/attempt', () => {
  const { tui, agent } = makeTui()
  // Shape taken from the rc.4 snapshot `snapshots/session/deepseek-content-refusal`:
  // an errored attempt carries its packed stream (usage included); `turn/end`
  // carries the failure. No `assistant/message` exists for this turn.
  const attempt = {
    turn: 1,
    step: 1,
    stream: [
      { type: 'chunk', time: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 0, index: 0, dt: [], texts: ['Draft returned before the provider refusal.'] },
      { type: 'chunk', time: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Draft returned before the provider refusal.' } } },
      { type: 'chunk', time: 0, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } } },
      { type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: REFUSAL, code: 'CONTENT_REFUSED' } } } },
    ],
  }
  tui.replaying = true
  try {
    send(tui, agent, 'turn/start', { turn: 1 })
    send(tui, agent, 'step/start', { turn: 1, step: 1 })
    send(tui, agent, 'assistant/attempt', attempt)
    send(tui, agent, 'step/end', { turn: 1, step: 1 })
    send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: REFUSAL, code: 'CONTENT_REFUSED' } } })
  } finally {
    tui.replaying = false
  }
  assert.deepEqual(
    { input: tui.stats.usage.inputTokens, output: tui.stats.usage.outputTokens, total: tui.stats.usage.reportedTokens },
    { input: 12, output: 5, total: 17 },
    'resume must agree with the live path about a billed refusal',
  )
  assert.equal(tui.rows.filter(row => row.kind === 'error').length, 1, 'the durable turn error still renders once')
  assert.equal(tui.rows.some(row => row.kind === 'assistant'), false, 'replay does not invent an assistant answer from the errored attempt')
})
