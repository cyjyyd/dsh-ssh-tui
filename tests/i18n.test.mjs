import test from 'node:test'
import assert from 'node:assert/strict'

import { localeFromTag, resolveLocale, setLocale, t } from '../lib/i18n/index.js'
import { footerActivity, presentToolCall, promptInjectionTitle } from '../lib/tui.js'

test('localeFromTag maps zh/en and ignores C/POSIX', () => {
  assert.equal(localeFromTag('zh_CN.UTF-8'), 'zh')
  assert.equal(localeFromTag('en-US'), 'en')
  assert.equal(localeFromTag('english'), 'en')
  assert.equal(localeFromTag('C'), undefined)
  assert.equal(localeFromTag('POSIX'), undefined)
})

test('DSH_TUI_LANG wins over LANG', () => {
  assert.equal(resolveLocale({ DSH_TUI_LANG: 'en', LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLocale({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(resolveLocale({ LANG: 'C' }), 'zh')
  assert.equal(resolveLocale({ DSH_TUI_LANG: 'en' }, 'zh'), 'en')
  assert.equal(resolveLocale({}, 'en'), 'en')
})

test('/language catalog switches chrome and tool titles', () => {
  setLocale('zh')
  assert.equal(footerActivity({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'x', provider: 'xai', parentModel: 'x', subModel: 'x', subDiffers: false,
    foldedInput: false, multiLineInput: false, queued: 0,
  }).text, '空闲')
  assert.equal(presentToolCall('edit', JSON.stringify({ file_path: 'a.ts' })).title, '编辑')
  assert.equal(promptInjectionTitle(['系统预设', 'AGENTS.MD']), '提示词注入:系统预设 AGENTS.MD')

  setLocale('en')
  assert.equal(footerActivity({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'x', provider: 'xai', parentModel: 'x', subModel: 'x', subDiffers: false,
    foldedInput: false, multiLineInput: false, queued: 0,
  }).text, 'idle')
  assert.equal(presentToolCall('edit', JSON.stringify({ file_path: 'a.ts' })).title, 'edit')
  assert.equal(t('lang.cmd').includes('zh'), true)
  assert.equal(t('boot.help').includes('/help'), true)
  setLocale('zh')
})
