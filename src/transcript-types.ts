/**
 * Shared transcript row shapes used by plan / tool presentation helpers.
 * Kept free of the SshTui class so leaf modules can import them.
 */

export type DisconnectPolicyName = 'pause' | 'continue'

export type SubagentLogKind = 'user' | 'assistant' | 'tool' | 'result' | 'turn' | 'approval' | 'team' | 'system'

/** One child-session event folded into a parent-side subagent card. */
export interface SubagentLogEntry {
  kind: SubagentLogKind
  text: string
}

/** One todo-list item as the plan card renders it. */
export interface PlanTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type Row =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'reasoning'; text: string; expanded: boolean }
  | { kind: 'brand'; text: string }
  | { kind: 'brand-logo' }
  | {
      kind: 'tool'
      callId: string
      name: string
      args: string
      status?: 'running' | 'ok' | 'error'
      output: string
      title: string
      summary: string
      command?: string
      cwd?: string
      diff?: ToolDiffHunk[]
      exitCode?: number
      signal?: string
      expanded: boolean
      /** Consecutive same-path reads/edits folded into this card. */
      repeats?: number
      /** Call ids folded into this card; results still match after merge. */
      mergedCallIds?: string[]
      /** Sum of output characters across folded reads. */
      totalChars?: number
      /** Sum of output lines across folded reads. */
      totalLines?: number
      /** Flip-card animation until this timestamp (ms since epoch). */
      flipUntil?: number
    }
  | {
      kind: 'subagent'
      sessionId: string
      runId: string
      provider: string
      local: boolean
      label: string
      status: 'running' | 'ok' | 'error' | 'aborted'
      startedAt: number
      endedAt?: number
      stopReason?: string
      lastActivity: string
      logs: SubagentLogEntry[]
      expanded: boolean
    }
  | {
      kind: 'plan'
      active: boolean
      pending: boolean
      todos: PlanTodoItem[]
      planMarkdown?: string
      expanded: boolean
      /** When true the plan stays in the scrolling transcript, not the dock. */
      archived?: boolean
      /**
       * Display-only: the last turn ended while todos were still open.
       * Does not rewrite the session log.
       */
      turnLeftOpen?: boolean
    }
  | {
      kind: 'question'
      questionId: string
      title: string
      header?: string
      detail?: string
      intent: 'ask' | 'plan-review'
      status: 'waiting' | 'answered' | 'cancelled'
      summary: string
      expanded: boolean
    }
  | {
      kind: 'goal'
      objective: string
      phase: 'active' | 'paused' | 'blocked' | 'complete' | 'cleared'
      blockedReason?: string
      expanded: boolean
    }
  | {
      kind: 'compaction'
      compactionId: string
      status: 'running' | 'ok' | 'error'
      startedAt: number
      endedAt?: number
      pruneCount: number
      prunedTokens: number
      summary?: string
      error?: string
      expanded: boolean
    }
  | {
      kind: 'prompt'
      sources: string[]
      text: string
      plugin?: string
      expanded: boolean
    }
  | { kind: 'system'; text: string }
  | { kind: 'error'; text: string }

/** A reasoning/tool/subagent/plan row or the live streaming-reasoning block. */
export type CollapsibleBlock =
  | Extract<Row, { kind: 'reasoning' } | { kind: 'tool' } | { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' } | { kind: 'prompt' }>
  | { kind: 'streaming-reasoning'; expanded: boolean }

export type DisplayKind = Row['kind'] | 'tool-result' | 'diff-add' | 'diff-del' | 'diff-path' | 'todo-done' | 'todo-active' | 'todo-pending' | 'plan-dock'

/** One file's change, matching the web diff-card contract (`card: 'diff'`). */
export interface ToolDiffHunk {
  path: string
  oldText: string | null
  newText: string
}
