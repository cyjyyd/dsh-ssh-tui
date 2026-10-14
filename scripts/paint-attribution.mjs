/**
 * Paint attribution for the PTY probes: which *frame* painted which row, and
 * whether that row actually changed.
 *
 * A probe reads a byte stream, not frames. `term.onData(chunk)` hands over
 * whatever the pty had ready, so **a chunk boundary is not a paint boundary** —
 * one frame can arrive in three chunks, and on ConPTY a whole frame arrives as a
 * single newline-separated batch with its row addressing rewritten. A judgement
 * built on chunk boundaries is therefore a judgement about the pty, not about the
 * painter.
 *
 * The painter does say where its frames are, and those markers are part of what
 * every terminal receives (`src/paint.ts`):
 *
 *   - a frame that paints rows wraps its row batch in DECAWM off/on
 *     (`ESC[?7l … ESC[?7h`), and a batch longer than two rows is additionally
 *     wrapped in a synchronized update (`ESC[?2026h … ESC[?2026l`);
 *   - every painted row is addressed, reset and erased first:
 *     `ESC[<row>;1H ESC[0m ESC[2K <content> ESC[0m`.
 *
 * So a frame is what the product says it is. This module parses those markers
 * into frames and replays them against a row-content map, which answers the two
 * questions a paint-scope assertion needs:
 *
 *   1. **which rows a frame painted** (its scope), and
 *   2. **whether each painted row changed in that frame** — a frame that rewrites a
 *      row to the bytes it already held repainted it for no reason, which is the
 *      regression "moving the selection repaints the whole frame" that the probe's
 *      dialog step exists to catch.
 *
 * The map is keyed by row and holds the composed bytes, so a style-only change
 * counts as a change (it is one: the row is composed with its colours).
 *
 * What this module deliberately does **not** do: decide *why* a row changed. A
 * chrome row that changes on its own timer is a legitimate repaint, and the caller
 * separates it from the key's own frames by content, not by pretending it was part
 * of them.
 */
import { stripAnsi } from '../lib/term-text.js'

const ROW_BATCH_OPEN = '\x1b[?7l'
const ROW_BATCH_CLOSE = '\x1b[?7h'
const SYNC_OPEN = '\x1b[?2026h'
const SYNC_CLOSE = '\x1b[?2026l'
const ROW_PAINT_SOURCE = '\\x1b\\[(\\d+);1H\\x1b\\[0m\\x1b\\[2K'

/** A full clear, an erase-below, or the home+erase pair: what "no clear" means. */
const CLEARS = [/\x1b\[2J/u, /\x1b\[3J/u, /\x1b\[H\x1b\[J/u, /\x1b\[\d+;1H\x1b\[J/u]

/**
 * Trailing sequences a painted row carries *after* its text: the reset the painter
 * appends and the caret it parks after the row it sits on.
 *
 * Anchored at the end on purpose: the content starts with the row's own text, and
 * a style reset *inside* the text is part of what the row is.
 */
const ROW_TAILS = [/\x1b\[0m/u, /\x1b\[\d+;\d+H/u, /\x1b\[\?25h/u]

/** Strip the sequences a painted row carries after its text (reset, caret). */
function trimRowTail(content) {
  let text = content
  for (;;) {
    let stripped = false
    for (const pattern of ROW_TAILS) {
      const match = pattern.exec(text)
      if (match === null || match.index + match[0].length !== text.length) continue
      text = text.slice(0, match.index)
      stripped = true
      break
    }
    if (!stripped) return text
  }
}

/**
 * Every frame in `text`, in order.
 *
 * A frame still in flight (its batch opened but not closed) is left out: the next
 * read completes it, and treating half a frame as one would invent a scope.
 *
 * @returns {{ start: number, end: number, paint: { row: number, content: string, text: string }[], synchronized: boolean }[]}
 */
export function parsePaintFrames(text) {
  const frames = []
  let index = 0
  let inSync = false
  for (;;) {
    // Track the synchronized-update state instead of assuming the marker sits
    // immediately before the batch: a size-changing frame writes
    // `ESC[?25l ESC[H ESC[J` in between, and it is still one bracketed frame.
    for (;;) {
      const opens = text.indexOf(SYNC_OPEN, index)
      const closes = text.indexOf(SYNC_CLOSE, index)
      const at = opens === -1 ? closes : closes === -1 ? opens : Math.min(opens, closes)
      const open = text.indexOf(ROW_BATCH_OPEN, index)
      if (at === -1 || (open !== -1 && at > open)) break
      inSync = at === opens
      index = at + (at === opens ? SYNC_OPEN.length : SYNC_CLOSE.length)
    }
    const open = text.indexOf(ROW_BATCH_OPEN, index)
    if (open === -1) break
    const close = text.indexOf(ROW_BATCH_CLOSE, open + ROW_BATCH_OPEN.length)
    if (close === -1) break
    const body = text.slice(open + ROW_BATCH_OPEN.length, close)
    const headers = []
    const pattern = new RegExp(ROW_PAINT_SOURCE, 'gu')
    for (;;) {
      const match = pattern.exec(body)
      if (match === null) break
      headers.push({ row: Number(match[1]), start: match.index, end: match.index + match[0].length })
    }
    const paint = headers.map((header, at) => {
      const until = at + 1 < headers.length ? headers[at + 1].start : body.length
      const content = trimRowTail(body.slice(header.end, until))
      return { row: header.row, content, text: stripAnsi(content).replace(/\s+$/u, '') }
    })
    frames.push({
      start: open,
      end: close + ROW_BATCH_CLOSE.length,
      synchronized: inSync,
      paint,
    })
    index = close + ROW_BATCH_CLOSE.length
  }
  return frames
}

/**
 * Replay a stream and report what the frames inside `[since, until)` painted.
 *
 * `frames` carries every frame with each painted row annotated `changed`/`before`,
 * compared against the content the row held *before that frame* — which is why the
 * replay starts at the beginning of `text` rather than at `since`.
 *
 * @param text - the whole captured stream (boot included).
 * @param options.since - first byte offset of the window (the key was written here).
 * @param options.until - last byte offset of the window (defaults to the end).
 */
export function attributePaint(text, options = {}) {
  const since = options.since ?? 0
  const until = options.until ?? text.length
  const frames = parsePaintFrames(text)
  const content = new Map(options.initialContent ?? [])
  let before
  const annotated = frames.map(frame => {
    if (before === undefined && frame.start >= since) before = new Map(content)
    return {
      ...frame,
      paint: frame.paint.map(entry => {
        const previous = content.get(entry.row)
        content.set(entry.row, entry.content)
        return { ...entry, before: previous, changed: previous !== entry.content }
      }),
    }
  })
  if (before === undefined) before = new Map(content)
  const inside = annotated.filter(frame => frame.start >= since && frame.start < until)
  const rowWrites = inside.flatMap(frame => frame.paint.map(entry => ({ ...entry, frameStart: frame.start })))
  const windowText = text.slice(since, until)
  return {
    frames: annotated,
    content,
    /** The rows as they stood when the window opened, and when it closed. */
    before,
    after: new Map(content),
    window: {
      from: since,
      to: until,
      frames: inside,
      rowWrites,
      rows: [...new Set(rowWrites.map(entry => entry.row))].sort((left, right) => left - right),
      /** Rewrites of a row to the bytes it already held: the scope this gate guards. */
      unjustified: rowWrites.filter(entry => !entry.changed),
      changedRows: [...new Set(rowWrites.filter(entry => entry.changed).map(entry => entry.row))].sort((left, right) => left - right),
      clears: CLEARS.flatMap(pattern => {
        const matches = []
        const scan = new RegExp(pattern.source, 'gu')
        for (;;) {
          const match = scan.exec(windowText)
          if (match === null) break
          matches.push(match[0])
        }
        return matches
      }),
    },
  }
}

/** The visible text of one row, as the reader would see it. */
export function rowText(content) {
  return stripAnsi(content).replace(/\s+$/u, '')
}

/**
 * The composer block's first row: the box the input sits in, drawn as `╭───…`.
 *
 * The chrome block is what a frame may repaint without a change of its own
 * (`src/paint.ts`: a frame with `chromeChanged` repaints every chrome row at or
 * below `chromeStart`, changed or not). Locating its top is how a judgement tells
 * "the frame repainted the input box it is entitled to redraw" from "the frame
 * repainted the transcript it must leave alone".
 */
export function composerTopRow(content) {
  let top
  for (const [row, rowContent] of content) {
    if (rowText(rowContent).startsWith('╭')) top = row
  }
  return top
}

/**
 * Whether one label row shows the option as chosen (`●`) or not (`○`).
 *
 * The markers are the product's (`questionOptionMarker`): a single-select list
 * opens with its first option chosen, and moving the highlight moves both the
 * caret and the mark.
 */
function labelState(content, label) {
  for (const [, rowContent] of content) {
    const text = rowText(rowContent)
    if (!text.includes(label)) continue
    return { chosen: text.includes('●'), text }
  }
  return undefined
}

/**
 * Judge probe step 6c: one arrow key inside a question layer.
 *
 * The window is what the terminal received between writing the key and the end of
 * the settle time. The judgement is per **frame** (the painter's own markers, see
 * `parsePaintFrames`), never per pty chunk, and never a filter on where the rows
 * are: the four checks below are the four things the step exists to prove, and
 * each one fails on its own evidence.
 *
 *   - `composer` — the input box is on screen, so the chrome block could be located;
 *   - `move` — the highlight actually moved from the first label to the second;
 *   - `repaint` — the layer was repainted (a frame addressed a row carrying a label);
 *   - `scope` — no frame repainted a row it did not change, except the chrome block
 *     (`paint.ts`: a frame with `chromeChanged` redraws the input box whole);
 *   - `transcript` — the rows above the layer's own top row did not move: a
 *     re-windowed viewport (the pre-B1.1 behaviour) shifts the whole band, while an
 *     independent clock or spinner touches one row, so the check allows
 *     `transcriptTickBudget` rows (default 2) and calls the band moving a failure.
 *     What it presumes is that no *turn* was running when the window opened: the
 *     probe waits for the strip to stop reporting work and logs which it was, because
 *     a streaming turn moves the transcript on its own;
 *   - `clear` — no full clear and no erase-below in the window.
 *
 * @param text - the captured stream (or just the window plus `initialContent`).
 * @param options.since - byte offset where the key was written.
 * @param options.until - byte offset where the settle time ended.
 * @param options.labels - the two option labels, in order.
 * @param options.height - the terminal's row count.
 * @param options.topChromeRows - rows above this one are chrome (the title rule).
 * @param options.initialContent - a row map to start from (fixture replay).
 */
export function judgeInteractionWindow(text, options) {
  const { since, until, labels, height } = options
  const topChromeRows = options.topChromeRows ?? 2
  const analysis = attributePaint(text, { since, until, ...(options.initialContent === undefined ? {} : { initialContent: options.initialContent }) })
  const { window, before, after } = analysis
  const checks = {}
  const record = (name, ok, detail) => { checks[name] = { ok, detail } }

  const chromeTop = composerTopRow(before) ?? composerTopRow(after)
  record('composer', chromeTop !== undefined,
    chromeTop === undefined
      ? 'the composer box was not on screen, so the chrome block could not be located'
      : `the chrome block starts at row ${chromeTop}`)

  const from = labelState(before, labels[0])
  const to = labelState(before, labels[1])
  const fromAfter = labelState(after, labels[0])
  const toAfter = labelState(after, labels[1])
  const labelled = from !== undefined && to !== undefined && fromAfter !== undefined && toAfter !== undefined
  record('move', labelled && from.chosen && !to.chosen && !fromAfter.chosen && toAfter.chosen,
    !labelled
      ? `the option labels ${labels.join(' / ')} were not both on screen`
      : `${labels[0]} ${from.chosen ? '●' : '○'} → ${fromAfter.chosen ? '●' : '○'}, ${labels[1]} ${to.chosen ? '●' : '○'} → ${toAfter.chosen ? '●' : '○'}`)

  const layerFrames = window.frames.filter(frame => frame.paint.some(entry => labels.some(label => entry.text.includes(label))))
  const layerRows = [...new Set(layerFrames.flatMap(frame => frame.paint.map(entry => entry.row)))].sort((left, right) => left - right)
  record('repaint', layerFrames.length > 0,
    layerFrames.length === 0
      ? 'moving the selection did not repaint the layer'
      : `${layerFrames.length} frame(s) addressed the layer (rows ${layerRows.join(',')})`)

  // The layer's top is where its own content starts — the option rows — not the
  // highest row of whatever frame happened to carry them: a frame that repainted the
  // transcript *and* the options is exactly the regression this check exists for, and
  // deriving the band from that frame would put the band's top inside the transcript
  // and excuse the very rows it painted.
  const optionRows = [before, after].flatMap(map => labels.map(label => {
    for (const [row, rowContent] of map) if (rowText(rowContent).includes(label)) return row
    return undefined
  })).filter(row => row !== undefined)
  const layerTop = optionRows.length === 0 ? undefined : Math.min(...optionRows)

  const unjustified = []
  for (const frame of window.frames) {
    for (const entry of frame.paint) {
      if (entry.changed) continue
      if (chromeTop !== undefined && entry.row >= chromeTop) continue
      unjustified.push({ row: entry.row, at: frame.start - since })
    }
  }
  record('scope', unjustified.length === 0,
    unjustified.length === 0
      ? `every row a frame painted had changed (chrome block rows ${chromeTop ?? '?'}..${height} excepted)`
      : unjustified.map(entry => `frame at +${entry.at}B repainted row ${entry.row} with the bytes it already held`).join('; '))

  const rewound = []
  if (layerTop !== undefined) {
    for (const [row, content] of after) {
      if (row <= topChromeRows || row >= layerTop) continue
      if (before.get(row) !== content) rewound.push(row)
    }
  }
  rewound.sort((left, right) => left - right)
  // A whole-transcript repaint is the regression; an independent tick is not. The
  // painter's own diffing means an unrelated clock or spinner touches one row (two
  // when a card carries both a clock and a spinner), while a re-window moves the
  // whole band — so the budget is stated rather than implied, and the case that
  // matters (M2b: five of five rows moved) stays red.
  const tickBudget = options.transcriptTickBudget ?? 2
  record('transcript', rewound.length <= tickBudget,
    rewound.length === 0
      ? `nothing above the layer's top row (${layerTop ?? '?'}) changed`
      : rewound.length <= tickBudget
        ? `${rewound.length} row(s) above the layer changed on their own (rows ${rewound.join(',')}; the tick budget is ${tickBudget})`
        : `the transcript above the layer moved: rows ${rewound.join(',')} (the frame re-windowed it)`)

  record('clear', window.clears.length === 0,
    window.clears.length === 0 ? 'no clear in the window' : `the screen was cleared: ${JSON.stringify(window.clears)}`)

  const failures = Object.entries(checks).filter(([, entry]) => !entry.ok).map(([name, entry]) => `${name}: ${entry.detail}`)
  return {
    ok: failures.length === 0,
    failures,
    checks,
    analysis,
    bands: { chromeTop, layerTop, height, topChromeRows },
    summary: {
      layerFrames: layerFrames.length,
      paintedRows: window.rows,
      changedRows: window.changedRows,
      unjustified: unjustified.map(entry => entry.row),
      clears: window.clears.length,
      frames: window.frames.length,
    },
  }
}
