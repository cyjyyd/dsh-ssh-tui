import test from 'node:test'
import assert from 'node:assert/strict'

import {
  askSummary,
  clipAnsiToWidth,
  describeProviderRoute,
  displayWidth,
  foldInputView,
  formatOpenCodeGoUsage,
  friendlyJsonLines,
  isEscapePrefix,
  openCodeSourceFor,
  parseExitStatus,
  parsePlanTodos,
  planTitleFromMarkdown,
  presentToolCall,
  providerUsesLocalOAuth,
  renderMarkdownLines,
  renderToolDiff,
  repeatToWidth,
  SshTui,
  subagentHeaderText,
  todoProgressLabel,
  todoSummary,
  toolBodyLines,
  truncateToWidth,
} from '../lib/tui.js'
import {
  defaultSubagentModelForProvider,
  subagentModelMatchesProvider,
} from '../lib/subagent-model.js'

test('truncateToWidth never splits a surrogate pair', () => {
  const cut = truncateToWidth('🙂🙂', 1)
  assert.equal(cut, '…')
  assert.ok(!cut.includes('\uFFFD'))
})

test('displayWidth matches glibc wcwidth for CJK vs ambiguous TUI glyphs', () => {
  assert.equal(displayWidth('计划'), 4)
  assert.equal(displayWidth('─'), 1)
  assert.equal(displayWidth('●'), 1)
  assert.equal(displayWidth('·'), 1)
  assert.equal(displayWidth('▸'), 1)
  assert.equal(displayWidth('❯'), 1)
  assert.equal(displayWidth('⠋'), 1)
  assert.equal(repeatToWidth('─', 8), '────────')
  assert.equal(displayWidth(repeatToWidth('─', 80)), 80)
  assert.equal(displayWidth('❯ hello'), 7)
})

test('clipAnsiToWidth keeps SGR and never exceeds the cell budget', () => {
  const styled = '\x1b[33m● 计划模式\x1b[0m'
  const clipped = clipAnsiToWidth(styled, 8)
  assert.ok(clipped.startsWith('\x1b[33m'))
  assert.ok(displayWidth(clipped.replace(/\x1b\[[0-9;]*m/gu, '')) <= 8)
})

test('prompt plus ASCII input cursor stays on integer columns', () => {
  const prompt = '❯ '
  assert.equal(displayWidth(prompt), 2)
  const text = 'hello\nworld'
  const cursor = text.indexOf('w')
  const first = 'hello'
  assert.equal(displayWidth(prompt) + displayWidth(first), 7)
  assert.equal(displayWidth(text.slice(cursor)), 5)
})

test('isEscapePrefix keeps multi-digit CSI / paste / SGR prefixes buffered', () => {
  assert.equal(isEscapePrefix('\x1b'), true)
  assert.equal(isEscapePrefix('\x1b[20'), true)
  assert.equal(isEscapePrefix('\x1b[200'), true)
  assert.equal(isEscapePrefix('\x1b[201'), true)
  assert.equal(isEscapePrefix('\x1b[<0;5;1'), true)
  assert.equal(isEscapePrefix('\x1b[1~'), true)
  assert.equal(isEscapePrefix('a'), false)
})

test('foldInputView keeps wide characters intact around the cursor', () => {
  const view = foldInputView('🙂🙂🙂🙂🙂', 6, 10)
  assert.equal(view.cursorOffset, 6)
  assert.equal(view.folded, false)
})

test('renderMarkdownLines strips terminal control sequences', () => {
  const lines = renderMarkdownLines('a\x1b[31mRED\x1b[0mb', 20, false)
  assert.deepEqual(lines, ['a[31mRED[0mb'])
})

test('friendlyJsonLines bounds recursion and entry count', () => {
  let deep = { value: 0 }
  for (let index = 0; index < 1000; index += 1) deep = { next: deep }
  assert.ok(friendlyJsonLines(deep).length < 100)
  const wide = friendlyJsonLines({ values: Array.from({ length: 500 }, (_, i) => i) })
  assert.ok(wide.length < 100)
})

test('renderToolDiff respects small maxLines budgets', () => {
  const diffs = [{ path: 'a.ts', oldText: 'a\nb', newText: 'c\nd' }]
  assert.equal(renderToolDiff(diffs, 1).length, 1)
  assert.equal(renderToolDiff(diffs, 2).length, 2)
  assert.equal(renderToolDiff(diffs, 3).length, 3)
})

test('toolBodyLines caps generic JSON bodies to maxLines', () => {
  const row = { args: '{"a":1}', output: '{"items":[1,2,3,4]}' }
  for (const max of [1, 2, 3]) {
    assert.ok(toolBodyLines(row, max).length <= max)
  }
})

test('openCodeSourceFor picks the right built-in api key env', () => {
  assert.equal(openCodeSourceFor('opencode', undefined)?.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(openCodeSourceFor('opencode-go', undefined)?.apiKeyEnv, 'OPENCODE_GO_API_KEY')
  assert.equal(openCodeSourceFor('custom-gw', {
    providers: { 'custom-gw': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'MY_KEY' } },
  })?.apiKeyEnv, 'MY_KEY')
})

test('formatOpenCodeGoUsage rejects unrecognized payloads', () => {
  assert.throws(
    () => formatOpenCodeGoUsage({}, { provider: 'x', flavor: 'go', label: 'x', apiKeyEnv: 'K' }),
    /无法识别/u,
  )
})

test('parseExitStatus keeps exit-code and signal parsing', () => {
  assert.deepEqual(parseExitStatus('out\n[exit code: 7]'), { body: 'out', exitCode: 7 })
  assert.deepEqual(parseExitStatus('out\n[killed by signal: SIGTERM]'), { body: 'out', signal: 'SIGTERM' })
})

test('subagent request waterfall applies model/effort but leaves the parent alone', async () => {
  const ctx = { get: () => undefined }
  const agent = { id: 'main-session', options: { provider: 'opencode-go', model: 'deepseek-v4-pro' } }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    provider: 'opencode-go',
    subagentSelection: {
      current: { model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    },
  })
  const next = async () => ({ provider: 'opencode-go', model: 'deepseek-v4-pro' })

  const child = await tui.handleAgentRequest({ agent: { id: 'child-session' } }, next)
  assert.equal(child.provider, 'opencode-go')
  assert.equal(child.model, 'deepseek-v4-flash')
  assert.equal(child.reasoningEffort, 'max')

  const parent = await tui.handleAgentRequest({ agent }, next)
  assert.equal(parent.provider, 'opencode-go')
  assert.equal(parent.model, 'deepseek-v4-pro')
  assert.equal(parent.reasoningEffort, undefined)
})

test('subagent waterfall follows the parent xAI route instead of leftover DeepSeek flash', async () => {
  const ctx = { get: () => undefined }
  const agent = { id: 'main-session', options: { provider: 'xai', model: 'grok-4.6' } }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    provider: 'xai',
    subagentSelection: {
      current: { model: 'deepseek-v4-flash' },
    },
  })
  const child = await tui.handleAgentRequest(
    { agent: { id: 'child-session' } },
    async () => ({ provider: 'xai', model: 'grok-4.6' }),
  )
  assert.equal(child.provider, 'xai')
  assert.equal(child.model, 'grok-4.5')
})

test('parsePlanTodos and todoSummary keep parallel in-progress counts', () => {
  const todos = parsePlanTodos({
    todos: [
      { content: 'inspect logs', status: 'completed' },
      { content: 'write tests', status: 'in_progress' },
      { content: 'fix renderer', status: 'in_progress' },
    ],
  })
  assert.equal(todos.length, 3)
  assert.equal(todoSummary(todos), '1/3 完成 · write tests +1')
})

test('askSummary names the first question and counts the rest', () => {
  assert.equal(askSummary({ questions: [{ question: 'Continue?' }, { question: 'Why?' }] }), 'Continue?（2 题）')
})

test('presentToolCall distinguishes subagent, plan, and ask tools', () => {
  assert.deepEqual(
    presentToolCall('subagent', JSON.stringify({ description: 'scan repo', prompt: 'go' })),
    { title: '子代理', summary: 'scan repo' },
  )
  assert.equal(presentToolCall('todo_write', JSON.stringify({ todos: [{ content: 'plan it', status: 'pending' }] })).title, '更新待办')
  assert.equal(presentToolCall('ask_user_question', JSON.stringify({ questions: [{ question: 'Ship it?' }] })).title, '提问用户')
  assert.equal(presentToolCall('exit_plan_mode', JSON.stringify({ plan: '# Add greeting flag\n\n- locate parser' })).title, '提交计划')
  assert.equal(presentToolCall('read', JSON.stringify({ path: 'src/tui.ts' })).title, '读取')
  assert.equal(presentToolCall('grep', JSON.stringify({ pattern: 'TODO', path: 'src' })).summary, 'TODO  src')
})

test('subagent cards stay collapsed, isolated, and animate while running', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSubagentStart({ runId: 'run-a', id: 'child-a', provider: 'spawn', local: true })
  tui.handleSubagentStart({ runId: 'run-b', id: 'child-b', provider: 'fork', local: true })
  tui.handleSubagentSessionEvent('child-a', {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'alpha working' }] } },
  })
  tui.handleSubagentSessionEvent('child-b', {
    type: 'tool/call',
    data: { name: 'bash', arguments: '{"command":"ls"}' },
  })
  const cards = tui.rows.filter(row => row.kind === 'subagent')
  assert.equal(cards.length, 2)
  assert.equal(cards[0].expanded, false)
  assert.equal(cards[1].expanded, false)
  assert.ok(cards[0].logs.some(entry => entry.text.includes('alpha working')))
  assert.ok(cards[1].logs.some(entry => entry.text.includes('bash')))
  assert.equal(subagentHeaderText(cards[0], cards[0].startedAt).includes('运行中'), true)
  tui.handleSubagentEnd({
    runId: 'run-a', id: 'child-a', provider: 'spawn', local: true, stopReason: 'completed',
    lastAssistantMessage: [{ type: 'text', text: 'alpha done' }],
  })
  assert.equal(cards[0].status, 'ok')
  assert.equal(cards[0].expanded, false)
})

test('plan mode and ask-user questions get their own collapsed cards', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, { type: 'plan/mode', data: { active: true } })
  tui.handleSessionEvent(agent.session, {
    type: 'todo/write',
    data: { todos: [{ content: 'outline the change', status: 'in_progress' }] },
  })
  const plan = tui.rows.findLast(row => row.kind === 'plan')
  assert.equal(plan?.active, true)
  assert.equal(plan?.expanded, false)
  assert.equal(plan?.todos[0]?.content, 'outline the change')

  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'q1',
      question: 'Approve this plan?',
      detail: '# Do the work',
      intent: { kind: 'plan-review', approve: 'Approve' },
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    }],
    agent,
  })
  const question = tui.rows.findLast(row => row.kind === 'question')
  assert.equal(question?.intent, 'plan-review')
  assert.equal(question?.status, 'waiting')
  assert.equal(question?.expanded, false)
  assert.equal(tui.dialog?.kind, 'questions')
  void pending.catch(() => {})
})

test('goal cards stay collapsed and report the current phase', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'goal/change',
    data: { operation: 'create', goal: { objective: 'finish the TUI cards', phase: 'active' } },
  })
  const goal = tui.rows.findLast(row => row.kind === 'goal')
  assert.equal(goal?.phase, 'active')
  assert.equal(goal?.expanded, false)
  assert.equal(goal?.objective, 'finish the TUI cards')
})

test('todo and exit_plan_mode cards render lists/markdown instead of raw JSON', () => {
  const todos = parsePlanTodos({
    todos: [
      { content: '梳理需求', status: 'completed' },
      { content: '实现 fixture', status: 'in_progress' },
      { content: '浏览器验收', status: 'pending' },
    ],
  })
  assert.equal(todoProgressLabel(todos), '1 已完成 · 1 进行中 · 1 待处理')
  const todoBody = toolBodyLines({
    name: 'todo_write',
    args: JSON.stringify({ todos }),
    output: '',
  }, 20)
  assert.ok(todoBody.some(line => line.text.includes('实现 fixture')))
  assert.equal(todoBody.some(line => line.text.includes('{')), false)
  assert.equal(planTitleFromMarkdown('# Add greeting flag\n\n- locate parser'), 'Add greeting flag')
  const planBody = toolBodyLines({
    name: 'exit_plan_mode',
    args: JSON.stringify({ plan: '# Add greeting flag\n\n- locate parser' }),
    output: '',
  }, 20)
  assert.ok(planBody.some(line => line.text.includes('Add greeting flag')))
  assert.equal(planBody.some(line => line.kind === 'diff-path' && line.text === '参数'), false)
})

test('default subagent model follows the parent provider family', () => {
  assert.equal(defaultSubagentModelForProvider('deepseek-official'), 'deepseek-v4-flash')
  assert.equal(defaultSubagentModelForProvider('xai'), 'grok-4.5')
  assert.equal(
    defaultSubagentModelForProvider('xai', ['grok-4.6', 'grok-4.5', 'grok-4.3']),
    'grok-4.5',
  )
  assert.equal(
    defaultSubagentModelForProvider('opencode-go', ['deepseek-v4-pro', 'deepseek-v4-flash-vision-exp']),
    'deepseek-v4-flash-vision-exp',
  )
  assert.equal(subagentModelMatchesProvider('xai', 'deepseek-v4-flash'), false)
  assert.equal(subagentModelMatchesProvider('deepseek-official', 'deepseek-v4-flash'), true)
})

test('describeProviderRoute labels DeepSeek, SuperGrok, and OpenCode routes', () => {
  assert.equal(describeProviderRoute('deepseek-official').short, 'DeepSeek 官方')
  assert.equal(describeProviderRoute('xai').kind, 'SuperGrok / X Premium 订阅')
  assert.equal(describeProviderRoute('opencode-go').short, 'OpenCode Go')
  assert.equal(describeProviderRoute('opencode').short, 'OpenCode Zen')
  assert.equal(providerUsesLocalOAuth('xai'), true)
  assert.equal(providerUsesLocalOAuth('deepseek-official'), false)
  assert.equal(providerUsesLocalOAuth('opencode-go'), false)
})
