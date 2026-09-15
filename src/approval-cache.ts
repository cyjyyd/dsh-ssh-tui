/**
 * A TTL cache for approval verdicts the AI reviewer already produced.
 *
 * `/approval auto` hands every shape the rule table cannot judge to a
 * subagent-configured model: one `llm.stream` call, up to 15 seconds, and the
 * user's quota. The same shape repeats inside one session — `pytest -q`,
 * `npm install`, `docker compose up` — and each repeat paid the full review
 * again. This module remembers a verdict for a bounded time so an identical
 * request is decided from the cache.
 *
 * Two rules keep that safe, and both are structural rather than heuristic:
 *
 * 1. Only requests the classifier marked `ask` are ever looked up or stored.
 *    Rule allows and denials are free, and `DANGER_PATTERNS` returns before the
 *    cache is consulted at all, so a remembered verdict can never widen what
 *    the rule table refuses.
 * 2. The key is an exact identity, not a prefix: the tool, the canonical
 *    command, its raw arguments, the sandbox mode, the workspace, the locale,
 *    the reviewer that produced the verdict, and a fingerprint of the user
 *    message that authorized it. A verdict handed out while `npm publish` was
 *    authorized never answers `npm publish --tag next`, and an escalation
 *    justified in one message is not replayed for the next one.
 *
 * Opaque interpreter payloads (`bash -c`, `python -e`) are excluded on purpose:
 * the review result there depends entirely on a script the key cannot see.
 * @module dsh-ssh-tui/approval-cache
 */

import { isOpaqueInterpreterCommand } from './auto-approval.js'
import type { ReviewVerdict } from './approval-reviewer.js'

/** How long one remembered verdict stays usable. */
export const DEFAULT_VERDICT_TTL_MS = 10 * 60 * 1000
/** How many verdicts are remembered at once; the least recently used go first. */
export const DEFAULT_VERDICT_CAPACITY = 32

/**
 * Everything the reviewer's verdict actually depends on.
 *
 * `args` and `authorization` are load-bearing: the `workspace-write` escalation
 * is allowed purely because the model read a justification out of the request,
 * and `latestUserAuthorizationText` is what the reviewer weighs when it decides
 * whether the user asked for this. Dropping either would let one authorization
 * cover a later, different call.
 */
export interface VerdictKeyInput {
  toolName: string
  command: string
  args?: string | undefined
  reason?: string | undefined
  sandboxMode?: string | undefined
  /** The agent the request came from: a subagent's authorization is its own. */
  agentId: string
  workspaceCwd: string
  locale: string
  /** The model that produced the verdict; a different reviewer may differ. */
  reviewer: { provider: string; model: string }
  /** One-way fingerprint of the user message that authorized the request. */
  authorization: string
}

/** FNV-1a: dependency-free, stable across restarts, and fine for a cache key. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** Whitespace-insensitive form of a command, so spacing alone cannot miss. */
export function canonicalCommand(command: string): string {
  return command.trim().replace(/\s+/gu, ' ')
}

/**
 * Whether a verdict for this request may be remembered.
 *
 * A request without a command has nothing to key on, and an interpreter
 * wrapper hides its payload behind `-c`/`-e`, so its review says nothing about
 * the next invocation of the same wrapper.
 * @param input - the identity a verdict would be stored under.
 * @returns whether the cache may serve and store this shape.
 */
export function cacheableShape(input: VerdictKeyInput): boolean {
  const command = canonicalCommand(input.command)
  if (command === '') return false
  return !isOpaqueInterpreterCommand(command)
}

/**
 * The cache key for one reviewed request.
 * @param input - the identity a verdict would be stored under.
 * @returns a stable, collision-resistant digest.
 */
export function verdictKey(input: VerdictKeyInput): string {
  return fnv1a([
    input.toolName,
    canonicalCommand(input.command),
    input.args ?? '',
    input.reason ?? '',
    input.sandboxMode ?? '',
    input.agentId,
    input.workspaceCwd,
    input.locale,
    `${input.reviewer.provider}/${input.reviewer.model}`,
    input.authorization,
  ].join('\u0000'))
}

export interface CachedVerdict {
  verdict: ReviewVerdict
  storedAt: number
}

/**
 * A bounded, time-limited map from a reviewed request to its verdict.
 *
 * Both limits are injectable so tests can drive the clock instead of sleeping.
 * The instance is per TUI: a fresh session starts with an empty cache, and
 * nothing is written to disk.
 */
export class ApprovalVerdictCache {
  private readonly entries = new Map<string, CachedVerdict>()
  private hitCount = 0

  constructor(private readonly options: {
    ttlMs?: number
    capacity?: number
    now?: () => number
  } = {}) {}

  private get ttlMs(): number {
    return this.options.ttlMs ?? DEFAULT_VERDICT_TTL_MS
  }

  private get capacity(): number {
    return this.options.capacity ?? DEFAULT_VERDICT_CAPACITY
  }

  private get now(): number {
    return (this.options.now ?? Date.now)()
  }

  /**
   * The remembered verdict for a key, if it is still inside its TTL.
   * @param key - {@link verdictKey} of the request being decided.
   * @returns the verdict and its age, or `undefined` for a miss or an expiry.
   */
  lookup(key: string): { verdict: ReviewVerdict; ageMs: number } | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    const ageMs = this.now - entry.storedAt
    if (ageMs > this.ttlMs) {
      this.entries.delete(key)
      return undefined
    }
    // Refresh recency so the entries in active use survive the capacity bound.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hitCount += 1
    return { verdict: entry.verdict, ageMs }
  }

  /**
   * Remember one reviewed verdict, evicting the least recently used entry past
   * the capacity.
   * @param key - {@link verdictKey} of the reviewed request.
   * @param verdict - what the reviewer concluded.
   */
  store(key: string, verdict: ReviewVerdict): void {
    this.entries.delete(key)
    this.entries.set(key, { verdict, storedAt: this.now })
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  /** Drop every remembered verdict; returns how many were held. */
  clear(): number {
    const held = this.entries.size
    this.entries.clear()
    return held
  }

  /** How many verdicts are held right now. */
  get size(): number {
    return this.entries.size
  }

  /** How many lookups were served from the cache over this instance's life. */
  get hits(): number {
    return this.hitCount
  }

  /** The TTL as whole minutes, for the status line. */
  get ttlMinutes(): number {
    return Math.round(this.ttlMs / 60_000)
  }
}
