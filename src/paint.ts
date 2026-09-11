/**
 * Incremental ANSI paint, SSH cadence, hangup signals, and sliding windows.
 *
 * Kept off `tui.ts` so the launch picker can dirty-paint without loading
 * the agent-backed SshTui class.
 */

import { t } from './i18n/index.js'
import { padAnsiToWidth, truncateToWidth } from './term-text.js'

const RENDER_INTERVAL_MS = 160
const LOCAL_PAINT_INTERVAL_MS = 80
const MIN_PAINT_INTERVAL_MS = 40
const MAX_PAINT_INTERVAL_MS = 1000
export const DSR_PROBE_TIMEOUT_MS = 800
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
export function detectSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
}

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


/** One incremental paint as a single stdout write (one SSH packet when corked). */
export function composePaintOutput(options: {
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
}): string {
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
  let painted = sizeChanged
  let rows = ''
  for (let i = 0; i < rowCount; i++) {
    const current = paintRows[i] ?? ''
    if (current === prev[i] && !(chromeChanged && i >= dirtyChromeStart)) continue
    painted = true
    const clipped = padAnsiToWidth(current, width)
    // EL2 *before* the glyphs, from column 1. A full-width write followed
    // by EL hits DEC auto-margin: the cursor wraps, and EL then blanks the
    // next card instead of the row we just drew.
    rows += `\x1b[${i + 1};1H\x1b[0m\x1b[2K${clipped}\x1b[0m`
  }
  if (rowCount < height && (sizeChanged || previousRows.length !== paintRows.length)) {
    painted = true
    rows += `\x1b[${rowCount + 1};1H\x1b[J`
  }
  if (!painted && options.hideCursor === true) return ''
  if (rows !== '') {
    // DECAWM off for the row batch. A glyph the width table under-counts (a
    // terminal drawing some emoji wider than wcwidth says) then loses its
    // last cell instead of wrapping onto the row below and punching through
    // the next card. Rows are addressed individually, so auto-wrap is never
    // needed here.
    out += `\x1b[?7l${rows}\x1b[?7h`
  }
  out += '\x1b[0m'
  if (options.hideCursor === true) return out
  const cursorRow = Math.min(height, Math.max(1, options.cursorRow))
  // Column `width + 1` (and writing into the last cell then parking past
  // it) trips DEC auto-margin: the hardware cursor wraps onto the next
  // row and the caret punches through the last glyph. Keep the caret on
  // this row, in a real cell.
  const cursorColumn = Math.min(width, Math.max(1, options.cursorColumn))
  out += `\x1b[${cursorRow};${cursorColumn}H\x1b[?25h`
  return out
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

/** Keep only the tail of a probe buffer so a chatty TTY cannot grow it forever. */
const PROBE_BUFFER_TAIL = 64

/**
 * Round-trip to the attached terminal via CSI 6n. Returns undefined when the
 * reply never arrives (dumb pipe, blocked DSR). Does not interpret the
 * coordinates — only the elapsed milliseconds matter.
 */
/** Ask up to `attempts` times, pausing between misses. */
export async function probeRttWithRetry(
  run: () => Promise<number | undefined>,
  attempts = 2,
  delayMs = 250,
): Promise<number | undefined> {
  const tries = Math.max(1, attempts)
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const measured = await run()
    if (measured !== undefined) return measured
    if (attempt + 1 < tries) await new Promise(resolve => setTimeout(resolve, delayMs))
  }
  return undefined
}

export async function probeTerminalRttMs(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  timeoutMs = DSR_PROBE_TIMEOUT_MS,
): Promise<number | undefined> {
  if (!stdin.isTTY || !stdout.isTTY) return undefined
  // Retried for the same reason the relay does it: a screen that is being
  // repainted can make the terminal miss the first window, and one miss used to
  // blank the footer's link chip to four hollow circles.
  return await probeRttWithRetry(() => probeTerminalRttOnce(stdin, stdout, timeoutMs))
}

function probeTerminalRttOnce(
  stdin: NodeJS.ReadStream,
  stdout: NodeJS.WriteStream,
  timeoutMs: number,
): Promise<number | undefined> {
  return new Promise(resolve => {
    let buffer = ''
    let settled = false
    const started = Date.now()
    const finish = (value: number | undefined): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.removeListener('data', onData)
      resolve(value)
    }
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8')
      if (findCursorPositionReply(buffer) !== undefined) {
        finish(Math.max(0, Date.now() - started))
        return
      }
      if (buffer.length > PROBE_BUFFER_TAIL) buffer = buffer.slice(-PROBE_BUFFER_TAIL)
      if (buffer.length > 32 && !buffer.includes('\x1b')) finish(undefined)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    stdin.on('data', onData)
    try {
      stdout.write('\x1b[6n')
    } catch {
      finish(undefined)
    }
  })
}


/** Sliding window of `windowSize` items that keeps `cursor` visible. */
export function pickerWindowStart(cursor: number, total: number, windowSize = PICKER_WINDOW): number {
  if (total <= windowSize) return 0
  const maxStart = Math.max(0, total - windowSize)
  const start = cursor - Math.floor((windowSize - 1) / 2)
  return Math.max(0, Math.min(maxStart, start))
}

/** Immediate first-frame chrome so a 2–3s Host boot is not a blank TTY. */
export function writeBootSplash(message: string, color = true): void {
  const width = Math.max(20, process.stdout.columns || 80)
  const title = t('boot.banner')
  const line = color
    ? `\x1b[1m${truncateToWidth(title, width)}\x1b[0m`
    : truncateToWidth(title, width)
  const detail = color
    ? `\x1b[36m${truncateToWidth(message, width)}\x1b[0m`
    : truncateToWidth(message, width)
  const useAlt = process.env.DSH_TUI_NO_ALT_SCREEN !== '1'
    && process.env.DSH_TUI_NO_ALT_SCREEN !== 'true'
  try {
    process.stdout.write(`${useAlt ? '\x1b[?1049h' : ''}\x1b[?25l\x1b[H\x1b[J${line}\n${'─'.repeat(width)}\n${detail}\n`)
  } catch {
    // TTY may already be gone.
  }
}

