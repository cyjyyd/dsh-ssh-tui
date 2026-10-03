/**
 * The plan artifact, projected from durable session events (B2.5).
 *
 * A plan is an **artifact**, not a row: it has an identity that outlives the card
 * drawn for it, a revision history, and a state that comes from the session log
 * rather than from whatever the renderer last painted. Everything here is a pure
 * fold over events, so a replay produces exactly the artifacts a live session did —
 * the same ids, the same revisions, the same states. That is the whole point of the
 * module: the transcript, the dock and the review Surface read *this*, and none of
 * them keeps plan state of its own (AD-15).
 *
 * What is durable (measured; see `docs/plans/b2-5-plan-artifact-audit.md`):
 *
 *   `plan/mode { active }`              — plan mode entered / left (plan-mode service)
 *   `todo/write { todos }`              — a whole-list snapshot (the `todo_write` tool)
 *   `exit_plan_mode` `tool/call`        — `arguments.plan` is the plan body; the call is
 *                                         the review's identity
 *   `exit_plan_mode` `tool/result`      — success = approved; the harness's own refusal
 *                                         sentences = rejected / dismissed
 *   `command/run` + `command/done`      — a `/plan` switch that is queued for the next step
 *
 * What is **not** durable, and therefore is never claimed here:
 *
 *   - the plan-review *question*: `dsh-plan-mode` asks through
 *     `ctx.get('userQuestions').ask(...)`, which appends nothing. The tool call is the
 *     review's only durable trace — which is also enough to recognise it on replay,
 *     something B2.4 could not do from the question alone;
 *   - any plan name or id: derived below, deterministically, from event order;
 *   - "completed" and "abandoned": no event says either. They are folded from the last
 *     snapshot (every step completed) and from the mode switch, and they carry
 *     {@link PlanProvenance} `inferred` so a reader is never told them as fact.
 *
 * @module dsh-ssh-tui/plan-projection
 */
import type { PlanTodoItem } from './transcript-types.js'
import { parsePlanTodos } from './plan.js'

/** How the artifact's state is known. `durable` = an event says it; `inferred` = a reading. */
export type PlanProvenance = 'durable' | 'inferred'

/** What the artifact is doing. `unknown` is a real answer, not a placeholder. */
export type PlanState =
  | 'draft'
  | 'reviewing'
  | 'approved'
  | 'rejected'
  | 'executing'
  | 'completed'
  | 'abandoned'
  | 'unknown'

/** One whole-list snapshot, with the durable sequence that produced it. */
export interface PlanRevision {
  /** `plan@<openSeq>#<writeSeq>` — deterministic, and unique within a session. */
  id: string
  /** `seq` of the `todo/write` that produced this revision. */
  seq: number
  steps: PlanTodoItem[]
}

/** The review a plan was put through, and what came back. */
export interface PlanReview {
  /** The `exit_plan_mode` call id: the review's identity, durable and replay-stable. */
  id: string
  seq: number
  /** The plan body as it was reviewed (`arguments.plan`). */
  body: string
  /**
   * `pending` is a *live* state: a request is out and nobody has answered yet. A
   * replayed log that ends here says `unknown` instead — the Host that asked is gone,
   * and B2.4 set that precedent for approvals.
   */
  outcome: 'pending' | 'approved' | 'rejected' | 'dismissed' | 'unknown'
  /** The reader's own words, when they refused with feedback. */
  feedback?: string
}

/** One plan, folded from the events that describe it. */
export interface PlanArtifact {
  /** `plan@<seq of the opening event>` — session-local, replay-stable. */
  id: string
  /** What opened it: plan mode, or a standing todo list. */
  openedBy: 'plan-mode' | 'todos'
  openSeq: number
  state: PlanState
  provenance: PlanProvenance
  /** The plan body, when the session recorded one. */
  body?: string
  /** The latest revision's steps. */
  steps: PlanTodoItem[]
  revisions: PlanRevision[]
  review?: PlanReview
  /** Plan mode is on, as of the end of the fold. */
  active: boolean
  /** A `/plan` switch is queued for the next step (derived, not read from the Host). */
  pending: boolean
  /** `seq` of the event that closed the artifact, when one did. */
  closedSeq?: number
}

/** The slice of a session event this fold reads. */
export interface PlanEvent {
  type: string
  seq?: number
  /**
   * Whether this event arrived from the running Host (as opposed to a log read).
   *
   * Only a live `exit_plan_mode` can be `reviewing`: a resumed process never carries
   * on a review the Host that asked it did not finish, so a replayed unresolved call
   * is `unknown`. Recorded per event because one log holds both.
   */
  live?: boolean
  data?: {
    active?: unknown
    todos?: unknown
    name?: unknown
    args?: unknown
    commandId?: unknown
    kind?: unknown
    arguments?: unknown
    callId?: unknown
    message?: { source?: { callId?: unknown }; content?: unknown; isError?: unknown }
    error?: { code?: unknown; message?: unknown }
  }
}

const PLAN_TOOL = 'exit_plan_mode'

/**
 * The harness's own refusal sentences for a plan review.
 *
 * Matched exactly, because they are the *only* durable evidence that a review was
 * refused rather than never asked: `keep planning` (with or without feedback) and the
 * dismissal that happens when the reader speaks instead of answering.
 */
export function reviewRefusal(text: string): { outcome: 'rejected' | 'dismissed'; feedback?: string } | undefined {
  if (text.includes('dismissed the plan review')) return { outcome: 'dismissed' }
  if (!text.includes('chose to keep planning')) return undefined
  const match = /their feedback:\s*(.*)$/u.exec(text)
  const feedback = match?.[1]?.trim() ?? ''
  return { outcome: 'rejected', ...(feedback === '' ? {} : { feedback }) }
}

/** The plan markdown a call carried, when the arguments are readable. */
function planBodyOf(args: unknown): string | undefined {
  const parsed = typeof args === 'string' ? safeParse(args) : args
  if (parsed === undefined || typeof parsed !== 'object' || parsed === null) return undefined
  const plan = (parsed as { plan?: unknown }).plan
  return typeof plan === 'string' && plan.trim() !== '' ? plan : undefined
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** The text one tool result carries, joined. */
function resultText(data: PlanEvent['data']): string {
  const content = data?.message?.content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => (typeof block === 'object' && block !== null && typeof (block as { text?: unknown }).text === 'string'
      ? String((block as { text: string }).text)
      : ''))
    .join('')
}

/** Whether the result is an error, either way the harness can say it. */
function resultFailed(data: PlanEvent['data']): boolean {
  if (data?.error !== undefined) return true
  return data?.message?.isError === true
}

function allCompleted(steps: readonly PlanTodoItem[]): boolean {
  return steps.length > 0 && steps.every(step => step.status === 'completed')
}

/**
 * Fold the durable events of one session into its plan artifacts.
 *
 * Deterministic by construction: ids are derived from event `seq` alone, and every
 * decision reads only events that precede it. The same log (live or replayed) folds
 * to the same list, which is what lets one artifact feed the transcript, the dock and
 * the review Surface without any of them keeping state.
 *
 * @param events - the session's events, in order. Unknown types are ignored.
 * @param options - `live` marks a fold whose last events come from a running Host, so
 *   an unresolved review may be called `reviewing`; a replay leaves it `unknown`.
 * @returns every artifact the session accounts for, oldest first.
 */
export function foldPlanArtifacts(
  events: readonly PlanEvent[],
  options: { live?: boolean } = {},
): PlanArtifact[] {
  const artifacts: PlanArtifact[] = []
  let open: PlanArtifact | undefined
  let modeActive = false
  let pendingCommandId: string | undefined
  let pendingWanted: boolean | undefined

  // The current event's anchors: a real `seq` when the log has one, otherwise its
  // position in the log (a distinct namespace, so the two can never collide).
  let anchor = 0
  let anchorId = '0'

  const close = (state?: PlanState, provenance: PlanProvenance = 'inferred'): void => {
    if (open === undefined) return
    if (state !== undefined) {
      open.state = state
      open.provenance = provenance
    }
    // The anchor, not the raw `seq`: a log without sequence numbers still closes its
    // artifacts (an undefined `closedSeq` read as "still open" and kept a finished
    // plan in the dock).
    open.closedSeq = anchor
    open = undefined
  }

  const openArtifact = (openedBy: PlanArtifact['openedBy']): PlanArtifact => {
    const artifact: PlanArtifact = {
      id: `plan@${anchorId}`,
      openedBy,
      openSeq: anchor,
      state: 'draft',
      provenance: 'durable',
      steps: [],
      revisions: [],
      active: openedBy === 'plan-mode',
      pending: false,
    }
    artifacts.push(artifact)
    return artifact
  }

  for (const [index, event] of events.entries()) {
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    // Events without a `seq` (a harness that omits it, a hand-written fixture) still
    // need distinct, replay-stable anchors: the position in the log is exactly that,
    // as long as it never collides with a real sequence number — hence the separate
    // `#` namespace rather than a bare index.
    anchor = seq ?? index
    anchorId = seq === undefined ? `#${index}` : String(seq)
    const data = event.data
    switch (event.type) {
      case 'plan/mode': {
        const active = data?.active === true
        modeActive = active
        pendingCommandId = undefined
        pendingWanted = undefined
        if (active) {
          if (open === undefined) open = openArtifact('plan-mode')
          open.active = true
          open.pending = false
          open.state = open.state === 'draft' ? 'draft' : open.state
          open.provenance = 'durable'
        } else if (open !== undefined) {
          open.active = false
          open.pending = false
          // Leaving plan mode is not "completed" and not "abandoned" on its own: with
          // an approved review behind it the plan is being carried out, and with a
          // refusal behind it the reader kept planning. Only a plan nobody approved
          // and nobody finished is abandoned — and that reading says so.
          if (open.review?.outcome === 'approved') {
            open.state = allCompleted(open.steps) ? 'completed' : 'executing'
            open.provenance = allCompleted(open.steps) ? 'inferred' : 'durable'
          } else if (open.review?.outcome === 'rejected' || open.review?.outcome === 'dismissed') {
            open.state = 'rejected'
            open.provenance = 'durable'
            close()
          } else if (allCompleted(open.steps)) {
            open.state = 'completed'
            open.provenance = 'inferred'
            close('completed', 'inferred')
          } else {
            open.state = 'abandoned'
            open.provenance = 'inferred'
            close('abandoned', 'inferred')
          }
        }
        break
      }
      case 'command/run': {
        if (String(data?.name ?? '') !== 'plan') break
        if (data?.args === undefined) break
        pendingCommandId = String(data?.commandId ?? '')
        pendingWanted = String(data.args).trim() !== 'off'
        if (open !== undefined) {
          open.pending = pendingWanted !== modeActive
        }
        break
      }
      case 'command/done': {
        if (pendingCommandId === undefined || String(data?.commandId ?? '') !== pendingCommandId) break
        const succeeded = data?.kind === 'success'
        const wanted = pendingWanted
        pendingCommandId = undefined
        pendingWanted = undefined
        if (open !== undefined && wanted !== undefined) open.pending = succeeded && wanted !== modeActive
        break
      }
      case 'todo/write': {
        const steps = parsePlanTodos(data?.todos)
        if (steps.length === 0) break
        const artifact = open ?? openArtifact('todos')
        artifact.revisions.push({ id: `${artifact.id}#${anchorId}`, seq: anchor, steps })
        artifact.steps = steps
        if (allCompleted(steps) && !artifact.active) {
          // The list is done and plan mode is not holding it: the next write is a new
          // plan, so this artifact closes here. Re-opening it (which this did, by
          // assigning `open` unconditionally) merged every later list into the first
          // plan — the "two plans in one session" case the projection exists for.
          artifact.state = 'completed'
          artifact.provenance = 'inferred'
          close('completed', 'inferred')
        } else {
          if (artifact.state === 'draft') {
            artifact.state = artifact.active ? 'draft' : 'executing'
            artifact.provenance = artifact.active ? 'durable' : 'inferred'
          }
          if (allCompleted(steps)) {
            artifact.state = 'completed'
            artifact.provenance = 'inferred'
          }
          open = artifact
        }
        break
      }
      case 'tool/call': {
        if (String(data?.name ?? '') !== PLAN_TOOL) break
        const body = planBodyOf(data?.arguments)
        const callId = String(data?.callId ?? '')
        const artifact = open ?? openArtifact('todos')
        const review: PlanReview = {
          id: callId === '' ? `review@${anchorId}` : callId,
          seq: anchor,
          body: body ?? artifact.body ?? '',
          outcome: (event.live ?? options.live) === true ? 'pending' : 'unknown',
        }
        artifact.review = review
        if (body !== undefined) artifact.body = body
        artifact.state = (event.live ?? options.live) === true ? 'reviewing' : 'unknown'
        artifact.provenance = 'durable'
        open = artifact
        break
      }
      case 'tool/result': {
        const callId = String(data?.message?.source?.callId ?? '')
        const artifact = artifacts.findLast(candidate => candidate.review?.id === callId)
        if (artifact?.review === undefined) break
        if (resultFailed(data)) {
          const refusal = reviewRefusal(`${resultText(data)} ${String(data?.error?.message ?? '')}`)
          artifact.review.outcome = refusal?.outcome ?? 'unknown'
          if (refusal?.feedback !== undefined) artifact.review.feedback = refusal.feedback
          artifact.state = refusal === undefined ? 'unknown' : 'rejected'
          artifact.provenance = refusal === undefined ? 'inferred' : 'durable'
        } else {
          artifact.review.outcome = 'approved'
          artifact.state = allCompleted(artifact.steps) ? 'completed' : 'approved'
          artifact.provenance = 'durable'
        }
        break
      }
      default:
        break
    }
  }

  // The fold is over: whatever is still open is the artifact a reader is looking at.
  for (const artifact of artifacts) {
    if (artifact === open) continue
    artifact.active = false
  }
  if (open !== undefined) open.active = modeActive
  return artifacts
}

/** The artifact a workspace should dock: the newest one that is still live. */
export function livePlanArtifact(artifacts: readonly PlanArtifact[]): PlanArtifact | undefined {
  return artifacts.findLast(artifact => artifactIsLive(artifact))
}

/**
 * Whether the artifact still describes work in progress.
 *
 * The same question `planIsLive` asked of a row, asked of the projection instead:
 * plan mode on, a switch queued, a step not finished, or a review awaiting its
 * answer. Everything else is history, and history belongs in the transcript.
 */
export function artifactIsLive(artifact: PlanArtifact): boolean {
  if (artifact.closedSeq !== undefined) return false
  if (artifact.active || artifact.pending) return true
  if (artifact.review?.outcome === 'pending') return true
  return artifact.steps.some(step => step.status !== 'completed')
}

/** `3/7`-style progress over the latest revision. */
export function artifactProgress(artifact: PlanArtifact): { done: number; total: number; current?: PlanTodoItem } {
  const total = artifact.steps.length
  const done = artifact.steps.filter(step => step.status === 'completed').length
  const current = artifact.steps.find(step => step.status === 'in_progress')
  return current === undefined ? { done, total } : { done, total, current }
}
