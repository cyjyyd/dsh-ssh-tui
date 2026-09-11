/**
 * Row storage and transcript windowing. These rules used to live in the paint
 * loop and the tool-event handlers, where a mistake shows up as "the tool card
 * lost its output" or "the transcript jumped" only in a live session.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_TRANSCRIPT_ROWS,
  archiveStalePlans,
  boundTranscriptRows,
  findLivePlanRow,
  findMergeableToolRow,
  findToolRowByCallId,
  mergeToolCard,
  planShouldDefaultExpand,
  windowTranscript,
} from '../lib/rows.js'

function toolRow(callId, overrides = {}) {
  return {
    kind: 'tool',
    callId,
    name: 'read',
    args: '{"path":"a.js"}',
    status: 'completed',
    output: 'body',
    title: 'read',
    summary: 'a.js',
    expanded: false,
    ...overrides,
  }
}

function planRow(overrides = {}) {
  return {
    kind: 'plan',
    active: false,
    pending: false,
    todos: [],
    expanded: false,
    archived: false,
    ...overrides,
  }
}

test('boundTranscriptRows keeps the newest rows and reports what left', () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ kind: 'system', text: `row ${i}` }))
  assert.equal(boundTranscriptRows(rows, 5), 0, 'under the limit: nothing moves')
  assert.equal(rows.length, 5)
  assert.equal(boundTranscriptRows(rows, 3), 2)
  assert.deepEqual(rows.map(row => row.text), ['row 2', 'row 3', 'row 4'])
})

test('the default row budget is the documented one', () => {
  assert.equal(MAX_TRANSCRIPT_ROWS, 5000)
})

test('a tool result finds its card through the merged call ids', () => {
  const rows = [
    toolRow('call-1', { mergedCallIds: ['call-0', 'call-1'] }),
    toolRow('call-2', { name: 'edit' }),
  ]
  assert.equal(findToolRowByCallId(rows, 'call-0')?.callId, 'call-1')
  assert.equal(findToolRowByCallId(rows, 'call-2')?.name, 'edit')
  assert.equal(findToolRowByCallId(rows, 'missing'), undefined)
})

test('only consecutive same-path reads merge onto one card', () => {
  const rows = [toolRow('call-1')]
  assert.equal(findMergeableToolRow(rows, { name: 'read', args: '{"path":"a.js"}' })?.callId, 'call-1')
  assert.equal(findMergeableToolRow(rows, { name: 'read', args: '{"path":"b.js"}' }), undefined)
  // A different kind of tool in between is its own card.
  assert.equal(findMergeableToolRow([toolRow('call-9', { name: 'bash', args: '{"command":"ls"}' })], {
    name: 'read', args: '{"path":"a.js"}',
  }), undefined)
})

test('merging a repeated call keeps prior output only when the attempt starts over', () => {
  const previous = toolRow('call-1', { output: 'first body', repeats: 1 })
  mergeToolCard(previous, {
    callId: 'call-2',
    name: 'read',
    args: '{"path":"a.js"}',
    title: '',
    summary: '',
  }, 10_000)
  assert.equal(previous.repeats, 2)
  assert.deepEqual(previous.mergedCallIds, ['call-1', 'call-2'])
  assert.equal(previous.callId, 'call-2', 'results for the newest id land here')
  assert.equal(previous.output, '', 'the previous attempt is stale')
  assert.equal(previous.status, 'running')
  assert.equal(previous.exitCode, undefined)
  assert.equal(previous.signal, undefined)
  assert.equal(previous.flipUntil, 10_000 + 280, 'the flip animation is armed')
  assert.equal(previous.title, 'read', 'an empty title keeps the old one')
  assert.equal(previous.summary, 'a.js')
})

test('a replayed merge does not arm the flip animation', () => {
  const previous = toolRow('call-1')
  mergeToolCard(previous, { callId: 'call-2', name: 'read', args: '{}', title: 't', summary: 's' }, 1_000, true)
  assert.equal(previous.flipUntil, undefined)
  assert.equal(previous.title, 't', 'a real title replaces the old one')
})

test('a repeat diff appends only after the first repeat', () => {
  const first = [{ path: 'a.js', lines: ['+1'] }]
  const second = [{ path: 'a.js', lines: ['+2'] }]
  const third = [{ path: 'a.js', lines: ['+3'] }]
  const previous = toolRow('call-1', { name: 'edit', diff: first, repeats: 1 })
  mergeToolCard(previous, { callId: 'call-2', name: 'edit', args: '{}', title: '', summary: '', diff: second }, 0)
  assert.deepEqual(previous.diff, second, 'the first merge replaces the diff')
  mergeToolCard(previous, { callId: 'call-3', name: 'edit', args: '{}', title: '', summary: '', diff: third }, 0)
  // Distinct payloads, so appending the *new* hunk is distinguishable from
  // appending the previous one again.
  assert.deepEqual(previous.diff, [second[0], third[0]], 'later merges stack the newest hunk')
})

test('the live plan is the newest one that still has work', () => {
  const finished = planRow({ todos: [{ content: 'done', status: 'completed' }] })
  const live = planRow({ active: true, todos: [{ content: 'next', status: 'pending' }] })
  const archived = planRow({ archived: true, active: true })
  assert.equal(findLivePlanRow([finished]), undefined, 'a completed list is not live')
  assert.equal(findLivePlanRow([finished, live, archived]), live)
  assert.equal(findLivePlanRow([live, planRow({ pending: true })]).pending, true, 'the newest live one wins')
})

test('archiving stale plans keeps the one that is still live', () => {
  const keep = planRow({ active: true })
  const old = planRow({ active: true, todos: [{ content: 'x', status: 'pending' }] })
  archiveStalePlans([old, keep], keep)
  assert.equal(old.archived, true)
  assert.equal(old.active, false)
  assert.equal(old.pending, false)
  assert.equal(old.expanded, false)
  assert.equal(keep.archived, false)
})

test('a plan with an in-progress todo opens by default', () => {
  assert.equal(planShouldDefaultExpand({ active: true, pending: false, todos: [] }), true)
  assert.equal(planShouldDefaultExpand({ active: false, pending: true, todos: [] }), true)
  assert.equal(planShouldDefaultExpand({
    active: false, pending: false, todos: [{ content: 'x', status: 'in_progress' }],
  }), true)
  assert.equal(planShouldDefaultExpand({
    active: false, pending: false, todos: [{ content: 'x', status: 'completed' }],
  }), false)
})

test('a transcript shorter than the window is padded at the top', () => {
  const window = windowTranscript({
    lines: ['one', 'two'],
    refs: [undefined, undefined],
    available: 5,
    scrollOffset: 0,
  })
  assert.equal(window.padding, 3)
  assert.deepEqual(window.visibleLines, ['', '', '', 'one', 'two'])
  assert.deepEqual(window.visibleRefs, [undefined, undefined, undefined, undefined, undefined])
  assert.equal(window.start, 0)
})

test('the newest lines are on screen, and refs follow them', () => {
  const rows = [1, 2, 3, 4, 5].map(n => ({ id: n }))
  const window = windowTranscript({
    lines: rows.map(row => `line ${row.id}`),
    refs: rows,
    available: 2,
    scrollOffset: 0,
  })
  assert.deepEqual(window.visibleLines, ['line 4', 'line 5'])
  assert.deepEqual(window.visibleRefs.map(ref => ref?.id), [4, 5])
  assert.equal(window.start, 3)
})

test('scrolling clamps at both ends of the transcript', () => {
  const lines = ['a', 'b', 'c', 'd']
  const atTop = windowTranscript({ lines, refs: [], available: 2, scrollOffset: 99 })
  assert.equal(atTop.scrollOffset, 2, 'cannot scroll past the first line')
  assert.deepEqual(atTop.visibleLines, ['a', 'b'])
  const negative = windowTranscript({ lines, refs: [], available: 2, scrollOffset: -5 })
  assert.equal(negative.scrollOffset, 0)
  assert.deepEqual(negative.visibleLines, ['c', 'd'])
})

test('a reveal scrolls the row into view and is not stored', () => {
  const rows = [1, 2, 3, 4, 5, 6].map(n => ({ id: n }))
  const lines = rows.map(row => `line ${row.id}`)
  const refs = [...rows]
  const window = windowTranscript({
    lines,
    refs,
    available: 2,
    scrollOffset: 0,
    reveal: refs[1],
  })
  assert.equal(window.scrollOffset, 3, 'the third line from the end')
  assert.deepEqual(window.visibleLines, ['line 2', 'line 3'])
  assert.deepEqual(window.visibleRefs, [refs[1], refs[2]], 'the visible window keeps its refs')
  // Windowing reads the transcript, it never rewrites it.
  assert.deepEqual(refs, rows)
  assert.deepEqual(lines, rows.map(row => `line ${row.id}`))
})

test('an unknown reveal leaves the window where it was', () => {
  const rows = [1, 2, 3, 4].map(n => ({ id: n }))
  const window = windowTranscript({
    lines: rows.map(row => `line ${row.id}`),
    refs: rows,
    available: 2,
    scrollOffset: 1,
    reveal: { id: 99 },
  })
  assert.equal(window.scrollOffset, 1)
  assert.deepEqual(window.visibleLines, ['line 2', 'line 3'])
})

test('an empty window budget shows nothing instead of throwing', () => {
  const window = windowTranscript({ lines: ['a'], refs: [], available: 0, scrollOffset: 0 })
  assert.deepEqual(window.visibleLines, [])
  assert.equal(window.padding, 0)
  assert.equal(window.start, 1)
})
