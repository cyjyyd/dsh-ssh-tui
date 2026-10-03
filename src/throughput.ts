/**
 * Live decode throughput for the status row.
 *
 * The harness never publishes tokens per second. What it does publish, per
 * step, is authoritative: `assistant/message` carries the step's output-token
 * count and the packed stream's first-token time, so `decodeTokens / decodeMs`
 * over settled steps is a real measurement. What it does *not* publish is any
 * per-token count while a step is still streaming — adapters emit text deltas
 * and only hand over `usage` as the stream closes (verified against
 * `dsh-llm-deepseek` and `dsh-llm-pi-ai`).
 *
 * So there are exactly two honest numbers, and this module keeps them apart:
 *
 * 1. **Settled** — tokens and milliseconds of a completed step. Exact, and the
 *    only number that is ever comparable across steps or sessions.
 * 2. **Live** — characters per second while a step streams, converted with a
 *    ratio calibrated from this session's own settled steps. It is an estimate,
 *    it is labelled with `~`, and it exists so a long reply shows *something*
 *    that moves instead of a number frozen at the previous step.
 *
 * There is deliberately no health grading here. Tokens per second is a property
 * of the model, the provider, the reasoning effort and the prompt, not a signal
 * that something is wrong: 20 tok/s from a reasoning model and 20 tok/s from a
 * small fast one mean different things. The row paints it neutral.
 *
 * @module dsh-ssh-tui/throughput
 */

/** How much of the recent past the live rate is measured over. */
export const THROUGHPUT_WINDOW_MS = 4_000
/** Minimum span between the two samples a rate is taken from. */
export const THROUGHPUT_MIN_SPAN_MS = 400
/** A live rate older than this describes a stream that stopped, not one running. */
export const THROUGHPUT_FRESH_MS = 2_500
/** Samples kept in the window; the cadence is the paint interval, not per token. */
const MAX_SAMPLES = 64
/**
 * Tokens per character, for the two ends of the script spectrum.
 *
 * Latin text averages roughly a third of a token per character; CJK is close to
 * one, because a Chinese character is usually its own token and most words are one
 * or two characters. Between those ends the estimate is interpolated by the
 * *measured* script mix of the stream being estimated, continuously: a threshold
 * ("30% CJK means Chinese") would put a mostly-English reply with one Chinese
 * paragraph on the wrong side of a cliff, and the number it produces is shown to
 * the reader.
 */
export const DEFAULT_TOKENS_PER_CHAR_LATIN = 0.32
export const DEFAULT_TOKENS_PER_CHAR_CJK = 0.85
/** The Latin end under its original name: the fallback for a stream with no text. */
export const DEFAULT_TOKENS_PER_CHAR = DEFAULT_TOKENS_PER_CHAR_LATIN
/** Calibration bounds: below the first a tokenizer is lying, above the second too. */
const MIN_TOKENS_PER_CHAR = 0.1
const MAX_TOKENS_PER_CHAR = 1.5
/** Weight of the newest settled step in the calibration average. */
const CALIBRATION_WEIGHT = 0.5
/** Rates kept for the median; three is what the link chip's RTT median uses. */
const RATE_HISTORY = 3

/** What the status row paints, and what `/status` reports. */
export interface ThroughputView {
  /** Exact tokens per second of the most recent settled step, when it had usage. */
  settledRate?: number
  /** Characters the live estimate was built from, for the calibration report. */
  liveChars: number
  /** Estimated tokens per second over the streaming window. */
  liveRate?: number
  /** True when `liveRate` was measured recently enough to call it current. */
  fresh: boolean
}

interface Sample {
  /** Milliseconds since the step's first delta. */
  at: number
  /** Cumulative characters at that moment. */
  chars: number
}

/**
 * Characters to tokens, bounded and finite.
 *
 * The default is an average over mixed prose and code; every settled step
 * replaces half of it with this session's own measurement, which is what makes
 * the live estimate usable on CJK output (where one character is close to one
 * token) without hardcoding a language.
 */
export function boundTokensPerChar(value: number, fallback = DEFAULT_TOKENS_PER_CHAR): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(MAX_TOKENS_PER_CHAR, Math.max(MIN_TOKENS_PER_CHAR, value))
}

/**
 * The median of up to the last three rates, or the newest one alone.
 *
 * A single frame in which the terminal coalesced a burst of tokens into one
 * delta reads as a spike; a median of three ignores it, while a real change
 * survives because two agreeing samples decide it. Same rule, and the same
 * reasoning, as the link chip's RTT median.
 */
export function medianRate(values: readonly number[]): number | undefined {
  const recent = values.filter(value => Number.isFinite(value) && value > 0).slice(-RATE_HISTORY)
  if (recent.length === 0) return undefined
  const sorted = [...recent].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * Tracks one step's live decode rate from character deltas.
 *
 * Sampling is the caller's job (`note` per fragment): the window's own
 * minimum span is what keeps the number stable, so a burst of tiny deltas and
 * one coalesced delta produce the same answer.
 */
/**
 * Whether one code point is written in a script whose characters are close to one
 * token each: CJK ideographs, kana, Hangul syllables, and the fullwidth or CJK
 * punctuation that travels with them.
 *
 * Deliberately a property of the *text* rather than of the reader's locale: a
 * Chinese reader's English reply is Latin text and costs Latin tokens per
 * character, and `~tok/s` has to describe the tokens, not the person.
 */
export function isCjkCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x3040 && codePoint <= 0x30ff)     // hiragana + katakana
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)       // CJK extension A
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)       // CJK unified ideographs
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)       // hangul syllables
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)       // CJK compatibility ideographs
    || (codePoint >= 0xff00 && codePoint <= 0xff60)       // fullwidth forms
    || (codePoint >= 0x3000 && codePoint <= 0x303f)       // CJK punctuation
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)     // extensions B and up
}

/**
 * The starting ratio for a stream of a given script mix: `cjkShare` of the
 * characters read as CJK, the rest as Latin. Continuous by construction, so a
 * reply that is 70% English and 30% Chinese lands 30% of the way up the range
 * instead of being classified as one or the other.
 */
export function scriptTokensPerChar(cjkShare: number): number {
  const share = Number.isFinite(cjkShare) ? Math.min(1, Math.max(0, cjkShare)) : 0
  return DEFAULT_TOKENS_PER_CHAR_LATIN
    + (DEFAULT_TOKENS_PER_CHAR_CJK - DEFAULT_TOKENS_PER_CHAR_LATIN) * share
}

export class ThroughputTracker {
  /** The session's own ratio, once a step has settled. */
  private calibrated: number | undefined
  /** Characters and CJK characters seen in the step being estimated. */
  private observedChars = 0
  private observedCjk = 0
  private samples: Sample[] = []
  private chars = 0
  private baseAt: number | undefined
  private startedAt: number | undefined
  private lastDeltaAt = 0
  private lastStepChars: number | undefined
  /** Rates already computed this step, kept for the median. */
  private recentRates: number[] = []
  private lastRate: number | undefined
  private settledRate: number | undefined

  /**
   * The ratio the estimate is using right now: this session's own measurement once
   * a step has settled, and the script mix of the stream being estimated before
   * that. `/status` and the tests read it.
   */
  tokensPerChar(): number {
    return this.calibrated ?? scriptTokensPerChar(this.cjkShare())
  }

  /** Share of this step's characters that were CJK, 0 when none have arrived. */
  cjkShare(): number {
    return this.observedChars === 0 ? 0 : this.observedCjk / this.observedChars
  }

  /** Whether the ratio is a settled measurement rather than a script estimate. */
  calibratedRatio(): boolean {
    return this.calibrated !== undefined
  }

  /** Drop a finished step's stream state, keeping calibration and last settle. */
  reset(): void {
    this.samples = []
    this.chars = 0
    this.observedChars = 0
    this.observedCjk = 0
    this.baseAt = undefined
    this.startedAt = undefined
    this.lastDeltaAt = 0
    this.lastStepChars = undefined
    this.recentRates = []
    this.lastRate = undefined
  }

  /**
   * One observed fragment of model output.
   *
   * The fragment itself, not a count: the estimate is tokens per character, and
   * how many tokens a character is worth depends on which characters they are, so
   * the script mix has to be measured here rather than assumed once for the
   * session. Code points rather than UTF-16 units, so an emoji or a rare ideograph
   * outside the BMP counts as the one character the reader sees.
   * @param text - the fragment; empty is ignored.
   * @param time - wall clock the fragment arrived at, for tests and replay.
   */
  note(text: string, time: number = Date.now()): void {
    if (text === '') return
    let chars = 0
    let cjk = 0
    for (const char of text) {
      chars += 1
      if (isCjkCodePoint(char.codePointAt(0) ?? 0)) cjk += 1
    }
    if (chars === 0) return
    if (this.startedAt === undefined) {
      this.startedAt = time
      this.baseAt = time
    }
    this.chars += chars
    this.observedChars += chars
    this.observedCjk += cjk
    this.lastDeltaAt = time
    const at = time - (this.baseAt ?? time)
    const last = this.samples[this.samples.length - 1]
    if (last !== undefined && last.at === at) {
      // Two fragments inside one millisecond: one sample, or the window fills
      // with points that share a timestamp and the span stays zero.
      last.chars = this.chars
    } else {
      this.samples.push({ at, chars: this.chars })
    }
    this.trim(at)
    this.sampleRate()
  }

  /**
   * Settle a step: fold its exact decode rate into the calibration and into the
   * number an idle row shows.
   * @param outputTokens - the step's authoritative output tokens.
   * @param decodeMs - milliseconds from first token to the settled message.
   */
  settle(outputTokens: number, decodeMs: number): void {
    const chars = this.chars
    if (Number.isFinite(outputTokens) && outputTokens > 0 && Number.isFinite(decodeMs) && decodeMs > 0) {
      this.settledRate = outputTokens / (decodeMs / 1_000)
      if (chars > 0) {
        // The session's own measurement takes over from the script estimate here,
        // and then keeps tracking it: half of the new sample, half of what was
        // already known, so one unusual reply cannot redefine the session.
        const before = this.tokensPerChar()
        const observed = boundTokensPerChar(outputTokens / chars, before)
        this.calibrated = before * (1 - CALIBRATION_WEIGHT) + observed * CALIBRATION_WEIGHT
      }
    }
    this.reset()
  }

  /** What the status row paints, and what `/status` reports. */
  view(now: number = Date.now()): ThroughputView {
    const liveRate = this.lastRate
    const fresh = liveRate !== undefined
      && this.lastDeltaAt > 0
      && now - this.lastDeltaAt <= THROUGHPUT_FRESH_MS
    return {
      ...(this.settledRate === undefined ? {} : { settledRate: this.settledRate }),
      liveChars: this.chars,
      ...(liveRate === undefined ? {} : { liveRate }),
      fresh,
    }
  }

  /** Drop samples that fell out of the window, and keep the newest few. */
  private trim(at: number): void {
    const cutoff = at - THROUGHPUT_WINDOW_MS
    let drop = 0
    while (drop + 2 < this.samples.length && (this.samples[drop + 1]?.at ?? 0) <= cutoff) drop += 1
    if (drop > 0) this.samples.splice(0, drop)
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES)
  }

  /** Recompute the window's rate and fold it into the median buffer. */
  private sampleRate(): void {
    const newest = this.samples[this.samples.length - 1]
    if (newest === undefined) return
    // The oldest sample still inside the minimum span, so a rate is never taken
    // over a 20 ms sliver where one chunk decides the answer.
    let oldest: Sample | undefined
    for (const sample of this.samples) {
      if (newest.at - sample.at >= THROUGHPUT_MIN_SPAN_MS) oldest = sample
      else break
    }
    oldest ??= this.samples[0]
    if (oldest === undefined) return
    const span = newest.at - oldest.at
    const chars = newest.chars - oldest.chars
    if (span < THROUGHPUT_MIN_SPAN_MS || chars <= 0) return
    // The ratio is sampled per rate, so a step that starts in English and drifts
    // into Chinese follows the text instead of one classification for the whole
    // reply.
    const rate = chars / (span / 1_000) * this.tokensPerChar()
    if (!Number.isFinite(rate) || rate <= 0) return
    this.lastStepChars = this.chars
    this.recentRates.push(rate)
    if (this.recentRates.length > RATE_HISTORY * 3) this.recentRates.shift()
    this.lastRate = medianRate(this.recentRates) ?? rate
  }
}

/**
 * A rate as the row paints it: whole numbers, `<1` rather than nothing.
 *
 * A slow step that decoded 3 tokens over 30 seconds is still decoding; rounding
 * it to `0` reads as a stalled model. Above 1000 the number is compacted, since
 * four digits is cells the quota and context meters want more.
 */
export function formatRate(tokensPerSecond: number): string {
  if (!Number.isFinite(tokensPerSecond) || tokensPerSecond < 1) return '<1'
  if (tokensPerSecond >= 1_000) return `${(Math.round(tokensPerSecond / 10) / 100).toFixed(2)}K`
  return String(Math.round(tokensPerSecond))
}
