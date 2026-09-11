/**
 * Dual-stack shims for dsh 0.1.2-rc.1 and 0.1.5-rc.1 (and the 0.1.5-alpha
 * handle API that landed with it).
 *
 * 0.1.2 turned settings free functions into `SettingsProvider` methods and
 * replaced `Session.events` with on-demand readers. 0.1.5 replaced
 * `SessionPersistence.list`/`inspect`/`locate` with snapshot `list` plus
 * per-session `open` handles, and moved live tokens from durable
 * `assistant/chunk` events to process-local `agent/assistant-stream`.
 * Every shim here picks the API that is actually present so one build
 * runs on either host.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import * as dshSettings from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

/**
 * 0.1.1-rc.2 wraps namespaces via `settingsNamespace()`; 0.1.2+ brands them at
 * the type level and takes the plain string at runtime. A cast covers both.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  return value as SettingsNamespace
}

/**
 * Register a settings section: 0.1.2-rc.1 moved the free function onto the
 * `settings` service as `installSection`, callable only once that service is
 * injected (plugins apply before it, so `ctx.inject` must defer — same
 * pattern the harness's own packages use); 0.1.1-rc.2 keeps the free
 * function, which defers internally and is safe at apply time.
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const legacy = (dshSettings as {
    installSettingsSection?: (
      ctx: Context,
      ns: SettingsNamespace,
      schema: z<T>,
      entry: T,
      hooks: SettingsSectionHooks<T>,
    ) => void
  }).installSettingsSection
  if (typeof legacy === 'function') {
    legacy(ctx, ns, schema, entry, hooks)
    return
  }
  const host = ctx as {
    inject?: (services: readonly string[], callback: (injected: unknown) => void) => void
  }
  if (typeof host.inject !== 'function') {
    throw new Error('dsh-settings: no legacy installSettingsSection and ctx.inject is unavailable')
  }
  host.inject(['settings'], (injected) => {
    const holder = injected as { settings?: { installSection?: (...args: unknown[]) => void } }
    const provider = (holder.settings ?? injected) as {
      installSection?: (...args: unknown[]) => void
    }
    if (typeof provider?.installSection !== 'function') {
      throw new Error('dsh-settings: settings service has no installSection')
    }
    provider.installSection(ctx, ns, schema, entry, hooks)
  })
}

/**
 * Read the full durable event log: 0.1.2-rc.1 replaced the `Session.events`
 * property with on-demand readers; 0.1.1-rc.2 still exposes the property.
 */
export function sessionEvents(session: object): readonly SessionEvent[] {
  const host = session as {
    events?: readonly SessionEvent[]
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
  }
  if (typeof host.snapshotEvents === 'function') return host.snapshotEvents()
  return host.events ?? []
}

/**
 * Walk the durable log without copying it. Prefer `eventAt` so resume does
 * not materialize a second array of every chunk.
 */
export function forEachSessionEvent(
  session: object,
  visit: (event: SessionEvent) => void,
): void {
  const host = session as {
    seq?: number
    eventAt?: (seq: number) => SessionEvent | undefined
    events?: readonly SessionEvent[]
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
  }
  if (typeof host.eventAt === 'function' && typeof host.seq === 'number') {
    const length = host.seq
    for (let seq = 0; seq < length; seq += 1) {
      const event = host.eventAt(seq)
      if (event !== undefined) visit(event)
    }
    return
  }
  for (const event of sessionEvents(host)) visit(event)
}

/** Events folded between event-loop turns while a long log is replayed. */
export const REPLAY_YIELD_EVERY = 200

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => { setImmediate(resolve) })
}

/**
 * {@link forEachSessionEvent} for the resume replay. A synchronous walk of a
 * large log blocks the loop for its whole duration, which freezes the TUI on
 * the pre-replay frame: the relay's RTT frame and the render timer cannot run,
 * so the footer keeps painting `SSH ○○○○` and the transcript never fills in
 * until the walk ends. Yielding every few hundred events keeps both flowing.
 *
 * @param halt - stop early when the TUI was disposed mid-replay.
 */
export async function forEachSessionEventAsync(
  session: object,
  visit: (event: SessionEvent) => void,
  yieldEvery = REPLAY_YIELD_EVERY,
  halt: () => boolean = () => false,
): Promise<void> {
  const host = session as {
    seq?: number
    eventAt?: (seq: number) => SessionEvent | undefined
    events?: readonly SessionEvent[]
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
  }
  if (typeof host.eventAt === 'function' && typeof host.seq === 'number') {
    const length = host.seq
    for (let seq = 0; seq < length; seq += 1) {
      if (halt()) return
      const event = host.eventAt(seq)
      if (event !== undefined) visit(event)
      if ((seq + 1) % yieldEvery === 0) await yieldToEventLoop()
    }
    return
  }
  let seen = 0
  for (const event of sessionEvents(host)) {
    if (halt()) return
    visit(event)
    seen += 1
    if (seen % yieldEvery === 0) await yieldToEventLoop()
  }
}

/** Header fields the picker and resume path actually read. */
export interface SessionHeaderLike {
  id: string
  createdAt: number
  cwd?: string
  origin?: string
  delegationDepth?: number
}

/** Logical log plus the header it belongs to. */
export interface SessionInspectionLike {
  events: readonly unknown[]
  meta?: SessionHeaderLike
  header?: SessionHeaderLike
}

function asHeader(value: unknown): SessionHeaderLike | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.id === 'string' && typeof record.createdAt === 'number') {
    return record as unknown as SessionHeaderLike
  }
  if (record.header !== undefined) return asHeader(record.header)
  if (record.meta !== undefined) return asHeader(record.meta)
  return undefined
}

/**
 * 0.1.2 `list()` returns headers; 0.1.5 returns `{ header, revision, … }`
 * snapshots. Normalize to headers so the picker does not care which host
 * it is talking to.
 */
export async function listPersistenceHeaders(persistence: object): Promise<SessionHeaderLike[]> {
  const host = persistence as { list?: (arg?: unknown) => Promise<unknown> }
  if (typeof host.list !== 'function') return []
  const listed = await host.list()
  if (!Array.isArray(listed)) return []
  const headers: SessionHeaderLike[] = []
  for (const item of listed) {
    const header = asHeader(item)
    if (header !== undefined) headers.push(header)
  }
  return headers
}

/**
 * 0.1.2 `inspect(id)` returns `{ meta, events }`. 0.1.5 dropped inspect in
 * favour of `open(id, 'read')` + `handle.read()`. Close the handle so a
 * listing pass does not pin write ownership.
 */
export async function inspectPersistenceSession(
  persistence: object,
  id: unknown,
): Promise<SessionInspectionLike> {
  const host = persistence as {
    inspect?: (id: unknown, signal?: AbortSignal) => Promise<unknown>
    open?: (id: unknown, access: string, options?: unknown) => Promise<unknown>
  }
  if (typeof host.inspect === 'function') {
    const inspection = await host.inspect(id)
    const events = (inspection as { events?: readonly unknown[] } | undefined)?.events ?? []
    return { events, meta: asHeader(inspection), header: asHeader(inspection) }
  }
  if (typeof host.open !== 'function') {
    throw new Error('dsh-session-persistence: neither inspect nor open is available')
  }
  const handle = await host.open(id, 'read') as {
    header?: SessionHeaderLike
    read?: (offset?: number, length?: number) => Promise<{ events?: readonly unknown[] }>
    close?: () => Promise<void>
  }
  try {
    const slice = typeof handle.read === 'function' ? await handle.read() : { events: [] }
    return {
      events: slice.events ?? [],
      header: handle.header,
      meta: handle.header,
    }
  } finally {
    if (typeof handle.close === 'function') {
      try {
        await handle.close()
      } catch {
        // Listing must not fail because a read handle's teardown raced.
      }
    }
  }
}

/** 0.1.2 owns `locate(header)`; 0.1.5 hid it on the JSONL backend. */
export function persistenceLocate(
  persistence: object,
  meta: object,
): { path?: string } | undefined {
  const locate = (persistence as {
    locate?: (header: object) => { path?: string } | undefined
  }).locate
  if (typeof locate !== 'function') return undefined
  return locate(meta)
}

/**
 * 0.1.2 command input advertised `images`; 0.1.5 renamed the flag to
 * `attachments`. Either true means the slash command accepts composer files.
 */
export function commandAcceptsAttachments(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  const record = input as { images?: unknown; attachments?: unknown }
  return record.images === true || record.attachments === true
}

/** One model stream chunk, from either `assistant/chunk` or `agent/assistant-stream`. */
export interface StreamChunkLike {
  type: string
  text?: string
  /** `tool-call-delta` argument fragment. */
  argumentsDelta?: string
  /** `tool-call-delta` tool name, present on the first fragment. */
  name?: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

/**
 * Whether one chunk carries the model's first output token, matching the host's
 * own `isTokenDelta`: a non-empty text/reasoning fragment, or a tool-call
 * fragment (name-bearing deltas included). Thinking-first models therefore
 * start the latency clock on their first reasoning token, not on the first
 * visible answer token.
 */
export function isTokenDeltaChunk(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const record = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  if (record.type === 'text-delta' || record.type === 'reasoning-delta') {
    return typeof record.text === 'string' && record.text !== ''
  }
  if (record.type === 'tool-call-delta') {
    return (typeof record.argumentsDelta === 'string' && record.argumentsDelta !== '') || record.name !== undefined
  }
  return false
}

/**
 * Turn/step of a live `agent/assistant-stream` `start` frame. The chunk frames
 * this opens carry no turn/step at all, so callers must remember them or every
 * live chunk is attributed to step 0 (which silently disabled TTFT, decode
 * speed, and usage de-duplication).
 */
export function streamFrameOwner(frame: unknown): { attemptId: unknown; turn: number; step: number } | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const record = frame as { type?: unknown; attemptId?: unknown; turn?: unknown; step?: unknown }
  if (record.type !== 'start') return undefined
  return {
    attemptId: record.attemptId,
    turn: typeof record.turn === 'number' ? record.turn : 0,
    step: typeof record.step === 'number' ? record.step : 0,
  }
}

/** Attempt id of a live chunk/end frame, used to match it to its `start`. */
export function streamFrameAttemptId(frame: unknown): unknown {
  if (frame === null || typeof frame !== 'object') return undefined
  const record = frame as { type?: unknown; attemptId?: unknown }
  if (record.type !== 'chunk' && record.type !== 'end') return undefined
  return record.attemptId
}

/**
 * First token time inside a durable compact assistant stream
 * (`assistant/message.stream`). Mirrors the host's
 * `assistantStreamFirstTokenTime`: packed delta runs place member `i` at
 * `time0 + dt[0..i-1]`, raw chunk records carry their own time.
 */
export function streamFirstTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const entry of stream) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as {
      type?: unknown
      time?: unknown
      chunk?: unknown
      time0?: unknown
      dt?: unknown
      texts?: unknown
      args?: unknown
      name?: unknown
    }
    if (record.type === 'chunk') {
      if (typeof record.time === 'number' && Number.isFinite(record.time) && isTokenDeltaChunk(record.chunk)) {
        return record.time
      }
      continue
    }
    if (record.type !== 'text-chunks' && record.type !== 'reasoning-chunks' && record.type !== 'tool-call-chunks') continue
    if (typeof record.time0 !== 'number' || !Number.isFinite(record.time0)) continue
    // A name-bearing tool-call run starts at its first member.
    if (record.type === 'tool-call-chunks' && record.name !== undefined) return record.time0
    const fragments = record.type === 'tool-call-chunks' ? record.args : record.texts
    if (!Array.isArray(fragments)) continue
    const dt = Array.isArray(record.dt) ? record.dt : []
    let time = record.time0
    for (let index = 0; index < fragments.length; index++) {
      if (index > 0 && typeof dt[index - 1] === 'number' && Number.isFinite(dt[index - 1])) {
        time += dt[index - 1] as number
      }
      if (fragments[index] !== '') return Number.isFinite(time) ? time : undefined
    }
  }
  return undefined
}

/**
 * Durable `assistant/chunk` payload, or a live stream frame's inner chunk.
 *
 * `fallback` supplies the turn/step for live chunk frames, which do not carry
 * them (see {@link streamFrameOwner}).
 */
export function streamChunkOf(eventOrFrame: unknown, fallback?: { turn: number; step: number }): {
  chunk: StreamChunkLike
  turn: number
  step: number
  time: number
  /**
   * False when neither the source nor a fallback carried a real turn/step.
   * Usage folded under such a chunk would be filed under a bogus key (0:0)
   * that `step/end` never clears, inflating the session totals forever.
   */
  stepKnown: boolean
} | undefined {
  if (eventOrFrame === null || typeof eventOrFrame !== 'object') return undefined
  const record = eventOrFrame as {
    type?: unknown
    time?: unknown
    data?: { chunk?: StreamChunkLike; turn?: unknown; step?: unknown }
    chunk?: StreamChunkLike
    turn?: unknown
    step?: unknown
  }
  const chunk = record.data?.chunk ?? (record.type === 'chunk' ? record.chunk : undefined)
  if (chunk === undefined || typeof chunk.type !== 'string') return undefined
  const turn = record.data?.turn ?? record.turn
  const step = record.data?.step ?? record.step
  const time = record.time
  const explicit = typeof turn === 'number' && typeof step === 'number'
  return {
    chunk,
    turn: explicit ? turn as number : fallback?.turn ?? 0,
    step: explicit ? step as number : fallback?.step ?? 0,
    time: typeof time === 'number' && Number.isFinite(time) ? time : 0,
    stepKnown: explicit || fallback !== undefined,
  }
}

/** Durable event type as a plain string so 0.1.5 hosts can omit `assistant/chunk`. */
export function sessionEventType(event: unknown): string {
  if (event === null || typeof event !== 'object') return ''
  const type = (event as { type?: unknown }).type
  return typeof type === 'string' ? type : ''
}

/** True when this event is a live-or-durable assistant token that replay should skip. */
export function isAssistantStreamEvent(event: unknown): boolean {
  const type = sessionEventType(event)
  return type === 'assistant/chunk' || type === 'assistant/attempt'
}

/**
 * Subscribe to a host event that may not exist on the compile-time Events
 * map. 0.1.5 emits `agent/assistant-stream`; 0.1.2 never does. Cordis
 * still accepts the string; the listener is simply never called on 0.1.2.
 */
export function listenHostEvent(
  ctx: { on: (event: never, handler: never) => unknown },
  event: string,
  handler: (...args: unknown[]) => unknown,
): () => void {
  return (ctx.on as (name: string, listener: (...args: unknown[]) => unknown) => () => void)(event, handler)
}
