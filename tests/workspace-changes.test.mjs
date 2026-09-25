import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { lineModeLines } from '../lib/line-mode.js'
import { copyTextFromRow } from '../lib/copy-text.js'
import {
  changesFileLine,
  changesHeader,
  changesRemainderLine,
  changesSummaryVisible,
  renderChangesDiff,
  workspaceChangesOf,
} from '../lib/workspace-changes.js'
import { SshTui } from '../lib/tui.js'

/**
 * The per-turn changes card, read from the Host's `workspaceChanges` service.
 *
 * The service ships with dsh 0.1.7 and is absent on 0.1.5, and what it serves
 * dies with the Session: a restarted Host replaying an old log gets nothing
 * back. The rules under test are the ones that follow from that — an absent or
 * unreadable summary draws no card, a later event for the same turn replaces
 * the card it already drew, and the diff on screen is the one the service
 * computed rather than one recomputed here.
 */
setLocale('zh')

const summary = (over = {}) => ({
  turn: 3,
  cwd: '/work',
  files: [
    { path: 'src/tui.ts', display: 'src/tui.ts', added: 30, deleted: 5 },
    { path: 'README.md', display: 'README.md', added: 12, deleted: 2 },
    { path: 'assets/logo.png', display: 'assets/logo.png', added: 0, deleted: 0, binary: true },
  ],
  total: 3,
  added: 42,
  deleted: 7,
  ...over,
})

test('a summary renders its header, and a file its counts or its label', () => {
  assert.equal(changesHeader(summary()), '本轮改动 · 3 个文件  +42 -7')
  assert.equal(changesFileLine(summary().files[0]), 'src/tui.ts  +30 -5')
  assert.equal(changesFileLine(summary().files[2]), 'assets/logo.png  二进制', 'a binary file has no counts')
  assert.equal(
    changesFileLine({ path: 'dump.bin', display: 'dump.bin', added: 0, deleted: 0, oversized: true }),
    'dump.bin  过大',
  )
})

test('files the cap left out are counted, and only then', () => {
  assert.equal(changesRemainderLine(summary({ total: 5 })), '另有 2 个未列出')
  assert.equal(changesRemainderLine(summary()), undefined)
})

test('a turn that changed nothing is not worth a card', () => {
  assert.equal(changesSummaryVisible(summary()), true)
  assert.equal(changesSummaryVisible(summary({ total: 0, files: [] })), false)
  assert.equal(changesSummaryVisible(summary({ files: [] })), false, 'a count without files has nothing to show')
})

test('only an object with both methods counts as the service', () => {
  const service = { summary() {}, diff() {} }
  assert.equal(workspaceChangesOf({ get: name => (name === 'workspaceChanges' ? service : undefined) }), service)
  assert.equal(workspaceChangesOf({ get: () => undefined }), undefined, 'a 0.1.5 host has no such service')
  assert.equal(workspaceChangesOf({ get: () => ({ summary() {} }) }), undefined, 'half a service is not one')
  assert.equal(workspaceChangesOf({}), undefined)
  assert.equal(workspaceChangesOf({ get: () => null }), undefined)
})

test('a text diff maps its prefixes, and a coarse one says so first', () => {
  const lines = renderChangesDiff({
    kind: 'text',
    path: 'a.ts',
    display: 'a.ts',
    before: true,
    after: true,
    coarse: true,
    hunks: [{
      oldStart: 12,
      oldLines: 3,
      newStart: 12,
      newLines: 4,
      lines: [' context', '-removed', '+added'],
    }],
  })
  assert.deepEqual(lines.map(line => [line.kind, line.text]), [
    ['tool-result', '改动过大，按整文件显示'],
    ['diff-path', '@@ -12,3 +12,4 @@'],
    ['tool-result', ' context'],
    ['diff-del', '-removed'],
    ['diff-add', '+added'],
  ])
})

test('a one-line hunk prints its start without a count', () => {
  const lines = renderChangesDiff({
    kind: 'text', path: 'a.ts', display: 'a.ts', before: true, after: true, coarse: false,
    hunks: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1, lines: [' same'] }],
  })
  assert.equal(lines[0].text, '@@ -4 +4 @@')
})

test('a binary or oversized file explains itself in one line', () => {
  assert.deepEqual(renderChangesDiff({ kind: 'binary', path: 'a', display: 'a' }), [
    { kind: 'tool-result', text: '二进制文件，没有可显示的内容' },
  ])
  assert.deepEqual(renderChangesDiff({ kind: 'oversized', path: 'a', display: 'a' }), [
    { kind: 'tool-result', text: '文件过大，没有可显示的内容' },
  ])
  assert.deepEqual(renderChangesDiff(undefined), [])
})

test('line mode and /copy carry the card as text', () => {
  const row = {
    kind: 'changes', turn: 3, seq: 1, sessionId: 's',
    header: '本轮改动 · 1 个文件  +1 -0', files: ['a.ts  +1 -0'], expanded: false,
  }
  assert.deepEqual(lineModeLines(row), ['本轮改动 · 1 个文件  +1 -0'])
  assert.equal(copyTextFromRow(row), '本轮改动 · 1 个文件  +1 -0\na.ts  +1 -0')
})

/** A TUI whose Host may or may not serve workspace changes. */
function changesTui(service) {
  const services = service === undefined ? {} : { workspaceChanges: service }
  const ctx = { get: name => services[name], on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  return { tui, agent }
}

const send = (tui, agent, seq, data) => tui.handleSessionEvent(agent.session, {
  type: 'workspace/changes', seq, time: Date.now(), data,
})

const cards = tui => tui.rows.filter(row => row.kind === 'changes')

const painted = tui => tui.captureFrame(80, 24).map(line => line.replace(/\u001b\[[0-9;]*m/gu, '')).join('\n')

test('an event with a summary draws one card, collapsed', () => {
  const recorded = summary()
  const { tui, agent } = changesTui({ summary: () => recorded, diff: async () => undefined })
  send(tui, agent, 7, { turn: 3 })

  assert.equal(cards(tui).length, 1)
  const card = cards(tui)[0]
  assert.equal(card.turn, 3)
  assert.equal(card.seq, 7, 'the card remembers the event sequence, which is what diff() is served by')
  assert.equal(card.expanded, false)
  assert.deepEqual(card.files, ['src/tui.ts  +30 -5', 'README.md  +12 -2', 'assets/logo.png  二进制'])

  const frame = painted(tui)
  assert.match(frame, /本轮改动 · 3 个文件 {2}\+42 -7/)
  assert.doesNotMatch(frame, /src\/tui\.ts/, 'a collapsed card shows the header only')
})

test('a second event for the same turn updates the card instead of adding one', () => {
  const first = summary()
  const second = summary({
    files: [{ path: 'src/tui.ts', display: 'src/tui.ts', added: 40, deleted: 5 }],
    total: 1, added: 40, deleted: 5,
  })
  let current = first
  const { tui, agent } = changesTui({ summary: () => current, diff: async () => undefined })
  send(tui, agent, 7, { turn: 3 })
  const card = cards(tui)[0]
  card.expanded = true
  current = second
  send(tui, agent, 9, { turn: 3 })

  assert.equal(cards(tui).length, 1, 'the turn still has exactly one card')
  assert.equal(cards(tui)[0], card, 'and it is the same card, so its place does not move')
  assert.equal(card.seq, 9)
  assert.equal(card.expanded, true, 'reading the card is not interrupted by the update')
  assert.deepEqual(card.files, ['src/tui.ts  +40 -5'])
})

test('a different turn gets its own card', () => {
  let turn = 3
  const { tui, agent } = changesTui({ summary: () => summary({ turn }), diff: async () => undefined })
  send(tui, agent, 7, { turn: 3 })
  turn = 4
  send(tui, agent, 8, { turn: 4 })
  assert.deepEqual(cards(tui).map(card => card.turn), [3, 4])
})

test('no service, an unreadable summary, or an empty turn all draw nothing', () => {
  const bare = changesTui(undefined)
  send(bare.tui, bare.agent, 1, { turn: 1 })
  assert.equal(cards(bare.tui).length, 0)

  const gone = changesTui({ summary: () => undefined, diff: async () => undefined })
  send(gone.tui, gone.agent, 1, { turn: 1 })
  assert.equal(cards(gone.tui).length, 0, 'a summary the restart ate is not an empty card')

  const quiet = changesTui({ summary: () => summary({ total: 0, files: [] }), diff: async () => undefined })
  send(quiet.tui, quiet.agent, 1, { turn: 1 })
  assert.equal(cards(quiet.tui).length, 0)

  const half = changesTui({ summary: () => summary() })
  send(half.tui, half.agent, 1, { turn: 1 })
  assert.equal(cards(half.tui).length, 0, 'a service without diff() is not usable')
})

test('the summary is read for the event sequence, not the turn', () => {
  const seen = []
  const { tui, agent } = changesTui({
    summary: (_sessionId, seq) => {
      seen.push(seq)
      return summary()
    },
    diff: async () => undefined,
  })
  send(tui, agent, 11, { turn: 3 })
  assert.deepEqual(seen, [11])
})

test('Enter on the open card asks the service for that file and shows its diff', async () => {
  const asked = []
  const diff = {
    kind: 'text', path: 'src/tui.ts', display: 'src/tui.ts', before: true, after: true, coarse: false,
    hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old', '+new'] }],
  }
  const { tui, agent } = changesTui({
    summary: () => summary(),
    diff: async (_sessionId, seq, index) => {
      asked.push([seq, index])
      return diff
    },
  })
  send(tui, agent, 7, { turn: 3 })
  const card = cards(tui)[0]

  tui.toggleCard(card)
  assert.equal(card.expanded, true, 'the first Enter opens the file list')
  assert.equal(tui.dialog, undefined)
  assert.match(painted(tui), /src\/tui\.ts {2}\+30 -5/)

  tui.toggleCard(card)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(asked, [[7, 0]], 'one file, so the only one is opened')
  assert.equal(tui.dialog?.kind, 'inspect')
  assert.deepEqual(
    tui.dialog.lines.map(line => [line.kind, line.text]),
    [['diff-path', '@@ -1 +1 @@'], ['diff-del', '-old'], ['diff-add', '+new']],
  )
})

test('a diff the service no longer has says so instead of opening an empty view', async () => {
  const { tui, agent } = changesTui({ summary: () => summary(), diff: async () => undefined })
  send(tui, agent, 7, { turn: 3 })
  const card = cards(tui)[0]
  card.expanded = true
  tui.toggleCard(card)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tui.dialog.lines[0].text, '这份改动已经不在了（会话重启后不再保留）')
})
