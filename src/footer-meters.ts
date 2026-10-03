/**
 * The three meter primitives the status row is built from.
 *
 * One component per kind of question, because a health question and a capacity
 * question do not look alike:
 *
 * - {@link healthMeter} — "is this healthy?" Discrete levels, no bar. This is the
 *   SSH chip's four pips, generalised.
 * - {@link capacityMeter} — "how much is left / how much is used?" A bar and a
 *   percent. The *direction* is a parameter, which is what lets quota (remaining)
 *   and context (used) share one implementation.
 * - {@link performanceValue} — "how fast is it going?" A bare number, neutral,
 *   with a mark for the estimate and a dimmer form for a finished step.
 *
 * Nothing here knows what a row is, how wide it is, or in what order chips go:
 * that is `footer-budget.ts`, and keeping the two apart is what stops a meter
 * from growing a layout opinion.
 *
 * @module dsh-ssh-tui/footer-meters
 */

import { t } from './i18n/index.js'
import { asciiChromeEnabled } from './term-text.js'
import { activeTheme, themeThresholdToken, type ThresholdLevel } from './theme.js'
import { downgradeSgr, type ColorDepth } from './color-depth.js'
import { formatRate, type ThroughputView } from './throughput.js'
import { accent } from './color-depth.js'
import {
  CONTEXT_PRESSURE_DANGER_RATIO,
  CONTEXT_PRESSURE_WARN_RATIO,
  formatTokens,
} from './footer-format.js'


/**
 * The row's visual vocabulary, as reusable primitives.
 *
 * Three components, because the row answers three different kinds of question:
 *
 * - {@link healthMeter} — "is this healthy?" Discrete levels, no bar. This is
 *   the SSH chip's four pips, generalised; nothing else on the row copies it,
 *   because a health question and a capacity question do not look alike.
 * - {@link capacityMeter} — "how much is left / how much is used?" A bar with a
 *   percent. The *direction* is a parameter, which is what lets quota (remaining)
 *   and context (used) share one implementation.
 * - {@link performanceValue} — "how fast is it going?" A bare number, neutral,
 *   with a mark for the estimate and a dimmer form for a finished step.
 *
 * All three take `ascii` and answer with the project's own fallback glyphs, and
 * none of them reach for a threshold colour on their own: the caller decides
 * whether the number it is drawing has bands at all.
 */
/** How many level marks a health meter has: the four pips the SSH chip always had. */
export const HEALTH_METER_LEVELS = 4

/** Full and empty level marks. The empty one is the same cell, hollow. */
export const HEALTH_MARK_FILLED = '●'

export const HEALTH_MARK_EMPTY = '○'

/** ASCII fallback for the same four levels, from the project's own glyph table. */
export const HEALTH_ASCII_FILLED = '*'

export const HEALTH_ASCII_EMPTY = 'o'

/** Filled and empty cells of a capacity meter, matching the existing quota bar. */
export const CAPACITY_CELL_FILLED = '█'

export const CAPACITY_CELL_EMPTY = '░'

/** ASCII fallback for the capacity meter, from the project's own glyph table. */
export const CAPACITY_ASCII_FILLED = '#'

export const CAPACITY_ASCII_EMPTY = '.'

/** Segment counts by row budget. Three is the smallest bar that still reads. */
export const CAPACITY_SEGMENTS_WIDE = 8

export const CAPACITY_SEGMENTS_MEDIUM = 5

export const CAPACITY_SEGMENTS_NARROW = 3

/** Which way a capacity meter reads. */
export type CapacityBasis = 'used' | 'remaining'

/** Options for one capacity meter; everything but the percent is optional. */
export interface CapacityMeterOptions {
  /** Segment count when the row has room. */
  segments?: number
  /** `used` reads left to right as usage, `remaining` as what is left. */
  basis?: CapacityBasis
  /** Leading label, e.g. `5Hr` / `CTX`. */
  label?: string
  /** Trailing text after the percent, e.g. `720K/1M`. */
  detail?: string
  /** Drop the bar entirely, keeping `CTX 72%`. */
  percentOnly?: boolean
  /** Quota bands (50 / 25 remaining) instead of context bands (80 / 95 used). */
  quota?: boolean
  /** Glyphs the terminal can actually draw; defaults to the terminal's own state. */
  ascii?: boolean
  /** Paint the filled run and the percent with the band's accent. */
  color?: boolean
  /** Colour depth the accent is downgraded for. */
  depth?: ColorDepth
}

/**
 * Colours for a capacity meter's filled portion.
 *
 * Context and quota answer different questions and have different runways, so
 * they get different bands — but each one reuses a threshold the session already
 * enforces, so the meter can never disagree with the alert beside it:
 * context reuses the pressure levels `contextPressureView` uses (warn at 80%,
 * danger at 95%, the same numbers that drive the compaction prompt), and quota
 * reuses the first two of `QUOTA_ALERT_THRESHOLDS` (50 / 25 remaining), which is
 * where the session starts telling the user about it.
 */
export const CONTEXT_METER_WARN_PERCENT = CONTEXT_PRESSURE_WARN_RATIO * 100

export const CONTEXT_METER_DANGER_PERCENT = CONTEXT_PRESSURE_DANGER_RATIO * 100

/** First two entries of `quota.ts`'s `QUOTA_ALERT_THRESHOLDS`, in remaining percent. */
export const QUOTA_METER_WARN_PERCENT = 50

export const QUOTA_METER_DANGER_PERCENT = 25

/** Which band a capacity reading falls in, given what the number means. */
export function capacityLevel(percent: number, basis: CapacityBasis = 'used', quota = false): ThresholdLevel {
  if (!Number.isFinite(percent)) return 'ok'
  if (basis === 'remaining') {
    // Remaining runs out downwards, so the bands are read on the way down; a
    // quota is only "over" when almost nothing is left.
    const warn = quota ? QUOTA_METER_WARN_PERCENT : 100 - CONTEXT_METER_WARN_PERCENT
    const danger = quota ? QUOTA_METER_DANGER_PERCENT : 100 - CONTEXT_METER_DANGER_PERCENT
    if (percent <= danger) return 'over'
    if (percent <= warn) return 'warn'
    return 'ok'
  }
  const warn = quota ? 100 - QUOTA_METER_WARN_PERCENT : CONTEXT_METER_WARN_PERCENT
  const danger = quota ? 100 - QUOTA_METER_DANGER_PERCENT : CONTEXT_METER_DANGER_PERCENT
  if (percent >= danger) return 'over'
  if (percent >= warn) return 'warn'
  return 'ok'
}

/**
 * One capacity meter: `CTX ███████░░░ 61%`.
 *
 * An unusable percent paints a hollow bar with a question mark rather than `0%`:
 * a reading nobody took is not a reading of zero, and `?%` is the same claim the
 * quota chip has always made before its first reading lands.
 *
 * Colour, when asked for, lands only on the cells that carry the meaning — the
 * filled run and the percent. Tinting the label and the empty cells would make
 * the whole chip one colour and lose the hierarchy it exists to create.
 */
export function capacityMeter(
  percent: number | undefined,
  options: CapacityMeterOptions = {},
): { text: string; level: ThresholdLevel } {
  const segments = Math.max(0, options.segments ?? CAPACITY_SEGMENTS_WIDE)
  const ascii = options.ascii ?? asciiChromeEnabled()
  const filledGlyph = ascii ? CAPACITY_ASCII_FILLED : CAPACITY_CELL_FILLED
  const emptyGlyph = ascii ? CAPACITY_ASCII_EMPTY : CAPACITY_CELL_EMPTY
  const label = options.label === undefined || options.label === '' ? '' : `${options.label} `
  const detail = options.detail === undefined || options.detail === '' ? '' : ` · ${options.detail}`
  if (percent === undefined || !Number.isFinite(percent)) {
    return { text: `${label}${emptyGlyph.repeat(segments)} ?%${detail}`, level: 'ok' }
  }
  const clamped = Math.max(0, Math.min(100, percent))
  const level = capacityLevel(clamped, options.basis ?? 'used', options.quota === true)
  const filled = Math.round(clamped / 100 * segments)
  const percentText = `${Math.round(clamped)}%`
  const color = options.color === true && options.depth !== 'none'
  const paint = (text: string): string => color
    ? accent(text, themeThresholdToken(activeTheme(), level), options.depth ?? 'truecolor')
    : text
  if (options.percentOnly === true) {
    return { text: `${label}${paint(percentText)}${detail}`, level }
  }
  const bar = `${paint(filledGlyph.repeat(filled))}${emptyGlyph.repeat(segments - filled)}`
  return { text: `${label}${bar} ${paint(percentText)}${detail}`, level }
}

/**
 * One health meter: `●●●●`.
 *
 * Discrete levels, never a bar: a link is one of five states, and four pips say
 * which at a glance. This is the component the SSH chip has always been — it
 * simply became reusable when the quota and context meters arrived, so that the
 * two things that *are* capacities stopped being drawn as pips.
 */
export function healthMeter(
  level: number,
  options: { levels?: number; ascii?: boolean } = {},
): string {
  const levels = Math.max(1, options.levels ?? HEALTH_METER_LEVELS)
  const filled = Math.max(0, Math.min(levels, Math.round(level)))
  const ascii = options.ascii ?? asciiChromeEnabled()
  const on = ascii ? HEALTH_ASCII_FILLED : HEALTH_MARK_FILLED
  const off = ascii ? HEALTH_ASCII_EMPTY : HEALTH_MARK_EMPTY
  return `${on.repeat(filled)}${off.repeat(levels - filled)}`
}

/** Options for {@link performanceValue}. */
export interface PerformanceValueOptions {
  /** `live` is the streaming estimate, `settled` the last completed step. */
  state: 'live' | 'settled' | 'unavailable'
  /** `tok/s` in full, `t/s` when the row is out of room. */
  short?: boolean
  /** Paint the live value at the row's primary intensity. */
  color?: boolean
}

/** Which form of the throughput number can be painted at all. */
export function performanceValueState(
  throughput: ThroughputView | undefined,
  running: boolean,
): PerformanceValueOptions['state'] {
  if (throughput === undefined) return 'unavailable'
  if (running && throughput.fresh && throughput.liveRate !== undefined) return 'live'
  if (!running && throughput.settledRate !== undefined && throughput.settledRate > 0) return 'settled'
  return 'unavailable'
}

/**
 * The performance value: `160 tok/s`, `~160 tok/s`, `— tok/s`.
 *
 * Tokens per second is neutral telemetry, so this component never reaches for a
 * threshold colour: the harness publishes no performance classification, and the
 * same number means different things on a reasoning model, a small fast one, and
 * a long-context request. `~` marks the live estimate — characters per second
 * scaled by this session's own tokens-per-character — and the settled value has
 * no mark because it is exact. A live value is lifted out of the row's muted
 * style because it is the one number on the row that is *moving*; every theme
 * understands "default intensity", and the mono theme keeps the distinction.
 */
export function performanceValue(
  throughput: ThroughputView | undefined,
  running: boolean,
  options: Partial<PerformanceValueOptions> = {},
): string {
  const unit = options.short === true ? 't/s' : 'tok/s'
  const state = options.state ?? performanceValueState(throughput, running)
  if (state === 'unavailable') return `— ${unit}`
  if (state === 'live') {
    const text = `~${formatRate(throughput?.liveRate ?? 0)} ${unit}`
    return options.color === true ? `\x1b[0m${text}\x1b[0m` : text
  }
  return `${formatRate(throughput?.settledRate ?? 0)} ${unit}`
}
