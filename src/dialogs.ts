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

/** Move the question highlight, clamped to its options. Returns false if not a question dialog. */
export function moveQuestionCursor(dialog: QuestionDialog, delta: number): boolean {
  const count = dialog.question.options?.length ?? 0
  if (count === 0) return false
  dialog.cursor = Math.max(0, Math.min(count - 1, dialog.cursor + delta))
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
 * What Enter means for a question dialog. A single-select list with nothing
 * highlighted cancels (the user must not accidentally answer with the first
 * option); a multi-select list may answer with an empty selection. With no
 * options at all, the typed text is the answer.
 */
export function questionSubmit(dialog: QuestionDialog, input: string): QuestionSubmit {
  const options = dialog.question.options ?? []
  const selected = [...dialog.selected]
    .map(index => options[index]?.label)
    .filter((label): label is string => label !== undefined)
  if (selected.length === 0 && options.length > 0 && dialog.question.multiSelect !== true) {
    return { kind: 'reject' }
  }
  if (options.length === 0) return { kind: 'resolve', selected: [], custom: input }
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
