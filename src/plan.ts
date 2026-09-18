/**
 * Plan dock, todo lists, /find, prompt-injection cards, and compact errors.
 */

import { t } from './i18n/index.js'
import { CONTEXT_RING_EMPTY, CONTEXT_RING_FULL, CONTEXT_RING_SEGMENTS, formatTokens, providerShortCode } from './footer.js'
import { parseJsonArgs } from './json-args.js'
import { subagentCourtesyName } from './job-label.js'
import { subagentIdentitySgr } from './subagent-model.js'
import { sliceCodePoints, type TextSegment } from './term-text.js'
import type { DiffDisplayLine, DisplayKind, PlanTodoItem, Row, SubagentLogEntry } from './transcript-types.js'

export const MAX_SUBAGENT_LOGS = 80

export const TODO_STATUS_MARK: Record<PlanTodoItem['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  failed: '✖',
  skipped: '⊘',
}

/** The status a model names, mapped onto the five we render. */
function normalizeTodoStatus(value: unknown): PlanTodoItem['status'] {
  const text = typeof value === 'string' ? value.trim().toLowerCase().replaceAll('-', '_') : ''
  if (text === 'in_progress' || text === 'active' || text === 'doing') return 'in_progress'
  if (text === 'completed' || text === 'complete' || text === 'done') return 'completed'
  if (text === 'failed' || text === 'fail' || text === 'error' || text === 'blocked') return 'failed'
  if (text === 'skipped' || text === 'skip' || text === 'cancelled' || text === 'canceled' || text === 'deferred') return 'skipped'
  return 'pending'
}

/** True while a plan still belongs in the dock (latest incomplete work). */
export function planIsLive(plan: {
  active: boolean
  pending: boolean
  todos: readonly PlanTodoItem[]
  planMarkdown?: string
  archived?: boolean
}): boolean {
  if (plan.archived === true) return false
  if (plan.active || plan.pending) return true
  if (plan.todos.some(item => item.status !== 'completed')) return true
  return false
}

/** Open todos left behind when a turn ends without a completing todo_write. */
export function planTurnLeftOpen(plan: {
  todos: readonly PlanTodoItem[]
}): boolean {
  return plan.todos.some(item => item.status !== 'completed')
}

/** Mark leftover in-progress/pending todos as display-stale after turn/end. */
export function applyTurnEndToPlan<T extends {
  todos: PlanTodoItem[]
  turnLeftOpen?: boolean
}>(plan: T): T {
  if (!planTurnLeftOpen(plan)) {
    plan.turnLeftOpen = false
    return plan
  }
  plan.turnLeftOpen = true
  return plan
}

/** Follow-up that asks the model to close leftover todos. One per open list. */
export function planCloseNudgeText(plan: {
  todos: readonly PlanTodoItem[]
}): string {
  const leftover = plan.todos.filter(item => item.status !== 'completed')
  const lines = leftover.map(item => `- [${item.status}] ${item.content}`)
  return [t('plan.nudge'), ...lines].join('\n')
}

export type CardCategory = 'thinking' | 'plan' | 'subagent' | 'reply' | 'tool' | 'question' | 'goal' | 'prompt'

/** Category for jump / search. Assistant replies are not collapsible cards. */
export function cardCategoryOf(row: { kind: string }): CardCategory | undefined {
  if (row.kind === 'reasoning' || row.kind === 'streaming-reasoning') return 'thinking'
  if (row.kind === 'plan') return 'plan'
  if (row.kind === 'subagent') return 'subagent'
  if (row.kind === 'assistant') return 'reply'
  if (row.kind === 'tool') return 'tool'
  if (row.kind === 'question') return 'question'
  if (row.kind === 'goal') return 'goal'
  if (row.kind === 'prompt') return 'prompt'
  if (row.kind === 'compaction') return 'tool'
  return undefined
}

export function cardCategoryLabel(category: CardCategory): string {
  return t(`card.${category}`)
}

const SEARCHABLE_CATEGORIES: readonly CardCategory[] = ['thinking', 'plan', 'subagent', 'reply']

export function parseCardCategoryToken(token: string): CardCategory | undefined {
  const id = token.trim().toLowerCase()
  if (id === 'thinking' || id === 'think' || id === '推理' || id === '思考') return 'thinking'
  if (id === 'plan' || id === '计划') return 'plan'
  if (id === 'subagent' || id === 'sub' || id === '子代理') return 'subagent'
  if (id === 'reply' || id === 'assistant' || id === '回复') return 'reply'
  if (id === 'tool' || id === '工具') return 'tool'
  if (id === 'question' || id === '提问') return 'question'
  if (id === 'goal' || id === '目标') return 'goal'
  if (id === 'prompt' || id === '提示词' || id === '注入') return 'prompt'
  return undefined
}

/** Split `/find thinking padAnsi` into an optional category and a query. */
export function parseFindQuery(raw: string): { category?: CardCategory; query: string } {
  const text = raw.trim()
  if (text === '') return { query: '' }
  const match = /^(\S+)(?:\s+(.*))?$/u.exec(text)
  if (match === null) return { query: text }
  const category = parseCardCategoryToken(match[1] ?? '')
  if (category === undefined) return { query: text }
  return { category, query: (match[2] ?? '').trim() }
}

function rowSearchHaystack(row: Row): string {
  switch (row.kind) {
    case 'reasoning':
    case 'assistant':
    case 'user':
    case 'system':
    case 'error':
    case 'brand':
      return row.text
    case 'tool':
      return `${row.title} ${row.summary} ${row.output} ${row.args}`
    case 'subagent':
      return `${row.label} ${row.lastActivity} ${row.logs.map(entry => entry.text).join('\n')}`
    case 'plan':
      return `${row.planMarkdown ?? ''} ${row.todos.map(item => item.content).join('\n')}`
    case 'question':
      return `${row.title} ${row.summary} ${row.detail ?? ''} ${row.header ?? ''}`
    case 'goal':
      return `${row.objective} ${row.blockedReason ?? ''}`
    case 'compaction':
      return `${row.summary ?? ''} ${row.error ?? ''}`
    case 'prompt':
      return `${row.sources.join(' ')} ${row.text}`
    default:
      return ''
  }
}

const PROMPT_SOURCE_PATTERNS: readonly { id: string; pattern: RegExp }[] = [
  { id: 'AGENTS.MD', pattern: /\bAGENTS\.md\b/iu },
  { id: 'CLAUDE.MD', pattern: /\bCLAUDE\.md\b/iu },
  { id: 'GEMINI.MD', pattern: /\bGEMINI\.md\b/iu },
  { id: 'CURSOR.MD', pattern: /\b(?:\.?cursor(?:\/rules)?|CURSOR\.md)\b/iu },
  { id: 'COPILOT.MD', pattern: /\b(?:COPILOT\.md|\.github\/copilot-instructions)\b/iu },
  { id: 'WINDSURF.MD', pattern: /\bWINDSURF\.md\b/iu },
]

const SYSTEM_PRESET_HINT = /you are an ai agent powered by deepseek harness|powered by DeepSeek Harness|harness identity|deployment persona|system prompt/iu
const SYSTEM_PRESET_LABEL = (): string => t('prompt.systemPreset')
const CONTEXT_LABEL = (): string => t('prompt.context')

/** Classify one injected prompt blob into display sources. */
export function promptInjectionSources(text: string, plugin?: string): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  const add = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    found.push(id)
  }
  for (const { id, pattern } of PROMPT_SOURCE_PATTERNS) {
    if (pattern.test(text)) add(id)
  }
  const fromTags = text.matchAll(/Additional instructions from:\s*([^\n<]+)/giu)
  for (const match of fromTags) {
    const raw = (match[1] ?? '').trim()
    const file = raw.split(/[\\/]/u).filter(Boolean).at(-1)
    if (file !== undefined && /\.md$/iu.test(file)) add(file.toUpperCase())
  }
  const looksSystem = SYSTEM_PRESET_HINT.test(text)
    || plugin === 'system-prompt'
    || plugin === 'dsh-system-prompt'
  if (looksSystem) add(SYSTEM_PRESET_LABEL())
  if (found.length === 0) add(CONTEXT_LABEL())
  const systemIndex = found.indexOf(SYSTEM_PRESET_LABEL())
  if (systemIndex > 0) {
    found.splice(systemIndex, 1)
    found.unshift(SYSTEM_PRESET_LABEL())
  }
  return found
}

export function promptInjectionTitle(sources: readonly string[]): string {
  return sources.length === 0 ? t('prompt.inject') : t('prompt.injectWith', { sources: sources.join(' ') })
}

export function isPromptInjectionMessage(sourceKind: string, text: string, plugin?: string): boolean {
  if (sourceKind === 'user') return false
  if (sourceKind === 'plugin') return true
  return /<system-reminder\b/iu.test(text)
    || SYSTEM_PRESET_HINT.test(text)
    || promptInjectionSources(text, plugin).some(id => id !== SYSTEM_PRESET_LABEL())
}

/** Official `/compact` idle-only failures, mapped to a local sentence. */
export function formatCompactCommandError(text: string): string {
  const raw = text.trim()
  if (raw === '') return t('command.failed')
  if (
    raw.includes('agent is not idle')
    || raw.includes('active compaction')
    || raw.includes('requires an idle agent')
  ) {
    return t('compact.busy')
  }
  if (raw.includes('No compactable history')) return t('compact.nothing')
  if (raw.startsWith('Usage: /compact')) return t('compact.usage')
  if (raw === 'Compaction cancelled.') return t('compact.cancelled')
  if (raw.includes('could not produce a useful summary')) return t('compact.noSummary')
  if (raw.includes('history selected for compaction changed')) return t('compact.changed')
  if (raw.includes('did not finish cleanly')) return t('compact.commit')
  if (raw.includes('could not be saved')) return t('compact.persistence')
  return raw
}

export function compactionHeaderText(row: {
  status: 'running' | 'ok' | 'error'
  pruneCount: number
  prunedTokens: number
  error?: string
}): string {
  const recovered = row.prunedTokens > 0
    ? t('compact.recoverTokens', { tokens: formatTokens(row.prunedTokens) })
    : row.pruneCount > 0
      ? t('compact.pruneChunks', { count: row.pruneCount })
      : t('compact.prepare')
  if (row.status === 'running') return t('compact.running', { detail: recovered })
  if (row.status === 'error') return t('compact.failed', { error: row.error ?? t('quota.unknown') })
  return t('compact.done', { detail: recovered })
}

/** Transcript rows matching a `/find` query, newest last. */
export function matchTranscriptRows(
  rows: readonly Row[],
  raw: string,
): Row[] {
  const { category, query } = parseFindQuery(raw)
  const needle = query.toLowerCase()
  return rows.filter(row => {
    const kind = cardCategoryOf(row)
    if (kind === undefined) return false
    if (category !== undefined && kind !== category) return false
    if (needle === '') return SEARCHABLE_CATEGORIES.includes(kind) || category !== undefined
    return rowSearchHaystack(row).toLowerCase().includes(needle)
  })
}

/** One-line note under an expanded plan strip. */
export function planDockNote(plan: {
  active: boolean
  pending: boolean
  todos: readonly PlanTodoItem[]
  planMarkdown?: string
  turnLeftOpen?: boolean
}): string {
  const running = plan.todos.some(item => item.status === 'in_progress')
  const allDone = plan.todos.length > 0 && plan.todos.every(item => item.status === 'completed')
  const leftover = plan.todos.filter(item => item.status !== 'completed').length
  if (plan.turnLeftOpen === true && leftover > 0) {
    return t('plan.leftOpen', { count: leftover })
  }
  if (plan.pending) return t('plan.pendingNext')
  if (plan.active) return t('plan.planningOnly')
  if (running) return t('plan.executing')
  if (allDone) return t('plan.allDone')
  if (plan.todos.length > 0 || (plan.planMarkdown !== undefined && plan.planMarkdown !== '')) {
    return t('plan.stillOpen')
  }
  return t('plan.closed')
}

/** Compact per-status counts matching the web plan strip. */
export function todoProgressLabel(todos: readonly PlanTodoItem[]): string {
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.filter(item => item.status === 'in_progress').length
  const failed = todos.filter(item => item.status === 'failed').length
  const skipped = todos.filter(item => item.status === 'skipped').length
  const pending = todos.length - done - active - failed - skipped
  const parts: string[] = []
  if (done > 0) parts.push(t('plan.todoDone', { count: done }))
  if (active > 0) parts.push(t('plan.todoActive', { count: active }))
  if (pending > 0) parts.push(t('plan.todoPending', { count: pending }))
  if (failed > 0) parts.push(t('plan.todoFailed', { count: failed }))
  if (skipped > 0) parts.push(t('plan.todoSkipped', { count: skipped }))
  return parts.join(' · ')
}

export function todoItemKind(status: PlanTodoItem['status']): DisplayKind {
  if (status === 'completed') return 'todo-done'
  if (status === 'in_progress') return 'todo-active'
  if (status === 'failed') return 'todo-failed'
  if (status === 'skipped') return 'todo-skipped'
  return 'todo-pending'
}

/**
 * A Braille bar for the plan's completion, in the same family as the context
 * ring: `⣿` filled, `⣀` empty, and the eight partial cells between them.
 * @param todos - the list as the model last wrote it.
 * @param cells - bar width in cells.
 */
export function todoProgressBar(todos: readonly PlanTodoItem[], cells = 10): string {
  const width = Math.max(1, cells)
  const total = todos.length
  if (total === 0) return CONTEXT_RING_EMPTY.repeat(width)
  const done = todos.filter(item => item.status === 'completed').length
  const steps = Math.round((done / total) * width * 8)
  let bar = ''
  for (let cell = 0; cell < width; cell += 1) {
    const remaining = steps - cell * 8
    bar += CONTEXT_RING_SEGMENTS[Math.max(0, Math.min(8, remaining))] ?? CONTEXT_RING_FULL
  }
  return bar
}

export function planMarkdownFromArgs(value: unknown): string | undefined {
  const root = typeof value === 'string' ? parseJsonArgs(value) : value
  if (root === null || typeof root !== 'object' || Array.isArray(root)) return undefined
  const plan = (root as { plan?: unknown }).plan
  return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
}

/** First markdown heading of an exit_plan_mode plan body. */
export function planTitleFromMarkdown(markdown: string): string | undefined {
  const match = /^\s*#\s+(.+)$/mu.exec(markdown)
  const title = match?.[1]?.trim()
  return title === undefined || title === '' ? undefined : title
}

/** Parse a todo_write payload into displayable plan items. */
export function parsePlanTodos(value: unknown): PlanTodoItem[] {
  const root = typeof value === 'string' ? parseJsonArgs(value) : value
  const todos = root !== null && typeof root === 'object' && !Array.isArray(root)
    ? (root as { todos?: unknown }).todos
    : Array.isArray(root) ? root : undefined
  if (!Array.isArray(todos)) return []
  const out: PlanTodoItem[] = []
  for (const item of todos) {
    if (typeof item !== 'object' || item === null) continue
    const content = typeof (item as { content?: unknown }).content === 'string'
      ? (item as { content: string }).content.trim()
      : ''
    if (content === '') continue
    out.push({ content, status: normalizeTodoStatus((item as { status?: unknown }).status) })
  }
  return out
}

/** Compact todo-list summary: done/total plus the first in-progress task. */
export function todoSummary(value: unknown): string {
  const todos = parsePlanTodos(value)
  if (todos.length === 0) return t('plan.list')
  const done = todos.filter(item => item.status === 'completed').length
  const active = todos.find(item => item.status === 'in_progress')
  const extra = todos.filter(item => item.status === 'in_progress').length
  // The collapsed card is the line a user actually watches during a long task,
  // so the bar belongs here too — the expanded body repeats it beside the list.
  const head = `${todoProgressBar(todos)} ${t('plan.todoSummary', { done, total: todos.length })}`
  if (active === undefined) return head
  return extra > 1
    ? t('plan.todoSummaryExtra', { head, active: active.content, extra: extra - 1 })
    : t('plan.todoSummaryActive', { head, active: active.content })
}

/** Compact ask_user_question summary from tool arguments. */
export function askSummary(value: unknown): string {
  const root = typeof value === 'string' ? parseJsonArgs(value) : value
  const questions = root !== null && typeof root === 'object' && !Array.isArray(root)
    ? (root as { questions?: unknown }).questions
    : undefined
  if (!Array.isArray(questions) || questions.length === 0) return t('question.waiting')
  const first = questions[0]
  const text = typeof first === 'object' && first !== null && typeof (first as { question?: unknown }).question === 'string'
    ? (first as { question: string }).question
    : t('question.waiting')
  return questions.length > 1 ? t('ask.multi', { text, count: questions.length }) : text
}

/** First non-empty line, collapsed to a single scan line. */
export function firstDisplayLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** Collapse a child-session blob to one short chip/wait-card line. */
export function clipSubagentActivity(text: string, maxChars = 48): string {
  const line = firstDisplayLine(text)
  if (line === '') return ''
  const clipped = sliceCodePoints(line, maxChars)
  return clipped === line ? line : `${clipped}…`
}

function subagentStatusLabel(status: Extract<Row, { kind: 'subagent' }>['status']): string {
  if (status === 'running') return t('sub.running')
  if (status === 'ok') return t('sub.ok')
  if (status === 'aborted') return t('sub.aborted')
  return t('sub.failed')
}

/** Running / ok / aborted / error → ANSI for the status dot and status word. */
export function subagentStateColor(
  status: Extract<Row, { kind: 'subagent' }>['status'],
): '33' | '32' | '31' | '90' {
  if (status === 'ok') return '32'
  if (status === 'error') return '31'
  if (status === 'aborted') return '90'
  return '33'
}

/**
 * Rebuild a subagent chip from the parent spawn tool call that survives in the
 * session log. Live `subagent/start` is not replayed, so resume would otherwise
 * show a generic tool card titled from the English description ("probe").
 */
export function subagentRowFromSpawnTool(input: {
  callId: string
  task: string
  provider?: string
  /** Model route for the child, when the caller knows it. */
  modelProvider?: string
  local?: boolean
  status?: Extract<Row, { kind: 'subagent' }>['status']
  startedAt?: number
  endedAt?: number
  output?: string
}): Extract<Row, { kind: 'subagent' }> {
  const task = input.task.trim()
  const provider = input.provider?.trim() || 'spawn'
  const modelProvider = input.modelProvider?.trim() ?? ''
  const status = input.status ?? 'ok'
  const startedAt = input.startedAt ?? 0
  const output = clipSubagentActivity(input.output ?? '')
  return {
    kind: 'subagent',
    sessionId: input.callId,
    spawnCallId: input.callId,
    runId: input.callId,
    provider,
    ...(modelProvider === '' ? {} : { modelProvider }),
    local: input.local ?? true,
    label: t('sub.label', { provider }),
    ...(task === '' ? {} : { task }),
    status,
    startedAt,
    ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    lastActivity: output === '' ? t('sub.started') : output,
    logs: output === ''
      ? [{ kind: 'system', text: t('sub.startedDetail', { provider: modelProvider === '' ? provider : modelProvider, external: '' }) }]
      : [{ kind: 'assistant', text: output }],
    expanded: false,
  }
}

/**
 * Courtesy title: distilled role plus a directional beast.
 *
 * The beast comes from the child's own session id, never the parent call id a
 * replayed chip was built with: the same child must keep its symbol across a
 * `--resume`.
 */
export function subagentDisplayName(row: Extract<Row, { kind: 'subagent' }>): string {
  return subagentCourtesyName({
    sessionId: row.childSessionId ?? row.sessionId,
    ...(row.task === undefined ? {} : { task: row.task }),
    fallback: row.label,
  })
}

/**
 * Short activity for the collapsed chip and wait card: prefer the parent
 * task name, else a clipped last log line. Never the full child transcript.
 */
export function subagentChipSummary(row: Extract<Row, { kind: 'subagent' }>): string {
  const fail = row.failHint?.trim() ?? ''
  if (fail !== '' && (row.status === 'error' || row.status === 'aborted')) {
    return clipSubagentActivity(fail, 48)
  }
  const task = row.task?.trim() ?? ''
  if (task !== '') {
    // The courtesy title already carries the distilled role, so strip a leading
    // English verb (`probe /www` → `/www`) instead of repeating it on resume.
    const stripped = task.replace(/^(probe|scan|search|read|fetch|run|plan|edit|write|inspect|explore|look)\b[\s:/]*/iu, '')
    return clipSubagentActivity(stripped === '' ? task : stripped, 40)
  }
  return clipSubagentActivity(row.lastActivity, 40)
}

/** Header + SGR spans: identity color, status dot/word, muted summary. */
export function buildSubagentHeader(input: {
  focused: boolean
  title: string
  status: Extract<Row, { kind: 'subagent' }>['status']
  elapsedLabel: string
  summary: string
  spinner?: string
  inspectHint?: string
  /** Different provider from the parent: paint the title cyan, not violet. */
  foreign?: boolean
}): { plain: string; segments: TextSegment[] } {
  const prefix = input.focused ? '▶ ' : '  '
  const marker = '▸'
  const lead = `${prefix}${marker} ● ${input.title}`
  const state = subagentStatusLabel(input.status)
  const stateText = `  ${state} · ${input.elapsedLabel}`
  const summaryText = input.summary === '' ? '' : `  ${input.summary}`
  const spinner = input.spinner ?? ''
  const hint = input.inspectHint ?? ''
  const plain = `${lead}${stateText}${summaryText}${spinner}${hint}`
  const dotIndex = lead.indexOf('●')
  const titleIndex = lead.indexOf(input.title)
  const stateCode = subagentStateColor(input.status)
  const segments: TextSegment[] = []
  if (dotIndex >= 0) segments.push({ start: dotIndex, end: dotIndex + '●'.length, sgr: stateCode })
  if (titleIndex >= 0 && input.title !== '') {
    segments.push({
      start: titleIndex,
      end: titleIndex + input.title.length,
      sgr: subagentIdentitySgr(input.foreign === true),
    })
  }
  segments.push({ start: lead.length, end: lead.length + stateText.length, sgr: stateCode })
  if (summaryText.length > 0) {
    segments.push({
      start: lead.length + stateText.length,
      end: lead.length + stateText.length + summaryText.length,
      sgr: '90',
    })
  }
  const tailStart = lead.length + stateText.length + summaryText.length
  if (spinner !== '' || hint !== '') {
    segments.push({ start: tailStart, end: plain.length, sgr: '90' })
  }
  return { plain, segments: segments.filter(segment => segment.end > segment.start) }
}

/** Map a folded child-session event onto an existing display role. */
export function subagentLogDisplayKind(
  entry: SubagentLogEntry,
  status: Extract<Row, { kind: 'subagent' }>['status'],
): DisplayKind {
  if (entry.kind === 'user') return 'user'
  if (entry.kind === 'assistant') return 'assistant'
  if (entry.kind === 'tool') return entry.text.includes('✗') ? 'error' : 'tool'
  if (entry.kind === 'approval') return 'todo-active'
  if (entry.kind === 'result') {
    const failed = status === 'error' || /^\s*✗/u.test(entry.text)
    return failed ? 'error' : 'tool-result'
  }
  return 'system'
}

/**
 * Overlay body: session line, stop reason, then the clipped child log.
 *
 * The child's session id is the one `/subagents kill` takes, so it belongs on
 * this line — the collapsed chip stays free of opaque ids.
 */
export function subagentInspectLines(row: Extract<Row, { kind: 'subagent' }>): DiffDisplayLine[] {
  const modelProvider = row.modelProvider?.trim() ?? ''
  const lines: DiffDisplayLine[] = [{
    kind: 'subagent-header',
    text: t('sub.cardSession', {
      name: subagentDisplayName(row),
      id: row.childSessionId === undefined ? '' : ` · ${row.childSessionId}`,
      provider: modelProvider === '' ? t('card.subagent') : modelProvider,
      external: row.local ? '' : t('sub.external'),
    }).trim(),
  }]
  if (row.task !== undefined && row.task.trim() !== '') {
    lines.push({ kind: 'tool-result', text: t('sub.cardTask', { task: row.task.trim() }) })
  }
  if (row.failHint !== undefined && row.failHint.trim() !== '') {
    lines.push({ kind: 'error', text: t('sub.failHint', { hint: row.failHint.trim() }).trim() })
  } else if (row.stopReason !== undefined) {
    lines.push({ kind: 'system', text: t('sub.stopReason', { reason: row.stopReason }).trim() })
  }
  if (row.logs.length === 0) {
    lines.push({
      kind: 'system',
      text: (row.status === 'running' ? t('sub.cardWait') : t('sub.cardEmpty')).trim(),
    })
    return lines
  }
  for (const entry of row.logs) {
    const kind = subagentLogDisplayKind(entry, row.status)
    for (const text of entry.text.split('\n')) {
      lines.push({ kind, text })
    }
  }
  return lines
}

/**
 * Classify a child-session error so the chip can say *why* it died, not just
 * that it ended. Quota and expired auth get a command that actually helps;
 * everything else keeps a clipped diagnostic.
 */
export function describeSubagentFailure(input: {
  stopReason?: string
  message?: string
  provider?: string
}): { hint: string; kind: 'quota' | 'auth' | 'effort' | 'error' } | undefined {
  const reason = input.stopReason?.trim() ?? ''
  const message = (input.message ?? '').replace(/\s+/gu, ' ').trim()
  if (reason === '' && message === '') return undefined
  if (reason === 'aborted' && message === '') {
    return { hint: t('sub.failAborted'), kind: 'error' }
  }
  const blob = `${reason} ${message}`.toLowerCase()
  const rawProvider = input.provider?.trim() ?? ''
  // The backend name (`spawn` / `fork` / `acp`) is not a provider a user can
  // act on; the short code is what the footer already calls that route.
  const provider = rawProvider === '' || rawProvider === 'spawn'
    ? t('card.subagent')
    : providerShortCode(rawProvider)
  if (
    /\b(401|403|unauthori[sz]ed|invalid[_ ]?(api[_ ]?key|token)|token expired|expired token|authentication|not authenticated)\b/u.test(blob)
    || /未授权|无效.*key|token 过期|登录过期|鉴权/.test(message)
  ) {
    return { hint: t('sub.failAuth', { provider }), kind: 'auth' }
  }
  if (
    /\b(429|quota|rate[_ ]?limit|insufficient[_ ]?(quota|credit)|billing|payment required)\b/u.test(blob)
    || /额度|配额|余额不足|限流/.test(message)
  ) {
    return { hint: t('sub.failQuota', { provider }), kind: 'quota' }
  }
  if (/\bunsupported_reasoning_effort|does not support reasoning effort\b/u.test(blob)) {
    return { hint: t('sub.failEffort'), kind: 'effort' }
  }
  const detail = message === '' ? reason : message
  if (detail === '') return undefined
  return { hint: clipSubagentActivity(detail, 72), kind: 'error' }
}

function settleSubagentToolLine(
  row: Extract<Row, { kind: 'subagent' }>,
  entry: SubagentLogEntry,
): boolean {
  const open = entry.callId !== undefined
    ? row.logs.findLast(item => item.kind === 'tool' && item.callId === entry.callId)
    : row.logs.findLast(item => item.kind === 'tool' && !/[✓✗]/u.test(item.text))
  if (open === undefined) return false
  const mark = /^\s*✗/u.test(entry.text) ? '✗' : '✓'
  if (!/[✓✗]/u.test(open.text)) open.text = `${open.text}  ${mark}`
  // What the tool returned rides on the call line: the overlay is the only
  // surface that can show it, and that line is where a reader looks for it.
  const detail = entry.detail?.trim() ?? ''
  if (detail !== '') open.text = `${open.text} · ${detail}`
  row.lastActivity = clipSubagentActivity(open.text)
  return true
}

export function appendSubagentLog(row: Extract<Row, { kind: 'subagent' }>, entry: SubagentLogEntry): void {
  if (entry.kind === 'result' && settleSubagentToolLine(row, entry)) return
  const detail = entry.detail?.trim() ?? ''
  const text = detail === '' ? entry.text : `${entry.text} · ${detail}`
  row.logs.push({ ...entry, text })
  if (row.logs.length > MAX_SUBAGENT_LOGS) row.logs.splice(0, row.logs.length - MAX_SUBAGENT_LOGS)
  row.lastActivity = clipSubagentActivity(text)
}

/** Fold a child user/plugin blob: reminders become one inject chip, not raw XML. */
export function foldSubagentUserLog(
  row: Extract<Row, { kind: 'subagent' }>,
  text: string,
  sourceKind = 'user',
  plugin?: string,
): void {
  const body = text.trim()
  if (body === '') return
  if (isPromptInjectionMessage(sourceKind, body, plugin)) {
    const title = promptInjectionTitle(promptInjectionSources(body, plugin))
    const last = row.logs.at(-1)
    if (last?.kind === 'system' && last.text === title) {
      row.lastActivity = title
      return
    }
    appendSubagentLog(row, { kind: 'system', text: title })
    return
  }
  appendSubagentLog(row, { kind: 'user', text: `❯ ${clipSubagentActivity(body, 80)}` })
}
