/**
 * The one read `/context` is allowed to make.
 *
 * DSH's persisted projection cache exposes a header-keyed checkpoint view. It is
 * synchronous, bounded, and never folds the session log, so it is safe on a cold
 * or resumed session where the live projection registry would have to replay
 * history. The cache is a hint, not an authority: a result carries `asOfSeq`, and
 * the caller must label it as a cached estimate rather than exact live state.
 *
 * No other service is consulted here, and a missing cache is a fail-closed
 * `unavailable`, never a fallback to another reading path.
 *
 * @module dsh-ssh-tui/context-cache
 */

/** The selected projection keys; model selection is optional in the result. */
export const CONTEXT_CACHE_KEYS = [
  'contextPressure',
  'contextBreakdown',
  'tokenUsage',
  'modelSelection',
] as const

/** Why the cache could not supply a usable checkpoint. */
export type ContextCacheUnavailableReason =
  | 'service-missing'
  | 'header-missing'
  | 'no-checkpoint'
  | 'invalid-checkpoint'
  | 'read-failed'

/** A header-keyed checkpoint, as the cache returned it. */
export interface ContextCacheAvailable {
  status: 'available'
  /** The lowest watermark among the served rows. */
  asOfSeq: number
  /** Whole projected values keyed by projection name. */
  values: Readonly<Record<string, unknown>>
}

/** A fail-closed read result. */
export interface ContextCacheUnavailable {
  status: 'unavailable'
  reason: ContextCacheUnavailableReason
}

export type ContextCacheRead = ContextCacheAvailable | ContextCacheUnavailable

/** The minimal session shape this reader touches: its header identity only. */
export interface ContextCacheSession {
  header?: unknown
}

/** The minimal cache service shape, intentionally not the live projection registry. */
interface ProjectionCacheLike {
  cachedSnapshot?: (header: unknown, keys?: readonly string[]) => unknown
}

/**
 * Read the selected cached projections for one session header.
 *
 * Only `ctx.get('sessionProjectionCache')` and its header-keyed checkpoint read
 * are used. `ctx.get` is never asked for another service, and the session is not
 * inspected beyond `header`.
 * @param ctx - the Cordis context.
 * @param session - the current session (only `header` is read).
 * @returns a checkpoint or a fail-closed reason.
 */
export function readContextCache(
  ctx: { get?: (name: string) => unknown } | undefined,
  session: ContextCacheSession | undefined,
): ContextCacheRead {
  if (ctx === undefined || typeof ctx.get !== 'function') {
    return { status: 'unavailable', reason: 'service-missing' }
  }
  let service: unknown
  try {
    service = ctx.get('sessionProjectionCache')
  } catch {
    return { status: 'unavailable', reason: 'service-missing' }
  }
  const cache = service as ProjectionCacheLike | undefined
  if (cache === undefined || cache === null || typeof cache.cachedSnapshot !== 'function') {
    return { status: 'unavailable', reason: 'service-missing' }
  }
  const header = session?.header
  if (header === undefined || header === null) {
    return { status: 'unavailable', reason: 'header-missing' }
  }
  let snapshot: unknown
  try {
    snapshot = cache.cachedSnapshot(header, CONTEXT_CACHE_KEYS)
  } catch {
    return { status: 'unavailable', reason: 'read-failed' }
  }
  if (snapshot === undefined || snapshot === null || typeof snapshot !== 'object') {
    return { status: 'unavailable', reason: 'no-checkpoint' }
  }
  const record = snapshot as { asOfSeq?: unknown; values?: unknown }
  if (
    typeof record.asOfSeq !== 'number'
    || !Number.isSafeInteger(record.asOfSeq)
    || record.values === null
    || typeof record.values !== 'object'
  ) {
    return { status: 'unavailable', reason: 'invalid-checkpoint' }
  }
  return {
    status: 'available',
    asOfSeq: record.asOfSeq,
    values: record.values as Readonly<Record<string, unknown>>,
  }
}
