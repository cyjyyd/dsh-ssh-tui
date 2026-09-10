/**
 * Codex-style auto-approval classifier for the /approval auto mode.
 *
 * This is a UX heuristic, not a security boundary. The contract mirrors
 * Codex's unattended posture: allow-shaped commands (reads, builds, tests,
 * git reads) approve automatically, danger-shaped commands are REJECTED with
 * the model informed (it adapts instead of paging the human), and only
 * genuinely unrecognized shapes fall through to a prompt — which detaches to
 * a rejection when nobody is watching. Real damage containment still comes
 * from the sandbox preset and git.
 */

import { parseJsonArgs } from './json-args.js'

export type AutoApprovalMode = 'off' | 'auto'
export type ApprovalDecision = 'allow' | 'deny' | 'ask'
export type AutoApprovalRisk = 'low' | 'medium' | 'high'

export interface ClassifiedApproval {
  decision: ApprovalDecision
  risk: AutoApprovalRisk
  /** Short stable id for i18n / model feedback. */
  reasonKey: string
}

/**
 * Whole-command danger patterns, checked before anything else. A match
 * auto-rejects. This is a UX heuristic, not a security boundary: obfuscated
 * or interpreter-wrapped damage still has to be contained by the sandbox.
 *
 * Interpreter `-c`/`-e` is NOT here: the table cannot see the payload, so
 * those shapes ask (AI review) instead of a blanket deny.
 */
export const DANGER_PATTERNS: RegExp[] = [
  /(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/,
  /\beval\b[^|;&]*(?:\$\(|`)/,
  /\brm\b(?:\s+[^\s;|&]+)*\s+-\w*[rf]/i,
  /\brm\b(?:\s+[^\s;|&]+)*\s+--(?:recursive|force|dir)\b/i,
  /\brm\s+(?:--\s+)?\/(?:\s|$)/,
  /\bsudo\b/,
  /\b(?:chmod|chown)\s+(?:-\w+\s+)*-R\b/,
  /\bmkfs\.\w/,
  /\bdd\b[^|;&]*of=\/dev\//,
  /\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/,
  /:\(\)\s*\{.*\};\s*:/,
  /\bgit\s+push\b[^|;&]*(?:--force|\s-f\b|\s\+\S)/,
  /\bfind\b[^|;&]*\s(?:-exec\b|-delete\b)/,
  />>?\s*\/dev\/(?:sd|nvme|hd)/,
  /\bcrontab\s+-r\b/,
]

/**
 * Segment-level allow patterns: low-risk, high-frequency reads, builds, and
 * tests. A command auto-approves only when EVERY segment matches one of these.
 * `env`/`printenv` stay off this list — process env often holds keys.
 */
export const ALLOW_SEGMENT_PATTERNS: RegExp[] = [
  /^(?:ls|cat|head|tail|wc|file|stat|du|df|which|whoami|pwd|date|sleep|clear|true|false)\b/,
  /^(?:grep|rg|fd|ag)\b/,
  /^(?:git)\s+(?:status|log|diff|show|branch|remote|tag|rev-parse|blame|ls-files|describe|shortlog|worktree\s+list)\b/,
  /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|ci)\b/,
  /^(?:npx|pnpm\s+dlx|bunx)\s+(?:tsc|eslint|prettier|vitest|jest|biome)\b/,
  /^(?:tsc|eslint|prettier|vitest|jest|biome|ruff|black|mypy)\b/,
  /^(?:make|cmake|ninja|meson)\b/,
  /^(?:pytest|python3?\s+-m\s+(?:pytest|unittest))\b/,
  /^(?:cargo|go)\s+(?:build|test|check|vet|clippy)\b/,
  /^(?:cd|pushd|popd)\s/,
  /^(?:npm|pnpm|yarn|bun|node|python3?|git|cargo|go|rustc|java)\s+(?:-V|--version|-v)\s*$/,
  /^(?:echo)\b/,
  /^(?:mkdir|touch)\b/,
  /^(?:tee)\b/,
  /^(?:cp|mv|install)\b/,
  /^(?:rm)\s+(?!-\w*[rf]|--(?:recursive|force|dir)\b)/,
]

const READ_SEGMENT = /^(?:ls|cat|head|tail|wc|file|stat|du|df|which|whoami|pwd|date|sleep|clear|true|false|grep|rg|fd|ag)\b/u
const MUTATING_SEGMENT = /^(?:cp|mv|install|rm|mkdir|touch|tee|ln|chmod|chown)\b/u
const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh'])
const SAFE_NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])
const WORKSPACE_FILE_TOOLS = new Set(['read', 'edit', 'write', 'str_replace_editor'])
const WORKSPACE_WRITE_ESCALATION = 'workspace-write'
const DANGER_ESCALATION = 'danger-full-access'

/**
 * Split a shell command into segments at &&, ||, ; and | boundaries,
 * skipping those operators when they sit inside quotes or a here-doc
 * terminator. Nested quoting is best-effort — the sandbox still owns
 * real damage containment.
 */
export function segments(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: "'" | '"' | '`' | null = null
  let escaped = false
  let hereDoc: string | null = null
  const chars = Array.from(command)
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i] ?? ''
    if (hereDoc !== null) {
      current += ch
      if (ch === '\n') {
        const lineStart = current.lastIndexOf('\n', current.length - 2) + 1
        const line = current.slice(lineStart, -1).trim()
        if (line === hereDoc) hereDoc = null
      }
      continue
    }
    if (quote === null && escaped === false && ch === '\\') {
      escaped = true
      current += ch
      continue
    }
    if (escaped) {
      escaped = false
      current += ch
      continue
    }
    if (quote !== null) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch
      current += ch
      continue
    }
    if (ch === '<' && chars[i + 1] === '<') {
      const rest = chars.slice(i).join('')
      const match = /^(<<[-]?[ \t]*)(?:\\)?(['"]?)(\w+)\2/u.exec(rest)
      if (match !== null && match[3] !== undefined) {
        hereDoc = match[3]
        current += match[0]
        i += match[0].length - 1
        continue
      }
    }
    if ((ch === '&' && chars[i + 1] === '&') || (ch === '|' && chars[i + 1] === '|')) {
      pushSegment(out, current)
      current = ''
      i += 1
      continue
    }
    if (ch === ';' || ch === '|') {
      pushSegment(out, current)
      current = ''
      continue
    }
    current += ch
  }
  pushSegment(out, current)
  return out
}

function pushSegment(out: string[], raw: string): void {
  const trimmed = raw.trim()
  if (trimmed !== '') out.push(trimmed)
}

/** True when the segment redirects into an absolute filesystem path. */
function redirectsToRoot(segment: string): boolean {
  return /(?:^|\s)>>?\s*(?:\/(?!tmp\/|var\/tmp\/|home\/)|~)/u.test(segment)
}

/**
 * System-sensitive paths. Matching is token-prefix-aware so `src/etc/config.ts`
 * and `/root/project/lib/foo` do not count as `/etc` or `/lib`. `/root` itself
 * (the root home) is sensitive; a workspace under `/root/…` is not.
 */
const SYSTEM_DIR = /^\/(?:etc|boot|usr|bin|sbin|lib|proc|sys|dev)(?:\/|$)/u
const ROOT_HOME_SENSITIVE = /^\/root(?:\/(?:\.ssh|\.gnupg|\.npmrc|\.env|\.config)(?:\/|$)|$)/u
const CREDENTIAL_LEAF = /(?:^|\/)(?:\.ssh|\.gnupg|\.npmrc|\.env|id_(?:rsa|ed25519)|\.config\/dsh-publish)(?:\/|$)/u

export function touchesSensitivePath(text: string): boolean {
  return text.split(/\s+/u).some(tokenLooksSensitive)
}

function tokenLooksSensitive(token: string): boolean {
  const trimmed = token.replace(/^['"]|['"]$/gu, '')
  if (trimmed === '') return false
  if (trimmed.startsWith('~/') && CREDENTIAL_LEAF.test(trimmed.slice(1))) return true
  if (SYSTEM_DIR.test(trimmed) || ROOT_HOME_SENSITIVE.test(trimmed)) return true
  if (/^\/var\/log(?:\/|$)/u.test(trimmed)) return true
  if (CREDENTIAL_LEAF.test(trimmed)) return true
  return false
}

function segmentTouchesSensitivePath(segment: string): boolean {
  return segment.split(/\s+/u).some(tokenLooksSensitive)
}

const classified = (
  decision: ApprovalDecision,
  risk: AutoApprovalRisk,
  reasonKey: string,
): ClassifiedApproval => ({ decision, risk, reasonKey })

/**
 * Classify one shell command line. Danger anywhere auto-rejects; otherwise
 * the command auto-approves only when every segment is a recognized low-risk
 * pattern — unknown shapes ask (and detach to a rejection when unattended).
 */
export function classifyCommand(command: string): ApprovalDecision {
  return classifyCommandDetailed(command).decision
}

const INTERPRETER_WRAPPER = /^(?:python3?|node|nodejs|perl|ruby|php|lua|bash|sh|zsh)\s+-[ce]\b/u

export function classifyCommandDetailed(command: string): ClassifiedApproval {
  const trimmed = command.trim()
  if (trimmed === '') return classified('ask', 'medium', 'empty')
  // Interpreter -c/-e payloads are opaque to the table. Ask (AI review)
  // instead of denying because a quoted `rm -rf` happens to match DANGER_PATTERNS.
  if (INTERPRETER_WRAPPER.test(trimmed)) return classified('ask', 'medium', 'unrecognized')
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(trimmed)) return classified('deny', 'high', 'dangerPattern')
  }
  const parts = segments(trimmed)
  if (parts.length === 0) return classified('ask', 'medium', 'empty')
  for (const segment of parts) {
    if (redirectsToRoot(segment)) return classified('deny', 'high', 'redirectRoot')
    const sensitive = segmentTouchesSensitivePath(segment)
    if (sensitive && (MUTATING_SEGMENT.test(segment) || READ_SEGMENT.test(segment))) {
      return classified('deny', 'high', 'sensitivePath')
    }
    if (!ALLOW_SEGMENT_PATTERNS.some(pattern => pattern.test(segment))) {
      return classified('ask', 'medium', 'unrecognized')
    }
  }
  return classified('allow', 'low', 'allowlist')
}

function looksLikePrivateUrl(url: string): boolean {
  const raw = url.trim()
  if (raw === '') return false
  if (/^(?:file|ftp):/iu.test(raw)) return true
  try {
    const parsed = new URL(raw.includes('://') ? raw : `https://${raw}`)
    const host = parsed.hostname.toLowerCase()
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return true
    if (/^127\./u.test(host) || /^10\./u.test(host) || /^192\.168\./u.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./u.test(host)) {
      return true
    }
    return false
  } catch {
    return /(?:localhost|127\.\d|192\.168\.|10\.\d)/u.test(raw)
  }
}

function pathFromToolArgs(args: Record<string, unknown> | null): string {
  if (args === null) return ''
  for (const key of ['file_path', 'path', 'file']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

function isWorkspacePath(filePath: string, workspaceCwd: string | undefined): boolean {
  const trimmed = filePath.trim()
  if (trimmed === '') return false
  if (trimmed.startsWith('~/') || trimmed === '~') return false
  if (workspaceCwd !== undefined && workspaceCwd.trim() !== '') {
    const cwd = workspaceCwd.replace(/\/+$/u, '')
    if (trimmed === cwd || trimmed.startsWith(`${cwd}/`)) return true
    // Relative paths are workspace-relative for harness file tools.
    if (!trimmed.startsWith('/')) return true
    return false
  }
  return !trimmed.startsWith('/')
}

function parseEscalation(reason: string | undefined, args: Record<string, unknown> | null): {
  requested: string | undefined
  justification: string
} {
  const fromArgs = typeof args?.sandbox_permissions === 'string' ? args.sandbox_permissions.trim() : ''
  const justification = typeof args?.justification === 'string' ? args.justification.trim() : ''
  if (fromArgs !== '') return { requested: fromArgs, justification }
  const match = reason?.match(/escalate sandbox to ([^\s:]+)/iu)
  return {
    requested: match?.[1],
    justification: justification !== '' ? justification : (reason ?? '').trim(),
  }
}

export interface ClassifyApprovalInput {
  toolName: string
  command?: string
  args?: string
  reason?: string
  workspaceCwd?: string
}

/**
 * Classify one approval request. `command` is the decoded shell command when
 * the pending call is a shell tool. 'deny' auto-rejects (the model reads the
 * rejection and adapts); 'ask' falls through to the interactive prompt.
 */
export function classifyApproval(toolName: string, command: string | undefined): ApprovalDecision {
  return classifyApprovalDetailed({ toolName, command }).decision
}

export function classifyApprovalDetailed(input: ClassifyApprovalInput): ClassifiedApproval {
  const toolName = input.toolName
  const parsed = input.args !== undefined ? parseJsonArgs(input.args) : null
  const command = (input.command ?? (typeof parsed?.command === 'string' ? parsed.command : undefined))
  const reason = input.reason
  const workspaceCwd = input.workspaceCwd

  if (SAFE_NETWORK_TOOLS.has(toolName)) {
    const url = typeof parsed?.url === 'string' ? parsed.url
      : typeof parsed?.query === 'string' ? parsed.query
        : typeof parsed?.q === 'string' ? parsed.q
          : command ?? ''
    if (looksLikePrivateUrl(url) || /^file:/iu.test(url)) {
      return classified('deny', 'high', 'privateUrl')
    }
    if (url.trim() === '') return classified('allow', 'low', 'networkRead')
    if (toolName === 'web_search') return classified('allow', 'low', 'networkRead')
    // Fetch of a public URL still asks — the page body is untrusted.
    return classified('ask', 'medium', 'networkFetch')
  }

  if (WORKSPACE_FILE_TOOLS.has(toolName)) {
    const filePath = pathFromToolArgs(parsed)
    if (filePath !== '' && segmentTouchesSensitivePath(filePath)) {
      return classified('deny', 'high', 'sensitivePath')
    }
    if (filePath !== '' && isWorkspacePath(filePath, workspaceCwd)) {
      return classified('allow', 'low', 'workspaceFile')
    }
    return classified('ask', 'medium', 'unrecognized')
  }

  const escalation = parseEscalation(reason, parsed)
  if (escalation.requested === WORKSPACE_WRITE_ESCALATION && escalation.justification !== '') {
    return classified('allow', 'low', 'sandboxWiden')
  }
  if (escalation.requested === DANGER_ESCALATION) {
    // Still classify the underlying command; danger-full-access is not a
    // free pass, but a user-authorized home-directory probe should not be
    // denied solely because it asked to widen.
    if (command !== undefined && command.trim() !== '') {
      const inner = classifyCommandDetailed(command)
      if (inner.decision === 'allow') return inner
      if (inner.decision === 'deny') return inner
    }
    return classified('ask', 'medium', 'sandboxDanger')
  }

  if (command === undefined || command.trim() === '') return classified('ask', 'medium', 'unrecognized')
  return classifyCommandDetailed(command)
}

/**
 * Decode the shell command of a streamed tool call from its raw JSON args.
 * Returns undefined for non-shell tools or unparseable args.
 */
export function commandFromArgs(toolName: string, args: string): string | undefined {
  if (toolName !== 'bash' && toolName !== 'pwsh') return undefined
  try {
    const parsed = JSON.parse(args) as { command?: unknown }
    return typeof parsed.command === 'string' ? parsed.command : undefined
  } catch {
    return undefined
  }
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== '') return value
  }
  return undefined
}

/**
 * Pull a shell command out of an approval-request `reason` when the
 * classifier never saw the tool-call JSON (sandbox escalation, missing
 * callId, or a card whose args were not recorded).
 */
export function commandFromApprovalReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined
  const patterns = [
    /(?:command|cmd|shell)\s*[:=]\s*((?:cp|mv|rm|mkdir|touch|cat|ls|install|tee|git|npm|pnpm|yarn|python3?|node)\b[^\n]+)/iu,
    /(?:escalat\w+|提权|升权)[^\n]*:\s*((?:cp|mv|rm|mkdir|touch|cat|ls|install|tee)\b[^\n]+)/iu,
    /(?:run|running|执行)\s*[`'"]([^`'"]+)[`'"]/iu,
    /\$\s+([^\n]+)/u,
    /(?:^|[\s:])((?:cp|mv|rm|mkdir|touch|cat|ls|install|tee)\b[^\n]+)/iu,
  ]
  for (const pattern of patterns) {
    const match = reason.match(pattern)
    const command = match?.[1]?.trim().replace(/^[`'"]|[`'"]$/gu, '')
    if (command !== undefined && command !== '' && /\s/u.test(command)) return command
  }
  const trimmed = reason.trim()
  if (/^(?:cp|mv|rm|mkdir|touch|cat|ls|chmod|chown|install|tee)\b/u.test(trimmed)) return trimmed
  return undefined
}

/**
 * Resolve the command the classifier should see for one approval request.
 * Prefer the streamed bash/pwsh card, then a command already decoded on the
 * card, then the request's reason text.
 */
export function commandForApprovalRequest(input: {
  toolName: string
  reason?: string
  row?: { name: string; args: string; command?: string }
}): string | undefined {
  const fromRow = input.row === undefined
    ? undefined
    : firstNonEmpty(
      commandFromArgs(input.row.name, input.row.args),
      SHELL_TOOL_NAMES.has(input.row.name) ? input.row.command : undefined,
    )
  const fromReason = commandFromApprovalReason(input.reason)
  return firstNonEmpty(
    fromRow,
    SHELL_TOOL_NAMES.has(input.toolName) ? fromReason : undefined,
  )
}

/** Parse the /approval argument into a mode. */
export function parseAutoApprovalMode(raw: string): AutoApprovalMode | undefined {
  const id = raw.trim().toLowerCase()
  if (id === 'auto' || id === 'on') return 'auto'
  if (id === 'off' || id === 'ask' || id === 'manual') return 'off'
  return undefined
}

/** True when `/approval <arg>` should print the current mode and counters. */
export function isApprovalStatusArg(raw: string): boolean {
  const id = raw.trim().toLowerCase()
  return id === 'status' || id === 'stat' || id === 'info' || id === 'show'
}
