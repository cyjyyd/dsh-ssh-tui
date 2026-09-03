import test from 'node:test'
import assert from 'node:assert/strict'

import { localeFromTag, resolveLocale, setLocale, t } from '../lib/i18n/index.js'
import { footerActivity, presentToolCall, promptInjectionTitle, SshTui } from '../lib/tui.js'

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

test('colored tool headers keep zh and en titles between the dot and [ok]', () => {
  const prevTerm = process.env.TERM
  const prevNoColor = process.env.NO_COLOR
  process.env.TERM = 'xterm-256color'
  delete process.env.NO_COLOR
  const paint = (locale, name) => {
    setLocale(locale)
    const ctx = { get: () => undefined, on() { return () => {} } }
    const agent = {
      id: 'main-session',
      options: { provider: 'xai', model: 'grok-4.6' },
      status: 'idle',
      session: { id: 'main-session', events: [] },
      cancel() {},
    }
    const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: true, provider: 'xai' })
    tui.rows.push({
      kind: 'tool', callId: `c-${locale}-${name}`, name, title: name,
      summary: 'src/tui.ts', args: '{}', output: 'ok', status: 'ok', expanded: false,
    })
    return tui.captureFrame(72, 14).join('\n')
  }
  try {
    const zh = paint('zh', 'edit')
    assert.match(zh, /\x1b\[32m●/)
    assert.match(zh, /编辑/)
    assert.match(zh, /\x1b\[32m\[ok\]/)
    const en = paint('en', 'edit')
    assert.match(en, /\x1b\[32m●/)
    assert.match(en, /edit/)
    assert.match(en, /\x1b\[32m\[ok\]/)
    const enRead = paint('en', 'read')
    assert.match(enRead, /read/)
    const zhRead = paint('zh', 'read')
    assert.match(zhRead, /读取/)
  } finally {
    setLocale('zh')
    if (prevTerm === undefined) delete process.env.TERM
    else process.env.TERM = prevTerm
    if (prevNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prevNoColor
  }
})
