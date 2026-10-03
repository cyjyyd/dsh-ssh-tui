/**
 * Representation policy: the one place that decides what a transcript line *is*.
 *
 * AD-10 in `docs/decisions/b2-architecture-decisions.md` froze the shape —
 * `Event / Command → Representation Policy → Representation → Renderer` — and this
 * module is the policy. A renderer never decides whether something exists, and a
 * creation site never decides whether its line is history or an echo: it names its
 * *source*, and the table below says what that source means.
 *
 * The boundary is enforced by the type system rather than by review:
 *
 * - `pushRow` takes a `Representation`, not a `Row`, so a line cannot reach the
 *   transcript without passing through `represent()` — a bare row is a type error;
 * - `RepresentationSource` is `keyof` the policy table, so naming a source that has
 *   no policy is also a type error: adding a creation site *requires* adding its
 *   policy, and there is no default to fall back on;
 * - anything that arrives anyway (a JavaScript caller, a test fixture) is pushed
 *   with no metadata and counted as **unclassified** by `auditRepresentations`,
 *   which the suite asserts is zero. Nothing is silently assumed durable.
 *
 * Three durabilities (B2.3a):
 *
 * - `durable` — rebuilt from the authoritative session log by replaying it, so it
 *   is there again after a resume;
 * - `display` — lives only for this Host/display's lifetime; its absence after a
 *   resume is correct, not a loss;
 * - `live` — a runtime projection, recomputed every tick. **It must never be a
 *   source row at all** (B2.2 moved the streaming text and the wait card out); a
 *   `live` row in the transcript is a bug, and the audit reports it as one.
 *
 * The A/B/C/D classes are orthogonal and describe the *form* of the
 * representation, not its importance:
 *
 * - **A** persistent transcript entry — an ordinary row;
 * - **B** ephemeral transient — never a source row (the live tail, a Surface);
 * - **C** summary entry — a row that summarizes an exchange (`question` cards);
 * - **D** artifact reference — a row that points at an object (plans, later).
 *
 * "Important" is not the same as "durable": a quota alert matters and is still
 * `display`, because no replay can bring it back.
 */
import type { Row } from './transcript-types.js'

/** Where a line can come from after a resume. */
export type Durability = 'durable' | 'display' | 'live'

/**
 * Where a representation is *shown* (B2.3b's routing boundary).
 *
 * Classification says what a line is; routing says where it goes. The policy owns
 * both, so a control-plane confirmation cannot be a transcript row at one call site
 * and a footer echo at the next: the source decides, once.
 *
 * - `transcript` — a real line in the log's view (narrative, a durable summary, a
 *   Screen's line-mode echo, or a local record with causal value);
 * - `echo` — a Host-local footer chip: the confirmation of something the reader just
 *   did. Replaced by the next echo, cleared by the next submit, never in the log;
 * - `notice` — a one-row Host-local notice above the composer, for feedback that
 *   needs to be read now but is not history (a failed command, an operational
 *   warning). Same lifetime rules as the echo, more room for the message.
 *
 * The rule behind the split is AD-13: narrative and causal facts go to the
 * transcript, runtime state belongs to the footer's own facts, and immediate action
 * feedback is an echo or a notice.
 */
export type Destination = 'transcript' | 'echo' | 'notice'

/** The form of the representation (see the module comment). */
export type RepresentationClass = 'A' | 'B' | 'C' | 'D'

/**
 * Every place that may put a line into the transcript.
 *
 * Adding an entry here is what makes a new creation site possible, and the entry
 * states what the line *is*. The ids name the producer, not the wording: one id
 * covers a family of messages whose answer to "is this history?" is the same.
 */
export const REPRESENTATION_POLICY = {
  // ── durable: folded from the session log, so a replay rebuilds them ─────────
  'user-message': { durability: 'durable', class: 'A', destination: 'transcript' },
  'assistant-message': { durability: 'durable', class: 'A', destination: 'transcript' },
  'reasoning-message': { durability: 'durable', class: 'A', destination: 'transcript' },
  'tool-call': { durability: 'durable', class: 'A', destination: 'transcript' },
  'turn-error': { durability: 'durable', class: 'A', destination: 'transcript' },
  /** Notices the log itself carries: reminders, context snapshots, interrupted streams. */
  'session-notice': { durability: 'durable', class: 'A', destination: 'transcript' },
  'compaction': { durability: 'durable', class: 'A', destination: 'transcript' },
  'goal': { durability: 'durable', class: 'A', destination: 'transcript' },
  'prompt-injection': { durability: 'durable', class: 'A', destination: 'transcript' },
  'plan-row': { durability: 'durable', class: 'D', destination: 'transcript' },
  'subagent-card': { durability: 'durable', class: 'A', destination: 'transcript' },
  'command-event': { durability: 'durable', class: 'A', destination: 'transcript' },
  'retry-notice': { durability: 'durable', class: 'A', destination: 'transcript' },
  'session-route': { durability: 'durable', class: 'A', destination: 'transcript' },
  /** The question card: one row summarizing an exchange, rebuilt from the projection. */
  'question-card': { durability: 'durable', class: 'C', destination: 'transcript' },

  // ── display: this Host's own voice; a resume does not bring it back ────────
  'boot': { durability: 'display', class: 'A', destination: 'transcript' },
  /** A confirmation of something the reader just did: a footer echo. */
  'command-feedback': { durability: 'display', class: 'A', destination: 'echo' },
  /**
   * A command that *reports* state rather than changing it (`/retryauth` with no
   * argument, `/notify` showing its target).
   *
   * A report is information, not an acknowledgement: the reader may need to read it
   * twice, or compare it with something they scrolled past, so it stays in the
   * transcript. The policy draws that line, not the call site.
   */
  'command-status': { durability: 'display', class: 'A', destination: 'transcript' },
  /** The outcome of a repair that edited the install (`/mode fix`). */
  'repair-result': { durability: 'display', class: 'A', destination: 'transcript' },
  /**
   * A local command that failed.
   *
   * Kept in the transcript: the message is usually an error chain the reader has to
   * be able to scroll back to, and re-running the command is not the same as reading
   * what it said. (A command that was simply *misused* is the notice below.)
   */
  'command-error': { durability: 'display', class: 'A', destination: 'transcript' },
  /**
   * A command that could not be understood at all: a mistyped name, a missing
   * argument, a value outside the table. Immediate feedback, and nothing to keep —
   * the reader fixes the line and moves on.
   */
  'command-misuse': { durability: 'display', class: 'A', destination: 'notice' },
  /** How to use a command: the reader asked for it, and it is not history. */
  'command-usage': { durability: 'display', class: 'A', destination: 'notice' },
  'auth-notice': { durability: 'display', class: 'A', destination: 'transcript' },
  'onboarding': { durability: 'display', class: 'A', destination: 'transcript' },
  /**
   * An auto approval the TUI *refused*. The transient notice, not a row (B2.4).
   *
   * The durable trace of a refusal is the tool card it guarded — its `approval`
   * field, rebuilt from the Harness's own `approval/asked` + `approval/decided`
   * pair — so a second, permanent sentence saying "rejected" would be a second
   * representation of the same event (and one nothing can rebuild). What the notice
   * adds is *now*: the reader sees why the model changed course while it happens.
   */
  'approval-notice': { durability: 'display', class: 'A', destination: 'notice' },
  /**
   * An auto approval the TUI *granted*.
   *
   * Routed to the footer chip rather than the notice row: an allow is an
   * acknowledgement, and it happens far more often than a refusal — the identity
   * row is for the one the reader must not miss.
   */
  'approval-allowance': { durability: 'display', class: 'A', destination: 'echo' },
  'doctor-result': { durability: 'display', class: 'A', destination: 'transcript' },
  /** Preset wizard/list feedback and its failures. */
  'preset-feedback': { durability: 'display', class: 'A', destination: 'echo' },
  'preset-error': { durability: 'display', class: 'A', destination: 'transcript' },
  /** The self-update path: progress is an echo, a failure is a notice. */
  'update-feedback': { durability: 'display', class: 'A', destination: 'echo' },
  'update-error': { durability: 'display', class: 'A', destination: 'notice' },
  /** A quota or balance reading the reader asked for. */
  'quota-report': { durability: 'display', class: 'A', destination: 'echo' },
  /** The context window filling up: operational, and worth reading now. */
  'runtime-warning': { durability: 'display', class: 'A', destination: 'transcript' },
  /** An approval the TUI could not resolve on its own. */
  'approval-warning': { durability: 'display', class: 'A', destination: 'transcript' },
  /** A question the Session still holds but cannot answer any more. */
  'question-notice': { durability: 'display', class: 'A', destination: 'transcript' },
  /**
   * A child agent starting or ending.
   *
   * Left in the transcript on purpose: it is narrative about work that happened, and
   * the durable child *card* is what a reader scrolls back to.
   */
  'subagent-notice': { durability: 'display', class: 'A', destination: 'transcript' },
  /**
   * What happened while the display was away.
   *
   * AD-13's causal exception: a gap in the work is exactly what a later reader needs
   * explained, so this one stays in the transcript rather than becoming an echo.
   */
  'away-summary': { durability: 'display', class: 'A', destination: 'transcript' },
  'attach-notice': { durability: 'display', class: 'A', destination: 'transcript' },
  'find-feedback': { durability: 'display', class: 'A', destination: 'echo' },
  'copy-feedback': { durability: 'display', class: 'A', destination: 'echo' },
  /**
   * The caveat that a terminal cannot take an OSC 52 write, so the copy may not have
   * landed.
   *
   * An operational warning (AD-13), not an acknowledgement: it goes to the notice row
   * where it can be read, and stays out of the footer chip that says "copied" — the
   * two would otherwise overwrite each other.
   */
  'copy-caveat': { durability: 'display', class: 'A', destination: 'notice' },
  'plan-notice': { durability: 'display', class: 'A', destination: 'echo' },
  /**
   * A plan artifact's lifecycle in the transcript: created, a review's answer, the
   * mode left. The *reference* the reader scrolls back to (`plan-row` points at the
   * same artifact), and the only representation of a transition — the plan body lives
   * with the artifact, not in a second copy.
   */
  'plan-lifecycle': { durability: 'durable', class: 'D', destination: 'transcript' },
  /**
   * A message the reader submitted while a turn was running.
   *
   * The record of it is the `user/message` the Harness appends when the next step
   * claims it — that row is the durable representation. This one is the
   * acknowledgement ("accepted, applies at the next step"), which has to be seen
   * the moment it happens and is worth no geometry.
   */
  'steer-notice': { durability: 'display', class: 'A', destination: 'notice' },
  'error-surface': { durability: 'display', class: 'A', destination: 'notice' },
  /** Line mode's echo of a Screen / Surface — there is no frame there to show it. */
  'report-echo': { durability: 'display', class: 'A', destination: 'transcript' },
  'surface-echo': { durability: 'display', class: 'A', destination: 'transcript' },
  /**
   * The workspace-changes card.
   *
   * The canonical `display` case (B2.3a): it *looks* like history — a card about a
   * turn that happened — but the summary is not in the session log and a restarted
   * Host cannot reopen it, so it must not pretend to survive a resume.
   */
  'changes-card': { durability: 'display', class: 'A', destination: 'transcript' },
  /** Rows a test fixture puts in, so the suite does not have to fabricate a policy. */
  'fixture': { durability: 'display', class: 'A', destination: 'transcript' },
} as const satisfies Record<string, { durability: Durability; class: RepresentationClass; destination: Destination }>

/** A source id that has a policy. Its type *is* the table's keys. */
export type RepresentationSource = keyof typeof REPRESENTATION_POLICY

/** What a row carries once it has been through the policy. */
export interface RepresentationMeta {
  source: RepresentationSource
  durability: Durability
  representationClass: RepresentationClass
  /** Where this representation is shown — a transcript row, an echo or a notice. */
  destination: Destination
}

/** A row plus the policy that produced it. The only thing `pushRow` accepts. */
export interface Representation {
  readonly meta: RepresentationMeta
  readonly row: Row
}

/**
 * Classify one row.
 *
 * The only constructor of a `Representation`: it looks the source up in the table,
 * so the durability and class can never disagree with the policy, and a source with
 * no entry cannot be named (the parameter's type is the table's keys).
 */
export function represent(source: RepresentationSource, row: Row): Representation {
  const policy = REPRESENTATION_POLICY[source]
  return {
    meta: {
      source,
      durability: policy.durability,
      representationClass: policy.class,
      destination: policy.destination,
    },
    row,
  }
}

/** Whether a value really is a classified representation (a runtime guard for JS callers). */
export function isRepresentation(value: unknown): value is Representation {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { meta?: unknown; row?: unknown }
  if (candidate.row === null || typeof candidate.row !== 'object') return false
  const meta = candidate.meta as RepresentationMeta | undefined
  if (meta === undefined || meta === null || typeof meta !== 'object') return false
  return typeof meta.source === 'string' && meta.source in REPRESENTATION_POLICY
}

/** A row as the audit sees it: whatever metadata it actually carries. */
interface AuditableRow {
  kind?: unknown
  representation?: RepresentationMeta
}

export interface RepresentationAudit {
  /** Rows carrying a policy, by durability. */
  counts: Record<Durability, number>
  /** Rows with no `representation` at all: must be 0. */
  unclassified: number
  /**
   * Rows claiming `live`: must be 0 — a live projection is not a source row.
   *
   * Counted from the row's own metadata, so a row whose source is not even in the
   * table (and is therefore also `unclassified`) still reports the live violation.
   */
  liveRows: number
  /** Per source: durability, class, destination and how many rows carry it. */
  sources: {
    source: string
    durability: Durability
    representationClass: RepresentationClass
    destination: Destination
    rows: number
  }[]
  /** Rows by destination. `unknown` must be 0: every source has a route. */
  destinations: Record<Destination, number>
  /** Sources with no destination — impossible by construction, and asserted anyway. */
  unknownDestination: number
  /**
   * Sources the policy knows, with no rows in this transcript. Named so a caller can
   * see the *whole* policy rather than only the part that happened to be exercised.
   */
  unusedSources: string[]
}

/**
 * Read a transcript's representations back.
 *
 * This is the audit artifact: it answers, for a real transcript, how many lines are
 * history, how many are this Host's own voice, and how many nobody classified. The
 * `live` and `unclassified` numbers are the two that must be zero, and the suite
 * asserts exactly that rather than trusting the policy table alone.
 */
export function auditRepresentations(rows: readonly unknown[]): RepresentationAudit {
  const counts: Record<Durability, number> = { durable: 0, display: 0, live: 0 }
  const destinations: Record<Destination, number> = { transcript: 0, echo: 0, notice: 0 }
  const bySource = new Map<string, RepresentationAudit['sources'][number]>()
  let unclassified = 0
  let liveRows = 0
  let unknownDestination = 0
  for (const entry of rows as readonly AuditableRow[]) {
    const meta = entry?.representation
    if (meta === undefined) {
      unclassified += 1
      continue
    }
    // A row that claims to be a live projection is a live source row *whatever* its
    // source says — that is the invariant, and reporting it is the point.
    if (meta.durability === 'live') liveRows += 1
    if (!(meta.source in REPRESENTATION_POLICY)) {
      unclassified += 1
      continue
    }
    counts[meta.durability] += 1
    if (meta.destination in destinations) destinations[meta.destination] += 1
    else unknownDestination += 1
    const seen = bySource.get(meta.source)
    if (seen === undefined) {
      bySource.set(meta.source, {
        source: meta.source,
        durability: meta.durability,
        representationClass: meta.representationClass,
        destination: meta.destination,
        rows: 1,
      })
    } else {
      seen.rows += 1
    }
  }
  const sources = [...bySource.values()].sort((left, right) => right.rows - left.rows)
  const unusedSources = Object.keys(REPRESENTATION_POLICY).filter(source => !bySource.has(source))
  return { counts, destinations, unknownDestination, unclassified, liveRows, sources, unusedSources }
}

/** The audit as text: what `scripts/representation-audit.mjs` prints. */
/**
 * One semantic question, one primary representation — counted from real rows
 * (B2.4).
 *
 * The success criterion of the ask/approval round is a *count*, so it is audited
 * like one: an ordinary `ask_user_question` call is represented by its question
 * card, and a generic tool row for the same call would be a second primary for one
 * semantic event. The tool's name is not read off the row's title but off `name`,
 * because that is the field the policy suppresses.
 * @param rows - the transcript rows to audit.
 * @returns the counts, with the call ids that broke the invariant.
 */
export function auditQuestionPrimaries(rows: readonly { kind?: string; callId?: string; name?: string }[]): {
  questionRows: number
  genericToolRows: number
  calls: number
  duplicateCalls: string[]
} {
  const questionRows = rows.filter(row => row?.kind === 'question')
  const genericToolRows = rows.filter(row => row?.kind === 'tool' && row.name === 'ask_user_question')
  const byCall = new Map<string, number>()
  for (const row of questionRows) {
    if (row.callId === undefined) continue
    byCall.set(row.callId, (byCall.get(row.callId) ?? 0) + 1)
  }
  for (const row of genericToolRows) {
    if (row.callId === undefined) continue
    byCall.set(row.callId, (byCall.get(row.callId) ?? 0) + 1)
  }
  return {
    questionRows: questionRows.length,
    genericToolRows: genericToolRows.length,
    calls: byCall.size,
    duplicateCalls: [...byCall.entries()].filter(([, count]) => count > 1).map(([callId]) => callId),
  }
}

export function formatRepresentationAudit(audit: RepresentationAudit): string {
  const lines = [
    `durable ${audit.counts.durable} · display ${audit.counts.display} · live ${audit.counts.live}`,
    `unclassified ${audit.unclassified} · live source rows ${audit.liveRows}`,
    `transcript ${audit.destinations.transcript} · echo ${audit.destinations.echo} · notice ${audit.destinations.notice} · unknown destination ${audit.unknownDestination}`,
    '',
  ]
  for (const source of audit.sources) {
    lines.push(
      `${source.source.padEnd(20)} ${source.representationClass} ${source.durability.padEnd(8)} → ${source.destination.padEnd(10)} ${source.rows}`,
    )
  }
  if (audit.unusedSources.length > 0) {
    lines.push('', `no rows this session: ${audit.unusedSources.join(', ')}`)
  }
  return lines.join('\n')
}
