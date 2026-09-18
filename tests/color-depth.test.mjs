import test from 'node:test'
import assert from 'node:assert/strict'

import { basicSgrFor, colorDepth, downgradeSgr, rgbFrom256 } from '../lib/color-depth.js'

/**
 * B-3: the palette follows the terminal, and a colour it cannot paint is
 * downgraded rather than dropped into the wrong slot.
 *
 * The diff rows are the reason this matters: their truecolor pairs are muted on
 * purpose, and nearest-RGB would turn both of them grey — the +/- symbol is the
 * real signal, but green and red still have to survive an 8-colour terminal.
 */
const env = overrides => ({ TERM: 'xterm-256color', ...overrides })

test('the environment decides the depth, override first', () => {
  assert.equal(colorDepth(env({ COLORTERM: 'truecolor' })), 'truecolor')
  assert.equal(colorDepth(env()), '256')
  assert.equal(colorDepth(env({ TERM: 'xterm' })), '8')
  assert.equal(colorDepth({ TERM: 'dumb' }), 'none')
  assert.equal(colorDepth({ TERM: 'linux' }), '8', 'a Linux virtual console still paints 8 colours')
  assert.equal(colorDepth({ TERM: 'vt100' }), '8')
  assert.equal(colorDepth({ TERM: 'vt220' }), '8')
  assert.equal(colorDepth({ TERM: 'xterm', NO_COLOR: '1' }), 'none')
  assert.equal(colorDepth({ TERM: 'screen' }), '256', 'tmux/screen default to the 256 palette')
  assert.equal(colorDepth({ TERM: 'tmux-256color' }), '256')
  assert.equal(colorDepth({ TERM: 'dumb', DSH_TUI_COLOR_DEPTH: 'truecolor' }), 'truecolor')
  assert.equal(colorDepth(env({ DSH_TUI_COLOR_DEPTH: 'off' })), 'none')
})

/**
 * Windows leaves `TERM` unset — PowerShell, ConHost and even Windows Terminal do
 * not set it — and the palette used to read an empty TERM as "no terminal at
 * all", so a Windows session came up black and white. Platform decides what an
 * empty TERM means: a pipe on POSIX, the normal case on Windows.
 */
test('an unset TERM is monochrome on POSIX and colour on Windows', () => {
  // POSIX, no TERM: the historical pipe/CI case, still no colour.
  assert.equal(colorDepth({}, 'linux'), 'none')
  assert.equal(colorDepth({ TERM: '' }, 'darwin'), 'none')
  // Windows, no TERM: PowerShell 7 / ConHost. The 16-colour palette carries the
  // diff colours; a Windows console understands those escapes.
  assert.equal(colorDepth({}, 'win32'), '8')
  assert.equal(colorDepth({ TERM: '' }, 'win32'), '8')
  // Windows Terminal advertises itself, and supports 24-bit colour.
  assert.equal(colorDepth({ WT_SESSION: '4a1b…' }, 'win32'), 'truecolor')
  // Capability variables win over the platform default, on both platforms.
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, 'win32'), '256')
  assert.equal(colorDepth({ COLORTERM: 'truecolor' }, 'win32'), 'truecolor')
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, 'linux'), '256')
  // An explicit "no capability" marker still means none, and the opt-outs keep
  // working everywhere.
  assert.equal(colorDepth({ TERM: 'dumb' }, 'win32'), 'none')
  assert.equal(colorDepth({ NO_COLOR: '1' }, 'win32'), 'none')
  assert.equal(colorDepth({ TERM: 'dumb', DSH_TUI_COLOR_DEPTH: 'truecolor' }, 'win32'), 'truecolor')
})

test('the diff pair keeps its hue at 8 colours instead of collapsing to grey', () => {
  // The muted add/del colours from styleLine.
  assert.equal(basicSgrFor(122, 168, 116), 32, 'muted green stays green')
  assert.equal(basicSgrFor(196, 122, 122), 31, 'muted red stays red')
  assert.equal(basicSgrFor(77, 107, 253), 94, 'the brand blue stays blue and bright')
  const eight = downgradeSgr('38;2;122;168;116;48;2;18;42;24', '8')
  assert.ok(eight.includes('32'), `the foreground is green: ${eight}`)
  assert.equal(eight.includes('38;'), false, 'and nothing truecolor survives')
})

/**
 * The 256-colour diff pair is the one case where two mapped colours share a row.
 * Mapping both through the hue family gave `38;5;2;48;5;2`: pure green on pure
 * green, so an expanded `write` preview was one solid green bar with nothing in
 * it. A background must be a different, darker colour than its foreground.
 */
test('a 256-colour diff row never paints green on green', () => {
  const pairs = [
    { code: '38;2;122;168;116;48;2;18;42;24', hue: 'green' },
    { code: '38;2;196;122;122;48;2;48;20;20', hue: 'red' },
  ]
  const luminance = index => {
    const [r, g, b] = rgbFrom256(index)
    const channel = value => {
      const v = value / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    }
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  for (const { code, hue } of pairs) {
    const downgraded = downgradeSgr(code, '256')
    const numbers = [...downgraded.matchAll(/(?:38|48);5;(\d+)/gu)].map(match => Number(match[1]))
    assert.equal(numbers.length, 2, `both colours survive: ${downgraded}`)
    const [fg, bg] = numbers
    assert.notEqual(fg, bg, `the text must not be invisible: ${downgraded}`)
    // 4.5:1 is the WCAG AA ratio for body text; a diff row carries code.
    const ratio = (Math.max(luminance(fg), luminance(bg)) + 0.05) / (Math.min(luminance(fg), luminance(bg)) + 0.05)
    assert.ok(ratio >= 4.5, `contrast ${ratio.toFixed(2)}:1 for ${downgraded} (fg ${fg} on bg ${bg})`)
    // The hue still has to be recognisable in the text itself, since the row
    // background went neutral to buy that contrast.
    const [fr, fg2, fb] = rgbFrom256(fg)
    if (hue === 'green') assert.ok(fg2 > fr && fg2 >= fb, `green stays green: ${downgraded}`)
    else assert.ok(fr > fg2 && fr >= fb, `red stays red: ${downgraded}`)
  }
})

test('a 256-colour index maps into the 16 when the terminal is 8-colour', () => {
  assert.equal(downgradeSgr('38;5;180', '256'), '38;5;180', 'untouched where the cube exists')
  const eight = downgradeSgr('38;5;180', '8')
  assert.equal(/38;5/u.test(eight), false, `no cube index survives: ${eight}`)
  assert.ok(/3[0-7]|9[0-7]/u.test(eight), `a standard colour took its place: ${eight}`)
  // 180 is a light sand tone; the grey ramp is its honest 8-colour answer.
  assert.equal(rgbFrom256(180).length, 3)
})

test('attributes survive every palette, including none', () => {
  assert.equal(downgradeSgr('1;38;2;77;107;253', 'none'), '1', 'bold stays, colour goes')
  assert.equal(downgradeSgr('2;3', 'none'), '2;3')
  // A colour mode is not an attribute: `38;2;…` must not leave a stray `2`
  // behind that reads as "dim" on a monochrome terminal.
  assert.equal(downgradeSgr('38;2;77;107;253', 'none'), '')
  assert.equal(downgradeSgr('38;5;180', 'none'), '')
  assert.equal(downgradeSgr('38;2;122;168;116;48;2;18;42;24', 'none'), '')
  assert.equal(downgradeSgr('31', 'none'), '', 'a bare colour goes too')
})

test('truecolor is left exactly as it was asked for', () => {
  const code = '1;38;2;77;107;253'
  assert.equal(downgradeSgr(code, 'truecolor'), code)
})

test('grey stays grey, because it has no hue to keep', () => {
  assert.equal(basicSgrFor(127, 127, 127), 90)
  assert.equal(basicSgrFor(250, 250, 250), 97)
})

test('a malformed introducer is dropped without eating valid attributes', () => {
  // `38;9` names no colour mode, so the introducer goes; `9` and `1` are real
  // attributes and stay.
  assert.equal(downgradeSgr('38;9;1', 'none'), '9;1')
  assert.equal(downgradeSgr('38;2;x;y;z;1', '8'), '1', 'a malformed payload is consumed whole')
})

/**
 * The palette reaches the frame, not just the function: a row that asked for
 * truecolor must come out parseable on the terminal the environment describes.
 */
async function frameAt(depth, t) {
  const previous = process.env.DSH_TUI_COLOR_DEPTH
  process.env.DSH_TUI_COLOR_DEPTH = depth
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_TUI_COLOR_DEPTH
    else process.env.DSH_TUI_COLOR_DEPTH = previous
  })
  const { SshTui } = await import('../lib/tui.js')
  const tui = new SshTui(
    { get: () => undefined, on() { return () => {} } },
    { id: 's', options: {}, status: 'idle', session: { id: 's', events: [] }, cancel() {} },
    { sessionId: 's', headlessDisplay: true },
  )
  // A brand row and a diff row are the two truecolor asks.
  tui.rows.push({ kind: 'brand', text: 'brand' })
  tui.rows.push({ kind: 'diff-add', text: '+ added' })
  tui.rows.push({ kind: 'diff-del', text: '- removed' })
  tui.rows.push({
    kind: 'subagent',
    sessionId: 'child-a',
    runId: 'run-a',
    provider: 'spawn',
    local: true,
    label: '子代理 spawn',
    task: 'scan repo',
    status: 'running',
    startedAt: Date.now(),
    lastActivity: 'scan repo',
    logs: [],
    expanded: false,
  })
  return { tui, frame: tui.captureFrame(80, 24).join('\n') }
}

test('an 8-colour terminal never receives a truecolor or cube sequence', async t => {
  const { frame } = await frameAt('8', t)
  assert.equal(/38;2|48;2/u.test(frame), false, 'no truecolor pair')
  assert.equal(/38;5|48;5/u.test(frame), false, 'no cube index')
  assert.ok(frame.includes('brand'), 'the rows are still painted')
  assert.ok(/3[0-7]|9[0-7]/u.test(frame), 'with standard colours')
})

/**
 * The status line tells the user which route the children take, so its accent
 * has to mean "a different provider from the parent's". A child that follows
 * the parent used to be painted violet on that row anyway, which read as a
 * `/submodel` pin.
 */
test('the status line accents only a child on a different provider', async t => {
  const { tui } = await frameAt('truecolor', t)
  const identityLine = () =>
    tui.captureFrame(90, 24).find(line => line.includes('sub:')) ?? ''
  const following = identityLine()
  assert.ok(following.includes('sub:'), following)
  assert.equal(/\x1b\[38;5;(?:141|80)m/u.test(following), false, following)
  tui.subagentSelection = { current: { provider: 'xai', model: 'grok-4.5' } }
  const pinned = identityLine()
  assert.ok(pinned.includes('\x1b[38;5;80msub:xai/grok-4.5\x1b[0m'), pinned)
})

/**
 * The card accent describes the child that is running, not the route the next
 * child would take: a `/submodel` reset must not repaint a live card, and a pin
 * must not paint children that are on the parent's own route.
 */
test('a running child keeps the accent of the route it actually runs on', async t => {
  const { tui } = await frameAt('truecolor', t)
  const card = tui.rows.find(row => row.kind === 'subagent')
  card.modelProvider = 'deepseek-official'
  // A pin for the *next* child; this one is already on the parent's route.
  tui.subagentSelection = { current: { provider: 'xai', model: 'grok-4.5' } }
  const header = tui.captureFrame(90, 24).find(line => line.includes('●')) ?? ''
  assert.equal(header.includes('\x1b[38;5;80m'), false, header)
  assert.ok(header.includes('\x1b[38;5;141m'), header)
  card.modelProvider = 'xai'
  const foreign = tui.captureFrame(90, 24).find(line => line.includes('●')) ?? ''
  assert.ok(foreign.includes('\x1b[38;5;80m'), foreign)
})

test('a monochrome terminal receives no colour at all, and keeps the marks', async t => {
  const { tui, frame } = await frameAt('none', t)
  tui.rows.push({ kind: 'error', text: '✖ something failed' })
  const painted = tui.captureFrame(80, 24).join('\n')
  const colourParams = painted.match(/\x1b\[[0-9;]*m/gu) ?? []
  for (const sgr of colourParams) {
    const params = sgr.slice(2, -1).split(';')
    for (const param of params) {
      assert.equal(
        /^(3[0-9]|4[0-9]|9[0-7]|10[0-7])$/u.test(param),
        false,
        `no colour parameter survives: ${sgr}`,
      )
    }
  }
  assert.ok(painted.includes('✖'), 'the failure mark is what carries the meaning')
  assert.ok(frame.includes('brand'), 'and the rows are still there')
})
