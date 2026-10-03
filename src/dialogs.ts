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
  /**
   * Called whenever the highlighted option moves.
   *
   * The theme picker uses it to paint the candidate palette immediately, so the
   * choice is a preview rather than a list of names — the reader sees the
   * transcript in the palette before committing to it. Nothing else sets it, and
   * a dialog without it behaves exactly as before.
   */
  onCursor?: (cursor: number) => void
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

/**
 * @deprecated Superseded by a Screen (`ScreenState`, `kind: 'setup'`) in B2.6.
 *
 * Kept as a *shape* so 0.8.x does not break an importer that names the type: nothing
 * in this plugin constructs one any more, and the wizard has no dialog path left to
 * reach it through. A dialog handed to the dialog path is still rejected as a
 * question rather than silently queued.
 */
export interface OnboardingDialog {
  kind: 'onboarding'
}

/**
 * @deprecated Superseded by `ScreenState` (`screen.ts`) in B2.1.
 *
 * Kept as a *shape* rather than a dialog so the single judgement entry
 * (`screenFromDialog`) can recognise one if it is ever handed to the dialog path,
 * and so 0.8.x does not break an importer that names the type. Nothing in this
 * plugin constructs one any more: every caller opens a Screen.
 */
export interface InspectDialog {
  kind: 'inspect'
  title: string
  lines: DiffDisplayLine[]
  offset: number
  /** Child session whose live log should refresh this overlay in place. */
  subagentSessionId?: string
  /** `/find` already scrolled to its hit here; later repaints keep the offset. */
  searchRevealed?: boolean
  /**
   * What the copy key takes while this overlay is up.
   *
   * The reader asked to see this body full-screen, so the body is what they
   * mean by "copy this" — the overlay has no input line, and `/copy` typed at
   * the prompt is covered by it. Undefined falls back to whatever is selected
   * behind the overlay, which is the card the reader opened to get here.
   */
  copyText?: string
  /**
   * Confirmation line shown in place of the key hint after an in-overlay copy.
   *
   * The notice row the copy also pushes is behind this screen, and silence after
   * a clipboard write is the one thing that reads as a failure.
   */
  notice?: string
}

/**
 * A dialog that owns the keyboard for the length of one human action.
 *
 * Deliberately does **not** include the inspect shape: since B2.1 an inspect body
 * is a *Screen*, not a dialog — it replaces the workspace instead of borrowing rows
 * from it, and it never enters `dialogQueue` (`screenFromDialog` converts the legacy
 * shape, and `docs/decisions/b2-architecture-decisions.md` AD-1…AD-3 freeze why).
 */
export type Dialog = ConfirmDialog | QuestionDialog | OnboardingDialog

/**
 * The dialogs the *live* dialog path can actually receive.
 *
 * `OnboardingDialog` is in the union only for 0.8.x importers; the wizard is a Screen
 * now, so the queue, the role and the painter only ever see these two (B2.6 §17).
 */
export type SurfaceDialog = Extract<Dialog, { kind: 'confirm' | 'questions' }>

/** Whether this is a dialog the live path can own (see {@link SurfaceDialog}). */
export function isSurfaceDialog(dialog: Dialog): dialog is SurfaceDialog {
  return dialog.kind === 'confirm' || dialog.kind === 'questions'
}

/**
 * What kind of human action a surface is asking for.
 *
 * The dialog *shape* deliberately does not say this: `/model` and
 * `ask_user_question` both open a `questions` dialog, and the two mean opposite
 * things — one changes the operating environment, the other is the task stopping
 * to wait for a person. Reading the shape as the meaning is what made the status
 * row claim the agent was waiting while a picker was open, and call an approval
 * idle. The opener declares the role instead.
 */
export type InteractionKind = 'question' | 'plan-review' | 'approval' | 'confirm'

/**
 * Who owns the keyboard, and what that means for the task.
 *
 * - `interaction` — the agent (or the action the reader asked for) is blocked on a
 *   human decision, and only `ask` distinguishes the three that stall a turn from
 *   a confirmation that blocks a local command;
 * - `picker` — control plane: it changes the environment and leaves the agent
 *   exactly as busy or idle as it already was.
 *
 * There used to be a third, `dedicated`, for "a surface with the whole screen and its
 * own state machine". B2.6 gave the two things that meant — the inspect overlay and
 * the setup wizard — the Screen contract instead, and with no producer left the role
 * was removed rather than kept as a path nothing could reach.
 */
export type SurfaceRole =
  | { kind: 'interaction'; ask: InteractionKind }
  | { kind: 'picker' }

/** The roles as values, so no call site invents its own object. */
export const PICKER_ROLE: SurfaceRole = { kind: 'picker' }
export function interactionRole(ask: InteractionKind): SurfaceRole {
  return { kind: 'interaction', ask }
}

/**
 * Whether a role means the task is stopped waiting for the human.
 *
 * A local `confirm` (deleting a preset, repairing the profile) owns the keyboard
 * too, but the agent is not waiting on it — reporting it as a wait is the same
 * class of mistake as reporting a picker as one.
 */
export function stallsTask(role: SurfaceRole | undefined): boolean {
  return role?.kind === 'interaction' && role.ask !== 'confirm'
}

/**
 * Which surface gets the keyboard first when more than one is waiting (B1.2).
 *
 * Only one transient surface is ever drawn, so this is not a z-order: it decides
 * who is *next in line*. A task interaction outranks a picker (someone is blocked on
 * it, and the agent cannot proceed), and a picker outranks whatever the reader was
 * about to type. Equal ranks keep their arrival order, so a queue of two pickers
 * still behaves exactly as it did before.
 *
 * A Screen is not in this ordering at all: it is not a surface (B2.6 §1).
 */
export function surfacePriority(role: SurfaceRole): number {
  return role.kind === 'interaction' ? 1 : 0
}

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
  dialog.onCursor?.(dialog.cursor)
  if (dialog.question.multiSelect !== true) {
    dialog.selected.clear()
    dialog.selected.add(dialog.cursor)
  }
  return true
}

/**
 * Which options a fresh question dialog starts with.
 *
 * The rule that caused a real mis-answer: a **multi-select** list used to inherit
 * the single-select default of "the first option is already chosen", so a reader
 * who moved the highlight to the row they wanted and pressed Enter answered with
 * the first row instead — the `●` never left it. A multi-select starts empty
 * unless the caller asks for a specific preselection; `questionSubmit` then falls
 * back to the highlighted row, which is what pressing Enter means.
 * @param question - the question being asked.
 * @param preselected - an index the caller wants chosen up front, if any.
 * @returns the indexes to select initially.
 */
export function initialQuestionSelection(
  question: AskUserQuestionItem,
  preselected?: number,
): number[] {
  const count = question.options?.length ?? 0
  if (count === 0) return []
  const wanted = preselected !== undefined && preselected >= 0 && preselected < count ? preselected : undefined
  if (question.multiSelect === true) return wanted === undefined ? [] : [wanted]
  return [wanted ?? 0]
}

/**
 * The circle drawn beside one option.
 *
 * `●` marks **what Enter will submit**, which is why it sits on the highlighted
 * row while nothing is ticked — the mark follows the cursor, so what the reader
 * sees is what the answer will be. A ticked row in a multi-select list carries
 * `✓` instead: several rows can be chosen at once, and the circle cannot be in
 * two places without lying about one of them.
 * @param dialog - the open question dialog.
 * @param index - the option index being drawn.
 * @returns the marker for that row.
 */
export function questionOptionMarker(dialog: QuestionDialog, index: number): '●' | '○' | '✓' {
  const toggled = dialog.selected.has(index)
  if (dialog.question.multiSelect !== true) return index === dialog.cursor ? '●' : '○'
  if (toggled) return '✓'
  return index === dialog.cursor && dialog.selected.size === 0 ? '●' : '○'
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

/**
 * Fit an interaction's rendered lines into the rows the frame can give it.
 *
 * The interaction layer is composed *over* the transcript (see `paintFrame`), and
 * the space above the composer is whatever the terminal has left after the footer,
 * the composer and the header. On a short terminal that can be fewer rows than a
 * question list needs — and clipping the *bottom* would hide the options and the
 * key hint, which is exactly the part that has to stay reachable. So the window
 * keeps the focused row visible and marks what it dropped.
 *
 * @param lines - the interaction as its renderer drew it, top to bottom.
 * @param cap - how many rows the frame has for it.
 * @param focusLine - index of the row that must stay visible (the highlighted
 *   option, or the prompt when there is no list).
 * @returns the rows to place, top to bottom, at most `cap` of them.
 */
export function windowInteractionLines(
  lines: readonly string[],
  cap: number,
  focusLine?: number,
): { lines: string[]; hiddenAbove: number; hiddenBelow: number } {
  if (cap <= 0) return { lines: [], hiddenAbove: lines.length, hiddenBelow: 0 }
  if (lines.length <= cap) return { lines: [...lines], hiddenAbove: 0, hiddenBelow: 0 }
  // One row is spent on the "there is more" marker, so the reader can tell a
  // clipped list from a short one.
  const room = Math.max(1, cap - 1)
  // The last line is the key hint: it is what says how to answer, so it is kept
  // even when the window has to drop the middle of the interaction. Only when
  // doing so would leave no room for the focused row does it go.
  const tail = lines[lines.length - 1]
  const keepTail = lines.length > 1 && room >= 3 && (focusLine ?? 0) < lines.length - 1
  const body = keepTail ? lines.slice(0, -1) : lines
  const rows = keepTail ? room - 1 : room
  const focus = Math.max(0, Math.min(body.length - 1, focusLine ?? body.length - 1))
  let start = Math.max(0, Math.min(body.length - rows, focus - Math.floor(rows / 2)))
  // The focus must be inside the window whatever the centring worked out to.
  if (focus < start) start = focus
  if (focus >= start + rows) start = focus - rows + 1
  start = Math.max(0, Math.min(start, body.length - rows))
  const kept = body.slice(start, start + rows)
  const hiddenAbove = start
  const hiddenBelow = body.length - start - rows
  return {
    lines: [`… ${hiddenAbove + hiddenBelow}`, ...kept, ...(keepTail ? [tail] : [])],
    hiddenAbove,
    hiddenBelow,
  }
}
