import http from 'node:http';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { createLiveMailboxes, LiveMailboxError } from './live-mailboxes.mjs';
import { httpReply, attachRelaySockets } from './reply.mjs';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const CLAIM = /^relay-([1-9][0-9]{0,9})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.lock$/;
const BODY_BYTES = 100 * 1024;
const CIPHERTEXT_BYTES = 80 * 1024;
const RESPONSE_BYTES = 100 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const STATE_VERSION = 1;
const decoder = new TextDecoder('utf-8', { fatal: true });

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function keysAre(value, keys) {
  return object(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function fullMatch(pattern, value) {
  return typeof value === 'string' && pattern.exec(value)?.[0] === value;
}

function validId(value) {
  return fullMatch(ID, value);
}

function validHash(value) {
  return fullMatch(HASH, value);
}

function digest(packet) {
  // A fingerprint for durable retry detection, not payload encryption/decryption.
  return createHash('sha256').update(JSON.stringify([
    packet.id, packet.from, packet.to, packet.ciphertext,
  ])).digest('hex');
}

function packetOf(record) {
  return {
    id: record.id, from: record.from, to: record.to,
    ciphertext: record.ciphertext, receivedAt: record.receivedAt,
  };
}

function json(reply, status, value) { reply.json(status, value); }

function errorResponse(res, error) {
  const recognized = error instanceof HttpError || error instanceof LiveMailboxError;
  const status = recognized ? error.status : 503;
  const code = recognized ? error.code : 'storage_unavailable';
  json(res, status, { error: code });
}

async function readJson(req) {
  const type = req.headers['content-type'];
  if (typeof type !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(type)) {
    req.resume();
    throw new HttpError(415, 'json_required');
  }
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > BODY_BYTES)) {
    req.resume();
    throw new HttpError(413, 'body_too_large');
  }
  const buffer = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => fail(new HttpError(408, 'body_timeout')), 10000);
    timer.unref();
    const cleanup = () => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      req.off('error', onError);
    };
    const fail = (error) => {
      cleanup();
      req.resume();
      reject(error);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > BODY_BYTES) return fail(new HttpError(413, 'body_too_large'));
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const onAborted = () => fail(new HttpError(400, 'request_aborted'));
    const onError = () => fail(new HttpError(400, 'invalid_request'));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    if (req.aborted || req.destroyed) onAborted();
  });
  try {
    const parsed = JSON.parse(decoder.decode(buffer));
    if (!object(parsed)) throw new Error('object required');
    return parsed;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
}

// All storage names are constants or our own UUIDs; routing IDs never form paths.
function storagePath(directory, name) {
  if (name !== 'state.json' && name !== 'relay.lock' && !fullMatch(CLAIM, name) &&
      !fullMatch(/^\.state-[a-f0-9-]{36}\.tmp$/, name)) throw new Error('Unsafe storage name');
  const target = path.resolve(directory, name);
  if (path.dirname(target) !== directory || path.basename(target) !== name) {
    throw new Error('Unsafe storage path');
  }
  return target;
}

function ensureDirectory(directory) {
  const root = path.parse(directory).root;
  if (directory === root) throw new Error('Dedicated storage directory required');
  let current = root;
  for (const part of directory.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe storage directory');
  }
}

function regularFile(target) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe storage file');
  return stat;
}

function acquireLock(directory) {
  // Never ignore a legacy shared-name lock: another relay version may own it.
  try {
    fs.lstatSync(storagePath(directory, 'relay.lock'));
    throw new Error('Legacy storage lock requires offline recovery');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const nonce = randomUUID();
  const name = `relay-${process.pid}-${nonce}.lock`;
  const target = storagePath(directory, name);
  const value = JSON.stringify({ pid: process.pid, nonce });
  const fd = fs.openSync(target, 'wx', 0o600);
  try {
    try {
      fs.writeFileSync(fd, value);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    // Publish our unique claim BEFORE listing. On a coherent local filesystem,
    // either a concurrent claimant sees us, or we see it (possibly both abort).
    // A stale claim is removed by its unique name, never a replaceable lock name.
    for (const other of fs.readdirSync(directory)) {
      if (other === name || !fullMatch(CLAIM, other)) continue;
      const match = CLAIM.exec(other);
      const otherPath = storagePath(directory, other);
      try {
        regularFile(otherPath);
        let alive = true;
        try { process.kill(Number(match[1]), 0); }
        catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('Storage is already in use');
        fs.unlinkSync(storagePath(directory, other));
      } catch (error) {
        // Another recovering process may already have removed this dead claim.
        if (error.code !== 'ENOENT') throw error;
      }
    }
  } catch (error) {
    regularFile(target);
    fs.unlinkSync(storagePath(directory, name));
    throw error;
  }
  return () => {
    regularFile(target);
    if (fs.readFileSync(target, 'utf8') !== value) throw new Error('Storage claim changed');
    fs.unlinkSync(storagePath(directory, name));
  };
}

function loadState(directory) {
  const target = storagePath(directory, 'state.json');
  let source;
  try {
    regularFile(target);
    source = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return new Map();
    throw error;
  }
  const data = JSON.parse(source);
  if (!keysAre(data, ['version', 'records']) || data.version !== STATE_VERSION ||
      !Array.isArray(data.records)) throw new Error('Invalid storage state');
  const records = new Map();
  for (const record of data.records) {
    const pending = Object.hasOwn(record, 'ciphertext');
    const fields = ['id', 'from', 'to', 'digest', 'receivedAt', 'expiresAt', 'retainUntil'];
    if (pending) fields.push('ciphertext');
    if (!keysAre(record, fields) || !validId(record.id) || !validId(record.from) ||
        !validId(record.to) || record.from === record.to || !validHash(record.digest) ||
        typeof record.receivedAt !== 'string' ||
        !Number.isSafeInteger(Date.parse(record.receivedAt)) ||
        new Date(record.receivedAt).toISOString() !== record.receivedAt ||
        !Number.isSafeInteger(record.expiresAt) ||
        record.expiresAt !== Date.parse(record.receivedAt) + DAY ||
        !Number.isSafeInteger(record.retainUntil) || record.retainUntil < record.expiresAt ||
        record.retainUntil > record.expiresAt + DAY || records.has(record.id)) {
      throw new Error('Invalid storage record');
    }
    if (pending && (typeof record.ciphertext !== 'string' || !record.ciphertext ||
        Buffer.byteLength(record.ciphertext) > CIPHERTEXT_BYTES ||
        digest(record) !== record.digest ||
        Buffer.byteLength(JSON.stringify({ items: [packetOf(record)] })) > RESPONSE_BYTES)) {
      throw new Error('Invalid pending record');
    }
    // Devices may have been revoked since persistence. Such records are not routable
    // unless the current config independently authenticates and authorizes the peers.
    records.set(record.id, record);
  }
  return records;
}

function cleanupTemporaryFiles(directory) {
  for (const name of fs.readdirSync(directory)) {
    if (!fullMatch(/^\.state-[a-f0-9-]{36}\.tmp$/, name)) continue;
    const target = storagePath(directory, name);
    regularFile(target);
    fs.unlinkSync(storagePath(directory, name));
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not expose fsync(directory) through Node. The file itself was
    // flushed before atomic rename. Other storage failures must fail closed.
    const unsupported = process.platform === 'win32'
      ? ['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP']
      : ['EINVAL', 'ENOTSUP'];
    if (!unsupported.includes(error.code)) throw error;
  } finally {
    if (handle) await handle.close();
  }
}

/**
 * Synchronous construction/recovery; all subsequent mutations are serialized.
 * The caller owns server.listen(port, '127.0.0.1') and must await close().
 * Storage must be a dedicated, trusted local directory (one relay writer).
 */
export function createRelay({ directory, devices, pollMs = 10000, maxPending = 256 } = {}) {
  if (typeof directory !== 'string' || !directory.trim() || !Array.isArray(devices) ||
      !Number.isSafeInteger(pollMs) || pollMs < 0 || pollMs > 60000 ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 100000) {
    throw new Error('Invalid relay configuration');
  }
  const configured = new Map();
  const hashes = new Set();
  for (const device of devices) {
    if (!keysAre(device, ['id', 'tokenHash', 'peerId']) || !validId(device.id) ||
        !validId(device.peerId) || device.id === device.peerId ||
        !validHash(device.tokenHash) ||
        configured.has(device.id) || hashes.has(device.tokenHash)) {
      throw new Error('Invalid device configuration');
    }
    configured.set(device.id, { ...device, hash: Buffer.from(device.tokenHash, 'hex') });
    hashes.add(device.tokenHash);
  }
  const live = createLiveMailboxes(pollMs, maxPending, configured);
  const root = path.resolve(directory);
  ensureDirectory(root);
  const unlock = acquireLock(root);
  let state;
  try {
    state = loadState(root);
    cleanupTemporaryFiles(root);
  } catch {
    unlock();
    throw new Error('Relay storage recovery failed');
  }

  let closing = false;
  let closePromise;
  let storageFailed = false;
  let queue = Promise.resolve();
  const polls = new Map();
  const sockets = new Set();

  function assertAvailable() {
    if (closing) throw new HttpError(503, 'relay_closing');
    if (storageFailed) throw new HttpError(503, 'storage_unavailable');
  }

  function serial(action) {
    const result = queue.then(() => {
      assertAvailable();
      return action();
    });
    queue = result.catch(() => {});
    return result;
  }

  function finishPoll(poll, status, value) {
    if (polls.get(poll.device.id) !== poll) return;
    polls.delete(poll.device.id);
    clearTimeout(poll.timer);
    poll.unsubscribe?.();
    json(poll.res, status, value);
  }

  function failStorage() {
    storageFailed = true;
    for (const poll of [...polls.values()]) {
      finishPoll(poll, 503, { error: 'storage_unavailable' });
    }
  }

  async function persist(next) {
    const name = `.state-${randomUUID()}.tmp`;
    const temporary = storagePath(root, name);
    let handle;
    try {
      handle = await fsp.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ version: STATE_VERSION, records: [...next.values()] }));
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Refuse symlink substitution instead of following an unexpected existing file.
      try { regularFile(storagePath(root, 'state.json')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await fsp.rename(storagePath(root, name), storagePath(root, 'state.json'));
      await syncDirectory(root);
      state = next;
    } catch {
      failStorage();
      throw new HttpError(503, 'storage_unavailable');
    } finally {
      if (handle) await handle.close().catch(() => {});
      // Only this operation's exclusively-created temporary name may be removed.
      await fsp.unlink(storagePath(root, name)).catch(() => {});
    }
  }

  async function expire(now = Date.now()) {
    let next;
    for (const [id, record] of state) {
      if (record.retainUntil <= now) {
        next ??= new Map(state);
        next.delete(id);
      } else if (Object.hasOwn(record, 'ciphertext') && record.expiresAt <= now) {
        next ??= new Map(state);
        const { ciphertext: _opaque, ...tombstone } = record;
        next.set(id, tombstone);
      }
    }
    if (next) await persist(next);
  }

  function itemsFor(device) {
    const items = [];
    let bytes = Buffer.byteLength('{"items":[]}');
    for (const record of state.values()) {
      if (record.to !== device.id || record.from !== device.peerId ||
          configured.get(record.from)?.peerId !== device.id ||
          !Object.hasOwn(record, 'ciphertext') || record.expiresAt <= Date.now()) continue;
      const packet = packetOf(record);
      const added = Buffer.byteLength(JSON.stringify(packet)) + (items.length ? 1 : 0);
      if (bytes + added > RESPONSE_BYTES) break;
      items.push(packet);
      bytes += added;
      if (items.length === 16) break;
    }
    return items;
  }

  function wake(deviceId) {
    const poll = polls.get(deviceId);
    if (!poll) return;
    const items = itemsFor(poll.device);
    if (items.length) finishPoll(poll, 200, { items });
  }

  function authenticate(req) {
    let occurrences = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() === 'authorization') occurrences++;
    }
    const header = req.headers.authorization;
    const match = occurrences === 1 && typeof header === 'string'
      ? /^Bearer ([\x21-\x7e]+)$/i.exec(header) : null;
    if (!match) throw new HttpError(401, 'unauthorized');
    const hash = createHash('sha256').update(match[1]).digest();
    let selected;
    // Compare all configured hashes; never compare raw bearer strings or log them.
    for (const device of configured.values()) {
      if (timingSafeEqual(hash, device.hash)) selected = device;
    }
    if (!selected) throw new HttpError(401, 'unauthorized');
    return selected;
  }

  async function send(body, device, res) {
    if (!keysAre(body, ['id', 'to', 'ciphertext']) || !validId(body.id) ||
        !validId(body.to) || typeof body.ciphertext !== 'string' || !body.ciphertext) {
      throw new HttpError(400, 'invalid_packet');
    }
    if (Buffer.byteLength(body.ciphertext) > CIPHERTEXT_BYTES) {
      throw new HttpError(413, 'ciphertext_too_large');
    }
    if (body.to !== device.peerId || configured.get(body.to)?.peerId !== device.id) {
      throw new HttpError(403, 'peer_not_allowed');
    }
    await serial(async () => {
      await expire();
      const now = Date.now();
      const packet = {
        id: body.id, from: device.id, to: body.to, ciphertext: body.ciphertext,
        receivedAt: new Date(now).toISOString(),
      };
      if (Buffer.byteLength(JSON.stringify({ items: [packet] })) > RESPONSE_BYTES) {
        throw new HttpError(413, 'packet_too_large');
      }
      const fingerprint = digest(packet);
      const existing = state.get(body.id);
      if (existing) {
        if (existing.digest !== fingerprint || existing.from !== device.id || existing.to !== body.to) {
          throw new HttpError(409, 'id_conflict');
        }
        json(res, 200, { accepted: true });
        return;
      }
      let count = 0;
      for (const record of state.values()) {
        if (record.to === body.to && Object.hasOwn(record, 'ciphertext')) count++;
      }
      if (count >= maxPending) throw new HttpError(429, 'mailbox_full');
      const next = new Map(state);
      next.set(body.id, {
        id: packet.id, from: packet.from, to: packet.to, digest: fingerprint,
        receivedAt: packet.receivedAt, expiresAt: now + DAY,
        retainUntil: now + 2 * DAY, ciphertext: packet.ciphertext,
      });
      await persist(next);
      json(res, 200, { accepted: true });
      wake(body.to);
    });
  }

  async function ack(body, device, res) {
    if (!keysAre(body, ['ids']) || !Array.isArray(body.ids) || !body.ids.every(validId)) {
      throw new HttpError(400, 'invalid_ids');
    }
    await serial(async () => {
      await expire();
      let next;
      const now = Date.now();
      for (const id of new Set(body.ids)) {
        const record = state.get(id);
        if (!record || record.to !== device.id || !Object.hasOwn(record, 'ciphertext')) continue;
        const { ciphertext: _opaque, ...tombstone } = record;
        tombstone.retainUntil = Math.max(record.expiresAt, now + DAY);
        // Clock rollback must not accidentally create unbounded retention.
        tombstone.retainUntil = Math.min(tombstone.retainUntil, record.expiresAt + DAY);
        next ??= new Map(state);
        next.set(id, tombstone);
      }
      if (next) await persist(next);
      json(res, 200, { acknowledged: true });
    });
  }

  function poll(body, device, res) {
    if (!keysAre(body, [])) throw new HttpError(400, 'invalid_poll');
    if (polls.has(device.id)) throw new HttpError(409, 'poll_already_active');
    const current = { device, res, timer: undefined, cancel: undefined };
    current.cancel = () => {
      if (polls.get(device.id) !== current) return;
      polls.delete(device.id);
      clearTimeout(current.timer);
    };
    polls.set(device.id, current);
    current.unsubscribe = res.onClose(current.cancel);
    // Read only the immutable, fully committed snapshot. Poll deadlines must not
    // queue behind fsync/write backlogs; expired packets are filtered by itemsFor.
    const items = itemsFor(device);
    if (items.length || pollMs === 0) return finishPoll(current, 200, { items });
    current.timer = setTimeout(() => {
      finishPoll(current, 200, { items: itemsFor(device) });
    }, pollMs);
    current.timer.unref();
  }

  async function dispatch(route, body, device, reply) {
    try {
      assertAvailable();
      if (reply.closed) return;
      if (route === 'send') await send(body, device, reply);
      else if (route === 'ack') await ack(body, device, reply);
      else if (route === 'live/info') live.info(body, reply);
      else if (route === 'live/send') live.send(body, device, reply);
      else if (route === 'live/poll') live.poll(body, device, reply);
      else if (route === 'poll') poll(body, device, reply);
      else throw new HttpError(404, 'not_found');
    } catch (error) { errorResponse(reply, error); }
  }

  const server = http.createServer(async (req, res) => {
    const reply = httpReply(res);
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && req.url === '/health') {
        const length = Number(req.headers['content-length'] ?? 0);
        if (length > 0 || req.headers['transfer-encoding']) {
          req.resume();
          res.setHeader('Connection', 'close');
          throw new HttpError(length > BODY_BYTES ? 413 : 400, 'unexpected_body');
        }
        json(reply, 200, { protocol: 1, service: 'dsh-remote-relay' });
        return;
      }
      assertAvailable();
      const device = authenticate(req);
      if (req.method !== 'POST' || !['/v1/send', '/v1/poll', '/v1/ack', '/v1/live/info', '/v1/live/send', '/v1/live/poll'].includes(req.url)) {
        req.resume();
        throw new HttpError(404, 'not_found');
      }
      const body = await readJson(req);
      assertAvailable();
      await dispatch(req.url.slice(4), body, device, reply);
    } catch (error) {
      // Error details, request bodies, headers, tokens, and config are never logged.
      if (!req.complete) {
        req.resume();
        res.setHeader('Connection', 'close');
      }
      errorResponse(reply, error);
    }
  });
  const socketTransport = attachRelaySockets(server, { authenticate, dispatch });
  server.headersTimeout = 10000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => {
    if (!socket.writable) return socket.destroy();
    const body = '{"error":"invalid_request"}';
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n' +
      'Cache-Control: no-store\r\nContent-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });

  const cleanup = setInterval(() => {
    serial(() => expire()).catch(() => {});
  }, 60000);
  cleanup.unref();
  // Expiry recovery is durable and queued ahead of the first HTTP mutation.
  serial(() => expire()).catch(() => {});

  function close() {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(cleanup);
    const socketClosing = socketTransport.close();
    live.close();
    for (const waiting of [...polls.values()]) {
      finishPoll(waiting, 503, { error: 'relay_closing' });
    }
    closePromise = (async () => {
      const stopped = new Promise((resolve, reject) => {
        server.close((error) => {
          if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
          else resolve();
        });
      });
      for (const socket of sockets) socket.destroy();
      await socketClosing;
      await queue;
      await stopped;
      unlock();
    })();
    return closePromise;
  }

  return { server, close };
}
