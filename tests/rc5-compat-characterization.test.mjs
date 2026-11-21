import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { cp, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { SshTui } from '../lib/tui.js'
import { forEachSessionEventAsync } from '../lib/dsh-compat.js'
import { sessionEventsAreBlank } from '../lib/session-blank.js'
import { classifyAuthFailure, isContentRefusedFailure } from '../lib/auth-failure.js'

/**
 * rc.5 characterization against the exact installed Host family.
 *
 * Everything here is synthetic: a fake key, loopback-only HTTP, and a `fetch`
 * tripwire for the case that must reach the official endpoint. No test reads a
 * real credential, starts a real provider, or contacts an external network.
 *
 * The rc.5 artifact is deliberately not a dependency of this repository (peer
 * ranges are not part of this U1). Install it in its own single-family tree and
 * point `DSH_RC5_ROOT` at that tree; the suite skips when it is absent:
 *
 *   mkdir -p .probe-tree/rc5-install
 *   cd .probe-tree/rc5-install
 *   printf '%s\n' '{"name":"rc5-strict-install","private":true,"version":"1.0.0","dependencies":{"@deepseek-ai/dsh":"0.2.2-rc.5"}}' > package.json
 *   npm install --ignore-scripts --no-audit --no-fund
 *   cd ../..
 *   DSH_RC5_ROOT="$PWD/.probe-tree/rc5-install" node --test tests/rc5-compat-characterization.test.mjs
 *
 * `npm run build` must have produced `lib/` first, as `npm test` does.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const RC5_ROOT = process.env.DSH_RC5_ROOT
  ? resolve(process.env.DSH_RC5_ROOT)
  : join(REPO, '.probe-tree', 'rc5-install')
const INSTALLED = existsSync(join(RC5_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'))
const SKIP = INSTALLED ? false : `rc.5 single-family artifact is not installed at ${RC5_ROOT}`

const FAKE_KEY = 'sk-rc5-synthetic-000000000000'
const DEFAULT_MESSAGES_ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages'

let rc5

before(async () => {
  if (!INSTALLED) return
  const require = createRequire(join(RC5_ROOT, 'package.json'))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const [cordis, web, legacy, api] = await Promise.all([
    load('@deepseek-ai/cordis'),
    load('@deepseek-ai/dsh-web'),
    load('@deepseek-ai/dsh-web-search-deepseek'),
    load('@deepseek-ai/dsh-web-deepseek-api'),
  ])
  rc5 = { Context: cordis.Context, WebRuntime: web.default, legacy, api }
})

/** Construct a WebRuntime with the given config id and constructor-time env override. */
function makeWeb({ config, env } = {}) {
  const previous = process.env.DSH_WEB_SEARCH_PROVIDER
  if (env === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
  else process.env.DSH_WEB_SEARCH_PROVIDER = env
  try {
    return new rc5.WebRuntime(new rc5.Context(), {
      searchProvider: { get: () => config },
      fetchProvider: { get: () => undefined },
    })
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_SEARCH_PROVIDER
    else process.env.DSH_WEB_SEARCH_PROVIDER = previous
  }
}

/** One recording search provider; `available`/`ready` can be fixed or dynamic. */
function stubProvider(id, { available = true, ready } = {}) {
  const calls = []
  const provider = {
    id,
    available: () => (typeof available === 'function' ? available() : available),
    search: async request => {
      calls.push(request)
      return { sources: [{ url: `https://${id}.example/`, title: id }] }
    },
    ...(ready === undefined ? {} : { ready }),
  }
  return { provider, calls }
}

/** Start a loopback JSON server and record every request body. */
async function startServer(t, reply) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const request = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: text,
        json: text === '' ? undefined : JSON.parse(text),
      }
      requests.push(request)
      try {
        const { status = 200, body } = reply(request)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      }
    })
  })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(0, '127.0.0.1', resolveListen)
  })
  t.after(() => new Promise(resolveClose => { server.close(resolveClose) }))
  return { port: server.address().port, requests }
}

/** The synthetic Messages-search answer rc.5's legacy provider maps. */
function messagesReply(url = 'https://example.test/a') {
  return {
    body: {
      content: [{
        type: 'web_search_tool_result',
        content: [{
          type: 'web_search_result',
          url,
          title: 'Synthetic result',
          snippet: 'synthetic snippet',
          page_age: '2026-01-01',
        }],
      }],
    },
  }
}

/** The synthetic Search API answer rc.5's API provider maps. */
function searchApiReply() {
  return {
    body: {
      results: [{
        url: 'https://example.test/b',
        title: 'Synthetic API result',
        snippet: 'api snippet',
        summary: 'api summary',
        date: '2026-02-02',
      }],
    },
  }
}

/**
 * Register rc.5's real legacy provider through its plugin `apply`, with the
 * Host services it reads replaced by recording fakes. This exercises the
 * settings-to-provider wiring, not just the provider class.
 */
function makeLegacyHarness({ baseURL, route = 'deepseek-official', apiKey = FAKE_KEY, apiKeyEnv = 'DSH_RC5_TEST_KEY' } = {}) {
  const appends = []
  let registered
  const ctx = {
    get(name) {
      if (name !== 'agents') return undefined
      return {
        currentInitiator: () => ({
          session: {
            requestContext: () => ({ provider: route }),
            append: (type, data) => appends.push({ type, data }),
          },
        }),
      }
    },
    web: {
      registerSearchProvider(provider) {
        registered = provider
        return () => {}
      },
    },
  }
  const value = current => ({ get: () => current })
  rc5.legacy.apply(ctx, {
    apiKey: value(apiKey),
    apiKeyEnv: value(apiKeyEnv),
    baseURL: value(baseURL),
    model: value('deepseek-v4-flash'),
    apiVersion: value('2023-06-01'),
    maxTokens: value(4096),
    maxUses: value(5),
  })
  assert.equal(registered?.id, 'deepseek-official')
  return { provider: registered, appends }
}

/** The exact rc.5 event a legacy search appends before dispatch. */
function searchRequestEvent(endpoint = `${DEFAULT_MESSAGES_ENDPOINT}`) {
  return {
    type: 'web/deepseek-search-llm-request',
    time: 1_700_000_000_000,
    data: {
      endpoint,
      apiVersion: '2023-06-01',
      body: {
        model: 'deepseek-v4-flash',
        max_tokens: 4096,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Perform a web search for the query: synthetic' }] }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        thinking: { type: 'disabled' },
      },
    },
  }
}

/** A TUI with the host services the transcript fold reads, as an event sink. */
function makeTui() {
  const credentials = {
    resolve: async () => ({ value: 'x'.repeat(20) }),
    describe: async () => ({ configured: true }),
  }
  const ctx = {
    get: name => (name === 'credentials' ? credentials : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [], header: { cwd: '/tmp' } },
    cancel() {},
    followup() {},
    steer() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.write = () => {}
  return { tui, agent }
}

/** Load rc.5's translate source from an artifact-local copy Node may type-strip. */
async function loadTranslate() {
  const copy = join(RC5_ROOT, 'rc5-src')
  const source = join(RC5_ROOT, 'node_modules', '@deepseek-ai', 'dsh-llm-deepseek', 'src')
  if (!existsSync(join(copy, 'translate.ts'))) await cp(source, copy, { recursive: true })
  const marker = join(copy, 'package.json')
  if (!existsSync(marker)) await writeFile(marker, '{"type":"module"}\n')
  return import(pathToFileURL(join(copy, 'translate.ts')).href)
}

test('T1 unset search routes DeepSeek models to Messages search and other routes to the Search API', { skip: SKIP }, async () => {
  for (const route of ['deepseek-official', 'deepseek-account']) {
    const web = makeWeb()
    const official = stubProvider('deepseek-official')
    const api = stubProvider('deepseek-search-api')
    web.registerSearchProvider(official.provider)
    web.registerSearchProvider(api.provider)
    await web.search({ query: 'route query', llmProvider: route })
    assert.deepEqual(official.calls.map(call => call.llmProvider), [route], `${route} selects Messages search`)
    assert.equal(api.calls.length, 0, `${route} must not select the Search API`)
  }
  for (const route of ['deepseek-v4-flash', 'some-other-route', undefined]) {
    const web = makeWeb()
    const official = stubProvider('deepseek-official')
    const api = stubProvider('deepseek-search-api')
    web.registerSearchProvider(official.provider)
    web.registerSearchProvider(api.provider)
    await web.search({ query: 'route query', ...(route === undefined ? {} : { llmProvider: route }) })
    assert.equal(api.calls.length, 1, `${String(route)} selects the Search API`)
    assert.equal(official.calls.length, 0, `${String(route)} must not select Messages search`)
  }
})

test('T1 explicit config and DSH_WEB_SEARCH_PROVIDER override the route preference', { skip: SKIP }, async () => {
  const explicit = makeWeb({ config: 'deepseek-search-api' })
  const explicitOfficial = stubProvider('deepseek-official')
  const explicitApi = stubProvider('deepseek-search-api')
  explicit.registerSearchProvider(explicitOfficial.provider)
  explicit.registerSearchProvider(explicitApi.provider)
  await explicit.search({ query: 'explicit', llmProvider: 'deepseek-official' })
  assert.equal(explicitApi.calls.length, 1)
  assert.equal(explicitOfficial.calls.length, 0)

  const env = makeWeb({ env: 'deepseek-official' })
  const envOfficial = stubProvider('deepseek-official')
  const envApi = stubProvider('deepseek-search-api')
  env.registerSearchProvider(envOfficial.provider)
  env.registerSearchProvider(envApi.provider)
  await env.search({ query: 'env', llmProvider: 'some-other-route' })
  assert.equal(envOfficial.calls.length, 1)
  assert.equal(envApi.calls.length, 0)

  const both = makeWeb({ config: 'deepseek-search-api', env: 'deepseek-official' })
  const bothOfficial = stubProvider('deepseek-official')
  const bothApi = stubProvider('deepseek-search-api')
  both.registerSearchProvider(bothOfficial.provider)
  both.registerSearchProvider(bothApi.provider)
  await both.search({ query: 'both', llmProvider: 'deepseek-official' })
  assert.equal(bothApi.calls.length, 1, 'explicit config wins over the environment')
  assert.equal(bothOfficial.calls.length, 0)
})

test('T1 an unregistered, unavailable, ambiguous, or empty selection fails with its structured code', { skip: SKIP }, async () => {
  const missing = makeWeb({ config: 'serverSearch' })
  missing.registerSearchProvider(stubProvider('deepseek-official').provider)
  missing.registerSearchProvider(stubProvider('deepseek-search-api').provider)
  await assert.rejects(
    missing.search({ query: 'missing', llmProvider: 'deepseek-official' }),
    error => error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
    'serverSearch is not a registered rc.5 provider id',
  )

  const unavailable = makeWeb({ config: 'deepseek-search-api' })
  unavailable.registerSearchProvider(stubProvider('deepseek-official').provider)
  unavailable.registerSearchProvider(stubProvider('deepseek-search-api', { available: false }).provider)
  await assert.rejects(
    unavailable.search({ query: 'unavailable', llmProvider: 'deepseek-official' }),
    error => error.code === 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE',
  )

  const ambiguous = makeWeb()
  ambiguous.registerSearchProvider(stubProvider('stub-a').provider)
  ambiguous.registerSearchProvider(stubProvider('stub-b').provider)
  await assert.rejects(
    ambiguous.search({ query: 'ambiguous', llmProvider: 'some-other-route' }),
    error => error.code === 'WEB_PROVIDER_AMBIGUOUS',
  )

  const empty = makeWeb()
  empty.registerSearchProvider(stubProvider('deepseek-official', { available: false }).provider)
  empty.registerSearchProvider(stubProvider('deepseek-search-api', { available: false }).provider)
  await assert.rejects(
    empty.search({ query: 'empty', llmProvider: 'deepseek-official' }),
    error => error.code === 'WEB_PROVIDER_UNAVAILABLE',
  )

  const single = makeWeb()
  single.registerSearchProvider(stubProvider('only-provider').provider)
  await single.search({ query: 'single', llmProvider: 'deepseek-official' })
})

test('T1 searchReady asks the provider the same route selection would run', { skip: SKIP }, async () => {
  const web = makeWeb()
  const officialReady = []
  const apiReady = []
  web.registerSearchProvider(stubProvider('deepseek-official', {
    ready: async route => { officialReady.push(route); return true },
  }).provider)
  web.registerSearchProvider(stubProvider('deepseek-search-api', {
    ready: async route => { apiReady.push(route); return false },
  }).provider)
  assert.equal(await web.searchReady('deepseek-official'), true)
  assert.equal(await web.searchReady('deepseek-account'), true)
  assert.equal(await web.searchReady('some-other-route'), false)
  assert.deepEqual(officialReady, ['deepseek-official', 'deepseek-account'])
  assert.deepEqual(apiReady, ['some-other-route'])
})

test('T3 legacy Messages search uses its loopback endpoint, native web_search body, and key, and records the event', { skip: SKIP }, async t => {
  const { port, requests } = await startServer(t, () => messagesReply())
  const baseURL = `http://127.0.0.1:${port}/anthropic/v1`
  const harness = makeLegacyHarness({ baseURL })
  const result = await harness.provider.search({ query: 'synthetic rc5 query' })

  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/anthropic/v1/messages')
  assert.equal(request.headers['x-api-key'], FAKE_KEY)
  assert.equal(request.headers.authorization, `Bearer ${FAKE_KEY}`)
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  assert.equal(request.json.model, 'deepseek-v4-flash')
  assert.deepEqual(request.json.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }])
  assert.match(request.json.messages[0].content[0].text, /synthetic rc5 query/u)
  assert.equal(request.json.thinking.type, 'disabled')

  assert.equal(harness.appends.length, 1)
  const event = harness.appends[0]
  assert.equal(event.type, 'web/deepseek-search-llm-request')
  assert.equal(event.data.endpoint, `${baseURL}/messages`)
  assert.equal(event.data.apiVersion, '2023-06-01')
  assert.deepEqual(event.data.body, request.json)
  assert.equal(JSON.stringify(event.data).includes(FAKE_KEY), false, 'the recorded event never carries the key')

  assert.deepEqual(result, {
    sources: [{ url: 'https://example.test/a', title: 'Synthetic result', snippet: 'synthetic snippet', publishedAt: '2026-01-01' }],
    truncated: false,
  })
})

test('T4 the default Messages endpoint does not follow the model-route gateway and performs no real I/O', { skip: SKIP }, async () => {
  const previousModelBase = process.env.DEEPSEEK_BASE_URL
  const previousSearchBase = process.env.DEEPSEEK_SEARCH_BASE_URL
  const originalFetch = globalThis.fetch
  const urls = []
  process.env.DEEPSEEK_BASE_URL = 'http://127.0.0.1:9/model-gateway/v1'
  delete process.env.DEEPSEEK_SEARCH_BASE_URL
  globalThis.fetch = async url => {
    urls.push(String(url))
    throw new Error('RC5_TRIPWIRE: no external network is permitted')
  }
  try {
    const harness = makeLegacyHarness({ baseURL: undefined })
    await assert.rejects(
      harness.provider.search({ query: 'tripwire query' }),
      error => error.code === 'WEB_PROVIDER_ERROR',
    )
    assert.deepEqual(urls, [DEFAULT_MESSAGES_ENDPOINT], 'the legacy search keeps the official endpoint')
    assert.equal(harness.appends.length, 1)
    assert.equal(harness.appends[0].data.endpoint, DEFAULT_MESSAGES_ENDPOINT)
    assert.equal(JSON.stringify(harness.appends).includes('model-gateway'), false, 'the model gateway is not reused')
    assert.equal(JSON.stringify(harness.appends).includes('127.0.0.1'), false)
  } finally {
    globalThis.fetch = originalFetch
    if (previousModelBase === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = previousModelBase
    if (previousSearchBase === undefined) delete process.env.DEEPSEEK_SEARCH_BASE_URL
    else process.env.DEEPSEEK_SEARCH_BASE_URL = previousSearchBase
  }
})

test('T5 explicit deepseek-search-api uses the route gateway origin and /v1/tools/search', { skip: SKIP }, async t => {
  const { port, requests } = await startServer(t, () => searchApiReply())
  const gatewayBase = `http://127.0.0.1:${port}/gateway/v1/tools`
  const provider = new rc5.api.DeepSeekSearchApiProvider(() => ({
    auth: { sources: [{ kind: 'api-key', baseURL: gatewayBase, key: FAKE_KEY }] },
    guidance: {
      subject: 'Search',
      plugin: 'web-deepseek-api',
      custom: false,
      baseURLField: 'searchBaseURL',
      apiKeyEnvField: 'searchApiKeyEnv',
    },
    count: 10,
    requestsPerSecond: 5,
  }))
  assert.equal(provider.id, 'deepseek-search-api')
  assert.equal(provider.available(), true)

  const web = makeWeb({ config: 'deepseek-search-api' })
  let legacySearches = 0
  web.registerSearchProvider(provider)
  web.registerSearchProvider({
    id: 'deepseek-official',
    available: () => true,
    search: async () => { legacySearches += 1; return { sources: [] } },
  })
  const result = await web.search({ query: 'api query', maxResults: 3, llmProvider: 'deepseek-official' })

  assert.equal(legacySearches, 0, 'the explicit id wins even on a DeepSeek route')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, '/gateway/v1/tools/search')
  assert.deepEqual(requests[0].json, { query: 'api query', count: 3, need_content: false })
  assert.equal(requests[0].headers.authorization, `Bearer ${FAKE_KEY}`)
  assert.deepEqual(result.sources, [{
    url: 'https://example.test/b',
    title: 'Synthetic API result',
    snippet: 'api snippet',
    summary: 'api summary',
    publishedAt: '2026-02-02',
  }])
})

test('T9 rc.5 still yields billed usage before CONTENT_REFUSED and Relay still reads it as a refusal', { skip: SKIP }, async () => {
  const { translate } = await loadTranslate()
  async function* refusalEvents() {
    yield { type: 'message_start', message: { usage: { input_tokens: 12 } } }
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'draft before refusal' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' grows' } }
    yield { type: 'content_block_stop', index: 0 }
    yield {
      type: 'message_delta',
      delta: { stop_reason: 'refusal', stop_details: { explanation: 'blocked: unauthorized use of copyrighted material' } },
      usage: { output_tokens: 5 },
    }
    yield { type: 'message_stop' }
  }

  const chunks = []
  let failure
  try {
    for await (const chunk of translate(refusalEvents(), 'deepseek-v4-flash')) chunks.push(chunk)
  } catch (error) {
    failure = error
  }

  assert.ok(failure, 'a refusal fails the stream')
  assert.equal(failure.code, 'CONTENT_REFUSED')
  assert.equal(
    failure.message,
    'DeepSeek refused to answer under its content safety review: blocked: unauthorized use of copyrighted material',
  )
  assert.deepEqual(chunks.at(-1), {
    type: 'usage',
    usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
  }, 'usage is the last chunk before the throw')
  assert.equal(chunks.filter(chunk => chunk.type === 'usage').length, 1, 'usage is not replayed twice')
  assert.equal(chunks.at(-1).type, 'usage', 'the billed usage precedes the failure')
  assert.equal(classifyAuthFailure(failure.message), undefined, 'auth-shaped explanation is still not an auth failure')
  assert.equal(isContentRefusedFailure(failure.message), true)
})

test('T8/T11 the search-request event replays without rows, stats, plan, or blank-state pollution', { skip: SKIP }, async () => {
  const { tui, agent } = makeTui()
  const event = searchRequestEvent('http://127.0.0.1:12345/anthropic/v1/messages')
  const rows = tui.rows.length
  const stats = JSON.stringify(tui.stats)
  const plan = JSON.stringify(tui.plan ?? null)

  assert.equal('usage' in event.data, false, 'the auxiliary request event carries no usage to bill')
  tui.handleSessionEvent(agent.session, event)
  assert.equal(tui.rows.length, rows, 'the event does not add a transcript row')
  assert.equal(JSON.stringify(tui.stats), stats, 'the event does not enter turn token accounting')
  assert.equal(JSON.stringify(tui.plan ?? null), plan, 'the event does not enter the plan projection')
  assert.equal(tui.stats.usage.reportedTokens, 0)
  assert.equal(sessionEventsAreBlank([event]), true, 'an auxiliary request alone still describes a blank session')

  const replay = { seq: 4, eventAt: index => (index < 4 ? event : undefined) }
  await forEachSessionEventAsync(replay, item => tui.handleSessionEvent(agent.session, item))
  assert.equal(tui.rows.length, rows, 'replaying the event adds no rows')
  assert.equal(JSON.stringify(tui.stats), stats, 'replaying the event adds no tokens')
  assert.equal(JSON.stringify(tui.plan ?? null), plan, 'replaying the event adds no plan state')

  const user = {
    type: 'user/message',
    time: event.time + 1,
    data: { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } },
  }
  assert.equal(sessionEventsAreBlank([event, user]), false, 'the same blank rule still sees real user work')
})
