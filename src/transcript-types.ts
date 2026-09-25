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
  /** Parent tool-call id, so a later result can settle on the same log line. */
  callId?: string
  /** Result body kept beside the call line, when the caller has one. */
  detail?: string
}

/** One todo-list item as the plan card renders it. */
export interface PlanTodoItem {
  content: string
  /**
   * The tool's own schema sends the first three. `failed` and `skipped` are
   * accepted from models that mark an item that way anyway — silently showing
   * those as pending would misreport the work that is left.
   */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
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
      /** Live child id when this chip was first built from the parent spawn tool. */
      childSessionId?: string
      /** Parent spawn tool-call id, so the wrapper's result can find this child. */
      spawnCallId?: string
      /** Model route the child runs on. Never the subagent backend name (`spawn`). */
      modelProvider?: string
      runId: string
      provider: string
      local: boolean
      label: string
      /** Parent `subagent` tool description, when the spawn call named the job. */
      task?: string
      status: 'running' | 'ok' | 'error' | 'aborted'
      startedAt: number
      endedAt?: number
      stopReason?: string
      /** One-line failure explanation shown on the collapsed chip. */
      failHint?: string
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
      /**
       * Display-only: the one leftover-todo reminder for this open list has
       * been sent. The model's answer is itself a `todo_write`, so this must
       * survive that patch — otherwise every turn end asks again, and each ask
       * is another model turn. Reset when the list closes, so a list that opens
       * again gets its own single reminder.
       */
      nudged?: boolean
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
  | {
      /**
       * Files one turn changed, from the Host's `workspaceChanges` service.
       * Display only: the summary is not in the session log, and a restarted
       * Host cannot reopen it, so the card is never rebuilt from history.
       */
      kind: 'changes'
      /** The turn the summary describes. A later event for it replaces this card. */
      turn: number
      /** Sequence of the `workspace/changes` event the summary was read from. */
      seq: number
      /** Session the summary belongs to; `diff` is served per session. */
      sessionId: string
      /** Header text, rendered once so the card does not recompute it per frame. */
      header: string
      /** One line per listed file, in the service's own order. */
      files: string[]
      /** Files the service's cap left off the list, appended after `files`. */
      more?: string
      expanded: boolean
    }
  | { kind: 'system'; text: string }
  /** A diagnostic report (`/diag`, `/doctor`): long, copyable whole. */
  | { kind: 'diag'; text: string }
  | { kind: 'error'; text: string }

/** A reasoning/tool/subagent/plan row or the live streaming-reasoning block. */
export type CollapsibleBlock =
  | Extract<Row, { kind: 'reasoning' } | { kind: 'tool' } | { kind: 'subagent' } | { kind: 'plan' } | { kind: 'question' } | { kind: 'goal' } | { kind: 'compaction' } | { kind: 'prompt' } | { kind: 'changes' }>
  | { kind: 'streaming-reasoning'; expanded: boolean }

export type DisplayKind = Row['kind'] | 'tool-result' | 'diff-add' | 'diff-del' | 'diff-path' | 'todo-done' | 'todo-active' | 'todo-pending' | 'todo-failed' | 'todo-skipped' | 'plan-dock' | 'subagent-header'

/** One rendered diff/inspect body line with its display role. */
export interface DiffDisplayLine {
  kind: DisplayKind
  text: string
  /**
   * Ranges of `text` to emphasise, in UTF-16 offsets. They travel with the line
   * rather than being baked in as escapes because the painter sanitises the text
   * it styles — an escape inserted down here would be stripped, leaving a
   * literal `[7m` on screen.
   */
  spans?: readonly { start: number; end: number }[]
  /**
   * Parts of `text` that carry their own role, for a line that holds two at
   * once: the columns of a side-by-side diff are a removal on the left and an
   * addition on the right, and painting the row as either one would mislabel
   * half of it. Offsets are UTF-16 into `text`; anything not covered keeps the
   * line's own `kind`.
   */
  columns?: readonly DiffDisplayColumn[]
}

/** One part of a line, painted with its own display role. */
export interface DiffDisplayColumn {
  start: number
  end: number
  kind: DisplayKind
}

/** One file's change, matching the web diff-card contract (`card: 'diff'`). */
export interface ToolDiffHunk {
  path: string
  oldText: string | null
  newText: string
}
