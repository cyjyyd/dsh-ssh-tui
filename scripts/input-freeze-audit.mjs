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
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const TUI = 'src/tui.ts'
const PICKER = 'src/picker.ts'
const READER = 'src/input-reader.ts'
const PAINT = 'src/paint.ts'
const REGRESSION_TESTS = 'tests/input-ownership-regression.test.mjs'

/** Every `.ts` file under `src/`, repo-relative — a router can live in a new file. */
function sourceFiles() {
  const out = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      // POSIX separators on purpose: the ownership filters below compare against
      // `src/input-reader.ts`, and `relative` on Windows yields `src\input-reader.ts` —
      // which silently counted the Reader's own markers as "outside the Reader" and
      // failed the audit on the Windows leg (the file is built from `root + path`,
      // so a `/` works on both platforms).
      else if (path.endsWith('.ts')) out.push(relative(ROOT, path).replaceAll('\\', '/'))
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
  guards: { count: 2, sites: [TUI, PICKER], what: 'a `TerminalInputGuard` (bytes → keystrokes): the Reader\'s, and the picker\'s own (recorded debt, W-7)' },
  dispatchers: { count: 1, sites: [TUI], what: 'a second ownership dispatcher (F-1: one place reads screen/dialog to route)' },
  mouseParsers: { count: 1, sites: [TUI], what: 'a second SGR mouse parser (W-2 collapsed the two report sites into one matcher the adapters share)' },
  rawBranches: { count: 8, sites: [TUI], what: 'an owner comparing a raw byte sequence itself (F-5: the reader splits, the owner sees keys) — 13 at W-0, 8 after W-2 moved the shapes into the adapters' },
  ownerReads: { screen: 24, dialog: 54, what: 'reads of this.screen / this.dialog — 31/59 at W-0, 25/54 after W-2 moved the routing reads into the Router, 24 after W-3a deleted the Screen-only splitter; may shrink, not grow' },
  pasteConsumers: { count: 2, sites: [TUI], what: 'a paste entry point (handlePasteText · pasteIntoScreen — the framing moved into the Reader in W-1, which is why this baseline could drop)' },
  mouseConsumers: { count: 3, sites: [TUI], what: 'a mouse entry point (begin · extend · endMouseSelection; `handleMouseClick` is public and counted by hand below)' },
  knownGaps: { count: 0, sites: [REGRESSION_TESTS], what: 'a `{ todo: … }` marker in the regression suite — W-3a closed the last three (G-1, G-2/G-8, G-3); a new marker is a regression, not a plan' },
  deadScreenGate: { count: 0, sites: [TUI], what: 'the unreachable second Screen gate — removed by W-2 with the body it was buried in' },
  routers: { count: 1, sites: ['src/input-router.ts'], what: 'a second Router module (the one place an owner is decided)' },
  routerCallSites: { count: 3, sites: [TUI], what: 'a `this.router.route(` call site — the read in `route`, the per-unit dispatch, and the paste payload; a fourth would be a second dispatcher' },
  // Reader ownership (AD-21, W-1). `readers` + `rawRouters` is what `routers` counts:
  // the picker still runs its own guard, which is the debt W-7 names.
  readers: { count: 1, sites: [READER], what: 'a second Reader — bytes → frames happens in one place now' },
  rawRouters: { count: 1, sites: [PICKER], what: 'a `TerminalInputGuard` built outside the Reader (picker.ts: recorded debt, W-7)' },
  rawDecoders: { count: 4, sites: [READER], what: 'a UTF-8 decoder — the Reader, the picker\'s own reader, the probe pump and the relay\'s frame decoder; a *new* one is a second parser (M1)' },
  pasteFraming: { count: 0, sites: [READER], what: 'a bracketed-paste marker outside the Reader — the framing has one owner' },
  escapeAssembly: { count: 1, sites: [READER, PAINT], what: 'an `isEscapePrefix` call outside the Reader (paint.ts defines it, picker.ts assembles its own — recorded debt, W-7)' },
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
  'extendMouseSelection', 'endMouseSelection', 'scrollWorkspace', 'stepSearch', 'runKeyAction',
  // W-2: the Router's call sites and the four owner adapters. They are here so a future
  // change that lets an adapter write state it does not own shows up as a new pair.
  'route', 'dispatch', 'dispatchWith', 'dispatchPaste', 'observe',
  'ownerScreen', 'ownerSurface', 'ownerComposer', 'ownerWorkspace',
  'composerUnit', 'arrowHistory', 'mouseGesture', 'repaintNow',
]

/**
 * A repo-relative path with POSIX separators.
 *
 * `relative` spells paths the platform's way (`src\input-reader.ts` on Windows)
 * while every comparison here is written against `src/input-reader.ts`. The first
 * version of the ownership filters compared the raw value, so on the Windows leg
 * the Reader's own markers counted as "outside the Reader" and the audit failed
 * with `pasteFraming 5 > 0`. Normalising at the boundary — for reading *and* for
 * comparing — is what makes the check platform-independent.
 */
const posix = path => path.split(sep).join('/')

const read = path => readFileSync(`${ROOT}${posix(path)}`, 'utf8')

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
  const guards = find(ALL_SOURCES, /new TerminalInputGuard\(/u)
  const dispatchers = find(ALL_SOURCES, /private handleInputText\(/u)
  const mouseParsers = find(ALL_SOURCES, /const (?:sgr|sgrMouse) = \/\^\\x1b\\\[</u)
  const rawBranches = find(ALL_SOURCES, /combined === '\\x1b/u)
  const pasteConsumers = find(ALL_SOURCES, /private (?:handlePasteText|pasteIntoScreen|processPasteChunk)\(/u)
  const mouseConsumers = find(ALL_SOURCES, /private (?:beginMouseSelection|extendMouseSelection|endMouseSelection)\(/u)
  // `, { todo: '…' }` — the option syntax, not the prose that explains it.
  const knownGaps = find([REGRESSION_TESTS], /,\s*\{ todo: '/u)
  const deadScreenGate = find([TUI], /A Screen owns the keyboard here too/u, { comments: true })
  const readers = find(ALL_SOURCES, /new InputReader\(/u)
  const routerModules = find(ALL_SOURCES, /export class InputRouter\b/u)
  const routerCallSites = find(ALL_SOURCES, /this\.router\.route\(/u)
  const rawRouters = find(ALL_SOURCES.filter(path => posix(path) !== READER), /new TerminalInputGuard\(/u)
  const rawDecoders = find(ALL_SOURCES, /new StringDecoder\(/u)
  const pasteFraming = find(ALL_SOURCES.filter(path => posix(path) !== READER), /\\x1b\[20[01]~/u)
  const escapeAssembly = find(
    ALL_SOURCES.filter(path => posix(path) !== READER && posix(path) !== PAINT),
    /isEscapePrefix\(/u,
  )
  const writes = writerMap()
  const reads = ownerReads()
  return {
    guards, dispatchers, mouseParsers, rawBranches, pasteConsumers, mouseConsumers, knownGaps, deadScreenGate,
    readers, rawRouters, rawDecoders, pasteFraming, escapeAssembly,
    routerModules, routerCallSites,
    writes, reads,
  }
}

const JSON_OUT = process.argv.slice(2).includes('--json')
const BASELINE_WRITERS = {
  // Recorded from the tree at W-0, re-keyed at W-2 because the refactors moved the
  // writes between methods without changing which writes exist:
  //   `handleInputText`/`handleChar` (W-0) → `route`/`ownerComposer`/`composerUnit` (W-2)
  // — the Alt chord's `/find ` seed, and the composer's own editing keys. `composer
  // draft` here means the handler *is* the composer's editor; the pair that must never
  // appear is a handler that does not own the composer writing it — the shape of G-10.
  route: ['composer draft'],
  ownerComposer: ['composer draft'],
  composerUnit: ['composer draft'],
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
  check('guards', audit.guards.length, BASELINE.guards.count, BASELINE.guards.what)
  check('dispatchers', audit.dispatchers.length, BASELINE.dispatchers.count, BASELINE.dispatchers.what)
  check('mouseParsers', audit.mouseParsers.length, BASELINE.mouseParsers.count, BASELINE.mouseParsers.what)
  check('rawBranches', audit.rawBranches.length, BASELINE.rawBranches.count, BASELINE.rawBranches.what)
  check('pasteConsumers', audit.pasteConsumers.length, BASELINE.pasteConsumers.count, BASELINE.pasteConsumers.what)
  check('mouseConsumers', audit.mouseConsumers.length, BASELINE.mouseConsumers.count, BASELINE.mouseConsumers.what)
  check('knownGaps', audit.knownGaps.length, BASELINE.knownGaps.count, BASELINE.knownGaps.what)
  check('readers', audit.readers.length, BASELINE.readers.count, BASELINE.readers.what)
  check('rawRouters', audit.rawRouters.length, BASELINE.rawRouters.count, BASELINE.rawRouters.what)
  check('rawDecoders', audit.rawDecoders.length, BASELINE.rawDecoders.count, BASELINE.rawDecoders.what)
  check('pasteFraming', audit.pasteFraming.length, BASELINE.pasteFraming.count, BASELINE.pasteFraming.what)
  check('escapeAssembly', audit.escapeAssembly.length, BASELINE.escapeAssembly.count, BASELINE.escapeAssembly.what)
  check('routers', audit.routerModules.length, BASELINE.routers.count, BASELINE.routers.what)
  check('routerCallSites', audit.routerCallSites.length, BASELINE.routerCallSites.count, BASELINE.routerCallSites.what)
  check('deadScreenGate', audit.deadScreenGate.length, BASELINE.deadScreenGate.count, BASELINE.deadScreenGate.what)
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
    console.log(`  · second router     ${audit.rawRouters.length > 0 ? `${audit.rawRouters.length} outside the Reader (picker)` : 'none'}`)
    for (const hit of audit.escapeAssembly) console.log(`      escape assembly outside the Reader: ${hit}`)
    for (const hit of audit.rawDecoders) console.log(`      decoder: ${hit}`)
    console.log(`  · paste consumers   ${audit.pasteConsumers.length} · mouse consumers ${audit.mouseConsumers.length}`)
    console.log('')
    console.log(problems.length === 0 ? 'OK: no input-ownership baseline was exceeded' : `FAIL: ${problems.join(' · ')}`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
}

// `resolve`, not a raw compare: on Windows `argv[1]` and `fileURLToPath` only
// agree after normalisation, and a guard that silently fails would make
// `npm run freeze:input` a no-op that exits 0.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
