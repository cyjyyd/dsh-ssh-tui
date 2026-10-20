/**
 * W-5B — the pure Search Screen state and matcher adapter.
 *
 * The Search Screen is a local workspace search: `rows` are the current
 * `visibleRows()` snapshot, never the durable session log. This module has no
 * terminal, Host, i18n or paint access; it owns query/hits/selection and the
 * read-only preview mode. The TUI supplies rows and revisions and renders state.
 */
import { lineModeLines } from './line-mode.js'
import { displayWidth, wrap } from './term-text.js'
import { matchTranscriptRowsFor, parseFindQuery, type FindRequest } from './plan.js'
import type { CardCategory } from './plan.js'
import type { Row } from './transcript-types.js'

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export interface SearchHit {
  readonly row: Row
  /** Position in the rows snapshot at materialization. */
  readonly ordinal: number
}

export interface SearchScreenState {
  readonly query: string
  readonly cursor: number
  readonly category: CardCategory | undefined
  readonly hits: readonly SearchHit[]
  readonly selected: number
  /** First visible result row. Wheel owns it; a selection move may reveal a row. */
  readonly listOffset: number
  readonly mode: 'list' | 'preview'
  readonly previewOffset: number
  readonly revision: number
  readonly sourceCutoff: number
  readonly notice: string | undefined
}

export interface SearchStateInput {
  readonly rows: readonly Row[]
  readonly query?: string
  readonly cursor?: number
  readonly category?: CardCategory
  readonly revision?: number
  readonly cutoff?: number
  readonly previous?: SearchScreenState
}

/** Parse a `/find …` command once; later field edits keep this category. */
export function searchRequestFor(raw: string): FindRequest {
  // Callers pass either the command argument (`tool deploy`) or the whole
  // `/find tool deploy` line; the one parse happens after removing the verb.
  const argument = raw.trim().replace(/^\/find(?:\s+|$)/u, '')
  return parseFindQuery(argument)
}

/** The one matcher adapter; it delegates to `matchTranscriptRowsFor`. */
export function searchRows(rows: readonly Row[], request: FindRequest): Row[] {
  return matchTranscriptRowsFor(rows, request)
}

function hitsFor(rows: readonly Row[], request: FindRequest): SearchHit[] {
  const matching = searchRows(rows, request)
  // Preserve the original visibleRows position. The matcher returns a filtered
  // list; its index is not the workspace ordinal the selection fallback needs.
  const hits: SearchHit[] = []
  let at = 0
  for (let ordinal = 0; ordinal < rows.length && at < matching.length; ordinal += 1) {
    if (rows[ordinal] !== matching[at]) continue
    hits.push({ row: matching[at], ordinal })
    at += 1
  }
  return hits
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1
  return Math.max(0, Math.min(Math.trunc(index), length - 1))
}

function queryOf(input: SearchStateInput): string {
  return input.query ?? input.previous?.query ?? ''
}

function categoryOf(input: SearchStateInput): CardCategory | undefined {
  return input.category ?? input.previous?.category
}

/** Materialize a state, preserving the selected row by identity when possible. */
export function searchStateFor(input: SearchStateInput): SearchScreenState {
  const query = queryOf(input)
  const cursor = Math.max(0, Math.min(input.cursor ?? query.length, query.length))
  const category = categoryOf(input)
  const hits = hitsFor(input.rows, { ...(category === undefined ? {} : { category }), query })
  const previous = input.previous
  const oldSelected = previous?.selected ?? -1
  const oldHit = previous !== undefined && oldSelected >= 0 ? previous.hits[oldSelected] : undefined
  let selected = -1
  if (hits.length > 0) {
    const identity = oldHit === undefined ? -1 : hits.findIndex(hit => hit.row === oldHit.row)
    if (identity >= 0) {
      selected = identity
    } else if (oldHit !== undefined) {
      // The selected row is gone. Pick the surviving hit nearest its original
      // workspace position, not the nearest filtered index.
      let bestDistance = Number.POSITIVE_INFINITY
      for (let index = 0; index < hits.length; index += 1) {
        const distance = Math.abs(hits[index].ordinal - oldHit.ordinal)
        if (distance < bestDistance) {
          selected = index
          bestDistance = distance
        }
      }
    } else {
      selected = hits.length - 1
    }
  }
  const listOffset = selected < 0
    ? 0
    : Math.max(0, Math.min(previous?.listOffset ?? 0, hits.length - 1))
  const mode = previous?.mode === 'preview' && selected >= 0 ? 'preview' : 'list'
  const sameSelection = oldHit !== undefined && selected >= 0 && hits[selected]?.row === oldHit.row
  return {
    query,
    cursor,
    category,
    hits,
    selected,
    listOffset,
    mode,
    previewOffset: mode === 'preview' && sameSelection ? (previous?.previewOffset ?? 0) : 0,
    revision: input.revision ?? previous?.revision ?? 0,
    sourceCutoff: input.cutoff ?? previous?.sourceCutoff ?? 0,
    notice: undefined,
  }
}

/** Edit the query field and rerun the matcher, keeping the fixed category. */
export function setSearchQuery(
  state: SearchScreenState,
  query: string,
  rows: readonly Row[],
  revision = state.revision,
  cutoff = state.sourceCutoff,
  cursor = state.cursor,
): SearchScreenState {
  return searchStateFor({
    rows,
    query,
    cursor: Math.max(0, Math.min(cursor, query.length)),
    ...(state.category === undefined ? {} : { category: state.category }),
    revision,
    cutoff,
    previous: state,
  })
}

/** Move by one result without wrapping (arrow keys). */
export function moveSearchSelection(state: SearchScreenState, delta: number): SearchScreenState {
  if (state.hits.length === 0) return state
  const selected = clampIndex(state.selected < 0 ? state.hits.length - 1 : state.selected + delta, state.hits.length)
  return selected === state.selected ? state : { ...state, selected, mode: 'list', previewOffset: 0 }
}

/** Move by one result with wrapping (Alt+n/p, Ctrl+G). */
export function cycleSearchSelection(
  state: SearchScreenState,
  delta: number,
  keepPreview = false,
): SearchScreenState {
  const count = state.hits.length
  if (count === 0) return state
  const from = state.selected < 0 ? count - 1 : state.selected
  const selected = ((from + delta) % count + count) % count
  return {
    ...state,
    selected,
    mode: keepPreview && state.mode === 'preview' ? 'preview' : 'list',
    previewOffset: 0,
  }
}

/** Move by a page without wrapping. */
export function pageSearchSelection(state: SearchScreenState, page: number, delta: number): SearchScreenState {
  if (state.hits.length === 0) return state
  const from = state.selected < 0 ? state.hits.length - 1 : state.selected
  const selected = clampIndex(from + Math.sign(delta) * Math.max(1, page), state.hits.length)
  return selected === state.selected ? state : { ...state, selected, mode: 'list', previewOffset: 0 }
}

/** The page size and the last possible first-visible row. */
function listViewport(state: SearchScreenState, page: number): { rows: number; maxOffset: number } {
  const rows = Math.max(1, Number.isFinite(page) ? Math.trunc(page) : 1)
  return { rows, maxOffset: Math.max(0, state.hits.length - rows) }
}

/** Clamp the viewport to a whole page without moving selection. */
export function clampSearchListOffset(state: SearchScreenState, page: number): SearchScreenState {
  const { maxOffset } = listViewport(state, page)
  const requested = Number.isFinite(state.listOffset) ? Math.trunc(state.listOffset) : 0
  const listOffset = Math.max(0, Math.min(requested, maxOffset))
  return listOffset === state.listOffset ? state : { ...state, listOffset }
}

/**
 * Bring the selected hit into the visible page after it moves.
 *
 * This deliberately runs on a selection transition, not on every paint: a wheel
 * may scroll the selected row out of view, and a painter that always re-revealed
 * it would make the wheel appear to do nothing. The viewport is still the one
 * `listOffset` field; this only decides its new first row.
 */
export function ensureSearchSelectionVisible(state: SearchScreenState, page: number): SearchScreenState {
  const { rows, maxOffset } = listViewport(state, page)
  const requested = Number.isFinite(state.listOffset) ? Math.trunc(state.listOffset) : 0
  let listOffset = Math.max(0, Math.min(requested, maxOffset))
  if (state.selected >= 0 && state.selected < state.hits.length) {
    if (state.selected < listOffset) listOffset = state.selected
    else if (state.selected >= listOffset + rows) listOffset = state.selected - rows + 1
    listOffset = Math.max(0, Math.min(listOffset, maxOffset))
  }
  return listOffset === state.listOffset ? state : { ...state, listOffset }
}

export function openSearchPreview(state: SearchScreenState): SearchScreenState {
  if (state.selected < 0 || state.hits.length === 0) return state
  return { ...state, mode: 'preview', previewOffset: 0 }
}

export function closeSearchPreview(state: SearchScreenState): SearchScreenState {
  return state.mode === 'preview' ? { ...state, mode: 'list', previewOffset: 0 } : state
}

/** Re-run only when the transcript revision or the visible cutoff changed. */
export function reconcileSearchHits(
  state: SearchScreenState,
  rows: readonly Row[],
  revision: number,
  cutoff: number,
): SearchScreenState {
  if (state.revision === revision && state.sourceCutoff === cutoff) return state
  return searchStateFor({
    rows,
    query: state.query,
    cursor: state.cursor,
    ...(state.category === undefined ? {} : { category: state.category }),
    revision,
    cutoff,
    previous: state,
  })
}

export function selectedSearchHit(state: SearchScreenState): SearchHit | undefined {
  return state.selected < 0 ? undefined : state.hits[state.selected]
}

/** The field text that belongs to a hit, for copy/preview. */
export function searchHitLines(hit: SearchHit): string[] {
  return lineModeLines(hit.row)
}

/** Copy text for the current list/preview selection. */
export function searchCopyText(state: SearchScreenState): string {
  const hit = selectedSearchHit(state)
  if (hit === undefined) return ''
  return searchHitLines(hit).join('\n')
}

/** Insert at the field caret and rerun the query. */
export function insertSearchText(
  state: SearchScreenState,
  text: string,
  rows: readonly Row[],
): SearchScreenState {
  const at = Math.max(0, Math.min(state.cursor, state.query.length))
  const query = `${state.query.slice(0, at)}${text}${state.query.slice(at)}`
  return setSearchQuery(state, query, rows, state.revision, state.sourceCutoff, at + text.length)
}

/** Delete the grapheme before the field caret. */
export function backspaceSearchText(
  state: SearchScreenState,
  rows: readonly Row[],
): SearchScreenState {
  if (state.cursor <= 0) return state
  const at = state.cursor
  let start = 0
  for (const segment of GRAPHEMES.segment(state.query)) {
    const end = segment.index + segment.segment.length
    if (end >= at) break
    start = end
  }
  const query = `${state.query.slice(0, start)}${state.query.slice(at)}`
  return setSearchQuery(state, query, rows, state.revision, state.sourceCutoff, start)
}

/** Delete the grapheme after the field caret. */
export function deleteSearchText(
  state: SearchScreenState,
  rows: readonly Row[],
): SearchScreenState {
  if (state.cursor >= state.query.length) return state
  const at = state.cursor
  let end = state.query.length
  for (const segment of GRAPHEMES.segment(state.query)) {
    const segmentEnd = segment.index + segment.segment.length
    if (at < segmentEnd) {
      end = segmentEnd
      break
    }
  }
  const query = `${state.query.slice(0, at)}${state.query.slice(end)}`
  return setSearchQuery(state, query, rows, state.revision, state.sourceCutoff, at)
}

/** Move the field caret by one grapheme (negative = left). */
export function moveSearchCursor(state: SearchScreenState, delta: number): SearchScreenState {
  if (delta < 0) {
    if (state.cursor <= 0) return state
    let previous = 0
    for (const segment of GRAPHEMES.segment(state.query)) {
      const end = segment.index + segment.segment.length
      if (end >= state.cursor) break
      previous = end
    }
    return { ...state, cursor: previous }
  }
  if (state.cursor >= state.query.length) return state
  for (const segment of GRAPHEMES.segment(state.query)) {
    const end = segment.index + segment.segment.length
    if (state.cursor < end) return { ...state, cursor: end }
  }
  return { ...state, cursor: state.query.length }
}

/**
 * The visible slice of the Search field and the caret's cell offset.
 *
 * The viewport is measured in terminal cells, not UTF-16 code units: a CJK
 * grapheme takes two cells, an emoji can take two, and a combining cluster is
 * one grapheme. The query itself is never sliced; only the displayed slice is.
 * The caller adds the fixed prefix width to `caretCell` to place the terminal
 * cursor.
 */
export function searchFieldViewport(
  query: string,
  cursor: number,
  availableCells: number,
): { text: string; caretCell: number } {
  const width = Math.max(1, availableCells)
  const graphemes = [...GRAPHEMES.segment(query)]
  const widths = graphemes.map(segment => displayWidth(segment.segment))
  const at = Math.max(0, Math.min(cursor, query.length))
  let cursorIndex = 0
  while (cursorIndex < graphemes.length && graphemes[cursorIndex].index + graphemes[cursorIndex].segment.length <= at) {
    cursorIndex += 1
  }
  let start = cursorIndex
  let before = 0
  while (start > 0 && before + widths[start - 1] <= width - 1) {
    before += widths[start - 1]
    start -= 1
  }
  let end = cursorIndex
  let total = before
  while (end < graphemes.length && total + widths[end] <= width) {
    total += widths[end]
    end += 1
  }
  return {
    text: graphemes.slice(start, end).map(segment => segment.segment).join(''),
    caretCell: before,
  }
}

export function setSearchCursor(state: SearchScreenState, cursor: number): SearchScreenState {
  const at = Math.max(0, Math.min(cursor, state.query.length))
  return at === state.cursor ? state : { ...state, cursor: at }
}

/** The selected hit after its logical lines have been wrapped to display lines. */
export function searchPreviewDisplayLines(hit: SearchHit, width: number): string[] {
  const inner = Math.max(1, width)
  const display: string[] = []
  for (const line of searchHitLines(hit)) {
    for (const piece of wrap(line, inner)) display.push(piece)
  }
  return display
}

/** Clamp Preview to whole pages: End leaves the final page visible, not one line. */
export function setSearchPreviewOffset(
  state: SearchScreenState,
  offset: number,
  lines: number,
  page = 1,
): SearchScreenState {
  const max = Math.max(0, lines - Math.max(1, page))
  return { ...state, previewOffset: Math.max(0, Math.min(offset, max)) }
}

