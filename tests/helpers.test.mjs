import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
import { filterCatalogPresets, mergeProviderEntries } from '../lib/provider-catalog.js'
setLocale('zh')

import {
  askSummary,
  clipAnsiToWidth,
  composePaintOutput,
  describeProviderRoute,
  displayWidth,
  padAnsiToWidth,
  cursorVisualPosition,
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
  hrefAtColumn,
  isEscapePrefix,
  osc52Clipboard,
  osc8Enabled,
  paintedLinkHits,
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
  formatTokensPerSecond,
  fitFooterStatsLine,
  fitFooterStatusLine,
  dropFooterQuotaPlanName,
  formatFooterQuota,
  subagentRouteLabel,
  formatFooterBalance,
  formatCompactCommandError,
  formatContextPressureChip,
  formatContextPressureRing,
  formatContextPressureStatusLine,
  parseContextPressure,
  contextPressureView,
  shouldIdleAutoCompact,
  CONTEXT_IDLE_COMPACT_RATIO,
  CONTEXT_RING_EMPTY,
  buildToolHeader,
  toolBodyFitsWorkspace,
  toolStateColor,
  wrappedToolBodyLineCount,
  linkQualityOf,
  providerShortCode,
  paintIntervalForRtt,
  parseCursorPositionReply,
  findCursorPositionReply,
  probeTerminalRttMs,
  resolvePaintIntervalMs,
  isHangupErrno,
  waitUntilIdleOrTimeout,
  captureHangupSignals,
  ignoreFurtherHangupSignals,
  renderMarkdownLines,
  renderToolDiff,
  repeatToWidth,
  SshTui,
  commandAcceptsAttachments,
  forEachSessionEvent,
  inspectPersistenceSession,
  isTokenDeltaChunk,
  listPersistenceHeaders,
  streamChunkOf,
  streamFirstTokenTime,
  streamFrameAttemptId,
  streamFrameOwner,
  writeBootSplash,
  fmtElapsedCompact,
  waitCardCopy,
  waitSummaryFromReasoning,
  wrapWaitDetails,
  parseWorkspaceView,
  parseDisconnectPolicy,
  parseEffortArg,
  canMergeToolCall,
  countOutputLines,
  pickerWindowStart,
  compactToolGroups,
  compactEditPath,
  compactToolBursts,
  countDiffLines,
  countDiffAddDel,
  diffStatToken,
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

/** Minimal DisplayHost stand-in for hangup tests. */
function fakeDisplayHost() {
  const host = {
    attached: false,
    sendStdout() { return true },
    close: async () => { host.attached = false },
  }
  return host
}

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

test('displayWidth counts emoji symbols two cells and variation selectors zero', () => {
  // npm test's pass/fail marks: an emoji font draws these double-width, so a
  // row measured at one cell spilled onto the next card.
  assert.equal(displayWidth('✔'), 2)
  assert.equal(displayWidth('✖'), 2)
  assert.equal(displayWidth('✔️'), 2)
  assert.equal(displayWidth('✅'), 2)
  assert.equal(displayWidth('❌'), 2)
  assert.equal(displayWidth('⚠️'), 2)
  // Box-drawing, TUI chrome, and text arrows keep their one-cell width.
  assert.equal(displayWidth('✓'), 1)
  assert.equal(displayWidth('✗'), 1)
  assert.equal(displayWidth('→'), 1)
  assert.equal(displayWidth('·'), 1)
  assert.equal(displayWidth('#️⃣'), 2)
  assert.equal(displayWidth('✔ 计划'), 7)
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

test('composePaintOutput can keep the cursor hidden for the session picker', () => {
  const hidden = composePaintOutput({
    width: 8,
    height: 3,
    paintRows: ['one', 'next'],
    previousRows: ['one', 'two'],
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: 2,
    cursorRow: 3,
    cursorColumn: 1,
    hideCursor: true,
  })
  assert.ok(hidden.includes('\x1b[?25l'))
  assert.equal(hidden.includes('\x1b[?25h'), false)
  const idle = composePaintOutput({
    width: 8,
    height: 3,
    paintRows: ['one', 'two'],
    previousRows: ['one', 'two'],
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: 2,
    cursorRow: 3,
    cursorColumn: 1,
    hideCursor: true,
  })
  assert.equal(idle, '')
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
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel(reason) { cancelled.push(reason) },
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
  assert.deepEqual(cancelled, [])
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(hangups, [], 'idle hangup must not keep the Host')
  assert.deepEqual(exits, [129])
  assert.equal(tui.disposed, true)
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

test('pickerWindowStart keeps a 12-row window around the cursor', () => {
  assert.equal(pickerWindowStart(0, 8), 0)
  assert.equal(pickerWindowStart(0, 30), 0)
  assert.equal(pickerWindowStart(20, 30), 15)
  assert.equal(pickerWindowStart(29, 30), 18)
})

test('slash suggestions on a bare slash include /disconnect', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.input = '/'
  tui.cursor = 1
  const text = tui.captureFrame(88, 28).join('\n')
  assert.ok(text.includes('/disconnect'))
  assert.ok(text.includes('断线策略'))
  assert.equal(/select model and reasoning/u.test(text), false)
  assert.equal(text.includes('/dialog-test'), false)
  assert.equal(text.includes('/exit'), false)
  assert.equal(text.includes('/lang '), false)
  assert.equal(text.includes('/balance'), false)
})

test('slash suggestions slide a 12-row window with the selected command', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.input = '/'
  tui.cursor = 1
  tui.captureFrame(88, 32)
  tui.suggestionIndex = Math.max(0, tui.commandSuggestions.length - 1)
  const frame = tui.captureFrame(88, 32)
  const text = frame.join('\n')
  if (tui.commandSuggestions.length > 12) assert.ok(text.includes('↑ 还有'))
  const rows = frame.filter(line => /[› ] \/[-a-z]+\s/u.test(line))
  assert.ok(rows.length <= 12)
  assert.ok(rows.length >= 1)
})

test('question dialogs slide a 12-row window around the focused option', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const options = Array.from({ length: 30 }, (_, index) => ({
    label: `model-${String(index).padStart(2, '0')}`,
    description: index === 20 ? '当前' : undefined,
  }))
  tui.dialog = {
    kind: 'questions',
    question: { id: 'model-pick', question: '选择模型', options },
    index: 0,
    total: 1,
    selected: new Set([20]),
    cursor: 20,
    resolve() {},
    reject() {},
  }
  const text = tui.captureFrame(88, 32).join('\n')
  assert.ok(text.includes('model-20'))
  assert.equal(text.includes('model-00'), false)
  assert.ok(text.includes('↑ 还有') && text.includes('↓ 还有'))
})

test('parseDisconnectPolicy accepts pause/continue aliases', () => {
  assert.equal(parseDisconnectPolicy('pause'), 'pause')
  assert.equal(parseDisconnectPolicy('继续'), 'continue')
  assert.equal(parseDisconnectPolicy('nope'), undefined)
})

test('arrow-up history restores the live draft when arrow-down past the newest item', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    followup() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.history.push('first')
  tui.history.push('second')
  tui.historyIndex = 2
  tui.input = 'draft-now'
  tui.cursor = tui.input.length
  tui.historyBack()
  assert.equal(tui.input, 'second')
  tui.historyBack()
  assert.equal(tui.input, 'first')
  tui.historyForward()
  assert.equal(tui.input, 'second')
  tui.historyForward()
  assert.equal(tui.input, 'draft-now')
  tui.historyBack()
  assert.equal(tui.input, 'second')
  tui.historyForward()
  assert.equal(tui.input, 'draft-now')
})

test('consecutive same-path reads and edits collapse; a different path starts a new card', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const session = agent.session
  const read = (id, path, body) => {
    tui.handleSessionEvent(session, {
      type: 'tool/call',
      data: { callId: id, name: 'read', arguments: JSON.stringify({ path }) },
    })
    tui.handleSessionEvent(session, {
      type: 'tool/result',
      data: {
        message: { source: { callId: id }, content: [{ type: 'text', text: body }] },
      },
    })
  }
  const edit = (id, path, oldText, newText) => {
    tui.handleSessionEvent(session, {
      type: 'tool/call',
      data: { callId: id, name: 'edit', arguments: JSON.stringify({ file_path: path, old_string: oldText, new_string: newText }) },
    })
    tui.handleSessionEvent(session, {
      type: 'tool/result',
      data: {
        message: { source: { callId: id }, content: [{ type: 'text', text: 'ok' }] },
        meta: { diffs: [{ path, oldText, newText }] },
      },
    })
  }

  read('r1', 'a.ts', 'aaaa\n')
  read('r2', 'a.ts', 'aaaa\nbbbb\n')
  read('r3', 'b.ts', 'b\n')
  read('r4', 'a.ts', 'again\n')
  edit('e1', 'c.ts', 'old', 'new1')
  edit('e2', 'c.ts', 'new1', 'new2')
  edit('e3', 'd.ts', 'x', 'y')

  const tools = tui.rows.filter(row => row.kind === 'tool')
  assert.equal(tools.length, 5)
  assert.equal(tools[0].summary, 'a.ts')
  assert.equal(tools[0].repeats, 2)
  assert.equal(tools[0].totalLines, 3)
  assert.equal(tools[0].output, 'aaaa\nbbbb\n')
  assert.equal(tools[1].summary, 'b.ts')
  assert.equal(tools[1].repeats, undefined)
  assert.equal(tools[2].summary, 'a.ts')
  assert.equal(tools[2].repeats, undefined)
  assert.equal(tools[3].summary, 'c.ts')
  assert.equal(tools[3].repeats, 2)
  assert.equal(tools[3].diff?.length, 2)
  assert.equal(tools[4].summary, 'd.ts')

  const previous = { kind: 'tool', name: 'read', args: JSON.stringify({ path: 'a.ts' }), summary: 'a.ts' }
  assert.equal(canMergeToolCall(previous, { name: 'read', args: JSON.stringify({ path: 'a.ts' }) }), true)
  assert.equal(canMergeToolCall(previous, { name: 'read', args: JSON.stringify({ file_path: 'a.ts' }) }), true)
  assert.equal(canMergeToolCall(previous, { name: 'read', args: JSON.stringify({ path: 'b.ts' }) }), false)
  assert.equal(countOutputLines('a\nb\n'), 2)
})

test('same-path reads keep one card after merge even when results reuse older call ids', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const session = agent.session
  const call = (id, path) => {
    tui.handleSessionEvent(session, {
      type: 'tool/call',
      data: { callId: id, name: 'read', arguments: JSON.stringify({ file_path: path }) },
    })
  }
  const result = (id, body) => {
    tui.handleSessionEvent(session, {
      type: 'tool/result',
      data: {
        message: { source: { callId: id }, content: [{ type: 'text', text: body }] },
      },
    })
  }

  call('r1', 'src/tui.ts')
  call('r2', 'src/tui.ts')
  result('r1', 'first-pass\n')
  result('r2', 'second-pass\n')
  const tools = tui.rows.filter(row => row.kind === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].summary, 'src/tui.ts')
  assert.equal(tools[0].title, '读取')
  assert.equal(tools[0].repeats, 2)
  assert.deepEqual(tools[0].mergedCallIds, ['r1', 'r2'])
  assert.equal(tools[0].output, 'second-pass\n')
  const untitled = tui.rows.filter(row => row.kind === 'tool' && (row.title === '' || row.summary === ''))
  assert.equal(untitled.length, 0)
  const frame = tui.captureFrame(88, 20).join('\n')
  assert.ok(frame.includes('读取'))
  assert.ok(frame.includes('src/tui.ts'))
  assert.ok(frame.includes('×2'))
})

test('/approval status reports the live mode instead of toggling it', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const lastSystem = () => {
    const row = tui.rows.findLast(item => item.kind === 'system')
    return String(row?.text ?? '')
  }
  tui.runCommand('/approval status')
  assert.ok(lastSystem().includes('自动审批关闭'))
  tui.runCommand('/approval auto')
  assert.ok(lastSystem().includes('自动审批已开启'))
  tui.runCommand('/approval status')
  assert.ok(lastSystem().includes('自动审批开启'))
  assert.ok(lastSystem().includes('AI 复核 0 次'))
  tui.runCommand('/approval STATUS')
  assert.ok(lastSystem().includes('自动审批开启'))
  tui.runCommand('/approval on')
  assert.ok(lastSystem().includes('自动审批已开启'))
  tui.runCommand('/approval off')
  assert.ok(lastSystem().includes('自动审批已关闭'))
  tui.runCommand('/approval status')
  assert.ok(lastSystem().includes('自动审批关闭'))
})

test('/submodel reset follows the parent provider again', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    provider: 'deepseek-official',
    subagentSelection: { current: { provider: 'xai', model: 'grok-4.6' } },
  })
  tui.runCommand('/submodel reset')
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(tui.subagentSelection.current.provider, undefined)
  assert.equal(tui.subagentSelection.current.model, 'deepseek-v4-flash')
  assert.ok(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('跟随提供商')))
  assert.ok(tui.rows.some(row => row.kind === 'error' && String(row.text).includes('仅当前会话')))
})

test('parseEffortArg accepts default aliases and rejects junk', () => {
  assert.deepEqual(parseEffortArg('default'), { kind: 'default' })
  assert.deepEqual(parseEffortArg('默认'), { kind: 'default' })
  assert.deepEqual(parseEffortArg('xhigh'), { kind: 'id', id: 'xhigh' })
  assert.equal(parseEffortArg('not an effort'), undefined)
  assert.equal(parseEffortArg(''), undefined)
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
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
  assert.deepEqual(cancelled, [])
  assert.equal(agent.status, 'running')
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(hangups, ['hung'])
  assert.deepEqual(exits, [])
})

test('idle hangup with continue still exits instead of keeping the host', async () => {
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
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel(reason) { cancelled.push(reason) },
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    disconnectPolicy: 'continue',
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
  assert.deepEqual(cancelled, [])
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(hangups, [])
  assert.deepEqual(exits, [129])
  assert.equal(tui.disposed, true)
})

test('pause hangup of a running turn still keeps the host after cancel settles', async () => {
  const cancelled = []
  const hangups = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { flush: async () => {} }
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
    disconnectPolicy: 'pause',
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
  assert.deepEqual(cancelled, [{ kind: 'user' }])
  assert.equal(agent.status, 'idle')
  assert.deepEqual(hangups, ['hung'], 'busy-at-drop still keeps Host after pause cancel')
  assert.deepEqual(exits, [])
  assert.equal(tui.disposed, false)
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
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
  assert.deepEqual(flushed, ['main-session'])
  assert.deepEqual(hangups, ['hung'])
  assert.deepEqual(exits, [])
  assert.equal(tui.disposed, false)
})

test('headless idle hangup exits instead of orphaning the host', async () => {
  const hangups = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { flush: async () => {} }
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
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    headlessDisplay: true,
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
  assert.deepEqual(hangups, [])
  assert.deepEqual(exits, [129])
  assert.equal(tui.disposed, true)
})

test('reattach after detached completion does not idle-exit the host', async () => {
  const hangups = []
  const reattaches = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { flush: async () => {} }
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
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    headlessDisplay: true,
    disconnectPolicy: 'continue',
    onHangup: () => { hangups.push('hung') },
    onReattach: () => { reattaches.push('up') },
  })
  const sent = []
  const display = fakeDisplayHost()
  display.attached = true
  display.sendStdout = (chunk) => { sent.push(chunk); return true }
  tui.displayHost = display
  await tui.handleHangup()
  assert.deepEqual(hangups, ['hung'], 'busy drop keeps the host')
  assert.deepEqual(exits, [])
  assert.equal(tui.disposed, false)

  // The agent finishes while nobody is attached; the Host is now idle.
  agent.status = 'idle'

  // A reconnect HELLOs: DisplayHost kicks the leftover socket and reports the
  // replacement. That must not run the idle hangup path.
  tui.relayColumns = 80
  tui.relayRows = 24
  tui.handleDisplayDetach({ replaced: true })
  assert.deepEqual(exits, [], 'replacing a leftover Display must not exit the idle host')
  assert.equal(tui.disposed, false)

  const originalWrite = process.stdout.write
  process.stdout.write = () => true
  try {
    tui.attachRelayDisplay()
  } finally {
    process.stdout.write = originalWrite
  }
  assert.equal(tui.displayDetached, false)
  assert.deepEqual(reattaches, ['up'], 'reattach callback must run so the lock returns to attached')
  assert.deepEqual(exits, [])
  assert.equal(tui.disposed, false)
  assert.ok(sent.some(chunk => chunk.includes('\x1b[?1000h')), 'reattach must repaint into the new relay')
})

test('headless hangup during a running turn keeps the host', async () => {
  const hangups = []
  const exits = []
  const ctx = {
    get(name) {
      if (name === 'sessions') return { flush: async () => {} }
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
    headlessDisplay: true,
    onHangup: () => { hangups.push('hung') },
  })
  tui.displayHost = fakeDisplayHost()
  await tui.handleHangup()
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
    parentModel: 'grok-4.6', subModel: 'grok-4.5',
    quotaCode: 'SuperGrok', quotaPercent: 82, foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.equal(activity.text, '子代理 2')
  const identity = footerIdentityParts({
    running: true, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 2, tools: 3, planLeftOpen: false, planPending: false, planActive: true,
    idleMs: 0, model: 'grok-4.6', effort: 'xhigh', preset: '标准模式', provider: 'xai',
    parentModel: 'grok-4.6', subModel: 'grok-4.5',
    quotaCode: 'SuperGrok', quotaPercent: 82,
    contextChip: `${formatContextPressureRing(80)} 400K/500K 80%`,
    foldedInput: false, multiLineInput: false, queued: 1,
    cwdLabel: '目录:srv',
  })
  assert.deepEqual(identity, ['[标准模式]', '目录:srv', 'grok-4.6 xhigh', `SuperGrok ${formatQuotaBar(82)} 82%`, `${formatContextPressureRing(80)} 400K/500K 80%`, 'sub:grok-4.5', '排队 1'])
  // A row too narrow for everything drops the subagent route before the live
  // quota/context chips: fit exactly up to the context chip and neither
  // operational signal may disappear.
  const contextPart = `${formatContextPressureRing(80)} 400K/500K 80%`
  const uptoContext = identity.slice(0, identity.indexOf(contextPart) + 1)
  const narrow = fitFooterStatusLine('空闲', identity, displayWidth(`空闲  ${uptoContext.join(' · ')}`))
  assert.equal(narrow.includes('sub:'), false, narrow)
  assert.equal(narrow.includes('82%'), true, narrow)
  assert.equal(narrow.includes('400K/500K'), true, narrow)
  const withBalance = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'deepseek-v4-flash', provider: 'deepseek-official',
    parentModel: 'deepseek-v4-flash', subModel: 'deepseek-v4-flash', subEffort: 'max',
    balanceText: '余额 86.42 CNY', foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.ok(withBalance.includes('余额 86.42 CNY'))
  // The subagent route keeps its effort suffix and never disappears just
  // because the child model matches the parent model.
  assert.equal(withBalance.includes('sub:deepseek-v4-flash(max)'), true, withBalance.join(' · '))
  const line = fitFooterStatusLine('子代理 2', identity, 28)
  assert.match(line, /^子代理 2/)
  assert.equal(line.includes('排队'), false)
  assert.ok(displayWidth(line) <= 28)
})

test('footer keeps the subagent route visible when it repeats the parent model', () => {
  // Before 0.3.6 the identity row always carried `sub:<model>`; hiding it
  // whenever the child model equaled the parent model made the subagent route
  // look like it had disappeared.
  const equal = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'deepseek-v4-flash', effort: 'max', provider: 'deepseek-official',
    parentModel: 'deepseek-v4-flash', subModel: 'deepseek-v4-flash',
    foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.equal(equal.includes('sub:deepseek-v4-flash'), true, equal.join(' · '))
  const explicit = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'deepseek-v4-flash', provider: 'deepseek-official',
    parentModel: 'deepseek-v4-flash', subModel: 'grok-4.5', subProvider: 'xai', subEffort: 'xhigh',
    foldedInput: false, multiLineInput: false, queued: 0,
  })
  assert.equal(explicit.includes('sub:xai/grok-4.5(xhigh)'), true, explicit.join(' · '))
  // An inherited provider stays implicit; only `/submodel` routes are prefixed.
  assert.equal(subagentRouteLabel('grok-4.5'), 'sub:grok-4.5')
  assert.equal(subagentRouteLabel('grok-4.5', 'xai'), 'sub:xai/grok-4.5')
  assert.equal(subagentRouteLabel('grok-4.5', 'xai', 'xhigh'), 'sub:xai/grok-4.5(xhigh)')
  assert.equal(subagentRouteLabel('grok-4.5', undefined, 'high'), 'sub:grok-4.5(high)')
  assert.equal(subagentRouteLabel('grok-4.5', 'xai', '  '), 'sub:xai/grok-4.5')
  assert.equal(subagentRouteLabel(''), '')
})

test('narrow footer drops the quota plan name before the remaining bar', () => {
  const identity = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'grok-4.6', effort: 'xhigh', preset: '标准模式', provider: 'xai',
    parentModel: 'grok-4.6', subModel: 'grok-4.5',
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

test('context pressure ring is one cell and fills clockwise', () => {
  assert.equal(formatContextPressureRing(0), CONTEXT_RING_EMPTY)
  assert.equal(formatContextPressureRing(1), '⠉')
  assert.equal(formatContextPressureRing(12.5), '⠉')
  assert.equal(formatContextPressureRing(25), '⠋')
  assert.equal(formatContextPressureRing(37.5), '⠛')
  assert.equal(formatContextPressureRing(50), '⠞')
  assert.equal(formatContextPressureRing(62.5), '⠟')
  assert.equal(formatContextPressureRing(75), '⠿')
  assert.equal(formatContextPressureRing(87.5), '⡿')
  assert.equal(formatContextPressureRing(100), '⣿')
  assert.equal(displayWidth(formatContextPressureRing(80)), 1)
  const view = contextPressureView({ usedTokens: 400_000, contextWindow: 500_000 })
  assert.equal(view.level, 'warn')
  assert.equal(formatContextPressureChip(view), `${formatContextPressureRing(80)} 400K/500K 80%`)
  const identity = footerIdentityParts({
    running: false, planReview: false, waitingQuestion: false, compacting: false,
    subagents: 0, tools: 0, planLeftOpen: false, planPending: false, planActive: false,
    idleMs: 0, model: 'grok-4.6', provider: 'xai',
    parentModel: 'grok-4.6', subModel: 'grok-4.6',
    quotaCode: 'SuperGrok', quotaPercent: 82,
    contextChip: formatContextPressureChip(view),
    foldedInput: false, multiLineInput: false, queued: 0,
  })
  const quotaAt = identity.indexOf(formatFooterQuota(82, 'SuperGrok'))
  const contextAt = identity.indexOf(formatContextPressureChip(view))
  assert.ok(quotaAt >= 0)
  assert.ok(contextAt === quotaAt + 1)
  const fitted = fitFooterStatusLine('空闲', identity, 80)
  assert.ok(fitted.includes(formatContextPressureRing(80)))
  assert.ok(displayWidth(fitted) <= 80)
})

test('context pressure uses DSH projectedTokens and a provider-agnostic window', () => {
  assert.deepEqual(parseContextPressure({
    projectedTokens: 360_000, pressureTokens: 300_000, contextWindow: 500_000,
  }), { usedTokens: 360_000, contextWindow: 500_000 })
  assert.equal(parseContextPressure({ pressureTokens: 10, contextWindow: 0 }), undefined)
  const warn = contextPressureView({ usedTokens: 400_000, contextWindow: 500_000 })
  const danger = contextPressureView({ usedTokens: 480_000, contextWindow: 500_000 })
  const ok = contextPressureView({ usedTokens: 200_000, contextWindow: 1_000_000 })
  assert.equal(warn.level, 'warn')
  assert.equal(danger.level, 'danger')
  assert.equal(ok.level, 'ok')
  assert.equal(shouldIdleAutoCompact(warn), true)
  assert.equal(shouldIdleAutoCompact(ok), 200_000 / 1_000_000 >= CONTEXT_IDLE_COMPACT_RATIO)
  assert.match(formatContextPressureStatusLine(warn), /context: 400K\/500K 80.0%/)
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

test('composePaintOutput disables auto-wrap around the row batch', () => {
  const painted = composePaintOutput({
    width: 8,
    height: 2,
    paintRows: ['hello', 'world'],
    previousRows: [],
    sizeChanged: false,
    chromeChanged: true,
    chromeStart: 0,
    cursorRow: 2,
    cursorColumn: 2,
  })
  const off = painted.indexOf('\x1b[?7l')
  const on = painted.indexOf('\x1b[?7h')
  assert.ok(off >= 0 && on > off, 'row batch must be guarded')
  assert.ok(painted.indexOf('hello') > off && painted.indexOf('hello') < on)
  assert.ok(painted.indexOf('world') > off && painted.indexOf('world') < on)
  // Nothing painted and the cursor stays hidden: no mode churn at all.
  const idle = composePaintOutput({
    width: 8,
    height: 2,
    paintRows: ['hello', 'world'],
    previousRows: ['hello', 'world'],
    sizeChanged: false,
    chromeChanged: false,
    chromeStart: 2,
    cursorRow: 1,
    cursorColumn: 1,
    hideCursor: true,
  })
  assert.equal(idle, '')
})

test('painted frames never exceed the terminal width with npm-test emoji', () => {
  // Independent terminal truth: a terminal with an emoji font draws ✔ / ✖
  // two cells wide. Reusing displayWidth here would hide the very mismatch
  // this test exists to catch.
  const emojiWide = new Set([0x2714, 0x2716, 0x2705, 0x274c, 0x26a0, 0x2b50])
  const terminalWidth = (line) => {
    let used = 0
    for (const char of line.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '')) {
      used += emojiWide.has(char.codePointAt(0)) ? 2 : displayWidth(char)
    }
    return used
  }
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.rows.push({
    kind: 'tool',
    callId: 'c1',
    name: 'bash',
    args: '{"command":"npm test"}',
    status: 'ok',
    output: [
      '> dsh-ssh-tui@0.5.6 test',
      '✔ classifyCommand auto-allows low-risk reads, builds, and tests',
      '✖ a failing test that keeps the cross mark on the row',
      '✔ test with a trailing check ✔',
    ].join('\n'),
    title: 'bash',
    summary: 'npm test',
    command: 'npm test',
    expanded: true,
  })
  const width = 40
  const frame = tui.captureFrame(width, 18)
  const wide = frame.filter(line => terminalWidth(line) > width)
  assert.deepEqual(wide, [], 'every painted row must fit the terminal width')
  assert.ok(frame.some(line => line.includes('✔')), 'the emoji body is actually painted')
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

test('cursorVisualPosition wraps a full-width row instead of overlaying the last glyph', () => {
  const width = 8
  const filled = 'abcdefgh'
  assert.equal(displayWidth(filled), width)
  const atEnd = cursorVisualPosition(filled, filled.length, width)
  assert.equal(atEnd.row, 1)
  assert.equal(atEnd.col, 0)
  const mid = cursorVisualPosition(filled, 3, width)
  assert.equal(mid.row, 0)
  assert.equal(mid.col, 3)
  const wrapped = cursorVisualPosition(`${filled}x`, `${filled}x`.length, width)
  assert.equal(wrapped.row, 1)
  assert.equal(wrapped.col, 1)
})

test('input caret at the right edge does not sit on the last glyph', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const width = 20
  tui.input = 'abcdefghijklmnopqr' // 18 ASCII + 2-col prompt = 20
  tui.cursor = tui.input.length
  tui.inputFolded = false
  const frame = tui.captureFrame(width, 16)
  const inputIndex = frame.findIndex(line => line.startsWith('> '))
  assert.ok(inputIndex >= 0)
  const inputLine = frame[inputIndex]
  assert.equal(displayWidth(inputLine), width)
  assert.equal(tui.lastPaintedCursorColumn() <= width, true)
  const next = frame[inputIndex + 1] ?? ''
  // Either an empty wrap row (caret at col 1 of the next input row) or the
  // caret stayed on this row in a cell after the last glyph.
  const col = tui.lastPaintedCursorColumn()
  const row = tui.lastPaintedCursorRow()
  assert.equal(row === inputIndex + 1 || row === inputIndex + 2, true)
  if (row === inputIndex + 1) {
    assert.ok(col < width, `caret col ${col} must not overlay the last glyph of a full row`)
  }
  if (row === inputIndex + 2) {
    assert.equal(col, 1)
    assert.equal(next.trim(), '')
  }
})

test('folded input keeps a blank cell for the caret at the right edge', () => {
  const line = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const view = foldInputView(line, line.length, 16)
  assert.equal(view.folded, true)
  assert.ok(view.cursorOffset < 16)
  assert.ok(displayWidth(view.text) < 16)
})

test('isEscapePrefix keeps multi-digit CSI / paste / SGR prefixes buffered', () => {
  assert.equal(isEscapePrefix('\x1b'), true)
  assert.equal(isEscapePrefix('\x1b[20'), true)
  assert.equal(isEscapePrefix('\x1b[200'), true)
  assert.equal(isEscapePrefix('\x1b[201'), true)
  assert.equal(isEscapePrefix('\x1b[<0;5;1'), true)
  assert.equal(isEscapePrefix('\x1b[1~'), true)
  assert.equal(isEscapePrefix('\x1b[99;6'), true)
  assert.equal(isEscapePrefix('\x1b[99;6u'), true)
  assert.equal(isEscapePrefix('a'), false)
})

test('fmtElapsedCompact matches Codex compact elapsed', () => {
  assert.equal(fmtElapsedCompact(0), '0s')
  assert.equal(fmtElapsedCompact(59), '59s')
  assert.equal(fmtElapsedCompact(61), '1m 01s')
  assert.equal(fmtElapsedCompact(3661), '1h 01m 01s')
})

test('waitCardCopy keeps the full tool detail and never echoes the prompt', () => {
  assert.equal(waitCardCopy({}).header, '处理中')
  assert.equal(waitCardCopy({ prompt: '  fix the footer  ' }).header, '处理中')
  assert.equal(waitCardCopy({ prompt: '  fix the footer  ' }).detail, undefined)
  assert.equal(waitCardCopy({
    toolTitle: '读取',
    toolSummary: 'src/tui.ts',
    prompt: 'ignored once a tool is live',
  }).detail, '读取  src/tui.ts')
  const longSummary = 'a'.repeat(120)
  assert.equal(waitCardCopy({ toolTitle: '读取', toolSummary: longSummary }).detail, `读取  ${longSummary}`)
  assert.equal(waitCardCopy({
    reasoning: '**Inspecting paint** then a long explanation of leftover glyphs.',
    prompt: 'please fix leftover paint',
  }).header, 'Inspecting paint')
})

test('writeBootSplash paints banner and status on the first frame', () => {
  const writes = []
  const originalWrite = process.stdout.write
  process.stdout.write = (chunk) => { writes.push(String(chunk)); return true }
  try {
    writeBootSplash('正在启动会话…', false)
  } finally {
    process.stdout.write = originalWrite
  }
  const out = writes.join('')
  assert.match(out, /DeepSeek Harness/)
  assert.match(out, /正在启动会话/)
  assert.match(out, /\x1b\[H/)
})

// A synchronous walk of a long log froze the TUI on the pre-replay frame: the
// relay's RTT frame could not be applied, so the footer sat on `SSH ○○○○` for
// the whole history load. The replay yields, so frames land while it runs.
test('replayHistory yields to the event loop while it loads history', async () => {
  const order = []
  const total = 500
  const session = {
    id: 'main-session',
    seq: total,
    eventAt: (seq) => {
      if (seq === 300) order.push('replay-300')
      return { type: 'user/message', data: { content: [{ type: 'text', text: `m${seq}` }], source: { kind: 'user' } } }
    },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session, cancel() {} }
  const ctx = { get: () => undefined, on() { return () => {} } }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  setImmediate(() => { order.push('rtt-frame') })
  await tui.replayHistory()
  assert.equal(order.includes('rtt-frame'), true)
  assert.ok(
    order.indexOf('rtt-frame') < order.indexOf('replay-300'),
    `relay frames must land during the replay, got order ${order.join(',')}`,
  )
  assert.equal(tui.rows.filter(row => row.kind === 'user').length, total)
  assert.equal(tui.replaying, false)
})

test('replayHistory skips assistant chunks and still paints the assembled reply', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const events = [
    { type: 'user/message', data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'skip-me' } } },
    { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk: { type: 'reasoning-delta', text: 'think' } } },
    {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'hello' },
          ],
        },
      },
    },
  ]
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: {
      id: 'main-session',
      seq: events.length,
      eventAt: (seq) => events[seq],
    },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  await tui.replayHistory()
  const kinds = tui.rows.map(row => row.kind)
  assert.equal(kinds.includes('user'), true)
  assert.equal(kinds.includes('assistant'), true)
  assert.equal(kinds.includes('reasoning'), true)
  assert.equal(tui.streaming, undefined)
  assert.equal(tui.rows.some(row => row.kind === 'assistant' && row.text.includes('hello')), true)
  assert.equal(tui.rows.some(row => row.kind === 'assistant' && row.text.includes('skip-me')), false)
})

test('listPersistenceHeaders unwraps 0.1.5 snapshots and inspectPersistenceSession uses open+read', async () => {
  const headers = await listPersistenceHeaders({
    list: async () => [
      { header: { id: 'a', createdAt: 1, cwd: '/tmp' }, revision: 'r1', sizeBytes: 12 },
      { id: 'b', createdAt: 2, cwd: '/tmp' },
    ],
  })
  assert.deepEqual(headers.map(item => item.id), ['a', 'b'])
  let closed = false
  const inspection = await inspectPersistenceSession({
    open: async (id, access) => {
      assert.equal(id, 'sess')
      assert.equal(access, 'read')
      return {
        header: { id: 'sess', createdAt: 9, cwd: '/tmp' },
        read: async () => ({ events: [{ type: 'user/message' }] }),
        close: async () => { closed = true },
      }
    },
  }, 'sess')
  assert.equal(closed, true)
  assert.equal(inspection.header?.id, 'sess')
  assert.equal(inspection.events[0].type, 'user/message')
})

test('streamChunkOf reads assistant/chunk events and live stream frames', () => {
  const fromEvent = streamChunkOf({
    type: 'assistant/chunk',
    time: 10,
    data: { turn: 1, step: 2, chunk: { type: 'text-delta', text: 'hi' } },
  })
  assert.equal(fromEvent?.chunk.text, 'hi')
  assert.equal(fromEvent?.turn, 1)
  const fromFrame = streamChunkOf({
    type: 'chunk',
    time: 11,
    turn: 3,
    step: 1,
    chunk: { type: 'reasoning-delta', text: 'think' },
  })
  assert.equal(fromFrame?.chunk.type, 'reasoning-delta')
  assert.equal(fromFrame?.turn, 3)
  assert.equal(commandAcceptsAttachments({ images: true }), true)
  assert.equal(commandAcceptsAttachments({ attachments: true }), true)
  assert.equal(commandAcceptsAttachments({ hint: 'x' }), false)
})

test('live assistant-stream frames paint tokens that 0.1.5 no longer logs', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleAssistantStream({
    agent,
    frame: {
      type: 'chunk',
      time: Date.now(),
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', text: 'streamed-live' },
    },
  })
  assert.equal(tui.streaming?.text.includes('streamed-live'), true)
})

test('streamChunkOf takes the live attempt step from its owner', () => {
  // Real 0.1.5 chunk frames carry no turn/step: without the fallback every
  // chunk lands on step 0, so TTFT/decode never match the open step and the
  // footer silently loses tok/s (and usage de-duplication keys collide).
  const frame = {
    type: 'chunk',
    attemptId: 'a1',
    revision: 1,
    index: 0,
    time: 1_200,
    chunk: { type: 'text-delta', index: 0, text: 'ok' },
  }
  assert.equal(streamChunkOf(frame)?.turn, 0)
  assert.equal(streamChunkOf(frame)?.step, 0)
  const owner = streamFrameOwner({ type: 'start', attemptId: 'a1', revision: 1, turn: 4, step: 2 })
  assert.deepEqual(owner, { attemptId: 'a1', turn: 4, step: 2 })
  const streamed = streamChunkOf(frame, owner)
  assert.equal(streamed?.turn, 4)
  assert.equal(streamed?.step, 2)
  assert.equal(streamed?.time, 1_200)
  // Durable assistant/chunk events keep their own turn/step, owner or not.
  const durable = streamChunkOf({ type: 'assistant/chunk', time: 5, data: { turn: 9, step: 3, chunk: { type: 'text-delta', text: 'x' } } }, owner)
  assert.equal(durable?.turn, 9)
  assert.equal(durable?.step, 3)
  assert.equal(streamFrameOwner({ type: 'chunk', attemptId: 'a1' }), undefined)
  assert.equal(streamFrameAttemptId({ type: 'chunk', attemptId: 'a1' }), 'a1')
  assert.equal(streamFrameAttemptId({ type: 'end', attemptId: 'a1' }), 'a1')
  assert.equal(streamFrameAttemptId({ type: 'start', attemptId: 'a1' }), undefined)
})

test('isTokenDeltaChunk matches the host notion of a first token', () => {
  assert.equal(isTokenDeltaChunk({ type: 'text-delta', text: 'x' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'reasoning-delta', text: 'x' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'tool-call-delta', argumentsDelta: '{' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'tool-call-delta', name: 'read' }), true)
  assert.equal(isTokenDeltaChunk({ type: 'text-delta', text: '' }), false)
  assert.equal(isTokenDeltaChunk({ type: 'tool-call-delta', argumentsDelta: '' }), false)
  assert.equal(isTokenDeltaChunk({ type: 'usage' }), false)
  assert.equal(isTokenDeltaChunk({ type: 'block-start', blockType: 'text' }), false)
  assert.equal(isTokenDeltaChunk(undefined), false)
})

test('streamFirstTokenTime reads 0.1.5 packed durable streams', () => {
  const stream = [
    { type: 'chunk', time: 1_000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
    { type: 'reasoning-chunks', time0: 1_100, index: 0, dt: [10, 10], texts: ['', 'think', 'ing'] },
    { type: 'chunk', time: 1_250, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } } },
    { type: 'text-chunks', time0: 1_300, index: 1, dt: [5], texts: ['ok'] },
  ]
  // First non-empty reasoning fragment: time0 + dt[0].
  assert.equal(streamFirstTokenTime(stream), 1_110)
  // A name-bearing tool-call run starts at its first member.
  assert.equal(streamFirstTokenTime([
    { type: 'tool-call-chunks', time0: 900, index: 0, dt: [], id: 'c1', name: 'read', args: [] },
  ]), 900)
  assert.equal(streamFirstTokenTime([{ type: 'text-chunks', time0: 5, index: 0, dt: [], texts: [''] }]), undefined)
  assert.equal(streamFirstTokenTime(undefined), undefined)
})

test('live chunks stay on the open step so the footer keeps tok/s', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const session = agent.session
  tui.handleSessionEvent(session, { type: 'step/start', time: 1_000, data: { turn: 1, step: 1 } })
  // Exactly what a 0.1.5 host emits: `start` owns the step, chunks carry none.
  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1_050, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' } },
  })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 1, time: 1_100, chunk: { type: 'text-delta', index: 1, text: 'ok' } },
  })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 2, time: 1_150, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 40 } } },
  })
  tui.handleSessionEvent(session, {
    type: 'assistant/message',
    time: 1_600,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: 10, outputTokens: 40 },
    },
  })
  const stats = tui.statsText()
  // The reasoning delta opens the clock at 1050: 40 tokens over 550 ms.
  assert.match(stats, /73 tok\/s/, stats)
  assert.equal(tui.stats.decodeTokens, 40)
  // The live usage chunk and the durable settlement share the step key, so the
  // totals are not counted twice.
  assert.equal(tui.stats.usage.outputTokens, 40)
  assert.equal(tui.stats.usage.inputTokens, 10)
})

test('resumed sessions rebuild tok/s from replayed chunks and packed streams', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const session = agent.session
  tui.replaying = true
  try {
    // 0.1.2 log: durable chunks carry the first token time.
    tui.handleSessionEvent(session, { type: 'step/start', time: 2_000, data: { turn: 1, step: 1 } })
    tui.handleSessionEvent(session, {
      type: 'assistant/chunk',
      time: 2_100,
      data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'hi' } },
    })
    tui.handleSessionEvent(session, {
      type: 'assistant/message',
      time: 2_600,
      data: {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'hi' }] },
        usage: { inputTokens: 5, outputTokens: 30 },
      },
    })
    assert.match(tui.statsText(), /60 tok\/s/, tui.statsText())
    // 0.1.5 log: no durable chunks, the packed settlement stream is the record.
    tui.handleSessionEvent(session, { type: 'step/start', time: 3_000, data: { turn: 1, step: 2 } })
    tui.handleSessionEvent(session, {
      type: 'assistant/message',
      time: 3_500,
      data: {
        turn: 1, step: 2,
        message: { content: [{ type: 'text', text: 'ok' }] },
        usage: { inputTokens: 6, outputTokens: 25 },
        stream: [
          { type: 'chunk', time: 3_100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'text-chunks', time0: 3_200, index: 0, dt: [0], texts: ['ok'] },
        ],
      },
    })
    // Cumulative: 30/0.5s + 25/0.3s tokens over 0.8s.
    assert.match(tui.statsText(), /69 tok\/s/, tui.statsText())
    assert.equal(tui.stats.decodeTokens, 55)
    assert.equal(tui.stats.ttftSteps, 2)
  } finally {
    tui.replaying = false
  }
})

test('forEachSessionEvent walks eventAt without snapshotting', () => {
  const seen = []
  const session = {
    seq: 3,
    eventAt: (seq) => ({ type: `e${seq}` }),
    snapshotEvents() { throw new Error('should not snapshot') },
  }
  forEachSessionEvent(session, event => { seen.push(event.type) })
  assert.deepEqual(seen, ['e0', 'e1', 'e2'])
})

test('waitSummaryFromReasoning only accepts a closed bold or a heading', () => {
  assert.equal(waitSummaryFromReasoning('**Reading files**\nmore'), 'Reading files')
  assert.equal(waitSummaryFromReasoning('# 核对光标\n后面很长'), '核对光标')
  // An unclosed ** means the title has not arrived yet: keep the default header.
  assert.equal(waitSummaryFromReasoning('**正在读取'), undefined)
  assert.equal(waitSummaryFromReasoning('正在读取 *一些* 文件'), undefined)
  // No bold and no heading: no crude truncation fallback.
  assert.equal(waitSummaryFromReasoning('这是一段没有加粗的很长说明文字用来测试截断'), undefined)
  // A closed bold is shown in full instead of being sliced.
  const long = '**这是一段很长的加粗标题不应当被截断掉**'
  assert.equal(waitSummaryFromReasoning(`前言 ${long} 后记`), '这是一段很长的加粗标题不应当被截断掉')
})

test('wrapWaitDetails wraps under the └ prefix and ellipsizes past 3 rows', () => {
  assert.deepEqual(wrapWaitDetails('src/tui.ts', 40), ['  └ src/tui.ts'])
  const wrapped = wrapWaitDetails('one two three four five six seven', 12)
  assert.equal(wrapped[0], '  └ one two')
  assert.ok(wrapped.every(line => line.startsWith('  └ ') || line.startsWith('    ')))
  assert.ok(wrapped.every(line => displayWidth(line) <= 12))
  const long = 'alpha '.repeat(10) + 'omega'
  const capped = wrapWaitDetails(long, 20)
  assert.equal(capped.length, 3)
  assert.ok(capped[2].endsWith('…'))
  assert.ok(displayWidth(capped[2]) <= 20)
  const wide = wrapWaitDetails('这是一条非常长的中文工具摘要需要折行显示', 14)
  assert.equal(wide[0], '  └ 这是一条非')
  assert.ok(wide.every(line => displayWidth(line) <= 14))
  assert.deepEqual(wrapWaitDetails('   ', 20), [])
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
  const waiting = tui.captureFrame(48, 16)
  assert.ok(waiting.some(line => line.includes('处理中')))
  assert.equal(waiting.some(line => line.includes('请修绘制残留')), false)
  assert.ok(waiting.some(line => /Esc/.test(line)))
  tui.streaming = { text: '', reasoning: '**Inspecting paint** leftover glyphs on the title' }
  tui.streamingReasoning = { kind: 'streaming-reasoning', expanded: false }
  const thinking = tui.captureFrame(56, 16)
  assert.ok(thinking.some(line => line.includes('Inspecting paint')))
  assert.ok(thinking.some(line => /Esc/.test(line)))
  // While the reply itself streams, the transcript paints the tokens and the
  // wait card yields instead of duplicating a truncated echo of the reply.
  tui.streaming = { text: '正在流式输出的回复正文', reasoning: '' }
  const streaming = tui.captureFrame(56, 16)
  assert.equal(streaming.some(line => line.includes('处理中')), false)
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

test('renderMarkdownLines contrasts inline bold against a non-bold body', () => {
  const lines = renderMarkdownLines('**跳板机上的风**比文档里写的更干。', 80, true, false)
  assert.equal(lines.length, 1)
  const line = lines[0]
  assert.match(line, /^\x1b\[37m/)
  assert.match(line, /\x1b\[1;97m跳板机上的风\x1b\[0m\x1b\[37m/)
  assert.match(line, /比文档里写的更干。/)
  assert.equal(line.includes('\x1b[1;37m'), false)
})

test('renderMarkdownLines resets italic so it does not leak into following text', () => {
  const lines = renderMarkdownLines('a *slant* b', 80, true, false)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /\x1b\[3;37mslant\x1b\[0m\x1b\[37m b/)
})

test('renderMarkdownLines wraps markdown and bare URLs in OSC 8', () => {
  const md = renderMarkdownLines('see [docs](https://example.com/a) please', 80, false, true)
  assert.equal(md.length, 1)
  assert.ok(md[0].includes('\x1b]8;;https://example.com/a\x1b\\'))
  assert.ok(md[0].includes('docs'))
  assert.equal(md[0].includes('(https://example.com/a)'), false)
  const bare = renderMarkdownLines('go https://example.com/b end', 80, false, true)
  assert.ok(bare[0].includes('\x1b]8;;https://example.com/b\x1b\\'))
  const off = renderMarkdownLines('see [docs](https://example.com/a)', 80, false, false)
  assert.equal(off[0].includes('\x1b]8;;'), false)
  assert.ok(off[0].includes('docs'))
})

test('paintedLinkHits maps OSC 8 spans to display columns', () => {
  const line = `see ${'\x1b]8;;https://ex.test/x\x1b\\'}docs${'\x1b]8;;\x1b\\'}!`
  const hits = paintedLinkHits(line)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].href, 'https://ex.test/x')
  assert.equal(hrefAtColumn(hits, hits[0].startCol), 'https://ex.test/x')
  assert.equal(hrefAtColumn(hits, hits[0].endCol), undefined)
})

test('osc52Clipboard encodes UTF-8 as base64', () => {
  const seq = osc52Clipboard('hi')
  assert.equal(seq, `\x1b]52;c;${Buffer.from('hi', 'utf8').toString('base64')}\x1b\\`)
  assert.equal(osc8Enabled({ DSH_TUI_OSC8: '0', TERM: 'xterm-256color' }), false)
  assert.equal(osc8Enabled({ DSH_TUI_OSC8: '1', TERM: 'dumb' }), true)
  assert.equal(osc8Enabled({ TERM: 'dumb' }), false)
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
  assert.equal(quotaRefreshEveryTurns(snap.windows[0]), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '本周', period: 'weekly', remainingPercent: 48 }), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '5h', period: 'hourly', remainingPercent: 80 }), 10)
  assert.equal(quotaRefreshEveryTurns({ label: '5h', period: 'hourly', remainingPercent: 50 }), 4)
  assert.equal(quotaRefreshEveryTurns({ label: '本月', period: 'monthly', remainingPercent: 90 }), 10)
  assert.equal(quotaRefreshEverySteps(snap.windows[0]), 10)
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
  assert.equal(formatFooterBalance(snap), '余额 86.42 CNY')
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
  assert.equal(formatFooterBalance(grants), '余额 15 USD')
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
  assert.equal(presentToolCall('skill', JSON.stringify({ name: 'release' })).title, '技能')
  assert.equal(presentToolCall('skill', JSON.stringify({ name: 'release' })).summary, 'release')
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
    type: 'tool/result',
    time: 2,
    data: {
      message: { source: { kind: 'tool', callId: 'g1' }, content: [{ type: 'text', text: '{}' }] },
    },
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
  assert.equal(tools.some(row => String(row.callId).startsWith('call-') || String(row.title).startsWith('call-')), false)
  const update = tools.find(row => row.name === 'update_goal')
  assert.equal(update?.title, '更新目标')
  assert.equal(update?.summary, '收口工具卡')
  assert.ok(tui.rows.some(row => row.kind === 'goal' && row.objective === '收口工具卡'))
})

test('orphan tool/result does not title a card with call-<uuid>', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const callId = 'call-346d8e09-43aa-4aa5-a0e5-cd34359ccc9b-428'
  tui.handleSessionEvent(agent.session, {
    type: 'tool/result',
    time: 1,
    data: {
      message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'ok' }] },
    },
  })
  const tools = tui.rows.filter(row => row.kind === 'tool')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'tool')
  assert.equal(tools[0].title, '工具')
  assert.equal(String(tools[0].title).startsWith('call-'), false)
  tui.handleSessionEvent(agent.session, {
    type: 'tool/call',
    time: 2,
    data: { callId, name: 'skill', arguments: JSON.stringify({ name: 'release' }) },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'tool/result',
    time: 3,
    data: {
      message: { source: { kind: 'tool', callId }, content: [{ type: 'text', text: 'loaded' }] },
    },
  })
  const skill = tui.rows.filter(row => row.kind === 'tool' && row.name === 'skill')
  assert.equal(skill.length, 1)
  assert.equal(skill[0].title, '技能')
  assert.equal(skill[0].summary, 'release')
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

test('countDiffAddDel separates additions from deletions', () => {
  // Edit: 2 removed, 3 added.
  assert.deepEqual(
    countDiffAddDel([{ path: 'a.ts', oldText: 'a\nb', newText: 'x\ny\nz' }]),
    { add: 3, del: 2 },
  )
  // New file (oldText null): everything is an addition.
  assert.deepEqual(
    countDiffAddDel([{ path: 'new.ts', oldText: null, newText: 'one\ntwo' }]),
    { add: 2, del: 0 },
  )
  // Pure deletion keeps the del count and drops additions.
  assert.deepEqual(
    countDiffAddDel([{ path: 'a.ts', oldText: 'a\nb\nc', newText: '' }]),
    { add: 0, del: 3 },
  )
  assert.deepEqual(countDiffAddDel(undefined), { add: 0, del: 0 })
})

test('diffStatToken orders deletions first and omits zero parts', () => {
  assert.equal(diffStatToken(24, 13), '-13 +24')
  assert.equal(diffStatToken(24, 0), '+24')
  assert.equal(diffStatToken(0, 13), '-13')
  assert.equal(diffStatToken(0, 0), '')
})

test('mergeProviderEntries dedupes catalog ids and filters the merged list', () => {
  const templates = [
    { key: 'template:official', label: 'DeepSeek 官方', detail: 'api.deepseek.com' },
    { key: 'template:opencode-go', label: 'OpenCode Go', detail: 'opencode.ai/zen/go' },
  ]
  const presets = [
    { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelIds: ['m'] },
    { id: 'opencode-go', name: 'OpenCode Go', baseUrl: 'https://opencode.ai/zen/go/v1', modelIds: ['m'] },
    { id: 'minimax-cn', name: 'MiniMax CN', baseUrl: 'https://api.minimaxi.com/anthropic', modelIds: ['m1'] },
  ]
  const merged = mergeProviderEntries(templates, presets, ['deepseek', 'opencode-go'], '')
  // 模板在前且保留，目录里重复的 deepseek / opencode-go 被合并掉
  assert.deepEqual(merged.map(entry => entry.key), [
    'template:official',
    'template:opencode-go',
    'catalog:minimax-cn',
  ])
  const filtered = mergeProviderEntries(templates, presets, ['deepseek', 'opencode-go'], 'minimax')
  assert.deepEqual(filtered.map(entry => entry.key), ['catalog:minimax-cn'])
  assert.equal(filtered[0]?.catalog?.id, 'minimax-cn')
})

test('filterCatalogPresets matches id or name case-insensitively', () => {
  const presets = [
    { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimax.chat/v1', modelIds: ['m1'] },
    { id: 'minimax-cn', name: 'MiniMax CN', baseUrl: '', modelIds: [] },
    { id: 'moonshotai', name: 'MoonshotAI', baseUrl: '', modelIds: [] },
  ]
  assert.deepEqual(filterCatalogPresets(presets, 'minimax').map(p => p.id), ['minimax', 'minimax-cn'])
  assert.deepEqual(filterCatalogPresets(presets, 'MOON').map(p => p.id), ['moonshotai'])
  // matches on the display name too, with surrounding whitespace ignored
  assert.deepEqual(filterCatalogPresets(presets, ' minimax-cn ').map(p => p.id), ['minimax-cn'])
  assert.deepEqual(filterCatalogPresets(presets, 'MiniMax CN').map(p => p.id), ['minimax-cn'])
  assert.equal(filterCatalogPresets(presets, 'nope').length, 0)
  // empty query keeps the declaration order
  assert.deepEqual(filterCatalogPresets(presets, '  ').map(p => p.id), ['minimax', 'minimax-cn', 'moonshotai'])
})

test('compactEditPath prefers args, then diff path, then summary', () => {
  assert.equal(compactEditPath({
    name: 'edit', args: JSON.stringify({ file_path: 'src/tui.ts' }), summary: 'ignored',
  }), 'src/tui.ts')
  assert.equal(compactEditPath({
    name: 'edit', args: '{}', summary: 'from-summary.ts', diff: [{ path: 'from-diff.ts' }],
  }), 'from-diff.ts')
  assert.equal(compactEditPath({
    name: 'edit', args: '{}', summary: 'from-summary.ts',
  }), 'from-summary.ts')
  assert.equal(compactEditPath({ name: 'edit', args: '{}', summary: '' }), '')
})

test('compactToolBursts keep tools with the preceding assistant reply', () => {
  const bursts = compactToolBursts([
    { kind: 'assistant', text: 'first' },
    { kind: 'tool', callId: 'r1', name: 'read', title: '读取', summary: 'a.ts', args: '{}', output: 'ok', status: 'ok', expanded: false },
    { kind: 'assistant', text: 'second' },
    { kind: 'tool', callId: 'e1', name: 'edit', title: '编辑', summary: 'a.ts', args: '{}', output: '', status: 'ok', expanded: false, diff: [{ path: 'a.ts', oldText: 'a', newText: 'b' }] },
  ])
  assert.equal(bursts.length, 2)
  assert.equal(bursts[0]?.after?.text, 'first')
  assert.equal(bursts[0]?.groups.calls.length, 1)
  assert.equal(bursts[1]?.after?.text, 'second')
  assert.equal(bursts[1]?.groups.edits.length, 1)
})

test('compact view hides thinking and interleaves merged tools after each reply', () => {
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
    { kind: 'assistant', text: 'first reply' },
    { kind: 'tool', callId: 'r1', name: 'read', title: '读取', summary: 'a.ts', args: '{}', output: 'ok', status: 'ok', expanded: false },
    { kind: 'tool', callId: 'g1', name: 'grep', title: '搜索', summary: 'x', args: '{}', output: 'miss', status: 'ok', expanded: false },
    { kind: 'assistant', text: 'second reply' },
    { kind: 'tool', callId: 'e1', name: 'edit', title: '编辑', summary: 'a.ts', args: '{}', output: '', status: 'ok', expanded: false, diff: [{ path: 'a.ts', oldText: 'a', newText: 'b\nc' }] },
  )
  const frame = tui.captureFrame(72, 20)
  const text = frame.join('\n')
  assert.equal(text.includes('SECRET_THOUGHT'), false)
  assert.equal(text.includes('已思考'), false)
  assert.ok(text.includes('first reply'))
  assert.ok(text.includes('second reply'))
  assert.ok(text.includes('已调用 2 个工具'))
  assert.ok(text.includes('已编辑 a.ts'))
  // The merged edit card carries a git-style -deletions +additions stat.
  assert.ok(text.includes('-1 +2'))
  const firstAt = frame.findIndex(line => line.includes('first reply'))
  const toolsAt = frame.findIndex(line => line.includes('已调用'))
  const secondAt = frame.findIndex(line => line.includes('second reply'))
  const editsAt = frame.findIndex(line => line.includes('已编辑'))
  assert.ok(firstAt >= 0 && toolsAt > firstAt && secondAt > toolsAt && editsAt > secondAt)
})

test('compact edit summary expands to the merged diff body', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  tui.setWorkspaceView('compact')
  const edit = {
    kind: 'tool',
    callId: 'e1',
    name: 'edit',
    title: '编辑',
    summary: 'a.ts',
    args: '{}',
    output: '',
    status: 'ok',
    expanded: false,
    diff: [{ path: 'a.ts', oldText: 'old-line', newText: 'new-line' }],
  }
  tui.rows.push(
    { kind: 'assistant', text: 'changed a file' },
    edit,
  )
  tui.focusedRow = edit
  tui.toggleCollapsible()
  assert.equal(edit.expanded, true)
  const text = tui.captureFrame(72, 20).join('\n')
  assert.ok(text.includes('已编辑 a.ts'))
  assert.ok(text.includes('old-line'))
  assert.ok(text.includes('new-line'))
  // The expanded per-file entry shows its own -/+ stat instead of a total.
  assert.ok(text.includes('-1 +1'))
})

test('detailed edit cards stay collapsed and show the -/+ stat in the header', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'xai', model: 'grok-4.6' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, provider: 'xai' })
  const oldText = 'line1\nline2\nline3'
  const newText = 'line1\nchanged\nadded-a\nadded-b'
  tui.rows.push(
    { kind: 'assistant', text: 'reworked the file' },
    { kind: 'tool', callId: 'e1', name: 'edit', title: '编辑', summary: 'src/tui.ts', args: '{}', output: 'ok', status: 'ok', expanded: false, diff: [{ path: 'src/tui.ts', oldText, newText }] },
  )
  const frame = tui.captureFrame(72, 20)
  const text = frame.join('\n')
  // Collapsed by default: the header carries the git stat, no diff body.
  assert.ok(frame.some(line => line.includes('▸ ● 编辑') && line.includes('-3 +4')))
  assert.equal(text.includes('-line2'), false)
  assert.equal(text.includes('+changed'), false)
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
    assert.equal(okFrame.includes('[ok]'), false)
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

test('buildToolHeader colors the status dot; ok omits the duplicate [ok] word', () => {
  const header = buildToolHeader({
    focused: false, expanded: false, title: '读取', summary: 'src/tui.ts', status: 'ok',
  })
  assert.match(header.plain, /● 读取  src\/tui\.ts$/)
  assert.equal(header.plain.includes('[ok]'), false)
  const dot = header.segments.find(segment => header.plain.slice(segment.start, segment.end) === '●')
  const summary = header.segments.find(segment => header.plain.slice(segment.start, segment.end).includes('src/tui.ts'))
  assert.equal(dot?.sgr, '32')
  assert.equal(summary?.sgr, '90')
  const failed = buildToolHeader({
    focused: false, expanded: false, title: '读取', summary: 'src/tui.ts', status: 'error',
  })
  assert.match(failed.plain, /\[error\]/)
  const errorWord = failed.segments.find(segment => failed.plain.slice(segment.start, segment.end).includes('[error]'))
  assert.equal(errorWord?.sgr, '31')
  assert.equal(toolStateColor('running'), '33')
  assert.equal(toolStateColor('error'), '31')
})

test('buildToolHeader paints the diff stat git red/green between summary and state', () => {
  const header = buildToolHeader({
    focused: false, expanded: false, title: '编辑', summary: 'src/tui.ts', status: 'ok',
    diffStat: { add: 24, del: 13 },
  })
  assert.match(header.plain, /● 编辑  src\/tui\.ts  -13 \+24$/)
  const red = header.segments.find(segment => header.plain.slice(segment.start, segment.end) === '-13')
  const green = header.segments.find(segment => header.plain.slice(segment.start, segment.end) === '+24')
  assert.equal(red?.sgr, '31')
  assert.equal(green?.sgr, '32')
  // New file: additions only; pure deletion: the minus part only.
  assert.equal(
    buildToolHeader({ focused: false, expanded: false, title: '编辑', summary: '', status: 'ok', diffStat: { add: 24, del: 0 } }).plain,
    '  ▸ ● 编辑  +24',
  )
  assert.equal(
    buildToolHeader({ focused: false, expanded: false, title: '编辑', summary: '', status: 'ok', diffStat: { add: 0, del: 13 } }).plain,
    '  ▸ ● 编辑  -13',
  )
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

test('turn/end marks leftover todos as display-stale and asks once to close them', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const followups = []
  const agent = {
    id: 'main-session',
    options: {},
    // Live `turn/end` is appended before the driver flips idle. The nudge
    // must wait for that idle so /compact is not blocked by a waking follow-up.
    status: 'running',
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
  assert.equal(followups.length, 0)
  agent.status = 'idle'
  await new Promise(resolve => queueMicrotask(resolve))
  assert.equal(followups.length, 1)
  assert.ok(String(followups[0].content[0].text).includes('todo_write'))
  assert.ok(String(followups[0].content[0].text).includes('pin the dock'))
  assert.equal(followups[0].source.kind, 'plugin')
  assert.equal(followups[0].source.form, 'notice')
  assert.ok(String(followups[0].source.summary).includes('补一次待办'))
  assert.ok(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('补一次待办')))
  assert.equal(tui.rows.some(row => row.kind === 'user' && String(row.text).includes('todo_write')), false)
  assert.equal(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('todo_write')), false)
  const frame = tui.captureFrame(80, 24)
  assert.ok(frame.some(line => line.includes('本轮未收尾')))
  assert.equal(frame.some(line => line.includes('todo_write')), false)
  tui.handleSessionEvent(agent.session, {
    type: 'user/message',
    data: {
      content: followups[0].content,
      source: followups[0].source,
    },
  })
  assert.equal(tui.rows.filter(row => row.kind === 'system' && String(row.text).includes('补一次待办')).length, 1)
  assert.equal(tui.rows.some(row => String(row.text).includes('todo_write') && row.kind !== 'plan'), false)
  tui.handleSessionEvent(agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await new Promise(resolve => queueMicrotask(resolve))
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

test('formatCompactCommandError maps official idle-only compact failures', () => {
  assert.ok(formatCompactCommandError(
    'Compaction is unavailable because this process has an active compaction, or the agent is not idle.',
  ).includes('空闲'))
  assert.equal(formatCompactCommandError('No compactable history yet.'), '还没有可压缩的历史。')
  assert.equal(formatCompactCommandError('Usage: /compact (no arguments)'), '用法：/compact（不接受参数）')
})

test('id-less compaction/prune does not attach to a leftover compact card', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/start',
    time: 1,
    data: { compactionId: 'c-open' },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/end',
    time: 2,
    data: { compactionId: 'c-open' },
  })
  tui.handleSessionEvent(agent.session, {
    type: 'compaction/prune',
    time: 3,
    data: { shadowedTokenCount: 4000 },
  })
  const card = tui.rows.find(row => row.kind === 'compaction')
  assert.equal(card.status, 'ok')
  assert.equal(card.prunedTokens, 0)
})

test('idle auto-compact fires at 72% of the routed window', async () => {
  const executions = []
  const ctx = {
    get: (name) => name === 'commands' ? {
      list: () => [],
      execute: async (_agent, text) => {
        executions.push(text)
        return { commandId: 'cmd-auto-compact', result: { kind: 'success', text: '' } }
      },
    } : name === 'sessionProjections' ? {
      snapshot: () => ({ values: { contextPressure: { projectedTokens: 370_000, contextWindow: 500_000 } } }),
    } : undefined,
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.handleSessionEvent(agent.session, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [] } } })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(executions, ['/compact'])
  assert.ok(tui.rows.some(row => row.kind === 'system' && String(row.text).includes('自动压缩')))
})

test('/compact while the agent is running is refused locally', () => {
  const ctx = {
    get: (name) => name === 'commands' ? {
      list: () => [],
      execute: async () => { throw new Error('must not dispatch compact while running') },
    } : undefined,
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'running', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.runCommand('/compact')
  assert.ok(tui.rows.some(row => row.kind === 'error' && String(row.text).includes('空闲')))
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
  assert.ok(tui.rows.some(row => row.kind === 'error' && String(row.text).includes('空闲')))
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
  assert.ok(lines.some(line => line.startsWith('context: unknown')))
  assert.ok(lines.some(line => line.includes('subagent: deepseek-v4-flash') && line.includes('同族')))
  const withContext = formatStatusReport({
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
    context: contextPressureView({ usedTokens: 360_000, contextWindow: 500_000 }),
  })
  assert.ok(withContext.some(line => line.startsWith('context: 360K/500K')))
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

test('enlarging window beyond standard sizes does not corrupt frame layout', () => {
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
    kind: 'plan',
    active: true,
    pending: false,
    expanded: true,
    todos: [
      { content: 'Task 1 in progress', status: 'in_progress' },
      { content: 'Task 2 pending', status: 'pending' },
    ],
    planMarkdown: '# Big Plan\nDetails here',
  })
  tui.input = 'test input'
  tui.cursor = 10

  // Test across normal, wide, ultra-wide, tall dimensions
  for (const [w, h] of [[80, 24], [120, 30], [160, 50], [200, 60], [240, 80]]) {
    const frame = tui.captureFrame(w, h)
    assert.equal(frame.length, h, `frame height for ${w}x${h} must be exactly ${h}`)
    for (let r = 0; r < frame.length; r++) {
      const vw = visibleWidth(frame[r])
      assert.ok(vw <= w, `row ${r} width ${vw} must be <= ${w}`)
    }
    // Plan card should be present in the docked area, rendered once
    const text = frame.join('\n')
    assert.ok(text.includes('Task 1 in progress'))
    assert.ok(text.includes('test input'))
    // Divider line should be present
    assert.ok(frame.some(line => line.includes('────')))
  }
})

// A retried step opens a second attempt in the SAME turn/step. The live latch
// keeps the failed attempt's first token, which stretched the decode window
// across the retry (a ~20x wrong rate); the settlement's own packed stream is
// authoritative.
test('a retried step reports the settled attempt, not the failed one', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'running',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const session = agent.session
  tui.handleSessionEvent(session, { type: 'step/start', time: 1_000, data: { turn: 1, step: 1 } })
  // Attempt a1 streams a reasoning token, then the provider fails and the host
  // retries the same step.
  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 1_050, chunk: { type: 'reasoning-delta', index: 0, text: 'partial' } },
  })
  tui.handleAssistantStream({ agent, frame: { type: 'end', attemptId: 'a1', revision: 2 } })
  tui.handleAssistantStream({ agent, frame: { type: 'start', attemptId: 'a2', revision: 3, turn: 1, step: 1 } })
  tui.handleAssistantStream({
    agent,
    frame: { type: 'chunk', attemptId: 'a2', revision: 3, index: 0, time: 1_800, chunk: { type: 'text-delta', index: 0, text: 'ok' } },
  })
  tui.handleSessionEvent(session, {
    type: 'assistant/message',
    time: 1_900,
    data: {
      turn: 1,
      step: 1,
      message: { content: [{ type: 'text', text: 'ok' }] },
      usage: { inputTokens: 10, outputTokens: 50 },
      stream: [{ type: 'chunk', time: 1_800, chunk: { type: 'text-delta', index: 0, text: 'ok' } }],
    },
  })
  // a2's window only: 50 tokens over 100 ms, not the 850 ms that spans a1.
  assert.equal(tui.stats.decodeTokens, 50)
  assert.equal(tui.stats.decodeMs, 100)
  assert.match(tui.statsText(), /500 tok\/s/, tui.statsText())
})

// A durable chunk that carries no turn/step must not file usage under a bogus
// 0:0 key: step/end never clears that key, so the totals would stay inflated
// for the rest of the session.
test('replayed usage without turn/step cannot inflate the totals', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.replaying = true
  tui.handleSessionEvent(agent.session, {
    type: 'assistant/chunk',
    time: 1_000,
    data: { chunk: { type: 'usage', usage: { inputTokens: 4_000, outputTokens: 900 } } },
  })
  tui.replaying = false
  assert.deepEqual(tui.stats.usage, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
})

// `streamChunkOf` reports whether turn/step are real; the callers rely on it to
// keep usage out of the bogus 0:0 bucket.
test('streamChunkOf marks an unowned chunk as step-unknown', () => {
  const frame = { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, time: 10, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } }
  assert.equal(streamChunkOf(frame)?.stepKnown, false)
  assert.equal(streamChunkOf(frame, { turn: 2, step: 3 })?.stepKnown, true)
  assert.equal(streamChunkOf(frame, { turn: 2, step: 3 })?.turn, 2)
  const durable = { type: 'assistant/chunk', time: 10, data: { turn: 2, step: 3, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } } }
  assert.equal(streamChunkOf(durable)?.stepKnown, true)
})

// `formatTokensPerSecond` must not round a slow step down to a stalled "0".
test('a slow decode reports <1 tok/s instead of 0', () => {
  assert.equal(formatTokensPerSecond(0.2), '<1 tok/s')
  assert.equal(formatTokensPerSecond(0), '0 tok/s')
  assert.equal(formatTokensPerSecond(Number.NaN), '0 tok/s')
  assert.equal(formatTokensPerSecond(42.4), '42 tok/s')
})

// The mirror of the host's `assistantStreamFirstTokenTime` is only trustworthy
// while it agrees with the host on the records the host itself produces.
test('streamFirstTokenTime agrees with the host implementation', async () => {
  let host
  try {
    host = await import('@deepseek-ai/dsh-llm')
  } catch {
    return
  }
  const reference = host.assistantStreamFirstTokenTime
  if (typeof reference !== 'function') return
  let seed = 0x2f6e2b1
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const pick = (list) => list[Math.floor(random() * list.length)]
  const chunk = () => pick([
    { type: 'block-start', index: 0, blockType: pick(['text', 'reasoning', 'tool-call']) },
    { type: 'text-delta', index: 0, text: pick(['', 'a', 'hello']) },
    { type: 'reasoning-delta', index: 0, text: pick(['', 'think']) },
    { type: 'tool-call-delta', index: 0, id: 'c1', ...(random() < 0.4 ? { name: 'read' } : {}), argumentsDelta: pick(['', '{"a"', ':1}']) },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
  ])
  for (let round = 0; round < 400; round += 1) {
    const records = []
    const time0 = 1_000 + Math.floor(random() * 1_000)
    for (let index = 0; index < 5; index += 1) {
      if (random() < 0.5) {
        records.push({ type: 'chunk', time: time0 + Math.floor(random() * 500), chunk: chunk() })
        continue
      }
      const kind = pick(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
      const fragments = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(['', 'x', 'yy']))
      records.push({
        type: kind,
        time0: time0 + Math.floor(random() * 200),
        index: 0,
        dt: Array.from({ length: fragments.length }, () => 1 + Math.floor(random() * 40)),
        ...(kind === 'tool-call-chunks'
          ? { id: 'c1', args: fragments, ...(random() < 0.3 ? { name: 'read' } : {}) }
          : { texts: fragments }),
      })
    }
    assert.equal(
      streamFirstTokenTime(records),
      reference(records),
      `round ${round}: ${JSON.stringify(records)}`,
    )
  }
})

// A CPR that shares its read with focus events, mouse reports or a keystroke
// used to fail the anchored match, time the probe out, and leave the footer on
// `SSH ○○○○` for the whole session.
test('the RTT probe finds a cursor reply inside noisy TTY input', async () => {
  const { EventEmitter } = await import('node:events')
  const stdin = new EventEmitter()
  stdin.isTTY = true
  const stdout = { isTTY: true, write: () => true }
  const pending = probeTerminalRttMs(stdin, stdout, 1_000)
  stdin.emit('data', Buffer.from('\x1b[I\x1b[O'))          // focus in/out
  stdin.emit('data', Buffer.from('\x1b[<0;10;5M'))          // mouse report
  stdin.emit('data', Buffer.from('k\x1b[12;34R'))           // keystroke + reply
  const rtt = await pending
  assert.equal(typeof rtt, 'number')
  assert.equal(findCursorPositionReply('\x1b[I\x1b[12;34R')?.column, 34)
  assert.equal(findCursorPositionReply('\x1b[12;34R')?.row, 12)
  assert.equal(parseCursorPositionReply('\x1b[12;34R')?.row, 12)
  assert.equal(parseCursorPositionReply('\x1b[I\x1b[12;34R'), undefined)
})

test('the RTT probe still gives up on a silent TTY', async () => {
  const { EventEmitter } = await import('node:events')
  const stdin = new EventEmitter()
  stdin.isTTY = true
  const stdout = { isTTY: true, write: () => true }
  const rtt = await probeTerminalRttMs(stdin, stdout, 60)
  assert.equal(rtt, undefined)
  const notTty = new EventEmitter()
  notTty.isTTY = false
  assert.equal(await probeTerminalRttMs(notTty, stdout, 60), undefined)
})

// The Host used to decide its fate from a snapshot taken when the link died,
// so a reconnect that landed while it was cancelling/flushing got disposed
// under it (the launcher saw `write EPIPE`).
test('a reconnect during the hangup window keeps the Host alive', async () => {
  let releaseFlush
  const flushing = new Promise(resolve => { releaseFlush = resolve })
  const exits = []
  const ctx = {
    get: (key) => key === 'sessions'
      ? { flush: () => flushing }
      : key === 'appExit' ? (code) => { exits.push(code) } : undefined,
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  const host = { attached: false, close: async () => {}, sendStdout: () => true, sendGoodbye: () => {} }
  tui.displayHost = host
  tui.displayDetached = true          // the link already dropped
  const hangup = tui.handleHangup()
  // A relay HELLOs while the hangup is still flushing: this is what
  // DisplayHost.claim() calls on the Host side.
  const originalWrite = process.stdout.write
  process.stdout.write = () => true
  try {
    host.attached = true
    tui.attachRelayDisplay()
  } finally {
    process.stdout.write = originalWrite
  }
  releaseFlush()
  await hangup
  assert.deepEqual(exits, [], 'an attached display must not be exited')
  assert.equal(tui.exited, undefined)
  assert.equal(host.attached, true)
  // And once the display is gone again, an idle hangup still exits as before.
  host.attached = false
  tui.displayDetached = true
  await tui.handleHangup()
  assert.deepEqual(exits, [129])
})
