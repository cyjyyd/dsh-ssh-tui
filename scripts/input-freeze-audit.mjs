#!/usr/bin/env node
/**
 * Input ownership audit — the static half of the input contract (AD-20, W-0).
 *
 * The contract (`docs/decisions/input-ownership.md`) says one event has exactly one
 * owner, and that only the router may read `screen`/`dialog` to decide which owner
 * that is. The *behavioural* half of that is pinned by
 * `tests/input-ownership-regression.test.mjs`; the half that is about **what exists
 * in the source** cannot be — a second router, a new hard-coded key branch or a
 * handler that starts writing the composer's draft leaves no test signature until
 * someone writes a case for it. This script is that half.
 *
 * It is a **ratchet**, not a demand for zero: the tree carries known debt (two
 * routers, a dead Screen gate, two hold windows), and this round records it rather
 * than removing it. Every count is compared against the baseline below; a count
 * that **grows** fails the audit. A count that shrinks is printed so the baseline
 * can be lowered in the same change.
 *
 *     node scripts/input-freeze-audit.mjs            # text report
 *     node scripts/input-freeze-audit.mjs --json     # machine-readable
 *     npm run freeze:input                           # the same thing
 *
 * It reads the working tree (not `lib/`), so run it from a checkout.
 *
 * @module dsh-ssh-tui/scripts/input-freeze-audit
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, relative } from 'node:path'
import process from 'node:process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const TUI = 'src/tui.ts'
const PICKER = 'src/picker.ts'
const REGRESSION_TESTS = 'tests/input-ownership-regression.test.mjs'

/** Every `.ts` file under `src/`, repo-relative — a router can live in a new file. */
function sourceFiles() {
  const out = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) out.push(relative(ROOT, path))
    }
  }
  walk(SRC)
  return out
}

const ALL_SOURCES = sourceFiles()

/**
 * The baseline this round establishes.
 *
 * `routers` counts the places that turn bytes into keystrokes (a
 * `TerminalInputGuard`), `dispatchers` the functions that decide ownership, and so
 * on. The `writers` map is the one that would have caught G-10: it lists which
 * input handler writes which owned state, so a handler that *starts* writing the
 * composer's draft shows up as a new pair.
 */
export const BASELINE = {
  routers: { count: 2, sites: [TUI, PICKER], what: 'a second input router (F-4: bytes → keystrokes lives in one place)' },
  dispatchers: { count: 1, sites: [TUI], what: 'a second ownership dispatcher (F-1: one place reads screen/dialog to route)' },
  mouseParsers: { count: 2, sites: [TUI], what: 'a second SGR mouse parser (the two sites are recorded debt: W-1) — count may shrink, not grow' },
  rawBranches: { count: 13, sites: [TUI], what: 'an owner comparing a raw byte sequence itself (F-5: the reader splits, the owner sees keys) — 13 recorded at W-0, W-1/W-3 lower it' },
  ownerReads: { screen: 31, dialog: 59, what: 'reads of this.screen / this.dialog — recorded per method below; may shrink, not grow' },
  pasteConsumers: { count: 3, sites: [TUI], what: 'a paste entry point (handlePasteText · pasteIntoScreen · processPasteChunk) — each one is a place paste could land on the wrong owner' },
  mouseConsumers: { count: 3, sites: [TUI], what: 'a mouse entry point (begin · extend · endMouseSelection; `handleMouseClick` is public and counted by hand below)' },
  knownGaps: { count: 3, sites: [REGRESSION_TESTS], what: 'a `{ todo: … }` marker in the regression suite — gaps may close, not accumulate' },
  deadScreenGate: { count: 1, sites: [TUI], what: 'the unreachable second Screen gate in `handleChar` (recorded debt: W-2)' },
}

/** State an input handler must not write unless it owns it (AD-20 F-2/F-3). */
const OWNED_WRITES = [
  { kind: 'composer draft', pattern: /this\.(input|cursor|inputFolded|historyDraft)\s*=/u },
  { kind: 'transcript', pattern: /this\.rows\.push\(|pushRow\(represent\(|this\.notice\s*=|this\.footerEcho\s*=/u },
]

/** The functions reachable from an input event. Each is scanned as a body. */
const INPUT_HANDLERS = [
  'handleData', 'handleInputText', 'processPasteChunk', 'handlePasteText', 'pasteIntoScreen',
  'handleScreenInput', 'handleSetupKey', 'handleOnboardingChar', 'handleChar', 'handlePlainText',
  'handleDialogChar', 'submit', 'runCommand', 'handleEscape', 'handleCtrlC', 'backspace',
  'deleteAtCursor', 'moveCursor', 'insertIntoField', 'setField', 'copyPlainText', 'copyKey',
  'copyFromScreen', 'copyHighlighted', 'handleMouseClick', 'beginMouseSelection',
  'extendMouseSelection', 'endMouseSelection', 'scrollActiveSurface', 'stepSearch', 'runKeyAction',
]

const read = path => readFileSync(`${ROOT}${path}`, 'utf8')

/**
 * The same text with comments blanked out, offsets and line count preserved.
 *
 * A line-based scanner that reads comments counts prose as code: the first run of
 * this audit listed `copyPlainText` as a composer writer because the comment
 * explaining the fix quoted the very assignment that was removed. Blanking keeps
 * `path:line` honest and makes "what exists in the source" mean the code. Strings
 * are tracked crudely (quotes and escapes) so a `//` inside a URL literal does not
 * open a comment; a regex literal containing `//` is not tracked, which no token in
 * this repo does.
 */
export function stripComments(text) {
  let out = ''
  let index = 0
  let inBlock = false
  let inLine = false
  let quote = ''
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (inBlock) {
      if (char === '*' && next === '/') {
        out += '  '
        index += 2
        inBlock = false
        continue
      }
      out += char === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    if (inLine) {
      if (char === '\n') {
        out += '\n'
        inLine = false
      } else out += ' '
      index += 1
      continue
    }
    if (quote !== '') {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 2
        continue
      }
      if (char === quote) quote = ''
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      out += '  '
      index += 2
      inBlock = true
      continue
    }
    if (char === '/' && next === '/') {
      out += '  '
      index += 2
      inLine = true
      continue
    }
    out += char
    index += 1
  }
  return out
}

const stripped = new Map()
const code = path => {
  if (!stripped.has(path)) stripped.set(path, stripComments(read(path)))
  return stripped.get(path)
}

/**
 * Every `path:line: text` in `files` whose line matches `pattern`.
 *
 * `comments: true` scans the raw text instead — used by exactly one query, the
 * dead Screen gate, which *is* a comment (the code under it is unreachable).
 */
function find(files, pattern, { comments = false } = {}) {
  const hits = []
  for (const path of files) {
    const text = comments ? read(path) : code(path)
    text.split('\n').forEach((line, index) => {
      if (pattern.test(line)) hits.push(`${path}:${index + 1}: ${line.trim()}`)
    })
  }
  return hits
}

/**
 * One method body, by brace balance — from `private name(` to its closing brace.
 *
 * Line-based scanning would read the *next* method's writes as this one's; the
 * body matters because the question is "does this handler write that state".
 */
function methodBody(text, name) {
  const start = new RegExp(`^  (?:private |public )?(?:async )?(?:readonly )?${name}\\s*[(<=]`, 'mu').exec(text)
  if (start === null) return undefined
  const from = text.indexOf('{', start.index)
  if (from === -1) return undefined
  let depth = 0
  for (let index = from; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return { from, to: index, body: text.slice(from, index + 1) }
    }
  }
  return undefined
}

/** Which owned state each input handler writes, as `method → kinds`. */
function writerMap() {
  const text = code(TUI)
  const out = {}
  for (const name of INPUT_HANDLERS) {
    const found = methodBody(text, name)
    if (found === undefined) continue
    const kinds = OWNED_WRITES.filter(entry => entry.pattern.test(found.body)).map(entry => entry.kind)
    if (kinds.length > 0) out[name] = kinds
  }
  return out
}

/** The reads of the two ownership flags, per enclosing method. */
function ownerReads() {
  const text = code(TUI)
  const lines = text.split('\n')
  const perMethod = {}
  let current = '(top level)'
  for (let index = 0; index < lines.length; index += 1) {
    const method = /^  (?:private |public )?(?:readonly )?(?:static )?([A-Za-z_][\w]*)\s*[(=<]/u.exec(lines[index])
    if (method !== null) current = method[1]
    if (/this\.screen\b/u.test(lines[index])) perMethod[current] = { ...(perMethod[current] ?? {}), screen: (perMethod[current]?.screen ?? 0) + 1 }
    if (/this\.dialog\b/u.test(lines[index])) perMethod[current] = { ...(perMethod[current] ?? {}), dialog: (perMethod[current]?.dialog ?? 0) + 1 }
  }
  const total = { screen: 0, dialog: 0 }
  for (const counts of Object.values(perMethod)) {
    total.screen += counts.screen ?? 0
    total.dialog += counts.dialog ?? 0
  }
  return { total, perMethod }
}

/** The whole audit, as data. Pure: no printing, no exit. */
export function auditInputOwnership() {
  const routers = find(ALL_SOURCES, /new TerminalInputGuard\(/u)
  const dispatchers = find(ALL_SOURCES, /private handleInputText\(/u)
  const mouseParsers = find(ALL_SOURCES, /const (?:sgr|sgrMouse) = \/\^\\x1b\\\[</u)
  const rawBranches = find(ALL_SOURCES, /combined === '\\x1b/u)
  const pasteConsumers = find(ALL_SOURCES, /private (?:handlePasteText|pasteIntoScreen|processPasteChunk)\(/u)
  const mouseConsumers = find(ALL_SOURCES, /private (?:beginMouseSelection|extendMouseSelection|endMouseSelection)\(/u)
  // `, { todo: '…' }` — the option syntax, not the prose that explains it.
  const knownGaps = find([REGRESSION_TESTS], /,\s*\{ todo: '/u)
  const deadScreenGate = find([TUI], /A Screen owns the keyboard here too/u, { comments: true })
  const writes = writerMap()
  const reads = ownerReads()
  return {
    routers, dispatchers, mouseParsers, rawBranches, pasteConsumers, mouseConsumers, knownGaps, deadScreenGate,
    writes, reads,
  }
}

const JSON_OUT = process.argv.slice(2).includes('--json')
const BASELINE_WRITERS = {
  // Recorded from the tree at W-0. `composer draft` here means the handler *is* the
  // composer's editor (the editing keys, the paste that lands in the draft, the
  // command line the command path consumes); the pair that must never appear is a
  // handler that does not own the composer writing it — the shape of G-10.
  handleInputText: ['composer draft'],
  handlePasteText: ['composer draft'],
  handleChar: ['composer draft'],
  setField: ['composer draft'],
  submit: ['composer draft', 'transcript'],
  runCommand: ['composer draft', 'transcript'],
  handleEscape: ['transcript'],
  handleCtrlC: ['transcript'],
  copyPlainText: ['transcript'],
  copyHighlighted: ['transcript'],
  stepSearch: ['transcript'],
}
/** (handler, kind) pairs that must not appear: the shape of the G-10 defect. */
function writerProblems(writes) {
  const problems = []
  for (const [method, kinds] of Object.entries(writes)) {
    const allowed = BASELINE_WRITERS[method] ?? []
    for (const kind of kinds) {
      if (!allowed.includes(kind)) problems.push(`new writer: ${method} writes the ${kind}`)
    }
  }
  return problems
}

function main() {
  const audit = auditInputOwnership()
  const rows = []
  const check = (id, count, baseline, what) => {
    rows.push({ id, count, baseline, what, over: count > baseline })
  }
  check('routers', audit.routers.length, BASELINE.routers.count, BASELINE.routers.what)
  check('dispatchers', audit.dispatchers.length, BASELINE.dispatchers.count, BASELINE.dispatchers.what)
  check('mouseParsers', audit.mouseParsers.length, BASELINE.mouseParsers.count, BASELINE.mouseParsers.what)
  check('rawBranches', audit.rawBranches.length, BASELINE.rawBranches.count, BASELINE.rawBranches.what)
  check('pasteConsumers', audit.pasteConsumers.length, BASELINE.pasteConsumers.count, BASELINE.pasteConsumers.what)
  check('mouseConsumers', audit.mouseConsumers.length, BASELINE.mouseConsumers.count, BASELINE.mouseConsumers.what)
  check('knownGaps', audit.knownGaps.length, BASELINE.knownGaps.count, BASELINE.knownGaps.what)
  check('ownerReads.screen', audit.reads.total.screen, BASELINE.ownerReads.screen, BASELINE.ownerReads.what)
  check('ownerReads.dialog', audit.reads.total.dialog, BASELINE.ownerReads.dialog, BASELINE.ownerReads.what)

  const problems = rows.filter(row => row.over).map(row => `${row.id} ${row.count} > baseline ${row.baseline}`)
  problems.push(...writerProblems(audit.writes))

  if (JSON_OUT) {
    console.log(JSON.stringify({ rows, writers: audit.writes, reads: audit.reads, problems }, null, 2))
  } else {
    console.log('input ownership audit (AD-20, W-0)')
    console.log('')
    console.log('baselines (a count that grows fails; a count that shrinks can lower the baseline)')
    for (const row of rows) {
      const mark = row.over ? '✗' : row.count < row.baseline ? '↓' : '✓'
      console.log(`  ${mark} ${row.id.padEnd(18)} ${String(row.count).padStart(3)} (baseline ${row.baseline}) — ${row.what}`)
    }
    console.log('')
    console.log('dangerous writers (a handler that starts writing state it does not own)')
    for (const [method, kinds] of Object.entries(audit.writes)) {
      console.log(`  · ${method.padEnd(22)} ${kinds.join(', ')}`)
    }
    console.log('')
    console.log('ownership reads, per method (recorded debt, not a target this round)')
    for (const [method, counts] of Object.entries(audit.reads.perMethod)) {
      console.log(`  · ${method.padEnd(22)} screen ${counts.screen ?? 0} · dialog ${counts.dialog ?? 0}`)
    }
    console.log('')
    console.log('recorded debt')
    console.log(`  · dead Screen gate   ${audit.deadScreenGate.length} — ${BASELINE.deadScreenGate.what}`)
    for (const hit of audit.deadScreenGate) console.log(`      ${hit}`)
    console.log(`  · second router     ${audit.routers.length > 1 ? `${audit.routers.length - 1} extra (picker)` : 'none'}`)
    console.log(`  · paste consumers   ${audit.pasteConsumers.length} · mouse consumers ${audit.mouseConsumers.length}`)
    console.log('')
    console.log(problems.length === 0 ? 'OK: no input-ownership baseline was exceeded' : `FAIL: ${problems.join(' · ')}`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main()
