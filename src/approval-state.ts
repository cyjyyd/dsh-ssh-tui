/**
 * What a tool card may say about the approval that guarded it.
 *
 * Approval is a *state of the tool call*, not an event with a history of its own
 * (B2.4): a tool that needed a decision says so on its own card, and nothing else
 * in the transcript claims to be that decision.
 *
 * The hard half is not the state, it is the *evidence*. Two facts are durable and
 * both belong to the Harness, not to this plugin:
 *
 *   `approval/asked`   — `{ id, toolName, callId?, reason? }`
 *   `approval/decided` — `{ id, outcome }`, `outcome ∈ allowed-once|rejected|cancelled|unavailable`
 *
 * Everything else is weaker, and the difference is carried in {@link
 * ApprovalProvenance} rather than smoothed over: reading the log after a resume
 * answers with `durable`, a live decision answers with `live` (a human) or
 * `policy` (a rule, a cached verdict, a reviewer), and a log that predates the
 * audit pair can only be read by `inferred`. The rule this module exists to hold:
 * **a weaker source may never claim more than it proves** — in particular nothing
 * here can ever produce `approved` from an inference, and an ask with no recorded
 * decision is `unknown`, never `approved`.
 *
 * This module is pure (no session, no TUI) so both the live path and a replay go
 * through the same mapping, and so the mapping is testable without a TUI.
 *
 * @module dsh-ssh-tui/approval-state
 */
import { t } from './i18n/index.js'

/** The four states a tool card may show for the approval that guarded it. */
export type ApprovalState = 'waiting' | 'approved' | 'rejected' | 'unknown'

/** How well the state is known. Ordered from strongest to weakest. */
export type ApprovalProvenance = 'live' | 'policy' | 'durable' | 'inferred'

/** The approval field of one tool row. Display-only: never persisted by us. */
export interface ToolApproval {
  state: ApprovalState
  provenance: ApprovalProvenance
  /** True when a rule/reviewer decided it rather than a person (`policy`). */
  auto?: boolean
  /** Why — the classifier's or the reviewer's reason, when one was given. */
  reason?: string
}

/** Strongest first: a weaker source never overwrites a stronger one. */
const PROVENANCE_ORDER: Record<ApprovalProvenance, number> = {
  live: 3,
  policy: 3,
  durable: 2,
  inferred: 1,
}

/**
 * One approval fact onto a card's current field.
 *
 * `next` wins on state when it is at least as strong as what is already there. A
 * live decision is not overwritten by the durable event of the *same* decision
 * (which arrives right behind it on the live path and says strictly less), and an
 * inference never replaces anything but an inference.
 * @param current - the field as it stands, if any.
 * @param next - the fact being applied.
 * @returns the field the card should carry.
 */
export function mergeApproval(current: ToolApproval | undefined, next: ToolApproval): ToolApproval {
  if (current === undefined) return next
  const strength = PROVENANCE_ORDER[next.provenance]
  const existing = PROVENANCE_ORDER[current.provenance]
  if (strength < existing) {
    // Keep the stronger state, but a reason is still worth having.
    return current.reason !== undefined || next.reason === undefined
      ? current
      : { ...current, reason: next.reason }
  }
  if (strength === existing && current.state === next.state) {
    return current.auto === next.auto && current.reason === next.reason
      ? current
      : { ...current, ...next, provenance: current.provenance }
  }
  // Same strength, or a stronger fact: it wins, and it keeps the better label.
  return existing > strength ? current : { ...current, ...next }
}

/**
 * A recorded outcome as a card state.
 *
 * `cancelled` and `unavailable` are deliberately **unknown**, not `rejected`: the
 * reader's Esc, or a Host that had no approval channel, is not the human refusing
 * the tool, and printing a refusal they did not make is exactly the kind of
 * comfortable lie this field exists to prevent.
 * @param outcome - the `approval/decided` outcome, as recorded.
 * @returns the state the card shows.
 */
export function approvalStateFromOutcome(outcome: string): ApprovalState {
  if (outcome === 'allowed-once') return 'approved'
  if (outcome === 'rejected') return 'rejected'
  return 'unknown'
}

/**
 * Whether a tool result proves an approval was **refused** when no audit events
 * survived.
 *
 * Only the Harness's own refusal sentences count. A generic denial (`denied by
 * policy`, `blocked`) does *not* prove an approval was ever needed, and the whole
 * point of the `inferred` provenance is that it is used only where the text can
 * carry it: the phrase below is what `dsh-tools` writes when `approval.request()`
 * came back `rejected` or `cancelled`, so it cannot appear for a tool that was
 * refused by a rule instead.
 *
 * It can never produce `approved` — running successfully is not evidence that
 * anyone approved anything (a tool with no approval requirement runs too).
 * @param text - the tool result's text.
 * @returns `rejected` when the text is that refusal, undefined otherwise.
 */
export function inferredApprovalFromResult(text: string): ApprovalState | undefined {
  if (/the user rejected tool "[^"]*"/u.test(text)) return 'rejected'
  if (/approval for tool "[^"]*" was cancelled/u.test(text)) return 'unknown'
  return undefined
}

/** A one-word label for the card chip. */
export function approvalStateKey(state: ApprovalState): string {
  return `approval.badge.${state}`
}

/**
 * The provenance note shown beside the state.
 *
 * `live` and `durable` say nothing extra: a person's own decision and the log of
 * it are the same fact at two moments. `policy` and `inferred` do, because the
 * reader is being told something weaker and has to be able to tell.
 */
export function approvalProvenanceKey(approval: ToolApproval): string | undefined {
  if (approval.provenance === 'inferred') return 'approval.badge.inferred'
  if (approval.auto === true) return 'approval.badge.auto'
  return undefined
}

/**
 * The expanded card's own line for the approval.
 *
 * It names the state, the strength of the evidence, and the reason when one
 * survived: `live`/`durable` need no apology, `policy` is marked automatic, and
 * `inferred` says outright that the card is reading the log rather than quoting it.
 * @param approval - the card's approval field.
 * @returns the sentence, already translated.
 */
export function approvalDetailText(approval: ToolApproval): string {
  const state = t(approvalStateKey(approval.state))
  const provenance = t(`approval.badge.${approval.provenance}`)
  const reason = approval.reason === undefined || approval.reason === '' ? '' : ` · ${approval.reason}`
  return t(approval.auto === true ? 'approval.badge.detailAuto' : 'approval.badge.detail', { state, provenance, reason })
}

/** Whether two approval fields would render identically. */
export function sameApproval(left: ToolApproval | undefined, right: ToolApproval | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.state === right.state
    && left.provenance === right.provenance
    && left.auto === right.auto
    && left.reason === right.reason
}
