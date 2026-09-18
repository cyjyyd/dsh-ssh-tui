import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { errorText, systemText, tick, waitForDialog, waitForError, waitForText } from './wait.mjs'
import { SshTui } from '../lib/tui.js'

const ROSTER = [
  { id: 'standard', trust: 'system', path: '/p/standard', name: '标准模式', isDefault: true },
  { id: 'minimal', trust: 'system', path: '/p/minimal', name: '极简模式' },
  { id: 'ptc', trust: 'system', path: '/p/ptc', name: 'PTC 模式', broken: 'row tool-presentation requires codeRuntime' },
  { id: 'routing-suite', trust: 'user', path: '/p/routing-suite', name: '智能路由模式' },
]

function fixture(ctxOverrides = {}) {
  const composed = []
  const roster = ROSTER.map(preset => ({ ...preset }))
  const agentPresets = {
    list: async () => roster,
    recompose: async (_agentCtx, id) => {
      composed.push(id)
      return roster.find(preset => preset.id === id)
    },
  }
  const ctx = {
    get: (name) => (name === 'agentPresets' ? agentPresets : undefined),
    on() { return () => {} },
    ...ctxOverrides,
  }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return { tui: new SshTui(ctx, agent, { sessionId: 'main-session', color: false }), composed }
}


/**
 * Wait for `/mode fix` to land its write instead of sleeping once.
 *
 * The repair reads the patch, plans, and writes; a fixed tick read the file
 * before the write on a slow Windows runner and reported ENOENT for a repair
 * that had succeeded.
 */
async function waitForPatch(path, pattern, tui, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (pattern.test(text)) return text
    if (Date.now() >= deadline) {
      assert.fail(`timed out waiting for ${pattern} in ${path}; last content:\n${text}\n--- transcript ---\n${systemText(tui)}\n${errorText(tui)}`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

test('a missing roster is reported at the patch and repaired by /mode fix', async () => {
  setLocale('zh')
  const home = await mkdtemp(join(tmpdir(), 'dsh-mode-fix-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const { tui, composed } = fixture({ get: () => undefined })
    // The boot notice makes the degraded state visible before /mode is typed.
    const boot = tui.captureFrame(140, 20).join('\n')
    assert.ok(boot.includes('未挂载 agent-presets 名单'), boot)
    assert.ok(boot.includes('ask_user_question'), boot)
    assert.equal(composed.length, 0)

    tui.runCommand('/mode')
    await waitForText(tui, 'agentPresets 服务不可用')
    const report = errorText(tui)
    assert.ok(report.includes('agentPresets 服务不可用'), report)
    assert.ok(report.includes('/mode fix'), report)
    assert.ok(report.includes('cordis.patch.yml'), report)
    assert.ok(report.includes('ensure-profile-rows.sh'), report)

    tui.runCommand('/mode fix')
    const patch = join(home, 'profiles', 'tui', 'cordis.patch.yml')
    const written = await waitForPatch(patch, /agent-presets/u, tui)
    assert.ok(written.includes("name: '@deepseek-ai/dsh-agent-presets'"), written)
    assert.ok(written.includes('id: code-runtime'), written)
    assert.ok(systemText(tui).includes(patch), systemText(tui))

    // A second repair is a no-op, not a duplicate row.
    const before = tui.rows.length
    tui.runCommand('/mode fix')
    await tick(30)
    assert.ok(tui.rows.length > before)
    assert.equal(await readFile(patch, 'utf8'), written, 'a second repair is a no-op, not a duplicate row')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
  setLocale('en')
  const en = fixture({ get: () => undefined })
  en.tui.runCommand('/mode')
  await waitForText(en.tui, '/mode fix')
  assert.ok(errorText(en.tui).includes('/mode fix'))
  setLocale('zh')
})

test('a failing /mode fix reports the path and the error instead of throwing', async () => {
  setLocale('zh')
  const home = await mkdtemp(join(tmpdir(), 'dsh-mode-fix-'))
  const previousHome = process.env.DSH_HOME
  // A file standing where the home directory must be makes mkdir fail.
  const blocker = join(home, 'blocker')
  await writeFile(blocker, 'not a directory\n')
  process.env.DSH_HOME = blocker
  try {
    const { tui } = fixture({ get: () => undefined })
    tui.runCommand('/mode fix')
    await waitForError(tui, '写入')
    assert.ok(errorText(tui).includes('写入'), errorText(tui))
    assert.ok(errorText(tui).includes('cordis.patch.yml'), errorText(tui))
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('the banner names the default preset in the active language, not as a raw id', () => {
  setLocale('zh')
  const { tui } = fixture()
  const frame = tui.captureFrame(100, 12).join('\n')
  assert.ok(frame.includes('标准模式'), frame)
  assert.equal(frame.includes('[standard]'), false)
  setLocale('en')
  const en = fixture()
  assert.ok(en.tui.captureFrame(100, 12).join('\n').includes('Standard'))
  setLocale('zh')
})

test('a user root keeps its own name while a shipped root follows the locale', () => {
  setLocale('zh')
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const config = { sessionId: 'main-session', color: false, presetId: 'standard' }
  const user = new SshTui(ctx, agent, { ...config, presetName: '我的标准', presetTrust: 'user' })
  assert.ok(user.captureFrame(100, 12).join('\n').includes('我的标准'))
  const shipped = new SshTui(ctx, agent, { ...config, presetName: '标准模式', presetTrust: 'system' })
  assert.ok(shipped.captureFrame(100, 12).join('\n').includes('标准模式'))
})

test('/mode switches by id and by the label the picker shows', async () => {
  setLocale('zh')
  const { tui, composed } = fixture()
  tui.runCommand('/mode minimal')
  await waitForText(tui, '极简模式')
  assert.deepEqual(composed, ['minimal'])
  assert.ok(systemText(tui).includes('极简模式'), systemText(tui))

  // The localized label is what the user reads in the picker, so it is what
  // they can type back; a user-authored preset keeps its own name.
  tui.runCommand('/mode 智能路由模式')
  await waitForText(tui, '智能路由模式')
  assert.deepEqual(composed, ['minimal', 'routing-suite'])
  assert.ok(systemText(tui).includes('智能路由模式'))
  tui.runCommand('/mode PTC 模式')
  await waitForError(tui, 'codeRuntime')
  assert.deepEqual(composed, ['minimal', 'routing-suite'], 'a broken preset must not compose')
  assert.ok(errorText(tui).includes('codeRuntime'), errorText(tui))
  setLocale('zh')
})

test('an unknown mode lists the roster ids', async () => {
  const { tui, composed } = fixture()
  tui.runCommand('/mode nope')
  await waitForError(tui, '可用')
  assert.deepEqual(composed, [])
  // The list follows the picker's own order now (shipped by declared position,
  // then locally authored), so the assertion is about membership, not sequence.
  const report = errorText(tui)
  for (const id of ['standard', 'minimal', 'ptc', 'routing-suite']) {
    assert.ok(report.includes(id), `the report names ${id}: ${report}`)
  }
})

test('child-agent requests carry the TUI subagent model, not the parent route', async () => {
  // The 0.5.1 trim dropped the bundle patch's `agentOptions.model` pins on the
  // host subagent rows, so this waterfall is the only thing that keeps a child
  // on the light model; guard it against a silent removal.
  const { tui } = fixture()
  const parent = { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 100, reasoningEffort: 'high' }
  const child = { id: 'child-session', options: {} }

  tui.subagentSelection.current = { model: 'deepseek-v4-flash' }
  const inherited = await tui.handleAgentRequest({ agent: child }, async () => ({ ...parent }))
  assert.equal(inherited.provider, 'deepseek-official')
  assert.equal(inherited.model, 'deepseek-v4-flash')
  assert.equal(inherited.maxTokens, 100, 'other request fields survive')
  assert.equal(inherited.reasoningEffort, undefined, 'a different child model does not inherit parent effort')

  // A leftover model on an inherited (unpinned) route is replaced, not sent.
  tui.subagentSelection.current = { model: 'grok-4.5' }
  const stale = await tui.handleAgentRequest({ agent: child }, async () => ({ ...parent }))
  assert.equal(stale.provider, 'deepseek-official')
  assert.equal(stale.model, 'deepseek-v4-flash')

  // A pinned provider keeps its model even when it is a different family.
  tui.subagentSelection.current = { provider: 'xai', model: 'grok-4.5' }
  const switched = await tui.handleAgentRequest({ agent: child }, async () => ({ ...parent }))
  assert.equal(switched.provider, 'xai')
  assert.equal(switched.model, 'grok-4.5')
  assert.equal(switched.reasoningEffort, undefined)

  // The main agent keeps its own /model waterfall untouched.
  const main = await tui.handleAgentRequest({ agent: tui.agent }, async () => ({ ...parent }))
  assert.equal(main.model, 'deepseek-flash')
})

test('typing narrows the /mode list, and Enter answers the match', async () => {
  const { tui, composed } = fixture()
  tui.runCommand('/mode')
  await waitForDialog(tui, 'questions')

  // `/` starts filtering: letters are the list's hotkeys, so the two cannot
  // share the keyboard without a mode.
  tui.handleChar('/')
  for (const char of 'routing') tui.handleChar(char)
  const frame = tui.captureFrame(100, 30).join('\n')
  assert.match(frame, /筛选：routing/u, 'the query is shown')
  // The option line is the only place the name carries its group suffix: the
  // banner and the footer both name the preset in effect without it.
  assert.ok(frame.includes('智能路由模式 — 本地'), 'the match is listed')
  assert.equal(frame.includes('标准模式 — 官方'), false, 'the rest is filtered out of the list')

  // First Enter applies the filter, second answers the highlighted match.
  tui.handleChar('\r')
  tui.handleChar('\r')
  await waitForText(tui, '已切换')
  assert.deepEqual(composed, ['routing-suite'], 'the filtered match is what got composed')
})

test('Esc clears a filter instead of cancelling the question', async () => {
  const { tui } = fixture()
  tui.runCommand('/mode')
  await waitForDialog(tui, 'questions')
  tui.handleChar('/')
  tui.handleChar('z')
  tui.handleChar('z')
  tui.handleChar('\x1b')
  assert.equal(tui.dialog?.kind, 'questions', 'the question is still open')
  const frame = tui.captureFrame(100, 30).join('\n')
  assert.equal(frame.includes('筛选：zz'), false, 'and the filter is gone')
  assert.ok(frame.includes('标准模式'), 'the whole list is back')
})

test('a filter that matches nothing leaves the list empty but the question answerable', async () => {
  const { tui } = fixture()
  tui.runCommand('/mode')
  await waitForDialog(tui, 'questions')
  tui.handleChar('/')
  for (const char of 'zzz') tui.handleChar(char)
  const frame = tui.captureFrame(100, 30).join('\n')
  assert.equal(frame.includes('标准模式 — 官方'), false, 'no option line survives the filter')
  assert.match(frame, /筛选：zzz/u)
  tui.handleChar('\x1b')
  assert.ok(
    tui.captureFrame(100, 30).join('\n').includes('标准模式 — 官方'),
    'clearing brings the roster back',
  )
})
