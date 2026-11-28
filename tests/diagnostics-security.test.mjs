import test from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'

const SOURCE_DIR = new URL('../src/diagnostics/', import.meta.url)

async function sources() {
  const names = (await readdir(SOURCE_DIR)).filter((name) => name.endsWith('.ts')).sort()
  const out = []
  for (const name of names) out.push({ name, text: await readFile(new URL(name, SOURCE_DIR), 'utf8') })
  return out
}

test('the sender never creates a listener and never relaxes TLS', async () => {
  for (const { name, text } of await sources()) {
    assert.equal(/createServer\s*\(/.test(text), false, `${name} must not create a server`)
    assert.equal(/\.listen\s*\(/.test(text), false, `${name} must not listen`)
    assert.equal(/rejectUnauthorized\s*:\s*false/.test(text), false, `${name} must not disable TLS verification`)
    assert.equal(/NODE_TLS_REJECT_UNAUTHORIZED/.test(text), false, `${name} must not rely on a TLS env escape hatch`)
    assert.equal(/['"`]http:\/\//.test(text), false, `${name} must not contain a plaintext HTTP endpoint`)
  }
})

test('the transport pins TLS 1.3 and the request signer domain', async () => {
  const text = await readFile(new URL('transport.ts', SOURCE_DIR), 'utf8')
  assert.match(text, /minVersion:\s*'TLSv1\.3'/)
  assert.match(text, /maxVersion:\s*'TLSv1\.3'/)
  assert.match(text, /checkServerIdentity/)
  assert.match(text, /x-dsh-diag-signature/)
  assert.equal(text.includes('Authorization: Bearer'), false)
})

test('no test fixture or source file in this change carries a private key literal', async () => {
  const files = await sources()
  for (const { name, text } of files) {
    // The scanner and its tests mention the marker; source modules must not
    // contain an actual PEM block.
    assert.equal(/-----BEGIN [A-Z ]*PRIVATE KEY-----\\n[A-Za-z0-9+/=]/.test(text), false, name)
  }
})
