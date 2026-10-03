/**
 * Condition waits for the command-level tests.
 *
 * A command runs behind `void this.runXCommand(...)`, so its effects land a
 * microtask chain (and sometimes a file write) later. A fixed `setTimeout` tick
 * before the assertion is therefore a race: it passed on a fast runner and read
 * the old state on a slow CI leg — three different legs flaked in one afternoon,
 * each time in a different file. These helpers wait for the state the test is
 * about and report the transcript when it never arrives, so a real failure is
 * not mistaken for a slow machine.
 */
import { represent } from '../lib/representation.js'
import assert from 'node:assert/strict'

export const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Poll `check` until it returns truthy.
 * @param check - the condition, re-evaluated every `intervalMs`.
 * @param options - what to call it, how long to wait, and what to print on timeout.
 */
export async function waitFor(check, options = {}) {
  const { describe = 'the condition', timeoutMs = 4_000, intervalMs = 20, detail } = options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (check()) return
    if (Date.now() >= deadline) {
      const context = detail === undefined ? '' : `\n--- context ---\n${detail()}`
      assert.fail(`timed out waiting for ${describe}${context}`)
    }
    await tick(intervalMs)
  }
}

/**
 * Put a fixture row into a transcript.
 *
 * `pushRow` takes a classified representation (B2.3a), so a test cannot hand it a
 * bare row — that is the point of the boundary. Fixtures say what they are: a row
 * this test fabricated, `display`, never something the session log could rebuild.
 */
export const pushRow = (tui, row) => tui.pushRow(represent('fixture', row))

/**
 * Seed a real plan artifact from durable events (B2.5).
 *
 * A plan is a projection of the session log now, so a fixture that pushes a bare
 * `plan` row no longer docks anything — the old rows were a second truth. This fires
 * the events the Harness fires: the mode switch, the todo snapshot, and (when asked)
 * the `exit_plan_mode` review with its result.
 * @param tui - the TUI under test.
 * @param agent - its agent (the session events are addressed to it).
 * @param options - what to seed; `seq` starts a fresh block of sequence numbers.
 * @returns the artifact id the fold produced.
 */
export function seedPlan(tui, agent, options = {}) {
  const {
    active = true,
    todos = [{ content: '第 1 步', status: 'in_progress' }],
    body,
    review,
  } = options
  const base = (seedPlan.seq = (seedPlan.seq ?? 0) + 20)
  const send = (type, seq, data) => tui.handleSessionEvent({ id: agent.id }, { type, seq, time: Date.now(), data })
  send('plan/mode', base, { active })
  send('todo/write', base + 1, { todos })
  if (body !== undefined) {
    send('tool/call', base + 2, { callId: `review-${base}`, name: 'exit_plan_mode', arguments: JSON.stringify({ plan: body }) })
    if (review !== undefined) {
      send('tool/result', base + 3, {
        message: {
          source: { callId: `review-${base}` },
          content: [{ type: 'text', text: review.text ?? '' }],
          isError: review.approved !== true,
        },
      })
    }
  }
  return `plan@${base}`
}

/**
 * Everything the reader can currently read as feedback.
 *
 * Before B2.3b a command's confirmation or failure was a transcript row, so a test
 * asserted on `errorText`/`systemText`. The routing moved those messages to the
 * footer echo and the notice row, and the *message* is what the tests are about —
 * this reads all three sinks, so a case does not have to know which one the policy
 * picked (and would fail if the message reached none of them).
 */
export const feedbackText = tui => [
  ...tui.rows.map(row => String(row.text ?? '')),
  tui.currentFooterEcho() ?? '',
  tui.currentNotice() ?? '',
].filter(text => text !== '').join('\n')

/**
 * The newest feedback message, whichever sink carries it.
 *
 * A command's outcome is routed to exactly one sink by the policy: a transcript row
 * (durable or causal), the footer echo, or the notice row. A test asking "what did
 * that command just say" should not have to know which — it asks here.
 */
export const lastFeedback = tui =>
  tui.currentNotice() ?? tui.currentFooterEcho() ?? lastSystemText(tui)

/** Wait until any sink shows the needle. */
export function waitForFeedback(tui, needle, options = {}) {
  return waitFor(() => feedbackText(tui).includes(needle), {
    describe: `feedback containing ${JSON.stringify(needle)}`,
    detail: () => feedbackText(tui),
    ...options,
  })
}

export const rowText = (tui, kind) =>
  tui.rows.filter(row => row.kind === kind).map(row => String(row.text)).join('\n')
export const systemText = tui => rowText(tui, 'system')
export const errorText = tui => rowText(tui, 'error')
/** `/diag` and `/doctor` reports: their own row kind, still plain text. */
export const diagText = tui => rowText(tui, 'diag')
export const allText = tui => `${systemText(tui)}\n${diagText(tui)}\n${errorText(tui)}`

/** Wait until a system or error row contains the needle. */
export function waitForText(tui, needle, options = {}) {
  return waitFor(() => allText(tui).includes(needle), {
    describe: `a row containing ${JSON.stringify(needle)}`,
    detail: () => allText(tui),
    ...options,
  })
}

/** Wait until an error row contains the needle. */
export function waitForError(tui, needle, options = {}) {
  return waitFor(() => errorText(tui).includes(needle), {
    describe: `an error row containing ${JSON.stringify(needle)}`,
    detail: () => allText(tui),
    ...options,
  })
}

/** Wait for a dialog of the given kind to be open. */
export function waitForDialog(tui, kind, options = {}) {
  return waitFor(() => tui.dialog?.kind === kind, {
    describe: `the ${kind} dialog`,
    detail: () => allText(tui),
    ...options,
  })
}

/**
 * A Screen's body as plain text.
 *
 * Since B2.1 a report is a Screen, not a row: `/doctor`, `/diag`, `/status`,
 * `/help` and `/subagents` paint into `tui.screen` and write nothing to the log.
 * Reading them means reading the Screen.
 */
export const screenText = tui => [tui.screen?.title ?? '', ...(tui.screen?.lines ?? []).map(line => String(line.text))]
  .filter(line => line !== '')
  .join('\n')

/** Wait until the Screen body contains the needle. */
export function waitForScreen(tui, needle, options = {}) {
  return waitFor(() => screenText(tui).includes(needle), {
    describe: `a Screen containing ${JSON.stringify(needle)}`,
    detail: () => screenText(tui) || '(no Screen)',
    ...options,
  })
}

/** Wait for a Screen's own confirmation (the doctor repair) to be asking. */
export function waitForScreenConfirm(tui, options = {}) {
  return waitFor(() => tui.screenSurface !== undefined, {
    describe: 'the Screen confirmation',
    detail: () => screenText(tui) || '(no Screen)',
    ...options,
  })
}

/** The newest report row, which is what a command ends on. */
export const lastSystemText = tui => String(
  tui.rows.findLast(row => row.kind === 'system' || row.kind === 'diag')?.text ?? '',
)

/** Wait for the last report row to contain the needle. */
export function waitForLastSystem(tui, needle, options = {}) {
  return waitFor(() => lastSystemText(tui).includes(needle), {
    describe: `the last system row to contain ${JSON.stringify(needle)}`,
    detail: () => allText(tui),
    ...options,
  })
}

/**
 * A credential service that says "this machine is set up".
 *
 * The first-run check (`maybeRunOnboarding`) opens the setup Screen when nothing is
 * configured — and it reads that from the *environment*, not from the test: a
 * developer's `$DSH_HOME/.credentials.yaml` hides it, a bare CI runner has nothing,
 * which is how eight tests passed here and failed there at 0.8.2's first push. A
 * fixture that drives the TUI and asserts on painted frames must say which machine
 * it is simulating; this is that statement.
 */
export const configuredCredentials = {
  async describe() { return { configured: true, writable: true, source: 'file' } },
  async resolve() { return { value: 'stub-key', source: 'file' } },
  async set() {},
  async unset() {},
}

/** The `ctx.get` a fixture wants when it simulates a machine that has been set up. */
export const ctxWithCredentials = (services = {}) => ({
  get: name => (name === 'credentials' ? configuredCredentials : services[name]),
  on() { return () => {} },
})

/**
 * Build something as an SSH-attached session, whatever terminal runs the suite.
 *
 * `detectSshSession` reads `process.env` at construction, so anything asserting the
 * SSH tier (the `SSH ●●●●` chip, or the 160 ms cadence that tier picks) passes on a
 * developer's SSH session and fails on a CI runner, which has no `SSH_*` at all.
 * The three variables the detector reads are set for the build and put back after.
 * @param build - called with the environment pinned; its return value is returned.
 */
export function withSshSession(build) {
  const names = ['SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY']
  const previous = names.map(name => process.env[name])
  process.env.SSH_CONNECTION = '203.0.113.4 53210 203.0.113.9 22'
  process.env.SSH_CLIENT = '203.0.113.4 53210 22'
  process.env.SSH_TTY = '/dev/pts/9'
  try {
    return build()
  } finally {
    names.forEach((name, index) => {
      const value = previous[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
}
