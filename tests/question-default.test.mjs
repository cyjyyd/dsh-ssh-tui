import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * Every option list opens with its first entry already chosen.
 *
 * The reported bug: an `ask_user_question` with `multiSelect` came back with
 * `selected: []` when the user simply pressed Enter, because the dialog started
 * with nothing ticked and only the single-select path fell back to the
 * highlight. The default is now established when the dialog is opened, so what
 * the screen shows and what Enter submits are the same thing.
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

test('a multi-select question opens with its first option chosen, and Enter submits it', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'pick',
      question: '接下来怎么走？',
      multiSelect: true,
      options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
    }],
  })
  await tick()
  assert.equal(tui.dialog?.kind, 'questions')
  assert.equal(tui.dialog.cursor, 0)
  assert.deepEqual([...tui.dialog.selected], [0], 'the first option is ticked on screen')

  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers, [{ id: 'pick', selected: ['甲'], custom: undefined }])
})

test('a single-select question opens on its first option too', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'one', question: '选一个', options: [{ label: 'alpha' }, { label: 'beta' }] }],
  })
  await tick()
  assert.deepEqual([...tui.dialog.selected], [0])
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers[0].selected, ['alpha'])
})

test('arrowing and toggling still beat the default', async () => {
  setLocale('zh')
  const tui = fixture()
  const pending = tui.handleUserQuestions({
    questions: [{
      id: 'pick',
      question: '多选',
      multiSelect: true,
      options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
    }],
  })
  await tick()
  // Deselect the default, then pick the third: the submitted set is the user's,
  // not the highlight.
  tui.handleChar('1')
  tui.handleChar('3')
  assert.deepEqual([...tui.dialog.selected], [2])
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers[0].selected, ['丙'])
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
