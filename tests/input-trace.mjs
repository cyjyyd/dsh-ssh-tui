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

function snapshot(tui, rowsAtStart) {
  return {
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
  const state = { ...snapshot(tui, rowsAtStart), sent: [...sent], exits: [...exits] }
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
]
