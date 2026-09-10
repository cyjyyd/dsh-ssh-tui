import test from 'node:test'
import assert from 'node:assert/strict'

import {
  actionsForInput,
  clampPickerCursor,
  feedPicker,
  filterResumableSessions,
  pickerCapacity,
  pickerStateUnchanged,
  SESSION_PICKER_WINDOW,
  sessionMatchesQuery,
  stepPicker,
} from '../lib/picker.js'
import { pickerWindowStart } from '../lib/paint.js'

function session(id, overrides = {}) {
  return {
    id,
    label: overrides.label ?? `task ${id}`,
    updatedAt: overrides.updatedAt ?? 1000,
    cwd: overrides.cwd ?? '/root/work',
    ...overrides,
  }
}

function state(sessions, overrides = {}) {
  return {
    sessions,
    query: '',
    cursor: 0,
    filterActive: false,
    ...overrides,
  }
}

function continueState(current, action, windowSize = SESSION_PICKER_WINDOW) {
  const step = stepPicker(current, action, windowSize)
  assert.equal(step.kind, 'continue')
  return step.state
}

test('filter matches title, id, cwd, and attach pid (every token)', () => {
  const live = session('live-host', {
    label: '修复绘制残留',
    cwd: '/root/genshin/srv',
    attach: { pid: 4242, sock: '/tmp/x.sock', state: 'paused' },
  })
  const other = session('other', { label: '写 README', cwd: '/tmp' })
  assert.equal(sessionMatchesQuery(live, '绘制'), true)
  assert.equal(sessionMatchesQuery(live, 'LIVE-HOST'), true)
  assert.equal(sessionMatchesQuery(live, 'genshin 4242'), true)
  assert.equal(sessionMatchesQuery(live, 'pid'), true)
  assert.equal(sessionMatchesQuery(live, '绘制 missing'), false)
  assert.deepEqual(filterResumableSessions([live, other], 'srv').map(item => item.id), ['live-host'])
  assert.deepEqual(filterResumableSessions([live, other], '').map(item => item.id), ['live-host', 'other'])
})

test('arrows and page keys move the highlight without capping at nine', () => {
  const sessions = Array.from({ length: 20 }, (_, index) => session(`s${index}`))
  let current = state(sessions)
  current = continueState(current, { type: 'move', delta: 1 })
  assert.equal(current.cursor, 1)
  current = continueState(current, { type: 'page', delta: 1 }, 5)
  assert.equal(current.cursor, 6)
  current = continueState(current, { type: 'end' })
  assert.equal(current.cursor, 19)
  current = continueState(current, { type: 'move', delta: 1 })
  assert.equal(current.cursor, 19)
  current = continueState(current, { type: 'home' })
  assert.equal(current.cursor, 0)
  assert.equal(clampPickerCursor(-3, 20), 0)
  assert.equal(pickerWindowStart(19, 20, SESSION_PICKER_WINDOW), 11)
  const atEnd = stepPicker(state(sessions, { cursor: 19 }), { type: 'move', delta: 1 })
  assert.equal(atEnd.kind, 'continue')
  assert.equal(pickerStateUnchanged(state(sessions, { cursor: 19 }), atEnd.state), true)
})

test('empty-filter digits 1-9 pick the visible window; Enter picks the cursor', () => {
  const sessions = Array.from({ length: 15 }, (_, index) => session(`s${index}`))
  let current = state(sessions, { cursor: 10 })
  const start = pickerWindowStart(10, 15, SESSION_PICKER_WINDOW)
  assert.equal(pickerWindowStart(10, 15, SESSION_PICKER_WINDOW) + SESSION_PICKER_WINDOW - start, 9)
  const quick = stepPicker(current, { type: 'quick', key: '1' }, SESSION_PICKER_WINDOW)
  assert.equal(quick.kind, 'done')
  assert.deepEqual(quick.result, { kind: 'resume', id: `s${start}` })
  const ninth = stepPicker(current, { type: 'quick', key: '9' }, SESSION_PICKER_WINDOW)
  assert.equal(ninth.kind, 'done')
  assert.deepEqual(ninth.result, { kind: 'resume', id: `s${start + 8}` })

  const submit = stepPicker(current, { type: 'submit' })
  assert.equal(submit.kind, 'done')
  assert.deepEqual(submit.result, { kind: 'resume', id: 's10' })

  const attached = session('live', { attach: { pid: 7, sock: '/tmp/live.sock' } })
  const attach = stepPicker(state([attached]), { type: 'submit' })
  assert.deepEqual(attach, { kind: 'done', result: { kind: 'attach', id: 'live', sock: '/tmp/live.sock' } })
})

test('typing filters; digits type once the filter is active; Esc leaves the filter first', () => {
  const sessions = [
    session('alpha', { label: '修复绘制残留', cwd: '/root/a' }),
    session('beta', { label: '写文档', cwd: '/root/docs' }),
    session('gamma-9', { label: 'task 9', cwd: '/tmp/nine' }),
  ]
  let current = state(sessions)
  current = continueState(current, { type: 'type', text: '绘' })
  assert.equal(current.filterActive, true)
  assert.equal(current.query, '绘')
  assert.equal(current.cursor, 0)
  const resume = stepPicker(current, { type: 'submit' })
  assert.deepEqual(resume, { kind: 'done', result: { kind: 'resume', id: 'alpha' } })

  current = continueState(state(sessions), { type: 'startFilter' })
  assert.equal(current.filterActive, true)
  current = continueState(current, { type: 'quick', key: '9' })
  assert.equal(current.query, '9')
  const filtered = filterResumableSessions(current.sessions, current.query)
  assert.deepEqual(filtered.map(item => item.id), ['gamma-9'])

  current = continueState(current, { type: 'escape' })
  assert.equal(current.query, '')
  assert.equal(current.filterActive, false)
  const cancel = stepPicker(current, { type: 'escape' })
  assert.deepEqual(cancel, { kind: 'done', result: null })
})

test('0 starts a new session only when not filtering', () => {
  const sessions = [session('one')]
  const fresh = stepPicker(state(sessions), { type: 'new' })
  assert.deepEqual(fresh, { kind: 'done', result: { kind: 'new' } })
  assert.deepEqual(actionsForInput('0'), [{ type: 'new' }])
  assert.deepEqual(actionsForInput('0', { query: '', filterActive: true }), [{ type: 'type', text: '0' }])
  assert.deepEqual(actionsForInput('/'), [{ type: 'startFilter' }])
  assert.deepEqual(actionsForInput('\x1b[A'), [{ type: 'move', delta: -1 }])
  assert.deepEqual(actionsForInput('\x1b[6~'), [{ type: 'page', delta: 1 }])
  assert.deepEqual(actionsForInput('\r'), [{ type: 'submit' }])
  assert.deepEqual(actionsForInput('\x1b'), [{ type: 'escape' }])
  assert.deepEqual(actionsForInput('\x03'), [{ type: 'cancel' }])
})

test('pickerCapacity locks a full page at nine when the tty can fit it', () => {
  assert.equal(SESSION_PICKER_WINDOW, 9)
  assert.equal(pickerCapacity(8), 1)
  assert.equal(pickerCapacity(24), 8)
  assert.equal(pickerCapacity(25), 9)
  assert.equal(pickerCapacity(80), 9)
})

test('pasted text types digits instead of firing 1-9 shortcuts', () => {
  const sessions = [
    session('s1', { label: 'alpha' }),
    session('fix-2', { label: 'fix 2 the renderer' }),
  ]
  const typed = feedPicker(state(sessions), 'fix 2')
  assert.equal(typed.kind, 'continue')
  assert.equal(typed.state.query, 'fix 2')
  assert.equal(typed.state.filterActive, true)
  const picked = stepPicker(typed.state, { type: 'submit' })
  assert.deepEqual(picked, { kind: 'done', result: { kind: 'resume', id: 'fix-2' } })

  const arrow = feedPicker(state(sessions, { cursor: 1 }), '\x1b[A')
  assert.equal(arrow.kind, 'continue')
  assert.equal(arrow.state.cursor, 0)
})

test('pickerStateUnchanged treats loading as part of the frame', () => {
  const sessions = [session('a')]
  const idle = state(sessions)
  const loading = state(sessions, { loading: true })
  assert.equal(pickerStateUnchanged(idle, idle), true)
  assert.equal(pickerStateUnchanged(idle, loading), false)
})
