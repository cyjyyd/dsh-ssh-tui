import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AICLIENT2API_PASSWORD_ENV,
  AICLIENT2API_TOKEN_ENV,
  aiClient2ApiSourceFor,
  aiClient2ApiUsagePath,
  parseAiClient2ApiUsage,
} from '../lib/quota.js'
import { SshTui } from '../lib/tui.js'

/**
 * AIClient2API (A2) quota: the panel, not the AI route.
 *
 * The provider row points at `<origin>/<providerType>/v1`, the AI key cannot
 * read the quota (A2 answers 401 for management routes), and the quota itself is
 * the *upstream subscription's* — for `gemini-antigravity`, the Google AI plan's
 * per-model windows. The fixtures below mirror
 * `formatAntigravityUsage()` in the A2 source.
 */

const ANTIGRAVITY_USAGE = {
  providerType: 'gemini-antigravity',
  instances: [
    {
      uuid: '841e0db0-2aec',
      name: '主账号',
      success: true,
      error: null,
      usage: {
        summary: {
          usedPercent: 37.5,
          status: 'normal',
          resetAt: '2026-09-23T00:00:00.000Z',
          plan: 'Google AI Pro',
          unit: 'percent',
        },
        user: { email: 'me@example.com' },
        items: [
          {
            id: 'gemini-3.8-flash',
            label: 'gemini-3.8-flash',
            used: 50,
            limit: 100,
            percent: 50,
            unit: 'percent',
            status: 'normal',
            resetAt: '2026-09-23T00:00:00.000Z',
          },
          {
            id: 'gemini-claude-sonnet-4-6',
            label: 'gemini-claude-sonnet-4-6',
            used: 25,
            limit: 100,
            percent: 25,
            status: 'normal',
            resetAt: '2026-09-23T02:30:00.000Z',
          },
        ],
      },
    },
  ],
  totalCount: 1,
  successCount: 1,
  errorCount: 0,
}

const SECTION = {
  providers: {
    'google-ai-pro': {
      displayName: 'Gemini Antigravity（agy.wdsky.top）',
      apiKeyEnv: 'GOOGLE_AI_PRO_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://agy.wdsky.top/gemini-antigravity/v1',
    },
  },
}

function tui(section, credentials) {
  const settings = { get: ns => (ns === 'llm-pi-ai' ? section : undefined) }
  const ctx = {
    get: name => (name === 'settings' ? settings : name === 'credentials' ? credentials : undefined),
    on() { return () => {} },
  }
  const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
  return new SshTui(ctx, agent, { sessionId: 's', color: false })
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('an A2 mount is recognized from the route, and nothing else is', () => {
  const base = { providers: { gw: { baseURL: 'https://agy.wdsky.top/gemini-antigravity/v1' } } }
  const source = aiClient2ApiSourceFor('gw', base)
  assert.equal(source?.origin, 'https://agy.wdsky.top')
  assert.equal(source?.providerType, 'gemini-antigravity')
  assert.equal(source?.label, 'AIClient2API · gemini-antigravity')
  assert.equal(source?.passwordEnv, AICLIENT2API_PASSWORD_ENV)
  assert.equal(source?.tokenEnv, AICLIENT2API_TOKEN_ENV)
  assert.equal(aiClient2ApiUsagePath('gemini-antigravity'), '/api/usage/gemini-antigravity')

  const cases = {
    'a trailing slash is still the same mount': 'https://agy.wdsky.top/gemini-antigravity/v1/',
    'a query string does not change the path': 'https://agy.wdsky.top/gemini-antigravity/v1?x=1',
    'v1beta is the other version A2 mounts': 'https://h/gemini-cli-oauth/v1beta',
    'the Kiro mount is a known type': 'https://h/claude-kiro-oauth/v1',
  }
  for (const [why, baseURL] of Object.entries(cases)) {
    assert.notEqual(aiClient2ApiSourceFor('gw', { providers: { gw: { baseURL } } }), null, why)
  }

  const notA2 = {
    'an unknown provider type': 'https://h/not-a-real-type/v1',
    'the version segment is missing': 'https://h/gemini-antigravity',
    'a deeper path is a different gateway': 'https://h/gemini-antigravity/v1/extra',
    'a plain OpenAI-compatible root': 'https://api.example.com/v1',
    'openrouter-style path': 'https://openrouter.ai/api/v1',
    'not a URL at all': 'agy.wdsky.top/gemini-antigravity/v1',
  }
  for (const [why, baseURL] of Object.entries(notA2)) {
    assert.equal(aiClient2ApiSourceFor('gw', { providers: { gw: { baseURL } } }), null, why)
  }
  assert.equal(aiClient2ApiSourceFor('missing', { providers: {} }), null)
  assert.equal(aiClient2ApiSourceFor('gw', undefined), null)
})

test('the panel usage view becomes per-model remaining windows', () => {
  const snapshot = parseAiClient2ApiUsage(ANTIGRAVITY_USAGE, 'google-ai-pro')
  assert.equal(snapshot.source, 'aiclient2api')
  assert.equal(snapshot.plan, 'Google AI Pro')
  assert.deepEqual(snapshot.windows.map(window => window.label), [
    'gemini-3.8-flash',
    'gemini-claude-sonnet-4-6',
  ])
  // A2 reports *used* percent; the shared window type carries what is left.
  assert.equal(snapshot.windows[0]?.remainingPercent, 50)
  assert.equal(snapshot.windows[1]?.remainingPercent, 75)
  assert.equal(snapshot.windows[0]?.resetsAt, '2026-09-23T00:00:00.000Z')
  assert.equal(snapshot.windows[1]?.resetsAt, '2026-09-23T02:30:00.000Z')
})

test('a pool prefixes each account, and a failed instance is reported with its reason', () => {
  const pooled = parseAiClient2ApiUsage({
    instances: [
      { name: 'acc-1', success: true, usage: { summary: { plan: 'Pro' }, items: [{ id: 'm', percent: 10 }] } },
      { name: 'acc-2', success: true, usage: { items: [{ id: 'm', percent: 30 }] } },
    ],
  }, 'p')
  assert.deepEqual(pooled.windows.map(window => window.label), ['acc-1 · m', 'acc-2 · m'])
  assert.equal(pooled.windows[0]?.remainingPercent, 90)

  assert.throws(
    () => parseAiClient2ApiUsage({
      instances: [{ name: 'acc', success: false, error: 'Provider is disabled', usage: null }],
    }, 'p'),
    /Provider is disabled/u,
  )
  assert.throws(() => parseAiClient2ApiUsage({ instances: [] }, 'p'), /quota\.unrecognized|额度|quota/iu)
  assert.throws(() => parseAiClient2ApiUsage({ nope: true }, 'p'), /quota\.unrecognized|额度|quota/iu)
})

test('the flow logs in with the panel password, then reads that provider type', async () => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', authorization: init?.headers?.authorization, body: init?.body })
    if (url === 'https://agy.wdsky.top/api/login') {
      assert.equal(init?.method, 'POST')
      assert.deepEqual(JSON.parse(String(init?.body)), { password: 'panel-secret' })
      return json({ token: 'tok-1' })
    }
    if (url === 'https://agy.wdsky.top/api/usage/gemini-antigravity') {
      assert.equal(init?.headers?.authorization, 'Bearer tok-1')
      return json(ANTIGRAVITY_USAGE)
    }
    return new Response('{}', { status: 404 })
  }
  try {
    globalThis.fetch = globalThis.fetch
    const credentials = { resolve: async ref => ({ value: ref.includes('PASSWORD') ? 'panel-secret' : '' }) }
    const instance = tui(SECTION, credentials)
    const snapshot = await instance.fetchQuotaSnapshot('google-ai-pro')
    assert.equal(snapshot?.windows.length, 2)
    assert.deepEqual(calls.map(call => `${call.method} ${call.url}`), [
      'POST https://agy.wdsky.top/api/login',
      'GET https://agy.wdsky.top/api/usage/gemini-antigravity',
    ])

    // Second read reuses the cached token: the panel token is per login.
    await instance.fetchQuotaSnapshot('google-ai-pro')
    assert.equal(calls.filter(call => call.url.endsWith('/api/login')).length, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('a stale panel token is replaced on 401, and a bare token skips the login', async () => {
  const original = globalThis.fetch
  const calls = []
  let usageAttempts = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, authorization: init?.headers?.authorization })
    if (url.endsWith('/api/login')) return json({ token: `tok-${calls.length}` })
    if (url.endsWith('/api/usage/gemini-antigravity')) {
      usageAttempts += 1
      // The session token the panel handed out first is already stale.
      if (usageAttempts === 1) return json({ error: { message: 'Unauthorized' } }, 401)
      return json(ANTIGRAVITY_USAGE)
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const credentials = { resolve: async ref => ({ value: ref.includes('PASSWORD') ? 'pw' : '' }) }
    const snapshot = await tui(SECTION, credentials).fetchQuotaSnapshot('google-ai-pro')
    assert.equal(snapshot?.windows.length, 2)
    assert.equal(usageAttempts, 2, 'the 401 is retried once with a fresh login')
    assert.equal(calls.filter(call => call.url.endsWith('/api/login')).length, 2)

    // With only a token configured there is nothing to log in with, so the
    // configured token is used as-is.
    calls.length = 0
    const tokenOnly = { resolve: async ref => ({ value: ref.includes('TOKEN') ? 'tok-direct' : '' }) }
    await tui(SECTION, tokenOnly).fetchQuotaSnapshot('google-ai-pro')
    assert.deepEqual(calls.map(call => call.url), ['https://agy.wdsky.top/api/usage/gemini-antigravity'])
    assert.equal(calls[0]?.authorization, 'Bearer tok-direct')
  } finally {
    globalThis.fetch = original
  }
})

test('a rejected password is reported once and then left alone', async () => {
  // A2 counts failed logins and locks the panel when they run out, so a wrong
  // password must not be re-sent on every quota refresh (start + every ten
  // steps). The panel's own message is what the user needs to see.
  const original = globalThis.fetch
  let logins = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.endsWith('/api/login')) {
      logins += 1
      return json({
        success: false,
        message: 'Incorrect password. 3 attempts remaining.',
        messageCode: 'login.error.incorrectWithRemaining',
      }, 401)
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const credentials = { resolve: async ref => ({ value: ref.includes('PASSWORD') ? 'wrong' : '' }) }
    const instance = tui(SECTION, credentials)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await assert.rejects(
        () => instance.fetchQuotaSnapshot('google-ai-pro'),
        error => error.message.includes('Incorrect password. 3 attempts remaining.'),
      )
    }
    assert.equal(logins, 1, 'the cooling-down failure is re-thrown without another login')
  } finally {
    globalThis.fetch = original
  }
})

test('without a panel credential the error says which refs to set', async () => {
  const credentials = { resolve: async () => undefined }
  await assert.rejects(
    () => tui(SECTION, credentials).fetchQuotaSnapshot('google-ai-pro'),
    error => error.message.includes('AICLIENT2API_PASSWORD') && error.message.includes('AICLIENT2API_TOKEN'),
  )
})
