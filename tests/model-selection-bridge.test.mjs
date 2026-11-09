/**
 * U2.F1 — the Relay's model-selection bridge across the two tagged host APIs.
 *
 * The 0.2.1 line owns selection through a mutable ModelSelectionRef passed to a
 * two-argument installModelSelection; 0.2.2 removed the argument and owns it
 * through Agent.model. These tests pin the structural bridge, including the
 * negative result on a legacy Agent and a Host rejection.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { SshTui } from '../lib/tui.js'
import { setLocale } from '../lib/i18n/index.js'

import {
  currentAgentSelection,
  installModelSelectionCompat,
  selectAgentModel,
} from '../lib/dsh-compat.js'

setLocale('en')

test('installModelSelectionCompat selects the two-argument legacy listener', () => {
  const calls = []
  const install = (ctx, ref) => { calls.push([ctx, ref]) }
  const ctx = { name: 'ctx' }
  const ref = { current: { provider: 'p', model: 'm' } }
  installModelSelectionCompat(install, ctx, ref)
  assert.deepEqual(calls, [[ctx, ref]])
})

test('installModelSelectionCompat selects the one-argument 0.2.2 listener', () => {
  const calls = []
  const install = (ctx) => { calls.push([ctx]) }
  const ctx = { name: 'ctx' }
  installModelSelectionCompat(install, ctx, { current: { provider: 'p', model: 'm' } })
  assert.deepEqual(calls, [[ctx]])
})

test('selectAgentModel writes through Agent.model and currentAgentSelection reads it back', () => {
  let selected
  const agent = {
    model: {
      current: () => selected,
      select: selection => { selected = selection },
    },
  }
  const next = { provider: 'p', model: 'm2', reasoningEffort: 'high' }
  assert.equal(selectAgentModel(agent, next), true)
  assert.deepEqual(currentAgentSelection(agent), next)
})

test('the legacy line has no Agent.model: the bridge stays inert', () => {
  const agent = { options: { provider: 'p', model: 'm' } }
  assert.equal(selectAgentModel(agent, { provider: 'p', model: 'm2' }), false)
  assert.equal(currentAgentSelection(agent), undefined)
})

test('a Host rejection is reported and not mistaken for a successful route', () => {
  const agent = { model: { select() { throw new Error('unknown model') } } }
  assert.equal(selectAgentModel(agent, { provider: 'p', model: 'nope' }), false)
})

test('a malformed current selection is ignored rather than painted as a route', () => {
  assert.equal(currentAgentSelection({ model: { current: () => ({ provider: '', model: 'm' }) } }), undefined)
  assert.equal(currentAgentSelection({ model: { current: () => { throw new Error('gone') } } }), undefined)
})


test('the TUI does not commit a route the Host callback rejects', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
  const selectionRef = { current: { provider: 'p', model: 'old' }, assembled: undefined }
  const tui = new SshTui(ctx, agent, {
    sessionId: 's', color: false, headlessDisplay: true, selectionRef,
    onSelectionChanged: () => false,
  })
  assert.throws(
    () => tui.applySelection({ provider: 'p', model: 'new' }),
    /Host did not accept/,
  )
  assert.deepEqual(selectionRef.current, { provider: 'p', model: 'old' })
  await tui.dispose()
})
