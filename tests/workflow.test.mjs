import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The workflow file is code that only GitHub parses.
 *
 * A bad edit there does not fail a step — it produces a run named after the
 * *file path* with zero jobs, which reads as an infrastructure hiccup rather
 * than "your YAML is wrong". That happened here: inserting a step before an
 * existing step's `run:` line left that step with two `run:` keys. PyYAML
 * accepts the duplicate and keeps the last one, so a local parse looked fine.
 * This test parses the way GitHub does not forgive: duplicates are fatal.
 */
const WORKFLOW = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'workflows', 'ci.yml')

/**
 * The file as GitHub sees it, whatever this checkout's line endings are.
 *
 * A Windows checkout is CRLF (`core.autocrlf`), and every check below is
 * line-based, so an un-normalized read finds no jobs at all — which is exactly
 * how this test failed on the Windows leg the first time it ran there.
 */
function readWorkflow() {
  return readFileSync(WORKFLOW, 'utf8').replaceAll('\r\n', '\n')
}

/** Parse YAML, refusing duplicate mapping keys (which GitHub rejects outright). */
function parseStrict(text) {
  // A hand-rolled reader for the subset this file uses would hide the very
  // indentation mistakes being checked for, so this uses the same parser the
  // rest of the toolchain does and adds the duplicate check on top.
  return import('yaml').then(mod => mod.parse(text, {
    uniqueKeys: true,
    prettyErrors: true,
  })).catch(error => {
    // `yaml` is not a dependency; fall back to a structural check that needs none.
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
    return undefined
  })
}

/** The job names the workflow defines (everything under its `jobs:` key). */
function jobNames(text) {
  const lines = text.split('\n')
  const jobsAt = lines.findIndex(line => line === 'jobs:')
  if (jobsAt === -1) return []
  const names = []
  for (let index = jobsAt + 1; index < lines.length; index += 1) {
    const match = /^ {2}([a-z][a-z0-9-]*):$/u.exec(lines[index])
    if (match !== null) names.push(match[1])
  }
  return names
}

/** Steps of one job, from the indentation, without needing a YAML parser. */
function jobStepBlocks(text, job) {
  const lines = text.split('\n')
  const start = lines.findIndex(line => line === `  ${job}:`)
  if (start === -1) return []
  const blocks = []
  let current
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^ {2}\S/u.test(line)) break
    if (/^ {6}- /u.test(line)) {
      if (current !== undefined) blocks.push(current)
      current = [line]
      continue
    }
    if (current !== undefined) current.push(line)
  }
  if (current !== undefined) blocks.push(current)
  return blocks.map(block => block.join('\n'))
}

test('every workflow step has exactly one run/uses, so GitHub can parse it', () => {
  const text = readWorkflow()
  const jobs = jobNames(text)
  assert.ok(jobs.length > 0, 'the workflow must define jobs')
  for (const job of jobs) {
    const blocks = jobStepBlocks(text, job)
    assert.ok(blocks.length > 0, `job ${job} must have steps`)
    for (const block of blocks) {
      // `- uses: …` puts the key on the bullet line; continuation keys are indented.
      const runs = (block.match(/^\s*(?:- )?run:/gmu) ?? []).length
      const uses = (block.match(/^\s*(?:- )?uses:/gmu) ?? []).length
      const name = /^\s+- name:\s*(.+)$/mu.exec(block)?.[1] ?? block.split('\n')[0].trim()
      assert.ok(
        runs + uses === 1,
        `step ${JSON.stringify(name)} in job ${job} must have exactly one run/uses, `
        + `got run=${runs} uses=${uses} — a second one means a step lost its body:\n${block}`,
      )
    }
  }
})

test('the Windows leg drives the real TUI, not just the unit suite', () => {
  // The three Windows bugs this repo shipped were all in code no Windows run
  // ever executed. Losing this step would quietly restore that gap.
  const text = readWorkflow()
  const windows = jobStepBlocks(text, 'test-windows').join('\n')
  assert.match(windows, /probe-home\.mjs --probe/u, 'the boot probe must run on Windows')
  assert.match(windows, /tui-drop-probe\.mjs/u, 'and the drop/reattach probe')
  // "The Host outlives a closed window" was hand-verified on one desktop before
  // this step existed; a ConPTY teardown mid-turn is the only place a Windows
  // run can still falsify it.
  assert.match(
    windows,
    /tui-mock-probe\.mjs --busy/u,
    'and the busy-drop probe, which is where the Host surviving a closed window is asserted',
  )
})

test('only the non-default legs rewrite the manifest, and the default one is declared', async () => {
  // `package.json` commits one host line, and exactly the legs that are *not*
  // that line rewrite it before installing. Losing the guard (or leaving the
  // committed manifest on a line no leg installs unchanged) would make a green
  // run mean nothing: the suite would be verifying a tree nobody ships.
  const text = readWorkflow()
  const lines = /dsh: \[([^\]]*)\]/u.exec(text)?.[1]
    ?.split(',').map(entry => entry.trim().replaceAll('"', '')).filter(entry => entry !== '')
  assert.ok(lines !== undefined && lines.length >= 2, 'the matrix must keep more than one leg')
  const pinStep = jobStepBlocks(text, 'test')
    .find(block => /^\s*(?:- )?run:/mu.test(block) && block.includes('ci-pin-line.mjs'))
  assert.ok(pinStep !== undefined, 'the workflow must rewrite the manifest through the script')
  const guard = /if: matrix\.dsh != '([^']+)'/u.exec(pinStep)?.[1]
  assert.ok(guard !== undefined, 'the pin step must exclude exactly the default line')
  assert.equal(lines.filter(line => line === guard).length, 1, 'exactly one leg installs the manifest unchanged')
  const { DEFAULT_LINE } = await import('../scripts/ci-pin-line.mjs')
  assert.equal(guard, DEFAULT_LINE, 'the leg the guard exempts is the line package.json commits')
  assert.ok(lines.includes(DEFAULT_LINE), 'and it has a leg of its own')
})

test('a CRLF checkout parses the same as an LF one', () => {
  // Pinned because this is how the test itself broke on Windows: the checks are
  // line-based, and `readWorkflow` is what keeps a CRLF checkout from finding
  // zero jobs. Build the CRLF form from the normalized text — converting a file
  // that is *already* CRLF doubles the carriage returns instead.
  const lf = readWorkflow()
  const crlf = lf.replaceAll('\n', '\r\n')
  assert.equal(jobNames(crlf).length, 0, 'an un-normalized CRLF read finds no jobs, which is the bug')
  assert.deepEqual(jobNames(crlf.replaceAll('\r\n', '\n')), jobNames(lf))
  assert.ok(jobStepBlocks(crlf.replaceAll('\r\n', '\n'), 'test-windows').length > 0)
})

test('the workflow is valid YAML when a parser is available', async () => {
  const text = readWorkflow()
  const parsed = await parseStrict(text)
  if (parsed === undefined) return // no yaml dependency in this checkout
  assert.ok(parsed.jobs !== undefined, 'the workflow must keep its jobs')
})
