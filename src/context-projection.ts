/**
 * CONTEXT.C1 — pure, read-only projection of the current Session.
 *
 * This module deliberately knows nothing about the TUI, persistence, the
 * Session store, or writes. It consumes a header, the current durable event
 * array, the current Surface membership, and the exact inherited cut, then
 * describes candidate ranges and evidence. Candidate ordinals/ranges are not
 * stable Segment identities and are never persisted.
 *
 * @module context-projection
 */

import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'

/** Hard ceiling applied before the caller materializes a full event snapshot. */
export const MAX_CONTEXT_EVENTS = 250_000
/** Display ceiling for candidate ranges. */
export const MAX_CONTEXT_CANDIDATES = 100
/** Display ceiling for compaction transactions. */
export const MAX_CONTEXT_COMPACTIONS = 50
/** Display ceiling for prune records. */
export const MAX_CONTEXT_PRUNES = 50

/** The five provenance classes used by the read-only view. */
export type ContextEvidence =
  | 'DURABLE_EVENT'
  | 'HEADER_METADATA'
  | 'LIVE_ONLY'
  | 'DERIVED_HEURISTIC'
  | 'NOT_REPRESENTED'

/** Stable warning codes; the formatter owns their localized text. */
export type ContextWarning =
  | 'HEADER_UNAVAILABLE'
  | 'EVENT_COUNT_UNAVAILABLE'
  | 'EVENT_COUNT_MISMATCH'
  | 'EVENT_LIMIT_EXCEEDED'
  | 'CURRENT_SURFACE_UNAVAILABLE'
  | 'INHERITED_COUNT_UNAVAILABLE'
  | 'INHERITED_MARKER_UNAVAILABLE'
  | 'INHERITED_CUT_MISMATCH'
  | 'NO_DIRECT_USER_BOUNDARY'
  | 'CANDIDATE_LIMIT'
  | 'COMPACTION_LIMIT'
  | 'PRUNE_LIMIT'
  | 'COMPACTION_INCOMPLETE'
  | 'COMPACTION_FAILED'
  | 'COMPACTION_REPLACEMENT_MISSING'
  | 'PRUNE_REPLACEMENT_MISSING'

/** Header fields safe to display; cwd is intentionally omitted. */
export interface ContextHeaderView {
  id: string
  createdAt: number
  parentSession?: string
  isSeeded: boolean
  origin?: string
  delegationDepth?: number
  agentPreset?: string
}

/** Event-type counts inside one candidate range. */
export interface ContextEventCounts {
  user: number
  assistant: number
  toolCall: number
  toolResult: number
  turn: number
  step: number
  other: number
}

/** One display-only candidate range. */
export interface ContextCandidateView {
  /** 1-based display ordinal; not a stable Segment identity. */
  ordinal: number
  startSeq: number
  endSeq: number
  /** The direct-user event that starts the range. */
  userSeq: number
  boundary: 'user-declared'
  /** Candidate grouping is always a derived interpretation. */
  heuristic: true
  eventCount: number
  counts: ContextEventCounts
  turnStart?: number
  turnEnd?: number
  stepCount: number
  currentSurfaceNodes: number
  shadowedNodes: number
  prunedNodes: number
  compactionIds: readonly string[]
}

/** One compaction transaction, keyed by its transaction id, never a Segment id. */
export interface ContextCompactionView {
  id: string
  startSeq?: number
  summarySeq?: number
  endSeq?: number
  status: 'complete' | 'incomplete' | 'failed'
  turn: number | null
  sourceCommandId?: string
  shadowedSeqs: readonly number[]
  shadowedTokenCount?: number
  replacementSeq?: number
  error?: string
}

/** One prune record; exact pruned nodes, not a whole-Segment deletion. */
export interface ContextPruneView {
  seq: number
  shadowedSeqs: readonly number[]
  replacementSeq?: number
}

/** Verified fork/seed prefix. */
export interface ContextInheritedView {
  parentSession?: string
  cut: number
  markerSeq: number
  verified: true
}

/** Open tail vs committed interrupted closer. */
export interface ContextInterruptedView {
  state: 'open-heuristic' | 'durable'
  turn?: number
  seq?: number
}

/** Read-only projection result. */
export interface ContextProjection {
  header?: ContextHeaderView
  eventCount?: number
  maxEvents: number
  limitExceeded: boolean
  currentSurface: 'available' | 'unavailable'
  currentSurfaceNodeCount: number
  candidates: readonly ContextCandidateView[]
  compactions: readonly ContextCompactionView[]
  prunes: readonly ContextPruneView[]
  inherited?: ContextInheritedView
  interrupted?: ContextInterruptedView
  /** Relay has no supported Session archive read API. */
  archive: 'UNAVAILABLE'
  /** No Host durable tombstone/API exists. */
  deleted: 'NOT_REPRESENTED'
  warnings: readonly ContextWarning[]
}

/** Input contract; `eventCount` must be checked by the caller before snapshotting. */
export interface ContextProjectionInput {
  header: SessionHeader | undefined
  eventCount: number | undefined
  events: readonly SessionEvent[]
  /** Current Surface membership, never a lifecycle flag. */
  activeNodeSeqs?: readonly number[]
  /** Exact fork-inherited prefix length, when the Session exposes it. */
  inheritedEventCount?: number
}

interface RawEvent {
  type: string
  seq: number
  time: number
  data?: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: readonly number[]
}

interface TurnSpan {
  turn: number
  startSeq: number
  endSeq?: number
  reason?: string
}

interface StepSpan {
  turn: number
  step: number
  startSeq: number
  endSeq?: number
}

interface WorkingCompaction {
  id: string
  startSeq?: number
  summarySeq?: number
  endSeq?: number
  turn: number | null
  sourceCommandId?: string
  shadowedSeqs: number[]
  shadowedTokenCount?: number
  replacementSeq?: number
  /** Summary seq actually cited by the replacement's sourceEventSeqs. */
  replacementSummarySeq?: number
  error?: string
}

interface WorkingPrune {
  seq: number
  shadowedSeqs: number[]
  replacementSeq?: number
}

interface Observed {
  directUserSeqs: number[]
  turns: TurnSpan[]
  steps: StepSpan[]
  compactions: WorkingCompaction[]
  prunes: WorkingPrune[]
  lastInheritedMarker: RawEvent | undefined
  lastInterruptedEnd: RawEvent | undefined
  openTurns: Map<number, number>
  warnings: ContextWarning[]
}

interface PendingReplacement {
  kind: 'compaction' | 'prune'
  compaction?: WorkingCompaction
  prune?: WorkingPrune
  summarySeq?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function raw(event: SessionEvent): RawEvent {
  return event as unknown as RawEvent
}

function dataOf(event: RawEvent): Record<string, unknown> | undefined {
  return isRecord(event.data) ? event.data : undefined
}

function sourceKind(event: RawEvent): string | undefined {
  const source = dataOf(event)?.['source']
  return isRecord(source) && typeof source['kind'] === 'string' ? source['kind'] : undefined
}

function isDirectUser(event: RawEvent): boolean {
  return event.type === 'user/message' && sourceKind(event) === 'user'
}

function isReplacement(event: RawEvent): boolean {
  return isRecord(event.surfaceOp) && event.surfaceOp['op'] === 'replace'
}

function safeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function seqArray(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is number => safeSeq(entry) !== undefined)
}

function unique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right)
}

/** Deduplicate while preserving the producer's recorded surface order. */
function stableUnique(values: readonly number[]): number[] {
  const seen = new Set<number>()
  const result: number[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

/** Whether one raw replacement event cites the given summary seq. */
function citesSeq(event: RawEvent, seq: number): boolean {
  return Array.isArray(event.sourceEventSeqs) && event.sourceEventSeqs.includes(seq)
}

function addWarning(warnings: ContextWarning[], warning: ContextWarning): void {
  if (!warnings.includes(warning)) warnings.push(warning)
}

function headerView(header: SessionHeader): ContextHeaderView {
  return {
    id: String(header.id),
    createdAt: header.createdAt,
    ...(header.parentSession === undefined ? {} : { parentSession: String(header.parentSession) }),
    isSeeded: header.isSeeded === true,
    ...(header.origin === undefined ? {} : { origin: String(header.origin) }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: String(header.agentPreset) }),
  }
}

function emptyCounts(): ContextEventCounts {
  return { user: 0, assistant: 0, toolCall: 0, toolResult: 0, turn: 0, step: 0, other: 0 }
}

function emptyProjection(
  header: ContextHeaderView | undefined,
  eventCount: number | undefined,
  limitExceeded: boolean,
  warnings: ContextWarning[],
  activeNodeSeqs?: readonly number[],
): ContextProjection {
  const active = activeNodeSeqs === undefined ? undefined : unique(activeNodeSeqs.filter(seq => safeSeq(seq) !== undefined))
  return {
    ...(header === undefined ? {} : { header }),
    ...(eventCount === undefined ? {} : { eventCount }),
    maxEvents: MAX_CONTEXT_EVENTS,
    limitExceeded,
    currentSurface: active === undefined ? 'unavailable' : 'available',
    currentSurfaceNodeCount: active?.length ?? 0,
    candidates: [],
    compactions: [],
    prunes: [],
    archive: 'UNAVAILABLE',
    deleted: 'NOT_REPRESENTED',
    warnings,
  }
}

function observe(events: readonly SessionEvent[]): Observed {
  const observed: Observed = {
    directUserSeqs: [],
    turns: [],
    steps: [],
    compactions: [],
    prunes: [],
    lastInheritedMarker: undefined,
    lastInterruptedEnd: undefined,
    openTurns: new Map(),
    warnings: [],
  }
  const turns = new Map<number, TurnSpan>()
  const steps = new Map<string, StepSpan>()
  const compactions = new Map<string, WorkingCompaction>()
  let pending: PendingReplacement | undefined

  const clearPending = (replaced: boolean): void => {
    if (pending === undefined) return
    if (!replaced) {
      if (pending.kind === 'compaction') addWarning(observed.warnings, 'COMPACTION_REPLACEMENT_MISSING')
      else addWarning(observed.warnings, 'PRUNE_REPLACEMENT_MISSING')
    }
    pending = undefined
  }

  for (const value of events) {
    const event = raw(value)
    if (pending !== undefined) {
      let replaced = false
      if (pending.kind === 'compaction' && pending.compaction !== undefined && pending.summarySeq !== undefined
        && event.type === 'user/message' && isReplacement(event) && citesSeq(event, pending.summarySeq)) {
        pending.compaction.replacementSeq = event.seq
        pending.compaction.replacementSummarySeq = pending.summarySeq
        replaced = true
      } else if (pending.kind === 'prune' && pending.prune !== undefined && event.type === 'tool/result' && isReplacement(event)) {
        pending.prune.replacementSeq = event.seq
        replaced = true
      }
      clearPending(replaced)
    }

    const data = dataOf(event)
    switch (event.type) {
      case 'turn/start': {
        const turn = safeSeq(data?.['turn'])
        if (turn === undefined) break
        const existing = turns.get(turn)
        if (existing === undefined) {
          const span: TurnSpan = { turn, startSeq: event.seq }
          turns.set(turn, span)
          observed.turns.push(span)
        } else if (existing.endSeq === undefined) {
          existing.startSeq = Math.min(existing.startSeq, event.seq)
        }
        observed.openTurns.set(turn, event.seq)
        break
      }
      case 'turn/end': {
        const turn = safeSeq(data?.['turn'])
        if (turn === undefined) break
        const existing = turns.get(turn) ?? { turn, startSeq: event.seq }
        if (!turns.has(turn)) observed.turns.push(existing)
        existing.endSeq = event.seq
        const reason = data?.['reason']
        if (isRecord(reason) && typeof reason['kind'] === 'string') {
          existing.reason = reason['kind']
          if (reason['kind'] === 'interrupted') observed.lastInterruptedEnd = event
          else observed.lastInterruptedEnd = undefined
        }
        observed.openTurns.delete(turn)
        break
      }
      case 'step/start': {
        const turn = safeSeq(data?.['turn'])
        const step = safeSeq(data?.['step'])
        if (turn === undefined || step === undefined) break
        const key = `${turn}:${step}`
        const existing = steps.get(key) ?? { turn, step, startSeq: event.seq }
        if (!steps.has(key)) {
          steps.set(key, existing)
          observed.steps.push(existing)
        }
        break
      }
      case 'step/end': {
        const turn = safeSeq(data?.['turn'])
        const step = safeSeq(data?.['step'])
        if (turn === undefined || step === undefined) break
        const key = `${turn}:${step}`
        const existing = steps.get(key) ?? { turn, step, startSeq: event.seq }
        if (!steps.has(key)) {
          steps.set(key, existing)
          observed.steps.push(existing)
        }
        existing.endSeq = event.seq
        break
      }
      case 'user/message': {
        if (isDirectUser(event)) observed.directUserSeqs.push(event.seq)
        break
      }
      case 'compaction/start': {
        const id = typeof data?.['compactionId'] === 'string' ? data['compactionId'] : undefined
        if (id === undefined) break
        const turn = data?.['turn'] === null ? null : safeSeq(data?.['turn']) ?? null
        const transaction = compactions.get(id) ?? {
          id,
          turn,
          shadowedSeqs: [],
        }
        if (!compactions.has(id)) {
          compactions.set(id, transaction)
          observed.compactions.push(transaction)
        }
        transaction.startSeq = event.seq
        transaction.turn = turn
        if (typeof data?.['sourceCommandId'] === 'string') transaction.sourceCommandId = data['sourceCommandId']
        break
      }
      case 'compaction/summary': {
        const id = typeof data?.['compactionId'] === 'string' ? data['compactionId'] : undefined
        if (id === undefined) break
        const transaction = compactions.get(id) ?? {
          id,
          turn: null,
          shadowedSeqs: [],
        }
        if (!compactions.has(id)) {
          compactions.set(id, transaction)
          observed.compactions.push(transaction)
        }
        transaction.summarySeq = event.seq
        transaction.shadowedSeqs = stableUnique(seqArray(data?.['shadowedSeqs']))
        const tokens = data?.['shadowedTokenCount']
        if (typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0) transaction.shadowedTokenCount = tokens
        pending = { kind: 'compaction', compaction: transaction, summarySeq: event.seq }
        break
      }
      case 'compaction/end': {
        const id = typeof data?.['compactionId'] === 'string' ? data['compactionId'] : undefined
        if (id === undefined) break
        const transaction = compactions.get(id) ?? {
          id,
          turn: null,
          shadowedSeqs: [],
        }
        if (!compactions.has(id)) {
          compactions.set(id, transaction)
          observed.compactions.push(transaction)
        }
        transaction.endSeq = event.seq
        if (typeof data?.['error'] === 'string' && data['error'] !== '') transaction.error = data['error']
        break
      }
      case 'compaction/prune': {
        const prune: WorkingPrune = {
          seq: event.seq,
          shadowedSeqs: stableUnique(seqArray(data?.['shadowedSeqs'])),
        }
        observed.prunes.push(prune)
        pending = { kind: 'prune', prune }
        break
      }
      case 'session/end-seed': {
        if (data?.['inherited'] === true) observed.lastInheritedMarker = event
        break
      }
      default:
        break
    }
  }
  clearPending(false)
  return observed
}

/** Only an observed start → summary → cited replacement → successful end is complete. */
function statusOf(transaction: WorkingCompaction): ContextCompactionView['status'] {
  if (transaction.endSeq !== undefined && transaction.error !== undefined) return 'failed'
  if (transaction.startSeq === undefined
    || transaction.summarySeq === undefined
    || transaction.replacementSeq === undefined
    || transaction.endSeq === undefined) return 'incomplete'
  if (!(transaction.startSeq < transaction.summarySeq
    && transaction.summarySeq < transaction.replacementSeq
    && transaction.replacementSeq < transaction.endSeq)) return 'incomplete'
  if (transaction.replacementSummarySeq !== transaction.summarySeq) return 'incomplete'
  return 'complete'
}

/** Project one current Session without reading persistence or another Session. */
export function projectContext(input: ContextProjectionInput): ContextProjection {
  const header = input.header === undefined ? undefined : headerView(input.header)
  const warnings: ContextWarning[] = []
  const count = typeof input.eventCount === 'number' && Number.isSafeInteger(input.eventCount) && input.eventCount >= 0
    ? input.eventCount
    : undefined
  if (input.header === undefined) addWarning(warnings, 'HEADER_UNAVAILABLE')
  if (count === undefined) {
    addWarning(warnings, 'EVENT_COUNT_UNAVAILABLE')
    return emptyProjection(header, undefined, false, warnings, input.activeNodeSeqs)
  }
  if (count > MAX_CONTEXT_EVENTS) {
    addWarning(warnings, 'EVENT_LIMIT_EXCEEDED')
    return emptyProjection(header, count, true, warnings, input.activeNodeSeqs)
  }
  const events = Array.isArray(input.events) ? input.events : []
  if (events.length > MAX_CONTEXT_EVENTS) {
    addWarning(warnings, 'EVENT_LIMIT_EXCEEDED')
    return emptyProjection(header, count, true, warnings, input.activeNodeSeqs)
  }
  if (events.length !== count) addWarning(warnings, 'EVENT_COUNT_MISMATCH')

  const active = input.activeNodeSeqs === undefined
    ? undefined
    : unique(input.activeNodeSeqs.filter(seq => safeSeq(seq) !== undefined))
  if (active === undefined) addWarning(warnings, 'CURRENT_SURFACE_UNAVAILABLE')

  if (count === 0 || input.header === undefined) {
    return emptyProjection(header, count, false, warnings, input.activeNodeSeqs)
  }

  const observed = observe(events)
  warnings.push(...observed.warnings.filter(warning => !warnings.includes(warning)))

  let inherited: ContextInheritedView | undefined
  if (input.header.isSeeded) {
    const cut = safeSeq(input.inheritedEventCount)
    if (cut === undefined) addWarning(warnings, 'INHERITED_COUNT_UNAVAILABLE')
    else if (observed.lastInheritedMarker === undefined) addWarning(warnings, 'INHERITED_MARKER_UNAVAILABLE')
    else if (observed.lastInheritedMarker.seq !== cut) addWarning(warnings, 'INHERITED_CUT_MISMATCH')
    else {
      inherited = {
        ...(input.header.parentSession === undefined ? {} : { parentSession: String(input.header.parentSession) }),
        cut,
        markerSeq: observed.lastInheritedMarker.seq,
        verified: true,
      }
    }
  } else if (input.inheritedEventCount !== undefined && input.inheritedEventCount > 0) {
    addWarning(warnings, 'INHERITED_COUNT_UNAVAILABLE')
  }

  const segmentationAvailable = !input.header.isSeeded || inherited !== undefined
  const cut = inherited?.cut ?? 0
  const lastSeq = events.length - 1
  const direct = observed.directUserSeqs
    .filter(seq => seq >= cut && seq <= lastSeq)
    .sort((left, right) => left - right)
  const candidates: ContextCandidateView[] = []
  if (segmentationAvailable) {
    for (let index = 0; index < direct.length && candidates.length < MAX_CONTEXT_CANDIDATES; index += 1) {
      const startSeq = direct[index] as number
      const next = direct[index + 1]
      const endSeq = Math.min(next === undefined ? lastSeq : next - 1, lastSeq)
      if (endSeq < startSeq) continue
      candidates.push({
        ordinal: candidates.length + 1,
        startSeq,
        endSeq,
        userSeq: startSeq,
        boundary: 'user-declared',
        heuristic: true,
        eventCount: endSeq - startSeq + 1,
        counts: emptyCounts(),
        stepCount: 0,
        currentSurfaceNodes: 0,
        shadowedNodes: 0,
        prunedNodes: 0,
        compactionIds: [],
      })
    }
    if (direct.length > candidates.length) addWarning(warnings, 'CANDIDATE_LIMIT')
  }
  if (direct.length === 0 && segmentationAvailable) addWarning(warnings, 'NO_DIRECT_USER_BOUNDARY')

  const candidateBySeq = indexCandidates(candidates, lastSeq)
  const counts = candidates.map(() => emptyCounts())
  for (const value of events) {
    const event = raw(value)
    const index = candidateAt(candidateBySeq, event.seq, lastSeq)
    if (index < 0) continue
    const target = counts[index] as ContextEventCounts
    switch (event.type) {
      case 'user/message': target.user += 1; break
      case 'assistant/message': target.assistant += 1; break
      case 'tool/call': target.toolCall += 1; break
      case 'tool/result': target.toolResult += 1; break
      case 'turn/start': target.turn += 1; break
      case 'step/start': target.step += 1; break
      default: target.other += 1; break
    }
  }

  // Interval sweeps over seq-sorted spans replace per-candidate filtering of
  // every turn and step. Each span enters and leaves one active set at most once.
  attachTurnStats(candidates, observed.turns, lastSeq)
  attachStepCounts(candidates, observed.steps, lastSeq)

  // Attribute each shadowed/pruned node once. Candidate ranges are disjoint, so
  // one pass over every transaction's exact seq set replaces C×N nested scans.
  const shadowed = candidates.map(() => new Set<number>())
  const compactionIds = candidates.map(() => new Set<string>())
  for (const transaction of observed.compactions) {
    for (const seq of transaction.shadowedSeqs) {
      const index = candidateAt(candidateBySeq, seq, lastSeq)
      if (index < 0) continue
      const nodes = shadowed[index] as Set<number>
      const ids = compactionIds[index] as Set<string>
      nodes.add(seq)
      ids.add(transaction.id)
    }
  }
  const pruned = candidates.map(() => new Set<number>())
  for (const prune of observed.prunes) {
    for (const seq of prune.shadowedSeqs) {
      const index = candidateAt(candidateBySeq, seq, lastSeq)
      if (index >= 0) (pruned[index] as Set<number>).add(seq)
    }
  }

  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as ContextCandidateView
    const next: ContextCandidateView = {
      ...candidate,
      counts: counts[index] as ContextEventCounts,
      currentSurfaceNodes: active === undefined ? 0 : countInRange(active, candidate.startSeq, candidate.endSeq),
      shadowedNodes: (shadowed[index] as Set<number>).size,
      prunedNodes: (pruned[index] as Set<number>).size,
      compactionIds: [...(compactionIds[index] as Set<string>)],
    }
    candidates[index] = next
  }

  const compactions = observed.compactions.slice(0, MAX_CONTEXT_COMPACTIONS).map(transaction => ({
    id: transaction.id,
    ...(transaction.startSeq === undefined ? {} : { startSeq: transaction.startSeq }),
    ...(transaction.summarySeq === undefined ? {} : { summarySeq: transaction.summarySeq }),
    ...(transaction.endSeq === undefined ? {} : { endSeq: transaction.endSeq }),
    status: statusOf(transaction),
    turn: transaction.turn,
    ...(transaction.sourceCommandId === undefined ? {} : { sourceCommandId: transaction.sourceCommandId }),
    shadowedSeqs: [...transaction.shadowedSeqs],
    ...(transaction.shadowedTokenCount === undefined ? {} : { shadowedTokenCount: transaction.shadowedTokenCount }),
    ...(transaction.replacementSeq === undefined ? {} : { replacementSeq: transaction.replacementSeq }),
    ...(transaction.error === undefined ? {} : { error: transaction.error }),
  }))
  if (observed.compactions.length > MAX_CONTEXT_COMPACTIONS) addWarning(warnings, 'COMPACTION_LIMIT')
  for (const transaction of compactions) {
    if (transaction.status === 'failed') addWarning(warnings, 'COMPACTION_FAILED')
    if (transaction.status === 'incomplete') addWarning(warnings, 'COMPACTION_INCOMPLETE')
  }

  if (observed.prunes.length > MAX_CONTEXT_PRUNES) addWarning(warnings, 'PRUNE_LIMIT')
  const prunes = observed.prunes.slice(0, MAX_CONTEXT_PRUNES).map(prune => ({
    seq: prune.seq,
    shadowedSeqs: [...prune.shadowedSeqs],
    ...(prune.replacementSeq === undefined ? {} : { replacementSeq: prune.replacementSeq }),
  }))

  const openTurn = [...observed.openTurns.entries()].sort((left, right) => right[1] - left[1])[0]
  const interrupted: ContextInterruptedView | undefined = openTurn === undefined
    ? observed.lastInterruptedEnd === undefined
      ? undefined
      : { state: 'durable', seq: observed.lastInterruptedEnd.seq, ...(safeSeq(dataOf(observed.lastInterruptedEnd)?.['turn']) === undefined ? {} : { turn: safeSeq(dataOf(observed.lastInterruptedEnd)?.['turn']) }) }
    : { state: 'open-heuristic', turn: openTurn[0], seq: openTurn[1] }

  return {
    ...(header === undefined ? {} : { header }),
    eventCount: count,
    maxEvents: MAX_CONTEXT_EVENTS,
    limitExceeded: false,
    currentSurface: active === undefined ? 'unavailable' : 'available',
    currentSurfaceNodeCount: active?.length ?? 0,
    candidates,
    compactions,
    prunes,
    ...(inherited === undefined ? {} : { inherited }),
    ...(interrupted === undefined ? {} : { interrupted }),
    archive: 'UNAVAILABLE',
    deleted: 'NOT_REPRESENTED',
    warnings,
  }
}

/** Map every seq in the displayed candidate ranges to its candidate index. */
function indexCandidates(candidates: readonly ContextCandidateView[], lastSeq: number): Int32Array {
  const index = new Int32Array(lastSeq + 1)
  index.fill(-1)
  for (let candidate = 0; candidate < candidates.length; candidate += 1) {
    const range = candidates[candidate] as ContextCandidateView
    const from = Math.max(0, range.startSeq)
    const to = Math.min(lastSeq, range.endSeq)
    for (let seq = from; seq <= to; seq += 1) index[seq] = candidate
  }
  return index
}

/** Resolve one seq without trusting an out-of-range array lookup. */
function candidateAt(index: Int32Array, seq: number, lastSeq: number): number {
  if (!Number.isSafeInteger(seq) || seq < 0 || seq > lastSeq) return -1
  return index[seq] as number
}

/** Minimal binary heap; ties do not affect the active-set invariants. */
class BinaryHeap<T> {
  private readonly items: T[] = []
  private readonly compare: (left: T, right: T) => number

  constructor(compare: (left: T, right: T) => number) {
    this.compare = compare
  }

  get size(): number {
    return this.items.length
  }

  peek(): T | undefined {
    return this.items[0]
  }

  push(value: T): void {
    this.items.push(value)
    let child = this.items.length - 1
    while (child > 0) {
      const parent = (child - 1) >> 1
      if (this.compare(this.items[parent] as T, this.items[child] as T) <= 0) break
      const swap = this.items[parent] as T
      this.items[parent] = this.items[child] as T
      this.items[child] = swap
      child = parent
    }
  }

  pop(): T | undefined {
    const first = this.items[0]
    const last = this.items.pop()
    if (this.items.length === 0 || last === undefined) return first
    this.items[0] = last
    let parent = 0
    for (;;) {
      const left = parent * 2 + 1
      const right = left + 1
      let smallest = parent
      if (left < this.items.length && this.compare(this.items[left] as T, this.items[smallest] as T) < 0) smallest = left
      if (right < this.items.length && this.compare(this.items[right] as T, this.items[smallest] as T) < 0) smallest = right
      if (smallest === parent) break
      const swap = this.items[parent] as T
      this.items[parent] = this.items[smallest] as T
      this.items[smallest] = swap
      parent = smallest
    }
    return first
  }
}

/** Distinct active turn numbers with lazy min/max removal. */
class ActiveTurns {
  private readonly counts = new Map<number, number>()
  private readonly lows = new BinaryHeap<number>((left, right) => left - right)
  private readonly highs = new BinaryHeap<number>((left, right) => right - left)

  add(turn: number): void {
    this.counts.set(turn, (this.counts.get(turn) ?? 0) + 1)
    this.lows.push(turn)
    this.highs.push(turn)
  }

  remove(turn: number): void {
    const count = this.counts.get(turn)
    if (count === undefined) return
    if (count <= 1) this.counts.delete(turn)
    else this.counts.set(turn, count - 1)
  }

  get size(): number {
    return this.counts.size
  }

  min(): number | undefined {
    while (this.lows.size > 0 && !this.counts.has(this.lows.peek() as number)) this.lows.pop()
    return this.lows.peek()
  }

  max(): number | undefined {
    while (this.highs.size > 0 && !this.counts.has(this.highs.peek() as number)) this.highs.pop()
    return this.highs.peek()
  }
}

/** Sweep turn spans once and attach their overlapping turn-number range. */
function attachTurnStats(
  candidates: ContextCandidateView[],
  spans: readonly TurnSpan[],
  lastSeq: number,
): void {
  const ordered = [...spans].sort((left, right) => left.startSeq - right.startSeq)
  const ends = new BinaryHeap<{ readonly end: number; readonly turn: number }>((left, right) => left.end - right.end)
  const active = new ActiveTurns()
  let next = 0
  for (const candidate of candidates) {
    while (next < ordered.length && (ordered[next] as TurnSpan).startSeq <= candidate.endSeq) {
      const span = ordered[next] as TurnSpan
      ends.push({ end: span.endSeq ?? lastSeq, turn: span.turn })
      active.add(span.turn)
      next += 1
    }
    while (ends.size > 0 && (ends.peek() as { readonly end: number }).end < candidate.startSeq) {
      const expired = ends.pop() as { readonly end: number; readonly turn: number }
      active.remove(expired.turn)
    }
    const first = active.min()
    const last = active.max()
    if (first !== undefined) candidate.turnStart = first
    if (last !== undefined) candidate.turnEnd = last
  }
}

/** Sweep step spans once and attach the number of spans overlapping each range. */
function attachStepCounts(
  candidates: ContextCandidateView[],
  spans: readonly StepSpan[],
  lastSeq: number,
): void {
  const ordered = [...spans].sort((left, right) => left.startSeq - right.startSeq)
  const ends = new BinaryHeap<number>((left, right) => left - right)
  let next = 0
  let active = 0
  for (const candidate of candidates) {
    while (next < ordered.length && (ordered[next] as StepSpan).startSeq <= candidate.endSeq) {
      ends.push((ordered[next] as StepSpan).endSeq ?? lastSeq)
      active += 1
      next += 1
    }
    while (ends.size > 0 && (ends.peek() as number) < candidate.startSeq) {
      ends.pop()
      active -= 1
    }
    candidate.stepCount = active
  }
}

/** Count the sorted values inside an inclusive range. */
function countInRange(sorted: readonly number[], start: number, end: number): number {
  const lower = lowerBound(sorted, start)
  const upper = lowerBound(sorted, end + 1)
  return upper - lower
}

/** First index with value >= target. */
function lowerBound(sorted: readonly number[], target: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const middle = (low + high) >> 1
    if ((sorted[middle] as number) < target) low = middle + 1
    else high = middle
  }
  return low
}
