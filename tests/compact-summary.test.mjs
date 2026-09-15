import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import {
  compactFailureLines,
  compactFileStats,
} from '../lib/tool-present.js'
import { SshTui } from '../lib/tui.js'

/**
 * C-1: the compact view's collapsed lines have to earn their space.
 *
 * A header saying "3 files +40 -12" cannot tell the reader which file moved, and
 * a failure counted but not named is a reason to expand that the reader cannot
 * see. Both belong on the line, because the line is all a collapsed burst shows.
 */
setLocale('zh')

const hunk = (oldText, newText, path) => ({ oldText, newText, ...(path === undefined ? {} : { path }) })
const edit = (summary, diff, args = '{}') => ({ name: 'edit', args, summary, diff })

test('per-file counts aggregate by path and keep first-seen order', () => {
  const stats = compactFileStats([
    edit('src/tui.ts', [hunk('a\nb', 'a\nb\nc', 'src/tui.ts')]),
    edit('src/paint.ts', [hunk('x', 'x\ny\nz', 'src/paint.ts')]),
    // The same file again: the counts add up rather than starting a second row.
    edit('src/tui.ts', [hunk('c', 'c\nd', 'src/tui.ts')]),
  ])
  // The same file's second edit adds to the first: 3+2 added, 2+1 removed.
  assert.deepEqual(stats, [
    { path: 'src/tui.ts', add: 5, del: 3 },
    { path: 'src/paint.ts', add: 3, del: 1 },
  ])
})

test('a tool with no path is skipped rather than listed as an empty file', () => {
  const stats = compactFileStats([
    { name: 'edit', args: '{}', summary: '', diff: [] },
    edit('src/tui.ts', [hunk('a', 'a\nb', 'src/tui.ts')]),
  ])
  assert.deepEqual(stats.map(entry => entry.path), ['src/tui.ts'])
})

test('only failures produce a line, and each names its tool', () => {
  const lines = compactFailureLines([
    { title: 'bash', summary: '$ npm test', status: 'error' },
    { title: 'read', summary: 'src/tui.ts', status: 'ok' },
    { title: 'bash', summary: '$ tsc', status: 'error' },
    { title: 'edit', summary: 'src/paint.ts' },
  ])
  assert.deepEqual(lines, ['bash  $ npm test', 'bash  $ tsc'])
  assert.deepEqual(compactFailureLines([{ title: 'read', status: 'ok' }]), [])
})

/** A TUI in the compact view with one reply and the tools that followed it. */
function compactTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.setWorkspaceView('compact')
  return tui
}

const toolRow = (overrides) => ({
  kind: 'tool',
  callId: overrides.callId,
  name: overrides.name ?? 'edit',
  title: overrides.title ?? 'edit',
  summary: overrides.summary ?? '',
  args: overrides.args ?? '{}',
  status: overrides.status ?? 'ok',
  expanded: false,
  ...(overrides.diff === undefined ? {} : { diff: overrides.diff }),
  ...(overrides.command === undefined ? {} : { command: overrides.command }),
  ...(overrides.output === undefined ? {} : { output: overrides.output }),
})

test('a collapsed burst names each file it changed', () => {
  const tui = compactTui()
  tui.rows.push({ kind: 'assistant', text: '改两处' })
  tui.rows.push(toolRow({ callId: 'a', summary: 'src/tui.ts', args: JSON.stringify({ path: 'src/tui.ts' }), diff: [hunk('a', 'a\nb', 'src/tui.ts')] }))
  tui.rows.push(toolRow({ callId: 'b', summary: 'src/paint.ts', args: JSON.stringify({ path: 'src/paint.ts' }), diff: [hunk('x', 'x\ny', 'src/paint.ts')] }))
  const frame = tui.captureFrame(120, 30).map(line => line.replace(/\x1b\[[0-9;]*m/gu, '')).join('\n')
  assert.ok(frame.includes('src/tui.ts'), `the first file is named: ${frame}`)
  assert.ok(frame.includes('src/paint.ts'), 'the second file is named')
  assert.match(frame, /\+2/u, 'with its own counts')
})

test('a collapsed burst shows a failed tool by name', () => {
  const tui = compactTui()
  tui.rows.push({ kind: 'assistant', text: '试一下' })
  tui.rows.push(toolRow({
    callId: 'f', name: 'bash', title: 'bash', summary: '$ npm test', command: 'npm test', output: 'boom', status: 'error',
  }))
  const frame = tui.captureFrame(120, 30).map(line => line.replace(/\x1b\[[0-9;]*m/gu, '')).join('\n')
  assert.ok(frame.includes('$ npm test'), `the failing command is visible without expanding: ${frame}`)
})

test('the default view is untouched by the compact summary', () => {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.rows.push({ kind: 'assistant', text: '改一处' })
  tui.rows.push(toolRow({ callId: 'a', summary: 'src/tui.ts', args: JSON.stringify({ path: 'src/tui.ts' }), diff: [hunk('a', 'a\nb', 'src/tui.ts')] }))
  const frame = tui.captureFrame(120, 30).join('\n')
  assert.equal(/\d+ 个文件/u.test(frame), false, 'no compact summary outside the compact view')
  assert.ok(frame.includes('src/tui.ts'), 'and the tool card is rendered as usual')
})
