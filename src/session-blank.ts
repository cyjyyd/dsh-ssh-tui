/**
 * What makes a session "blank": a launch that never did anything.
 *
 * A fresh TUI start creates a session before the reader has typed anything, so
 * quitting straight away leaves an artifact behind. The picker hides those, but
 * they are real files, and other surfaces (the web session list) read the same
 * artifacts without that filter — which is how a session that was never used
 * still shows up in another profile's menu.
 *
 * The rule lives in its own module, with no host imports, for one reason: three
 * very different callers have to agree on it — the picker (which prunes while
 * listing), the TUI (which drops its own session on exit), and
 * `scripts/prune-blank-sessions.mjs` (which sweeps whatever already accumulated,
 * outside a running host).
 *
 * @module dsh-ssh-tui/session-blank
 */

/** Whether one event is a message the reader typed. */
export function isUserMessageEvent(event: unknown): boolean {
  return (event as { type?: string }).type === 'user/message'
}

/**
 * Whether a turn was opened and never closed.
 *
 * A session with an open turn is mid-work: it must never be treated as empty,
 * however little it looks like it has done.
 * @param events - decoded session events, in order.
 * @returns true when a `turn/start` has no matching `turn/end`.
 */
export function hasUnfinishedTurn(events: readonly unknown[]): boolean {
  let open = 0
  for (const event of events) {
    const type = (event as { type?: string }).type
    if (type === 'turn/start') open += 1
    else if (type === 'turn/end') open -= 1
  }
  return open > 0
}

/**
 * Whether the session ever produced a reply.
 *
 * A failed request counts: the error text is the only thing the reader has to
 * look at, and deleting it would delete their evidence.
 * @param events - decoded session events, in order.
 * @returns true when an assistant message or a failed turn is present.
 */
export function sessionHasReply(events: readonly unknown[]): boolean {
  return events.some(event => {
    const candidate = event as {
      type?: string
      data?: { reason?: { kind?: string } }
    }
    if (candidate.type === 'assistant/message' || candidate.type === 'agent/error') return true
    if (candidate.type === 'turn/end') return candidate.data?.reason?.kind === 'error'
    return false
  })
}

/**
 * Whether a session saw the reader's input, a reply, or an open turn.
 * @param events - decoded session events, in order.
 * @returns true when there is something worth keeping.
 */
export function sessionHasWork(events: readonly unknown[]): boolean {
  return events.some(event => isUserMessageEvent(event))
    || sessionHasReply(events)
    || hasUnfinishedTurn(events)
}

/**
 * Whether a session's events describe a launch that never did anything.
 * @param events - the session's decoded events.
 * @returns true when nothing the reader would recognise as work happened. An
 *   empty event list is *not* blank: it is an unreadable or detached log, and
 *   guessing there once made a listing delete a live session's directory.
 */
export function sessionEventsAreBlank(events: readonly unknown[]): boolean {
  if (events.length === 0) return false
  return !sessionHasWork(events)
}
