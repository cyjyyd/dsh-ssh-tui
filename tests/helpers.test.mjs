import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
setLocale('zh')

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
  formatQuotaStatusLine,
  formatStatusReport,
  joinUrl,
  parseDeepSeekBalance,
  parseOpenAiCompatibleBalance,
  parseSuperGrokBilling,
  parseOpenCodeGoQuota,
  remainingPercentFromUsed,
  crossedQuotaThresholds,
  quotaAlertText,
  quotaRefreshEveryTurns,
  quotaRefreshEverySteps,
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
  promptInjectionSources,
  promptInjectionTitle,
  isPromptInjectionMessage,
  providerUsesLocalOAuth,
  detectSshSession,
  formatLinkQualityChip,
  formatQuotaBar,
  footerActivity,
  footerIdentityParts,
  footerStatsGroups,
  fitFooterStatsLine,
  fitFooterStatusLine,
  dropFooterQuotaPlanName,
  formatFooterQuota,
  buildToolHeader,
  toolBodyFitsWorkspace,
  toolStateColor,
  wrappedToolBodyLineCount,
  linkQualityOf,
  providerShortCode,
  paintIntervalForRtt,
  parseCursorPositionReply,
  resolvePaintIntervalMs,
  isHangupErrno,
  waitUntilIdleOrTimeout,
  captureHangupSignals,
  ignoreFurtherHangupSignals,
  renderMarkdownLines,
  renderToolDiff,
  repeatToWidth,
  SshTui,
  fmtElapsedCompact,
  waitCardCopy,
  waitSummaryFromReasoning,
  parseWorkspaceView,
  parseDisconnectPolicy,
  compactToolGroups,
  countDiffLines,
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
  describeSubagentFit,
  subagentCostClass,
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
  const color256 = clipAnsiToWidth('\x1b[38;2;122;168;116;48;2;18;42;24m+ hello', 12)
  assert.ok(color256.startsWith('\x1b[38;2;122;168;116;48;2;18;42;24m'))
  assert.ok(color256.includes('+ hello'))
})

test('padAnsiToWidth keeps diff background across the whole row', () => {
  const styled = '\x1b[38;2;122;168;116;48;2;18;42;24m+ hello'
  const padded = padAnsiToWidth(styled, 12)
  assert.ok(padded.startsWith('\x1b[38;2;122;168;116;48;2;18;42;24m'))
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

test('composePaintOutput full-repaints when the transcript viewport scrolls', () => {
  const previous = ['title', 'old-tool-body', 'prompt']
  const next = ['title', 'thinking', 'prompt']
  const frame = composePaintOutput({
    width: 12,
    height: 3,
    paintRows: next,
    previousRows: previous,
    sizeChanged: true,
    chromeChanged: false,
    chromeStart: 2,
    cursorRow: 3,
    cursorColumn: 1,
  })
  assert.ok(frame.includes('\x1b[H\x1b[J'))
  assert.ok(frame.includes('\x1b[1;1H'))
  assert.ok(frame.includes('\x1b[2;1H'))
  assert.ok(frame.includes('\x1b[3;1H'))
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

test('isHangupErrno matches dead-TTY write failures', () => {
  assert.equal(isHangupErrno({ code: 'EIO' }), true)
  assert.equal(isHangupErrno({ code: 'EPIPE' }), true)
  assert.equal(isHangupErrno({ code: 'ENXIO' }), true)
  assert.equal(isHangupErrno({ code: 'ECONNRESET' }), true)
  assert.equal(isHangupErrno({ code: 'EAGAIN' }), false)
  assert.equal(isHangupErrno(new Error('boom')), false)
  assert.equal(isHangupErrno(undefined), false)
})

test('waitUntilIdleOrTimeout resolves idle before the deadline', async () => {
  let idle = false
  let now = 0
  const waits = []
  const result = waitUntilIdleOrTimeout(
    () => idle,
    1000,
    () => now,
    async (ms) => {
      waits.push(ms)
      now += ms
      idle = true
    },
  )
  assert.equal(await result, 'idle')
  assert.deepEqual(waits, [50])
})

test('waitUntilIdleOrTimeout times out when still running', async () => {
  let now = 0
  const result = await waitUntilIdleOrTimeout(
    () => false,
    80,
    () => now,
    async (ms) => {
      now += ms
    },
  )
  assert.equal(result, 'timeout')
  assert.ok(now >= 80)
})

test('hangup cancels a running turn, flushes, and exits without writing goodbye', async () => {
  const flushed = []
  const cancelled = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { flush: async (session) => { flushed.push(session.id) } }
      }
      if (name === 'appExit') return (code) => { exits.push(code) }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel(reason) { cancelled.push(reason); this.status = 'idle' },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  await tui.handleHangup()
  assert.deepEqual(cancelled, [{ kind: 'user' }])
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(exits, [129])
  await tui.handleHangup()
  assert.equal(exits.length, 1)
})

test('hangup on an idle agent flushes without cancel', async () => {
  const cancelled = []
  const flushed = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { flush: async (session) => { flushed.push(session.id) } }
      }
      if (name === 'appExit') return (code) => { exits.push(code) }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel(reason) { cancelled.push(reason) },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  await tui.handleHangup()
  assert.deepEqual(cancelled, [])
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(exits, [129])
})

test('captureHangupSignals drops the launcher SIGTERM handler', () => {
  const launcher = []
  const ours = []
  const previousTerm = process.listeners('SIGTERM').slice()
  const previousHup = process.listeners('SIGHUP').slice()
  const previousInt = process.listeners('SIGINT').slice()
  const launcherFn = () => { launcher.push('launcher') }
  const oursFn = () => { ours.push('ours') }
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGHUP')
  process.removeAllListeners('SIGINT')
  process.on('SIGTERM', launcherFn)
  try {
    captureHangupSignals(oursFn)
    assert.equal(process.listeners('SIGTERM').includes(launcherFn), false)
    assert.equal(process.listeners('SIGTERM').includes(oursFn), true)
    process.emit('SIGTERM')
    assert.deepEqual(ours, ['ours'])
    assert.deepEqual(launcher, [])
    ignoreFurtherHangupSignals()
    ours.length = 0
    process.emit('SIGTERM')
    process.emit('SIGINT')
    assert.deepEqual(ours, [])
  } finally {
    process.removeAllListeners('SIGTERM')
    process.removeAllListeners('SIGHUP')
    process.removeAllListeners('SIGINT')
    for (const fn of previousTerm) process.on('SIGTERM', fn)
    for (const fn of previousHup) process.on('SIGHUP', fn)
    for (const fn of previousInt) process.on('SIGINT', fn)
  }
})

test('parseDisconnectPolicy accepts pause/continue aliases', () => {
  assert.equal(parseDisconnectPolicy('pause'), 'pause')
  assert.equal(parseDisconnectPolicy('继续'), 'continue')
  assert.equal(parseDisconnectPolicy('nope'), undefined)
})

test('hangup with disconnect continue does not cancel a running turn', async () => {
  const cancelled = []
  const flushed = []
  const hangups = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { flush: async (session) => { flushed.push(session.id) } }
      }
      if (name === 'appExit') return (code) => { exits.push(code) }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [] },
    cancel(reason) { cancelled.push(reason); this.status = 'idle' },
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    disconnectPolicy: 'continue',
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = { attached: false, close: async () => {} }
  await tui.handleHangup()
  assert.deepEqual(cancelled, [])
  assert.equal(agent.status, 'running')
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(hangups, ['hung'])
  assert.deepEqual(exits, [])
})

test('hangup keeps the host when a display socket is listening', async () => {
  const flushed = []
  const hangups = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') {
        return { flush: async (session) => { flushed.push(session.id) } }
      }
      if (name === 'appExit') return (code) => { exits.push(code) }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [] },
    cancel() { this.status = 'idle' },
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = { attached: false, close: async () => {} }
  await tui.handleHangup()
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(hangups, ['hung'])
  assert.deepEqual(exits, [])
  assert.equal(tui.disposed, false)
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
    cwdLabel: '目录:srv',
  })
  assert.deepEqual(identity, ['[标准模式]', '目录:srv', 'grok-4.6 xhigh', 'sub:grok-4.5', `SuperGrok ${formatQuotaBar(82)} 82%`, '排队 1'])
  const line = fitFooterStatusLine('子代理 2', identity, 28)
  assert.match(line, /^子代理 2/)
  assert.equal(line.includes('排队'), false)
  assert.ok(displayWidth(line) <= 28)
})

test('narrow footer drops the quota plan name before the remaining bar', () => {
  const identity = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'grok-4.6', effort: 'xhigh', preset: '标准模式', provider: 'xai',
    parentModel: 'grok-4.6', subModel: 'grok-4.5', subDiffers: true,
    quotaCode: 'SuperGrok', quotaPercent: 82, foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.equal(identity.includes(formatFooterQuota(82, 'SuperGrok')), true)
  const rewritten = [...identity]
  assert.equal(dropFooterQuotaPlanName(rewritten), true)
  assert.equal(rewritten.includes(formatFooterQuota(82)), true)
  assert.equal(rewritten.some(part => part.startsWith('SuperGrok ')), false)

  const wide = fitFooterStatusLine('空闲', identity, 80)
  assert.match(wide, /SuperGrok/)
  assert.match(wide, /82%/)
  // Full identity is 72 cells with the plan name, 62 without it — 64 is
  // the window where shrinking the quota widget is enough.
  const mid = fitFooterStatusLine('空闲', identity, 64)
  assert.equal(mid.includes('SuperGrok'), false)
  assert.match(mid, /82%/)
  assert.match(mid, /[█░]{8}/)
  assert.ok(displayWidth(mid) <= 64)
  const tight = fitFooterStatusLine('空闲', identity, 18)
  assert.equal(tight.includes('SuperGrok'), false)
  assert.ok(displayWidth(tight) <= 18)
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

test('fmtElapsedCompact matches Codex compact elapsed', () => {
  assert.equal(fmtElapsedCompact(0), '0s')
  assert.equal(fmtElapsedCompact(59), '59s')
  assert.equal(fmtElapsedCompact(61), '1m 01s')
  assert.equal(fmtElapsedCompact(3661), '1h 01m 01s')
})

test('waitCardCopy prefers a live tool then a model summary, not the user prompt', () => {
  assert.equal(waitCardCopy({}).header, '处理中')
  assert.equal(waitCardCopy({ prompt: '  fix the footer  ' }).detail, undefined)
  assert.equal(waitCardCopy({
    toolTitle: '读取',
    toolSummary: 'src/tui.ts',
    prompt: 'ignored once a tool is live',
  }).detail, '读取  src/tui.ts')
  assert.equal(waitCardCopy({
    reasoning: '**Inspecting paint** then a long explanation of leftover glyphs.',
    prompt: 'please fix leftover paint',
  }).header, 'Inspecting paint')
})

test('waitSummaryFromReasoning keeps a short Codex-style clause', () => {
  assert.equal(waitSummaryFromReasoning('**Reading files**\nmore'), 'Reading files')
  assert.equal(waitSummaryFromReasoning('# 核对光标\n后面很长'), '核对光标')
  const long = waitSummaryFromReasoning('这是一段没有加粗的很长说明文字用来测试截断')
  assert.ok(long !== undefined && long.length <= 18)
})

test('wait card tracks model work and stays while thinking', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'running',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  tui.waitStartedAt = Date.now() - 1500
  tui.waitPrompt = '请修绘制残留'
  const waiting = tui.captureFrame(48, 16)
  assert.ok(waiting.some(line => line.includes('处理中')))
  assert.equal(waiting.some(line => line.includes('请修绘制残留')), false)
  assert.ok(waiting.some(line => /Esc/.test(line)))
  tui.streaming = { text: '', reasoning: '**Inspecting paint** leftover glyphs on the title' }
  tui.streamingReasoning = { kind: 'streaming-reasoning', expanded: false }
  const thinking = tui.captureFrame(56, 16)
  assert.ok(thinking.some(line => line.includes('Inspecting paint')))
  assert.ok(thinking.some(line => /Esc/.test(line)))
})

test('foldInputView keeps wide characters intact around the cursor', () => {
  const view = foldInputView('🙂🙂🙂🙂🙂', 6, 10)
  assert.equal(view.cursorOffset, 6)
  assert.equal(view.folded, false)
})

test('foldInputView clips a long line around the caret and keeps the caret on that row', () => {
  const line = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const cursor = 20
  const view = foldInputView(line, cursor, 16)
  assert.equal(view.folded, true)
  assert.ok(view.text.startsWith('…') || view.text.endsWith('…'))
  assert.equal(view.text.includes('\n'), false)
  assert.ok(view.cursorOffset >= 0)
  assert.ok(view.cursorOffset <= displayWidth(view.text))
  assert.ok(displayWidth(view.text) <= 16)
  const promptWidth = 2
  const column = promptWidth + view.cursorOffset + 1
  assert.ok(column <= 18)
})

test('foldInputView of a multi-line paste uses the current line only', () => {
  const input = `${'alpha '.repeat(20)}\nMIDDLE_LINE_XXXX\n${'omega '.repeat(20)}`
  const cursor = input.indexOf('MIDDLE') + 'MIDDLE'.length
  const view = foldInputView(input, cursor, 24)
  assert.equal(view.text.includes('\n'), false)
  assert.ok(view.text.includes('MIDDLE'))
  assert.equal(view.text.includes('alpha'), false)
  assert.equal(view.text.includes('omega'), false)
  assert.ok(view.cursorOffset <= displayWidth(view.text))
})

test('folded long paste does not park the caret on the stats/status chrome', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  tui.input = `${'paste-line\n'.repeat(40)}CARET_HERE`
  tui.cursor = tui.input.indexOf('CARET_HERE') + 'CARET'.length
  tui.inputFolded = true
  const frame = tui.captureFrame(48, 16)
  assert.equal(frame.length, 16)
  const inputIndex = frame.findIndex(line => line.startsWith('> ') || line.startsWith('❯ '))
  assert.ok(inputIndex >= 0)
  assert.ok(frame[inputIndex]?.includes('CARET'))
  assert.equal(frame[inputIndex]?.includes('\n'), false)
  const statsIndex = frame.findIndex(line => line.includes('本机') || line.includes('SSH') || line.includes('Local'))
  if (statsIndex >= 0) {
    assert.equal(frame[statsIndex]?.includes('CARET_HERE'), false)
  }
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
  assert.deepEqual(crossedQuotaThresholds(undefined, 8), [10])
  assert.deepEqual(crossedQuotaThresholds(undefined, 4), [5])
  const alert = quotaAlertText(snap, snap.windows[0])
  assert.match(alert, /^⚠ /u)
  assert.match(alert, /SuperGrok/)
  assert.match(alert, /每周额度还剩余 82%/)
  assert.equal(quotaRefreshEveryTurns(snap.windows[0]), 50)
  assert.equal(quotaRefreshEveryTurns({ label: '本周', period: 'weekly', remainingPercent: 48 }), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '5h', period: 'hourly', remainingPercent: 80 }), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '5h', period: 'hourly', remainingPercent: 50 }), 4)
  assert.equal(quotaRefreshEveryTurns({ label: '本月', period: 'monthly', remainingPercent: 90 }), 80)
  assert.equal(quotaRefreshEverySteps(snap.windows[0]), 50)
  assert.deepEqual(crossedQuotaThresholds(80, 4), [5])
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

test('presentToolCall localizes mutation and common file tool names', () => {
  assert.equal(presentToolCall('edit', JSON.stringify({ file_path: 'a.ts', old_string: 'a', new_string: 'b' })).title, '编辑')
  assert.equal(presentToolCall('write', JSON.stringify({ file_path: 'a.ts', content: 'x' })).title, '写入')
  assert.equal(presentToolCall('str_replace_editor', JSON.stringify({ path: 'a.ts', command: 'str_replace' })).title, '替换')
  assert.equal(presentToolCall('list_files', '{}').title, '列出文件')
  assert.equal(presentToolCall('find', JSON.stringify({ pattern: '*.ts' })).title, '搜索文件')
  assert.equal(presentToolCall('delete', JSON.stringify({ path: 'a.ts' })).title, '删除文件')
  assert.equal(presentToolCall('skills', '{}').title, '技能')
  assert.equal(presentToolCall('bash', JSON.stringify({ command: 'ls' })).title, 'bash')
  assert.equal(presentToolCall('update_goal', JSON.stringify({ action: 'edit', objective: '收口工具卡' })).title, '更新目标')
  assert.equal(presentToolCall('create_goal', JSON.stringify({ objective: '做完 A' })).title, '创建目标')
  assert.equal(presentToolCall('get_goal', '{}').title, '查看目标')
})

test('get_goal tool cards stay hidden; update_goal is labelled 更新目标', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'tool/call',
    time: 1,
    data: { callId: 'g1', name: 'get_goal', arguments: '{}' },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'tool/call',
    time: 3,
    data: { callId: 'u1', name: 'update_goal', arguments: JSON.stringify({ objective: '收口工具卡' }) },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'goal/change',
    time: 4,
    data: { goal: { objective: '收口工具卡', phase: 'active' } },
  })
  const tools = tui.rows.filter(row => row.kind === 'tool')
  assert.equal(tools.some(row => row.name === 'get_goal'), false)
  const update = tools.find(row => row.name === 'update_goal')
  assert.equal(update?.title, '更新目标')
  assert.equal(update?.summary, '收口工具卡')
  assert.ok(tui.rows.some(row => row.kind === 'goal' && row.objective === '收口工具卡'))
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

test('parseWorkspaceView accepts compact aliases', () => {
  assert.equal(parseWorkspaceView('compact'), 'compact')
  assert.equal(parseWorkspaceView('minimal'), 'compact')
  assert.equal(parseWorkspaceView('极简'), 'compact')
  assert.equal(parseWorkspaceView('detailed'), 'detailed')
  assert.equal(parseWorkspaceView('nope'), undefined)
})

test('compactToolGroups splits edits from other calls and counts lines', () => {
  const groups = compactToolGroups([
    { kind: 'tool', callId: 'e1', name: 'edit', title: '编辑', summary: 'a.ts', args: '{}', output: '', status: 'ok', expanded: false, diff: [{ path: 'a.ts', oldText: 'a\nb', newText: 'a\nc\nd' }] },
    { kind: 'tool', callId: 'r1', name: 'read', title: '读取', summary: 'a.ts', args: '{}', output: '', status: 'ok', expanded: false },
    { kind: 'tool', callId: 'g1', name: 'grep', title: '搜索', summary: 'x', args: '{}', output: '', status: 'error', expanded: false },
  ])
  assert.equal(groups.edits.length, 1)
  assert.equal(groups.calls.length, 2)
  assert.equal(groups.failedCalls, 1)
  assert.equal(countDiffLines(groups.edits[0].diff) > 0, true)
})

test('compact view hides thinking and pins merged tools after the reply', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  tui.setWorkspaceView('compact')
  tui.rows.push(
    { kind: 'reasoning', text: 'SECRET_THOUGHT', expanded: false },
    { kind: 'tool', callId: 'r1', name: 'read', title: '读取', summary: 'a.ts', args: '{}', output: 'ok', status: 'ok', expanded: false },
    { kind: 'tool', callId: 'g1', name: 'grep', title: '搜索', summary: 'x', args: '{}', output: 'miss', status: 'ok', expanded: false },
    { kind: 'tool', callId: 'e1', name: 'edit', title: '编辑', summary: 'a.ts', args: '{}', output: '', status: 'ok', expanded: false, diff: [{ path: 'a.ts', oldText: 'a', newText: 'b\nc' }] },
    { kind: 'assistant', text: 'visible reply that would scroll early tool cards away' },
  )
  const frame = tui.captureFrame(72, 16)
  const text = frame.join('\n')
  assert.equal(text.includes('SECRET_THOUGHT'), false)
  assert.equal(text.includes('已思考'), false)
  assert.ok(text.includes('visible reply'))
  assert.ok(text.includes('已调用 2 个工具'))
  assert.ok(text.includes('已编辑'))
  const replyAt = frame.findIndex(line => line.includes('visible reply'))
  const toolsAt = frame.findIndex(line => line.includes('已调用'))
  assert.ok(replyAt >= 0 && toolsAt >= 0 && toolsAt > replyAt)
})

test('Ctrl+R without a selection expands the latest card', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.rows.push(
    { kind: 'reasoning', text: 'old thought', expanded: false },
    { kind: 'tool', callId: 'c1', name: 'read', title: '读取', summary: 'a.ts', args: '{}', output: 'ok', status: 'ok', expanded: false },
  )
  tui.focusedRow = null
  tui.toggleCollapsible()
  const latest = tui.rows.findLast(row => row.kind === 'tool')
  const older = tui.rows.find(row => row.kind === 'reasoning')
  assert.equal(latest?.expanded, true)
  assert.equal(older?.expanded, false)
})

test('streaming a collapsed thinking line does not keep a scrolled tool body on the title', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'running',
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
    output: 'TOOL_BODY_SHOULD_NOT_COVER_TITLE',
    status: 'ok',
    expanded: true,
  })
  const before = tui.captureFrame(40, 12)
  tui.streaming = { text: '', reasoning: '思考折叠中的内容应当只占一行' }
  tui.streamingReasoning = { kind: 'streaming-reasoning', expanded: false }
  const after = tui.captureFrame(40, 12)
  assert.ok(after.some(line => line.includes('DeepSeek Harness')))
  const title = after.find(line => line.includes('DeepSeek Harness')) ?? ''
  assert.equal(title.includes('TOOL_BODY_SHOULD_NOT_COVER_TITLE'), false)
  const input = after.find(line => line.startsWith('> ') || line.startsWith('❯ ')) ?? ''
  assert.equal(input.includes('TOOL_BODY_SHOULD_NOT_COVER_TITLE'), false)
  assert.equal(before.length, 12)
  assert.equal(after.length, 12)
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

test('tool card colors follow state: green ok, red error, dim shell command', () => {
  const prevTerm = process.env.TERM
  const prevNoColor = process.env.NO_COLOR
  process.env.TERM = 'xterm-256color'
  delete process.env.NO_COLOR
  try {
    const build = (status, name, summary, title, output) => {
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
      kind: 'tool', callId: `c-${name}`, name, title, summary,
      args: '{}', output, status, expanded: true,
      ...(name === 'bash' ? { command: summary.slice(2), exitCode: status === 'ok' ? 0 : 1 } : {}),
    })
    return tui.captureFrame(72, 18).join('\n')
  }
    const okFrame = build('ok', 'bash', '$ npm test', 'bash', '3 passing')
    assert.match(okFrame, /\x1b\[32m●/)
    assert.match(okFrame, /\x1b\[32m\[ok\]/)
    assert.match(okFrame, /\x1b\[90m\s*\$\s?npm test/)
    assert.match(okFrame, /3 passing/)
    const errFrame = build('error', 'bash', '$ npm test', 'bash', '1 failing')
    assert.match(errFrame, /\x1b\[31m●/)
    assert.match(errFrame, /\x1b\[31m\[error\]/)
    const readFrame = build('ok', 'read', 'src/tui.ts', '读取', 'export const x = 1')
    assert.match(readFrame, /\x1b\[32m●/)
    assert.match(readFrame, /\x1b\[90m\s+src\/tui\.ts/)
    // Title and body stay default; only the status dot/word are green.
    assert.equal(/\x1b\[32m读取/.test(readFrame), false)
    assert.equal(readFrame.includes('\x1b[33m'), false)
    const editFrame = build('ok', 'edit', 'src/tui.ts', '编辑', '')
    assert.match(editFrame, /\x1b\[32m●/)
    assert.match(editFrame, /\x1b\[90m\s+src\/tui\.ts/)
    assert.match(readFrame, /●\x1b\[0m 读取/)
    assert.match(editFrame, /●\x1b\[0m 编辑/)
  } finally {
    if (prevTerm === undefined) delete process.env.TERM
    else process.env.TERM = prevTerm
    if (prevNoColor === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prevNoColor
  }
})

test('buildToolHeader colors only the status dot and [ok]/[error] word', () => {
  const header = buildToolHeader({
    focused: false, expanded: false, title: '读取', summary: 'src/tui.ts', status: 'ok',
  })
  assert.match(header.plain, /● 读取  src\/tui\.ts  \[ok\]/)
  const dot = header.segments.find(segment => header.plain.slice(segment.start, segment.end) === '●')
  const state = header.segments.find(segment => header.plain.slice(segment.start, segment.end).includes('[ok]'))
  const summary = header.segments.find(segment => header.plain.slice(segment.start, segment.end).includes('src/tui.ts'))
  assert.equal(dot?.sgr, '32')
  assert.equal(state?.sgr, '32')
  assert.equal(summary?.sgr, '90')
  assert.equal(toolStateColor('running'), '33')
  assert.equal(toolStateColor('error'), '31')
})

test('oversized tool bodies open a dedicated inspect overlay', () => {
  assert.equal(toolBodyFitsWorkspace(10, 12), true)
  assert.equal(toolBodyFitsWorkspace(11, 12), true)
  assert.equal(toolBodyFitsWorkspace(12, 12), false)
  const lines = Array.from({ length: 40 }, (_, index) => ({ text: `LINE_${index}` }))
  assert.ok(wrappedToolBodyLineCount(lines, 40) >= 40)

  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  const output = Array.from({ length: 80 }, (_, index) => `BODY_LINE_${index}`).join('\n')
  tui.rows.push({
    kind: 'tool', callId: 'call-big', name: 'read', title: '读取', summary: 'big.ts',
    args: JSON.stringify({ path: 'big.ts' }), output, status: 'ok', expanded: false,
  })
  const tool = tui.rows.find(row => row.kind === 'tool')
  process.stdout.columns = 48
  process.stdout.rows = 16
  tui.toggleCard(tool)
  assert.equal(tool.expanded, false)
  assert.equal(tui.dialog?.kind, 'inspect')
  const overlay = tui.captureFrame(48, 16)
  assert.ok(overlay.some(line => line.includes('工具全文')))
  assert.ok(overlay.some(line => line.includes('BODY_LINE_0')))
  assert.ok(overlay.some(line => line.includes('Esc 返回')))
  tui.closeInspect()
  assert.equal(tui.dialog, undefined)
  const back = tui.captureFrame(48, 16)
  assert.ok(back.some(line => line.startsWith('> ') || line.startsWith('❯ ')))
  assert.equal(back.some(line => line.includes('工具全文')), false)

  tui.rows.push({
    kind: 'tool', callId: 'call-small', name: 'read', title: '读取', summary: 'tiny.ts',
    args: JSON.stringify({ path: 'tiny.ts' }), output: 'one line', status: 'ok', expanded: false,
  })
  const small = tui.rows.find(row => row.kind === 'tool' && row.callId === 'call-small')
  tui.toggleCard(small)
  assert.equal(small.expanded, true)
  assert.equal(tui.dialog, undefined)
  const inPlace = tui.captureFrame(48, 16)
  assert.ok(inPlace.some(line => line.includes('one line')))
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
  assert.equal(plan?.expanded, true)
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

test('promptInjectionSources joins system preset and instruction files', () => {
  assert.deepEqual(
    promptInjectionSources('You are an AI agent powered by DeepSeek Harness.'),
    ['系统预设'],
  )
  assert.deepEqual(
    promptInjectionSources('<system-reminder>Additional instructions from: pkg/AGENTS.md</system-reminder>'),
    ['AGENTS.MD'],
  )
  const both = promptInjectionSources(
    'You are an AI agent powered by DeepSeek Harness.\n<system-reminder>Additional instructions from: ./CLAUDE.md and AGENTS.md</system-reminder>',
  )
  assert.ok(both.includes('系统预设'))
  assert.ok(both.includes('AGENTS.MD'))
  assert.ok(both.includes('CLAUDE.MD'))
  assert.equal(promptInjectionTitle(['系统预设', 'AGENTS.MD']), '提示词注入:系统预设 AGENTS.MD')
  assert.equal(isPromptInjectionMessage('plugin', 'hello', 'agent-instructions'), true)
  assert.equal(isPromptInjectionMessage('user', 'hello'), false)
})

test('injected system reminders become a collapsed 提示词注入 card', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'user/message',
    data: {
      content: [{
        type: 'text',
        text: 'You are an AI agent powered by DeepSeek Harness.\n<system-reminder>Additional instructions from: /proj/AGENTS.md</system-reminder>',
      }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    },
  })
  const card = tui.rows.find(row => row.kind === 'prompt')
  assert.equal(card?.expanded, false)
  assert.ok(card?.sources.includes('系统预设'))
  assert.ok(card?.sources.includes('AGENTS.MD'))
  const frame = tui.captureFrame(80, 16)
  assert.ok(frame.some(line => line.includes('提示词注入:系统预设 AGENTS.MD')))
  assert.equal(frame.some(line => line.includes('(context)')), false)
  assert.equal(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('powered by DeepSeek')), false)
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
  // With the parent model id, flash-like ids closest to the parent name win.
  assert.equal(
    defaultSubagentModelForProvider('deepseek-official', ['deepseek-v4-pro', 'deepseek-v4-flash'], 'deepseek-v4-pro'),
    'deepseek-v4-flash',
  )
  assert.equal(
    defaultSubagentModelForProvider('deepseek-official', ['deepseek-v4-flash-vision-exp', 'deepseek-v4-flash'], 'deepseek-v4-flash-vision-exp'),
    'deepseek-v4-flash',
  )
  assert.equal(
    defaultSubagentModelForProvider('xai', ['grok-4.6', 'grok-4.3'], 'grok-4.6'),
    'grok-4.3',
  )
  assert.equal(subagentModelMatchesProvider('xai', 'deepseek-v4-flash'), false)
  assert.equal(subagentModelMatchesProvider('deepseek-official', 'deepseek-v4-flash'), true)
  // A dirty catalog that still lists the leftover DeepSeek id must not keep it on xAI.
  assert.equal(
    subagentModelMatchesProvider('xai', 'deepseek-v4-flash', ['grok-4.6', 'deepseek-v4-flash']),
    false,
  )
  assert.equal(
    subagentModelMatchesProvider('xai', 'grok-4.5', ['grok-4.6', 'grok-4.5']),
    true,
  )
  assert.equal(subagentCostClass('deepseek-v4-flash'), 'light')
  assert.equal(subagentCostClass('grok-4.5'), 'light')
  assert.equal(subagentCostClass('grok-4.6'), 'heavy')
  assert.equal(subagentCostClass('deepseek-v4-pro'), 'heavy')
  const cheap = describeSubagentFit({
    parentProvider: 'xai', parentModel: 'grok-4.6', subModel: 'grok-4.5',
  })
  assert.equal(cheap.sameFamily, true)
  assert.equal(cheap.expensive, false)
  assert.match(cheap.line, /跟随父/)
  assert.match(cheap.line, /同族/)
  const leftover = describeSubagentFit({
    parentProvider: 'xai', parentModel: 'grok-4.6', subModel: 'deepseek-v4-flash',
  })
  assert.equal(leftover.sameFamily, false)
  const expensive = describeSubagentFit({
    parentProvider: 'deepseek-official', parentModel: 'deepseek-v4-pro', subModel: 'deepseek-v4-pro',
  })
  assert.equal(expensive.expensive, true)
  assert.match(expensive.line, /较贵（目录无轻量）/)
})

test('/status lists the link chip, quota window, and subagent family fit', () => {
  const quota = parseOpenCodeGoQuota({
    usage: {
      rolling: { status: 'ok', percent: 40 },
      weekly: { status: 'ok', percent: 10 },
      monthly: { status: 'ok', percent: 70 },
    },
  }, 'opencode-go')
  assert.match(formatQuotaStatusLine(quota), /quota: OpenCode Go/)
  assert.match(formatQuotaStatusLine(quota), /本月 30%/)
  assert.equal(formatQuotaStatusLine(undefined), 'quota: none')
  const lines = formatStatusReport({
    sessionId: 'sess-1',
    pluginVersion: '0.3.8',
    provider: 'opencode-go',
    model: 'deepseek-v4-pro',
    effort: 'max',
    agentStatus: 'idle',
    preset: '标准模式',
    activeSubagents: 0,
    plan: 'off',
    paint: 'SSH ●●●○ 90ms',
    disconnect: 'continue',
    waitingQuestions: 0,
    quota,
    parentModel: 'deepseek-v4-pro',
    subModel: 'deepseek-v4-flash',
    cwd: '/root/genshin/srv',
  })
  assert.ok(lines.some(line => line === 'cwd: /root/genshin/srv'))
  assert.ok(lines.some(line => line.startsWith('paint: SSH ●●●○ 90ms')))
  assert.ok(lines.some(line => line === 'disconnect: continue'))
  assert.ok(lines.some(line => line.startsWith('quota: OpenCode Go')))
  assert.ok(lines.some(line => line.includes('subagent: deepseek-v4-flash') && line.includes('同族')))
  const heavy = formatStatusReport({
    sessionId: 'sess-1',
    pluginVersion: '0.3.8',
    provider: 'xai',
    model: 'grok-4.6',
    agentStatus: 'idle',
    preset: '标准模式',
    activeSubagents: 0,
    plan: 'off',
    paint: '本机 ●●●●',
    waitingQuestions: 0,
    parentModel: 'grok-4.6',
    subModel: 'grok-4.6',
  })
  assert.ok(heavy.some(line => line.includes('较贵（目录无轻量）')))
})

test('clicking the footer directory chip prints the full workspace path', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/root/genshin/srv' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  const frame = tui.captureFrame(80, 16)
  assert.ok(frame.some(line => line.includes('目录:srv')))
  const chipRow = frame.findIndex(line => line.includes('目录:srv'))
  assert.ok(chipRow >= 0)
  tui.handleMouseClick(chipRow + 1)
  assert.ok(tui.rows.some(row => row.kind === 'system' && row.text === '工作目录 /root/genshin/srv'))
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

import {
  parseSuperGrokAuthFile,
  superGrokTokenNeedsRefresh,
  persistSuperGrokToken,
} from '../lib/supergrok-token.js'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('parseSuperGrokAuthFile reads grok-bridge auth.json', () => {
  const now = 1_700_000_000_000
  const parsed = parseSuperGrokAuthFile({
    access_token: 'abc',
    refresh_token: 'ref',
    expires_at: now + 60 * 60 * 1000,
  }, '/tmp/auth.json')
  assert.equal(parsed?.accessToken, 'abc')
  assert.equal(parsed?.refreshToken, 'ref')
  assert.ok(parsed)
  assert.equal(superGrokTokenNeedsRefresh(parsed, now), false)
  assert.equal(superGrokTokenNeedsRefresh(parsed, now + 56 * 60 * 1000), true)
  assert.equal(superGrokTokenNeedsRefresh({ ...parsed, expiresAt: now - 1 }, now), true)
})

test('persistSuperGrokToken writes 0600 grok-bridge auth.json', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-tui-grok-'))
  const path = join(home, 'auth.json')
  const saved = await persistSuperGrokToken(path, {
    access_token: 'new',
    refresh_token: 'next',
    expires_in: 3600,
  }, 'prev', 1_700_000_000_000)
  assert.equal(saved.accessToken, 'new')
  const raw = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(raw.access_token, 'new')
  assert.equal(raw.refresh_token, 'next')
  assert.equal(raw.expires_at, 1_700_000_000_000 + 3600 * 1000)
})
