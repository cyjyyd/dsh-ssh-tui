/**
 * Tool-card presentation: headers, diffs, compact bursts, JSON bodies.
 */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { t } from './i18n/index.js'
import { wrap, type TextSegment, truncate, sliceCodePoints } from './term-text.js'
import { firstString, parseJsonArgs, scalarText } from './json-args.js'
import {
  parsePlanTodos,
  planTitleFromMarkdown,
  todoProgressLabel,
  todoSummary,
  askSummary,
  TODO_STATUS_MARK,
  todoItemKind,
  planMarkdownFromArgs,
} from './plan.js'
import type { DisplayKind, Row, ToolDiffHunk } from './transcript-types.js'

export const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh'])
export const DIFF_TOOL_NAMES = new Set(['edit', 'write', 'str_replace_editor'])

/** Format a model list compactly: show the first few entries and an ellipsis. */
export function formatModelList(models: readonly string[], max = 5): string {
  const shown = models.slice(0, max)
  const text = shown.join(', ')
  return models.length > max ? t('models.ellipsis', { text, count: models.length }) : text
}

/** Prefer the fields a human scans for; fall back to the first scalar pairs. */
export function friendlyArgsSummary(name: string, args: string): string {
  const parsed = parseJsonArgs(args)
  if (parsed === null) return sliceCodePoints(args, 120)
  const preferred = [
    'path', 'file_path', 'file', 'query', 'pattern', 'url', 'command',
    'name', 'skill', 'description', 'content', 'file_text', 'old_string', 'new_string',
    'old_str', 'new_str', 'insert_line', 'line', 'offset', 'limit',
  ]
  const parts: string[] = []
  for (const key of preferred) {
    const value = parsed[key]
    if (value === undefined || value === null || typeof value === 'object') continue
    parts.push(`${key}: ${String(value)}`)
    if (parts.length >= 3) break
  }
  if (parts.length === 0) {
    for (const [key, value] of Object.entries(parsed)) {
      const text = scalarText(value)
      if (text !== null) {
        parts.push(`${key}: ${text}`)
        if (parts.length >= 3) break
      }
    }
  }
  const summary = parts.join('  ')
  return summary === '' ? name : sliceCodePoints(summary, 160)
}
export function countDiffLines(hunks: readonly ToolDiffHunk[] | undefined): number {
  if (hunks === undefined || hunks.length === 0) return 0
  let total = 0
  for (const hunk of hunks) {
    const added = hunk.newText === '' ? 0 : hunk.newText.split('\n').length
    if (hunk.oldText === null) {
      total += added
      continue
    }
    const removed = hunk.oldText === '' ? 0 : hunk.oldText.split('\n').length
    total += added + removed
  }
  return total
}

/** Added / removed line counts for a diff (`oldText: null` means a new file). */
export function countDiffAddDel(hunks: readonly ToolDiffHunk[] | undefined): { add: number; del: number } {
  const stat = { add: 0, del: 0 }
  if (hunks === undefined) return stat
  for (const hunk of hunks) {
    stat.add += hunk.newText === '' ? 0 : hunk.newText.split('\n').length
    if (hunk.oldText !== null) {
      stat.del += hunk.oldText === '' ? 0 : hunk.oldText.split('\n').length
    }
  }
  return stat
}

/**
 * Git diffstat token, deletions first like `-13 +24`. Zero parts drop out
 * (a new file shows only `+24`); empty when the diff has no counted lines.
 */
export function diffStatToken(add: number, del: number): string {
  const parts: string[] = []
  if (del > 0) parts.push(`-${del}`)
  if (add > 0) parts.push(`+${add}`)
  return parts.join(' ')
}

export const READ_TOOL_NAMES = new Set(['read'])
export const TOOL_FLIP_MS = 280

export function toolTargetPath(name: string, args: string, fallback = ''): string {
  const parsed = parseJsonArgs(args)
  if (READ_TOOL_NAMES.has(name)) {
    if (parsed === null) return fallback
    return firstString(parsed, ['path', 'file_path', 'url']) || fallback
  }
  if (DIFF_TOOL_NAMES.has(name)) {
    if (parsed === null) return fallback
    return firstString(parsed, ['file_path', 'path']) || fallback
  }
  return fallback
}

/** Path shown on a compact single-file edit summary. */
export function compactEditPath(item: {
  name: string
  args: string
  summary?: string
  diff?: readonly { path?: string }[]
}): string {
  const fromArgs = toolTargetPath(item.name, item.args)
  if (fromArgs !== '') return fromArgs
  const fromDiff = item.diff?.map(hunk => hunk.path ?? '').find(path => path !== '')
  if (fromDiff !== undefined && fromDiff !== '') return fromDiff
  const summary = item.summary?.trim() ?? ''
  return summary
}

export function sameToolPath(left: string, right: string): boolean {
  if (left === '' || right === '') return false
  const normalize = (value: string): string => value.replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalize(left) === normalize(right)
}

export function countOutputLines(text: string): number {
  if (text === '') return 0
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body === '' ? 0 : body.split('\n').length
}

export function mergeableToolKind(name: string): 'read' | 'edit' | undefined {
  if (READ_TOOL_NAMES.has(name)) return 'read'
  if (DIFF_TOOL_NAMES.has(name)) return 'edit'
  return undefined
}

/**
 * Consecutive same-path reads (or edits) collapse onto one card.
 * A → B → C → A becomes four cards; A ×5 stays one card with repeats=5.
 */
export function canMergeToolCall(
  previous: Extract<Row, { kind: 'tool' }> | undefined,
  next: { name: string; args: string },
): previous is Extract<Row, { kind: 'tool' }> {
  if (previous === undefined) return false
  const kind = mergeableToolKind(next.name)
  if (kind === undefined || mergeableToolKind(previous.name) !== kind) return false
  const previousPath = toolTargetPath(previous.name, previous.args, previous.summary)
  const nextPath = toolTargetPath(next.name, next.args, previousPath)
  return sameToolPath(previousPath, nextPath)
}

export function compactToolGroups(tools: readonly Extract<Row, { kind: 'tool' }>[]): {
  edits: Extract<Row, { kind: 'tool' }>[]
  calls: Extract<Row, { kind: 'tool' }>[]
  failedCalls: number
} {
  const edits: Extract<Row, { kind: 'tool' }>[] = []
  const calls: Extract<Row, { kind: 'tool' }>[] = []
  for (const tool of tools) {
    if (DIFF_TOOL_NAMES.has(tool.name) || (tool.diff !== undefined && tool.diff.length > 0)) edits.push(tool)
    else calls.push(tool)
  }
  return {
    edits,
    calls,
    failedCalls: calls.filter(tool => tool.status === 'error').length,
  }
}

/**
 * Split compact-view tools into the bursts that belong with each assistant
 * reply: tools after reply N sit with that reply, until the next reply.
 */
export function compactToolBursts(rows: readonly Row[]): Array<{
  after: Extract<Row, { kind: 'assistant' }> | undefined
  groups: ReturnType<typeof compactToolGroups>
}> {
  const bursts: Array<{
    after: Extract<Row, { kind: 'assistant' }> | undefined
    tools: Extract<Row, { kind: 'tool' }>[]
  }> = []
  let current: (typeof bursts)[number] = { after: undefined, tools: [] }
  bursts.push(current)
  for (const row of rows) {
    if (row.kind === 'assistant') {
      current = { after: row, tools: [] }
      bursts.push(current)
      continue
    }
    if (row.kind === 'tool') current.tools.push(row)
  }
  return bursts
    .map(burst => ({ after: burst.after, groups: compactToolGroups(burst.tools) }))
    .filter(burst => burst.groups.calls.length > 0 || burst.groups.edits.length > 0)
}
export const SUBAGENT_TOOL_NAMES = new Set(['subagent', 'subagent_fork', 'task'])

/**
 * Tool calls that already have a dedicated transcript card (goal/change,
 * plan dock, question dialog). Showing them again as raw `get_goal` cards
 * just duplicates chrome.
 */
export const HIDDEN_TOOL_NAMES = new Set(['get_goal'])

const TOOL_TITLE_KEYS = [
  'edit', 'write', 'str_replace_editor', 'fetch', 'list_files', 'list', 'ls',
  'find', 'search', 'delete', 'rm', 'rename', 'mv', 'mkdir', 'skills', 'skill',
  'create_goal', 'update_goal', 'complete_goal', 'clear_goal', 'pause_goal',
  'resume_goal', 'todo_write', 'todo', 'compact', 'glob', 'grep', 'read',
  'web_search', 'web_fetch',
] as const

export function toolTitle(name: string): string {
  if (name === '' || name.startsWith('call-')) return t('card.tool')
  return t(`toolTitle.${name}`, undefined, name === 'tool' ? t('card.tool') : name)
}
export function planReviewOf(question: AskUserQuestionItem): boolean {
  return question.intent?.kind === 'plan-review' && question.detail !== undefined && question.detail !== ''
}

/** Derive the intended file change from a mutation tool's arguments. */
export function diffHunksFromArgs(name: string, argsRaw: string): ToolDiffHunk[] | null {
  const args = parseJsonArgs(argsRaw)
  if (args === null) return null
  if (name === 'edit' || name === 'write') {
    const path = typeof args.file_path === 'string' ? args.file_path : ''
    if (path === '') return null
    if (name === 'edit') {
      return [{
        path,
        oldText: typeof args.old_string === 'string' ? args.old_string : null,
        newText: typeof args.new_string === 'string' ? args.new_string : '',
      }]
    }
    return [{
      path,
      oldText: null,
      newText: typeof args.content === 'string' ? args.content : '',
    }]
  }
  if (name === 'str_replace_editor') {
    const path = typeof args.path === 'string' ? args.path : ''
    const command = typeof args.command === 'string' ? args.command : ''
    if (path === '') return null
    if (command === 'create') {
      return [{ path, oldText: null, newText: typeof args.file_text === 'string' ? args.file_text : '' }]
    }
    if (command === 'str_replace') {
      return [{
        path,
        oldText: typeof args.old_str === 'string' ? args.old_str : null,
        newText: typeof args.new_str === 'string' ? args.new_str : '',
      }]
    }
  }
  return null
}

/** One-line friendly tool-call presentation (command / path / arg summary). */
export function presentToolCall(name: string, args: string): {
  title: string
  summary: string
  command?: string
  cwd?: string
  diff?: ToolDiffHunk[]
} {
  const parsed = parseJsonArgs(args)
  if (SHELL_TOOL_NAMES.has(name)) {
    const command = typeof parsed?.command === 'string' ? parsed.command : sliceCodePoints(args, 80)
    return {
      title: name,
      summary: `$ ${command}`,
      command,
      cwd: typeof parsed?.workdir === 'string' ? parsed.workdir : undefined,
    }
  }
  if (DIFF_TOOL_NAMES.has(name)) {
    const diff = diffHunksFromArgs(name, args)
    const path = diff?.[0]?.path
    return {
      title: toolTitle(name),
      summary: path ?? friendlyArgsSummary(name, args),
      ...diff === null || diff === undefined ? {} : { diff },
    }
  }
  if (SUBAGENT_TOOL_NAMES.has(name)) {
    const description = typeof parsed?.description === 'string' ? parsed.description.trim() : ''
    return {
      title: toolTitle(name === 'subagent_fork' ? 'subagent_fork' : 'subagent'),
      summary: description === '' ? friendlyArgsSummary(name, args) : description,
    }
  }
  if (name === 'todo_write' || name === 'todo') {
    return { title: toolTitle('todo_write'), summary: todoSummary(parsed) }
  }
  if (name === 'ask_user_question') {
    return { title: toolTitle('ask_user_question'), summary: askSummary(parsed) }
  }
  if (name === 'exit_plan_mode') {
    const plan = typeof parsed?.plan === 'string' ? parsed.plan : ''
    return { title: toolTitle('exit_plan_mode'), summary: planTitleFromMarkdown(plan) ?? t('plan.waitConfirm') }
  }
  if (name === 'update_goal' || name === 'create_goal') {
    const action = typeof parsed?.action === 'string' ? parsed.action.trim() : ''
    const objective = typeof parsed?.objective === 'string' ? parsed.objective.trim() : ''
    const titleKey = name === 'create_goal' || action === 'create' || action === 'set'
      ? 'create_goal'
      : action === 'pause' ? 'pause_goal'
        : action === 'resume' ? 'resume_goal'
          : action === 'clear' ? 'clear_goal'
            : action === 'complete' ? 'complete_goal'
              : 'update_goal'
    return { title: toolTitle(titleKey), summary: objective || action || friendlyArgsSummary(name, args) }
  }
  if (name === 'get_goal') {
    return { title: toolTitle('get_goal'), summary: friendlyArgsSummary(name, args) }
  }
  if (name === 'skill' || name === 'skills') {
    const skill = typeof parsed?.name === 'string' ? parsed.name.trim()
      : typeof parsed?.skill === 'string' ? parsed.skill.trim()
        : typeof parsed?.id === 'string' ? parsed.id.trim()
          : ''
    return { title: toolTitle('skill'), summary: skill || friendlyArgsSummary(name, args) }
  }
  if (name === 'read') {
    const path = typeof parsed?.path === 'string' ? parsed.path
      : typeof parsed?.file_path === 'string' ? parsed.file_path
        : typeof parsed?.url === 'string' ? parsed.url
          : ''
    return { title: toolTitle('read'), summary: path || friendlyArgsSummary(name, args) }
  }
  if (name === 'grep') {
    const pattern = typeof parsed?.pattern === 'string' ? parsed.pattern : ''
    const path = typeof parsed?.path === 'string' ? parsed.path : ''
    return { title: toolTitle('grep'), summary: [pattern, path].filter(Boolean).join('  ') || friendlyArgsSummary(name, args) }
  }
  if (name === 'glob') {
    const pattern = typeof parsed?.pattern === 'string' ? parsed.pattern
      : typeof parsed?.glob_pattern === 'string' ? parsed.glob_pattern
        : ''
    return { title: toolTitle('glob'), summary: pattern || friendlyArgsSummary(name, args) }
  }
  if (name === 'web_search') {
    const query = typeof parsed?.query === 'string' ? parsed.query : typeof parsed?.q === 'string' ? parsed.q : ''
    return { title: toolTitle('web_search'), summary: query || friendlyArgsSummary(name, args) }
  }
  if (name === 'web_fetch') {
    const url = typeof parsed?.url === 'string' ? parsed.url : ''
    return { title: toolTitle('web_fetch'), summary: url || friendlyArgsSummary(name, args) }
  }
  return { title: toolTitle(name), summary: friendlyArgsSummary(name, args) }
}

/** Validate a tool/result meta payload's structured diff, mirroring the web card. */
export function diffMetaDiffs(meta: unknown): ToolDiffHunk[] | null {
  if (typeof meta !== 'object' || meta === null) return null
  const diffs = (meta as { diffs?: unknown }).diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: ToolDiffHunk[] = []
  for (const hunk of diffs) {
    if (typeof hunk !== 'object' || hunk === null) return null
    const { path, oldText, newText } = hunk as Record<string, unknown>
    if (typeof path !== 'string' || typeof newText !== 'string') return null
    if (oldText !== null && typeof oldText !== 'string') return null
    out.push({ path, oldText: oldText as string | null, newText })
  }
  return out
}

/** Split one diff side into content lines (trailing newline is a terminator). */
export function diffContentLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n')
}

/** One rendered diff body line with its display role. */
export interface DiffDisplayLine {
  kind: DisplayKind
  text: string
}

/** Cap one flat diff/body row list to `maxLines` while preserving the final line. */
export function capDisplayLines(lines: readonly DiffDisplayLine[], maxLines: number): DiffDisplayLine[] {
  const budget = Math.max(1, Math.floor(maxLines))
  if (lines.length <= budget) return [...lines]
  const omitted = lines.length - budget + 1
  const marker: DiffDisplayLine = { kind: 'tool-result', text: `… ${omitted} more line(s) …` }
  if (budget === 1) return [marker]
  return [...lines.slice(0, budget - 2), marker, ...lines.slice(-1)]
}

/** Running / ok / error → ANSI color for the status dot and status word only. */
export function toolStateColor(status: 'running' | 'ok' | 'error' | undefined): '33' | '32' | '31' {
  if (status === 'ok') return '32'
  if (status === 'error') return '31'
  return '33'
}

export function toolStateLabel(status: 'running' | 'ok' | 'error' | undefined): string {
  if (status === 'ok') return 'ok'
  if (status === 'error') return 'error'
  return 'running…'
}

/** Header + SGR spans: default title, dim operand, colored ●. `[ok]` is omitted — the green dot is enough. */
export function buildToolHeader(input: {
  focused: boolean
  expanded: boolean
  title: string
  summary: string
  status?: 'running' | 'ok' | 'error'
  command?: string
  signal?: string
  exitCode?: number
  spinner?: string
  flipping?: boolean
  diffStat?: { add: number; del: number }
}): { plain: string; segments: TextSegment[] } {
  const running = input.status === undefined || input.status === 'running'
  const stateToken = input.status === 'ok' ? '' : `[${toolStateLabel(input.status)}]`
  const exit = !running && input.command !== undefined
    ? input.signal !== undefined
      ? t('tool.signal', { signal: input.signal })
      : (input.exitCode ?? 0) !== 0
        ? t('tool.exitCode', { code: input.exitCode ?? 0 })
        : ''
    : ''
  const spinner = input.spinner ?? ''
  const prefix = input.focused ? '▶ ' : '  '
  const flipping = input.flipping === true
  const marker = flipping ? '◇' : input.expanded ? '▾' : '▸'
  const lead = `${prefix}${marker} ● ${input.title}`
  const summaryText = input.summary === '' ? '' : `  ${input.summary}`
  const statToken = input.diffStat === undefined ? '' : diffStatToken(input.diffStat.add, input.diffStat.del)
  const statText = statToken === '' ? '' : `  ${statToken}`
  const stateGap = stateToken === '' ? '' : '  '
  const tail = `${stateGap}${stateToken}${exit}${spinner}`
  const plain = `${lead}${summaryText}${statText}${tail}`
  const stateCode = toolStateColor(input.status)
  const dotIndex = lead.indexOf('●')
  const stateIndex = stateToken === '' ? -1 : lead.length + summaryText.length + statText.length + stateGap.length
  const segments: TextSegment[] = []
  if (flipping) {
    const markerIndex = prefix.length
    segments.push({ start: markerIndex, end: markerIndex + marker.length, sgr: '36' })
  }
  if (dotIndex >= 0) segments.push({ start: dotIndex, end: dotIndex + '●'.length, sgr: stateCode })
  if (summaryText.length > 0) {
    segments.push({ start: lead.length, end: lead.length + summaryText.length, sgr: '90' })
  }
  if (statToken !== '') {
    // Git diffstat colors: deletions red, additions green. The token sits
    // two cells after the summary, deletions before the joining space.
    const statStart = lead.length + summaryText.length + 2
    const delEnd = statToken.indexOf(' +')
    if (statToken.startsWith('-')) {
      segments.push({
        start: statStart,
        end: statStart + (delEnd === -1 ? statToken.length : delEnd),
        sgr: '31',
      })
    }
    if (delEnd !== -1) {
      const addStart = statStart + delEnd + 1
      segments.push({ start: addStart, end: statStart + statToken.length, sgr: '32' })
    }
  }
  if (stateIndex >= 0) {
    segments.push({ start: stateIndex, end: stateIndex + stateToken.length + exit.length, sgr: stateCode })
  } else if (exit !== '') {
    const exitIndex = lead.length + summaryText.length + statText.length
    segments.push({ start: exitIndex, end: exitIndex + exit.length, sgr: stateCode })
  }
  if (spinner !== '') {
    const spinnerStart = (stateIndex >= 0 ? stateIndex + stateToken.length + exit.length : lead.length + summaryText.length + statText.length + exit.length)
    segments.push({
      start: spinnerStart,
      end: plain.length,
      sgr: '90',
    })
  }
  return { plain, segments: segments.filter(segment => segment.end > segment.start) }
}

/** How many terminal rows a tool body occupies after wrapping. */
export function wrappedToolBodyLineCount(
  lines: readonly { text: string }[],
  width: number,
): number {
  const inner = Math.max(1, width - 2)
  let count = 0
  for (const line of lines) {
    count += Math.max(1, wrap(line.text, inner).length)
  }
  return count
}

/**
 * True when the full tool body plus a one-line header fits in the workspace
 * (the rows between the title bar and the input chrome). Oversized bodies
 * open a dedicated inspect overlay instead of dumping into the transcript.
 */
export function toolBodyFitsWorkspace(bodyLines: number, workspaceRows: number): boolean {
  return bodyLines + 1 <= Math.max(1, workspaceRows)
}

/** Flatten hunks into git-style `-`/`+` lines plus the web-compatible footer. */
export function renderToolDiff(diffs: ToolDiffHunk[], maxLines: number): DiffDisplayLine[] {
  const rows: DiffDisplayLine[] = []
  const paths = new Set<string>()
  let added = 0
  let removed = 0
  let prevPath: string | undefined
  for (const hunk of diffs) {
    paths.add(hunk.path)
    rows.push(hunk.path === prevPath
      ? { kind: 'diff-path', text: '⋯' }
      : { kind: 'diff-path', text: hunk.path })
    prevPath = hunk.path
    if (hunk.oldText !== null) {
      for (const line of diffContentLines(hunk.oldText)) {
        rows.push({ kind: 'diff-del', text: `- ${line}` })
        removed += 1
      }
    }
    for (const line of diffContentLines(hunk.newText)) {
      rows.push({ kind: 'diff-add', text: `+ ${line}` })
      added += 1
    }
  }
  rows.push({
    kind: 'tool-result',
    text: `└ +${added} -${removed} · ${paths.size} file${paths.size === 1 ? '' : 's'}`,
  })
  return capDisplayLines(rows, maxLines)
}

/** Keys whose multiline strings render as indented content blocks. */
const LONG_TEXT_KEYS = new Set([
  'program', 'content', 'file_text', 'new_string', 'old_string',
  'plan', 'markdown', 'details', 'description', 'text',
])

const JSON_STRING_CAP = 400
const JSON_MAX_DEPTH = 16
const JSON_MAX_ENTRIES = 60

/** Convert any parsed JSON value into readable indented display lines. */
export function friendlyJsonLines(value: unknown, depth = 0): string[] {
  const pad = '  '.repeat(depth)
  if (value === null) return [`${pad}null`]
  if (typeof value === 'string') {
    const capped = value.length > JSON_STRING_CAP ? `${value.slice(0, JSON_STRING_CAP)}…` : value
    return [`${pad}${capped}`]
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return [`${pad}${String(value)}`]
  }
  if (depth >= JSON_MAX_DEPTH) {
    return [`${pad}…`]
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`]
    const shown = value.slice(0, JSON_MAX_ENTRIES)
    const lines: string[] = []
    for (const item of shown) {
      if (item !== null && typeof item === 'object') {
        lines.push(`${pad}-`)
        lines.push(...friendlyJsonLines(item, depth + 1))
      } else {
        lines.push(`${pad}- ${friendlyJsonLines(item, 0)[0] ?? ''}`)
      }
    }
    if (value.length > shown.length) lines.push(`${pad}… ${value.length - shown.length} more item(s)`)
    return lines
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return [`${pad}{}`]
    const shown = entries.slice(0, JSON_MAX_ENTRIES)
    const lines: string[] = []
    for (const [key, item] of shown) {
      if (typeof item === 'string' && item.includes('\n') && LONG_TEXT_KEYS.has(key)) {
        const contentLines = item.split('\n')
        lines.push(`${pad}${key}:`)
        for (const contentLine of contentLines.slice(0, 80)) {
          lines.push(`${pad}  │ ${contentLine}`)
        }
        if (contentLines.length > 80) {
          lines.push(`${pad}  … ${contentLines.length - 80} more line(s)`)
        }
      } else if (item !== null && typeof item === 'object') {
        lines.push(`${pad}${key}:`)
        lines.push(...friendlyJsonLines(item, depth + 1))
      } else {
        const scalar = friendlyJsonLines(item, 0)[0] ?? ''
        lines.push(`${pad}${key}: ${scalar}`)
      }
    }
    if (entries.length > shown.length) lines.push(`${pad}… ${entries.length - shown.length} more field(s)`)
    return lines
  }
  return [`${pad}${String(value)}`]
}

/** Minimal tool-row shape the expanded-body renderer reads. */
export interface ToolBodySource {
  name?: string
  diff?: ToolDiffHunk[]
  command?: string
  status?: 'running' | 'ok' | 'error'
  output: string
  args: string
}

/** Try to parse a result body as one JSON document, when it looks like one. */
export function parseJsonBody(text: string): unknown | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

/**
 * The expanded body of one tool card: diffs and shell output keep their
 * dedicated views; every other tool's JSON arguments and JSON result are
 * converted into readable indented content instead of raw JSON text.
 */
export function toolBodyLines(row: ToolBodySource, maxLines: number): DiffDisplayLine[] {
  const unlimited = !Number.isFinite(maxLines) || maxLines >= Number.MAX_SAFE_INTEGER
  if (row.diff !== undefined && row.diff.length > 0) {
    // File-edit diffs are never truncated in the card: omitting hunks would
    // hide the exact code change the model applied. `maxLines` only governs
    // shell and generic JSON output bodies (and the inspect overlay).
    return renderToolDiff(row.diff, unlimited ? Number.MAX_SAFE_INTEGER : maxLines)
  }
  if (row.command !== undefined) {
    const out: DiffDisplayLine[] = []
    if (row.output !== '') {
      const text = unlimited ? row.output : truncate(row.output, maxLines)
      for (const line of text.split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    } else if (row.status !== 'running' && row.status !== undefined) {
      out.push({ kind: 'tool-result', text: t('tool.noOutput') })
    }
    return out
  }

  const specialized = specializedToolBody(row, unlimited ? Number.MAX_SAFE_INTEGER : maxLines)
  if (specialized !== null) {
    return unlimited ? specialized : capDisplayLines(specialized, maxLines)
  }

  const out: DiffDisplayLine[] = []
  const args = parseJsonArgs(row.args)
  if (args !== null && Object.keys(args).length > 0) {
    out.push({ kind: 'diff-path', text: t('tool.args') })
    for (const line of friendlyJsonLines(args)) {
      out.push({ kind: 'tool-result', text: line })
    }
  }
  if (row.output !== '') {
    out.push({ kind: 'diff-path', text: t('tool.result') })
    const parsed = parseJsonBody(row.output)
    if (parsed !== null) {
      for (const line of friendlyJsonLines(parsed)) {
        out.push({ kind: 'tool-result', text: line })
      }
    } else {
      const text = unlimited ? row.output : truncate(row.output, maxLines)
      for (const line of text.split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    }
  }
  return unlimited ? out : capDisplayLines(out, maxLines)
}

export interface NamedToolBodySource extends ToolBodySource {
  name?: string
}

export function specializedToolBody(row: NamedToolBodySource, maxLines = Number.MAX_SAFE_INTEGER): DiffDisplayLine[] | null {
  const name = row.name ?? ''
  const args = parseJsonArgs(row.args)
  const unlimited = !Number.isFinite(maxLines) || maxLines >= Number.MAX_SAFE_INTEGER
  const take = (text: string, fallback: number): string =>
    unlimited ? text : truncate(text, Math.min(maxLines, fallback))
  if (name === 'todo_write' || name === 'todo') {
    const todos = parsePlanTodos(args ?? row.args)
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: todoProgressLabel(todos) || t('todo.list') }]
    if (todos.length === 0) {
      out.push({ kind: 'tool-result', text: t('todo.empty') })
    } else {
      for (const item of todos) {
        out.push({ kind: todoItemKind(item.status), text: `${TODO_STATUS_MARK[item.status]} ${item.content}` })
      }
    }
    return out
  }
  if (name === 'exit_plan_mode') {
    const markdown = planMarkdownFromArgs(args ?? row.args) ?? ''
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: planTitleFromMarkdown(markdown) ?? t('plan.reviewing') }]
    if (markdown === '') {
      out.push({ kind: 'tool-result', text: t('plan.emptyBody') })
    } else {
      for (const line of markdown.split('\n')) {
        out.push({ kind: 'assistant', text: line })
      }
    }
    return out
  }
  if (name === 'read' && args !== null) {
    const path = firstString(args, ['path', 'file_path', 'url'])
    const out: DiffDisplayLine[] = []
    if (path !== '') out.push({ kind: 'diff-path', text: path })
    const offset = typeof args.offset === 'number' ? args.offset : undefined
    const limit = typeof args.limit === 'number' ? args.limit : undefined
    if (offset !== undefined || limit !== undefined) {
      out.push({ kind: 'tool-result', text: `offset ${offset ?? 1}${limit === undefined ? '' : ` · limit ${limit}`}` })
    }
    if (row.output !== '') {
      for (const line of take(row.output, 40).split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    } else if (row.status === 'running') {
      out.push({ kind: 'tool-result', text: t('tool.reading') })
    }
    return out.length > 0 ? out : null
  }
  if ((name === 'grep' || name === 'glob') && args !== null) {
    const pattern = firstString(args, ['pattern', 'glob_pattern', 'query'])
    const path = firstString(args, ['path', 'glob'])
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: [pattern, path].filter(Boolean).join('  ') || name }]
    if (row.output !== '') {
      for (const line of take(row.output, 30).split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    }
    return out
  }
  if ((name === 'web_search' || name === 'web_fetch') && args !== null) {
    const query = firstString(args, ['query', 'q', 'url'])
    const out: DiffDisplayLine[] = [{ kind: 'diff-path', text: query || name }]
    if (row.output !== '') {
      for (const line of take(row.output, 24).split('\n')) {
        out.push({ kind: 'assistant', text: line })
      }
    }
    return out
  }
  if (name === 'update_goal' || name === 'create_goal' || name === 'get_goal') {
    const objective = args === null ? '' : firstString(args, ['objective', 'goal'])
    const action = args === null ? '' : firstString(args, ['action'])
    const out: DiffDisplayLine[] = []
    if (action !== '') out.push({ kind: 'diff-path', text: action })
    if (objective !== '') out.push({ kind: 'assistant', text: objective })
    if (row.output !== '') {
      for (const line of take(row.output, 12).split('\n')) {
        out.push({ kind: 'tool-result', text: line })
      }
    }
    return out.length > 0 ? out : null
  }
  return null
}

/** Recover the shell tools' exit marker, mirroring @deepseek-ai/dsh-shell/render. */
export function parseExitStatus(text: string): {
  body: string
  exitCode?: number
  signal?: string
} {
  const signal = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(text)
  if (signal?.[1] !== undefined) {
    return { body: text.slice(0, signal.index), signal: signal[1] }
  }
  const exit = /\n\[exit code: (\d+)\]$/.exec(text)
  if (exit?.[1] !== undefined) {
    return { body: text.slice(0, exit.index), exitCode: Number(exit[1]) }
  }
  return { body: text, exitCode: 0 }
}
