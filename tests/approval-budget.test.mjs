import test from 'node:test'
import assert from 'node:assert/strict'
import { setLocale } from '../lib/i18n/index.js'
import { SshTui } from '../lib/tui.js'
import {
  ReviewCollector,
  REVIEW_BUDGETS,
  REVIEW_DEADLINE_MS,
  REVIEW_FIRST_MAX_TOKENS,
  reviewOutcome,
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

function approvalTui(ctx) {
  const agent = fakeAgent()
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false })
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

test('only an explicit max-tokens truncation earns the single retry', () => {
  const future = Date.now() + 10_000
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'max-tokens' } }), 1, future), true)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'max-tokens' } }), 2, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'stop' } }), 1, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'error', failure: { message: 'x' } } }), 1, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'aborted', failure: { message: 'x' } } }), 1, future), false)
  assert.equal(shouldRetryReview(attempt({ finish: { kind: 'max-tokens' } }), 1, Date.now() - 1), false)
})

test('the review budget is bounded: two calls sharing one 20 s deadline', () => {
  assert.deepEqual(REVIEW_BUDGETS, [2048, 8192])
  assert.equal(REVIEW_BUDGETS.length, 2)
  assert.equal(REVIEW_FIRST_MAX_TOKENS, 2048)
  assert.equal(REVIEW_DEADLINE_MS, 20_000)
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
  const { calls, ctx } = reviewCtx([new Error('bad key 401')])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-provider', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 1, 'a larger budget cannot fix a bad key or an unsupported option')
  assert.match(lastReviewRow(tui), /复核失败/)
  assert.match(lastReviewRow(tui), /bad key 401/)
})

test('an unparsed clean stop is not retried', async () => {
  const { calls, ctx } = reviewCtx([[text('not-json'), usage(), finish('stop')]])
  const { tui, agent } = approvalTui(ctx)
  const pending = tui.handleApproval(bashCall(tui, agent, 'c-unparsed', 'python deploy.py'),
    async () => { throw new Error('reviewer verdict must not call next()') })
  const outcome = await answer(tui, pending, 'n')
  assert.equal(outcome, 'rejected')
  assert.equal(calls.length, 1)
  assert.match(lastReviewRow(tui), /无可用结论/)
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
  assert.match(lastReviewRow(tui), /超时或被取消/)
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
