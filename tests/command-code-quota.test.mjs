import test from 'node:test'
import assert from 'node:assert/strict'

import {
  commandCodePeriodStart,
  commandCodeSourceFor,
  formatQuotaSnapshot,
  parseCommandCodeQuota,
} from '../lib/quota.js'
import { SshTui } from '../lib/tui.js'

/**
 * Command Code's billing surface: `/alpha/billing/credits` windowLimits plus a
 * credit pool, enriched by the subscription period and period spend. These
 * fixtures mirror the shapes the live endpoint returns.
 */

const CREDITS = {
  credits: { belowThreshold: false, monthlyCredits: 20, purchasedCredits: 5, freeCredits: 1 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 25, cap: 100, exceeded: false, resetAt: 1_789_458_750_708 },
    weekly: { used: 10, cap: 40, resetAt: 1_790_045_550_708 },
  },
}

const SUBSCRIPTION = {
  success: true,
  data: {
    planId: 'individual-goat',
    currentPeriodStart: '2026-09-15T02:41:06.000Z',
    currentPeriodEnd: '2026-10-15T02:41:06.000Z',
  },
}

test('maps the 5h/weekly windows and the USD credit pool into one snapshot', () => {
  const snapshot = parseCommandCodeQuota(
    { credits: CREDITS, subscription: SUBSCRIPTION, summary: { totalCost: 15 } },
    'command-code',
  )
  assert.equal(snapshot.provider, 'command-code')
  assert.equal(snapshot.plan, 'GOAT')
  assert.deepEqual(snapshot.windows[0], {
    label: '滚动 5 小时',
    period: 'hourly',
    remainingPercent: 75,
    resetsAt: new Date(1_789_458_750_708).toISOString(),
  })
  assert.deepEqual(snapshot.windows[1], {
    label: '本周',
    period: 'weekly',
    remainingPercent: 75,
    resetsAt: new Date(1_790_045_550_708).toISOString(),
  })
  // percent = 100 - 15 / (15 + 26) * 100
  assert.deepEqual(snapshot.windows[2], {
    label: '额度余额',
    period: 'monthly',
    remainingPercent: 63.4,
    detail: '$26.00',
    resetsAt: '2026-10-15T02:41:06.000Z',
  })
})

test('a missing spend read leaves the credit window at full and still reports the pool', () => {
  const snapshot = parseCommandCodeQuota({ credits: CREDITS, subscription: SUBSCRIPTION }, 'command-code')
  assert.equal(snapshot.windows[2]?.remainingPercent, 100)
  assert.equal(snapshot.windows[2]?.detail, '$26.00')
})

test('a missing subscription falls back to the provider label and no reset', () => {
  const snapshot = parseCommandCodeQuota({ credits: { windowLimits: { weekly: { used: 10, cap: 40 } } } }, 'cc')
  assert.equal(snapshot.plan, 'Command Code')
  assert.deepEqual(snapshot.windows, [{ label: '本周', period: 'weekly', remainingPercent: 75 }])
})

test('an unrecognized payload throws instead of reporting an empty quota', () => {
  assert.throws(() => parseCommandCodeQuota({ credits: {} }, 'command-code'))
  assert.throws(() => parseCommandCodeQuota({ credits: null }, 'command-code'))
})

test('the period start scopes the spend query and a bad value is ignored', () => {
  assert.equal(commandCodePeriodStart(SUBSCRIPTION), '2026-09-15T02:41:06.000Z')
  assert.equal(commandCodePeriodStart({ data: { currentPeriodStart: '   ' } }), undefined)
  assert.equal(commandCodePeriodStart(undefined), undefined)
})

test('the rendered snapshot carries the USD pool beside the percent', () => {
  const snapshot = parseCommandCodeQuota({ credits: CREDITS, subscription: SUBSCRIPTION, summary: { totalCost: 15 } }, 'command-code')
  const text = formatQuotaSnapshot(snapshot)
  assert.ok(text.includes('GOAT'), text)
  assert.ok(text.includes('$26.00'), text)
  assert.ok(text.includes('剩余 63.4%'), text)
})

test('Command Code is recognized by provider id or canonical base URL only', () => {
  assert.deepEqual(
    commandCodeSourceFor('command-code', { providers: { 'command-code': { apiKeyEnv: 'COMMAND_CODE_API_KEY' } } }),
    { provider: 'command-code', apiKeyEnv: 'COMMAND_CODE_API_KEY', label: 'Command Code' },
  )
  assert.equal(
    commandCodeSourceFor('my-gw', { providers: { 'my-gw': { baseURL: 'https://api.commandcode.ai/provider/v1' } } })?.provider,
    'my-gw',
  )
  assert.equal(
    commandCodeSourceFor('my-gw', { providers: { 'my-gw': { baseURL: 'https://api.commandcode.ai/' } } })?.provider,
    'my-gw',
  )
  // A lookalike host keeps its own id, so no credential is released to it.
  assert.equal(commandCodeSourceFor('my-gw', { providers: { 'my-gw': { baseURL: 'https://example.invalid/v1' } } }), null)
  assert.equal(commandCodeSourceFor('deepseek-official', { providers: {} }), null)
})

test('a Command Code profile without an explicit env ref uses the canonical key name', () => {
  assert.equal(
    commandCodeSourceFor('command-code', { providers: { 'command-code': { displayName: 'CC' } } })?.apiKeyEnv,
    'COMMAND_CODE_API_KEY',
  )
})

test('the quota read targets the canonical billing URLs and soft-fails enrichment', async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, authorization: init?.headers?.authorization })
    const json = body => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
    if (url.includes('/alpha/billing/credits')) return json(CREDITS)
    if (url.includes('/alpha/billing/subscriptions')) return json(SUBSCRIPTION)
    if (url.includes('/alpha/usage/summary')) return new Response('down', { status: 500 })
    return new Response('{}', { status: 404 })
  }
  try {
    const section = { providers: { 'command-code': { apiKeyEnv: 'COMMAND_CODE_API_KEY' } } }
    const settings = { get: ns => (ns === 'llm-pi-ai' ? section : undefined) }
    const credentials = { resolve: async () => ({ value: 'cc-test-key' }) }
    const ctx = {
      get: name => (name === 'settings' ? settings : name === 'credentials' ? credentials : undefined),
      on() { return () => {} },
    }
    const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
    const tui = new SshTui(ctx, agent, { sessionId: 's', color: false })

    const snapshot = await tui.fetchQuotaSnapshot('command-code')

    assert.equal(snapshot?.plan, 'GOAT')
    assert.equal(snapshot?.windows.length, 3)
    assert.equal(calls[0]?.url, 'https://api.commandcode.ai/alpha/billing/credits')
    assert.equal(calls[0]?.authorization, 'Bearer cc-test-key')
    assert.equal(calls[1]?.url, 'https://api.commandcode.ai/alpha/billing/subscriptions')
    assert.equal(calls[2]?.url, 'https://api.commandcode.ai/alpha/usage/summary?since=2026-09-15T02%3A41%3A06.000Z')
    // The 500 on the spend read is soft: the credit window stays at full.
    assert.equal(snapshot?.windows[2]?.remainingPercent, 100)
    assert.equal(snapshot?.windows[2]?.detail, '$26.00')
  } finally {
    globalThis.fetch = original
  }
})
