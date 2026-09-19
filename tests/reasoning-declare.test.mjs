import test from 'node:test'
import assert from 'node:assert/strict'

import { SshTui, handDeclaredReasoningEfforts, onboardingReasoningEfforts } from '../lib/tui.js'

/**
 * Coverage for the `/setup` root causes a hand-declared OpenAI-compatible
 * gateway exposed:
 *
 * 1. The route is absent from pi-ai's catalog, so `defaultReasoningEffort`
 *    resolved nothing before the profile was saved and the model landed as a
 *    bare `{ id }`. The Harness then reported it as non-reasoning and refused
 *    every effort the TUI itself offers for an undeclared model.
 * 2. The same absence dropped the endpoint's disclosed context window, so the
 *    route fell back to the 262144-token default even when the endpoint
 *    advertised 1048576.
 * 3. Ctrl+F filled the fetched listing into `state.models`, but pressing Enter
 *    replaced it with the template's placeholder ids, so the fetch never
 *    reached settings.
 */

function makeTui({ section, credentials } = {}) {
  const writes = []
  const settings = {
    get: ns => (ns === 'llm-pi-ai' ? section : undefined),
    mutate: async (ns, ops) => { writes.push({ op: 'mutate', ns, ops }) },
    replace: async (ns, value) => { writes.push({ op: 'replace', ns, value }) },
    update: async (ns, value) => { writes.push({ op: 'update', ns, value }) },
  }
  const services = { settings, ...(credentials === undefined ? {} : { credentials }) }
  const ctx = { get: name => services[name], on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  return { tui, writes }
}

function wizardState(overrides) {
  return {
    step: 'models',
    providerType: 'openai-completions',
    providerId: 'cc-test-gw',
    baseUrl: 'https://gateway.example/v1',
    key: 'sk-test',
    models: [],
    modelCapacity: new Map(),
    catalogPresets: undefined,
    catalog: undefined,
    providerCursor: 0,
    saving: false,
    resolve() {},
    ...overrides,
  }
}

test('the hand-declared completions template declares the offered vocabulary', () => {
  const expected = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh' }
  assert.deepEqual(handDeclaredReasoningEfforts(), expected)
  assert.deepEqual(onboardingReasoningEfforts('openai-completions', undefined), expected)
  assert.deepEqual(onboardingReasoningEfforts('command-code', undefined), expected)
})

test('other templates keep their existing declaration behavior', () => {
  // Responses materializes an unset level as `reasoning: { effort: "none" }`,
  // which a custom gateway need not accept, so it stays undeclared.
  assert.equal(onboardingReasoningEfforts('openai-responses', undefined), undefined)
  assert.equal(onboardingReasoningEfforts('opencode-go', undefined), undefined)
  assert.equal(onboardingReasoningEfforts('catalog', undefined), undefined)
  assert.deepEqual(onboardingReasoningEfforts('opencode-go', 'max'), { off: null, max: 'max' })
})

test('the models step accepts the listing Ctrl+F fetched', () => {
  const { tui } = makeTui()
  tui.onboarding = wizardState({ models: ['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5'] })
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')
  assert.deepEqual(tui.onboarding.models, ['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5'])
  // This checkout resolves no catalog, so neither pick is sized and the wizard
  // asks for the route default before confirming (covered in context-window tests).
  assert.equal(tui.onboarding.step, 'context')
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'confirm')
})

test('the models step still falls back to the template default when nothing was fetched', () => {
  const { tui } = makeTui()
  tui.onboarding = wizardState({ models: [] })
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')
  assert.deepEqual(tui.onboarding.models, ['deepseek-v4-flash'])
})

test('an explicit effort on an undeclared model is persisted as its declaration', async () => {
  const section = { providers: { 'command-code': { api: 'openai-completions', models: [{ id: 'deepseek/deepseek-v4.1-flash' }] } } }
  const { tui, writes } = makeTui({ section })
  assert.equal(await tui.declareReasoningEffort('command-code', 'deepseek/deepseek-v4.1-flash', 'max'), true)
  assert.deepEqual(writes.at(-1).ops[0].value, [{
    id: 'deepseek/deepseek-v4.1-flash',
    reasoningEfforts: { off: null, max: 'max' },
  }])
})

test('declaring merges existing levels and appends a model the profile lacks', async () => {
  const section = { providers: { gw: { api: 'openai-completions', models: [
    { id: 'a', reasoningEfforts: { off: null, high: 'high' } },
    'b',
  ] } } }
  const { tui, writes } = makeTui({ section })

  await tui.declareReasoningEffort('gw', 'a', 'max')
  assert.deepEqual(writes.at(-1).ops[0].value[0], {
    id: 'a',
    reasoningEfforts: { off: null, high: 'high', max: 'max' },
  })

  await tui.declareReasoningEffort('gw', 'c', 'low')
  const after = writes.at(-1).ops[0].value
  assert.equal(after[1], 'b')
  assert.deepEqual(after[2], { id: 'c', reasoningEfforts: { off: null, low: 'low' } })
})

test('a route pi-ai does not describe, or another dialect, is left untouched', async () => {
  const { tui, writes } = makeTui({ section: {
    providers: { 'resp-gw': { api: 'openai-responses', models: [{ id: 'x' }] } },
  } })
  assert.equal(await tui.declareReasoningEffort('deepseek-official', 'x', 'max'), false)
  assert.equal(await tui.declareReasoningEffort('missing', 'x', 'max'), false)
  assert.equal(await tui.declareReasoningEffort('resp-gw', 'x', 'max'), false)
  assert.equal(writes.length, 0)
})

test('/setup persists the gateway vocabulary and the fetched context window', async () => {
  const section = { providers: {} }
  const { tui, writes } = makeTui({ section, credentials: { set: async () => {} } })
  tui.onboarding = wizardState({
    step: 'confirm',
    models: ['deepseek/deepseek-v4.1-flash'],
    modelCapacity: new Map([['deepseek/deepseek-v4.1-flash', { contextWindow: 1_048_576 }]]),
  })

  await tui.saveOnboarding()

  const write = writes.find(entry => entry.op === 'mutate' && entry.ns === 'llm-pi-ai')
  assert.ok(write, 'the provider profile must be written')
  assert.deepEqual(write.ops[0].value.models, [{
    id: 'deepseek/deepseek-v4.1-flash',
    contextWindow: 1_048_576,
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh' },
  }])
})

test('the wizard lists the fixed Command Code provider', () => {
  const { tui } = makeTui()
  const entries = tui.mergedProviderEntries(wizardState({ step: 'provider' }))
  const entry = entries.find(candidate => candidate.key === 'template:command-code')
  assert.ok(entry, `Command Code must be offered: ${JSON.stringify(entries)}`)
  assert.match(entry.label, /Command Code/)
})

test('/setup persists the fixed Command Code route with its verified capacity', async () => {
  const section = { providers: {} }
  const { tui, writes } = makeTui({ section, credentials: { set: async () => {} } })
  tui.onboarding = wizardState({
    step: 'confirm',
    providerType: 'command-code',
    providerId: 'command-code',
    baseUrl: '',
    models: ['deepseek/deepseek-v4.1-flash'],
    modelCapacity: new Map(),
  })

  await tui.saveOnboarding()

  const write = writes.find(entry => entry.op === 'mutate' && entry.ns === 'llm-pi-ai')
  assert.ok(write, 'the provider profile must be written')
  // The gateway's pinned protocol is responses (verified against the live
  // gateway), and the base id keeps that protocol.
  assert.equal(write.ops[0].path[1], 'command-code')
  assert.equal(write.ops[0].value.api, 'openai-responses')
  assert.equal(write.ops[0].value.baseURL, 'https://api.commandcode.ai/provider/v1')
  assert.deepEqual(write.ops[0].value.models, [{
    id: 'deepseek/deepseek-v4.1-flash',
    contextWindow: 1_048_576,
    reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh' },
  }])
})

test('/setup files each model of one gateway under the protocol it speaks', async () => {
  const section = { providers: {} }
  const { tui, writes } = makeTui({ section, credentials: { set: async () => {} } })
  tui.onboarding = wizardState({
    step: 'confirm',
    providerType: 'command-code',
    providerId: 'command-code',
    baseUrl: '',
    models: ['deepseek/deepseek-v4.1-flash', 'z-ai/glm-5.3-flash'],
    modelCapacity: new Map(),
    // What `GET /provider/v1/models` publishes for these two ids.
    modelEndpoints: new Map([
      ['deepseek/deepseek-v4.1-flash', ['/chat/completions', '/responses']],
      ['z-ai/glm-5.3-flash', ['/chat/completions']],
    ]),
  })

  await tui.saveOnboarding()

  const write = writes.find(entry => entry.op === 'mutate' && entry.ns === 'llm-pi-ai')
  assert.ok(write, 'the provider profiles must be written')
  const byId = Object.fromEntries(write.ops.map(op => [op.path[1], op.value]))
  // One wizard row, two entries: the model that answers both routes takes the
  // preferred one, the chat-only model gets its own sibling entry.
  assert.equal(byId['command-code'].api, 'openai-responses')
  assert.deepEqual(byId['command-code'].models.map(model => model.id), ['deepseek/deepseek-v4.1-flash'])
  assert.equal(byId['command-code-completions'].api, 'openai-completions')
  assert.deepEqual(byId['command-code-completions'].models.map(model => model.id), ['z-ai/glm-5.3-flash'])
  assert.equal(Object.keys(byId).length, 2)
})
