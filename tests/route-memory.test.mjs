import test from 'node:test'
import assert from 'node:assert/strict'

import {
  latestRememberedRoute,
  parseRouteMemory,
  rememberedRouteFor,
  upsertRememberedRoute,
} from '../lib/route-memory.js'

test('route memory keeps one last model/effort per provider', () => {
  const first = upsertRememberedRoute({}, 'xai', { model: 'grok-4.6', reasoningEffort: 'xhigh' })
  const both = upsertRememberedRoute(first, 'deepseek-official', { model: 'deepseek-v4-pro' })
  const xai = rememberedRouteFor(both, 'xai')
  assert.equal(xai?.model, 'grok-4.6')
  assert.equal(xai?.reasoningEffort, 'xhigh')
  assert.ok((xai?.updatedAt ?? 0) > 0)
  assert.equal(rememberedRouteFor(both, 'deepseek-official')?.model, 'deepseek-v4-pro')
  const updated = upsertRememberedRoute(both, 'xai', { model: 'grok-4.5', reasoningEffort: 'high' })
  assert.equal(rememberedRouteFor(updated, 'deepseek-official')?.model, 'deepseek-v4-pro')
  const updatedXai = rememberedRouteFor(updated, 'xai')
  assert.equal(updatedXai?.model, 'grok-4.5')
  assert.equal(updatedXai?.reasoningEffort, 'high')
})

test('parseRouteMemory ignores junk entries and keeps updatedAt', () => {
  assert.deepEqual(parseRouteMemory(null), {})
  const parsed = parseRouteMemory({
    xai: { model: 'grok-4.6', reasoningEffort: 'xhigh' },
    bad: 1,
  })
  assert.deepEqual(parsed, { xai: { model: 'grok-4.6', reasoningEffort: 'xhigh' } })
  const withTime = parseRouteMemory({
    xai: { model: 'grok-4.6', updatedAt: 12345 },
  })
  assert.equal(withTime.xai?.updatedAt, 12345)
})

test('upsertRememberedRoute stamps updatedAt so the newest switch wins', () => {
  const clock = Date.now
  try {
    let now = 1000
    Date.now = () => now
    let memory = upsertRememberedRoute({}, 'xai', { model: 'grok-4.6' })
    now = 2000
    memory = upsertRememberedRoute(memory, 'opencode-go', { model: 'deepseek-v4-flash' })
    const latest = latestRememberedRoute(memory)
    assert.equal(latest?.provider, 'opencode-go')
    assert.equal(latest?.updatedAt, 2000)
  } finally {
    Date.now = clock
  }
  // Legacy entries without updatedAt rank last.
  const legacy = latestRememberedRoute({
    xai: { model: 'grok-4.6' },
    official: { model: 'deepseek-v4-flash', updatedAt: Date.now() },
  })
  assert.equal(legacy?.provider, 'official')
})
