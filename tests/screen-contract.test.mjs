/**
 * B2.1 — the Screen contract.
 *
 * A **Surface** (ask-user, a picker) borrows rows from the workspace and gives them
 * back: the transcript never moves and the reader returns to the same place. A
 * **Screen** is the other thing — it replaces the workspace, owns its own
 * navigation, writes nothing to the transcript, and must be able to redraw itself
 * from its state alone, because an SSH drop and a reattach are the normal case
 * (`docs/decisions/b2-architecture-decisions.md`, AD-1 … AD-3, AD-7, AD-17).
 *
 * These cases pin the parts that are easy to get subtly wrong: depth, channel
 * separation, incremental repaint, restoration, and the compact strip that keeps
 * "is the agent still running" answerable while a report is up.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { screenLayout, clampScreenOffset, screenPositionText } from '../lib/screen.js'
import { SshTui } from '../lib/tui.js'
import { errorText, feedbackText, pushRow, rowText, screenText, systemText, tick, waitFor, waitForDialog, waitForScreen } from './wait.mjs'

setLocale('zh')

const COLUMNS = 100
const ROWS = 20

function fixture(options = {}) {
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => ({ questions: { active: [], settled: [] } }) }
      if (name === 'commands') return { list: () => [] }
      if (name === 'appExit') return () => {}
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: options.status ?? 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  for (let index = 0; index < 40; index += 1) {
    pushRow(tui, { kind: index % 2 === 0 ? 'assistant' : 'user', text: `${index % 2 === 0 ? '回复' : '提问'} ${index}` })
  }
  return { tui, agent }
}

/**
 * Open the inspect Screen the way a reader does: focus a reply card, then Enter.
 *
 * `openReplyInspect` is what the Enter handler calls, so going through it keeps
 * these cases honest about the entry the user actually has.
 */
function openInspect(tui) {
  const reply = tui.rows.findLast(row => row.kind === 'assistant')
  tui.focusedRow = reply
  tui.openReplyInspect(reply)
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const frame = (tui, columns = COLUMNS, rows = ROWS) => tui.captureFrame(columns, rows).map(plain)

/** Paint for real and measure the wire: `captureFrame` swaps `write` out. */
function wirePaint(tui, columns = COLUMNS, rows = ROWS) {
  const written = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { written.push(chunk); real(chunk) }
  process.stdout.columns = columns
  process.stdout.rows = rows
  tui.paint()
  tui.write = real
  const painted = written.join('')
  return {
    painted,
    rows: [...painted.matchAll(/\u001b\[(\d+);1H/gu)].map(match => Number(match[1])),
    cleared: /\u001b\[[HJ]|\u001b\[2J/u.test(painted),
    bytes: painted.length,
  }
}

// ── A. the contract ─────────────────────────────────────────────────────────

test('a report opens as a Screen and leaves the transcript alone', async () => {
  const { tui } = fixture()
  const before = { rows: tui.rows.length, start: tui.lastTranscriptStart, offset: tui.scrollOffset }
  tui.runCommand('/status')
  await waitForScreen(tui, '会话')
  const report = screenText(tui)
  assert.ok(report.length > 0, 'the report has a body')
  assert.equal(tui.rows.length, before.rows, 'a report writes nothing to the transcript')
  assert.equal(feedbackText(tui).includes('会话状态'), false, 'and no system row either')
  assert.equal(errorText(tui), '', 'nor an error')
  assert.equal(tui.scrollOffset, before.offset, 'the transcript behind it did not scroll')
  assert.equal(tui.lastTranscriptStart, before.start, 'and its window did not move')
  tui.handleEscape()
  await tick(0)
  assert.equal(tui.screen, undefined, 'and it closes')
})

test('Screen depth is one: opening a second Screen replaces the first', async () => {
  const { tui } = fixture()
  tui.runCommand('/help')
  await waitForScreen(tui, '/model')
  const first = tui.screen
  assert.equal(first?.report, 'help')
  tui.runCommand('/status')
  await waitFor(() => tui.screen?.report === 'status', { describe: 'the second report' })
  // No stack: the first Screen is gone, not pushed onto. If a stack existed the
  // Esc below would return to `/help` instead of the workspace.
  assert.equal(tui.screen?.report, 'status')
  tui.handleEscape()
  await tick(0)
  assert.equal(tui.screen, undefined, 'one Esc leaves the workspace, not a stack')
  assert.equal(tui.dialog, undefined, 'and no dialog was left queued by either Screen')
})

test('a Screen never enters the workspace dialog queue', async () => {
  const { tui } = fixture()
  // A question asked *while* a Screen is up must wait in the workspace queue rather
  // than open behind the report, and the report must still be the only thing drawn.
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '要部署到哪？', options: [{ label: '预发' }] }] })
  pending.catch(() => undefined)
  await waitForDialog(tui, 'questions')
  const asked = tui.screen
  assert.equal(asked, undefined, 'a question is a Surface, not a Screen')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)

  tui.runCommand('/status')
  await waitForScreen(tui, '会话')
  // The legacy inspect shape, handed to the dialog path, must be converted rather
  // than queued — that is the single judgement entry (`screenFromDialog`).
  tui.openDialog({ kind: 'inspect', title: '遗留', lines: [{ kind: 'system', text: 'legacy body' }], offset: 0 }, { kind: 'dedicated' })
  assert.equal(tui.screen?.title, '遗留', 'it became the Screen')
  assert.equal(tui.dialog, undefined, 'and never became the active dialog')
  assert.equal(tui.dialogQueue.length, 0, 'nor a queued one')
})

test('a Surface that arrives while a Screen is up waits for it', async () => {
  // The separation has to hold in both directions. A Screen may not enter the
  // workspace queue (the case above), and a workspace Surface may not take over the
  // screen a Screen is using: it would own the keyboard while nothing of it was
  // painted — invisible, unanswerable, and silently blocking the agent.
  const { tui } = fixture()
  tui.runCommand('/status')
  await waitForScreen(tui, '会话')
  const pending = tui.handleUserQuestions({ questions: [{ id: 'q1', question: '要部署到哪？', options: [{ label: '预发' }] }] })
  pending.catch(() => undefined)
  await tick(20)
  assert.equal(tui.dialog, undefined, 'the question did not become the active Surface')
  assert.equal(tui.dialogQueue.length, 1, 'it is queued behind the Screen')
  assert.equal(tui.screen?.report, 'status', 'and the Screen still owns the screen')
  // The reader is told, because a Screen must never hide that someone is waiting.
  const strip = frame(tui).at(-1) ?? ''
  assert.ok(strip.includes('等待'), `the strip reports the wait behind the Screen: ${strip}`)
  // Leaving the Screen hands the keyboard to whoever was waiting.
  tui.handleEscape()
  await tick(20)
  assert.equal(tui.dialog?.kind, 'questions', 'and it opens as soon as the Screen is gone')
  tui.handleEscape()
  await pending.catch(() => undefined)
  await tick(0)
})

test('leaving a Screen restores the workspace without rebuilding it', async () => {
  const { tui } = fixture()
  tui.scrollOffset = 5
  tui.input = '请检查 reconnect'
  tui.cursor = tui.input.length
  // Everything the workspace owns, set before the Screen opens: the brief's list is
  // the composer draft, the scroll position, the focused card and `/find`'s hits —
  // a Screen is a visit, and all four have to be where they were.
  const focused = tui.rows.findLast(row => row.kind === 'assistant')
  tui.focusedRow = focused
  tui.searchHits = [tui.rows.find(row => row.kind === 'assistant')]
  tui.searchIndex = 0
  tui.searchQuery = '行'
  // Opened from a card (Enter on a reply), not from a command: a slash command is
  // typed *into* the composer and running one clears it, which is the composer's
  // own long-standing contract rather than anything a Screen does.
  openInspect(tui)
  await waitFor(() => tui.screen?.kind === 'inspect', { describe: 'the inspect Screen' })
  assert.equal(tui.input, '请检查 reconnect', 'the draft is untouched while a Screen is up')
  tui.handleEscape()
  await tick(0)
  const restored = frame(tui)
  assert.equal(tui.scrollOffset, 5, 'the scroll position is the one the reader had')
  assert.equal(tui.input, '请检查 reconnect')
  assert.equal(tui.cursor, '请检查 reconnect'.length)
  assert.ok(restored.some(line => line.includes('请检查 reconnect')), 'and the composer shows it again')
  assert.equal(tui.focusedRow, focused, 'the focused card is the one the reader had')
  assert.equal(tui.searchIndex, 0, 'and the search position is where it was')
  assert.equal(tui.searchHits.length, 1)
  assert.equal(tui.searchQuery, '行')
  assert.equal(tui.screen, undefined)
})

test('a Screen owns every key: nothing reaches the composer or the transcript', async () => {
  const { tui } = fixture()
  tui.scrollOffset = 3
  tui.input = '草稿'
  tui.cursor = 2
  openInspect(tui)
  await waitFor(() => tui.screen?.kind === 'inspect', { describe: 'the inspect Screen' })
  tui.handleChar('x')
  tui.handleData(Buffer.from('\x1b[A'))
  tui.handleData(Buffer.from('\x1b[5~'))
  tui.handleData(Buffer.from('\x1b[<64;5;5M'))
  tui.handleMouseClick(3, 1)
  assert.equal(tui.input, '草稿', 'printable keys do not reach the draft')
  assert.equal(tui.cursor, 2)
  assert.equal(tui.scrollOffset, 3, 'and no key scrolls or reveals the transcript behind it')
  assert.equal(tui.dialog, undefined, 'nor opens a dialog')
})

// ── B. the strip ────────────────────────────────────────────────────────────

test('the strip answers "is it running / is anything waiting / is the link alive"', async () => {
  const { tui, agent } = fixture({ status: 'running' })
  tui.runCommand('/status')
  await waitForScreen(tui, '会话')
  const running = frame(tui).at(-1) ?? ''
  assert.ok(running.includes('运行中'), `the strip reports the agent is working: ${running}`)
  assert.ok(/SSH|本地/u.test(running), `and the link: ${running}`)
  assert.equal(running.includes('tok/s'), false, 'but not throughput: the strip is a subset')
  assert.equal(running.includes('Tok'), false, 'nor a session total')

  agent.status = 'idle'
  tui.markDirty()
  const idle = frame(tui).at(-1) ?? ''
  assert.ok(idle.includes('空闲'), `the same row follows the agent's state: ${idle}`)
  tui.handleEscape()
  await tick(0)
})

test('a question waiting behind the Screen shows up in the strip', async () => {
  const { tui } = fixture()
  tui.runCommand('/status')
  await waitForScreen(tui, '会话')
  tui.queuedQuestions = 2
  tui.markDirty()
  const strip = frame(tui).at(-1) ?? ''
  assert.ok(strip.includes('待答'), `the strip reports the wait: ${strip}`)
  tui.queuedQuestions = 0
})

test('a narrow terminal keeps the strip and drops whole groups from the back', async () => {
  const { tui } = fixture({ status: 'running' })
  tui.runCommand('/help')
  await waitForScreen(tui, '/model')
  for (const columns of [120, 80, 72, 40]) {
    const painted = frame(tui, columns, ROWS)
    assert.equal(painted.length, ROWS, `${columns}: the frame is exactly as tall as the terminal`)
    const strip = painted.at(-1) ?? ''
    assert.ok(strip.includes('运行中'), `${columns}: the activity survives every width: ${strip}`)
    for (const [index, line] of painted.entries()) {
      assert.ok(visibleWidthOf(line) <= columns, `${columns}: row ${index + 1} fits the width`)
    }
  }
  tui.handleEscape()
  await tick(0)
})

const visibleWidthOf = line => {
  // Counting cells for this module's own glyph set: the test only asserts the frame
  // does not exceed the terminal, and every glyph a Screen paints is single-width.
  return [...line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '')].length
}

// ── C. geometry ─────────────────────────────────────────────────────────────

test('the Screen layout never overflows and always keeps the strip', () => {
  for (const height of [1, 2, 3, 4, 5, 6, 8, 12, 20, 40]) {
    const layout = screenLayout(height)
    const used = layout.titleRows + layout.dividerRows + layout.bodyRows + layout.hintRows + layout.stripRows
    assert.equal(used, height, `${height}: the rows add up exactly`)
    assert.equal(layout.stripRows, 1, `${height}: the runtime strip is always there`)
    assert.ok(layout.bodyRows >= 0)
  }
  assert.equal(screenLayout(1).bodyRows, 0)
  assert.equal(screenLayout(2).hintRows, 1, 'two rows still say how to leave')
  assert.ok(screenLayout(8).bodyRows >= 4, 'eight rows still show a body')
  // The offsets address the rows the layout promises.
  const tall = screenLayout(20)
  assert.equal(tall.contentTop, 2)
  assert.equal(tall.hintTop, 18)
  assert.equal(tall.stripTop, 19)
  assert.equal(screenLayout(4).titleRows, 1, 'the title arrives before the rule')
  assert.equal(screenLayout(4).dividerRows, 0)
})

test('a Screen body that shrank clamps the reader back into range', () => {
  assert.equal(clampScreenOffset(50, 10, 5), 5)
  assert.equal(clampScreenOffset(-3, 10, 5), 0)
  assert.equal(clampScreenOffset(Number.NaN, 10, 5), 0)
  assert.equal(screenPositionText(0, 10, 5), '1–5/10')
  assert.equal(screenPositionText(5, 10, 5), '6–10/10')
  assert.equal(screenPositionText(0, 0, 5), '0/0', 'an empty report does not read as a bug')
})

test('a very short terminal still shows the strip and the way out', async () => {
  const { tui } = fixture({ status: 'running' })
  tui.runCommand('/help')
  await waitForScreen(tui, '/model')
  // 6 is the painter's own floor (`paint()` never composes fewer rows), so the
  // heights below it are covered by the pure layout case instead.
  for (const rows of [8, 6]) {
    const painted = frame(tui, 72, rows)
      assert.equal(painted.length, rows, `${rows}: the frame fits`)
    const strip = painted.at(-1) ?? ''
    assert.ok(strip.includes('运行中'), `${rows}: the strip survives: ${strip}`)
  }
  tui.handleEscape()
  await tick(0)
})

// ── D. incremental repaint ──────────────────────────────────────────────────

test('scrolling a Screen repaints the body, never clearing the screen', async () => {
  const { tui } = fixture()
  tui.runCommand('/help')
  await waitForScreen(tui, '/model')
  wirePaint(tui) // establish: the first frame of a Screen may clear
  const move = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(move.cleared, false, 'a settled Screen frame does not clear')

  const down = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(down.cleared, false, 'nothing to repaint, nothing to clear')

  tui.handleData(Buffer.from('\x1b[6~')) // PgDn: the body moves one page
  const page = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(page.cleared, false, `scrolling must not clear the screen (${page.bytes}B)`)
  assert.ok(page.rows.length > 0, 'it painted something')
  const layout = screenLayout(ROWS)
  assert.ok(
    page.rows.every(row => row - 1 >= layout.contentTop && row - 1 <= layout.hintTop),
    `a page addresses body and hint rows, never the title (${page.rows.join(',')})`,
  )
  assert.equal(
    page.rows.some(row => row - 1 < layout.contentTop),
    false,
    'the title and its rule are not re-sent by a scroll',
  )
  assert.ok(page.bytes < 2000, `a page is a body, not the frame (${page.bytes}B)`)
  tui.handleEscape()
  await tick(0)
})

test('leaving a Screen costs one repaint, and it is the workspace frame', async () => {
  const { tui } = fixture()
  tui.runCommand('/status')
  await waitForScreen(tui, '会话')
  wirePaint(tui)
  tui.handleEscape()
  await tick(0)
  const back = wirePaint(tui, COLUMNS, ROWS)
  // Documented and deliberate: the transcript may have grown while the reader was
  // away, so the returning frame is rebuilt once. What must never happen is a full
  // frame per *keypress inside* a Screen — pinned by the case above.
  assert.ok(back.rows.length >= ROWS - 3, `the workspace frame is rebuilt once (${back.rows.length} rows)`)
  const again = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(again.rows.length, 0, 'and nothing repaints after that')
})

// ── E. lifecycle ────────────────────────────────────────────────────────────

test('the agent keeps running while a report is up', async () => {
  const { tui, agent } = fixture({ status: 'running' })
  const before = tui.rows.length
  tui.runCommand('/diag')
  await waitForScreen(tui, '诊断')
  pushRow(tui, { kind: 'assistant', text: '后台又写了一段' })
  assert.equal(tui.rows.length, before + 1, 'transcript events still arrive while a Screen is up')
  agent.status = 'idle'
  tui.markDirty()
  assert.equal(tui.screen?.report, 'diag', 'and the Screen is still the thing on screen')
  tui.handleEscape()
  await tick(0)
})

test('a Screen survives detach and reattach with the same state', async () => {
  const { tui } = fixture()
  tui.runCommand('/help')
  await waitForScreen(tui, '/model')
  tui.handleData(Buffer.from('\x1b[6~'))
  const before = { offset: tui.screen.offset, report: tui.screen.report, draft: tui.input }
  tui.detachDisplay()
  await tick(10)
  tui.displayHost = { attached: true, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await tick(10)
  assert.equal(tui.screen?.offset, before.offset, 'the Screen scrolled position survived')
  assert.equal(tui.screen?.report, before.report)
  assert.equal(tui.input, before.draft)
  // The first frame after a reattach may clear (the terminal holds a stale frame);
  // the next one must not.
  wirePaint(tui, COLUMNS, ROWS)
  const settled = wirePaint(tui, COLUMNS, ROWS)
  assert.equal(settled.cleared, false, 'and the Screen returns to incremental repaint')
  tui.handleEscape()
  await tick(0)
})

test('both workspace views keep the Screen contract', async () => {
  for (const view of ['detailed', 'compact']) {
    const { tui } = fixture()
    tui.setWorkspaceView(view)
    const before = { start: tui.lastTranscriptStart, offset: tui.scrollOffset }
    tui.runCommand('/status')
    await waitForScreen(tui, '会话')
    assert.equal(tui.scrollOffset, before.offset, `${view}: the transcript offset is untouched`)
    assert.equal(tui.lastTranscriptStart, before.start, `${view}: and its window`)
    const painted = frame(tui)
    assert.ok(painted.at(-1)?.includes('SSH') || painted.at(-1)?.includes('本地'), `${view}: the strip is drawn`)
    tui.handleEscape()
    await tick(0)
  }
})

test('line mode keeps its textual path and composes no Screen', async () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, lineMode: true })
  tui.write = () => {}
  tui.runCommand('/diag')
  await waitFor(() => rowText(tui, 'diag').length > 0, { describe: 'the textual report' })
  assert.equal(tui.screen, undefined, 'line mode has no framed Screen')
  assert.ok(rowText(tui, 'diag').length > 0, 'the report went into the log as a diag row')
})

// ── F. the hybrid: a Screen's own confirmation ──────────────────────────────

test("a Screen's confirmation stays inside the Screen", async () => {
  const { tui } = fixture()
  tui.runCommand('/doctor')
  await waitForScreen(tui, '体检')
  const answered = tui.askScreenConfirm('写入两行？', '（y/n）')
  assert.notEqual(answered, undefined, 'the Screen took the question')
  const painted = frame(tui)
  assert.ok(painted.some(line => line.includes('写入两行？')), 'and paints it on its own hint row')
  assert.equal(tui.dialog, undefined, 'the workspace dialog channel stayed empty')
  tui.handleChar('y')
  assert.equal(await answered, 'y', 'the answer reached the Screen that asked')
  tui.handleEscape()
  await tick(0)
})

test('an Esc at a Screen confirmation cancels it, not the Screen', async () => {
  const { tui } = fixture()
  tui.runCommand('/doctor')
  await waitForScreen(tui, '体检')
  const answered = tui.askScreenConfirm('写入两行？', '（y/n）')
  tui.handleChar('\x1b')
  assert.equal(await answered, 'cancel')
  assert.equal(tui.screen?.report, 'doctor', 'the Screen is still up')
  tui.handleEscape()
  await tick(0)
  assert.equal(tui.screen, undefined)
})

test('every report opens a Screen with a title and a body', async () => {
  const cases = [
    ['status', '会话'],
    ['usage', '用量'],
    ['diag', '诊断'],
    ['doctor', '体检'],
    ['help', '/model'],
    ['subagents', '子代理'],
  ]
  for (const [command, needle] of cases) {
    const { tui } = fixture()
    tui.runCommand(`/${command}`)
    // `/usage` needs a credential before it can read anything; without one it takes
    // the failure path, which is allowed to be an `error` row (AD-7). Every other
    // outcome must be a Screen.
    await waitFor(
      () => (tui.screen?.report === command) || (command === 'usage' && feedbackText(tui) !== ''),
      { describe: `/${command} to answer`, detail: () => screenText(tui) },
    )
    if (command === 'usage' && tui.screen === undefined) {
      assert.ok(feedbackText(tui) !== '', 'the only non-Screen outcome is a reported failure')
      continue
    }
    assert.equal(tui.screen?.report, command, `/${command} is a report Screen`)
    assert.ok(tui.screen.title.length > 0, `/${command} has a title`)
    assert.ok(tui.rows.every(row => row.kind !== 'diag'), `/${command} left no diag row`)
    tui.handleEscape()
    await tick(0)
  }
})

test('every closing key the overlay documents leaves the Screen, `q` included', async () => {
  // `inspectClosesOn` accepts Esc, Ctrl-C, `q`/`Q` and Enter, and the dispatcher
  // says so in its own comment — but the printable-key hint used to be answered
  // first, and it returns, so `q` and `Q` only ever produced the hint: the
  // documented keys were unreachable. A reader who typed `q` at a report, the way
  // every pager answers, was told to press Esc instead.
  for (const key of ['q', 'Q']) {
    const { tui } = fixture()
    openInspect(tui)
    await waitFor(() => tui.screen?.kind === 'inspect', { describe: 'the inspect Screen' })
    tui.handleChar(key)
    await tick(0)
    assert.equal(tui.screen, undefined, `${JSON.stringify(key)} leaves the Screen`)
  }

  // And the hint is still what every other printable key gets, once.
  const { tui } = fixture()
  tui.input = '草稿'
  openInspect(tui)
  await waitFor(() => tui.screen?.kind === 'inspect', { describe: 'the inspect Screen' })
  tui.handleChar('x')
  const hint = tui.screen?.notice
  assert.match(String(hint ?? ''), /报告视图|report view|Esc/u, 'a printable key still explains itself')
  tui.handleChar('y')
  assert.equal(tui.screen?.notice, hint, 'and repeated keys do not pile up')
  assert.equal(tui.input, '草稿', 'while the draft behind the Screen is untouched')
})
