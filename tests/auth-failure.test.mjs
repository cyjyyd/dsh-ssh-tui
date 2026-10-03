import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { classifyAuthFailure, isReasoningReplayFailure, isRequestRejectedFailure, statusOf } from '../lib/auth-failure.js'
import { SshTui } from '../lib/tui.js'

setLocale('zh')

/**
 * `code: "AUTH"` covers two opposite situations.
 *
 * A provider that rejects the request (the local key is fine) and a machine with
 * no key at all both arrive as AUTH, and the host retries neither. On 2026-09-29
 * a provider-side 403 killed two turns 45 seconds apart on a route that answered
 * 200 with the same key straight afterwards, so the plugin now says which one it
 * was and can retry the first kind once — the second kind is a configuration
 * problem that retrying cannot fix.
 */

/** The exact bodies seen in that session, kept verbatim as the fixtures. */
const PROVIDER_403 = 'OpenAI API error (403): {"message":"Authentication failed. Please check your credentials.","type":"permission_error"}'
const PROVIDER_PLAN = 'OpenAI API error (403): {"type":"error","error":{"type":"permission_error","message":"MODEL_NOT_IN_PLAN: Claude Haiku 4.5 available in Pro and above plans"}}'
const PROVIDER_401 = 'OpenAI API error (401): {"error":{"message":"Invalid API key provided","type":"invalid_request_error"}}'
const LOCAL_MISSING = 'dsh-llm: no API key for provider "command-code" (set COMMAND_CODE_API_KEY)'

test('the two auth shapes are told apart by their bodies', () => {
  const provider = classifyAuthFailure(PROVIDER_403)
  assert.deepEqual(provider, { origin: 'provider', status: 403 })
  assert.equal(classifyAuthFailure(PROVIDER_PLAN)?.origin, 'provider')
  assert.equal(classifyAuthFailure(PROVIDER_401)?.origin, 'provider')
  assert.equal(classifyAuthFailure(LOCAL_MISSING)?.origin, 'local')
  // A local message wins even when it quotes a provider-ish word like "key".
  assert.equal(classifyAuthFailure('no API key configured; provider said invalid API key')?.origin, 'local')
})

test('a failure that is not about authentication gets no advice', () => {
  for (const message of ['Request failed: socket hang up', 'context length exceeded', '', '   ']) {
    assert.equal(classifyAuthFailure(message), undefined, JSON.stringify(message))
  }
  // A 500 is not an auth failure: the hint would send the reader to the wrong fix.
  assert.equal(classifyAuthFailure('OpenAI API error (500): internal error'), undefined)
})

test('the status reader knows both host shapes', () => {
  assert.equal(statusOf('OpenAI API error (403): {}'), 403)
  assert.equal(statusOf('HTTP 429 Too Many Requests'), 429)
  assert.equal(statusOf('no status here'), undefined)
})

/** The verbatim body from the long session that hit this five times. */
const REASONING_REPLAY_400 = 'OpenAI API error (400): {"message":"{\"type\":\"invalid_request_error\",\"code\":\"invalid_request_error\",\"message\":\"The `reasoning_text` in the thinking mode must be passed back to the API. (request_id: 38ff3639)\n","type":"invalid_request_error"}'

test('the reasoning-replay 400 is recognised, and only it', () => {
  assert.equal(isReasoningReplayFailure(REASONING_REPLAY_400), true)
  assert.equal(isReasoningReplayFailure('The `content[].thinking` in the thinking mode must be passed back'), true)
  // The other 400 family (the `summary` field) is a different fix.
  assert.equal(isReasoningReplayFailure('OpenAI API error (400): {"message":"json: unknown field \"summary\""}'), false)
  assert.equal(isReasoningReplayFailure(''), false)
  assert.equal(isReasoningReplayFailure('socket hang up'), false)
})

test('that 400 gets its own advice rather than the auth hint', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  process.env.DSH_TUI_RETRY_PROVIDER_AUTH = 'on'
  try {
    const { tui, agent, calls } = makeTui({ credentials: configuredCredentials })
    send(tui, agent, 'turn/start', { turn: 45 })
    tui.lastUserText = 'carry on'
    send(tui, agent, 'turn/end', { turn: 45, reason: { kind: 'error', error: { message: REASONING_REPLAY_400, code: 'INVALID_REQUEST' } } })
    await flush()
    const said = rows(tui).join('\n')
    assert.match(said, /上游/u, 'it says the defect is upstream')
    assert.match(said, /1780|#231/u, 'and points at the reports')
    assert.match(said, /effort off|command-code-messages/u, 'and gives the workarounds')
    assert.equal(/提供商拒绝了请求|没有可用的/u.test(said), false, 'not the auth advice')
    assert.equal(calls.length, 0, 'and never an automatic retry — this 400 is deterministic')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

function makeTui({ credentials } = {}) {
  const services = credentials === undefined ? {} : { credentials }
  const ctx = { get: name => services[name], on() { return () => {} } }
  const calls = []
  const agent = {
    id: 'main-session',
    options: {},
    status: 'idle',
    session: { id: 'main-session', events: [] },
    cancel() {},
    followup(message) { calls.push(message) },
    steer(message) { calls.push(message) },
  }
  const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: false, headlessDisplay: true })
  tui.write = () => {}
  return { tui, agent, calls }
}

const send = (tui, agent, type, data) => tui.handleSessionEvent(agent.session, { type, time: Date.now(), data })
const rows = tui => tui.rows.filter(row => row.kind === 'system').map(row => String(row.text))
const flush = () => new Promise(resolve => setImmediate(resolve))

/** A configured credential: the probe the hint uses to tell the two apart. */
const configuredCredentials = { resolve: async () => ({ value: 'x'.repeat(20) }), describe: async () => ({ configured: true }) }

test('a provider rejection says so, and names the credential it checked', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  try {
    const { tui, agent, calls } = makeTui({ credentials: configuredCredentials })
    send(tui, agent, 'turn/start', { turn: 1 })
    tui.lastUserText = 'do the thing'
    send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: PROVIDER_403, code: 'AUTH' } } })
    await flush()
    const said = rows(tui).join('\n')
    assert.match(said, /提供商/u, 'the hint points at the provider')
    assert.match(said, /HTTP 403/u, 'and quotes the status')
    assert.match(said, /COMMAND_CODE_API_KEY|DEEPSEEK_API_KEY/u, 'and names the credential it checked')
    // Off by default: the hint must not spend a second request on its own.
    assert.equal(calls.length, 0, 'no automatic retry unless the reader asked for one')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

test('a missing credential is not blamed on the provider', async () => {
  const { tui, agent } = makeTui()
  send(tui, agent, 'turn/start', { turn: 1 })
  tui.lastUserText = 'do the thing'
  send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: PROVIDER_403, code: 'AUTH' } } })
  await flush()
  assert.match(rows(tui).join('\n'), /没有可用的/u)
  assert.equal(rows(tui).some(text => /提供商拒绝了/u.test(text)), false, 'no provider blame without a credential')
})

test('the opt-in retry resends the same message exactly once', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  process.env.DSH_TUI_RETRY_PROVIDER_AUTH = 'on'
  try {
    const { tui, agent, calls } = makeTui({ credentials: configuredCredentials })
    send(tui, agent, 'turn/start', { turn: 1 })
    tui.lastUserText = 'do the thing'
    send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: PROVIDER_403, code: 'AUTH' } } })
    await flush()
    assert.equal(calls.length, 1, 'exactly one retry')
    assert.equal(calls[0].content[0].text, 'do the thing', 'and it is the same prompt')
    assert.match(rows(tui).join('\n'), /重试一次/u)
    // The retry starts its own turn; a second failure inside it must not fire
    // another attempt, or a broken upstream becomes an infinite loop.
    send(tui, agent, 'turn/start', { turn: 2 })
    send(tui, agent, 'turn/end', { turn: 2, reason: { kind: 'error', error: { message: PROVIDER_403, code: 'AUTH' } } })
    await flush()
    assert.equal(calls.length, 1, 'still one retry')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

test('an unrelated failure is never retried', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  process.env.DSH_TUI_RETRY_PROVIDER_AUTH = 'on'
  try {
    const { tui, agent, calls } = makeTui({ credentials: configuredCredentials })
    send(tui, agent, 'turn/start', { turn: 1 })
    tui.lastUserText = 'do the thing'
    send(tui, agent, 'turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'socket hang up', code: 'NETWORK' } } })
    await flush()
    assert.equal(calls.length, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

test('a replayed failure gets the row but no advice or retry', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  process.env.DSH_TUI_RETRY_PROVIDER_AUTH = 'on'
  try {
    const { tui, calls } = makeTui({ credentials: configuredCredentials })
    tui.replaying = true
    tui.lastUserText = 'do the thing'
    tui.handleSessionEvent(
      { id: 'main-session', events: [] },
      { type: 'turn/end', time: Date.now(), data: { turn: 1, reason: { kind: 'error', error: { message: PROVIDER_403, code: 'AUTH' } } } },
    )
    await flush()
    assert.equal(rows(tui).some(text => /提供商/u.test(text)), false, 'no hint while replaying history')
    assert.equal(calls.length, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

test('/retryauth reports and flips the setting', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  try {
    const { tui } = makeTui()
    tui.runCommand('/retryauth')
    assert.match(rows(tui).at(-1) ?? '', /关/u, 'default is off')
    assert.match((rows(tui).at(-1) ?? '').length > 0 ? rows(tui).at(-1) : '', /自动重试/u)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})

// ── the bare sibling: a 400 the gateway refuses to explain ──────────────────
//
// Measured in one long session (2026-10-03, command-code, effort max): 13 of 14
// failed turns were HTTP 400, 12 of them this bare envelope, arriving in runs (eight
// consecutive turns over twelve minutes) and then clearing up on the same route. The
// harness retried none of them (14 attempts, 0 retries) — a 400 is outside its
// retryable set. The plugin says what it knows and does not spend a context guessing.

const BARE_400 = 'command-code API error (400): {"message":"{\\"type\\":\\"invalid_request_error\\",\\"code\\":\\"\\",\\"message\\":\\"invalid request error trace_id: 3ad7a3cd26a46e9d53b4b7e717b894b0\\"}\\n","type":"invalid_request_error"}'

test('the bare 400 is recognised, and a diagnosable 400 is not', () => {
  assert.equal(isRequestRejectedFailure(BARE_400), true)
  // The named sibling keeps its own branch: this predicate must not swallow it.
  assert.equal(isRequestRejectedFailure(REASONING_REPLAY_400), false)
  // A 400 that names what is wrong is a different fix, so it is not this case.
  assert.equal(isRequestRejectedFailure('OpenAI API error (400): {"message":"json: unknown field \\"summary\\""}'), false)
  // Other statuses and other shapes are not this either.
  assert.equal(isRequestRejectedFailure('OpenAI API error (403): permission_error'), false)
  assert.equal(isRequestRejectedFailure('command-code API error (400): upstream connect error'), false)
  assert.equal(isRequestRejectedFailure(''), false)
})

test('the bare 400 gets its own advice, and still no automatic retry', async () => {
  const previous = process.env.DSH_TUI_RETRY_PROVIDER_AUTH
  process.env.DSH_TUI_RETRY_PROVIDER_AUTH = 'on'
  try {
    const { tui, agent, calls } = makeTui({ credentials: configuredCredentials })
    send(tui, agent, 'turn/start', { turn: 18 })
    tui.lastUserText = 'carry on'
    send(tui, agent, 'turn/end', { turn: 18, reason: { kind: 'error', error: { message: BARE_400, code: 'INVALID_REQUEST' } } })
    await flush()
    const said = rows(tui).join('\n')
    assert.match(said, /请求本身/u, 'it says the request was refused')
    assert.match(said, /不是本机缺凭据/u, 'and that it is not a credential problem')
    assert.match(said, /1780|#231/u, 'it names the known family')
    assert.match(said, /effort off|command-code-messages/u, 'and gives the workarounds')
    assert.equal(/提供商拒绝了请求|没有可用的/u.test(said), false, 'not the auth advice')
    assert.equal(calls.length, 0, 'and no automatic retry, even with /retryauth on')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_RETRY_PROVIDER_AUTH
    else process.env.DSH_TUI_RETRY_PROVIDER_AUTH = previous
  }
})
