/** Terminal outbox identity remains authenticated without retaining completed ciphertext. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac, hkdfSync, randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { CompactEncrypt } from 'jose'
import { openEndpoint } from '../lib/endpoint.mjs'
import { createRelay } from '../relay/server.mjs'
const hash = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function eventually(check) { const end = Date.now() + 6000; while (Date.now() < end) { if (await check()) return; await delay(20) } assert.fail('endpoint did not reach its durable state') }
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-outbox-compaction-'))), owned = [], key = randomBytes(32)
  t.after(async () => {
    for (const resource of owned.reverse()) await resource.close()
    const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.equal(path.basename(target).startsWith('dsh-outbox-compaction-'), true)
    await rm(target, { recursive: true, force: true })
  })
  const controllerToken = randomBytes(32).toString('base64url'), workerToken = randomBytes(32).toString('base64url')
  const relay = createRelay({ directory: path.join(root, 'relay'), pollMs: 20, devices: [
    { id: 'controller', peerId: 'worker', tokenHash: hash(controllerToken) }, { id: 'worker', peerId: 'controller', tokenHash: hash(workerToken) },
  ] }); owned.push(relay)
  let sent = 0; relay.server.on('request', request => { if (request.url === '/v1/send') sent++ })
  await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address(); assert.ok(address && typeof address !== 'string')
  const settings = role => ({ role, id: role, peerId: role === 'controller' ? 'worker' : 'controller', protocol: 2, pairingGeneration: 1,
    relayUrl: `http://127.0.0.1:${address.port}`, allowLoopback: true, relayToken: role === 'controller' ? controllerToken : workerToken,
    sharedKey: key.toString('base64url'), stateDir: path.join(root, role) })
  const open = async (role, onMessage = async () => {}) => { const endpoint = await openEndpoint(settings(role), { onMessage }); owned.push(endpoint); return endpoint }
  return { root, key, settings, open, sent: () => sent, read: async role => JSON.parse(await readFile(path.join(root, role, 'endpoint.json'), 'utf8')) }
}

test('completed ciphertext becomes an authenticated receipt and same-id restart never redelivers its body', async t => {
  const f = await fixture(t), body = { text: 'x'.repeat(16384) }, id = 'completed_original_id', expiresAt = Date.now() + 60000
  let handled = 0
  const receiver = await f.open('worker', async () => { handled++ }), sender = await f.open('controller')
  await sender.send('command', body, { id, expiresAt })
  const pending = (await f.read('controller')).outbox[0]; assert.equal(pending.state, 'pending'); assert.equal(typeof pending.ciphertext, 'string')
  receiver.start(); sender.start()
  await eventually(() => sender.status().outbox.sent === 1 && receiver.status().inbox.done === 1)
  await sender.close()
  const compact = await f.read('controller'), terminal = compact.outbox[0]
  assert.equal(compact.version, 2); assert.equal(Object.hasOwn(terminal, 'ciphertext'), false); assert.match(terminal.receipt, /^[a-f0-9]{64}$/)
  assert.equal(terminal.id, pending.id); assert.equal(terminal.digest, pending.digest); assert.equal(terminal.createdAt, pending.createdAt); assert.equal(terminal.expiresAt, expiresAt)
  const sent = f.sent(), reopened = await f.open('controller')
  assert.deepEqual(await reopened.send('command', body, { id, expiresAt }), { id })
  await assert.rejects(reopened.send('command', { text: 'different' }, { id, expiresAt }), { code: 'ID_COLLISION' })
  reopened.start(); await eventually(() => reopened.status().connection === 'connected')
  assert.equal(f.sent(), sent); assert.equal(handled, 1); await reopened.close()
  const tampered = await f.read('controller'); tampered.outbox[0].receipt = '0'.repeat(64)
  await writeFile(path.join(f.root, 'controller', 'endpoint.json'), JSON.stringify(tampered))
  await assert.rejects(f.open('controller'), { code: 'STATE_CORRUPT' })
})

test('v1 migration verifies every original envelope, preserves pending ciphertext and refuses a malformed legacy digest without upgrading', async t => {
  const f = await fixture(t), now = Date.now(), expiry = now + 60000, body = { text: 'legacy pending' }
  const make = async (id, state, text) => {
    const content = { text }, envelope = { version: 1, id, from: 'controller', to: 'worker', createdAt: new Date(now).toISOString(), expiresAt: new Date(expiry).toISOString(), kind: 'command', body: content }
    const ciphertext = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(envelope))).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(f.key)
    return { id, digest: hash(JSON.stringify({ body: content, kind: 'command' })), ciphertext, expiresAt: expiry, retainUntil: now + 86400000, attempts: 0, nextAt: 0, state }
  }
  const pending = await make('legacy_pending_id', 'pending', body.text), sent = await make('legacy_sent_id', 'sent', 'legacy completed')
  const binding = { id: 'controller', peerId: 'worker', role: 'controller', keyHash: hash(f.key), protocol: 2, pairingGeneration: 1 }
  const legacy = { version: 1, binding, outbox: [pending, sent], inbox: [], acks: [], quarantine: [] }
  await mkdir(path.join(f.root, 'controller')); await writeFile(path.join(f.root, 'controller', 'endpoint.json'), JSON.stringify(legacy))
  let handled = 0
  const receiver = await f.open('worker', async envelope => { assert.equal(envelope.id, pending.id); assert.deepEqual(envelope.body, body); handled++ })
  const sender = await f.open('controller'), migrated = await f.read('controller')
  assert.equal(migrated.version, 2); assert.equal(migrated.outbox[0].ciphertext, pending.ciphertext); assert.equal(migrated.outbox[0].createdAt, now)
  assert.equal(migrated.outbox[1].id, sent.id); assert.equal(migrated.outbox[1].digest, sent.digest); assert.equal(migrated.outbox[1].expiresAt, sent.expiresAt)
  assert.equal(Object.hasOwn(migrated.outbox[1], 'ciphertext'), false); assert.match(migrated.outbox[1].receipt, /^[a-f0-9]{64}$/); assert.equal(f.sent(), 0)
  assert.deepEqual(await sender.send('command', body, { id: pending.id, expiresAt: expiry }), { id: pending.id })
  receiver.start(); sender.start(); await eventually(() => sender.status().outbox.pending === 0 && handled === 1)
  assert.equal(f.sent(), 1); await sender.close()
  const invalid = structuredClone(legacy); invalid.outbox[0].digest = 'f'.repeat(64)
  const directory = path.join(f.root, 'invalid-legacy'); await mkdir(directory); const file = path.join(directory, 'endpoint.json')
  await writeFile(file, JSON.stringify(invalid))
  await assert.rejects(openEndpoint({ ...f.settings('controller'), stateDir: directory }, { onMessage: async () => {} }), { code: 'STATE_CORRUPT' })
  const unchanged = JSON.parse(await readFile(file, 'utf8')); assert.equal(unchanged.version, 1); assert.equal(unchanged.outbox[0].ciphertext, pending.ciphertext)
})

// Offline, owned-key fixtures: exercise record boundaries without relay calls or thousands of sends.
const canonicalJSON = value => Array.isArray(value) ? `[${value.map(canonicalJSON).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}` : JSON.stringify(value)
async function capacityFixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-outbox-capacity-'))), owned = [], key = randomBytes(32), now = Date.now(), body = { text: 'capacity fixture' }
  const binding = { id: 'controller', peerId: 'worker', role: 'controller', keyHash: hash(key), protocol: 2, pairingGeneration: 1 }
  const receiptKey = Buffer.from(hkdfSync('sha256', key, Buffer.from('dsh-remote:endpoint:outbox-terminal:v2'), Buffer.from(canonicalJSON(binding)), 32))
  t.after(async () => {
    for (const endpoint of owned.reverse()) await endpoint.close()
    key.fill(0); receiptKey.fill(0)
    const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.equal(path.basename(target).startsWith('dsh-outbox-capacity-'), true)
    await rm(target, { recursive: true, force: true })
  })
  const fields = (id, state) => ({ id, digest: hash(canonicalJSON({ kind: 'command', body })), createdAt: now, expiresAt: now + 60000, retainUntil: now + 86400000, attempts: 0, nextAt: 0, state })
  const terminal = index => {
    const item = fields(`receipt_${index}`, 'sent')
    item.receipt = createHmac('sha256', receiptKey).update(canonicalJSON({ version: 2, binding, entry: item })).digest('hex')
    return item
  }
  const pending = async index => {
    const item = fields(`pending_${index}`, 'pending')
    const envelope = { version: 1, id: item.id, from: binding.id, to: binding.peerId, createdAt: new Date(now).toISOString(), expiresAt: new Date(item.expiresAt).toISOString(), kind: 'command', body }
    item.ciphertext = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(envelope))).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key)
    return item
  }
  const file = path.join(root, 'endpoint.json'), config = { ...binding, relayUrl: 'https://relay.invalid', relayToken: randomBytes(32).toString('base64url'), sharedKey: key.toString('base64url'), stateDir: root }
  delete config.keyHash
  const open = async () => { const endpoint = await openEndpoint(config, { onMessage: async () => assert.fail('offline fixture must not run') }); owned.push(endpoint); return endpoint }
  return { body, file, terminal, pending, open, read: async () => JSON.parse(await readFile(file, 'utf8')),
    seed: async (outbox, version = 2) => writeFile(file, JSON.stringify({ version, binding, outbox, inbox: [], acks: [], quarantine: [] })) }
}

test('outbox capacity admits a 513th record without changing retained receipts or restart identity', async t => {
  const f = await capacityFixture(t), receipts = Array.from({ length: 512 }, (_, index) => f.terminal(index)), id = 'record_513'
  const receiptBytes = JSON.stringify(receipts)
  await f.seed(receipts)
  const sender = await f.open()
  assert.deepEqual(await sender.send('command', f.body, { id }), { id })
  const admitted = await f.read(), pending = admitted.outbox[512]
  assert.equal(admitted.outbox.length, 513); assert.equal(JSON.stringify(admitted.outbox.slice(0, 512)), receiptBytes)
  assert.equal(pending.state, 'pending'); assert.equal(typeof pending.ciphertext, 'string'); assert.equal(pending.retainUntil, pending.createdAt + 86400000)
  await sender.close()
  const reopened = await f.open()
  for (const duplicate of ['receipt_0', 'receipt_1', id]) {
    assert.deepEqual(await reopened.send('command', f.body, { id: duplicate }), { id: duplicate })
    await assert.rejects(reopened.send('command', { text: 'changed body' }, { id: duplicate }), { code: 'ID_COLLISION' })
  }
  assert.deepEqual(await f.read(), admitted, 'reopen/dedup preserves receipt bytes and original pending ciphertext/ID')
})

test('outbox capacity still admits only 256 pending messages across reopen', async t => {
  const f = await capacityFixture(t), pending = await Promise.all(Array.from({ length: 255 }, (_, index) => f.pending(index)))
  await f.seed(pending)
  const sender = await f.open()
  await sender.send('command', f.body, { id: 'pending_256' })
  const full = await f.read(); assert.equal(full.outbox.length, 256); assert.deepEqual(full.outbox.slice(0, 255), pending)
  await assert.rejects(sender.send('command', f.body, { id: 'pending_257' }), { code: 'OUTBOX_CAPACITY' })
  await sender.close()
  const reopened = await f.open()
  await assert.rejects(reopened.send('command', f.body, { id: 'pending_257' }), { code: 'OUTBOX_CAPACITY' })
  assert.deepEqual(await f.read(), full, 'failed admission never evicts or changes pending ciphertext')
})

test('outbox capacity uses the strict 8192 record admission and reload boundary', async t => {
  const f = await capacityFixture(t), receipts = Array.from({ length: 8191 }, (_, index) => f.terminal(index))
  await f.seed(receipts)
  const sender = await f.open()
  await sender.send('command', f.body, { id: 'record_8192' })
  const full = await f.read(); assert.equal(full.outbox.length, 8192); assert.deepEqual(full.outbox.slice(0, 8191), receipts)
  await assert.rejects(sender.send('command', f.body, { id: 'record_8193' }), { code: 'OUTBOX_CAPACITY' })
  assert.deepEqual(await f.read(), full, 'full record budget does not trim unexpired receipts')
  await sender.close()
  const reopened = await f.open()
  assert.deepEqual(await reopened.send('command', f.body, { id: 'receipt_0' }), { id: 'receipt_0' })
  await assert.rejects(reopened.send('command', { text: 'changed body' }, { id: 'receipt_0' }), { code: 'ID_COLLISION' })
  await reopened.close()
  await f.seed([...full.outbox, f.terminal(8192)])
  const oversized = await readFile(f.file, 'utf8')
  await assert.rejects(f.open(), { code: 'STATE_CORRUPT' })
  assert.equal(await readFile(f.file, 'utf8'), oversized, 'oversized state fails closed without rewriting')
})

test('legacy v1 input retains its 512 ciphertext record validation bound', async t => {
  const f = await capacityFixture(t), legacy = await Promise.all(Array.from({ length: 513 }, (_, index) => f.pending(index)))
  for (const item of legacy) { delete item.createdAt; item.state = 'sent' }
  await f.seed(legacy, 1)
  const oversized = await readFile(f.file, 'utf8')
  await assert.rejects(f.open(), { code: 'STATE_CORRUPT' })
  assert.equal(await readFile(f.file, 'utf8'), oversized, 'oversized legacy input is not migrated or rewritten')
})
