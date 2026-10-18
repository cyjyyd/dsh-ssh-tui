import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import {
  consumeReviewStream,
  describeReviewError,
  nextReviewAction,
  ReviewCollector,
  REVIEW_BUDGETS,
  REVIEW_DEADLINE_MS,
  REVIEW_FIRST_MAX_TOKENS,
  reviewOutcome,
  reviewOutcomeAt,
  reviewStopReason,
  shouldRetryReview,
} from '../lib/approval-reviewer.js'
import { feedbackText } from './wait.mjs'

setLocale('zh')

const text = value => ({ type: 'text-delta', index: 0, text: value })
const reasoning = value => ({ type: 'reasoning-delta', index: 0, text: value })
const usage = (inputTokens = 64, outputTokens = 32) => ({ type: 'usage', usage: { inputTokens, outputTokens } })
const finish = (kind = 'stop') => ({ type: 'finish', reason: { kind } })
const approveJson = '{"risk":"low","authorization":"yes","decision":"approved","reason":"项目内构建"}'

const attempt = (overrides = {}) => ({
  text: '',
  sawReasoning: false,
  finish: { kind: 'stop' },
  ...overrides,
})

function fakeAgent() {
  return {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    steer() {},
    followup() {},
  }
}

/**
 * An LLM whose nth call plays `scripts[n]` (chunks) or throws it (an Error).
 * `calls` keeps the options, so a test can assert the budgets really sent —
 * not merely that the reviewer "tried again".
 */
function reviewCtx(scripts) {
  const calls = []
  return {
    calls,
    ctx: {
      get(name) {
        if (name !== 'llm') return undefined
        return {
          stream(options) {
            calls.push(options)
            const script = scripts[Math.min(calls.length - 1, scripts.length - 1)]
            if (script instanceof Error) throw script
            return (async function* replay() {
              for (const chunk of script) yield chunk
            })()
          },
        }
      },
      on() { return () => {} },
    },
  }
}

function approvalTui(ctx, config = {}) {
  const agent = fakeAgent()
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, ...config })
  tui.runCommand('/approval auto')
  return { tui, agent }
}

function bashCall(tui, agent, callId, command) {
  tui.handleSessionEvent(agent.session, {
    type: 'tool/call',
    data: { callId, name: 'bash', arguments: JSON.stringify({ command }) },
  })
  return { toolName: 'bash', callId, agent, reason: undefined }
}

async function answer(tui, pending, key) {
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(tui.dialog?.kind, 'confirm', 'a failed review must ask a human')
  tui.handleChar(key)
  return pending
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

const lastReviewRow = tui => String(
  tui.rows.findLast(row => row.kind === 'system' && String(row.text).includes('自动审批复核'))?.text ?? '',
)

test('the collector records finish and usage but never turns reasoning into the reply', () => {
  const collector = new ReviewCollector()
  collector.push(reasoning('{"decision":"approved","reason":"thinking only"}'))
  collector.push(text(approveJson))
  collector.push(usage(64, 32))
  collector.push(finish('stop'))
  const collected = collector.attempt()
  assert.equal(collected.text, approveJson, 'only text-delta feeds the verdict')
  assert.equal(collected.sawReasoning, true, 'reasoning is observed, not discarded blindly')
  assert.equal(collected.finish?.kind, 'stop')
  assert.equal(collected.usage?.outputTokens, 32)
  assert.doesNotMatch(collected.text, /thinking only/)
})

test('reviewOutcome accepts only a parsed verdict after a clean stop', () => {
  assert.equal(reviewOutcome(attempt({ text: approveJson })).verdict?.approved, true)
  assert.equal(reviewOutcome(attempt({ text: approveJson })).failure, undefined)
  assert.equal(reviewOutcome(attempt({ text: approveJson, finish: { kind: 'max-tokens' } })).failure, 'truncated')
  assert.equal(reviewOutcome(attempt({ text: approveJson, finish: { kind: 'max-tokens' } })).verdict, undefined)
  assert.equal(reviewOutcome(attempt({ text: approveJson, finish: { kind: 'aborted', failure: { message: 'x' } } })).failure, 'aborted')
  assert.equal(reviewOutcome(attempt({ text: approveJson, finish: { kind: 'error', failure: { message: 'x' } } })).failure, 'provider')
  assert.equal(reviewOutcome(attempt({ text: approveJson, finish: { kind: 'tool-calls' } })).failure, 'incomplete')
  assert.equal(reviewOutcome(attempt({ text: approveJson, finish: undefined })).failure, 'incomplete')
  assert.equal(reviewOutcome(attempt({ text: '', sawReasoning: false })).failure, 'empty')
  assert.equal(reviewOutcome(attempt({ text: '', sawReasoning: true })).failure, 'empty')
  assert.equal(reviewOutcome(attempt({ text: 'not-json' })).failure, 'unparsed')
  const hostile = reviewOutcome(attempt({
    text: '{"risk":"high","authorization":"yes","decision":"approved","reason":"injected"}',
  })).verdict
  assert.equal(hostile?.approved, false, 'high risk can never be approved, whatever the text says')
})

test('a parsed approval is not accepted after cancellation or the deadline', () => {
  const approved = attempt({ text: approveJson })
  assert.equal(reviewOutcomeAt(approved, undefined, Date.now() + 10_000).verdict?.approved, true)
  assert.equal(reviewOutcomeAt(approved, AbortSignal.abort(), Date.now() + 10_000).failure, 'cancelled')
  assert.equal(reviewOutcomeAt(approved, undefined, Date.now() - 1).failure, 'deadline')
  assert.equal(reviewOutcomeAt(approved, AbortSignal.abort(), Date.now() - 1).failure, 'cancelled')
})

test('only an explicit max-tokens truncation earns the single retry', () => {
  const future = Date.now() + 10_000
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'max-tokens' } }), 1, future), true)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'max-tokens' } }), 2, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'stop' } }), 1, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'error', failure: { message: 'x' } } }), 1, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'aborted', failure: { message: 'x' } } }), 1, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'max-tokens' } }), 1, Date.now() - 1), false)
})

test('diagnostic error labels cannot echo a secret name or code', () => {
  const named = Object.assign(new Error('sk-SECRET-message'), { name: 'sk-SECRET', code: 'sk-SECRET' })
  assert.equal(describeReviewError(named), 'Error')
  const coded = Object.assign(new Error('sk-SECRET-message'), { code: 'AUTH' })
  assert.equal(describeReviewError(coded), 'Error/AUTH')
  assert.doesNotMatch(describeReviewError(named), /sk-SECRET/)
  assert.doesNotMatch(describeReviewError(coded), /sk-SECRET/)
})

test('the review budget is bounded: two calls sharing one 20 s deadline', () => {
  assert.deepEqual(REVIEW_BUDGETS, [2048, 8192])
  assert.equal(REVIEW_BUDGETS.length, 2)
  assert.equal(REVIEW_FIRST_MAX_TOKENS, 2048)
  assert.equal(REVIEW_DEADLINE_MS, 20_000)
})

test('an abort during the stream discards a late approved stop and caches nothing', async () => {
  const controller = new AbortController()
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = []
  let step = 0
  const iterator = {
    async next() {
      step += 1
      if (step === 1) {
        started()
        await gate
        return { done: false, value: text(approveJson) }
      }
      if (step === 2) return { done: false, value: usage() }
      if (step === 3) return { done: false, value: finish('stop') }
      return { done: true, value: undefined }
    },
    // Deliberately ignores the consumer's close request: this is the adapter
    // that keeps producing after the abort.
    async return() { return { done: true, value: undefined } },
  }
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        stream(options) {
          calls.push(options)
          return { [Symbol.asyncIterator]: () => iterator }
        },
      }
    },
    on() { return () => {} },
  }
  const { tui, agent } = approvalTui(ctx)
  const request = bashCall(tui, agent, 'c-midflight', 'python deploy.py')
  request.signal = controller.signal
  const pending = tui.handleApproval(request,
    async () => { throw new Error('a cancelled review must not call next()') })
  await startedPromise
  controller.abort()
  release()
  const outcome = await pending
  assert.equal(outcome, 'cancelled', 'a late approved stop cannot beat the abort')
  assert.equal(calls.length, 1, 'cancellation never starts a second call')
  assert.equal(step, 1, 'the consumer never asks the stalled iterator for another chunk')
  assert.equal(tui.dialog, undefined)
  tui.runCommand('/approval cache')
  assert.match(feedbackText(tui), /0 条/, 'a cancelled verdict is never cached')
  assert.doesNotMatch(JSON.stringify(tui.rows), /自动审批复核 通过/)
})

test('reviewStopReason lets cancellation and the deadline outrank a retry', () => {
  const truncated = attempt({ finish: { kind: 'max-tokens' } })
  const deadline = Date.now()
  assert.equal(reviewStopReason(AbortSignal.abort(), deadline), 'cancelled')
  assert.equal(reviewStopReason(undefined, deadline - 1), 'deadline')
  assert.equal(reviewStopReason(undefined, Date.now() + 10_000), undefined)
  assert.equal(nextReviewAction(truncated, 1, deadline + 10_000, undefined, () => deadline), 'retry')
  assert.equal(nextReviewAction(truncated, 1, deadline, undefined, () => deadline), 'deadline')
  assert.equal(nextReviewAction(truncated, 1, deadline + 10_000, AbortSignal.abort(), () => deadline), 'cancelled')
  assert.equal(nextReviewAction(truncated, 2, deadline + 10_000, undefined, () => deadline), 'stop')
})

test('a stream that never settles is stopped by the deadline and closed once', async () => {
  let closed = 0
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise(() => {}),
        return: async () => { closed += 1; return { done: true, value: undefined } },
      }
    },
  }
  const started = Date.now()
  const result = await consumeReviewStream(stream, { deadlineAt: Date.now() + 30 })
  assert.equal(result.failure, 'deadline')
  assert.ok(Date.now() - started < 1_000, 'a non-cooperative stream cannot hold the review open')
  assert.equal(closed, 1, 'the consumer asks the iterator to close exactly once')
})

test('a stop completed after the deadline is marked deadline, not accepted', async () => {
  let clock = 0
  let step = 0
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          step += 1
          if (step === 1) return { done: false, value: text(approveJson) }
          if (step === 2) return { done: false, value: finish('stop') }
          clock = 500
          return { done: true, value: undefined }
        },
        return: async () => ({ done: true, value: undefined }),
      }
    },
  }
  const result = await consumeReviewStream(stream, { deadlineAt: 100, now: () => clock })
  assert.equal(result.failure, 'deadline')
  assert.equal(result.attempt.text, approveJson, 'the late text was collected, but not accepted')
})

test('a stop completed after cancellation is marked cancelled, not accepted', async () => {
  const controller = new AbortController()
  let step = 0
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          step += 1
          if (step === 1) return { done: false, value: text(approveJson) }
          controller.abort()
          return { done: true, value: undefined }
        },
        return: async () => ({ done: true, value: undefined }),
      }
    },
  }
  const result = await consumeReviewStream(stream, {
    signal: controller.signal,
    deadlineAt: Date.now() + 10_000,
  })
  assert.equal(result.failure, 'cancelled')
})

test('a stream that ignores abort cannot hold the approval past the deadline', async () => {
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined
      return {
        stream() {
          return (async function* ignoresEverything() {
            started()
            await new Promise(() => {})
          })()
        },
      }
    },
    on() { return () => {} },
  }
  const { tui, agent } = approvalTui(ctx, { reviewDeadlineMs: 20 })
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-hanging', 'python deploy.py'),
    async () => { throw new Error('a timed-out review must not call next()') })
  await startedPromise
  await delay(100)
  assert.equal(tui.dialog?.kind, 'confirm', 'the approval returns to the human without waiting for the adapter')
  const card = lastReviewRow(tui)
  assert.match(card, /截止时间/)
  assert.match(card, /20 ms/)
  assert.match(card, /deepseek-official/)
  tui.handleChar('n')
  assert.equal(await pending, 'rejected')
  tui.runCommand('/approval cache')
  assert.match(feedbackText(tui), /0 条/)
})

test('a late approved stop after the deadline is never accepted or cached', async () => {
  let started
  const startedPromise = new Promise(resolve => { started = resolve })
  let release
  const gate = new Promise(resolve => { release = resolve })
  let step = 0
  const iterator = {
    async next() {
      step += 1
      if (step === 1) {
        started()
        await gate
        return { done: false, value: text(approveJson) }
      }
      if (step === 2) return { done: false, value: usage() }
      if (step === 3) return { done: false, value: finish('stop') }
      return { done: true, value: undefined }
    },
    async return() { return { done: true, value: undefined } },
  }
  const ctx = {
    get(name) {
      if (name !== 'llm') return undefined
      return { stream() { return { [Symbol.asyncIterator]: () => iterator } } }
    },
    on() { return () => {} },
  }
  const { tui, agent } = approvalTui(ctx, { reviewDeadlineMs: 20 })
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-late', 'python deploy.py'),
    async () => { throw new Error('a timed-out review must not call next()') })
  await startedPromise
  await delay(80)
  assert.equal(tui.dialog?.kind, 'confirm')
  release()
  await delay(50)
  assert.equal(step, 1, 'the consumer never resumes a stream it already stopped waiting for')
  assert.equal(tui.dialog?.kind, 'confirm', 'the late stop did not close the question')
  tui.handleChar('n')
  assert.equal(await pending, 'rejected')
  assert.doesNotMatch(JSON.stringify(tui.rows), /自动审批复核 通过/)
  tui.runCommand('/approval cache')
  assert.match(feedbackText(tui), /0 条/)
})

test('rule allow and deny decisions never ask the model', async () => {
  const { calls, ctx } = reviewCtx([[text(approveJson), usage(), finish('stop')]])
  const { tui, agent } = approvalTui(ctx)
  const next = async () => { throw new Error('rule decisions must not call next()') }
  assert.equal(await tui.handleApproval(bashCall(tui, agent, 'c-rule-allow', 'git status'), next), 'allowed-once')
  assert.equal(await tui.handleApproval(bashCall(tui, agent, 'c-rule-deny', 'rm -rf /tmp/x'), next), 'rejected')
  assert.equal(calls.length, 0, 'only the unknown shape reaches the reviewer')
  tui.runCommand('/approval status')
  assert.match(feedbackText(tui), /AI 复核 0 次/)
})

test('a truncated first answer is retried once with the larger budget and can then approve', async () => {
  const { calls, ctx } = reviewCtx([
    [text(approveJson), usage(), finish('max-tokens')],
    [reasoning('SECRET-CHAIN-OF-THOUGHT'), text(approveJson), usage(), finish('stop')],
  ])
  const { tui, agent } = approvalTui(ctx)
  const outcome = await tui.handleApproval(
    bashCall(tui, agent, 'c-retry-allow', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') },
  )
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(calls.map(call => call.maxTokens), [2048, 8192])
  assert.equal(calls[0].reasoningEffort, 'off', 'cheap request stays the default; safety rests on finish/budget')
  assert.match(feedbackText(tui), /提高预算重试一次/)
  assert.doesNotMatch(JSON.stringify(tui.rows), /SECRET-CHAIN-OF-THOUGHT/, 'reasoning never reaches a row')
  tui.runCommand('/approval status')
  const status = feedbackText(tui)
  assert.match(status, /AI 复核 1 次/)
  assert.match(status, /模型调用 2 次/)
})

test('two truncated answers stop at two calls, ask the human, and cache nothing', async () => {
  const { calls, ctx } = reviewCtx([
    [text(approveJson), usage(), finish('max-tokens')],
    [text(approveJson), usage(), finish('max-tokens')],
  ])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-retry-deny', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 2)
  assert.deepEqual(calls.map(call => call.maxTokens), [2048, 8192])
  const card = lastReviewRow(tui)
  assert.match(card, /输出预算耗尽/)
  assert.match(card, /8192 tokens/)
  assert.match(card, /max-tokens/)
  assert.match(card, /2 次调用/)
  tui.runCommand('/approval cache')
  assert.match(feedbackText(tui), /0 条/, 'a truncated verdict is never cached')
})

test('a provider error is not retried and falls back to the human', async () => {
  const { calls, ctx } = reviewCtx([new Error('bad key sk-SECRET-401')])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-provider', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 1, 'a larger budget cannot fix a bad key or an unsupported option')
  assert.match(lastReviewRow(tui), /复核失败/)
  assert.match(lastReviewRow(tui), /Error/, 'the category is useful')
  assert.match(lastReviewRow(tui), /deepseek-official/, 'the route is finite, useful metadata')
  assert.match(lastReviewRow(tui), /1 次调用/)
  assert.doesNotMatch(lastReviewRow(tui), /bad key sk-SECRET-401/, 'the raw provider message may contain a key')
  assert.doesNotMatch(JSON.stringify(tui.rows), /sk-SECRET-401/)
})

test('an unparsed clean stop is not retried and never echoes the model output', async () => {
  const secret = 'MODEL-OUTPUT-SECRET-7f3c'
  const { calls, ctx } = reviewCtx([[text(`${secret} not-json`), usage(), finish('stop')]])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-unparsed', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 1)
  assert.match(lastReviewRow(tui), /无可用结论/)
  assert.match(lastReviewRow(tui), /字符/)
  assert.doesNotMatch(lastReviewRow(tui), /MODEL-OUTPUT-SECRET/)
  assert.doesNotMatch(JSON.stringify(tui.rows), /MODEL-OUTPUT-SECRET/)
})

test('a reasoning-only truncated attempt retries, then a clean stop approves', async () => {
  const { calls, ctx } = reviewCtx([
    [reasoning('thinking consumed the whole first budget'), finish('max-tokens')],
    [text(approveJson), usage(), finish('stop')],
  ])
  const { tui, agent } = approvalTui(ctx)
  const outcome = await tui.handleApproval(bashCall(tui, agent, 'c-reasoning-budget', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  assert.equal(outcome, 'allowed-once')
  assert.deepEqual(calls.map(call => call.maxTokens), [2048, 8192])
  assert.doesNotMatch(JSON.stringify(tui.rows), /thinking consumed the whole first budget/)
})

test('an unknown finish kind is reported as other, never echoed', async () => {
  const secret = 'finish-SECRET-91ab'
  const { ctx } = reviewCtx([[text('{}'), usage(), { type: 'finish', reason: { kind: secret } }]])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-finish-kind', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.match(lastReviewRow(tui), /other/)
  assert.doesNotMatch(lastReviewRow(tui), /finish-SECRET/)
  assert.doesNotMatch(JSON.stringify(tui.rows), /finish-SECRET/)
})

test('a provider error finish is not retried and asks the human', async () => {
  const { calls, ctx } = reviewCtx([
    [text(''), { type: 'finish', reason: { kind: 'error', failure: { message: 'upstream 503' } } }],
  ])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-error-finish', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 1, 'a provider error is not a budget problem')
  assert.match(lastReviewRow(tui), /未正常结束/)
  assert.match(lastReviewRow(tui), /finish error/)
})

test('an already-cancelled request makes no model call and yields cancelled', async () => {
  const { calls, ctx } = reviewCtx([[text(approveJson), usage(), finish('stop')]])
  const { tui, agent } = approvalTui(ctx)
  const request = bashCall(tui, agent, 'c-cancelled', 'python deploy.py')
  request.signal = AbortSignal.abort()
  const outcome = await tui.handleApproval(request,
    async () => { throw new Error('reviewer verdict must not call next()') })
  assert.equal(outcome, 'cancelled', 'the card says cancelled; it never guesses a verdict')
  assert.equal(tui.dialog, undefined)
  assert.equal(calls.length, 0, 'a cancelled approval spends no tokens')
  assert.match(lastReviewRow(tui), /已取消/)
})

test('detached, an exhausted review denies without a human and without a cached verdict', async () => {
  const { calls, ctx } = reviewCtx([
    [text(approveJson), usage(), finish('max-tokens')],
    [text(approveJson), usage(), finish('max-tokens')],
  ])
  const { tui, agent } = approvalTui(ctx)
  tui.displayDetached = true
  const outcome = await tui.handleApproval(bashCall(tui, agent, 'c-detached', 'python deploy.py'),
    async () => { throw new Error('detached auto mode must not call next()') })
  assert.equal(outcome, 'rejected')
  assert.equal(tui.dialog, undefined, 'no question is left waiting with nobody attached')
  assert.equal(calls.length, 2)
  assert.match(lastReviewRow(tui), /输出预算耗尽/)
  tui.runCommand('/approval status')
  assert.match(feedbackText(tui), /自动拒绝 1 次/)
  tui.runCommand('/approval cache')
  assert.match(feedbackText(tui), /0 条/)
})
