/** Terminal outbox identity remains authenticated without retaining completed ciphertext. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
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
