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

export type AutoApprovalMode = 'off' | 'auto'
export type ApprovalDecision = 'allow' | 'deny' | 'ask'

/**
 * Whole-command danger patterns, checked before anything else. A match
 * auto-rejects. This is a UX heuristic, not a security boundary: obfuscated
 * or interpreter-wrapped damage still has to be contained by the sandbox.
 */
export const DANGER_PATTERNS: RegExp[] = [
  /(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b/,
  /\beval\b[^|;&]*(?:\$\(|`)/,
  /\brm\s+(?:-\w+\s+)*-\w*[rf]/i,
  /\brm\s+(?:-\w+\s+)*--(?:recursive|force|dir)\b/i,
  /\brm\s+(?:--\s+)?\/(?:\s|$)/,
  /\bsudo\b/,
  /\b(?:chmod|chown)\s+(?:-\w+\s+)*-R\b/,
  /\bmkfs\.\w/,
  /\bdd\b[^|;&]*of=\/dev\//,
  /\b(?:shutdown|reboot|halt|poweroff)\b|\binit\s+[06]\b/,
  /:\(\)\s*\{.*\};\s*:/,
  /\bgit\s+push\b[^|;&]*(?:--force|\s-f\b|\s\+\S)/,
  /\b(?:npm|pnpm|yarn)\s+publish\b/,
  /\bfind\b[^|;&]*\s(?:-exec\b|-delete\b)/,
  />>?\s*\/dev\/(?:sd|nvme|hd)/,
  /\bcrontab\s+-r\b/,
  /\b(?:python3?|node|nodejs|perl|ruby|php|lua)\s+-c\b/,
  /\b(?:python3?|node|nodejs|perl|ruby)\s+-e\b/,
  /\bbash\s+-c\b|\bsh\s+-c\b/,
]

/**
 * Segment-level allow patterns: low-risk, high-frequency reads, builds, and
 * tests. A command auto-approves only when EVERY segment matches one of these.
 */
export const ALLOW_SEGMENT_PATTERNS: RegExp[] = [
  /^(?:ls|cat|head|tail|wc|file|stat|du|df|which|whoami|pwd|date|env|printenv|sleep|clear|true|false)\b/,
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

/** Split a shell command into segments at &&, ||, ; and | boundaries. */
function segments(command: string): string[] {
  return command
    .split(/(?:\|\||&&|;|\|)/u)
    .map(segment => segment.trim())
    .filter(segment => segment !== '')
}

/** True when the segment redirects into an absolute filesystem path. */
function redirectsToRoot(segment: string): boolean {
  return /(?:^|\s)>>?\s*(?:\/(?!tmp\/|var\/tmp\/|home\/)|~)/u.test(segment)
}

const MUTATING_SEGMENT = /^(?:cp|mv|install|rm|mkdir|touch|tee)\b/u

/** System-sensitive paths the reviewer also rejects; mutating allowlist must not skip them. */
const SENSITIVE_PATH = /(?:^|[\s"'=])(?:~\/(?:\.ssh|\.gnupg)(?:\/|$)|\/(?:etc|boot|usr|bin|sbin|lib|root|proc|sys|dev)(?:\/|$|\s)|\/var\/log(?:\/|$|\s)|(?:^|\/)\.env(?:\b|$)|(?:^|\/)id_(?:rsa|ed25519)(?:\b|$))/u

function touchesSensitivePath(segment: string): boolean {
  return SENSITIVE_PATH.test(segment)
}

/**
 * Classify one shell command line. Danger anywhere auto-rejects; otherwise
 * the command auto-approves only when every segment is a recognized low-risk
 * pattern — unknown shapes ask (and detach to a rejection when unattended).
 */
export function classifyCommand(command: string): ApprovalDecision {
  const trimmed = command.trim()
  if (trimmed === '') return 'ask'
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(trimmed)) return 'deny'
  }
  const parts = segments(trimmed)
  if (parts.length === 0) return 'ask'
  for (const segment of parts) {
    if (redirectsToRoot(segment)) return 'deny'
    if (MUTATING_SEGMENT.test(segment) && touchesSensitivePath(segment)) return 'deny'
    if (!ALLOW_SEGMENT_PATTERNS.some(pattern => pattern.test(segment))) return 'ask'
  }
  return 'allow'
}

/** Tools whose output is read-only network information. */
const SAFE_NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])

/**
 * Classify one approval request. `command` is the decoded shell command when
 * the pending call is a shell tool. 'deny' auto-rejects (the model reads the
 * rejection and adapts); 'ask' falls through to the interactive prompt.
 */
export function classifyApproval(toolName: string, command: string | undefined): ApprovalDecision {
  if (SAFE_NETWORK_TOOLS.has(toolName)) return 'allow'
  if (command === undefined || command.trim() === '') return 'ask'
  return classifyCommand(command)
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

const SHELL_TOOL_NAMES = new Set(['bash', 'pwsh'])

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
  return firstNonEmpty(
    fromRow,
    SHELL_TOOL_NAMES.has(input.toolName) ? commandFromApprovalReason(input.reason) : undefined,
    commandFromApprovalReason(input.reason),
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
