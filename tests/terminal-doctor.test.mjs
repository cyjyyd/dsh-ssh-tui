/**
 * W6B.G1 — Terminal Doctor evidence ledger and formatter.
 *
 * The point of these cases is provenance, not prose: a host-table guess must
 * never become MEASURED, a previous attachment must never become current, and
 * a missing frame must never become "disabled". The ledger is pure, so every
 * case is deterministic and needs no terminal, socket or timer.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { setLocale } from '../lib/i18n/index.js'
import { terminalCapabilities } from '../lib/terminal-caps.js'
import {
  assertFactProvenance,
  formatTerminalDoctor,
  hostPolicyFrom,
  TerminalEvidenceLedger,
} from '../lib/terminal-doctor.js'

setLocale('en')

const ENV = { TERM: 'xterm-256color' }
const PLATFORM = 'linux'

function policy(env = ENV, callerSupplied = false) {
  const caps = terminalCapabilities({ env, platform: PLATFORM })
  return hostPolicyFrom(caps, { env, platform: PLATFORM, callerSupplied })
}

function linesFor(ledger, env = ENV, options = {}) {
  return formatTerminalDoctor(policy(env), ledger.snapshot(), options)
}

const row = (lines, label) => lines.find(line => line.startsWith(label))
const joined = lines => lines.join('\n')

test('a detached Host reports Relay evidence as UNMEASURED, never as a failure', () => {
  const lines = linesFor(new TerminalEvidenceLedger())
  assert.match(joined(lines), /Current Relay: detached/)
  assert.match(row(lines, 'Link RTT'), /UNMEASURED/)
  assert.match(row(lines, 'Link RTT'), /no Relay attached/)
  assert.match(row(lines, 'Ambiguous width'), /UNMEASURED/)
  assert.doesNotMatch(row(lines, 'Link RTT'), /\bMEASURED\b/)
  assert.doesNotMatch(joined(lines), /unsupported/)
})

test('an attached Relay with no observations is UNMEASURED with an unknown reason', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  const lines = linesFor(ledger)
  assert.match(joined(lines), /attached, epoch 1/)
  assert.match(row(lines, 'Link RTT'), /UNMEASURED/)
  assert.match(row(lines, 'Link RTT'), /no reply in this epoch/)
  assert.match(row(lines, 'Ambiguous width'), /UNMEASURED/)
  assert.match(row(lines, 'Ambiguous width'), /no FRAME_METRICS/)
  assert.doesNotMatch(joined(lines), /disabled/)
})

test('current-epoch RTT and metrics are MEASURED with their epoch', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  assert.equal(ledger.observeRtt(42), true)
  assert.equal(ledger.observeMetrics({ wide: false, reserve: true }), true)
  const lines = linesFor(ledger)
  assert.match(row(lines, 'Link RTT'), /42 ms/)
  assert.match(row(lines, 'Link RTT'), /\bMEASURED\b/)
  assert.match(row(lines, 'Link RTT'), /relay epoch 1/)
  assert.match(row(lines, 'Ambiguous width'), /1 cell/)
  assert.match(row(lines, 'Ambiguous width'), /\bMEASURED\b/)
})

test('replacement makes the old epoch STALE and the new epoch unproven', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  ledger.observeRtt(40)
  ledger.observeMetrics({ wide: true, reserve: false })
  ledger.attach()
  const lines = linesFor(ledger)
  assert.match(joined(lines), /attached, epoch 2/)
  assert.match(row(lines, 'Link RTT'), /UNMEASURED/)
  assert.match(row(lines, 'Previous RTT'), /40 ms/)
  assert.match(row(lines, 'Previous RTT'), /STALE/)
  assert.match(row(lines, 'Previous width'), /2 cells/)
  assert.match(row(lines, 'Previous width'), /STALE/)
  assert.doesNotMatch(row(lines, 'Link RTT'), /40 ms/)
})

test('a new epoch observation retires the stale row', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  ledger.observeRtt(40)
  ledger.attach()
  ledger.observeRtt(90)
  ledger.observeMetrics({ wide: false, reserve: true })
  const lines = linesFor(ledger)
  assert.match(row(lines, 'Link RTT'), /90 ms/)
  assert.match(row(lines, 'Link RTT'), /\bMEASURED\b/)
  assert.equal(row(lines, 'Previous RTT'), undefined)
  assert.match(row(lines, 'Ambiguous width'), /1 cell/)
  assert.equal(row(lines, 'Previous width'), undefined)
})

test('detach closes the epoch; late observations cannot resurrect it', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  ledger.observeRtt(55)
  ledger.detach()
  assert.equal(ledger.observeRtt(999), false)
  assert.equal(ledger.observeMetrics({ wide: true, reserve: false }), false)
  const lines = linesFor(ledger)
  assert.match(joined(lines), /Current Relay: detached/)
  assert.match(row(lines, 'Link RTT'), /UNMEASURED/)
  assert.match(row(lines, 'Previous RTT'), /55 ms/)
  assert.match(row(lines, 'Previous RTT'), /STALE/)
  assert.doesNotMatch(joined(lines), /999 ms/)
})

test('malformed metrics are ignored, not converted into a zero-width claim', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  assert.equal(ledger.observeMetrics({ wide: 'yes', reserve: true }), false)
  assert.equal(ledger.observeMetrics({ wide: true }), false)
  const lines = linesFor(ledger)
  assert.match(row(lines, 'Ambiguous width'), /UNMEASURED/)
  assert.doesNotMatch(joined(lines), /0 cell|0-width|disabled/)
})

test('CONFIGURED is distinct from INFERRED for explicit overrides', () => {
  const env = { ...ENV, DSH_TUI_TERM_CAPS: 'no-mouse' }
  const lines = linesFor(new TerminalEvidenceLedger(), env)
  assert.match(row(lines, 'Mouse / SGR'), /CONFIGURED/)
  assert.match(row(lines, 'Terminal family'), /INFERRED/)
  assert.match(row(lines, 'Overrides'), /CONFIGURED/)
})

test('caller-supplied caps are CONFIGURED and labelled as caller supplied', () => {
  const caps = terminalCapabilities({ env: ENV, platform: PLATFORM })
  const caller = hostPolicyFrom(caps, { env: ENV, platform: PLATFORM, callerSupplied: true })
  const lines = formatTerminalDoctor(caller, new TerminalEvidenceLedger().snapshot())
  assert.match(row(lines, 'Terminal family'), /CONFIGURED/)
  assert.match(row(lines, 'Terminal family'), /caller supplied/)
  assert.match(row(lines, 'OSC52 clipboard'), /CONFIGURED/)
})

test('invalid override tokens are counted, never echoed', () => {
  const env = { ...ENV, DSH_TUI_TERM_CAPS: 'bogus=secret another' }
  const lines = linesFor(new TerminalEvidenceLedger(), env)
  assert.match(row(lines, 'Overrides'), /^Overrides: 2\s+CONFIGURED/)
  assert.match(row(lines, 'Overrides'), /2 invalid token/)
  assert.doesNotMatch(joined(lines), /bogus|secret|another/)
})

test('OSC52 is never presented as proof of clipboard delivery', () => {
  const lines = linesFor(new TerminalEvidenceLedger())
  assert.match(row(lines, 'OSC52 clipboard'), /not proof of delivery/)
  assert.doesNotMatch(joined(lines), /copied successfully|clipboard written|delivered/)
})

test('ASCII mode uses ASCII separators and line mode omits the Screen hint', () => {
  const ledger = new TerminalEvidenceLedger()
  ledger.attach()
  const ascii = linesFor(ledger, ENV, { ascii: true })
  assert.doesNotMatch(joined(ascii), /·/)
  const lineMode = linesFor(ledger, ENV, { lineMode: true })
  assert.doesNotMatch(joined(lineMode), /Esc close/)
  assert.match(joined(lineMode), /fresh recheck unavailable/)
})

test('a forged provenance pair is rejected before it can be rendered', () => {
  assert.throws(
    () => assertFactProvenance({ id: 'rtt', value: '1 ms', state: 'MEASURED', source: 'host-start' }),
    /MEASURED requires relay-current/,
  )
  assert.throws(
    () => assertFactProvenance({ id: 'rtt', value: '1 ms', state: 'STALE', source: 'relay-current', epoch: 1 }),
    /STALE requires previous-attach/,
  )
  assert.doesNotThrow(
    () => assertFactProvenance({ id: 'rtt', value: '1 ms', state: 'MEASURED', source: 'relay-current', epoch: 1 }),
  )
})

test('Chinese and English labels both exist for all five states', () => {
  for (const locale of ['en', 'zh']) {
    setLocale(locale)
    const lines = linesFor(new TerminalEvidenceLedger())
    for (const state of ['MEASURED', 'CONFIGURED', 'INFERRED', 'UNMEASURED', 'STALE']) {
      assert.equal(typeof state, 'string')
    }
    assert.ok(lines.length > 10, locale)
    assert.doesNotMatch(joined(lines), /terminal\.(state|fact|detail)\./)
  }
  setLocale('en')
})

test('an invalid DSH_TUI_COLOR_DEPTH is not reported as configured', () => {
  const env = { ...ENV, DSH_TUI_COLOR_DEPTH: 'bogus' }
  const lines = linesFor(new TerminalEvidenceLedger(), env)
  assert.match(row(lines, 'Color depth'), /256/)
  assert.match(row(lines, 'Color depth'), /INFERRED/)
  assert.doesNotMatch(row(lines, 'Color depth'), /CONFIGURED|explicit override/)
})

test('a recognized forced color is CONFIGURED with its real source', () => {
  const env = { ...ENV, DSH_TUI_COLOR_DEPTH: '8' }
  const lines = linesFor(new TerminalEvidenceLedger(), env)
  assert.match(row(lines, 'Color depth'), /^Color depth: 8\s+CONFIGURED/)
  assert.match(row(lines, 'Color depth'), /DSH_TUI_COLOR_DEPTH/)
})

test('NO_COLOR matches the effective none and is CONFIGURED', () => {
  const env = { ...ENV, NO_COLOR: '1' }
  const lines = linesFor(new TerminalEvidenceLedger(), env)
  assert.match(row(lines, 'Color depth'), /^Color depth: none\s+CONFIGURED/)
  assert.match(row(lines, 'Color depth'), /NO_COLOR/)
})

test('a recognized forced color keeps precedence over NO_COLOR', () => {
  const env = { ...ENV, DSH_TUI_COLOR_DEPTH: 'truecolor', NO_COLOR: '1' }
  const lines = linesFor(new TerminalEvidenceLedger(), env)
  assert.match(row(lines, 'Color depth'), /^Color depth: truecolor\s+CONFIGURED/)
  assert.match(row(lines, 'Color depth'), /DSH_TUI_COLOR_DEPTH/)
  assert.doesNotMatch(row(lines, 'Color depth'), /NO_COLOR/)
})

test('caller-supplied caps do not configure the independent ASCII policy', () => {
  const caps = terminalCapabilities({ env: ENV, platform: PLATFORM })
  const caller = hostPolicyFrom(caps, { env: ENV, platform: PLATFORM, callerSupplied: true })
  const lines = formatTerminalDoctor(caller, new TerminalEvidenceLedger().snapshot())
  assert.match(row(lines, 'ASCII fallback'), /off\s+INFERRED/)
  assert.doesNotMatch(row(lines, 'ASCII fallback'), /CONFIGURED|caller supplied/)
  assert.match(row(lines, 'Terminal family'), /CONFIGURED/)
  assert.match(row(lines, 'Terminal family'), /caller supplied/)
})

test('raw TERM and TERM_PROGRAM never reach the report', () => {
  const xterm = linesFor(new TerminalEvidenceLedger(), {
    TERM: 'xterm-256color-SECRET-TOKEN',
    TERM_PROGRAM: 'PRIVATE-TERM-PROGRAM',
  })
  assert.match(row(xterm, 'Terminal family'), /xterm-compatible terminal/)
  assert.doesNotMatch(joined(xterm), /SECRET-TOKEN|PRIVATE-TERM-PROGRAM/)

  const vte = linesFor(new TerminalEvidenceLedger(), {
    TERM: 'xterm-256color',
    VTE_VERSION: '7000',
    TERM_PROGRAM: 'SECRET-VTE-PROGRAM',
  })
  assert.match(row(vte, 'Terminal family'), /VTE-based terminal/)
  assert.doesNotMatch(joined(vte), /SECRET-VTE-PROGRAM|TERM_PROGRAM/)

  const control = linesFor(new TerminalEvidenceLedger(), {
    TERM: 'xterm-\u202eEVIL\u0007',
    TERM_PROGRAM: '\u202ePRIVATE',
  })
  assert.doesNotMatch(joined(control), /EVIL|PRIVATE|\u202e/)
})

test('the family label is an allowlisted name, not caps.label', () => {
  const caps = terminalCapabilities({ env: { TERM: 'xterm-256color' }, platform: PLATFORM })
  caps.label = 'RAW-ENV-LABEL-SECRET'
  const lines = formatTerminalDoctor(hostPolicyFrom(caps, { env: ENV, platform: PLATFORM }), new TerminalEvidenceLedger().snapshot())
  assert.doesNotMatch(joined(lines), /RAW-ENV-LABEL-SECRET/)
  assert.match(row(lines, 'Terminal family'), /xterm-compatible terminal/)
})
