import test from 'node:test'
import assert from 'node:assert/strict'

import {
  askSummary,
  clipAnsiToWidth,
  composePaintOutput,
  describeProviderRoute,
  displayWidth,
  padAnsiToWidth,
  foldInputView,
  formatOpenCodeGoUsage,
  formatAccountBalance,
  formatQuotaSnapshot,
  joinUrl,
  parseDeepSeekBalance,
  parseOpenAiCompatibleBalance,
  parseSuperGrokBilling,
  parseOpenCodeGoQuota,
  remainingPercentFromUsed,
  crossedQuotaThresholds,
  quotaAlertText,
  quotaRefreshEveryTurns,
  tightestQuotaWindow,
  friendlyJsonLines,
  isEscapePrefix,
  openCodeSourceFor,
  parseExitStatus,
  parseFindQuery,
  parsePlanTodos,
  applyTurnEndToPlan,
  planCloseNudgeText,
  planDockNote,
  planIsLive,
  planTitleFromMarkdown,
  matchTranscriptRows,
  presentToolCall,
  providerUsesLocalOAuth,
  detectSshSession,
  formatLinkQualityChip,
  formatQuotaBar,
  footerActivity,
  footerIdentityParts,
  footerStatsGroups,
  fitFooterStatsLine,
  fitFooterStatusLine,
  linkQualityOf,
  providerShortCode,
  paintIntervalForRtt,
  parseCursorPositionReply,
  resolvePaintIntervalMs,
  renderMarkdownLines,
  renderToolDiff,
  repeatToWidth,
  SshTui,
  compactionHeaderText,
  subagentHeaderText,
  todoProgressLabel,
  todoSummary,
  toolBodyLines,
  truncateToWidth,
  visibleWidth,
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
  const color256 = clipAnsiToWidth('\x1b[38;5;22;48;5;194m+ hello', 12)
  assert.ok(color256.startsWith('\x1b[38;5;22;48;5;194m'))
  assert.ok(color256.includes('+ hello'))
})

test('padAnsiToWidth keeps diff background across the whole row', () => {
  const styled = '\x1b[38;5;22;48;5;194m+ hello'
  const padded = padAnsiToWidth(styled, 12)
  assert.ok(padded.startsWith('\x1b[38;5;22;48;5;194m'))
  assert.equal(visibleWidth(padded), 12)
  assert.ok(padded.endsWith(' '.repeat(5)))
  assert.equal(padded.includes('\x1b[0m'), false)
  const closed = padAnsiToWidth('\x1b[33mshort\x1b[0m', 10)
  assert.equal(visibleWidth(closed), 10)
  assert.ok(closed.endsWith('\x1b[0m'))
  assert.ok(closed.includes('short     '))
})

test('composePaintOutput pads a short card line so the next row cannot inherit glyphs', () => {
  const frame = composePaintOutput({
    width: 12,
    height: 2,
    paintRows: ['\x1b[2;3m思考残留\x1b[0m', '\x1b[33m● tool\x1b[0m'],
    previousRows: [],
    sizeChanged: true,
    chromeChanged: false,
    chromeStart: 0,
    cursorRow: 2,
    cursorColumn: 1,
  })
  const rows = [...frame.matchAll(/\x1b\[\d+;1H\x1b\[0m\x1b\[2K(.*?)\x1b\[0m/g)].map(match => match[1])
  assert.equal(rows.length, 2)
  assert.equal(visibleWidth(rows[0] ?? ''), 12)
  assert.equal(visibleWidth(rows[1] ?? ''), 12)
  assert.equal(frame.includes('\x1b[K'), false)
  assert.ok(frame.includes('\x1b[1;1H\x1b[0m\x1b[2K'))
  assert.ok(frame.includes('\x1b[2;1H\x1b[0m\x1b[2K'))
})

test('composePaintOutput repaints chrome when a card expansion moves the input box', () => {
  const previous = ['card', 'body', 'more', '────', '> ', 'stats', 'idle']
  const next = ['card', 'body', 'more', 'extra', '────', '> ', 'stats']
  const frame = composePaintOutput({
    width: 8,
    height: 7,
    paintRows: next,
    previousRows: previous,
    sizeChanged: false,
    chromeChanged: true,
    chromeStart: 4,
    previousChromeStart: 3,
    cursorRow: 6,
    cursorColumn: 3,
  })
  assert.ok(frame.includes('\x1b[4;1H'))
  assert.ok(frame.includes('\x1b[5;1H'))
  assert.ok(frame.includes('\x1b[6;1H'))
  assert.ok(frame.includes('\x1b[7;1H'))
})

test('composePaintOutput never writes past the terminal height', () => {
  const frame = composePaintOutput({
    width: 8,
    height: 2,
    paintRows: ['one', 'two', 'three'],
    previousRows: [],
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: 0,
    cursorRow: 9,
    cursorColumn: 1,
  })
  assert.equal(frame.includes('\x1b[3;1H'), false)
  assert.equal(frame.includes('\x1b[9;1H'), false)
  assert.ok(frame.includes('\x1b[2;1H'))
})

test('resolvePaintIntervalMs clamps jump-host cadence', () => {
  assert.equal(resolvePaintIntervalMs(undefined, {}), 80)
  assert.equal(resolvePaintIntervalMs(undefined, {}, { ssh: true }), 160)
  assert.equal(resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: 20 }), 80)
  assert.equal(resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: 90 }), 160)
  assert.equal(resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: 200 }), 250)
  assert.equal(resolvePaintIntervalMs(undefined, {}, { ssh: true, rttMs: 500 }), 400)
  assert.equal(resolvePaintIntervalMs(undefined, { DSH_TUI_PAINT_MS: '250' }, { ssh: true, rttMs: 20 }), 250)
  assert.equal(resolvePaintIntervalMs(40, { DSH_TUI_PAINT_MS: '9999' }), 40)
  assert.equal(resolvePaintIntervalMs(undefined, { DSH_TUI_PAINT_MS: '10' }), 40)
  assert.equal(resolvePaintIntervalMs(undefined, { DSH_TUI_PAINT_MS: '5000' }), 1000)
})

test('footer stats drop cache first when the row is narrow', () => {
  const groups = footerStatsGroups({
    turns: 3, steps: 12, llmMs: 80_000, toolMs: 8400,
    ttftMs: 1200, ttftSteps: 1, decodeMs: 2000, decodeTokens: 84,
    inputTokens: 6100, outputTokens: 640, cacheReadTokens: 12_100, cacheWriteTokens: 0,
  })
  assert.deepEqual(groups.slice(0, 2), ['3 轮 · 12 步', '输入 18.2K · 输出 640'])
  assert.equal(groups.at(-1)?.startsWith('缓存命中'), true)
  const fitted = fitFooterStatsLine('SSH ●●○○ 210ms', groups, 42)
  assert.equal(fitted.includes('缓存'), false)
  assert.match(fitted, /^SSH ●●○○ 210ms/)
  assert.ok(displayWidth(fitted) <= 42)
})

test('footer status keeps one activity and drops identity from the right', () => {
  assert.equal(providerShortCode('xai'), 'SuperGrok')
  const activity = footerActivity({
    running: true, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 2, tools: 3, planLeftOpen: false, planPending: false, planActive: true,
    idleMs: 0, model: 'grok-4.6', effort: 'xhigh', preset: '标准模式', provider: 'xai',
    parentModel: 'grok-4.6', subModel: 'grok-4.5', subDiffers: true,
    quotaCode: 'SuperGrok', quotaPercent: 82, foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.equal(activity.text, '子代理 2')
  const identity = footerIdentityParts({
    running: true, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 2, tools: 3, planLeftOpen: false, planPending: false, planActive: true,
    idleMs: 0, model: 'grok-4.6', effort: 'xhigh', preset: '标准模式', provider: 'xai',
    parentModel: 'grok-4.6', subModel: 'grok-4.5', subDiffers: true,
    quotaCode: 'SuperGrok', quotaPercent: 82, foldedInput: false, multiLineInput: false, queued: 1,
  })
  assert.deepEqual(identity, ['[标准模式]', 'grok-4.6 xhigh', 'sub:grok-4.5', `SuperGrok ${formatQuotaBar(82)} 82%`, '排队 1'])
  const line = fitFooterStatusLine('子代理 2', identity, 28)
  assert.match(line, /^子代理 2/)
  assert.equal(line.includes('排队'), false)
  assert.ok(displayWidth(line) <= 28)
})

test('formatQuotaBar is an 8-pip remaining bar', () => {
  assert.equal(formatQuotaBar(100), '████████')
  assert.equal(formatQuotaBar(82), '███████░')
  assert.equal(formatQuotaBar(50), '████░░░░')
  assert.equal(formatQuotaBar(0), '░░░░░░░░')
})

test('formatLinkQualityChip is a compact colored signal bar', () => {
  assert.equal(linkQualityOf('local', undefined), 'local')
  assert.equal(linkQualityOf('ssh', 20), 'good')
  assert.equal(linkQualityOf('ssh', 90), 'ok')
  assert.equal(linkQualityOf('ssh', 200), 'slow')
  assert.equal(linkQualityOf('ssh', 500), 'poor')
  assert.equal(formatLinkQualityChip('ssh', 160, 90, true), 'SSH ●●●○ 90ms')
  assert.equal(formatLinkQualityChip('ssh', 400, 500, true), 'SSH ●○○○ 500ms')
  assert.equal(formatLinkQualityChip('local', 80, undefined, false), '本机 ●●●●')
  assert.match(formatLinkQualityChip('ssh', 400, 500, true, true), /\x1b\[31m●○○○\x1b\[0m/)
  assert.match(formatLinkQualityChip('ssh', 250, 200, true, true), /\x1b\[33m●●○○\x1b\[0m/)
  assert.match(formatLinkQualityChip('ssh', 160, 90, true, true), /\x1b\[32m●●●○\x1b\[0m/)
})

test('detectSshSession and paintIntervalForRtt do not need a model', () => {
  assert.equal(detectSshSession({}), false)
  assert.equal(detectSshSession({ SSH_CONNECTION: '10.0.0.1 22 10.0.0.2 443' }), true)
  assert.equal(detectSshSession({ SSH_TTY: '/dev/pts/0' }), true)
  assert.equal(paintIntervalForRtt(undefined), 160)
  assert.equal(paintIntervalForRtt(12), 80)
  assert.equal(paintIntervalForRtt(149), 160)
  assert.equal(paintIntervalForRtt(350), 400)
})

test('parseCursorPositionReply accepts CSI 6n replies', () => {
  assert.deepEqual(parseCursorPositionReply('\x1b[24;80R'), { row: 24, column: 80 })
  assert.equal(parseCursorPositionReply('\x1b[A'), undefined)
})

test('composePaintOutput is one write of dirty rows only', () => {
  const first = composePaintOutput({
    width: 8,
    height: 2,
    paintRows: ['hello', 'world'],
    previousRows: [],
    sizeChanged: true,
    chromeChanged: false,
    chromeStart: 0,
    cursorRow: 2,
    cursorColumn: 2,
  })
  assert.equal(first.includes('\x1b[H\x1b[J'), true)
  assert.ok((first.match(/\x1b\[\d+;1H/g) ?? []).length >= 2)
  assert.ok(first.includes('hello'))
  assert.ok(first.includes('world'))
  const second = composePaintOutput({
    width: 8,
    height: 2,
    paintRows: ['hello', 'there'],
    previousRows: ['hello', 'world'],
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: 0,
    cursorRow: 2,
    cursorColumn: 2,
  })
  assert.equal(second.includes('\x1b[H\x1b[J'), false)
  assert.equal((second.match(/\x1b\[\d+;1H/g) ?? []).length, 1)
  assert.ok(second.includes('there'))
  assert.equal(second.includes('hello'), false)
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

test('parseSuperGrokBilling maps creditUsagePercent to remaining quota', () => {
  const snap = parseSuperGrokBilling({
    config: {
      creditUsagePercent: 18,
      currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-09-02T02:22:49.432697+00:00' },
    },
  })
  assert.equal(snap.plan, 'SuperGrok')
  assert.equal(snap.windows[0]?.period, 'weekly')
  assert.equal(snap.windows[0]?.remainingPercent, 82)
  assert.equal(remainingPercentFromUsed(100), 0)
  assert.deepEqual(crossedQuotaThresholds(60, 48), [50])
  assert.deepEqual(crossedQuotaThresholds(50, 49), [])
  assert.deepEqual(crossedQuotaThresholds(undefined, 8), [50, 25, 10])
  const alert = quotaAlertText(snap, snap.windows[0])
  assert.match(alert, /^⚠ /u)
  assert.match(alert, /SuperGrok/)
  assert.match(alert, /每周额度还剩余 82%/)
  assert.equal(quotaRefreshEveryTurns(snap.windows[0]), 50)
  assert.equal(quotaRefreshEveryTurns({ label: '本周', period: 'weekly', remainingPercent: 48 }), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '5h', period: 'hourly', remainingPercent: 80 }), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '5h', period: 'hourly', remainingPercent: 50 }), 4)
  assert.equal(quotaRefreshEveryTurns({ label: '本月', period: 'monthly', remainingPercent: 90 }), 80)
})

test('parseDeepSeekBalance reads official user/balance wire format', () => {
  const snap = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [{
      currency: 'CNY',
      total_balance: '86.42',
      granted_balance: '10.00',
      topped_up_balance: '76.42',
    }],
  })
  assert.equal(snap.plan, 'DeepSeek 官方')
  assert.equal(snap.available, true)
  assert.equal(snap.lines[0]?.amount, '86.42')
  assert.match(formatAccountBalance(snap), /可用余额 · 86\.42 CNY/)
})

test('parseOpenAiCompatibleBalance accepts credit_grants and DeepSeek-shaped gateways', () => {
  const grants = parseOpenAiCompatibleBalance({
    total_granted: 20, total_used: 5, total_available: 15,
  }, 'my-gateway', '/dashboard/billing/credit_grants')
  assert.equal(grants?.lines[0]?.amount, '15')
  assert.equal(joinUrl('https://api.example.com/v1', '/v1/dashboard/billing/credit_grants'),
    'https://api.example.com/v1/dashboard/billing/credit_grants')
  const shaped = parseOpenAiCompatibleBalance({
    is_available: true,
    balance_infos: [{ currency: 'USD', total_balance: '3.2' }],
  }, 'my-gateway', '/user/balance')
  assert.equal(shaped?.lines[0]?.amount, '3.2')
})

test('parseOpenCodeGoQuota keeps remaining percent for each window', () => {
  const snap = parseOpenCodeGoQuota({
    usage: {
      rolling: { status: 'ok', percent: 40 },
      weekly: { status: 'ok', percent: 10 },
      monthly: { status: 'ok', percent: 70 },
    },
  }, 'opencode-go')
  assert.equal(tightestQuotaWindow(snap)?.period, 'monthly')
  assert.equal(tightestQuotaWindow(snap)?.remainingPercent, 30)
  assert.match(formatQuotaSnapshot(snap), /剩余 30\.0%/)
})

test('parseExitStatus keeps exit-code and signal parsing', () => {
  assert.deepEqual(parseExitStatus('out\n[exit code: 7]'), { body: 'out', exitCode: 7 })
  assert.deepEqual(parseExitStatus('out\n[killed by signal: SIGTERM]'), { body: 'out', signal: 'SIGTERM' })
})

test('syncSubagentToProvider force-follows a parent provider switch', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    provider: 'xai',
    subagentSelection: { current: { provider: 'xai', model: 'grok-4.5' } },
  })
  tui.quotaSnapshot = { provider: 'xai', plan: 'SuperGrok', windows: [{ label: '本周', period: 'weekly', remainingPercent: 82 }] }
  await tui.syncSubagentToProvider('opencode-go', ['deepseek-v4-flash', 'deepseek-v4-pro'], true)
  assert.equal(tui.subagentSelection.current.model, 'deepseek-v4-flash')
  assert.equal(tui.subagentSelection.current.provider, undefined)
  tui.clearQuotaForProvider('opencode-go')
  assert.equal(tui.quotaSnapshot, undefined)
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

test('expanding any collapsible card does not leave body glyphs on the input row', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  tui.rows.push({
    kind: 'tool',
    callId: 'call-1',
    name: 'read',
    title: '读取',
    summary: 'src/tui.ts',
    args: '{"path":"src/tui.ts"}',
    output: 'ALPHA_BODY_LINE\nBETA_BODY_LINE\nGAMMA_BODY_LINE',
    status: 'ok',
    expanded: false,
  })
  const collapsed = tui.captureFrame(48, 16)
  const tool = tui.rows.find(row => row.kind === 'tool')
  assert.equal(tool?.kind, 'tool')
  tool.expanded = true
  tui.focusedRow = tool
  const expanded = tui.captureFrame(48, 16)
  const inputIndex = expanded.findIndex(line => line.startsWith('> ') || line.startsWith('❯ '))
  assert.ok(inputIndex >= 0)
  assert.equal(expanded[inputIndex]?.includes('ALPHA_BODY_LINE'), false)
  assert.equal(expanded[inputIndex]?.includes('BETA_BODY_LINE'), false)
  assert.equal(collapsed.length, 16)
  assert.equal(expanded.length, 16)
})

test('captureFrame paints a bounded SSH-sized frame for README fixtures', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  tui.handleSessionEvent(agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  })
  const frame = tui.captureFrame(80, 24)
  assert.equal(frame.length, 24)
  assert.ok(frame.some(line => line.includes('hello')))
  assert.ok(frame.some(line => line.includes('DeepSeek Harness')))
  assert.ok(frame.some(line => /本机 ●●●●|SSH [●○]{4}/u.test(line)))
})

test('planDockNote follows task status instead of always saying plan mode is off', () => {
  assert.equal(planDockNote({
    active: false,
    pending: false,
    todos: [{ content: 'edit diff', status: 'in_progress' }],
  }), '正在按计划执行。')
  assert.equal(planDockNote({
    active: false,
    pending: false,
    todos: [{ content: 'edit diff', status: 'completed' }],
  }), '计划任务已全部完成。')
  assert.equal(planDockNote({
    active: true,
    pending: false,
    todos: [{ content: 'outline', status: 'in_progress' }],
  }), '只规划、不改代码；确认后再执行。')
  assert.equal(planDockNote({
    active: false,
    pending: false,
    todos: [],
  }), '计划模式已关闭，可用 /plan 重新进入。')
  assert.equal(planDockNote({
    active: false,
    pending: false,
    turnLeftOpen: true,
    todos: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ],
  }), '本轮未收尾：还剩 2 项待办（会话日志未改）。')
})

test('turn/end marks leftover todos as display-stale and asks once to close them', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const followups = []
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    followup(message) { followups.push(message) },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'todo/write',
    data: { todos: [
      { content: 'pin the dock', status: 'in_progress' },
      { content: 'search cards', status: 'pending' },
    ] },
  })
  tui.handleSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  const plan = tui.rows.find(row => row.kind === 'plan')
  assert.equal(plan.turnLeftOpen, true)
  assert.equal(plan.todos[0].status, 'in_progress')
  assert.equal(followups.length, 1)
  assert.ok(String(followups[0].content[0].text).includes('todo_write'))
  assert.ok(String(followups[0].content[0].text).includes('pin the dock'))
  const frame = tui.captureFrame(80, 24)
  assert.ok(frame.some(line => line.includes('本轮未收尾')))
  tui.handleSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(followups.length, 1)
  tui.handleSessionEvent(agent.session, {
    type: 'todo/write',
    data: { todos: [
      { content: 'pin the dock', status: 'completed' },
      { content: 'search cards', status: 'completed' },
    ] },
  })
  assert.equal(tui.rows.find(row => row.kind === 'plan').turnLeftOpen, false)
})

test('planCloseNudgeText lists leftover items only', () => {
  const text = planCloseNudgeText({
    todos: [
      { content: 'done already', status: 'completed' },
      { content: 'still open', status: 'in_progress' },
    ],
  })
  assert.equal(text.includes('done already'), false)
  assert.ok(text.includes('still open'))
})

test('applyTurnEndToPlan is a no-op when every todo is completed', () => {
  const plan = applyTurnEndToPlan({
    todos: [{ content: 'done', status: 'completed' }],
  })
  assert.equal(plan.turnLeftOpen, false)
})

test('planIsLive treats completed archived plans as dock-ineligible', () => {
  assert.equal(planIsLive({
    active: true, pending: false, todos: [{ content: 'a', status: 'pending' }],
  }), true)
  assert.equal(planIsLive({
    active: false, pending: false, todos: [{ content: 'a', status: 'completed' }],
  }), false)
  assert.equal(planIsLive({
    active: false, pending: false, todos: [{ content: 'a', status: 'in_progress' }],
  }), true)
})

test('re-entering plan mode on an incomplete list does not archive it', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, { type: 'plan/mode', data: { active: true } })
  tui.handleSessionEvent(agent.session, {
    type: 'todo/write',
    data: { todos: [{ content: 'still going', status: 'in_progress' }] },
  })
  tui.handleSessionEvent(agent.session, { type: 'plan/mode', data: { active: true } })
  const plans = tui.rows.filter(row => row.kind === 'plan')
  assert.equal(plans.length, 1)
  assert.equal(plans[0].archived, false)
  assert.equal(plans[0].active, true)
  assert.equal(plans[0].todos[0]?.content, 'still going')
})

test('a second plan/mode on archives the previous live plan into the transcript', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, { type: 'plan/mode', data: { active: true } })
  tui.handleSessionEvent(agent.session, {
    type: 'todo/write',
    data: { todos: [{ content: 'first plan', status: 'completed' }] },
  })
  tui.handleSessionEvent(agent.session, { type: 'plan/mode', data: { active: false } })
  tui.handleSessionEvent(agent.session, { type: 'plan/mode', data: { active: true } })
  tui.handleSessionEvent(agent.session, {
    type: 'todo/write',
    data: { todos: [{ content: 'second plan', status: 'in_progress' }] },
  })
  const plans = tui.rows.filter(row => row.kind === 'plan')
  assert.equal(plans.length, 2)
  assert.equal(plans[0].archived, true)
  assert.equal(plans[0].todos[0]?.content, 'first plan')
  assert.equal(plans[1].archived, false)
  assert.equal(plans[1].todos[0]?.content, 'second plan')
  const frame = tui.captureFrame(80, 24)
  assert.ok(frame.some(line => line.includes('first plan') || line.includes('已归档') || line.includes('计划')))
  assert.ok(frame.some(line => line.includes('second plan') || line.includes('进行中')))
})

test('parseFindQuery and matchTranscriptRows filter thinking vs reply', () => {
  assert.deepEqual(parseFindQuery('思考 padAnsi'), { category: 'thinking', query: 'padAnsi' })
  assert.deepEqual(parseFindQuery('thinking overflow'), { category: 'thinking', query: 'overflow' })
  assert.deepEqual(parseFindQuery('just text'), { query: 'just text' })
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [
      { type: 'reasoning', text: 'look at padAnsiToWidth first' },
      { type: 'text', text: 'done with the overflow fix' },
    ] } },
  })
  const thinking = matchTranscriptRows(tui.rows, '思考 padAnsi')
  assert.equal(thinking.length, 1)
  assert.equal(thinking[0]?.kind, 'reasoning')
  const replies = matchTranscriptRows(tui.rows, '回复 overflow')
  assert.equal(replies.length, 1)
  assert.equal(replies[0]?.kind, 'assistant')
})

test('/find jumps to the matching reply and keeps it in the painted frame', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'user/message',
    data: { content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: 'early reply about widgets' }] } },
  })
  for (let i = 0; i < 12; i++) {
    tui.handleSessionEvent(agent.session, {
      type: 'user/message',
      data: { content: [{ type: 'text', text: `noise ${i} ${'x'.repeat(40)}` }], source: { kind: 'user' } },
    })
  }
  tui.handleSessionEvent(agent.session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'reasoning', text: 'unique-needle lives only in this thought' }, { type: 'text', text: 'later answer' }] } },
  })
  tui.runCommand('/find unique-needle')
  const frame = tui.captureFrame(80, 16)
  assert.ok(frame.some(line => line.includes('unique-needle')))
  assert.ok(frame.some(line => line.includes('»') || line.includes('已思考')))
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

test('slash commands that call the model or rewrite the session surface progress', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'command/run',
    data: { commandId: 'cmd-1', name: 'compact', args: '', source: { kind: 'user' } },
  })
  assert.equal(tui.status.includes('压缩'), true)
  tui.handleSessionEvent(agent.session, {
    type: 'command/done',
    data: { commandId: 'cmd-1', kind: 'error', text: 'Compaction is unavailable because the agent is not idle.' },
  })
  assert.ok(tui.rows.some(row => row.kind === 'error' && String(row.text).includes('Compaction is unavailable')))
  tui.handleSessionEvent(agent.session, {
    type: 'llm/retry',
    data: {
      retry: 1, maxRetries: 5, delayMs: 500,
      failure: { message: 'xAI API stream failed', code: 'TRANSPORT' },
    },
  })
  const retry = tui.captureFrame(80, 24)
  assert.ok(retry.some(line => line.includes('重试 1/5')))
  tui.handleSessionEvent(agent.session, {
    type: 'session/title',
    data: { title: '慢链路绘制', source: { kind: 'provider' } },
  })
  assert.equal(tui.sessionTitle, '慢链路绘制')
})

test('compaction start/prune/end show a progress card instead of staying silent', () => {
  assert.equal(compactionHeaderText({
    status: 'running', pruneCount: 0, prunedTokens: 0,
  }), '压缩上下文 · 准备摘要')
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/start',
    time: 1000,
    data: { compactionId: 'c1', sourceCommandId: 'cmd-1' },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/prune',
    time: 1100,
    data: { compactionId: 'c1', shadowedTokenCount: 2500 },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/prune',
    time: 1200,
    data: { compactionId: 'c1', shadowedTokenCount: 1500 },
  })
  let card = tui.rows.find(row => row.kind === 'compaction')
  assert.equal(card.status, 'running')
  assert.equal(card.pruneCount, 2)
  assert.equal(card.prunedTokens, 4000)
  const mid = tui.captureFrame(80, 24)
  assert.ok(mid.some(line => line.includes('压缩上下文') && line.includes('4K')))
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/summary',
    time: 1300,
    data: { compactionId: 'c1', summary: [{ type: 'text', text: 'Kept the SSH paint work.' }] },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/end',
    time: 1400,
    data: { compactionId: 'c1' },
  })
  card = tui.rows.find(row => row.kind === 'compaction')
  assert.equal(card.status, 'ok')
  assert.equal(card.summary.includes('SSH paint'), true)
  const done = tui.captureFrame(80, 24)
  assert.ok(done.some(line => line.includes('压缩完成')))
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
