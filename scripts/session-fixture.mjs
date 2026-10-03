#!/usr/bin/env node
/**
 * A durable session log with history, for the probes that need a *load window*.
 *
 * Why this exists: several product promises only exist while a resumed session is
 * rebuilding its log — the screen must keep showing what the launcher is showing
 * instead of going blank, and the link chip has to come up measured rather than
 * sitting on its placeholder. Both are *timing* promises, and a session with one
 * turn of history rebuilds too fast to test either. A model turn would give real
 * history, but a durable log big enough to take seconds is thousands of events,
 * and a probe may not spend tokens or a provider key.
 *
 * So the probe writes the artifact itself. It is deliberately small about how:
 * the layout and the zstd framing here are the harness's storage contract, not
 * ours, so the caller must treat a failure to read it as its own failure — a
 * fixture the harness refuses to load is a red probe, never a skip (the resumed
 * window says "stored log is corrupt: …" and the caller asserts on the transcript
 * it asked for).
 *
 * Verified against `dsh-session-persistence-jsonl` 0.1.0-rc.7:
 *   `sessions/--<cwd slug>--/<id>/session.v4.jsonl.zstd`
 *   one zstd frame for the header line, then the event lines;
 *   `user/message` is a surface event, so each row carries `surfaceOp: 'append'`
 *   and a message with `id` / `role` / `source` / `content`.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

/**
 * The harness's project directory key: separators collapse to one `-`, unsafe
 * code units become `~XXXX`, and the whole thing is wrapped in `--…--`.
 */
export function projectKey(cwd) {
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/u.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, '0')}`
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/u, '') || 'root').slice(0, 251)}--`
}

/**
 * Write a session whose log holds `count` user messages.
 *
 * @param home - `DSH_HOME` the session belongs to.
 * @param id - the session id to write (the probes own the name they probe).
 * @param options.events - how many `user/message` rows to append.
 * @param options.cwd - the project directory the session belongs to.
 * @param options.text - one line of text per event; `{n}` is the index.
 * @returns the artifact path.
 */
export function writeSessionWithHistory(home, id, options = {}) {
  const count = Math.max(1, options.events ?? 4_000)
  const cwd = options.cwd ?? process.cwd()
  const text = options.text ?? 'synthetic event {n}'
  const now = Date.now()
  const lines = [
    JSON.stringify({
      type: 'session',
      version: 4,
      id,
      createdAt: now,
      cwd,
      isSeeded: false,
      delegationDepth: 0,
    }),
  ]
  for (let seq = 0; seq < count; seq += 1) {
    lines.push(JSON.stringify({
      type: 'user/message',
      seq,
      time: now,
      // A surface event without its operation marker is a corrupt log, not a row
      // to skip: the harness rejects the whole artifact.
      surfaceOp: 'append',
      data: {
        id: `synthetic-${seq}`,
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: text.replace('{n}', String(seq)) }],
      },
    }))
  }
  const dir = join(home, 'sessions', projectKey(cwd), id)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'session.v4.jsonl.zstd')
  // The reader wants the header alone in the first frame (that is how it reads
  // the format version before validating anything), the events after it.
  writeFileSync(path, Buffer.concat([
    zstdCompressSync(Buffer.from(`${lines[0]}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${lines.slice(1).join('\n')}\n`, 'utf8')),
  ]))
  return path
}
