import test from 'node:test'
import assert from 'node:assert/strict'

import { diffHunks, diffLines, splitLines, wordDiffSpans } from '../lib/line-diff.js'

/**
 * C-2: the tool card needs a line diff, not a whole-file replacement.
 *
 * Printing every old line as `-` and every new line as `+` turns a one-line
 * change into two hundred rows. These rules decide what actually changed, what
 * context to keep, and which characters inside a replaced pair to emphasise.
 */
const text = (...lines) => lines.join('\n')
const shape = lines => lines.map(line => `${line.kind === 'same' ? ' ' : line.kind === 'add' ? '+' : '-'}${line.text}`)

test('an unchanged file is all context', () => {
  const lines = diffLines(text('a', 'b'), text('a', 'b'))
  assert.deepEqual(shape(lines), [' a', ' b'])
  assert.deepEqual(diffHunks(lines), [], 'and produces no hunks to render')
})

test('a one-line change is one del and one add, not a whole-file pair', () => {
  const before = text('one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight')
  const after = text('one', 'two', 'THREE', 'four', 'five', 'six', 'seven', 'eight')
  const lines = diffLines(before, after)
  assert.deepEqual(shape(lines), [' one', ' two', '-three', '+THREE', ' four', ' five', ' six', ' seven', ' eight'])
  // Two unchanged lines of context on each side of the change.
  const hunks = diffHunks(lines, 2)
  assert.equal(hunks.length, 1)
  assert.equal(hunks[0].omittedBefore, 0)
  assert.deepEqual(shape(hunks[0].lines), [' one', ' two', '-three', '+THREE', ' four', ' five'])
})

test('two distant changes become two hunks with the middle counted as omitted', () => {
  const before = Array.from({ length: 40 }, (_unused, at) => `line ${at}`)
  const after = before.map((line, at) => (at === 2 || at === 30 ? `${line} changed` : line))
  const hunks = diffHunks(diffLines(text(...before), text(...after)), 2)
  assert.equal(hunks.length, 2)
  assert.equal(hunks[0].omittedBefore, 0)
  assert.ok(hunks[1].omittedBefore > 20, `the gap is counted: ${hunks[1].omittedBefore}`)
})

test('pure additions and pure deletions keep their order', () => {
  assert.deepEqual(shape(diffLines('', text('a', 'b'))), ['+a', '+b'])
  assert.deepEqual(shape(diffLines(text('a', 'b'), '')), ['-a', '-b'])
  assert.deepEqual(shape(diffLines(text('a', 'c'), text('a', 'b', 'c'))), [' a', '+b', ' c'])
  assert.deepEqual(shape(diffLines(text('a', 'b', 'c'), text('a', 'c'))), [' a', '-b', ' c'])
})

test('an empty text has no lines at all', () => {
  assert.deepEqual(splitLines(''), [])
  assert.deepEqual(splitLines('a'), ['a'])
  assert.deepEqual(splitLines('a\nb'), ['a', 'b'])
})

test('word spans trim the common prefix and suffix on both sides', () => {
  assert.deepEqual(wordDiffSpans('const value = 1', 'const value = 2'), { old: [{ start: 14, end: 15 }], new: [{ start: 14, end: 15 }] })
  assert.deepEqual(wordDiffSpans('same', 'same'), { old: [], new: [] })
  // A pure insertion: nothing is removed, and the added text is the span.
  assert.deepEqual(wordDiffSpans('ab', 'aXb'), { old: [], new: [{ start: 1, end: 2 }] })
  assert.deepEqual(wordDiffSpans('aXb', 'ab'), { old: [{ start: 1, end: 2 }], new: [] })
  // A full replacement spans both lines entirely.
  assert.deepEqual(wordDiffSpans('abc', 'xyz'), { old: [{ start: 0, end: 3 }], new: [{ start: 0, end: 3 }] })
})

test('word spans do not split an emoji in half', () => {
  const spans = wordDiffSpans('🚀 go', '🚀 stop')
  assert.deepEqual(spans.old, [{ start: 3, end: 5 }], 'the rocket keeps its two units')
  assert.equal('🚀 go'.slice(spans.old[0].start, spans.old[0].end), 'go')
  assert.equal('🚀 stop'.slice(spans.new[0].start, spans.new[0].end), 'stop')
})

/** A card rendering the diff for one tool row. */
async function diffFrame(hunks, { maxLines = 6, width = 90 } = {}) {
  const { toolBodyLines } = await import('../lib/tool-present.js')
  const { setLocale: set } = await import('../lib/i18n/index.js')
  set('zh')
  const row = {
    kind: 'tool', callId: 'e1', name: 'edit', title: '编辑', summary: hunks[0]?.path ?? '',
    args: '{}', output: '', status: 'ok', expanded: true, diff: hunks,
  }
  const lines = toolBodyLines(row, maxLines)
  return { lines, text: lines.map(line => line.text).join('\n') }
}

test('a one-line change in a long file renders as a change, not as the file twice', async () => {
  const before = Array.from({ length: 30 }, (_unused, at) => `line ${at}`).join('\n')
  const after = before.replace('line 15', 'line 15 changed')
  const tight = await diffFrame([{ path: 'a.ts', oldText: before, newText: after }], { maxLines: 6 })
  assert.ok(tight.lines.length <= 6, `the budget holds: ${tight.lines.length}`)
  assert.ok(tight.text.includes('- line 15'), 'the removed line')
  assert.ok(tight.text.includes('+ line 15 changed'), 'and the added one')
  assert.equal(/line 14\b/u.test(tight.text), false, 'no context when there is no room for it')

  // With room, the change keeps its context and the stretch between changes is
  // counted instead of printed.
  const roomy = await diffFrame([{ path: 'a.ts', oldText: before, newText: after }], { maxLines: 20 })
  assert.ok(roomy.text.includes('- line 15'), 'the change is still there')
  assert.ok(roomy.text.includes('⋯'), 'with the unchanged stretch counted')
  assert.equal(/line 3\b/u.test(roomy.text), false, 'and far-away context still not printed')
})

test('the changed characters are emphasised, and only them', async () => {
  const { lines } = await diffFrame([{ path: 'a.ts', oldText: 'const value = 1', newText: 'const value = 2' }])
  const removed = lines.find(line => line.kind === 'diff-del')
  const added = lines.find(line => line.kind === 'diff-add')
  assert.deepEqual(removed?.spans, [{ start: 16, end: 17 }], 'the marker shifts the span by two')
  assert.deepEqual(added?.spans, [{ start: 16, end: 17 }])
})

test('a diff that cannot fit collapses to its counts and a pointer', async () => {
  const before = Array.from({ length: 60 }, (_unused, at) => `old ${at}`).join('\n')
  const after = Array.from({ length: 60 }, (_unused, at) => `new ${at}`).join('\n')
  const { lines, text } = await diffFrame([{ path: 'a.ts', oldText: before, newText: after }], { maxLines: 4 })
  assert.ok(lines.length <= 4, `the budget holds: ${lines.length}`)
  assert.ok(text.includes('a.ts'), 'the path is still named')
  assert.match(text, /\+\d+ -\d+/u, 'with the counts')
  assert.ok(text.includes('Enter 看全文'), 'and where the whole diff is')
  assert.equal(text.includes('old 0'), false, 'without a truncated body')
})

/**
 * C-2b: the same diff, laid out for the terminal it is painted on.
 */
test('the layout follows the width, with a threshold that means something', async () => {
  const { diffLayout, SIDE_BY_SIDE_MIN_WIDTH } = await import('../lib/line-diff.js')
  assert.equal(diffLayout(SIDE_BY_SIDE_MIN_WIDTH - 1), 'stacked')
  assert.equal(diffLayout(SIDE_BY_SIDE_MIN_WIDTH), 'side-by-side')
  assert.equal(diffLayout(80), 'stacked', 'a normal terminal stacks')
  assert.equal(diffLayout(200), 'side-by-side')
})

test('a replacement shares a row, and context appears in both columns', async () => {
  const { diffLines, sideBySideRows } = await import('../lib/line-diff.js')
  const rows = sideBySideRows(diffLines('same\nold line\nlast', 'same\nnew line\nlast'))
  assert.deepEqual(rows.map(row => [row.left, row.right]), [
    ['  same', '  same'],
    ['- old line', '+ new line'],
    ['  last', '  last'],
  ])
  assert.equal(rows[1].context, false)
  // `old line` and `new line` share their suffix, so `old`/`new` is the change;
  // the `- `/`+ ` marker adds two cells before the text.
  assert.deepEqual(rows[1].leftSpans, [{ start: 2, end: 5 }], 'the changed word, after the marker')
  assert.deepEqual(rows[1].rightSpans, [{ start: 2, end: 5 }])
})

test('a lone removal or addition leaves the other column empty', async () => {
  const { diffLines, sideBySideRows } = await import('../lib/line-diff.js')
  const removed = sideBySideRows(diffLines('a\nb\nc', 'a\nc'))
  assert.deepEqual(removed.map(row => [row.left, row.right]), [
    ['  a', '  a'],
    ['- b', ''],
    ['  c', '  c'],
  ])
  const added = sideBySideRows(diffLines('a\nc', 'a\nb\nc'))
  assert.deepEqual(added.map(row => [row.left, row.right]), [
    ['  a', '  a'],
    ['', '+ b'],
    ['  c', '  c'],
  ])
})

test('a wide card paints two columns that fit, a narrow one stacks', async () => {
  const { renderToolDiff, toolBodyLines } = await import('../lib/tool-present.js')
  const diffs = [{ path: 'a.ts', oldText: 'keep\nold line\nx', newText: 'keep\nnew line\ny' }]
  const wide = renderToolDiff(diffs, 20, 120)
  // The first row with a gutter is the context row; the change is the one to
  // check the columns of.
  const paired = wide.find(line => line.text.includes('- old line'))
  assert.ok(paired !== undefined, `a wide diff is side by side: ${JSON.stringify(wide.map(l => l.text))}`)
  assert.match(paired.text, /- old line\s+│ \+ new line/u)
  for (const line of wide) {
    assert.ok([...line.text].length <= 120, `the row fits: ${JSON.stringify(line.text)}`)
  }
  // Every gutter sits in the same column: that alignment is what makes the two
  // sides readable, and a column that is not padded loses it.
  const gutters = wide
    .filter(line => line.text.includes('│'))
    .map(line => line.text.indexOf('│'))
  // Every line of a change block appears: pairing must not drop the tail of a
  // block that happens to be longer than one line.
  const text = wide.map(line => line.text).join('\n')
  assert.match(text, /- old line/u)
  assert.match(text, /\+ new line/u)
  assert.match(text, /- x\s+│ \+ y/u, `the block's second pair is rendered: ${JSON.stringify(text)}`)
  assert.ok(gutters.length >= 2, `several paired rows are needed to test alignment: ${JSON.stringify(gutters)}`)
  assert.equal(
    new Set(gutters).size,
    1,
    `every gutter sits in the same column, however long the line beside it: ${JSON.stringify(gutters)}`,
  )
  assert.ok((paired.spans ?? []).length >= 1, 'and the changed characters are still emphasised')

  const narrow = renderToolDiff(diffs, 20, 80)
  assert.equal(narrow.some(line => line.text.includes('│')), false, 'a narrow diff stacks instead')

  // The body builder passes the width through, so the card follows the terminal.
  const row = { kind: 'tool', callId: 'c', name: 'edit', title: 'edit', summary: 'a.ts', args: '{}', status: 'ok', expanded: true, diff: diffs }
  assert.ok(toolBodyLines(row, 20, 120).some(line => line.text.includes('│')))
  assert.equal(toolBodyLines(row, 20, 80).some(line => line.text.includes('│')), false)
})
