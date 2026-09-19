import test from 'node:test'
import assert from 'node:assert/strict'

import { SshTui } from '../lib/tui.js'

/**
 * One gateway, one provider — in the TUI.
 *
 * `llm-pi-ai` puts the wire protocol on the provider entry, so Command Code and
 * OpenCode Go are stored as sibling rows (`command-code`,
 * `command-code-completions`, `command-code-messages`). The user must never be
 * asked to choose between them: the pickers list the family once, the model
 * list is the union of its rows, and a pick is filed on the row that actually
 * serves it.
 */

const COMMAND_CODE = {
  providers: {
    'command-code': {
      displayName: 'Command Code',
      api: 'openai-responses',
      apiKeyEnv: 'COMMAND_CODE_API_KEY',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      models: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'gpt-5.6-sol' }],
    },
    'command-code-completions': {
      displayName: 'Command Code',
      api: 'openai-completions',
      apiKeyEnv: 'COMMAND_CODE_API_KEY',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      models: [{ id: 'z-ai/glm-5.3-flash' }],
    },
    'command-code-messages': {
      displayName: 'Command Code',
      api: 'anthropic-messages',
      apiKeyEnv: 'COMMAND_CODE_API_KEY',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      models: [{ id: 'claude-sonnet-5' }],
    },
  },
}

const LIVE_LISTING = {
  data: [
    { id: 'deepseek/deepseek-v4.1-flash', supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'gpt-5.6-sol', supported_endpoints: ['/responses'] },
    { id: 'z-ai/glm-5.3-flash', supported_endpoints: ['/chat/completions'] },
    { id: 'claude-sonnet-5', supported_endpoints: ['/messages'] },
  ],
}

function makeTui({ section = COMMAND_CODE, llm, selection } = {}) {
  const writes = []
  const settings = {
    get: ns => (ns === 'llm-pi-ai' ? section : undefined),
    mutate: async (ns, ops) => { writes.push({ op: 'mutate', ns, ops }) },
    replace: async (ns, value) => { writes.push({ op: 'replace', ns, value }) },
    update: async (ns, value) => { writes.push({ op: 'update', ns, value }) },
  }
  const credentials = { resolve: async () => ({ value: 'sk-test' }) }
  const services = { settings, credentials, ...(llm === undefined ? {} : { llm }) }
  const ctx = { get: name => services[name], on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const changed = []
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color: false,
    ...(selection === undefined ? {} : { selectionRef: { current: selection } }),
    onSelectionChanged: next => changed.push(next),
  })
  return { tui, writes, changed }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

test('a gateway spread over protocol rows is listed once', () => {
  const llm = { listProviders: () => [
    { id: 'command-code', name: 'Command Code' },
    { id: 'command-code-completions', name: 'Command Code' },
    { id: 'command-code-messages', name: 'Command Code' },
  ] }
  const { tui } = makeTui({ llm })
  const ids = tui.listSelectableProviders().map(option => option.id)
  assert.ok(ids.includes('command-code'), `the family base must be listed: ${ids}`)
  assert.ok(!ids.includes('command-code-completions'), `siblings must stay hidden: ${ids}`)
  assert.ok(!ids.includes('command-code-messages'), `siblings must stay hidden: ${ids}`)
})

test('a lone sibling whose base row is missing stays its own provider', () => {
  const llm = { listProviders: () => [{ id: 'acme-messages', name: 'Acme' }] }
  const { tui } = makeTui({ section: { providers: {
    'acme-messages': { api: 'anthropic-messages', baseURL: 'https://acme.example/v1', models: [{ id: 'm' }] },
  } }, llm })
  const ids = tui.listSelectableProviders().map(option => option.id)
  assert.ok(ids.includes('acme-messages'), `nothing to merge it with: ${ids}`)
})

test('a protocol-word suffix alone does not make another vendor a sibling', () => {
  // `-messages` is only a naming convention. A provider someone actually named
  // `foo-messages`, pointing at another host, must not be absorbed by `foo`: it
  // would disappear from /provider and its requests would be reported (and
  // routed) as `foo`'s.
  const llm = { listProviders: () => [
    { id: 'foo', name: 'Foo' },
    { id: 'foo-messages', name: 'Other Vendor' },
  ] }
  const { tui } = makeTui({ section: { providers: {
    foo: {
      displayName: 'Foo',
      api: 'openai-responses',
      baseURL: 'https://foo.example/v1',
      models: [{ id: 'foo-model' }],
    },
    'foo-messages': {
      displayName: 'Other Vendor',
      api: 'anthropic-messages',
      baseURL: 'https://totally-other.example/v1',
      models: [{ id: 'other-model' }],
    },
  } }, llm })

  assert.deepEqual(tui.providerFamilyRows('foo'), ['foo'])
  assert.equal(tui.displayProviderId('foo-messages'), 'foo-messages')
  const ids = tui.listSelectableProviders().map(option => option.id)
  assert.ok(ids.includes('foo'), ids)
  assert.ok(ids.includes('foo-messages'), `the unrelated vendor must stay listed: ${ids}`)
})

test('a sibling that agrees on protocol, endpoint and label still merges', () => {
  const llm = { listProviders: () => [
    { id: 'gw', name: 'Acme' },
    { id: 'gw-completions', name: 'Acme' },
  ] }
  const { tui } = makeTui({ section: { providers: {
    gw: {
      displayName: 'Acme',
      api: 'openai-responses',
      baseURL: 'https://acme.example/v1',
      models: [{ id: 'a' }],
    },
    'gw-completions': {
      displayName: 'Acme',
      api: 'openai-completions',
      baseURL: 'https://acme.example/v1/',
      models: [{ id: 'b' }],
    },
  } }, llm })
  assert.deepEqual(tui.providerFamilyRows('gw'), ['gw', 'gw-completions'])
  assert.deepEqual(
    tui.listSelectableProviders().map(option => option.id).filter(id => id.startsWith('gw')),
    ['gw'],
  )
})

test('a row whose api contradicts its suffix is not adopted', () => {
  // `gw-messages` that actually speaks Completions is a misnamed hand-written
  // row, not the family's Messages arm.
  const { tui } = makeTui({ section: { providers: {
    gw: { api: 'openai-responses', baseURL: 'https://acme.example/v1', models: [{ id: 'a' }] },
    'gw-messages': { api: 'openai-completions', baseURL: 'https://acme.example/v1', models: [{ id: 'b' }] },
  } } })
  assert.deepEqual(tui.providerFamilyRows('gw'), ['gw'])
})

test('the family model list is the union of its rows', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(LIVE_LISTING), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  try {
    const llm = { discoverModels: async () => [] }
    const { tui } = makeTui({ llm })
    const { options } = await tui.loadModelOptions('command-code')
    const ids = options.map(option => option.id)
    assert.deepEqual(new Set(ids), new Set([
      'deepseek/deepseek-v4.1-flash',
      'gpt-5.6-sol',
      'z-ai/glm-5.3-flash',
      'claude-sonnet-5',
    ]))
    // Each model remembered the row that offered it, which is what routes the
    // pick back to a protocol that can send it.
    assert.equal(tui.familyModelOwner.get('command-code\u0000claude-sonnet-5'), 'command-code-messages')
    assert.equal(tui.familyModelOwner.get('command-code\u0000z-ai/glm-5.3-flash'), 'command-code-completions')
    assert.equal(tui.familyModelOwner.get('command-code\u0000gpt-5.6-sol'), 'command-code')
  } finally {
    globalThis.fetch = original
  }
})

test('the row a live listing named wins over a stale row that still lists the model', () => {
  // deepseek/deepseek-v4.1-flash answers both routes, so an earlier setup left
  // it on the responses row. When the gateway has since been listed as
  // chat-only for that id, an explicit `/model <id>` must follow the listing —
  // not the leftover configuration, which is what "first row that configures
  // it" used to return.
  const { tui } = makeTui({ section: { providers: {
    'command-code': {
      api: 'openai-responses',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      models: [{ id: 'deepseek/deepseek-v4.1-flash' }],
    },
    'command-code-completions': {
      api: 'openai-completions',
      baseURL: 'https://api.commandcode.ai/provider/v1',
      models: [],
    },
  } } })
  assert.equal(
    tui.familyOwnerRow('command-code', 'deepseek/deepseek-v4.1-flash'),
    'command-code',
    'with no listing, the configured placement stands',
  )
  tui.familyModelOwner.set('command-code\u0000deepseek/deepseek-v4.1-flash', 'command-code-completions')
  assert.equal(
    tui.familyOwnerRow('command-code', 'deepseek/deepseek-v4.1-flash'),
    'command-code-completions',
    'the row the listing named wins',
  )
})

test('the endpoint listing beats a leftover row for the same model', async () => {
  // The base row still carries a model the gateway now serves on another
  // protocol. The picker must both list and route it to the sibling, otherwise
  // the next `/model` on that id writes it back onto the wrong protocol.
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [{
    id: 'z-ai/glm-5.3-flash',
    supported_endpoints: ['/chat/completions'],
  }] }), { status: 200, headers: { 'content-type': 'application/json' } })
  try {
    const llm = { discoverModels: async () => [] }
    const { tui } = makeTui({ section: { providers: {
      // The leftover: the model is configured on the responses row.
      'command-code': {
        api: 'openai-responses',
        apiKeyEnv: 'COMMAND_CODE_API_KEY',
        baseURL: 'https://api.commandcode.ai/provider/v1',
        models: [{ id: 'z-ai/glm-5.3-flash' }],
      },
      'command-code-completions': {
        api: 'openai-completions',
        apiKeyEnv: 'COMMAND_CODE_API_KEY',
        baseURL: 'https://api.commandcode.ai/provider/v1',
        models: [],
      },
    } }, llm })
    const { options } = await tui.loadModelOptions('command-code')
    assert.deepEqual(options.map(option => option.id), ['z-ai/glm-5.3-flash'])
    assert.equal(
      tui.familyModelOwner.get('command-code\u0000z-ai/glm-5.3-flash'),
      'command-code-completions',
      'the sibling the gateway named, not the row it happens to sit on',
    )
    assert.equal(tui.familyOwnerRow('command-code', 'z-ai/glm-5.3-flash'), 'command-code-completions')
  } finally {
    globalThis.fetch = original
  }
})

test('a pick is saved on the row that serves the model, remembered on the base', async () => {
  const original = globalThis.fetch
  // Selecting a model asks the gateway which protocol serves it, so the pick
  // lands on a row that can send it even when nothing listed it yet.
  globalThis.fetch = async () => new Response(JSON.stringify(LIVE_LISTING), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
  const llm = {
    discoverModels: async () => [],
    resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
  }
  try {
  const { tui, writes, changed } = makeTui({ llm, selection: { provider: 'command-code', model: 'gpt-5.6-sol' } })

  const pending = tui.applyModelSelection('command-code', 'claude-sonnet-5')
  await tick()
  tui.handleDialogChar('\r')
  await pending

  assert.equal(changed.at(-1)?.provider, 'command-code-messages')
  assert.equal(changed.at(-1)?.model, 'claude-sonnet-5')
  const saved = writes.find(entry => entry.op === 'replace' && entry.ns === 'agent-default-model')
  assert.equal(saved?.value.provider, 'command-code-messages')
  // The route memory is keyed by what the user picked from, so `/provider`
  // offers the gateway once and prefills the model they last used.
  const memory = writes.find(entry => entry.op === 'mutate' && entry.ns === 'ssh-tui-routes')
  assert.deepEqual(Object.keys(memory?.ops[0].value ?? {}), ['command-code'])
  } finally {
    globalThis.fetch = original
  }
})

test('the wizard picker decides the set and the session model, not the listing', () => {
  const { tui } = makeTui()
  tui.onboarding = {
    step: 'models',
    providerType: 'command-code',
    providerId: 'command-code',
    baseUrl: '',
    key: 'k',
    models: ['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5', 'z-ai/glm-5.3-flash'],
    modelCapacity: new Map(),
    catalogPresets: undefined,
    catalog: undefined,
    providerCursor: 0,
    saving: false,
    resolve() {},
  }
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'models-pick')
  // Only the template's pinned model is checked; the listing only offers more.
  assert.deepEqual([...tui.onboarding.modelChecked], [0])
  // '2' toggles the second row in (space toggles the highlighted one, which is
  // the model the template already checked).
  tui.handleOnboardingChar('2')
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'model-default')
  assert.deepEqual(tui.onboarding.models, ['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5'])
  tui.handleOnboardingChar('2')
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.defaultModel, 'claude-sonnet-5')
  assert.deepEqual(tui.onboarding.models, ['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5'])
})

test('an empty pick is refused instead of silently configuring nothing', () => {
  const { tui } = makeTui()
  tui.onboarding = {
    step: 'models',
    providerType: 'command-code',
    providerId: 'command-code',
    baseUrl: '',
    key: 'k',
    models: ['deepseek/deepseek-v4.1-flash'],
    modelCapacity: new Map(),
    catalogPresets: undefined,
    catalog: undefined,
    providerCursor: 0,
    saving: false,
    resolve() {},
  }
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')
  tui.handleOnboardingChar(' ') // uncheck the only candidate
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'models-pick', 'the picker stays open')
  assert.ok(tui.rows.some(row => row.kind === 'error'), 'and says why')
})
