/**
 * The footer, in four parts — and the module every caller has always imported.
 *
 * `tui.ts` paints from here, `/status` reports from here, and a dozen tests
 * reach in through this path. The pass that turned the strip into a status row
 * split the file along the four responsibilities that had grown together inside
 * it; this module stays as the barrel so that split cost no call site:
 *
 * - `footer-format.ts`      — a value in, text out (and the pressure reading).
 * - `footer-meters.ts`      — the three meter primitives.
 * - `footer-budget.ts`      — the responsive degradation ladder and the row.
 * - `footer-layout.ts`      — the two chrome rows, and `/status`.
 *
 * The one helper they all share — `accent`, the "paint this run in this role's
 * colour" primitive — lives in `color-depth.ts` beside `downgradeSgr`, which is
 * where "what can this terminal take" is already answered.
 *
 * Import from here unless you are inside the footer; the four modules import
 * each other in exactly that order and never back.
 *
 * @module dsh-ssh-tui/footer
 */

export * from './footer-format.js'
export * from './footer-meters.js'
export * from './footer-budget.js'
export * from './footer-layout.js'
