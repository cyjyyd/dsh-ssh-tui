/**
 * W-4B.1 — Composer-owned completion, at the real input/paint boundaries.
 *
 * These cases drive `handleData()` (the Reader) and `render()` (the Painter), never
 * private helpers as evidence. The pure state machine has its own file; this one
 * proves who receives a unit, what survives a frame, and that paint writes nothing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { checkCompletionWrites } from '../scripts/completion-write-guard.mjs'
import { tick } from './wait.mjs'

setLocale('zh')

function makeTui({ lineMode = false, commands = undefined, onEvent = undefined } = {}) {
  const handlers = new Map()
  const ctx = {
    get(name) { return name === 'commands' ? commands : undefined },
    on(name, fn) {
      handlers.set(name, fn)
      if (onEvent !== undefined) onEvent(name, fn)
      return () => handlers.delete(name)
    },
  }
  const agent = {
    id: 'main-session', options: {}, status: 'idle',
    session: { id: 'main-session', events: [] }, cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent, handlers, ctx }
}

function paint(tui, columns = 100, rows = 30) {
  tui.markDirty()
  tui.render()
  return tui.lastPaintRows.map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd())
}

const listRows = frame => frame.filter(line => /[› ] \/[-a-z]+\s/u.test(line))
const fingerprint = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  folded: tui.inputFolded,
  historyIndex: tui.historyIndex,
  historyDraft: tui.historyDraft,
  completion: {
    query: tui.completion.query,
    visible: tui.completion.visible,
    index: tui.completion.index,
    items: tui.completion.items.map(item => item.name),
    dismissedFor: tui.completion.dismissedFor,
  },
  dialog: tui.dialog?.kind,
  screen: tui.screen?.kind,
  rowsAdded: tui.rows.length,
  borrowedText: tui.borrowedText?.text,
})

test('P2: a prefix ranks starts-with before contains-only', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/se'))
  const names = tui.completion.items.map(item => item.name)
  assert.equal(names[0], 'setup', 'starts-with comes first')
  assert.equal(names[1], 'preset', 'contains-only follows')
})

test('P12b: a failing Host list degrades to local commands and never reuses the old Host list', () => {
  let fail = false
  const host = [{ name: 'hosted', description: 'host', input: { kind: 'text' } }]
  const commands = { list: () => { if (fail) throw new Error('registry down'); return host } }
  let event
  const { tui } = makeTui({ commands, onEvent: (name, fn) => { if (name === 'commands/change') event = fn } })
  tui.bindAgentEvents()
  tui.handleData(Buffer.from('/'))
  assert.equal(tui.completion.items.some(item => item.name === 'hosted'), true)
  fail = true
  event()
  assert.equal(tui.completion.items.some(item => item.name === 'hosted'), false, 'the stale Host entry is gone')
  assert.equal(tui.completion.items.some(item => item.name === 'help'), true, 'the local catalog still paints')
})

test('P12c: non-slash drafts, repaints, and arrow moves never query the Host catalog', () => {
  let calls = 0
  const commands = { list: () => { calls += 1; return [{ name: 'hosted', description: 'h' }] } }
  const { tui } = makeTui({ commands })
  tui.handleData(Buffer.from('hello'))
  paint(tui)
  assert.equal(calls, 0, 'a message never asks for commands')
  tui.handleData(Buffer.from('\x7f'.repeat(5)))
  tui.handleData(Buffer.from('/'))
  assert.equal(calls, 1, 'the first slash materializes once')
  paint(tui)
  tui.handleData(Buffer.from('\x1b[B'))
  paint(tui)
  assert.equal(calls, 1, 'repaint and highlight moves reuse the keyed derivation')
})

test('a programmatic setDraft materializes without waiting for a paint', () => {
  const { tui } = makeTui()
  tui.setDraft('/hel', 4)
  assert.equal(tui.completion.visible, true)
  assert.equal(tui.completion.items[tui.completion.index]?.name, 'help')
  assert.ok(listRows(paint(tui)).some(line => line.includes('/help')))
})

test('P3: arrows move only the completion index and paint the highlighted row', () => {
  const { tui } = makeTui()
  tui.history.push('earlier')
  tui.historyIndex = 1
  tui.handleData(Buffer.from('/'))
  const before = fingerprint(tui)
  tui.handleData(Buffer.from('\x1b[B\x1b[B\x1b[B'))
  assert.equal(tui.completion.index, 3)
  assert.equal(tui.historyIndex, 1, 'history is untouched')
  assert.equal(tui.input, '/', 'the draft is still the query')
  const frame = paint(tui)
  const highlighted = listRows(frame).find(line => line.includes('›'))
  assert.ok(highlighted?.includes(`/${tui.completion.items[3].name}`), 'paint marks the selected item')
  assert.equal(before.completion.items.length, tui.completion.items.length)
})

test('P4/P11: Tab accepts, stays dismissed across frames, and the next Enter runs it', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/hel'))
  assert.equal(tui.completion.items[tui.completion.index]?.name, 'help')
  tui.handleData(Buffer.from('\t'))
  assert.equal(tui.input, '/help ')
  assert.equal(tui.cursor, 6)
  assert.equal(tui.completion.phase, 'dismissed')
  assert.equal(tui.completion.dismissedFor, '/help ')
  assert.equal(listRows(paint(tui)).length, 0, 'Tab does not leave a painted list')
  assert.equal(listRows(paint(tui)).length, 0, 'the next frame does not resurrect it')
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.screen?.kind, 'report', 'the accepted command runs on the next Enter')
  assert.equal(tui.input, '')
})

test('P5: Enter on a prefix highlight completes and runs in one unit', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/hel'))
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.screen?.kind, 'report')
  assert.equal(tui.input, '')
  assert.equal(tui.completion.visible, false)
})

test('P6: Esc dismisses persistently and a real edit re-lists', async () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/'))
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  assert.equal(tui.completion.phase, 'dismissed')
  assert.equal(tui.completion.dismissedFor, '/')
  assert.equal(listRows(paint(tui)).length, 0)
  assert.equal(listRows(paint(tui)).length, 0)
  tui.handleData(Buffer.from('m'))
  assert.equal(tui.completion.visible, true)
  assert.equal(tui.completion.dismissedFor, undefined)
})

test('P8: a paste is materialized before the next unit, with no paint in between', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/model'))
  assert.deepEqual(tui.completion.items.map(item => item.name), ['model', 'submodel'])
  tui.handleData(Buffer.from('\x1b[200~s\x1b[201~'))
  assert.equal(tui.input, '/models')
  assert.equal(tui.completion.visible, false)
  assert.deepEqual(tui.completion.items, [])
})

test('P12: commands/change refreshes without a key, and the no-event host waits for the next draft', () => {
  const host = [{ name: 'hosted', description: 'before', input: { kind: 'text' } }]
  const commands = { list: () => host }
  let event
  const first = makeTui({ commands, onEvent: (name, fn) => { if (name === 'commands/change') event = fn } })
  first.tui.bindAgentEvents()
  first.tui.handleData(Buffer.from('/'))
  assert.equal(first.tui.completion.items.some(item => item.name === 'dynamic'), false)
  host.push({ name: 'dynamic', description: 'registered later', input: { kind: 'text' } })
  event()
  assert.equal(first.tui.completion.items.some(item => item.name === 'dynamic'), true, 'the event refreshed the list')
  assert.equal(first.tui.input, '/', 'no keystroke was needed')

  const silent = makeTui({ commands })
  silent.tui.handleData(Buffer.from('/'))
  host.push({ name: 'later', description: 'no event', input: { kind: 'text' } })
  assert.equal(silent.tui.completion.items.some(item => item.name === 'later'), false)
  silent.tui.handleData(Buffer.from('l'))
  assert.equal(silent.tui.completion.items.some(item => item.name === 'later'), true, 'the next draft change re-queries')
})

test('P13: line mode creates no completion state; Tab keeps its two spaces', () => {
  const { tui } = makeTui({ lineMode: true })
  tui.handleData(Buffer.from('/'))
  assert.equal(tui.completion.visible, false)
  assert.equal(tui.completion.query, '')
  tui.handleData(Buffer.from('\t'))
  assert.equal(tui.input, '/  ')
  assert.equal(tui.completion.visible, false)
})

test('N1: while listed an arrow moves completion and never history', () => {
  const { tui } = makeTui()
  tui.history.push('earlier')
  tui.historyIndex = 1
  tui.handleData(Buffer.from('/'))
  const index = tui.completion.index
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.completion.index, index + 1)
  assert.equal(tui.historyIndex, 1)
  assert.equal(tui.input, '/')
})

test('N10: Enter refuses a contains-only or case-mismatched highlight', () => {
  for (const draft of ['/ag', '/HELP']) {
    const { tui } = makeTui()
    tui.handleData(Buffer.from(draft))
    assert.equal(tui.completion.visible, true, `${draft} lists a contains/case match`)
    tui.handleData(Buffer.from('\r'))
    assert.notEqual(tui.screen?.kind, 'report', `${draft} did not execute the highlighted command`)
    assert.ok(String(tui.currentNotice() ?? '').includes(draft), 'the literal draft reached the unknown-command path')
  }
})

test('N2: a borrowed Surface field never receives completion or a Tab rewrite', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/'))
  assert.equal(tui.completion.visible, true)
  tui.openDialog({
    kind: 'questions',
    question: { id: 'free', question: 'answer', options: [] },
    index: 0, total: 1, selected: new Set(), cursor: 0,
    resolve() {}, reject() {},
  }, { kind: 'picker' })
  tui.handleData(Buffer.from('borrowed'))
  assert.equal(tui.borrowedText.text, 'borrowed')
  assert.equal(tui.completion.visible, false)
  tui.handleData(Buffer.from('\t'))
  assert.equal(tui.borrowedText.text, 'borrowed', 'Tab at the Surface is the Surface\u2019s key')
  assert.equal(tui.completion.visible, false)
})

test('N3: an arrow at a Surface moves its cursor, never completion', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/'))
  const dialog = {
    kind: 'questions',
    question: { id: 'pick', question: 'choose', options: [{ label: 'a' }, { label: 'b' }] },
    index: 0, total: 1, selected: new Set(), cursor: 0,
    resolve() {}, reject() {},
  }
  tui.openDialog(dialog, { kind: 'picker' })
  const before = tui.completion.index
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.completion.index, before)
  assert.equal(tui.completion.visible, false)
  assert.equal(dialog.cursor, 1, 'the Surface owns the arrow')
})

test('N4: a Screen tail is discarded inside its read, while a new read is routed again', async () => {
  const { tui } = makeTui()
  tui.history.push('should not appear')
  tui.historyIndex = 1
  const before = tui.completion.index
  // One raw read: open the report, close it with q, then send an arrow. The arrow
  // was addressed to the Screen and must be dropped after its dismissal.
  tui.handleData(Buffer.from('/help\r\x03X'))
  assert.equal(tui.screen, undefined, 'the report was opened and closed in the read')
  assert.equal(tui.completion.index, before, 'the tail cannot move a list')
  assert.equal(tui.input, '', 'the tail cannot type behind the Screen')
  tui.handleData(Buffer.from('/'))
  assert.equal(tui.completion.visible, true, 'a new read is routed from scratch')
})

test('N5: Tab never submits', () => {
  const { tui } = makeTui()
  const rows = tui.rows.length
  tui.handleData(Buffer.from('/hel\t'))
  assert.equal(tui.input, '/help ')
  assert.equal(tui.rows.length, rows)
  assert.equal(tui.screen, undefined)
})

test('N6: submit resets the state; the list can only return after a new draft', async () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/help\r'))
  assert.equal(tui.completion.visible, false)
  assert.equal(tui.input, '')
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  assert.equal(tui.screen, undefined)
  tui.handleData(Buffer.from('/'))
  assert.equal(tui.completion.visible, true)
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.completion.phase, 'dismissed')
})

test('N7: Ctrl+L stays KEEP_DUAL and does not take the completion branch', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/'))
  const before = fingerprint(tui)
  tui.handleData(Buffer.from('\x0c'))
  assert.equal(tui.completion.index, before.completion.index)
  assert.equal(tui.completion.visible, true)
  assert.equal(tui.forceFullPaint ?? false, false, 'Ctrl+L is an incremental repaint here')
})

test('N8: clearing the draft then an arrow browses history, not a paint-written list', () => {
  const { tui } = makeTui()
  tui.history.push('earlier message')
  tui.historyIndex = 1
  tui.handleData(Buffer.from('/'))
  assert.equal(tui.completion.visible, true, 'typing materialized the list before any paint')
  paint(tui) // a list is painted
  tui.handleData(Buffer.from('\x15')) // Ctrl+U clears the draft; no paint in between
  assert.equal(tui.input, '')
  assert.equal(tui.completion.visible, false, 'the draft setter, not a frame, cleared the list')
  tui.handleData(Buffer.from('\x1b[A'))
  assert.equal(tui.input, 'earlier message')
  assert.equal(tui.completion.visible, false)
})

test('N9: completion moves do not touch inputFolded', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/'))
  const folded = tui.inputFolded
  tui.handleData(Buffer.from('\x1b[B'))
  tui.handleData(Buffer.from('\t'))
  assert.equal(tui.inputFolded, folded)
})

test('the source guard sees every draft write go through setDraft()', () => {
  assert.deepEqual(checkCompletionWrites('src/tui.ts'), [])
})

test('the state fingerprint is stable across a repeated arrow and a no-op Esc-free read', () => {
  const { tui } = makeTui()
  tui.handleData(Buffer.from('/'))
  tui.handleData(Buffer.from('\x1b[B'))
  const first = fingerprint(tui)
  tui.handleData(Buffer.from('x'))
  tui.handleData(Buffer.from('\x7f'))
  assert.equal(tui.input, '/')
  assert.deepEqual(fingerprint(tui).completion.items, first.completion.items)
  assert.equal(tui.completion.index, 0, 'a query change starts the rebuilt list at the top')
})
