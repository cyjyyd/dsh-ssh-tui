/**
 * CONTEXT.C1 — sanitized bilingual formatting for the read-only /context view.
 *
 * The formatter only receives the pure projection and a translator. It never
 * reads a Session, persistence, a path, event text, tool arguments, or a
 * credential. It turns evidence into display rows and previews; the TUI owns
 * Screen state, selection, copy, and line-mode emission.
 *
 * @module context-format
 */

import type { DiffDisplayLine } from './transcript-types.js'
import type {
  ContextCandidateView,
  ContextCompactionView,
  ContextInheritedView,
  ContextInterruptedView,
  ContextProjection,
  ContextPruneView,
  ContextWarning,
} from './context-projection.js'

/** Translator shape shared with the existing i18n catalog. */
export type ContextTranslator = (key: string, vars?: Record<string, string | number>) => string

/** One selectable row in the list. Ordinals and ranges are display-only. */
export interface ContextListRow {
  kind: 'candidate' | 'compaction' | 'prune' | 'inherited' | 'interrupted'
  key: string
  /** The first list-line index owned by this row, for keeping selection visible. */
  line: number
  preview: ContextPreview
}

/** A rendered list plus the selectable rows it contains. */
export interface ContextListModel {
  lines: readonly DiffDisplayLine[]
  copyText: string
  items: readonly ContextListRow[]
}

/** A rendered detail mode; it lives inside the same Report Screen. */
export interface ContextPreview {
  lines: readonly DiffDisplayLine[]
  copyText: string
}

function line(text: string): DiffDisplayLine {
  return { kind: 'system', text }
}

function rendered(lines: readonly string[]): ContextPreview {
  return {
    lines: lines.map(line),
    copyText: lines.join('\n'),
  }
}

function warningText(warning: ContextWarning, t: ContextTranslator): string {
  return t(`context.warning.${warning}`)
}

function compactStatus(status: ContextCompactionView['status'], t: ContextTranslator): string {
  return t(`context.status.${status}`)
}

function candidateTitle(candidate: ContextCandidateView, projection: ContextProjection, t: ContextTranslator): string {
  if (projection.currentSurface === 'unavailable') return t('context.surfaceUnavailable')
  return candidate.currentSurfaceNodes > 0
    ? t('context.inCurrentSurface', { count: candidate.currentSurfaceNodes })
    : t('context.notInCurrentSurface')
}

function candidateRange(candidate: ContextCandidateView, t: ContextTranslator): string {
  const turns = candidate.turnStart === undefined
    ? t('context.turnUnavailable')
    : t('context.turnRange', { start: candidate.turnStart, end: candidate.turnEnd ?? candidate.turnStart })
  return t('context.range', {
    turns,
    start: candidate.startSeq,
    end: candidate.endSeq,
  })
}

function candidatePreview(candidate: ContextCandidateView, projection: ContextProjection, t: ContextTranslator): ContextPreview {
  const rows = [
    t('context.preview.title'),
    t('context.preview.candidate', { ordinal: candidate.ordinal }),
    t('context.preview.seq', { start: candidate.startSeq, end: candidate.endSeq }),
    t('context.preview.events', { count: candidate.eventCount }),
    t('context.preview.types', {
      user: candidate.counts.user,
      assistant: candidate.counts.assistant,
      toolCall: candidate.counts.toolCall,
      toolResult: candidate.counts.toolResult,
    }),
    t('context.preview.turns', {
      turns: candidate.turnStart === undefined ? 0 : (candidate.turnEnd ?? candidate.turnStart) - candidate.turnStart + 1,
      steps: candidate.stepCount,
    }),
    projection.currentSurface === 'unavailable'
      ? t('context.surfaceUnavailable')
      : t('context.preview.surface', { count: candidate.currentSurfaceNodes }),
    t('context.preview.shadowed', { count: candidate.shadowedNodes }),
    t('context.preview.pruned', { count: candidate.prunedNodes }),
    t('context.preview.evidence'),
    t('context.preview.hidden'),
  ]
  return rendered(rows)
}

function compactionPreview(compaction: ContextCompactionView, t: ContextTranslator): ContextPreview {
  const seqs = compaction.shadowedSeqs.length === 0 ? t('context.none') : compaction.shadowedSeqs.join(', ')
  const rows = [
    t('context.preview.title'),
    t('context.preview.compaction', { id: compaction.id }),
    t('context.preview.compactionStatus', { status: compactStatus(compaction.status, t) }),
    t('context.preview.start', { seq: compaction.startSeq }),
    ...(compaction.summarySeq === undefined ? [] : [t('context.preview.summary', { seq: compaction.summarySeq })]),
    ...(compaction.replacementSeq === undefined ? [] : [t('context.preview.replacement', { seq: compaction.replacementSeq })]),
    ...(compaction.endSeq === undefined ? [] : [t('context.preview.end', { seq: compaction.endSeq })]),
    t('context.preview.shadowedSeqs', { seqs }),
    ...(compaction.shadowedTokenCount === undefined ? [] : [t('context.preview.shadowedTokens', { count: compaction.shadowedTokenCount })]),
    t('context.preview.evidence'),
    t('context.preview.hidden'),
  ]
  return rendered(rows)
}

function prunePreview(prune: ContextPruneView, t: ContextTranslator): ContextPreview {
  return rendered([
    t('context.preview.title'),
    t('context.preview.prune', { seq: prune.seq }),
    t('context.preview.shadowedSeqs', {
      seqs: prune.shadowedSeqs.length === 0 ? t('context.none') : prune.shadowedSeqs.join(', '),
    }),
    ...(prune.replacementSeq === undefined ? [] : [t('context.preview.replacement', { seq: prune.replacementSeq })]),
    t('context.preview.evidence'),
    t('context.preview.hidden'),
  ])
}

function inheritedPreview(inherited: ContextInheritedView, t: ContextTranslator): ContextPreview {
  return rendered([
    t('context.preview.title'),
    t('context.inheritedTitle'),
    t('context.inheritedLine', {
      parent: inherited.parentSession ?? t('context.none'),
      cut: inherited.cut,
      marker: inherited.markerSeq,
    }),
    t('context.preview.evidence'),
    t('context.preview.hidden'),
  ])
}

function interruptedPreview(interrupted: ContextInterruptedView, t: ContextTranslator): ContextPreview {
  return rendered([
    t('context.preview.title'),
    t('context.interruptedTitle'),
    interrupted.state === 'durable'
      ? t('context.interruptedDurable', { seq: interrupted.seq ?? '?' })
      : t('context.interruptedOpen', { turn: interrupted.turn ?? '?' }),
    t('context.preview.evidence'),
    t('context.preview.hidden'),
  ])
}

function listView(projection: ContextProjection, t: ContextTranslator, selected: number): ContextListModel {
  const lines: string[] = []
  const items: ContextListRow[] = []
  const push = (text: string): void => { lines.push(text) }
  push(t('context.readOnly'))
  if (projection.header === undefined) {
    push(t('context.headerUnavailable'))
  } else {
    const header = projection.header
    push(t('context.sessionLine', {
      id: header.id,
      parent: header.parentSession ?? t('context.none'),
      seeded: header.isSeeded ? t('context.yes') : t('context.no'),
      depth: header.delegationDepth ?? 0,
    }))
    push(t('context.eventCount', { count: projection.eventCount ?? '?' }))
  }
  if (projection.currentSurface === 'available') {
    push(t('context.currentSurfaceCount', { count: projection.currentSurfaceNodeCount }))
  } else {
    push(t('context.surfaceUnavailable'))
  }
  push(t('context.modelWindowUnavailable'))
  push(t('context.legend'))

  if (projection.limitExceeded) {
    push(t('context.limitExceeded', { count: projection.eventCount ?? '?', max: projection.maxEvents }))
  } else if (projection.eventCount === undefined) {
    push(t('context.eventCountUnavailable'))
  } else if (projection.eventCount === 0) {
    push(t('context.empty'))
  }

  for (const candidate of projection.candidates) {
    const preview = candidatePreview(candidate, projection, t)
    const title = candidateTitle(candidate, projection, t)
    const lineIndex = lines.length
    const marker = items.length === selected ? '> ' : '  '
    push(`${marker}${title}  ${t('context.candidate', { ordinal: candidate.ordinal })}`)
    push(`  ${candidateRange(candidate, t)}`)
    push(`  ${t('context.grouping')}`)
    if (candidate.shadowedNodes > 0) push(`  ${t('context.shadowedNodes', { count: candidate.shadowedNodes })}`)
    if (candidate.prunedNodes > 0) push(`  ${t('context.prunedNodes', { count: candidate.prunedNodes })}`)
    items.push({ kind: 'candidate', key: `candidate-${candidate.ordinal}`, line: lineIndex, preview })
  }
  for (const compaction of projection.compactions) {
    const preview = compactionPreview(compaction, t)
    const lineIndex = lines.length
    const marker = items.length === selected ? '> ' : '  '
    push(`${marker}${t('context.compressed')}  ${t('context.compaction', { id: compaction.id })}`)
    push(`  ${t('context.source')}: DURABLE_EVENT`)
    push(`  ${t('context.statusLine', { status: compactStatus(compaction.status, t) })}`)
    push(`  ${t('context.shadowedNodes', { count: compaction.shadowedSeqs.length })}`)
    if (compaction.replacementSeq !== undefined) push(`  ${t('context.replacementSeq', { seq: compaction.replacementSeq })}`)
    items.push({ kind: 'compaction', key: `compaction-${compaction.id}`, line: lineIndex, preview })
  }
  for (const prune of projection.prunes) {
    const preview = prunePreview(prune, t)
    const lineIndex = lines.length
    const marker = items.length === selected ? '> ' : '  '
    push(`${marker}${t('context.pruned')}  ${t('context.prune')}`)
    push(`  ${t('context.source')}: DURABLE_EVENT`)
    push(`  ${t('context.shadowedNodes', { count: prune.shadowedSeqs.length })}`)
    items.push({ kind: 'prune', key: `prune-${prune.seq}`, line: lineIndex, preview })
  }
  if (projection.inherited !== undefined) {
    const preview = inheritedPreview(projection.inherited, t)
    const lineIndex = lines.length
    const marker = items.length === selected ? '> ' : '  '
    push(`${marker}${t('context.inheritedTitle')}`)
    push(`  ${t('context.inheritedLine', {
      parent: projection.inherited.parentSession ?? t('context.none'),
      cut: projection.inherited.cut,
      marker: projection.inherited.markerSeq,
    })}`)
    items.push({ kind: 'inherited', key: 'inherited', line: lineIndex, preview })
  } else if (projection.header?.isSeeded === true) {
    push(`${t('context.unavailable')}  ${t('context.inheritedTitle')}`)
  }
  if (projection.interrupted !== undefined) {
    const preview = interruptedPreview(projection.interrupted, t)
    const lineIndex = lines.length
    const marker = items.length === selected ? '> ' : '  '
    push(`${marker}${t('context.interruptedTitle')}`)
    push(`  ${projection.interrupted.state === 'durable'
      ? t('context.interruptedDurable', { seq: projection.interrupted.seq ?? '?' })
      : t('context.interruptedOpen', { turn: projection.interrupted.turn ?? '?' })}`)
    items.push({ kind: 'interrupted', key: 'interrupted', line: lineIndex, preview })
  }
  if (projection.candidates.length === 0 && projection.limitExceeded === false
    && projection.eventCount !== undefined && projection.eventCount > 0) {
    push(t('context.noCandidates'))
  }
  push(`${t('context.archiveTitle')}`)
  push(`  ${t('context.archiveUnavailable')}`)
  push(`${t('context.deletedTitle')}`)
  push(`  ${t('context.deletedNotRepresented')}`)
  for (const warning of projection.warnings) {
    if (warning === 'EVENT_LIMIT_EXCEEDED' || warning === 'EVENT_COUNT_UNAVAILABLE') continue
    push(`${t('context.warningPrefix')} ${warningText(warning, t)}`)
  }
  return {
    lines: lines.map(line),
    copyText: lines.join('\n'),
    items,
  }
}

/** Format the list for one selected row index; selection is display-only. */
export function formatContextList(projection: ContextProjection, t: ContextTranslator, selected = 0): ContextListModel {
  const model = listView(projection, t, selected)
  return model
}

/** Return a selectable row's already-built preview. */
export function formatContextPreview(row: ContextListRow, _t: ContextTranslator): ContextPreview {
  return row.preview
}
