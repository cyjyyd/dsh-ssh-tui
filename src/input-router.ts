/**
 * The InputRouter: one unit in, exactly one owner out.
 *
 * W-1 taught the TUI *what arrived* (`InputFrame`). This module answers the other
 * question — *who takes it* — and it is the only place that may. The four owners
 * (Screen, Surface, Composer, Workspace) each have an adapter in `tui.ts`; an
 * adapter may read its own state, but it may not decide cross-owner ownership
 * again, and it may not hand a unit on to the next owner when it does not use it
 * (AD-20 §4.3, §4.5 F-1/F-6).
 *
 * The decision is a pure function of `(unit kind, unit, ownership snapshot)`: no
 * app state is read or written, nothing is painted, no transcript row is pushed,
 * and the snapshot is a plain object the caller keeps and overwrites, so a
 * keystroke costs no allocation (W-2 is a hot-path migration).
 *
 * The rules are the ones `tui.ts` already applied inline, moved here verbatim —
 * including two asymmetries that are **recorded debt, not decisions**:
 *
 *   1. `Ctrl+L` is handled by the Screen when a Screen is up and by the Composer
 *      otherwise; the repaint has two implementations and W-2 does not merge them
 *      (AD-20 §6: only a test that proves both owners repaint identically may).
 *   2. With a Surface up, `Home`/`End`/`Delete`/kitty-`Ctrl+Shift+C` still reach the
 *      composer today (`SURFACE_COMPOSER_KEYS`). That is the same class of leak W-0
 *      found behind Screens, now written down where W-3 can see it — preserving it
 *      is what keeps this round free of behaviour changes.
 *
 * @module dsh-ssh-tui/input-router
 */

/** Who takes a unit. Exactly one of these, per unit, decided here. */
export type Owner = 'screen' | 'surface' | 'composer' | 'workspace'

/**
 * The unit classes the ladder dispatches.
 *
 * `text` and `control` are the composer's own shapes, `sequence` is a complete
 * CSI/SS3 unit, `paste` is a payload with its markers already off, and `escape` is
 * the released lone Escape. `burst` frames never reach this module as a whole: the
 * ladder types them character by character, so every character is routed on its own
 * (which is also what lets a Surface answer `y` and the composer take the `es`).
 */
export type UnitKind = 'text' | 'control' | 'sequence' | 'paste' | 'escape'

/** The read-only ownership state a decision may look at. */
export interface OwnershipSnapshot {
  /** The Screen that is up, if any (its kind, for reports). */
  screenKind: string | undefined
  /** The Surface (dialog) that is up, if any. */
  surfaceKind: string | undefined
  /** …and whether that Surface owns a borrowed text field. */
  surfaceHasField: boolean
  /** The composer's field is empty — the focus ring's precondition. */
  composerEmpty: boolean
  /** The transcript has collapsible cards — the focus ring's other precondition. */
  workspaceCards: boolean
}

const PAGE_UP = '\x1b[5~'
const PAGE_DOWN = '\x1b[6~'
const ARROW_UP = '\x1b[A'
const ARROW_DOWN = '\x1b[B'
const SGR_MOUSE = /^\x1b\[<\d+;\d+;\d+[Mm]$/u

/**
 * Units that still reach the Composer while a Surface is up (recorded debt, W-3).
 *
 * Home/End move the hidden draft's caret, `Delete` edits it, and the kitty copy
 * sequence copies from the transcript. None of them belongs to a Surface; all three
 * are what the ladder does today, and W-2 preserves them. W-3 decides whether they
 * should be dropped at the Surface boundary instead.
 */
const SURFACE_COMPOSER_KEYS = /^(?:\x1b\[[HF]|\x1b\[1~|\x1b\[4~|\x1b\[3~|\x1b\[99;6u)$/u

export class InputRouter {
  /** The one cross-owner decision. One unit in, one owner out. */
  route(kind: UnitKind, unit: string, view: OwnershipSnapshot): Owner {
    // A Screen replaces the workspace and owns the keyboard outright (AD-20 §4.3,
    // priority 3). This single line is why no Screen event can reach the composer
    // behind it: the owners below are never consulted.
    if (view.screenKind !== undefined) return 'screen'
    // Paste is text: the field that owns the keyboard takes it. A Screen already
    // terminated the paste above (it does not fall through to a field behind it), and
    // a Surface without a field refuses it in its own adapter — the decision is still
    // "the Surface", never the composer behind it (AD-20 §4.3, priority 1).
    if (kind === 'paste') return view.surfaceKind !== undefined ? 'surface' : 'composer'
    // A Surface owns everything except the two recorded asymmetries above.
    if (view.surfaceKind !== undefined) {
      if (kind === 'control' && unit === '\x0c') return 'composer'
      if (kind === 'sequence' && SURFACE_COMPOSER_KEYS.test(unit)) return 'composer'
      return 'surface'
    }
    return this.composerOrWorkspace(kind, unit, view)
  }

  /**
   * With nothing layered over the workspace, the Composer owns text and its editing
   * keys, and the Workspace owns the transcript: the mouse, the page keys, and the
   * focus ring — which an arrow reaches only while the field is empty and there is a
   * card to land on (otherwise the same arrow browses history, and history is the
   * composer's).
   */
  private composerOrWorkspace(kind: UnitKind, unit: string, view: OwnershipSnapshot): Owner {
    if (kind !== 'sequence') return 'composer'
    if (SGR_MOUSE.test(unit)) return 'workspace'
    if (unit === PAGE_UP || unit === PAGE_DOWN) return 'workspace'
    if (unit === ARROW_UP || unit === ARROW_DOWN) {
      return view.composerEmpty && view.workspaceCards ? 'workspace' : 'composer'
    }
    return 'composer'
  }
}
