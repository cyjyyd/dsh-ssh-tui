import test from 'node:test'
import assert from 'node:assert/strict'

import { localeFromTag, resolveLocale, setLocale, t } from '../lib/i18n/index.js'
import { zh } from '../lib/i18n/zh.js'
import { en } from '../lib/i18n/en.js'
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
  assert.equal(t('lang.cmd').includes('Chinese') || t('lang.cmd').includes('English'), true)
  assert.equal(t('boot.help').includes('/help'), true)
  setLocale('zh')
})

test('colored tool headers keep zh and en titles after the status dot', () => {
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
    assert.equal(zh.includes('[ok]'), false)
    const en = paint('en', 'edit')
    assert.match(en, /\x1b\[32m●/)
    assert.match(en, /edit/)
    assert.equal(en.includes('[ok]'), false)
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

test('slash command descriptions are complete and bilingual in zh and en', () => {
  const zhCmdKeys = Object.keys(zh).filter(k => k.startsWith('cmd.'))
  const enCmdKeys = Object.keys(en).filter(k => k.startsWith('cmd.'))
  assert.ok(zhCmdKeys.length >= 25)
  assert.deepEqual(zhCmdKeys.sort(), enCmdKeys.sort())

  // Verify key guidance in /permission
  assert.ok(zh['cmd.permission'].includes('workspace-write'))
  assert.ok(zh['cmd.permission'].includes('danger-full-access'))
  assert.ok(en['cmd.permission'].includes('workspace-write'))
  assert.ok(en['cmd.permission'].includes('danger-full-access'))

  // Verify parameter guidance in /approval, /disconnect, /view, /plan, /goal
  assert.ok(zh['cmd.approval'].includes('auto'))
  assert.ok(en['cmd.approval'].includes('auto'))
  assert.ok(zh['cmd.disconnect'].includes('pause') && zh['cmd.disconnect'].includes('continue'))
  assert.ok(en['cmd.disconnect'].includes('pause') && en['cmd.disconnect'].includes('continue'))
  assert.ok(zh['cmd.view'].includes('detailed') && zh['cmd.view'].includes('compact'))
  assert.ok(en['cmd.view'].includes('detailed') && en['cmd.view'].includes('compact'))
  assert.ok(zh['cmd.plan'].includes('/plan off'))
  assert.ok(en['cmd.plan'].includes('/plan off'))
})

test('slash suggestions and help output include localized dsh commands', () => {
  const commandsMock = {
    list: () => [
      { name: 'permission', description: 'Switch the permission preset', input: { hint: '<preset>' } },
      { name: 'plan', description: 'Enter or leave plan mode', input: { hint: '[off|message]' } },
    ],
  }
  const ctx = { get: (name) => (name === 'commands' ? commandsMock : undefined), on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.input = '/per'
  tui.cursor = 4
  const frame = tui.captureFrame(120, 24).join('\n')
  assert.ok(frame.includes('/permission'))
  assert.ok(frame.includes('权限预设'))
  assert.ok(frame.includes('workspace-write'))
})

test('dsh command execute does not reprint a result already shown by command/done', async () => {
  setLocale('zh')
  const executions = []
  const commandsMock = {
    list: () => [{ name: 'permission', description: 'Switch the permission preset' }],
    execute: async () => {
      executions.push(1)
      return {
        commandId: 'cmd-perm-once',
        result: {
          kind: 'success',
          text: 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)',
        },
      }
    },
  }
  const ctx = { get: (name) => (name === 'commands' ? commandsMock : undefined), on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const before = tui.rows.filter(row => row.kind === 'system').length
  tui.handleSessionEvent(agent.session, {
    type: 'command/done',
    data: {
      commandId: 'cmd-perm-once',
      kind: 'success',
      text: 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)',
    },
  })
  tui.runCommand('/permission')
  await new Promise(resolve => setTimeout(resolve, 20))
  const after = tui.rows.filter(row => row.kind === 'system' && String(row.text).includes('当前权限预设'))
  assert.equal(executions.length, 1)
  assert.equal(after.length, 1, 'command/done plus execute must not double-print')
  assert.equal(tui.rows.filter(row => row.kind === 'system').length, before + 1)
})

test('permission command output is printed once and localized in zh and en', () => {
  setLocale('zh')
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })

  const initialSysCount = tui.rows.filter(row => row.kind === 'system').length
  tui.handleSessionEvent(agent.session, {
    type: 'command/done',
    data: {
      commandId: 'cmd-perm',
      kind: 'success',
      text: 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)',
    },
  })

  // Verify only one system row is added and the text is localized
  const sysRows = tui.rows.filter(row => row.kind === 'system')
  assert.equal(sysRows.length, initialSysCount + 1)
  const line = String(sysRows[sysRows.length - 1]?.text ?? '')
  assert.ok(line.includes('当前权限预设：'))
  assert.ok(line.includes('工作区读写'))
  assert.ok(line.includes('只读'))
  assert.ok(line.includes('完全访问'))

  // Switch to en and test
  setLocale('en')
  const tuiEn = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const initialEnCount = tuiEn.rows.filter(row => row.kind === 'system').length
  tuiEn.handleSessionEvent(agent.session, {
    type: 'command/done',
    data: {
      commandId: 'cmd-perm-2',
      kind: 'success',
      text: 'current preset workspace-write (available: read-only, workspace-write, danger-full-access)',
    },
  })
  const enRows = tuiEn.rows.filter(row => row.kind === 'system')
  assert.equal(enRows.length, initialEnCount + 1)
  const enLine = String(enRows[enRows.length - 1]?.text ?? '')
  assert.ok(enLine.includes('Current permission preset:'))
  assert.ok(enLine.includes('Workspace Write'))
  assert.ok(enLine.includes('Read-Only'))
  assert.ok(enLine.includes('Full Access'))
  setLocale('zh')
})

test('effort command adjusts current model reasoning effort with manual override and default fallback', async () => {
  setLocale('zh')
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: { provider: 'test-provider', model: 'test-model' }, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.selectionRef = { current: { provider: 'test-provider', model: 'test-model' } }

  // 1. Check direct setting to high
  tui.runCommand('/effort high')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.selectionRef.current.reasoningEffort, 'high')
  assert.ok(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('已更新思考强度') && String(row.text).includes('high')))

  // 2. Check fallback to default (undefined reasoningEffort)
  tui.runCommand('/effort default')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.selectionRef.current.reasoningEffort, undefined)
  assert.ok(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('默认（不显式传参）')))

  // 3. Check /effort in suggestions
  tui.input = '/eff'
  tui.cursor = 4
  const frame = tui.captureFrame(120, 24).join('\n')
  assert.ok(frame.includes('/effort'))
  assert.ok(frame.includes('思考强度'))

  // 4. Junk values must not be branded into the selection
  tui.runCommand('/effort not an effort')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.selectionRef.current.reasoningEffort, undefined)
  assert.ok(tui.rows.some(row => row.kind === 'error' && String(row.text).includes('未知思考强度')))
})
