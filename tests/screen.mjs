/**
 * A real terminal grid for screen-level assertions.
 *
 * Shared by the paint and picker screen tests: both need to know what the user
 * ends up *seeing* after a sequence of bytes, which no string-level assertion
 * can tell (residue under a repaint, a row addressed past the viewport, a caret
 * outside a real cell, an alternate screen that was never given back).
 */
import xterm from '@xterm/headless'

const { Terminal } = xterm

export function screen(cols, rows) {
  const term = new Terminal({ cols, rows, allowProposedApi: true })
  const flush = () => new Promise(resolve => term.write('', resolve))
  return {
    term,
    /** `normal` or `alternate`: which buffer the terminal is showing. */
    get bufferType() { return term.buffer.active.type },
    async write(data) {
      term.write(data)
      await flush()
    },
    async resize(cols2, rows2) {
      term.resize(cols2, rows2)
      // A real terminal that reflows on resize also scrolls its viewport into
      // scrollback. Absolute addressing (row 1 = the first *visible* row) is
      // relative to the active screen, so the viewport has to be back on it.
      term.scrollToBottom()
      await flush()
    },
    /**
     * Visible rows with the frame's right-padding removed, as the user reads
     * them. The frames pad every row to the full width, so the raw grid keeps
     * that padding and only `grid()` should assert on it.
     */
    lines() {
      const buffer = term.buffer.active
      const out = []
      for (let i = 0; i < buffer.length; i++) {
        out.push((buffer.getLine(i)?.translateToString(true) ?? '').replace(/\s+$/u, ''))
      }
      return out
    },
    /**
     * The grid the user sees: `baseY` rows are scrollback above the viewport,
     * so line 0 of the screen is buffer line `baseY`. Reading from 0 compares
     * scrollback instead of the screen and looks like "the repaint missed".
     */
    grid() {
      const buffer = term.buffer.active
      const out = []
      for (let i = 0; i < term.rows; i++) {
        out.push((buffer.getLine(buffer.baseY + i)?.translateToString(true) ?? '').padEnd(term.cols, ' '))
      }
      return out
    },
    cursor() {
      const buffer = term.buffer.active
      return { x: buffer.cursorX, y: buffer.baseY + buffer.cursorY }
    },
  }
}
