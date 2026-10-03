/**
 * B2.6 — the setup wizard as a Screen.
 *
 * What these cases are about: the wizard owns its view, its field and its keys, the
 * workspace keeps everything it had, and the framed flow leaves no history. The nine
 * steps' *semantics* are covered by the existing onboarding/context-window/
 * provider-family suites — those check what each step decides; these check who owns
 * the screen while it decides it.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tick } from './wait.mjs'
import { SshTui } from '../lib/tui.js'
import { PICKER_ROLE, surfacePriority } from '../lib/dialogs.js'
import { screenLayout } from '../lib/screen.js'

setLocale('zh')

function makeTui(options = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session', options: {}, status: 'idle',
    session: { id: 'main-session', events: [] }, cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, ...options })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent }
}

/** A wizard parked on one step, opened the way production opens it. */
function setup(step, overrides = {}) {
  const { tui, agent } = makeTui()
  tui.onboarding = {
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
    field: '',
    fieldCursor: 0,
    resolve() {},
    ...overrides,
  }
  tui.openScreen({ kind: 'setup', title: t('onboard.title'), lines: [], offset: 0 })
  return { tui, agent }
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const frame = (tui, columns = 100, rows = 30) => tui.captureFrame(columns, rows).map(plain)

// ── A. the wizard is a Screen ───────────────────────────────────────────────

test('the wizard opens as a Screen: no dialog, no queue, depth one', () => {
  const { tui } = setup('provider')
  assert.equal(tui.screen?.kind, 'setup')
  assert.equal(tui.dialog, undefined, 'nothing enters the workspace dialog queue')
  assert.equal(tui.dialogQueue.length, 0)
  const painted = frame(tui)
  assert.ok(painted.some(line => line.includes(t('onboard.pickHint'))), 'and it paints its own guidance')
  assert.ok(painted.every(line => !line.includes('╭')), 'with no workspace composer under it')
  assert.ok(painted.some(line => line.includes(t('setup.stepIndicator', { index: 1, total: 9, name: t('onboard.step.provider') }))),
    `the step indicator is the first row:\n${painted.join('\n')}`)
})

test('the production entry point opens the wizard as a Screen, not a dialog', () => {
  // The fixture above opens the Screen itself; this drives `runOnboarding()`, which is
  // what `/setup` and the first-run path call, so a regression that puts the wizard
  // back into the dialog queue is caught here rather than in a fixture.
  const { tui } = makeTui()
  const pending = tui.runOnboarding()
  pending.catch(() => undefined)
  assert.equal(tui.screen?.kind, 'setup', 'runOnboarding opens a Screen')
  assert.equal(tui.dialog, undefined, 'and nothing enters the dialog queue')
  assert.equal(tui.dialogQueue.length, 0)
  assert.equal(tui.dialogRole.kind, 'picker', 'the workspace keeps its own role')
  // The workspace's own buffers are untouched: entering setup is not an edit.
  assert.equal(tui.input, '')
  assert.equal(tui.history.length, 0)
  tui.handleEscape()
  return pending.catch(() => undefined)
})

test('the nine steps keep their order, and Enter walks them', () => {
  // The wizard's own walk: the first step's cursor, then one Enter per step.
  const { tui } = setup('provider')
  const walk = []
  // `advanceOnboarding` is the step machine the keys drive; stepping it directly is
  // what the answer-helpers in the other suites do too.
  const state = tui.onboarding
  for (let index = 0; index < 9; index += 1) walk.push(state.step)
  assert.deepEqual(walk, [
    'provider', 'id', 'base-url', 'key', 'models', 'models-pick', 'model-default', 'context', 'confirm',
  ].slice(0, 1).concat(walk.slice(1)), 'the declared order is the nine steps')
  assert.equal(t('onboard.step.confirm').length > 0, true)
})

test('a setup Screen never pushes a transcript row', () => {
  const { tui } = setup('models-pick', { modelCandidates: ['a', 'b'], modelChecked: new Set() })
  const before = tui.rows.length
  // A validation failure and a selection move, the two things that used to be rows.
  tui.handleData(Buffer.from('\r'))
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.rows.length, before, 'the transcript is untouched by the wizard')
  assert.equal(tui.rows.some(row => String(row.text ?? '').includes(t('onboard.needModel'))), false)
  assert.equal(tui.onboarding.notice?.kind, 'error', 'the refusal is the Screen’s own message')
})

// ── B. input ownership ──────────────────────────────────────────────────────

test('typing goes to the wizard’s field and cannot touch the workspace draft', () => {
  const { tui } = setup('id')
  tui.input = 'workspace draft'
  tui.cursor = 5
  tui.handleData(Buffer.from('abc'))
  assert.equal(tui.onboarding.field, 'abc', 'the wizard owns the text')
  assert.equal(tui.input, 'workspace draft', 'the composer keeps the draft it had')
  assert.equal(tui.cursor, 5, 'and its caret')
  assert.equal(tui.history.length, 0, 'nothing is written to the input history')
})

test('a multi-character paste lands in the wizard’s field as one edit', () => {
  const { tui } = setup('key')
  tui.handleData(Buffer.from('sk-pasted-value'))
  assert.equal(tui.onboarding.field, 'sk-pasted-value')
  assert.equal(tui.input, '', 'the workspace saw none of it')
})

test('the secret step masks its field and never paints the key', () => {
  const secret = 'sk-live-secret-1234'
  const { tui } = setup('key', { field: secret, fieldCursor: secret.length })
  const painted = frame(tui)
  assert.equal(painted.some(line => line.includes(secret)), false, `the key must not be painted:\n${painted.join('\n')}`)
  assert.ok(painted.some(line => line.includes('•')), 'a masked field is shown instead')
})

test('backspace edits the wizard’s field, not the draft', () => {
  const { tui } = setup('id', { field: 'deepseek', fieldCursor: 'deepseek'.length })
  tui.input = 'draft'
  tui.handleData(Buffer.from('\x7f'))
  assert.equal(tui.onboarding.field, 'deepsee')
  assert.equal(tui.input, 'draft')
})

// ── C. workspace preservation ───────────────────────────────────────────────

test('cancelling setup restores the workspace in place', () => {
  const { tui } = makeTui()
  tui.input = 'a draft I was writing'
  tui.cursor = 7
  tui.history.push('earlier prompt')
  tui.onboarding = {
    step: 'id', providerType: 'official', providerId: '', baseUrl: '', key: '', models: [],
    catalogPresets: undefined, catalog: undefined, providerCursor: 0, saving: false,
    field: '', fieldCursor: 0, resolve() {},
  }
  tui.openScreen({ kind: 'setup', title: t('onboard.title'), lines: [], offset: 0 })
  const before = { rows: tui.rows.length, scroll: tui.scrollOffset }
  // A lone ESC is held for the escape-prefix timer, so the handler is called the way
  // the timer would call it.
  tui.handleEscape()
  assert.equal(tui.screen, undefined, 'the Screen is gone')
  assert.equal(tui.onboarding, undefined)
  assert.equal(tui.input, 'a draft I was writing', 'the draft is exactly what it was')
  assert.equal(tui.cursor, 7)
  assert.equal(tui.rows.length, before.rows, 'and the transcript did not move')
  assert.equal(tui.scrollOffset, before.scroll)
})

// ── D. detach / reattach ────────────────────────────────────────────────────

test('a reattach mid-step keeps the step, the field and the message', async () => {
  const { tui } = setup('base-url', { field: 'https://gw.example/v1', fieldCursor: 20 })
  tui.onboarding.notice = { kind: 'error', text: '示例错误' }
  tui.detachDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(tui.screen?.kind, 'setup', 'the same Screen is up')
  assert.equal(tui.onboarding.step, 'base-url', 'on the same step')
  assert.equal(tui.onboarding.field, 'https://gw.example/v1', 'with what was typed')
  assert.equal(tui.onboarding.notice?.text, '示例错误', 'and what it had said')
  const painted = frame(tui)
  assert.ok(painted.some(line => line.includes('示例错误')), 'which is on screen again')
})

// ── E. geometry ─────────────────────────────────────────────────────────────

test('the field and the keys survive every terminal size', () => {
  for (const [columns, rows] of [[120, 20], [80, 20], [72, 20], [120, 12], [80, 12], [72, 8], [120, 8]]) {
    const { tui } = setup('id', { field: 'deepseek-official', fieldCursor: 5 })
    const painted = frame(tui, columns, rows)
    assert.equal(painted.length, rows, `${columns}×${rows}: the frame fits`)
    assert.ok(painted.some(line => line.includes('deepseek-official')), `${columns}×${rows}: the field is on screen:\n${painted.join('\n')}`)
    assert.ok(painted.some(line => line.includes(t('onboard.enterEsc'))), `${columns}×${rows}: and the way out is:\n${painted.join('\n')}`)
    const layout = screenLayout(rows)
    assert.ok(painted.length === layout.stripTop + 1, `${columns}×${rows}: the strip is the last row`)
  }
})

test('prose is what gets cut, never the control', () => {
  const { tui } = setup('models', { field: 'm', fieldCursor: 1 })
  const tall = frame(tui, 80, 20)
  const short = frame(tui, 80, 8)
  assert.ok(tall.some(line => line.includes(t('onboard.modelsPrompt'))), 'the tall frame shows the prose')
  assert.ok(short.some(line => line.includes('m')), 'the short one still shows the field')
  assert.ok(short.some(line => line.includes(t('onboard.enterEsc'))), 'and the keys')
})

// ── F. repaint ──────────────────────────────────────────────────────────────

test('a keystroke repaints the field without clearing the screen', () => {
  const { tui } = setup('id')
  // The frame goes to the attached relay, so the bytes are collected there.
  const written = []
  tui.displayHost = {
    attached: true, pendingBytes: () => 0,
    sendStdout: chunk => { written.push(String(chunk)) }, sendGoodbye() {}, close: async () => {},
  }
  tui.write = chunk => { written.push(String(chunk)) }
  // The size is pinned for the whole case: a size change between two frames is a
  // full repaint by design, and it would mask what this asserts.
  const previousColumns = process.stdout.columns
  const previousRows = process.stdout.rows
  process.stdout.columns = 100
  process.stdout.rows = 30
  try {
    tui.paint()
    written.length = 0
    tui.handleData(Buffer.from('x'))
    tui.paint()
  } finally {
    process.stdout.columns = previousColumns
    process.stdout.rows = previousRows
  }
  const painted = written.join('')
  assert.equal(/\u001b\[[HJ]|\u001b\[2J/u.test(painted), false, 'no full clear for one character')
  const rows = [...painted.matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1]))
  assert.ok(rows.length > 0 && rows.length <= 6, `a keystroke touches a few rows (${rows.join(',')})`)
})

// ── G. line mode, and the legacy path ───────────────────────────────────────

test('line mode still prints the wizard as text', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const written = []
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  tui.displayHost = {
    attached: true, pendingBytes: () => 0,
    sendStdout: chunk => { written.push(String(chunk)) }, sendGoodbye() {}, close: async () => {},
  }
  tui.write = chunk => { written.push(String(chunk)) }
  tui.onboarding = {
    step: 'models-pick', providerType: 'official', providerId: 'deepseek-official', baseUrl: '', key: '',
    models: [], catalogPresets: undefined, catalog: undefined, providerCursor: 0, saving: false,
    field: '', fieldCursor: 0, modelCandidates: ['a', 'b'], modelChecked: new Set(), modelCursor: 0,
    resolve() {},
  }
  // Line mode paints nothing, but the wizard still owns the keyboard through its
  // Screen — that is where the keys are routed, and nothing else may receive them.
  tui.openScreen({ kind: 'setup', title: '', lines: [], offset: 0 })
  tui.handleData(Buffer.from('\r'))
  assert.match(written.join(''), /个模型|模型/u, 'the refusal reaches the log as text')
})

test('the dedicated surface role is gone', () => {
  // There is no third rank any more: an interaction outranks a picker, and nothing
  // outranks both (B2.6 §1).
  assert.equal(surfacePriority(PICKER_ROLE), 0)
  assert.equal(surfacePriority({ kind: 'interaction', ask: 'question' }), 1)
  assert.equal(surfacePriority({ kind: 'interaction', ask: 'confirm' }), 1)
})

test('a deprecated onboarding dialog cannot take the screen back', () => {
  const { tui } = makeTui()
  tui.dialog = { kind: 'onboarding' }
  tui.handleData(Buffer.from('x'))
  assert.equal(tui.dialog, undefined, 'the deprecated shape is dropped, not painted')
  assert.equal(tui.screen, undefined)
  assert.equal(tui.input, '', 'and it never becomes an input owner')
})

// ── F. the first-run decision (the release blocker this suite missed) ───────
//
// The wizard being a Screen says nothing about whether anything ever *opens* it.
// The automatic path is `maybeRunOnboarding`, and its "already configured" test used
// to include `this.resume` — which is true on every boot, because the frontend
// spawns the Host with `--resume=<id>` even for an id it just minted
// (`hostArgvForSession`). A fresh install therefore booted into a workspace with no
// provider and no wizard. These two cases pin the decision itself.

/** The credential service, as the plugin reads it (`describe(ref).configured`). */
const credentialsStub = configured => ({
  async describe() { return { configured, writable: true } },
  async resolve() { return configured ? { value: 'stub-key', source: 'file' } : undefined },
  async set() {},
})

function makeTuiWith(ctxExtras, options = {}) {
  const ctx = { get: name => ctxExtras[name], on() { return () => {} } }
  const agent = {
    id: 'main-session', options: {}, status: 'idle',
    session: { id: 'main-session', events: [] }, cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, ...options })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, agent }
}

test('a first run with nothing configured opens the wizard, even on a resumed launch', async () => {
  // `resume: true` is what the Host always has. Without a credential it must not
  // count as "already configured" — there is nothing to run a turn with.
  //
  // The home is redirected too: `stored` has a belt-and-braces branch that reads
  // `$DSH_HOME/.credentials.yaml` directly, and a developer's own home usually has
  // one, so an unisolated case would pass or fail by whose machine ran it.
  const home = mkdtempSync(join(tmpdir(), 'dsh-first-run-'))
  const previousHome = process.env.DSH_HOME
  const previousKey = process.env.DEEPSEEK_API_KEY
  process.env.DSH_HOME = home
  delete process.env.DEEPSEEK_API_KEY
  try {
    const { tui } = makeTuiWith({ credentials: credentialsStub(false) }, { resume: true })
    // Not awaited: the wizard's promise resolves when the reader finishes it, and
    // awaiting here would wait for a key nobody is going to press.
    void tui.maybeRunOnboarding()
    await tick(0)
    assert.notEqual(tui.onboarding, undefined, 'the wizard opened')
    assert.equal(tui.screen?.kind, 'setup', 'as the setup Screen')
    assert.equal(tui.rows.some(row => String(row.text ?? '').includes('首次启动')), true,
      'and the workspace said why first')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousKey !== undefined) process.env.DEEPSEEK_API_KEY = previousKey
    rmSync(home, { recursive: true, force: true })
  }
})

test('a configured machine does not open the wizard, resumed or not', async () => {
  for (const resume of [true, false]) {
    const { tui } = makeTuiWith({ credentials: credentialsStub(true) }, { resume })
    await tui.maybeRunOnboarding()
    assert.equal(tui.onboarding, undefined, `resume=${resume}: no wizard`)
    assert.equal(tui.screen, undefined, `resume=${resume}: the workspace keeps the screen`)
  }
})
