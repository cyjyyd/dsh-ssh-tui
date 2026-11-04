/**
 * W6B Terminal Doctor: a snapshot of what the Host knows about the terminal.
 *
 * Two rules decide every row:
 *
 * 1. **The Host policy is not the current terminal.** `terminalCapabilities()`
 *    classifies the environment once, in the Host constructor; it is a policy
 *    the renderer acts on, not a measurement of the terminal now attached.
 * 2. **Only this attachment can prove this attachment.** A numeric `onRtt` or a
 *    `FRAME_METRICS` payload observed after the current `onAttach` is
 *    MEASURED. Anything from a previous Relay is STALE; anything missing is
 *    UNMEASURED with an unknown reason. The Footer's cached RTT and the
 *    process-global ambiguous-width table are deliberately not evidence.
 *
 * The module is pure apart from the locale lookup: the ledger is fed by the
 * Host callbacks, and the formatter only formats the snapshot it is given. It
 * never writes a probe byte, reads a file, opens a socket or calls a model.
 */
import { asciiFallbackEnabled } from './platform.js'
import { parseCapsOverrideReport, type TerminalCapabilities } from './terminal-caps.js'
import { t } from './i18n/index.js'

/** The five provenance states the report must keep distinct. */
export type TerminalEvidenceState = 'MEASURED' | 'CONFIGURED' | 'INFERRED' | 'UNMEASURED' | 'STALE'

/** Where a fact came from. Kept narrow so a forged state is a type error. */
export type TerminalEvidenceSource = 'relay-current' | 'host-start' | 'caller-config' | 'previous-attach'

/** One row of the report: value plus the evidence behind it. */
export interface TerminalFact {
  readonly id: string
  readonly value: string
  readonly state: TerminalEvidenceState
  readonly source: TerminalEvidenceSource
  /** Attachment generation for MEASURED / STALE facts. */
  readonly epoch?: number
  /** Short, already-localized explanation; never a raw environment dump. */
  readonly detail?: string
}

/** The relay-measured ambiguous-glyph verdict carried by `FRAME_METRICS`. */
export interface TerminalMetrics {
  readonly wide: boolean
  readonly reserve: boolean
}

interface EpochObservation {
  epoch: number
  rttSeen: boolean
  rttMs?: number
  metrics?: TerminalMetrics
}

/** Immutable copy of the ledger for one report repaint. */
export interface TerminalLedgerSnapshot {
  /** 0 before the first attach. */
  readonly epoch: number
  readonly attached: boolean
  readonly current?: Readonly<EpochObservation>
  readonly previous?: Readonly<EpochObservation>
}

/**
 * Host-side attachment-generation ledger.
 *
 * `attach()` starts a new generation. `detach()` closes the current one and
 * keeps it only as STALE history. Observations that arrive while detached are
 * ignored: a late frame from an old socket must never resurrect old evidence.
 */
export class TerminalEvidenceLedger {
  private epoch = 0
  private attached = false
  private current: EpochObservation | undefined
  private previous: EpochObservation | undefined

  /** Start a generation for the Relay that just claimed the display. */
  attach(): void {
    if (this.attached && this.current !== undefined) this.previous = this.current
    this.epoch += 1
    this.attached = true
    this.current = { epoch: this.epoch, rttSeen: false }
  }

  /** Close the current generation; its facts become STALE, not current. */
  detach(): void {
    if (!this.attached) return
    if (this.current !== undefined) this.previous = this.current
    this.attached = false
    this.current = undefined
  }

  /**
   * Record one numeric RTT, or one silent probe (`undefined`).
   * @returns whether the observation belonged to a live generation.
   */
  observeRtt(rttMs: number | undefined): boolean {
    if (!this.attached || this.current === undefined) return false
    this.current.rttSeen = true
    if (typeof rttMs === 'number' && Number.isFinite(rttMs) && rttMs >= 0) {
      this.current.rttMs = rttMs
    } else {
      delete this.current.rttMs
    }
    return true
  }

  /**
   * Record one `FRAME_METRICS` payload. Malformed payloads are ignored rather
   * than turned into a zero-width or "disabled" claim.
   * @returns whether a valid observation belonged to a live generation.
   */
  observeMetrics(metrics: TerminalMetrics | undefined): boolean {
    if (!this.attached || this.current === undefined) return false
    if (metrics === undefined || typeof metrics.wide !== 'boolean' || typeof metrics.reserve !== 'boolean') {
      return false
    }
    this.current.metrics = { wide: metrics.wide, reserve: metrics.reserve }
    return true
  }

  /** A detached copy of the ledger; safe to hold while the Host repaints. */
  snapshot(): TerminalLedgerSnapshot {
    const copy = (value: EpochObservation | undefined): EpochObservation | undefined =>
      value === undefined
        ? undefined
        : {
            epoch: value.epoch,
            rttSeen: value.rttSeen,
            ...(value.rttMs === undefined ? {} : { rttMs: value.rttMs }),
            ...(value.metrics === undefined ? {} : { metrics: { ...value.metrics } }),
          }
    return {
      epoch: this.epoch,
      attached: this.attached,
      ...(this.current === undefined ? {} : { current: copy(this.current) }),
      ...(this.previous === undefined ? {} : { previous: copy(this.previous) }),
    }
  }
}

/** What the constructor snapshot says, and which parts were explicit. */
export interface TerminalHostPolicy {
  readonly caps: TerminalCapabilities
  /** `config.terminalCaps` supplied by the caller, rather than the classifier. */
  readonly callerSupplied: boolean
  /** Capability names explicitly set through `DSH_TUI_TERM_CAPS` / legacy flags. */
  readonly configuredKeys: ReadonlySet<string>
  /** Rejected override tokens, counted but never echoed. */
  readonly ignoredOverrideCount: number
  readonly ascii: boolean
  readonly asciiConfigured: boolean
  readonly colorConfigured: boolean
}

/**
 * Build the Host policy description from the constructor's capability object.
 *
 * This is the `this.terminalCaps` snapshot, not a fresh classifier run, so the
 * report cannot disagree with the policy the renderer actually paints with.
 * @param caps - the Host's immutable capability snapshot.
 * @param options - environment/overrides for provenance; defaults to `process.env`.
 */
export function hostPolicyFrom(
  caps: TerminalCapabilities,
  options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; callerSupplied?: boolean } = {},
): TerminalHostPolicy {
  const env = options.env ?? process.env
  const { overrides, ignored } = parseCapsOverrideReport(env.DSH_TUI_TERM_CAPS ?? '')
  const configured = new Set<string>(Object.keys(overrides))
  const altScreen = (env.DSH_TUI_NO_ALT_SCREEN ?? '').trim().toLowerCase()
  if (['1', 'true', 'on', 'yes', '0', 'false', 'off', 'no'].includes(altScreen)) configured.add('alternateScreen')
  const osc8 = (env.DSH_TUI_OSC8 ?? '').trim().toLowerCase()
  if (['1', 'true', 'on', 'yes', '0', 'false', 'off', 'no'].includes(osc8)) configured.add('osc8')
  const asciiRaw = (env.DSH_TUI_ASCII ?? '').trim().toLowerCase()
  return {
    caps,
    callerSupplied: options.callerSupplied === true,
    configuredKeys: configured,
    ignoredOverrideCount: ignored.length,
    ascii: asciiFallbackEnabled(env, options.platform ?? process.platform),
    asciiConfigured: ['1', 'true', 'on', 'yes', 'ascii', '0', 'false', 'off', 'no', 'utf8', 'utf-8'].includes(asciiRaw),
    colorConfigured: (env.DSH_TUI_COLOR_DEPTH ?? '').trim() !== '',
  }
}

/** A fact whose source cannot support its state is a programming error. */
export function assertFactProvenance(fact: TerminalFact): void {
  const measured = fact.state === 'MEASURED'
  const stale = fact.state === 'STALE'
  const config = fact.state === 'CONFIGURED'
  const inferred = fact.state === 'INFERRED'
  const unmeasured = fact.state === 'UNMEASURED'
  if (measured && (fact.source !== 'relay-current' || fact.epoch === undefined)) {
    throw new Error(`terminal fact ${fact.id}: MEASURED requires relay-current with an epoch`)
  }
  if (stale && (fact.source !== 'previous-attach' || fact.epoch === undefined)) {
    throw new Error(`terminal fact ${fact.id}: STALE requires previous-attach with an epoch`)
  }
  if (config && fact.source !== 'host-start' && fact.source !== 'caller-config') {
    throw new Error(`terminal fact ${fact.id}: CONFIGURED requires a Host or caller source`)
  }
  if (inferred && fact.source !== 'host-start') {
    throw new Error(`terminal fact ${fact.id}: INFERRED requires a Host source`)
  }
  if (unmeasured && fact.source !== 'relay-current') {
    throw new Error(`terminal fact ${fact.id}: UNMEASURED belongs to Relay evidence`)
  }
}

function cleanLabel(text: string): string {
  const printable = text.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
  return [...printable].slice(0, 48).join('')
}

function stateLabel(state: TerminalEvidenceState): string {
  return t(`terminal.state.${state.toLowerCase()}`)
}

function factRow(label: string, fact: TerminalFact, sep: string): string {
  assertFactProvenance(fact)
  const detail = fact.detail === undefined ? '' : `${sep}${fact.detail}`
  return `${label}: ${fact.value}  ${stateLabel(fact.state)}${detail}`
}

function onOff(value: boolean): string {
  return value ? t('terminal.value.on') : t('terminal.value.off')
}

function hostDetail(policy: TerminalHostPolicy): string {
  if (policy.callerSupplied) return t('terminal.detail.caller')
  return t('terminal.detail.host')
}

function hostFact(
  id: string,
  value: string,
  policy: TerminalHostPolicy,
  configured: boolean,
  detail?: string,
): TerminalFact {
  const isConfigured = policy.callerSupplied || configured
  return {
    id,
    value,
    state: isConfigured ? 'CONFIGURED' : 'INFERRED',
    source: policy.callerSupplied ? 'caller-config' : 'host-start',
    detail: isConfigured ? (policy.callerSupplied ? t('terminal.detail.caller') : t('terminal.detail.override')) : (detail ?? hostDetail(policy)),
  }
}

function relayFact(
  id: string,
  value: string,
  state: 'MEASURED' | 'UNMEASURED',
  snapshot: TerminalLedgerSnapshot,
  detail: string,
): TerminalFact {
  if (state === 'MEASURED') {
    return { id, value, state, source: 'relay-current', epoch: snapshot.epoch, detail }
  }
  return { id, value, state, source: 'relay-current', detail }
}

function staleFact(id: string, value: string, epoch: number, detail: string): TerminalFact {
  return { id, value, state: 'STALE', source: 'previous-attach', epoch, detail }
}

function epochDetail(epoch: number): string {
  return t('terminal.detail.epoch', { epoch })
}

/**
 * Format one Terminal Doctor snapshot.
 *
 * The returned lines are the canonical body: the Screen wraps them for the
 * current width, and `copyText` is their exact join. No live probe is implied.
 * @param policy - Host constructor policy and explicit-override provenance.
 * @param snapshot - the attachment ledger at this repaint.
 * @param options - ASCII separators and line-mode hint suppression.
 */
export function formatTerminalDoctor(
  policy: TerminalHostPolicy,
  snapshot: TerminalLedgerSnapshot,
  options: { ascii?: boolean; lineMode?: boolean } = {},
): string[] {
  const ascii = options.ascii ?? policy.ascii
  const sep = ascii ? ' - ' : ' · '
  const caps = policy.caps
  const configured = (key: string): boolean => policy.configuredKeys.has(key)
  const lines: string[] = []

  lines.push(t('terminal.scope.host'))
  lines.push(snapshot.attached
    ? t('terminal.relay.attached', { epoch: snapshot.epoch })
    : t('terminal.relay.detached'))
  lines.push('')

  lines.push(factRow(t('terminal.fact.family'), hostFact('family', cleanLabel(caps.label), policy, false), sep))
  lines.push(factRow(t('terminal.fact.color'), hostFact('color', String(caps.colors), policy, policy.colorConfigured), sep))
  lines.push(factRow(t('terminal.fact.mouse'), hostFact(
    'mouse',
    t('terminal.value.mouseSgr', { mouse: onOff(caps.mouse), sgr: onOff(caps.mouseSgr) }),
    policy,
    configured('mouse') || configured('mouseSgr'),
  ), sep))
  lines.push(factRow(t('terminal.fact.drag'), hostFact('drag', onOff(caps.mouseDrag), policy, configured('mouseDrag')), sep))
  lines.push(factRow(t('terminal.fact.paste'), hostFact('paste', onOff(caps.bracketedPaste), policy, configured('bracketedPaste')), sep))
  lines.push(factRow(t('terminal.fact.alt'), hostFact('alt', onOff(caps.alternateScreen), policy, configured('alternateScreen')), sep))
  const osc52 = hostFact(
    'osc52',
    caps.osc52 ? t('terminal.value.on') : t('terminal.value.notPromised'),
    policy,
    configured('osc52'),
  )
  lines.push(factRow(t('terminal.fact.osc52'), {
    ...osc52,
    detail: `${osc52.detail ?? hostDetail(policy)}${sep}${t('terminal.detail.notProof')}`,
  }, sep))
  lines.push(factRow(t('terminal.fact.osc8'), hostFact('osc8', onOff(caps.osc8), policy, configured('osc8')), sep))
  lines.push(factRow(t('terminal.fact.title'), hostFact('title', onOff(caps.title), policy, configured('title')), sep))
  lines.push(factRow(t('terminal.fact.ascii'), hostFact('ascii', onOff(policy.ascii), policy, policy.asciiConfigured), sep))

  const current = snapshot.current
  if (!snapshot.attached) {
    lines.push(factRow(t('terminal.fact.rtt'), relayFact('rtt', t('terminal.value.unknown'), 'UNMEASURED', snapshot, t('terminal.detail.detached')), sep))
    lines.push(factRow(t('terminal.fact.glyph'), relayFact('glyph', t('terminal.value.unknown'), 'UNMEASURED', snapshot, t('terminal.detail.detached')), sep))
  } else if (current?.rttMs !== undefined) {
    lines.push(factRow(t('terminal.fact.rtt'), relayFact('rtt', `${current.rttMs} ms`, 'MEASURED', snapshot, epochDetail(current.epoch)), sep))
  } else {
    lines.push(factRow(t('terminal.fact.rtt'), relayFact('rtt', t('terminal.value.unknown'), 'UNMEASURED', snapshot, t('terminal.detail.noReply')), sep))
  }
  if (snapshot.attached && current?.metrics !== undefined) {
    const value = current.metrics.wide ? t('terminal.value.twoCells') : t('terminal.value.oneCell')
    lines.push(factRow(t('terminal.fact.glyph'), relayFact('glyph', value, 'MEASURED', snapshot, epochDetail(current.epoch)), sep))
  } else if (snapshot.attached) {
    lines.push(factRow(t('terminal.fact.glyph'), relayFact('glyph', t('terminal.value.unknown'), 'UNMEASURED', snapshot, t('terminal.detail.noMetrics')), sep))
  }

  const previous = snapshot.previous
  if (previous?.rttMs !== undefined && current?.rttMs === undefined) {
    lines.push(factRow(
      t('terminal.fact.previousRtt'),
      staleFact('previousRtt', `${previous.rttMs} ms`, previous.epoch, t('terminal.detail.previous', { epoch: previous.epoch })),
      sep,
    ))
  }
  if (previous?.metrics !== undefined && current?.metrics === undefined) {
    const value = previous.metrics.wide ? t('terminal.value.twoCells') : t('terminal.value.oneCell')
    lines.push(factRow(
      t('terminal.fact.previousGlyph'),
      staleFact('previousGlyph', value, previous.epoch, t('terminal.detail.previous', { epoch: previous.epoch })),
      sep,
    ))
  }

  const overrideValue = policy.ignoredOverrideCount > 0
    ? String(policy.ignoredOverrideCount)
    : policy.configuredKeys.size > 0 ? String(policy.configuredKeys.size) : t('terminal.value.none')
  lines.push(factRow(t('terminal.fact.overrides'), {
    id: 'overrides',
    value: overrideValue,
    state: 'CONFIGURED',
    source: policy.callerSupplied ? 'caller-config' : 'host-start',
    detail: policy.ignoredOverrideCount > 0
      ? t('terminal.detail.invalidOverrides', { count: policy.ignoredOverrideCount })
      : t('terminal.detail.validated'),
  }, sep))

  lines.push('')
  lines.push(t('terminal.recheck.unavailable'))
  if (options.lineMode !== true) {
    lines.push(t('terminal.hint'))
  }
  if (ascii) {
    return lines.map(line => line.replace(/·/gu, '-'))
  }
  return lines
}
