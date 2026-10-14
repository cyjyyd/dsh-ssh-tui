/**
 * The Router's decisions, on their own (AD-20 §4.3, W-2).
 *
 * Layer A of the W-2 test plan: one unit in, one owner out, decided by the Router
 * alone. The rules below are the ones the ladder applied inline before this module
 * existed — including the two asymmetries the contract records as debt (Ctrl+L's two
 * implementations, and the Home/End/Delete pair that still reaches the Composer with
 * a Surface up). Pinning them here means W-3 changes them deliberately, with this
 * file in the diff, rather than by accident.
 *
 * Layer B — the same decisions through `handleData` → Reader → Router → owner — is
 * `tests/input-reader.test.mjs` (the 72-fixture trace comparison) and the ownership
 * matrix in `tests/input-ownership-regression.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { InputRouter } from '../lib/input-router.js'

const router = new InputRouter()

/** A snapshot with everything off; each case names what it turns on. */
const view = (overrides = {}) => ({
  screenKind: undefined,
  surfaceKind: undefined,
  surfaceHasField: false,
  composerEmpty: true,
  workspaceCards: false,
  ...overrides,
})

const SCREEN = view({ screenKind: 'report' })
const SURFACE = view({ surfaceKind: 'confirm' })
const SURFACE_FIELD = view({ surfaceKind: 'questions', surfaceHasField: true })
const BARE = view()
const BARE_WITH_CARDS = view({ workspaceCards: true })

test('a Screen owns every unit while it is up', () => {
  const units = [
    ['text', 'x'],
    ['control', '\r'],
    ['control', '\x15'],
    ['control', '\x0c'],
    ['control', '\x03'],
    ['sequence', '\x1b[A'],
    ['sequence', '\x1b[5~'],
    ['sequence', '\x1b[<0;10;5M'],
    ['sequence', '\x1b[3~'],
    ['paste', 'pasted'],
    ['escape', ''],
  ]
  for (const [kind, unit] of units) {
    assert.equal(router.route(kind, unit, SCREEN), 'screen', `Screen must own ${kind} ${JSON.stringify(unit)}`)
  }
})

test('paste lands on the field that owns the keyboard, never behind it', () => {
  assert.equal(router.route('paste', 'x', BARE), 'composer')
  assert.equal(router.route('paste', 'x', SURFACE), 'surface', 'a Surface without a field refuses it itself')
  assert.equal(router.route('paste', 'x', SURFACE_FIELD), 'surface')
  assert.equal(router.route('paste', 'x', SCREEN), 'screen', 'a Screen terminates the paste')
})

test('a Surface owns its units, and drops what it does not use', () => {
  for (const [kind, unit] of [['text', 'y'], ['control', '\r'], ['control', '\x03'], ['escape', ''], ['sequence', '\x1b[A'], ['sequence', '\x1b[B'], ['sequence', '\x1b[5~'], ['sequence', '\x1b[<65;10;5M']]) {
    assert.equal(router.route(kind, unit, SURFACE), 'surface', `Surface must own ${kind} ${JSON.stringify(unit)}`)
    assert.equal(router.route(kind, unit, SURFACE_FIELD), 'surface')
  }
})

test('the two recorded Surface asymmetries stay where W-1 left them', () => {
  // Ctrl+L: the repaint is the composer's implementation when no Screen is up
  // (G-6 keeps both implementations until a test proves they are identical).
  assert.equal(router.route('control', '\x0c', SURFACE), 'composer')
  // Home/End/Delete and the kitty copy sequence still reach the composer today.
  for (const unit of ['\x1b[H', '\x1b[F', '\x1b[1~', '\x1b[4~', '\x1b[3~', '\x1b[99;6u']) {
    assert.equal(router.route('sequence', unit, SURFACE), 'composer', `${JSON.stringify(unit)} is recorded debt (W-3)`)
  }
})

test('with nothing layered over it, the composer types and the workspace scrolls', () => {
  for (const [kind, unit] of [['text', 'a'], ['control', '\r'], ['control', '\x15'], ['control', '\x0c'], ['escape', ''], ['sequence', '\x1b[C'], ['sequence', '\x1b[D'], ['sequence', '\x1b[H'], ['sequence', '\x1b[3~']]) {
    assert.equal(router.route(kind, unit, BARE), 'composer', `${kind} ${JSON.stringify(unit)} is the composer's`)
  }
  for (const unit of ['\x1b[<64;10;5M', '\x1b[<65;10;5M', '\x1b[<0;10;5M', '\x1b[<32;14;5M', '\x1b[<0;14;5m', '\x1b[5~', '\x1b[6~']) {
    assert.equal(router.route('sequence', unit, BARE), 'workspace', `${JSON.stringify(unit)} is the transcript's`)
  }
})

test('an arrow reaches the focus ring only with an empty field and a card', () => {
  for (const unit of ['\x1b[A', '\x1b[B']) {
    assert.equal(router.route('sequence', unit, BARE), 'composer', 'with no card it browses history')
    assert.equal(router.route('sequence', unit, view({ workspaceCards: true, composerEmpty: false })), 'composer', 'a draft keeps the arrow in the field')
    assert.equal(router.route('sequence', unit, BARE_WITH_CARDS), 'workspace', 'empty field + a card is the focus ring')
  }
})

test('every decision is one of the four owners, and the view is never written', () => {
  const kinds = ['text', 'control', 'sequence', 'paste', 'escape']
  const units = ['a', '\r', '\x0c', '\x03', '\x1b', '\x1b[A', '\x1b[5~', '\x1b[3~', '\x1b[<0;1;1M', '\x1b[99;6u', 'pasted', '']
  const views = [SCREEN, SURFACE, SURFACE_FIELD, BARE, BARE_WITH_CARDS]
  for (const kind of kinds) {
    for (const unit of units) {
      for (const snapshot of views) {
        const frozen = Object.freeze({ ...snapshot })
        const owner = router.route(kind, unit, frozen)
        assert.ok(['screen', 'surface', 'composer', 'workspace'].includes(owner), `${kind} ${JSON.stringify(unit)} → ${owner}`)
        // Determinism and purity: the same question twice is the same answer, and the
        // snapshot (frozen here) was not written to.
        assert.equal(router.route(kind, unit, frozen), owner)
      }
    }
  }
  // A fresh router answers identically: the decision lives in the arguments.
  assert.equal(new InputRouter().route('text', 'a', BARE), 'composer')
})
