#!/usr/bin/env node
/**
 * Synthetic Messages endpoint for H11. It binds loopback *inside* the test
 * network namespace so the SSH blackhole never touches provider traffic and the
 * host's firewall is not modified.
 */
import { startMockLlmServer } from '/root/dsh-ssh-tui/node_modules/@deepseek-ai/dsh-llm-mock-server/lib/index.js'
import process from 'node:process'

const port = Number(process.argv[2] ?? '0')
const server = await startMockLlmServer({
  host: '127.0.0.1',
  port,
  apiKey: 'sk-h11-synthetic',
  sequence: ['slow_success'],
  repeatLast: true,
  successText: `H11-STREAM-${'x'.repeat(48)}`,
  chunkSize: 1,
  chunkDelayMs: 180,
})
console.log(`H11_MOCK_READY ${server.port} ${server.baseURL}`)
const stop = async () => { await server.close(); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
setInterval(() => {}, 1000)
