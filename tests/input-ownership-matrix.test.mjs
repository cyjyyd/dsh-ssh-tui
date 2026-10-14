/**
 * The ownership matrix, through the real input path (W-2 layer B).
 *
 * Layer A (`tests/input-router.test.mjs`) pins what the Router answers. This file
 * pins what actually happens: every case arrives through `handleData` — decoder, reply
 * filter, holds, framing, Router, owner adapter — and the assertion is **exactly one
 * owner took the unit**, plus the state that owner was supposed to leave alone.
 *
 * The owners are observed at their adapter entry points (`ownerScreen`,
 * `ownerSurface`, `ownerComposer`, `ownerWorkspace`): the spying wraps them and calls
 * through, so the event still travels the production path. That is the one thing a
 * unit may not do — reach two owners, or reach the composer while a Screen or a
 * Surface is up (AD-20 §4.5 F-6).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, waitForDialog } from './wait.mjs'

setLocale('zh')

const OWNERS = ['ownerScreen', 'ownerSurface', 'ownerComposer', 'ownerWorkspace']

/** A TUI with the four owner adapters wrapped: the calls are the evidence. */
function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const sent = []
  const agent = {
    id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] },
    cancel() {},
    followup: message => { sent.push(message) },
    steer: message => { sent.push(message) },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  const seen = []
  for (const name of OWNERS) {
    const original = tui[name].bind(tui)
    tui[name] = (...args) => { seen.push(name); return original(...args) }
  }
  // Geometry is pinned so a page key is not the runner's terminal.
  tui.screenRows = () => 24
  tui.screenColumns = () => 80
  return { tui, seen }
}

const draft = tui => { tui.input = '我打了一半的消息'; tui.cursor = 3 }
const transcript = tui => { for (let index = 0; index < 40; index += 1) pushRow(tui, { kind: 'assistant', text: `回复 ${index}` }) }

/** The same transcript with collapsible cards: the focus ring's precondition. */
const cards = tui => {
  transcript(tui)
  for (let index = 0; index < 3; index += 1) {
    pushRow(tui, {
      kind: 'tool', callId: `c${index}`, name: 'bash', title: 'bash', summary: 'ls',
      args: '{}', output: 'ok', status: 'ok', expanded: false,
    })
  }
}
const snapshot = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  scroll: tui.scrollOffset,
  screen: tui.screen?.kind ?? '-',
  dialog: tui.dialog?.kind ?? '-',
  focused: tui.focusedRow?.kind ?? null,
  rows: tui.rows.length,
})

/** The states a unit can arrive in, and the owner that must take it. */
const STATES = [
  {
    name: 'composer (draft)',
    open: tui => draft(tui),
    expect: {
      'x': 'ownerComposer', '\r': 'ownerComposer', '\x15': 'ownerComposer', '\x0c': 'ownerComposer',
      '\x1b[A': 'ownerComposer', '\x1b[5~': 'ownerWorkspace', '\x1b[<65;10;5M': 'ownerWorkspace',
      '\x1b[3~': 'ownerComposer', '\x03': 'ownerComposer',
    },
  },
  {
    name: 'composer (empty, cards below)',
    open: tui => cards(tui),
    expect: {
      'x': 'ownerComposer', '\x1b[A': 'ownerWorkspace', '\x1b[B': 'ownerWorkspace',
      '\x1b[5~': 'ownerWorkspace', '\x1b[6~': 'ownerWorkspace',
    },
  },
  {
    name: 'report Screen',
    open: tui => {
      draft(tui)
      tui.openScreen({
        kind: 'report', report: 'diag', title: '诊断',
        lines: Array.from({ length: 60 }, (_line, index) => ({ kind: 'system', text: `第 ${index} 行` })),
        offset: 20, copyText: '屏幕上的正文',
      })
    },
    expect: {
      'x': 'ownerScreen', '\r': 'ownerScreen', '\x03': 'ownerScreen', '\x0c': 'ownerScreen',
      '\x1b[A': 'ownerScreen', '\x1b[5~': 'ownerScreen', '\x1b[<65;10;5M': 'ownerScreen',
      '\x1b[3~': 'ownerScreen', '\x15': 'ownerScreen',
    },
  },
  {
    name: 'confirm Surface',
    open: tui => {
      draft(tui)
      void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
    },
    expect: {
      'x': 'ownerSurface', '\r': 'ownerSurface', '\x03': 'ownerSurface', '\x1b[A': 'ownerSurface',
      '\x1b[5~': 'ownerSurface', '\x1b[<65;10;5M': 'ownerSurface', '\x15': 'ownerSurface',
      // Ctrl+L is the composer's repaint, and Home/End/Delete still reach the composer
      // (recorded debt, AD-22 §"the two asymmetries"); the Router says so explicitly.
      '\x0c': 'ownerComposer', '\x1b[3~': 'ownerComposer',
    },
  },
  {
    name: 'question Surface (borrowed field)',
    open: tui => {
      draft(tui)
      void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
    },
    expect: {
      'x': 'ownerSurface', '\r': 'ownerSurface', '\x7f': 'ownerSurface', '\x15': 'ownerSurface',
      '\x1b[A': 'ownerSurface', '\x1b[5~': 'ownerSurface',
    },
  },
]

test('a unit reaches exactly one owner, in every state', () => {
  const failures = []
  for (const state of STATES) {
    for (const [unit, expected] of Object.entries(state.expect)) {
      const { tui, seen } = fixture()
      state.open(tui)
      tui.handleData(Buffer.from(unit))
      const where = `${state.name} + ${JSON.stringify(unit)}`
      if (seen.length !== 1) failures.push(`${where}: ${seen.length} owners took it (${seen.join(', ')}) — expected ${expected}`)
      else if (seen[0] !== expected) failures.push(`${where}: ${seen[0]} took it — expected ${expected}`)
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`)
})

test('a Screen keeps the composer behind it: keys, paste, mouse', () => {
  // The last two are one read that both ends the Screen and carries a tail: a paste
  // followed by the Escape and a key behind it, and the same in the other order. They
  // are *units*, not frames — the delivery is character by character inside them — and
  // they are here because this list is what says "no unit rewrites the draft behind a
  // Screen" (W-3a.1: the tail of one of them did).
  for (const unit of ['x', '\r', '\x1b', '\x15', '\x0b', '\x7f', '\x03', '\x04', '\x12', '\x14', '\x1b[3~', '\x1b[<0;10;5M', '\x1b[200~pasted\x1b[201~', '\x1b[200~pasted\x1b[201~\x1bq', '\x1bq\x1b[200~pasted\x1b[201~']) {
    const { tui } = fixture()
    tui.openScreen({ kind: 'report', report: 'diag', title: '诊断', lines: [{ kind: 'system', text: '正文' }], offset: 0 })
    draft(tui)
    const before = snapshot(tui)
    tui.handleData(Buffer.from(unit))
    const after = snapshot(tui)
    assert.equal(after.input, before.input, `${JSON.stringify(unit)}: the draft behind the Screen is untouched`)
    assert.equal(after.cursor, before.cursor, `${JSON.stringify(unit)}: and its caret`)
    assert.equal(after.rows, before.rows, `${JSON.stringify(unit)}: and no row was pushed behind it`)
  }
})

test('a Surface with no field refuses text and paste without touching the draft', () => {
  // `y` is the documented answer and is asserted on its own below; every other unit
  // must leave the confirmation waiting and the draft alone.
  for (const unit of ['x', 'e', '\x1b[200~yes\x1b[201~', '\x1b[200~pasted\x1b[201~', '\x7f', '\x15']) {
    const { tui } = fixture()
    draft(tui)
    void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
    const before = snapshot(tui)
    tui.handleData(Buffer.from(unit))
    const after = snapshot(tui)
    assert.equal(after.dialog, 'confirm', `${JSON.stringify(unit)}: the confirmation is still waiting`)
    assert.equal(after.input, before.input, `${JSON.stringify(unit)}: the draft is untouched`)
    assert.equal(after.cursor, before.cursor, `${JSON.stringify(unit)}: and its caret`)
  }
  const { tui } = fixture()
  draft(tui)
  void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
  tui.handleData(Buffer.from('y'))
  assert.equal(tui.dialog, undefined, 'a typed y is the answer the confirmation asked for')
})

test('an event nobody acts on reaches at most one owner, and changes nothing', () => {
  // Focus reports, device replies, Ctrl+V's raw byte and an unknown CSI are not input.
  // A Screen or a Surface may still be handed one (it owns the keyboard and drops what
  // it does not use, AD-20 §5) — but never the composer behind it, never two owners, and
  // never a state change. This is the invariant; which owner received the drop is not.
  const failures = []
  for (const unit of ['\x1b[I', '\x1b[O', '\x1b[12;5R', '\x16', '\x1b[1;5u']) {
    for (const state of [STATES[0], STATES[1], STATES[2], STATES[3]]) {
      const { tui, seen } = fixture()
      state.open(tui)
      const before = snapshot(tui)
      tui.handleData(Buffer.from(unit))
      const where = `${state.name} + ${JSON.stringify(unit)}`
      if (seen.length > 1) failures.push(`${where}: ${seen.join(', ')} — two owners took one unit`)
      if (seen.includes('ownerComposer') && !state.name.startsWith('composer')) {
        failures.push(`${where}: the composer took it behind the ${state.name}`)
      }
      if (JSON.stringify(snapshot(tui)) !== JSON.stringify(before)) failures.push(`${where}: the state changed`)
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`)
})

test('closing a Screen gives the draft and the focus back exactly as they were', () => {
  const { tui } = fixture()
  transcript(tui)
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x1b[A')) // the arrow the workspace keeps: focus the newest card
  const focused = snapshot(tui)
  tui.openScreen({ kind: 'report', report: 'diag', title: '诊断', lines: [{ kind: 'system', text: '正文' }], offset: 0 })
  assert.equal(snapshot(tui).input, before.input, 'opening the Screen does not touch the draft')
  tui.handleData(Buffer.from('q'))
  const after = snapshot(tui)
  assert.equal(after.screen, '-', 'the Screen is gone')
  assert.equal(after.input, before.input, 'the draft is exactly what it was')
  assert.equal(after.cursor, before.cursor, 'caret included')
  assert.equal(after.focused, focused.focused, 'and the focus ring is where the reader left it')
})

test('the wizard owns the keyboard from a resumed launch, and gives it back', async () => {
  const { tui, seen } = fixture()
  draft(tui)
  const before = snapshot(tui)
  const wizard = tui.runOnboarding()
  assert.equal(tui.screen?.kind, 'setup', 'the production entry opened the wizard as a Screen')
  tui.handleData(Buffer.from('x'))
  assert.deepEqual(seen, ['ownerScreen'], 'the wizard takes the key')
  assert.equal(tui.input, before.input, 'and the draft it found is still there')
  tui.handleData(Buffer.from('\x1b'))
  await wizard.catch(() => undefined)
  assert.equal(snapshot(tui).input, before.input, 'leaving the wizard restores the draft')
  assert.equal(snapshot(tui).cursor, before.cursor)
})

test('a pasted yes is not an answer, wherever it lands', async () => {
  const { tui } = fixture()
  draft(tui)
  const pending = tui.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } })
  await waitForDialog(tui, 'confirm')
  tui.handleData(Buffer.from('\x1b[200~yes\x1b[201~'))
  assert.equal(tui.dialog?.kind, 'confirm', 'the approval is still waiting for a human')
  assert.equal(tui.input, '我打了一半的消息', 'and the draft is untouched')
  tui.handleData(Buffer.from('n'))
  await pending.catch(() => undefined)
})
