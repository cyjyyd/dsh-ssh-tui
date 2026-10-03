import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * Screen-level coverage for the /setup wizard's guidance copy.
 *
 * The API-key step once rendered nothing at all: the provider rework in
 * 4672e7b dropped its `case 'key'` arm, so the user got a masked input line
 * with no prompt, no provider name and no Enter/Esc hint while the i18n
 * strings sat unused. These tests read the painted frame, not the state
 * machine, so a missing render arm fails here instead of reaching a release.
 */

function makeTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
}

/** A wizard parked on one step, shaped the way runOnboarding builds it. */
function wizardState(step, overrides = {}) {
  return {
    step,
    providerType: 'official',
    providerId: 'deepseek-official',
    baseUrl: '',
    key: '',
    models: [],
    catalogPresets: undefined,
    catalog: undefined,
    providerCursor: 0,
    saving: false,
    // The wizard owns its field and its message row (B2.6): the composer is the
    // workspace's and is never borrowed.
    field: '',
    fieldCursor: 0,
    resolve() {},
    ...overrides,
  }
}

/**
 * The wizard parked on one step, drawn the way production opens it.
 *
 * It is a **Screen** now (B2.6): `openScreen({kind:'setup'})` is what `/setup` and
 * the first-run path do, so a fixture that sets the state and opens the screen
 * exercises the same renderer the user sees.
 */
function dialogFrame(step, overrides = {}) {
  const tui = makeTui()
  tui.onboarding = wizardState(step, overrides)
  tui.openScreen({ kind: 'setup', title: '', lines: [], offset: 0 })
  return { tui, text: tui.captureFrame(100, 30).join('\n') }
}

test('every /setup wizard step paints its guidance copy', () => {
  // One marker per step: the line a user needs to know what to type.
  const markers = {
    provider: () => t('onboard.pickHint'),
    id: () => t('onboard.idPrompt'),
    'base-url': () => t('onboard.basePrompt', { fallback: 'https://api.deepseek.com' }),
    key: () => t('onboard.keyPrompt'),
    models: () => t('onboard.modelsPrompt'),
    'models-pick': () => t('onboard.modelsCheckHint'),
    'model-default': () => t('onboard.defaultModelPick'),
    confirm: () => t('onboard.confirmTitle'),
  }
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    for (const [step, marker] of Object.entries(markers)) {
      const { text } = dialogFrame(step)
      assert.ok(
        text.includes(marker()),
        `${locale} step "${step}" is missing its prompt ${JSON.stringify(marker())}\n${text}`,
      )
    }
  }
  setLocale('zh')
})

test('the models picker paints the candidates, the checks and the hints', () => {
  const { text } = dialogFrame('models-pick', {
    modelCandidates: ['deepseek/deepseek-v4.1-flash', 'claude-sonnet-5'],
    modelChecked: new Set([0]),
    modelCursor: 0,
  })
  assert.ok(text.includes('◉ deepseek/deepseek-v4.1-flash'), `the checked pick must show as checked\n${text}`)
  assert.ok(text.includes('○ claude-sonnet-5'), `an unchecked pick must show as open\n${text}`)
  assert.ok(text.includes(t('onboard.modelsCheckHint')), `the keys must be on screen\n${text}`)
})

test('the session-model step lists only the models that were kept', () => {
  const { text } = dialogFrame('model-default', {
    modelCandidates: ['keep-me-first', 'keep-me-second'],
    modelChecked: new Set([1]),
    modelCursor: 0,
  })
  assert.ok(text.includes(t('onboard.defaultModelPick')), text)
  assert.ok(text.includes('○ keep-me-second'), `the kept model must be listed\n${text}`)
  assert.ok(!text.includes('keep-me-first'), `the dropped model must not be listed\n${text}`)
})

test('/setup API-key step prompts for the key and keeps it masked', () => {
  const secret = 'sk-live-secret-1234'
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    const tui = makeTui()
    // The wizard's *own* field: the composer is the workspace's draft and the
    // migration exists so the wizard cannot read or write it (B2.6 §4/§5).
    tui.onboarding = wizardState('key', { field: secret, fieldCursor: secret.length })
    tui.openScreen({ kind: 'setup', title: '', lines: [], offset: 0 })
    const painted = tui.captureFrame(100, 30).join('\n')

    // The step must say which provider it is configuring and what to enter.
    assert.ok(
      painted.includes(t('onboard.providerLine', { label: `${t('route.deepseek')}（https://api.deepseek.com）` })),
      `${locale}: the API-key step must name the provider\n${painted}`,
    )
    assert.ok(painted.includes(t('onboard.keyPrompt')), `${locale}: missing the API-key prompt\n${painted}`)
    assert.ok(painted.includes(t('onboard.enterEsc')), `${locale}: missing the Enter/Esc hint\n${painted}`)
    // The catalog-only "leave empty" hint belongs to catalog presets, not here.
    assert.equal(painted.includes(t('onboard.keyCatalogHint')), false)

    // A typed key is masked on screen and never echoed in clear.
    assert.ok(painted.includes('•'.repeat(secret.length)), `${locale}: the key must render as bullets\n${painted}`)
    assert.equal(painted.includes(secret), false, `${locale}: the raw key must never reach the frame`)
  }
  setLocale('zh')
})

test('/setup catalog API-key step explains the environment-key fallback', () => {
  const catalog = { id: 'acme-cloud', name: 'Acme Cloud', baseUrl: '', modelIds: ['acme-1'] }
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    const { text } = dialogFrame('key', { providerType: 'catalog', providerId: 'acme-cloud', catalog })
    assert.ok(text.includes(t('onboard.keyPrompt')), `${locale}: missing the API-key prompt\n${text}`)
    assert.ok(text.includes(t('onboard.keyCatalogHint')), `${locale}: missing the catalog key hint\n${text}`)
  }
  setLocale('zh')
})

test('/setup lists one row per gateway, and the protocol is chosen per model', () => {
  // A gateway whose catalogue spans protocols used to need one row per
  // protocol, which asked the user to guess. The wizard now files each model
  // under the route it speaks (see gateway-protocol), so the row count is the
  // gateway count and no row names a protocol.
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    const { text } = dialogFrame('provider')
    for (const key of ['onboard.providerGo', 'onboard.providerCommandCode']) {
      const label = t(key)
      const rows = text.split('\n').filter(line => line.includes(label))
      assert.equal(rows.length, 1, `${locale}: ${key} must appear exactly once\n${text}`)
    }
    assert.equal(text.includes('· Responses'), false, `${locale}: no per-protocol rows\n${text}`)
    assert.equal(text.includes('· Completions'), false, `${locale}: no per-protocol rows\n${text}`)
    assert.ok(text.includes(t('onboard.protocolAuto')), `${locale}: the row must say the protocol is automatic\n${text}`)
  }
  setLocale('zh')
})
