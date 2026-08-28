import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseRouteMemory,
  rememberedRouteFor,
  upsertRememberedRoute,
} from '../lib/route-memory.js'

test('route memory keeps one last model/effort per provider', () => {
  const first = upsertRememberedRoute({}, 'xai', { model: 'grok-4.6', reasoningEffort: 'xhigh' })
  const both = upsertRememberedRoute(first, 'deepseek-official', { model: 'deepseek-v4-pro' })
  assert.deepEqual(rememberedRouteFor(both, 'xai'), { model: 'grok-4.6', reasoningEffort: 'xhigh' })
  assert.deepEqual(rememberedRouteFor(both, 'deepseek-official'), { model: 'deepseek-v4-pro' })
  const updated = upsertRememberedRoute(both, 'xai', { model: 'grok-4.5', reasoningEffort: 'high' })
  assert.equal(rememberedRouteFor(updated, 'deepseek-official')?.model, 'deepseek-v4-pro')
  assert.deepEqual(rememberedRouteFor(updated, 'xai'), { model: 'grok-4.5', reasoningEffort: 'high' })
})

test('parseRouteMemory ignores junk entries', () => {
  assert.deepEqual(parseRouteMemory(null), {})
  assert.deepEqual(parseRouteMemory({ xai: { model: 'grok-4.6', reasoningEffort: 'xhigh' }, bad: 1 }), {
    xai: { model: 'grok-4.6', reasoningEffort: 'xhigh' },
  })
})
