/**
 * One place that says "this home is a first run", for the probes that assert on
 * the *workspace*.
 *
 * Since 0.8.2 a home with nothing configured boots the **setup wizard**, which
 * owns the keyboard — and that is the correct behaviour (it used to be an empty
 * workspace with no hint that `/setup` exists). It also means every workspace
 * probe pointed at an unconfigured home fails on a symptom of that fix: `/diag`
 * and `/status` never answer because the wizard is what is on screen. The failure
 * reads like a broken command, and the reader has to work out that the home, not
 * the product, is the subject.
 *
 * The wizard's contract has its own probe (`tui-setup-probe.mjs`), and the other
 * direction — configured ⇒ no wizard — is asserted there too, so a workspace
 * probe that skips an unconfigured home leaves nothing uncovered. A **skip is not
 * a pass**: `verify-batch.mjs` closes the run `INCOMPLETE` when it sees one.
 *
 * Both spellings the wizard has shipped are matched, because the *workspace* probe
 * cannot assume a locale: the onboarding row (`首次启动` / `Setup`), the wizard's
 * own step title (`安装向导 1/9`), and its provider step (`选择提供商`).
 */
export const FIRST_RUN_PATTERN = /首次启动|安装向导|Setup \d\/9|选择提供商/u

/** Whether the screen shows the first-run wizard rather than the workspace. */
export function isFirstRun(text) {
  return FIRST_RUN_PATTERN.test(text)
}

/** The three lines every workspace probe prints before it stands down. */
export function printFirstRunSkip(contract) {
  console.log(`SKIP: this home is a first run — the setup wizard owns the screen, so ${contract}`)
  console.log('      was not exercised here. Point the probe at a configured home:')
  console.log('      `node scripts/probe-home.mjs ...` builds one; the wizard has `tui-setup-probe.mjs`.')
}
