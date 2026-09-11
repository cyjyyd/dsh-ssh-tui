/**
 * Terminal input hygiene for the display relay.
 *
 * The relay measures the SSH round-trip with a Device Status Report (`CSI 6n`)
 * and the terminal answers with a cursor position report (`CSI row;col R`).
 * That answer arrives on stdin, where it is indistinguishable from typing: if
 * it lands after the probe's window closed — the terminal was still busy with
 * a repaint, the link queued it behind a burst, or an earlier launcher asked
 * and died before reading it — it used to be forwarded to the Host and painted
 * into the prompt as `[17;1R`. An ESC whose tail arrived in a later read
 * cancelled whatever dialog was open, and while two launchers fought over one
 * session the TTY spent half its time in cooked mode, so the replies in flight
 * were *echoed* as `^[[17;1R` lines on top of the TUI.
 *
 * The same in-flight replies corrupt the measurement itself: the probe that
 * reads a previous request's answer reports ~2 ms, and the answer to its own
 * request is still on the wire (it becomes the next garbage the prompt shows).
 * A DSR request can also be queued behind a full-screen repaint, which is how
 * a 50 ms SSH link reported 1900 ms.
 *
 * Two things keep both under control:
 *   - `TerminalInputFilter` removes replies from the byte stream wherever they
 *     appear, including split across reads, and holds a half-arrived sequence
 *     briefly so it cannot leak as `17;1R` digits either;
 *   - `TerminalInputPump` measures RTT by asking several times, discarding
 *     answers that cannot be a real round-trip, and reporting the middle one —
 *     an estimate of the link rather than of the current queue.
 */
import { StringDecoder } from 'node:string_decoder'

/** True when this process is talking to a terminal through SSH. */
export function detectSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY)
}

/** Cursor position report: `CSI row ; col R` (`?` for DECXCPR). */
const CURSOR_REPLY = /\x1b\[\??\d+;\d+R/gu

/** Longest run that can still grow into one: `\x1b[?12345;12345`. */
const CURSOR_PREFIX_MAX = 16

/** A partial reply: `\x1b`, `\x1b[`, `\x1b[12;3`, but not `\x1b[1;2;3`. */
const CURSOR_PREFIX = /^\x1b(?:\[(?:\??(?:\d*(?:;\d*)?)?)?)?$/u

/** What a probe writes to ask the terminal where its cursor is. */
export const CURSOR_POSITION_REQUEST = '\x1b[6n'

/**
 * How long a half-arrived reply is held before it is handed over as typing.
 * A real sequence arrives within one read or the next; anything slower is
 * either a very unlucky split or the start of a user's own escape key.
 */
export const INPUT_HOLD_MS = 30

/** A single probe answer that misses this window counts as "no reply". */
export const RTT_SAMPLE_TIMEOUT_MS = 350
/** Wider window for the rest of the measurement once one has been missed. */
export const RTT_SLOW_SAMPLE_TIMEOUT_MS = 800
/** Answers to collect before one is reported. */
export const RTT_SAMPLE_COUNT = 3
/** Two answers this close already describe the link; the third is not needed. */
export const RTT_AGREEMENT_MS = 6
/** Rejected or lost answers do not consume the sampling budget. */
const RTT_EXTRA_ATTEMPTS = 3
/** Wall-clock ceiling for one measurement, however chatty the terminal is. */
export const RTT_MEASURE_BUDGET_MS = 2_500
/** Quiet time before re-asking when nothing was measured yet. */
const RTT_QUIET_MIN_MS = 150
/** On top of the last good round-trip: how far behind it an answer can be. */
const RTT_QUIET_MARGIN_MS = 25
/**
 * An SSH answer that came back this much faster than the slowest sample cannot
 * have made the round trip — it was already on the wire when we asked. Relative
 * on purpose: `ssh localhost` honestly answers in about 2 ms.
 */
export const RTT_OUTLIER_RATIO = 0.25

/** Remove every complete cursor reply from `text`. */
export function stripCursorReplies(text: string): { text: string; replies: number } {
  let replies = 0
  const cleaned = text.replace(CURSOR_REPLY, () => {
    replies += 1
    return ''
  })
  return { text: cleaned, replies }
}

/** The trailing run of `text` that a reply could still grow out of. */
function cursorReplyTail(text: string): string {
  const start = text.lastIndexOf('\x1b')
  if (start === -1) return ''
  const tail = text.slice(start)
  if (tail.length > CURSOR_PREFIX_MAX || !CURSOR_PREFIX.test(tail)) return ''
  return tail
}

/**
 * Drop cursor replies from a byte stream that is otherwise user input.
 *
 * Feed every read to `push()`; the bytes it returns are what the user actually
 * typed. A read that ends in the middle of a possible reply is held back (see
 * `flush()`) so `ESC [ 1` + `7;1R` cannot become visible digits either.
 */
export class TerminalInputFilter {
  private held = ''

  push(text: string): { forward: string; replies: number } {
    const { text: cleaned, replies } = stripCursorReplies(this.held + text)
    this.held = ''
    const tail = cursorReplyTail(cleaned)
    if (tail === '') return { forward: cleaned, replies }
    this.held = tail
    return { forward: cleaned.slice(0, cleaned.length - tail.length), replies }
  }

  /** Release a held partial (its window passed, so it was not a reply). */
  flush(): string {
    const held = this.held
    this.held = ''
    return held
  }

  /** Forget a held partial — used when the caller knows it must be stale. */
  reset(): void {
    this.held = ''
  }

  get pending(): boolean {
    return this.held !== ''
  }
}

/**
 * The filter with the hold timer attached, for a caller that turns bytes into
 * keystrokes (the TUI and the session picker) instead of forwarding them.
 */
export class TerminalInputGuard {
  private readonly filter = new TerminalInputFilter()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private readonly emit: (text: string) => void,
    private readonly holdMs: number = INPUT_HOLD_MS,
  ) {}

  /** Feed one decoded read; anything that is not a reply reaches `emit`. */
  push(text: string): void {
    const { forward } = this.filter.push(text)
    if (this.filter.pending) {
      if (this.timer !== undefined) clearTimeout(this.timer)
      // Referenced on purpose: this timer *completes* an operation the caller
      // started (releasing a held key). Unref'ing it let the event loop drain
      // with the release still pending — under `node --test` on Node 22 that
      // cancels every later test in the file, and an embedder that awaits the
      // guard would lose the keystroke. `stop()` clears it.
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.release()
      }, this.holdMs)
    }
    if (forward !== '') this.emit(forward)
  }

  /** Hand a half-arrived sequence over (its window passed; it is typing). */
  release(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const held = this.filter.flush()
    if (held !== '') this.emit(held)
  }

  /** Drop the timer and any held bytes (display detached, picker settled). */
  stop(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.filter.reset()
  }
}

export interface TerminalInputPumpOptions {  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  /** Receives bytes that are real typing, never probe answers. */
  onInput: (text: string) => void
  /** Link kind; defaults to the SSH environment of this process. */
  ssh?: boolean
  holdMs?: number
  sampleTimeoutMs?: number
  samples?: number
  /** Give up sampling after this long; the attach must not wait forever. */
  budgetMs?: number
  /** One line per probe attempt, for `DSH_TUI_DEBUG=1` troubleshooting. */
  debug?: (message: string) => void
}

interface ReplyWaiter {
  started: number
  settle: (rttMs: number | undefined) => void
  timer: NodeJS.Timeout
}

/**
 * stdin → replies (for the probe) + real input (for the caller).
 *
 * Long-lived on purpose: the relay keeps it running for the whole attachment,
 * so a reply that arrives seconds late is dropped instead of reaching the Host.
 */
export class TerminalInputPump {
  private readonly filter = new TerminalInputFilter()
  private readonly decoder = new StringDecoder('utf8')
  private readonly waiters: ReplyWaiter[] = []
  /** When the last answer (accepted or not) arrived; drives the quiet wait. */
  private lastAnswerAt = 0
  /** When the last request went out; an answer may follow it for a window. */
  private lastRequestAt = 0
  /** Current answer window; widened once when the first one is missed. */
  private windowMs = RTT_SAMPLE_TIMEOUT_MS
  /** Answers seen, used to tell "slow terminal" from "terminal never answers". */
  private answersSeen = 0
  /** Slowest sample so far; the quiet wait has to clear the worst of them. */
  private slowestSampleMs: number | undefined
  private holdTimer: NodeJS.Timeout | undefined
  private listening = false
  readonly ssh: boolean

  constructor(private readonly options: TerminalInputPumpOptions) {
    this.ssh = options.ssh ?? detectSshSession()
  }

  start(): void {
    if (this.listening) return
    this.listening = true
    this.options.stdin.on('data', this.onData)
  }

  stop(): void {
    const wasListening = this.listening
    this.listening = false
    if (wasListening) this.options.stdin.removeListener('data', this.onData)
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer)
      this.holdTimer = undefined
    }
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer)
      waiter.settle(undefined)
    }
    const held = this.filter.flush()
    if (held !== '') this.options.onInput(held)
    const tail = this.decoder.end()
    if (tail !== '') this.options.onInput(tail)
  }

  /**
   * Ask the terminal for its cursor a few times and report the round-trip that
   * best describes the link. `undefined` means the terminal never answered in
   * time (a dumb pipe), and the caller must not treat that as "0 ms".
   */
  async measure(): Promise<number | undefined> {
    const timeoutMs = this.options.sampleTimeoutMs ?? RTT_SAMPLE_TIMEOUT_MS
    this.windowMs = timeoutMs
    const wanted = Math.max(1, this.options.samples ?? RTT_SAMPLE_COUNT)
    const samples: number[] = []
    const note = this.options.debug
    let misses = 0
    let attempts = 0
    // A rejected or lost answer must not eat the budget: on a reconnect the
    // terminal can still be finishing a dead launcher's probe.
    const maxAttempts = wanted + RTT_EXTRA_ATTEMPTS
    const budgetMs = this.options.budgetMs ?? RTT_MEASURE_BUDGET_MS
    const startedAt = Date.now()
    const answersAtStart = this.answersSeen
    this.lastAnswerAt = startedAt
    while (samples.length < wanted && attempts < maxAttempts
      && Date.now() - startedAt < budgetMs) {
      attempts += 1
      // Never ask while an earlier request may still be in flight: its answer
      // would be read as this request's, and because it left earlier it is
      // *faster* — the "2 ms on a 50 ms link" reading. Wait for the whole
      // answer window to go by before asking again.
      if (attempts > 1) await this.quiet(startedAt + budgetMs)
      this.drain()
      const rtt = await this.ask(this.windowMs)
      if (rtt === undefined) {
        misses += 1
        note?.(`rtt probe ${attempts}: no answer`)
        // A miss may just mean the link is slower than the first window, so
        // widen it — but only for a terminal that has answered at all: a dumb
        // pipe must not cost the widened window twice.
        if (this.answersSeen > answersAtStart) {
          this.windowMs = Math.min(RTT_SLOW_SAMPLE_TIMEOUT_MS, Math.max(this.windowMs, timeoutMs * 3))
        }
        // Two silent windows in a row and nothing collected: this terminal
        // does not answer DSR at all, and a third only delays the attach.
        if (misses >= 2 && samples.length === 0) break
        continue
      }
      samples.push(rtt)
      note?.(`rtt probe ${attempts}: ${rtt}ms`)
      if (samples.length >= 2
        && Math.max(...samples) - Math.min(...samples) <= RTT_AGREEMENT_MS) break
    }
    // Whatever else was queued belongs to a request we have already given up
    // on; it must not reach the Host, and it must not extend this measurement.
    this.drain()
    const kept = this.dropFastOutliers(samples)
    // Median of three, not the minimum: one answer that was already in flight
    // when we asked is *fast*, and taking the smallest sample let it decide the
    // footer's chip. Two samples only get here when they already agree (the
    // early stop above), and the larger one is the conservative pick.
    const measured = kept.length === 0
      ? undefined
      : kept.length >= 3
        ? [...kept].sort((a, b) => a - b)[Math.floor(kept.length / 2)]
        : Math.max(...kept)
    note?.(measured === undefined
      ? 'rtt probe: unknown'
      : `rtt probe: ${measured}ms (of ${samples.map(value => `${value}ms`).join(', ')})`)
    return measured
  }

  /**
   * Drop an answer that came back far too fast to have made the round trip —
   * an answer to somebody else's request, still on the wire when we asked.
   * Relative, not absolute (`ssh localhost` honestly answers in 2 ms), and
   * measured against the *median*: comparing with the slowest sample would
   * throw away three good answers because one request sat behind a repaint.
   */
  private dropFastOutliers(samples: number[]): number[] {
    if (!this.ssh || samples.length < 2) return samples
    const sorted = [...samples].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 1
      ? (sorted[middle] ?? 0)
      : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    return samples.filter(sample => sample >= median * RTT_OUTLIER_RATIO)
  }

  /**
   * How long the line must be quiet before the next request may go out.
   *
   * The only safe answer is the full sample window: a request we sent can be
   * answered at any point inside it, so anything shorter can attribute that
   * answer to the request that follows. Deriving it from the samples instead
   * looks cheaper and is exactly what goes wrong — a leftover answer reports
   * 1 ms, the window shrinks to the minimum, and the honest answer to the
   * abandoned request lands in the *next* window (250 ms link reported as 1 ms
   * and 0 ms, two "agreeing" samples, early stop, chip frozen on a wrong value).
   */
  private quietMs(): number {
    if (this.slowestSampleMs === undefined) return Math.max(RTT_QUIET_MIN_MS, this.windowMs)
    return Math.max(RTT_QUIET_MIN_MS, this.windowMs, this.slowestSampleMs + RTT_QUIET_MARGIN_MS)
  }

  /**
   * Wait until the line has been quiet for a full window, measured from the
   * later of the last answer and the last request. An answer to a request we
   * already gave up on lands in here and is thrown away, so it cannot be
   * attributed to the request that follows it.
   */
  private async quiet(deadline: number): Promise<void> {
    const quietMs = this.quietMs()
    for (;;) {
      const last = Math.max(this.lastAnswerAt, this.lastRequestAt)
      const idle = Date.now() - last
      if (idle >= quietMs) return
      if (Date.now() >= deadline) return
      await new Promise(resolve => setTimeout(resolve, Math.min(20, quietMs - idle)))
    }
  }

  /**
   * Consume what the kernel already holds, so an answer that was on its way
   * before this request cannot be read as its answer.
   *
   * `read()` emits `data` for the chunk it returns whenever a listener is
   * attached, and the listener path would then deliver the same bytes twice
   * (a typed `hi` arrived at the Host as `hihi`). Detach for the duration of
   * the loop: it is synchronous, so nothing can be lost in between.
   */
  private drain(): void {
    const read = this.options.stdin.read
    const listening = this.listening
    if (listening && typeof read === 'function') this.options.stdin.removeListener('data', this.onData)
    try {
      if (typeof read === 'function') {
        for (;;) {
          let chunk: Buffer | string | null
          try {
            chunk = read.call(this.options.stdin) as Buffer | string | null
          } catch {
            break
          }
          if (chunk === null || chunk === undefined) break
          if (chunk.length === 0) break
          this.feed(chunk)
        }
      }
    } finally {
      if (listening) this.options.stdin.on('data', this.onData)
    }
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer)
      this.holdTimer = undefined
    }
    // A half-arrived sequence sitting here now predates the request we are
    // about to send, so it cannot be its answer.
    this.filter.reset()
  }

  private ask(timeoutMs: number): Promise<number | undefined> {
    return new Promise(resolve => {
      let settled = false
      const settle = (value: number | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      // Referenced for the same reason as the guard's hold: the waiter's whole
      // job is to settle the probe, and it is cleared by `stop()`/`drain()`.
      const waiter: ReplyWaiter = {
        started: Date.now(),
        settle,
        timer: setTimeout(() => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) this.waiters.splice(index, 1)
          settle(undefined)
        }, timeoutMs),
      }
      this.waiters.push(waiter)
      this.lastRequestAt = Date.now()
      try {
        this.options.stdout.write(CURSOR_POSITION_REQUEST)
      } catch {
        const index = this.waiters.indexOf(waiter)
        if (index !== -1) this.waiters.splice(index, 1)
        clearTimeout(waiter.timer)
        settle(undefined)
      }
    })
  }

  private readonly onData = (chunk: Buffer): void => {
    this.feed(chunk)
  }

  private feed(chunk: Buffer | string): void {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (text === '') return
    const { forward, replies } = this.filter.push(text)
    for (let index = 0; index < replies; index += 1) this.answer()
    if (forward !== '') this.options.onInput(forward)
    this.scheduleHold()
  }

  /**
   * One reply: hand it to the oldest outstanding request. An answer that
   * belongs to a request we already gave up on is simply dropped here — and
   * its arrival time still restarts the quiet window, which is what keeps it
   * from being attributed to the next request.
   */
  private answer(): void {
    this.lastAnswerAt = Date.now()
    this.answersSeen += 1
    const waiter = this.waiters.shift()
    if (waiter === undefined) return
    clearTimeout(waiter.timer)
    const elapsed = Math.max(0, Date.now() - waiter.started)
    if (this.slowestSampleMs === undefined || elapsed > this.slowestSampleMs) {
      this.slowestSampleMs = elapsed
    }
    waiter.settle(elapsed)
  }

  private scheduleHold(): void {
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer)
      this.holdTimer = undefined
    }
    if (!this.filter.pending) return
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined
      const held = this.filter.flush()
      if (held !== '') this.options.onInput(held)
    }, this.options.holdMs ?? INPUT_HOLD_MS)
  }
}
