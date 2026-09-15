import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import {
  comparePresets,
  optionMatches,
  filterPresets,
  flattenGroups,
  groupPresets,
  presetOptionDescription,
} from '../lib/preset-picker.js'

/**
 * B-2: the `/mode` list is grouped, ordered, and says what each preset is.
 *
 * The dialog renders a flat list, so the group has to survive as order plus
 * text: shipped presets first, each line naming its group, and a preset that
 * declares a position showing it.
 */
setLocale('zh')

const preset = (id, extra = {}) => ({ id, trust: 'system', path: `/p/${id}/agent.cordis.yml`, ...extra })

test('shipped presets come before locally authored ones', () => {
  const groups = groupPresets([
    preset('mine', { trust: 'user' }),
    preset('standard'),
    preset('ptc'),
  ], 'standard')
  assert.deepEqual(groups.map(group => group.trust), ['system', 'user'])
  assert.deepEqual(flattenGroups(groups).map(option => option.id), ['ptc', 'standard', 'mine'])
  assert.ok(groups[0].options[0].description.startsWith('官方'), 'each line names its group')
  assert.ok(groups[1].options[0].description.startsWith('本地'))
})

test('a declared position wins, undeclared presets follow by id', () => {
  const list = [
    preset('zulu', { order: 1 }),
    preset('alpha'),
    preset('mike', { order: 2 }),
    preset('bravo'),
  ].sort(comparePresets)
  assert.deepEqual(list.map(item => item.id), ['zulu', 'mike', 'alpha', 'bravo'])
  assert.equal(comparePresets(preset('a', { order: 5 }), preset('b')), -1, 'declared sorts before undeclared')
  assert.equal(comparePresets(preset('a'), preset('b')), -1, 'and the rest by id')
})

test('the line marks the current preset and shows its position', () => {
  const line = presetOptionDescription(preset('standard', { order: 3, description: '适合日常' }), 'standard')
  assert.match(line, /官方/u)
  assert.match(line, /当前/u)
  assert.match(line, /适合日常/u)
  assert.match(line, /第 3 位/u)
  const plain = presetOptionDescription(preset('minimal'), 'standard')
  assert.equal(plain.includes('当前'), false, 'a preset that is not in effect is not marked')
})

test('a broken preset leads with its reason instead of its prose', () => {
  const line = presetOptionDescription(
    preset('gone', { broken: '缺少包 @deepseek-ai/dsh-host-nope', description: '一段介绍' }),
    'standard',
  )
  assert.match(line, /缺少包/u)
  assert.equal(line.includes('一段介绍'), false, 'the reason replaces the description')
})

test('an empty group is omitted rather than shown as a header', () => {
  const groups = groupPresets([preset('standard')], 'standard')
  assert.deepEqual(groups.map(group => group.trust), ['system'])
})

test('a typed query narrows by id, name, or description', () => {
  const list = [
    preset('standard', { name: '标准模式', description: '适合日常' }),
    preset('ptc', { name: 'PTC', description: 'plan-then-code 流程' }),
    preset('mine', { trust: 'user', name: '我的模式' }),
  ]
  assert.equal(filterPresets(list, '').length, 3, 'an empty query keeps the roster')
  assert.deepEqual(filterPresets(list, 'ptc').map(item => item.id), ['ptc'], 'by id')
  assert.deepEqual(filterPresets(list, '我的').map(item => item.id), ['mine'], 'by name')
  assert.deepEqual(filterPresets(list, 'PLAN-THEN').map(item => item.id), ['ptc'], 'by description, case-insensitively')
  assert.deepEqual(filterPresets(list, 'nothing'), [])
})

test('a preset answers to its id, its published name, and its label', () => {
  const groups = groupPresets([preset('standard', { name: 'Standard Mode' })], 'standard')
  const option = groups[0]?.options[0]
  assert.ok(option !== undefined)
  assert.equal(optionMatches(option, 'standard'), true, 'by id')
  assert.equal(optionMatches(option, 'Standard Mode'), true, 'by the name it published')
  assert.equal(optionMatches(option, '标准模式'), true, 'and by the label it shows')
  assert.equal(optionMatches(option, 'nope'), false)
  assert.equal(optionMatches(option, ''), false, 'an empty query selects nothing')
})

test('a user preset keeps its published name among the aliases', () => {
  const groups = groupPresets([preset('mine', { trust: 'user', name: '我的模式' })], 'standard')
  const option = groups[0]?.options[0]
  assert.ok(option !== undefined)
  assert.deepEqual(option.aliases, ['mine', '我的模式'], 'no duplicate for label === name')
})
