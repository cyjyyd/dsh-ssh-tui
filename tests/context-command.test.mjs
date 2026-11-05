/**
 * CONTEXT.C1 — /context as a read-only Report Screen and line-mode report.
 *
 * These cases drive the same SshTui entry and Screen key adapter the reader
 * uses. They pin the two refinements from the independent review: event-count
 * preflight before snapshot materialization, and CURRENT SURFACE membership is
 * not a stable ACTIVE lifecycle state.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { MAX_CONTEXT_EVENTS } from '../lib/context-projection.js'
import { reportRowKind } from '../lib/screen.js'
import { SshTui } from '../lib/tui.js'

setLocale('en')

const header = {
  version: 4,
  id: 'main-session',
  createdAt: 1,
  cwd: '/very/private/workspace',
  isSeeded: false,
  delegationDepth: 0,
}

const user = (seq, text = 'synthetic question', source = { kind: 'user' }) => ({
  type: 'user/message', seq, time: seq + 1, surfaceOp: 'append',
  data: { id: `m${seq}`, role: 'user', source, content: [{ type: 'text', text }] },
})
const turnStart = (seq, turn = 1) => ({ type: 'turn/start', seq, time: seq + 1, data: { turn } })
const turnEnd = (seq, turn = 1) => ({ type: 'turn/end', seq, time: seq + 1, data: { turn, reason: { kind: 'completed' } } })
const assistant = (seq, turn = 1, step = 1) => ({
  type: 'assistant/message', seq, time: seq + 1, surfaceOp: 'append',
  data: { turn, step, message: { id: `a${seq}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'synthetic answer' }] }, stream: [] },
})

function fixture(options = {}) {
  const events = options.events ?? [turnStart(0), user(1), assistant(2), turnEnd(3)]
  let snapshotCalls = 0
  const session = {
    id: 'main-session',
    seq: options.seqProvided === true ? options.seq : (options.seq === undefined ? events.length : options.seq),
    header: options.header ?? header,
    inheritedEventCount: options.inheritedEventCount ?? 0,
    snapshotEvents() {
      snapshotCalls += 1
      if (options.snapshotThrows === true) throw new Error('snapshot should not be requested')
      return events
    },
  }
  if (options.withSurface !== false) {
    Object.defineProperty(session, 'surface', {
      get() {
        if (options.surfaceThrows === true) throw new Error('surface unavailable')
        return { nodes: options.activeNodes ?? [1, 2] }
      },
    })
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session, cancel() {} }
  const ctx = {
    calls: [],
    get(name) {
      this.calls.push(name)
      if (name === 'sessionProjections') return { stateOf: () => ({ questions: { active: [], settled: [] } }) }
      if (name === 'commands') return { list: () => [] }
      if (name === 'appExit') return () => {}
      return undefined
    },
    on() { return () => {} },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true, ...options.tui })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, ctx, session, snapshotCalls: () => snapshotCalls }
}

const screenText = screen => screen.lines.map(line => line.text).join('\n')

test('R16 framed /context is one Report Screen and writes no transcript row', () => {
  const { tui } = fixture()
  tui.input = 'hidden draft'
  const before = tui.rows.length
  tui.runContextCommand()
  assert.equal(tui.screen.kind, 'report')
  assert.equal(tui.screen.report, 'context')
  assert.equal(tui.screen.title, 'context')
  assert.equal(tui.rows.length, before, 'a report is not narrative')
  assert.equal(tui.input, 'hidden draft')
  const body = screenText(tui.screen)
  assert.match(body, /CURRENT SURFACE/)
  assert.doesNotMatch(body, /\[ACTIVE\]/)
  assert.match(body, /SESSION ARCHIVE STATE/)
  assert.match(body, /UNAVAILABLE/)
  assert.match(body, /SEGMENT DELETED/)
  assert.match(body, /NOT_REPRESENTED/)
  assert.equal(body.includes(header.cwd), false)
})

test('R16b /context dispatches through the command catalog', () => {
  const { tui } = fixture()
  tui.runCommand('/context')
  assert.equal(tui.screen.kind, 'report')
  assert.equal(tui.screen.report, 'context')
  assert.equal(tui.screen.title, 'context')
})

test('R17 event-count preflight over cap never requests a snapshot', () => {
  const { tui, snapshotCalls } = fixture({ seq: MAX_CONTEXT_EVENTS + 1, events: [user(0, 'must not appear')] })
  tui.runContextCommand()
  assert.equal(snapshotCalls(), 0)
  assert.match(screenText(tui.screen), /250000/)
  assert.doesNotMatch(screenText(tui.screen), /must not appear/)
})

test('R18 unknown or invalid event count fails closed without snapshot', () => {
  for (const seq of [undefined, -1, Number.NaN, 1.5]) {
    const { tui, snapshotCalls } = fixture({ seq, seqProvided: true, events: [user(0)] })
    tui.runContextCommand()
    assert.equal(snapshotCalls(), 0, String(seq))
    assert.match(screenText(tui.screen), /UNAVAILABLE|unavailable/)
  }
})

test('R19 missing/raising Surface is explicit unavailable, never all-active', () => {
  for (const options of [{ surfaceThrows: true }, { withSurface: false }]) {
    const { tui } = fixture(options)
    tui.runContextCommand()
    const body = screenText(tui.screen)
    assert.match(body, /CURRENT SURFACE/)
    assert.match(body, /UNAVAILABLE|unavailable/)
    assert.doesNotMatch(body, /\[ACTIVE\]/)
  }
})

test('R20 Enter opens preview in the same Screen; Esc returns; q closes', () => {
  const { tui } = fixture()
  tui.input = 'keep me'
  tui.runContextCommand()
  assert.equal(tui.screen.context.mode, 'list')
  tui.handleScreenInput('\r', undefined)
  assert.equal(tui.screen.kind, 'report')
  assert.equal(tui.screen.report, 'context')
  assert.equal(tui.screen.context.mode, 'preview')
  assert.match(screenText(tui.screen), /RANGE PREVIEW/)
  assert.match(screenText(tui.screen), /seq 1\.\.3/)
  tui.handleScreenInput('\x1b', undefined)
  assert.equal(tui.screen.context.mode, 'list')
  assert.equal(tui.input, 'keep me')
  tui.handleScreenInput('q', undefined)
  assert.equal(tui.screen, undefined)
  assert.equal(tui.input, 'keep me')
})

test('R20b opening and closing /context preserves workspace, scroll, focus and find state', () => {
  const { tui } = fixture()
  tui.input = 'keep me'
  tui.scrollOffset = 7
  const focus = tui.rows.at(-1)
  tui.focusedRow = focus
  tui.searchQuery = 'find-me'
  tui.searchHits = [focus]
  tui.searchIndex = 0
  const before = {
    rows: tui.rows.length,
    scroll: tui.scrollOffset,
    focus: tui.focusedRow,
    query: tui.searchQuery,
    hits: tui.searchHits,
    index: tui.searchIndex,
  }
  tui.runContextCommand()
  assert.equal(tui.input, 'keep me')
  assert.equal(tui.rows.length, before.rows)
  assert.equal(tui.scrollOffset, before.scroll)
  assert.equal(tui.focusedRow, before.focus)
  assert.equal(tui.searchQuery, before.query)
  assert.equal(tui.searchHits, before.hits)
  assert.equal(tui.searchIndex, before.index)
  tui.handleScreenInput('\x1b', undefined)
  assert.equal(tui.screen, undefined)
  assert.equal(tui.input, 'keep me')
  assert.equal(tui.scrollOffset, before.scroll)
  assert.equal(tui.focusedRow, before.focus)
  assert.equal(tui.searchQuery, before.query)
  assert.equal(tui.searchHits, before.hits)
  assert.equal(tui.searchIndex, before.index)
})

test('R21 no lifecycle action keys; a/r/d are inert', () => {
  const { tui } = fixture()
  const before = tui.rows.length
  tui.runContextCommand()
  for (const key of ['a', 'r', 'd', 'A', 'R', 'D']) {
    tui.handleScreenInput(key, undefined)
    assert.equal(tui.screen.kind, 'report')
    assert.equal(tui.screen.report, 'context')
  }
  assert.equal(tui.rows.length, before, 'no transcript row from a key')
})

test('R22 copy is sanitized and never includes cwd/raw args/content', () => {
  const { tui } = fixture({
    events: [
      turnStart(0),
      user(1, 'secret user text'),
      assistant(2),
      { type: 'tool/call', seq: 3, time: 4, data: { turn: 1, step: 1, callId: 'c3', name: 'read', arguments: '{"path":"/private/secret"}' } },
      { type: 'tool/result', seq: 4, time: 5, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'r4', role: 'tool', source: { kind: 'tool', callId: 'c3' }, content: [{ type: 'text', text: 'secret tool output' }] } } },
      turnEnd(5),
    ],
    activeNodes: [1, 2, 4],
  })
  tui.runContextCommand()
  let copied = ''
  tui.copyPlainText = text => { copied = text }
  tui.handleScreenInput('c', undefined)
  assert.ok(copied.length > 0)
  assert.equal(copied.includes(header.cwd), false)
  assert.equal(copied.includes('secret user text'), false)
  assert.equal(copied.includes('secret tool output'), false)
  assert.equal(copied.includes('/private/secret'), false)
})

test('R23 line mode emits a text report and creates no Screen', () => {
  const { tui } = fixture({ tui: { lineMode: true } })
  const before = tui.rows.length
  tui.runContextCommand()
  assert.equal(tui.screen, undefined)
  assert.equal(tui.rows.length, before + 1)
  const last = tui.rows.at(-1)
  assert.equal(last.kind, 'system')
  assert.match(last.text, /CURRENT SURFACE|UNAVAILABLE/)
  assert.equal(reportRowKind('context'), 'system')
})

test('R24 no persistence or other-Session access', () => {
  const { tui, ctx } = fixture()
  tui.runContextCommand()
  const forbidden = ctx.calls.filter(name => name === 'sessionPersistence' || name === 'sessions' || name === 'workspaceRegistry')
  assert.deepEqual(forbidden, [])
  assert.equal(tui.screen.report, 'context')
})
