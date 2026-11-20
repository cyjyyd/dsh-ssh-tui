/**
 * `/context` without a terminal: the cache read, the normalized model, and the
 * three width layouts.
 *
 * The command's safety claim is narrow on purpose — one header-keyed cache read,
 * no event history — so these cases pin exactly that boundary: which service is
 * asked, which fields become values, and what the UI does when a value is absent.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { setLocale } from '../lib/i18n/index.js'
import { LOCAL_COMMANDS } from '../lib/commands.js'
import { CONTEXT_CACHE_KEYS, readContextCache } from '../lib/context-cache.js'
import { buildContextReport, formatContextReport, formatContextTextReport } from '../lib/context-view.js'
import { displayWidth } from '../lib/term-text.js'

setLocale('zh')

const ROUTE = { provider: 'deepseek', model: 'deepseek-chat' }

function snapshot(values = {}, asOfSeq = 10) {
  return { status: 'available', asOfSeq, values }
}

function complete(overrides = {}) {
  return snapshot({
    contextPressure: { pressureTokens: 1000, projectedTokens: 1051, contextWindow: 128000 },
    contextBreakdown: { systemTokens: 9000, toolsTokens: 14000, messageTokens: 39000 },
    tokenUsage: { uncachedInputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 },
    modelSelection: { lastUsed: ROUTE, next: ROUTE },
    ...overrides,
  }, overrides.asOfSeq ?? 10)
}

const page = (report, number, width, extra = {}) =>
  formatContextReport(report, { page: number, width, ...extra }).lines
const joined = (report, number, width, extra = {}) => page(report, number, width, extra).join('\n')

test('projectedTokens wins, and a checkpoint behind the log head is STALE', () => {
  const report = buildContextReport(complete(), { headSeq: 12, currentRoute: ROUTE })
  assert.equal(report.cache, 'AVAILABLE')
  assert.equal(report.overview.usedTokens, 1051)
  assert.equal(report.overview.usedSource, 'projected')
  assert.equal(report.overview.contextWindow, 128000)
  assert.equal(report.overview.freshness, 'STALE')
  assert.deepEqual(report.overview.staleReasons, ['LAG'])
  assert.equal(report.overview.lagEvents, 2)
  const body = joined(report, 1, 78)
  assert.match(body, /~1\.1K \/ 128K/)
  assert.match(body, /asOfSeq 10 \/ head 12 · STALE \(滞后 2\)/)
  assert.match(body, /CACHED|STALE/)
})

test('pressureTokens is the fallback and a real zero is not UNKNOWN', () => {
  const report = buildContextReport(snapshot({
    contextPressure: { pressureTokens: 0, contextWindow: 128000 },
  }, 10), { headSeq: 10, currentRoute: ROUTE })
  assert.equal(report.overview.usedTokens, 0)
  assert.equal(report.overview.usedSource, 'pressure')
  assert.equal(report.overview.percent, 0)
  assert.equal(report.overview.freshness, 'CACHED')
  const body = joined(report, 1, 78)
  assert.match(body, /~0 \/ 128K/)
  assert.match(body, /0%/)
  assert.doesNotMatch(page(report, 1, 78).find(line => line.includes('预计下一次请求')) ?? '', /UNKNOWN/)
})

test('missing capacity or missing usage is UNKNOWN, never 0%', () => {
  const noWindow = buildContextReport(snapshot({
    contextPressure: { pressureTokens: 1000 },
  }, 10), { headSeq: 12, currentRoute: ROUTE })
  assert.equal(noWindow.overview.usedTokens, 1000)
  assert.equal(noWindow.overview.contextWindow, undefined)
  assert.equal(noWindow.overview.percent, undefined)
  assert.match(joined(noWindow, 1, 78), /UNKNOWN/)
  assert.doesNotMatch(joined(noWindow, 1, 78), /0%/)

  const noUsage = buildContextReport(snapshot({ contextWindow: 128000 }, 10), { headSeq: 12 })
  assert.equal(noUsage.overview.available, false)
  assert.equal(noUsage.overview.freshness, 'UNKNOWN')
  assert.match(joined(noUsage, 1, 78), /UNKNOWN/)
  assert.doesNotMatch(joined(noUsage, 1, 78), /0%/)
})

test('a cached route that differs from the current route is STALE even at the same seq', () => {
  const report = buildContextReport(complete(), {
    headSeq: 10,
    currentRoute: { provider: 'xai', model: 'grok-4' },
  })
  assert.equal(report.overview.freshness, 'STALE')
  assert.deepEqual(report.overview.staleReasons, ['ROUTE'])
  assert.equal(report.overview.routeMatches, false)
  assert.match(joined(report, 1, 78), /STALE \(路由不一致\)/)
})

test('>100% keeps the true number and clamps only the bar', () => {
  const report = buildContextReport(snapshot({
    contextPressure: { pressureTokens: 200000, projectedTokens: 200012, contextWindow: 128000 },
  }, 10), { headSeq: 10, currentRoute: ROUTE })
  assert.equal(report.overview.percent, (200012 / 128000) * 100)
  assert.equal(report.overview.overflow, true)
  const lines = page(report, 1, 78)
  const bar = lines.find(line => line.startsWith('['))
  assert.ok(bar !== undefined, 'the bar is present')
  assert.equal([...bar].filter(char => char === '█').length, 36, 'the bar is filled to 100%')
  assert.equal([...bar].filter(char => char === '░').length, 0, 'and has no empty cell')
  const body = lines.join('\n')
  assert.match(body, /~200K \/ 128K/)
  assert.match(body, /156\.3%/)
  assert.match(body, /超过 100%/)
})

test('composition is three independent ~ estimates, never added to occupancy', () => {
  const report = buildContextReport(complete(), { headSeq: 10, currentRoute: ROUTE })
  const body = joined(report, 2, 78)
  assert.match(body, /系统提示 ~9K/)
  assert.match(body, /工具定义 ~14K/)
  assert.match(body, /对话 ~39K/)
  assert.match(body, /仅相对占比/)
  assert.match(body, /不等于上方缓存占用/)
  assert.doesNotMatch(body, /62K/, 'the sum is not printed as a total')
  assert.doesNotMatch(joined(report, 1, 78), /62K/, 'and it never becomes occupancy')
  assert.equal(report.composition.relativeTotal, 62000)
  assert.equal(report.overview.usedTokens, 1051)
})

test('cumulative tokenUsage is labelled billing, not occupancy', () => {
  const report = buildContextReport(snapshot({
    contextPressure: { projectedTokens: 1051, contextWindow: 128000 },
    tokenUsage: { uncachedInputTokens: 500000, outputTokens: 100000, cacheReadTokens: 0, cacheWriteTokens: 0 },
  }, 10), { headSeq: 10, currentRoute: ROUTE })
  const body = joined(report, 1, 78)
  assert.match(body, /计费累计（不是上下文占用）/)
  assert.match(body, /500K/)
  assert.match(body, /100K/)
  assert.doesNotMatch(body, /~600K \/ 128K/, 'billing never appears as occupancy')
  assert.match(body, /~1\.1K \/ 128K/)
})

test('an absent cache is fail-closed UNKNOWN with a reason', () => {
  const report = buildContextReport({ status: 'unavailable', reason: 'no-checkpoint' }, { headSeq: 12 })
  assert.equal(report.cache, 'UNAVAILABLE')
  assert.equal(report.overview.available, false)
  assert.equal(report.overview.freshness, 'UNKNOWN')
  const body = joined(report, 1, 78)
  assert.match(body, /投影缓存不可用/)
  assert.match(body, /UNKNOWN/)
  assert.doesNotMatch(body, /0%/)
  assert.doesNotMatch(body, /\[\u2588/, 'no occupancy bar is drawn')
  assert.match(joined(report, 2, 78), /构成：UNKNOWN/)
})

test('80/40/20 layouts fit the declared width, CJK included, with no ANSI', () => {
  const report = buildContextReport(complete(), { headSeq: 12, currentRoute: ROUTE })
  for (const width of [78, 38, 18]) {
    for (const number of [1, 2, 3]) {
      const lines = page(report, number, width)
      for (const line of lines) {
        assert.ok(displayWidth(line) <= width, `${width}w p${number} overflows: ${JSON.stringify(line)} (${displayWidth(line)})`)
        assert.equal(line.includes('\x1b'), false, 'formatter output is plain text')
      }
    }
  }
  const full = page(report, 1, 78)
  assert.match(full[0], /^第 1\/3 页 · 总览 · 只读 · 缓存投影/)
  const compact = page(report, 1, 38)
  assert.match(compact[0], /^第 1\/3 页 · 总览 · 只读/)
  const narrow = page(report, 1, 18)
  assert.match(narrow[0], /^上下文 1\/3/)
  assert.equal(narrow.some(line => line.includes('█') || line.includes('░')), false, '20 columns has no bar')
  assert.equal(narrow.join('').includes('…'), false, 'the narrow copy is designed to fit')
})

test('ASCII mode degrades the bar to #/. with no block glyphs', () => {
  const report = buildContextReport(snapshot({
    contextPressure: { pressureTokens: 32000, projectedTokens: 64000, contextWindow: 128000 },
  }, 10), { headSeq: 10, currentRoute: ROUTE })
  const body = joined(report, 1, 78, { ascii: true })
  assert.match(body, /#/)
  assert.match(body, /\./)
  assert.doesNotMatch(body, /[█░]/)
})

test('the line-mode text report carries all three pages', () => {
  const report = buildContextReport(complete(), { headSeq: 12, currentRoute: ROUTE })
  const lines = formatContextTextReport(report)
  const body = lines.join('\n')
  assert.match(body, /asOfSeq/)
  assert.match(body, /构成/)
  assert.match(body, /DETAIL_UNAVAILABLE/)
  assert.equal(body.includes('\x1b'), false)
  for (const line of lines) assert.ok(displayWidth(line) <= 80, `line overflows 80: ${JSON.stringify(line)}`)
})

test('the reader asks only the projection cache service and passes the exact keys', () => {
  const gets = []
  const reads = []
  const cache = {
    cachedSnapshot(header, keys) {
      reads.push({ header, keys })
      return { asOfSeq: 7, values: { contextPressure: { pressureTokens: 1 } } }
    },
  }
  const ctx = {
    get(name) {
      gets.push(name)
      if (name === 'sessionProjectionCache') return cache
      throw new Error(`unexpected service read: ${name}`)
    },
  }
  const session = { header: { id: 'main' } }
  const read = readContextCache(ctx, session)
  assert.equal(read.status, 'available')
  assert.equal(read.asOfSeq, 7)
  assert.deepEqual(gets, ['sessionProjectionCache'])
  assert.deepEqual(reads, [{ header: { id: 'main' }, keys: [...CONTEXT_CACHE_KEYS] }])
  assert.deepEqual([...CONTEXT_CACHE_KEYS], ['contextPressure', 'contextBreakdown', 'tokenUsage', 'modelSelection'])
})

test('missing service, missing header and a throwing reader all fail closed', () => {
  assert.deepEqual(readContextCache(undefined, { header: {} }), { status: 'unavailable', reason: 'service-missing' })
  assert.deepEqual(readContextCache({ get: () => undefined }, { header: {} }), { status: 'unavailable', reason: 'service-missing' })
  assert.deepEqual(readContextCache({ get: () => ({}) }, { header: {} }), { status: 'unavailable', reason: 'service-missing' })
  assert.deepEqual(readContextCache({ get: () => ({ cachedSnapshot: () => ({ asOfSeq: 1, values: {} }) }) }, {}), { status: 'unavailable', reason: 'header-missing' })
  assert.deepEqual(readContextCache({ get: () => ({ cachedSnapshot: () => { throw new Error('boom') } }) }, { header: {} }), { status: 'unavailable', reason: 'read-failed' })
  assert.deepEqual(readContextCache({ get: () => ({ cachedSnapshot: () => undefined }) }, { header: {} }), { status: 'unavailable', reason: 'no-checkpoint' })
})

test('a cold session accessor is never touched by the cache read', () => {
  let touched = 0
  const session = { header: { id: 'cold' } }
  for (const name of ['events', 'snapshotEvents', 'eventAt', 'ownEvents']) {
    Object.defineProperty(session, name, {
      configurable: true,
      get() { touched += 1; throw new Error(`FORBIDDEN_${name}`) },
    })
  }
  let foreignService = 0
  const ctx = {
    get(name) {
      if (name === 'sessionProjectionCache') {
        return { cachedSnapshot: () => ({ asOfSeq: 3, values: { contextPressure: { pressureTokens: 5, contextWindow: 100 } } }) }
      }
      foreignService += 1
      throw new Error(`unexpected service read: ${name}`)
    },
  }
  const read = readContextCache(ctx, session)
  assert.equal(read.status, 'available')
  assert.equal(touched, 0)
  assert.equal(foreignService, 0)
  const report = buildContextReport(read, { headSeq: 9 })
  assert.equal(report.overview.freshness, 'STALE')
})

test('55k/250k synthetic reads stay O(1), copy no events, and keep the payload small', () => {
  for (const seq of [55_000, 250_000]) {
    let accessorHits = 0
    const session = { header: { id: `synthetic-${seq}` }, seq }
    Object.defineProperty(session, 'events', { configurable: true, get() { accessorHits += 1; throw new Error('FORBIDDEN_events') } })
    Object.defineProperty(session, 'snapshotEvents', { configurable: true, get() { accessorHits += 1; throw new Error('FORBIDDEN_snapshotEvents') } })
    const cache = {
      cachedSnapshot: () => ({
        asOfSeq: seq - 1,
        values: {
          contextPressure: { projectedTokens: 55_000, pressureTokens: 54_000, contextWindow: 128_000 },
          contextBreakdown: { systemTokens: 9_000, toolsTokens: 14_000, messageTokens: 32_000 },
          tokenUsage: { uncachedInputTokens: 250_000, outputTokens: 12_345, cacheReadTokens: 1_000, cacheWriteTokens: 500 },
        },
      }),
    }
    const start = process.hrtime.bigint()
    let report
    for (let index = 0; index < 250; index += 1) {
      report = buildContextReport(readContextCache({ get: () => cache }, session), { headSeq: seq })
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6
    assert.equal(accessorHits, 0, 'no event accessor was read')
    assert.equal(report?.asOfSeq, seq - 1)
    assert.ok(elapsedMs < 1_500, `${seq} reads took ${elapsedMs.toFixed(1)}ms`)
    assert.ok(Buffer.byteLength(JSON.stringify(report), 'utf8') < 8_192, 'the normalized payload stays small')
  }
})

test('the new command code contains no forbidden read path', () => {
  const source = name => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
  const forbidden = [
    /\bsessionProjections\b/u,
    /\btokenMeter\b/u,
    /\bSessionObservation\b/u,
    /\bsessionEvents\b/u,
    /\bsnapshotEvents\b/u,
    /\beventAt\b/u,
    /\bownEvents\b/u,
    /agents\s*\.\s*resume/u,
    /open\s*\(\s*['"]read['"]\s*\)/u,
  ]
  for (const name of ['context-cache.ts', 'context-view.ts']) {
    const text = source(name)
    for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${name} matches ${pattern}`)
  }
  const tui = source('tui.ts')
  const start = tui.indexOf('private runContextCommand(): void {')
  const end = tui.indexOf('/** Rebuild the context body', start)
  assert.ok(start > 0 && end > start, 'the command body is locatable')
  const region = tui.slice(start, end)
  for (const pattern of forbidden) assert.doesNotMatch(region, pattern, `runContextCommand matches ${pattern}`)
  assert.match(region, /readContextCache/)
})

test('/context sits directly after /status and keeps the host compact command foreign', () => {
  const names = LOCAL_COMMANDS.map(command => command.name)
  assert.equal(names.indexOf('context'), names.indexOf('status') + 1)
  assert.equal(names.includes('compact'), false, 'the host owns /compact')
  assert.equal(names.includes('usage'), true)
  assert.equal(names.includes('find'), true)
})
