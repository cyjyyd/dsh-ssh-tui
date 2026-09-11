/**
 * The launcher's attach/reconnect state machine, kept out of the bundle entry
 * so it can be driven with fakes.
 *
 * This is the code that decides whether a launcher keeps fighting for a
 * session's display. It used to answer a bare `close` from the Host with a
 * retry — and since the Host answers a *replacement* by closing the previous
 * relay, two SSH windows kicked each other off the display in a loop: every
 * lap repainted the whole screen, every lap left the TTY cooked long enough to
 * echo the DSR replies still in flight as `^[[17;1R`, and neither window could
 * be typed into. `replaced` is now an exit, and the burst breaker below stops
 * any leftover launcher from an older release that would ignore it.
 */

/** Why one relay session ended. */
export type RelayReason = 'goodbye' | 'host-closed' | 'signal' | 'replaced'

/** A relay that dies this soon after connecting reached a Host that was leaving. */
export const ATTACH_RECOVERY_WINDOW_MS = 5_000
/** How long to let a mid-dispose Host finish before starting a fresh one. */
export const ATTACH_RECOVERY_WAIT_MS = 3_000
/** Automatic re-attaches allowed inside this window before we stop trying. */
export const RECOVERY_BURST_WINDOW_MS = 10_000
export const RECOVERY_BURST_LIMIT = 3
/** How long to wait for a freshly spawned Host to accept on its channel. */
export const HOST_START_TIMEOUT_MS = 15_000
/** Pause between "is the old Host gone yet" checks while recovering. */
const RECOVERY_POLL_MS = 150

/** True when a relay error means the peer vanished rather than a real fault. */
export function attachPeerVanished(error: unknown, elapsedMs: number): boolean {
  if (elapsedMs >= ATTACH_RECOVERY_WINDOW_MS) return false
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === undefined) return false
  return code === 'EPIPE' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'ERR_STREAM_DESTROYED'
}

export interface LiveHost {
  kind: 'attachable' | 'zombie'
  sock: string
  pid: number
  exitWatch?: { dispose(): void; exited: Promise<number | null> }
}

export interface SpawnedDisplayHost {
  sock: string
  pid: number
  errFile?: string
  exitWatch: { dispose(): void; exited: Promise<number | null> }
}

/** Everything the state machine touches; the bundle entry supplies the real ones. */
export interface AttacherDeps {
  /** Run one relay; `seed` is typing captured while no display existed. */
  relay(sock: string, seed: string): Promise<{ reason: RelayReason }>
  /** Keep the TTY in raw mode and drop what is queued (stale replies, keys). */
  quiet(): void
  /**
   * Start keeping what the user types. A fresh Host takes a moment to boot,
   * and the old code left stdin flowing with nobody listening, so everything
   * typed in that window was silently dropped.
   */
  beginCapture?(): void
  /** Stop capturing and return the typing ('' when unsupported). */
  endCapture?(): string
  inspectLiveHost(sessionId: string): Promise<LiveHost | undefined>
  spawnHost(sessionId: string): SpawnedDisplayHost
  waitForDisplaySock(spawned: SpawnedDisplayHost): Promise<void>
  /** One already-formatted status line for stderr. */
  report(message: string): void
  exit(code: number): void
  /** `t(...)` for the two state machine messages. */
  messages: {
    connecting(sessionId: string): string
    recovering(sessionId: string): string
    replaced(sessionId: string): string
    flapping(sessionId: string): string
    zombie(sessionId: string, pid: number): string
  }
  locksDisabled?(): boolean
  now?(): number
  debug?: boolean
  /** Override the burst breaker window/limit (tests). */
  burst?: { windowMs?: number; limit?: number }
}

export interface Attacher {
  attachExisting(sessionId: string, sock: string, recover?: boolean): Promise<void>
  /** Attach to a live Host on this session, or spawn a fresh one and attach. */
  attachOrSpawn(sessionId: string, recover?: boolean): Promise<void>
  /** Recoveries recorded in the current burst window (tests). */
  readonly recoveries: number
}

export function createAttacher(deps: AttacherDeps): Attacher {
  const now = deps.now ?? (() => Date.now())
  const windowMs = deps.burst?.windowMs ?? RECOVERY_BURST_WINDOW_MS
  const limit = deps.burst?.limit ?? RECOVERY_BURST_LIMIT
  const recoveryWindow: number[] = []

  const recoveryAllowed = (): boolean => {
    const current = now()
    while (recoveryWindow.length > 0 && current - (recoveryWindow[0] ?? current) >= windowMs) {
      recoveryWindow.shift()
    }
    if (recoveryWindow.length >= limit) return false
    recoveryWindow.push(current)
    return true
  }

  const spawnHostAndRelay = async (sessionId: string, recover: boolean): Promise<void> => {
    const live = deps.locksDisabled?.() === true ? undefined : await deps.inspectLiveHost(sessionId)
    if (live?.kind === 'attachable') {
      await attachExisting(sessionId, live.sock, recover)
      return
    }
    if (live?.kind === 'zombie') {
      throw new Error(deps.messages.zombie(sessionId, live.pid))
    }
    const spawned = deps.spawnHost(sessionId)
    // The Host boots with the TTY in cooked mode: quiet it first so a reply
    // still in flight cannot be echoed over the boot splash, and keep whatever
    // the user types meanwhile instead of dropping it.
    deps.beginCapture?.()
    try {
      await deps.waitForDisplaySock(spawned)
    } finally {
      spawned.exitWatch.dispose()
    }
    const seed = deps.endCapture?.() ?? ''
    await attachExisting(sessionId, spawned.sock, recover, seed)
  }

  /** Wait out a Host that was mid-dispose, then take the normal path again. */
  const recoverAttach = async (sessionId: string): Promise<void> => {
    if (!recoveryAllowed()) throw new Error(deps.messages.flapping(sessionId))
    if (deps.debug === true) deps.report(deps.messages.recovering(sessionId))
    const deadline = now() + ATTACH_RECOVERY_WAIT_MS
    for (;;) {
      const live = deps.locksDisabled?.() === true ? undefined : await deps.inspectLiveHost(sessionId)
      if (live === undefined || now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, RECOVERY_POLL_MS))
    }
    await spawnHostAndRelay(sessionId, false)
  }

  const attachExisting = async (
    sessionId: string,
    sock: string,
    recover = true,
    seed = '',
  ): Promise<void> => {
    // Status lines go to the terminal, and a leftover launcher's terminal is
    // usually a *dead* link: whatever lands there sits in the connection and is
    // flushed onto the screen the moment that link comes back — the stray text
    // the user sees when they resume in a new window. Keep them for
    // `DSH_TUI_DEBUG=1`, where the user asked for diagnostics.
    if (deps.debug === true) deps.report(deps.messages.connecting(sessionId))
    // Always before a relay: the previous one restored cooked mode on its way
    // out, and a cursor reply still in flight is *echoed* there as `^[[17;1R`
    // over the screen. The error path below used to skip this and leave the
    // TTY echoing for the whole recovery wait.
    deps.quiet()
    const startedAt = now()
    let result: { reason: RelayReason }
    try {
      result = await deps.relay(sock, seed)
    } catch (error) {
      if (!recover || !attachPeerVanished(error, now() - startedAt)) throw error
      await recoverAttach(sessionId)
      return
    }
    if (result.reason === 'replaced') {
      // A newer Display claimed this session — the user opened another window
      // on it, or this launcher outlived an SSH drop. Exit instead of
      // re-attaching: that retry is what started the fight.
      //
      // No message either. This window no longer owns any screen, and the link
      // is usually the dead one (that is why the user is resuming elsewhere):
      // anything written here sits in the connection and is flushed onto that
      // terminal when it comes back — the leak the user sees on entry. The
      // takeover is already visible where it matters, in the new window.
      if (deps.debug === true) deps.report(deps.messages.replaced(sessionId))
      deps.exit(0)
      return
    }
    if (recover && result.reason === 'host-closed' && now() - startedAt < ATTACH_RECOVERY_WINDOW_MS) {
      // Accepted, then closed with no goodbye: the Host we reached was on its
      // way out. A second manual attempt used to be the only way in.
      await recoverAttach(sessionId)
      return
    }
    deps.exit(0)
  }

  return {
    attachExisting,
    attachOrSpawn: (sessionId, recover = true) => spawnHostAndRelay(sessionId, recover),
    get recoveries(): number {
      return recoveryWindow.length
    },
  }
}
