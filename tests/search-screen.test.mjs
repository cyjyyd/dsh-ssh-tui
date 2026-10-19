/**
 * W-5B — Search Screen. F1/F2 are the safety baseline; the Screen matrix is
 * added as the implementation lands.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import { feedbackText, tick } from './wait.mjs'

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
  return { tui, agent }
}

function seed(tui, texts, kind = 'assistant') {
  for (const text of texts) tui.rows.push({ kind, text })
}

const plainFrame = (tui, columns = 100, rows = 24) => tui.captureFrame(columns, rows)
  .map(line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd())

const searchState = tui => tui.screen?.search

function openFind(tui, command = '/find deploy') {
  tui.runCommand(command)
}

function workspaceSnapshot(tui) {
  return {
    input: tui.input,
    cursor: tui.cursor,
    historyIndex: tui.historyIndex,
    historyDraft: tui.historyDraft,
    focused: tui.focusedRow,
    scroll: tui.scrollOffset,
    rows: tui.rows.length,
  }
}

function openSetup(tui, field = '') {
  tui.onboarding = {
    step: 'key', providerType: 'official', providerId: '', baseUrl: '', key: '', models: [],
    catalogPresets: undefined, catalog: undefined, providerCursor: 0, saving: false,
    field, fieldCursor: field.length, resolve() {},
  }
  tui.openScreen({ kind: 'setup', title: 'setup', lines: [], offset: 0 })
}

// ── F1 · paste provenance ───────────────────────────────────────────────────

test('F1: a paste tail after its Screen closes does not reach the composer', async () => {
  const { tui } = makeTui()
  openSetup(tui)
  tui.handleData(Buffer.from('\x1b[200~secret'))
  tui.closeScreen()
  tui.handleData(Buffer.from('-tail\x1b[201~'))
  assert.equal(tui.input, '', 'the old Screen payload never becomes the composer draft')
  assert.equal(tui.screen, undefined)
})

test('F1: a paste tail after its Screen closes does not reach the next Screen', () => {
  const { tui } = makeTui()
  openSetup(tui, 'old')
  tui.handleData(Buffer.from('\x1b[200~secret'))
  tui.closeScreen()
  openSetup(tui, 'new')
  tui.handleData(Buffer.from('-tail\x1b[201~'))
  assert.equal(tui.onboarding?.field, 'new', 'Screen B does not receive Screen A’s paste')
  assert.equal(tui.input, '')
})

test('F1: a watchdog tail cannot use a Screen that replaced its owner', async () => {
  const { tui } = makeTui()
  tui.reader.options.pasteMarkerHoldMs = 25
  openSetup(tui, 'old')
  // A swallowed/incomplete close marker leaves a watchdog tail in the Reader.
  tui.handleData(Buffer.from('\x1b[200~secret\x1b[20'))
  tui.closeScreen()
  openSetup(tui, 'new')
  await tick(80)
  assert.equal(tui.onboarding?.field, 'new', 'the late watchdog payload stays out of Screen B')
  assert.equal(tui.input, '')
  assert.doesNotMatch(String(tui.onboarding?.field), /\[20|secret/)
})

test('F1: a normal setup paste and a split bracketed paste still work', () => {
  const { tui } = makeTui()
  openSetup(tui)
  tui.handleData(Buffer.from('\x1b[200~key'))
  tui.handleData(Buffer.from('-one\x1b[201~'))
  assert.equal(tui.onboarding?.field, 'key-one')
})

// ── F2 · structured matcher adapter ─────────────────────────────────────────

test('F2: category and query are adapted once through the existing matcher', async () => {
  const { searchRequestFor, searchRows } = await import('../lib/search-screen.js')
  const rows = [
    { kind: 'tool', callId: 't1', name: 'bash', title: 'deploy tool', summary: 'deploy now', output: '', args: '', status: 'ok' },
    { kind: 'assistant', text: 'deploy reply' },
    { kind: 'reasoning', text: 'deploy thought' },
  ]
  assert.deepEqual(searchRequestFor('/find tool deploy'), { category: 'tool', query: 'deploy' })
  assert.deepEqual(searchRows(rows, { category: 'tool', query: 'deploy' }).map(row => row.kind), ['tool'])
  assert.deepEqual(searchRows(rows, { category: 'reply', query: 'deploy' }).map(row => row.kind), ['assistant'])
  assert.deepEqual(searchRows(rows, { query: 'deploy' }).map(row => row.kind), ['tool', 'assistant', 'reasoning'])
  assert.equal(searchRows(rows, { category: 'tool', query: '' }).length, 1)
  assert.equal(searchRows(rows, { query: '' }).length, 2, 'empty query lists the searchable categories, not tools')
  assert.equal(searchRows(rows, { query: '   ' }).length, 2, 'whitespace is an empty query')
  assert.deepEqual(searchRequestFor('/find tools deploy'), { query: 'tools deploy' }, 'a longer word is not a category')
  assert.deepEqual(searchRequestFor('/find 回复 deploy'), { category: 'reply', query: 'deploy' })
})

test('F2: changing the query does not drop the fixed category', async () => {
  const { setSearchQuery, searchStateFor } = await import('../lib/search-screen.js')
  const rows = [
    { kind: 'tool', callId: 't1', name: 'bash', title: 'deploy tool', summary: '', output: '', args: '', status: 'ok' },
    { kind: 'assistant', text: 'deploy reply' },
  ]
  let state = searchStateFor({ rows, category: 'tool', query: 'deploy' })
  state = setSearchQuery(state, 'dep', rows)
  assert.equal(state.category, 'tool')
  assert.equal(state.hits.length, 1)
  assert.equal(state.hits[0].row.kind, 'tool')
})

// ── Search Screen matrix ────────────────────────────────────────────────────

test('S-P1: /find opens Search over the visible workspace without a transcript row', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'other', 'deploy two'])
  const before = workspaceSnapshot(tui)
  openFind(tui, '/find deploy')
  assert.equal(tui.screen?.kind, 'search')
  assert.equal(searchState(tui)?.query, 'deploy')
  assert.equal(searchState(tui)?.selected, 1)
  assert.equal(searchState(tui)?.hits.length, 2)
  assert.equal(tui.rows.length, before.rows, 'search writes no transcript row')
  assert.equal(tui.scrollOffset, before.scroll)
  assert.equal(tui.focusedRow, before.focused)
  assert.ok(tui.screen?.copyText?.includes('deploy two'))
})

test('S-P2: empty /find lists the searchable categories, not every row kind', () => {
  const { tui } = makeTui()
  tui.rows.push(
    { kind: 'assistant', text: 'reply' },
    { kind: 'reasoning', text: 'thought', expanded: true },
    { kind: 'tool', callId: 't', name: 'bash', title: 'tool', summary: '', output: '', args: '', status: 'ok', expanded: false },
  )
  openFind(tui, '/find')
  assert.equal(searchState(tui)?.query, '')
  assert.equal(searchState(tui)?.hits.length, 2)
  assert.deepEqual(searchState(tui)?.hits.map(hit => hit.row.kind), ['assistant', 'reasoning'])
})

test('S-P3: category stays fixed while the query is edited', () => {
  const { tui } = makeTui()
  tui.rows.push(
    { kind: 'tool', callId: 't', name: 'bash', title: 'deploy', summary: '', output: '', args: '', status: 'ok', expanded: false },
    { kind: 'assistant', text: 'deploy reply' },
  )
  openFind(tui, '/find tool deploy')
  assert.equal(searchState(tui)?.category, 'tool')
  assert.deepEqual(searchState(tui)?.hits.map(hit => hit.row.kind), ['tool'])
  tui.handleData(Buffer.from('x'))
  assert.equal(searchState(tui)?.category, 'tool')
  assert.equal(searchState(tui)?.query, 'deployx')
  assert.equal(searchState(tui)?.hits.length, 0)
})

test('S-P4: Search has its own field and caret, never the composer', () => {
  const { tui } = makeTui()
  openFind(tui, '/find')
  tui.input = 'draft'
  tui.cursor = 2
  tui.handleData(Buffer.from('部署🚀'))
  tui.handleData(Buffer.from('\x7f'))
  assert.equal(searchState(tui)?.query, '部署')
  assert.equal(tui.input, 'draft', 'the hidden composer keeps its text')
  assert.equal(tui.cursor, 2)
  assert.equal(tui.borrowedText, undefined)
})

test('S-P5: multiple search units in one read materialize correctly', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy'])
  openFind(tui, '/find')
  tui.handleData(Buffer.from('dep\tx'))
  assert.equal(searchState(tui)?.query, 'depx')
  assert.equal(searchState(tui)?.hits.length, 0, 'Tab is not completion in a Screen')
})

test('S-P6: result navigation is independent of history and workspace focus', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two', 'deploy three'])
  tui.history.push('old history')
  tui.historyIndex = 1
  openFind(tui, '/find deploy')
  const start = searchState(tui)?.selected
  tui.handleData(Buffer.from('\x1b[A'))
  assert.equal(searchState(tui)?.selected, start - 1)
  assert.equal(tui.historyIndex, 1)
  tui.handleData(Buffer.from('\x1bn'))
  assert.equal(searchState(tui)?.selected, 2, 'Alt+n advances from the selected row')
  tui.handleData(Buffer.from('\x1bn'))
  assert.equal(searchState(tui)?.selected, 0, 'Alt+n wraps from the last hit to the first')
  tui.handleData(Buffer.from('\x1bp'))
  assert.equal(searchState(tui)?.selected, 2, 'Alt+p wraps backwards')
  tui.handleData(Buffer.from('\x1b[6~'))
  assert.equal(typeof searchState(tui)?.selected, 'number')
})

test('S-P7: zero hits has a stable empty state and Enter reruns', () => {
  const { tui } = makeTui()
  seed(tui, ['nothing here'])
  openFind(tui, '/find absent')
  assert.equal(searchState(tui)?.hits.length, 0)
  assert.equal(searchState(tui)?.selected, -1)
  assert.match(plainFrame(tui, 100, 20).join('\n'), /没有匹配|未找到|no match/iu)
  tui.handleData(Buffer.from('\r'))
  assert.equal(searchState(tui)?.mode, 'list')
  assert.equal(searchState(tui)?.hits.length, 0)
})

test('S-P8/P9/P20: preview, copy and close never mutate workspace state', async () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  const before = workspaceSnapshot(tui)
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\r'))
  assert.equal(searchState(tui)?.mode, 'preview')
  tui.handleData(Buffer.from('\x1b[99;6u'))
  assert.ok(tui.copyYank.includes('deploy two'))
  assert.deepEqual(workspaceSnapshot(tui), before)
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  assert.equal(searchState(tui)?.mode, 'list')
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  assert.equal(tui.screen, undefined)
  assert.deepEqual(workspaceSnapshot(tui), before)
})

test('S-P10: narrow and Unicode Search rendering never overflows', () => {
  const { tui } = makeTui()
  tui.rows.push({ kind: 'assistant', text: '🚀 deploy 部署 ' + 'x'.repeat(300) })
  openFind(tui, '/find deploy')
  const frame = plainFrame(tui, 40, 20)
  for (const line of frame) assert.ok([...line].length <= 40, `row fits: ${JSON.stringify(line)}`)
  assert.ok(tui.lastPaintCursorColumn >= 1)
})

test('S-P11: Search state survives detach/reattach', async () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\x1b[A'))
  const before = { query: searchState(tui)?.query, selected: searchState(tui)?.selected, mode: searchState(tui)?.mode }
  tui.detachDisplay()
  await tick(10)
  tui.displayHost = { attached: true, pendingSend: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.attachRelayDisplay()
  await tick(10)
  assert.deepEqual(
    { query: searchState(tui)?.query, selected: searchState(tui)?.selected, mode: searchState(tui)?.mode },
    before,
  )
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
})

test('S-P12/P13: new rows refresh, removed rows migrate the selection', async () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find deploy')
  const selectedRow = searchState(tui)?.hits[searchState(tui)?.selected ?? -1]?.row
  tui.rows.push({ kind: 'assistant', text: 'deploy three' })
  tui.bumpTranscriptRevision()
  await tick(20)
  assert.equal(searchState(tui)?.hits.length, 3)
  assert.equal(searchState(tui)?.hits[searchState(tui)?.selected ?? -1]?.row, selectedRow, 'identity survives append')
  const removed = searchState(tui)?.hits[0]?.row
  if (removed !== undefined) tui.rows.splice(tui.rows.indexOf(removed), 1)
  tui.bumpTranscriptRevision()
  await tick(20)
  assert.equal(searchState(tui)?.hits.length, 2)
  assert.ok((searchState(tui)?.selected ?? -1) >= 0)
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
})

test('S-P14: line mode keeps textual /find and creates no Search Screen', () => {
  const { tui } = makeTui({ lineMode: true })
  seed(tui, ['deploy here'])
  openFind(tui, '/find deploy')
  assert.equal(tui.screen, undefined)
  assert.match(feedbackText(tui), /找到|found|搜索/iu)
})

test('S-P17: Alt+f at a report replaces it with Search', async () => {
  const { tui } = makeTui()
  tui.runCommand('/help')
  assert.equal(tui.screen?.kind, 'report')
  tui.handleData(Buffer.from('\x1bf'))
  assert.equal(tui.screen?.kind, 'search')
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  assert.equal(tui.screen, undefined)
})

test('S-P18: paste is text in Search, normalizes newlines and never submits', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy line'])
  openFind(tui, '/find')
  tui.handleData(Buffer.from('\x1b[200~deploy\nline\x1b[201~'))
  assert.equal(searchState(tui)?.query, 'deploy line')
  assert.equal(tui.rows.some(row => row.kind === 'user'), false)
  tui.handleData(Buffer.from('\x1b[999~'))
  assert.equal(searchState(tui)?.query, 'deploy line')
})

test('S-P19: resizing Search keeps the selection and fits the frame', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\x1b[A'))
  const selected = searchState(tui)?.selected
  const frame = plainFrame(tui, 40, 20)
  assert.equal(searchState(tui)?.selected, selected)
  for (const line of frame) assert.ok([...line].length <= 40)
})

// ── Negative ownership invariants ───────────────────────────────────────────

function paintedBytes(tui, columns = 100, rows = 24) {
  const written = []
  const real = tui.write.bind(tui)
  tui.write = chunk => { written.push(String(chunk)); real(chunk) }
  process.stdout.columns = columns
  process.stdout.rows = rows
  tui.paint()
  tui.write = real
  return written.join('')
}

test('S-N1: Search writes no transcript row', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy'])
  const rows = tui.rows.length
  openFind(tui, '/find deploy')
  assert.equal(tui.rows.length, rows)
})

test('S-N2: Search never writes the composer or history', () => {
  const { tui } = makeTui()
  openFind(tui, '/find')
  tui.input = 'composer'
  tui.cursor = 3
  tui.history.push('history')
  tui.historyIndex = 1
  tui.handleData(Buffer.from('search'))
  assert.equal(tui.input, 'composer')
  assert.equal(tui.cursor, 3)
  assert.equal(tui.historyIndex, 1)
})

test('S-N3: Search never writes a borrowed Surface field', () => {
  const { tui } = makeTui()
  openFind(tui, '/find')
  tui.borrowedText = { text: 'borrowed', cursor: 8 }
  tui.handleData(Buffer.from('abc'))
  assert.equal(tui.borrowedText.text, 'borrowed')
})

test('S-N4: Search never moves workspace focus or scroll', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  tui.scrollOffset = 4
  tui.focusedRow = tui.rows.find(row => row.kind === 'assistant')
  const before = workspaceSnapshot(tui)
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\x1b[A'))
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.scrollOffset, before.scroll)
  assert.equal(tui.focusedRow, before.focused)
})

test('S-N5: Search preview never opens a second Screen', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one'])
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.screen?.kind, 'search')
  assert.equal(tui.screen?.search?.mode, 'preview')
})

test('S-N6: replacing a report with Search leaves exactly one Screen', async () => {
  const { tui } = makeTui()
  tui.runCommand('/help')
  assert.equal(tui.screen?.kind, 'report')
  tui.handleData(Buffer.from('\x1bf'))
  assert.equal(tui.screen?.kind, 'search')
  tui.handleData(Buffer.from('\x1b'))
  await tick(140)
  assert.equal(tui.screen, undefined, 'Esc returns to the workspace, not the report stack')
})

test('S-N7: a tail after Search closes in the same read is discarded', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy'])
  openFind(tui, '/find deploy')
  const draft = tui.input
  tui.handleData(Buffer.from('\x03X'))
  assert.equal(tui.screen, undefined)
  assert.equal(tui.input, draft, 'X was addressed to the closed Search Screen')
})

test('S-N8: Alt+n/p never use workspace history or focus', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  tui.history.push('history')
  tui.historyIndex = 1
  tui.focusedRow = tui.rows.find(row => row.kind === 'assistant')
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\x1bn\x1bp'))
  assert.equal(tui.historyIndex, 1)
  assert.equal(tui.focusedRow, tui.rows.find(row => row.kind === 'assistant'))
})

test('S-N9: copy is read-only for workspace state', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one'])
  openFind(tui, '/find deploy')
  tui.input = 'draft'
  tui.cursor = 2
  tui.history.push('history')
  tui.historyIndex = 1
  tui.focusedRow = tui.rows.find(row => row.kind === 'assistant')
  const before = workspaceSnapshot(tui)
  tui.handleData(Buffer.from('\x1b[99;6u'))
  assert.ok(tui.copyYank.includes('deploy one'))
  assert.deepEqual(workspaceSnapshot(tui), before)
})

test('S-N10: paint never queries the transcript matcher', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy'])
  openFind(tui, '/find deploy')
  const original = tui.visibleRows.bind(tui)
  tui.visibleRows = () => { throw new Error('paint scanned the transcript') }
  try {
    tui.captureFrame(80, 20)
  } finally {
    tui.visibleRows = original
  }
})

test('S-N11: stale hits are reconciled after a trim', async () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find deploy')
  const removed = searchState(tui)?.hits[0]?.row
  if (removed !== undefined) tui.rows.splice(tui.rows.indexOf(removed), 1)
  tui.bumpTranscriptRevision()
  await tick(20)
  assert.equal(searchState(tui)?.hits.length, 1)
})

test('S-N12: Search field never reads or writes the composer field', () => {
  const { tui } = makeTui()
  openFind(tui, '/find')
  tui.input = 'hidden'
  tui.cursor = 6
  tui.handleData(Buffer.from('\x1b[D\x7f'))
  assert.equal(tui.input, 'hidden')
  assert.equal(tui.cursor, 6)
  assert.equal(searchState(tui)?.query, '')
})

test('S-N13: typing a query does not clear the screen', () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find')
  paintedBytes(tui)
  tui.handleData(Buffer.from('d'))
  const frame = paintedBytes(tui)
  assert.equal(/\u001b\[H\u001b\[J|\u001b\[2J|\u001b\[3J/u.test(frame), false)
})

test('S-N14: line mode never opens a Search Screen', () => {
  const { tui } = makeTui({ lineMode: true })
  seed(tui, ['deploy'])
  openFind(tui, '/find deploy')
  assert.equal(tui.screen, undefined)
  assert.ok(tui.rows.some(row => String(row.text).includes('找到') || String(row.text).includes('搜索')))
})

test('S-P6b: Alt+n/p reopen the last query after Search closes', async () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find deploy')
  tui.handleData(Buffer.from('\x1b[A'))
  const selected = searchState(tui)?.selected
  tui.handleData(Buffer.from('\x03'))
  await tick(20)
  assert.equal(tui.screen, undefined)
  tui.handleData(Buffer.from('\x1bn'))
  assert.equal(tui.screen?.kind, 'search')
  assert.equal(searchState(tui)?.query, 'deploy')
  assert.equal(searchState(tui)?.category, undefined)
  assert.notEqual(searchState(tui)?.selected, selected, 'the step moved from the remembered ordinal')
  tui.handleData(Buffer.from('\x03'))
})

test('S-P13b: an updated row that stops matching leaves the selected list valid', async () => {
  const { tui } = makeTui()
  seed(tui, ['deploy one', 'deploy two'])
  openFind(tui, '/find deploy')
  const selected = searchState(tui)?.hits[searchState(tui)?.selected ?? -1]?.row
  if (selected !== undefined) selected.text = 'rewritten without the needle'
  tui.bumpTranscriptRevision()
  await tick(20)
  assert.equal(searchState(tui)?.hits.length, 1)
  assert.ok((searchState(tui)?.selected ?? -1) >= 0)
  assert.equal(searchState(tui)?.hits[searchState(tui)?.selected ?? -1]?.row.text, 'deploy one')
})
