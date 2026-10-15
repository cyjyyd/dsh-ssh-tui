/**
 * W-3b.3a — what a Surface may not write behind itself.
 *
 * The W-3b.2 audit registered two risks it could only point at, and this round is
 * their reproduction and fix:
 *
 *   - **R-HISTORY**: a borrowed field's editing keys run through
 *     `leaveHistoryBrowse()`, which belongs to the composer's history browse. Editing
 *     the answer on screen ended the *composer's* browse and overwrote the draft it
 *     was holding with the entry being browsed.
 *   - **R-ALT**: `Alt+f`/`Alt+F`/`Alt+/` seed the composer with `/find ` from the
 *     Alt-chord branch of `route()`, which runs before any owner is asked — so with a
 *     Surface up the seed was written into a draft nobody could see.
 *
 * Both are driven through the real `handleData(Buffer)` here, and the browse is
 * entered with a real ↑ over history built by real submissions: no fixture sets
 * `historyIndex` to fake a browse.
 *
 * What is deliberately **kept**: W-3a's lock that the workspace chords run while a
 * Surface is up (`Alt+1…4`, `Alt+n/p`), and the composer's own history semantics —
 * typing in the composer still ends its browse, and `↓` still gives the draft back.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, tick, waitFor, waitForDialog } from './wait.mjs'

setLocale('zh')

const DRAFT = '我打了一半的消息'

function fixture() {
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
  tui.screenRows = () => 24
  tui.screenColumns = () => 100
  return tui
}

/** The composer's own state: the draft, its caret, the browse and the history. */
const composerState = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  historyIndex: tui.historyIndex,
  historyDraft: tui.historyDraft,
  folded: tui.inputFolded,
  history: [...tui.history],
})

/** Everything a chord or an edit key may not touch while a Surface owns the keys. */
const surfaceState = tui => ({
  ...composerState(tui),
  dialog: tui.dialog?.kind ?? null,
  dialogCursor: tui.dialog?.cursor ?? null,
  dialogFilter: tui.dialog?.filter ?? null,
  filtering: tui.dialog?.filtering ?? null,
  borrowed: tui.borrowedText === undefined ? null : { ...tui.borrowedText },
  focused: tui.focusedRow?.kind ?? null,
  scroll: tui.scrollOffset,
  rows: tui.rows.length,
})

/** A real submission, which is where history comes from. */
async function submit(tui, text) {
  tui.input = text
  tui.cursor = text.length
  tui.handleData(Buffer.from('\r'))
  await tick(0)
}

/**
 * Close the Surface the way a reader does, and wait for it to actually close.
 *
 * One Esc is not always enough, for two reasons that both belong to the input
 * contract rather than to this test: a lone ESC is held by the Reader for 60 ms
 * before it is released (AD-21), and at a filtering picker the first Esc means
 * "show the whole list again" (`clearQuestionFilter`) with the question still up
 * behind it.
 */
async function closeSurface(tui) {
  for (let attempt = 0; attempt < 3 && tui.dialog !== undefined; attempt += 1) {
    tui.handleData(Buffer.from('\u001b'))
    await tick(80)
  }
  await waitFor(() => tui.dialog === undefined, { describe: 'the Surface to close' })
}

async function openQuestion(tui, { options = [] } = {}) {
  void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？', ...(options.length === 0 ? {} : { options }) }, 0, 1)
    .catch(() => undefined)
  await waitForDialog(tui, 'questions')
}

/** Two submitted messages, a half-typed draft, then a real ↑ into the browse. */
async function browsing(tui) {
  await submit(tui, '历史一')
  await submit(tui, '历史二')
  assert.deepEqual(tui.history, ['历史一', '历史二'], 'two submissions make two entries')
  assert.equal(tui.historyIndex, tui.history.length, 'a submission leaves the browse at its end')
  tui.input = DRAFT
  tui.cursor = DRAFT.length
  tui.handleData(Buffer.from('\u001b[A'))
  assert.equal(tui.historyIndex, 1, '↑ recalls the newest entry')
  assert.equal(tui.input, '历史二', 'which is what the composer now shows')
  assert.equal(tui.historyDraft, DRAFT, 'and the browse put the unsent draft aside')
}

// ── R-HISTORY ───────────────────────────────────────────────────────────────

/**
 * Every borrowed-field path that used to end the composer's browse.
 *
 * `leaveHistoryBrowse()` is reached from four editing keys and from paste — and
 * `if (cursor === 0) return` in `backspace()`, `graphemeAfter() === undefined` in
 * `deleteAtCursor()` mean the field has to be non-empty (and the caret off the end)
 * for those two, which is why each case types an answer first.
 */
const BORROWED_EDITS = [
  { label: 'Backspace', prepare: tui => tui.handleData(Buffer.from('v2')), edit: tui => tui.handleData(Buffer.from('\u007f')), after: 'v' },
  { label: 'Delete', prepare: tui => { tui.handleData(Buffer.from('v2')); tui.handleData(Buffer.from('\u001b[H')) }, edit: tui => tui.handleData(Buffer.from('\u001b[3~')), after: '2' },
  { label: 'Ctrl+U', prepare: tui => tui.handleData(Buffer.from('v2')), edit: tui => tui.handleData(Buffer.from('\u0015')), after: '' },
  { label: 'Ctrl+K', prepare: tui => { tui.handleData(Buffer.from('v2')); tui.handleData(Buffer.from('\u001b[H')) }, edit: tui => tui.handleData(Buffer.from('\u000b')), after: '' },
  { label: 'typing', prepare: () => {}, edit: tui => tui.handleData(Buffer.from('v2')), after: 'v2' },
  { label: 'paste', prepare: () => {}, edit: tui => tui.handleData(Buffer.from('\u001b[200~v2.3\u001b[201~')), after: 'v2.3' },
]

test('R-HISTORY: a borrowed field’s edit does not end the composer’s history browse', async () => {
  for (const entry of BORROWED_EDITS) {
    const tui = fixture()
    await browsing(tui)
    await openQuestion(tui)
    assert.notEqual(tui.borrowedText, undefined, `${entry.label}: the question borrowed the field`)
    const before = composerState(tui)

    entry.prepare(tui)
    entry.edit(tui)

    assert.equal(tui.borrowedText?.text, entry.after, `${entry.label}: the visible field took the edit`)
    assert.deepEqual(composerState(tui), before, `${entry.label}: and the composer was not touched`)

    // Closing the Surface leaves the reader where they were: still on the entry the
    // browse recalled, with the draft still held.
    await closeSurface(tui)
    assert.equal(tui.dialog, undefined, `${entry.label}: Escape closed the question`)
    assert.equal(tui.input, '历史二', `${entry.label}: the composer is still on the browsed entry`)
    assert.equal(tui.historyIndex, 1, `${entry.label}: the browse is still on it`)
    assert.equal(tui.historyDraft, DRAFT, `${entry.label}: holding the reader’s own draft`)

    // …and a real ↓ ends the browse by giving that draft back.
    tui.handleData(Buffer.from('\u001b[B'))
    assert.equal(tui.input, DRAFT, `${entry.label}: ↓ gives the unsent draft back`)
    assert.equal(tui.cursor, DRAFT.length, `${entry.label}: with the caret at its end`)
    assert.equal(tui.historyIndex, tui.history.length, `${entry.label}: the browse is over`)
    assert.deepEqual(tui.history, ['历史一', '历史二'], `${entry.label}: no entry was rewritten`)
  }
})

test('R-HISTORY: with no browse open, a borrowed edit still writes no composer state', async () => {
  // The other half of the rule: the fix may not simply stop `leaveHistoryBrowse()`
  // from working — it may only stop a *borrowed* field from reaching it.
  for (const entry of BORROWED_EDITS) {
    const tui = fixture()
    await submit(tui, '历史一')
    await submit(tui, '历史二')
    tui.handleData(Buffer.from('\u001b[A'))
    tui.handleData(Buffer.from('\u001b[B'))
    tui.input = DRAFT
    tui.cursor = DRAFT.length
    const settled = composerState(tui)
    assert.equal(settled.historyIndex, settled.history.length, `${entry.label}: not browsing`)

    await openQuestion(tui)
    entry.prepare(tui)
    entry.edit(tui)
    assert.deepEqual(composerState(tui), settled, `${entry.label}: the composer state is untouched`)

    await closeSurface(tui)
    assert.deepEqual(composerState(tui), settled, `${entry.label}: still untouched after the Surface closes`)

    // The composer's own history semantics still work from there.
    tui.handleData(Buffer.from('\u001b[A'))
    assert.equal(tui.input, '历史二', `${entry.label}: ↑ still recalls`)
    assert.equal(tui.historyDraft, DRAFT, `${entry.label}: and still holds the draft`)
    tui.handleData(Buffer.from('\u001b[B'))
    assert.equal(tui.input, DRAFT, `${entry.label}: ↓ still returns it`)
  }
})

test('R-HISTORY: the composer’s own typing still ends its browse', async () => {
  // The behaviour the guard must not take away: typing into the field the keyboard
  // is on *is* the composer's typing, and it detaches from the recalled entry.
  const tui = fixture()
  await browsing(tui)
  tui.handleData(Buffer.from('x'))
  assert.equal(tui.historyIndex, tui.history.length, 'typing in the composer detaches it from the browse')
  assert.equal(tui.input, '历史二x', 'and the character lands at the caret of what was on screen')
  assert.deepEqual(tui.history, ['历史一', '历史二'], 'history itself is never rewritten')
})

// ── R-ALT ───────────────────────────────────────────────────────────────────

const SURFACE_FORMS = [
  ['confirm Surface', async tui => {
    void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
    await waitForDialog(tui, 'confirm')
  }],
  ['question Surface (borrowed field)', async tui => { await openQuestion(tui) }],
  ['question Surface (options)', async tui => { await openQuestion(tui, { options: [{ label: 'Alpha' }, { label: 'Beta' }] }) }],
  ['filtering picker', async tui => {
    await openQuestion(tui, { options: [{ label: 'Alpha' }, { label: 'Beta' }] })
    tui.handleData(Buffer.from('/'))
    assert.equal(tui.dialog?.filtering, true, 'the picker is filtering')
  }],
]

test('R-ALT: the /find seed is only written into a field the composer owns', async () => {
  for (const [name, open] of SURFACE_FORMS) {
    for (const chord of ['\u001bf', '\u001bF', '\u001b/']) {
      const tui = fixture()
      pushRow(tui, { kind: 'assistant', text: '一段可搜索的回复' })
      tui.input = DRAFT
      tui.cursor = 3
      await open(tui)
      const before = surfaceState(tui)

      tui.handleData(Buffer.from(chord))

      const where = `${name} + ${JSON.stringify(chord)}`
      assert.equal(tui.input, DRAFT, `${where}: the hidden draft is not a search seed`)
      assert.equal(tui.cursor, 3, `${where}: and its caret did not move`)
      assert.deepEqual(surfaceState(tui), before, `${where}: the chord wrote nothing at all`)
      assert.notEqual(tui.dialog, undefined, `${where}: the Surface is still up`)

      await closeSurface(tui)
    }
  }

  // With nothing layered over the workspace the seed is the composer's, exactly as
  // it always was — this is the behaviour the guard must keep, not replace.
  const composer = fixture()
  composer.input = DRAFT
  composer.cursor = 3
  composer.handleData(Buffer.from('\u001bf'))
  assert.equal(composer.input, '/find ', 'the composer seeds its own /find')
  assert.equal(composer.cursor, 6, 'with the caret after the seed')
  assert.equal(composer.historyIndex, -1, 'and nothing else moved')
})

test('R-ALT: the workspace chords keep running while a Surface is up (W-3a’s lock)', async () => {
  // Alt+1…4 jump a category and Alt+n/p step the search: workspace actions, locked
  // by W-3a for every owner. This round records them, it does not redefine them —
  // only the two chords that write *composer text* are brought under the Surface's
  // boundary.
  const recorded = []
  for (const [chord, expect] of [
    ['\u001b1', /已跳到最新思考/u],
    ['\u001b4', /已跳到最新回复/u],
    ['\u001bn', /没有|未找到|搜索/u],
    ['\u001bp', /没有|未找到|搜索/u],
  ]) {
    const tui = fixture()
    pushRow(tui, { kind: 'reasoning', text: '一段思考' })
    pushRow(tui, { kind: 'assistant', text: '一段回复' })
    tui.input = DRAFT
    tui.cursor = 3
    await openQuestion(tui)
    const before = { input: tui.input, cursor: tui.cursor, dialog: tui.dialog?.kind }
    tui.handleData(Buffer.from(chord))
    assert.match(String(tui.currentFooterEcho() ?? ''), expect, `${JSON.stringify(chord)} still runs`)
    assert.equal(tui.input, before.input, `${JSON.stringify(chord)}: the answer behind the Surface is not text`)
    assert.equal(tui.cursor, before.cursor, `${JSON.stringify(chord)}: nor is its caret`)
    assert.equal(tui.dialog?.kind, before.dialog, `${JSON.stringify(chord)}: the Surface is still up`)
    recorded.push(`${JSON.stringify(chord)} → ${String(tui.currentFooterEcho() ?? '').trim()}`)
    await closeSurface(tui)
  }
  console.log(`workspace chords while a Surface is up: ${recorded.join(' · ')}`)
})

test('R-ALT: Ctrl+L keeps the routing W-3b.2 froze', async () => {
  // The chord branch sits next to Ctrl+L's; the fix must not move it. A Surface
  // still sends Ctrl+L to the composer adapter's repaint path (the recorded
  // exception), and it still clears exactly once.
  const owners = []
  const tui = fixture()
  pushRow(tui, { kind: 'assistant', text: '一段回复' })
  tui.input = DRAFT
  tui.cursor = 3
  for (const name of ['ownerScreen', 'ownerSurface', 'ownerComposer', 'ownerWorkspace']) {
    const original = tui[name].bind(tui)
    tui[name] = (...args) => { owners.push(name); return original(...args) }
  }
  const writes = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { writes.push(String(chunk)); real(chunk) }
  await openQuestion(tui)
  tui.markDirty()
  tui.paint()
  tui.dirty = false
  writes.length = 0
  owners.length = 0

  tui.handleData(Buffer.from('\u000c'))
  const frame = writes.join('')
  assert.deepEqual(owners, ['ownerComposer'], 'Ctrl+L at a Surface is still the recorded exception')
  assert.equal([...frame.matchAll(/\u001b\[H\u001b\[J/gu)].length, 1, 'and it still repaints the frame exactly once')
  assert.equal(tui.input, DRAFT, 'writing nothing to the hidden draft')
  await closeSurface(tui)
})
