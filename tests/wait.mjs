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

export const rowText = (tui, kind) =>
  tui.rows.filter(row => row.kind === kind).map(row => String(row.text)).join('\n')
export const systemText = tui => rowText(tui, 'system')
export const errorText = tui => rowText(tui, 'error')
export const allText = tui => `${systemText(tui)}\n${errorText(tui)}`

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

/** The newest system row, which is what a command's report ends on. */
export const lastSystemText = tui => String(tui.rows.findLast(row => row.kind === 'system')?.text ?? '')

/** Wait for the last system row to contain the needle. */
export function waitForLastSystem(tui, needle, options = {}) {
  return waitFor(() => lastSystemText(tui).includes(needle), {
    describe: `the last system row to contain ${JSON.stringify(needle)}`,
    detail: () => allText(tui),
    ...options,
  })
}
