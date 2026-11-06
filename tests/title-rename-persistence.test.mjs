/**
 * TITLE.G1 — the title is a normal durable `session/title` event.
 *
 * This uses the shipped JSONL backend against a disposable synthetic root:
 * create, flush, close, reopen, append a second title, flush, and let the
 * Picker's derived mtime/size cache miss and read the new label. No real Home,
 * Session or DSH_HOME is touched.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listResumableSessionsProgressive } from '../lib/session-list.js'

const userMessage = {
  type: 'user/message',
  seq: 0,
  time: 1,
  surfaceOp: 'append',
  data: {
    id: 'm0',
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'synthetic prompt' }],
  },
}

const titleEvent = (seq, title) => ({
  type: 'session/title',
  seq,
  time: seq + 10,
  data: { title, messageSeqs: [], source: { kind: 'user' } },
})

test('a flushed session/title survives reopen and invalidates the Picker cache', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-title-g1-'))
  const ctx = new Context()
  await apply(ctx, { root, compression: 'none' })
  const persistence = ctx.sessionPersistence
  const id = 'synthetic-title-g1'
  const header = {
    version: 4,
    id,
    createdAt: 1,
    cwd: root,
    isSeeded: false,
    delegationDepth: 0,
  }
  const indexPath = join(root, 'picker-index.json')
  try {
    const writer = await persistence.create(header)
    await writer.append([userMessage, titleEvent(1, 'Old title')])
    await writer.flush()
    await writer.close()

    const first = await listResumableSessionsProgressive(persistence, '', {
      listHosts: async () => [],
      indexPath,
    })
    assert.equal(first.complete[0]?.label, 'Old title')

    const secondWriter = await persistence.open(id, 'write')
    await secondWriter.append([titleEvent(2, '新的标题🚀')])
    await secondWriter.flush()
    await secondWriter.close()

    const second = await listResumableSessionsProgressive(persistence, '', {
      listHosts: async () => [],
      indexPath,
    })
    assert.equal(second.complete[0]?.label, '新的标题🚀')

    const reader = await persistence.open(id, 'read')
    const stored = await reader.read()
    await reader.close()
    assert.equal(stored.events.at(-1)?.data?.title, '新的标题🚀')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
