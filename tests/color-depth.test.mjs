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
  assert.equal(colorDepth({ TERM: 'xterm', NO_COLOR: '1' }), 'none')
  assert.equal(colorDepth({ TERM: 'screen' }), '256', 'tmux/screen default to the 256 palette')
  assert.equal(colorDepth({ TERM: 'tmux-256color' }), '256')
  assert.equal(colorDepth({ TERM: 'dumb', DSH_TUI_COLOR_DEPTH: 'truecolor' }), 'truecolor')
  assert.equal(colorDepth(env({ DSH_TUI_COLOR_DEPTH: 'off' })), 'none')
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
  return { tui, frame: tui.captureFrame(80, 24).join('\n') }
}

test('an 8-colour terminal never receives a truecolor or cube sequence', async t => {
  const { frame } = await frameAt('8', t)
  assert.equal(/38;2|48;2/u.test(frame), false, 'no truecolor pair')
  assert.equal(/38;5|48;5/u.test(frame), false, 'no cube index')
  assert.ok(frame.includes('brand'), 'the rows are still painted')
  assert.ok(/3[0-7]|9[0-7]/u.test(frame), 'with standard colours')
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
