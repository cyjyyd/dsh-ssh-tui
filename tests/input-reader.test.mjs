/**
 * The Reader's contract, as a test (AD-21, W-1).
 *
 * W-1 moved byte framing — decoding, device-reply filtering, escape assembly, paste
 * markers, unit classification — out of `tui.ts` into `src/input-reader.ts`. "Move"
 * is the whole claim: the same bytes must produce the same frames and the same
 * consumer calls as before, and the three gaps W-0 recorded must stay exactly as
 * broken as they were (they are W-3's business, not this round's).
 *
 * The evidence is a **trace comparison**, not a rewrite of expectations:
 *
 *   fixtures/input-reader-traces.json was captured from the build *before* the
 *   extraction (HEAD's `tui.ts`, no Reader) by feeding each fixture through
 *   `handleData` and recording every consumer entry point it reached, in order,
 *   with its arguments, plus the state the run ended in. This suite re-derives the
 *   same traces through the Reader build and demands byte equality.
 *
 * Every case here arrives through `handleData` (what `process.stdin` and the Host
 * relay call), so decoding, the reply filter, the holds and the framing all run.
 * Nothing calls the Reader's own methods as *the* evidence — the Reader-level
 * assertions below only explain a fixture that the trace already covers.
 *
 * W-3a is that change: four traces differ on purpose (`arrow-left-right`,
 * `pgup-twice-one-read`, `rebound-coalesced`, `alt-1-batched`), each with its old
 * reading recorded in `GAP_FIXTURES` below, and the rest of the reference is
 * byte-identical.
 *
 * 0.8.4-rc.1 changes exactly one more, and only in how the reads are spelled:
 * `paste-split-close-marker`. The reply filter used to hold `ESC[201` as half a
 * cursor reply and hand it over glued to `~`; it no longer holds paste traffic at
 * all (that hold is what cut the marker in half on CI), so the Reader receives the
 * pieces and completes the marker itself. The consumer calls and the end state are
 * unchanged — one `handlePasteText`, `input: 'pasted'` — and the two new fixtures at
 * the end of this file pin the completed behaviour. The paired fixtures prove the rule the fix rests on: one read and
 * several reads reach the same owners with the same state.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { FIXTURES, traceFixture } from './input-trace.mjs'
import { ESCAPE_HOLD_MS, InputReader } from '../lib/input-reader.js'

const REFERENCE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/input-reader-traces.json', import.meta.url)), 'utf8'))

/**
 * The traces W-3a changes on purpose, with what the reference used to say.
 *
 * Each is a coalesced read the gate authorises fixing; the old reading is recorded
 * here so the change is a decision on the record rather than a rewritten expectation.
 */
const GAP_FIXTURES = {
  'arrow-left-right': 'a read of two arrows was dropped as an unknown escape',
  'pgup-twice-one-read': 'two page keys in one read scrolled nothing (G-1)',
  'rebound-coalesced': 'a rebound key twice in one read ran no action and moved focus twice (G-2/G-8)',
  'alt-1-batched': 'Alt+1 batched with a character typed `1x` and skipped the chord (G-3)',
}

/**
 * The traces W-3a.1 adds, with what the build *before* the fix (46d09d9) did with
 * them.
 *
 * These four are new safety cases rather than changed ones: nothing in the reference
 * moved when the guard went in (the 98 traces W-3a left are byte-identical, which is
 * the evidence that the fix is a boundary and not a re-framing). They are captured
 * here because the delivery of a text unit is character by character, and a Screen
 * that owns a read has to stop that delivery the moment it goes away — including when
 * the same unit carries the paste payload, the Escape that closes it and the key
 * behind the Escape.
 */
const W3A1_FIXTURES = {
  'screen-paste-tail-escape': 'the Escape closed the Screen and the q behind it was typed into the draft it was hiding (draft 我打了q一半的消息, cursor 4)',
  'screen-escape-then-paste': 'the Escape closed the Screen and the q behind it was typed as well; the paste that followed the dismissal in the same read was already dropped',
  'wizard-paste-tail-escape': 'the paste landed in the wizard field, the Escape cancelled the wizard, and the q behind it was typed into the composer draft (draft 我打了q一半的消息)',
  'surface-paste-tail-typing': 'nothing (the same trace: a Surface hands the rest of the read on, and it still does)',
}

/**
 * The two traces W-3b.1 changes, and the four safety cases it adds.
 *
 * The first two are the defect, written down: with a Surface up, `Home`/`End` were
 * looked up in the composer's table and moved the *hidden* draft's caret, and `Delete`
 * edited it. Both are replaced here with the old reading recorded, because a reference
 * that is rewritten without one is a reference that proves nothing. The new fixtures are
 * the boundary itself — each Surface shape, and the answer's tail behind it.
 */
/**
 * The three traces W-3b.1b adds, and what the build before the fix did with them.
 *
 * Nothing in the reference moved (106 untouched, 0 replaced): the fix is one code-point
 * test in `composerUnit`, and the fixtures are new because no existing one could survive
 * an astral character — the old build threw `RangeError: Maximum call stack size
 * exceeded` on all three, which is the reading recorded here.
 */
const W3B1B_FIXTURES = {
  'unicode-astral-typing': 'RangeError: typing `a🚀b` recursed until the stack ran out (the emoji is two UTF-16 units and one code point)',
  'unicode-astral-split-bytes': 'RangeError: the same, with the four bytes of `🚀` cut in half across two reads — the Reader joined them, then the unit recursed',
  'unicode-astral-borrowed': 'RangeError: the same at a borrowed field, before the Surface ever saw the answer',
}

const W3B1_FIXTURES = {
  'dialog-home-end': 'with a confirmation up, Home/End moved the draft behind it (cursor 3 → 8); the trace itself was already the two reads, so the change is the end state',
  'dialog-delete': 'the Delete was spent on the draft behind the confirmation (我打了一半的消息 → 我打了半的消息, with a `deleteAtCursor` call in the trace)',
  'surface-edit-keys-no-field': 'new case: the same keys, plus the kitty copy sequence, at a confirmation — the old build deleted a character and called `copyKey`',
  'surface-field-home-delete': 'new case: a Surface that borrowed the field edits *that* one (borrowed ab|2 → b|1 with Home, Delete and End)',
  'surface-filter-edit-keys': 'new case: a list question in filter mode — the filter is a string with no caret, so the keys are dropped and the draft is untouched',
  'surface-edit-then-answer': 'new case: `ESC[3~yes` at a confirmation — the Delete is dropped and `y` still answers while `es` reaches the composer',
}

test('the fixture set is the one the reference was captured from', () => {
  assert.deepEqual(
    FIXTURES.map(fixture => fixture.name).sort(),
    Object.keys(REFERENCE).sort(),
    'a fixture without a reference trace would make the comparison vacuous',
  )
  const calls = Object.values(REFERENCE).reduce((total, entry) => total + entry.trace.length, 0)
  assert.ok(calls > 150, `the reference must exercise the consumers (${calls} calls)`)
})

test('every fixture frames identically to the pre-Reader build', async () => {
  const differences = []
  for (const fixture of FIXTURES) {
    const actual = await traceFixture(fixture)
    const expected = REFERENCE[fixture.name]
    if (JSON.stringify(actual.trace) !== JSON.stringify(expected.trace)) {
      differences.push(`${fixture.name}: consumer calls\n    expected ${JSON.stringify(expected.trace)}\n    actual   ${JSON.stringify(actual.trace)}`)
      continue
    }
    if (JSON.stringify(actual.state) !== JSON.stringify(expected.state)) {
      const keys = new Set([...Object.keys(actual.state), ...Object.keys(expected.state)])
      const changed = [...keys].filter(key => JSON.stringify(actual.state[key]) !== JSON.stringify(expected.state[key]))
      differences.push(`${fixture.name}: state ${changed.map(key => `${key} ${JSON.stringify(expected.state[key])} → ${JSON.stringify(actual.state[key])}`).join(' · ')}`)
    }
  }
  assert.deepEqual(differences, [], `framing changed for:\n  ${differences.join('\n  ')}`)
})

test('the recorded gaps are closed, and the reference records the closed behaviour', () => {
  // W-0 wrote these down as failing and W-1/W-2 had to leave them exactly as broken
  // while they moved code. W-3a fixes them, so this test asserts the fixed behaviour —
  // against traces re-derived from the fixed build, with the old reading kept in
  // `GAP_FIXTURES` so the change is on the record.
  assert.deepEqual(
    Object.keys(GAP_FIXTURES).sort(),
    ['alt-1-batched', 'arrow-left-right', 'pgup-twice-one-read', 'rebound-coalesced'],
  )
  const coalesced = REFERENCE['pgup-twice-one-read']
  assert.equal(coalesced.state.scrollOffset, 24, 'two page keys in one read scroll two pages (G-1 closed)')
  const rebound = REFERENCE['rebound-coalesced']
  assert.equal(rebound.state.scrollOffset, 24, 'a rebound key twice in one read runs twice (G-2/G-8 closed)')
  assert.equal(rebound.state.focusedKind, null, 'and it no longer falls through to the focus ring')
  const alt = REFERENCE['alt-1-batched']
  assert.equal(alt.state.input, 'x', 'an Alt chord batched with a character types only the character behind it (G-3 closed)')
  assert.equal(alt.state.echo, '已跳到最新思考。', 'and the chord itself ran')
  const arrows = REFERENCE['arrow-left-right']
  assert.deepEqual(arrows.trace.map(entry => entry[0]), ['handleInputText', 'moveCursor', 'moveCursor'],
    'two arrows in one read both move the caret')
})

test('W-3a.1: a Screen stops the delivery of its text unit, and a Surface still does not', () => {
  // The four safety cases for Screen read ownership, asserted on the traces the
  // reference now records. A paste tail arrives as one `literal` unit — payload,
  // markers and the escape behind them in a single read — and the unit is delivered
  // character by character because that is what lets a Surface hand the rest of a read
  // on. A Screen owns the read it was sent, so its dismissal has to end the delivery,
  // and what follows in the same read has to be dropped: not typed into the draft the
  // Screen was hiding, and not routed to the owner behind it.
  assert.deepEqual(Object.keys(W3A1_FIXTURES).sort(), [
    'screen-escape-then-paste', 'screen-paste-tail-escape',
    'surface-paste-tail-typing', 'wizard-paste-tail-escape',
  ])
  const REPORT = { input: '我打了一半的消息', cursor: 3 }

  const screen = REFERENCE['screen-paste-tail-escape']
  assert.deepEqual(screen.trace, [
    ['handleInputText', '\x1b[200~pasted\x1b[201~\x1bq'],
    ['handlePasteText', 'pasted'],
    ['pasteIntoScreen', 'pasted'],
    ['handleScreenInput', '\x1b', 'cancel'],
  ], 'the report Screen takes the paste, the Escape closes it, and the q is dropped')
  assert.equal(screen.state.screen, null, 'the Screen is gone')
  assert.equal(screen.state.input, REPORT.input, 'and the draft behind it is exactly what it was')
  assert.equal(screen.state.cursor, REPORT.cursor, 'including the caret')

  const before = REFERENCE['screen-escape-then-paste']
  assert.deepEqual(before.trace, [
    ['handleInputText', '\x1bq\x1b[200~pasted\x1b[201~'],
    ['handleScreenInput', '\x1b', 'cancel'],
  ], 'a dismissal before the paste drops the payload behind it too — the q with it')
  assert.equal(before.state.input, REPORT.input, 'the draft is untouched')

  const wizard = REFERENCE['wizard-paste-tail-escape']
  assert.deepEqual(wizard.trace, [
    ['handleInputText', '\x1b[200~pasted\x1b[201~\x1bq'],
    ['handlePasteText', 'pasted'],
    ['pasteIntoScreen', 'pasted'],
    ['handleScreenInput', '\x1b', 'cancel'],
    ['handleSetupKey', '\x1b', 'cancel'],
  ], 'the wizard takes the paste into its own field, and the Escape ends the read there')
  assert.equal(wizard.state.input, REPORT.input, 'the composer draft behind the wizard is untouched')

  // The asymmetry is the point: a Surface's answer is a character like any other, so
  // the rest of that read is routed on — `y` answers and `es` reaches the composer.
  // W-3a.1 must not change it, and this fixture is byte-identical to the pre-fix build.
  const surface = REFERENCE['surface-paste-tail-typing']
  assert.deepEqual(surface.trace, [
    ['handleInputText', '\x1b[200~pasted\x1b[201~yes'],
    ['handlePasteText', 'pasted'],
    ['handleDialogChar', 'y'],
    ['insertIntoField', 'e'],
    ['insertIntoField', 's'],
  ], 'a Surface still hands the rest of the read on')
  assert.equal(surface.state.input, '我打了es一半的消息', 'which is what the composer takes')
})

test('W-3b.1: a Surface owns its editing keys, and the field on screen is the one they edit', () => {
  // Where the two changed traces land, and what the four new ones pin. The trace is the
  // evidence here because the change is a *call* that no longer happens (`deleteAtCursor`
  // on the hidden draft) and a caret that no longer moves (the hidden `cursor`), plus the
  // borrowed field for the one case the composer's own state cannot see.
  assert.deepEqual(Object.keys(W3B1_FIXTURES).sort(), [
    'dialog-delete', 'dialog-home-end', 'surface-edit-keys-no-field',
    'surface-edit-then-answer', 'surface-field-home-delete', 'surface-filter-edit-keys',
  ])

  // The two that changed: with a confirmation up, Home/End left the draft's caret alone.
  const homeEnd = REFERENCE['dialog-home-end']
  assert.equal(homeEnd.state.cursor, 3, 'Home/End no longer move the caret of the draft behind the Surface')
  assert.equal(homeEnd.state.input, '我打了一半的消息', 'and never touched its text')

  const deleted = REFERENCE['dialog-delete']
  assert.deepEqual(deleted.trace.filter(call => call[0] !== 'handleInputText').map(call => call[0]), ['handleDialogChar'],
    'the Delete is consumed by the Surface: no `deleteAtCursor` reaches the draft')
  assert.equal(deleted.state.input, '我打了一半的消息', 'so the draft is whole')

  // A confirmation with no field: all four keys are dropped, including the copy key.
  const noField = REFERENCE['surface-edit-keys-no-field']
  assert.deepEqual(noField.trace.filter(call => call[0] !== 'handleInputText').map(call => call[0]), ['handleDialogChar'],
    'none of Home/End/Delete/copy reaches a consumer behind the Surface')
  assert.equal(noField.state.input, '我打了一半的消息', 'the draft is untouched')
  assert.equal(noField.state.cursor, 3, 'and so is its caret')
  assert.equal(noField.state.yank, '', 'and nothing was copied')

  // The borrowed field: the keys edit the answer the reader can see. This is the one
  // fixture that records `borrowed` — the composer's `input`/`cursor` cannot show it.
  const borrowed = REFERENCE['surface-field-home-delete']
  assert.deepEqual(borrowed.state.borrowed, { text: 'b', cursor: 1 },
    'Home, Delete and End edited the borrowed field: ab|2 → b|0 → b|1')
  assert.equal(borrowed.state.input, '我打了一半的消息', 'while the draft behind it never moved')
  assert.equal(borrowed.state.cursor, 3, 'nor its caret')

  // A filter is a string, not a field with a caret: nothing to move, nothing to delete.
  const filter = REFERENCE['surface-filter-edit-keys']
  assert.deepEqual(filter.trace.filter(call => call[0] !== 'handleInputText').map(call => call[0]),
    ['handleDialogChar', 'handleDialogChar', 'handleDialogChar', 'handleDialogChar'],
    'the filter took the `/` and the two characters, and the editing keys reached nobody')
  assert.equal(filter.state.input, '我打了一半的消息', 'the draft behind the filtered list is whole')

  // The tail behind a Surface's answer still belongs to the composer (W-3a), and the
  // Delete in front of it no longer costs it a character.
  const answer = REFERENCE['surface-edit-then-answer']
  assert.deepEqual(answer.trace.filter(call => call[0] !== 'handleInputText').map(call => call[0]),
    ['handleDialogChar', 'insertIntoField', 'insertIntoField'], 'y answers, es is typed')
  assert.equal(answer.state.input, '我打了es一半的消息', 'with the Delete dropped rather than spent on the draft')
})

test('W-3b.1b: a non-BMP character is delivered once per code point, to its owner', () => {
  // The reference records it: one `handleInputText` per read, and then one delivery per
  // code point — the emoji included, whole. The state is what a reader would see, and the
  // borrowed-field fixture records the field itself (`record: ['borrowed']`).
  assert.deepEqual(Object.keys(W3B1B_FIXTURES).sort(), [
    'unicode-astral-borrowed', 'unicode-astral-split-bytes', 'unicode-astral-typing',
  ])

  const typed = REFERENCE['unicode-astral-typing']
  assert.deepEqual(typed.trace, [
    ['handleInputText', 'a🚀b'],
    ['insertIntoField', 'a'],
    ['insertIntoField', '🚀'],
    ['insertIntoField', 'b'],
  ], 'three code points, three deliveries, in order — no recursion and no duplication')
  assert.equal(typed.state.input, '我打了a🚀b一半的消息', 'and the run landed at the caret behind it')
  assert.equal(typed.state.cursor, 7, 'which moved by seven UTF-16 units')

  const split = REFERENCE['unicode-astral-split-bytes']
  assert.deepEqual(split.trace, [
    ['handleInputText', '🚀'],
    ['insertIntoField', '🚀'],
  ], 'bytes cut inside the code point arrive as one unit and land once')
  assert.equal(split.state.input, '我打了🚀一半的消息', 'with no replacement character and no duplication')
  assert.equal(split.state.cursor, 5)

  const borrowed = REFERENCE['unicode-astral-borrowed']
  assert.deepEqual(borrowed.trace.filter(call => call[0] !== 'handleInputText').map(call => call[0]), [
    'handleDialogChar', 'insertIntoField',
    'handleDialogChar', 'insertIntoField',
    'handleDialogChar', 'insertIntoField',
    'handleDialogChar', 'insertIntoField',
  ], 'the Surface took each code point and put it in the borrowed field')
  assert.deepEqual(borrowed.state.borrowed, { text: 'a🚀b', cursor: 4 }, 'which is where the answer is')
  assert.equal(borrowed.state.input, '我打了一半的消息', 'while the draft behind it never moved')
  assert.equal(borrowed.state.cursor, 3, 'nor its caret')
})

test('a read is not a key: one read and several reads reach the same owners and state', async () => {
  // The pairs W-3a adds: the same keys, once coalesced into one read and once split
  // across reads. The framing differs (one `handleInputText` per read), so that entry is
  // dropped before comparing; everything the owners did, and the state they left, must
  // be identical — which is the whole claim "a read is not a key" makes.
  const pairs = [
    ['pgup-twice-one-read', 'pair-pgup-two-reads'],
    ['pair-pgdn-one-read', 'pair-pgdn-two-reads'],
    ['pair-down-one-read', 'pair-down-two-reads'],
    ['pair-arrows-mixed-one-read', 'pair-arrows-mixed-two-reads'],
    ['pair-keys-three-one-read', 'pair-keys-three-three-reads'],
    ['pair-typing-with-enter-one-read', 'pair-typing-with-enter-two-reads'],
    ['rebound-coalesced', 'rebound-split'],
    ['rebound-with-text', 'rebound-split-with-text'],
    ['rebound-mixed-default', 'rebound-mixed-default-split'],
    ['alt-1-batched', 'alt-1-then-text-two-reads'],
    ['alt-1-then-key-one-read', 'alt-1-then-key-two-reads'],
    ['screen-copy-with-page', 'screen-copy-with-page-split'],
    ['surface-keys-one-read', 'surface-keys-split'],
  ]
  const byName = new Map(FIXTURES.map(fixture => [fixture.name, fixture]))
  const owners = trace => trace.filter(entry => entry[0] !== 'handleInputText')
  const differences = []
  for (const [oneName, splitName] of pairs) {
    const one = byName.get(oneName)
    const split = byName.get(splitName)
    assert.ok(one !== undefined && split !== undefined, `${oneName} / ${splitName} must both exist`)
    const [whole, apart] = [await traceFixture(one), await traceFixture(split)]
    if (JSON.stringify(owners(whole.trace)) !== JSON.stringify(owners(apart.trace))) {
      differences.push(`${oneName} vs ${splitName}: owner calls differ\n    one   ${JSON.stringify(owners(whole.trace))}\n    split ${JSON.stringify(owners(apart.trace))}`)
      continue
    }
    if (JSON.stringify(whole.state) !== JSON.stringify(apart.state)) {
      const keys = new Set([...Object.keys(whole.state), ...Object.keys(apart.state)])
      const changed = [...keys].filter(key => JSON.stringify(whole.state[key]) !== JSON.stringify(apart.state[key]))
      differences.push(`${oneName} vs ${splitName}: state ${changed.map(key => `${key} ${JSON.stringify(whole.state[key])} → ${JSON.stringify(apart.state[key])}`).join(' · ')}`)
    }
  }
  assert.deepEqual(differences, [], `a coalesced read changed what the keys mean:\n  ${differences.join('\n  ')}`)
})

test('a bracketed paste split across three reads is still one paste', async () => {
  // W-0 named this as the missing case: the markers arrive in different reads, so
  // "inside a paste" has to survive between them. The trace proves the payload
  // reached the paste path once — not the typing path — on the *middle* read.
  const fixture = FIXTURES.find(entry => entry.name === 'paste-split-markers')
  const { trace, state } = await traceFixture(fixture)
  assert.deepEqual(trace, [
    ['handleInputText', '\x1b[200~'],
    ['handleInputText', 'pasted content'],
    ['handlePasteText', 'pasted content'],
    ['handleInputText', '\x1b[201~'],
  ], 'the payload is framed as a paste on the read that carries it')
  assert.equal(state.input, 'pasted content', 'and it landed in the draft')
})

test('the close marker split across reads is reassembled, and its payload is all that lands', async () => {
  // The interesting half of "markers may be split": a marker the terminal cut in two
  // is put back together before the paste is closed, so the pieces never become
  // payload. The reassembly is the **Reader's** now, not the reply filter's: the
  // filter used to hold a trailing `ESC[201` as half a cursor reply, and that hold is
  // what cut the marker in half when the second half arrived after its window (the
  // keyboard stayed inside the paste — see `tui-paste-probe.mjs`). The filter
  // forwards paste traffic untouched, so the trace shows the pieces arriving and the
  // Reader completing the marker between them.
  const fixture = FIXTURES.find(entry => entry.name === 'paste-split-close-marker')
  const { trace, state } = await traceFixture(fixture)
  assert.deepEqual(trace, [
    ['handleInputText', '\x1b[200~pasted'],
    ['handlePasteText', 'pasted'],
    ['handleInputText', '\x1b[201'],
    ['handleInputText', '~'],
  ])
  assert.equal(state.input, 'pasted', 'the payload is the paste, and the markers are not')
})

test('a paste that says yes does not answer a confirmation', async () => {
  // W-0's rule, re-pinned through the Reader: paste is text, never an answer. The
  // paste is handed to the paste path (that is the framing's job) and the Surface
  // refuses it (that is the owner's) — the confirmation is still waiting and the
  // draft behind it is untouched. This is the behaviour W-1 must not weaken while
  // moving the framing.
  const pasted = FIXTURES.find(entry => entry.name === 'yes-pasted-at-dialog')
  const { trace, state } = await traceFixture(pasted)
  assert.deepEqual(trace.slice(0, 2), [
    ['handleInputText', '\x1b[200~yes\x1b[201~'],
    ['handlePasteText', 'yes'],
  ], 'one paste read, framed as paste (the trailing calls are the harness settling the Surface)')
  assert.equal(state.dialog, 'confirm', 'the confirmation is still waiting')
  assert.equal(state.input, '我打了一半的消息', 'and the draft behind it is untouched')

  // Typing `y` *is* the documented answer, and the rest of that read is not swallowed
  // with it: the trace records 'y' answering and 'es' reaching the composer. That
  // asymmetry (a Surface's tail goes on to the composer; a Screen's is dropped) is
  // W-2 material and is pinned here so a move cannot quietly change it.
  const typed = FIXTURES.find(entry => entry.name === 'yes-typed-at-dialog')
  const { trace: typedTrace, state: typedState } = await traceFixture(typed)
  assert.deepEqual(typedTrace.map(call => call[0]), [
    'handleInputText', 'handleDialogChar', 'insertIntoField', 'insertIntoField',
  ], 'y answers the Surface, and the rest of the read types into the composer')
  assert.equal(typedState.input, '我打了es一半的消息', 'the answered Surface lets the rest of the read type')
})

test('the two hold windows are separate, and stay the numbers they were', () => {
  // 30 ms guards a *reply* (the guard hands the bytes back as input when the window
  // passes); this one guards a *keystroke* and turns what it held into an Escape or
  // into text. AD-21 §"两个 hold 窗口" says why they are not merged.
  assert.equal(ESCAPE_HOLD_MS, 60, 'the escape hold is 60 ms: moved into the Reader, not changed')
  const { readFileSync: read } = { readFileSync }
  const guard = read(fileURLToPath(new URL('../src/terminal-input.ts', import.meta.url)), 'utf8')
  assert.match(guard, /export const INPUT_HOLD_MS = 30/u, 'the reply hold is 30 ms, and still the guard’s')
  const reader = read(fileURLToPath(new URL('../src/input-reader.ts', import.meta.url)), 'utf8')
  assert.match(reader, /TerminalInputGuard/u, 'the Reader owns the guard rather than duplicating it')
})

test('a lone escape is held and then released as the Escape key', async () => {
  // The hold is the one piece of framing with a timer, so it gets a case that does
  // not depend on the trace: nothing happens before the window, the Escape arrives
  // after it.
  const { trace } = await traceFixture(FIXTURES.find(entry => entry.name === 'lone-escape'))
  assert.deepEqual(trace, [
    ['handleInputText', '\x1b'],
    ['handleEscape'],
  ], 'held on the read, released into the Escape the reader pressed')
})

/**
 * The split the guard could not save: a paste whose close marker lands in two reads.
 *
 * The filter used to hold `ESC[20` as a half-arrived cursor reply and hand it over as
 * typing one window later, so the other half (`1~`) arrived with no opener. Framed
 * naively the reader never leaves the paste: every later key is payload, Esc stops
 * closing a dialog and `/exit` stops exiting. Both halves are pinned here because the
 * fix has two: the filter keeps paste traffic whole, the reader completes a marker it
 * was handed in pieces.
 */
test('a paste close marker split across reads does not swallow the keyboard', async () => {
  const reader = new InputReader({ onRead: () => {}, onFrame: () => {} })
  assert.deepEqual(reader.read('\x1b[200~pasted\x1b[20'), [{ kind: 'paste', text: 'pasted' }],
    'the payload is delivered; only the marker it cut in half is held')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(reader.read('1~'), [], 'the other half closes the paste instead of being typed')
  assert.deepEqual(reader.read('\x1b'), [{ kind: 'key', sequence: '\x1b' }], 'and the next Escape is a key again')
})

test('a paste tail whose other half never comes is released as payload', async () => {
  const released = []
  // The window is injected: waiting the release value here starved a timer-sensitive
  // paint test on the Windows runner, and what is under test is the expiry, not 2 s.
  const reader = new InputReader({ onRead: () => {}, onFrame: frame => released.push(frame), pasteMarkerHoldMs: 40 })
  assert.deepEqual(reader.read('\x1b[200~pasted\x1b[20'), [{ kind: 'paste', text: 'pasted' }])
  await new Promise(resolve => setTimeout(resolve, 140))
  assert.deepEqual(released, [{ kind: 'paste', text: '\x1b[20' }], 'a dangling tail is typed, not dropped')
  assert.deepEqual(reader.read('\x1b'), [{ kind: 'key', sequence: '\x1b' }],
    'and the paste it belonged to is abandoned, so the keyboard comes back')
})

/**
 * The Escape that arrived while a paste marker was pending.
 *
 * This is the CI failure (`Paste probe (ConPTY, composer + layers)`: the `/view`
 * picker stayed up after Esc, and the probe timed out waiting for the workspace).
 * The paste the probe wrote is complete, but a terminal may deliver it cut or with
 * its close marker lost; the reader then holds a tail, and the Escape that arrives
 * one second later used to be resolved as paste text **two seconds later** — by
 * which time the key was gone and the dialog it was meant to close was still up.
 *
 * The window is injected so the test waits 60 ms rather than the release value.
 */
test('an Escape after a paste whose close marker was lost is still the Escape key', async () => {
  const released = []
  const reader = new InputReader({ onRead: () => {}, onFrame: frame => released.push(frame), pasteMarkerHoldMs: 40 })
  // The close marker never arrives: the terminal swallowed it.
  assert.deepEqual(reader.read('\x1b[200~PASTED-IN-PICKER'), [{ kind: 'paste', text: 'PASTED-IN-PICKER' }],
    'the payload still lands')
  assert.deepEqual(reader.read('\x1b'), [],
    'the Escape is held while its other half could still be a marker')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.deepEqual(released, [{ kind: 'escape' }],
    'and it is released as the Escape key, not as paste text')
  assert.deepEqual(reader.read('x'), [{ kind: 'burst', text: 'x' }],
    'the paste is over, so the next key is typed again')
})

test('an Escape after a close marker the terminal cut in half is still the Escape key', async () => {
  const released = []
  const reader = new InputReader({ onRead: () => {}, onFrame: frame => released.push(frame), pasteMarkerHoldMs: 40 })
  assert.deepEqual(reader.read('\x1b[200~PASTED-IN-PICKER\x1b[20'), [{ kind: 'paste', text: 'PASTED-IN-PICKER' }],
    'the payload lands; the cut marker is held')
  assert.deepEqual(reader.read('\x1b'), [{ kind: 'paste', text: '\x1b[20' }],
    'the held half cannot become a marker once Escape follows it, so it is payload')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.deepEqual(released, [{ kind: 'escape' }], 'the Escape itself is the key the reader pressed')
})

test('an Escape arriving in the same read as a complete close marker is a key, not text', async () => {
  const released = []
  const reader = new InputReader({ onRead: () => {}, onFrame: frame => released.push(frame), pasteMarkerHoldMs: 40 })
  assert.deepEqual(reader.read('\x1b[200~pasted\x1b[201~\x1b'), [{ kind: 'paste', text: 'pasted' }],
    'the payload is the paste; the Escape behind the marker is not payload')
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.deepEqual(released, [{ kind: 'escape' }], 'the Escape behind a closed paste is the Escape key')
})

test('a complete marker still closes the paste, and a lone Escape keeps its own timing', async () => {
  const released = []
  const reader = new InputReader({ onRead: () => {}, onFrame: frame => released.push(frame) })
  const started = Date.now()
  assert.deepEqual(reader.read('\x1b[200~pasted\x1b[201~'), [{ kind: 'paste', text: 'pasted' }])
  assert.deepEqual(reader.read('\x1b'), [{ kind: 'key', sequence: '\x1b' }])
  assert.equal(reader.hold('\x1b'), true, 'the routing still holds a lone Escape, as it always did')
  await new Promise(resolve => setTimeout(resolve, ESCAPE_HOLD_MS + 60))
  assert.deepEqual(released, [{ kind: 'escape' }])
  assert.ok(Date.now() - started < 400, 'the Escape window is the keystroke window, not the marker watchdog')
})
