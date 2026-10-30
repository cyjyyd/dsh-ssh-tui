/**
 * PERF-085-LONG-R3.F1 — canonical `toolCallId` settlement during replay.
 *
 * The projection below mirrors `@deepseek-ai/dsh-user-questions`'s durable fold
 * (request header timing, tool/call, tool/result by `message.toolCallId`, late
 * user-question reply). It exists so the card state is computed from the event
 * stream instead of a hand-swapped view.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SshTui } from '../lib/tui.js'

function upstreamProjection() {
  let timed = false
  let active = []
  let settled = []
  let reads = 0
  const parse = text => { try { return JSON.parse(text) } catch { return undefined } }
  const textOf = content => (content ?? []).find(block => block.type === 'text')?.text
  const apply = event => {
    if (event.type === 'request/header') {
      const tools = event.data?.header?.tools
      timed = Array.isArray(tools) && tools.some(tool =>
        tool?.name === 'ask_user_question'
        && tool.parameters !== null && typeof tool.parameters === 'object'
        && tool.parameters.properties !== null && typeof tool.parameters.properties === 'object'
        && 'timeout' in tool.parameters.properties)
      return
    }
    if (event.type === 'tool/call') {
      if (!timed || event.data?.name !== 'ask_user_question') return
      const questions = parse(event.data.arguments)?.questions
      if (!Array.isArray(questions) || questions.length === 0) return
      const callId = String(event.data.callId)
      active = active.filter(item => item.callId !== callId)
      active.push({ callId, state: 'open', questions })
      return
    }
    if (event.type === 'tool/result') {
      // Canonical key. The TUI's guard must agree with this field.
      const callId = String(event.data?.message?.toolCallId ?? '')
      const item = active.find(entry => entry.callId === callId)
      if (item === undefined) return
      const parsed = parse(textOf(event.data.message.content) ?? '')
      if (parsed?.pending === true) { item.state = 'continued'; return }
      const answers = event.data.error === undefined && event.data.message.isError !== true
        && Array.isArray(parsed?.answers) ? parsed.answers : null
      active = active.filter(entry => entry.callId !== callId)
      if (answers !== null) settled.push({ callId, answers })
      return
    }
    if (event.type === 'user/message') {
      if (event.data?.source?.kind !== 'user-question-reply') return
      const callId = String(event.data.source.callId)
      if (!active.some(item => item.callId === callId)) return
      const answers = Array.isArray(parse(textOf(event.data.content) ?? '')?.answers)
        ? parse(textOf(event.data.content)).answers : []
      active = active.filter(item => item.callId !== callId)
      settled.push({ callId, answers })
    }
  }
  return {
    apply,
    get reads() { return reads },
    stateOf() { reads += 1; return { questions: { active: structuredClone(active), settled: structuredClone(settled) } } },
  }
}

function fixture() {
  const projection = upstreamProjection()
  const ctx = {
    get(name) { return name === 'sessionProjections' ? projection : undefined },
    on() { return () => {} },
  }
  const agent = { id: 'r3f1', options: {}, status: 'idle', session: { id: 'r3f1', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: agent.id, headlessDisplay: true, color: false })
  tui.replaying = true
  tui.loadingHistory = true
  const send = event => {
    projection.apply(event)
    tui.handleSessionEvent({ id: agent.id }, { time: Date.parse('2026-10-01T00:00:00Z'), ...event })
  }
  return { tui, send, projection }
}

const header = seq => ({ type: 'request/header', seq, data: { header: { tools: [{ name: 'ask_user_question', parameters: { properties: { timeout: {} } } }] } } })
const legacyHeader = seq => ({ type: 'request/header', seq, data: { header: { tools: [{ name: 'ask_user_question', parameters: { properties: {} } }] } } })
const ask = (seq, callId = 'ask-q') => ({ type: 'tool/call', seq, data: { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions: [{ id: 'q1', question: 'Which environment?' }] }) } })
const result = (seq, message) => ({ type: 'tool/result', seq, data: { message } })
const answers = value => JSON.stringify({ answers: [{ id: 'q1', selected: [value] }] })

test('R3.F1 RED: canonical toolCallId alone settles the card', () => {
  const { tui, send } = fixture()
  send(header(1)); send(ask(2))
  assert.equal(tui.rows.find(row => row.kind === 'question')?.status, 'waiting')
  send(result(3, { role: 'tool', toolCallId: 'ask-q', source: {}, content: [{ type: 'text', text: answers('staging') }] }))
  const card = tui.rows.find(row => row.kind === 'question')
  assert.equal(card?.status, 'answered', `status=${card?.status}`)
  assert.equal(card?.summary, 'staging')
})

test('R3.F1 RED: toolCallId wins over a mismatched source.callId', () => {
  const { tui, send } = fixture()
  send(header(1)); send(ask(2))
  send(result(3, { role: 'tool', toolCallId: 'ask-q', source: { callId: 'other' }, content: [{ type: 'text', text: answers('prod') }] }))
  const card = tui.rows.find(row => row.kind === 'question')
  assert.equal(card?.status, 'answered', `status=${card?.status}`)
  assert.equal(card?.summary, 'prod')
})

test('R3.F1 reverse conflict: source.callId alone must not bind an ordinary result', () => {
  const { tui, send, projection } = fixture()
  send(header(1)); send(ask(2))
  const before = projection.reads
  send(result(3, { role: 'tool', toolCallId: 'ordinary', source: { callId: 'ask-q' }, content: [{ type: 'text', text: answers('prod') }] }))
  assert.equal(projection.reads, before, 'a non-question toolCallId must not trigger a projection read')
  assert.equal(tui.rows.find(row => row.kind === 'question')?.status, 'waiting')
})

test('R3.F1: source-only legacy result stays relevant through the fallback', () => {
  const { tui, send, projection } = fixture()
  send(header(1)); send(ask(2))
  const before = projection.reads
  // The rc.2 projection keys on toolCallId, so a source-only row cannot settle
  // it; the guard must still treat the row as question-relevant (legacy host).
  send(result(3, { role: 'tool', source: { callId: 'ask-q' }, content: [{ type: 'text', text: answers('legacy') }] }))
  assert.equal(projection.reads, before + 1, 'legacy source.callId fallback must still refresh')
  assert.equal(tui.rows.find(row => row.kind === 'question')?.status, 'waiting')
})

test('R3.F1: continued and cancelled settlement states', () => {
  const continued = fixture()
  continued.send(header(1)); continued.send(ask(2))
  continued.send(result(3, { role: 'tool', toolCallId: 'ask-q', source: {}, content: [{ type: 'text', text: '{"pending":true}' }] }))
  const openCard = continued.tui.rows.find(row => row.kind === 'question')
  assert.equal(openCard?.continued, true)
  assert.equal(openCard?.status, 'waiting')

  const cancelled = fixture()
  cancelled.send(header(1)); cancelled.send(ask(2))
  cancelled.send(result(3, { role: 'tool', toolCallId: 'ask-q', source: {}, content: [{ type: 'text', text: '{"answers":[]}' }] }))
  const cancelledCard = cancelled.tui.rows.find(row => row.kind === 'question')
  assert.equal(cancelledCard?.status, 'cancelled')
  assert.ok(cancelledCard?.summary !== undefined && cancelledCard.summary !== '')
})

test('R3.F1: legacy blocking header keeps a waiting card and no projection record', () => {
  const { tui, send } = fixture()
  send(legacyHeader(1)); send(ask(2))
  send(result(3, { role: 'tool', toolCallId: 'ask-q', source: {}, content: [{ type: 'text', text: answers('staging') }] }))
  assert.equal(tui.rows.find(row => row.kind === 'question')?.status, 'waiting')
})

test('R3.F1: late user-question reply remains synchronous', () => {
  const { tui, send } = fixture()
  send(header(1)); send(ask(2))
  send({ type: 'user/message', seq: 3, data: { source: { kind: 'user-question-reply', callId: 'ask-q' }, content: [{ type: 'text', text: answers('late') }] } })
  const card = tui.rows.find(row => row.kind === 'question')
  assert.equal(card?.status, 'answered')
  assert.equal(card?.summary, 'late')
})

test('R3.F1: question card keeps its position between ordinary rows', () => {
  const { tui, send } = fixture()
  send(header(1))
  send({ type: 'tool/call', seq: 2, data: { name: 'shell', callId: 'before', arguments: '{}' } })
  send({ type: 'tool/result', seq: 3, data: { message: { role: 'tool', toolCallId: 'before', source: { callId: 'before' }, content: [{ type: 'text', text: 'ok' }] } } })
  send(ask(4))
  send({ type: 'tool/call', seq: 5, data: { name: 'shell', callId: 'after', arguments: '{}' } })
  send(result(6, { role: 'tool', toolCallId: 'ask-q', source: {}, content: [{ type: 'text', text: answers('staging') }] }))
  const questionIndex = tui.rows.findIndex(row => row.kind === 'question')
  assert.ok(questionIndex > 0)
  assert.ok(tui.rows.slice(0, questionIndex).some(row => row.callId === 'before'))
  assert.ok(tui.rows.slice(questionIndex + 1).some(row => row.callId === 'after'))
})
