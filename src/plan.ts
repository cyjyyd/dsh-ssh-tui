/**
 * Plan dock, todo lists, /find, prompt-injection cards, and compact errors.
 */

import { t } from './i18n/index.js'
import { formatTokens } from './footer.js'
import { parseJsonArgs } from './json-args.js'
import type { DisplayKind, PlanTodoItem, Row, SubagentLogEntry } from './transcript-types.js'

export const MAX_SUBAGENT_LOGS = 80

export const TODO_STATUS_MARK: Record<PlanTodoItem['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
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
  const pending = todos.length - done - active
  const parts: string[] = []
  if (done > 0) parts.push(t('plan.todoDone', { count: done }))
  if (active > 0) parts.push(t('plan.todoActive', { count: active }))
  if (pending > 0) parts.push(t('plan.todoPending', { count: pending }))
  return parts.join(' · ')
}

export function todoItemKind(status: PlanTodoItem['status']): DisplayKind {
  if (status === 'completed') return 'todo-done'
  if (status === 'in_progress') return 'todo-active'
  return 'todo-pending'
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
    const status = (item as { status?: unknown }).status
    out.push({
      content,
      status: status === 'in_progress' || status === 'completed' ? status : 'pending',
    })
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
  const head = t('plan.todoSummary', { done, total: todos.length })
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

/** One-line subagent card header used while collapsed. */
export function subagentHeaderText(row: Extract<Row, { kind: 'subagent' }>, now = Date.now()): string {
  const elapsed = Math.max(0, Math.floor(((row.endedAt ?? now) - row.startedAt) / 1000))
  const elapsedLabel = elapsed >= 60 ? `${Math.floor(elapsed / 60)}m${elapsed % 60}s` : `${elapsed}s`
  const state = row.status === 'running'
    ? t('sub.running')
    : row.status === 'ok'
      ? t('sub.ok')
      : row.status === 'aborted'
        ? t('sub.aborted')
        : t('sub.failed')
  const activity = row.lastActivity === '' ? '' : ` · ${row.lastActivity}`
  const id = row.sessionId.slice(0, 8)
  return `${row.label}  [${id}]  ${state} · ${elapsedLabel}${activity}`
}

export function appendSubagentLog(row: Extract<Row, { kind: 'subagent' }>, entry: SubagentLogEntry): void {
  row.logs.push(entry)
  if (row.logs.length > MAX_SUBAGENT_LOGS) row.logs.splice(0, row.logs.length - MAX_SUBAGENT_LOGS)
  row.lastActivity = entry.text
}
