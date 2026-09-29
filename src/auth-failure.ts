/**
 * Two failure classes that look alike in the transcript and need different fixes.
 *
 * 1. **Authentication** — `code: "AUTH"`, and the message says which side said
 *    no (below).
 * 2. **Reasoning replay** — a 400 from a thinking-mode gateway that wants the
 *    previous turn's reasoning passed back; the harness drops it when it rebuilds
 *    a long multi-turn history. Reported upstream (deepseek-harness #1780, #231),
 *    so the advice is a workaround, not a fix.
 *
 * Where an authentication failure came from.
 *
 * A turn can die with `code: "AUTH"` for two very different reasons, and the
 * difference decides what the reader should do:
 *
 *  - **provider**: the request left the machine and the provider (or something
 *    between it and the model) rejected it. The local credential is present, so
 *    changing it is the wrong move — the usual causes are a transient upstream
 *    failure, a plan/quota limit, or a model the account may not call. Retrying
 *    is reasonable.
 *  - **local**: nothing usable is configured on this machine, so every request
 *    would fail the same way. Retrying changes nothing; the key has to be set.
 *
 * The host reports both as `AUTH`, and the only place the difference survives is
 * the message body — which is why this is a text classifier and why it is kept
 * pure: the caller resolves the actual credential and decides what to say.
 *
 * Observed bodies (2026-09-29, command-code):
 *   provider → `OpenAI API error (403): {"message":"Authentication failed.
 *               Please check your credentials.","type":"permission_error"}`
 *   provider → `403 {"type":"error","error":{"type":"permission_error",
 *               "message":"MODEL_NOT_IN_PLAN: …"}}`
 *   local    → `dsh-llm: no API key for provider "x" (set X_API_KEY)`
 * A *missing* credential on that gateway answered with a 401 and its own
 * envelope (`{"success":false,"error":{"code":"UNAUTHORIZED"}}`), which is why
 * an HTTP status alone cannot classify this: 401 and 403 both appear on the
 * provider side.
 *
 * @module dsh-ssh-tui/auth-failure
 */

/** Which side rejected the request. */
export type AuthFailureOrigin = 'provider' | 'local'

export interface AuthFailure {
  origin: AuthFailureOrigin
  /** The HTTP status, when the message carried one. */
  status?: number
}

/**
 * Bodies/messages that mean "the provider said no".
 *
 * `MODEL_NOT_IN_PLAN` and the quota phrasings are deliberately here: they are
 * answerable by switching model or plan, not by editing a key, and the gateway
 * reports them through the same auth-shaped envelope.
 */
const PROVIDER_PATTERNS: readonly RegExp[] = [
  /authentication failed/iu,
  /invalid[_ -]?api[_ -]?key/iu,
  /\bpermission_error\b/iu,
  /\bunauthori[sz]ed\b/iu,
  /\bforbidden\b/iu,
  /model[_ -]not[_ -]in[_ -]plan/iu,
  /insufficient[_ -]quota/iu,
  /quota (?:exceeded|exhausted)/iu,
  /account[_ -]quota/iu,
  /invalid token/iu,
]

/** Messages that mean "this machine has nothing to send". */
const LOCAL_PATTERNS: readonly RegExp[] = [
  /no (?:api ?key|credentials?|token)\b/iu,
  /(?:api ?key|credentials?|token)[^.]{0,24}\bnot (?:set|configured|found)\b/iu,
  /missing (?:api ?key|credentials?|token)\b/iu,
  /(?:api ?key|credentials?)[^.]{0,24}\bmissing\b/iu,
  /未配置/iu,
  /缺少[^。]{0,12}(?:密钥|凭据|token)/iu,
]

/** The HTTP status inside a host-formatted failure, if there is one. */
export function statusOf(message: string): number | undefined {
  // `OpenAI API error (403): …` and `HTTP 403` are the two shapes the host and
  // the adapters produce.
  const match = /(?:HTTP\s+|\berror\s*\()(\d{3})\b/iu.exec(message)
  if (match === null) return undefined
  const status = Number.parseInt(match[1] ?? '', 10)
  return Number.isFinite(status) ? status : undefined
}

/**
 * Classify one failure message.
 * @param message - the failure text the host attached to the turn.
 * @returns the origin (and status when known), or undefined when the message
 *   says nothing about authentication — an unrelated failure keeps its own row
 *   and gets no advice.
 */
export function classifyAuthFailure(message: string): AuthFailure | undefined {
  const text = String(message ?? '')
  if (text.trim() === '') return undefined
  const status = statusOf(text)
  // A local message wins: a provider body can quote the word "key", and the
  // actionable advice for "nothing configured here" is the opposite one.
  if (LOCAL_PATTERNS.some(pattern => pattern.test(text))) return { origin: 'local', ...(status === undefined ? {} : { status }) }
  if (status === 401 || status === 403) return { origin: 'provider', status }
  if (PROVIDER_PATTERNS.some(pattern => pattern.test(text))) return { origin: 'provider', ...(status === undefined ? {} : { status }) }
  return undefined
}

/**
 * A thinking-mode gateway refusing a follow-up because the reasoning is missing.
 *
 * Seen on the 0.2.0-rc line with the command-code route and `effort: max`
 * (five times in one long session, always on a *continuation*, never on the
 * first request of a turn):
 *
 *     {"type":"invalid_request_error","code":"invalid_request_error",
 *      "message":"The `reasoning_text` in the thinking mode must be passed back
 *                 to the API."}
 *
 * Both a live probe and the upstream reports agree on the shape: the client is
 * expected to send the previous assistant turn's reasoning items back, and the
 * harness does not do that once a session grows long. Nothing the reader can do
 * fixes the client, but two workarounds exist — no thinking on that route, or
 * the same gateway's Anthropic-flavoured route, which carries signed thinking
 * blocks the harness does replay.
 * @param message - the failure text the host attached to the turn.
 * @returns true when this is that failure.
 */
export function isReasoningReplayFailure(message: string): boolean {
  const text = String(message ?? '')
  if (text === '') return false
  return /reasoning_text[^.]{0,80}must be passed back/iu.test(text)
    || /thinking mode must be passed back/iu.test(text)
}
