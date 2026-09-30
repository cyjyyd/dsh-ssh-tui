import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'

/**
 * The compact card's own lines must not repeat what its header already said.
 *
 * A collapsed edit card names the file it changed and its diffstat — that is
 * what the header is for. The per-file breakdown line below it exists to name
 * the files a *multi*-file edit touched, so on a single-file edit it printed the
 * header again, verbatim:
 *
 *   ▸ ● 已编辑 /root/dsh-ssh-tui/src/terminal-input.ts  +4
 *     /root/dsh-ssh-tui/src/terminal-input.ts  +4
 *
 * A failed tool has the opposite problem: the header gets a status ball coloured
 * by state, while the lines that say *what* failed are drawn as bare text. The
 * reader sees red words without the state marker every other card line carries.
 */
setLocale('zh')

const strip = line => line.replace(/\x1b\[[0-9;]*m/gu, '')
const hunk = (oldText, newText, path) => ({ oldText, newText, ...(path === undefined ? {} : { path }) })

function compactTui() {
  const ctx = { get: () => undefined, on() { return () => {} } }
  const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.setWorkspaceView('compact')
  return tui
}

const editRow = (overrides = {}) => ({
  kind: 'tool',
  callId: overrides.callId ?? 'a',
  name: 'edit',
  title: overrides.title ?? 'edit',
  summary: 'src/tui.ts',
  args: JSON.stringify({ path: 'src/tui.ts' }),
  status: overrides.status ?? 'ok',
  expanded: false,
  diff: [hunk('a', 'a\nb', 'src/tui.ts')],
  ...overrides,
})

const burstLines = tui => tui.captureFrame(120, 30).map(strip).filter(line => line.trim() !== '')

test('a single-file edit card names its file once', () => {
  const tui = compactTui()
  tui.rows.push({ kind: 'assistant', text: '改一处' })
  tui.rows.push(editRow())
  const named = burstLines(tui).filter(line => line.includes('src/tui.ts'))

  assert.equal(named.length, 1, `named once, not twice:\n${named.join('\n')}`)
})

test('a multi-file edit card still breaks the change down by file', () => {
  // The breakdown line earns its space here: the header carries one total, and
  // the reader deciding whether to expand needs to know which files moved.
  const tui = compactTui()
  tui.rows.push({ kind: 'assistant', text: '改两处' })
  tui.rows.push(editRow())
  tui.rows.push(editRow({
    callId: 'b',
    summary: 'src/paint.ts',
    args: JSON.stringify({ path: 'src/paint.ts' }),
    diff: [hunk('x', 'x\ny', 'src/paint.ts')],
  }))
  const frame = burstLines(tui).join('\n')

  assert.ok(frame.includes('2 个文件'), `the header counts the files:\n${frame}`)
  assert.ok(frame.includes('src/tui.ts') && frame.includes('src/paint.ts'), `both files are named:\n${frame}`)
})

test('a failed tool line carries the status ball', () => {
  const tui = compactTui()
  tui.rows.push({ kind: 'assistant', text: '试一下' })
  tui.rows.push(editRow({ callId: 'f', status: 'error', title: '编辑', summary: '/root/dsh-ssh-tui/src/terminal-input.ts' }))
  const lines = burstLines(tui)
  const failed = lines.findIndex(line => line.includes('/root/dsh-ssh-tui/src/terminal-input.ts'))
  assert.notEqual(failed, -1, `the failure is named:\n${lines.join('\n')}`)
  // The last mention is the failure line (the header named the file above it).
  const last = lines.filter(line => line.includes('terminal-input.ts')).at(-1) ?? ''
  assert.match(last.trimStart(), /^[▸▾◇]?\s*●\s/u, `a status ball precedes it:\n${lines.join('\n')}`)
})
