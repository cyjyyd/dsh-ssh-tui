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

/**
 * The protocol one model should be filed under: what the gateway says it
 * supports (best), else the built-in table, else the gateway's own primary.
 * A model the gateway lists on several routes takes the earliest entry in
 * `preference`.
 */
export function resolveModelProtocol(input: {
  advertised?: readonly string[]
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
  for (const protocol of preference) {
    if (supported.has(protocol)) return protocol
  }
  if (input.table !== undefined) return input.table
  return input.fallback
}

/**
 * Every model of one gateway, filed by protocol. Models the gateway does not
 * describe and the table does not know land on `fallback`, which is the
 * gateway's own pinned protocol — the one its default models were verified on.
 */
export function splitModelsByProtocol(input: {
  models: readonly string[]
  advertised?: ReadonlyMap<string, readonly string[]>
  table?: Readonly<Record<string, GatewayProtocol>>
  fallback: GatewayProtocol
  preference?: readonly GatewayProtocol[]
}): Map<GatewayProtocol, string[]> {
  const split = new Map<GatewayProtocol, string[]>()
  for (const model of input.models) {
    if (model === '') continue
    const protocol = resolveModelProtocol({
      advertised: input.advertised?.get(model),
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
 * Two entries deliberately disagree with the page: `deepseek-v4-flash` and
 * `deepseek-v4-pro` answer `/responses` (verified against the live gateway, and
 * what this plugin's pinned template has shipped since 0.7.0) while the table
 * lists them under chat. A route that works is not downgraded because a
 * document lags. Zen's own (non-Go) route publishes no table here — unknown
 * models there take the gateway's primary protocol.
 */
export const ZEN_GO_MODEL_PROTOCOLS: Readonly<Record<string, GatewayProtocol>> = {
  'grok-4.6': 'openai-responses',
  'gpt-5.6-luna': 'openai-responses',
  'muse-spark-1.3-contributor': 'openai-responses',
  'muse-spark-1.2-contributor': 'openai-responses',
  'deepseek-v4-flash': 'openai-responses',
  'deepseek-v4-pro': 'openai-responses',
  'deepseek-v4.1-flash': 'openai-completions',
  'deepseek-v4-flash-vision-exp': 'openai-completions',
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
