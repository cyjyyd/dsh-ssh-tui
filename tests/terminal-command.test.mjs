/**
 * W6B.G1 — `/terminal` as a real Screen and real line-mode row.
 *
 * These cases drive the same SshTui entry the composer uses and the same Screen
 * key adapter the reader uses. They assert ownership and provenance, not only
 * text: no transcript row, no second Screen, no hidden-draft edit and no
 * outbound probe byte.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { reportRowKind } from '../lib/screen.js'
import { SshTui } from '../lib/tui.js'
import { pushRow } from './wait.mjs'

setLocale('en')

function fixture(options = {}) {
  const ctx = {
    get: name => {
      if (name === 'sessionProjections') return { stateOf: () => ({ questions: { active: [], settled: [] } }) }
      if (name === 'commands') return { list: () => [] }
      if (name === 'appExit') return () => {}
      return undefined
    },
    on() { return () => {} },
  }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true, ...options })
  tui.displayHost = {
    attached: true,
    pendingBytes: () => 0,
    sendStdout() {},
    sendGoodbye() {},
    close: async () => {},
  }
  tui.write = () => {}
  for (let index = 0; index < 40; index += 1) {
    pushRow(tui, { kind: index % 2 === 0 ? 'assistant' : 'user', text: `row ${index}` })
  }
  return { tui, agent }
}

const plain = line => line.replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, '').trimEnd()
const screenRow = (screen, label) => screen.lines.find(line => line.text.startsWith(label))?.text ?? ''
const screenText = screen => screen.lines.map(line => line.text).join('\n')

test('framed /terminal is one report Screen and writes no transcript row', () => {
  const { tui } = fixture()
  tui.input = 'hidden draft'
  const before = tui.rows.length
  tui.runTerminalCommand()

  assert.equal(tui.rows.length, before, 'a report is not narrative')
  assert.equal(tui.screen.kind, 'report')
  assert.equal(tui.screen.report, 'terminal')
  assert.equal(tui.screen.title, 'terminal check')
  assert.ok(tui.screen.lines.length > 8)
  assert.equal(tui.screen.copyText, screenText(tui.screen), 'copyText is the canonical body')
  assert.match(tui.screen.copyText, /Host startup policy/)
  assert.match(tui.screen.copyText, /UNMEASURED/)
  assert.equal(tui.input, 'hidden draft')

  const frame = tui.captureFrame(100, 24).map(plain)
  assert.equal(frame.length, 24)
  assert.ok(frame.some(line => line.includes('terminal check')))
  assert.ok(frame.some(line => line.includes('Host startup policy')))
})

test('Esc, Ctrl+C and q close the report; the hidden draft survives', () => {
  for (const key of ['\x1b', '\x03', 'q']) {
    const { tui } = fixture()
    tui.input = 'keep me'
    tui.runTerminalCommand()
    tui.handleScreenInput(key, undefined)
    assert.equal(tui.screen, undefined, JSON.stringify(key))
    assert.equal(tui.input, 'keep me')
  }
})

test('PgUp/PgDn scroll the report body, not the transcript', () => {
  const { tui } = fixture()
  tui.runTerminalCommand()
  const previousRows = process.stdout.rows
  process.stdout.rows = 8
  try {
    const before = tui.screen.offset
    tui.handleScreenInput('\x1b[6~', undefined)
    assert.ok(tui.screen.offset > before, 'PgDn moves the Screen offset')
  } finally {
    process.stdout.rows = previousRows
  }
})

test('Alt+f replaces the report with Search, keeping existing semantics', () => {
  const { tui } = fixture()
  tui.runTerminalCommand()
  tui.handleScreenInput('\x1bf', undefined)
  assert.equal(tui.screen.kind, 'search')
})

test('line mode emits one diag row, never a Screen', () => {
  assert.equal(reportRowKind('terminal'), 'diag')
  const { tui } = fixture({ lineMode: true })
  tui.runTerminalCommand()
  assert.equal(tui.screen, undefined)
  const last = tui.rows.at(-1)
  assert.equal(last.kind, 'diag')
  assert.match(last.text, /terminal check/)
  assert.match(last.text, /UNMEASURED/)
  assert.doesNotMatch(last.text, /Esc close/)
})

test('8/12/20 rows and 40/100 columns keep the report inside the frame', () => {
  const { tui } = fixture()
  tui.runTerminalCommand()
  for (const [columns, rows] of [[40, 8], [100, 8], [40, 12], [100, 12], [40, 20], [100, 20]]) {
    const frame = tui.captureFrame(columns, rows).map(plain)
    assert.equal(frame.length, rows, `${columns}x${rows}`)
    assert.ok(frame.some(line => line.includes('terminal check')), `${columns}x${rows} title`)
    for (const line of frame) {
      assert.ok(line.length <= columns, `${columns}x${rows}: ${line.length} > ${columns}`)
    }
  }
  assert.equal(tui.screen.copyText, screenText(tui.screen))
})

test('ASCII mode removes the non-ASCII separators from report rows', () => {
  process.env.DSH_TUI_ASCII = '1'
  try {
    const { tui } = fixture()
    tui.runTerminalCommand()
    assert.doesNotMatch(screenText(tui.screen), /·|—|…/)
  } finally {
    delete process.env.DSH_TUI_ASCII
  }
})

test('explicit overrides are CONFIGURED and rejected tokens are not echoed', () => {
  process.env.DSH_TUI_TERM_CAPS = 'no-mouse bogus=secret'
  try {
    const { tui } = fixture()
    tui.runTerminalCommand()
    const text = screenText(tui.screen)
    assert.match(screenRow(tui.screen, 'Mouse / SGR'), /off \/ off/)
    assert.match(screenRow(tui.screen, 'Mouse / SGR'), /CONFIGURED/)
    assert.match(screenRow(tui.screen, 'Overrides'), /1\s+CONFIGURED/)
    assert.match(screenRow(tui.screen, 'Overrides'), /1 invalid token/)
    assert.doesNotMatch(text, /bogus|secret/)
  } finally {
    delete process.env.DSH_TUI_TERM_CAPS
  }
})

test('the footer cache is not evidence; replacement marks old facts STALE', () => {
  const { tui } = fixture()
  tui.terminalEvidence.attach()
  tui.terminalEvidence.observeRtt(40)
  tui.terminalEvidence.observeMetrics({ wide: true, reserve: false })
  tui.paintRttMs = 777
  tui.paintProbed = true

  tui.runTerminalCommand()
  assert.match(screenRow(tui.screen, 'Link RTT'), /40 ms/)
  assert.match(screenRow(tui.screen, 'Link RTT'), /\bMEASURED\b/)

  tui.terminalEvidence.attach()
  tui.runTerminalCommand()
  const text = screenText(tui.screen)
  assert.match(screenRow(tui.screen, 'Link RTT'), /UNMEASURED/)
  assert.match(screenRow(tui.screen, 'Previous RTT'), /40 ms/)
  assert.match(screenRow(tui.screen, 'Previous RTT'), /STALE/)
  assert.doesNotMatch(text, /777 ms/)
})

test('r only sets the fixed notice; it sends no probe bytes or terminal modes', () => {
  const { tui } = fixture()
  tui.runTerminalCommand()
  let sent = 0
  tui.displayHost.sendStdout = () => { sent += 1 }
  const written = []
  const realWrite = tui.write
  tui.write = chunk => { written.push(chunk); realWrite(chunk) }
  // `r` normally arrives through inbound FRAME_STDIN; this call is the routed
  // Screen owner after that legitimate keystroke, not a claim of zero input.
  tui.handleScreenInput('r', undefined)
  tui.paint()
  tui.write = realWrite

  assert.equal(tui.screen.notice, 'fresh recheck unavailable in this version')
  const output = written.join('')
  assert.doesNotMatch(output, /\u001b\[6n/u, 'no DSR/CPR request')
  assert.doesNotMatch(output, /\u001b\[\?(1000|1002|1006|2004|1049)h/u, 'no DECSET')
  assert.equal(sent, 0, 'no Host->Relay probe request')
})

test('detached and NO_GLYPH_PROBE reports stay truthful', () => {
  const { tui } = fixture()
  tui.runTerminalCommand()
  assert.match(screenText(tui.screen), /Current Relay: detached/)
  assert.match(screenRow(tui.screen, 'Link RTT'), /UNMEASURED/)

  process.env.DSH_TUI_NO_GLYPH_PROBE = '1'
  try {
    const second = fixture()
    second.tui.runTerminalCommand()
    const text = screenText(second.tui.screen)
    assert.match(screenRow(second.tui.screen, 'Ambiguous width'), /UNMEASURED/)
    assert.doesNotMatch(text, /disabled|DSH_TUI_NO_GLYPH_PROBE/)
  } finally {
    delete process.env.DSH_TUI_NO_GLYPH_PROBE
  }
})

test('a second /terminal replaces the report rather than stacking a Screen', () => {
  const { tui } = fixture()
  tui.runTerminalCommand()
  const first = tui.screen
  tui.runTerminalCommand()
  assert.equal(tui.screen.kind, 'report')
  assert.equal(tui.screen.report, 'terminal')
  assert.notEqual(tui.screen, first)
})
