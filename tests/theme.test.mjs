import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { downgradeSgr } from '../lib/color-depth.js'
import { SshTui } from '../lib/tui.js'
import { pushRow } from './wait.mjs'
import {
  resolveTheme,
  themeByName,
  themeEmphasisToken,
  themeExtraToken,
  themeHasColour,
  themeNames,
  themeToken,
} from '../lib/theme.js'

/**
 * The palette is a contract, and these are its clauses.
 *
 * Why they exist: the colours used to be a ternary inside the painter, so every
 * new role was a new branch and a light-terminal user got white text on white.
 * The three rules worth defending are that primary text takes the terminal's own
 * foreground (no `37`), that `mono` carries every distinction *without* colour,
 * and that the palettes are the only place a colour literal may appear — the
 * same job Codex does with `clippy.toml` rules around its TUI style guide.
 */

const SRC = join(import.meta.dirname, '..', 'src')

test('every palette answers every role, and only the intended ones paint colour', () => {
  assert.deepEqual(themeNames(), ['default', 'catppuccin', 'gruvbox', 'mono'])
  for (const name of themeNames()) {
    const theme = resolveTheme(name)
    // The three roles that must never force a foreground: forcing one is what
    // made assistant text unreadable on light terminals.
    for (const role of ['assistant', 'tool', 'tool-result']) {
      assert.equal(themeToken(theme, role), '', `${name}: ${role} must take the terminal's own foreground`)
    }
    // Errors stay legible in every palette, by colour or by attribute.
    assert.notEqual(themeToken(theme, 'error'), '', `${name}: an error has to be marked somehow`)
    assert.equal(themeHasColour(theme), name !== 'mono', `${name}: colour expectation`)
  }
})

test('mono keeps the structure when it drops the colour', () => {
  const mono = resolveTheme('mono')
  const colourFree = /\b(?:3[0-9]|4[0-9]|9[0-7]|38|48)\b/u
  for (const role of ['user', 'reasoning', 'brand', 'diff-add', 'diff-del', 'diff-path', 'todo-failed', 'error', 'system']) {
    assert.equal(colourFree.test(themeToken(mono, role)), false, `${role} must not ask for colour under mono`)
  }
  // …and the distinctions survive as attributes rather than vanishing.
  assert.equal(themeToken(mono, 'error'), '1;4', 'a failure is bold-underlined')
  assert.equal(themeToken(mono, 'diff-path'), '4', 'the diff path is underlined')
  assert.equal(themeToken(mono, 'system'), '2', 'secondary text is dim')
  assert.notEqual(themeToken(mono, 'diff-add'), themeToken(mono, 'diff-del'), 'added and removed must differ')
})

test('an unknown name resolves quietly, and can still be reported', () => {
  assert.equal(resolveTheme('bogus').name, 'default')
  assert.equal(resolveTheme(undefined).name, 'default')
  assert.equal(resolveTheme('  CATPPUCCIN ').name, 'catppuccin', 'names are case- and space-insensitive')
  assert.equal(themeByName('bogus'), undefined, 'the command needs to tell the reader about a typo')
})

test('the palettes survive every colour depth the plugin can meet', () => {
  for (const name of themeNames()) {
    const theme = resolveTheme(name)
    for (const [depth, pattern] of [
      ['truecolor', /^\d*;?(?:38;2;|1;38;2;|3[0-9]|9[0-7]|1;4|4|2)/u],
      ['256', /^(?:\d+;)*\d+$/u],
      ['8', /^(?:\d+;)*\d+$/u],
      // `none` drops every colour but keeps attributes: `mono`'s whole point is
      // that bold/underline still mark an error when colour is gone. (Whether
      // anything is painted at all is the painter's decision — it skips styling
      // entirely when the user asked for no colour.)
      ['none', /^(?:[1247];?)*[1247]?$/u],
    ]) {
      const code = downgradeSgr(themeToken(theme, 'error'), depth)
      assert.match(code, pattern, `${name}/error at depth ${depth} → ${JSON.stringify(code)}`)
    }
  }
  // A truecolor token must actually lose its truecolor on a 16-colour terminal,
  // and keep a hue rather than collapsing to grey.
  const red = downgradeSgr(themeToken(resolveTheme('catppuccin'), 'error'), '8')
  assert.equal(/38;2;/u.test(red), false, 'no truecolor left')
  assert.notEqual(red, '', 'and not dropped either')
})

test('diff emphasis is a brighter version of the same fill, per theme', () => {
  for (const name of themeNames()) {
    const theme = resolveTheme(name)
    for (const kind of ['diff-add', 'diff-del']) {
      const base = themeToken(theme, kind)
      const strong = themeEmphasisToken(theme, kind)
      if (strong === undefined) continue
      assert.notEqual(strong, base, `${name}/${kind}: emphasis has to differ from the base row`)
      if (name !== 'mono') {
        assert.match(strong, /48;2;/u, `${name}/${kind}: emphasis keeps a fill so the row stays a row`)
      }
    }
  }
})

test('non-row roles come from the theme too', () => {
  for (const name of themeNames()) {
    const theme = resolveTheme(name)
    for (const role of ['subagent-self', 'subagent-foreign', 'warn', 'link']) {
      assert.notEqual(themeExtraToken(theme, role), '', `${name}: ${role} must resolve`)
    }
    assert.notEqual(
      themeExtraToken(theme, 'subagent-self'),
      themeExtraToken(theme, 'subagent-foreign'),
      `${name}: a foreign subagent has to be distinguishable`,
    )
  }
})

test('no colour literal lives outside the theme module', () => {
  // Codex enforces its TUI style guide with clippy rules; this is the same idea
  // for a repo whose colours used to be a ternary in the painter. A literal
  // outside `theme.ts` is a colour no palette can reach and no depth can
  // downgrade, and `color-depth.ts` is allowed because it is the machine that
  // does the downgrading.
  // Two shapes count as a literal: a full escape (`\x1b[31m`) and a bare SGR
  // parameter list (`'90'`, `'1;36'`) — the second is how the colour tables
  // outside this module used to hide from a scan that only looked for escapes.
  const SGR_LITERAL = /^(?:[0-9]{1,2}(?:;[0-9]{1,2})+|3[0-9]|4[0-9]|9[0-7])$/u
  const offenders = []
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts') || file === 'theme.ts' || file === 'color-depth.ts') continue
    readFileSync(join(SRC, file), 'utf8').split('\n').forEach((line, index) => {
      if (/^\s*(?:\*|\/\/)/u.test(line)) return
      if (/(?:38;2;\d|48;2;\d|38;5;\d|\\x1b\[(?:3[0-9]|9[0-7])m)/u.test(line)) {
        offenders.push(`${file}:${index + 1}: ${line.trim()}`)
        return
      }
      for (const match of line.matchAll(/'([0-9;]{1,6})'/gu)) {
        if (SGR_LITERAL.test(match[1] ?? '')) offenders.push(`${file}:${index + 1}: '${match[1]}'`)
      }
    })
  }
  assert.deepEqual(offenders, [], `colour literals belong in theme.ts:\n${offenders.join('\n')}`)
})

/**
 * The end-to-end version of the promise: a real frame, painted by the real TUI.
 *
 * The unit tests above prove the tokens; this proves the painter consults them,
 * which is the part that used to be a ternary and that a refactor could quietly
 * bypass.
 */
function frameFor(themeName) {
  const previousTheme = process.env.DSH_TUI_THEME
  const previousDepth = process.env.DSH_TUI_COLOR_DEPTH
  process.env.DSH_TUI_THEME = themeName
  // The runner's own TERM is not a colour terminal, and the palette is chosen
  // from the environment — force it, or the assertion below would pass because
  // *nothing* paints colour rather than because the theme did its job.
  process.env.DSH_TUI_COLOR_DEPTH = 'truecolor'
  try {
    const ctx = { get: () => undefined, on() { return () => {} } }
    const agent = { id: 'main-session', options: {}, status: 'idle', session: { id: 'main-session', events: [] }, cancel() {} }
    // `showReasoning` because a reasoning row is hidden by default, and the point
    // of this case is that every role survives the palette switch.
    const tui = new SshTui(ctx, agent, { sessionId: 'main-session', color: true, showReasoning: true })
    // A reasoning row only reaches the transcript while a turn is live, so it is
    // asserted at the token level above rather than here.
    for (const [kind, text] of [
      ['user', 'a question'],
      ['assistant', 'the answer'],
      ['error', 'something failed'],
      ['diff-add', '+added line'],
      ['diff-del', '-removed line'],
    ]) pushRow(tui, { kind, text })
    return tui.captureFrame(100, 30).join('\n')
  } finally {
    if (previousTheme === undefined) delete process.env.DSH_TUI_THEME
    else process.env.DSH_TUI_THEME = previousTheme
    if (previousDepth === undefined) delete process.env.DSH_TUI_COLOR_DEPTH
    else process.env.DSH_TUI_COLOR_DEPTH = previousDepth
  }
}

test('a painted frame follows the selected palette', () => {
  const plain = frameFor('default')
  const mono = frameFor('mono')
  const colourCode = /\u001b\[(?:[0-9]+;)*3[0-9]m|\u001b\[(?:[0-9]+;)*9[0-7]m|\u001b\[(?:[0-9]+;)*38;/u
  assert.match(plain, colourCode, 'the default palette does use colour')
  assert.equal(colourCode.test(mono), false, 'mono must not emit a single colour code')
  assert.match(mono, /\u001b\[1;4m/u, 'but a failure is still marked, by attribute')
  // Both frames carry the same text: nothing disappears with the colour.
  for (const text of ['a question', 'the answer', 'something failed', '+added line', '-removed line']) {
    assert.ok(plain.includes(text), `default frame lost ${text}`)
    assert.ok(mono.includes(text), `mono frame lost ${text}`)
  }
})

test('a muted role names a colour, so a terminal that ignores faint still mutes it', () => {
  // Reported from the field: the thinking card drew in the terminal's *default*
  // foreground — as bright as the reply beside it, i.e. white on a dark theme — on
  // a 256-colour terminal. The role was `2;3`, attributes only: `faint` is what
  // made it grey, and a terminal that does not implement it falls back to the
  // default foreground. The colour is the part every palette can carry; the
  // attributes stay for the terminals that do honour them. `mono` is the one
  // palette that must not name a colour (its own case above pins that).
  for (const name of themeNames()) {
    const token = themeToken(resolveTheme(name), 'reasoning')
    assert.match(token, /\b2\b/u, `${name}: the faint attribute stays`)
    if (name === 'mono') {
      assert.doesNotMatch(token, /\b(?:3[0-9]|9[0-7]|38)\b/u, 'mono must not name a colour')
      continue
    }
    assert.match(token, /\b(?:3[0-9]|9[0-7]|38)\b/u, `${name}: reasoning must name a colour, not only attributes`)
  }
})
