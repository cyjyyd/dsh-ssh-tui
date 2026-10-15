/**
 * Unicode scalar input safety (W-3b.1b).
 *
 * One Unicode code point is one input unit, whatever its UTF-16 length. `composerUnit`
 * decided "is this a run of text or a single key?" with `unit.length > 1`, and a single
 * astral-plane character — `🚀`, `𠮷` — has length 2, so it took the multi-character path:
 * `handlePlainText` delivered it as one code point to `handleChar`, which routed it back
 * to `composerUnit`, which saw length 2 again. The composer, a Surface with a borrowed
 * field and a Surface *without* one all recursed until the stack ran out; a Screen was
 * safe only because it owns the unit before any of that.
 *
 * Every case here arrives through `handleData(Buffer)` — the real Reader, Router and
 * owner adapters — and the recursion is measured rather than waited for: the wrappers
 * below count how deep the delivery went and fail with a number instead of a stack
 * overflow.
 *
 * The distinction the fix rests on, and the one it must not blur:
 *
 *   - **code unit** — `'🚀'.length === 2`, `'a'.length === 1`; offsets and slices are
 *     counted in these, and the cursor contract is unchanged by this round;
 *   - **code point** — `Array.from('🚀').length === 1`; what `for...of` iterates and
 *     what the Reader frames;
 *   - **grapheme cluster** — what the editing keys move over (`e` + U+0301, ZWJ
 *     sequences): several code points, and the existing segmenter rules are untouched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, tick, waitForDialog } from './wait.mjs'

setLocale('zh')

/** A TUI with the delivery instrumented: depth, and how often each path was entered. */
function fixture() {
  const sent = []
  const exits = []
  const ctx = {
    get: name => (name === 'appExit' ? code => { exits.push(code) } : undefined),
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] },
    cancel() {}, followup: message => { sent.push(message) }, steer: message => { sent.push(message) },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}

  // The recursion guard: the wrappers call through exactly as before, but a delivery that
  // re-enters itself more than a few times is reported as what it is. The honest ceiling
  // is small — a run of text is delivered once and each code point then reaches an owner
  // once — so a regression cannot hide behind "it happened to survive".
  const DEPTH_LIMIT = 8
  const counts = { composerUnit: 0, handlePlainText: 0, handleChar: 0 }
  let depth = 0
  let maxDepth = 0
  for (const name of ['composerUnit', 'handlePlainText', 'handleChar']) {
    const original = tui[name].bind(tui)
    tui[name] = (...args) => {
      counts[name] += 1
      depth += 1
      maxDepth = Math.max(maxDepth, depth)
      if (depth > DEPTH_LIMIT) {
        depth -= 1
        throw new Error(`${name} re-entered itself ${depth + 1} deep for ${JSON.stringify(args[0])}: one code point is not a run of text`)
      }
      try {
        return original(...args)
      } finally {
        depth -= 1
      }
    }
  }
  return { tui, sent, exits, counts, maxDepth: () => maxDepth }
}

const type = (tui, text) => tui.handleData(Buffer.from(text, 'utf8'))

/** What a Unicode input must not disturb, on top of the text it must produce. */
const snapshot = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  historyIndex: tui.historyIndex,
  folded: tui.inputFolded,
  scroll: tui.scrollOffset,
  screen: tui.screen?.kind ?? '-',
  dialog: tui.dialog?.kind ?? '-',
  focused: tui.focusedRow?.kind ?? null,
  rows: tui.rows.length,
  echo: tui.footerEcho?.text ?? null,
})

const borrowedQuestion = async tui => {
  void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
  await waitForDialog(tui, 'questions')
}

// ── A · the composer ─────────────────────────────────────────────────────────

test('W-3b.1b: a single non-BMP character is one input unit, not a run of text', () => {
  // The scalar itself, the one that is two UTF-16 units in a *different* way (a surrogate
  // pair is a pair either way), and the two shapes that used to reach the same code path.
  const cases = [
    { text: '🚀', cursor: 2 },
    { text: '𠮷', cursor: 2 },          // U+20BB7, the CJK extension B character
    { text: '𝄞', cursor: 2 },          // U+1D11E, outside the BMP too
    { text: 'a🚀b', cursor: 4 },
    { text: '🚀🚀', cursor: 4 },
    { text: '🚀a', cursor: 3 },
    { text: 'a𠮷', cursor: 3 },
    { text: '你好', cursor: 2 },
    { text: 'hello', cursor: 5 },
  ]
  for (const entry of cases) {
    const { tui, sent, counts, maxDepth } = fixture()
    const before = snapshot(tui)
    assert.doesNotThrow(() => type(tui, entry.text), `typing ${JSON.stringify(entry.text)} must not recurse`)
    assert.equal(tui.input, entry.text, `${JSON.stringify(entry.text)}: the whole text arrived, once`)
    assert.equal(tui.cursor, entry.cursor, `${JSON.stringify(entry.text)}: the caret is at the UTF-16 offset after it`)
    assert.equal([...tui.input].length, [...entry.text].length, `${JSON.stringify(entry.text)}: no code point was duplicated`)
    assert.ok(!tui.input.includes('\uFFFD'), `${JSON.stringify(entry.text)}: no replacement character`)
    // Nothing else happened: no submit, no row, no history move, no browser mode.
    assert.deepEqual(sent, [], `${JSON.stringify(entry.text)}: no message was sent`)
    const after = snapshot(tui)
    for (const key of ['historyIndex', 'folded', 'scroll', 'screen', 'dialog', 'focused', 'rows', 'echo']) {
      assert.deepEqual(after[key], before[key], `${JSON.stringify(entry.text)}: ${key} must not change`)
    }
    // The delivery itself stayed flat. The honest depth for a run is four — the unit,
    // the split, one character, and the owner's own `composerUnit` for that character —
    // and a recursion would blow past the wrapper's ceiling instead of the stack's.
    assert.ok(maxDepth() <= 4, `${JSON.stringify(entry.text)}: delivery depth ${maxDepth()}`)
    const units = 1 + [...entry.text].length   // the read itself, then one per code point
    assert.ok(counts.composerUnit <= units,
      `${JSON.stringify(entry.text)}: composerUnit entered ${counts.composerUnit} times, not ${units}`)
  }
})

test('W-3b.1b: a mixed run keeps its order and its caret', () => {
  const { tui } = fixture()
  type(tui, 'ab')
  type(tui, '🚀')
  type(tui, 'cd')
  assert.equal(tui.input, 'ab🚀cd', 'each read lands where the last one stopped')
  assert.equal(tui.cursor, 6, 'and the caret counts UTF-16 units')
  type(tui, '\x1b[H')
  assert.equal(tui.cursor, 0, 'Home is still the composer’s')
  type(tui, '𠮷')
  assert.equal(tui.input, '𠮷ab🚀cd', 'a non-BMP character inserts at the caret without splitting it')
  assert.equal(tui.cursor, 2, 'and the caret moves by its UTF-16 length')
})

// ── B · a Surface that borrowed the field ────────────────────────────────────

test('W-3b.1b: a non-BMP answer goes to the borrowed field, never to the draft', async () => {
  for (const text of ['🚀', '𠮷', 'a🚀b']) {
    const { tui, sent } = fixture()
    tui.input = '我打了一半的消息'
    tui.cursor = 3
    await borrowedQuestion(tui)
    assert.doesNotThrow(() => type(tui, text), `${JSON.stringify(text)}: typing at a borrowed field must not recurse`)
    assert.equal(tui.borrowedText?.text, text, `${JSON.stringify(text)}: the answer is the field the reader can see`)
    assert.equal(tui.borrowedText?.cursor, text.length, `${JSON.stringify(text)}: with the caret after it`)
    assert.equal(tui.input, '我打了一半的消息', `${JSON.stringify(text)}: the draft behind the Surface is untouched`)
    assert.equal(tui.cursor, 3, `${JSON.stringify(text)}: and so is its caret`)
    assert.deepEqual(sent, [], `${JSON.stringify(text)}: and nothing was answered`)
  }
})

test('W-3b.1b: an emoji typed at a borrowed field can be edited like a character', async () => {
  const { tui } = fixture()
  tui.input = '我打了一半的消息'
  tui.cursor = 3
  await borrowedQuestion(tui)
  type(tui, 'a🚀')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'a🚀', cursor: 3 })
  type(tui, '\x7f')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'a', cursor: 1 },
    'Backspace removes the whole emoji, not half a surrogate pair')
  type(tui, '🚀b')
  type(tui, '\x1b[H')
  type(tui, '\x1b[3~')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: '🚀b', cursor: 0 },
    'Delete removes the character at the caret')
  type(tui, '\x1b[3~')
  assert.deepEqual({ text: tui.borrowedText?.text, cursor: tui.borrowedText?.cursor }, { text: 'b', cursor: 0 },
    'and the next one takes the emoji whole, not half a surrogate pair')
  assert.ok(!(tui.borrowedText?.text ?? '').includes('\uFFFD'), 'and never leaves a replacement character')
})

// ── C · owners that refuse input, and the wizard's own field ─────────────────

test('W-3b.1b: a refusing Surface or Screen is not crashed by a non-BMP character', async () => {
  // The confirm is the interesting one: it has no field, so `composerUnit` used to recurse
  // *before* the Surface could refuse the text. A Screen never reached that path at all.
  const confirm = fixture()
  confirm.tui.input = '我打了一半的消息'
  confirm.tui.cursor = 3
  void new Promise(resolve => { confirm.tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
  await waitForDialog(confirm.tui, 'confirm')
  assert.doesNotThrow(() => type(confirm.tui, '🚀'))
  assert.equal(confirm.tui.dialog?.kind, 'confirm', 'the confirmation is still asking')
  assert.equal(confirm.tui.input, '我打了一半的消息', 'and the draft behind it is untouched')
  assert.equal(confirm.tui.cursor, 3, 'including its caret')

  const screen = fixture()
  screen.tui.input = '我打了一半的消息'
  screen.tui.cursor = 3
  screen.tui.openScreen({
    kind: 'report', report: 'diag', title: '诊断',
    lines: [{ kind: 'system', text: '正文' }], offset: 0, copyText: '正文',
  })
  assert.doesNotThrow(() => type(screen.tui, '🚀'))
  assert.equal(screen.tui.screen?.kind, 'report', 'the Screen is still up')
  assert.equal(screen.tui.input, '我打了一半的消息', 'and the draft behind it is untouched')
  assert.equal(screen.tui.cursor, 3, 'including its caret')

  // The wizard is a Screen with a field of its own, and it types through its own handler:
  // the character must land there (not be dropped, not reach the draft).
  const wizard = fixture()
  const pending = wizard.tui.runOnboarding()
  assert.equal(wizard.tui.screen?.kind, 'setup', 'the production entry opened the wizard')
  wizard.tui.input = '我打了一半的消息'
  wizard.tui.cursor = 3
  const state = wizard.tui.onboarding
  assert.doesNotThrow(() => type(wizard.tui, '🚀'))
  assert.equal(state?.field, '🚀', 'the wizard’s own field took the character')
  assert.equal(wizard.tui.input, '我打了一半的消息', 'and the composer draft is untouched')
  wizard.tui.handleData(Buffer.from('\x1b'))
  await pending.catch(() => undefined)
})

// ── D · UTF-8 split across reads ─────────────────────────────────────────────

test('W-3b.1b: a code point split across reads arrives whole, once', () => {
  const bytes = Buffer.from('🚀', 'utf8')
  assert.equal(bytes.length, 4, 'the fixture really is a four-byte code point')
  const whole = fixture()
  type(whole.tui, '🚀')
  for (const cut of [1, 2, 3]) {
    const { tui } = fixture()
    tui.handleData(bytes.subarray(0, cut))
    assert.equal(tui.input, '', `cut ${cut}: half a code point is not inserted`)
    tui.handleData(bytes.subarray(cut))
    assert.equal(tui.input, '🚀', `cut ${cut}: the decoder joined the halves`)
    assert.equal(tui.cursor, 2, `cut ${cut}: and the caret is after the code point`)
    assert.ok(!tui.input.includes('\uFFFD'), `cut ${cut}: no replacement character`)
    assert.deepEqual(snapshot(tui), snapshot(whole.tui), `cut ${cut}: the same state as one whole read`)
  }

  // Several code points in one read, and the same bytes one code point at a time.
  const together = fixture()
  type(together.tui, 'a🚀b')
  const apart = fixture()
  type(apart.tui, 'a')
  type(apart.tui, '🚀')
  type(apart.tui, 'b')
  assert.equal(apart.tui.input, 'a🚀b', 'the split reads produce the same text')
  assert.equal(apart.tui.cursor, 4)
  assert.deepEqual(snapshot(apart.tui), snapshot(together.tui), 'and the same state')

  // A byte-level split of the same three characters, cut inside the emoji.
  const sliced = fixture()
  const raw = Buffer.from('a🚀b', 'utf8')
  sliced.tui.handleData(raw.subarray(0, 2))
  sliced.tui.handleData(raw.subarray(2, 4))
  sliced.tui.handleData(raw.subarray(4))
  assert.equal(sliced.tui.input, 'a🚀b', 'a cut inside the emoji is still one emoji')
  assert.deepEqual(snapshot(sliced.tui), snapshot(together.tui), 'with the same state as the whole read')
})

// ── E · paste, typing, and the semantics around them ─────────────────────────

test('W-3b.1b: pasted and typed non-BMP text agree', async () => {
  for (const text of ['🚀', 'a🚀b', '𠮷🚀']) {
    const typed = fixture()
    type(typed.tui, text)
    const pasted = fixture()
    pasted.tui.handleData(Buffer.from(`\x1b[200~${text}\x1b[201~`, 'utf8'))
    assert.equal(pasted.tui.input, typed.tui.input, `${JSON.stringify(text)}: paste and typing agree in the composer`)
    assert.equal(pasted.tui.cursor, typed.tui.cursor, `${JSON.stringify(text)}: and on the caret`)

    const typedField = fixture()
    await borrowedQuestion(typedField.tui)
    type(typedField.tui, text)
    const pastedField = fixture()
    await borrowedQuestion(pastedField.tui)
    pastedField.tui.handleData(Buffer.from(`\x1b[200~${text}\x1b[201~`, 'utf8'))
    assert.equal(pastedField.tui.borrowedText?.text, typedField.tui.borrowedText?.text,
      `${JSON.stringify(text)}: and in a borrowed field`)
  }
})

test('W-3b.1b: the answer and dismissal semantics are the ones W-3a/W-3b.1 pinned', async () => {
  // A pasted `yes` still does not answer a confirmation, and a typed one still answers
  // while the rest of the read reaches the composer — the branch this round must not
  // delete to fix the emoji.
  const pasted = fixture()
  pasted.tui.input = '我打了一半的消息'
  pasted.tui.cursor = 3
  void new Promise(resolve => { pasted.tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
  await waitForDialog(pasted.tui, 'confirm')
  pasted.tui.handleData(Buffer.from('\x1b[200~yes\x1b[201~'))
  assert.equal(pasted.tui.dialog?.kind, 'confirm', 'a paste is not an answer')
  assert.equal(pasted.tui.input, '我打了一半的消息', 'and it does not reach the draft either')

  const typed = fixture()
  typed.tui.input = '我打了一半的消息'
  typed.tui.cursor = 3
  const pending = typed.tui.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } })
  await waitForDialog(typed.tui, 'confirm')
  type(typed.tui, 'yes')
  assert.equal(typed.tui.input, '我打了es一半的消息', 'y answers and the es is typed behind it')
  assert.equal(typed.tui.cursor, 5, 'the caret followed the two characters that landed')
  await pending.catch(() => undefined)

  // A Screen's rejection: the character does not reach the draft behind it, and the
  // dismissal guard from W-3a.1 still drops what follows in the same read.
  const screen = fixture()
  screen.tui.input = '我打了一半的消息'
  screen.tui.cursor = 3
  screen.tui.openScreen({
    kind: 'report', report: 'diag', title: '诊断',
    lines: [{ kind: 'system', text: '正文' }], offset: 0, copyText: '正文',
  })
  screen.tui.handleData(Buffer.from('🚀\x1bq', 'utf8'))
  assert.equal(screen.tui.input, '我打了一半的消息', 'a non-BMP character cannot reach the draft behind a Screen')
  assert.equal(screen.tui.cursor, 3, 'nor move its caret')
})

// ── F · grapheme editing is unchanged ────────────────────────────────────────

test('W-3b.1b: a borrowed field edits its own graphemes, not the draft’s', async () => {
  // The second defect this round found, and the same root as the first: the field that
  // owns the keyboard has to be the one measured. `graphemeBefore`/`graphemeAfter`
  // segmented the *draft* while `backspace`/`deleteAtCursor` edited the borrowed answer,
  // so the ranges came from another string — with a CJK draft and an emoji answer,
  // Backspace took one surrogate and left the caret inside the pair (and the old
  // build shipped that since the borrowed field existed).
  const cases = [
    { name: 'a🚀 then Backspace', reads: ['a🚀', '\x7f'], text: 'a', cursor: 1 },
    { name: '🚀 then Backspace', reads: ['🚀', '\x7f'], text: '', cursor: 0 },
    { name: '🚀🚀 then Backspace', reads: ['🚀🚀', '\x7f'], text: '🚀', cursor: 2 },
    { name: 'a🚀b, Home, Delete, Delete', reads: ['a🚀b', '\x1b[H', '\x1b[3~', '\x1b[3~'], text: 'b', cursor: 0 },
    { name: 'a🚀b, Home, insert 𠮷, Backspace', reads: ['a🚀b', '\x1b[H', '𠮷', '\x7f'], text: 'a🚀b', cursor: 0 },
    { name: 'e\u0301 then Backspace', reads: ['e\u0301', '\x7f'], text: '', cursor: 0 },
    { name: 'a👍🏽 then Backspace', reads: ['a👍🏽', '\x7f'], text: 'a', cursor: 1 },
  ]
  for (const entry of cases) {
    const { tui } = fixture()
    tui.input = '我打了一半的消息'
    tui.cursor = 3
    await borrowedQuestion(tui)
    for (const read of entry.reads) assert.doesNotThrow(() => type(tui, read), `${entry.name}: ${JSON.stringify(read)}`)
    assert.equal(tui.borrowedText?.text, entry.text, `${entry.name}: the borrowed field holds the right text`)
    assert.equal(tui.borrowedText?.cursor, entry.cursor, `${entry.name}: and the caret is on a code point boundary`)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(tui.borrowedText?.text ?? ''),
      `${entry.name}: no half surrogate pair is left behind`)
    assert.ok(!(tui.borrowedText?.text ?? '').includes('\uFFFD'), `${entry.name}: and no replacement character`)
    assert.equal(tui.input, '我打了一半的消息', `${entry.name}: the draft behind the Surface is untouched`)
    assert.equal(tui.cursor, 3, `${entry.name}: including its caret`)
  }

  // The composer's own editing is the same code, and with no borrowed field the field
  // *is* the draft: the same reads must land identically there.
  for (const entry of cases) {
    const { tui } = fixture()
    for (const read of entry.reads) type(tui, read)
    assert.equal(tui.input, entry.text, `composer ${entry.name}: same text`)
    assert.equal(tui.cursor, entry.cursor, `composer ${entry.name}: same caret`)
  }
})

test('W-3b.1b: multi-code-point graphemes keep their existing editing rules', () => {
  const cases = [
    { name: 'combining mark', text: 'e\u0301', backspaces: 1, after: '' },
    { name: 'emoji with a skin tone', text: '👍🏽', backspaces: 1, after: '' },
    { name: 'ZWJ family', text: '👩\u200D💻', backspaces: 1, after: '' },
    { name: 'flag', text: '🇨🇳', backspaces: 1, after: '' },
    { name: 'two emoji', text: '🚀🚀', backspaces: 1, after: '🚀' },
    { name: 'text then emoji', text: 'a🚀', backspaces: 1, after: 'a' },
  ]
  for (const entry of cases) {
    const { tui } = fixture()
    assert.doesNotThrow(() => type(tui, entry.text), `${entry.name}: typing`)
    assert.equal(tui.input, entry.text, `${entry.name}: the whole grapheme arrived`)
    for (let index = 0; index < entry.backspaces; index += 1) type(tui, '\x7f')
    assert.equal(tui.input, entry.after,
      `${entry.name}: Backspace takes one grapheme (the segmenter's own unit), never half a surrogate pair`)
    assert.ok(!tui.input.includes('\uFFFD'), `${entry.name}: no replacement character`)
  }

  // Delete in front, and an emoji inserted in the middle of an existing draft.
  const { tui } = fixture()
  type(tui, 'a🚀b')
  type(tui, '\x1b[H')
  type(tui, '\x1b[C')
  type(tui, '\x1b[3~')
  assert.equal(tui.input, 'ab', 'Delete removes the emoji whole')
  assert.equal(tui.cursor, 1)
  type(tui, '𠮷')
  assert.equal(tui.input, 'a𠮷b', 'and a non-BMP character inserts in the middle')
  assert.equal(tui.cursor, 3)
  assert.ok(!tui.input.includes('\uFFFD'))
})

test('W-3b.1b: a long run of mixed scripts stays exact', () => {
  const text = 'ASCII 中文 🚀𠮷 𝄞 e\u0301 👩\u200D💻 done'
  const { tui, counts } = fixture()
  assert.doesNotThrow(() => type(tui, text))
  assert.equal(tui.input, text, 'the run arrived exactly once, code point for code point')
  assert.equal(tui.cursor, text.length, 'the caret is at the end of the UTF-16 string')
  assert.equal(tui.input.normalize('NFC'), text.normalize('NFC'), 'and the text is not silently recomposed')
  assert.ok(counts.handlePlainText <= 2, `the run was split ${counts.handlePlainText} times, not per character`)
  const { tui: back } = fixture()
  type(back, text)
  const graphemes = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(text)].length
  for (let index = 0; index < graphemes; index += 1) type(back, '\x7f')
  assert.equal(back.input, '', `Backspace ${graphemes} times emptied the field, one grapheme at a time`)
})

test('W-3b.1b: nothing here changed the keymap or the holds', async () => {
  // The fix is a code-point test in one branch; the keys and the two hold windows are the
  // ones the contract froze. This is the cheap guard that the round stayed inside them.
  const { tui } = fixture()
  await tick(0)
  assert.equal(tui.keys ?? undefined, undefined, 'a fixture with no overrides has no key table of its own')
  pushRow(tui, { kind: 'assistant', text: '一行' })
  type(tui, '\x1b[A')
  assert.equal(tui.historyIndex, -1, 'an arrow with an empty field and no cards stays in the composer')
})
