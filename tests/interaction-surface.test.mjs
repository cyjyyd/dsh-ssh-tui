/**
 * Who owns the keyboard, and what the surface means.
 *
 * Two things were true at once in 0.8.1 and both were wrong: `this.dialog` was one
 * field for a task stopping on a person and for a menu that only changes the
 * environment, and the composer's draft doubled as every dialog's text field. The
 * status row read the dialog's *shape*, so a `/model` picker claimed the agent was
 * waiting while an approval — a `confirm` — read as idle; and a paste or a
 * free-text answer could overwrite the message the reader was writing.
 *
 * These cases pin the ownership rules rather than the pixels: one key, one owner,
 * no fallthrough, and a draft that belongs to the composer until the composer is
 * the thing being typed into.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { errorText, pushRow, tick, waitFor, waitForDialog } from './wait.mjs'

setLocale('zh')

/** A TUI whose "process" never actually exits, so Ctrl+D is observable. */
function fixture(options = {}) {
  const exits = []
  const pane = []
  const settings = { update: async (namespace, value) => { pane.push({ namespace, value }) } }
  const ctx = {
    get: name => {
      if (name === 'appExit') return code => { exits.push(code) }
      if (name === 'settings') return settings
      if (name === 'userQuestions') return options.userQuestions
      return undefined
    },
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return { tui, exits, pane }
}

/** A picker, which is what every `/model`-style menu is built on. */
function openPicker(tui) {
  void tui.askQuestion(
    { id: 'pick', question: '切换到哪个模型？', options: [{ label: 'deepseek-v4' }, { label: 'grok-4.5' }] },
    0, 1,
  ).catch(() => undefined)
  return waitForDialog(tui, 'questions')
}

function openConfirmDialog(tui) {
  void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
  return waitForDialog(tui, 'confirm')
}

/** The status row as the terminal received it. */
function statusText(tui) {
  return tui.captureFrame(100, 30)
    .map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, ''))
    .filter(line => line.includes('│'))
    .join('\n')
}

// ── Ctrl+D ────────────────────────────────────────────────────────────────────

test('Ctrl+D exits from the composer, and only from the composer', async () => {
  const { tui, exits } = fixture()
  tui.handleChar('\x04')
  assert.equal(tui.exiting, true, 'the composer owns the exit key')
  // The exit itself is a promise chain (dispose, flush, then the exit hook); wait
  // for it so this case proves the whole path rather than only the flag.
  await waitFor(() => exits.includes(0), { describe: 'the exit hook' })
})

test('Ctrl+D inside a surface does not exit the process', async () => {
  for (const open of [openPicker, openConfirmDialog]) {
    const { tui, exits } = fixture()
    await open(tui)
    tui.handleChar('\x04')
    assert.deepEqual(exits, [], `a surface owns the keyboard: ${tui.dialog?.kind} must not exit`)
    assert.equal(tui.exiting, false)
    assert.notEqual(tui.dialog, undefined, 'and it is still there to be answered')
  }
})

// ── arrows under a confirmation ────────────────────────────────────────────────

test('an arrow a confirmation does not use never reaches the transcript', async () => {
  const { tui } = fixture()
  pushRow(tui, { kind: 'assistant', text: '先看一下。' })
  // Both fallbacks the router would otherwise reach: history rewrites the field,
  // and focus moves the selection behind the dialog. An empty composer and a
  // stocked history are what make either one observable — with a non-empty
  // composer and no history the leak is invisible, which is how it survived.
  tui.input = ''
  tui.cursor = 0
  tui.history.push('上一条消息')
  tui.historyIndex = tui.history.length
  await openConfirmDialog(tui)
  const before = { focus: tui.focusedRow, scroll: tui.scrollOffset, history: tui.historyIndex }
  // One press, asserted on its own: pressing both keys would let the second undo
  // what the first leaked, which is exactly how the first version of this case
  // passed against a router that still leaked.
  tui.handleData(Buffer.from('\x1b[A'))
  assert.equal(tui.input, '', 'history did not reach the field behind the dialog')
  assert.equal(tui.historyIndex, before.history, 'and the browse position did not move')
  assert.equal(tui.focusedRow, before.focus, 'the selection behind the dialog did not move')
  assert.equal(tui.scrollOffset, before.scroll, 'nor did the transcript scroll')
})

test('a picker keeps the arrows it uses, and drops the rest', async () => {
  const { tui } = fixture()
  tui.input = ''
  tui.history.push('上一条消息')
  tui.historyIndex = tui.history.length
  await openPicker(tui)
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.dialog?.cursor, 1, 'the list still moves')
  assert.equal(tui.input, '', 'and the field behind it is untouched')
  assert.equal(tui.historyIndex, tui.history.length)
})

// ── paste ─────────────────────────────────────────────────────────────────────

test('a paste into a surface without a text field changes nothing', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect'
  tui.cursor = 6
  await openConfirmDialog(tui)
  tui.handlePasteText('rm -rf /')
  assert.equal(tui.input, '请检查 reconnect', 'the composer draft is not a scratch buffer')
  assert.equal(tui.cursor, 6)
})

test('a paste into a picker never rewrites the composer draft', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect'
  tui.cursor = 6
  await openPicker(tui)
  // Through the real bracketed-paste path, not the sink directly: the markers are
  // what a terminal sends, and they must not be the thing that decides ownership.
  tui.handleData(Buffer.from('\x1b[200~grok\x1b[201~'))
  assert.equal(tui.input, '请检查 reconnect', 'the draft survives the menu')
  assert.equal(tui.cursor, 6)
  // …and the menu did not take it as input either: a picker with options answers by
  // highlight and hotkey, so a paste is not an answer.
  assert.equal(tui.dialog?.filter ?? '', '', 'no filter was typed by the paste')
})

test('a free-text answer is typed into the question, not into the draft', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect'
  tui.cursor = tui.input.length
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '回滚到哪个版本？' }] })
  await waitForDialog(tui, 'questions')
  tui.handlePasteText('上一版')
  assert.equal(tui.input, '请检查 reconnect', 'the draft is untouched while the answer is typed')
  tui.handleChar('\r')
  const answer = await pending
  assert.deepEqual(answer.answers, [{ id: 'q1', selected: [], custom: '上一版' }])
  assert.equal(tui.input, '请检查 reconnect', 'and it survives the answer')
})

// ── the inspect overlay's scroll convention ──────────────────────────────────

test('PgUp, the wheel and the arrows agree on which way is up', async () => {
  const { tui } = fixture()
  tui.screen = {
    kind: 'inspect',
    title: 'diff',
    lines: Array.from({ length: 80 }, (_line, index) => ({ kind: 'diff-add', text: `+ line ${index}` })),
    offset: 40,
  }
  const offset = () => tui.screen?.offset ?? -1
  tui.handleData(Buffer.from('\x1b[5~')) // PgUp
  const afterPageUp = offset()
  assert.ok(afterPageUp < 40, `PgUp goes toward the top (offset ${afterPageUp})`)
  tui.handleData(Buffer.from('\x1b[6~')) // PgDn
  assert.ok(offset() > afterPageUp, 'PgDn goes back down')
  tui.screen.offset = 40
  tui.handleData(Buffer.from('\x1b[<64;10;10M')) // wheel up
  assert.ok(offset() < 40, `wheel up goes toward the top (offset ${offset()})`)
  tui.screen.offset = 40
  tui.handleData(Buffer.from('\x1b[<65;10;10M')) // wheel down
  assert.ok(offset() > 40, 'wheel down goes the other way')
  tui.screen.offset = 40
  tui.handleData(Buffer.from('\x1b[A'))
  assert.ok(offset() < 40, 'and the up arrow agrees with both')
})

test('a scroll aimed at a dialog does not move the transcript behind it', async () => {
  const { tui } = fixture()
  for (let index = 0; index < 40; index += 1) pushRow(tui, { kind: 'assistant', text: `第 ${index} 行` })
  await openConfirmDialog(tui)
  tui.handleData(Buffer.from('\x1b[5~'))
  tui.handleData(Buffer.from('\x1b[<64;10;10M'))
  assert.equal(tui.scrollOffset, 0, 'the view behind a confirmation is not the reader’s target')
})

// ── status semantics ─────────────────────────────────────────────────────────

test('a picker no longer claims the agent is waiting, an approval no longer reads idle', async () => {
  const { tui } = fixture()

  await openPicker(tui)
  assert.equal(statusText(tui).includes('等待回答'), false, 'a menu is not the task waiting')
  assert.equal(errorText(tui).includes('等待审批'), false)

  tui.handleEscape()
  await tick(0)
  assert.equal(tui.dialog, undefined)

  void tui.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } })
  await waitForDialog(tui, 'confirm')
  assert.ok(statusText(tui).includes('等待审批'), `an approval is a wait:\n${statusText(tui)}`)
  tui.handleChar('n')
  await tick(0)
})

test('a question and a plan review read as their own states', async () => {
  const { tui } = fixture()
  const question = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }] }],
  })
  await waitForDialog(tui, 'questions')
  assert.ok(statusText(tui).includes('等待回答'), `a question is a wait:\n${statusText(tui)}`)
  tui.handleChar('\r')
  await question.catch(() => undefined)
  await tick(0)

  const review = tui.handleUserQuestions({
    questions: [{
      id: 'plan-review',
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: '# 修复构建\n\n1. 找到失败的步骤',
      options: [{ label: 'Approve and run' }, { label: 'Keep planning' }],
      intent: { kind: 'plan-review', approve: 'Approve and run', callId: 'call-plan' },
    }],
  })
  await waitForDialog(tui, 'questions')
  assert.ok(statusText(tui).includes('计划待审'), `a plan review is its own state:\n${statusText(tui)}`)
  tui.handleEscape()
  await review.catch(() => undefined)
  await tick(0)
})

test('a question the Session still holds is a record, not a wait', async () => {
  const state = {
    questions: {
      active: [{ callId: 'call-q9', questions: [{ id: 'q9', question: '继续吗？' }], state: 'continued' }],
      settled: [],
    },
  }
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => state } : undefined),
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {} }
  tui.write = () => {}
  tui.handleSessionEvent({ id: 'main-session' }, {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: {
      callId: 'call-q9',
      name: 'ask_user_question',
      arguments: JSON.stringify({ questions: [{ id: 'q9', question: '继续吗？', timeout: 1_000 }] }),
    },
  })
  assert.equal(tui.rows.filter(row => row.kind === 'question').length, 1, 'the card is drawn')
  assert.equal(statusText(tui).includes('等待回答'), false, 'but nobody is blocked on it')
})

// ── the composer's draft ─────────────────────────────────────────────────────

test('a picker comes and goes without touching the draft', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect logic'
  tui.cursor = 8
  await openPicker(tui)
  for (const key of ['\x1b[B', '\x1b[B', '\x1b[A']) tui.handleData(Buffer.from(key))
  tui.handleEscape()
  await tick(0)
  assert.equal(tui.dialog, undefined, 'the picker closed')
  assert.equal(tui.input, '请检查 reconnect logic', 'the draft is exactly what it was')
  assert.equal(tui.cursor, 8, 'caret included')
})

test('answer a question and the draft is still there', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect logic'
  tui.cursor = tui.input.length
  const pending = tui.handleUserQuestions({
    questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }, { label: '生产' }] }],
  })
  await waitForDialog(tui, 'questions')
  tui.handleData(Buffer.from('\x1b[B'))
  tui.handleChar('\r')
  await pending
  assert.equal(tui.input, '请检查 reconnect logic')
  assert.equal(tui.cursor, tui.input.length)
})

test('a detach and reattach keep the draft', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect logic'
  tui.cursor = 5
  tui.detachDisplay()
  await tick(10)
  assert.equal(tui.input, '请检查 reconnect logic', 'the Host still holds the session')
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await tick(10)
  assert.equal(tui.input, '请检查 reconnect logic')
  assert.equal(tui.cursor, 5)
})

test('the borrowed field is drawn in the composer row, so nothing moved', async () => {
  const { tui } = fixture()
  tui.input = '请检查 reconnect logic'
  const before = tui.captureFrame(80, 24).length
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '回滚到哪个版本？' }] })
  await waitForDialog(tui, 'questions')
  tui.handleChar('上')
  const frame = tui.captureFrame(80, 24)
  assert.equal(frame.length, before, 'same number of rows as before the question')
  const plain = frame.map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, ''))
  assert.ok(plain.some(line => line.trim() === '❯ 上' || line.trim() === '> 上'), `the answer is typed in the composer row:\n${plain.join('\n')}`)
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
  assert.equal(tui.input, '请检查 reconnect logic', 'and the draft comes back when the question is gone')
})

// ── the owner contract ───────────────────────────────────────────────────────

test('one owner per key: the contract every surface keeps', async () => {
  // The point of the split is that this table can be written down at all. Each
  // row is one owner; each cell is what that owner does with the key. `ignored`
  // means the key is consumed and dropped — never forwarded to another surface.
  const cases = [
    {
      name: 'composer',
      open: async () => {},
      // The composer is the only owner that types into the draft and exits.
      expect: { text: 'typed', enter: 'submits', updown: 'history', paste: 'draft' },
    },
    {
      name: 'picker',
      open: openPicker,
      expect: { text: 'ignored', enter: 'answers', updown: 'list', paste: 'ignored' },
    },
    {
      name: 'interaction/confirm',
      open: openConfirmDialog,
      expect: { text: 'ignored', enter: 'ignored', updown: 'ignored', paste: 'ignored' },
    },
  ]
  for (const entry of cases) {
    const { tui } = fixture()
    tui.input = ''
    tui.history.push('上一条消息')
    tui.historyIndex = tui.history.length
    await entry.open(tui)

    tui.handleChar('x')
    const typed = tui.input === 'x'
    assert.equal(typed, entry.expect.text === 'typed', `${entry.name}: ordinary text`)

    const before = { input: tui.input, cursor: tui.cursor, history: tui.historyIndex, dialog: tui.dialog !== undefined }
    tui.handleData(Buffer.from('\x1b[A'))
    const moved = tui.input !== before.input || tui.historyIndex !== before.history
    assert.equal(moved, entry.expect.updown === 'history', `${entry.name}: ↑ stays inside the owner`)
    if (entry.expect.updown === 'list') assert.notEqual(tui.dialog?.cursor, undefined, `${entry.name}: ↑ moves the list`)

    tui.handleData(Buffer.from('\x1b[200~pasted\x1b[201~'))
    const pasted = tui.input.includes('pasted')
    assert.equal(pasted, entry.expect.paste === 'draft', `${entry.name}: paste goes to the text owner or nowhere`)

    // Enter belongs to the owner too: the composer sends, a picker answers, a
    // confirmation does nothing with it.
    let sent = 0
    tui.agent.followup = () => { sent += 1 }
    tui.agent.steer = () => { sent += 1 }
    tui.input = 'x'
    tui.cursor = 1
    tui.handleChar('\r')
    await tick(0)
    assert.equal(
      sent,
      entry.expect.enter === 'submits' ? 1 : 0,
      `${entry.name}: Enter ${entry.expect.enter === 'submits' ? 'sends the message' : 'never sends one'}`,
    )
    if (entry.expect.enter === 'ignored') {
      assert.notEqual(tui.dialog, undefined, `${entry.name}: Enter is dropped, not forwarded`)
    } else {
      assert.equal(tui.dialog, undefined, `${entry.name}: Enter answers the open surface`)
    }

    // And the surface is closed the way its own contract says, so the next case
    // starts clean.
    if (tui.dialog !== undefined) {
      tui.handleEscape()
      await tick(0)
    }
  }
})

// ── a Screen is an owner too ─────────────────────────────────────────────────

/** A wizard parked on a field step, opened the way production opens it. */
function openSetup(tui, step = 'key', overrides = {}) {
  tui.onboarding = {
    step, providerType: 'official', providerId: 'deepseek-official', baseUrl: '', key: '',
    models: [], catalogPresets: undefined, catalog: undefined, providerCursor: 0,
    saving: false, field: '', fieldCursor: 0, resolve() {},
    ...overrides,
  }
  tui.openScreen({ kind: 'setup', title: '首次配置向导', lines: [], offset: 0 })
  return tui
}

/** Every Screen kind, opened the way its command opens it. */
const SCREENS = [
  ['setup', openSetup],
  ['report', tui => tui.openScreen({ kind: 'report', report: 'diag', title: '诊断', lines: [{ kind: 'system', text: '一行正文' }], offset: 0 })],
  ['inspect', tui => tui.openScreen({ kind: 'inspect', title: 'diff', lines: [{ kind: 'diff-add', text: '+ 一行' }], offset: 0 })],
]

test('a Screen owns the composer’s own keys, not just the printable ones', () => {
  // The leak this pins: a Screen is not a dialog, and every guard the composer's
  // editing keys carry reads `this.dialog === undefined`. So Backspace, Ctrl+U,
  // Ctrl+K, Ctrl+A/E, Ctrl+R, Ctrl+T and Enter all walked past the Screen and spent
  // themselves on the draft behind it — invisibly, because a Screen paints none of
  // that draft. One key per TUI and one delivery path, so a key that legitimately
  // closes the Screen cannot leak into the next assertion.
  const keys = [
    ['\x7f', 'Backspace'], ['\x08', 'Ctrl+H'], ['\x15', 'Ctrl+U'], ['\x0b', 'Ctrl+K'],
    ['\x01', 'Ctrl+A'], ['\x05', 'Ctrl+E'], ['\x12', 'Ctrl+R'], ['\x14', 'Ctrl+T'],
    ['\r', 'Enter'], ['\x03', 'Ctrl+C'], ['\x04', 'Ctrl+D'], ['x', 'a printable key'],
  ]
  for (const [name, open] of SCREENS) {
    for (const [key, label] of keys) {
      for (const path of ['handleData', 'handleChar']) {
        const { tui, exits } = fixture()
        tui.input = 'the draft I was writing'
        tui.cursor = 8
        tui.history.push('an earlier prompt')
        tui.historyIndex = 0
        pushRow(tui, {
          kind: 'tool', callId: 'c1', name: 'bash', title: 'bash', summary: 'ls',
          args: '{}', output: 'ok', status: 'ok', expanded: false,
        })
        open(tui)
        if (path === 'handleData') tui.handleData(Buffer.from(key))
        else tui.handleChar(key)
        const where = `${name} + ${label} via ${path}`
        assert.equal(tui.input, 'the draft I was writing', `${where}: the draft belongs to the composer`)
        assert.equal(tui.cursor, 8, `${where}: and so does its caret`)
        assert.equal(tui.historyIndex, 0, `${where}: the browse position did not move`)
        assert.equal(tui.rows.find(row => row.kind === 'tool')?.expanded, false, `${where}: no card was folded or unfolded`)
        assert.equal(tui.focusedRow, null, `${where}: and no card was selected`)
        assert.equal(tui.inputFolded, false, `${where}: the composer’s fold is the composer’s`)
        assert.deepEqual(exits, [], `${where}: and the process was not told to exit`)
      }
    }
  }
})

test('a paste at a Screen with no field goes nowhere at all', () => {
  for (const [name, open] of SCREENS.slice(1)) {
    const { tui } = fixture()
    tui.input = 'the draft I was writing'
    tui.cursor = 8
    open(tui)
    tui.handleData(Buffer.from('\x1b[200~rm -rf /\x1b[201~'))
    assert.equal(tui.input, 'the draft I was writing', `${name}: a Screen without a field takes no paste`)
    assert.equal(tui.cursor, 8, `${name}: caret included`)
    assert.equal(tui.screen?.kind, name, `${name}: and it is still the Screen that is up`)
  }
})

test('a read that carries several keys is not one key', () => {
  // A terminal hands over whatever arrived together. `text\r` is a fast typist on a
  // slow link, and the wizard used to take the whole read as one key: the text landed
  // and the Enter was dropped, so the step never advanced — the reader pressed Enter
  // again and blamed the keyboard.
  const { tui } = fixture()
  openSetup(tui)
  tui.handleData(Buffer.from('sk-live-1234\r'))
  assert.equal(tui.onboarding.field, '', 'the field was submitted, not left holding the key')
  assert.equal(tui.onboarding.key, 'sk-live-1234', 'with what was typed')
  assert.equal(tui.onboarding.step, 'models', 'and the step advanced on the Enter in that read')

  // Two backspaces in one read are two backspaces.
  const second = openSetup(fixture().tui, 'id', { field: 'deepseek', fieldCursor: 'deepseek'.length })
  second.handleData(Buffer.from('\x7f\x7f'))
  assert.equal(second.onboarding.field, 'deepse', 'each control byte is its own key')

  // A CRLF is one Enter, not two.
  const third = openSetup(fixture().tui)
  third.handleData(Buffer.from('sk-live-1234\r\n'))
  assert.equal(third.onboarding.step, 'models', 'the Windows pair is the one Enter it is')
  assert.equal(third.onboarding.key, 'sk-live-1234')

  // And a run of printable text is still one key: a paste without markers must not
  // answer the confirmation by falling apart into `y` plus leftovers.
  const fourth = openSetup(fixture().tui, 'confirm')
  fourth.handleData(Buffer.from('yes'))
  assert.equal(fourth.onboarding?.saving, false, 'a pasted "yes" is not an answer')
  assert.equal(fourth.onboarding?.step, 'confirm')

  // Two arrows in one read scroll twice, rather than being dropped whole.
  const fifth = fixture().tui
  fifth.screen = {
    kind: 'report',
    title: '诊断',
    lines: Array.from({ length: 80 }, (_line, index) => ({ kind: 'system', text: `第 ${index} 行` })),
    offset: 40,
  }
  fifth.handleData(Buffer.from('\x1b[B\x1b[B'))
  assert.equal(fifth.screen.offset, 42, 'each arrow in the read moved the Screen')
})

// ── Standard / Minimal / line mode share one semantic state ─────────────────

test('both workspace views report the same interaction states', async () => {
  const seen = []
  for (const view of ['detailed', 'compact']) {
    const { tui } = fixture()
    tui.setWorkspaceView(view)
    const pending = tui.handleUserQuestions({
      questions: [{ id: 'q1', question: '要部署到哪个环境？', options: [{ label: '预发' }] }],
    })
    await waitForDialog(tui, 'questions')
    seen.push(`${view}:${statusText(tui).includes('等待回答')}`)
    tui.handleChar('\r')
    await pending.catch(() => undefined)
    await tick(0)
    // The picker must read the same way in both: the mode is presentation, not
    // semantics.
    await openPicker(tui)
    seen.push(`${view}:${statusText(tui).includes('等待回答')}`)
    tui.handleEscape()
    await tick(0)
  }
  assert.deepEqual(seen, [
    'detailed:true', 'detailed:false',
    'compact:true', 'compact:false',
  ])
})

test('line mode still echoes an interaction instead of owning a screen', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  const written = []
  tui.write = chunk => written.push(chunk)
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '继续吗？', options: [{ label: '好' }] }] })
  await waitFor(() => tui.rows.some(row => String(row.text).includes('继续吗')), { describe: 'the echoed question' })
  const echoed = tui.rows.map(row => String(row.text)).join('\n')
  assert.ok(echoed.includes('继续吗'), 'the question is in the log a `tee` can read')
  assert.ok(echoed.includes('好'), 'and so are its options')
  tui.handleChar('\r')
  await pending.catch(() => undefined)
  await tick(0)
})

test('Enter on a question the Session still holds answers it through the service', async () => {
  const state = {
    questions: {
      active: [{ callId: 'call-q9', questions: [{ id: 'q9', question: '继续吗？' }], state: 'continued' }],
      settled: [],
    },
  }
  const answers = []
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => state }
      if (name === 'userQuestions') {
        return { answer: (agent, callId, batch) => { answers.push({ agent: agent.id, callId, batch }); return true } }
      }
      return undefined
    },
    on() { return () => {} },
  }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {} }
  tui.write = () => {}
  tui.handleSessionEvent({ id: 'main-session' }, {
    type: 'tool/call',
    seq: 1,
    time: Date.now(),
    data: {
      callId: 'call-q9',
      name: 'ask_user_question',
      arguments: JSON.stringify({
        questions: [{ id: 'q9', question: '继续吗？', options: [{ label: '继续' }, { label: '停' }], timeout: 1_000 }],
      }),
    },
  })
  const [card] = tui.rows.filter(row => row.kind === 'question')
  assert.equal(card.continued, true, 'the Session says it is still answerable')

  // Enter on the card is the action the durable state makes possible: the request
  // that first asked it is long gone, and `ctx.userQuestions.answer` is the only
  // channel that can still settle it.
  tui.focusedRow = card
  // The card's own Enter path: `submit()` reads the focused row when the composer
  // is empty, which is how a reader reaches a card without typing anything.
  tui.input = ''
  tui.cursor = 0
  tui.handleChar('\r')
  await waitForDialog(tui, 'questions')
  tui.handleData(Buffer.from('\x1b[B'))
  tui.handleChar('\r')
  await waitFor(() => answers.length === 1, { describe: 'the answer reaching the service' })
  assert.equal(answers[0].callId, 'call-q9', 'the call the Session named')
  assert.equal(answers[0].agent, 'main-session')
  assert.deepEqual(answers[0].batch.answers, [{ id: 'q9', selected: ['停'] }], 'the batch keeps the call’s own shape')
})
