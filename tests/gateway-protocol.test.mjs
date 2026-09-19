import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GATEWAY_PROTOCOL_ENDPOINT,
  GATEWAY_PROTOCOL_PREFERENCE,
  ZEN_GO_MODEL_PROTOCOLS,
  advertisedProtocols,
  baseProviderIdOf,
  declaredProtocol,
  endpointProtocol,
  gatewayModelTable,
  gatewayServesModel,
  isSiblingOf,
  resolveModelProtocol,
  siblingProtocolOf,
  siblingProviderId,
  splitModelsByProtocol,
} from '../lib/gateway-protocol.js'

/**
 * One gateway expands into one provider entry per protocol, because
 * `llm-pi-ai` keeps `api` on the provider. These cover the naming and the
 * "which route does this model actually speak" decision.
 */

test('endpoint strings map to protocols, and unknown ones map to nothing', () => {
  assert.equal(endpointProtocol('/responses'), 'openai-responses')
  assert.equal(endpointProtocol('/chat/completions'), 'openai-completions')
  assert.equal(endpointProtocol('/messages'), 'anthropic-messages')
  assert.equal(endpointProtocol('/responses/'), 'openai-responses')
  assert.equal(endpointProtocol('https://api.commandcode.ai/provider/v1/chat/completions'), 'openai-completions')
  assert.equal(endpointProtocol('/embeddings'), null)
  assert.equal(endpointProtocol(''), null)
})

test('sibling ids round-trip and only match their own base', () => {
  assert.equal(siblingProviderId('command-code', 'openai-responses'), 'command-code-responses')
  assert.equal(siblingProviderId('opencode-go', 'anthropic-messages'), 'opencode-go-messages')
  assert.equal(siblingProtocolOf('command-code-responses'), 'openai-responses')
  assert.equal(siblingProtocolOf('command-code-messages'), 'anthropic-messages')
  assert.equal(siblingProtocolOf('command-code'), null)
  assert.equal(siblingProtocolOf('opencode-go'), null)
  assert.equal(isSiblingOf('command-code', 'command-code-responses'), true)
  assert.equal(isSiblingOf('command-code', 'command-code'), false)
  assert.equal(isSiblingOf('command-code', 'command-code-other'), false)
  // A longer base must not claim a shorter one's siblings.
  assert.equal(isSiblingOf('command-code-res', 'command-code-responses'), false)
})

test('a gateway that publishes its routes decides, by preference order', () => {
  // Listed chat-first, still filed under responses: preference beats order.
  assert.equal(
    resolveModelProtocol({ advertised: ['/chat/completions', '/responses'], fallback: 'openai-completions' }),
    'openai-responses',
  )
  assert.equal(resolveModelProtocol({ advertised: ['/messages'], fallback: 'openai-responses' }), 'anthropic-messages')
  // Nothing recognised in the payload falls through to the table, then the gateway.
  assert.equal(resolveModelProtocol({ advertised: ['/embeddings'], table: 'openai-completions', fallback: 'openai-responses' }), 'openai-completions')
  assert.equal(resolveModelProtocol({ table: 'anthropic-messages', fallback: 'openai-responses' }), 'anthropic-messages')
  assert.equal(resolveModelProtocol({ fallback: 'openai-completions' }), 'openai-completions')
  // An explicit preference is honoured instead of the default one.
  assert.equal(
    resolveModelProtocol({ advertised: ['/responses', '/chat/completions'], fallback: 'openai-responses', preference: ['openai-completions'] }),
    'openai-completions',
  )
  assert.deepEqual([...GATEWAY_PROTOCOL_PREFERENCE], ['openai-responses', 'openai-completions', 'anthropic-messages'])
})

test('a working placement is kept unless the gateway itself moves the model', () => {
  // The gateway publishes nothing (Zen): the table must not relocate a model
  // that is already configured on a route that works.
  assert.equal(
    resolveModelProtocol({ existing: 'openai-responses', table: 'openai-completions', fallback: 'openai-completions' }),
    'openai-responses',
  )
  // Still advertised, and the existing route is one of the advertised ones.
  assert.equal(
    resolveModelProtocol({ existing: 'openai-completions', advertised: ['/chat/completions', '/responses'], fallback: 'openai-responses' }),
    'openai-completions',
  )
  // The gateway dropped that route: the advertisement wins and the model moves.
  assert.equal(
    resolveModelProtocol({ existing: 'openai-responses', advertised: ['/chat/completions'], fallback: 'openai-responses' }),
    'openai-completions',
  )
  // Advertised, existing route not among them, and nothing in the preference
  // list matches either: the table still has the last word over the fallback.
  assert.equal(
    resolveModelProtocol({ existing: 'openai-completions', advertised: ['/messages'], table: 'anthropic-messages', fallback: 'openai-responses' }),
    'anthropic-messages',
  )
  // A model with no placement at all still follows the table.
  assert.equal(
    resolveModelProtocol({ table: 'openai-completions', fallback: 'openai-responses' }),
    'openai-completions',
  )
})

test('one gateway splits into per-protocol model lists', () => {
  const split = splitModelsByProtocol({
    models: ['alpha', 'beta', 'gamma', 'delta', ''],
    advertised: new Map([
      ['alpha', ['/responses', '/chat/completions']],
      ['beta', ['/chat/completions']],
      ['gamma', ['/messages']],
    ]),
    table: { delta: 'openai-completions' },
    fallback: 'openai-responses',
  })
  assert.deepEqual(split.get('openai-responses'), ['alpha'])
  assert.deepEqual(split.get('openai-completions'), ['beta', 'delta'])
  assert.deepEqual(split.get('anthropic-messages'), ['gamma'])
  assert.equal(split.size, 3)
})

test('re-running the split keeps every model where it already is', () => {
  const split = splitModelsByProtocol({
    models: ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'glm-5.3', 'kimi-k3'],
    existing: new Map([
      ['deepseek-v4-flash', 'openai-responses'],
      ['deepseek-v4-flash-vision-exp', 'openai-responses'],
    ]),
    table: {
      'deepseek-v4-flash': 'openai-responses',
      'deepseek-v4-flash-vision-exp': 'openai-responses',
      'glm-5.3': 'openai-completions',
      'kimi-k3': 'openai-completions',
    },
    fallback: 'openai-responses',
  })
  assert.deepEqual(split.get('openai-responses'), ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp'])
  assert.deepEqual(split.get('openai-completions'), ['glm-5.3', 'kimi-k3'])
})

test('unadvertised models land on the gateway fallback, never nowhere', () => {
  const split = splitModelsByProtocol({ models: ['unknown-1', 'unknown-2'], fallback: 'openai-completions' })
  assert.deepEqual(split.get('openai-completions'), ['unknown-1', 'unknown-2'])
  assert.equal(split.size, 1)
})

test('the Go table covers the published routes and keeps the verified override', () => {
  const protocols = new Set(Object.values(ZEN_GO_MODEL_PROTOCOLS))
  for (const protocol of protocols) {
    assert.ok(GATEWAY_PROTOCOL_PREFERENCE.includes(protocol), `unexpected protocol ${protocol}`)
  }
  for (const model of Object.keys(ZEN_GO_MODEL_PROTOCOLS)) {
    assert.match(model, /^[a-z0-9][a-z0-9.-]*$/u, model)
  }
  // The whole DeepSeek family answers /responses on Go (verified against the
  // live gateway; the docs still list it under chat), so the wizard never moves
  // the models the pinned template already ships there.
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4.1-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.equal(ZEN_GO_MODEL_PROTOCOLS[model], 'openai-responses', model)
  }
  // Documented as chat / Anthropic-shaped respectively.
  assert.equal(ZEN_GO_MODEL_PROTOCOLS['glm-5.3'], 'openai-completions')
  assert.equal(ZEN_GO_MODEL_PROTOCOLS['minimax-m3'], 'anthropic-messages')
  assert.equal(ZEN_GO_MODEL_PROTOCOLS['qwen3.8-flash'], 'anthropic-messages')
})

test('the built-in table is chosen by gateway, and only where we have one', () => {
  assert.equal(gatewayModelTable('https://opencode.ai/zen/go/v1'), ZEN_GO_MODEL_PROTOCOLS)
  // Command Code advertises its own endpoints, so it needs no table.
  assert.equal(gatewayModelTable('https://api.commandcode.ai/provider/v1'), undefined)
  assert.equal(gatewayModelTable('https://opencode.ai/zen/v1'), undefined)
})

test('a row only offers what its own protocol serves', () => {
  // The live Command Code shape: `deepseek/deepseek-v4.1-flash` answers chat and
  // responses, never messages.
  const endpoints = new Map([
    ['deepseek/deepseek-v4.1-flash', ['/chat/completions', '/responses']],
    ['claude-sonnet-5', ['/messages']],
    ['Qwen/Qwen3.8-Flash', ['/chat/completions']],
  ])
  assert.equal(gatewayServesModel(endpoints, 'deepseek/deepseek-v4.1-flash', 'anthropic-messages'), false)
  assert.equal(gatewayServesModel(endpoints, 'deepseek/deepseek-v4.1-flash', 'openai-completions'), true)
  assert.equal(gatewayServesModel(endpoints, 'deepseek/deepseek-v4.1-flash', 'openai-responses'), true)
  assert.equal(gatewayServesModel(endpoints, 'claude-sonnet-5', 'anthropic-messages'), true)
  assert.equal(gatewayServesModel(endpoints, 'claude-sonnet-5', 'openai-responses'), false)
  // Silence never blocks: a model the gateway does not describe, a gateway that
  // describes nothing, and a row with no protocol all pass.
  assert.equal(gatewayServesModel(endpoints, 'unknown-model', 'anthropic-messages'), true)
  assert.equal(gatewayServesModel(endpoints, 'claude-sonnet-5', undefined), true)
  assert.equal(gatewayServesModel(undefined, 'claude-sonnet-5', 'anthropic-messages'), true)
  // An explicit list that names no route this row speaks is a refusal, even
  // when the endpoints themselves are ones we do not model.
  assert.equal(gatewayServesModel(new Map([['x', ['/embeddings']]]), 'x', 'anthropic-messages'), false)
  assert.deepEqual(advertisedProtocols(endpoints, 'deepseek/deepseek-v4.1-flash'), ['openai-responses', 'openai-completions'])
  assert.deepEqual(advertisedProtocols(endpoints, 'nope'), [])
})

test('sibling ids can be traced back to their gateway', () => {
  assert.equal(baseProviderIdOf('command-code-messages'), 'command-code')
  assert.equal(baseProviderIdOf('command-code-responses'), 'command-code')
  assert.equal(baseProviderIdOf('command-code'), 'command-code')
  // A gateway whose own name ends in a protocol-ish word is not a sibling.
  assert.equal(baseProviderIdOf('opencode-go'), 'opencode-go')
  assert.equal(baseProviderIdOf('google-ai-pro'), 'google-ai-pro')
  assert.equal(declaredProtocol('anthropic-messages'), 'anthropic-messages')
  assert.equal(declaredProtocol('openai-completions'), 'openai-completions')
  assert.equal(declaredProtocol('gemini'), undefined)
  assert.equal(declaredProtocol(undefined), undefined)
  assert.deepEqual(GATEWAY_PROTOCOL_ENDPOINT, {
    'openai-responses': '/responses',
    'openai-completions': '/chat/completions',
    'anthropic-messages': '/messages',
  })
})

test('a row refuses to persist a model the gateway serves on another route', async () => {
  const { SshTui } = await import('../lib/tui.js')
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async input => {
    const url = String(input)
    seen.push(url)
    if (url.endsWith('/models')) {
      return new Response(JSON.stringify({
        data: [
          { id: 'deepseek/deepseek-v4.1-flash', supported_endpoints: ['/chat/completions', '/responses'] },
          { id: 'claude-sonnet-5', supported_endpoints: ['/messages'] },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 404 })
  }
  try {
    const base = { baseURL: 'https://api.commandcode.ai/provider/v1', apiKeyEnv: 'COMMAND_CODE_API_KEY' }
    const profiles = {
      'command-code': { ...base, api: 'openai-completions', models: [] },
      'command-code-responses': { ...base, api: 'openai-responses', models: [{ id: 'deepseek/deepseek-v4.1-flash' }] },
      'command-code-messages': { ...base, api: 'anthropic-messages', models: [] },
    }
    const writes = []
    const settings = {
      get: ns => (ns === 'llm-pi-ai' ? { providers: profiles } : undefined),
      mutate: async (ns, ops) => { writes.push({ ns, ops }) },
    }
    const credentials = { resolve: async () => ({ value: 'cc-test-key' }) }
    const ctx = {
      get: name => (name === 'settings' ? settings : name === 'credentials' ? credentials : undefined),
      on() { return () => {} },
    }
    const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
    const tui = new SshTui(ctx, agent, { sessionId: 's', color: false })

    // The Anthropic row cannot serve it, so nothing is written and the message
    // names both the row it actually is and the family `/provider` offers — the
    // old copy sent the user to a sibling row the picker deliberately hides.
    assert.equal(await tui.ensureProviderModelConfigured('command-code-messages', 'deepseek/deepseek-v4.1-flash'), false)
    assert.deepEqual(writes, [])
    const refusal = tui.rows.at(-1)?.text ?? ''
    assert.match(refusal, /command-code-messages/u, 'the row the request was made on')
    assert.match(refusal, /command-code/u, 'and the family to pick')
    assert.doesNotMatch(refusal, /\/provider 切过去/u, 'no dead end pointing at a hidden row')

    // A model the row does serve still goes through, and an unlisted model is
    // never blocked by silence.
    assert.equal(await tui.ensureProviderModelConfigured('command-code-messages', 'claude-sonnet-5'), true)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].ops[0].path.join('.'), 'providers.command-code-messages.models')
    // The Anthropic row declares no vocabulary; a completions row without a
    // route default still declares the levels the dialect offers.
    assert.equal(writes[0].ops[0].value[0].reasoningEfforts, undefined)
    assert.equal(await tui.ensureProviderModelConfigured('command-code', 'gpt-5.6-sol'), true)
    assert.deepEqual(writes.at(-1).ops[0].value.at(-1).reasoningEfforts, {
      off: null, low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh',
    })
    assert.equal(await tui.ensureProviderModelConfigured('command-code-messages', 'not-listed-anywhere'), true)
    assert.ok(seen.some(url => url.endsWith('/models')))
  } finally {
    globalThis.fetch = original
  }
})
