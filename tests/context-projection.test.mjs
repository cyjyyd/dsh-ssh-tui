/**
 * CONTEXT.C1 — pure projection and formatter contract.
 *
 * These cases are the RED→GREEN contract for the read-only /context view. They
 * deliberately describe what the Session log can prove, not a lifecycle state
 * the Host does not have.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import {
  MAX_CONTEXT_EVENTS,
  projectContext,
} from '../lib/context-projection.js'
import { formatContextList, formatContextPreview } from '../lib/context-format.js'

setLocale('en')

const header = {
  version: 4,
  id: 'session-c1',
  createdAt: 1,
  cwd: '/very/private/workspace',
  isSeeded: false,
  delegationDepth: 0,
}

const turnStart = (seq, turn = 1) => ({ type: 'turn/start', seq, time: seq + 1, data: { turn } })
const turnEnd = (seq, turn = 1, reason = { kind: 'completed' }) => ({ type: 'turn/end', seq, time: seq + 1, data: { turn, reason } })
const stepStart = (seq, turn = 1, step = 1) => ({ type: 'step/start', seq, time: seq + 1, data: { turn, step } })
const stepEnd = (seq, turn = 1, step = 1) => ({ type: 'step/end', seq, time: seq + 1, data: { turn, step } })
const user = (seq, text = 'synthetic question', source = { kind: 'user' }) => ({
  type: 'user/message', seq, time: seq + 1, surfaceOp: 'append',
  data: { id: `m${seq}`, role: 'user', source, content: [{ type: 'text', text }] },
})
const assistant = (seq, turn = 1, step = 1, extra = {}) => ({
  type: 'assistant/message', seq, time: seq + 1, surfaceOp: 'append',
  data: {
    turn, step,
    message: { id: `a${seq}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'synthetic answer' }] },
    stream: [],
    ...extra,
  },
})
const toolCall = (seq, turn = 1, step = 1, callId = `c${seq}`) => ({
  type: 'tool/call', seq, time: seq + 1,
  data: { turn, step, callId, name: 'read', arguments: '{"path":"/private/secret"}' },
})
const toolResult = (seq, turn = 1, step = 1, callId = `c${seq - 1}`, extra = {}) => ({
  type: 'tool/result', seq, time: seq + 1, surfaceOp: 'append',
  data: {
    turn, step,
    message: { id: `r${seq}`, role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'synthetic result' }] },
    ...extra,
  },
})
const seedMarker = (seq, inherited = true) => ({ type: 'session/end-seed', seq, time: seq + 1, data: inherited ? { inherited: true } : {} })

function project(events, overrides = {}) {
  return projectContext({
    header: header,
    eventCount: events.length,
    events,
    activeNodeSeqs: events.filter(event => event.type === 'user/message').map(event => event.seq),
    inheritedEventCount: 0,
    ...overrides,
  })
}

test('R1 only producer-declared user messages are candidate boundaries', () => {
  const events = [
    turnStart(0), user(1), user(2, 'injected', { kind: 'runtime-context' }), user(3, 'checkpoint', { kind: 'compact-checkpoint' }), user(4), turnEnd(5),
  ]
  const p = project(events)
  assert.equal(p.candidates.length, 2)
  assert.deepEqual(p.candidates.map(c => [c.startSeq, c.endSeq]), [[1, 3], [4, 5]])
  assert.equal(p.candidates[0].boundary, 'user-declared')
  assert.equal(p.candidates[0].heuristic, true)
})

test('R2 shadowedSeqs is authoritative; shadowedRange is never a seq interval', () => {
  const events = [
    user(1), assistant(2), user(3, 'context', { kind: 'runtime-context' }),
    { type: 'compaction/start', seq: 4, time: 5, data: { compactionId: 'c-1', turn: null } },
    {
      type: 'compaction/summary', seq: 5, time: 6,
      data: {
        compactionId: 'c-1', summary: [{ type: 'text', text: 'summary' }],
        shadowedRange: { start: 99, end: 1 }, shadowedSeqs: [1, 3], shadowedTokenCount: 7,
        provider: 'p', model: 'm',
      },
    },
    { type: 'user/message', seq: 6, time: 7, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, sourceEventSeqs: [4, 5, 1, 3], data: { id: 'checkpoint', role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] } },
    { type: 'compaction/end', seq: 7, time: 8, data: { compactionId: 'c-1', turn: null } },
  ]
  const p = project(events, { activeNodeSeqs: [6] })
  assert.deepEqual(p.compactions[0].shadowedSeqs, [1, 3])
  assert.equal(p.compactions[0].status, 'complete')
  assert.equal(p.compactions[0].replacementSeq, 6)
  assert.equal(p.candidates[0].shadowedNodes, 2)
  assert.equal(p.candidates[0].currentSurfaceNodes, 1)
  assert.equal(p.candidates.some(c => c.endSeq === 99), false)
})

test('R3 exact inherited cut requires header + tagged marker + inheritedEventCount', () => {
  const seeded = { ...header, isSeeded: true, parentSession: 'parent-c1' }
  const events = [user(0), seedMarker(1), user(2), turnStart(3), turnEnd(4)]
  const p = project(events, { header: seeded, inheritedEventCount: 1 })
  assert.equal(p.inherited?.verified, true)
  assert.equal(p.inherited?.cut, 1)
  assert.equal(p.inherited?.markerSeq, 1)
  assert.equal(p.candidates[0].startSeq, 2)

  const noCount = project(events, { header: seeded, inheritedEventCount: undefined })
  assert.equal(noCount.inherited, undefined)
  assert.equal(noCount.candidates.length, 0, 'fail closed when the exact cut is unknown')
  assert.ok(noCount.warnings.includes('INHERITED_COUNT_UNAVAILABLE'))

  const untagged = project([seedMarker(1, false), user(2)], { header: seeded, inheritedEventCount: 1 })
  assert.equal(untagged.inherited, undefined)
  assert.equal(untagged.candidates.length, 0)
  assert.ok(untagged.warnings.includes('INHERITED_MARKER_UNAVAILABLE'))
})

test('R4 open tail is heuristic; only committed interrupted closer is durable', () => {
  const open = project([turnStart(0), user(1)])
  assert.equal(open.interrupted?.state, 'open-heuristic')
  assert.equal(open.interrupted?.turn, 1)

  const durable = project([turnStart(0), user(1), turnEnd(2, 1, { kind: 'interrupted' })])
  assert.equal(durable.interrupted?.state, 'durable')
  assert.equal(durable.interrupted?.seq, 2)
})

test('R5 incomplete and failed compaction are not complete', () => {
  const incomplete = project([
    { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c-1', turn: null } },
    { type: 'compaction/summary', seq: 1, time: 2, data: { compactionId: 'c-1', summary: [], shadowedRange: { start: 1, end: 1 }, shadowedSeqs: [], shadowedTokenCount: 0, provider: 'p', model: 'm' } },
  ])
  assert.equal(incomplete.compactions[0].status, 'incomplete')

  const failed = project([
    { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c-1', turn: null } },
    { type: 'compaction/end', seq: 1, time: 2, data: { compactionId: 'c-1', turn: null, error: 'boom' } },
  ])
  assert.equal(failed.compactions[0].status, 'failed')
  assert.equal(failed.compactions[0].error, 'boom')
})

test('R6 prune marks exact nodes; it never means whole-Segment deletion', () => {
  const events = [
    user(1), toolCall(2), toolResult(3),
    { type: 'compaction/prune', seq: 4, time: 5, data: { shadowedRange: { start: 3, end: 3 }, shadowedSeqs: [3], shadowedTokenCount: 9 } },
    { type: 'tool/result', seq: 5, time: 6, surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, sourceEventSeqs: [3], data: { turn: 1, step: 1, message: { id: 'r5', role: 'tool', source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'text', text: 'trimmed' }] } } },
  ]
  const p = project(events, { activeNodeSeqs: [1, 2, 5] })
  assert.deepEqual(p.prunes[0].shadowedSeqs, [3])
  assert.equal(p.prunes[0].replacementSeq, 5)
  assert.equal(p.candidates[0].prunedNodes, 1)
  assert.equal(p.deleted, 'NOT_REPRESENTED')
})

test('R7 missing current surface is explicit; it never assumes all nodes are current', () => {
  const p = project([user(1), assistant(2)], { activeNodeSeqs: undefined })
  assert.equal(p.currentSurface, 'unavailable')
  assert.equal(p.candidates[0].currentSurfaceNodes, 0)
  assert.ok(p.warnings.includes('CURRENT_SURFACE_UNAVAILABLE'))
})

test('R8 cap and unknown count fail closed before any event work', () => {
  const capped = project([], { eventCount: MAX_CONTEXT_EVENTS + 1 })
  assert.equal(capped.limitExceeded, true)
  assert.equal(capped.candidates.length, 0)
  assert.ok(capped.warnings.includes('EVENT_LIMIT_EXCEEDED'))

  const unknown = project([], { eventCount: undefined })
  assert.equal(unknown.limitExceeded, false)
  assert.equal(unknown.candidates.length, 0)
  assert.ok(unknown.warnings.includes('EVENT_COUNT_UNAVAILABLE'))
})

test('R9 overlapping compactions both survive; candidate shadow count is unique', () => {
  const events = [
    user(1), assistant(2), user(3),
    { type: 'compaction/start', seq: 4, time: 5, data: { compactionId: 'c-1', turn: null } },
    { type: 'compaction/summary', seq: 5, time: 6, data: { compactionId: 'c-1', summary: [], shadowedRange: { start: 2, end: 1 }, shadowedSeqs: [1, 2], shadowedTokenCount: 1, provider: 'p', model: 'm' } },
    { type: 'compaction/end', seq: 6, time: 7, data: { compactionId: 'c-1', turn: null } },
    { type: 'compaction/start', seq: 7, time: 8, data: { compactionId: 'c-2', turn: null } },
    { type: 'compaction/summary', seq: 8, time: 9, data: { compactionId: 'c-2', summary: [], shadowedRange: { start: 9, end: 1 }, shadowedSeqs: [2, 3], shadowedTokenCount: 2, provider: 'p', model: 'm' } },
    { type: 'compaction/end', seq: 9, time: 10, data: { compactionId: 'c-2', turn: null } },
  ]
  const p = project(events, { activeNodeSeqs: [] })
  assert.equal(p.compactions.length, 2)
  assert.deepEqual(p.compactions.map(c => c.shadowedSeqs), [[1, 2], [2, 3]])
  assert.equal(p.candidates[0].shadowedNodes, 2)
  assert.deepEqual(p.candidates[0].compactionIds, ['c-1', 'c-2'])
})

test('R10 archive is UNAVAILABLE and deleted is NOT_REPRESENTED', () => {
  const p = project([user(1)], { activeNodeSeqs: [1] })
  assert.equal(p.archive, 'UNAVAILABLE')
  assert.equal(p.deleted, 'NOT_REPRESENTED')
})

test('R11 no direct user boundary produces no candidate claim', () => {
  const p = project([turnStart(0), assistant(1), turnEnd(2)], { activeNodeSeqs: [1] })
  assert.equal(p.candidates.length, 0)
  assert.ok(p.warnings.includes('NO_DIRECT_USER_BOUNDARY'))
})

test('R12 turn/step counts and event types are attached to the candidate', () => {
  const events = [
    turnStart(0, 2), stepStart(1, 2, 1), user(2), assistant(3, 2, 1), toolCall(4, 2, 1), toolResult(5, 2, 1), stepEnd(6, 2, 1), turnEnd(7, 2),
  ]
  const p = project(events, { activeNodeSeqs: [2, 3, 5] })
  const c = p.candidates[0]
  assert.equal(c.turnStart, 2)
  assert.equal(c.turnEnd, 2)
  assert.equal(c.counts.user, 1)
  assert.equal(c.counts.assistant, 1)
  assert.equal(c.counts.toolCall, 1)
  assert.equal(c.counts.toolResult, 1)
  assert.equal(c.stepCount, 1)
})

test('R26 multiple direct user messages in one turn remain separate heuristic candidates', () => {
  const p = project([
    turnStart(0), user(1), user(2, 'same-turn steering'), assistant(3), turnEnd(4),
  ])
  assert.equal(p.candidates.length, 2)
  assert.deepEqual(p.candidates.map(c => [c.startSeq, c.endSeq]), [[1, 1], [2, 4]])
  assert.deepEqual(p.candidates.map(c => [c.turnStart, c.turnEnd]), [[1, 1], [1, 1]])
  assert.equal(p.candidates[0].counts.user, 1)
  assert.equal(p.candidates[1].counts.user, 1)
  assert.equal(p.candidates.every(c => c.heuristic && c.boundary === 'user-declared'), true)
  assert.equal(p.warnings.includes('NO_DIRECT_USER_BOUNDARY'), false)
})

test('R27 injected and Goal-continuation messages never split a candidate', () => {
  const p = project([
    turnStart(0),
    user(1),
    user(2, 'goal continuation', { kind: 'goal', goalId: 'g-1', revision: 2, round: 1 }),
    user(3, 'runtime context', { kind: 'runtime-context' }),
    user(4, 'compaction checkpoint', { kind: 'compact-checkpoint' }),
    assistant(5),
    turnEnd(6),
  ])
  assert.equal(p.candidates.length, 1)
  assert.equal(p.candidates[0].startSeq, 1)
  assert.equal(p.candidates[0].endSeq, 6)
  assert.equal(p.candidates[0].counts.user, 4)
  assert.equal(p.candidates[0].boundary, 'user-declared')
  assert.equal(p.candidates[0].heuristic, true)
})

test('R28 only a complete compaction is labelled COMPRESSED', () => {
  const complete = project([
    { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c-complete', turn: null } },
    { type: 'compaction/summary', seq: 1, time: 2, data: { compactionId: 'c-complete', summary: [], shadowedRange: { start: 1, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1, provider: 'p', model: 'm' } },
    { type: 'user/message', seq: 2, time: 3, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0, 1], data: { id: 'r', role: 'user', source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] } },
    { type: 'compaction/end', seq: 3, time: 4, data: { compactionId: 'c-complete', turn: null } },
  ])
  const completeText = formatContextList(complete, t).lines.map(line => line.text).join('\n')
  assert.match(completeText, /\[COMPRESSED\]/)
  assert.doesNotMatch(completeText, /\[COMPACTION\]/)

  const failed = project([
    { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c-failed', turn: null } },
    { type: 'compaction/end', seq: 1, time: 2, data: { compactionId: 'c-failed', turn: null, error: 'boom' } },
  ])
  const failedText = formatContextList(failed, t).lines.map(line => line.text).join('\n')
  assert.match(failedText, /\[COMPACTION\]/)
  assert.match(failedText, /status: failed/)
  assert.doesNotMatch(failedText, /\[COMPRESSED\]/)

  const incomplete = project([
    { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c-incomplete', turn: null } },
    { type: 'compaction/summary', seq: 1, time: 2, data: { compactionId: 'c-incomplete', summary: [], shadowedRange: { start: 0, end: 0 }, shadowedSeqs: [0], shadowedTokenCount: 1, provider: 'p', model: 'm' } },
  ])
  const incompleteText = formatContextList(incomplete, t).lines.map(line => line.text).join('\n')
  assert.match(incompleteText, /\[COMPACTION\]/)
  assert.match(incompleteText, /status: incomplete/)
  assert.doesNotMatch(incompleteText, /\[COMPRESSED\]/)
})

test('R29 compaction preview truncates seq rendering but keeps the exact count', () => {
  const shadowedSeqs = Array.from({ length: 200 }, (_, index) => index)
  const p = project([
    { type: 'compaction/start', seq: 0, time: 1, data: { compactionId: 'c-large', turn: null } },
    { type: 'compaction/summary', seq: 1, time: 2, data: { compactionId: 'c-large', summary: [], shadowedRange: { start: 199, end: 0 }, shadowedSeqs, shadowedTokenCount: 200, provider: 'p', model: 'm' } },
  ])
  assert.equal(p.compactions[0].shadowedSeqs.length, 200)
  const view = formatContextList(p, t)
  const row = view.items.find(item => item.kind === 'compaction')
  assert.ok(row)
  const text = formatContextPreview(row, t).lines.map(line => line.text).join('\n')
  assert.match(text, /shadowed seqs:/)
  assert.match(text, /truncated/)
  assert.match(text, /\+\d+ more/)
  assert.ok(text.length < 1200)
  assert.equal((text.match(/,/gu) ?? []).length < 200, true)
})

test('R30 a step span crossing candidate boundaries counts once per overlap', () => {
  const p = project([
    turnStart(0), stepStart(1), user(2), assistant(3), user(4), toolCall(5), stepEnd(6), user(7),
  ])
  assert.deepEqual(p.candidates.map(c => [c.startSeq, c.endSeq]), [[2, 3], [4, 6], [7, 7]])
  assert.deepEqual(p.candidates.map(c => c.stepCount), [1, 1, 0])
  assert.deepEqual(p.candidates.map(c => [c.turnStart, c.turnEnd]), [[1, 1], [1, 1], [1, 1]])
})

test('R13 formatter labels CURRENT SURFACE, never a stable ACTIVE lifecycle', () => {
  const p = project([user(1), assistant(2)], { activeNodeSeqs: [1, 2] })
  const view = formatContextList(p, t)
  const text = view.lines.map(line => line.text).join('\n')
  assert.match(text, /CURRENT SURFACE/)
  assert.doesNotMatch(text, /\[ACTIVE\]/)
  assert.doesNotMatch(text, /ACTIVE Segment/)
  assert.equal(text.includes(header.cwd), false)
  assert.match(text, /SESSION ARCHIVE STATE/)
  assert.match(text, /UNAVAILABLE/)
  assert.match(text, /NOT_REPRESENTED/)
})

test('R14 preview exposes exact seq/counts and keeps content/paths hidden', () => {
  const p = project([user(0), assistant(1), toolCall(2), toolResult(3)], { activeNodeSeqs: [0, 1, 3] })
  const view = formatContextList(p, t)
  const row = view.items.find(item => item.kind === 'candidate')
  assert.ok(row)
  const preview = formatContextPreview(row, t)
  const text = preview.lines.map(line => line.text).join('\n')
  assert.match(text, /seq 0\.\.3/)
  assert.match(text, /events 4/)
  assert.match(text, /user 1/)
  assert.match(text, /tool calls 1/)
  assert.doesNotMatch(text, /private|secret|synthetic question|synthetic answer/)
  assert.doesNotMatch(text, new RegExp(header.cwd.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
})

test('R15 limit-exceeded formatter is summary-only and makes no candidate claim', () => {
  const p = project([], { eventCount: MAX_CONTEXT_EVENTS + 1 })
  const text = formatContextList(p, t).lines.map(line => line.text).join('\n')
  assert.match(text, /250000/)
  assert.match(text, /limit/i)
  assert.doesNotMatch(text, /Candidate 1/)
})

test('R25 bilingual formatter keeps the same evidence, no raw paths', () => {
  const p = project([user(1), assistant(2)], { activeNodeSeqs: [1, 2] })
  setLocale('zh')
  try {
    const text = formatContextList(p, t).lines.map(line => line.text).join('\n')
    assert.match(text, /只读/)
    assert.match(text, /会话归档状态/)
    assert.match(text, /NOT_REPRESENTED/)
    assert.equal(text.includes(header.cwd), false)
  } finally {
    setLocale('en')
  }
})
