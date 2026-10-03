/**
 * The durable half of an ask-user question, as the Session reports it.
 *
 * A question used to exist only as a live request: the dialog the answerer opened
 * and the row it pushed. Nothing rebuilt it from the log, so `--resume` showed the
 * `ask_user_question` *tool* card and nothing that said what was asked or answered —
 * the same session read differently depending on whether it was lived or replayed.
 *
 * The Session already records the truth: `tool/call` carries the questions and
 * `tool/result` (or a late `user-question-reply` message) carries the answers, and
 * `@deepseek-ai/dsh-user-questions` folds both into a projection every Client can
 * read (`ctx.sessionProjections.stateOf(session, 'userQuestions')`). This module
 * turns that view into the records the transcript paints, and it is deliberately
 * pure: the caller supplies the questions, because the projection's *settled* half
 * names only the call and the answers.
 *
 * Two limits are the Harness's, not this module's, and both are why the caller
 * keeps its live path as well:
 *
 * - the projection tracks only **timed** `ask_user_question` calls — a call made
 *   while the blocking legacy schema was in effect appears in neither half, so a
 *   session that only ever used it folds to an empty view;
 * - it needs the projection service to be registered at all, which a bare Context
 *   in a test (or an embedder without `dsh-session-projection`) does not provide.
 *
 * @module dsh-ssh-tui/question-state
 */
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
  PendingUserQuestion,
  SettledUserQuestion,
  UserQuestionProjectionView,
} from '@deepseek-ai/dsh-user-questions'
import { t } from './i18n/index.js'

/** One question as the transcript should show it, live or replayed. */
export interface DurableQuestionRecord {
  /** The `ask_user_question` call this question belongs to. */
  callId: string
  question: AskUserQuestionItem
  /**
   * `open` is a foreground wait nobody has answered yet; `continued` is one whose
   * window closed but which the Session still accepts an answer for; the other two
   * are terminal.
   */
  state: 'open' | 'continued' | 'answered' | 'cancelled'
  /** What the human chose; empty while the question is unanswered. */
  answers: readonly AskUserQuestionAnswerItem[]
}

/** The projection view, or the empty one when nothing is registered. */
export function questionViewOf(value: unknown): UserQuestionProjectionView | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const view = (value as { questions?: unknown }).questions
  if (typeof view !== 'object' || view === null) return undefined
  const active = (view as { active?: unknown }).active
  const settled = (view as { settled?: unknown }).settled
  if (!Array.isArray(active) || !Array.isArray(settled)) return undefined
  return { active: active as PendingUserQuestion[], settled: settled as SettledUserQuestion[] }
}

/** Whether the projection has anything to say about this session's questions. */
export function questionViewIsEmpty(view: UserQuestionProjectionView | undefined): boolean {
  return view === undefined || (view.active.length === 0 && view.settled.length === 0)
}

/**
 * Every question the Session log can still account for, in ask order then
 * settlement order.
 *
 * A settled call names only its answers, so a call whose questions this process
 * never saw (a resumed session whose `tool/call` predates the log window it read)
 * contributes nothing rather than a half-record: an answer with no question is not
 * something the transcript can draw.
 * @param view - the projection view, or undefined when nothing is registered.
 * @param questionsOf - the questions recorded for one call, when known.
 * @returns one record per question, newest last.
 */
export function durableQuestionRecords(
  view: UserQuestionProjectionView | undefined,
  questionsOf: (callId: string) => readonly AskUserQuestionItem[] | undefined,
): DurableQuestionRecord[] {
  if (view === undefined) return []
  const records: DurableQuestionRecord[] = []
  for (const pending of view.active) {
    for (const question of questionsOf(String(pending.callId)) ?? []) {
      records.push({
        callId: String(pending.callId),
        question,
        state: pending.state === 'continued' ? 'continued' : 'open',
        answers: [],
      })
    }
  }
  for (const settled of view.settled) {
    const callId = String(settled.callId)
    const answers = settled.answers ?? []
    for (const question of questionsOf(callId) ?? []) {
      const mine = answers.filter(answer => answer.id === question.id)
      records.push({
        callId,
        question,
        // An answer batch the projection recorded is an answer: the only way into
        // `settled` is a result carrying one, or a late reply that closed the call.
        state: mine.length === 0 ? 'cancelled' : 'answered',
        answers: mine,
      })
    }
  }
  return records
}

/**
 * How one answered question reads on its card.
 *
 * Mirrors what the live dialog writes when it settles a card, so a session that
 * was replayed shows the same sentence as one that was lived: the typed answer
 * when there was one, the chosen labels otherwise.
 * @param answers - the recorded answers for this question.
 * @returns the summary text.
 */
export function answerSummaryText(answers: readonly AskUserQuestionAnswerItem[]): string {
  const first = answers.find(answer => answer !== undefined)
  if (first === undefined) return t('question.cancelled')
  const custom = first.custom
  if (typeof custom === 'string' && custom.trim() !== '') return custom
  const selected = first.selected ?? []
  if (selected.length === 0) return t('question.answered')
  return selected.join(', ')
}
