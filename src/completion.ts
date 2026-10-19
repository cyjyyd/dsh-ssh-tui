/**
 * Composer-owned completion state.
 *
 * The list attached to a `/`-prefixed draft is derived state, not something the
 * painter may create while drawing a frame. This module owns the pure transitions
 * and is the only place that knows the rules; the TUI supplies the already-built
 * items (local catalog plus the Host's current list) and a previous state for
 * index/dismissal continuity.
 *
 * It performs no I/O, no Host query, no i18n and no painting. `paint()` and the
 * Composer adapter only read {@link CompletionState}.
 */
import type { CommandSuggestion } from './commands.js'

/** The three observable conditions of the list. */
export type CompletionPhase = 'hidden' | 'listed' | 'dismissed'

export interface CompletionState {
  readonly phase: CompletionPhase
  /** The exact draft these items were derived for ('' while not a slash line). */
  readonly query: string
  /** Items to paint; empty while hidden/dismissed. */
  readonly items: readonly CommandSuggestion[]
  /** Highlighted item, clamped into `items` at derivation and while moving. */
  readonly index: number
  /** The exact draft Esc or Tab dismissed; cleared when the draft changes. */
  readonly dismissedFor: string | undefined
  /** Convenience for every reader: `phase === 'listed'`. */
  readonly visible: boolean
}

export interface CompletionForInput {
  /** The current composer draft. */
  query: string
  /** Fully built suggestions for this draft (local + Host, localized). */
  items: readonly CommandSuggestion[]
  /** The previous state, used to preserve/clamp the highlight and dismissal. */
  previous?: CompletionState
  /** A Screen or Surface currently owns the keyboard; a list is not painted. */
  layerOpen?: boolean
  /** Line mode never paints and never receives completion input. */
  lineMode?: boolean
}

export const EMPTY_COMPLETION: CompletionState = Object.freeze({
  phase: 'hidden',
  query: '',
  items: [],
  index: 0,
  dismissedFor: undefined,
  visible: false,
})

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(Math.trunc(index), length - 1))
}

function hiddenState(query: string, index: number, dismissedFor: string | undefined): CompletionState {
  return {
    phase: 'hidden',
    query,
    items: [],
    index,
    dismissedFor,
    visible: false,
  }
}

/**
 * Derive the state for a draft and its items.
 *
 * The key rules are deliberately visible here, not scattered through paint:
 *
 * - only `/`-prefixed drafts, with no Screen/Surface and outside line mode, list;
 * - an exact `dismissedFor` holds until the draft changes;
 * - the highlight is clamped, never wrapped;
 * - a same-query refresh preserves the highlight; a new query starts at zero;
 * - a dismissal marker survives only while the draft is unchanged.
 */
export function completionFor(input: CompletionForInput): CompletionState {
  const query = input.query.startsWith('/') ? input.query : ''
  const previous = input.previous
  const sameQuery = previous !== undefined && previous.query === query
  const dismissedFor = sameQuery ? previous.dismissedFor : undefined
  const baseIndex = sameQuery ? previous.index : 0

  if (query === '' || input.lineMode === true || input.layerOpen === true) {
    return hiddenState(query, clampIndex(baseIndex, input.items.length), dismissedFor)
  }
  if (dismissedFor === query) {
    return {
      phase: 'dismissed',
      query,
      items: [],
      index: 0,
      dismissedFor,
      visible: false,
    }
  }
  if (input.items.length === 0) {
    return hiddenState(query, 0, dismissedFor)
  }
  return {
    phase: 'listed',
    query,
    items: [...input.items],
    index: clampIndex(baseIndex, input.items.length),
    dismissedFor,
    visible: true,
  }
}

/**
 * Move the highlight by one step, without wrapping or leaving the list.
 * Hidden/dismissed states are untouched.
 */
export function moveCompletion(state: CompletionState, delta: number): CompletionState {
  if (state.phase !== 'listed' || state.items.length === 0 || delta === 0) return state
  const next = clampIndex(state.index + delta, state.items.length)
  return next === state.index ? state : { ...state, index: next }
}

export interface CompletionAcceptance {
  /** The draft to write. */
  text: string
  /** Caret position, always at the end. */
  cursor: number
  /** The dismissed state that must replace the listed one. */
  state: CompletionState
}

/**
 * Accept the highlighted command.
 *
 * Tab accepts whatever is highlighted (today's behaviour, including a
 * contains-only item). Enter keeps the existing byte-for-byte prefix guard:
 * `/ag` → `diag` and `/HELP` → `help` must not execute. Returns undefined when
 * there is nothing to accept or Enter's guard refuses the highlight.
 */
export function acceptCompletion(
  state: CompletionState,
  draft: string,
  mode: 'tab' | 'enter',
): CompletionAcceptance | undefined {
  if (state.phase !== 'listed' || state.items.length === 0) return undefined
  const selected = state.items[clampIndex(state.index, state.items.length)]
  if (selected === undefined) return undefined
  if (mode === 'enter' && !selected.name.startsWith(draft.slice(1))) return undefined
  const text = `/${selected.name}${mode === 'tab' ? ' ' : ''}`
  return {
    text,
    cursor: text.length,
    state: {
      phase: 'dismissed',
      query: text,
      items: [],
      index: 0,
      dismissedFor: text,
      visible: false,
    },
  }
}

/** Dismiss the list for this exact draft (Esc). */
export function dismissCompletion(state: CompletionState, draft: string): CompletionState {
  if (state.phase !== 'listed') return state
  return {
    phase: 'dismissed',
    query: draft,
    items: [],
    index: 0,
    dismissedFor: draft,
    visible: false,
  }
}

/** Reset to the empty state (`/clear`, submit, session switch). */
export function resetCompletion(): CompletionState {
  return { ...EMPTY_COMPLETION, items: [] }
}
