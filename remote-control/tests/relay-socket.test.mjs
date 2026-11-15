import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { createRelay } from '../relay/server.mjs'
import { openRelaySocket } from '../lib/relay-socket.mjs'

async function fixture(t, pollMs = 0) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-relay-ws-'))
  const tokens = { a: randomBytes(32).toString('base64url'), b: randomBytes(32).toString('base64url') }
  const relay = createRelay({ directory, pollMs, devices: ['a', 'b'].map(id => ({ id, peerId: id === 'a' ? 'b' : 'a',
    tokenHash: createHash('sha256').update(tokens[id]).digest('hex') })) })
  await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
  const settings = id => ({ relayUrl: `http://127.0.0.1:${relay.server.address().port}/`, allowLoopback: true,
    relayToken: tokens[id], relayTransport: 'auto', relaySocketConnectTimeoutMs: 1000, requestTimeoutMs: 5000 })
  const owned = []
  const socket = id => { const value = openRelaySocket(settings(id)); owned.push(value); return value }
  t.after(async () => {
    await Promise.all(owned.map(value => value.close())); await relay.close()
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('dsh-relay-ws-'))
    await fs.rm(directory, { recursive: true })
  })
  return { relay, settings, socket }
}
test('authenticated socket reuses send/poll/ack and bounds frames without leaking transport data', async t => {
  const h = await fixture(t), a = h.socket('a'), b = h.socket('b')
  assert.deepEqual(await a.request('send', { id: 'packet', to: 'b', ciphertext: 'opaque-jwe' }), { status: 200, body: { accepted: true } })
  assert.equal((await b.request('poll', {})).body.items[0].ciphertext, 'opaque-jwe')
  assert.deepEqual((await b.request('ack', { ids: ['packet'] })).body, { acknowledged: true })
  assert.deepEqual((await b.request('poll', {})).body.items, [])
  const refusal = new Error('private publication refusal'), before = a.status()
  await assert.rejects(a.request('send', { id: 'guarded', to: 'b', ciphertext: 'never-published' }, undefined,
    () => { throw refusal }), error => error === refusal)
  assert.equal(a.status().requestsSent, before.requestsSent)
  assert.equal(a.status().framesSent, before.framesSent)
  assert.deepEqual((await b.request('poll', {})).body.items, [])
  await assert.rejects(a.request('send', { id: 'huge', to: 'b', ciphertext: 'x'.repeat(100 * 1024) }), { code: 'SOCKET_FRAME_TOO_LARGE' })
  const wrong = openRelaySocket({ ...h.settings('a'), relayToken: 'wrong-token-value-123456' })
  try { await assert.rejects(wrong.request('live/info', {}), { code: 'RELAY_AUTH_FAILED' }) } finally { await wrong.close() }
  const status = a.status()
  assert.ok(status.bytesSent > 0 && status.bytesReceived > 0)
  assert.equal(JSON.stringify(status).includes('opaque-jwe'), false)
  assert.equal(JSON.stringify(status).includes(h.settings('a').relayToken), false)
})
test('old relay is HTTPS-eligible before publication, but a disconnect after sending never replays', async t => {
  let upgrades = 0, httpRequests = 0
  const old = http.createServer((_req, res) => { httpRequests++; res.end() })
  old.on('upgrade', (_req, socket) => { upgrades++; socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n') })
  await new Promise(resolve => old.listen(0, '127.0.0.1', resolve))
  const legacy = openRelaySocket({ relayUrl: `http://127.0.0.1:${old.address().port}/`, allowLoopback: true,
    relayToken: 'valid-shaped-token-123456', relayTransport: 'auto', relaySocketConnectTimeoutMs: 1000, requestTimeoutMs: 5000 })
  try {
    assert.equal(await legacy.request('poll', {}), undefined)
    assert.equal(await legacy.request('poll', {}), undefined)
    assert.equal(upgrades, 1); assert.equal(httpRequests, 0)
  } finally { await legacy.close(); await new Promise(resolve => old.close(resolve)) }
  const h = await fixture(t), sender = h.socket('a')
  h.relay.server.on('upgrade', (_req, socket) => { socket.once('data', () => socket.destroy()) })
  await assert.rejects(sender.request('send', { id: 'unknown-result', to: 'b', ciphertext: 'same-original-jwe' }), { code: 'SOCKET_DISCONNECTED' })
  assert.equal(sender.status().requestsSent, 1)
})
test('cancelling one long poll releases the existing mailbox owner before the next socket request', async t => {
  const h = await fixture(t, 30000), a = h.socket('a'), b = h.socket('b'), cancelled = new AbortController()
  const pending = b.request('poll', {}, cancelled.signal)
  await b.request('live/info', {})
  cancelled.abort(new Error('private cancellation'))
  await assert.rejects(pending, { code: 'REQUEST_ABORTED' })
  const replacement = b.request('poll', {})
  await b.request('live/info', {})
  await a.request('send', { id: 'next-packet', to: 'b', ciphertext: 'opaque' })
  assert.equal((await replacement).body.items[0].id, 'next-packet')
  await b.close()
  const reconnected = h.socket('b')
  assert.equal((await reconnected.request('live/info', {})).status, 200)
})
