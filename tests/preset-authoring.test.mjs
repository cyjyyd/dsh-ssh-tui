import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isRefusal,
  planCopy,
  planDelete,
  planMetadata,
  presetDirectory,
  validatePresetId,
} from '../lib/preset-authoring.js'

/** A discovered preset; `path` is the composition file upstream hands out. */
function preset(id, overrides = {}) {
  return {
    id,
    trust: 'user',
    path: `/home/u/.dsh/.agent-presets/${id}/agent.cordis.yml`,
    ...overrides,
  }
}

test('ids follow the discovery rule', () => {
  assert.equal(validatePresetId('review-only'), true)
  assert.equal(validatePresetId('a1'), true)
  assert.equal(validatePresetId('Review'), false, 'uppercase never reaches discovery')
  assert.equal(validatePresetId('-lead'), false)
  assert.equal(validatePresetId('has space'), false)
  assert.equal(validatePresetId(''), false)
})

test('the preset directory is where the composition file lives', () => {
  assert.equal(presetDirectory(preset('x')), '/home/u/.dsh/.agent-presets/x')
})

test('a copy carries the source id, the free destination, and an optional name', () => {
  const plan = planCopy({ presets: [preset('standard', { trust: 'system' })], authorable: true, from: 'standard', id: 'review-only', name: ' 只读审查 ' })
  assert.equal(isRefusal(plan), false)
  assert.deepEqual(plan, { kind: 'copy', from: 'standard', id: 'review-only', name: '只读审查' })

  const unnamed = planCopy({ presets: [preset('standard', { trust: 'system' })], authorable: true, from: 'standard', id: 'x', name: '   ' })
  assert.deepEqual(unnamed, { kind: 'copy', from: 'standard', id: 'x' })
})

test('a copy refuses what upstream would refuse, before calling out', () => {
  const roster = [preset('taken'), preset('standard', { trust: 'system' })]
  assert.deepEqual(planCopy({ presets: roster, authorable: true, from: 'standard', id: 'Bad Id' }), { error: 'invalid-id', id: 'Bad Id' })
  assert.deepEqual(planCopy({ presets: roster, authorable: true, from: 'standard', id: 'taken' }), { error: 'exists', id: 'taken', name: 'taken' })
  assert.deepEqual(planCopy({ presets: roster, authorable: true, from: 'ghost', id: 'fresh' }), { error: 'not-found', id: 'ghost' })
  assert.deepEqual(planCopy({ presets: roster, authorable: false, from: 'standard', id: 'fresh' }), { error: 'read-only' })
})

test('a metadata edit merges, keeps order, and refuses a shipped preset', () => {
  const plan = planMetadata({
    preset: preset('mine'),
    current: { description: '旧描述', order: 3 },
    patch: { name: '只读审查' },
  })
  assert.equal(isRefusal(plan), false)
  assert.equal(plan.directory, '/home/u/.dsh/.agent-presets/mine')
  assert.match(plan.text, /name: 只读审查/u)
  assert.match(plan.text, /description: 旧描述/u, 'editing the name keeps the description')
  assert.match(plan.text, /order: 3/u, 'order survives the edit')

  const described = planMetadata({ preset: preset('mine'), current: { name: '只读审查' }, patch: { description: '新描述' } })
  assert.equal(isRefusal(described), false)
  assert.match(described.text, /name: 只读审查/u)
  assert.match(described.text, /description: 新描述/u)

  assert.deepEqual(
    planMetadata({ preset: preset('standard', { trust: 'system' }), current: {}, patch: { name: 'x' } }),
    { error: 'system', id: 'standard' },
  )
  assert.deepEqual(
    planMetadata({ preset: preset('mine'), current: {}, patch: { name: '  ' } }),
    { error: 'empty-metadata', id: 'mine' },
    'nothing left to publish is a refusal, not a file deletion',
  )
})

test('a delete refuses shipped and running presets', () => {
  assert.deepEqual(planDelete({ preset: preset('mine'), authorable: true, current: false }), { kind: 'delete', id: 'mine' })
  assert.deepEqual(
    planDelete({ preset: preset('standard', { trust: 'system' }), authorable: true, current: false }),
    { error: 'system', id: 'standard' },
  )
  assert.deepEqual(
    planDelete({ preset: preset('mine'), authorable: true, current: true }),
    { error: 'running', id: 'mine' },
  )
  assert.deepEqual(
    planDelete({ preset: preset('mine'), authorable: false, current: false }),
    { error: 'read-only' },
  )
})
