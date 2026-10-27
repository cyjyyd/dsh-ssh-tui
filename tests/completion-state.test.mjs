import test from 'node:test'
import assert from 'node:assert/strict'

import {
  acceptCompletion,
  completionFor,
  dismissCompletion,
  EMPTY_COMPLETION,
  moveCompletion,
  resetCompletion,
} from '../lib/completion.js'

const items = [
  { name: 'help', description: 'help', local: true },
  { name: 'model', description: 'model', local: true },
  { name: 'submodel', description: 'submodel', local: true },
]
const listed = (query = '/', source = items, previous) => completionFor({ query, items: source, ...(previous === undefined ? {} : { previous }) })

test('completionFor lists only slash drafts with items and no layer', () => {
  assert.equal(completionFor({ query: '', items }).visible, false)
  assert.equal(completionFor({ query: 'hello', items }).visible, false)
  assert.equal(completionFor({ query: '/', items: [] }).visible, false)
  const state = completionFor({ query: '/he', items: [items[0]] })
  assert.equal(state.visible, true)
  assert.equal(state.query, '/he')
  assert.deepEqual(state.items.map(item => item.name), ['help'])
})

test('completionFor hides in line mode and under a Screen/Surface while keeping the draft query', () => {
  assert.equal(completionFor({ query: '/', items, lineMode: true }).visible, false)
  const layered = completionFor({ query: '/', items, layerOpen: true })
  assert.equal(layered.phase, 'hidden')
  assert.equal(layered.query, '/')
  assert.equal(layered.items.length, 0)
})

test('the highlight clamps, never wraps, and survives a same-query refresh', () => {
  let state = completionFor({ query: '/', items })
  assert.equal(state.index, 0)
  state = moveCompletion(state, -1)
  assert.equal(state.index, 0, 'no wrap at the top')
  state = moveCompletion(state, 1)
  assert.equal(state.index, 1)
  state = moveCompletion(state, 3)
  assert.equal(state.index, 2, 'clamped at the bottom')
  state = completionFor({ query: '/', items, previous: state })
  assert.equal(state.index, 2, 'same query preserves the highlight')
  state = completionFor({ query: '/m', items, previous: state })
  assert.equal(state.index, 0, 'a new query starts at the top')
})

test('dismissal persists for the exact draft and dies on the next edit', () => {
  const state = dismissCompletion(listed('/'), '/')
  assert.equal(state.phase, 'dismissed')
  assert.equal(state.dismissedFor, '/')
  assert.equal(state.visible, false)
  const same = completionFor({ query: '/', items, previous: state })
  assert.equal(same.phase, 'dismissed')
  assert.equal(same.visible, false)
  const changed = completionFor({ query: '/m', items, previous: same })
  assert.equal(changed.visible, true, 'a different draft is a new question')
  assert.equal(changed.dismissedFor, undefined)
})

test('Tab accepts the highlight and dismisses the written text', () => {
  let state = listed('/')
  state = moveCompletion(state, 1)
  const accepted = acceptCompletion(state, '/', 'tab')
  assert.deepEqual(accepted, {
    text: '/model ',
    cursor: 7,
    state: {
      phase: 'dismissed',
      query: '/model ',
      items: [],
      index: 0,
      dismissedFor: '/model ',
      visible: false,
    },
  })
  const refreshed = completionFor({ query: accepted.text, items, previous: accepted.state })
  assert.equal(refreshed.phase, 'dismissed', 'the accepted draft stays dismissed')
})

test('Enter keeps the byte-for-byte prefix guard', () => {
  const containsOnly = completionFor({ query: '/ag', items: [] })
  assert.equal(acceptCompletion(containsOnly, '/ag', 'enter'), undefined)
  const help = listed('/he')
  const accepted = acceptCompletion(help, '/he', 'enter')
  assert.equal(accepted.text, '/help', 'Enter writes the bare command and the caller submits it')
  assert.equal(accepted.cursor, 5)
  assert.equal(accepted.state.dismissedFor, '/help')
  const caseMismatch = completionFor({ query: '/HELP', items: [{ name: 'help', description: '', local: true }] })
  assert.equal(acceptCompletion(caseMismatch, '/HELP', 'enter'), undefined)
})

test('reset returns the empty state and does not share mutable items', () => {
  const first = resetCompletion()
  const second = resetCompletion()
  assert.equal(first.visible, false)
  assert.equal(first.query, '')
  assert.deepEqual(first.items, [])
  assert.equal(EMPTY_COMPLETION.visible, false)
  assert.notEqual(first, second, 'reset is safe to hand to a new owner')
})
