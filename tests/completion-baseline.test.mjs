/**
 * Completion — the baseline W-4B.1 has to keep, and the behaviour it must change.
 *
 * This file is the **before/after safety net** for W-4B.1. The P/N matrix in
 * `docs/plans/w4a-completion-ownership.md` is the contract; this file keeps the
 * baseline cases and rewrites the two pinned defects (D1/D2b) when the state
 * extraction changes them. D2 stays the pinned negative case.
 *
 * Three kinds of case live here, and the difference matters when one fails:
 *
 *   - **baseline** — passes today and must keep passing (who owns ↑/↓/Tab/Enter,
 *     what is written where). A failure is a regression, not a design change.
 *   - **pinned defect** — passes today and *documents a defect* the design defers
 *     (D1's paint-written list, D2's refused highlight, D2b's Esc that does not
 *     dismiss). W-4B.1 will change these on purpose; when it does, the case is
 *     rewritten with the design doc's oracle, not deleted.
 *   - **not tested here** — W-4B.1 targets that have nothing to assert yet
 *     (`commands/change` refresh, stdio acceptance, persistent dismissal as a
 *     *rule* rather than a frame). They are listed in
 *     `docs/plans/w4b0-completion-baseline.md` with their oracles, and are not
 *     fake-green cases in this file.
 *
 * Nothing here reaches into `src/`: the cases drive `handleData` (the real input
 * entry) and `render()` (the real paint), and assert on state a reader can see.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { tick } from './wait.mjs'

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
  return tui
}

/** One painted frame, through the real paint path (`render` needs `dirty`). */
function paint(tui, columns = 100, rows = 30) {
  tui.markDirty()
  tui.render()
  return tui.lastPaintRows
    .map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd())
}

/** The rows that carry a list entry, as the reader sees them. */
const listRows = frame => frame.filter(line => /[› ] \/[-a-z]+\s/u.test(line))

/** Type a draft the way a terminal does, and paint while it is open. */
function typeDraft(tui, text) {
  tui.handleData(Buffer.from(text))
  return paint(tui)
}

test('BASELINE: a bare slash lists the catalog in a 12-row window, aliases held back', () => {
  const tui = makeTui()
  const frame = typeDraft(tui, '/')
  assert.ok(tui.commandSuggestions.length > 12, `the catalog is longer than the window (${tui.commandSuggestions.length})`)
  assert.equal(listRows(frame).length, 12, 'the window is twelve rows')
  assert.ok(listRows(frame).some(line => line.includes('/disconnect')), 'a day-to-day command is in the window')
  assert.equal(listRows(frame).some(line => line.includes('/exit')), false, 'aliases wait for a prefix')
  assert.equal(frame.join('\n').includes('/dialog-test'), false, 'and the test-only command is never suggested')
})

test('BASELINE: the arrows move the highlight and never the history', () => {
  const tui = makeTui()
  tui.history.push('an earlier message')
  tui.historyIndex = tui.history.length
  typeDraft(tui, '/')
  const before = tui.suggestionIndex
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.suggestionIndex, before + 1, '↓ moves the list')
  assert.equal(tui.historyIndex, tui.history.length, 'and leaves history where it was')
  assert.equal(tui.input, '/', 'the draft is the list’s query, not a recalled entry')
  tui.handleData(Buffer.from('\x1b[A'))
  assert.equal(tui.suggestionIndex, before, '↑ moves it back')
})

test('BASELINE: without a list, an arrow is history again', () => {
  const tui = makeTui()
  tui.history.push('an earlier message')
  tui.historyIndex = tui.history.length
  tui.handleData(Buffer.from('\x1b[A'))
  assert.equal(tui.input, 'an earlier message', 'the recalled draft is the composer’s')
  assert.equal(tui.cursor, 'an earlier message'.length)
})

test('BASELINE: Tab accepts the highlight without submitting it', () => {
  const tui = makeTui()
  const rowsBefore = tui.rows.length
  typeDraft(tui, '/hel')
  tui.handleData(Buffer.from('\t'))
  assert.equal(tui.input, '/help ', 'the accepted command and its trailing space')
  assert.equal(tui.cursor, '/help '.length)
  assert.equal(tui.rows.length, rowsBefore, 'Tab does not run anything')
  assert.equal(tui.screen, undefined, 'no report opened')
  assert.equal(tui.history.length, 0, 'nothing entered the history')
})

test('BASELINE: Enter on a prefix highlight completes it and runs it', () => {
  const tui = makeTui()
  typeDraft(tui, '/hel')
  assert.equal(tui.commandSuggestions[tui.suggestionIndex]?.name, 'help')
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.screen?.kind, 'report', '/help ran (its report is up)')
  assert.equal(tui.input, '', 'and the draft is spent')
})

test('PINNED D2: Enter refuses a contains-only highlight (deferred, not fixed)', () => {
  // `diag` contains `ag` but does not start with it; the guard is a byte-for-byte
  // prefix test, so the command is *not* run and the literal line goes to the
  // unknown-command path. W-4A §2.1 D2 records this as DEFERRED; W-4B.1 keeps it.
  const tui = makeTui()
  const frame = typeDraft(tui, '/ag')
  assert.equal(tui.commandSuggestions[tui.suggestionIndex]?.name, 'diag', 'the highlight is a contains match')
  tui.handleData(Buffer.from('\r'))
  assert.notEqual(tui.screen?.kind, 'report', 'diag did not run')
  const notice = String(tui.currentNotice() ?? '')
  assert.ok(notice.includes('/ag'), `the unknown-command notice names the line the reader typed: ${JSON.stringify(notice)}`)
  assert.equal(tui.input, '', 'the line was submitted, not completed')
  paint(tui)
  assert.ok(frame.some(line => line.includes('diag')), 'the highlight was real, and that is the defect')
})

test('PINNED D2: Enter refuses a case-mismatched highlight', () => {
  // The filter lowercases the prefix; the guard does not. `/HELP` lists `help`,
  // Enter refuses it, and the reader gets the unknown-command row instead.
  const tui = makeTui()
  typeDraft(tui, '/HELP')
  assert.equal(tui.commandSuggestions[tui.suggestionIndex]?.name, 'help')
  tui.handleData(Buffer.from('\r'))
  assert.notEqual(tui.screen?.kind, 'report')
  assert.ok(String(tui.currentNotice() ?? '').includes('/HELP'))
})

test('D2b FIXED: Esc dismisses the list, and it stays dismissed until the draft changes', async () => {
  // W-4B.1 replaced the paint-time rebuild with `dismissedFor`: the released
  // Escape records the exact draft, so the next frames must not resurrect it.
  const tui = makeTui()
  typeDraft(tui, '/')
  assert.equal(tui.completion.visible, true)
  tui.handleData(Buffer.from('\x1b'))
  // A lone Escape is held for 60 ms before the Reader frames it.
  await tick(140)
  assert.equal(tui.completion.phase, 'dismissed')
  assert.equal(tui.completion.dismissedFor, '/')
  assert.equal(tui.completion.items.length, 0)
  const after = paint(tui)
  assert.equal(listRows(after).length, 0, 'the reader sees no list after Esc')
  assert.equal(listRows(paint(tui)).length, 0, 'and the next frame does not rebuild it')
  tui.handleData(Buffer.from('m'))
  assert.equal(tui.input, '/m')
  assert.equal(tui.completion.visible, true, 'a real draft change re-lists the new query')
  assert.ok(listRows(paint(tui)).length > 0)
})

test('D1 FIXED: a paste materializes the list before the next unit, without a paint', () => {
  // The read boundary (and the draft setter) now refresh the state, so the next
  // key sees the post-paste list rather than the previous frame's answer.
  const tui = makeTui()
  typeDraft(tui, '/model')
  assert.deepEqual(tui.completion.items.map(item => item.name), ['model', 'submodel'])
  tui.handleData(Buffer.from('\x1b[200~s\x1b[201~'))
  assert.equal(tui.input, '/models', 'the paste is in the draft')
  assert.equal(tui.completion.visible, false, 'no paint was needed to refresh it')
  assert.deepEqual(tui.completion.items, [], 'the stale /model list is gone')
})

test('BASELINE: a Surface hides the list without destroying its state', () => {
  // The state stays materialized while the Surface owns the keyboard; paint must
  // not show it and input must not receive it, then it returns when the Surface
  // closes. This deliberately does not assert the old "paint empties the array"
  // internal detail.
  const tui = makeTui()
  typeDraft(tui, '/')
  assert.equal(tui.completion.visible, true)
  tui.openConfirm('prompt', 'hint', () => {})
  const hidden = paint(tui)
  assert.equal(listRows(hidden).length, 0, 'nothing of the list is painted under a Surface')
  assert.equal(tui.completion.visible, false, 'and completion is not offered input')
  tui.closeConfirm('n')
  const back = paint(tui)
  assert.equal(tui.completion.visible, true, 'the state returns with the workspace')
  assert.equal(listRows(back).length, 12)
})

test('BASELINE: a Screen owns the read — the list neither sees its keys nor its tail', () => {
  const tui = makeTui()
  // Enter opens the report; the arrow behind it in the same raw read belongs to the
  // Screen (it scrolls), not to the list and not to the composer.
  tui.handleData(Buffer.from('/help\r'))
  assert.equal(tui.screen?.kind, 'report', '/help opened its report')
  const indexBefore = tui.suggestionIndex
  tui.handleData(Buffer.from('\x1b[B'))
  assert.equal(tui.suggestionIndex, indexBefore, 'the list did not move')
  assert.equal(tui.input, '', 'and nothing was typed behind the Screen')
})

test('BASELINE: line mode has no list at all', () => {
  const tui = makeTui({ lineMode: true })
  tui.handleData(Buffer.from('/'))
  // Line mode never paints, so nothing ever builds a list; Tab keeps its own meaning.
  assert.equal(tui.commandSuggestions.length, 0, 'no list')
  tui.handleData(Buffer.from('\t'))
  assert.equal(tui.input, '/  ', 'Tab still inserts two spaces')
})

test('E1 BASELINE: an async reader frame reaches the same handler as a read', async () => {
  // The Reader can emit a frame outside `handleInputText` — a held Escape is
  // released by a timer, a paste tail by its watchdog. Both go straight to
  // `consumeFrame`, so W-4B.1 cannot put its refresh only in the read loop.
  const tui = makeTui()
  typeDraft(tui, '/')
  assert.equal(tui.commandSuggestions.length, 27)
  tui.handleData(Buffer.from('\x1b'))
  // The hold is 60 ms; the frame has not been emitted yet.
  assert.equal(tui.commandSuggestions.length, 27, 'the escape is held, not handled')
  await tick(140)
  assert.equal(tui.commandSuggestions.length, 0, 'the released escape reached handleEscape')
  assert.equal(tui.suggestionIndex, 0)
})
