/**
 * Codex-style auto-approval classifier for the /approval auto mode.
 *
 * This is a UX heuristic, not a security boundary: "allow" means the command
 * matches low-risk, high-frequency conventions (reads, builds, tests, git
 * reads) so unattended turns keep moving. Anything unrecognized — and
 * everything dangerous — stays with the human. Real damage containment still
 * comes from the sandbox preset and git.
 */

export type AutoApprovalMode = 'off' | 'auto'
export type ApprovalDecision = 'allow' | 'ask'

/**
 * Whole-command danger patterns, checked before anything else. A match keeps
 * the interactive prompt regardless of what else the command contains.
 */
export const DANGER_PATTERNS: RegExp[] = [
  /(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/, // … | sh
  /\brm\s+(?:-\w+\s+)*-\w*[rf]/i, // rm -r / -f / -rf variants
  /\brm\s+[^|;&]*\s\/(?:\s|$)/, // rm … / (filesystem root)
  /\bsudo\b/,
  /\bmkfs\.\w/,
  /\bdd\b[^|;&]*of=\/dev\//,
  /\b(?:shutdown|reboot)\b|\binit\s+[06]\b/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
  /\bgit\s+push\b[^|;&]*(?:--force|\s-f\b|\s\+\S)/,
  /\b(?:npm|pnpm|yarn)\s+publish\b/,
  /\bfind\b[^|;&]*\s(?:-exec\b|-delete\b)/,
  />>?\s*\/dev\/(?:sd|nvme|hd)/,
  /\bcrontab\s+-r\b/,
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

/**
 * Classify one shell command line. Danger anywhere wins; otherwise the
 * command auto-approves only when every segment is a recognized low-risk
 * pattern — unknown shapes stay with the human.
 */
export function classifyCommand(command: string): ApprovalDecision {
  const trimmed = command.trim()
  if (trimmed === '') return 'ask'
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(trimmed)) return 'ask'
  }
  const parts = segments(trimmed)
  if (parts.length === 0) return 'ask'
  for (const segment of parts) {
    if (redirectsToRoot(segment)) return 'ask'
    if (!ALLOW_SEGMENT_PATTERNS.some(pattern => pattern.test(segment))) return 'ask'
  }
  return 'allow'
}

/** Tools whose output is read-only network information. */
const SAFE_NETWORK_TOOLS = new Set(['web_fetch', 'web_search'])

/**
 * Classify one approval request. `command` is the decoded shell command when
 * the pending call is a shell tool; anything unrecognized asks.
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

/** Parse the /approval argument into a mode. */
export function parseAutoApprovalMode(raw: string): AutoApprovalMode | undefined {
  const id = raw.trim().toLowerCase()
  if (id === 'auto') return 'auto'
  if (id === 'off' || id === 'ask' || id === 'manual') return 'off'
  return undefined
}
