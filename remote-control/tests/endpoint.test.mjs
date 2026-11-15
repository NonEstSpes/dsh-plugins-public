import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { CompactEncrypt, compactDecrypt } from 'jose';
import { openEndpoint as rawOpenEndpoint } from '../lib/endpoint.mjs';
import { openJsonStore as rawOpenJsonStore } from '../lib/store.mjs';
import { pair } from '../scripts/pair.mjs';

const resources = new Set();
async function openEndpoint(...args) {
  const endpoint = await rawOpenEndpoint(...args);
  resources.add(endpoint);
  return endpoint;
}
async function openJsonStore(...args) {
  const store = await rawOpenJsonStore(...args);
  resources.add(store);
  return store;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const digest = value => createHash('sha256').update(value).digest('hex');

async function eventually(check, message, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  assert.fail(`Timed out: ${message}`);
}

class FakeRelay {
  requests = [];
  attempts = [];
  acknowledged = [];
  queues = new Map([['controller', []], ['worker', []]]);
  tokens = new Map([['controller_token_0123456789', 'controller'], ['worker_token_0123456789', 'worker']]);
  peers = new Map([['controller', 'worker'], ['worker', 'controller']]);
  sent = new Map();
  failAfterAccept = false;
  onAck;
  override;

  enqueue(packet) { this.queues.get(packet.to).push(packet); }

  fetch = async (url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.method, 'POST');
    assert.ok(options.signal instanceof AbortSignal);
    const sender = this.tokens.get(options.headers.authorization.replace(/^Bearer /, ''));
    assert.ok(sender, 'valid device bearer');
    const route = new URL(url).pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    this.requests.push({ route, sender });
    if (this.override) return this.override({ route, sender, body, options });
    if (route === 'send') {
      this.attempts.push(body.ciphertext);
      assert.equal(body.to, this.peers.get(sender));
      const key = `${sender}:${body.id}`;
      const previous = this.sent.get(key);
      if (previous) assert.equal(previous.ciphertext, body.ciphertext, 'retry must use original ciphertext');
      else {
        const packet = { id: body.id, from: sender, to: body.to, ciphertext: body.ciphertext, receivedAt: new Date().toISOString() };
        this.sent.set(key, packet);
        this.enqueue(packet);
      }
      if (this.failAfterAccept) {
        this.failAfterAccept = false;
        throw new Error('simulated network loss after durable relay acceptance');
      }
      return json({ accepted: true });
    }
    if (route === 'poll') return json({ items: this.queues.get(sender).slice(0, 16) });
    if (route === 'ack') {
      await this.onAck?.(sender, body.ids);
      this.acknowledged.push(...body.ids);
      this.queues.set(sender, this.queues.get(sender).filter(item => !body.ids.includes(item.id)));
      return json({ acknowledged: true });
    }
    assert.fail('Unexpected relay route');
  };
}

function settings(root, key, role = 'worker', extra = {}) {
  return {
    role, id: role, peerId: role === 'worker' ? 'controller' : 'worker',
    relayUrl: 'https://relay.invalid', relayToken: `${role}_token_0123456789`,
    sharedKey: key.toString('base64url'), stateDir: path.join(root, role), allowLoopback: false,
    ...extra,
  };
}

function envelope(id, overrides = {}) {
  const now = Date.now();
  return {
    version: 1, id, from: 'controller', to: 'worker',
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
    kind: 'command', body: { operationId: id, action: 'status', text: 'TOP_SECRET_PLAINTEXT' },
    ...overrides,
  };
}

async function encrypt(value, key, header = { alg: 'dir', enc: 'A256GCM' }) {
  return new CompactEncrypt(new TextEncoder().encode(JSON.stringify(value))).setProtectedHeader(header).encrypt(key);
}

async function packet(id, key, overrides = {}, outer = {}) {
  return { id, from: 'controller', to: 'worker', ciphertext: await encrypt(envelope(id, overrides), key), receivedAt: new Date().toISOString(), ...outer };
}

async function storeTests(root) {
  const file = path.join(root, 'store', 'state.json');
  const store = await openJsonStore(file, { count: 0, nested: { value: 1 } });
  const snapshot = store.get();
  snapshot.nested.value = 99;
  assert.equal(store.get().nested.value, 1);
  await assert.rejects(openJsonStore(file, {}), { code: 'STORE_LOCKED' });
  const updates = Array.from({ length: 12 }, () => store.update(async state => {
    const before = state.count;
    await delay(1);
    state.count = before + 1;
  }));
  await Promise.all(updates);
  assert.equal(store.get().count, 12, 'serialized async mutators');
  await assert.rejects(store.update(() => { throw new Error('mutator failure'); }));
  await store.update(state => { state.nested.value = 2; });
  const pending = store.update(state => { state.count++; });
  await store.close();
  await pending;
  assert.equal(JSON.parse(await readFile(file, 'utf8')).count, 13, 'close flushes queued writes');
  await assert.rejects(store.update(() => {}));
  const reopened = await openJsonStore(file, { count: -1 });
  assert.equal(reopened.get().count, 13, 'initial is ENOENT-only');
  await reopened.close();
  const corrupt = '{"count":';
  await writeFile(file, corrupt);
  await assert.rejects(openJsonStore(file, { count: 0 }), { code: 'STORE_CORRUPT' });
  assert.equal(await readFile(file, 'utf8'), corrupt, 'corruption never overwritten');
  await writeFile(`${file}.lock`, 'orphaned');
  await assert.rejects(openJsonStore(file, {}), { code: 'STORE_LOCKED' });
  assert.equal(await readFile(`${file}.lock`, 'utf8'), 'orphaned', 'stale lock never stolen');
  await assert.rejects(openJsonStore(path.join(root, 'CON.json'), {}), /Unsafe store filename/);
  const replacement = await openJsonStore(path.join(root, 'replacement.json'), { initial: true });
  assert.deepEqual(await replacement.update(() => ({ replaced: true })), { replaced: true });
  await assert.rejects(replacement.update(() => ({ notJSON: undefined })));
  assert.deepEqual(replacement.get(), { replaced: true });
  await replacement.close();
}

async function validationTests(root, key) {
  const badUrls = [
    'http://example.com', 'http://127.0.0.1', 'https://user:password@relay.invalid',
    'https://relay.invalid?token=secret', 'https://relay.invalid#secret', 'https://relay.invalid?',
    'https://relay.invalid#', 'https://@relay.invalid', 'ftp://relay.invalid', 'https://relay.invalid\\evil',
  ];
  for (const relayUrl of badUrls) await assert.rejects(openEndpoint(settings(root, key, 'worker', { relayUrl }), { onMessage() {} }));
  for (const relayUrl of ['http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://127.0.0.2', 'http://localhost.example', 'http://example.com']) {
    await assert.rejects(openEndpoint(settings(root, key, 'worker', { relayUrl, allowLoopback: true }), { onMessage() {} }));
  }
  for (const relayUrl of ['http://127.0.0.1:8787', 'http://localhost:8787', 'http://[::1]:8787']) {
    const endpoint = await openEndpoint(settings(root, key, 'worker', { relayUrl, allowLoopback: true }), { onMessage() {} });
    assert.ok(endpoint.status().relayOrigin.startsWith('http:'));
    await endpoint.close();
  }
  for (const sharedKey of ['bad', randomBytes(31).toString('base64url'), `${key.toString('base64url')}=`]) {
    await assert.rejects(openEndpoint(settings(root, key, 'worker', { sharedKey }), { onMessage() {} }));
  }
}

async function outboxTests(root, key) {
  const relay = new FakeRelay();
  globalThis.fetch = relay.fetch;
  const config = settings(root, key, 'controller');
  let endpoint = await openEndpoint(config, { onMessage() {} });
  const sent = await endpoint.send('command', { operationId: 'operation', text: 'TOP_SECRET_PLAINTEXT' }, { id: 'outbound' });
  assert.deepEqual(sent, { id: 'outbound' });
  assert.equal(relay.requests.length, 0, 'no network before start');
  const file = path.join(config.stateDir, 'endpoint.json');
  const raw = await readFile(file, 'utf8');
  assert.ok(!raw.includes('TOP_SECRET_PLAINTEXT'));
  const original = JSON.parse(raw).outbox[0].ciphertext;
  const decoded = await compactDecrypt(original, key);
  assert.deepEqual(decoded.protectedHeader, { alg: 'dir', enc: 'A256GCM' });
  assert.equal(JSON.parse(new TextDecoder().decode(decoded.plaintext)).id, 'outbound');
  await endpoint.send('command', { text: 'TOP_SECRET_PLAINTEXT', operationId: 'operation' }, { id: 'outbound' });
  assert.equal(JSON.parse(await readFile(file, 'utf8')).outbox[0].ciphertext, original);
  await assert.rejects(endpoint.send('command', { operationId: 'different' }, { id: 'outbound' }), { code: 'ID_COLLISION' });
  await assert.rejects(endpoint.send('command', { text: 'x'.repeat(70 * 1024) }), { code: 'MESSAGE_TOO_LARGE' });
  await endpoint.close();
  relay.failAfterAccept = true;
  endpoint = await openEndpoint(config, { onMessage() {} });
  endpoint.start();
  endpoint.start();
  await eventually(() => relay.attempts.length === 1, 'first persisted outbound attempt');
  await endpoint.close();
  endpoint = await openEndpoint(config, { onMessage() {} });
  endpoint.start();
  await eventually(() => endpoint.status().outbox.sent === 1, 'retry after endpoint restart');
  assert.ok(relay.attempts.length >= 2);
  assert.ok(relay.attempts.every(value => value === original));
  const status = JSON.stringify(endpoint.status());
  assert.ok(!status.includes(config.relayToken) && !status.includes(config.sharedKey) && !status.includes(original));
  await endpoint.close();
  await assert.rejects(endpoint.send('response', {}), { code: 'ENDPOINT_CLOSED' });
  assert.throws(() => endpoint.start(), { code: 'ENDPOINT_CLOSED' });
}

async function inboxTests(root, key) {
  const relay = new FakeRelay();
  globalThis.fetch = relay.fetch;
  const config = settings(root, key);
  const file = path.join(config.stateDir, 'endpoint.json');
  const now = Date.now();
  const incoming = await packet('durable', key, { createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 2000).toISOString() });
  relay.enqueue(incoming);
  let attempts = 0;
  let effects = 0;
  const handled = new Set();
  const errors = [];
  const handler = async received => {
    attempts++;
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(snapshot.inbox.find(item => item.id === received.id).state, 'pending', 'acceptance durable before handler');
    if (!handled.has(received.body.operationId)) {
      handled.add(received.body.operationId);
      effects++;
    }
    if (attempts === 1) throw new Error('TOP_SECRET_PLAINTEXT must not leak through onError');
  };
  let endpoint = await openEndpoint(config, { onMessage: handler, onError: error => errors.push(error.message) });
  endpoint.start();
  await eventually(() => attempts === 1 && errors.some(message => message.includes('HANDLER_FAILED')), 'failed durable handler');
  assert.equal(relay.acknowledged.length, 0, 'no ACK before successful durable handler');
  await endpoint.close();
  await delay(Math.max(0, now + 2050 - Date.now()));
  relay.onAck = async (_sender, ids) => {
    const state = JSON.parse(await readFile(file, 'utf8'));
    for (const id of ids) assert.notEqual(state.inbox.find(item => item.id === id)?.state, 'pending', 'ACK follows durable completion/quarantine');
  };
  endpoint = await openEndpoint(config, { onMessage: handler, onError: error => errors.push(error.message) });
  endpoint.start();
  await eventually(() => relay.acknowledged.includes('durable'), 'accepted command retries after expiry/restart');
  assert.equal(attempts, 2);
  assert.equal(effects, 1, 'durable handler reconciles unknown outcome instead of blindly redoing effect');
  await endpoint.close();
  relay.enqueue(incoming);
  endpoint = await openEndpoint(config, { onMessage: handler });
  endpoint.start();
  await eventually(() => relay.queues.get('worker').length === 0, 'persisted duplicate is ACKed');
  assert.equal(attempts, 2, 'persistent received-ID dedup');
  const different = await packet('durable', key, { body: { operationId: 'different' } });
  relay.enqueue(different);
  await eventually(() => endpoint.status().quarantineCount >= 1 && relay.queues.get('worker').length === 0, 'same id/different ciphertext quarantined');
  assert.equal(attempts, 2);
  const state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.inbox.find(item => item.id === 'durable').hash, digest(incoming.ciphertext), 'original dedup binding retained');
  assert.ok(state.inbox[0].retainUntil >= state.inbox[0].acceptedAt + 24 * 60 * 60 * 1000);
  assert.ok(errors.every(message => !message.includes('TOP_SECRET_PLAINTEXT')));
  await endpoint.close();
}

async function cryptoTests(root, key) {
  const relay = new FakeRelay();
  globalThis.fetch = relay.fetch;
  const errors = [];
  let executed = 0;
  const endpoint = await openEndpoint(settings(root, key), { onMessage() { executed++; }, onError: error => errors.push(error.code) });
  const now = Date.now();
  relay.enqueue(await packet('expired', key, { createdAt: new Date(now - 2000).toISOString(), expiresAt: new Date(now - 1000).toISOString() }));
  relay.enqueue(await packet('future', key, { createdAt: new Date(now + 6 * 60_000).toISOString(), expiresAt: new Date(now + 7 * 60_000).toISOString() }));
  relay.enqueue(await packet('lifetime', key, { expiresAt: new Date(now + 25 * 60 * 60_000).toISOString() }));
  relay.enqueue(await packet('inner-route', key, { to: 'somebody_else' }));
  relay.enqueue(await packet('inner-id', key, { id: 'not-matching' }));
  relay.enqueue(await packet('outer-route', key, {}, { from: 'somebody_else' }));
  relay.enqueue(await packet('version', key, { version: 2 }));
  relay.enqueue(await packet('body', key, { body: [] }));
  relay.enqueue(await packet('invalid-time', key, { createdAt: 'yesterday' }));
  relay.enqueue(await packet('wrong-key', randomBytes(32)));
  relay.enqueue(await packet('malformed', key, {}, { ciphertext: 'not.a.compact.jwe' }));
  const tampered = await packet('tampered', key);
  const parts = tampered.ciphertext.split('.');
  parts[4] = (parts[4][0] === 'A' ? 'B' : 'A') + parts[4].slice(1);
  tampered.ciphertext = parts.join('.');
  relay.enqueue(tampered);
  relay.enqueue(await packet('unexpected-header', key, {}, { ciphertext: await encrypt(envelope('unexpected-header'), key, { alg: 'dir', enc: 'A256GCM', typ: 'JWT' }) }));
  relay.enqueue(await packet('algorithm', key, {}, { ciphertext: await encrypt(envelope('algorithm'), randomBytes(16), { alg: 'dir', enc: 'A128GCM' }) }));
  const count = relay.queues.get('worker').length;
  endpoint.start();
  await eventually(() => relay.acknowledged.length >= count, 'invalid crypto/expiry/routing quarantine and ACK');
  assert.equal(executed, 0);
  assert.equal(endpoint.status().inbox.quarantined, count);
  assert.ok(errors.includes('EXPIRED') && errors.includes('CLOCK_SKEW') && errors.includes('INVALID_ROUTING') && errors.includes('INVALID_CRYPTO'));
  await endpoint.close();
}

async function transportTests(root, key) {
  let requests = 0;
  const errors = [];
  globalThis.fetch = async (_url, options) => {
    requests++;
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 307, headers: { location: 'https://attacker.invalid/steal' } });
  };
  let endpoint = await openEndpoint(settings(path.join(root, 'redirect'), key), { onMessage() { assert.fail('redirect executed'); }, onError: error => errors.push(error.code) });
  endpoint.start();
  await eventually(() => errors.includes('HTTP_REDIRECT'), 'redirect refusal');
  await delay(100);
  assert.equal(requests, 1, 'backoff, no busy redirect retry');
  await endpoint.close();
  for (const withLength of [true, false]) {
    globalThis.fetch = async () => new Response(withLength ? '{}' : 'x'.repeat(100 * 1024 + 1), { headers: { 'content-type': 'application/json', ...(withLength ? { 'content-length': String(100 * 1024 + 1) } : {}) } });
    const localErrors = [];
    endpoint = await openEndpoint(settings(path.join(root, `large-${withLength}`), key), { onMessage() { assert.fail('oversized response executed'); }, onError: error => localErrors.push(error.code) });
    endpoint.start();
    await eventually(() => localErrors.includes('RESPONSE_TOO_LARGE'), 'bounded response bytes');
    await endpoint.close();
  }
  let active = 0;
  globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
    active++;
    options.signal.addEventListener('abort', () => {
      active--;
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });
  endpoint = await openEndpoint(settings(path.join(root, 'abort'), key), { onMessage() {} });
  endpoint.start();
  await eventually(() => active === 1, 'active long poll');
  await endpoint.close();
  await endpoint.close();
  assert.equal(active, 0, 'close aborts owned request');
}

async function corruptionTests(root, key) {
  const config = settings(root, key);
  const endpoint = await openEndpoint(config, { onMessage() {} });
  await endpoint.close();
  const file = path.join(config.stateDir, 'endpoint.json');
  const state = JSON.parse(await readFile(file, 'utf8'));
  state.binding.peerId = 'changed';
  const corrupt = JSON.stringify(state);
  await writeFile(file, corrupt);
  await assert.rejects(openEndpoint(config, { onMessage() {} }), { code: 'STATE_BINDING_MISMATCH' });
  assert.equal(await readFile(file, 'utf8'), corrupt);
}

async function pairingTests(root) {
  const directory = path.join(root, '.private');
  const result = await pair({ url: 'https://relay.invalid', out: directory });
  assert.equal(result.files.length, 3);
  const controllerRaw = await readFile(path.join(directory, 'controller.json'), 'utf8');
  const controller = JSON.parse(controllerRaw);
  const worker = JSON.parse(await readFile(path.join(directory, 'worker.json'), 'utf8'));
  const relayRaw = await readFile(path.join(directory, 'relay.json'), 'utf8');
  const relay = JSON.parse(relayRaw);
  assert.equal(controller.sharedKey, worker.sharedKey);
  assert.equal(Buffer.from(controller.sharedKey, 'base64url').length, 32);
  assert.notEqual(controller.relayToken, worker.relayToken);
  assert.notEqual(controller.relayToken, controller.sharedKey);
  assert.equal(controller.peerId, worker.id);
  assert.equal(worker.peerId, controller.id);
  assert.deepEqual(worker.projects, {});
  assert.equal(controller.delivery, 'notify');
  assert.ok(!relayRaw.includes(controller.sharedKey) && !relayRaw.includes(controller.relayToken) && !relayRaw.includes(worker.relayToken));
  assert.equal(relay.devices.find(item => item.id === controller.id).tokenHash, digest(controller.relayToken));
  assert.equal(await readFile(path.join(directory, '.gitignore'), 'utf8'), '*\n!.gitignore\n');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'controller.json'))).mode & 0o777, 0o600);
  await assert.rejects(pair({ url: 'https://relay.invalid', out: directory }), /overwrite/);
  assert.equal(await readFile(path.join(directory, 'controller.json'), 'utf8'), controllerRaw);
  await assert.rejects(pair({ url: 'http://example.com', out: path.join(root, 'bad'), allowLoopback: true }));
}

/** No child processes, no real network, no relay server, and no credential reads. */
export async function runEndpointTests() {
  const originalFetch = globalThis.fetch;
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-endpoint-'));
  const key = randomBytes(32);
  const cases = [
    ['store', () => storeTests(path.join(root, 'store-tests'))],
    ['settings', () => validationTests(path.join(root, 'validation'), key)],
    ['outbox', () => outboxTests(path.join(root, 'outbox'), key)],
    ['inbox', () => inboxTests(path.join(root, 'inbox'), key)],
    ['crypto', () => cryptoTests(path.join(root, 'crypto'), key)],
    ['transport', () => transportTests(path.join(root, 'transport'), key)],
    ['corruption', () => corruptionTests(path.join(root, 'corruption'), key)],
    ['pairing', () => pairingTests(path.join(root, 'pairing'))],
  ];
  try {
    for (const [name, run] of cases) {
      await mkdir(path.join(root, name), { recursive: true });
      await run();
    }
    return { passed: cases.length, cases: cases.map(([name]) => name) };
  } finally {
    await Promise.allSettled([...resources].map(resource => resource.close()));
    resources.clear();
    globalThis.fetch = originalFetch;
    key.fill(0);
    // Only remove the exact fresh temporary directory allocated above.
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('dsh-remote-endpoint-')) throw new Error('Unsafe test cleanup path');
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runEndpointTests().then(result => console.log(`Endpoint tests passed (${result.passed} groups)`), error => {
    console.error(error);
    process.exitCode = 1;
  });
}
