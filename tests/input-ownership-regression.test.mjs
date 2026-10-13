/**
 * Input ownership regression net (AD-20, W-0).
 *
 * The contract is `docs/decisions/input-ownership.md`: one event has exactly one
 * owner, and an event carries **one key** whatever the terminal packed into the
 * read. This file is the executable half of that — the static half is
 * `scripts/input-freeze-audit.mjs`, and `npm run freeze:input` runs it.
 *
 * Two rules for everything here:
 *
 *   1. **Every event goes through the real input path.** `tui.handleData(bytes)`
 *      is what `process.stdin` and the Host relay call, so the decoder, the reply
 *      filter, the escape hold, the paste markers and the routing all run. No test
 *      in this file calls `handleSetupKey`, `handleChar`, `handleScreenInput` or
 *      `copyPlainText` directly, and none of them sets an owner's state to make an
 *      assertion pass — a case that needed that would be pinning the router, not
 *      the contract.
 *   2. **A gap is written down, not hidden.** Gaps the audit found are asserted the
 *      way they *should* behave and marked `{ todo: … }`: they run, they fail, and
 *      node reports them as todo instead of failing the suite. W-1/W-3 turn each
 *      one green — and the marker is what `npm run freeze:input` ratchets, so the
 *      count can only go down.
 *
 * | gap | what | state |
 * |---|---|---|
 * | G-1 | several page keys in one read (composer path keeps whole reads) | todo → W-3 |
 * | G-2/G-8 | a rebound key sent twice in one read | todo → W-3 |
 * | G-3 | an Alt chord batched with the next character | todo → W-3 |
 * | G-4 | Ctrl+V (`0x16`) is nobody's | ignore, pinned |
 * | G-5 | mouse inside a Screen (wheel only; clicks and drags refused) | policy, pinned |
 * | G-6 | a second router, a dead Screen gate | recorded by the audit |
 * | G-7 | focus sequences (`CSI I` / `CSI O`) | ignore, pinned |
 * | G-9 | the two hold windows (30 ms replies / 60 ms ESC) | recorded in the contract |
 * | G-10 | the copy path wrote the composer's draft | **fixed in W-0, pinned here** |
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { setLocale } from '../lib/i18n/index.js'
import { displayWidth, stripAnsi } from '../lib/term-text.js'
import { terminalCapabilities } from '../lib/terminal-caps.js'
import { SshTui } from '../lib/tui.js'
import { pushRow, waitForDialog } from './wait.mjs'

setLocale('zh')

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every capability on, so a mouse or link case asserts the path, not the runner's TERM. */
const fullTerminal = () => terminalCapabilities({
  env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  platform: 'linux',
})

function fixture({ keys, caps, color = false } = {}) {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, {
    sessionId: 'main-session',
    color,
    headlessDisplay: true,
    ...(keys === undefined ? {} : { keys }),
    ...(caps === undefined ? {} : { terminalCaps: caps }),
  })
  tui.displayHost = { attached: true, pendingBytes: () => 0, sendStdout() {}, sendGoodbye() {}, close: async () => {} }
  tui.write = () => {}
  return tui
}

/** What a reader had typed. Set as a *fixture*, never as an assertion shortcut. */
const draft = (tui, text = '我打了一半的消息', cursor = 3) => {
  tui.input = text
  tui.cursor = cursor
}

/** A transcript long enough that a page key has somewhere to go. */
const transcript = (tui, count = 120, kind = 'assistant') => {
  for (let index = 0; index < count; index += 1) pushRow(tui, { kind, text: `第 ${index} 行` })
}

const snapshot = tui => ({
  input: tui.input,
  cursor: tui.cursor,
  historyIndex: tui.historyIndex,
  folded: tui.inputFolded,
  scroll: tui.scrollOffset,
  screen: tui.screen?.kind ?? '-',
  screenOffset: tui.screen?.offset ?? null,
  dialog: tui.dialog?.kind ?? '-',
  focused: tui.focusedRow?.kind ?? null,
  rows: tui.rows.length,
  yank: tui.copyYank ?? null,
})

/** Everything a case did not ask to change must be exactly what it was. */
function assertUnchanged(tui, before, where, except = []) {
  const after = snapshot(tui)
  for (const key of Object.keys(before)) {
    if (except.includes(key)) continue
    assert.deepEqual(after[key], before[key], `${where}: ${key} must not change`)
  }
}

// ── G-1 · several page keys in one read ─────────────────────────────────────

test('G-1: a page key scrolls a page, in one read or in two', () => {
  // The baseline the coalescing case is measured against: what one page key does
  // when the terminal sends it on its own, and what two of them do when they arrive
  // separately. Both are true today.
  const single = fixture()
  transcript(single)
  draft(single)
  const before = snapshot(single)
  single.handleData(Buffer.from('\x1b[5~'))
  const page = single.scrollOffset - before.scroll
  assert.ok(page > 0, `PgUp scrolls back by a page (${page} lines)`)
  assertUnchanged(single, before, 'PgUp alone', ['scroll'])

  const twice = fixture()
  transcript(twice)
  draft(twice)
  const start = twice.scrollOffset
  twice.handleData(Buffer.from('\x1b[5~'))
  twice.handleData(Buffer.from('\x1b[5~'))
  assert.equal(twice.scrollOffset - start, page * 2, 'two PgUps in two reads scroll two pages')

  const back = fixture()
  transcript(back)
  back.handleData(Buffer.from('\x1b[5~'))
  back.handleData(Buffer.from('\x1b[5~'))
  back.handleData(Buffer.from('\x1b[6~'))
  back.handleData(Buffer.from('\x1b[6~'))
  assert.equal(back.scrollOffset, 0, 'and two PgDns bring it back')
})

test('G-1: two page keys inside one read scroll two pages', { todo: 'G-1 — the composer path matches whole reads; W-3 splits them (AD-20 §3)' }, () => {
  const tui = fixture()
  transcript(tui)
  draft(tui)
  const before = snapshot(tui)

  tui.handleData(Buffer.from('\x1b[5~\x1b[5~'))

  const single = fixture()
  transcript(single)
  single.handleData(Buffer.from('\x1b[5~'))
  const page = single.scrollOffset
  assert.equal(tui.scrollOffset - before.scroll, page * 2, 'the read carries two keys, so it scrolls two pages')
  assertUnchanged(tui, before, 'two page keys in one read', ['scroll'])
})

test('G-1: two page keys inside one read scroll back in a Screen too', () => {
  // The Screen path already splits reads (0.8.3, `screenKeys`): this is the shape the
  // composer path is measured against, and it must not regress while W-1 moves it.
  const tui = fixture()
  tui.openScreen({
    kind: 'report', report: 'diag', title: '诊断',
    lines: Array.from({ length: 200 }, (_line, index) => ({ kind: 'system', text: `第 ${index} 行` })),
    offset: 100,
  })
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x1b[6~\x1b[6~'))
  assert.ok(tui.screen.offset > before.screenOffset, `both page keys moved the Screen (${before.screenOffset} → ${tui.screen.offset})`)
  assertUnchanged(tui, before, 'two page keys inside a Screen', ['screenOffset'])
})

// ── G-2 / G-8 · a rebound key, coalesced ────────────────────────────────────

test('G-2/G-8: a rebound key is consumed, not typed, and not lost', () => {
  const keys = { pageUp: 'ctrl+p' }
  const single = fixture({ keys })
  transcript(single)
  draft(single)
  single.handleData(Buffer.from('\x10'))
  const page = single.scrollOffset
  assert.ok(page > 0, `the rebound key runs its action (${page} lines)`)
  assert.equal(single.input, '我打了一半的消息', 'and is not typed as text')

  const twice = fixture({ keys })
  transcript(twice)
  draft(twice)
  twice.handleData(Buffer.from('\x10'))
  twice.handleData(Buffer.from('\x10'))
  assert.equal(twice.scrollOffset, page * 2, 'two presses in two reads run it twice')
  assert.equal(twice.input, '我打了一半的消息')
})

test('G-2/G-8: a rebound key sent twice inside one read runs twice', { todo: 'G-2/G-8 — the keymap lookup compares the whole read; W-3 looks keys up one at a time' }, () => {
  const tui = fixture({ keys: { pageUp: 'ctrl+p' } })
  transcript(tui)
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x10\x10'))
  assert.equal(tui.scrollOffset - before.scroll, 24, 'both presses ran (two pages of twelve lines)')
  assertUnchanged(tui, before, 'a rebound key twice in one read', ['scroll'])
})

// ── G-3 · an Alt chord batched with the next character ──────────────────────

test('G-3: an Alt chord alone reaches its action and types nothing', () => {
  const tui = fixture()
  transcript(tui, 40, 'reasoning')
  transcript(tui, 20)
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x1b1'))
  assert.match(tui.footerEcho?.text ?? '', /已跳到最新/u, 'the chord answered on the footer')
  assert.equal(tui.input, '我打了一半的消息', 'and the chord itself is not text')
  assert.equal(tui.cursor, before.cursor, 'nor did it move the caret')
})

test('G-3: an Alt chord batched with the next character keeps the chord and drops the rest', { todo: 'G-3 — the Alt branch consumes the whole read; W-3 has the reader hand it the chord alone' }, () => {
  const tui = fixture()
  transcript(tui, 40, 'reasoning')
  transcript(tui, 20)
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x1b1x'))
  assert.match(tui.footerEcho?.text ?? '', /已跳到最新/u, 'the chord still runs')
  assert.equal(tui.input, '我打了一半的消息', 'and the character after it does not leak into the composer')
  assert.equal(tui.cursor, before.cursor)
})

// ── G-4 · Ctrl+V ────────────────────────────────────────────────────────────

test('G-4: Ctrl+V belongs to nobody, and never becomes text', async () => {
  const composer = fixture()
  draft(composer)
  const before = snapshot(composer)
  composer.handleData(Buffer.from('\x16'))
  assertUnchanged(composer, before, 'Ctrl+V in the composer')

  const screen = fixture()
  screen.openScreen({ kind: 'report', report: 'diag', title: '诊断', lines: [{ kind: 'system', text: '正文' }], offset: 0 })
  draft(screen)
  const screenBefore = snapshot(screen)
  screen.handleData(Buffer.from('\x16'))
  assertUnchanged(screen, screenBefore, 'Ctrl+V inside a Screen')

  const dialog = fixture()
  draft(dialog)
  const pending = dialog.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } })
  await waitForDialog(dialog, 'confirm')
  const dialogBefore = snapshot(dialog)
  dialog.handleData(Buffer.from('\x16'))
  assertUnchanged(dialog, dialogBefore, 'Ctrl+V at an approval')
  dialog.handleData(Buffer.from('n'))
  await pending.catch(() => undefined)
})

// ── G-5 · the mouse policy inside a Screen ──────────────────────────────────

test('G-5: a Screen takes the wheel and refuses everything else', () => {
  const tui = fixture({ caps: fullTerminal() })
  tui.openScreen({
    kind: 'report', report: 'diag', title: '诊断',
    lines: Array.from({ length: 200 }, (_line, index) => ({ kind: 'system', text: `第 ${index} 行` })),
    offset: 100, copyText: '屏幕上的正文',
  })
  draft(tui)
  const before = snapshot(tui)

  tui.handleData(Buffer.from('\x1b[<65;10;5M'))
  assert.ok(tui.screen.offset > before.screenOffset, 'the wheel scrolls the Screen')
  assertUnchanged(tui, before, 'the wheel inside a Screen', ['screenOffset'])

  const scrolled = snapshot(tui)
  for (const report of ['\x1b[<0;10;5M', '\x1b[<32;14;5M', '\x1b[<0;14;5m']) {
    tui.handleData(Buffer.from(report))
  }
  assertUnchanged(tui, scrolled, 'a press, a drag and a release inside a Screen')
  assert.equal(tui.copyYank ?? null, before.yank, 'and no selection started')
})

test('G-5: the resolved wizard refuses the mouse too, and keeps its field', async () => {
  const tui = fixture({ caps: fullTerminal() })
  const wizard = tui.runOnboarding()
  await waitForDialog(tui, undefined).catch(() => undefined)
  assert.equal(tui.screen?.kind, 'setup', 'the production entry opened the wizard as a Screen')
  draft(tui)
  const before = snapshot(tui)
  for (const report of ['\x1b[<0;10;5M', '\x1b[<32;14;5M', '\x1b[<0;14;5m', '\x1b[<65;10;9M']) {
    tui.handleData(Buffer.from(report))
  }
  assertUnchanged(tui, before, 'the mouse at the wizard')
  tui.handleData(Buffer.from('\x1b'))
  await wizard.catch(() => undefined)
})

// ── the Screen gate · the defect 0.8.3 fixed, pinned through the char path ───

test('a Screen gate holds for keys that arrive beside a paste', () => {
  // The other delivery path into `handleChar`: a read that carries a bracketed paste
  // *and* a control key (a terminal batching a paste with the keypress after it).
  // Everything outside the markers goes through `handlePlainText` → `handleChar`, and
  // before 0.8.3 the Screen gate sat *below* that switch — so this exact read spent
  // Ctrl+U, Ctrl+K, Backspace and Enter on the draft behind the Screen.
  const control = ['\x15', '\x0b', '\x7f', '\r']
  for (const [index, key] of control.entries()) {
    const tui = fixture({ caps: fullTerminal() })
    tui.openScreen({
      kind: 'report', report: 'diag', title: '诊断',
      lines: [{ kind: 'system', text: '正文' }], offset: 0,
    })
    draft(tui)
    const before = snapshot(tui)
    tui.handleData(Buffer.from(`\x1b[200~粘贴的文本\x1b[201~${key}`))
    // Enter is the Screen's own closing key (`inspectClosesOn`); the rest are keys it
    // does not use, and a key the owner does not use is dropped, never forwarded.
    const closes = key === '\r'
    assert.equal(tui.screen?.kind, closes ? undefined : 'report', `${index}: the Screen ${closes ? 'closed on Enter' : 'is still up'}`)
    assert.equal(tui.input, before.input, `${index}: the draft behind the Screen is untouched`)
    assert.equal(tui.cursor, before.cursor, `${index}: and so is the caret`)
  }
})

// ── G-6 · the static boundary ───────────────────────────────────────────────

test('G-6: the input boundary audit passes and reports the known debt', () => {
  let output = ''
  try {
    output = execFileSync(process.execPath, [join(ROOT, 'scripts', 'input-freeze-audit.mjs')], { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    assert.fail(`the input audit failed:\n${error.stdout ?? ''}${error.stderr ?? ''}`)
  }
  assert.match(output, /input ownership audit \(AD-20, W-0\)/u)
  assert.match(output, /OK: no input-ownership baseline was exceeded/u)
  assert.match(output, /dead Screen gate\s+\d+ —/u, 'the unreachable Screen gate is recorded, not silently ignored')
})

// ── G-7 · focus sequences ───────────────────────────────────────────────────

test('G-7: focus sequences are ignored wherever they land', async () => {
  for (const sequence of ['\x1b[I', '\x1b[O']) {
    const composer = fixture()
    draft(composer)
    const before = snapshot(composer)
    composer.handleData(Buffer.from(sequence))
    assertUnchanged(composer, before, `${JSON.stringify(sequence)} in the composer`)

    const screen = fixture()
    screen.openScreen({ kind: 'report', report: 'diag', title: '诊断', lines: [{ kind: 'system', text: '正文' }], offset: 0 })
    draft(screen)
    const screenBefore = snapshot(screen)
    screen.handleData(Buffer.from(sequence))
    assertUnchanged(screen, screenBefore, `${JSON.stringify(sequence)} inside a Screen`)
  }

  // Both in one read are two events, not one unknown sequence.
  const pair = fixture()
  draft(pair)
  const pairBefore = snapshot(pair)
  pair.handleData(Buffer.from('\x1b[I\x1b[O'))
  assertUnchanged(pair, pairBefore, 'focus in and out in one read')

  const dialog = fixture()
  draft(dialog)
  const pending = dialog.handleApproval({ toolName: 'bash', reason: 'runs a build', agent: { id: 'main-session' } })
  await waitForDialog(dialog, 'confirm')
  const dialogBefore = snapshot(dialog)
  dialog.handleData(Buffer.from('\x1b[I'))
  assertUnchanged(dialog, dialogBefore, 'focus in at an approval')
  dialog.handleData(Buffer.from('n'))
  await pending.catch(() => undefined)
})

// ── G-10 · copy does not own the composer ───────────────────────────────────

test('G-10: the copy key leaves the draft alone', () => {
  const tui = fixture({ caps: fullTerminal() })
  pushRow(tui, { kind: 'assistant', text: '这是最新的回复，可以复制' })
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x1b[99;6u')) // the copy key's default sequence
  assert.equal(tui.copyYank, '这是最新的回复，可以复制', 'the copy happened')
  assert.equal(tui.input, before.input, 'the draft is the composer’s, not the copy path’s')
  assert.equal(tui.cursor, before.cursor)
})

test('G-10: a Screen’s copy key leaves the draft alone', () => {
  const tui = fixture({ caps: fullTerminal() })
  tui.openScreen({
    kind: 'report', report: 'diag', title: '诊断',
    lines: [{ kind: 'system', text: '正文' }], offset: 0, copyText: '屏幕上的正文',
  })
  draft(tui)
  const before = snapshot(tui)
  tui.handleData(Buffer.from('\x1b[99;6u'))
  assert.equal(tui.copyYank, '屏幕上的正文', 'the Screen’s text was copied')
  assert.equal(tui.input, before.input, 'and the draft survives it')
  assert.equal(tui.cursor, before.cursor)
})

test('G-10: a drag selection leaves the draft alone', () => {
  const tui = fixture({ caps: fullTerminal() })
  pushRow(tui, { kind: 'assistant', text: '先跑 npm test 再提交' })
  const frame = tui.captureFrame(100, 30)
  const row = frame.findIndex(line => stripAnsi(line).includes('npm test'))
  assert.ok(row >= 0, 'the reply is painted')
  const text = stripAnsi(frame[row])
  const column = [...text.slice(0, text.indexOf('npm'))].reduce((width, char) => width + displayWidth(char), 0) + 1
  draft(tui)
  const before = snapshot(tui)

  tui.handleData(Buffer.from(`\x1b[<0;${column};${row + 1}M`))
  tui.handleData(Buffer.from(`\x1b[<32;${column + 8};${row + 1}M`))
  tui.handleData(Buffer.from(`\x1b[<0;${column + 8};${row + 1}m`))

  assert.equal(tui.copyYank, 'npm test', 'the drag copied what it covered')
  assert.equal(tui.input, before.input, 'and the draft survives the drag')
  assert.equal(tui.cursor, before.cursor)
})

test('G-10: a link click leaves the draft alone', () => {
  const tui = fixture({ caps: fullTerminal(), color: true })
  pushRow(tui, { kind: 'assistant', text: '文档见 [指南](https://example.com/guide) 一节' })
  const frame = tui.captureFrame(100, 30)
  const row = frame.findIndex(line => line.includes('\x1b]8;'))
  assert.ok(row >= 0, 'the link is painted as an OSC 8 hyperlink')
  const text = stripAnsi(frame[row])
  const column = [...text.slice(0, text.indexOf('指南'))].reduce((width, char) => width + displayWidth(char), 0) + 1
  draft(tui)
  const before = snapshot(tui)

  tui.handleData(Buffer.from(`\x1b[<0;${column};${row + 1}M`))
  tui.handleData(Buffer.from(`\x1b[<0;${column};${row + 1}m`))

  assert.match(tui.copyYank ?? '', /example\.com/u, 'the link was copied')
  assert.equal(tui.input, before.input, 'and the draft survives the click')
  assert.equal(tui.cursor, before.cursor)
})

test('G-10: the /copy command still consumes its own line', () => {
  // The other half of the rule, and the reason the guard is not a blanket "never
  // clear": a command *is* text submitted from the composer, and `runCommand`
  // consumes it for every command. `/copy` must not be the odd one out in either
  // direction — it consumes its line like `/help`, and it does not touch a draft
  // that a key or a gesture would have left.
  const tui = fixture({ caps: fullTerminal() })
  pushRow(tui, { kind: 'assistant', text: '一段可复制的回复' })
  tui.input = '/copy'
  tui.cursor = '/copy'.length
  tui.handleData(Buffer.from('\r'))
  assert.equal(tui.input, '', 'the command line is consumed by the command path')
  assert.equal(tui.copyYank, '一段可复制的回复', 'and the copy happened')
})
