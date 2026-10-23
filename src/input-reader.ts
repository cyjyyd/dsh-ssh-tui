/**
 * The input Reader: bytes in, framed input units out.
 *
 * This module owns everything between the wire and "here is what arrived":
 *
 *   - **byte decoding** — a UTF-8 code point split across two reads is one
 *     character, not two replacement glyphs (`StringDecoder`)
 *   - **device-reply filtering** — the `CSI row;col R` answers the link probe asks
 *     for are not typing; the guard strips them and holds a possible tail for
 *     `INPUT_HOLD_MS` so `ESC [ 1` + `7;1R` cannot become `[17;1R` in the draft
 *   - **escape assembly** — a sequence may arrive in pieces (`ESC`, then `[A`;
 *     `ESC[`, then `5~`), so a read that could still grow is held for
 *     {@link ESCAPE_HOLD_MS} and released as what it turned out to be
 *   - **paste framing** — `ESC[200~ … ESC[201~` markers, the payload between them,
 *     and the console-without-bracketed-paste fallback (a burst carrying more than
 *     one line break in one read is a paste, not repeated Enter presses)
 *   - **paste-tail release** — a marker cut in half is held, and what it turns out
 *     to be decides the frame: a longer tail (`ESC[20`) may still be a marker, so it
 *     keeps the marker window and is released as payload; a tail that is only `ESC`
 *     cannot be paste text, so it is released as the **Escape key** after the Escape
 *     window (the rule `armPasteTail` implements)
 *   - **unit classification** — whether a read is one complete terminal unit, a
 *     burst of typing, paste traffic, or a device reply (shape only: this module
 *     does not know which key does what)
 *
 * It owns **no** semantics. It does not look at `screen`, `dialog`, the composer or
 * the workspace, does not consult the keymap, and never mutates owner state: the
 * frames it emits are the input to the caller's routing, not a decision about it.
 * That is the boundary the contract freezes (`docs/decisions/input-reader.md`,
 * AD-21) — the same input bytes must produce the same frames, and the caller must
 * be able to prove it (`tests/input-reader.test.mjs` compares the frames and the
 * consumer calls against traces captured before this module existed).
 *
 * The two hold windows are deliberately separate and must not be merged:
 * `INPUT_HOLD_MS` (30 ms, in the guard) guards a **reply** and hands the bytes back
 * as input when the window passes; {@link ESCAPE_HOLD_MS} (60 ms, here) guards a
 * **keystroke** and turns what it held into an Escape or into text. One is a filter
 * with a fallback, the other an assembly step with two possible readings.
 *
 * @module dsh-ssh-tui/input-reader
 */
import { StringDecoder } from 'node:string_decoder'

import { isEscapePrefix, parseCursorPositionReply } from './paint.js'
import { TerminalInputGuard } from './terminal-input.js'

/**
 * How long a read that could still grow into a sequence is held.
 *
 * The window is what makes a lone `ESC` (the reader pressed Escape) different from
 * the first byte of a sequence the terminal is still sending. W-1 moved the timer,
 * not the number: changing it changes how Escape feels, and that is a separate
 * decision with its own evidence.
 */
export const ESCAPE_HOLD_MS = 60

/**
 * One framed unit of input.
 *
 * The vocabulary is deliberately small — four kinds carry text, one carries the
 * released Escape, one carries a device reply — because the Reader's job is to say
 * *what arrived*, not what it means. `key` and `burst` reach the same routing today;
 * they are distinguished because the Router (W-2) has to decide "one key" versus
 * "several keys in one read" (the read-coalescing gaps G-1/G-2 live exactly there).
 */
export type InputFrame =
  /** One complete terminal unit: a control byte, a full CSI sequence, or a lone ESC. */
  | { kind: 'key'; sequence: string }
  /** A read of ordinary typing. It may carry several keys — W-3 splits it. */
  | { kind: 'burst'; text: string }
  /** Text to be typed exactly as it is (a sequence tail, an Alt remainder, a release). */
  | { kind: 'literal'; text: string }
  /** The payload between paste markers. */
  | { kind: 'paste'; text: string }
  /** The held read turned out to be the Escape key itself. */
  | { kind: 'escape' }
  /** A device reply (cursor position) — input to the prober, never to an owner. */
  | { kind: 'reply'; sequence: string }

export interface InputReaderOptions {
  /** A read that survived decoding and reply filtering. */
  onRead: (text: string) => void
  /** A frame the Reader produced on its own: paste traffic, or a released hold. */
  onFrame: (frame: InputFrame) => void
  /**
   * How long a stalled paste may hold the reader before it is abandoned.
   *
   * A seam for tests only — the default is the release value. A test that waited the
   * real two seconds kept a whole file's process alive alongside the others and was
   * enough to unbalance a timer-sensitive paint test on a Windows runner.
   */
  pasteMarkerHoldMs?: number
}

/** Whether `text` is exactly one complete terminal unit (shape, not meaning). */
const COMPLETE_CSI = /^\x1b\[[0-9;?<]*[ -/]*[@-~]$/u
const COMPLETE_SS3 = /^\x1bO[@-~]$/u
/** The same shapes, anchored at the start: one complete unit of a longer read. */
const COMPLETE_CSI_AT = /^\x1b\[[0-9;?<]*[ -/]*[@-~]/u
const COMPLETE_SS3_AT = /^\x1bO[@-~]/u
/**
 * `ESC` plus one printable character: the Alt chord.
 *
 * Not `[ -~]` alone: a terminal can send Alt with any character it can encode, and the
 * chord has to reach the Alt branch in one piece or its character leaks as text.
 */
const ALT_CHORD_AT = /^\x1b(?!\[|O)[^\x00-\x1f\x7f]/u

const PASTE_MARKERS = ['\x1b[200~', '\x1b[201~'] as const

/**
 * How long a paste may sit with half a marker before the reader gives up on it.
 *
 * This is a watchdog, not a key hold: a paste is a stream, and its close marker may
 * arrive in a second chunk after a slow terminal, a ConPTY or a loaded runner — on
 * Windows CI the gap was over 200 ms, and expiring that early typed the marker's tail
 * into the draft and left the session inside the paste. So the window is generous.
 * When it does expire the reader does not just release the tail as payload, it
 * **leaves the paste**: a paste that never closed must not keep the keyboard as its
 * payload for the rest of the session.
 */
export const PASTE_MARKER_HOLD_MS = 2_000

/**
 * The length of the longest suffix of `text` that is a *proper* prefix of a paste
 * marker (0 when there is none) — what a read cut in half leaves behind.
 */
function pasteMarkerSuffix(text: string): number {
  const longest = Math.max(...PASTE_MARKERS.map(marker => marker.length)) - 1
  for (let length = Math.min(longest, text.length); length > 0; length -= 1) {
    const suffix = text.slice(text.length - length)
    if (PASTE_MARKERS.some(marker => marker.startsWith(suffix))) return length
  }
  return 0
}

export class InputReader {
  private readonly decoder = new StringDecoder('utf8')
  private readonly guard: TerminalInputGuard
  /** A read that may still grow (escape assembly). */
  private held = ''
  private holdTimer: ReturnType<typeof setTimeout> | undefined
  /** Inside `ESC[200~ … ESC[201~`. */
  private inPaste = false
  /**
   * The tail of a read that ended *inside* a paste marker (`…ESC[20`), waiting for
   * its other half.
   */
  private pasteTail = ''
  private pasteTailTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly options: InputReaderOptions) {
    this.guard = new TerminalInputGuard(
      text => this.options.onRead(text),
      undefined,
      // The filter must not mistake a paste's close marker for half a cursor reply.
      { isPasteTraffic: text => this.isPasteTraffic(text) },
    )
  }

  /** One read of bytes: decode it, drop device replies, hand the rest on. */
  push(chunk: Buffer): void {
    const decoded = this.decoder.write(chunk)
    if (decoded === '') return
    this.guard.push(decoded)
  }

  /** The read with any held prefix in front of it. The hold window is over. */
  assemble(text: string): string {
    const combined = this.held + text
    this.held = ''
    this.cancelHold()
    return combined
  }

  /**
   * The frames of one read, whichever kind it is.
   *
   * A read is what the terminal happened to send, not what the reader pressed: a
   * fast typist, a slow link or ConPTY can put several keys in one read. This is the
   * one place that decides where one unit ends and the next begins; everything above
   * it (Router, owners) sees complete units only, and nothing above it re-parses the
   * bytes (AD-20 §4.4, §6).
   */
  read(text: string): InputFrame[] {
    const combined = this.pasteTail === '' ? text : `${this.pasteTail}${text}`
    if (this.pasteTail !== '') {
      this.pasteTail = ''
      this.cancelPasteTail()
    }
    if (!this.isPasteTraffic(combined)) return this.units(combined)
    const { frames, tail } = this.framePaste(combined)
    this.pasteTail = tail
    // Armed for the whole paste, not just for a held tail: a terminal can swallow the
    // close marker outright (ConPTY drops a partial CSI), and a paste that never says
    // it ended must not keep the keyboard as its payload.
    if (this.inPaste || tail !== '') this.armPasteTail()
    else this.cancelPasteTail()
    return frames
  }

  /**
   * Frame one paste read, holding back a marker it cut in half.
   *
   * A terminal writes bytes, not reads: `ESC[201~` can arrive as `…ESC[20` and `1~`.
   * Framed naively, the first read swallows `ESC[20` as payload and the second one
   * carries no marker at all — so `inPaste` never clears and **every later key is
   * pasted text**: Esc stops closing a dialog, `/exit` stops exiting. Found by
   * `scripts/tui-paste-probe.mjs` on CI, where the pty chunked the write exactly
   * there. The fix is the same rule the escape ladder already uses — a read that
   * could still grow is held, and released as payload if its other half never comes.
   */
  private framePaste(combined: string): { frames: InputFrame[]; tail: string } {
    const keep = pasteMarkerSuffix(combined)
    if (keep === 0) return { frames: this.frames(combined), tail: '' }
    const body = combined.slice(0, combined.length - keep)
    return { frames: this.frames(body), tail: combined.slice(combined.length - keep) }
  }

  /**
   * Release a held paste tail, on the window its content deserves.
   *
   * A tail that is **only** `ESC` is not paste text: it is either the start of a
   * marker whose other half never came, or the Escape key the reader pressed while
   * the paste was still open. Holding it for the marker window turned it into a
   * `paste` frame (or a `literal`) two seconds later — the key was gone either way,
   * which is how a picker whose paste lost its close marker stayed open and a CI
   * probe timed out waiting for the workspace. So a bare `ESC` gets the *Escape*
   * disambiguation window, and it is released as the key. A longer tail (`ESC[20`)
   * keeps the marker window: only it can still become a marker.
   */
  private armPasteTail(): void {
    this.cancelPasteTail()
    const configured = this.options.pasteMarkerHoldMs ?? PASTE_MARKER_HOLD_MS
    const onlyEscape = this.pasteTail === '\x1b'
    this.pasteTailTimer = setTimeout(() => {
      this.pasteTailTimer = undefined
      const pending = this.pasteTail
      this.pasteTail = ''
      // Its other half never came. Those bytes are what the reader pasted, and the
      // paste they belonged to is over: leaving `inPaste` set here is what turned a
      // slow (or swallowed) marker into a session that ignored every key.
      if (pending === '\x1b') {
        this.inPaste = false
        this.options.onFrame({ kind: 'escape' })
        return
      }
      if (pending !== '') this.options.onFrame({ kind: this.inPaste ? 'paste' : 'literal', text: pending })
      this.inPaste = false
    }, onlyEscape ? Math.min(configured, ESCAPE_HOLD_MS) : configured)
  }

  private cancelPasteTail(): void {
    if (this.pasteTailTimer !== undefined) clearTimeout(this.pasteTailTimer)
    this.pasteTailTimer = undefined
  }

  /**
   * One non-paste read, split into complete units.
   *
   * The rules, and why each one exists:
   *
   *   - **A complete CSI/SS3 sequence is one unit.** `ESC [ 5 ~ ESC [ 5 ~` is two page
   *     keys, not one unnameable read (G-1). A sequence the read cuts short stays one
   *     piece: `hold()` has already claimed it if it could still grow, and a trailing
   *     `ESC [` must reach the hold again rather than be split into `ESC` + `[`.
   *   - **An Alt chord is one unit.** `ESC` plus exactly one printable character is
   *     Alt+that key, so `ESC 1 x` is the chord Alt+1 *and then* `x` — never the text
   *     `1x` (G-3), and never a chord that swallows the character behind it.
   *   - **A control byte is one unit, CR/LF pair as one Enter.** `\x10\x10` is two
   *     presses of a rebound key (G-2/G-8), and Windows' CRLF is one key.
   *   - **A run of ordinary characters is one unit.** Splitting typing per character
   *     would make a pasted `yes` answer a confirm dialog character by character,
   *     which is the boundary W-0 pinned (`yes-typed-at-dialog`). Keymap lookup on a
   *     whole run is still exactly what a run means: text.
   *   - **A burst the paste heuristic claims stays whole.** A console without
   *     bracketed paste sends a paste as ordinary bytes with line breaks in them;
   *     that read has to reach the paste path intact (`looksLikePasteBurst`).
   */
  units(text: string): InputFrame[] {
    if (InputReader.looksLikePasteBurst(text)) return [{ kind: 'burst', text }]
    const frames: InputFrame[] = []
    let index = 0
    while (index < text.length) {
      const char = text[index]
      if (char === '\x1b') {
        const rest = text.slice(index)
        const sequence = COMPLETE_CSI_AT.exec(rest)?.[0] ?? COMPLETE_SS3_AT.exec(rest)?.[0]
        if (sequence !== undefined) {
          frames.push({ kind: 'key', sequence })
          index += sequence.length
          continue
        }
        // Something that could still grow into a sequence — `ESC [ 5` with its final
        // byte in the next read, a mouse report cut in half — goes on as one piece, so
        // the hold below claims exactly what it claimed before: splitting it here would
        // turn the head of a sequence into an Alt chord and type its tail as text.
        if (isEscapePrefix(rest)) {
          frames.push({ kind: 'key', sequence: rest })
          index += rest.length
          continue
        }
        const chord = ALT_CHORD_AT.exec(rest)?.[0]
        if (chord !== undefined) {
          frames.push({ kind: 'key', sequence: chord })
          index += chord.length
          continue
        }
        // A lone ESC, or something that cannot grow: its own unit, and the hold decides.
        frames.push({ kind: 'key', sequence: '\x1b' })
        index += 1
        continue
      }
      if (char === '\r' || char === '\n') {
        const next = text[index + 1]
        frames.push({ kind: 'key', sequence: char === '\n' ? '\n' : '\r' })
        index += (char === '\r' && next === '\n') || (char === '\n' && next === '\r') ? 2 : 1
        continue
      }
      if (char < ' ' || char === '\x7f') {
        frames.push({ kind: 'key', sequence: char })
        index += 1
        continue
      }
      let end = index
      while (end < text.length && text[end] >= ' ' && text[end] !== '\x7f' && text[end] !== '\x1b') end += 1
      frames.push({ kind: 'burst', text: text.slice(index, end) })
      index = end
    }
    return frames
  }

  /**
   * Whether a read is paste traffic: inside a paste, or carrying a marker.
   *
   * Asked before anything else, exactly as the inline check it replaces was: while
   * inside a paste, CR/LF are literal characters rather than submit.
   */
  isPasteTraffic(combined: string): boolean {
    return this.inPaste || combined.includes('\x1b[200~') || combined.includes('\x1b[201~')
  }

  /**
   * The frames of one paste read, in order: payload inside the markers as `paste`,
   * everything outside them as `literal` (which is what the inline version typed
   * directly, without a keymap lookup).
   *
   * Only complete markers are handled here: `framePaste` holds back a read that ends
   * inside one, because a marker whose two halves land in two reads would otherwise
   * leave the reader inside the paste for the rest of the session.
   */
  frames(combined: string): InputFrame[] {
    const frames: InputFrame[] = []
    let index = 0
    while (index < combined.length) {
      if (combined.startsWith('\x1b[200~', index)) {
        this.inPaste = true
        index += 6
        continue
      }
      if (combined.startsWith('\x1b[201~', index)) {
        this.inPaste = false
        index += 6
        continue
      }
      let end = index
      while (end < combined.length
        && !combined.startsWith('\x1b[200~', end)
        && !combined.startsWith('\x1b[201~', end)) {
        end += 1
      }
      if (end > index) {
        const part = combined.slice(index, end)
        frames.push(this.inPaste ? { kind: 'paste', text: part } : { kind: 'literal', text: part })
        index = end
      } else {
        index += 1
      }
    }
    return frames
  }

  /**
   * Keep a read that could still grow into a sequence.
   * @returns true when it was held (the caller stops there), false when the read is
   *   complete as it stands.
   */
  hold(combined: string): boolean {
    if (!isEscapePrefix(combined)) return false
    this.held = combined
    this.cancelHold()
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined
      const pending = this.held
      this.held = ''
      this.releaseHold(pending)
    }, ESCAPE_HOLD_MS)
    return true
  }

  /**
   * Whether one read is a paste from a console that cannot say so.
   *
   * A burst carrying more than one line break is not a human pressing Enter twice —
   * they cannot press it twice inside one read. This is the fallback's one rule, and
   * it lives here so every caller applies the same one.
   */
  static looksLikePasteBurst(text: string): boolean {
    let breaks = 0
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index]
      if (char === '\r' && text[index + 1] !== '\n') breaks += 1
      else if (char === '\n' && text[index - 1] !== '\r') breaks += 1
      if (breaks > 1) return true
    }
    return false
  }

  /** Whether a complete read is a device reply rather than input. */
  isDeviceReply(text: string): boolean {
    return parseCursorPositionReply(text) !== undefined
  }

  /** Classify one complete read by shape. */
  classify(text: string): InputFrame {
    if (this.isDeviceReply(text)) return { kind: 'reply', sequence: text }
    if (text === '\x1b') return { kind: 'key', sequence: text }
    if (text.length === 1) {
      const code = text.codePointAt(0) ?? 0
      return code < 0x20 || code === 0x7f ? { kind: 'key', sequence: text } : { kind: 'burst', text }
    }
    if (COMPLETE_CSI.test(text) || COMPLETE_SS3.test(text)) return { kind: 'key', sequence: text }
    return { kind: 'burst', text }
  }

  /**
   * Hand over a held reply tail now.
   *
   * The guard releases on its own window; this is for a caller that already knows
   * the tail is stale — `scripts/bench-b2.mjs` drives keystrokes faster than the
   * hold, and a measurement that waited for the window would be measuring the wait.
   */
  releaseReplyTail(): void {
    this.guard.release()
  }

  /** Drop the holds and the reply filter (display detached, teardown). */
  stop(): void {
    this.cancelHold()
    this.cancelPasteTail()
    this.pasteTail = ''
    this.guard.stop()
  }

  private cancelHold(): void {
    if (this.holdTimer !== undefined) clearTimeout(this.holdTimer)
    this.holdTimer = undefined
  }

  /**
   * What a held read turned out to be.
   *
   * Verbatim from the inline timer it replaces: a lone `ESC` is the Escape key, an
   * `ESC O` without its final byte is Alt+O, an escape sequence that never completed
   * is consumed silently (its `ESC` must not read as a cancel), and anything else is
   * typed. The last branch is unreachable for the shapes `isEscapePrefix` accepts —
   * it is kept because "unreachable today" is not a reason to change a release.
   */
  private releaseHold(pending: string): void {
    if (pending === '\x1b') {
      this.options.onFrame({ kind: 'escape' })
      return
    }
    if (pending === '\x1bO') {
      this.options.onFrame({ kind: 'literal', text: 'O' })
      return
    }
    if (pending.startsWith('\x1b[') || pending.startsWith('\x1bO')) return
    if (pending !== '') this.options.onFrame({ kind: 'literal', text: pending })
  }
}
