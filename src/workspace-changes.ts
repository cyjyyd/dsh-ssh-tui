/**
 * Per-turn workspace change cards, read from the Host's `workspaceChanges`
 * service (`@deepseek-ai/dsh-workspace-changes`, shipped with dsh 0.1.7).
 *
 * The service is not a dependency of this plugin: 0.1.5 has neither the
 * package nor the `workspace/changes` event, so everything here is reached by
 * feature detection and the local types below are copied from the service's
 * contract rather than imported. Importing the package would fail to compile
 * on the 0.1.5 tree, where the module does not exist.
 *
 * What the service serves lives only as long as the Session does, in this Host
 * process. After a restart a replayed event resolves to `undefined`, and the
 * upstream decision — which this module honours — is to show no card at all
 * rather than a card whose contents can no longer be opened.
 * @module dsh-ssh-tui/workspace-changes
 */

import { t } from './i18n/index.js'
import type { DiffDisplayLine } from './transcript-types.js'

/** One file changed during a turn. Mirrors the service's `WorkspaceChangedFile`. */
export interface ChangesFile {
  /** Path relative to the Session working directory, or absolute outside it. */
  path: string
  /** Sort key and label, always slash-separated. */
  display: string
  /** Lines added; zero when the file is binary or oversized. */
  added: number
  /** Lines deleted; zero when the file is binary or oversized. */
  deleted: number
  /** Git called it binary, or a captured side holds a NUL byte. */
  binary?: true
  /** A captured side exceeded the plugin's byte cap; listed without counts. */
  oversized?: true
}

/** Files changed during one top-level turn. Mirrors `WorkspaceChangesSummary`. */
export interface ChangesSummary {
  /** The turn this summary describes. */
  turn: number
  /** Working directory the `path` values are relative to. */
  cwd: string
  /** Changed files in `display` order, capped by the plugin's `maxFiles`. */
  files: ChangesFile[]
  /** Complete changed-file count, including files the cap omitted. */
  total: number
  /** Lines added over every changed file, including omitted ones. */
  added: number
  /** Lines deleted over every changed file, including omitted ones. */
  deleted: number
}

/** One unified-diff hunk; every line keeps its `+`, `-`, or space prefix. */
export interface ChangesHunk {
  /** First line in the turn-start content, 1-based. */
  oldStart: number
  /** Lines taken from the turn-start content. */
  oldLines: number
  /** First line in the turn-end content, 1-based. */
  newStart: number
  /** Lines taken from the turn-end content. */
  newLines: number
  /** Hunk body in order, each line prefixed with `+`, `-`, or a space. */
  lines: string[]
}

/**
 * One listed file's comparison, computed when asked for. Mirrors
 * `WorkspaceFileDiff`: a line diff, or a file that has no lines to show.
 */
export type ChangesFileDiff =
  | {
      kind: 'text'
      path: string
      display: string
      before: boolean
      after: boolean
      hunks: ChangesHunk[]
      /** The comparison timed out and every line is shown as replaced. */
      coarse: boolean
    }
  | { kind: 'binary'; path: string; display: string }
  | { kind: 'oversized'; path: string; display: string }

/**
 * The Host service, as far as this plugin reads it. `seq` is the
 * `workspace/changes` event's own sequence number, not the turn number.
 */
export interface WorkspaceChangesSource {
  summary(sessionId: string, seq: number): ChangesSummary | undefined
  diff(sessionId: string, seq: number, index: number, signal: AbortSignal): Promise<ChangesFileDiff | undefined>
}

/**
 * The `workspaceChanges` service, when this Host actually has one.
 *
 * Both methods have to be functions: a present-but-incomplete object (a stub,
 * a future shape) must read as "not available" so the event is ignored instead
 * of throwing when the card is built.
 * @param ctx - the Host context.
 * @returns the service, or undefined on a Host that never registered one.
 */
export function workspaceChangesOf(
  ctx: { get?(name: string): unknown },
): WorkspaceChangesSource | undefined {
  const get = ctx.get
  if (typeof get !== 'function') return undefined
  const service: unknown = get.call(ctx, 'workspaceChanges')
  if (typeof service !== 'object' || service === null) return undefined
  const candidate = service as Partial<WorkspaceChangesSource>
  if (typeof candidate.summary !== 'function' || typeof candidate.diff !== 'function') return undefined
  return service as WorkspaceChangesSource
}

/** Whether a summary is worth a card. A turn that changed nothing is not. */
export function changesSummaryVisible(summary: ChangesSummary): boolean {
  return summary.total > 0 && summary.files.length > 0
}

/** Collapsed-card header: `本轮改动 · 3 个文件  +42 -7`. */
export function changesHeader(summary: ChangesSummary): string {
  return t('changes.header', {
    count: summary.total,
    added: summary.added,
    deleted: summary.deleted,
  })
}

/**
 * One expanded-card file line.
 *
 * Binary and oversized files carry no counts upstream, so naming the file and
 * then printing `+0 -0` would report a change that was not measured. They get
 * a label instead.
 * @param file - one entry of the summary.
 * @returns the line, without the card's indent.
 */
export function changesFileLine(file: ChangesFile): string {
  const label = file.display === '' ? file.path : file.display
  if (file.binary === true) return `${label}  ${t('changes.binary')}`
  if (file.oversized === true) return `${label}  ${t('changes.oversized')}`
  return `${label}  +${file.added} -${file.deleted}`
}

/**
 * Files the cap left out, when there are any.
 * @param summary - the turn's summary.
 * @returns the trailing line, or undefined when every file is listed.
 */
export function changesRemainderLine(summary: ChangesSummary): string | undefined {
  const omitted = summary.total - summary.files.length
  if (omitted <= 0) return undefined
  return t('changes.more', { count: omitted })
}

/** `@@ -12,3 +12,4 @@`, the range a hunk covers on each side. */
function hunkRange(start: number, lines: number): string {
  return lines === 1 ? String(start) : `${start},${lines}`
}

/**
 * Render one file's comparison as overlay lines.
 *
 * The service already compared the two sides, so this only maps what it
 * returned: recomputing the diff would be slower and could disagree with the
 * counts the card already showed. A `+` line is an addition, a `-` line a
 * removal, and a space-prefixed line is the unchanged context. Anything else
 * (a hunk line the service did not prefix) is shown as context too — dropping
 * it would hide part of the file.
 * @param diff - the comparison `workspaceChanges.diff` returned.
 * @returns the lines, or an empty list when there is nothing to show.
 */
export function renderChangesDiff(diff: ChangesFileDiff | undefined): DiffDisplayLine[] {
  if (diff === undefined) return []
  if (diff.kind === 'binary') return [{ kind: 'tool-result', text: t('changes.binaryFile') }]
  if (diff.kind === 'oversized') return [{ kind: 'tool-result', text: t('changes.oversizedFile') }]
  const lines: DiffDisplayLine[] = []
  if (diff.coarse) lines.push({ kind: 'tool-result', text: t('changes.coarse') })
  for (const hunk of diff.hunks) {
    lines.push({
      kind: 'diff-path',
      text: `@@ -${hunkRange(hunk.oldStart, hunk.oldLines)} +${hunkRange(hunk.newStart, hunk.newLines)} @@`,
    })
    for (const raw of hunk.lines) {
      const prefix = raw.charAt(0)
      lines.push({
        kind: prefix === '+' ? 'diff-add' : prefix === '-' ? 'diff-del' : 'tool-result',
        text: raw,
      })
    }
  }
  return lines
}
