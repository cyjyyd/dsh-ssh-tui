import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { parsePlanTodos, todoItemKind, todoProgressBar, todoProgressLabel } from '../lib/plan.js'
import { specializedToolBody } from '../lib/tool-present.js'

/**
 * The plan strip: a Braille bar for completion, and a count for every state.
 *
 * `todo_write`'s own schema has three states, but a model that marks an item
 * failed or skipped would previously be shown as pending — work that looks
 * still to do. Those two are recognized now and counted on their own.
 */
setLocale('zh')

const todos = (...statuses) => statuses.map((status, index) => ({ content: `任务 ${index}`, status }))

test('the bar fills in eighths of a cell, in the context ring family', () => {
  const full = '⣿'
  const empty = '⣀'
  assert.equal(todoProgressBar(todos(), 4), empty.repeat(4), 'no todos, no fill')
  assert.equal(todoProgressBar(todos('pending', 'pending'), 4), empty.repeat(4))
  assert.equal(todoProgressBar(todos('completed', 'completed'), 4), full.repeat(4))
  assert.equal(todoProgressBar(todos('completed', 'pending'), 4), `⣿⣿${empty}${empty}`)
  assert.equal(todoProgressBar(todos('completed', 'pending', 'pending', 'pending'), 4), `⣿${empty.repeat(3)}`)
  // One of eight parts of a single cell is the first partial glyph, not a full one.
  assert.equal(todoProgressBar(todos(...Array.from({ length: 8 }, (_, i) => (i === 0 ? 'completed' : 'pending'))), 1), '⠉')
  // A bar is always the requested width, so the header cannot jump around.
  for (const cells of [1, 6, 10, 24]) {
    assert.equal([...todoProgressBar(todos('completed', 'pending', 'failed'), cells)].length, cells)
  }
})

test('every state has its own count, and failures are not pending', () => {
  const label = todoProgressLabel(todos('completed', 'completed', 'in_progress', 'pending', 'failed', 'failed', 'skipped'))
  assert.match(label, /2 已完成/u)
  assert.match(label, /1 进行中/u)
  assert.match(label, /1 待处理/u, 'only the genuinely pending item is counted as pending')
  assert.match(label, /2 失败/u)
  assert.match(label, /1 跳过/u)
})

test('a model that marks an item failed or skipped is understood', () => {
  const parsed = parsePlanTodos({
    todos: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'failed' },
      { content: 'd', status: 'blocked' },
      { content: 'e', status: 'skipped' },
      { content: 'f', status: 'cancelled' },
      { content: 'g', status: 'done' },
      { content: 'h', status: 'weird' },
      { content: 'i' },
    ],
  })
  assert.deepEqual(parsed.map(item => item.status), [
    'completed', 'in_progress', 'failed', 'failed', 'skipped', 'skipped', 'completed', 'pending', 'pending',
  ])
  assert.equal(todoItemKind('failed'), 'todo-failed')
  assert.equal(todoItemKind('skipped'), 'todo-skipped')
})

test('the card header leads with the bar', () => {
  const lines = specializedToolBody({
    kind: 'tool',
    callId: 'c1',
    name: 'todo_write',
    title: 'todo_write',
    summary: '',
    args: JSON.stringify({ todos: todos('completed', 'completed', 'pending', 'failed').map(item => ({
      content: item.content,
      status: item.status,
    })) }),
    status: 'done',
    expanded: false,
  })
  const header = lines?.[0]?.text ?? ''
  assert.ok(header.startsWith('⣿'), `the header starts with the bar: ${JSON.stringify(header)}`)
  assert.match(header, /2 已完成/u)
  assert.match(header, /1 失败/u)
  assert.match(header, /1 待处理/u)
  // Each item still gets its own mark, failures included.
  const body = (lines ?? []).slice(1).map(line => line.text).join('\n')
  assert.match(body, /✖/u, 'a failed item is marked as failed')
})

test('an empty plan says so instead of drawing an empty bar', () => {
  const lines = specializedToolBody({
    kind: 'tool',
    callId: 'c2',
    name: 'todo_write',
    title: 'todo_write',
    summary: '',
    args: JSON.stringify({ todos: [] }),
    status: 'done',
    expanded: false,
  })
  assert.equal(lines?.[0]?.text.includes('⣀'), false, 'no bar when there is nothing to measure')
})
