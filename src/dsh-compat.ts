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
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** Durable `assistant/chunk` payload, or a live stream frame's inner chunk. */
export function streamChunkOf(eventOrFrame: unknown): {
  chunk: StreamChunkLike
  turn: number
  step: number
  time: number
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
  return {
    chunk,
    turn: typeof turn === 'number' ? turn : 0,
    step: typeof step === 'number' ? step : 0,
    time: typeof time === 'number' ? time : 0,
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
