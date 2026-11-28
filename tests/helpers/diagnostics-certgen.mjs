/**
 * Minimal X.509 generator for tests.
 *
 * Test-only private keys must not be committed. This helper builds a small
 * ECDSA P-256 CA + leaf certificates in memory with Node's crypto and a few
 * DER primitives, so every test run gets fresh synthetic material and the
 * repository never carries a private key.
 */
import { generateKeyPairSync, sign } from 'node:crypto'

const OID_CN = '2.5.4.3'
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2'
const OID_BASIC_CONSTRAINTS = '2.5.29.19'
const OID_KEY_USAGE = '2.5.29.15'
const OID_EXT_KEY_USAGE = '2.5.29.37'
const OID_SUBJECT_ALT_NAME = '2.5.29.17'
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1'
const OID_CLIENT_AUTH = '1.3.6.1.5.5.7.3.2'

function derLength(length) {
  if (length < 0x80) return Buffer.from([length])
  const bytes = []
  let value = length
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value >>= 8
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content])
}

function seq(...items) {
  return der(0x30, Buffer.concat(items))
}

function set(...items) {
  return der(0x31, Buffer.concat(items))
}

function integer(value) {
  let bytes = []
  let current = value
  if (current === 0) bytes = [0]
  while (current > 0) {
    bytes.unshift(current & 0xff)
    current = Math.floor(current / 256)
  }
  if ((bytes[0] & 0x80) !== 0) bytes.unshift(0)
  return der(0x02, Buffer.from(bytes))
}

function oid(value) {
  const parts = value.split('.').map(Number)
  const bytes = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f]
    let rest = Math.floor(part / 128)
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80)
      rest = Math.floor(rest / 128)
    }
    bytes.push(...encoded)
  }
  return der(0x06, Buffer.from(bytes))
}

function utf8(value) {
  return der(0x0c, Buffer.from(value, 'utf8'))
}

function octetString(value) {
  return der(0x04, value)
}

function bitString(value, unused = 0) {
  return der(0x03, Buffer.concat([Buffer.from([unused]), value]))
}

function boolean(value) {
  return der(0x01, Buffer.from([value ? 0xff : 0x00]))
}

function explicit(tagNumber, value) {
  return der(0xa0 + tagNumber, value)
}

function utcTime(value) {
  return der(0x17, Buffer.from(value, 'ascii'))
}

function name(commonName) {
  return seq(set(seq(oid(OID_CN), utf8(commonName))))
}

function extension(oidValue, critical, value) {
  return seq(oid(oidValue), ...(critical ? [boolean(true)] : []), octetString(value))
}

function basicConstraints(isCa) {
  return seq(boolean(isCa))
}

function keyUsage(isCa) {
  // CA: keyCertSign + cRLSign; leaf: digitalSignature.
  return isCa ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)
}

function extendedKeyUsage(server) {
  return seq(oid(server ? OID_SERVER_AUTH : OID_CLIENT_AUTH))
}

function subjectAltName() {
  const dns = der(0x82, Buffer.from('localhost', 'ascii'))
  const ip = der(0x87, Buffer.from([127, 0, 0, 1]))
  return seq(dns, ip)
}

function algorithm() {
  return seq(oid(OID_ECDSA_SHA256))
}

function tbsCertificate(input) {
  const extensions = []
  extensions.push(extension(OID_BASIC_CONSTRAINTS, true, basicConstraints(input.isCa)))
  extensions.push(extension(OID_KEY_USAGE, true, keyUsage(input.isCa)))
  if (!input.isCa) extensions.push(extension(OID_EXT_KEY_USAGE, false, extendedKeyUsage(input.server)))
  if (input.server) extensions.push(extension(OID_SUBJECT_ALT_NAME, false, subjectAltName()))
  return seq(
    explicit(0, integer(2)),
    integer(input.serial),
    algorithm(),
    name(input.issuer),
    seq(utcTime(input.notBefore), utcTime(input.notAfter)),
    name(input.subject),
    input.publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(...extensions)),
  )
}

export function createCertificate(input) {
  const tbs = tbsCertificate(input)
  const signature = sign('sha256', tbs, input.signingKey)
  const certificate = seq(tbs, algorithm(), bitString(signature))
  return certificate.toString('base64').replace(/(.{64})/g, '$1\n').trim()
}

export function pemFromBase64(base64, label) {
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END ${label}-----\n`
}

export function createTestPki() {
  const keyPair = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const caKeys = keyPair()
  const serverKeys = keyPair()
  const clientKeys = keyPair()
  const secondClientKeys = keyPair()
  const otherCaKeys = keyPair()
  const otherClientKeys = keyPair()
  const otherServerKeys = keyPair()
  const valid = { notBefore: '260101000000Z', notAfter: '490101000000Z' }
  const caBase = {
    subject: 'DSH Diagnostics Test CA',
    issuer: 'DSH Diagnostics Test CA',
    publicKey: caKeys.publicKey,
    signingKey: caKeys.privateKey,
    isCa: true,
    server: false,
    serial: 1,
    ...valid,
  }
  const ca = createCertificate(caBase)
  const otherCa = createCertificate({
    ...caBase,
    subject: 'DSH Diagnostics Other CA',
    issuer: 'DSH Diagnostics Other CA',
    publicKey: otherCaKeys.publicKey,
    signingKey: otherCaKeys.privateKey,
    serial: 2,
  })
  const leaf = (subject, publicKey, signingKey, serial, server) => createCertificate({
    subject,
    issuer: 'DSH Diagnostics Test CA',
    publicKey,
    signingKey,
    isCa: false,
    server,
    serial,
    ...valid,
  })
  const server = leaf('localhost', serverKeys.publicKey, caKeys.privateKey, 3, true)
  const client = leaf('dsh-diag-client', clientKeys.publicKey, caKeys.privateKey, 4, false)
  const secondClient = leaf('dsh-diag-second-client', secondClientKeys.publicKey, caKeys.privateKey, 7, false)
  const otherClient = createCertificate({
    subject: 'dsh-diag-other-client',
    issuer: 'DSH Diagnostics Other CA',
    publicKey: otherClientKeys.publicKey,
    signingKey: otherCaKeys.privateKey,
    isCa: false,
    server: false,
    serial: 5,
    ...valid,
  })
  const otherServer = createCertificate({
    subject: 'localhost',
    issuer: 'DSH Diagnostics Other CA',
    publicKey: otherServerKeys.publicKey,
    signingKey: otherCaKeys.privateKey,
    isCa: false,
    server: true,
    serial: 6,
    ...valid,
  })
  return {
    caCertPem: pemFromBase64(ca, 'CERTIFICATE'),
    caKeyPem: caKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    serverCertPem: pemFromBase64(server, 'CERTIFICATE'),
    serverKeyPem: serverKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    clientCertPem: pemFromBase64(client, 'CERTIFICATE'),
    clientKeyPem: clientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    secondClientCertPem: pemFromBase64(secondClient, 'CERTIFICATE'),
    secondClientKeyPem: secondClientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    otherCaCertPem: pemFromBase64(otherCa, 'CERTIFICATE'),
    otherClientCertPem: pemFromBase64(otherClient, 'CERTIFICATE'),
    otherClientKeyPem: otherClientKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    otherServerCertPem: pemFromBase64(otherServer, 'CERTIFICATE'),
    otherServerKeyPem: otherServerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}
