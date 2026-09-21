/**
 * Incremental ANSI paint, SSH cadence, hangup signals, and sliding windows.
 *
 * Kept off `tui.ts` so the launch picker can dirty-paint without loading
 * the agent-backed SshTui class.
 */

import { t } from './i18n/index.js'
import { lineModeEnabled } from './line-mode.js'
import { terminalCapabilities } from './terminal-caps.js'
import { padAnsiToWidth, pinEmojiCells, truncateToWidth } from './term-text.js'
import { detectSshSession, RTT_SAMPLE_TIMEOUT_MS, TerminalInputPump } from './terminal-input.js'

const RENDER_INTERVAL_MS = 160
const LOCAL_PAINT_INTERVAL_MS = 80
const MIN_PAINT_INTERVAL_MS = 40
const MAX_PAINT_INTERVAL_MS = 1000
/** Give a running turn this long to settle after cancel before we flush anyway. */
export const HANGUP_CANCEL_TIMEOUT_MS = 10_000

export type PaintLinkKind = 'local' | 'ssh'


/** In-app dialog / slash-suggestion page size. Launch picker uses 9 of its own. */
export const PICKER_WINDOW = 12

/**
 * Explicit env/config always wins. Otherwise local TTYs stay snappy and SSH
 * sessions pick a tier from a measured round-trip (CSI 6n), falling back to
 * 160 ms when the probe is missing.
 */
export function resolvePaintIntervalMs(
  configured?: number,
  env: NodeJS.ProcessEnv = process.env,
  options: { ssh?: boolean; rttMs?: number } = {},
): number {
  const raw = configured ?? Number.parseInt(env.DSH_TUI_PAINT_MS ?? '', 10)
  if (Number.isFinite(raw) && raw > 0) {
    return Math.min(MAX_PAINT_INTERVAL_MS, Math.max(MIN_PAINT_INTERVAL_MS, Math.floor(raw)))
  }
  if (options.ssh === true) return paintIntervalForRtt(options.rttMs)
  return LOCAL_PAINT_INTERVAL_MS
}

/** True when this process is attached to an SSH session (jump host / proxy). */
export { detectSshSession } from './terminal-input.js'

/** Node errno on a write/close that means the TTY is gone (SSH drop, HUP). */
export function isHangupErrno(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EIO' || code === 'EPIPE' || code === 'ENXIO' || code === 'ECONNRESET'
}

const HANGUP_SIGNAL_NAMES = ['SIGHUP', 'SIGTERM', 'SIGINT'] as const

/**
 * Replace launcher SIGTERM/SIGINT/SIGHUP handlers with `handler`. SSH drop
 * otherwise lets `dsh` dispose the whole tree before this plugin can detach.
 */
export function captureHangupSignals(handler: () => void): void {
  for (const name of HANGUP_SIGNAL_NAMES) {
    process.removeAllListeners(name)
    process.prependListener(name, handler)
  }
}

export function releaseHangupSignals(handler: () => void): void {
  for (const name of HANGUP_SIGNAL_NAMES) {
    process.removeListener(name, handler)
  }
}

/** After detach, extra HUP/TERM from sshd must not kill the leftover Host. */
export function ignoreFurtherHangupSignals(): void {
  const ignore = (): void => {}
  for (const name of HANGUP_SIGNAL_NAMES) {
    process.removeAllListeners(name)
    process.on(name, ignore)
  }
}

/**
 * Wait until `isIdle` is true or `timeoutMs` elapses. Used after cancel so a
 * hangup can flush a settled session log instead of tearing a live write.
 */
export async function waitUntilIdleOrTimeout(
  isIdle: () => boolean,
  timeoutMs: number,
  now: () => number = Date.now,
  wait: (ms: number) => Promise<void> = (ms) => new Promise(resolve => {
    setTimeout(resolve, ms)
  }),
): Promise<'idle' | 'timeout'> {
  const deadline = now() + Math.max(0, timeoutMs)
  while (!isIdle()) {
    if (now() >= deadline) return 'timeout'
    await wait(Math.min(50, Math.max(0, deadline - now())))
  }
  return 'idle'
}

/** Map a CSI-6n round-trip to a paint cadence. Unknown RTT uses the SSH default. */
export function paintIntervalForRtt(rttMs: number | undefined): number {
  if (rttMs === undefined || !Number.isFinite(rttMs) || rttMs < 0) return RENDER_INTERVAL_MS
  if (rttMs < 50) return LOCAL_PAINT_INTERVAL_MS
  if (rttMs < 150) return 160
  if (rttMs < 350) return 250
  return 400
}

export function paintLinkLabel(kind: PaintLinkKind, intervalMs: number, probed: boolean): string {
  if (kind === 'local') return t('paint.localMs', { ms: intervalMs })
  return probed ? t('paint.sshMs', { ms: intervalMs }) : t('paint.sshMsUnprobed', { ms: intervalMs })
}

export type LinkQuality = 'local' | 'good' | 'ok' | 'slow' | 'poor' | 'unknown'

/** Signal-bar quality from a measured SSH round-trip, or local TTY. */
export function linkQualityOf(kind: PaintLinkKind, rttMs: number | undefined): LinkQuality {
  if (kind === 'local') return 'local'
  if (rttMs === undefined || !Number.isFinite(rttMs) || rttMs < 0) return 'unknown'
  if (rttMs < 50) return 'good'
  if (rttMs < 150) return 'ok'
  if (rttMs < 350) return 'slow'
  return 'poor'
}

/** How many filled signal pips: 4 local/fast, 3 ok, 2 slow, 1 poor, 0 unknown. */
export function linkSignalPips(quality: LinkQuality): number {
  if (quality === 'local' || quality === 'good') return 4
  if (quality === 'ok') return 3
  if (quality === 'slow') return 2
  if (quality === 'poor') return 1
  return 0
}

/**
 * How many bytes one frame may carry before the rest waits for the next tick.
 *
 * A 100x30 full repaint costs about 3.7 kB, which on a 400ms link is a third of
 * a second of serialization the user waits through before anything moves. The
 * cadence already follows the measured RTT; the budget bounds what each of
 * those ticks may spend, so a resize or a burst of streaming output degrades
 * into a few ordered frames instead of one long freeze and a queue behind it.
 */
export const FRAME_BYTE_BUDGETS: Record<LinkQuality, number> = {
  local: Number.POSITIVE_INFINITY,
  good: 16_384,
  ok: 8_192,
  slow: 4_096,
  poor: 2_048,
  unknown: 8_192,
}

/** The per-frame byte budget for a link quality. */
export function frameByteBudget(quality: LinkQuality): number {
  return FRAME_BYTE_BUDGETS[quality] ?? Number.POSITIVE_INFINITY
}

/**
 * How many body lines an expanded card may show before it points at the
 * overlay, by link quality.
 *
 * A measured slow link is the only case that truncates: there, every body line
 * is bytes the user waits for, and the overlay is one key away (`Enter`). Fast
 * and unmeasured links keep the behavior 0.3.9 settled on — an expanded body
 * shows in full, or opens in the overlay when it cannot fit the workspace — so
 * nothing changes for a local terminal or a link whose RTT could not be probed.
 */
export const TOOL_BODY_LINES_BY_QUALITY: Record<LinkQuality, number> = {
  local: Number.POSITIVE_INFINITY,
  good: Number.POSITIVE_INFINITY,
  ok: Number.POSITIVE_INFINITY,
  slow: 6,
  poor: 3,
  unknown: Number.POSITIVE_INFINITY,
}

/** The body-line cap for a link quality; `Infinity` means "show it all". */
export function toolBodyLineLimit(quality: LinkQuality): number {
  return TOOL_BODY_LINES_BY_QUALITY[quality] ?? Number.POSITIVE_INFINITY
}

const LINK_PIP_COLOR: Record<number, string> = {
  0: '90',
  1: '31',
  2: '33',
  3: '32',
  4: '32',
}

/** Compact footer chip: `SSH ●●●○ 90ms` — 1 pip red, 2 yellow, 3+ green. */
export function formatLinkQualityChip(
  kind: PaintLinkKind,
  intervalMs: number,
  rttMs: number | undefined,
  probed: boolean,
  color = false,
): string {
  const quality = linkQualityOf(kind, probed ? rttMs : undefined)
  const filled = linkSignalPips(quality)
  const pips = `${'●'.repeat(filled)}${'○'.repeat(4 - filled)}`
  const colored = color
    ? `\x1b[${LINK_PIP_COLOR[filled] ?? '90'}m${pips}\x1b[0m`
    : pips
  if (kind === 'local') return t('paint.localChip', { pips: colored })
  const delay = probed && rttMs !== undefined && Number.isFinite(rttMs)
    ? `${Math.round(rttMs)}ms`
    : `${intervalMs}ms`
  return t('paint.sshChip', { pips: colored, delay })
}


export interface PaintOptions {
  width: number
  height: number
  paintRows: readonly string[]
  previousRows: readonly string[]
  sizeChanged: boolean
  chromeChanged: boolean
  chromeStart: number
  previousChromeStart?: number
  cursorRow: number
  cursorColumn: number
  /** Keep the cursor hidden (session picker). Default shows it on the input. */
  hideCursor?: boolean
}

export interface PaintFrame {
  /** The single stdout write for this frame. */
  output: string
  /** Row indices actually written, ascending. Only these are now up to date. */
  painted: number[]
  /** Rows that needed a paint but did not fit the byte budget. */
  deferred: number[]
  /** Highest deferred row, to pass back as `from` on the next frame. */
  resume: number | undefined
  /** Bytes this frame carried, for the ledger `/diag` and the tests read. */
  bytes: number
}

/**
 * Which dirty rows to paint first when a byte budget applies.
 *
 * Rows at or below `from` were deferred by the previous frame and go first so
 * they cannot starve; everything above is the tail the user is looking at,
 * painted newest-row-first so the input area is current even when the budget
 * runs out. Without a `from`, the order is simply tail-first.
 * @param dirty - row indices that need a paint, ascending.
 * @param from - highest row the previous frame deferred, if any.
 * @returns indices in paint order.
 */
export function paintOrder(dirty: readonly number[], from?: number): number[] {
  const descending = (values: readonly number[]): number[] => [...values].sort((left, right) => right - left)
  if (from === undefined) return descending(dirty)
  return [...descending(dirty.filter(index => index <= from)), ...descending(dirty.filter(index => index > from))]
}

/**
 * Compose one incremental paint, optionally bounded by a byte budget.
 *
 * Every row is addressed absolutely, so the paint order is free: with a budget
 * the frame spends it on the tail first and reports what it could not reach, so
 * the caller keeps those rows dirty instead of forgetting them.
 * @param options - the frame to paint, plus the budget and resume point.
 * @returns the write, what it covered, and what is left for the next tick.
 */
export function composePaintFrame(options: PaintOptions & {
  maxBytes?: number
  from?: number
}): PaintFrame {
  const { width, height, paintRows, previousRows, sizeChanged, chromeChanged, chromeStart } = options
  const previousChromeStart = options.previousChromeStart ?? chromeStart
  // When a card expands, the input box moves up. Rows that used to be
  // transcript may now be chrome (or vice versa); force-repaint from the
  // higher of the two chrome starts so leftover tool-body glyphs cannot sit
  // on the prompt.
  const dirtyChromeStart = Math.min(chromeStart, previousChromeStart)
  let out = '\x1b[?25l'
  const prev = sizeChanged ? [] : previousRows
  if (sizeChanged) out += '\x1b[H\x1b[J'
  // Never address row height+1: that scrolls the SSH viewport and leaves
  // thinking/tool/assistant glyphs sitting on the next card.
  const rowCount = Math.min(height, paintRows.length)
  const dirty: number[] = []
  for (let index = 0; index < rowCount; index += 1) {
    const current = paintRows[index] ?? ''
    if (current === prev[index] && !(chromeChanged && index >= dirtyChromeStart)) continue
    dirty.push(index)
  }
  const budgeted = options.maxBytes !== undefined && Number.isFinite(options.maxBytes)
  // Without a budget the order stays ascending, byte for byte what the
  // unbudgeted painter always wrote.
  const order = budgeted ? paintOrder(dirty, options.from) : [...dirty].sort((left, right) => left - right)
  const limit = options.maxBytes ?? Number.POSITIVE_INFINITY
  const painted: number[] = []
  const deferred: number[] = []
  let rows = ''
  let used = out.length
  for (const index of order) {
    // Pin first, then pad: the padder measures with `visibleWidth`, which does
    // not know that a symbol like ⚠ will gain a variation selector and a
    // reserving space. Padding the unpinned form and pinning afterwards pushed
    // rows that reach the right edge two cells past the terminal.
    const clipped = padAnsiToWidth(pinEmojiCells(paintRows[index] ?? ''), width)
    const row = `\x1b[${index + 1};1H\x1b[0m\x1b[2K${clipped}\x1b[0m`
    // Always paint one row, however small the budget: a frame that draws
    // nothing would leave the terminal stale for as long as the burst lasts.
    if (painted.length > 0 && used + row.length > limit) {
      deferred.push(index)
      continue
    }
    rows += row
    used += row.length
    painted.push(index)
  }
  if (rowCount < height && (sizeChanged || previousRows.length !== paintRows.length)) {
    rows += `\x1b[${rowCount + 1};1H\x1b[J`
  }
  painted.sort((left, right) => left - right)
  const paintedAny = painted.length > 0 || sizeChanged
  if (!paintedAny && options.hideCursor === true) {
    return { output: '', painted, deferred, resume: undefined, bytes: 0 }
  }
  if (rows !== '') {
    // DECAWM off for the row batch. A glyph the width table under-counts (a
    // terminal drawing some emoji wider than wcwidth says) then loses its
    // last cell instead of wrapping onto the row below and punching through
    // the next card. Rows are addressed individually, so auto-wrap is never
    // needed here.
    out += `\x1b[?7l${rows}\x1b[?7h`
  }
  out += '\x1b[0m'
  if (options.hideCursor !== true) {
    const cursorRow = Math.min(height, Math.max(1, options.cursorRow))
    // Column `width + 1` (and writing into the last cell then parking past
    // it) trips DEC auto-margin: the hardware cursor wraps onto the next
    // row and the caret punches through the last glyph. Keep the caret on
    // this row, in a real cell.
    const cursorColumn = Math.min(width, Math.max(1, options.cursorColumn))
    out += `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`
  }
  return {
    output: out,
    painted,
    deferred,
    resume: deferred.length === 0 ? undefined : Math.max(...deferred),
    bytes: out.length,
  }
}

/**
 * The snapshot for the next frame: only the rows a frame painted become clean.
 *
 * A deferred row has to keep its previous content in the snapshot, or the next
 * frame would compare it against itself, call it unchanged, and never paint it:
 * the row would simply stay wrong. The array also keeps its old length while
 * anything is owed, so the "row count changed" clear keeps firing until the
 * frame is complete.
 * @param previous - the snapshot the frame painted against.
 * @param current - the rows the frame wanted to show.
 * @param painted - indices the frame actually wrote.
 * @returns the snapshot to hand to the next frame.
 */
export function advancePaintedRows(
  previous: readonly string[],
  current: readonly string[],
  painted: readonly number[],
): string[] {
  const next = previous.slice()
  for (const index of painted) {
    if (index < next.length) next[index] = current[index] ?? ''
  }
  return next
}

/** One incremental paint as a single stdout write (one SSH packet when corked). */
export function composePaintOutput(options: PaintOptions): string {
  return composePaintFrame(options).output
}

/** Whether `text` could still grow into a recognized escape sequence. */
export function isEscapePrefix(text: string): boolean {
  if (text === '\x1b') return true
  if (!text.startsWith('\x1b')) return false
  if (text === '\x1b[') return true
  if (text === '\x1bO' || /^\x1bO[A-Z]?$/u.test(text)) return true
  if (/^\x1b\[[A-D]$/u.test(text)) return true
  if (/^\x1b\[[HF]$/u.test(text)) return true
  if (/^\x1b\[\d+~?$/u.test(text)) return true
  if (/^\x1b\[\d+(?:;\d+)?R?$/u.test(text)) return true
  if (/^\x1b\[<(?:\d*;?)*[Mm]?$/u.test(text)) return true
  if (/^\x1b\[\d+(?:;\d+)*u?$/u.test(text)) return true
  return false
}

/** Parse a Device Status Report cursor reply (`CSI row;col R`). */
export function parseCursorPositionReply(text: string): { row: number; column: number } | undefined {
  const match = /^\x1b\[(\d+);(\d+)R$/u.exec(text)
  if (match === null) return undefined
  return { row: Number(match[1]), column: Number(match[2]) }
}

/**
 * Find a cursor reply inside a noisy buffer.
 *
 * The anchored parse above only works when the CPR is the whole chunk. Real
 * terminals interleave it with focus events, mouse reports, bracketed-paste
 * marks or keystrokes that raced the probe, and an anchored match then fails
 * until the probe times out — which is how the footer's link chip ends up
 * stuck on four hollow circles (`SSH ○○○○`) for a whole session.
 */
export function findCursorPositionReply(text: string): { row: number; column: number } | undefined {
  const match = /\x1b\[(\d+);(\d+)R/u.exec(text)
  if (match === null) return undefined
  return { row: Number(match[1]), column: Number(match[2]) }
}

/**
 * Round-trip to the attached terminal via CSI 6n. Returns undefined when the
 * reply never arrives (dumb pipe, blocked DSR). Does not interpret the
 * coordinates — only the elapsed milliseconds matter.
 *
 * Sampling and plausibility live in `terminal-input.ts`: a single request used
 * to accept a previous probe's answer (~2 ms) and to report a repaint queue as
 * the link (~1900 ms on a 50 ms SSH line).
 */
export async function probeTerminalRttMs(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = RTT_SAMPLE_TIMEOUT_MS,
  ssh = detectSshSession(),
): Promise<number | undefined> {
  if (!stdin.isTTY || !stdout.isTTY) return undefined
  const pump = new TerminalInputPump({
    stdin,
    stdout,
    onInput: () => {},
    ssh,
    sampleTimeoutMs: timeoutMs,
  })
  pump.start()
  try {
    return await pump.measure()
  } finally {
    pump.stop()
  }
}

/** Sliding window of `windowSize` items that keeps `cursor` visible. */
export function pickerWindowStart(cursor: number, total: number, windowSize = PICKER_WINDOW): number {
  if (total <= windowSize) return 0
  const maxStart = Math.max(0, total - windowSize)
  const start = cursor - Math.floor((windowSize - 1) / 2)
  return Math.max(0, Math.min(maxStart, start))
}

/**
 * Immediate first-frame chrome so a 2–3s Host boot is not a blank TTY.
 *
 * Line mode gets nothing: a splash enters the alternate screen and paints over
 * itself, which is exactly what that mode exists to avoid — the log would open
 * with screen control instead of the session's first event.
 * @param message - what the launcher is waiting for.
 * @param color - whether colour is allowed.
 */
export function writeBootSplash(message: string, color = true): void {
  if (lineModeEnabled()) return
  const width = Math.max(20, process.stdout.columns || 80)
  const title = t('boot.banner')
  const line = color
    ? `\x1b[1m${truncateToWidth(title, width)}\x1b[0m`
    : truncateToWidth(title, width)
  const detail = color
    ? `\x1b[36m${truncateToWidth(message, width)}\x1b[0m`
    : truncateToWidth(message, width)
  // The capability table, not the raw switch: a Linux virtual console has no
  // alternate screen to return to, and entering one there costs the scrollback
  // the user navigates with.
  const useAlt = terminalCapabilities().alternateScreen
  try {
    process.stdout.write(`${useAlt ? '\x1b[?1049h' : ''}\x1b[?25l\x1b[H\x1b[J${pinEmojiCells(line)}\n${'─'.repeat(width)}\n${pinEmojiCells(detail)}\n`)
  } catch {
    // TTY may already be gone.
  }
}

