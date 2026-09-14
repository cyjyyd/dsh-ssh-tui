import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import { isShippedPreset, presetLabel, profileFromArgv } from '../lib/preset-label.js'

test('shipped preset ids resolve through the active locale', () => {
  setLocale('zh')
  assert.equal(presetLabel('standard'), '标准模式')
  assert.equal(presetLabel('minimal'), '极简模式')
  assert.equal(presetLabel('ptc'), 'PTC 模式')
  assert.equal(presetLabel('cordis'), '创造模式')
  // The roster's own metadata must not override the dictionary for a shipped
  // preset: the file carries one language, the picker follows /language.
  assert.equal(presetLabel('standard', '标准模式', 'system'), '标准模式')
  setLocale('en')
  assert.equal(presetLabel('standard', '标准模式', 'system'), 'Standard')
  assert.equal(presetLabel('ptc', 'PTC 模式', 'system'), 'PTC')
  setLocale('zh')
})

test('user-authored presets keep the name their preset.yml published', () => {
  assert.equal(presetLabel('routing-suite', '智能路由模式', 'user'), '智能路由模式')
  assert.equal(presetLabel('whoami-standard', 'Whoami Standard (experimental)', 'user'), 'Whoami Standard (experimental)')
  // A shipped id stays localized even when it was copied into a user root.
  assert.equal(presetLabel('standard', '我的标准', 'user'), '我的标准')
})

test('a missing or id-shaped name falls back without leaking an empty label', () => {
  assert.equal(presetLabel('standard', undefined, 'system'), '标准模式')
  assert.equal(presetLabel('standard', 'standard', 'system'), '标准模式')
  assert.equal(presetLabel('standard', '   ', 'system'), '标准模式')
  assert.equal(presetLabel('my-mode', undefined, 'user'), 'my-mode')
  assert.equal(presetLabel('my-mode', 'my-mode'), 'my-mode')
  assert.equal(presetLabel('routing-suite', undefined, 'user'), 'routing-suite')
  assert.equal(isShippedPreset('standard'), true)
  assert.equal(isShippedPreset('routing-suite'), false)
})

test('profileFromArgv reads both --profile spellings', () => {
  assert.equal(profileFromArgv(['dsh', '--profile', 'tui']), 'tui')
  assert.equal(profileFromArgv(['dsh', '--profile=work']), 'work')
  assert.equal(profileFromArgv(['dsh', '--profile', 'tui', '--resume=s1']), 'tui')
  assert.equal(profileFromArgv(['dsh', '--profile=web', '--profile', 'tui']), 'web')
  assert.equal(profileFromArgv(['dsh']), 'tui')
  assert.equal(profileFromArgv(['dsh', '--profile', '--resume=s1']), 'tui')
  assert.equal(profileFromArgv(['dsh', '--profile=']), 'tui')
})

test('the missing-roster report names the repair, not just the failure', () => {
  setLocale('zh')
  const zh = t('mode.missingServiceHint', { profile: 'tui', patch: '/root/.dsh/profiles/tui/cordis.patch.yml' })
  assert.ok(zh.includes('/root/.dsh/profiles/tui/cordis.patch.yml'))
  assert.ok(zh.includes('/mode fix'))
  assert.ok(zh.includes('ensure-profile-rows.sh'))
  assert.ok(t('mode.missingService').includes('agentPresets'))
  assert.ok(t('mode.bootMissing').includes('ask_user_question'))
  setLocale('en')
  const en = t('mode.missingServiceHint', { profile: 'tui', patch: '/root/.dsh/profiles/tui/cordis.patch.yml' })
  assert.ok(en.includes('/root/.dsh/profiles/tui/cordis.patch.yml'))
  assert.ok(en.includes('/mode fix'))
  assert.equal(en.includes('{patch}'), false)
  assert.ok(t('mode.fixWritten', { patch: '/p' }).includes('/p'))
  setLocale('zh')
})
