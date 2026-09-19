import test from 'node:test'
import assert from 'node:assert/strict'

import {
  GATEWAY_PROTOCOL_PREFERENCE,
  ZEN_GO_MODEL_PROTOCOLS,
  endpointProtocol,
  gatewayModelTable,
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
  // Verified against the live gateway (docs still list them under chat).
  assert.equal(ZEN_GO_MODEL_PROTOCOLS['deepseek-v4-flash'], 'openai-responses')
  assert.equal(ZEN_GO_MODEL_PROTOCOLS['deepseek-v4-pro'], 'openai-responses')
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
