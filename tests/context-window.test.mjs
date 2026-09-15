import test from 'node:test'
import assert from 'node:assert/strict'

import {
  catalogContextWindow,
  catalogIdCandidates,
  catalogWindowIndex,
  suggestedRouteContextWindow,
} from '../lib/context-window.js'
import { readProviderCatalog } from '../lib/provider-catalog.js'
import { SshTui } from '../lib/tui.js'

/**
 * A gateway that discloses no capacity leaves its models at the 262,144
 * harness default. `/setup` sizes them from the endpoint listing first, then
 * from the installed pi-ai catalog — where the gateway id rarely matches a
 * catalog id verbatim, because providers namespace ids and bake the thinking
 * level into the name (`gemini-3.8-flash-high`, `gemini-claude-sonnet-4-6`).
 */

const INDEX = new Map([
  ['claude-sonnet-4-6', 1_000_000],
  ['claude-opus-4-6', 1_000_000],
  ['claude-haiku-4-5', 200_000],
  ['gemini-3.6-flash', 1_000_000],
  ['gemini-2.5-flash', 1_048_576],
  ['deepseek-v4-pro', 1_000_000],
  ['longcat-2.0', 1_048_576],
])

test('a thinking-level suffix in the model name never reaches the lookup', () => {
  const candidates = catalogIdCandidates('gemini-3.8-flash-high')
  assert.ok(candidates.includes('gemini-3.8-flash'), candidates.join(', '))
  assert.equal(catalogContextWindow('gemini-3.6-flash-high', INDEX), 1_000_000)
  assert.equal(catalogContextWindow('gemini-2.5-flash-thinking', INDEX), 1_048_576)
  assert.equal(catalogContextWindow('gemini-3.8-flash-low', INDEX), undefined)
})

test('a proxy namespace is stripped when a model family follows it', () => {
  assert.equal(catalogContextWindow('gemini-claude-sonnet-4-6', INDEX), 1_000_000)
  assert.equal(catalogContextWindow('gemini-claude-opus-4-6-thinking', INDEX), 1_000_000)
  // A word that is part of the model name must survive: `gemini-3.6-flash`.
  assert.equal(catalogContextWindow('gemini-3.6-flash', INDEX), 1_000_000)
})

test('listing decorations, namespaces, and version spellings are normalized', () => {
  assert.equal(catalogContextWindow('meituan/LongCat-2.0:free', INDEX), 1_048_576)
  assert.equal(catalogContextWindow('deepseek/deepseek-v4-pro', INDEX), 1_000_000)
  assert.equal(catalogContextWindow('claude-opus-4.6', INDEX), 1_000_000)
  assert.equal(catalogContextWindow('claude-haiku-4-5-20251001', INDEX), 200_000)
  assert.equal(catalogContextWindow('unknown-model-9', INDEX), undefined)
})

test('the index keeps the first provider that sizes an id', () => {
  const index = catalogWindowIndex([
    { id: 'a', name: 'A', baseUrl: '', modelIds: ['m'], capacities: { m: 1000 } },
    { id: 'b', name: 'B', baseUrl: '', modelIds: ['m'], capacities: { m: 2000 } },
  ])
  assert.equal(index.get('m'), 1000)
})

test('the route default is the smallest window the pick proved', () => {
  assert.equal(suggestedRouteContextWindow([1_048_576, 1_000_000]), 1_000_000)
  assert.equal(suggestedRouteContextWindow([]), undefined)
  assert.equal(suggestedRouteContextWindow([0, -5]), undefined)
})

const PRESETS = [
  {
    id: 'anthropic', name: 'Anthropic', baseUrl: '',
    modelIds: ['claude-sonnet-4-6', 'claude-opus-4-6'],
    capacities: { 'claude-sonnet-4-6': 1_000_000, 'claude-opus-4-6': 1_000_000 },
  },
  {
    id: 'google', name: 'Google', baseUrl: '',
    modelIds: ['gemini-3.6-flash'],
    capacities: { 'gemini-3.6-flash': 1_000_000 },
  },
]

function makeTui(presets = PRESETS) {
  const writes = []
  const settings = {
    get: () => ({ providers: {} }),
    mutate: async (ns, ops) => { writes.push({ op: 'mutate', ns, ops }) },
    replace: async (ns, value) => { writes.push({ op: 'replace', ns, value }) },
    update: async (ns, value) => { writes.push({ op: 'update', ns, value }) },
  }
  const services = { settings, credentials: { set: async () => {} } }
  const ctx = { get: name => services[name], on() { return () => {} } }
  const agent = { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 's', color: false })
  tui.catalogPresets = presets
  return { tui, writes }
}

function wizardState(overrides = {}) {
  return {
    step: 'models',
    providerType: 'openai-completions',
    providerId: 'cc-test-gw',
    baseUrl: 'https://gateway.example/v1',
    key: 'sk-test',
    models: [],
    modelCapacity: new Map(),
    catalogPresets: PRESETS,
    catalog: undefined,
    providerCursor: 0,
    saving: false,
    resolve() {},
    ...overrides,
  }
}

test('an unsized pick asks for the route window, pre-filled from the catalog', () => {
  const { tui } = makeTui()
  tui.onboarding = wizardState({ models: ['gemini-3.8-flash-high', 'gemini-3.6-flash-high', 'gemini-claude-sonnet-4-6'] })
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')

  assert.equal(tui.onboarding.step, 'context')
  // 1,000,000 is what the two catalog-matched picks proved; the 3.8 alias,
  // which no catalog entry sizes, inherits it rather than the 262,144 default.
  assert.equal(tui.onboarding.routeContextWindow, 1_000_000)
  assert.equal(tui.onboarding.modelCapacity.get('gemini-3.6-flash-high')?.contextWindow, 1_000_000)
  assert.equal(tui.onboarding.modelCapacity.get('gemini-claude-sonnet-4-6')?.contextWindow, 1_000_000)
  assert.equal(tui.onboarding.modelCapacity.get('gemini-3.8-flash-high'), undefined)

  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'confirm')
})

test('a fully sized pick goes straight to confirm', () => {
  const { tui } = makeTui()
  tui.onboarding = wizardState({
    models: ['gemini-3.8-flash-high'],
    modelCapacity: new Map([['gemini-3.8-flash-high', { contextWindow: 1_048_576 }]]),
  })
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'confirm')
  assert.equal(tui.onboarding.routeContextWindow, undefined)
})

test('the context step takes a typed override and rejects nonsense', () => {
  const { tui } = makeTui()
  tui.onboarding = wizardState({ models: ['gemini-3.8-flash-high'] })
  tui.input = ''
  tui.cursor = 0
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'context')

  tui.input = 'not-a-number'
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'context', 'an invalid value keeps the step open')

  tui.input = '300000'
  tui.handleOnboardingChar('\r')
  assert.equal(tui.onboarding.step, 'confirm')
  assert.equal(tui.onboarding.routeContextWindow, 300_000)
})

test('/setup persists the route default and the per-model windows', async () => {
  const { tui, writes } = makeTui()
  tui.onboarding = wizardState({
    step: 'confirm',
    models: ['gemini-3.6-flash-high', 'gemini-3.8-flash-high'],
    modelCapacity: new Map([['gemini-3.8-flash-high', { contextWindow: 1_048_576 }]]),
    routeContextWindow: 1_000_000,
  })

  await tui.saveOnboarding()

  const write = writes.find(entry => entry.op === 'mutate' && entry.ns === 'llm-pi-ai')
  assert.ok(write, 'the provider profile must be written')
  assert.equal(write.ops[0].value.defaultContextWindow, 1_000_000)
  assert.deepEqual(write.ops[0].value.models, [
    {
      id: 'gemini-3.6-flash-high',
      contextWindow: 1_000_000,
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh' },
    },
    {
      id: 'gemini-3.8-flash-high',
      contextWindow: 1_048_576,
      reasoningEfforts: { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max', xhigh: 'xhigh' },
    },
  ])
})

test('the catalog child reads pi-ai capacities when the install ships it', async t => {
  const presets = await readProviderCatalog([process.cwd()])
  if (presets === undefined) {
    t.skip('no reachable pi-ai install from this checkout')
    return
  }
  assert.ok(presets.length > 0, 'the catalog must list providers')
  const sized = presets.filter(preset => preset.capacities !== undefined)
  assert.ok(sized.length > 0, 'at least one provider must disclose model capacities')
})

test('a model added through /model is sized from the catalog too', async () => {
  const { tui, writes } = makeTui()
  tui.catalogPresets = PRESETS
  tui.ctx.get('settings').get = () => ({
    providers: { gw: { api: 'openai-completions', models: [{ id: 'known' }] } },
  })

  assert.equal(await tui.ensureProviderModelConfigured('gw', 'gemini-3.6-flash-high'), true)
  assert.deepEqual(writes.at(-1).ops[0].value, [
    { id: 'known' },
    { id: 'gemini-3.6-flash-high', contextWindow: 1_000_000 },
  ])

  assert.equal(await tui.ensureProviderModelConfigured('gw', 'who-knows-9'), true)
  assert.deepEqual(writes.at(-1).ops[0].value.at(-1), { id: 'who-knows-9' })
})
