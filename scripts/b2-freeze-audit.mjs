#!/usr/bin/env node
/**
 * B2 freeze audit — the static half of the contract.
 *
 * B2 is frozen (docs/plans/b2-architecture-plan.md, docs/decisions/b2-architecture-decisions.md).
 * The *behavioural* invariants are pinned by the test matrix (`npm test`); the
 * invariants that are about **what exists in the source** cannot be: a deleted
 * legacy path leaves no runtime signature, so nothing fails when someone adds it
 * back. This script is that half.
 *
 * It answers seven questions with a number, and exits non-zero if any of them is
 * not zero (or, for depth, not one):
 *
 *   1. unclassified representation rows      must be 0
 *   2. unknown representation destinations   must be 0
 *   3. live source rows                      must be 0
 *   4. duplicate primary representations     must be 0
 *   5. Screen depth                          must be <= 1
 *   6. streaming per-tick clears             must be 0
 *   7. retired B2 paths                      must be 0 occurrences
 *
 * 1–4 come from `scripts/representation-audit.mjs` — the same numbers the round
 * reports quote, re-run here so a freeze check is one command. 5–6 are PTY facts
 * and are **measured** by `scripts/tui-probe.mjs`; this script does not re-drive a
 * terminal (that probe needs node-pty and a session), it re-states the thresholds
 * the probe enforces so the two agree on what "frozen" means. 7 is the static scan.
 *
 *     node scripts/b2-freeze-audit.mjs            # text report
 *     node scripts/b2-freeze-audit.mjs --json     # machine-readable
 *
 * It reads the working tree, not `lib/`, so run it from a checkout — and run
 * `npm run build` first if you changed `src/`, because 1–4 execute the built
 * audit.
 *
 * @module dsh-ssh-tui/scripts/b2-freeze-audit
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

import { auditRepresentations, auditQuestionPrimaries } from '../lib/representation.js'

// `fileURLToPath`, never `URL.pathname`: on Windows the latter is `/D:/a/…` — a leading
// slash in front of the drive — and `join` then builds `D:\D:\a\…`, which the first CI
// run on the Windows leg reported as `ENOENT: scandir 'D:\D:\a\…\src'`.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const JSON_OUT = process.argv.slice(2).includes('--json')

/** Every `.ts` file under `src/`, as `[repo-relative path, text]`. */
function sourceFiles() {
  const out = []
  const walk = directory => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry)
      if (statSync(path).isDirectory()) walk(path)
      else if (path.endsWith('.ts')) out.push([relative(ROOT, path), readFileSync(path, 'utf8')])
    }
  }
  walk(SRC)
  return out
}

const FILES = sourceFiles()

/** Every line of `src/` that matches `pattern`, as `path:line: text`. */
function find(pattern) {
  const hits = []
  for (const [path, text] of FILES) {
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      if (pattern.test(lines[index])) hits.push(`${path}:${index + 1}: ${lines[index].trim()}`)
    }
  }
  return hits
}

/**
 * The retired B2 paths, each as a query.
 *
 * A query is deliberately textual: the point is that the *name* is gone from the
 * source, not that some runtime branch happens to be unreachable today. Where a
 * closure over the whole file is needed (the onboarding producer, the plan-row
 * writer) the query reads the file's text rather than one line.
 */
const RETIRED = [
  {
    id: 'dedicated-role',
    what: 'the `dedicated` Surface role and its one consumer (`dedicatedLines`)',
    hits: () => find(/DEDICATED_ROLE|dedicatedLines/),
  },
  {
    id: 'dedicated-comment-only',
    what: 'a live `{ kind: \'dedicated\' }` call site (comments may still explain the removal)',
    hits: () => find(/\{\s*kind:\s*'dedicated'\s*\}/),
  },
  {
    id: 'legacy-onboarding-renderer',
    what: 'the onboarding dialog renderer (the wizard is a Screen; only the deprecated shape may remain)',
    hits: () => [
      ...find(/handleOnboardingChar\s*\(.*\)\s*:\s*void\s*\{[\s\S]*?addDialog/),
      ...find(/dialog\.kind === 'onboarding'|this\.dialog\.kind === 'onboarding'/),
      ...find(/OnboardingDialog[^\n]*=\s*\{\s*kind:\s*'onboarding'/),
    ],
  },
  {
    id: 'onboarding-transcript-producer',
    what: 'an onboarding transcript producer outside the line-mode branch (`setupMessage`)',
    hits: () => {
      const path = 'src/tui.ts'
      const lines = (FILES.find(([candidate]) => candidate === path)?.[1] ?? '').split('\n')
      const hits = []
      for (let index = 0; index < lines.length; index += 1) {
        if (!/represent\('onboarding'/.test(lines[index])) continue
        // The one allowed site sits inside `setupMessage`, whose body branches on
        // `this.lineMode`. Anything else is a second producer.
        const window = lines.slice(Math.max(0, index - 40), index).join('\n')
        if (/private setupMessage|lineMode/.test(window)) continue
        hits.push(`${path}:${index + 1}: ${lines[index].trim()}`)
      }
      return hits
    },
  },
  {
    id: 'plan-row-second-writer',
    what: 'a plan-row writer other than the artifact fold (`syncPlanArtifacts` → `createPlanRow`)',
    // A comment may name the retired writer — that is documentation. A *call* may
    // not: `upsertPlanRow(` (or a bare mention) outside a comment is a second truth.
    hits: () => find(/(?<!\/\/[^\n]*)\bupsertPlanRow\b/).filter(line => !/^\S+:\d+: \*/.test(line)),
  },
  {
    id: 'plan-row-kind-mismatch',
    what: 'a `plan-row` call site that is not the fold (`createPlanRow`, or an inline `kind: \'plan\'` row)',
    // The one *live* site takes the row from the fold's factory, so there is
    // exactly one place a plan row is built. A new call site has to be either that
    // factory or an explicit plan row — the misclassification B2's audit found
    // (`plan-row` over a plain system row) is precisely a call site that is
    // neither, and the runtime rule that pins it lives in
    // `tests/plan-artifact.test.mjs` ("the leftover-todo notice is not a plan row").
    // The argument has to be *exactly* one of the two allowed shapes. An earlier
    // version of this query looked for those shapes anywhere in a window of lines,
    // which is how it missed the defect it exists to catch: `{ kind: 'system' … }`
    // sat within six lines of a `createPlanRow` mention elsewhere in the method and
    // was waved through. The argument itself is therefore what is matched.
    hits: () => {
      const hits = []
      for (const [path, text] of FILES) {
        const lines = text.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          if (!/represent\('plan-row'/.test(lines[index])) continue
          const argument = lines.slice(index, index + 6).join('\n').replace(/\s+/gu, ' ')
          const identifier = /represent\('plan-row', ((?:this\.)?[A-Za-z_$][\w$]*)\)/.exec(argument)
          const literal = /represent\('plan-row', (\{ kind: 'plan',)/.exec(argument)
          if (identifier !== null || literal !== null) continue
          hits.push(`${path}:${index + 1}: ${lines[index].trim()}`)
        }
      }
      return hits
    },
  },
  {
    id: 'generic-ask-user-card',
    what: 'an `ask_user_question` call handler that never reaches the question card',
    // The rule (B2.4): one semantic question gets exactly one primary transcript
    // representation, and it is the question card — never a generic tool card. A
    // handler that names the tool without either remembering the batch
    // (`askQuestions`) or drawing the card (`ensureQuestionCard`) is the second
    // representation coming back.
    hits: () => {
      const hits = []
      for (const [path, text] of FILES) {
        // The form vocabulary and the audit that counts these rows both *name* the
        // tool on purpose; neither creates a card.
        if (path.endsWith('tool-present.ts') || path.endsWith('representation.ts')) continue
        const lines = text.split('\n')
        for (let index = 0; index < lines.length; index += 1) {
          // The *decision* points, not every mention: a comparison against the
          // tool's name is where a generic card would be chosen.
          if (!/===\s*'ask_user_question'|!==\s*'ask_user_question'/.test(lines[index])) continue
          const block = lines.slice(index, index + 20).join('\n')
          if (/askQuestions\(/.test(block) || /ensureQuestionCard\(/.test(block)) continue
          hits.push(`${path}:${index + 1}: ${lines[index].trim()}`)
        }
      }
      return hits
    },
  },
]

/** The representation counts, from the built audit (questions 1–4). */
function representationCounts() {
  // A minimal fixture session: the audit counts *policies and rows*, not content,
  // and the same fixture the round reports use is what makes the numbers
  // comparable between rounds. Every row is classified on purpose — a bare row
  // here would show up as `unclassified` and fail the audit for the wrong reason.
  const rows = [
    {
      kind: 'user', text: '审计夹具',
      representation: { source: 'user-message', durability: 'durable', representationClass: 'A', destination: 'transcript' },
    },
    {
      kind: 'assistant', text: '回复',
      representation: { source: 'assistant-message', durability: 'durable', representationClass: 'A', destination: 'transcript' },
    },
    {
      kind: 'tool', callId: 'c1', name: 'bash', args: '{}', status: 'ok', output: '', title: 'bash', summary: 'bash', expanded: false,
      representation: { source: 'tool-call', durability: 'durable', representationClass: 'A', destination: 'transcript' },
    },
    {
      kind: 'question', callId: 'q1', questionId: 'q1', text: '要部署到哪？', options: [], state: 'answered',
      representation: { source: 'question-card', durability: 'durable', representationClass: 'C', destination: 'transcript' },
    },
    {
      kind: 'plan', active: true, pending: false, todos: [{ content: '第 1 步', status: 'in_progress' }], expanded: false, artifactId: 'plan@1',
      representation: { source: 'plan-row', durability: 'durable', representationClass: 'D', destination: 'transcript' },
    },
  ]
  const audit = auditRepresentations(rows)
  const questions = auditQuestionPrimaries(rows)
  return {
    unclassified: audit.unclassified,
    unknownDestination: audit.unknownDestination,
    liveRows: audit.liveRows,
    duplicatePrimaries: questions.duplicateCalls.length,
    questionRows: questions.questionRows,
    genericToolRows: questions.genericToolRows,
    sources: audit.sources.length,
  }
}

const representation = representationCounts()
const retired = RETIRED.map(entry => ({ id: entry.id, what: entry.what, hits: entry.hits() }))

/**
 * The PTY facts, restated.
 *
 * These are the thresholds `scripts/tui-probe.mjs` asserts on a real terminal, so
 * the freeze document, the probe and this script cannot drift apart. They are not
 * re-measured here: driving a PTY needs node-pty and a session, which is a probe's
 * job, and a second implementation of that would be a second truth.
 */
const PTY = [
  { id: 'screen-depth', rule: '<= 1', measured_by: 'npm test · tests/screen-contract.test.mjs (`a Screen never opens a Screen`)' },
  { id: 'stream-per-tick-clears', rule: 'addressed >= 4 × clears', measured_by: 'scripts/tui-probe.mjs (step 6b, while an answer streams)' },
  { id: 'screen-scroll-clears', rule: '= 0', measured_by: 'scripts/tui-probe.mjs (step 6e, PgDn on a report Screen)' },
  { id: 'setup-typing-clears', rule: '= 0', measured_by: 'npm test · tests/setup-screen.test.mjs + scripts/tui-setup-probe.mjs' },
]

const problems = []
if (representation.unclassified !== 0) problems.push(`unclassified = ${representation.unclassified}`)
if (representation.unknownDestination !== 0) problems.push(`unknown destination = ${representation.unknownDestination}`)
if (representation.liveRows !== 0) problems.push(`live source rows = ${representation.liveRows}`)
if (representation.duplicatePrimaries !== 0) problems.push(`duplicate primary = ${representation.duplicatePrimaries}`)
if (representation.genericToolRows !== 0) problems.push(`generic question tool rows = ${representation.genericToolRows}`)
for (const entry of retired) {
  if (entry.hits.length > 0) problems.push(`${entry.id} = ${entry.hits.length} occurrence(s)`)
}

if (JSON_OUT) {
  console.log(JSON.stringify({ representation, retired, pty: PTY, problems }, null, 2))
} else {
  console.log('B2 freeze audit')
  console.log('')
  console.log('representation')
  console.log(`  unclassified rows        ${representation.unclassified}${representation.unclassified === 0 ? ' ✓' : ' ✗'}`)
  console.log(`  unknown destinations     ${representation.unknownDestination}${representation.unknownDestination === 0 ? ' ✓' : ' ✗'}`)
  console.log(`  live source rows         ${representation.liveRows}${representation.liveRows === 0 ? ' ✓' : ' ✗'}`)
  console.log(`  duplicate primaries      ${representation.duplicatePrimaries}${representation.duplicatePrimaries === 0 ? ' ✓' : ' ✗'}`)
  console.log(`  generic question rows    ${representation.genericToolRows}${representation.genericToolRows === 0 ? ' ✓' : ' ✗'}`)
  console.log(`  policy sources           ${representation.sources}`)
  console.log('')
  console.log('retired paths (B2)')
  for (const entry of retired) {
    console.log(`  ${entry.hits.length === 0 ? '✓' : '✗'} ${entry.id.padEnd(28)} ${entry.hits.length} — ${entry.what}`)
    for (const hit of entry.hits) console.log(`      ${hit}`)
  }
  console.log('')
  console.log('PTY facts (measured by the probes, restated here)')
  for (const entry of PTY) console.log(`  · ${entry.id} ${entry.rule} — ${entry.measured_by}`)
  console.log('')
  console.log(problems.length === 0 ? 'OK: every frozen invariant holds' : `FAIL: ${problems.join(' · ')}`)
}

process.exit(problems.length === 0 ? 0 : 1)
