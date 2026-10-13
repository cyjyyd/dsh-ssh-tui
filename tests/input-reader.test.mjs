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
 * When W-3 fixes the read-coalescing gaps, three traces change on purpose
 * (`pgup-twice-one-read`, `rebound-coalesced`, `alt-1-batched`): update the fixture
 * in that change and say so.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { FIXTURES, traceFixture } from './input-trace.mjs'
import { ESCAPE_HOLD_MS } from '../lib/input-reader.js'

const REFERENCE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/input-reader-traces.json', import.meta.url)), 'utf8'))

/** The traces this round must leave alone; W-3 changes them deliberately. */
const KNOWN_GAP_FIXTURES = ['pgup-twice-one-read', 'rebound-coalesced', 'alt-1-batched']

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

test('the known gaps are still exactly as broken as W-0 recorded', () => {
  // Not a target — a boundary. W-1 must not "helpfully" fix these while moving
  // code, because a behaviour change hidden inside a move is the one thing a move
  // must never contain. W-3 flips them, with the fixture, in its own change.
  for (const name of KNOWN_GAP_FIXTURES) {
    const entry = REFERENCE[name]
    assert.ok(entry !== undefined, `${name} must be in the reference`)
    assert.equal(entry.state.scrollOffset === undefined ? null : entry.state.scrollOffset, entry.state.scrollOffset, `${name}: recorded`)
  }
  const coalesced = REFERENCE['pgup-twice-one-read']
  assert.equal(coalesced.state.scrollOffset, 0, 'two page keys in one read still scroll nothing (G-1)')
  const rebound = REFERENCE['rebound-coalesced']
  assert.equal(rebound.state.scrollOffset, 0, 'a rebound key sent twice in one read still does nothing (G-2)')
  const alt = REFERENCE['alt-1-batched']
  assert.equal(alt.state.input, '1x', 'an Alt chord batched with the next character still types it (G-3)')
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
  // payload. The reassembly is the reply filter's 30 ms tail hold (a trailing
  // `ESC[2…` could still grow into a cursor reply), which is why the third read
  // carries the first two joined — the trace records that, not an assumption.
  const fixture = FIXTURES.find(entry => entry.name === 'paste-split-close-marker')
  const { trace, state } = await traceFixture(fixture)
  assert.deepEqual(trace, [
    ['handleInputText', '\x1b[200~pasted'],
    ['handlePasteText', 'pasted'],
    ['handleInputText', '\x1b[201~'],
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
    'handleInputText', 'handlePlainText', 'handleChar', 'handleDialogChar', 'handleChar', 'handleChar',
  ])
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
    ['handleChar', '\x1b'],
    ['handleEscape'],
  ], 'held on the read, released through the same two calls the inline timer made')
})
