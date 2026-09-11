/**
 * Dialog key rules: cursor moves, selection, and what Enter means. These used
 * to live inside `handleDialogChar`, where a mistake is only visible with a
 * live question dialog on screen.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  confirmAnswer,
  inspectClosesOn,
  moveQuestionCursor,
  optionsLength,
  questionOptionIndex,
  questionSubmit,
  selectQuestionOption,
  selectQuestionOptionByKey,
} from '../lib/dialogs.js'

function questionDialog(options, overrides = {}) {
  return {
    kind: 'questions',
    question: { id: 'q1', question: 'Pick', ...(options === undefined ? {} : { options }) },
    index: 1,
    total: 1,
    selected: new Set(),
    cursor: 0,
    ...overrides,
  }
}

const OPTIONS = [
  { label: 'alpha' },
  { label: 'bravo' },
  { label: 'charlie' },
]

test('only a question list has answerable options', () => {
  assert.equal(optionsLength(questionDialog(OPTIONS)), 3)
  assert.equal(optionsLength(questionDialog(undefined)), 0)
  assert.equal(optionsLength({ kind: 'confirm', prompt: 'p', hint: 'h', resolve: () => {} }), 0)
  assert.equal(optionsLength({ kind: 'inspect', title: 't', lines: [], offset: 0 }), 0)
  assert.equal(optionsLength({ kind: 'onboarding' }), 0)
})

test('option hotkeys follow the painted digits then letters', () => {
  assert.equal(questionOptionIndex('1', 3), 0)
  assert.equal(questionOptionIndex('3', 3), 2)
  assert.equal(questionOptionIndex('4', 3), undefined, 'no such option')
  // Letters only name options past the ninth, matching the keys painted on screen.
  assert.equal(questionOptionIndex('c', 3), undefined)
  assert.equal(questionOptionIndex('c', 13), 11)
  assert.equal(questionOptionIndex('C', 13), 11, 'uppercase works too')
  assert.equal(questionOptionIndex('z', 13), undefined)
})

test('the highlight clamps at both ends of the option list', () => {
  const dialog = questionDialog(OPTIONS, { cursor: 1 })
  assert.equal(moveQuestionCursor(dialog, -1), true)
  assert.equal(dialog.cursor, 0)
  assert.equal(moveQuestionCursor(dialog, -1), true)
  assert.equal(dialog.cursor, 0, 'never above the first option')
  assert.equal(moveQuestionCursor(dialog, 99), true)
  assert.equal(dialog.cursor, 2, 'never past the last option')
  assert.deepEqual([...dialog.selected], [2], 'a single-select list follows the highlight')
})

test('a multi-select list keeps its own selection while moving', () => {
  const dialog = questionDialog(OPTIONS, { multiSelect: true, selected: new Set([0]) })
  dialog.question.multiSelect = true
  moveQuestionCursor(dialog, 1)
  assert.equal(dialog.cursor, 1)
  assert.deepEqual([...dialog.selected], [0], 'moving does not select')
})

test('moving needs options to move through', () => {
  const dialog = questionDialog(undefined)
  assert.equal(moveQuestionCursor(dialog, 1), false)
  assert.equal(dialog.cursor, 0)
})

test('selecting replaces in a single-select list and toggles in a multi-select one', () => {
  const single = questionDialog(OPTIONS, { selected: new Set([0]) })
  selectQuestionOption(single, 2)
  assert.equal(single.cursor, 2)
  assert.deepEqual([...single.selected], [2])

  const multi = questionDialog(OPTIONS, { multiSelect: true })
  multi.question.multiSelect = true
  selectQuestionOption(multi, 1)
  assert.deepEqual([...multi.selected], [1])
  selectQuestionOption(multi, 1)
  assert.deepEqual([...multi.selected], [], 'pressing the key again deselects')
})

test('a hotkey selects only the option it names', () => {
  const dialog = questionDialog(OPTIONS)
  assert.equal(selectQuestionOptionByKey(dialog, '2'), true)
  assert.deepEqual([...dialog.selected], [1])
  assert.equal(selectQuestionOptionByKey(dialog, '9'), false, 'no ninth option here')
  assert.deepEqual([...dialog.selected], [1], 'an out-of-range key changes nothing')
})

test('Enter on an unselected single-select list cancels instead of answering', () => {
  const dialog = questionDialog(OPTIONS)
  assert.deepEqual(questionSubmit(dialog, ''), { kind: 'reject' })
})

test('Enter answers a selected list with the selected labels', () => {
  const dialog = questionDialog(OPTIONS, { selected: new Set([0, 2]), multiSelect: true })
  dialog.question.multiSelect = true
  assert.deepEqual(questionSubmit(dialog, ''), { kind: 'resolve', selected: ['alpha', 'charlie'] })
})

test('Enter on an empty multi-select list is an empty answer, not a cancel', () => {
  const dialog = questionDialog(OPTIONS, { multiSelect: true })
  dialog.question.multiSelect = true
  assert.deepEqual(questionSubmit(dialog, ''), { kind: 'resolve', selected: [] })
})

test('a question with no options answers with the typed text', () => {
  const dialog = questionDialog(undefined)
  assert.deepEqual(questionSubmit(dialog, 'blue'), { kind: 'resolve', selected: [], custom: 'blue' })
})

test('confirm prompts take y/n and treat Ctrl-C or Esc as a cancel', () => {
  assert.equal(confirmAnswer('y'), 'y')
  assert.equal(confirmAnswer('Y'), 'y')
  assert.equal(confirmAnswer('n'), 'n')
  assert.equal(confirmAnswer('N'), 'n')
  assert.equal(confirmAnswer('\x03'), 'cancel')
  assert.equal(confirmAnswer('\x1b'), 'cancel')
  assert.equal(confirmAnswer('x'), undefined)
  assert.equal(confirmAnswer('\r'), undefined, 'Enter is not an answer to a confirm')
})

test('the inspect overlay closes on its own keys and ignores the rest', () => {
  for (const key of ['\x1b', '\x03', 'q', 'Q', '\r', '\n']) {
    assert.equal(inspectClosesOn(key), true, JSON.stringify(key))
  }
  for (const key of ['j', '/', 'y']) {
    assert.equal(inspectClosesOn(key), false, JSON.stringify(key))
  }
})
