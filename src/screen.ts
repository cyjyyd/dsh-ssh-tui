/**
 * The Screen contract: a whole-view surface with its own navigation state.
 *
 * A **Surface** (ask-user, a picker) borrows a few rows of the workspace and gives
 * them back when the action is done: the transcript behind it never moves, and
 * the reader returns to the same place. A **Screen** is the other thing entirely —
 * it replaces the workspace, owns its own scrolling, and must be able to redraw
 * itself from its state alone (a reattach after an SSH drop is a normal event, not
 * an edge case). See `docs/decisions/b2-architecture-decisions.md` (AD-1 … AD-3).
 *
 * Depth is exactly one: a Screen may hold tabs, sections and detail modes of its
 * own, but it never pushes another Screen. Nothing here allocates a stack, and
 * nothing here renders — this module is the contract, `tui.ts` is the renderer.
 */
import type { Dialog, InspectDialog } from './dialogs.js'
import type { DiffDisplayLine } from './tool-present.js'

/**
 * Which Screen is up. Adding one here is the only way to add one at all.
 *
 * `setup` is the odd one: it draws no body of its own — the wizard's rows are built
 * from its state machine every frame — but it is a Screen in every other sense. It
 * owns the whole view, it owns its input, it never enters the dialog queue, and it is
 * rebuilt from state after a reattach (B2.6).
 */
export type ScreenKind = 'inspect' | 'report' | 'setup'

/** The report a `report` Screen is showing. */
export type ReportKind = 'status' | 'usage' | 'diag' | 'doctor' | 'help' | 'subagents'

/**
 * A Screen's whole state.
 *
 * Everything the renderer needs is here on purpose: nothing about the picture
 * lives only in the paint loop, which is what makes a reattach able to rebuild the
 * same screen, and what makes the screen testable without a terminal. `offset` is
 * the first visible body row — the Screen's own scroll position, unrelated to the
 * transcript's `scrollOffset` behind it.
 */
export interface ScreenState {
  kind: ScreenKind
  /** Title row. */
  title: string
  /** Body, already rendered for the width it will be shown at. */
  lines: readonly DiffDisplayLine[]
  /** First visible body row. */
  offset: number
  /** Which report this is, when `kind === 'report'`. */
  report?: ReportKind
  /** What the copy key takes while this screen is up. */
  copyText?: string
  /**
   * A confirmation line shown in place of the navigation hint.
   *
   * Used by an in-screen copy ("copied 412 chars") and by a Screen's own action
   * (the doctor repair result): the row the action would otherwise push is behind
   * this screen, and silence after an action reads as a failure.
   */
  notice?: string
  /** Child session whose live log refreshes this screen in place. */
  subagentSessionId?: string
  /** `/find` already scrolled to its hit here; later repaints keep the offset. */
  searchRevealed?: boolean
}

/**
 * The one judgement: is this dialog a Screen?
 *
 * A Screen is *not* a dialog — it never enters `dialogQueue`, is never replaced by
 * a Surface and never blocks one. This function exists so that no future call site
 * has to remember that: a screen-shaped dialog handed to the dialog path is
 * converted here and handed to the Screen path instead, and a test pins it.
 *
 * Returns `undefined` for the surfaces that genuinely are dialogs (questions,
 * confirms, the onboarding wizard).
 */
export function screenFromDialog(dialog: Dialog | InspectDialog): ScreenState | undefined {
  if (dialog.kind !== 'inspect') return undefined
  const inspect: InspectDialog = dialog
  return {
    kind: 'inspect',
    title: inspect.title,
    lines: inspect.lines,
    offset: inspect.offset,
    ...(inspect.copyText === undefined ? {} : { copyText: inspect.copyText }),
    ...(inspect.notice === undefined ? {} : { notice: inspect.notice }),
    ...(inspect.subagentSessionId === undefined ? {} : { subagentSessionId: inspect.subagentSessionId }),
    ...(inspect.searchRevealed === undefined ? {} : { searchRevealed: inspect.searchRevealed }),
  }
}

/**
 * The row kind a report falls back to where there is no frame to draw on.
 *
 * Line mode has no Screen (and no way to dismiss one), so `/diag` and `/doctor`
 * keep their own copyable `diag` rows there — which is also where they are read
 * from in a transcript (`/copy error` looks for `error` or `diag`).
 */
export function reportRowKind(report: ReportKind): 'diag' | 'system' {
  return report === 'diag' || report === 'doctor' ? 'diag' : 'system'
}

/** The rows a Screen lays out, top to bottom. */
export interface ScreenLayout {
  /** 1 when the title row is drawn. */
  titleRows: number
  /** 1 when the rule under the title is drawn. */
  dividerRows: number
  /** Rows available to the body; may be 0 on a terminal that short. */
  bodyRows: number
  /** 1 when the navigation hint row is drawn. */
  hintRows: number
  /** 1 when the compact runtime strip is drawn. */
  stripRows: number
  /** 0-based index of the first body row in the painted frame. */
  contentTop: number
  /** 0-based index of the hint row, or -1 when it is not drawn. */
  hintTop: number
  /** 0-based index of the strip row, or -1 when it is not drawn. */
  stripTop: number
}

/**
 * Lay a Screen out for the height the terminal has.
 *
 * The strip is the one row that never goes: a Screen is a place the reader can be
 * *while the agent keeps working*, and "is it still running, is anything waiting,
 * is the link alive" has to be answerable without leaving. After that the order
 * gives up the least load-bearing row first — the rule under the title, then the
 * title, then body rows — and the navigation hint goes only when there is nothing
 * left to navigate. Measured at 8 / 12 / 20 rows in the Screen contract tests.
 */
export function screenLayout(height: number): ScreenLayout {
  const h = Math.max(0, Math.floor(height))
  if (h <= 0) {
    return { titleRows: 0, dividerRows: 0, bodyRows: 0, hintRows: 0, stripRows: 0, contentTop: 0, hintTop: -1, stripTop: -1 }
  }
  if (h === 1) {
    return { titleRows: 0, dividerRows: 0, bodyRows: 0, hintRows: 0, stripRows: 1, contentTop: 0, hintTop: -1, stripTop: 0 }
  }
  // Two rows: the strip plus the hint. The reader can still leave, and still see
  // that the session is alive, which is the whole reason both survive.
  if (h === 2) {
    return { titleRows: 0, dividerRows: 0, bodyRows: 0, hintRows: 1, stripRows: 1, contentTop: 0, hintTop: 0, stripTop: 1 }
  }
  if (h === 3) {
    return { titleRows: 0, dividerRows: 0, bodyRows: 1, hintRows: 1, stripRows: 1, contentTop: 0, hintTop: 1, stripTop: 2 }
  }
  if (h === 4) {
    // The title arrives before the rule: knowing which screen this is beats a
    // second horizontal line.
    return { titleRows: 1, dividerRows: 0, bodyRows: 1, hintRows: 1, stripRows: 1, contentTop: 1, hintTop: 2, stripTop: 3 }
  }
  return {
    titleRows: 1,
    dividerRows: 1,
    bodyRows: h - 4,
    hintRows: 1,
    stripRows: 1,
    contentTop: 2,
    hintTop: h - 2,
    stripTop: h - 1,
  }
}

/**
 * Clamp a Screen's scroll offset to its body.
 *
 * The body can be shorter than the last offset the reader scrolled to (a resize, a
 * shorter report, a live subagent log that was replaced), and an offset past the
 * end paints an empty screen with a position readout that lies.
 */
export function clampScreenOffset(offset: number, lineCount: number, bodyRows: number): number {
  const max = Math.max(0, lineCount - Math.max(1, bodyRows))
  if (!Number.isFinite(offset)) return 0
  return Math.max(0, Math.min(Math.floor(offset), max))
}

/**
 * `1–18/64`, the position readout a Screen's footer shows.
 *
 * Zero lines reads `0/0` rather than `1–0/0`: the second looks like a bug in the
 * readout instead of an empty report.
 */
export function screenPositionText(offset: number, lineCount: number, bodyRows: number): string {
  if (lineCount <= 0) return '0/0'
  const from = Math.min(offset + 1, lineCount)
  const to = Math.min(lineCount, offset + Math.max(1, bodyRows))
  return `${from}–${to}/${lineCount}`
}
