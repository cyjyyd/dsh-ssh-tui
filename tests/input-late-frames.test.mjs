/**
 * Late input frames: a sequence held by the Reader is released 60 ms later, and the
 * layer it was pressed in may be gone by then (F2 of the W-4B.0 review).
 *
 * The first fix remembered the *owner name* the Router had chosen. A name is not a
 * lifecycle: `'surface'` is valid for any Surface, `'screen'` for any Screen, so a
 * release could land in a layer that did not exist when the key was pressed — a held
 * `ESC O` typed `O` into the composer after its Surface closed, a late Esc closed a
 * Screen that had opened in the meantime, and a wizard's held report typed into the
 * *next* wizard. These cases pin the lifecycle, not the name.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale, t } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { tick } from './wait.mjs'

setLocale('zh')

/** Long enough for the Reader's 60 ms hold to expire and release the frame. */
const RELEASE = 140

function makeTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session', options: {}, status: 'idle',
    session: { id: 'main-session', events: [] }, cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return tui
}

/** A Surface that borrowed a text field, the way a question with an input does. */
function openSurface(tui) {
  tui.dialog = {
    kind: 'questions',
    question: { id: 'q', question: 'pick', options: [{ label: 'a' }] },
    index: 0, total: 1, selected: new Set([0]), cursor: 0,
    resolve() {}, reject() {},
  }
  tui.borrowedText = { text: 'ab', cursor: 2 }
}

function closeSurface(tui) {
  tui.dialog = undefined
  tui.borrowedText = undefined
}

function openSetup(tui, step = 'id') {
  tui.onboarding = {
    step, providerType: 'official', providerId: 'deepseek-official',
    baseUrl: '', key: '', models: [], providerCursor: 0, saving: false,
    field: '', fieldCursor: 0, resolve() {},
  }
  tui.openScreen({ kind: 'setup', title: t('onboard.title'), lines: [], offset: 0 })
}

test('T1: a Surface’s held ESC O is not typed into the composer after it closes', async () => {
  const tui = makeTui()
  tui.input = 'draft'
  tui.cursor = 5
  openSurface(tui)
  tui.handleData(Buffer.from('\u001bO'))
  assert.equal(tui.input, 'draft', 'the hold keeps it out of the composer while the Surface is up')
  closeSurface(tui)
  await tick(RELEASE)
  assert.equal(tui.input, 'draft', 'the release must not reach the composer the Surface revealed')
  assert.equal(tui.cursor, 5)
  assert.equal(tui.history.length, 0)
})

test('T1b: a composer’s held ESC O is not typed into a Surface that opens later', async () => {
  const tui = makeTui()
  tui.input = 'draft'
  tui.cursor = 5
  tui.handleData(Buffer.from('\u001bO'))
  openSurface(tui)
  await tick(RELEASE)
  assert.equal(tui.borrowedText?.text, 'ab', 'the borrowed field is not the composer’s late input')
  assert.equal(tui.borrowedText?.cursor, 2)
  assert.equal(tui.input, 'draft')
  assert.equal(tui.cursor, 5)
})

test('T2: a composer’s held Escape does not close a Screen that opens later', async () => {
  const tui = makeTui()
  tui.handleData(Buffer.from('\u001b'))
  // Two holds sit in front of a lone Escape, and they are different owners of the
  // byte: the reply filter holds it for ~30 ms (a trailing `ESC` could still be a
  // cursor reply — `TerminalInputFilter`), and only then does it reach `route()`,
  // where the Reader holds it for 60 ms as a possible sequence. T2 is about the
  // *composer's* hold, so the Screen has to open after the first one flushed and
  // while the second is still pending. Opening it earlier is a different case: the
  // Escape then arrives with the Screen already up and is the Screen's own key.
  await tick(40)
  assert.equal(tui.reader.held, '\u001b', 'the composer is holding the escape')
  openSetup(tui)
  assert.equal(tui.screen?.kind, 'setup', 'the Screen opened while the escape was held')
  await tick(RELEASE)
  assert.equal(tui.screen?.kind, 'setup', 'the late escape did not dismiss it')
  assert.notEqual(tui.onboarding, undefined, 'and the wizard is still asking')
})

test('T3: a dismissed Screen’s held report does not reach the next Screen', async () => {
  const tui = makeTui()
  openSetup(tui, 'id')
  tui.handleData(Buffer.from('\u001bO'))
  tui.closeScreen()
  tui.onboarding = undefined
  openSetup(tui, 'id')
  await tick(RELEASE)
  assert.equal(tui.onboarding?.field, '', 'the second wizard’s field is untouched')
  assert.equal(tui.onboarding?.fieldCursor, 0)
  assert.equal(tui.onboarding?.step, 'id')
})

test('PROVENANCE: a hold completed by the next read leaves nothing behind', async () => {
  // `assemble()` prepends the held text to the next read and cancels the timer. The
  // TUI's provenance has to go with it, or the *next* released frame (a paste tail)
  // would be attributed to a hold that no longer exists.
  const tui = makeTui()
  tui.handleData(Buffer.from('\u001b['))
  tui.handleData(Buffer.from('B'))
  await tick(RELEASE)
  tui.handleData(Buffer.from('\u001b[200~typed by paste\u001b[201~'))
  assert.equal(tui.input, 'typed by paste', 'the paste is a paste, not a stale hold')
})

test('PROVENANCE: a detached display leaves no pending attribution', async () => {
  const tui = makeTui()
  tui.input = 'draft'
  tui.cursor = 5
  tui.handleData(Buffer.from('\u001bO'))
  tui.detachDisplay()
  await tick(RELEASE)
  assert.equal(tui.input, 'draft', 'nothing is delivered after the reader was stopped')
  assert.equal(tui.cursor, 5)
})
