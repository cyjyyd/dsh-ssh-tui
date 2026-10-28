/**
 * U1-R3 — DSH 0.2.1-rc.3 official dynamic model listing.
 *
 * These tests mount the real published rc.3 `llm-deepseek-api-key` plugin,
 * replace the process-wide `fetch` with a local responder, and use a fake
 * credential. No network request and no real API key is involved. The matrix
 * covers the official-origin/catalog gate, fallback, cache scope and the Relay
 * consumers that must stay honest about what the host actually advertised.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

import { SshTui } from '../../lib/tui.js'

const installedHost = JSON.parse(
  await readFile(new URL('../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url), 'utf8'),
).version
const RC3 = installedHost === '0.2.1-rc.3'
const rc3Test = (name, fn) => test(name, {
  skip: RC3 ? false : `requires DSH 0.2.1-rc.3 (installed ${installedHost})`,
}, fn)

const CAPABILITIES = {
  api_capabilities: { anthropic_messages: {} },
  input_modalities: ['text'],
}

function listed(id, extra = {}) {
  return { id, name: id, ...CAPABILITIES, ...extra }
}

function jsonResponse(entries, status = 200) {
  return new Response(JSON.stringify({ data: entries }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function installFetch(t, handler) {
  const original = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => { globalThis.fetch = original })
}

/** Capture the plugin's diagnostic warnings once for the whole test. */
function captureWarnings(t) {
  const warnings = []
  const original = console.warn
  console.warn = (...args) => { warnings.push(args.map(String).join(' ')) }
  t.after(() => { console.warn = original })
  return warnings
}

/** Mount the real exported rc.3 plugin against a disposable Cordis-shaped ctx. */
async function mountPlugin(t, options = {}) {
  const { Config, apply, plainOptions, resolveAdapterOptions } = await import('@deepseek-ai/dsh-llm-deepseek-api-key')
  const handlers = []
  const warnings = options.warnings ?? []
  let adapter
  let credential = options.apiKey ?? 'sk-u1r3-mock-not-a-real-key'
  const registry = {
    registerConfigurableProviders() {},
    registerAdapter(_routes, next) {
      adapter = next
      return { replace() {} }
    },
    listProviders() {
      return [{ id: 'deepseek-official', name: 'DeepSeek' }]
    },
  }
  const settings = { configure() {} }
  const ctx = {
    llm: registry,
    get(name) {
      if (name === 'llm') return registry
      if (name === 'credentials') return { resolve: async () => ({ value: credential }) }
      if (name === 'settings') return settings
      return undefined
    },
    inject(_services, fn) { fn(ctx) },
    effect() {},
    on(event, fn) { handlers.push({ event, fn }) },
    logger: { warn: message => { warnings.push(String(message)) }, info() {}, error() {} },
    fiber: { entry: { options: { id: 'u1-r3-listing-test' } } },
  }
  const config = Config({
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.modelsTimeoutMs === undefined ? {} : { modelsTimeoutMs: options.modelsTimeoutMs }),
    ...(options.modelsMaxAgeMs === undefined ? {} : { modelsMaxAgeMs: options.modelsMaxAgeMs }),
  })
  apply(ctx, config)
  assert.equal(typeof adapter?.listModels, 'function', 'the real plugin must register its adapter')
  return {
    adapter,
    config,
    registry,
    warnings,
    gate: () => resolveAdapterOptions(plainOptions(config), undefined),
    setCredential(value) { credential = value },
    write(key, value) {
      config[key][Symbol.for('cosmokit.volatile.write')](value)
    },
    update() {
      for (const { event, fn } of handlers) if (event === 'loader/volatile-update') fn()
    },
  }
}

function makeTui(llm) {
  const ctx = {
    get(name) { return name === 'llm' ? llm : undefined },
    on() { return () => {} },
  }
  const selectionRef = { current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' } }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session', color: false, selectionRef })
}

rc3Test('official origin plus built-in catalog fetches /models once and offers listed entries', async t => {
  const warnings = captureWarnings(t)
  const calls = []
  installFetch(t, async (url, init) => {
    calls.push({ url: String(url), init })
    return jsonResponse([
      listed('deepseek-v4-pro'),
      // A listing row this build does not know and that declares no client
      // requirement must stay hidden, not become selectable by accident.
      listed('deepseek-v4.1-flash'),
      listed('deepseek-new-preview', {
        client_requirements: { 'deepseek-harness': { min_version: '0.2.1-rc.2' } },
      }),
      // A listed model this client cannot serve must stay out of the picker,
      // whether the refusal is a newer client requirement or unusable output.
      listed('deepseek-needs-upgrade', {
        client_requirements: { 'deepseek-harness': { min_version: '99.0.0' } },
      }),
      listed('image-only', { output_modalities: ['image'] }),
    ])
  })
  const { adapter, gate } = await mountPlugin(t, { warnings })
  assert.deepEqual(gate().listing, {
    url: 'https://api.deepseek.com/models',
    timeoutMs: 5000,
    maxAgeMs: 600000,
  })
  const models = await adapter.listModels('deepseek-official')
  assert.deepEqual(models.map(model => model.id), ['deepseek-v4-pro', 'deepseek-new-preview'])
  assert.equal(models.some(model => model.id === 'deepseek-needs-upgrade'), false)
  assert.equal(models.some(model => model.id === 'image-only'), false)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/models')
  assert.equal(calls[0].init.method, 'GET')
  assert.equal(calls[0].init.redirect, 'error')
  assert.equal(calls[0].init.headers['x-api-key'], 'sk-u1r3-mock-not-a-real-key')
})

rc3Test('custom baseURL and custom catalog never issue an external /models request', async t => {
  const warnings = captureWarnings(t)
  let calls = 0
  installFetch(t, async () => { calls += 1; throw new Error('fetch must not run') })

  const customEndpoint = await mountPlugin(t, { warnings, baseURL: 'https://gateway.example.test/anthropic' })
  assert.equal(customEndpoint.gate().listing, undefined)
  const endpointModels = await customEndpoint.adapter.listModels('deepseek-official')
  assert.deepEqual(endpointModels.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(calls, 0)

  const customCatalog = await mountPlugin(t, { warnings, models: [{ id: 'private-model' }] })
  assert.equal(customCatalog.gate().listing, undefined)
  const catalogModels = await customCatalog.adapter.listModels('deepseek-official')
  assert.deepEqual(catalogModels.map(model => model.id), ['private-model'])
  assert.equal(calls, 0)
})

rc3Test('a first-load timeout falls back to the bundled catalog without throwing', async t => {
  const warnings = captureWarnings(t)
  let calls = 0
  installFetch(t, (_url, init) => {
    calls += 1
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
  })
  const { adapter } = await mountPlugin(t, { warnings, modelsTimeoutMs: 25 })
  const started = performance.now()
  const models = await adapter.listModels('deepseek-official')
  const elapsed = performance.now() - started
  assert.equal(calls, 1)
  assert.ok(elapsed >= 10, `timeout fired too early: ${elapsed}ms`)
  assert.ok(elapsed < 2000, `timeout took too long: ${elapsed}ms`)
  assert.deepEqual(models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.ok(warnings.some(message => message.includes('using the bundled catalog')), warnings.join('\n'))
})

rc3Test('non-2xx and malformed first loads fall back to the bundled catalog', async t => {
  const warnings = captureWarnings(t)
  for (const failure of ['http-500', 'malformed']) {
    let calls = 0
    installFetch(t, async () => {
      calls += 1
      if (failure === 'http-500') return new Response('server error', { status: 500 })
      return new Response('not json', { status: 200 })
    })
    const { adapter } = await mountPlugin(t, { warnings })
    const models = await adapter.listModels('deepseek-official')
    assert.equal(calls, 1, failure)
    assert.deepEqual(models.map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'], failure)
    assert.ok(warnings.some(message => message.includes('using the bundled catalog')), `${failure}: ${warnings.join('\n')}`)
  }
})

rc3Test('a failed refresh keeps the last known good listing', async t => {
  const warnings = captureWarnings(t)
  let phase = 'good'
  let calls = 0
  installFetch(t, async () => {
    calls += 1
    if (phase === 'good') {
      return jsonResponse([
        listed('stable-model', {
          client_requirements: { 'deepseek-harness': { min_version: '0.2.1-rc.2' } },
        }),
      ])
    }
    return new Response('server error', { status: 503 })
  })
  const { adapter, config, update } = await mountPlugin(t, { warnings, modelsMaxAgeMs: 600000 })
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['stable-model'])

  phase = 'fail'
  config.modelsMaxAgeMs[Symbol.for('cosmokit.volatile.write')](0)
  update()
  // The stale view is returned at once; the refresh runs in the background.
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['stable-model'])
  for (let index = 0; index < 20 && calls < 2; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(calls, 2)
  await new Promise(resolve => setImmediate(resolve))
  config.modelsMaxAgeMs[Symbol.for('cosmokit.volatile.write')](600000)
  update()
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['stable-model'])
  assert.ok(warnings.some(message => message.includes('keeping the previous catalog')), warnings.join('\n'))
})

rc3Test('restoring the default catalog invalidates the cache and loads again', async t => {
  const warnings = captureWarnings(t)
  let phase = 'default-a'
  let calls = 0
  installFetch(t, async () => {
    calls += 1
    const id = phase === 'default-a' ? 'model-a' : 'model-b'
    return jsonResponse([
      listed(id, { client_requirements: { 'deepseek-harness': { min_version: '0.2.1-rc.2' } } }),
    ])
  })
  const { adapter, config, update } = await mountPlugin(t, { warnings })
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['model-a'])
  assert.equal(calls, 1)

  config.baseURL[Symbol.for('cosmokit.volatile.write')]('https://gateway.example.test/anthropic')
  update()
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['deepseek-flash', 'deepseek-v4-pro'])
  assert.equal(calls, 1, 'a custom endpoint must not fetch')

  phase = 'default-b'
  config.baseURL[Symbol.for('cosmokit.volatile.write')]('https://api.deepseek.com/anthropic')
  update()
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['model-b'])
  assert.equal(calls, 2, 'restoring the default must reload instead of reusing the old scope')
})

rc3Test('cache scopes are separated by credential and endpoint', async t => {
  const warnings = captureWarnings(t)
  let key = 'key-a'
  let calls = 0
  installFetch(t, async (_url, init) => {
    calls += 1
    const id = init.headers['x-api-key'] === 'key-a' ? 'model-a' : 'model-b'
    return jsonResponse([
      listed(id, { client_requirements: { 'deepseek-harness': { min_version: '0.2.1-rc.2' } } }),
    ])
  })
  const { adapter, setCredential } = await mountPlugin(t, { warnings })
  setCredential('key-a')
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['model-a'])
  setCredential('key-b')
  assert.deepEqual((await adapter.listModels('deepseek-official')).map(model => model.id), ['model-b'])
  assert.equal(calls, 2)

  const { ModelListingCache } = await import('@deepseek-ai/dsh-llm-deepseek')
  const loads = []
  const cache = new ModelListingCache({
    credential: async url => (url.includes('one') ? 'key-one' : 'key-two'),
    load: async url => {
      loads.push(url)
      return { entries: [{ id: url.includes('one') ? 'one-model' : 'two-model' }], skipped: 0 }
    },
    now: () => 0,
    info() {},
    warn() {},
  })
  const one = await cache.view({ url: 'https://one.example.test/models', timeoutMs: 100, maxAgeMs: 1000 })
  const two = await cache.view({ url: 'https://two.example.test/models', timeoutMs: 100, maxAgeMs: 1000 })
  assert.equal(loads.length, 2)
  assert.equal(one.listing.entries[0].id, 'one-model')
  assert.equal(two.listing.entries[0].id, 'two-model')
  cache.dispose()
})

rc3Test('Relay /model and /submodel consume the listed catalog while /doctor only reports registration', async t => {
  const warnings = captureWarnings(t)
  installFetch(t, async () => jsonResponse([
    listed('deepseek-v4-pro'),
    listed('deepseek-new-preview', {
      client_requirements: { 'deepseek-harness': { min_version: '0.2.1-rc.2' } },
    }),
  ]))
  const { adapter, registry } = await mountPlugin(t, { warnings })
  let listModelsCalls = 0
  const llm = {
    listModels: async provider => {
      listModelsCalls += 1
      return adapter.listModels(provider)
    },
    listProviders: () => registry.listProviders(),
  }
  const tui = makeTui(llm)

  const parent = await tui.loadModelOptions('deepseek-official')
  assert.deepEqual(parent.options.map(option => option.id), ['deepseek-v4-pro', 'deepseek-new-preview'])
  const subagent = await tui.subagentModelOptions('deepseek-official')
  assert.deepEqual(subagent.options.map(option => option.id), ['deepseek-v4-pro', 'deepseek-new-preview'])

  const callsBeforeDoctor = listModelsCalls
  const routing = tui.doctorRouting()
  assert.equal(listModelsCalls, callsBeforeDoctor, '/doctor must not query live model membership')
  assert.deepEqual(routing?.routes, ['deepseek-official'])
  assert.deepEqual(routing?.routeModels, [])
})

rc3Test('the /model picker offers the listed catalog and files the picked model', async t => {
  const warnings = captureWarnings(t)
  installFetch(t, async () => jsonResponse([
    listed('deepseek-v4-pro', { name: 'V4 Pro' }),
    listed('deepseek-listed-new', {
      name: 'Listed New',
      client_requirements: { 'deepseek-harness': { min_version: '0.2.1-rc.2' } },
      context_window: 2000000,
    }),
  ]))
  const { adapter, registry } = await mountPlugin(t, { warnings })
  const llm = {
    listModels: async provider => adapter.listModels(provider),
    listProviders: () => registry.listProviders(),
  }
  const tui = makeTui(llm)
  const asked = []
  tui.askQuestion = async question => {
    asked.push(question)
    if (question.id === 'model-pick') {
      return { selected: [question.options.find(option => option.label === 'Listed New').label] }
    }
    if (question.id === 'effort-pick') return { selected: [question.options[0].label] }
    return { selected: [] }
  }
  tui.runCommand('/model')
  // The command dispatches its picker behind a detached promise, so wait for
  // the selection to settle instead of racing it.
  for (let index = 0; index < 100 && tui.selectionRef?.current?.model !== 'deepseek-listed-new'; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
  }

  const picker = asked.find(question => question.id === 'model-pick')
  assert.ok(picker, 'the /model picker must open')
  assert.deepEqual(picker.options.map(option => option.label), ['V4 Pro', 'Listed New'])
  assert.match(picker.question, /已配置列表|配置/u, picker.question)
  assert.equal(tui.selectionRef?.current?.model, 'deepseek-listed-new')
  assert.equal(tui.selectionRef?.current?.provider, 'deepseek-official')
})
