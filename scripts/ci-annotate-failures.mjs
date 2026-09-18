/**
 * Turn a TAP test run into workflow annotations.
 *
 * `node --test` fails the step with exit code 1, and the checks UI then shows
 * only "Process completed with exit code 1" — the names of the failing tests
 * live in the step log, which needs a signed-in reader. This script reads the
 * TAP stream the test step wrote to disk and re-emits each failure as an
 * `::error::` line, which GitHub lifts into the checks UI (and the public
 * annotations API) next to the test file it came from.
 *
 * Usage: node scripts/ci-annotate-failures.mjs [test-output.txt]
 */

import { readFileSync } from 'node:fs'

const MAX_ANNOTATIONS = 20

/** Escape the characters GitHub reserves inside a workflow command payload. */
function escapeData(text) {
  return text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
}

/** The test file a TAP block points at, as a repo-relative path. */
function testFileOf(location) {
  const match = /(?:^|\/)tests\/([^\s:]+\.test\.mjs)/u.exec(location)
  return match === null ? '' : `tests/${match[1]}`
}

/** Read one `not ok` block: its test file and the head of its error message. */
function readFailure(lines, start) {
  const failure = { name: '', file: '', detail: '' }
  for (let at = start + 1; at < lines.length && at < start + 60; at += 1) {
    const line = lines[at] ?? ''
    if (/^(?:not )?ok \d+ - /u.test(line.trim())) break
    const location = /^\s*location: '(.+)'$/u.exec(line)
    if (location !== null && failure.file === '') failure.file = testFileOf(location[1] ?? '')
    if (/^\s*error: \|-/u.test(line) && failure.detail === '') {
      for (let body = at + 1; body < lines.length; body += 1) {
        const text = lines[body] ?? ''
        if (text.trim() === '') continue
        if (!/^\s{4,}\S/u.test(text)) break
        failure.detail = text.trim()
        break
      }
    }
  }
  return failure
}

function main() {
  const path = process.argv[2] ?? 'test-output.txt'
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    console.log(`no ${path}: nothing to annotate`)
    return
  }
  const lines = raw.split('\n')
  const failures = []
  for (const [at, line] of lines.entries()) {
    const failed = /^not ok \d+ - (.+)$/u.exec(line.trim())
    if (failed === null) continue
    const failure = readFailure(lines, at)
    failure.name = (failed[1] ?? '').trim()
    failures.push(failure)
  }
  const summary = lines
    .map(line => /^# (tests|pass|fail|skipped) (\d+)$/u.exec(line.trim()))
    .filter(match => match !== null)
    .map(match => `${match[1]} ${match[2]}`)
    .join(' · ')
  console.log(`TAP: ${summary === '' ? 'no summary' : summary}`)
  if (failures.length === 0) {
    console.log('no failing test in the TAP stream')
    return
  }
  for (const failure of failures.slice(0, MAX_ANNOTATIONS)) {
    const where = failure.file === '' ? '' : ` file=${failure.file}`
    const text = failure.detail === '' ? failure.name : `${failure.name}: ${failure.detail}`
    console.log(`::error${where}::${escapeData(text)}`)
  }
  if (failures.length > MAX_ANNOTATIONS) {
    console.log(`::error::…and ${failures.length - MAX_ANNOTATIONS} more failing tests (see the step log)`)
  }
}

main()
