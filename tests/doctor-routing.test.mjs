import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { screenText, waitForScreen } from './wait.mjs'

setLocale('zh')

/**
 * A real TUI, with only the LLM directory and the llm-pi-ai settings stubbed.
 *
 * The doctor's routing check must be exercised through `/doctor`, not by
 * asserting a standalone array union: the bug was in the facts the real command
 * collects from the running context.
 */
async function withHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-doc-routing-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  return home
}

function makeTui({ listed = [], providers, provider = 'deepseek-official', model = 'deepseek-v4-pro', sub } = {}) {
  const llm = {
    listProviders() {
      if (listed instanceof Error) throw listed
      return listed.map(id => ({ id, name: id }))
    },
  }
  const settings = providers === undefined
    ? undefined
    : { get: ns => (ns === 'llm-pi-ai' ? { providers } : undefined) }
  const ctx = {
    get(name) {
      if (name === 'llm') return llm
      if (name === 'settings') return settings
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: { provider, model },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.write = () => {}
  if (sub !== undefined) tui.subagentSelection.current = sub
  return tui
}

async function doctorReport(tui) {
  tui.runCommand('/doctor')
  await waitForScreen(tui, '部署体检')
  const report = screenText(tui)
  assert.ok(report.includes('/doctor'), report)
  return report
}

test('a registered official adapter with no llm-pi-ai profile has no routing warning', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({ listed: ['deepseek-official'] }))
  assert.match(report, /默认路由与子代理模型自洽/u, report)
  assert.equal(report.includes('deepseek-official'), false, 'the official route is registered evidence, not a missing route')
})

test('an unregistered official adapter with no llm-pi-ai profile still reports provider missing', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({ listed: [] }))
  assert.match(report, /默认提供商 deepseek-official 既未注册也未配置/u, report)
})

test('an unavailable adapter directory does not crash /doctor and falls back to configured routes', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({
    listed: new Error('adapter directory unavailable'),
    providers: { 'opencode-go': { models: [{ id: 'deepseek-v4-flash' }] } },
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
  }))
  assert.match(report, /默认路由与子代理模型自洽/u, report)
})

test('a configured third-party route with a legal model is OK without a registered adapter', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({
    listed: [],
    providers: { 'opencode-go': { models: [{ id: 'deepseek-v4-flash' }] } },
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
  }))
  assert.match(report, /默认路由与子代理模型自洽/u, report)
})

test('a third-party provider absent from every source still reports provider missing', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({
    listed: ['deepseek-official'],
    provider: 'ghost',
    model: 'deepseek-v4-pro',
  }))
  assert.match(report, /默认提供商 ghost 既未注册也未配置/u, report)
})

test('a configured third-party route with an illegal model reports model missing', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({
    listed: ['opencode-go'],
    providers: { 'opencode-go': { models: [{ id: 'deepseek-v4-pro' }] } },
    provider: 'opencode-go',
    model: 'deepseek-v4-flash',
  }))
  assert.match(report, /模型 deepseek-v4-flash 不在 opencode-go 的模型列表里/u, report)
})

test('a cross-family subagent pin reports a subagent mismatch', async t => {
  await withHome(t)
  const report = await doctorReport(makeTui({
    listed: ['deepseek-official'],
    sub: { provider: 'xai', model: 'deepseek-v4-flash' },
  }))
  assert.match(report, /子代理模型 deepseek-v4-flash 与父路由 xai 不同族/u, report)
})

test('adapter and configured route duplicates are merged, not diagnosed twice', async t => {
  await withHome(t)
  const tui = makeTui({
    listed: ['deepseek-official'],
    providers: { 'deepseek-official': { models: [{ id: 'deepseek-v4-pro' }] } },
  })
  const report = await doctorReport(tui)
  assert.match(report, /默认路由与子代理模型自洽/u, report)
  // Keep the real path as the primary evidence; this also pins the dedupe in
  // the collected facts without depending on a particular report layout.
  const routes = tui.doctorRouting().routes
  assert.deepEqual(routes, ['deepseek-official'], 'one official id, not two')
})
