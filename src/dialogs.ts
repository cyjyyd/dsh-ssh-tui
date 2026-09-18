/**
 * Dialog state rules: the dialog shapes, and what one key does to a question
 * list, a confirm prompt or the inspect overlay.
 *
 * `tui.ts` owns the rendering, the promise plumbing and the agent side; these
 * functions decide cursor moves, selection, and whether Enter means "answer",
 * "cancel" or "send the free-text box". Keeping them here makes the rules
 * testable without a terminal.
 */
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { DiffDisplayLine } from './tool-present.js'

export interface ConfirmDialog {
  kind: 'confirm'
  prompt: string
  hint: string
  resolve(value: 'y' | 'n' | 'cancel'): void
}

export interface QuestionDialog {
  kind: 'questions'
  question: AskUserQuestionItem
  index: number
  total: number
  selected: Set<number>
  cursor: number
  /**
   * The typed filter, once the user pressed `/`. Letters and digits are the
   * list's hotkeys, so filtering is entered explicitly instead of hijacking
   * every keystroke — the two would otherwise fight over the same keys.
   */
  filter?: string
  /** True while the filter is being typed; Enter applies it, Esc clears it. */
  filtering?: boolean
  /**
   * Machine names for the options, indexed like `question.options`. The option
   * shape belongs to the questions package and carries only display text, so a
   * preset id would otherwise be unmatchable — and `routing-suite` is exactly
   * what a user types to find it.
   */
  matchKeys?: readonly string[]
  resolve(selection: { selected: string[]; custom?: string }): void
  reject(error: unknown): void
}

export interface OnboardingDialog {
  kind: 'onboarding'
}

export interface InspectDialog {
  kind: 'inspect'
  title: string
  lines: DiffDisplayLine[]
  offset: number
  /** Child session whose live log should refresh this overlay in place. */
  subagentSessionId?: string
  /** `/find` already scrolled to its hit here; later repaints keep the offset. */
  searchRevealed?: boolean
}

export type Dialog = ConfirmDialog | QuestionDialog | OnboardingDialog | InspectDialog

export interface DialogAnswer {
  selected: string[]
  custom?: string
}

/** Digits then letters: the hotkeys painted next to question options. */
export const QUESTION_OPTION_KEYS = '123456789abcdefghijklmnopqrstuvwxyz'

/** Options a dialog can answer with; only a question list has any. */
export function optionsLength(dialog: Dialog): number {
  return dialog.kind === 'questions' ? (dialog.question.options?.length ?? 0) : 0
}

/**
 * The option index a hotkey selects, or undefined when the key is not one of
 * the painted keys or names no option.
 */
export function questionOptionIndex(key: string, optionCount: number): number | undefined {
  const index = QUESTION_OPTION_KEYS.indexOf(key.toLowerCase())
  if (index < 0 || index >= optionCount) return undefined
  return index
}

/**
 * The option indexes the current filter leaves visible, in list order.
 *
 * An empty or absent filter keeps everything. The match is the same shape the
 * pickers use: the label or the description, case-insensitively.
 */
export function visibleQuestionIndexes(dialog: QuestionDialog): number[] {
  const options = dialog.question.options ?? []
  const needle = (dialog.filter ?? '').trim().toLowerCase()
  const all = options.map((_option, index) => index)
  if (needle === '') return all
  return all.filter(index => {
    const option = options[index]
    if (option === undefined) return false
    return [option.label, option.description ?? '', dialog.matchKeys?.[index] ?? '']
      .some(field => field.toLowerCase().includes(needle))
  })
}

/** Append a typed character to the filter (filter mode only). */
export function typeQuestionFilter(dialog: QuestionDialog, text: string): boolean {
  if (dialog.filtering !== true) return false
  dialog.filter = `${dialog.filter ?? ''}${text}`
  clampCursorToVisible(dialog)
  return true
}

/** Remove the last character of the filter; the caller exits when it is empty. */
export function backspaceQuestionFilter(dialog: QuestionDialog): boolean {
  if (dialog.filtering !== true) return false
  dialog.filter = (dialog.filter ?? '').slice(0, -1)
  clampCursorToVisible(dialog)
  return true
}

/** Leave filter mode, keeping whatever was typed (Enter applies it). */
export function applyQuestionFilter(dialog: QuestionDialog): void {
  dialog.filtering = false
}

/** Leave filter mode and show the whole list again (Esc clears it). */
export function clearQuestionFilter(dialog: QuestionDialog): void {
  dialog.filtering = false
  dialog.filter = ''
  clampCursorToVisible(dialog)
}

/**
 * Keep the highlight on a visible option after the filter changed: the cursor
 * indexes the full list, and a filtered-out option would otherwise stay
 * selected while invisible.
 */
function clampCursorToVisible(dialog: QuestionDialog): void {
  const visible = visibleQuestionIndexes(dialog)
  if (visible.length === 0) return
  if (visible.includes(dialog.cursor)) return
  dialog.cursor = visible[0] ?? dialog.cursor
  if (dialog.question.multiSelect !== true) {
    dialog.selected.clear()
    dialog.selected.add(dialog.cursor)
  }
}

/** Move the question highlight, clamped to its options. Returns false if not a question dialog. */
export function moveQuestionCursor(dialog: QuestionDialog, delta: number): boolean {
  const count = dialog.question.options?.length ?? 0
  if (count === 0) return false
  const visible = visibleQuestionIndexes(dialog)
  if (visible.length === 0) return false
  const at = visible.indexOf(dialog.cursor)
  const next = at === -1
    ? (delta >= 0 ? visible[0] : visible[visible.length - 1])
    : visible[Math.max(0, Math.min(visible.length - 1, at + delta))]
  dialog.cursor = next ?? dialog.cursor
  if (dialog.question.multiSelect !== true) {
    dialog.selected.clear()
    dialog.selected.add(dialog.cursor)
  }
  return true
}

/** Select option `index`: toggles in a multi-select list, replaces otherwise. */
export function selectQuestionOption(dialog: QuestionDialog, index: number): void {
  dialog.cursor = index
  if (dialog.question.multiSelect === true) {
    if (dialog.selected.has(index)) dialog.selected.delete(index)
    else dialog.selected.add(index)
    return
  }
  dialog.selected.clear()
  dialog.selected.add(index)
}

/** Handle a hotkey: select its option and report whether it applied. */
export function selectQuestionOptionByKey(dialog: QuestionDialog, key: string): boolean {
  if (dialog.filtering === true) return false
  const index = questionOptionIndex(key, dialog.question.options?.length ?? 0)
  if (index === undefined) return false
  selectQuestionOption(dialog, index)
  return true
}

export type QuestionSubmit =
  | { kind: 'resolve'; selected: string[]; custom?: string }
  | { kind: 'reject' }
  | { kind: 'none' }

/**
 * What Enter means for a question dialog. Enter never answers with nothing: the
 * list opens on the first option, and that highlight is the answer for a
 * single-select list and a multi-select one alike — pressing Enter without
 * touching anything returns the option under the cursor, and Esc stays the
 * explicit cancel. Space (or a digit/letter) still builds a multi-select set,
 * and a list with no options at all answers with the typed text.
 */
export function questionSubmit(dialog: QuestionDialog, input: string): QuestionSubmit {
  const options = dialog.question.options ?? []
  const selected = [...dialog.selected]
    .map(index => options[index]?.label)
    .filter((label): label is string => label !== undefined)
  if (options.length === 0) return { kind: 'resolve', selected: [], custom: input }
  if (selected.length === 0) {
    const highlighted = options[dialog.cursor]?.label
    // The cursor is clamped to the option list, so this guards only a dialog
    // built without one; Enter must never silently answer nothing.
    if (highlighted === undefined) return { kind: 'reject' }
    return { kind: 'resolve', selected: [highlighted] }
  }
  return { kind: 'resolve', selected }
}

/** y/n/ctrl-c/esc answers for a confirm prompt. */
export function confirmAnswer(text: string): 'y' | 'n' | 'cancel' | undefined {
  if (text === 'y' || text === 'Y') return 'y'
  if (text === 'n' || text === 'N') return 'n'
  if (text === '\x03' || text === '\x1b') return 'cancel'
  return undefined
}

/** The inspect overlay closes on any of these, and ignores the rest. */
export function inspectClosesOn(text: string): boolean {
  return text === '\x1b' || text === '\x03' || text === 'q' || text === 'Q' || text === '\r' || text === '\n'
}
