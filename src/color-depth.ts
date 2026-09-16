/**
 * How much colour the terminal can take, and what to do when it cannot take
 * what a caller asked for.
 *
 * A truecolor pair (`38;2;…`) on an 8-colour terminal is not a cosmetic loss: a
 * terminal that does not understand it either ignores the sequence or renders
 * the row in the wrong colour, and the diff rows are the ones that suffer. The
 * palette is downgraded here instead, by hue family rather than by nearest RGB
 * distance — the diff colours are deliberately muted, and nearest-RGB maps them
 * to grey, which throws away the only signal they carry. Status is never colour
 * alone in this TUI (a `+`/`-`/`●`/`⚠`/`✖` is always present), so a downgraded
 * palette stays readable.
 * @module dsh-ssh-tui/color-depth
 */

/** What the terminal advertised, or what the user forced. */
export type ColorDepth = 'truecolor' | '256' | '8' | 'none'

/**
 * Decide the palette from the environment.
 *
 * `DSH_TUI_COLOR_DEPTH` wins outright so a user can correct a wrong guess.
 * Otherwise: no colour at all when `NO_COLOR` is set or `TERM` names a
 * monochrome terminal; truecolor when `COLORTERM` says so; 256 for a
 * `*256color` terminal and for tmux/screen (their default palette is 256 and
 * they translate truecolor poorly); 8 for everything else.
 * @param env - the environment to read (tests pass their own).
 * @returns the palette to paint with.
 */
export function colorDepth(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ColorDepth {
  const forced = (env.DSH_TUI_COLOR_DEPTH ?? '').trim().toLowerCase()
  if (forced === 'truecolor' || forced === '24bit' || forced === '16m') return 'truecolor'
  if (forced === '256' || forced === '256color') return '256'
  if (forced === '8' || forced === '8color' || forced === 'basic') return '8'
  if (forced === 'none' || forced === 'off' || forced === '0' || forced === 'no') return 'none'

  const noColor = (env.NO_COLOR ?? '').trim()
  if (noColor !== '') return 'none'
  const term = (env.TERM ?? '').trim().toLowerCase()
  // What an empty TERM means depends on the platform. On POSIX it is the pipe /
  // CI case and there is nothing to paint with. On Windows it is simply the
  // normal state — PowerShell, ConHost and Windows Terminal all leave TERM unset
  // — and reading it as "no colour" is what turned a Windows session black and
  // white. The explicit markers below still decide the palette there.
  if (term === '') {
    if (platform !== 'win32') return 'none'
  } else if (term === 'dumb' || term === 'linux' || term === 'vt100' || term === 'vt220') {
    return 'none'
  }
  const colorTerm = (env.COLORTERM ?? '').trim().toLowerCase()
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return 'truecolor'
  if (term.includes('256color')) return '256'
  if (term.startsWith('screen') || term.startsWith('tmux')) return '256'
  // Windows Terminal sets WT_SESSION and paints 24-bit colour; a plain Windows
  // console falls through to the 16-colour palette, which still carries the
  // diff colours (and `DSH_TUI_COLOR_DEPTH` overrides either way).
  if (platform === 'win32' && (env.WT_SESSION ?? '').trim() !== '') return 'truecolor'
  return '8'
}

/** The 16 standard colours, as the RGB a terminal roughly paints them with. */
const BASIC_RGB: readonly (readonly [number, number, number])[] = [
  [0, 0, 0], [205, 0, 0], [0, 205, 0], [205, 205, 0],
  [0, 0, 238], [205, 0, 205], [0, 205, 205], [229, 229, 229],
  [127, 127, 127], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [92, 92, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]

/** SGR foreground for each of the 16 standard colours. */
const BASIC_SGR = [30, 31, 32, 33, 34, 35, 36, 37, 90, 91, 92, 93, 94, 95, 96, 97] as const

/** The xterm 256-colour cube index back to RGB. */
export function rgbFrom256(index: number): [number, number, number] {
  if (index < 16) {
    const basic = BASIC_RGB[index] ?? BASIC_RGB[7] ?? [229, 229, 229]
    return [basic[0], basic[1], basic[2]]
  }
  if (index < 232) {
    const at = index - 16
    const steps = [0, 95, 135, 175, 215, 255]
    return [steps[Math.floor(at / 36) % 6] ?? 0, steps[Math.floor(at / 6) % 6] ?? 0, steps[at % 6] ?? 0]
  }
  const grey = 8 + (index - 232) * 10
  return [grey, grey, grey]
}

/**
 * The nearest standard colour, by hue family.
 *
 * Brightness picks the bright half of the palette; a colour whose channels are
 * nearly equal becomes a grey. Everything else keeps its hue, so a muted green
 * stays green instead of collapsing to grey the way nearest-RGB would leave it.
 */
export function basicSgrFor(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  // 204/255: the muted diff colours sit just under it and belong on the normal
  // half of the palette, while a vivid primary (255) belongs on the bright half.
  const bright = max > 204
  if (max - min < 24) return bright ? 97 : 90
  // Hue family from the channels that share the maximum: yellow, cyan and
  // magenta are the two-dominant-channel families.
  if (r === max && g === max) return bright ? 93 : 33
  if (g === max && b === max) return bright ? 96 : 36
  if (r === max && b === max) return bright ? 95 : 35
  if (r === max) return bright ? 91 : 31
  if (g === max) return bright ? 92 : 32
  if (b === max) return bright ? 94 : 34
  return bright ? 97 : 90
}

/** Cube axis step nearest to one channel value (the cube's 0/95/135/175/215/255). */
function cubeAxis(value: number): number {
  const steps = [0, 95, 135, 175, 215, 255]
  let best = 0
  for (let at = 1; at < steps.length; at += 1) {
    if (Math.abs((steps[at] ?? 0) - value) < Math.abs((steps[best] ?? 0) - value)) best = at
  }
  return best
}

/**
 * The nearest 256-cube colour. Unlike the 16-colour mapping this keeps
 * brightness, which is what the text of a diff row needs to stay readable.
 */
function nearestCubeIndex(r: number, g: number, b: number): number {
  return 16 + cubeAxis(r) * 36 + cubeAxis(g) * 6 + cubeAxis(b)
}

/**
 * The row background at 256 colours: the ramp's dark grey (`#1c1c1c`).
 *
 * The cube's darkest step is `#005f00` / `#5f0000`, and the muted diff text on
 * that measures 3.2:1 — below the 4.5:1 a row of code needs. A tinted row is not
 * worth unreadable text, so the row goes neutral and the *hue* stays in the
 * foreground, which is also what the 8-colour path does (black background, green
 * or red text). Two consequences worth stating: a background can never equal its
 * own foreground, and the tint is the one thing a 256-colour terminal loses.
 */
const DIFF_BACKGROUND_INDEX = 234

/**
 * Rewrite one SGR parameter list for the palette in use.
 *
 * Attributes (bold, dim, italic, underline, reverse) always survive: they are
 * what carries meaning when colour cannot. Colour parameters are dropped at
 * `none`, mapped to the standard 16 at `8`, and mapped into the 256-cube at
 * `256`.
 * @param code - the parameter list, e.g. `1;38;2;77;107;253`.
 * @param depth - the palette to rewrite for.
 * @returns the parameter list to emit, possibly empty.
 */
export function downgradeSgr(code: string, depth: ColorDepth): string {
  if (depth === 'truecolor') return code
  const parts = code.split(';')
  const out: string[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index] ?? ''
    if (part === '38' || part === '48') {
      const background = part === '48'
      const mode = parts[index + 1]
      if (mode === '2') {
        const rgb: [number, number, number] = [
          Number(parts[index + 2]), Number(parts[index + 3]), Number(parts[index + 4]),
        ]
        index += 4
        if (depth === 'none' || rgb.some(channel => !Number.isFinite(channel))) continue
        if (depth === '256') {
          // Truecolor keeps its brightness here, and a background is never the
          // colour of its own foreground (green on green hid a `write` preview).
          out.push(
            String(background ? 48 : 38), '5',
            String(background ? DIFF_BACKGROUND_INDEX : nearestCubeIndex(rgb[0], rgb[1], rgb[2])),
          )
          continue
        }
        out.push(...paintColour(basicSgrFor(rgb[0], rgb[1], rgb[2]), background, depth))
        continue
      }
      if (mode === '5') {
        const at = Number(parts[index + 2])
        index += 2
        if (depth === 'none' || !Number.isFinite(at)) continue
        if (depth === '256') {
          out.push(String(background ? 48 : 38), '5', String(at))
          continue
        }
        const [r, g, b] = rgbFrom256(at)
        out.push(...paintColour(basicSgrFor(r, g, b), background, depth))
        continue
      }
      // A malformed introducer takes its payload with it rather than leaving a
      // stray parameter behind.
      continue
    }
    if (depth === 'none' && BASIC_COLOUR.has(part)) continue
    out.push(part)
  }
  return out.filter(part => part !== '').join(';')
}

/** Whether one parameter is a bare colour (and so goes at `none`). */
const BASIC_COLOUR = new Set([
  ...Array.from({ length: 8 }, (_unused, at) => String(30 + at)),
  ...Array.from({ length: 8 }, (_unused, at) => String(40 + at)),
  ...Array.from({ length: 8 }, (_unused, at) => String(90 + at)),
  ...Array.from({ length: 8 }, (_unused, at) => String(100 + at)),
])

/** Foreground/background parameters for one standard colour at the given depth. */
function paintColour(sgr: number, background: boolean, depth: ColorDepth): string[] {
  if (depth === '256') {
    // The 256-cube index of a basic colour: the first 16 answer directly.
    return [String(background ? 48 : 38), '5', String(sgrTo256(sgr))]
  }
  const basic = sgrToBasicIndex(sgr)
  if (background) {
    // 8-colour terminals have no bright backgrounds worth trusting; a dim
    // background would fight the text. Drop it and let the attribute carry on.
    return ['40']
  }
  return [String(basic >= 8 ? 90 + (basic - 8) : 30 + basic)]
}

/** Standard SGR (30-37 / 90-97) to the 0-15 index. */
function sgrToBasicIndex(sgr: number): number {
  if (sgr >= 90 && sgr <= 97) return sgr - 90 + 8
  if (sgr >= 30 && sgr <= 37) return sgr - 30
  return 7
}

/** The 0-15 index back to a 256-cube index (the cube starts with them). */
function sgrTo256(sgr: number): number {
  return sgrToBasicIndex(sgr)
}
