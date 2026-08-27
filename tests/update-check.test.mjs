import test from 'node:test'
import assert from 'node:assert/strict'

import {
  checkForPluginUpdate,
  compareSemver,
  formatUpdateNotice,
  fetchLatestNpmVersion,
} from '../lib/update-check.js'

test('compareSemver orders dotted versions', () => {
  assert.equal(compareSemver('0.3.4', '0.3.5') < 0, true)
  assert.equal(compareSemver('0.3.5', '0.3.4') > 0, true)
  assert.equal(compareSemver('v0.3.4', '0.3.4'), 0)
  assert.equal(compareSemver('0.4.0', '0.3.9') > 0, true)
})

test('formatUpdateNotice is a copy-paste upgrade line', () => {
  const text = formatUpdateNotice('0.3.4', '0.3.5')
  assert.match(text, /0\.3\.5/)
  assert.match(text, /当前 0\.3\.4/)
  assert.match(text, /dsh plugin --profile tui add dsh-ssh-tui/)
})

test('fetchLatestNpmVersion returns undefined on HTTP failure', async () => {
  const latest = await fetchLatestNpmVersion(async () => new Response('nope', { status: 500 }))
  assert.equal(latest, undefined)
})

test('checkForPluginUpdate stays quiet when disabled or already current', async () => {
  const previous = process.env.DSH_TUI_NO_UPDATE_CHECK
  process.env.DSH_TUI_NO_UPDATE_CHECK = '1'
  try {
    assert.equal(await checkForPluginUpdate('0.0.1'), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_NO_UPDATE_CHECK
    else process.env.DSH_TUI_NO_UPDATE_CHECK = previous
  }
})
