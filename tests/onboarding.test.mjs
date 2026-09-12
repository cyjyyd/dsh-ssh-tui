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
    resolve() {},
    ...overrides,
  }
}

function dialogFrame(step, overrides = {}) {
  const tui = makeTui()
  tui.onboarding = wizardState(step, overrides)
  tui.dialog = { kind: 'onboarding' }
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

test('/setup API-key step prompts for the key and keeps it masked', () => {
  const secret = 'sk-live-secret-1234'
  for (const locale of ['zh', 'en']) {
    setLocale(locale)
    const tui = makeTui()
    tui.onboarding = wizardState('key')
    tui.dialog = { kind: 'onboarding' }
    tui.input = secret
    tui.cursor = secret.length
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
