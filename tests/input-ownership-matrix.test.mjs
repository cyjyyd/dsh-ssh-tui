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
  // `appExit` is recorded rather than honoured. Ctrl+D is one of the keys a Surface
  // must *not* let through to the process (W-3b.3c, G1), and an unrecorded exit would
  // end the test run instead of failing an assertion.
  const exits = []
  const ctx = {
    get: name => (name === 'appExit' ? code => { exits.push(code) } : undefined),
    on() { return () => {} },
  }
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
  return { tui, seen, exits }
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
      // Home/End/Delete and the copy key are the Surface's own units (W-3b.1). Ctrl+L
      // is still the composer's repaint (recorded debt, AD-22 §"the two asymmetries",
      // which is down to one).
      '\x1b[H': 'ownerSurface', '\x1b[1~': 'ownerSurface', '\x1b[F': 'ownerSurface',
      '\x1b[4~': 'ownerSurface', '\x1b[99;6u': 'ownerSurface',
      '\x0c': 'ownerComposer', '\x1b[3~': 'ownerSurface',
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
      '\x1b[H': 'ownerSurface', '\x1b[F': 'ownerSurface', '\x1b[3~': 'ownerSurface',
    },
  },
  // W-3b.3c · G2: the two Surface shapes that own the keyboard without owning the
  // composer's text *and* without borrowing a field. A list answers with its highlight
  // and its hotkeys; a filtering one answers with the filter box. Both are states where
  // a printable key has a Surface meaning, which is exactly where a shared executor can
  // be tempted to reach for the draft behind it.
  {
    name: 'question Surface (options)',
    open: tui => {
      draft(tui)
      void tui.askQuestion({ id: 'q2', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1)
        .catch(() => undefined)
    },
    expect: {
      'x': 'ownerSurface', 'y': 'ownerSurface', '\r': 'ownerSurface', '\x7f': 'ownerSurface',
      '\x15': 'ownerSurface', '\x0c': 'ownerComposer',
      '\x1b[A': 'ownerSurface', '\x1b[B': 'ownerSurface', '\x1b[5~': 'ownerSurface',
      '\x1b[H': 'ownerSurface', '\x1b[1~': 'ownerSurface', '\x1b[F': 'ownerSurface',
      '\x1b[4~': 'ownerSurface', '\x1b[3~': 'ownerSurface', '\x1b[99;6u': 'ownerSurface',
      '\x1b[<65;10;5M': 'ownerSurface', '\x03': 'ownerSurface',
    },
  },
  {
    name: 'picker Surface (filtering)',
    open: (tui, seen) => {
      draft(tui)
      void tui.askQuestion({ id: 'q3', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1)
        .catch(() => undefined)
      tui.handleData(Buffer.from('/'))
      // `/` is the unit that *opens* filter mode, and it is a Surface unit like any
      // other — recorded here so the cell under test is the only call in the trace.
      seen.length = 0
    },
    expect: {
      'x': 'ownerSurface', '\r': 'ownerSurface', '\x7f': 'ownerSurface', '\x08': 'ownerSurface',
      '\x0c': 'ownerComposer', '\x03': 'ownerSurface',
      '\x1b[A': 'ownerSurface', '\x1b[3~': 'ownerSurface', '\x1b[<65;10;5M': 'ownerSurface',
    },
  },
]

test('a unit reaches exactly one owner, in every state', () => {
  // A lone `ESC` is not a cell here: the Reader holds it for its own window before
  // releasing it (AD-21), so the owner is called after this loop has moved on. Its
  // Surface semantics are pinned where the wait is affordable — `dialog-escape` in
  // the reference traces, and the picker's own cases in `interaction-surface`.
  const failures = []
  for (const state of STATES) {
    for (const [unit, expected] of Object.entries(state.expect)) {
      const { tui, seen } = fixture()
      state.open(tui, seen)
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

test('a Surface keeps the composer behind it: its own editing keys included', async () => {
  // The Screen case above is the same claim for a Screen. W-3b.1 adds the keys the
  // composer's table used to answer for a Surface: Home/End moved the hidden caret and
  // Delete edited the hidden draft. A Surface without a field has nothing to move or
  // delete, so the draft, the caret and the reader's other state stay exactly as they
  // were — and a Surface *with* a borrowed field edits that field, not the draft.
  const forms = [
    ['confirm', async tui => {
      void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
      await waitForDialog(tui, 'confirm')
    }, false],
    ['question with options', async tui => {
      void tui.askQuestion({ id: 'q2', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1).catch(() => undefined)
      await waitForDialog(tui, 'questions')
    }, false],
    ['question with a borrowed field', async tui => {
      void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
      await waitForDialog(tui, 'questions')
    }, true],
  ]
  for (const [name, open, hasField] of forms) {
    for (const unit of ['x', '\x1b[H', '\x1b[1~', '\x1b[F', '\x1b[4~', '\x1b[3~', '\x1b[99;6u', '\x15', '\x7f']) {
      const { tui } = fixture()
      draft(tui)
      await open(tui)
      const before = snapshot(tui)
      tui.handleData(Buffer.from(unit))
      const after = snapshot(tui)
      const where = `${name} + ${JSON.stringify(unit)}`
      assert.equal(after.input, before.input, `${where}: the draft behind the Surface is untouched`)
      assert.equal(after.cursor, before.cursor, `${where}: and its caret`)
      assert.equal(after.historyIndex, before.historyIndex, `${where}: and the browse position`)
      assert.equal(after.scroll, before.scroll, `${where}: and the transcript`)
      assert.equal(after.focused, before.focused, `${where}: and the focus ring`)
      assert.equal(after.rows, before.rows, `${where}: and no row was pushed`)
      assert.equal(tui.dialog !== undefined, true, `${where}: the Surface is still up`)
      if (!hasField) assert.equal(tui.borrowedText, undefined, `${where}: no field was borrowed`)
      else if (unit === 'x') assert.equal(tui.borrowedText?.text, 'x', `${where}: the answer is the visible field's`)
    }
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

// ── W-3b.3c · G1–G4: the evidence the KEEP_SHARED_WITH_INVARIANTS decision rests on ──
//
// The shared executor (`composerUnit`) is kept, so the keys whose value comes from a
// `dialog` guard *inside* it — and the two paths that write the composer's own `/find `
// seed — need cells of their own. Each case opens the Surface the way the product does
// and reads the whole owner state, not just the final effect.

/**
 * Everything a unit may not move unless it owns it.
 *
 * Deliberately broader than {@link snapshot}: the composer's *history* and the borrowed
 * field are the two states W-3b.3a found being written from behind a Surface, so they
 * are asserted directly here rather than inferred from the draft. `inputFolded` is here
 * for the same reason one round later — the Independent Gate removed Ctrl+T's
 * `dialog === undefined` guard and every Surface's hidden composer folded, while this
 * oracle was still green because the field was not in it (W-3b.3c evidence repair).
 * `folds` is the same lesson for `Ctrl+R`: the guard protects a *card behind the
 * Surface*, so an oracle that only watched the composer could not see it either.
 */
const ownerState = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  inputFolded: tui.inputFolded,
  // Which cards are open, by position: `${index}:${kind}:${open|folded}`. Built from the
  // rows rather than from one card the fixture happens to push, so the field keeps
  // working if a fixture grows a second card.
  folds: tui.rows
    .map((row, index) => (typeof row.expanded === 'boolean' ? `${index}:${row.kind}:${row.expanded ? 'open' : 'folded'}` : undefined))
    .filter(entry => entry !== undefined)
    .join(' '),
  historyIndex: tui.historyIndex,
  historyDraft: tui.historyDraft,
  borrowed: tui.borrowedText === undefined ? null : `${tui.borrowedText.text}@${tui.borrowedText.cursor}`,
  dialog: tui.dialog?.kind ?? null,
  dialogCursor: tui.dialog?.cursor ?? null,
  filtering: tui.dialog?.filtering ?? null,
  filter: tui.dialog?.filter ?? null,
  focused: tui.focusedRow?.kind ?? null,
  rows: tui.rows.length,
  scroll: tui.scrollOffset,
  yank: tui.copyYank ?? null,
  echo: tui.currentFooterEcho() ?? null,
})

/**
 * One real, collapsed card on the transcript the Surface is drawn over.
 *
 * `Ctrl+R` folds a card — `toggleCollapsible()` takes the focused one, else the newest —
 * so with nothing collapsible behind it the key is a no-op however its guard is spelled.
 * The Independent Gate's second finding is exactly that: G1's surfaces had no card, so
 * removing `case '\x12'`'s `dialog !== undefined` guard changed a state no oracle was
 * watching and the suite stayed green. This fixture puts the reachable state there.
 *
 * The preconditions are asserted rather than assumed, because the cell is only evidence
 * if they hold: a card exists, it starts folded, and nothing is focused (a focused ring
 * entry would make `Ctrl+R` fold *that* row instead, which is the composer's own path).
 */
const collapsibleCardBehind = tui => {
  pushRow(tui, {
    kind: 'tool', callId: 'c-ctrl-r', name: 'bash', title: 'bash', summary: 'ls',
    args: '{}', output: 'ok', status: 'ok', expanded: false,
  })
  const cards = tui.rows.filter(row => row.kind === 'tool')
  assert.equal(cards.length, 1, 'the fixture put exactly one collapsible card behind the Surface')
  assert.equal(cards[0]?.expanded, false, 'and it starts folded')
  assert.equal(tui.focusedRow, null, 'with nothing focused')
}

/** The four Surface shapes, opened through their product entry points. */
const SURFACE_FORMS = [
  ['confirm', async tui => {
    void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
    await waitForDialog(tui, 'confirm')
  }],
  ['question (borrowed field)', async tui => {
    void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
    await waitForDialog(tui, 'questions')
  }],
  ['question (options)', async tui => {
    void tui.askQuestion({ id: 'q2', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1)
      .catch(() => undefined)
    await waitForDialog(tui, 'questions')
  }],
  ['picker (filtering)', async tui => {
    void tui.askQuestion({ id: 'q3', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1)
      .catch(() => undefined)
    await waitForDialog(tui, 'questions')
    tui.handleData(Buffer.from('/'))
  }],
]

test('G1: the keys the shared executor guards for a Surface never reach the composer behind it', async () => {
  // These eight are the shared body's own forks: five switch cases protected by
  // `dialog !== undefined` (Ctrl+N/P/R/T/D), and three that fall out after the early
  // return (`\x07`, `\x1f`, Tab). A split would move exactly these; keeping the shared
  // body means they stay where they are, and this is what says so.
  const keys = [
    ['\x0e', 'Ctrl+N'], ['\x10', 'Ctrl+P'], ['\x12', 'Ctrl+R'], ['\x14', 'Ctrl+T'],
    ['\t', 'Tab'], ['\x04', 'Ctrl+D'], ['\x07', 'Ctrl+G'], ['\x1f', 'Ctrl+_'],
  ]
  const failures = []
  for (const [name, open] of SURFACE_FORMS) {
    for (const [unit, label] of keys) {
      const { tui, seen, exits } = fixture()
      draft(tui)
      collapsibleCardBehind(tui)
      await open(tui)
      seen.length = 0
      const before = ownerState(tui)
      const dialog = tui.dialog?.kind
      tui.handleData(Buffer.from(unit))
      const where = `${name} + ${label}`
      if (seen.length !== 1) failures.push(`${where}: ${seen.length} owners took it (${seen.join(', ')})`)
      else if (seen[0] !== 'ownerSurface') failures.push(`${where}: ${seen[0]} took it`)
      if (JSON.stringify(ownerState(tui)) !== JSON.stringify(before)) {
        failures.push(`${where}: the state moved — ${JSON.stringify(before)} → ${JSON.stringify(ownerState(tui))}`)
      }
      if (tui.dialog?.kind !== dialog) failures.push(`${where}: the Surface left`)
      if (name === 'picker (filtering)' && tui.dialog?.filtering !== true) failures.push(`${where}: filter mode was dropped`)
      if (exits.length > 0) failures.push(`${where}: the process was told to exit (${exits.join(',')})`)
    }
    // Ctrl+L is the one recorded exception (W-3b.2 KEEP_DUAL): the Surface's keys go to
    // the composer *adapter*, which only runs the repaint — so the Surface must not have
    // grown a repaint case of its own, and nothing may be written either.
    const { tui, seen } = fixture()
    draft(tui)
    collapsibleCardBehind(tui)
    await open(tui)
    seen.length = 0
    const before = ownerState(tui)
    tui.handleData(Buffer.from('\x0c'))
    if (seen.join(',') !== 'ownerComposer') failures.push(`${name} + Ctrl+L: ${seen.join(',') || 'nobody'} took it — KEEP_DUAL routes it to the composer adapter`)
    if (JSON.stringify(ownerState(tui)) !== JSON.stringify(before)) failures.push(`${name} + Ctrl+L: the repaint wrote state`)
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`)
})

test('G2: the two field-less Surface shapes keep every owner state they do not own', async () => {
  // The matrix above says *who* takes a unit in these states; this says what the unit
  // left alone, cell by cell. `focused` is in the fingerprint on purpose: a list's
  // highlight is `dialog.cursor`, while the transcript's ring is a different thing that
  // must not move. Where the Surface legitimately does something, the case names it —
  // the expectation is written per cell rather than inferred from the key's shape,
  // because "may this move?" depends on the list's options and on the filter's contents
  // (`y` is not a hotkey for Alpha/Beta; backspacing an empty filter is a no-op).
  const cases = [
    {
      name: 'question (options)',
      open: SURFACE_FORMS[2][1],
      cells: [
        // The list's hotkeys are `123456789abc…` by position (`QUESTION_OPTION_KEYS`), so
        // with two options they are `1` and `2` — a letter is an ordinary printable here,
        // which is exactly why "consumed" and "the Surface's own action" need separate cells.
        ['x', {}, 'a printable that is not a hotkey is consumed'],
        ['y', {}, 'and so is one that is not a hotkey at all'],
        ['1', { dialogCursor: 0 }, 'a hotkey highlights its option — which was already the highlight'],
        ['2', { dialogCursor: 1 }, 'the second hotkey moves the highlight'],
        ['\x1b[B', { dialogCursor: 1 }, '↓ moves the highlight'],
        ['\x1b[A', {}, '↑ at the top stays at the top'],
        ['/', { filtering: true, filter: '' }, '`/` opens the filter box'],
        ['\x7f', {}, 'Backspace outside the filter box types nothing'],
        ['\x1b[3~', {}, 'Delete is a list’s nothing, not the draft’s'],
      ],
    },
    {
      name: 'picker (filtering)',
      open: SURFACE_FORMS[3][1],
      cells: [
        ['x', { filter: 'x' }, 'a printable goes into the filter'],
        ['A', { filter: 'A' }, 'and its case is kept'],
        ['\x7f', {}, 'Backspace on an empty filter is a no-op'],
        ['\x08', {}, 'Ctrl+H likewise'],
        ['\x1b[A', {}, 'the arrows do not move through a filter box'],
      ],
    },
  ]
  const failures = []
  for (const entry of cases) {
    for (const [unit, expected, why] of entry.cells) {
      const { tui, seen } = fixture()
      draft(tui)
      await entry.open(tui)
      seen.length = 0
      const before = ownerState(tui)
      tui.handleData(Buffer.from(unit))
      const where = `${entry.name} + ${JSON.stringify(unit)} (${why})`
      if (seen.join(',') !== 'ownerSurface') failures.push(`${where}: ${seen.join(',') || 'nobody'} took it`)
      // What the Surface owns may change, and only what it owns.
      const after = ownerState(tui)
      for (const field of ['input', 'cursor', 'historyIndex', 'historyDraft', 'borrowed', 'focused', 'rows', 'scroll', 'yank', 'dialog', 'echo']) {
        if (JSON.stringify(after[field]) !== JSON.stringify(before[field])) {
          failures.push(`${where}: ${field} moved — ${JSON.stringify(before[field])} → ${JSON.stringify(after[field])}`)
        }
      }
      for (const [field, want] of Object.entries(expected)) {
        if (JSON.stringify(after[field]) !== JSON.stringify(want)) {
          failures.push(`${where}: ${field} is ${JSON.stringify(after[field])}, expected ${JSON.stringify(want)}`)
        }
      }
      if (Object.keys(expected).length === 0 && JSON.stringify([after.dialogCursor, after.filter, after.filtering])
        !== JSON.stringify([before.dialogCursor, before.filter, before.filtering])) {
        failures.push(`${where}: the Surface state moved with no expectation named`)
      }
    }
  }
  assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}`)
})

test('G3: the /find seed is written by the composer, on both of its paths, and never behind a Surface', async () => {
  // Two independent paths write the same seed, and W-3b.3a had to guard one of them:
  // `\x1f` is the shared body's tail (already behind the `dialog` early return) and
  // `Alt+f`/`Alt+/` are the Router's chord branch (which runs *before* any owner).
  for (const [unit, label] of [['\x1f', 'Ctrl+_'], ['\x1bf', 'Alt+f'], ['\x1b/', 'Alt+/']]) {
    const { tui } = fixture()
    draft(tui)
    tui.handleData(Buffer.from(unit))
    assert.equal(tui.input, '/find ', `${label}: the composer seeds its own /find`)
    assert.equal(tui.cursor, 6, `${label}: with the caret after the seed`)
    assert.equal(tui.dialog, undefined, `${label}: and nothing was opened`)
  }

  // Ctrl+G is the search *step*, not a seed: it writes no text at all.
  const step = fixture()
  draft(step.tui)
  step.tui.handleData(Buffer.from('\x07'))
  assert.equal(step.tui.input, '我打了一半的消息', 'Ctrl+G types nothing')
  assert.equal(step.tui.cursor, 3, 'and moves no caret')
  assert.match(String(step.tui.currentFooterEcho() ?? ''), /还没有搜索结果/u, 'it reports the search it stepped through')

  // At a Surface the seed has no field to land in — the answer is not the draft, and
  // the draft is not the Surface's — so both paths are consumed with no write.
  for (const [name, open] of SURFACE_FORMS) {
    for (const [unit, label] of [['\x1f', 'Ctrl+_'], ['\x07', 'Ctrl+G'], ['\x1bf', 'Alt+f'], ['\x1b/', 'Alt+/']]) {
      const { tui, seen } = fixture()
      draft(tui)
      await open(tui)
      seen.length = 0
      const before = ownerState(tui)
      tui.handleData(Buffer.from(unit))
      const where = `${name} + ${label}`
      assert.equal(tui.input, '我打了一半的消息', `${where}: the hidden draft is not a search seed`)
      assert.equal(tui.cursor, 3, `${where}: and its caret did not move`)
      assert.deepEqual(ownerState(tui), before, `${where}: nothing else moved either`)
      // Who consumed it says which fix is holding: `\x1f` and `\x07` are the shared
      // body's tail, so the Surface adapter takes them and drops them, while the Alt
      // chords are read by `route()` *before* any owner is asked (W-3b.3a) — no adapter
      // sees them at all, which is what makes "consumed, not forwarded" checkable.
      const expectedOwner = unit.startsWith('\x1b') ? '' : 'ownerSurface'
      assert.equal(seen.join(','), expectedOwner, `${where}: ${expectedOwner === '' ? 'the chord branch consumed it' : 'the Surface took it'}`)
    }
  }
})

test('G4: Ctrl+N/P move the transcript’s focus ring only while the composer owns the keys', async () => {
  // Recorded behaviour, not a defect: with nothing layered over the workspace the
  // composer's adapter takes Ctrl+N/P and they move the *workspace's* focus ring — which
  // is why `/copy` can copy the focused row. What matters here is the other half: the
  // same keys at a Surface or a Screen must not move it.
  const composer = fixture()
  cards(composer.tui)
  composer.tui.input = ''
  composer.tui.cursor = 0
  const base = ownerState(composer.tui)
  assert.equal(base.focused, null, 'nothing is focused to begin with')
  composer.tui.handleData(Buffer.from('\x0e'))
  assert.notEqual(composer.tui.focusedRow, null, 'Ctrl+N focuses the newest ring entry')
  assert.equal(composer.tui.input, '', 'and types nothing')
  composer.tui.handleData(Buffer.from('\x10'))
  assert.equal(ownerState(composer.tui).focused, base.focused === null ? ownerState(composer.tui).focused : base.focused,
    'Ctrl+P moves within the ring')
  for (const field of ['input', 'cursor', 'historyIndex', 'historyDraft', 'borrowed', 'rows', 'scroll']) {
    assert.equal(JSON.stringify(ownerState(composer.tui)[field]), JSON.stringify(base[field]),
      `the ring move left ${field} alone`)
  }

  // A Surface, and a Screen, own the keyboard: the ring behind them stays where it was.
  for (const [name, open] of SURFACE_FORMS) {
    for (const [unit, label] of [['\x0e', 'Ctrl+N'], ['\x10', 'Ctrl+P']]) {
      const { tui } = fixture()
      cards(tui)
      draft(tui)
      await open(tui)
      const before = ownerState(tui)
      tui.handleData(Buffer.from(unit))
      assert.deepEqual(ownerState(tui), before, `${name} + ${label}: the focus ring behind the Surface did not move`)
    }
  }
  const screen = fixture()
  cards(screen.tui)
  draft(screen.tui)
  screen.tui.openScreen({ kind: 'report', report: 'diag', title: '诊断', lines: [{ kind: 'system', text: '正文' }], offset: 0 })
  const before = ownerState(screen.tui)
  screen.tui.handleData(Buffer.from('\x0e'))
  screen.tui.handleData(Buffer.from('\x10'))
  assert.deepEqual(ownerState(screen.tui), before, 'a Screen owns Ctrl+N/P: the ring behind it did not move')
})
