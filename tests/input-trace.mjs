/**
 * The trace harness behind the Reader's behaviour-equivalence test.
 *
 * W-1 moves byte framing (decode · reply filter · ESC assembly · paste markers ·
 * sequence classification) out of `tui.ts` into `src/input-reader.ts`. A move is
 * only a move if the same bytes reach the same consumer the same number of times
 * with the same arguments — so this module feeds a fixed fixture list through
 * `handleData` (the real entry: stdin and the Host relay both call it) and records
 * **which consumer entry point received what**, in order, plus the state the run
 * ended in.
 *
 * The recorded answer for the fixtures lives in `fixtures/input-reader-traces.json`,
 * captured **before** the extraction. `tests/input-reader.test.mjs` re-derives it and
 * compares. Nothing here asserts; it observes. The consumer methods are wrapped on
 * the instance (still the real path, the wrapper calls through), never replaced.
 */
import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { pushRow } from './wait.mjs'

setLocale('zh')

/**
 * The instance methods whose calls are the framing's observable output.
 *
 * Deliberately the **owner boundary** and the effects, not the internals the
 * refactors are allowed to rename: W-1 replaced `processPasteChunk`, W-2 replaced
 * `handleChar`/`handlePlainText`/`scrollActiveSurface` with adapters, and neither is
 * a behaviour change — a trace that failed on those names would be pinning the shape
 * of the code rather than what a user sees. What stays in the list is what the four
 * owners are called *by*, plus the operations that move state a reader can observe
 * (history, focus, scroll, the selection, the exit).
 */
const TRACED = [
  'handleInputText',
  'handlePasteText',
  'pasteIntoScreen',
  'handleScreenInput',
  'handleSetupKey',
  'handleDialogChar',
  'submit',
  'handleEscape',
  'handleCtrlC',
  'copyKey',
  'scrollScreen',
  'moveFocus',
  'historyBack',
  'historyForward',
  'moveCursor',
  'insertIntoField',
  'backspace',
  'deleteAtCursor',
  'beginMouseSelection',
  'extendMouseSelection',
  'endMouseSelection',
  'handleMouseClick',
  'stepSearch',
  'jumpToCategory',
  'toggleCollapsible',
  'toggleAllCollapsible',
  'requestExit',
]

/**
 * What a fixture builds before it types.
 *
 * - `rows` — a transcript with something to scroll and copy
 * - `thinking` — a reasoning card, so an Alt chord has a target
 * - `draft` — a half-typed message (so a leak is visible in the trace)
 * - `screen` — a report Screen (the Screen path must frame identically too)
 * - `wizard` — the production onboarding entry point
 * - `dialog` — an approval Surface
 */
const SETUPS = {
  rows: tui => {
    for (let index = 0; index < 40; index += 1) pushRow(tui, { kind: 'assistant', text: `回复 ${index}` })
  },
  thinking: tui => {
    for (let index = 0; index < 12; index += 1) pushRow(tui, { kind: 'reasoning', text: `思考 ${index}` })
    for (let index = 0; index < 40; index += 1) pushRow(tui, { kind: 'assistant', text: `回复 ${index}` })
  },
  draft: tui => {
    tui.input = '我打了一半的消息'
    tui.cursor = 3
  },
  screen: tui => {
    tui.openScreen({
      kind: 'report', report: 'diag', title: '诊断',
      lines: Array.from({ length: 60 }, (_line, index) => ({ kind: 'system', text: `第 ${index} 行` })),
      offset: 20, copyText: '屏幕上的正文',
    })
  },
  wizard: tui => { void tui.runOnboarding() },
  /** A question with no options: the Surface that owns a borrowed text field. */
  question: tui => {
    void tui.askQuestion({ id: 'q1', question: '回滚到哪个版本？' }, 0, 1).catch(() => undefined)
  },
  /** A list question: the shape that has hotkeys, and the one that can be filtered. */
  list: tui => {
    void tui.askQuestion({ id: 'q2', question: '选哪个？', options: [{ label: 'Alpha' }, { label: 'Beta' }] }, 0, 1).catch(() => undefined)
  },
  dialog: tui => {
    // `openConfirm` is the Surface's own entry (the approval service would need a
    // mock); the route under test is the same one `handleApproval` lands on.
    void new Promise(resolve => { tui.openConfirm('允许工具 "bash"？', 'y = 允许一次', resolve, 'approval') })
  },
}

/** One TUI with pinned geometry, so a page size is not the runner's terminal. */
function fixture({ setup = [], keys } = {}) {
  // `appExit` is recorded rather than honoured: the harness traces a Ctrl+D, it
  // does not exit the suite's process.
  const exits = []
  const ctx = {
    get: name => (name === 'appExit' ? code => { exits.push(code) } : undefined),
    on() { return () => {} },
  }
  // A submitted message is part of the observable answer: the framing decides
  // whether a read becomes one, so the trace records what reached the agent.
  const sent = []
  const agent = {
    id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] },
    cancel() {},
    followup: message => { sent.push(sentText(message)) },
    steer: message => { sent.push(sentText(message)) },
  }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session', color: false, headlessDisplay: true,
    ...(keys === undefined ? {} : { keys }),
  })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  // Geometry is fixed here on purpose: a page key moves by `rows/2`, and the trace
  // must not depend on the terminal the suite happens to run under. The *frames* are
  // still produced by the real paint math for this size.
  tui.screenRows = () => 24
  tui.screenColumns = () => 80
  for (const name of setup) SETUPS[name](tui)
  return { tui, agent, sent, exits }
}

/** The text of a message the agent was handed (or a marker when the shape is odd). */
function sentText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return `object:${typeof message}`
  return content.map(part => (typeof part?.text === 'string' ? part.text : `part:${part?.type ?? '?'}`)).join('')
}

/** A value that survives JSON and does not depend on time or identity. */
function oid(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return null
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map(oid)
  if (typeof value === 'object') return `object:${value.kind ?? value.constructor?.name ?? 'unknown'}`
  return String(value)
}

/**
 * The recorded end state of one fixture.
 *
 * `record` is how a fixture asks for state only its own case can observe: W-3b.1's
 * borrowed-field case needs the field the Surface borrowed, which the composer's own
 * `input`/`cursor` say nothing about. It is opt-in on purpose — a key added for every
 * fixture would rewrite the whole reference, and the reference is only worth comparing
 * while it is the same file it always was.
 */
function snapshot(tui, rowsAtStart, record = []) {
  const state = {
    input: tui.input,
    cursor: tui.cursor,
    historyIndex: tui.historyIndex,
    historyLength: tui.history.length,
    folded: tui.inputFolded,
    scrollOffset: tui.scrollOffset,
    screen: tui.screen?.kind ?? null,
    screenOffset: tui.screen?.offset ?? null,
    dialog: tui.dialog?.kind ?? null,
    focusedKind: tui.focusedRow?.kind ?? null,
    // Rows *added*, not rows held: the boot transcript differs by environment (a
    // CI run has one more notice than a developer's checkout), and the framing's
    // business is what a fixture appended, not what boot happened to paint.
    rowsAdded: tui.rows.length - rowsAtStart,
    yank: tui.copyYank ?? null,
    echo: tui.footerEcho?.text ?? null,
  }
  if (record.includes('borrowed')) {
    state.borrowed = tui.borrowedText === undefined
      ? null
      : { text: tui.borrowedText.text, cursor: tui.borrowedText.cursor }
  }
  return state
}

/**
 * Feed one fixture and return `{ trace, state }`.
 * @param fixture - a fixture from {@link FIXTURES}.
 */
export async function traceFixture(fixture) {
  const { tui, sent, exits } = fixtureOf(fixture)
  const trace = []
  const originals = new Map()
  for (const name of TRACED) {
    const original = tui[name]
    if (typeof original !== 'function') continue
    const bound = original.bind(tui)
    originals.set(name, original)
    tui[name] = (...args) => {
      trace.push([name, ...args.map(oid)])
      return bound(...args)
    }
  }
  const rowsAtStart = tui.rows.length
  for (const read of fixture.reads) {
    tui.handleData(Array.isArray(read) ? Buffer.from(read) : Buffer.from(read, 'utf8'))
  }
  // Both holds are timers (30 ms for a reply tail, 60 ms for an ESC prefix): wait
  // past them so a released key is part of the trace rather than a pending callback.
  await new Promise(resolve => setTimeout(resolve, 120))
  const state = { ...snapshot(tui, rowsAtStart, fixture.record ?? []), sent: [...sent], exits: [...exits] }
  // Settle a Surface this fixture left open, so the run does not keep a pending
  // promise alive — but never wait on it: the trace is already recorded.
  if (tui.dialog !== undefined) {
    tui.handleData(Buffer.from('n'))
    void Promise.resolve().catch(() => undefined)
  }
  for (const [name, original] of originals) tui[name] = original
  return { trace, state }
}

/** The fixture with its setup applied (the harness needs it twice). */
function fixtureOf(entry) {
  return fixture({ setup: entry.setup ?? [], keys: entry.keys })
}

/** Bytes as the terminal would split them, for the split-read cases. */
const split = (...parts) => parts

/**
 * The fixture list. Every entry is `{ name, reads, setup? }` and every one of them
 * is a case the W-0 audit or the contract's event table names — printable, UTF-8,
 * escape sequences, arrows, page keys, mouse, paste (whole and split), a device
 * reply, control bytes, Alt chords, and the coalesced reads the known gaps are
 * about (which must stay *exactly* as broken until W-3).
 */
export const FIXTURES = [
  { name: 'printable', reads: ['hello'] },
  { name: 'printable-with-draft', reads: ['ab'], setup: ['draft'] },
  { name: 'utf8-multibyte', reads: ['思考一下'] },
  { name: 'utf8-split-code-point', reads: split([0xe6, 0x80], [0x9d]) },
  { name: 'control-bytes', reads: ['\x15'] },
  { name: 'backspace', reads: ['\x7f'], setup: ['draft'] },
  { name: 'enter-submits', reads: ['hello\r'] },
  { name: 'crlf', reads: ['hello\r\n'] },
  { name: 'ctrl-c', reads: ['\x03'] },
  { name: 'ctrl-d', reads: ['\x04'] },
  { name: 'ctrl-l', reads: ['\x0c'] },
  { name: 'ctrl-v', reads: ['\x16'], setup: ['draft'] },
  { name: 'arrow-up', reads: ['\x1b[A'], setup: ['rows'] },
  { name: 'arrow-down', reads: ['\x1b[B'], setup: ['rows'] },
  { name: 'arrow-left-right', reads: ['\x1b[C\x1b[D'], setup: ['draft'] },
  { name: 'pgup', reads: ['\x1b[5~'], setup: ['rows'] },
  { name: 'pgup-pgdn', reads: ['\x1b[5~', '\x1b[6~'], setup: ['rows'] },
  { name: 'pgup-twice-one-read', reads: ['\x1b[5~\x1b[5~'], setup: ['rows'] },
  { name: 'home-end-delete', reads: ['\x1b[H', '\x1b[F', '\x1b[3~'], setup: ['draft'] },
  { name: 'unknown-csi', reads: ['\x1b[1;5u'] },
  { name: 'ss3-with-tail', reads: ['\x1bOAx'] },
  { name: 'ss3-unknown', reads: ['\x1bOZ'] },
  { name: 'escape-prefix-split', reads: split('\x1b', '[A'), setup: ['rows'] },
  { name: 'escape-prefix-split-inside', reads: split('\x1b[', '5~'), setup: ['rows'] },
  { name: 'lone-escape', reads: ['\x1b'] },
  { name: 'escape-o-partial', reads: ['\x1bO'] },
  { name: 'alt-1', reads: ['\x1b1'], setup: ['thinking'] },
  { name: 'alt-1-batched', reads: ['\x1b1x'], setup: ['thinking'] },
  { name: 'alt-f', reads: ['\x1bf'] },
  { name: 'mouse-press-release', reads: ['\x1b[<0;10;5M', '\x1b[<0;10;5m'], setup: ['rows'] },
  { name: 'mouse-drag', reads: ['\x1b[<0;10;5M', '\x1b[<32;14;5M', '\x1b[<0;14;5m'], setup: ['rows'] },
  { name: 'mouse-wheel', reads: ['\x1b[<65;10;5M'], setup: ['rows'] },
  { name: 'mouse-split-report', reads: split('\x1b[<0;1', '0;5M'), setup: ['rows'] },
  { name: 'cpr-reply', reads: ['\x1b[12;5R'] },
  { name: 'paste-simple', reads: ['\x1b[200~pasted text\x1b[201~'] },
  { name: 'paste-multiline', reads: ['\x1b[200~line one\nline two\x1b[201~'] },
  { name: 'paste-with-enter', reads: ['\x1b[200~pasted\x1b[201~\r'] },
  { name: 'paste-split-markers', reads: split('\x1b[200~', 'pasted content', '\x1b[201~') },
  { name: 'paste-split-inside-marker', reads: split('\x1b[20', '0~pasted\x1b[201~') },
  { name: 'paste-split-close-marker', reads: split('\x1b[200~pasted', '\x1b[201', '~') },
  // The close marker cut in half *inside a long read*: the guard above cannot hold it
  // (the read is not an escape prefix), so the Reader is the only place that can. The
  // naive framing leaves `inPaste` set for the rest of the session — Esc stops
  // closing dialogs and `/exit` stops exiting, which is what `tui-paste-probe.mjs`
  // caught on CI.
  { name: 'paste-split-inside-long-read', reads: split('\x1b[200~pasted\x1b[20', '1~') },
  { name: 'paste-split-inside-long-read-then-escape', reads: split('\x1b[200~pasted\x1b[20', '1~', '\x1b'), setup: ['dialog', 'draft'] },
  { name: 'paste-at-screen', reads: ['\x1b[200~pasted\x1b[201~'], setup: ['screen', 'draft'] },
  { name: 'paste-burst-no-markers', reads: ['one\ntwo\nthree\n'] },
  { name: 'yes-is-not-an-answer', reads: ['yes'] },
  // ── the Surface's edges, and the two Ctrl+L implementations (W-2 decisions) ──
  { name: 'dialog-arrows', reads: ['\x1b[A', '\x1b[B'], setup: ['dialog', 'draft'] },
  { name: 'dialog-escape', reads: ['\x1b'], setup: ['dialog', 'draft'] },
  { name: 'dialog-enter', reads: ['\r'], setup: ['dialog', 'draft'] },
  { name: 'dialog-ctrl-c', reads: ['\x03'], setup: ['dialog', 'draft'] },
  { name: 'dialog-ctrl-l', reads: ['\x0c'], setup: ['dialog', 'draft'] },
  { name: 'dialog-ctrl-u', reads: ['\x15'], setup: ['dialog', 'draft'] },
  { name: 'dialog-home-end', reads: ['\x1b[H', '\x1b[F'], setup: ['dialog', 'draft'] },
  { name: 'dialog-delete', reads: ['\x1b[3~'], setup: ['dialog', 'draft'] },
  { name: 'dialog-pages-wheel', reads: ['\x1b[5~', '\x1b[<65;10;5M'], setup: ['dialog', 'draft'] },
  { name: 'dialog-unknown-csi', reads: ['\x1b[1;5u'], setup: ['dialog', 'draft'] },
  { name: 'composer-ctrl-l', reads: ['\x0c'], setup: ['draft'] },
  { name: 'screen-ctrl-l', reads: ['\x0c'], setup: ['screen', 'draft'] },
  { name: 'screen-printable-hint', reads: ['x'], setup: ['screen', 'draft'] },
  { name: 'question-typing', reads: ['v2.3'], setup: ['question', 'draft'] },
  { name: 'question-backspace', reads: ['v2.3', '\x7f\x7f'], setup: ['question', 'draft'] },
  { name: 'question-enter', reads: ['v2.3\r'], setup: ['question', 'draft'] },
  { name: 'question-paste', reads: ['\x1b[200~v2.3\x1b[201~'], setup: ['question', 'draft'] },
  { name: 'question-arrows', reads: ['\x1b[A', '\x1b[B'], setup: ['question', 'draft'] },
  { name: 'yes-typed-at-dialog', reads: ['yes'], setup: ['dialog', 'draft'] },
  { name: 'yes-pasted-at-dialog', reads: ['\x1b[200~yes\x1b[201~'], setup: ['dialog', 'draft'] },
  { name: 'screen-keys', reads: ['\x1b[B', '\x1b[6~', 'q'], setup: ['screen', 'draft'] },
  { name: 'screen-paste-and-ctrl-u', reads: ['\x1b[200~text\x1b[201~\x15'], setup: ['screen', 'draft'] },
  { name: 'screen-copy-key', reads: ['\x1b[99;6u'], setup: ['screen', 'draft'] },
  { name: 'wizard-keys', reads: ['\r', 'x', '\x7f'], setup: ['wizard', 'draft'] },
  { name: 'dialog-keys', reads: ['y'], setup: ['dialog', 'draft'] },
  { name: 'dialog-paste', reads: ['\x1b[200~pasted\x1b[201~'], setup: ['dialog', 'draft'] },
  { name: 'text-then-enter', reads: ['hello\r'] },
  { name: 'rebound-alone', reads: ['\x10'], setup: ['rows'], keys: { pageUp: 'ctrl+p' } },
  { name: 'rebound-coalesced', reads: ['\x10\x10'], setup: ['rows'], keys: { pageUp: 'ctrl+p' } },
  // ── W-3a: the same keys delivered in one read or in several ─────────────────
  //
  // Each pair is asserted to reach the same owners with the same end state (see
  // `tests/input-reader.test.mjs`, "a read is not a key"): a coalesced read may not
  // drop a key, may not run one twice, and may not change what a key means. The pairs
  // whose halves end in different states on purpose — a Surface that closes on the
  // first key, a Screen that does — are not here; they are their own cases below.
  { name: 'pair-pgup-two-reads', reads: ['\x1b[5~', '\x1b[5~'], setup: ['rows'] },
  { name: 'pair-pgdn-one-read', reads: ['\x1b[6~\x1b[6~'], setup: ['rows'] },
  { name: 'pair-pgdn-two-reads', reads: ['\x1b[6~', '\x1b[6~'], setup: ['rows'] },
  { name: 'pair-down-one-read', reads: ['\x1b[B\x1b[B'], setup: ['rows'] },
  { name: 'pair-down-two-reads', reads: ['\x1b[B', '\x1b[B'], setup: ['rows'] },
  { name: 'pair-arrows-mixed-one-read', reads: ['\x1b[A\x1b[B\x1b[A'], setup: ['rows'] },
  { name: 'pair-arrows-mixed-two-reads', reads: ['\x1b[A\x1b[B', '\x1b[A'], setup: ['rows'] },
  { name: 'pair-keys-three-one-read', reads: ['\x1b[5~\x1b[6~\x1b[5~'], setup: ['rows'] },
  { name: 'pair-keys-three-three-reads', reads: ['\x1b[5~', '\x1b[6~', '\x1b[5~'], setup: ['rows'] },
  { name: 'pair-typing-with-enter-one-read', reads: ['hello\r'], setup: ['draft'] },
  { name: 'pair-typing-with-enter-two-reads', reads: ['hello', '\r'], setup: ['draft'] },
  { name: 'rebound-split', reads: ['\x10', '\x10'], setup: ['rows'], keys: { pageUp: 'ctrl+p' } },
  { name: 'rebound-with-text', reads: ['ab\x10cd'], setup: ['draft'], keys: { pageUp: 'ctrl+p' } },
  { name: 'rebound-split-with-text', reads: ['ab', '\x10', 'cd'], setup: ['draft'], keys: { pageUp: 'ctrl+p' } },
  { name: 'rebound-mixed-default', reads: ['\x1b[5~\x10'], setup: ['rows'], keys: { pageUp: 'ctrl+p' } },
  { name: 'rebound-mixed-default-split', reads: ['\x1b[5~', '\x10'], setup: ['rows'], keys: { pageUp: 'ctrl+p' } },
  { name: 'alt-1-then-key-one-read', reads: ['\x1b1\x1b[5~'], setup: ['thinking'] },
  { name: 'alt-1-then-key-two-reads', reads: ['\x1b1', '\x1b[5~'], setup: ['thinking'] },
  { name: 'alt-1-then-text-two-reads', reads: ['\x1b1', 'x'], setup: ['thinking'] },
  { name: 'screen-keys-one-read', reads: ['\x1b[A\x1b[6~q'], setup: ['screen', 'draft'] },
  { name: 'screen-copy-with-page', reads: ['\x1b[6~\x1b[99;6u'], setup: ['screen', 'draft'] },
  { name: 'screen-copy-with-page-split', reads: ['\x1b[6~', '\x1b[99;6u'], setup: ['screen', 'draft'] },
  { name: 'surface-keys-one-read', reads: ['\x1b[B\x1b[B'], setup: ['dialog', 'draft'] },
  { name: 'surface-keys-split', reads: ['\x1b[B', '\x1b[B'], setup: ['dialog', 'draft'] },
  // A paste is text, whatever it looks like: the key bytes inside the markers must
  // arrive as payload, and a marker-less burst with line breaks stays one paste even
  // when it carries something that looks like a key.
  { name: 'paste-with-key-bytes', reads: ['\x1b[200~\x1b[5~ and yes\x1b[201~'], setup: ['draft'] },
  { name: 'paste-burst-with-key-bytes', reads: ['one\n\x1b[5~ two\nthree\n'], setup: ['draft'] },
  // ── W-3a.1: a Screen owns the whole read, including its text units ──────────
  //
  // The units after a dismissal are dropped, and that has to hold *inside* a unit as
  // well as between units: a paste tail is delivered character by character, so the
  // `ESC` that closes the Screen and the `q` behind it used to be one delivery, and
  // the `q` was typed into the composer the Screen was hiding. These four fixtures
  // are the safety cases for that boundary — the Screen pair, the wizard (a Screen
  // with a field of its own) and the Surface, whose tail is still routed on.
  { name: 'screen-paste-tail-escape', reads: ['\x1b[200~pasted\x1b[201~\x1bq'], setup: ['screen', 'draft'] },
  { name: 'screen-escape-then-paste', reads: ['\x1bq\x1b[200~pasted\x1b[201~'], setup: ['screen', 'draft'] },
  { name: 'wizard-paste-tail-escape', reads: ['\x1b[200~pasted\x1b[201~\x1bq'], setup: ['wizard', 'draft'] },
  { name: 'surface-paste-tail-typing', reads: ['\x1b[200~pasted\x1b[201~yes'], setup: ['dialog', 'draft'] },
  // ── W-3b.1: the Surface's own editing keys ──────────────────────────────────
  //
  // Home/End/Delete and the kitty copy sequence are sequences, and a sequence with a
  // Surface up used to be looked up in the composer's table — so they moved and edited
  // the draft behind it. These are the safety cases for the closed boundary: the
  // no-field Surface, the borrowed field (where the same keys are the answer's own),
  // the filter (a string with no caret, so nothing to move), and the tail behind a
  // Surface's answer, which must still reach the composer.
  { name: 'surface-edit-keys-no-field', reads: ['\x1b[H', '\x1b[F', '\x1b[3~', '\x1b[99;6u'], setup: ['dialog', 'draft'] },
  { name: 'surface-field-home-delete', record: ['borrowed'], reads: ['ab', '\x1b[H', '\x1b[3~', '\x1b[F'], setup: ['question', 'draft'] },
  { name: 'surface-filter-edit-keys', reads: ['/', 'al', '\x1b[H', '\x1b[3~', '\x1b[F'], setup: ['list', 'draft'] },
  { name: 'surface-edit-then-answer', reads: ['\x1b[3~', 'yes'], setup: ['dialog', 'draft'] },
  // ── W-3b.1b: one code point is one input unit ────────────────────────────────
  //
  // An astral character is two UTF-16 code units and one code point. These fixtures pin
  // what that has to mean on the wire: one delivery per code point, the code point whole
  // when its bytes arrive split, and the borrowed field owning the answer (never the
  // draft behind it).
  { name: 'unicode-astral-typing', reads: ['a🚀b'], setup: ['draft'] },
  { name: 'unicode-astral-split-bytes', reads: split([0xf0, 0x9f], [0x9a, 0x80]), setup: ['draft'] },
  { name: 'unicode-astral-borrowed', record: ['borrowed'], reads: ['a🚀b'], setup: ['question', 'draft'] },
]
