import test from 'node:test'
import assert from 'node:assert/strict'

import {
  foldInputView,
  formatOpenCodeGoUsage,
  friendlyJsonLines,
  openCodeSourceFor,
  parseExitStatus,
  renderMarkdownLines,
  renderToolDiff,
  toolBodyLines,
  truncateToWidth,
} from '../lib/tui.js'

test('truncateToWidth never splits a surrogate pair', () => {
  const cut = truncateToWidth('🙂🙂', 1)
  assert.equal(cut, '…')
  assert.ok(!cut.includes('\uFFFD'))
})

test('foldInputView keeps wide characters intact around the cursor', () => {
  const view = foldInputView('🙂🙂🙂🙂🙂', 6, 10)
  assert.equal(view.cursorOffset, 6)
  assert.equal(view.folded, false)
})

test('renderMarkdownLines strips terminal control sequences', () => {
  const lines = renderMarkdownLines('a\x1b[31mRED\x1b[0mb', 20, false)
  assert.deepEqual(lines, ['a[31mRED[0mb'])
})

test('friendlyJsonLines bounds recursion and entry count', () => {
  let deep = { value: 0 }
  for (let index = 0; index < 1000; index += 1) deep = { next: deep }
  assert.ok(friendlyJsonLines(deep).length < 100)
  const wide = friendlyJsonLines({ values: Array.from({ length: 500 }, (_, i) => i) })
  assert.ok(wide.length < 100)
})

test('renderToolDiff respects small maxLines budgets', () => {
  const diffs = [{ path: 'a.ts', oldText: 'a\nb', newText: 'c\nd' }]
  assert.equal(renderToolDiff(diffs, 1).length, 1)
  assert.equal(renderToolDiff(diffs, 2).length, 2)
  assert.equal(renderToolDiff(diffs, 3).length, 3)
})

test('toolBodyLines caps generic JSON bodies to maxLines', () => {
  const row = { args: '{"a":1}', output: '{"items":[1,2,3,4]}' }
  for (const max of [1, 2, 3]) {
    assert.ok(toolBodyLines(row, max).length <= max)
  }
})

test('openCodeSourceFor picks the right built-in api key env', () => {
  assert.equal(openCodeSourceFor('opencode', undefined)?.apiKeyEnv, 'OPENCODE_API_KEY')
  assert.equal(openCodeSourceFor('opencode-go', undefined)?.apiKeyEnv, 'OPENCODE_GO_API_KEY')
  assert.equal(openCodeSourceFor('custom-gw', {
    providers: { 'custom-gw': { baseURL: 'https://opencode.ai/zen/go/v1', apiKeyEnv: 'MY_KEY' } },
  })?.apiKeyEnv, 'MY_KEY')
})

test('formatOpenCodeGoUsage rejects unrecognized payloads', () => {
  assert.throws(
    () => formatOpenCodeGoUsage({}, { provider: 'x', flavor: 'go', label: 'x', apiKeyEnv: 'K' }),
    /无法识别/u,
  )
})

test('parseExitStatus keeps exit-code and signal parsing', () => {
  assert.deepEqual(parseExitStatus('out\n[exit code: 7]'), { body: 'out', exitCode: 7 })
  assert.deepEqual(parseExitStatus('out\n[killed by signal: SIGTERM]'), { body: 'out', signal: 'SIGTERM' })
})
