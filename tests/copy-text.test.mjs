import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
import { copyTextFromRow, copyTextFromTranscript } from '../lib/copy-text.js'
import { SshTui } from '../lib/tui.js'

setLocale('zh')

test('copyTextFromTranscript prefers the focused card then the latest reply', () => {
  const assistant = { kind: 'assistant', text: '最终回复正文' }
  const tool = {
    kind: 'tool', callId: 'c1', name: 'bash', args: '{}', output: 'ok\n',
    title: 'bash', summary: 'git status', command: 'git status', expanded: false,
  }
  assert.equal(copyTextFromRow(assistant), '最终回复正文')
  assert.equal(copyTextFromRow(tool), 'git status\ngit status\nok')
  assert.deepEqual(copyTextFromTranscript([assistant], tool), { text: 'git status\ngit status\nok', source: 'focused' })
  assert.deepEqual(copyTextFromTranscript([assistant], null), { text: '最终回复正文', source: 'assistant' })
  assert.equal(copyTextFromTranscript([], null).source, 'empty')
})

test('/copy writes OSC 52 and a workspace notice', () => {
  const writes = []
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  // These tests are about the copy plumbing, not the terminal in front of the
  // runner: on a Windows or `TERM=dumb` host the capability table would add the
  // "this terminal may ignore OSC 52" line and the notice asserted below would
  // no longer be the newest row. Declare the clipboard as working instead.
  const previousCaps = process.env.DSH_TUI_TERM_CAPS
  process.env.DSH_TUI_TERM_CAPS = 'osc52'
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.write = (chunk) => { writes.push(String(chunk)) }
  tui.rows.push({ kind: 'assistant', text: '可复制的回复' })
  tui.focusedRow = tui.rows[0]
  tui.runCommand('/copy')
  assert.ok(tui.lastCopiedText.includes('可复制的回复'))
  assert.ok(writes.some(chunk => chunk.includes('\x1b]52;c;') && chunk.endsWith('\x1b\\')))
  assert.equal(tui.focusedRow, null)
  const notice = tui.rows.findLast(row => row.kind === 'system')?.text ?? ''
  assert.match(String(notice), /已复制/)
  assert.match(String(notice), /最近回复/)
  tui.handleChar('a')
  assert.equal(tui.input, 'a')
  if (previousCaps === undefined) delete process.env.DSH_TUI_TERM_CAPS
  else process.env.DSH_TUI_TERM_CAPS = previousCaps
})

test('clicking an OSC 8 column copies the URL instead of toggling a card', () => {
  const previous = process.env.DSH_TUI_OSC8
  const previousCaps = process.env.DSH_TUI_TERM_CAPS
  process.env.DSH_TUI_OSC8 = '1'
  // Same reason as above: the OSC 52 notice must not displace the URL notice.
  process.env.DSH_TUI_TERM_CAPS = 'osc52'
  const writes = []
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
  tui.write = (chunk) => { writes.push(String(chunk)) }
  tui.rows.push({ kind: 'assistant', text: 'see [docs](https://example.com/click) please' })
  try {
    tui.captureFrame(80, 24)
    const entry = [...tui.linkHitsByRow.entries()][0]
    assert.ok(entry, 'painted assistant line should carry an OSC 8 hit')
    const [y, hits] = entry
    tui.handleMouseClick(y, hits[0].startCol + 1)
    assert.equal(tui.lastCopiedText, 'https://example.com/click')
    const notice = tui.rows.findLast(row => row.kind === 'system')?.text ?? ''
    assert.match(String(notice), /example.com\/click/)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_OSC8
    else process.env.DSH_TUI_OSC8 = previous
    if (previousCaps === undefined) delete process.env.DSH_TUI_TERM_CAPS
    else process.env.DSH_TUI_TERM_CAPS = previousCaps
  }
})

test('the clipboard caveat is said once per session, not after every copy', () => {
  // The caveat is now shown on every terminal the table does not promise OSC 52
  // for — which includes VTE (GNOME/XFCE), the most common Linux desktop
  // terminal. Once per session is what keeps that honest without becoming noise,
  // and rows are the only place that can be asserted: the painted byte stream
  // repeats the transcript on every repaint.
  //
  // It stays quiet over SSH, where the write reaches the local terminal rather
  // than the remote one the table describes. This case is about a local session,
  // so the SSH markers are cleared — the suite also runs on a jump host.
  const previousCaps = process.env.DSH_TUI_TERM_CAPS
  const sshKeys = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']
  const previousSsh = sshKeys.map(key => [key, process.env[key]])
  process.env.DSH_TUI_TERM_CAPS = 'no-osc52'
  for (const key of sshKeys) delete process.env[key]
  try {
    const ctx = { get: () => undefined, on() { return () => {} } }
    const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
    const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
    tui.write = () => {}
    tui.rows.push({ kind: 'assistant', text: '可复制的回复' })
    tui.focusedRow = tui.rows[0]

    const caveats = () => tui.rows.filter(row => row.kind === 'system' && String(row.text).includes('OSC 52')).length
    tui.runCommand('/copy')
    assert.equal(caveats(), 1, 'the first copy explains why the clipboard may be empty')
    tui.rows.push({ kind: 'assistant', text: '第二条' })
    tui.focusedRow = tui.rows.at(-1)
    tui.runCommand('/copy')
    assert.equal(caveats(), 1, 'and the second copy does not repeat it')
  } finally {
    if (previousCaps === undefined) delete process.env.DSH_TUI_TERM_CAPS
    else process.env.DSH_TUI_TERM_CAPS = previousCaps
    for (const [key, value] of previousSsh) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('a relayed local window still warns, because the table described that terminal', () => {
  // `applyProbedRtt` pins `paintLink` to `'ssh'` for every relayed frame, and the
  // launcher relays a purely local window too. Gating the caveat on that field
  // therefore silenced it locally as well — which the terminal probe caught on
  // seven profiles (VTE, Konsole 23.08, tmux, screen, the Linux console, dumb).
  // The gate is the SSH environment instead, so this case keeps its warning.
  const previousSsh = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY'].map(key => [key, process.env[key]])
  const previousCaps = process.env.DSH_TUI_TERM_CAPS
  for (const [key] of previousSsh) delete process.env[key]
  process.env.DSH_TUI_TERM_CAPS = 'no-osc52'
  try {
    const ctx = { get: () => undefined, on() { return () => {} } }
    const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
    const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
    tui.write = () => {}
    // What the launcher's RTT report does to a local window.
    tui.applyProbedRtt(40)
    assert.equal(tui.paintLink, 'ssh', 'the relayed frame reads as an ssh link')
    tui.rows.push({ kind: 'assistant', text: '可复制的回复' })
    tui.focusedRow = tui.rows[0]
    tui.runCommand('/copy')
    const caveats = tui.rows.filter(row => row.kind === 'system' && String(row.text).includes('OSC 52'))
    assert.equal(caveats.length, 1, 'this terminal really cannot take the write, so the caveat is not a lie')
  } finally {
    for (const [key, value] of previousSsh) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (previousCaps === undefined) delete process.env.DSH_TUI_TERM_CAPS
    else process.env.DSH_TUI_TERM_CAPS = previousCaps
  }
})

test('an SSH session does not warn about a clipboard write that reached the local terminal', () => {
  // The capability table describes the remote tty, which over SSH is usually a
  // bare console that has never heard of OSC 52. The bytes are written to the
  // local terminal, though, and that is the one the user pastes from — so the
  // copy works and the warning is the part that is wrong. A session whose link
  // was probed as SSH must not say it.
  const previousSsh = process.env.SSH_CONNECTION
  const previousCaps = process.env.DSH_TUI_TERM_CAPS
  process.env.SSH_CONNECTION = '203.0.113.4 53210 203.0.113.9 22'
  process.env.DSH_TUI_TERM_CAPS = 'no-osc52'
  try {
    const ctx = { get: () => undefined, on() { return () => {} } }
    const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
    const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
    tui.write = () => {}
    tui.rows.push({ kind: 'assistant', text: '可复制的回复' })
    tui.focusedRow = tui.rows[0]
    tui.runCommand('/copy')
    const caveats = tui.rows.filter(row => row.kind === 'system' && String(row.text).includes('OSC 52'))
    assert.equal(caveats.length, 0, 'the copy landed on the local terminal, so there is nothing to warn about')
    assert.equal(tui.lastCopiedText.includes('可复制的回复'), true, 'and the copy itself still happens')
  } finally {
    if (previousSsh === undefined) delete process.env.SSH_CONNECTION
    else process.env.SSH_CONNECTION = previousSsh
    if (previousCaps === undefined) delete process.env.DSH_TUI_TERM_CAPS
    else process.env.DSH_TUI_TERM_CAPS = previousCaps
  }
})
