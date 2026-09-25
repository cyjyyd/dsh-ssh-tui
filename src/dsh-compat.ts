/**
 * Dual-stack shims for the dsh 0.1.5-rc and 0.1.7-rc lines (including the
 * 0.1.5-alpha handle API that landed with the former).
 *
 * 0.1.5 resolves settings through `SettingsProvider.get`/`installSection` and
 * exposes session persistence as snapshot `list` plus per-session `open`
 * handles; live tokens arrive on the process-local `agent/assistant-stream`.
 * 0.1.7 replaced the settings service with schema-projected forms. Every shim
 * here picks the API that is actually present so one build runs on either
 * host line.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type z from '@deepseek-ai/schemastery'

/**
 * The source kind this plugin declares for the messages it commits itself: the
 * plan-close nudge and the approval-denied steering notice.
 *
 * These used to ride the released catch-all wrapper —
 * `<kind: 'plugin', plugin: 'dsh-ssh-tui'>` — which 0.1.5 shipped as a member and
 * 0.1.7 deleted ("each producer declares its own `kind` in its own module; there
 * is no shared catch-all `plugin` kind"). Worse than missing on 0.1.7: its V4
 * native admission *refuses* the wrapper outright, so an append under that
 * spelling throws "format v4 message requires a producer-owned source kind" and
 * takes the whole turn down with it — which is what the plan nudge and the
 * approval-denied notice did to any turn they fired in on a V4 session.
 *
 * The producer-owned spelling is the one shape both supported lines admit: the
 * wrapper was only ever mandatory for `system/message` (`SystemMessage['source']`
 * is the `plugin` member on 0.1.5), while user-role messages have always carried
 * a producer's own kind — the 0.1.5 line's own `goal`, `webhook`, and
 * `agent-instructions` producers all commit `kind: '<their name>'`.
 */
export const TUI_SOURCE_KIND = 'dsh-ssh-tui'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-ssh-tui': { kind: 'dsh-ssh-tui' } & ContextFormed
  }
}

/**
 * The kind the V3-to-V4 lane gives the same messages in a converted log.
 *
 * The conversion lifts a released plugin wrapper to the producer's kind when it
 * knows the plugin, and falls back to `plugin:<name>` when it does not — which is
 * this plugin's case, so a resumed V3 session carries the prefixed spelling.
 */
export const TUI_CONVERTED_SOURCE_KIND = `plugin:${TUI_SOURCE_KIND}`

/**
 * Whether a durable message source came from this plugin.
 *
 * Three spellings reach a reader: the producer-owned kind written now, the
 * `plugin:`-prefixed compatibility kind the V3-to-V4 conversion assigns, and the
 * original wrapper (`kind: 'plugin'` + `plugin: 'dsh-ssh-tui'`) that a log
 * committed before this change — or an unconverted V3 file read on the 0.1.5
 * line — still carries.
 *
 * @param kind - the source's `kind`, when it has one.
 * @param plugin - the source's legacy `plugin` field, when it carries the wrapper.
 * @returns whether this plugin produced the message.
 */
export function isTuiMessageSource(kind: unknown, plugin?: unknown): boolean {
  if (kind === TUI_SOURCE_KIND || kind === TUI_CONVERTED_SOURCE_KIND) return true
  return kind === 'plugin' && plugin === TUI_SOURCE_KIND
}

/**
 * Settings namespaces are branded strings at the type level on both supported
 * lines; this cast supplies the brand from a plain literal.
 */
export function settingsNamespace(value: string): SettingsNamespace {
  return value as SettingsNamespace
}

/**
 * Hooks a settings consumer hands to {@link installSettingsSection}.
 *
 * Spelled out locally instead of imported: 0.1.7 deleted the
 * `SettingsSectionHooks` export, and this shape is the whole contract the three
 * call sites use.
 */
export interface SettingsSectionHooks<T> {
  /**
   * Receive the active configuration source: the resolved settings value while
   * a section is attached. Called at attach and again after every change.
   * @param current - thunk returning the currently authoritative value.
   */
  setSource(current: () => T): void
  /**
   * Re-judge anything derived from the source — registration-level facts,
   * memoized resolutions — after an attach or a committed change.
   */
  onChange(): void
  /** Reject a resolved section this consumer could not act on. */
  validate?(value: T): void
}

/** One `describe()` row: a profile entry's id and its live form values. */
interface SettingsDescriptorLike {
  ns: SettingsNamespace
  value: unknown
  /** The user's own layer for this entry; absent when nothing was overridden. */
  user?: unknown
}

/**
 * The settings service as the lines we support expose it.
 *
 * 0.1.5 publishes `get` plus `installSection`, so a consumer reads a namespace
 * and registers its own section. 0.1.7 removed both: a form is projected out of
 * the loader entry's own `Config` schema (`describe()`), and a write addresses
 * that entry id. Feature detection, not a version check, picks the paths.
 */
interface SettingsServiceLike {
  get?: (ns: SettingsNamespace) => unknown
  describe?: (options?: { redactSecrets?: boolean }) => readonly SettingsDescriptorLike[]
  installSection?: (...args: unknown[]) => void
  /** The raw user document, published by 0.1.5 providers. */
  document?: unknown
  /** Context the service emits `settings/document-updated` on. */
  ctx?: Context
}

function settingsService(ctx: Context): SettingsServiceLike | undefined {
  return ctx.get('settings') as unknown as SettingsServiceLike | undefined
}

/** Which settings protocol the running host speaks. */
export type SettingsGeneration = 'legacy' | 'forms'

/** Generations already seen for a context, so an early caller cannot misread. */
const generationCache = new WeakMap<object, SettingsGeneration>()

/** Whether the 0.1.5 preset-roster package is installed beside this plugin. */
function presetRosterInstalled(): boolean {
  try {
    return typeof import.meta.resolve === 'function'
      && import.meta.resolve('@deepseek-ai/dsh-agent-presets') !== undefined
  } catch {
    // Not installed (0.1.7 dropped it) or resolution unavailable.
    return false
  }
}

/**
 * The host's settings generation, as feature detection rather than a version.
 *
 * `legacy` (0.1.5) resolves a namespace through `settings.get`; `forms` (0.1.7)
 * has no `get` and projects a form per loader entry. Callers that differ by
 * generation — which profile rows a terminal profile must mount, for one — read
 * it here instead of sniffing package versions.
 *
 * Before the service exists (a plugin applies before it is mounted) the same
 * split shows up as the roster package's absence, and the answer is memoized as
 * soon as the service is seen so a later call cannot disagree with an earlier
 * one.
 */
export function hostSettingsGeneration(ctx: Context): SettingsGeneration {
  const cached = generationCache.get(ctx)
  if (cached !== undefined) return cached
  const service = settingsService(ctx)
  if (service !== undefined) {
    const generation: SettingsGeneration = typeof service.get === 'function' ? 'legacy' : 'forms'
    generationCache.set(ctx, generation)
    return generation
  }
  return presetRosterInstalled() ? 'legacy' : 'forms'
}

/** `describe()` re-projects every entry's schema, so one frame shares a walk. */
const DESCRIPTORS_TTL_MS = 250
const descriptorCache = new WeakMap<object, { at: number; rows: readonly SettingsDescriptorLike[] }>()

function descriptorsOf(service: SettingsServiceLike & object): readonly SettingsDescriptorLike[] | undefined {
  if (typeof service.describe !== 'function') return undefined
  const now = Date.now()
  const cached = descriptorCache.get(service)
  if (cached !== undefined && now - cached.at < DESCRIPTORS_TTL_MS) return cached.rows
  const rows = service.describe()
  descriptorCache.set(service, { at: now, rows })
  return rows
}

/** Forget the memoized descriptors so the next read re-walks the forms. */
export function invalidateSettingsCache(ctx: Context): void {
  const service = settingsService(ctx)
  if (service !== undefined) descriptorCache.delete(service)
}

/**
 * Read one settings section.
 *
 * 0.1.5 resolves it through `get(ns)`. 0.1.7 has no `get`, so the value comes
 * from the entry's descriptor, which projects the live config — volatile fields
 * only, i.e. exactly the fields its form exposes — and returns `undefined` when
 * no entry carries that id.
 */
export function readSettingsSection(ctx: Context, ns: SettingsNamespace): unknown {
  const service = settingsService(ctx)
  if (service === undefined) return undefined
  if (typeof service.get === 'function') return service.get(ns)
  return descriptorsOf(service)?.find(row => row.ns === ns)?.value
}

/**
 * The user's own settings document, keyed by namespace, on either line.
 *
 * 0.1.5 publishes it as `settings.document`. 0.1.7 dropped the property — the
 * document is the profile patch now — but each descriptor still carries the
 * user layer it was built from, so the same view is reconstructible. Callers
 * that ask "did the user configure this?" must use this, not
 * {@link readSettingsSection}: a resolved read also carries the composition
 * base and schema defaults, which is exactly what such a caller must not
 * mistake for a user choice.
 */
export function settingsDocument(ctx: Context): Record<string, unknown> | undefined {
  const service = settingsService(ctx)
  if (service === undefined) return undefined
  const raw = service.document
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  const rows = descriptorsOf(service)
  if (rows === undefined) return undefined
  return Object.fromEntries(
    rows.filter(row => row.user !== undefined).map(row => [row.ns, row.user]),
  )
}

/**
 * Mark one schema field as form-writable on the 0.1.7 line.
 *
 * 0.1.7 projects only fields whose schema node carries the `volatile` meta, and
 * refuses a settings write to any other path. The 0.1.5 schemastery (3.18.2)
 * has no such builder, so the call is feature-detected rather than typed: on
 * that line the marker means nothing and the schema is returned untouched.
 */
export function liveField<T>(schema: z<T>): z<T> {
  const builder = schema as unknown as { volatile?: () => z<T> }
  return typeof builder.volatile === 'function' ? builder.volatile() : schema
}

/**
 * Register a settings section.
 *
 * 0.1.5 publishes the `settings` service with `installSection`, callable only
 * once that service is injected (plugins apply before it, so `ctx.inject` must
 * defer — same pattern the harness's own packages use).
 *
 * 0.1.7 removed it. The section is now the loader entry's own `Config`
 * schema — this plugin's is `ssh-tui`, and the two auxiliary namespaces are
 * carried by the `dsh-ssh-tui/settings-*` rows in `cordis.patch.yml` — so the
 * only thing left for a consumer to wire is the live read (`setSource`) and the
 * change notification (`onChange`).
 */
export function installSettingsSection<T>(
  ctx: Context,
  ns: SettingsNamespace,
  schema: z<T>,
  entry: T,
  hooks: SettingsSectionHooks<T>,
): void {
  const host = ctx as {
    inject?: (services: readonly string[], callback: (injected: unknown) => void) => void
  }
  if (typeof host.inject !== 'function') {
    throw new Error('dsh-settings: ctx.inject is unavailable')
  }
  host.inject(['settings'], (injected) => {
    const holder = injected as { settings?: unknown }
    const service = (holder.settings ?? injected) as unknown as SettingsServiceLike
    if (typeof service.installSection === 'function') {
      service.installSection(ctx, ns, schema, entry, hooks)
      return
    }
    if (typeof service.describe !== 'function') {
      throw new Error('dsh-settings: settings service has no installSection')
    }
    hooks.setSource(() => readSettingsSection(ctx, ns) as T)
    // 0.1.7 emits `settings/document-updated` on the service's own context,
    // which is where a consumer outside the root fiber has to listen. A host
    // that does not expose it still gets the attach read below.
    const owner = service.ctx as unknown as {
      on?: (name: string, listener: (changed: unknown) => void) => (() => void) | undefined
    } | undefined
    if (typeof owner?.on === 'function') {
      const off = owner.on('settings/document-updated', (changed) => {
        if (changed !== ns) return
        invalidateSettingsCache(ctx)
        hooks.onChange()
      })
      if (typeof off === 'function') ctx.effect(() => off)
    }
    hooks.onChange()
  })
}

/**
 * Whether a tool result reports failure.
 *
 * 0.1.5 carries `isError` on the `tool-result` content block; 0.1.7 removed
 * that block from `ContentBlockMap` and moved the flag onto the message
 * itself. Both are read, so one build understands either host.
 */
export function toolResultFailed(message: unknown): boolean {
  if (message === null || typeof message !== 'object') return false
  if ((message as { isError?: unknown }).isError === true) return true
  const first = (message as { content?: readonly unknown[] }).content?.[0]
  return first !== null && typeof first === 'object'
    && (first as { isError?: unknown }).isError === true
}

/**
 * Read the full durable event log. Both supported lines read it on demand
 * through `snapshotEvents()`.
 */
export function sessionEvents(session: object): readonly SessionEvent[] {
  const host = session as {
    snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEvent[]
  }
  return typeof host.snapshotEvents === 'function' ? host.snapshotEvents() : []
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
  header?: SessionHeaderLike
  /**
   * Backend state for the slice. `detached` means the backend never
   * materialized a physical artifact (the writer is in this process and has
   * not flushed yet), so `events: []` says nothing about whether the session
   * is blank. Callers must not delete artifacts on a `detached` read.
   */
  eventState?: string
}

/** The `header` of one `list()` snapshot, when it carries a plausible one. */
function asHeader(value: unknown): SessionHeaderLike | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const header = (value as { header?: unknown }).header
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return undefined
  const record = header as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.createdAt !== 'number') return undefined
  return record as unknown as SessionHeaderLike
}

/**
 * Both supported lines return `{ header, revision, … }` snapshots from
 * `list()`; normalize to the header so the picker does not care which host
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
 * Read one session through `open(id, 'read')` + `handle.read()`, the access
 * both supported lines expose. Close the handle so a listing pass does not pin
 * write ownership.
 */
export async function inspectPersistenceSession(
  persistence: object,
  id: unknown,
): Promise<SessionInspectionLike> {
  const host = persistence as {
    open?: (id: unknown, access: string, options?: unknown) => Promise<unknown>
  }
  if (typeof host.open !== 'function') {
    throw new Error('dsh-session-persistence: open is not available')
  }
  const handle = await host.open(id, 'read') as {
    header?: SessionHeaderLike
    read?: (offset?: number, length?: number) => Promise<{ events?: readonly unknown[]; eventState?: string }>
    close?: () => Promise<void>
  }
  try {
    if (typeof handle.read !== 'function') {
      // Reporting an absent log as an empty one used to look like a blank
      // session, and the picker deleted the session's artifacts on that
      // verdict. An unreadable log stays visible instead.
      throw new Error('dsh-session-persistence: read handle exposes no read(); refusing to report an empty log')
    }
    const slice = await handle.read()
    if (slice === null || typeof slice !== 'object' || !Array.isArray(slice.events)) {
      throw new Error('dsh-session-persistence: read handle returned no readable event log')
    }
    return {
      events: slice.events,
      header: handle.header,
      ...(typeof slice.eventState === 'string' ? { eventState: slice.eventState } : {}),
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

/**
 * A session's artifact path from its header. Both supported lines still
 * implement `locate()` on the JSONL backend, but their typings keep it
 * private, so the call stays feature-detected.
 */
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

/** Whether a command's input admits the composer's attachments. */
export function commandAcceptsAttachments(input: unknown): boolean {
  if (input === null || typeof input !== 'object') return false
  return (input as { attachments?: unknown }).attachments === true
}

/** One chunk from a live `agent/assistant-stream` frame. */
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
 * A live `agent/assistant-stream` chunk frame's inner chunk plus its framing.
 *
 * `fallback` supplies the turn/step, which chunk frames do not carry (see
 * {@link streamFrameOwner}).
 */
export function streamChunkOf(frame: unknown, fallback?: { turn: number; step: number }): {
  chunk: StreamChunkLike
  turn: number
  step: number
  time: number
  /**
   * False when neither the frame nor a fallback carried a real turn/step.
   * Usage folded under such a chunk would be filed under a bogus key (0:0)
   * that `step/end` never clears, inflating the session totals forever.
   */
  stepKnown: boolean
} | undefined {
  if (frame === null || typeof frame !== 'object') return undefined
  const record = frame as {
    type?: unknown
    time?: unknown
    chunk?: StreamChunkLike
    turn?: unknown
    step?: unknown
  }
  if (record.type !== 'chunk') return undefined
  const chunk = record.chunk
  if (chunk === undefined || typeof chunk.type !== 'string') return undefined
  const turn = record.turn
  const step = record.step
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

/**
 * Subscribe to a host event whose scoped payload type does not match this
 * build's `Events` map. Both supported lines emit `agent/assistant-stream`,
 * and Cordis accepts the plain event name at runtime.
 */
export function listenHostEvent(
  ctx: { on: (event: never, handler: never) => unknown },
  event: string,
  handler: (...args: unknown[]) => unknown,
): () => void {
  return (ctx.on as (name: string, listener: (...args: unknown[]) => unknown) => () => void)(event, handler)
}
