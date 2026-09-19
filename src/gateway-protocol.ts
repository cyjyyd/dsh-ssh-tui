/**
 * One gateway, several wire protocols.
 *
 * `llm-pi-ai` puts `api` on the *provider* entry, not on a model entry, so a
 * gateway whose catalogue spans protocols (Command Code: 55 of 71 models answer
 * `/responses`, 8 only `/chat/completions`, the Claude family only `/messages`)
 * cannot be one entry. The wizard therefore keeps one row per gateway and
 * expands it into sibling entries — `command-code`, `command-code-responses`,
 * `command-code-messages` — with each model filed under the protocol it
 * actually speaks. Everything here is pure so the split can be tested without
 * a settings file or a network.
 */

export type GatewayProtocol = 'openai-responses' | 'openai-completions' | 'anthropic-messages'

/** Preference order for a model a gateway lists on more than one route. */
export const GATEWAY_PROTOCOL_PREFERENCE: readonly GatewayProtocol[] = [
  'openai-responses',
  'openai-completions',
  'anthropic-messages',
]

/** Id suffix per protocol; the base entry keeps the plain gateway id. */
export const GATEWAY_PROTOCOL_SUFFIX: Record<GatewayProtocol, string> = {
  'openai-responses': 'responses',
  'openai-completions': 'completions',
  'anthropic-messages': 'messages',
}

/** The endpoint path each protocol speaks, for messages and hints. */
export const GATEWAY_PROTOCOL_ENDPOINT: Record<GatewayProtocol, string> = {
  'openai-responses': '/responses',
  'openai-completions': '/chat/completions',
  'anthropic-messages': '/messages',
}

const SUFFIX_TO_PROTOCOL = new Map<string, GatewayProtocol>(
  Object.entries(GATEWAY_PROTOCOL_SUFFIX).map(([protocol, suffix]) => [suffix, protocol as GatewayProtocol]),
)

/** The endpoint strings gateways publish; `null` for anything unrecognised. */
export function endpointProtocol(endpoint: string): GatewayProtocol | null {
  const path = endpoint.trim().toLowerCase().replace(/\/+$/u, '')
  if (path === '/responses' || path.endsWith('/responses')) return 'openai-responses'
  if (path === '/chat/completions' || path.endsWith('/chat/completions')) return 'openai-completions'
  if (path === '/messages' || path.endsWith('/messages')) return 'anthropic-messages'
  return null
}

/** `command-code` + `openai-responses` → `command-code-responses`. */
export function siblingProviderId(baseId: string, protocol: GatewayProtocol): string {
  return `${baseId}-${GATEWAY_PROTOCOL_SUFFIX[protocol]}`
}

/** The protocol a sibling id carries, or null when it is not one of ours. */
export function siblingProtocolOf(id: string): GatewayProtocol | null {
  const match = /-([a-z]+)$/u.exec(id)
  if (match === null) return null
  return SUFFIX_TO_PROTOCOL.get(match[1] ?? '') ?? null
}

/** True when `id` is a sibling of `baseId` (and not the base itself). */
export function isSiblingOf(baseId: string, id: string): boolean {
  if (id === baseId) return false
  return id.startsWith(`${baseId}-`) && siblingProtocolOf(id) !== null
}

/** The gateway id a sibling row belongs to; a base id comes back unchanged. */
export function baseProviderIdOf(id: string): string {
  const protocol = siblingProtocolOf(id)
  if (protocol === null) return id
  const suffix = `-${GATEWAY_PROTOCOL_SUFFIX[protocol]}`
  return id.endsWith(suffix) ? id.slice(0, -suffix.length) : id
}

/** The protocol a provider entry's `api` names, when it is one of the three we model. */
export function declaredProtocol(value: unknown): GatewayProtocol | undefined {
  return value === 'openai-responses' || value === 'openai-completions' || value === 'anthropic-messages'
    ? value
    : undefined
}

/**
 * Whether an entry that speaks `protocol` may serve `model`, according to the
 * gateway's own `supported_endpoints`. A gateway that publishes nothing about
 * the model — or no protocol to check against — never blocks it: silence is not
 * a refusal, only an explicit list that omits the protocol is.
 */
export function gatewayServesModel(
  endpoints: ReadonlyMap<string, readonly string[]> | undefined,
  model: string,
  protocol: GatewayProtocol | undefined,
): boolean {
  if (protocol === undefined || endpoints === undefined) return true
  const advertised = endpoints.get(model)
  if (advertised === undefined) return true
  return advertised.some(endpoint => endpointProtocol(endpoint) === protocol)
}

/**
 * The protocols a gateway lists for `model`, in preference order. Empty when the
 * gateway says nothing, which callers read as "no opinion".
 */
export function advertisedProtocols(
  endpoints: ReadonlyMap<string, readonly string[]> | undefined,
  model: string,
): GatewayProtocol[] {
  const advertised = endpoints?.get(model)
  if (advertised === undefined) return []
  const protocols = new Set<GatewayProtocol>()
  for (const endpoint of advertised) {
    const protocol = endpointProtocol(endpoint)
    if (protocol !== null) protocols.add(protocol)
  }
  return GATEWAY_PROTOCOL_PREFERENCE.filter(protocol => protocols.has(protocol))
}

/**
 * The protocol one model should be filed under. The gateway's own
 * `supported_endpoints` decide when it publishes them; a model already
 * configured on a route the gateway still lists keeps that route, and a model
 * the gateway does not describe keeps the route it is already on rather than
 * being relocated by a hand-maintained table. Otherwise the earliest entry in
 * `preference` wins, then the table, then the gateway's own primary protocol.
 */
export function resolveModelProtocol(input: {
  advertised?: readonly string[]
  /** The provider protocol this model is already configured on, if any. */
  existing?: GatewayProtocol
  table?: GatewayProtocol
  fallback: GatewayProtocol
  preference?: readonly GatewayProtocol[]
}): GatewayProtocol {
  const preference = input.preference ?? GATEWAY_PROTOCOL_PREFERENCE
  const supported = new Set<GatewayProtocol>()
  for (const endpoint of input.advertised ?? []) {
    const protocol = endpointProtocol(endpoint)
    if (protocol !== null) supported.add(protocol)
  }
  // Silence from the gateway is not evidence against a placement that works:
  // only an explicit advertisement that has dropped the model's route moves it.
  if (input.existing !== undefined && (supported.size === 0 || supported.has(input.existing))) {
    return input.existing
  }
  for (const protocol of preference) {
    if (supported.has(protocol)) return protocol
  }
  if (input.table !== undefined) return input.table
  return input.fallback
}

/**
 * Every model of one gateway, filed by protocol. `existing` carries the
 * protocol each model is already configured on, so re-running setup keeps a
 * working placement instead of re-homing it. Models the gateway does not
 * describe, that are not configured yet, and that the table does not know land
 * on `fallback`, which is the gateway's own pinned protocol — the one its
 * default models were verified on.
 */
export function splitModelsByProtocol(input: {
  models: readonly string[]
  advertised?: ReadonlyMap<string, readonly string[]>
  existing?: ReadonlyMap<string, GatewayProtocol>
  table?: Readonly<Record<string, GatewayProtocol>>
  fallback: GatewayProtocol
  preference?: readonly GatewayProtocol[]
}): Map<GatewayProtocol, string[]> {
  const split = new Map<GatewayProtocol, string[]>()
  for (const model of input.models) {
    if (model === '') continue
    const protocol = resolveModelProtocol({
      advertised: input.advertised?.get(model),
      ...(input.existing?.get(model) === undefined ? {} : { existing: input.existing.get(model) }),
      table: input.table?.[model],
      fallback: input.fallback,
      ...(input.preference === undefined ? {} : { preference: input.preference }),
    })
    split.set(protocol, [...(split.get(protocol) ?? []), model])
  }
  return split
}

/**
 * OpenCode Go's published endpoint table (https://opencode.ai/docs/go/), because
 * `GET /zen/go/v1/models` carries no `supported_endpoints` field at all.
 *
 * The whole DeepSeek family answers `/responses` (verified against the live
 * gateway, and what this plugin's pinned template has shipped since 0.7.0) even
 * though the page still lists those models under chat. A route that works is not
 * downgraded because a document lags. Zen's own (non-Go) route publishes no
 * table here — unknown models there take the gateway's primary protocol.
 */
export const ZEN_GO_MODEL_PROTOCOLS: Readonly<Record<string, GatewayProtocol>> = {
  'grok-4.6': 'openai-responses',
  'gpt-5.6-luna': 'openai-responses',
  'muse-spark-1.3-contributor': 'openai-responses',
  'muse-spark-1.2-contributor': 'openai-responses',
  'deepseek-flash': 'openai-responses',
  'deepseek-v4-flash': 'openai-responses',
  'deepseek-v4-pro': 'openai-responses',
  'deepseek-v4.1-flash': 'openai-responses',
  'deepseek-v4-flash-vision-exp': 'openai-responses',
  'glm-5.3-flash': 'openai-completions',
  'glm-5.3': 'openai-completions',
  'glm-5.2': 'openai-completions',
  'glm-5.1': 'openai-completions',
  'kimi-k3': 'openai-completions',
  'kimi-k2.7-code': 'openai-completions',
  'kimi-k2.6': 'openai-completions',
  'longcat-2.0': 'openai-completions',
  'mimo-v2.5': 'openai-completions',
  'mimo-v2.5-pro': 'openai-completions',
  'hy4-preview': 'openai-completions',
  'hy3': 'openai-completions',
  'minimax-m3': 'anthropic-messages',
  'minimax-m2.7': 'anthropic-messages',
  'minimax-m2.5': 'anthropic-messages',
  'qwen3.8-max': 'anthropic-messages',
  'qwen3.8-flash': 'anthropic-messages',
  'qwen3.7-max': 'anthropic-messages',
  'qwen3.7-plus': 'anthropic-messages',
  'qwen3.6-plus': 'anthropic-messages',
}

/** The built-in table for a gateway base URL, when we have one. */
export function gatewayModelTable(baseURL: string): Readonly<Record<string, GatewayProtocol>> | undefined {
  return /opencode\.ai\/zen\/go/iu.test(baseURL) ? ZEN_GO_MODEL_PROTOCOLS : undefined
}
