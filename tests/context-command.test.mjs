/**
 * `/context` inside the real Screen: ownership, paging, copy, close and the
 * width/reattach path.
 *
 * The fixture deliberately gives the Session hostile accessors after boot. The
 * command must render from the one cache read without touching them, and every
 * key it claims must stay away from the composer behind the Screen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { commandSuggestions } from '../lib/commands.js'

setLocale('zh')

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function cacheWith(values, asOfSeq = 9) {
  return { cachedSnapshot: () => ({ asOfSeq, values }) }
}

function values(overrides = {}) {
  return {
    contextPressure: { projectedTokens: 64000, pressureTokens: 62000, contextWindow: 128000 },
    contextBreakdown: { systemTokens: 9000, toolsTokens: 14000, messageTokens: 39000 },
    tokenUsage: { uncachedInputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    modelSelection: { lastUsed: ROUTE, next: ROUTE },
    ...overrides,
  }
}

function fixture(options = {}) {
  const cache = 'cache' in options ? options.cache : cacheWith(values())
  const ctx = {
    get(name) {
      if (name === 'sessionProjectionCache') return cache
      if (name === 'sessionProjections') return { stateOf: () => ({ questions: { active: [], settled: [] } }) }
      if (name === 'commands') return { list: () => [] }
      if (name === 'appExit') return () => {}
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: ROUTE,
    status: 'idle',
    session: { id: 'main-session', seq: 10, header: { id: 'main-session' }, events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    headlessDisplay: true,
    ...(options.lineMode === true ? { lineMode: true } : {}),
  })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent, cache }
}

/** Make the Session's event accessors hostile after boot; the command must not use them. */
function guardSession(session) {
  const hits = { events: 0, snapshotEvents: 0, eventAt: 0, ownEvents: 0 }
  for (const name of Object.keys(hits)) {
    Object.defineProperty(session, name, {
      configurable: true,
      get() { hits[name] += 1; throw new Error(`FORBIDDEN_${name}`) },
    })
  }
  return hits
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const bodyText = tui => (tui.screen?.lines ?? []).map(line => String(line.text)).join('\n')

test('/context opens one Screen from the cache and writes no transcript row', () => {
  const { tui, agent } = fixture()
  const hits = guardSession(agent.session)
  const rowsBefore = tui.rows.length
  tui.input = 'draft stays'
  tui.cursor = tui.input.length
  // Go straight to the Screen path: a slash command submitted through the
  // composer clears the input by its own long-standing contract, so the draft
  // assertion belongs to the Screen open itself, not to command submission.
  tui.runContextCommand()
  assert.equal(tui.screen?.kind, 'report')
  assert.equal(tui.screen?.report, 'context')
  assert.equal(tui.screen?.title, '上下文详情')
  assert.equal(tui.screen?.context?.page, 1)
  assert.match(bodyText(tui), /总览/)
  assert.match(bodyText(tui), /asOfSeq 9 \/ head 10 · STALE/)
  assert.match(bodyText(tui), /~64K \/ 128K/)
  assert.equal(tui.rows.length, rowsBefore, 'a Screen is not a transcript row')
  assert.equal(tui.input, 'draft stays', 'the composer draft survives the visit')
  assert.deepEqual(hits, { events: 0, snapshotEvents: 0, eventAt: 0, ownEvents: 0 })
})

test('1/2/3 switch pages inside the Screen; 3 is DETAIL_UNAVAILABLE only', () => {
  const { tui, agent } = fixture()
  guardSession(agent.session)
  tui.runCommand('/context')
  tui.handleInputText('2')
  assert.equal(tui.screen?.context?.page, 2)
  assert.match(bodyText(tui), /系统提示 ~9K/)
  assert.match(bodyText(tui), /工具定义 ~14K/)
  assert.match(bodyText(tui), /对话 ~39K/)
  assert.doesNotMatch(bodyText(tui), /64K \/ 128K/, 'composition does not repeat occupancy')
  tui.handleInputText('3')
  assert.equal(tui.screen?.context?.page, 3)
  assert.match(bodyText(tui), /DETAIL_UNAVAILABLE/)
  assert.doesNotMatch(bodyText(tui), /系统提示 ~9K/)
  tui.handleInputText('1')
  assert.equal(tui.screen?.context?.page, 1)
  assert.match(bodyText(tui), /总览/)
})

test('Enter expands, Esc collapses and then closes; q closes too', () => {
  const { tui, agent } = fixture()
  guardSession(agent.session)
  tui.runCommand('/context')
  tui.handleInputText('\r')
  assert.equal(tui.screen?.context?.expanded, true)
  assert.match(bodyText(tui), /asOfSeq 是缓存检查点/)
  tui.handleInputText('\x1b')
  assert.equal(tui.screen?.context?.expanded, false)
  assert.notEqual(tui.screen, undefined, 'the first Esc collapsed, it did not leave')
  tui.handleInputText('\x1b')
  assert.equal(tui.screen, undefined)
  tui.runCommand('/context')
  tui.handleInputText('q')
  assert.equal(tui.screen, undefined)
})

test('c copies the sanitized current page; printable keys never reach the composer', () => {
  const { tui, agent } = fixture()
  guardSession(agent.session)
  let copied
  tui.copyPlainText = text => { copied = text }
  tui.runCommand('/context')
  tui.handleInputText('2')
  tui.handleInputText('c')
  assert.equal(typeof copied, 'string')
  assert.match(copied, /系统提示 ~9K/)
  assert.equal(copied.includes('\x1b'), false, 'the copy is plain text')
  tui.handleInputText('x')
  assert.equal(tui.input, '', 'a printable key did not enter the composer')
  assert.equal(tui.screen?.context?.page, 2, 'and the Screen still owns the keyboard')
  tui.handleInputText('q')
  tui.handleInputText('hello')
  assert.equal(tui.input, 'hello', 'closing returns the composer')
})

test('PageDown/PageUp scroll only the Screen body', () => {
  const { tui, agent } = fixture()
  guardSession(agent.session)
  tui.runCommand('/context')
  tui.handleInputText('2')
  tui.handleInputText('\r')
  const previousRows = process.stdout.rows
  process.stdout.rows = 10
  try {
    tui.handleInputText('\x1b[6~')
    assert.ok((tui.screen?.offset ?? 0) > 0, 'PageDown moved the Screen body')
    const scrolled = tui.screen?.offset
    tui.handleInputText('\x1b[5~')
    assert.ok((tui.screen?.offset ?? 0) < (scrolled ?? 0), 'PageUp moved it back')
    assert.notEqual(tui.screen, undefined, 'paging never closes the Screen')
  } finally {
    process.stdout.rows = previousRows
  }
})

test('a cold cache fails closed: UNKNOWN body, no throw, no fallback', () => {
  const { tui, agent } = fixture({ cache: null })
  const hits = guardSession(agent.session)
  tui.runCommand('/context')
  assert.equal(tui.screen?.report, 'context')
  assert.match(bodyText(tui), /投影缓存不可用/)
  assert.match(bodyText(tui), /UNKNOWN/)
  assert.doesNotMatch(bodyText(tui), /~0 \/ 128K/)
  assert.equal(tui.rows.some(row => row.kind === 'error'), false)
  assert.deepEqual(hits, { events: 0, snapshotEvents: 0, eventAt: 0, ownEvents: 0 })
})

test('raw prompt and event text never reach the body or the copy', () => {
  const { tui, agent } = fixture()
  agent.session.events = [{ type: 'user/message', data: { text: 'SECRET-RAW-PROMPT' } }]
  guardSession(agent.session)
  let copied
  tui.copyPlainText = text => { copied = text }
  tui.runCommand('/context')
  tui.handleInputText('c')
  assert.doesNotMatch(bodyText(tui), /SECRET-RAW-PROMPT/)
  assert.doesNotMatch(String(copied), /SECRET-RAW-PROMPT/)
  assert.equal(tui.dialog, undefined)
  assert.equal(tui.dialogQueue.length, 0, 'the report never becomes a Surface')
})

test('80/40/20 repaints rebuild the body from state without a second read', () => {
  let reads = 0
  const cache = { cachedSnapshot: () => { reads += 1; return { asOfSeq: 10, values: values() } } }
  const { tui, agent } = fixture({ cache })
  guardSession(agent.session)
  tui.runCommand('/context')
  assert.equal(reads, 1)
  const narrow = tui.captureFrame(20, 20).map(plain).join('\n')
  const compact = tui.captureFrame(40, 20).map(plain).join('\n')
  const full = tui.captureFrame(80, 20).map(plain).join('\n')
  assert.match(full, /第 1\/3 页 · 总览 · 只读 · 缓存投影/)
  assert.match(compact, /第 1\/3 页 · 总览 · 只读/)
  assert.match(narrow, /上下文 1\/3/)
  assert.doesNotMatch(narrow, /[█░]/, '20 columns draws no bar')
  assert.match(compact, /█/)
  assert.match(compact, /q/, 'the 40-column hint keeps the close key')
  assert.match(narrow, /q/, 'the 20-column hint keeps the close key')
  assert.equal(reads, 1, 'repaint is pure; it did not read the cache again')
})

test('line mode keeps the report as text with all sections', () => {
  const { tui } = fixture({ lineMode: true })
  tui.runCommand('/context')
  assert.equal(tui.screen, undefined, 'line mode has no Screen')
  const row = tui.rows.findLast(row => row.kind === 'system')
  assert.ok(row !== undefined)
  assert.match(String(row.text), /asOfSeq/)
  assert.match(String(row.text), /构成/)
  assert.match(String(row.text), /DETAIL_UNAVAILABLE/)
  assert.equal(String(row.text).includes('\x1b'), false)
})

test('/status still opens its own report after a context visit', () => {
  const { tui } = fixture()
  tui.runCommand('/context')
  tui.handleInputText('q')
  tui.runCommand('/status')
  assert.equal(tui.screen?.report, 'status')
  tui.handleEscape()
  assert.equal(tui.screen, undefined)
})

test('the catalog still offers the day-to-day commands and the host /compact', () => {
  const names = commandSuggestions('/', []).map(command => command.name)
  const status = names.indexOf('status')
  assert.equal(names[status + 1], 'context')
  assert.equal(names.includes('usage'), true)
  assert.equal(names.includes('find'), true)
  assert.equal(names.includes('compact'), false)
})
