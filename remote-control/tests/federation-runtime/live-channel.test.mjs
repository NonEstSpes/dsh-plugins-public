/** Real HTTP/JWE derived-live carrier proofs; not native Worker or application live acceptance. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { CompactEncrypt } from 'jose'
import { createRelay } from '../../relay/server.mjs'
import { openLiveChannel } from '../../lib/live-channel.mjs'
import { LIVE_CHANNEL, LIVE_CHANNEL_LIMITS as L } from '../../lib/live-channel-protocol.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('live fixture deadline')), 10_000) })]) }
  finally { clearTimeout(timer) }
}
async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-live-channel-'))
  const controllerToken = randomBytes(24).toString('base64url'), workerToken = randomBytes(24).toString('base64url')
  const relay = createRelay({ directory: path.join(root, 'relay'), devices: [
    { id: 'controller', peerId: 'worker', tokenHash: hash(controllerToken) },
    { id: 'worker', peerId: 'controller', tokenHash: hash(workerToken) },
  ], pollMs: 1000, ...options })
  await new Promise(resolve => { relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (address === null || typeof address === 'string') throw new Error('missing relay address')
  const relayUrl = `http://127.0.0.1:${address.port}/`, sharedKey = randomBytes(32).toString('base64url')
  const settings = role => ({ protocol: 2, role, id: role, peerId: role === 'controller' ? 'worker' : 'controller',
    pairingGeneration: 3, sharedKey, relayUrl, allowLoopback: true,
    relayToken: role === 'controller' ? controllerToken : workerToken })
  const channels = []
  const open = (role, handlers) => { const value = openLiveChannel(settings(role), handlers); channels.push(value); return value }
  const post = async (route, body, token = controllerToken) => {
    const result = await fetch(new URL(route, relayUrl), { method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: result.status, value: await result.json() }
  }
  t.after(async () => {
    await Promise.allSettled(channels.map(channel => channel.close()))
    await relay.close()
    // root was minted by mkdtemp in this fixture, never an unchecked caller path.
    await rm(root, { recursive: true, force: true })
  })
  return { root, relay, relayUrl, settings, open, post, sharedKey, controllerToken, workerToken }
}
async function packet(h, body, options = {}) {
  const now = Date.now(), packetId = options.id ?? randomUUID(), expiresAt = options.expiresAt ?? now + L.maxLifetimeMs
  const envelope = { version: 1, id: packetId, from: 'controller', to: 'worker', pairingGeneration: 3,
    createdAt: now, expiresAt, purpose: LIVE_CHANNEL, body, ...options.envelope }
  const ciphertext = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(envelope)))
    .setProtectedHeader(options.header ?? { alg: 'dir', enc: 'A256GCM', typ: LIVE_CHANNEL })
    .encrypt(Buffer.from(h.sharedKey, 'base64url'))
  return { id: packetId, to: 'worker', ciphertext, expiresAt }
}

test('more than512 bidirectional live packets do not create endpoint journals or grow durable relay state', async t => {
  const h = await fixture(t), replies = new Map(), errors = []
  let worker
  const controller = h.open('controller', { onMessage: body => { replies.get(body.index)?.resolve(body) }, onError: value => { errors.push(value) } })
  worker = h.open('worker', { onMessage: async body => { await worker.send({ type: 'data', index: body.index, value: 'source-only Ж' }) },
    onError: value => { errors.push(value) } })
  assert.deepEqual(await Promise.all([controller.start(), worker.start()]), [true, true])
  const before = await readdir(path.join(h.root, 'relay'))
  const stateBefore = await readFile(path.join(h.root, 'relay', 'state.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error })
  for (let index = 0; index < 640; index++) {
    const reply = deferred(); replies.set(index, reply)
    await controller.send({ type: 'pull', index })
    assert.deepEqual(await bounded(reply.promise), { type: 'data', index, value: 'source-only Ж' })
    replies.delete(index)
  }
  assert.equal(controller.status().replayRecords, 640)
  assert.equal(worker.status().replayRecords, 640)
  assert.equal(controller.status().pending, 0)
  assert.equal(worker.status().pending, 0)
  assert.deepEqual(errors, [])
  assert.deepEqual(await readdir(h.root), ['relay'])
  assert.deepEqual(await readdir(path.join(h.root, 'relay')), before)
  assert.equal(await readFile(path.join(h.root, 'relay', 'state.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error }), stateBefore)
})

test('duplicate ciphertext is not re-delivered and same-ID collisions retire the carrier with static diagnostics', async t => {
  const h = await fixture(t), first = deferred(), marker = deferred(), failure = deferred(), values = []
  const worker = h.open('worker', { onMessage: body => { values.push(body.index); if (body.index === 1) first.resolve(); else marker.resolve() },
    onError: value => { failure.resolve(value) } })
  assert.equal(await worker.start(), true)
  const original = await packet(h, { type: 'data', index: 1 })
  assert.equal((await h.post('v1/live/send', original)).status, 200)
  await bounded(first.promise)
  assert.equal((await h.post('v1/live/send', original)).status, 200)
  assert.equal((await h.post('v1/live/send', await packet(h, { type: 'data', index: 2 }))).status, 200)
  await bounded(marker.promise)
  assert.deepEqual(values, [1, 2])
  const collision = await packet(h, { type: 'data', private: 'PRIVATE_COLLISION' }, { id: original.id })
  assert.equal((await h.post('v1/live/send', collision)).status, 200)
  assert.equal((await bounded(failure.promise)).code, 'ID_COLLISION')
  assert.equal(worker.status().running, false)
  assert.doesNotMatch(JSON.stringify(worker.status()), /PRIVATE_COLLISION|ciphertext|sharedKey/)
})

test('new purpose, pairing generation and exact closed body separate derived reads from durable requests', async t => {
  const h = await fixture(t), failure = deferred(), received = []
  const worker = h.open('worker', { onMessage: value => { received.push(value) }, onError: value => { failure.resolve(value) } })
  assert.equal(await worker.start(), true)
  const wrongGeneration = await packet(h, { type: 'data', private: 'PRIVATE_GENERATION' }, { envelope: { pairingGeneration: 2 } })
  assert.equal((await h.post('v1/live/send', wrongGeneration)).status, 200)
  assert.equal((await bounded(failure.promise)).code, 'INVALID_ENVELOPE')
  assert.deepEqual(received, [])
  assert.equal(await worker.start(), true)
  await assert.rejects(worker.send({ type: 'request', op: 'session.prompt', private: 'PRIVATE_MUTATION' }), /INVALID_LIVE_BODY/)
  const secondFailure = deferred()
  const separate = h.open('controller', { onMessage: () => {}, onError: value => { secondFailure.resolve(value) } })
  assert.equal(await separate.start(), true)
  const now = Date.now(), ciphertext = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify({ version: 1,
    id: 'durable-envelope', from: 'worker', to: 'controller', createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 10_000).toISOString(), kind: 'federation', body: { type: 'request', op: 'session.prompt' } })))
    .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(Buffer.from(h.sharedKey, 'base64url'))
  assert.equal((await h.post('v1/live/send', { id: 'durable-envelope', to: 'controller', ciphertext, expiresAt: now + 10_000 }, h.workerToken)).status, 200)
  assert.equal((await bounded(secondFailure.promise)).code, 'INVALID_CRYPTO')
  assert.doesNotMatch(JSON.stringify(worker.status()), /PRIVATE_GENERATION|PRIVATE_MUTATION/)
})

test('relay enforces peer authorization and bounded offline mailboxes independently of durable capacity', async t => {
  const h = await fixture(t, { maxPending: 2 })
  const first = await packet(h, { type: 'data', value: 1 })
  assert.equal((await h.post('v1/live/send', first, 'incorrect_bearer_token_123456')).status, 401)
  assert.equal((await h.post('v1/live/send', { ...first, to: 'controller' })).status, 403)
  assert.equal((await h.post('v1/live/send', first)).status, 200)
  assert.equal((await h.post('v1/live/send', await packet(h, { type: 'data', value: 2 }))).status, 200)
  assert.equal((await h.post('v1/live/send', await packet(h, { type: 'data', value: 3 }))).status, 429)
  const polled = await h.post('v1/live/poll', {}, h.workerToken)
  assert.equal(polled.status, 200); assert.equal(polled.value.items.length, 2)
  assert.equal((await h.post('v1/live/send', await packet(h, { type: 'data', value: 4 }))).status, 200)
  assert.equal((await h.post('v1/live/send', { ...await packet(h, { type: 'data' }), expiresAt: Date.now() + L.maxLifetimeMs + L.clockSkewMs + 10_000 })).status, 400)
})

test('live routing requires the same reciprocal configured peers as durable delivery', async t => {
  const token = randomBytes(24).toString('base64url')
  for (const recipient of [undefined, { id: 'worker', peerId: 'third', tokenHash: hash(randomBytes(24).toString('base64url')) }]) {
    const h = await fixture(t, { devices: [
      { id: 'controller', peerId: 'worker', tokenHash: hash(token) },
      ...(recipient === undefined ? [] : [recipient, { id: 'third', peerId: 'worker', tokenHash: hash(randomBytes(24).toString('base64url')) }]),
    ] })
    const value = await packet(h, { type: 'data' })
    assert.equal((await h.post('v1/live/send', value, token)).status, 403)
    const { expiresAt: _expiresAt, ...durable } = value
    assert.equal((await h.post('v1/send', durable, token)).status, 403)
  }
})

test('complete multibyte live bodies have an exact bound and close joins an outstanding long poll', async t => {
  const h = await fixture(t), got = deferred(), received = []
  const worker = h.open('worker', { onMessage: value => { received.push(value); got.resolve() } })
  const controller = h.open('controller', { onMessage: () => {} })
  assert.deepEqual(await Promise.all([worker.start(), controller.start()]), [true, true])
  const empty = { type: 'data', text: '' }, overhead = Buffer.byteLength(JSON.stringify(empty))
  const text = 'Ж'.repeat(Math.floor((L.maxFrameBytes - overhead) / 2)) + ((L.maxFrameBytes - overhead) % 2 ? 'x' : '')
  assert.equal(Buffer.byteLength(JSON.stringify({ ...empty, text })), L.maxFrameBytes)
  await controller.send({ ...empty, text }); await bounded(got.promise)
  assert.equal(received[0].text, text)
  await assert.rejects(controller.send({ ...empty, text: text + 'x' }), /MESSAGE_TOO_LARGE/)
  const caller = new AbortController(); caller.abort({ get code() { throw new Error('PRIVATE_ABORT_REASON') } })
  await assert.rejects(controller.send({ type: 'data' }, caller.signal), /REQUEST_ABORTED/)
  await bounded(Promise.all([worker.close(), controller.close()]))
  assert.equal(worker.status().replayRecords, 0)
  assert.equal(controller.status().closed, true)
})

test('channel close aborts and joins its admitted callback before releasing replay state', async t => {
  const h = await fixture(t), entered = deferred(), released = deferred()
  let callbackSignal, completed = false
  const worker = h.open('worker', { onMessage: async (_body, signal) => { callbackSignal = signal; entered.resolve(); await released.promise } })
  assert.equal(await worker.start(), true)
  assert.equal((await h.post('v1/live/send', await packet(h, { type: 'data' }))).status, 200)
  await bounded(entered.promise)
  const closing = worker.close().then(() => { completed = true })
  try {
    assert.equal(callbackSignal.aborted, true)
    await Promise.resolve()
    assert.equal(completed, false)
    assert.equal(worker.status().replayRecords, 1)
  } finally { released.resolve(); await bounded(closing) }
  assert.equal(worker.status().replayRecords, 0)
})

test('offline relay byte quota bounds large messages before the item quota and IDs reject trailing newlines', async t => {
  const h = await fixture(t)
  assert.throws(() => openLiveChannel({ ...h.settings('controller'), id: 'controller\n' }, { onMessage() {} }), /INVALID_SETTINGS/)
  const first = await packet(h, { type: 'data', value: 'x'.repeat(31_000) })
  assert.equal((await h.post('v1/live/send', { ...first, id: first.id + '\n' })).status, 400)
  assert.equal((await h.post('v1/live/send', { ...first, ciphertext: first.ciphertext + '\n' })).status, 400)
  let accepted = 0
  for (let index = 0; index < 20; index++) {
    const value = await h.post('v1/live/send', await packet(h, { type: 'data', value: 'x'.repeat(31_000) }))
    if (value.status === 429) break
    assert.equal(value.status, 200); accepted++
  }
  assert.ok(accepted > 0 && accepted < 20)
  assert.ok(accepted < L.maxPending)
})

test('async diagnostic rejection is contained without exposing its private failure', async t => {
  const h = await fixture(t), reported = deferred()
  const worker = h.open('worker', { onMessage() {}, onError: async value => {
    reported.resolve(value)
    throw new Error('PRIVATE_ASYNC_DIAGNOSTIC')
  } })
  assert.equal(await worker.start(), true)
  assert.equal((await h.post('v1/live/send', await packet(h, { type: 'data' }, { envelope: { pairingGeneration: 2 } }))).status, 200)
  assert.equal((await bounded(reported.promise)).code, 'INVALID_ENVELOPE')
  await worker.close()
  assert.doesNotMatch(JSON.stringify(worker.status()), /PRIVATE_ASYNC_DIAGNOSTIC/)
})

test('a valid nonblocking relay does not cause an idle live poll hot loop', async t => {
  const h = await fixture(t, { pollMs: 0 }), first = deferred()
  let polls = 0
  h.relay.server.on('request', req => { if (req.url === '/v1/live/poll') { polls++; first.resolve() } })
  const worker = h.open('worker', { onMessage() {} })
  assert.equal(await worker.start(), true)
  await bounded(first.promise)
  await new Promise(resolve => { setTimeout(resolve, L.minEmptyPollMs / 2) })
  assert.equal(polls, 1)
  await bounded(worker.close())
})

test('the owner publication guard rechecks after encryption and prevents a newly unauthorized POST', async t => {
  const h = await fixture(t)
  let posts = 0, authorized = true, guards = 0
  h.relay.server.on('request', request => { if (request.url === '/v1/live/send') posts++ })
  const controller = h.open('controller', { onMessage() {} })
  assert.equal(await controller.start(), true)
  const refusal = Object.assign(new Error('owner authority changed'), { code: 'grant-changed' })
  const pending = controller.send({ type: 'data', value: 'PRIVATE_NOT_PUBLISHED' }, undefined, () => {
    guards++
    if (!authorized) throw refusal
  })
  authorized = false
  await assert.rejects(pending, error => error === refusal)
  assert.equal(guards, 1); assert.equal(posts, 0)
  assert.equal(controller.status().running, true, 'An owner refusal does not mislabel the carrier as a network failure')
})

test('an old relay explicitly reports unsupported without sending any live payload', async t => {
  const requests = []
  const server = http.createServer((req, res) => { requests.push(req.url); req.resume(); res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}') })
  await new Promise(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('missing old relay address')
  const channel = openLiveChannel({ protocol: 2, role: 'controller', id: 'controller', peerId: 'worker', pairingGeneration: 1,
    sharedKey: randomBytes(32).toString('base64url'), relayToken: randomBytes(24).toString('base64url'),
    relayUrl: `http://127.0.0.1:${address.port}/`, allowLoopback: true }, { onMessage: () => {} })
  t.after(async () => { await channel.close(); await new Promise(resolve => { server.close(resolve) }) })
  assert.equal(await channel.start(), false)
  assert.equal(channel.status().supported, false)
  await assert.rejects(channel.send({ type: 'data' }), /LIVE_UNAVAILABLE/)
  assert.deepEqual(requests, ['/v1/live/info'])
})
