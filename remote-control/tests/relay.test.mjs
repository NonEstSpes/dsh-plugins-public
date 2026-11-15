import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRelay } from '../relay/server.mjs';
import { main as relayMain } from '../relay/cli.mjs';

const BODY_BYTES = 100 * 1024;
const CIPHER_BYTES = 80 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');

function request(port, route, token, body = {}, options = {}) {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'POST';
    const payload = options.raw !== undefined ? Buffer.from(options.raw)
      : method === 'GET' ? undefined : Buffer.from(JSON.stringify(body));
    const headers = {
      ...(payload ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      ...(payload && !options.chunked ? { 'Content-Length': payload.length } : {}),
      ...(token !== undefined ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    };
    const req = http.request({
      host: '127.0.0.1', port, path: route, method, headers, agent: false,
      ...(options.signal ? { signal: options.signal } : {}),
    }, (res) => {
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > BODY_BYTES) req.destroy(new Error('Response byte cap exceeded'));
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          assert.equal(res.headers['cache-control'], 'no-store');
          assert.equal(res.headers['set-cookie'], undefined);
          assert.equal(res.headers['access-control-allow-origin'], undefined);
          assert.equal(Number(res.headers['content-length']), bytes);
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, headers: res.headers, bytes, raw, json: JSON.parse(raw) });
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(6000, () => req.destroy(new Error('HTTP test timeout')));
    req.on('error', reject);
    if (payload && options.chunked) {
      req.write(payload.subarray(0, Math.floor(payload.length / 2)));
      req.end(payload.subarray(Math.floor(payload.length / 2)));
    } else req.end(payload);
  });
}

async function listen(relay) {
  await new Promise((resolve, reject) => {
    relay.server.once('error', reject);
    relay.server.listen(0, '127.0.0.1', () => {
      relay.server.off('error', reject);
      resolve();
    });
  });
  assert.equal(relay.server.address().address, '127.0.0.1');
  return relay.server.address().port;
}

/** Real ephemeral loopback servers, builtin assert, no subprocesses or dependencies. */
export async function runRelayTests() {
  const temporaryBase = path.resolve(await fs.realpath(os.tmpdir()));
  const prefix = 'dsh-relay-tests-';
  const root = await fs.mkdtemp(path.join(temporaryBase, prefix));
  const owner = randomUUID();
  await fs.writeFile(path.join(root, '.owner'), owner, { flag: 'wx', mode: 0o600 });
  const running = new Set();
  const tests = [];
  const tokens = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, randomBytes(32).toString('base64url')]));
  const devices = ['a', 'b', 'c', 'd'].map((id) => ({
    id, tokenHash: hash(tokens[id]), peerId: ({ a: 'b', b: 'a', c: 'd', d: 'c' })[id],
  }));

  async function start(name, settings = {}) {
    const directory = path.join(root, name);
    const relay = createRelay({ directory, devices, pollMs: 0, ...settings });
    running.add(relay);
    const port = await listen(relay);
    const call = (route, id, body, options) => request(port, route, tokens[id], body, options);
    return { ...relay, directory, port, call, original: relay };
  }
  async function stop(fixture) {
    await fixture.close();
    running.delete(fixture.original ?? fixture);
  }
  async function test(name, action) {
    try { await action(); }
    catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    }
    tests.push(name);
  }
  async function accepted(fixture, id, ciphertext = `opaque-${id}`, to = 'b', from = 'a') {
    const result = await fixture.call('/v1/send', from, { id, to, ciphertext });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { accepted: true });
    return result;
  }
  async function items(fixture, id = 'b') {
    const result = await fixture.call('/v1/poll', id, {});
    assert.equal(result.status, 200);
    return result.json.items;
  }
  async function ack(fixture, ids, id = 'b') {
    const result = await fixture.call('/v1/ack', id, { ids });
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { acknowledged: true });
  }

  try {
    await test('health, bearer authentication, no cookies/CORS and peer allowlist', async () => {
      const f = await start('auth');
      const health = await request(f.port, '/health', undefined, undefined, { method: 'GET' });
      assert.equal(health.status, 200);
      assert.deepEqual(health.json, { protocol: 1, service: 'dsh-remote-relay' });
      assert.equal((await request(f.port, '/health', undefined, {}, { method: 'GET', raw: '{}' })).status, 400);
      assert.equal((await request(f.port, '/health', undefined, {}, {
        method: 'GET', raw: 'x'.repeat(BODY_BYTES + 1),
      })).status, 413);
      for (const route of ['/v1/send', '/v1/poll', '/v1/ack']) {
        assert.equal((await request(f.port, route)).status, 401);
        assert.equal((await request(f.port, route, 'incorrect')).status, 401);
        assert.equal((await request(f.port, route, undefined, {}, {
          headers: { Cookie: `token=${tokens.a}` },
        })).status, 401);
      }
      assert.equal((await request(f.port, '/v1/poll', undefined, {}, {
        headers: { Authorization: [`Bearer ${tokens.a}`, `Bearer ${tokens.b}`] },
      })).status, 401);
      assert.equal((await f.call('/v1/send', 'a', { id: 'wrong', to: 'c', ciphertext: 'opaque' })).status, 403);
      assert.equal((await f.call('/v1/send', 'a', { id: 'wrong', to: 'missing', ciphertext: 'opaque' })).status, 403);
      assert.equal((await f.call('/v1/send', 'a', {
        id: 'spoof', to: 'b', ciphertext: 'opaque', from: 'c',
      })).status, 400);
      await accepted(f, 'derived');
      assert.equal((await items(f))[0].from, 'a');
      assert.throws(() => createRelay({ directory: path.join(root, 'invalid'), devices: [
        { id: 'a', peerId: 'b', tokenHash: tokens.a },
      ] }), /configuration/);
      assert.throws(() => createRelay({ directory: path.join(root, 'invalid-hash'), devices: [
        { id: 'a', peerId: 'b', tokenHash: hash(tokens.a) + '\n' },
      ] }), /configuration/);
      await stop(f);
    });

    await test('routing traversal and malformed JSON/types never reach filesystem paths', async () => {
      const f = await start('paths');
      const sentinel = path.join(root, 'do-not-touch.txt');
      await fs.writeFile(sentinel, 'owned sentinel');
      for (const id of ['../outside', '..', 'a/b', 'a\\b', '%2e%2e', 'x'.repeat(81), '', 'id\n', 'id\r', 'id\u2028', 42]) {
        assert.equal((await f.call('/v1/send', 'a', { id, to: 'b', ciphertext: 'opaque' })).status, 400);
        assert.equal((await f.call('/v1/ack', 'b', { ids: [id] })).status, 400);
      }
      assert.equal((await f.call('/v1/send', 'a', { id: 'good', to: '../b', ciphertext: 'opaque' })).status, 400);
      for (const route of ['/v1/../../state.json', '/state.json', '/v1/send?file=state.json', '/%2e%2e/state.json']) {
        assert.equal((await f.call(route, 'a', {})).status, 404);
      }
      for (const raw of ['{', 'null', '[]', '123', Buffer.from([0x7b, 0x22, 0xc3, 0x28, 0x22, 0x3a, 0x31, 0x7d])]) {
        assert.equal((await f.call('/v1/poll', 'a', {}, { raw })).status, 400);
      }
      assert.equal((await f.call('/v1/poll', 'a', { extra: true })).status, 400);
      assert.equal((await f.call('/v1/poll', 'a', {}, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal(await fs.readFile(sentinel, 'utf8'), 'owned sentinel');
      const files = await fs.readdir(f.directory);
      assert.equal(files.length, 1);
      assert.match(files[0], /^relay-\d+-[a-f0-9-]{36}\.lock$/);
      await stop(f);
    });

    await test('durable non-destructive delivery, dedup before/after ACK, restart and mailbox-scoped ACK', async () => {
      let f = await start('durable');
      await accepted(f, 'stable', 'opaque-original');
      const original = (await items(f))[0];
      assert.deepEqual(Object.keys(original).sort(), ['ciphertext', 'from', 'id', 'receivedAt', 'to']);
      assert.equal(new Date(original.receivedAt).toISOString(), original.receivedAt);
      await accepted(f, 'stable', 'opaque-original');
      assert.deepEqual(await items(f), [original]);
      assert.equal((await f.call('/v1/send', 'a', { id: 'stable', to: 'b', ciphertext: 'different' })).status, 409);
      await ack(f, ['stable'], 'a');
      await ack(f, ['stable'], 'c');
      assert.deepEqual(await items(f), [original]);
      await stop(f);
      // A crash-left temp file must not replace the last committed snapshot.
      const abandoned = path.join(f.directory, `.state-${randomUUID()}.tmp`);
      await fs.writeFile(abandoned, '{partial');
      const deadPid = 2147483647;
      assert.throws(() => process.kill(deadPid, 0), { code: 'ESRCH' });
      const interruptedClaim = path.join(f.directory, `relay-${deadPid}-${randomUUID()}.lock`);
      // A crash after wx but before writing JSON leaves an empty claim. Its PID
      // is recoverable from the immutable filename, not partial file contents.
      await fs.writeFile(interruptedClaim, '', { flag: 'wx' });
      f = await start('durable');
      await assert.rejects(fs.stat(abandoned), { code: 'ENOENT' });
      await assert.rejects(fs.stat(interruptedClaim), { code: 'ENOENT' });
      assert.deepEqual(await items(f), [original]);
      await accepted(f, 'stable', 'opaque-original');
      assert.equal((await f.call('/v1/send', 'a', { id: 'stable', to: 'b', ciphertext: 'different' })).status, 409);
      const ackStarted = Date.now();
      await ack(f, ['stable', 'stable', 'unknown']);
      await ack(f, ['stable']);
      assert.deepEqual(await items(f), []);
      await accepted(f, 'stable', 'opaque-original');
      assert.deepEqual(await items(f), []);
      assert.equal((await f.call('/v1/send', 'a', { id: 'stable', to: 'b', ciphertext: 'different' })).status, 409);
      const stored = JSON.parse(await fs.readFile(path.join(f.directory, 'state.json'), 'utf8')).records[0];
      assert.equal(Object.hasOwn(stored, 'ciphertext'), false);
      assert.match(stored.digest, /^[a-f0-9]{64}$/);
      assert.ok(stored.retainUntil >= ackStarted + DAY);
      assert.ok(stored.retainUntil <= stored.expiresAt + DAY);
      await stop(f);
      f = await start('durable');
      assert.deepEqual(await items(f), []);
      await accepted(f, 'stable', 'opaque-original');
      assert.equal((await f.call('/v1/send', 'a', { id: 'stable', to: 'b', ciphertext: 'different' })).status, 409);
      await stop(f);
    });

    await test('per-mailbox capacity, idempotent retries while full and durable ACK capacity release', async () => {
      let f = await start('capacity', { maxPending: 2 });
      await accepted(f, 'one');
      await accepted(f, 'two');
      assert.equal((await f.call('/v1/send', 'a', { id: 'three', to: 'b', ciphertext: 'opaque-three' })).status, 429);
      await accepted(f, 'one');
      assert.equal((await f.call('/v1/send', 'a', { id: 'one', to: 'b', ciphertext: 'different' })).status, 409);
      await accepted(f, 'reverse', 'opaque', 'a', 'b');
      await ack(f, ['one'], 'a');
      assert.equal((await f.call('/v1/send', 'a', { id: 'three', to: 'b', ciphertext: 'opaque-three' })).status, 429);
      await ack(f, ['one']);
      await accepted(f, 'three');
      await stop(f);
      f = await start('capacity', { maxPending: 2 });
      assert.deepEqual((await items(f)).map((packet) => packet.id), ['two', 'three']);
      assert.equal((await f.call('/v1/send', 'a', { id: 'four', to: 'b', ciphertext: 'opaque' })).status, 429);
      await ack(f, ['two', 'three']);
      await accepted(f, 'one');
      assert.deepEqual(await items(f), []);
      await accepted(f, 'four');
      await stop(f);
    });

    await test('long-poll wakeup, one active poll, cancellation and bounded empty wait', async () => {
      const f = await start('polling', { pollMs: 2000 });
      const started = Date.now();
      const waiting = f.call('/v1/poll', 'b', {});
      await delay(40);
      assert.equal((await f.call('/v1/poll', 'b', {})).status, 409);
      await accepted(f, 'wakeup');
      const delivered = await waiting;
      assert.equal(delivered.status, 200);
      assert.equal(delivered.json.items[0].id, 'wakeup');
      assert.ok(Date.now() - started < 1800, 'send must wake before poll timeout');
      assert.equal((await items(f))[0].id, 'wakeup');
      await ack(f, ['wakeup']);
      const controller = new AbortController();
      const aborted = f.call('/v1/poll', 'b', {}, { signal: controller.signal }).then(
        () => assert.fail('aborted request unexpectedly completed'),
        (error) => assert.equal(error.code, 'ABORT_ERR'),
      );
      await delay(40);
      controller.abort();
      await aborted;
      await delay(30);
      const replacement = f.call('/v1/poll', 'b', {});
      await delay(40);
      await accepted(f, 'replacement');
      assert.equal((await replacement).status, 200);
      await stop(f);
      const empty = await start('empty-poll', { pollMs: 80 });
      const before = Date.now();
      assert.deepEqual(await items(empty), []);
      assert.ok(Date.now() - before >= 50);
      assert.ok(Date.now() - before < 2000);
      await stop(empty);
    });

    await test('poll deadline is independent of blocked atomic persistence', async () => {
      const f = await start('poll-deadline', { pollMs: 80 });
      const originalRename = fs.rename;
      let release;
      let entered;
      const gate = new Promise((resolve) => { release = resolve; });
      const blocked = new Promise((resolve) => { entered = resolve; });
      fs.rename = async (from, to) => {
        if (to === path.join(f.directory, 'state.json')) {
          entered();
          await gate;
        }
        return originalRename(from, to);
      };
      let sending;
      try {
        sending = f.call('/v1/send', 'a', { id: 'slow-commit', to: 'b', ciphertext: 'opaque' });
        let blockedTimer;
        try {
          await Promise.race([blocked, new Promise((_, reject) => {
            blockedTimer = setTimeout(() => reject(new Error('Write did not reach rename')), 2000);
          })]);
        } finally { clearTimeout(blockedTimer); }
        const before = Date.now();
        const result = await f.call('/v1/poll', 'b', {});
        assert.equal(result.status, 200);
        assert.deepEqual(result.json.items, []);
        assert.ok(Date.now() - before < 1500, 'poll must not wait for the write queue');
      } finally {
        release();
        fs.rename = originalRename;
      }
      assert.equal((await sending).status, 200);
      assert.equal((await items(f))[0].id, 'slow-commit');
      await stop(f);
    });

    await test('strict UTF-8 ciphertext/body byte caps, JSON expansion and 100 KiB poll cap', async () => {
      const f = await start('bytes', { maxPending: 64 });
      assert.equal((await f.call('/v1/send', 'a', {
        id: 'oversize', to: 'b', ciphertext: 'x'.repeat(CIPHER_BYTES + 1),
      })).status, 413);
      assert.equal((await f.call('/v1/send', 'a', {
        id: 'unicode-over', to: 'b', ciphertext: 'é'.repeat(CIPHER_BYTES / 2 + 1),
      })).status, 413);
      const rawTooBig = '{}'.padEnd(BODY_BYTES + 1, ' ');
      assert.equal((await f.call('/v1/poll', 'b', {}, { raw: rawTooBig })).status, 413);
      assert.equal((await f.call('/v1/poll', 'b', {}, { raw: rawTooBig, chunked: true })).status, 413);
      assert.equal((await f.call('/v1/poll', 'b', {}, { raw: '{}'.padEnd(BODY_BYTES, ' ') })).status, 200);
      const edge = { id: 'escaping', to: 'b', ciphertext: '' };
      edge.ciphertext = '\\'.repeat(Math.floor((BODY_BYTES - Buffer.byteLength(JSON.stringify(edge))) / 2));
      assert.ok(Buffer.byteLength(JSON.stringify(edge)) <= BODY_BYTES);
      assert.equal((await f.call('/v1/send', 'a', edge)).status, 413);
      await accepted(f, 'large1', 'x'.repeat(CIPHER_BYTES));
      await accepted(f, 'large2', 'y'.repeat(CIPHER_BYTES));
      await accepted(f, 'large3', 'é'.repeat(CIPHER_BYTES / 2));
      for (const id of ['large1', 'large2', 'large3']) {
        const result = await f.call('/v1/poll', 'b', {});
        assert.equal(result.status, 200);
        assert.equal(result.json.items.length, 1);
        assert.equal(result.json.items[0].id, id);
        assert.ok(result.bytes <= BODY_BYTES);
        await ack(f, [id]);
      }
      for (let i = 0; i < 17; i++) await accepted(f, `small${i}`, 'opaque', 'a', 'b');
      const first = await items(f, 'a');
      assert.equal(first.length, 16);
      await ack(f, first.map((packet) => packet.id), 'a');
      assert.equal((await items(f, 'a')).length, 1);
      await stop(f);
    });

    await test('serialized concurrent sends/ACKs and exclusive storage writer', async () => {
      let f = await start('serial', { maxPending: 64 });
      assert.throws(() => createRelay({ directory: f.directory, devices }), /already in use/);
      await Promise.all(Array.from({ length: 20 }, (_, i) => accepted(f, `concurrent${i}`)));
      const same = await Promise.all(Array.from({ length: 6 }, () =>
        f.call('/v1/send', 'a', { id: 'race', to: 'b', ciphertext: 'same' })));
      assert.ok(same.every((response) => response.status === 200));
      const different = await Promise.all(['alpha', 'beta'].map((ciphertext) =>
        f.call('/v1/send', 'a', { id: 'conflicting', to: 'b', ciphertext })));
      assert.deepEqual(different.map((response) => response.status).sort(), [200, 409]);
      await stop(f);
      f = await start('serial', { maxPending: 64 });
      const all = [];
      for (;;) {
        const batch = await items(f);
        if (!batch.length) break;
        all.push(...batch);
        await Promise.all([ack(f, batch.map((packet) => packet.id)), ack(f, batch.map((packet) => packet.id))]);
      }
      assert.equal(all.length, 22);
      assert.equal(new Set(all.map((packet) => packet.id)).size, 22);
      await stop(f);
    });

    await test('expiry recovery and bounded durable tombstone cleanup', async () => {
      let f = await start('expiry');
      await accepted(f, 'expired');
      await stop(f);
      const statePath = path.join(f.directory, 'state.json');
      const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
      const received = Date.now() - DAY - 1000;
      Object.assign(state.records[0], {
        receivedAt: new Date(received).toISOString(), expiresAt: received + DAY,
        retainUntil: received + 2 * DAY,
      });
      await fs.writeFile(statePath, JSON.stringify(state));
      f = await start('expiry');
      assert.deepEqual(await items(f), []);
      await accepted(f, 'expired');
      assert.deepEqual(await items(f), []);
      assert.equal((await f.call('/v1/send', 'a', { id: 'expired', to: 'b', ciphertext: 'different' })).status, 409);
      await stop(f);
      const expired = JSON.parse(await fs.readFile(statePath, 'utf8'));
      assert.equal(Object.hasOwn(expired.records[0], 'ciphertext'), false);
      const old = Date.now() - 2 * DAY - 1000;
      Object.assign(expired.records[0], {
        receivedAt: new Date(old).toISOString(), expiresAt: old + DAY, retainUntil: old + 2 * DAY,
      });
      await fs.writeFile(statePath, JSON.stringify(expired));
      f = await start('expiry');
      await accepted(f, 'expired', 'new-after-retention');
      assert.equal((await items(f))[0].ciphertext, 'new-after-retention');
      await stop(f);
    });

    await test('restart uses current auth/allowlist; revoked devices cannot send or deliver', async () => {
      let f = await start('revoked');
      await accepted(f, 'previously-authorized');
      await stop(f);
      const replacementToken = randomBytes(32).toString('base64url');
      f = await start('revoked', { devices: [{ id: 'b', peerId: 'a', tokenHash: hash(replacementToken) }] });
      assert.equal((await f.call('/v1/poll', 'a', {})).status, 401);
      assert.equal((await f.call('/v1/poll', 'b', {})).status, 401);
      const result = await request(f.port, '/v1/poll', replacementToken, {});
      assert.equal(result.status, 200);
      assert.deepEqual(result.json.items, []);
      assert.equal((await request(f.port, '/v1/send', replacementToken, {
        id: 'revoked-target', to: 'a', ciphertext: 'opaque',
      })).status, 403);
      await stop(f);
      f = await start('revoked', { devices: [] });
      assert.equal((await f.call('/v1/poll', 'b', {})).status, 401);
      assert.equal((await request(f.port, '/health', undefined, undefined, { method: 'GET' })).status, 200);
      await stop(f);
    });

    await test('corrupt recovery fails closed without losing committed state; safe directory validation', async () => {
      let f = await start('corrupt');
      await accepted(f, 'recoverable');
      await stop(f);
      const statePath = path.join(f.directory, 'state.json');
      const backup = await fs.readFile(statePath);
      await fs.writeFile(statePath, '{partial');
      assert.throws(() => createRelay({ directory: f.directory, devices }), /recovery failed/);
      await fs.writeFile(statePath, backup);
      f = await start('corrupt');
      assert.equal((await items(f))[0].id, 'recoverable');
      await stop(f);
      const file = path.join(root, 'not-a-directory');
      await fs.writeFile(file, 'must survive');
      assert.throws(() => createRelay({ directory: file, devices }));
      assert.equal(await fs.readFile(file, 'utf8'), 'must survive');
    });

    await test('storage failures fail closed and recover complete before/after-rename snapshots', async () => {
      for (const afterRename of [false, true]) {
        const name = afterRename ? 'io-after-rename' : 'io-before-rename';
        let f = await start(name);
        await accepted(f, 'committed');
        const originalRename = fs.rename;
        fs.rename = async (from, to) => {
          if (to === path.join(f.directory, 'state.json')) {
            if (afterRename) await originalRename(from, to);
            throw Object.assign(new Error('Injected disk failure'), { code: 'EIO' });
          }
          return originalRename(from, to);
        };
        try {
          assert.equal((await f.call('/v1/send', 'a', {
            id: 'uncertain', to: 'b', ciphertext: 'opaque-uncertain',
          })).status, 503);
        } finally { fs.rename = originalRename; }
        assert.equal((await f.call('/v1/poll', 'b', {})).status, 503);
        assert.equal((await f.call('/v1/ack', 'b', { ids: ['committed'] })).status, 503);
        assert.equal((await fs.readdir(f.directory)).some((entry) => entry.endsWith('.tmp')), false);
        await stop(f);
        f = await start(name);
        const recovered = await items(f);
        assert.deepEqual(recovered.map((packet) => packet.id), afterRename ? ['committed', 'uncertain'] : ['committed']);
        await accepted(f, 'uncertain');
        assert.deepEqual((await items(f)).map((packet) => packet.id), ['committed', 'uncertain']);
        await stop(f);
      }
    });

    await test('close aborts waiting polls, releases sockets/lock and permits immediate restart', async () => {
      let f = await start('closing', { pollMs: 30000 });
      const waiting = f.call('/v1/poll', 'b', {}).then(
        (response) => assert.equal(response.status, 503),
        (error) => assert.ok(['ECONNRESET', 'ECONNREFUSED'].includes(error.code)),
      );
      await delay(40);
      const before = Date.now();
      await Promise.all([stop(f), f.close()]);
      await waiting;
      assert.equal(f.server.listening, false);
      assert.ok(Date.now() - before < 2000);
      f = await start('closing');
      await accepted(f, 'after-close');
      await stop(f);
    });

    await test('CLI JSON config, relative directory, ephemeral loopback default and secret-free diagnostics', async () => {
      const configPath = path.join(root, 'relay-config.json');
      await fs.writeFile(configPath, JSON.stringify({ directory: 'cli-state', devices, port: 0, pollMs: 0 }));
      const output = [];
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      const beforeInt = process.listenerCount('SIGINT');
      const beforeTerm = process.listenerCount('SIGTERM');
      let relay;
      try {
        process.stdout.write = (chunk) => { output.push(String(chunk)); return true; };
        process.stderr.write = (chunk) => { output.push(String(chunk)); return true; };
        relay = await relayMain(['--config', configPath]);
        running.add(relay);
        assert.equal(relay.server.address().address, '127.0.0.1');
        assert.equal((await request(relay.server.address().port, '/health', undefined, undefined, { method: 'GET' })).status, 200);
        await relay.close();
        running.delete(relay);
        const invalid = path.join(root, 'invalid-config.json');
        await fs.writeFile(invalid, `{"secret":"${tokens.a}", broken`);
        await assert.rejects(relayMain([invalid]));
        const exposed = path.join(root, 'non-loopback.json');
        for (const host of ['0.0.0.0', '192.0.2.1', '::', 'localhost']) {
          await fs.writeFile(exposed, JSON.stringify({ directory: 'must-not-start', devices, host, port: 0 }));
          await assert.rejects(relayMain([exposed]), /Invalid listen address/);
        }
        await assert.rejects(relayMain(['--unexpected', tokens.a]));
        await relayMain(['--help']);
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
      }
      const text = output.join('');
      assert.match(text, /127\.0\.0\.1/);
      for (const token of Object.values(tokens)) assert.equal(text.includes(token), false);
      assert.equal(process.listenerCount('SIGINT'), beforeInt);
      assert.equal(process.listenerCount('SIGTERM'), beforeTerm);
      assert.equal((await fs.stat(path.join(root, 'cli-state'))).isDirectory(), true);
    });

    return { passed: tests.length, tests };
  } finally {
    const errors = [];
    for (const relay of running) {
      try { await relay.close(); } catch (error) { errors.push(error); }
    }
    // Verify exact ownership, direct-child containment, non-symlink identity and
    // sentinel BEFORE recursive cleanup. Never remove a computed unchecked path.
    const resolved = path.resolve(root);
    const stat = await fs.lstat(resolved);
    assert.equal(path.dirname(resolved), temporaryBase);
    assert.ok(path.basename(resolved).startsWith(prefix));
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.isDirectory(), true);
    assert.equal(path.resolve(await fs.realpath(resolved)), resolved);
    assert.equal(await fs.readFile(path.join(resolved, '.owner'), 'utf8'), owner);
    if (errors.length) throw new AggregateError(errors, 'Relay shutdown failed; temp directory retained');
    await fs.rm(resolved, { recursive: true, force: false });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runRelayTests().then((result) => {
    console.log(`Relay: ${result.passed} tests passed`);
    for (const name of result.tests) console.log(`  PASS ${name}`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
