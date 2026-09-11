/**
 * Startup history-session picker: a raw-mode selector shown BEFORE the main
 * TUI mounts, so launching without an explicit session id lands on a choice
 * instead of a fresh main screen.
 *
 * The list itself is not capped. The visible page is always nine rows so
 * digits 1-9 map onto every on-screen item. Arrow keys move a highlight,
 * typing filters by title / id / cwd, and Enter confirms the focused row.
 */

import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { formatSessionTime, listResumableSessionsProgressive, type ResumableSession } from './session-list.js'
import { composePaintOutput, isEscapePrefix, pickerWindowStart } from './paint.js'
import { truncateToWidth } from './term-text.js'
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
  /** Older logs are still being inspected in the background. */
  loading?: boolean
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
): SessionPickerStep {
  let current = state
  for (const unit of splitPickerInput(text)) {
    for (const action of actionsForInput(unit, current)) {
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
  listSessions?: typeof listResumableSessionsProgressive
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
  const listSessions = options.listSessions ?? listResumableSessionsProgressive
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
  /** Whether a listing with titles has been painted at least once. */
  let listPainted = false
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
    lines.push(style(truncateToWidth(t('picker.count', {
      shown: filtered.length,
      total: state.sessions.length,
    }) + (state.loading === true ? t('picker.loading') : ''), width), '90'))
    if (filtered.length === 0) {
      const empty = state.loading === true
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
    let escapeBuffer = ''
    let escapeTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = (result: SessionPickerResult): void => {
      if (done) return
      done = true
      if (escapeTimer !== undefined) clearTimeout(escapeTimer)
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
      const step = feedPicker(state, text, windowSize)
      if (step.kind === 'done') {
        cleanup(step.result)
        return
      }
      state = step.state
      if (done) return
      // Held ↑/↓ at the ends used to ED2-clear the whole screen every repeat.
      if (pickerStateUnchanged(previous, state)) return
      render()
    }
    const onData = (chunk: Buffer): void => {
      const combined = escapeBuffer + decoder.write(chunk)
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
    const applyListing = (
      listing: { sessions: ResumableSession[]; pending: boolean },
      final = false,
    ): void => {
      if (done) return
      // The first listing is a header sketch: a live Host is labelled with its
      // raw session id until its log has been inspected, and painting that
      // frame makes the user pick an id they cannot recognise (it reads as "a
      // session I did not ask for" jumping into the list). Hold the entries —
      // the loading line keeps the spot — until titles exist, but always paint
      // the final listing so an all-untitled history stays selectable.
      if (!listPainted && !final && !listing.sessions.some(session => session.label !== session.id)) return
      listPainted = true
      const focusedId = filterResumableSessions(state.sessions, state.query)[state.cursor]?.id
      const nextFiltered = filterResumableSessions(listing.sessions, state.query)
      state = {
        ...state,
        sessions: listing.sessions,
        loading: listing.pending,
        cursor: retainCursor(focusedId, nextFiltered, state.cursor),
      }
      render()
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
      const listing = await listSessions(persistence, '', {
        onUpdate: applyListing,
      })
      if (done) return
      if (listing.complete.length === 0 && state.query === '') {
        cleanup({ kind: 'new' })
        stdout.write(t('picker.none'))
        return
      }
      applyListing({ sessions: listing.complete, pending: false }, true)
    }
    void startListing().catch(() => {
      if (!done) cleanup({ kind: 'new' })
    })
  })
}
