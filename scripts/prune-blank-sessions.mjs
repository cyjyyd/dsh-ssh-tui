#!/usr/bin/env node
/**
 * Delete session artifacts that never saw user input.
 *
 * Every fresh TUI start creates a session, so quitting before typing leaves an
 * artifact behind. The picker hides those and the `/cleanup` command deletes
 * them, but both need a running host — this script does the same job against
 * `$DSH_HOME/sessions` directly, which is what you want after a batch of
 * aborted launches (and what the `/cleanup` command was written to make
 * unnecessary).
 *
 * The blank rule is **not** re-implemented here: it is imported from
 * `lib/session-blank.js`, the same module the picker and the TUI use, so the
 * three can never disagree about what "empty" means. A session with an open turn,
 * a reply, or an unreadable log is kept.
 *
 *     node scripts/prune-blank-sessions.mjs              # report only
 *     node scripts/prune-blank-sessions.mjs --delete     # delete
 *     node scripts/prune-blank-sessions.mjs --delete --sessions /path/to/sessions
 *
 * Logs are zstd-compressed JSONL; the `zstd` binary must be on PATH (it is what
 * the host writes them with). A log that cannot be decoded counts as unreadable
 * and is kept — never guessed at.
 *
 * @module dsh-ssh-tui/scripts/prune-blank-sessions
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'

import { sessionEventsAreBlank } from '../lib/session-blank.js'

/** `$DSH_HOME/sessions`, resolved the way the host resolves `$DSH_HOME`. */
function defaultSessionsDir() {
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.dsh')
  return join(home, 'sessions')
}

/**
 * The log file names the host has used, newest first.
 *
 * Three generations are on disk on any long-lived machine (`session.jsonl.zstd`,
 * `session.v3.jsonl.zstd`, `session.v4.jsonl.zstd`). They are read the same way:
 * the blank rule only looks at `type` and `data`, which all three share.
 */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']

/** Decode one session log into its events, or undefined when it cannot be read. */
function readEvents(path) {
  try {
    const raw = execFileSync('zstd', ['-dc', path], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
    const events = []
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // A truncated final line is normal for a live writer; the events read so
        // far still decide whether the session did anything.
      }
    }
    return events
  } catch {
    return undefined
  }
}

function main(argv) {
  const remove = argv.includes('--delete')
  const allFormats = argv.includes('--all-formats')
  const at = argv.indexOf('--sessions')
  const root = at === -1 ? defaultSessionsDir() : argv[at + 1]
  if (root === undefined) {
    process.stderr.write('usage: node scripts/prune-blank-sessions.mjs [--delete] [--sessions <dir>]\n')
    return 2
  }
  if (!existsSync(root)) {
    process.stdout.write(`no sessions directory at ${root}\n`)
    return 0
  }

  let scanned = 0
  let blank = 0
  let kept = 0
  let unreadable = 0
  let bytes = 0
  let olderFormats = 0
  let failed = 0
  for (const project of readdirSync(root)) {
    const projectDir = join(root, project)
    if (!statSync(projectDir).isDirectory()) continue
    for (const session of readdirSync(projectDir)) {
      const sessionDir = join(projectDir, session)
      if (!statSync(sessionDir).isDirectory()) continue
      const log = LOG_NAMES.map(name => join(sessionDir, name)).find(path => existsSync(path))
      if (log === undefined) {
        // No log at all: an in-flight launch that has not materialized yet.
        // Never a deletion candidate — guessing here is how a live session's
        // directory gets removed.
        unreadable += 1
        continue
      }
      scanned += 1
      const events = readEvents(log)
      if (events === undefined) {
        unreadable += 1
        continue
      }
      if (!sessionEventsAreBlank(events)) {
        kept += 1
        continue
      }
      blank += 1
      const size = statSync(log).size
      bytes += size
      if (remove && !allFormats && !log.endsWith('session.v4.jsonl.zstd')) {
        // Older generations are reported, never deleted by default: they predate
        // the format the picker prunes, and a machine's older logs are the ones
        // most likely to hold work someone still wants. `--all-formats` opts in.
        process.stdout.write(`blank (older format) ${sessionDir}\n`)
        olderFormats += 1
        continue
      }
      if (remove) {
        try {
          rmSync(sessionDir, { recursive: true, force: true })
          process.stdout.write(`deleted  ${sessionDir}\n`)
        } catch (error) {
          // A directory we may not remove (permissions, a read-only mount) must
          // not abort the sweep: report it and keep going, so one locked session
          // cannot stop the machine from being tidied.
          failed += 1
          process.stdout.write(`FAILED   ${sessionDir}: ${error.message}\n`)
        }
      } else {
        process.stdout.write(`would delete ${sessionDir} (${Math.round(size / 1024)}kB)\n`)
      }
    }
  }
  const removed = blank - failed
  const verb = remove ? `${removed} deleted${failed > 0 ? ` (${failed} failed)` : ''}` : `${blank} would be deleted`
  process.stdout.write(`\nscanned ${scanned} · ${verb} · kept ${kept} · unreadable ${unreadable} (${Math.round(bytes / 1024)}kB)\n`)
  if (failed > 0) process.stdout.write(`${failed} session(s) could not be removed (permissions or a read-only mount)\n`)
  if (olderFormats > 0) {
    process.stdout.write(`${olderFormats} blank session(s) predate the current log format and were only reported\n`)
  }
  if (!remove && blank > 0) process.stdout.write('run again with --delete to remove them\n')
  return 0
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main(process.argv.slice(2)))
}
