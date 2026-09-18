/**
 * Friendly display names for background jobs and subagent chips.
 *
 * Background `job_*` cards otherwise read as the raw tool vocabulary
 * (`job_output`, `job_id: bash-1`). Each job id gets a two-token alias
 * (hour + weather: 昏风 / twilight wind) derived from the id itself rather
 * than from a random draw, so the same
 * job keeps one name across its call card, its result card, and every later
 * `job_output` / `job_kill` mention. The model-facing id stays authoritative;
 * the alias is presentation only.
 *
 * Subagent chips use a different scheme: a role distilled from the parent
 * spawn description, joined to one of the four directional beasts
 * (青龙 / 白虎 / 朱雀 / 玄武) hashed from the child session id.
 *
 * @module dsh-ssh-tui/job-label
 */

import { t } from './i18n/index.js'

/** FNV-1a over the job id: stable, dependency-free, and well spread for short ids. */
export function hashJobId(id: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function splitList(key: string): string[] {
  return t(key).split(',').filter(word => word !== '')
}

function pickPair(id: string, left: readonly string[], right: readonly string[]): { left: string; right: string } | undefined {
  if (left.length === 0 || right.length === 0) return undefined
  const hash = hashJobId(id)
  const a = left[hash % left.length]
  const b = right[Math.floor(hash / left.length) % right.length]
  if (a === undefined || b === undefined) return undefined
  return { left: a, right: b }
}

/**
 * One stable alias for a background job, or `undefined` when the id is empty
 * or the locale carries no vocabulary.
 * @param jobId - the native job id (`bash-1`, `pwsh-2`, …).
 * @returns the locale-formatted alias, e.g. `昏风` / `twilight wind`.
 */
export function jobAlias(jobId: string): string | undefined {
  const id = jobId.trim()
  if (id === '') return undefined
  const pair = pickPair(id, splitList('jobAlias.left'), splitList('jobAlias.right'))
  if (pair === undefined) return undefined
  return t('jobAlias.pattern', { left: pair.left, right: pair.right })
}

/** The four directional beasts, hashed from the child session id. */
export const SUBAGENT_BEASTS = ['azure-dragon', 'white-tiger', 'vermilion-bird', 'black-tortoise'] as const

export type SubagentBeastId = (typeof SUBAGENT_BEASTS)[number]

export type SubagentRoleId =
  | 'scout'
  | 'scribe'
  | 'artisan'
  | 'envoy'
  | 'inquirer'
  | 'sentinel'
  | 'steward'
  | 'courier'

const ROLE_RULES: readonly { id: SubagentRoleId; pattern: RegExp }[] = [
  { id: 'scout', pattern: /\b(scan|search|find|grep|glob|explore|look|locate|discover|inspect|audit|survey|probe|list|enumerate|index|crawl|research|recon)\b|扫描|搜索|查找|检索|探|搜|列目录|枚举|审计|巡|调研|勘查|探查|探路/iu },
  { id: 'scribe', pattern: /\b(read|summar\w*|review|analy[sz]\w*|explain|understand|study|investigat\w*|diagnos\w*|trace|reason|think|compare|eval\w*)\b|阅读|读取|摘要|总结|分析|解释|理解|研究|调查|诊断|对比|评估|审阅/iu },
  { id: 'artisan', pattern: /\b(edit|write|patch|fix|implement|refactor|code|apply|create|update|change|modify|build|generate|draft)\b|编辑|写入|修改|实现|重构|修补|生成|起草|创建|更新/iu },
  { id: 'envoy', pattern: /\b(web|http|fetch|browse|url|download|request|api|network)\b|网页|抓取|浏览|下载|请求|联网/iu },
  { id: 'inquirer', pattern: /\b(ask|question|clarif\w*|confirm|choose|pick|option)\b|提问|询问|澄清|确认|选择/iu },
  { id: 'sentinel', pattern: /\b(test|lint|check|verify|validat\w*|assert|guard|watch|monitor)\b|测试|检查|校验|验证|看守|监视/iu },
  { id: 'steward', pattern: /\b(plan|todo|goal|organiz\w*|coordinat\w*|orchestr\w*|delegat\w*|schedul\w*)\b|计划|待办|目标|编排|协调|调度/iu },
  { id: 'courier', pattern: /\b(run|execut\w*|shell|bash|command|install|spawn|launch|job|terminal)\b|运行|执行|终端|安装|启动|命令/iu },
]

/** Distill a parent spawn description into one role id. */
export function subagentRoleId(task: string): SubagentRoleId {
  const text = task.replace(/\s+/gu, ' ').trim()
  if (text === '') return 'courier'
  for (const rule of ROLE_RULES) {
    if (rule.pattern.test(text)) return rule.id
  }
  return 'courier'
}

/** Hash the child session onto one of the four beasts. */
export function subagentBeastId(sessionId: string): SubagentBeastId {
  const id = sessionId.trim()
  const hash = id === '' ? 0 : hashJobId(id)
  return SUBAGENT_BEASTS[hash % SUBAGENT_BEASTS.length] ?? 'azure-dragon'
}

/** Localized role label (`探路` / `scout`). */
export function subagentRoleLabel(role: SubagentRoleId): string {
  return t(`sub.role.${role}`)
}

/** Localized beast label (`青龙` / `Azure Dragon`). */
export function subagentBeastLabel(beast: SubagentBeastId): string {
  return t(`sub.beast.${beast}`)
}

/**
 * Chip title: `探路·青龙` / `Scout · Azure Dragon`.
 * Falls back to the spawn-time label when neither task nor id can be named.
 */
export function subagentCourtesyName(input: {
  sessionId: string
  task?: string
  fallback: string
}): string {
  const task = input.task?.trim() ?? ''
  const id = input.sessionId.trim()
  if (task === '' && id === '') return input.fallback
  return t('sub.courtesy', {
    role: subagentRoleLabel(subagentRoleId(task)),
    beast: subagentBeastLabel(subagentBeastId(id === '' ? task : id)),
  })
}

/** True when a string looks like a session / tool-call id, not a display name. */
export function looksLikeOpaqueId(value: string): boolean {
  const text = value.trim()
  if (text === '') return false
  if (/^call-/iu.test(text)) return true
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(text)) return true
  if (/^[0-9a-f]{16,}$/iu.test(text)) return true
  return false
}

/** Prefer a recorded tool name; never surface `call-<uuid>` as a title. */
export function displayToolName(name: string | undefined): string {
  const text = name?.trim() ?? ''
  if (text === '' || looksLikeOpaqueId(text)) return 'tool'
  return text
}
