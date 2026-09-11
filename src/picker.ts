/**
 * Startup history-session picker: a raw-mode selector shown BEFORE the main
 * TUI mounts, so launching without an explicit session id lands on a choice
 * instead of a fresh main screen.
 *
 * Reading is lazy. The first page is inspected up front and only then painted,
 * so nothing on screen is a raw id waiting to turn into a title; older sessions
 * are read only when the user reaches for them — pressing past the last row, or
 * filtering, which has to look deeper than the rows on screen. The visible page
 * is always nine rows so digits 1-9 map onto every on-screen item.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import {
  formatSessionTime,
  openResumableSessionPager,
  PICKER_PAGE_SIZE,
  type ResumableSession,
  type ResumableSessionPage,
  type ResumableSessionPager,
} from './session-list.js'
import { composePaintOutput, isEscapePrefix, pickerWindowStart } from './paint.js'
import { truncateToWidth } from './term-text.js'
import { TerminalInputGuard } from './terminal-input.js'
import { t } from './i18n/index.js'

/** What the launch picker decided. */
export type SessionPickerResult =
  | { kind: 'resume'; id: string }
  | { kind: 'attach'; id: string; sock: string }
  | { kind: 'new' }
  | null

/**
 * Visible rows in the sliding window. Locked to nine so every on-screen
 * session has a 1-9 shortcut; remaining history is reached with ↑/↓ / filter.
 */
export const SESSION_PICKER_WINDOW = 9

/** Digit shortcuts into the current window when the filter is empty. */
export const PICKER_QUICK_KEYS = '123456789'

/** Mutable picker UI state. */
export interface SessionPickerState {
  sessions: ResumableSession[]
  query: string
  cursor: number
  /**
   * When true, digits type into the filter instead of acting as 1-9 / 0
   * shortcuts. Set automatically by the first letter, or by `/` / Ctrl+F.
   */
  filterActive: boolean
  /** A page is being read right now (the first one, or a lazy load). */
  loading?: boolean
  /** Sessions in history that have not been read yet. */
  more?: number
}

/** One key / control action against {@link SessionPickerState}. */
export type SessionPickerAction =
  | { type: 'move'; delta: number }
  | { type: 'page'; delta: number }
  | { type: 'home' }
  | { type: 'end' }
  | { type: 'type'; text: string }
  | { type: 'backspace' }
  | { type: 'clearQuery' }
  | { type: 'startFilter' }
  | { type: 'quick'; key: string }
  | { type: 'submit' }
  | { type: 'new' }
  | { type: 'escape' }
  | { type: 'cancel' }

/** Result of applying one action: keep going, or the picker is done. */
export type SessionPickerStep =
  | { kind: 'continue'; state: SessionPickerState }
  | { kind: 'done'; result: SessionPickerResult }

/** Haystack used by the filter: title, id, cwd, and a live pid when attached. */
export function sessionSearchHaystack(session: ResumableSession): string {
  const parts = [session.label, session.id, session.cwd]
  if (session.attach !== undefined) {
    parts.push(String(session.attach.pid), 'pid')
  }
  return parts.join('\n').toLowerCase()
}

/** Whether one session matches a whitespace-separated query (every token). */
export function sessionMatchesQuery(session: ResumableSession, query: string): boolean {
  const tokens = query.trim().toLowerCase().split(/\s+/u).filter(token => token !== '')
  if (tokens.length === 0) return true
  const haystack = sessionSearchHaystack(session)
  return tokens.every(token => haystack.includes(token))
}

/** Sessions still visible under the current filter, in list order. */
export function filterResumableSessions(
  sessions: readonly ResumableSession[],
  query: string,
): ResumableSession[] {
  if (query.trim() === '') return [...sessions]
  return sessions.filter(session => sessionMatchesQuery(session, query))
}

/** Keep `cursor` inside `[0, total)`. Empty lists pin to 0. */
export function clampPickerCursor(cursor: number, total: number): number {
  if (total <= 0) return 0
  return Math.max(0, Math.min(total - 1, cursor))
}

/**
 * How many session rows to show. Prefer a full page of nine so 1-9 always
 * map onto every on-screen item. Shrink only when the tty cannot fit that
 * page (title + filter + nine items + hints).
 */
export function pickerCapacity(rows: number): number {
  const chrome = 7
  const perItem = 2
  const available = Math.max(0, rows - chrome)
  return Math.max(1, Math.min(SESSION_PICKER_WINDOW, Math.floor(available / perItem)))
}

/** Whether two picker states would paint the same frame. */
export function pickerStateUnchanged(previous: SessionPickerState, next: SessionPickerState): boolean {
  return previous.query === next.query
    && previous.cursor === next.cursor
    && previous.filterActive === next.filterActive
    && previous.sessions === next.sessions
    && previous.loading === next.loading
    && previous.more === next.more
}

/**
 * Whether this input asked for sessions the picker has not read yet.
 *
 * Older history is read lazily, so the trigger matters: while filtering, a page
 * that leaves fewer matches than fit on screen is deepened (a search has to look
 * past the rows on screen); otherwise the user has to press past the last loaded
 * row — pressing Down at the end, PageDown, or End — before older sessions are
 * read.
 */
export function pickerWantsMorePage(input: {
  previous: Pick<SessionPickerState, 'sessions' | 'cursor' | 'query' | 'filterActive'>
  next: Pick<SessionPickerState, 'sessions' | 'cursor' | 'query' | 'filterActive'>
  actions: readonly SessionPickerAction[]
  more: number
  windowSize?: number
}): boolean {
  if (input.more <= 0) return false
  const windowSize = input.windowSize ?? SESSION_PICKER_WINDOW
  const nextFiltered = filterResumableSessions(input.next.sessions, input.next.query)
  const filtering = input.next.filterActive || input.next.query !== ''
  const downward = input.actions.some(action =>
    action.type === 'end'
    || (action.type === 'move' && action.delta > 0)
    || (action.type === 'page' && action.delta > 0))
  const atEnd = (state: Pick<SessionPickerState, 'cursor'>, filtered: readonly ResumableSession[]): boolean =>
    filtered.length > 0 && state.cursor >= filtered.length - 1

  if (filtering) {
    // A search has to look past the rows on screen: while it has fewer matches
    // than fit, keep reading. With a full page of matches it reads on only when
    // the user asks for more — a press at the end of the matches, or End.
    if (nextFiltered.length < windowSize) return true
    return downward && atEnd(input.next, nextFiltered)
  }
  if (nextFiltered.length === 0) {
    // Nothing to show yet (the pager never returns a short page on purpose, so
    // this is the first load): keep reading instead of pretending history is
    // over.
    return true
  }
  if (!atEnd(input.next, nextFiltered)) return false
  const previousFiltered = filterResumableSessions(input.previous.sessions, input.previous.query)
  const wasAtEnd = atEnd(input.previous, previousFiltered)
  // End is explicit ("show me the end"); otherwise the keypress only counts
  // when the cursor was already parked on the last loaded row.
  return input.actions.some(action => action.type === 'end') || (wasAtEnd && downward)
}

function resultFor(session: ResumableSession): SessionPickerResult {
  return session.attach === undefined
    ? { kind: 'resume', id: session.id }
    : { kind: 'attach', id: session.id, sock: session.attach.sock }
}

function continueWith(state: SessionPickerState): SessionPickerStep {
  return { kind: 'continue', state }
}

function dropLastCodePoint(text: string): string {
  const points = Array.from(text)
  points.pop()
  return points.join('')
}

function retainCursor(previousId: string | undefined, filtered: readonly ResumableSession[], fallback: number): number {
  if (previousId !== undefined) {
    const kept = filtered.findIndex(session => session.id === previousId)
    if (kept >= 0) return kept
  }
  return clampPickerCursor(fallback, filtered.length)
}

/**
 * Apply one picker action. Pure: the TTY layer maps keystrokes onto this, and
 * tests drive it without stdin.
 */
export function stepPicker(
  state: SessionPickerState,
  action: SessionPickerAction,
  windowSize = SESSION_PICKER_WINDOW,
): SessionPickerStep {
  const filtered = filterResumableSessions(state.sessions, state.query)
  const focused = filtered[state.cursor]
  switch (action.type) {
    case 'move': {
      const cursor = clampPickerCursor(state.cursor + action.delta, filtered.length)
      if (cursor === state.cursor) return continueWith(state)
      return continueWith({ ...state, cursor })
    }
    case 'page': {
      const cursor = clampPickerCursor(state.cursor + action.delta * Math.max(1, windowSize), filtered.length)
      if (cursor === state.cursor) return continueWith(state)
      return continueWith({ ...state, cursor })
    }
    case 'home': {
      if (state.cursor === 0) return continueWith(state)
      return continueWith({ ...state, cursor: 0 })
    }
    case 'end': {
      const cursor = Math.max(0, filtered.length - 1)
      if (cursor === state.cursor) return continueWith(state)
      return continueWith({ ...state, cursor })
    }
    case 'type': {
      if (action.text === '') return continueWith(state)
      const query = `${state.query}${action.text}`
      const next = filterResumableSessions(state.sessions, query)
      return continueWith({
        ...state,
        query,
        filterActive: true,
        cursor: retainCursor(focused?.id, next, 0),
      })
    }
    case 'backspace': {
      if (state.query === '' && !state.filterActive) return continueWith(state)
      if (state.query === '') {
        return continueWith({ ...state, filterActive: false })
      }
      const query = dropLastCodePoint(state.query)
      const next = filterResumableSessions(state.sessions, query)
      return continueWith({
        ...state,
        query,
        filterActive: query !== '',
        cursor: retainCursor(focused?.id, next, state.cursor),
      })
    }
    case 'clearQuery': {
      if (state.query === '' && !state.filterActive) return continueWith(state)
      return continueWith({
        ...state,
        query: '',
        filterActive: false,
        cursor: retainCursor(focused?.id, state.sessions, state.cursor),
      })
    }
    case 'startFilter':
      if (state.filterActive) return continueWith(state)
      return continueWith({ ...state, filterActive: true })
    case 'quick': {
      if (state.filterActive || state.query !== '') {
        return stepPicker(state, { type: 'type', text: action.key }, windowSize)
      }
      const index = PICKER_QUICK_KEYS.indexOf(action.key)
      if (index < 0) return continueWith(state)
      const start = pickerWindowStart(state.cursor, filtered.length, windowSize)
      const session = filtered[start + index]
      if (session === undefined) return continueWith(state)
      return { kind: 'done', result: resultFor(session) }
    }
    case 'submit': {
      const session = filtered[state.cursor]
      if (session === undefined) return continueWith(state)
      return { kind: 'done', result: resultFor(session) }
    }
    case 'new':
      return { kind: 'done', result: { kind: 'new' } }
    case 'escape':
      if (state.query !== '' || state.filterActive) {
        return stepPicker(state, { type: 'clearQuery' }, windowSize)
      }
      return { kind: 'done', result: null }
    case 'cancel':
      return { kind: 'done', result: null }
  }
}

/** Map one decoded stdin chunk (or a complete CSI sequence) to actions. */
export function actionsForInput(
  text: string,
  state: Pick<SessionPickerState, 'query' | 'filterActive'> = { query: '', filterActive: false },
): SessionPickerAction[] {
  if (
    text === '\x1b[A'
    || text === '\x1bOA'
    || text === '\x10'
  ) {
    return [{ type: 'move', delta: -1 }]
  }
  if (
    text === '\x1b[B'
    || text === '\x1bOB'
    || text === '\x0e'
  ) {
    return [{ type: 'move', delta: 1 }]
  }
  if (text === '\x1b[5~') return [{ type: 'page', delta: -1 }]
  if (text === '\x1b[6~') return [{ type: 'page', delta: 1 }]
  if (text === '\x1b[H' || text === '\x1b[1~') return [{ type: 'home' }]
  if (text === '\x1b[F' || text === '\x1b[4~') return [{ type: 'end' }]
  if (text === '\x1b' || text === '\x03') return [{ type: text === '\x03' ? 'cancel' : 'escape' }]
  if (text.startsWith('\x1b')) return []

  const filtering = state.filterActive || state.query !== ''
  const actions: SessionPickerAction[] = []
  for (const char of text) {
    if (char === '\x03') {
      actions.push({ type: 'cancel' })
      continue
    }
    if (char === '\x1b') {
      actions.push({ type: 'escape' })
      continue
    }
    if (char === '\r' || char === '\n') {
      actions.push({ type: 'submit' })
      continue
    }
    if (char === '\x7f' || char === '\x08') {
      actions.push({ type: 'backspace' })
      continue
    }
    if (char === '\x15' || char === '\x17') {
      actions.push({ type: 'clearQuery' })
      continue
    }
    if (char === '\x10') {
      actions.push({ type: 'move', delta: -1 })
      continue
    }
    if (char === '\x0e') {
      actions.push({ type: 'move', delta: 1 })
      continue
    }
    if (char === '\x06') {
      actions.push({ type: 'startFilter' })
      continue
    }
    if (char === '/' && !filtering) {
      actions.push({ type: 'startFilter' })
      continue
    }
    if (char === '0' && !filtering) {
      actions.push({ type: 'new' })
      continue
    }
    if (char >= '1' && char <= '9' && !filtering) {
      actions.push({ type: 'quick', key: char })
      continue
    }
    if (char >= ' ' && char !== '\x7f') {
      actions.push({ type: 'type', text: char })
    }
  }
  return actions
}

/** Split a decoded stdin chunk into CSI/SS3 sequences and individual characters. */
export function splitPickerInput(text: string): string[] {
  const units: string[] = []
  let index = 0
  while (index < text.length) {
    if (text[index] !== '\x1b') {
      units.push(text[index] ?? '')
      index += 1
      continue
    }
    const rest = text.slice(index)
    const sequence = /^(?:\x1b\[[A-DHF]|\x1b\[[1-6]~|\x1bO[A-D]|\x1b)/u.exec(rest)?.[0]
    if (sequence === undefined) {
      units.push('\x1b')
      index += 1
      continue
    }
    units.push(sequence)
    index += sequence.length
  }
  return units
}

/**
 * Feed a decoded stdin chunk through the picker. CSI / SS3 sequences are one
 * unit; ordinary text is applied character by character so a pasted "fix 2"
 * types the digit instead of treating it as a 1-9 shortcut.
 */
export function feedPicker(
  state: SessionPickerState,
  text: string,
  windowSize = SESSION_PICKER_WINDOW,
  onAction?: (action: SessionPickerAction) => void,
): SessionPickerStep {
  let current = state
  for (const unit of splitPickerInput(text)) {
    for (const action of actionsForInput(unit, current)) {
      onAction?.(action)
      const step = stepPicker(current, action, windowSize)
      if (step.kind === 'done') return step
      current = step.state
    }
  }
  return continueWith(current)
}

/**
 * Show the picker and wait for a selection, a new-session request, or cancel.
 * Restores the terminal before resolving; an AbortSignal cancels as well.
 * @param ctx - boot context supplying sessionPersistence.
 * @param color - whether to apply ANSI colors.
 * @param signal - optional abort signal (fiber dispose) to cancel the picker.
 * @returns the selection, or null when cancelled.
 */
/** Injection seams for tests; production uses the TTY and the session index. */
export interface SessionPickerOptions {
  stdin?: NodeJS.ReadStream
  stdout?: NodeJS.WriteStream
  openPager?: typeof openResumableSessionPager
}

export async function showSessionPicker(
  ctx: Context,
  color: boolean,
  signal?: AbortSignal,
  options: SessionPickerOptions = {},
): Promise<SessionPickerResult> {
  if (signal?.aborted) return null

  const stdin = options.stdin ?? process.stdin
  const stdout = options.stdout ?? process.stdout
  const openPager = options.openPager ?? openResumableSessionPager
  const useAltScreen = process.env.DSH_TUI_NO_ALT_SCREEN !== '1'
    && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
  const decoder = new StringDecoder('utf8')
  stdin.setRawMode(true)
  stdin.resume()
  stdout.write(`${useAltScreen ? '\x1b[?1049h' : ''}\x1b[?25l`)

  const style = (text: string, code: string): string => color ? `\x1b[${code}m${text}\x1b[0m` : text
  let state: SessionPickerState = { sessions: [], query: '', cursor: 0, filterActive: false, loading: true }
  let previousRows: string[] = []
  let previousWidth = 0
  let previousHeight = 0
  /**
   * Settled pickers must never paint again: the launcher process keeps owning
   * the TTY as the display relay, so a leaked frame would overwrite the TUI on
   * every later terminal resize.
   */
  let done = false

  const paintLines = (width: number, height: number): string[] => {
    const windowSize = pickerCapacity(height)
    const filtered = filterResumableSessions(state.sessions, state.query)
    const start = pickerWindowStart(state.cursor, filtered.length, windowSize)
    const end = Math.min(filtered.length, start + windowSize)
    const lines: string[] = [
      style(truncateToWidth(t('picker.title'), width), '1'),
      '─'.repeat(width),
    ]
    const filtering = state.filterActive || state.query !== ''
    const filterLine = !filtering
      ? t('picker.filterHint')
      : t('picker.filter', { query: state.query === '' ? '▌' : `${state.query}▌` })
    lines.push(style(truncateToWidth(filterLine, width), filtering ? '36' : '90'))
    const more = state.more ?? 0
    lines.push(style(truncateToWidth(t('picker.count', {
      shown: filtered.length,
      total: state.sessions.length,
    }) + (more > 0 ? t('picker.countMore', { count: more }) : '')
      + (state.loading === true ? t('picker.loading') : ''), width), '90'))
    if (filtered.length === 0) {
      // An empty list with history still unread is "loading", never "there is
      // nothing": the pager reads on by itself until it has a row or the
      // history is over.
      const empty = state.loading === true || more > 0
        ? t('picker.loadingList')
        : state.query === ''
          ? t('picker.noneYet')
          : t('picker.noMatch', { query: state.query })
      lines.push(style(truncateToWidth(empty, width), '33'))
    } else {
      if (start > 0) {
        lines.push(style(truncateToWidth(t('picker.moreAbove', { count: start }), width), '90'))
      }
      for (let index = start; index < end; index += 1) {
        const session = filtered[index]
        if (session === undefined) continue
        const quick = PICKER_QUICK_KEYS[index - start]
        const focused = index === state.cursor
        const marker = focused ? '›' : ' '
        const key = quick ?? ' '
        const label = `${marker}${key}  ${session.label}`
        lines.push(style(truncateToWidth(label, width), focused ? '1;7' : '1'))
        const attachNote = session.attach === undefined
          ? ''
          : t('picker.attachable', {
            pid: session.attach.pid,
            status: session.attach.state === 'running-detached'
              ? t('picker.attachRunning')
              : t('picker.attachPaused'),
          })
        const meta = `${session.unreadable === true ? t('resume.unreadable') : ''}${formatSessionTime(session.updatedAt)} · ${session.cwd}`
        if (attachNote !== '') {
          lines.push(`   ${style(truncateToWidth(attachNote, Math.max(1, width - 3)), '32')}`)
        }
        lines.push(`   ${style(truncateToWidth(meta, Math.max(1, width - 3)), '90')}`)
      }
      if (end < filtered.length) {
        lines.push(style(truncateToWidth(t('picker.moreBelow', { count: filtered.length - end }), width), '90'))
      } else if (more > 0) {
        // Everything read is on screen: say how to reach the rest instead of
        // reading it now. Filtering looks deeper on its own (see `pump`).
        lines.push(style(truncateToWidth(t('picker.loadMore', { count: more }), width), '90'))
      }
    }
    lines.push('')
    lines.push(style(truncateToWidth(filtering ? t('picker.hintFilter') : t('picker.hint'), width), '36'))
    lines.push(filtering
      ? `${style('Esc', '36')}  ${t('picker.cancel')}`
      : `${style('0', '36')}  ${t('picker.new')} · ${style('Esc', '36')}  ${t('picker.cancel')}`)
    return lines
  }

  const render = (force = false): void => {
    if (done) return
    const width = Math.max(20, stdout.columns || 80)
    const height = Math.max(12, stdout.rows || 24)
    const paintRows = paintLines(width, height)
    const sizeChanged = force || width !== previousWidth || height !== previousHeight
    const frame = composePaintOutput({
      width,
      height,
      paintRows,
      previousRows,
      sizeChanged,
      chromeChanged: false,
      chromeStart: paintRows.length,
      cursorRow: 1,
      cursorColumn: 1,
      hideCursor: true,
    })
    if (frame !== '') stdout.write(frame)
    previousRows = paintRows
    previousWidth = width
    previousHeight = height
  }
  /** Named so cleanup() can remove this exact listener, not a look-alike. */
  const onResize = (): void => { render(true) }

  return new Promise<SessionPickerResult>((resolve) => {
    let pager: ResumableSessionPager | undefined
    let pageInFlight = false
    let escapeBuffer = ''
    // A cursor reply that outlived its probe would otherwise be typed into the
    // filter as `[17;1R` and empty the list with a query nobody wrote.
    const inputGuard = new TerminalInputGuard(text => handleKeys(text))
    let escapeTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (result: SessionPickerResult): void => {
      if (done) return
      done = true
      if (escapeTimer !== undefined) clearTimeout(escapeTimer)
      inputGuard.stop()
      signal?.removeEventListener('abort', onAbort)
      stdin.removeListener('data', onData)
      stdout.removeListener('resize', onResize)
      try {
        stdin.setRawMode(false)
      } catch {
        // The stream may already be closed during shutdown; restoring is best-effort.
      }
      stdin.pause()
      try {
        stdout.write(`\x1b[0m\x1b[?25h${useAltScreen ? '\x1b[?1049l' : ''}\n`)
      } catch {
        // The TTY may already be gone (EPIPE/ERR_STREAM_DESTROYED).
      }
      resolve(result)
    }
    const onAbort = (): void => {
      cleanup(null)
    }
    const applyChunk = (text: string): void => {
      const windowSize = pickerCapacity(Math.max(12, stdout.rows || 24))
      const previous = state
      const actions: SessionPickerAction[] = []
      const step = feedPicker(state, text, windowSize, action => actions.push(action))
      if (step.kind === 'done') {
        cleanup(step.result)
        return
      }
      state = step.state
      if (done) return
      // Held ↑/↓ at the ends used to ED2-clear the whole screen every repeat.
      if (pickerStateUnchanged(previous, state)) {
        pump(actions, previous)
        return
      }
      render()
      pump(actions, previous)
    }
    const onData = (chunk: Buffer): void => {
      const decoded = decoder.write(chunk)
      if (decoded !== '') inputGuard.push(decoded)
    }
    /** One decoded read, replies already removed. */
    const handleKeys = (text: string): void => {
      const combined = escapeBuffer + text
      escapeBuffer = ''
      if (escapeTimer !== undefined) {
        clearTimeout(escapeTimer)
        escapeTimer = undefined
      }

      if (
        /^\x1b\[[A-DHF]$/u.test(combined)
        || /^\x1b\[[1-6]~$/u.test(combined)
        || /^\x1bO[A-D]$/u.test(combined)
      ) {
        applyChunk(combined)
        return
      }

      if (isEscapePrefix(combined)) {
        escapeBuffer = combined
        escapeTimer = setTimeout(() => {
          escapeTimer = undefined
          const pending = escapeBuffer
          escapeBuffer = ''
          applyChunk(pending)
        }, 60)
        return
      }

      if (combined.startsWith('\x1b')) {
        // Unknown / complete escape sequence — ignore rather than cancel.
        return
      }

      applyChunk(combined)
    }
    if (signal?.aborted) {
      cleanup(null)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      stdin.on('data', onData)
      stdout.on('resize', onResize)
      render(true)
    } catch (error) {
      // A dying TTY can throw mid-setup (EPIPE). Without this the listeners
      // would outlive the picker and repaint it over the TUI, which is the
      // exact leak this handler pairing exists to prevent.
      cleanup(null)
      throw error
    }
    /** Paint a page: replace the loaded rows and keep the cursor on its row. */
    const applyPage = (page: ResumableSessionPage): void => {
      // A page is steady by contract (every label resolved); hold back a
      // placeholder anyway, so a future reader cannot put a raw id on screen
      // that turns into a title a moment later.
      const ready = page.sessions.filter(session => session.labelPending !== true)
      const focusedId = filterResumableSessions(state.sessions, state.query)[state.cursor]?.id
      const nextFiltered = filterResumableSessions(ready, state.query)
      state = {
        ...state,
        sessions: ready,
        loading: false,
        more: page.remaining,
        cursor: retainCursor(focusedId, nextFiltered, state.cursor),
      }
      render()
    }
    const loadPage = async (): Promise<void> => {
      if (done || pager === undefined || pageInFlight) return
      pageInFlight = true
      state = { ...state, loading: true }
      render()
      try {
        const page = await pager.page(PICKER_PAGE_SIZE)
        pageInFlight = false
        if (done) return
        applyPage(page)
        // A filter that still has fewer matches than fit on screen keeps
        // deepening; a plain page load stops here until the user asks again.
        pump([], state)
      } catch {
        // A read that failed must not leave the picker stuck on "loading…".
        pageInFlight = false
        if (done) return
        state = { ...state, loading: false, more: 0 }
        render()
      }
    }
    /**
     * The one place that decides to read more history. Called after every
     * applied input and after every page; `pickerWantsMorePage` holds the rule.
     */
    const pump = (actions: readonly SessionPickerAction[], previous: SessionPickerState): void => {
      if (done || pager === undefined) return
      const more = state.more ?? 0
      if (more <= 0) return
      if (!pickerWantsMorePage({ previous, next: state, actions, more })) return
      void loadPage()
    }
    const startListing = async (): Promise<void> => {
      let persistence = ctx.get('sessionPersistence')
      if (persistence === undefined) {
        await ctx.get('loader')?.await()
        if (done || signal?.aborted) return
        persistence = ctx.get('sessionPersistence')
      }
      if (persistence === undefined) {
        process.stderr.write(t('picker.noPersistence'))
        cleanup({ kind: 'new' })
        return
      }
      pager = await openPager(persistence, '')
      if (done || signal?.aborted) return
      // The first page is read in full before anything is painted: every row
      // on screen carries its real title, and no id is ever shown and then
      // replaced a moment later.
      const first = await pager.page(PICKER_PAGE_SIZE)
      if (done || signal?.aborted) return
      if (first.sessions.length === 0) {
        if (first.done) {
          cleanup({ kind: 'new' })
          stdout.write(t('picker.none'))
          return
        }
        // Rows exist but none is showable yet: keep reading rather than telling
        // the user their history is empty (and starting a fresh session).
        applyPage(first)
        void loadPage()
        return
      }
      applyPage(first)
    }
    void startListing().catch(() => {
      if (!done) cleanup({ kind: 'new' })
    })
  })
}
