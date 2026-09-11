/**
 * Transcript row storage and the window the paint loop shows.
 *
 * `tui.ts` keeps the row array (many call sites read it) but the operations that
 * have rules — bounding memory, finding the card a tool result belongs to,
 * merging repeated calls, choosing which slice of the transcript is on screen —
 * live here, where they can be tested without a terminal or an agent.
 */
import { planIsLive } from './plan.js'
import { canMergeToolCall, TOOL_FLIP_MS } from './tool-present.js'
import type { PlanTodoItem, Row, ToolDiffHunk } from './transcript-types.js'

type ToolRow = Extract<Row, { kind: 'tool' }>
type PlanRow = Extract<Row, { kind: 'plan' }>

/** Long sessions keep the newest rows; older ones are dropped from the front. */
export const MAX_TRANSCRIPT_ROWS = 5000

/**
 * Drop the oldest rows past `max` and report how many went. The caller owns the
 * things that point at rows (the focused card, clickable maps), so they can be
 * invalidated with that count.
 */
export function boundTranscriptRows(rows: Row[], max = MAX_TRANSCRIPT_ROWS): number {
  if (rows.length <= max) return 0
  const removed = rows.length - max
  rows.splice(0, removed)
  return removed
}

export function findToolRowByCallId(rows: readonly Row[], callId: string): ToolRow | undefined {
  return rows.findLast((candidate): candidate is ToolRow =>
    candidate.kind === 'tool'
    && (candidate.callId === callId || candidate.mergedCallIds?.includes(callId) === true))
}

/** The card a repeated call of the same tool should merge into, if any. */
export function findMergeableToolRow(rows: readonly Row[], next: { name: string; args: string }): ToolRow | undefined {
  const previous = rows.findLast((candidate): candidate is ToolRow => candidate.kind === 'tool')
  return canMergeToolCall(previous, next) ? previous : undefined
}

/**
 * Fold a repeated call into the card that is already on screen: the card grows
 * a repeat mark and starts over as `running`. `now` is passed in so the flip
 * animation is testable.
 */
export function mergeToolCard(
  previous: ToolRow,
  next: {
    callId: string
    name: string
    args: string
    title: string
    summary: string
    diff?: ToolDiffHunk[]
  },
  now: number,
  replaying = false,
): void {
  const ids = previous.mergedCallIds ?? [previous.callId]
  if (!ids.includes(previous.callId)) ids.push(previous.callId)
  if (!ids.includes(next.callId)) ids.push(next.callId)
  previous.mergedCallIds = ids
  previous.callId = next.callId
  previous.name = next.name
  previous.args = next.args
  if (next.title !== '') previous.title = next.title
  if (next.summary !== '') previous.summary = next.summary
  if (next.diff !== undefined && next.diff.length > 0) {
    previous.diff = (previous.repeats ?? 1) > 1 && previous.diff !== undefined && previous.diff.length > 0
      ? [...previous.diff, ...next.diff]
      : next.diff
  }
  previous.status = 'running'
  previous.output = ''
  previous.exitCode = undefined
  previous.signal = undefined
  previous.repeats = (previous.repeats ?? 1) + 1
  if (!replaying) previous.flipUntil = now + TOOL_FLIP_MS
}

export function findLivePlanRow(rows: readonly Row[]): PlanRow | undefined {
  return rows.findLast((row): row is PlanRow => row.kind === 'plan' && planIsLive(row))
}

/** Whether the plan card should open on its own when it has work left. */
export function planShouldDefaultExpand(plan: { active?: boolean; pending?: boolean; todos: readonly PlanTodoItem[] }): boolean {
  return plan.active === true
    || plan.pending === true
    || plan.todos.some(item => item.status === 'in_progress')
}

/** Older / finished plans stay in the scrolling transcript, greyed out. */
export function archiveStalePlans(rows: readonly Row[], keep?: PlanRow): void {
  for (const row of rows) {
    if (row.kind !== 'plan' || row === keep) continue
    if (row.archived === true) continue
    row.archived = true
    row.active = false
    row.pending = false
    row.expanded = false
  }
}

export interface TranscriptWindow<T> {
  /** Index of the first transcript line on screen; a fresh window means a repaint. */
  start: number
  /** Clamped scroll offset; the caller stores it back for the next paint. */
  scrollOffset: number
  visibleLines: string[]
  visibleRefs: (T | undefined)[]
  /** Blank lines added above so a short transcript sits against the chrome. */
  padding: number
}

/**
 * Pick the slice of the transcript the terminal shows.
 *
 * `available` is the row budget the chrome left over; `reveal` is a row a fresh
 * message wants on screen, which wins over the current scroll position. A
 * transcript shorter than the budget is padded at the top so the prompt stays
 * at the bottom instead of floating in the middle of the screen.
 */
export function windowTranscript<T>(input: {
  lines: readonly string[]
  refs: readonly (T | undefined)[]
  available: number
  scrollOffset: number
  reveal?: T | undefined
}): TranscriptWindow<T> {
  const { lines, refs } = input
  const available = Math.max(0, input.available)
  let scrollOffset = Math.max(0, input.scrollOffset)
  const reveal = input.reveal
  if (reveal !== undefined) {
    const first = refs.findIndex(ref => ref === reveal)
    if (first !== -1) {
      scrollOffset = Math.max(0, lines.length - available - first)
    }
  }
  const maxOffset = Math.max(0, lines.length - available)
  if (scrollOffset > maxOffset) scrollOffset = maxOffset
  const start = Math.max(0, lines.length - available - scrollOffset)
  const visibleLines = lines.slice(start, start + available)
  const visibleRefs = refs.slice(start, start + available)
  const padding = Math.max(0, available - visibleLines.length)
  for (let index = 0; index < padding; index++) {
    visibleLines.unshift('')
    visibleRefs.unshift(undefined)
  }
  return { start, scrollOffset, visibleLines, visibleRefs, padding }
}
