import test from 'node:test'
import assert from 'node:assert/strict'

import { questionOptionMarker } from '../lib/dialogs.js'
import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * What Enter submits, and what the screen shows it will submit.
 *
 * Two bugs live here, and they pull in opposite directions — which is why the
 * rule is worth stating once:
 *
 * 1. (Earlier) A multi-select question answered `selected: []` when the reader
 *    simply pressed Enter, so a choice they believed they had made reached the
 *    model as "nothing".
 * 2. (Reported from a real session) The fix for 1 — opening every list with its
 *    first option already ticked — meant a reader who moved the highlight to the
 *    row they wanted and pressed Enter answered with the **first** row. The `●`
 *    never left it.
 *
 * The rule that satisfies both: a list opens with nothing ticked (multi-select)
 * or with its default (single-select), `Enter` answers with the **highlighted**
 * row when nothing is ticked, and the `●` is drawn on exactly that row. So the
 * answer is never empty, and never somewhere the reader was not pointing.
 */
function fixture() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  return new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
}

const tick = () => new Promise(resolve => setTimeout(resolve, 20))

const MULTI = {
  id: 'pick',
  question: '接下来怎么走？',
  multiSelect: true,
  options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
}

test('a multi-select question opens unticked, and Enter answers the highlighted row', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({ questions: [MULTI] })
  await tick()
  assert.equal(tui.dialog?.kind, 'questions')
  assert.equal(tui.dialog.cursor, 0)
  assert.deepEqual([...tui.dialog.selected], [], 'nothing is ticked until the reader ticks it')
  assert.equal(questionOptionMarker(tui.dialog, 0), '●', 'the circle shows what Enter will submit')
  assert.equal(questionOptionMarker(tui.dialog, 1), '○')

  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers, [{ id: 'pick', selected: ['甲'], custom: undefined }],
    'never empty — but it is the highlighted row, not a default the reader did not look at')
})

test('and the circle moves with the highlight, so the answer is the marked row', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({ questions: [MULTI] })
  await tick()
  // The reported interaction: highlight the second row, press Enter.
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(questionOptionMarker(tui.dialog, 0), '○')
  assert.equal(questionOptionMarker(tui.dialog, 1), '●')
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers[0].selected, ['乙'], 'the row the circle was on')
})

test('a single-select question opens on its first option, and Enter submits it', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'one', question: '选一个', options: [{ label: 'alpha' }, { label: 'beta' }] }],
  })
  await tick()
  assert.deepEqual([...tui.dialog.selected], [0])
  assert.equal(questionOptionMarker(tui.dialog, 0), '●')
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers[0].selected, ['alpha'])
})

test('ticking rows replaces the circle with a tick, and that set is submitted', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({ questions: [MULTI] })
  await tick()
  tui.handleChar('3')
  assert.deepEqual([...tui.dialog.selected], [2])
  assert.equal(questionOptionMarker(tui.dialog, 2), '✓', 'a ticked row is a tick, wherever the circle would be')
  assert.equal(questionOptionMarker(tui.dialog, 0), '○')
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers[0].selected, ['丙'])
})

test('the same key twice unticks, and Enter falls back to the highlighted row', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({ questions: [MULTI] })
  await tick()
  tui.handleChar('1')
  tui.handleChar('1')
  assert.deepEqual([...tui.dialog.selected], [], 'toggled back off')
  tui.handleChar('\r')
  const answer = await pending
  // The highlight stayed on row 1, so that is what the circle marked and what
  // Enter answered with.
  assert.deepEqual(answer.answers[0].selected, ['甲'])
})

test('a question with no options still answers with the typed text', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({ questions: [{ id: 'free', question: '随便说' }] })
  await tick()
  assert.deepEqual([...tui.dialog.selected], [])
  tui.handleChar('好')
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers, [{ id: 'free', selected: [], custom: '好' }])
})

test('Esc stays the explicit cancel', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q', question: '取消我', options: [{ label: '甲' }, { label: '乙' }] }],
  })
  await tick()
  tui.handleChar('\x1b')
  await assert.rejects(() => pending)
})

test('the painted dialog puts the circle on the highlighted row', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({
    questions: [{ ...MULTI, options: [{ label: '甲甲甲' }, { label: '乙乙乙' }] }],
  })
  await tick()
  const lines = tui.captureFrame(60, 20).map(line => line.replace(/\u001b\[[0-9;]*m/gu, ''))
  const rowOf = label => lines.findIndex(line => line.includes(label))
  const first = rowOf('甲甲甲')
  const second = rowOf('乙乙乙')
  assert.ok(first >= 0 && second >= 0, 'both options are on screen')
  assert.match(lines[first], /●/, 'the circle is on the highlighted row')
  assert.equal(/●/u.test(lines[second]), false)

  tui.handleData(Buffer.from('\x1b[B'))
  const moved = tui.captureFrame(60, 20).map(line => line.replace(/\u001b\[[0-9;]*m/gu, ''))
  assert.match(moved[rowOf('乙乙乙')], /●/, 'and it followed the highlight')
  assert.equal(/●/u.test(moved[rowOf('甲甲甲')]), false, 'leaving the row behind')
  tui.handleChar('\r')
  await pending
})
