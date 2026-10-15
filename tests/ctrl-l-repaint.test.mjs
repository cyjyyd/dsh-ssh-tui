/**
 * W-3b.2 — Ctrl+L's two repaint paths, measured on the bytes (decision closeout).
 *
 * The audit that closed this round found one `composePaintFrame` and one shared
 * "next frame is full" flag (`forceFullPaint`), with two owners writing the
 * prologue and two painters consuming it. The decision was **KEEP_DUAL**
 * (`docs/decisions/input-router.md` §10, `docs/decisions/input-ownership.md` §17):
 * Screen and workspace keep their own strategies and keep sharing the composer.
 *
 * This file is the evidence half of that decision. It drives the real
 * `handleData(Buffer)` and reads the real `write()` bytes — not `forceFullPaint`,
 * not `lastPaintWidth` — so "Ctrl+L repainted" means an `ESC[H ESC[J` went out
 * and every row was rebuilt, and "it went back to incremental" means the next
 * frame that had a real change painted *some* rows and cleared nothing.
 *
 * What is deliberately **not** asserted: that the two paths emit the same bytes.
 * They do not, and they are not meant to (the Screen hides the cursor and writes
 * no caret; the workspace restores it), which is what KEEP_DUAL records.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { represent } from '../lib/representation.js'
import { cursorVisualPosition, displayWidth, stripAnsi } from '../lib/term-text.js'
import { pushRow, tick, waitForDialog } from './wait.mjs'

setLocale('zh')

const COLUMNS = 100
const ROWS = 24

/** A full clear, as the painter writes it, or a terminal's own. */
const FULL_CLEAR = /\u001b\[H\u001b\[J|\u001b\[2J|\u001b\[3J/gu

/** One row address, `ESC[<row>;1H` — the caret never lands in column 1. */
const ROW_ADDRESS = /\u001b\[(\d+);1H/gu

const clearsIn = text => [...text.matchAll(FULL_CLEAR)].length

/** The rows a frame addressed, as 1-based row numbers. */
function addressedRows(text) {
  return [...text.matchAll(ROW_ADDRESS)].map(match => Number(match[1]))
}

/**
 * The rows the frame *drew*, by address (a later write wins), as the reader sees
 * them. Read off the bytes rather than from `captureFrame`: the question here is
 * what the terminal was told, not what the painter intended.
 */
function paintedRows(text) {
  const rows = new Map()
  for (const part of text.split(/(?=\u001b\[\d+;1H)/u)) {
    const at = /^\u001b\[(\d+);1H/u.exec(part)
    if (at === null) continue
    const erase = part.indexOf('\u001b[2K')
    if (erase === -1) continue
    rows.set(Number(at[1]), stripAnsi(part.slice(erase + 4)).replace(/\s+$/u, ''))
  }
  return rows
}

/** The caret the frame finished on: `ESC[<row>;<col>H` immediately before `?25h`. */
function caretOf(text) {
  const match = /\u001b\[(\d+);(\d+)H\u001b\[\?25h\s*$/u.exec(text)
  return match === null ? undefined : { row: Number(match[1]), column: Number(match[2]) }
}

const OWNERS = ['ownerScreen', 'ownerSurface', 'ownerComposer', 'ownerWorkspace']

/** A TUI with pinned geometry, the four owner adapters observed, and `write` captured. */
function fixture(options = {}) {
  const ctx = {
    get: name => (name === 'sessionProjections' ? { stateOf: () => ({ questions: { active: [], settled: [] } }) } : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] },
    cancel() {}, followup: async () => {}, steer: async () => {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  tui.screenRows = () => ROWS
  tui.screenColumns = () => COLUMNS
  const seen = []
  for (const name of OWNERS) {
    const original = tui[name].bind(tui)
    tui[name] = (...args) => { seen.push(name); return original(...args) }
  }
  for (let index = 0; index < (options.history ?? 30); index += 1) {
    pushRow(tui, { kind: index % 2 === 0 ? 'assistant' : 'user', text: `行 ${index}` })
  }
  const writes = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { writes.push(String(chunk)); real(chunk) }
  return {
    tui,
    agent,
    seen,
    /** Bytes written since the last call, and clear them. */
    drain() {
      const chunk = writes.join('')
      writes.length = 0
      return chunk
    },
  }
}

/** Everything an owner is not allowed to write when a repaint key arrives. */
const fingerprint = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  historyIndex: tui.historyIndex,
  historyLength: tui.history.length,
  folded: tui.inputFolded,
  scroll: tui.scrollOffset,
  screen: tui.screen?.kind ?? null,
  screenOffset: tui.screen?.offset ?? null,
  dialog: tui.dialog?.kind ?? null,
  dialogCursor: tui.dialog?.cursor ?? null,
  dialogFilter: tui.dialog?.filter ?? null,
  borrowed: tui.borrowedText === undefined
    ? null
    : { text: tui.borrowedText.text, cursor: tui.borrowedText.cursor },
  focused: tui.focusedRow?.kind ?? null,
  rows: tui.rows.length,
  yank: tui.copyYank ?? null,
  echo: tui.currentFooterEcho() ?? null,
  notice: tui.currentNotice() ?? null,
})

/** One settled frame: the scenario is set up, then painted once and drained. */
function settle(tui) {
  tui.markDirty()
  tui.paint()
}

// ── T1 · the workspace painter, which a Surface shares ──────────────────────

/**
 * Ctrl+L at the composer: one clear, the whole frame rebuilt, nothing else moved.
 *
 * The composer is the plainest case of the frozen workspace path — and the one
 * whose caret is on screen, so the frame that follows can be checked against the
 * field it belongs to.
 */
test('Ctrl+L at the composer clears once, rebuilds the frame, and leaves the caret where it was', () => {
  const { tui, seen, drain } = fixture()
  tui.input = '我打了一半的消息'
  tui.cursor = 3
  settle(tui)
  tui.dirty = false
  drain()
  const before = fingerprint(tui)

  // One unit in, one owner: the composer takes Ctrl+L while nothing is layered
  // over the workspace (AD-22 §3, rule 4).
  tui.handleData(Buffer.from('\x0c'))
  assert.deepEqual(seen, ['ownerComposer'], 'Ctrl+L is the composer adapter’s unit')
  const frame = drain()
  assert.ok(frame !== '', 'the workspace path paints on the key itself, not on a cadence')

  assert.equal(clearsIn(frame), 1, 'exactly one full clear')
  const addressed = addressedRows(frame)
  assert.equal(addressed.length, ROWS, `every row is rebuilt (${addressed.length} of ${ROWS})`)
  assert.deepEqual([...new Set(addressed)].sort((left, right) => left - right), Array.from({ length: ROWS }, (_row, index) => index + 1))
  const painted = paintedRows(frame)
  assert.match(painted.get(1) ?? '', /DeepSeek Harness/u, 'the header is back')
  assert.ok(painted.get(ROWS) !== undefined, 'and so is the last row')
  assert.ok([...painted.values()].some(line => line.includes('我打了一半的消息')), 'the draft is on the row it belongs to')

  assert.deepEqual(fingerprint(tui), before, 'a repaint is not a state change')
  assert.equal(tui.dirty, false, 'the frame consumed the dirty flag')

  // The caret is the field's, derived here from the draft rather than read back
  // from the painter: prompt `> ` plus the visual width of the text before it.
  const caret = caretOf(frame)
  assert.ok(caret !== undefined, 'the workspace frame restores the cursor')
  const expectedColumn = displayWidth('> ') + cursorVisualPosition(tui.input, tui.cursor, COLUMNS - displayWidth('> ')).col + 1
  assert.equal(caret.column, expectedColumn, 'the caret is at the draft’s own column')
  assert.equal(caret.row, tui.lastPaintedCursorRow(), 'and on the row the painter reported')

  // The frame after it is a *real* local change — one typed character — and it
  // must be incremental again: no clear, and not a whole screen of rows. Unlike
  // Ctrl+L, an ordinary key only marks the frame; the cadence paints it, which is
  // the difference the decision keeps rather than removes.
  tui.handleData(Buffer.from('x'))
  assert.equal(drain(), '', 'a typed character does not paint on the key itself')
  tui.render()
  const next = drain()
  assert.ok(next !== '', 'the typed character painted something')
  assert.equal(clearsIn(next), 0, 'and it did not clear the screen')
  const nextRows = addressedRows(next)
  assert.ok(nextRows.length > 0, 'the frame has output')
  assert.ok(nextRows.length < ROWS, `and it is incremental, not a rebuild (${nextRows.length} rows)`)
  assert.ok(nextRows.includes(caret.row), 'the caret row is among the rows the change repainted')
})

/**
 * Ctrl+L with a Surface up: the recorded exception, and what it does not mean.
 *
 * The Router answers `composer` for Ctrl+L at a Surface (AD-22 §4, kept by the
 * KEEP_DUAL decision) and only the *repaint* execution path is used: the unit
 * never reaches `handleDialogChar`, so the Surface's text ownership is untouched.
 * A Surface has no painter of its own — its rows are part of the workspace frame
 * — so the workspace painter is the only thing that can repaint it.
 */
test('Ctrl+L with a Surface up repaints the workspace frame and leaves the Surface alone', async () => {
  const cases = [
    {
      name: 'confirm Surface (no field)',
      open: async tui => {
        void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
        await waitForDialog(tui, 'confirm')
      },
      // A Surface without a field refuses text, so the next real change is the
      // acknowledgement row: `command-feedback` is what `/theme` and an
      // auto-approval notice push, and it lands on that one row.
      change: tui => { tui.pushRow(represent('command-feedback', { kind: 'system', text: '配色已切换：mono' })) },
      content: /允许工具/u,
    },
    {
      name: 'question Surface (borrowed field)',
      open: async tui => {
        void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
        await waitForDialog(tui, 'questions')
      },
      change: tui => { tui.handleData(Buffer.from('y')) },
      content: /回滚到哪个版本/u,
    },
    {
      name: 'picker Surface (filtering)',
      open: async tui => {
        void tui.askQuestion({ id: 'q2', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1).catch(() => undefined)
        await waitForDialog(tui, 'questions')
        tui.handleData(Buffer.from('/'))
        assert.equal(tui.dialog?.filtering, true, 'the picker is in its filter mode')
      },
      change: tui => { tui.handleData(Buffer.from('a')) },
      content: /选哪个/u,
    },
  ]

  for (const entry of cases) {
    const { tui, seen, drain } = fixture()
    tui.input = '我打了一半的消息'
    tui.cursor = 3
    await entry.open(tui)
    settle(tui)
    tui.dirty = false
    drain()
    seen.length = 0
    const before = fingerprint(tui)

    tui.handleData(Buffer.from('\x0c'))
    assert.deepEqual(seen, ['ownerComposer'], `${entry.name}: the recorded exception still routes to the composer adapter`)
    const frame = drain()
    assert.equal(clearsIn(frame), 1, `${entry.name}: exactly one full clear`)
    const addressed = addressedRows(frame)
    assert.equal(addressed.length, ROWS, `${entry.name}: every row is rebuilt (${addressed.length} of ${ROWS})`)
    assert.ok(
      [...paintedRows(frame).values()].some(line => entry.content.test(line)),
      `${entry.name}: the Surface is on the rebuilt frame`,
    )
    assert.deepEqual(fingerprint(tui), before, `${entry.name}: the repaint wrote no state`)
    assert.equal(tui.input, '我打了一半的消息', `${entry.name}: the hidden draft is untouched`)
    assert.equal(tui.dialog !== undefined, true, `${entry.name}: the Surface is still up`)

    // The caret belongs to the field that owns the keyboard, not to the hidden
    // draft (W-3b.1a): with a borrowed answer the two offsets differ on purpose,
    // and the frame must place the caret at the borrowed one.
    const caret = caretOf(frame)
    assert.ok(caret !== undefined, `${entry.name}: the workspace frame restores the cursor`)
    const field = tui.borrowedText ?? { text: tui.input, cursor: tui.cursor }
    const expectedColumn = displayWidth('> ')
      + cursorVisualPosition(field.text, field.cursor, COLUMNS - displayWidth('> ')).col + 1
    assert.equal(caret.column, expectedColumn, `${entry.name}: the caret is the field’s that owns the keyboard`)
    assert.equal(caret.row, tui.lastPaintedCursorRow(), `${entry.name}: on the row the painter reported`)

    entry.change(tui)
    tui.render()
    const next = drain()
    assert.ok(next !== '', `${entry.name}: the next real change painted something`)
    assert.equal(clearsIn(next), 0, `${entry.name}: and it did not clear the screen`)
    const nextRows = addressedRows(next)
    assert.ok(nextRows.length > 0 && nextRows.length < ROWS, `${entry.name}: it is incremental (${nextRows.length} rows)`)

    // Leave the Surface so the run does not keep a pending question alive.
    tui.handleData(Buffer.from('\x1b'))
    await tick(0)
  }
})

// ── T2 · the Screen painter ─────────────────────────────────────────────────

/** A report Screen the way the product opens one, with a scrolled-off body. */
function openReport(tui) {
  tui.openScreen({
    kind: 'report',
    report: 'diag',
    title: '诊断',
    lines: Array.from({ length: 80 }, (_line, index) => ({ kind: 'system', text: `第 ${index} 行` })),
    offset: 0,
    copyText: '屏幕上的正文',
  })
}

/** The wizard's own field, which its Screen draws in place of the composer. */
function openSetup(tui) {
  tui.onboarding = {
    step: 'key', providerType: 'official', providerId: '', baseUrl: '', key: '', models: [],
    catalogPresets: undefined, catalog: undefined, providerCursor: 0, saving: false,
    field: 'sk-half-typed', fieldCursor: 6, resolve() {},
  }
  tui.openScreen({ kind: 'setup', title: '首次配置', lines: [], offset: 0 })
}

function openInspect(tui) {
  // Long enough that a page key really moves the window: a body that fits in the
  // overlay does not change when PgDn is pressed, and a frame with no change is
  // not the incremental frame this test is about.
  const text = Array.from({ length: 80 }, (_line, index) => `回复第 ${index} 行，一行足够长的正文。`).join('\n')
  pushRow(tui, { kind: 'assistant', text })
  const reply = tui.rows.findLast(row => row.kind === 'assistant')
  tui.openReplyInspect(reply)
}

/**
 * The interval the cadence paints on is the scheduler's, and a test may not wait
 * for the shipped one (80 ms on a local TTY, up to 400 ms on a slow link).
 */
const FAST_CADENCE_MS = 20

/**
 * Ctrl+L at a Screen only *marks* the frame; the cadence timer paints it.
 *
 * This is the scheduling half, and it is the half a test that calls `paint()`
 * directly cannot see: with `markDirty()` gone the flag is still set and a direct
 * paint still clears — only the timer would never come back for it. So the bytes
 * are read after letting the *real* render timer run, with no further input.
 */
test('Ctrl+L at a Screen marks the frame, and the cadence timer is what paints it', async () => {
  const { tui, seen, drain } = fixture()
  openReport(tui)
  settle(tui)
  tui.dirty = false
  drain()

  tui.handleData(Buffer.from('\x0c'))
  assert.deepEqual(seen, ['ownerScreen'], 'Ctrl+L is the Screen adapter’s unit')
  assert.equal(drain(), '', 'the key itself paints nothing: it marks the frame')
  assert.equal(tui.dirty, true, 'and the frame is owed')

  tui.paintIntervalMs = FAST_CADENCE_MS
  tui.startRenderTimer()
  await tick(FAST_CADENCE_MS * 4)
  // The cadence is stopped where it was started rather than by `dispose()`: a
  // dispose writes the terminal's goodbye to stdout, which is the suite's output
  // and not this test's business.
  clearInterval(tui.renderTimer)
  tui.renderTimer = undefined
  const frame = drain()
  assert.ok(frame !== '', 'the cadence picked the frame up with no further input')
  assert.equal(clearsIn(frame), 1, 'and it is the one full clear')
  assert.equal(addressedRows(frame).length, ROWS, 'the whole Screen is rebuilt')
})

/**
 * Every Screen: one clear on Ctrl+L, then ordinary incremental frames.
 *
 * The report, the wizard and the inspect overlay are three `paintScreen` bodies
 * behind one owner, and the frozen contract is the same for all three: the
 * Screen's own scroll position, the wizard's field and the hidden composer are
 * not the repaint's business, and the frame after it is a normal one.
 */
test('every Screen repaints once on Ctrl+L and goes back to incremental frames', async () => {
  const cases = [
    { name: 'report Screen', open: openReport, step: tui => tui.handleData(Buffer.from('\u001b[6~')), content: /诊断/u },
    { name: 'setup Screen', open: openSetup, step: tui => tui.handleData(Buffer.from('x')), content: /首次配置|sk-half-typed/u },
    { name: 'inspect Screen', open: openInspect, step: tui => tui.handleData(Buffer.from('\u001b[6~')), content: /回复|全文/u },
  ]

  for (const entry of cases) {
    const { tui, drain } = fixture()
    tui.input = '我打了一半的消息'
    tui.cursor = 3
    await entry.open(tui)
    settle(tui)
    tui.dirty = false
    drain()
    const before = fingerprint(tui)

    tui.handleData(Buffer.from('\x0c'))
    assert.equal(tui.dirty, true, `${entry.name}: the frame is owed`)
    assert.equal(drain(), '', `${entry.name}: the key paints nothing itself`)
    tui.render()
    const frame = drain()
    assert.equal(clearsIn(frame), 1, `${entry.name}: exactly one full clear`)
    const addressed = addressedRows(frame)
    assert.equal(addressed.length, ROWS, `${entry.name}: the whole frame is rebuilt (${addressed.length} of ${ROWS})`)
    assert.ok(
      [...paintedRows(frame).values()].some(line => entry.content.test(line)),
      `${entry.name}: the Screen's own content is back`,
    )
    assert.deepEqual(fingerprint(tui), before, `${entry.name}: the Screen, its field and the hidden draft are untouched`)
    assert.equal(tui.input, '我打了一半的消息', `${entry.name}: the hidden composer is untouched`)

    // The next frame is a real local update inside the Screen, and it must be a
    // normal one: no clear, and only the rows that changed.
    entry.step(tui)
    tui.render()
    const next = drain()
    assert.ok(next !== '', `${entry.name}: the local update painted something`)
    assert.equal(clearsIn(next), 0, `${entry.name}: and it did not clear the screen`)
    const nextRows = addressedRows(next)
    assert.ok(nextRows.length > 0 && nextRows.length < ROWS, `${entry.name}: it is incremental (${nextRows.length} rows)`)

    if (entry.name !== 'setup Screen') {
      // Leaving the Screen is the one documented full repaint of the way back,
      // and the frame after it is incremental again.
      tui.handleEscape()
      await tick(0)
      assert.equal(tui.screen, undefined, `${entry.name}: Escape left the Screen`)
      tui.render()
      const back = drain()
      assert.equal(clearsIn(back), 1, `${entry.name}: the returning workspace frame is rebuilt once`)
      const backRows = paintedRows(back)
      assert.match(backRows.get(1) ?? '', /DeepSeek Harness/u, `${entry.name}: the workspace header is back`)
      assert.ok([...backRows.values()].some(line => line.includes('我打了一半的消息')), `${entry.name}: and the draft`)
      tui.render()
      assert.equal(clearsIn(drain()), 0, `${entry.name}: and nothing clears after that`)
    }
  }
})
