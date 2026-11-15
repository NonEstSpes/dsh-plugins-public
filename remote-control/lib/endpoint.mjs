import path from 'node:path';
import { randomUUID, createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { CompactEncrypt, compactDecrypt } from 'jose';
import { openJsonStore } from './store.mjs';
import { openRelaySocket } from './relay-socket.mjs';

const ID = /^[a-zA-Z0-9_-]{1,80}$/;
const HASH = /^[a-f0-9]{64}$/;
const DAY = 24 * 60 * 60 * 1000;
const SKEW = 5 * 60 * 1000;
const MAX_CIPHERTEXT = 80 * 1024;
const MAX_BODY = 100 * 1024;
const MAX_PLAINTEXT = 59 * 1024;
const MAX_RECORDS = 8192;
const MAX_PENDING = 256;
const MAX_OUTBOX = 512;
const MAX_QUARANTINE = 256;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const own = (value, key) => Object.hasOwn(value, key);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const validId = value => typeof value === 'string' && ID.test(value);
const bytes = value => Buffer.byteLength(value, 'utf8');

function fault(code, details = {}) {
  const error = new Error(`Remote endpoint: ${code}`);
  error.code = code;
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 100 && details.httpStatus <= 599) error.httpStatus = details.httpStatus;
  if (['send', 'poll', 'ack'].includes(details.route)) error.route = details.route;
  return error;
}

function timestamp(value) {
  if (typeof value !== 'string') throw fault('INVALID_TIMESTAMP');
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result) || new Date(result).toISOString() !== value) throw fault('INVALID_TIMESTAMP');
  return result;
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => own(value, key));
}

function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 40) throw fault('INVALID_BODY');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (!value || typeof value !== 'object' || seen.has(value)) throw fault('INVALID_BODY');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw fault('INVALID_BODY');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    const entries = [];
    for (let index = 0; index < value.length; index++) {
      if (!own(value, index)) throw fault('INVALID_BODY');
      entries.push(canonical(value[index], seen, depth + 1));
    }
    result = `[${entries.join(',')}]`;
  } else {
    const entries = [];
    for (const key of Reflect.ownKeys(value).sort()) {
      if (typeof key !== 'string') throw fault('INVALID_BODY');
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !own(descriptor, 'value')) throw fault('INVALID_BODY');
      entries.push(`${JSON.stringify(key)}:${canonical(descriptor.value, seen, depth + 1)}`);
    }
    result = `{${entries.join(',')}}`;
  }
  seen.delete(value);
  return result;
}

function relayBase(settings) {
  const input = settings.relayUrl;
  if (typeof input !== 'string' || !input || /[\s\\?#]/.test(input)) throw fault('INVALID_RELAY_URL');
  let url;
  try { url = new URL(input); } catch { throw fault('INVALID_RELAY_URL'); }
  const authority = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)?.[1];
  if (!authority || authority.includes('@') || url.username || url.password) throw fault('INVALID_RELAY_URL');
  if (url.protocol !== 'https:') {
    // Inspect the original authority too: URL normalizes 127.1/integer/hex hosts to 127.0.0.1.
    if (url.protocol !== 'http:' || settings.allowLoopback !== true || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(authority)) {
      throw fault('HTTPS_REQUIRED');
    }
  }
  if (!url.hostname || url.search || url.hash) throw fault('INVALID_RELAY_URL');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function validateEnvelope(envelope, { id, from, to }, now, accepted = false, kinds = ['command', 'response', 'report']) {
  if (!exactKeys(envelope, ['version', 'id', 'from', 'to', 'createdAt', 'expiresAt', 'kind', 'body'])) throw fault('INVALID_ENVELOPE');
  if (envelope.version !== 1 || !validId(envelope.id) || !validId(envelope.from) || !validId(envelope.to) ||
      envelope.id !== id || envelope.from !== from || envelope.to !== to) throw fault('INVALID_ROUTING');
  if (!kinds.includes(envelope.kind) || !record(envelope.body)) throw fault('INVALID_ENVELOPE');
  const created = timestamp(envelope.createdAt);
  const expiry = timestamp(envelope.expiresAt);
  if (expiry <= created || expiry - created > DAY) throw fault('INVALID_LIFETIME');
  if (!accepted && created > now + SKEW) throw fault('CLOCK_SKEW');
  if (!accepted && expiry <= now) throw fault('EXPIRED');
  canonical(envelope.body);
  return envelope;
}

function validCiphertext(value) {
  return typeof value === 'string' && bytes(value) <= MAX_CIPHERTEXT && /^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value);
}

function backoff(attempt) {
  return Math.min(30_000, 500 * (2 ** Math.min(attempt - 1, 6))) + Math.floor(Math.random() * 200);
}

function prune(state, now) {
  state.outbox = state.outbox.filter(item => item.state === 'pending' || item.retainUntil > now);
  state.inbox = state.inbox.filter(item => item.state === 'pending' || item.retainUntil > now || state.acks.includes(item.id));
  state.quarantine = state.quarantine.filter(item => item.at + DAY > now).slice(-MAX_QUARANTINE);
}

function validateState(state, binding, verifyReceipt) {
  const corrupt = () => { throw fault('STATE_CORRUPT'); };
  if (!exactKeys(state, ['version', 'binding', 'outbox', 'inbox', 'acks', 'quarantine']) || ![1, 2].includes(state.version) ||
      canonical(state.binding) !== canonical(binding)) throw fault('STATE_BINDING_MISMATCH');
  if (!Array.isArray(state.outbox) || state.outbox.length > MAX_OUTBOX || !Array.isArray(state.inbox) || state.inbox.length > MAX_RECORDS ||
      !Array.isArray(state.acks) || state.acks.length > MAX_RECORDS || !Array.isArray(state.quarantine) || state.quarantine.length > MAX_QUARANTINE) corrupt();
  for (const list of [state.outbox, state.inbox]) {
    const ids = new Set();
    for (const item of list) {
      if (!record(item) || !validId(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.retainUntil) || !Number.isSafeInteger(item.attempts) || item.attempts < 0 ||
          !Number.isSafeInteger(item.nextAt) || item.nextAt < 0) corrupt();
      ids.add(item.id);
      if (list === state.outbox) {
        if (!['pending', 'sent', 'expired'].includes(item.state) || !HASH.test(item.digest) || !Number.isSafeInteger(item.expiresAt)) corrupt();
        const fields = ['id', 'digest', 'expiresAt', 'retainUntil', 'attempts', 'nextAt', 'state'];
        if (state.version === 1) {
          if (!exactKeys(item, [...fields, 'ciphertext']) || !validCiphertext(item.ciphertext)) corrupt();
        } else {
          if (!Number.isSafeInteger(item.createdAt) || item.expiresAt <= item.createdAt || item.expiresAt - item.createdAt > DAY) corrupt();
          if (item.state === 'pending') {
            if (!exactKeys(item, [...fields, 'createdAt', 'ciphertext']) || !validCiphertext(item.ciphertext)) corrupt();
          } else if (!exactKeys(item, [...fields, 'createdAt', 'receipt']) || !verifyReceipt(item)) corrupt();
        }
      } else {
        if (!['pending', 'done', 'quarantined'].includes(item.state) || !HASH.test(item.hash) || !Number.isSafeInteger(item.acceptedAt)) corrupt();
        if (item.state === 'pending' && (!validCiphertext(item.ciphertext) || hash(item.ciphertext) !== item.hash)) corrupt();
        if (item.state !== 'pending' && own(item, 'ciphertext')) corrupt();
      }
    }
  }
  if (state.inbox.filter(item => item.state === 'pending').length > MAX_PENDING || new Set(state.acks).size !== state.acks.length || state.acks.some(id => !validId(id))) corrupt();
  for (const item of state.quarantine) {
    if (!record(item) || (item.id !== null && !validId(item.id)) || !HASH.test(item.hash) || !Number.isSafeInteger(item.at) || typeof item.reason !== 'string' || !/^[A-Z_]{1,64}$/.test(item.reason)) corrupt();
  }
}

/**
 * Outbound send resolves after local durability, not relay delivery. No network before start().
 * onMessage must itself durably deduplicate side effects by envelope.id/operationId: a crash
 * between handler success and the inbox commit can call it again, including after expiry.
 * stateDir is resolved against the caller's cwd; config loaders should resolve it beside config.
 */
export async function openEndpoint(settings, { onMessage, onError = () => {} } = {}) {
  if (!record(settings) || !['controller', 'worker'].includes(settings.role) || !validId(settings.id) || !validId(settings.peerId) || settings.id === settings.peerId) throw fault('INVALID_SETTINGS');
  if (typeof onMessage !== 'function' || typeof onError !== 'function') throw fault('INVALID_HANDLERS');
  if (typeof settings.stateDir !== 'string' || !settings.stateDir || settings.stateDir.includes('\0')) throw fault('INVALID_STATE_DIRECTORY');
  if (typeof settings.relayToken !== 'string' || !/^[a-zA-Z0-9._~-]{16,512}$/.test(settings.relayToken)) throw fault('INVALID_RELAY_TOKEN');
  if (settings.allowLoopback !== undefined && typeof settings.allowLoopback !== 'boolean') throw fault('INVALID_SETTINGS');
  if (typeof settings.sharedKey !== 'string' || !/^[a-zA-Z0-9_-]{43}$/.test(settings.sharedKey)) throw fault('INVALID_SHARED_KEY');
  const key = Buffer.from(settings.sharedKey, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== settings.sharedKey) throw fault('INVALID_SHARED_KEY');
  if (settings.protocol !== undefined && settings.protocol !== 1 && settings.protocol !== 2) throw fault('INVALID_SETTINGS');
  if (settings.protocol === 2 && (!Number.isSafeInteger(settings.pairingGeneration) || settings.pairingGeneration < 1)) throw fault('INVALID_SETTINGS');
  const kinds = settings.protocol === 2 ? ['command', 'response', 'report', 'federation'] : ['command', 'response', 'report'];
  const base = relayBase(settings);
  const { id, peerId, role, relayToken } = settings;
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw fault('FETCH_UNAVAILABLE');
  const binding = { id, peerId, role, keyHash: hash(key), ...(settings.protocol === 2 ? { protocol: 2, pairingGeneration: settings.pairingGeneration } : {}) };
  const receiptKey = Buffer.from(hkdfSync('sha256', key, encoder.encode('dsh-remote:endpoint:outbox-terminal:v2'), encoder.encode(canonical(binding)), 32));
  const receipt = item => {
    const unsigned = { ...item }; delete unsigned.receipt;
    return createHmac('sha256', receiptKey).update(canonical({ version: 2, binding, entry: unsigned })).digest('hex');
  };
  const verifyReceipt = item => typeof item.receipt === 'string' && HASH.test(item.receipt)
    && timingSafeEqual(Buffer.from(item.receipt, 'hex'), Buffer.from(receipt(item), 'hex'));
  const compact = item => { delete item.ciphertext; item.receipt = receipt(item); };
  let store, relaySocket;
  try {
    relaySocket = openRelaySocket(settings);
    store = await openJsonStore(path.join(path.resolve(settings.stateDir), 'endpoint.json'), {
      version: 2, binding, outbox: [], inbox: [], acks: [], quarantine: [],
    });
  } catch (error) {
    try { await relaySocket?.close(); } finally { key.fill(0); receiptKey.fill(0); }
    throw error;
  }

  async function decrypt(ciphertext, routing, accepted = false) {
    if (!validCiphertext(ciphertext)) throw fault('INVALID_CIPHERTEXT');
    let result;
    try {
      result = await compactDecrypt(ciphertext, key, { keyManagementAlgorithms: ['dir'], contentEncryptionAlgorithms: ['A256GCM'] });
    } catch { throw fault('INVALID_CRYPTO'); }
    if (!exactKeys(result.protectedHeader, ['alg', 'enc']) || result.protectedHeader.alg !== 'dir' || result.protectedHeader.enc !== 'A256GCM' || result.plaintext.byteLength > MAX_PLAINTEXT) throw fault('INVALID_CRYPTO');
    let envelope;
    try { envelope = JSON.parse(decoder.decode(result.plaintext)); } catch { throw fault('INVALID_ENVELOPE'); }
    return validateEnvelope(envelope, routing, Date.now(), accepted, kinds);
  }

  try {
    const snapshot = store.get();
    validateState(snapshot, binding, verifyReceipt);
    // A syntactically valid, but modified, pending state must not turn into an ACK.
    for (const item of snapshot.inbox.filter(item => item.state === 'pending')) {
      await decrypt(item.ciphertext, { id: item.id, from: peerId, to: id }, true);
    }
    for (const item of snapshot.outbox) {
      if (snapshot.version === 2 && item.state !== 'pending') continue;
      const envelope = await decrypt(item.ciphertext, { id: item.id, from: id, to: peerId }, true);
      if (hash(canonical({ kind: envelope.kind, body: envelope.body })) !== item.digest || timestamp(envelope.expiresAt) !== item.expiresAt
        || (snapshot.version === 2 && timestamp(envelope.createdAt) !== item.createdAt)) throw fault('STATE_CORRUPT');
      if (snapshot.version === 1) {
        item.createdAt = timestamp(envelope.createdAt);
        if (item.state !== 'pending') compact(item);
      }
    }
    if (snapshot.version === 1) {
      snapshot.version = 2;
      validateState(snapshot, binding, verifyReceipt);
      await store.update(() => snapshot);
    }
  } catch (error) {
    try { await Promise.allSettled([store.close(), relaySocket.close()]); } finally { key.fill(0); receiptKey.fill(0); }
    throw error;
  }

  let running = false;
  let closed = false;
  let fatal = false;
  let closePromise;
  let pumpPromise;
  let pollPromise;
  let lastError = null;
  let lastSuccessfulPollAt = null;
  let lastPollError = null;
  let ackNextAt = 0;
  let ackAttempts = 0;
  let wake;
  const controllers = new Set();
  const waits = new Set();
  const sends = new Set();

  function report(problem) {
    const code = typeof problem === 'string' ? problem : problem?.code;
    const safeCode = typeof code === 'string' && /^[A-Z_]{1,64}$/.test(code) ? code : 'INTERNAL_ERROR';
    lastError = { code: safeCode, at: new Date().toISOString() };
    if (Number.isInteger(problem?.httpStatus) && problem.httpStatus >= 100 && problem.httpStatus <= 599) lastError.httpStatus = problem.httpStatus;
    if (['send', 'poll', 'ack'].includes(problem?.route)) lastError.route = problem.route;
    try {
      Promise.resolve(onError(fault(safeCode))).catch(() => {});
    } catch { /* The error callback cannot stop durability/cleanup. */ }
  }

  function notify() {
    wake?.();
  }

  function delay(ms) {
    if (!running) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        waits.delete(done);
        resolve();
      };
      waits.add(done);
      timer = setTimeout(done, Math.max(1, ms));
    });
  }

  function pausePump(ms) {
    if (!running) return Promise.resolve();
    return new Promise(resolve => {
      let timer;
      const done = () => {
        clearTimeout(timer);
        waits.delete(done);
        if (wake === done) wake = undefined;
        resolve();
      };
      wake = done;
      waits.add(done);
      if (Number.isFinite(ms)) timer = setTimeout(done, Math.max(1, ms));
    });
  }

  function stopOwned() {
    running = false;
    for (const controller of controllers) controller.abort();
    for (const done of [...waits]) done();
    notify();
  }

  function fail(error) {
    fatal = true;
    report(error?.code || 'STORAGE_FAILURE');
    stopOwned();
  }

  async function request(route, data, poll = false) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), poll ? 15_000 : 10_000);
    let reader;
    try {
      const body = JSON.stringify(data);
      if (bytes(body) > MAX_BODY) throw fault('REQUEST_TOO_LARGE');
      const socketReply = await relaySocket.request(route, data, controller.signal);
      if (socketReply !== undefined) {
        if (socketReply.status >= 300 && socketReply.status < 400) throw fault('HTTP_REDIRECT', { httpStatus: socketReply.status, route });
        if (socketReply.status < 200 || socketReply.status >= 300) throw fault(socketReply.status === 401 || socketReply.status === 403 ? 'RELAY_AUTH_FAILED' : 'RELAY_HTTP_ERROR', { httpStatus: socketReply.status, route });
        return socketReply.body;
      }
      const response = await fetchImpl(new URL(`v1/${route}`, base).href, {
        method: 'POST', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        headers: { authorization: `Bearer ${relayToken}`, 'content-type': 'application/json', accept: 'application/json' },
        body, signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) throw fault('HTTP_REDIRECT', { httpStatus: response.status, route });
      if (!response.ok) throw fault(response.status === 401 || response.status === 403 ? 'RELAY_AUTH_FAILED' : 'RELAY_HTTP_ERROR', { httpStatus: response.status, route });
      const contentType = response.headers.get('content-type') || '';
      if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw fault('INVALID_RELAY_RESPONSE');
      const length = response.headers.get('content-length');
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY)) throw fault('RESPONSE_TOO_LARGE');
      if (!response.body || typeof response.body.getReader !== 'function') throw fault('INVALID_RELAY_RESPONSE');
      reader = response.body.getReader();
      let total = 0;
      const chunks = [];
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.byteLength;
        if (total > MAX_BODY) throw fault('RESPONSE_TOO_LARGE');
        chunks.push(part.value);
      }
      try { return JSON.parse(decoder.decode(Buffer.concat(chunks, total))); } catch { throw fault('INVALID_RELAY_RESPONSE'); }
    } catch (error) {
      if (typeof error?.code === 'string' && /^[A-Z_]{1,64}$/.test(error.code)) throw error;
      throw fault(controller.signal.aborted ? 'REQUEST_ABORTED' : 'NETWORK_FAILURE');
    } finally {
      clearTimeout(timer);
      controller.abort();
      await reader?.cancel().catch(() => {});
      controllers.delete(controller);
    }
  }

  function ack(state, packetId) {
    if (!state.acks.includes(packetId)) state.acks.push(packetId);
  }

  function quarantine(state, packetId, digest, reason, now) {
    state.quarantine.push({ id: packetId, hash: digest, reason, at: now });
    state.quarantine = state.quarantine.slice(-MAX_QUARANTINE);
  }

  async function receive(packet) {
    const now = Date.now();
    const packetId = record(packet) && validId(packet.id) ? packet.id : null;
    let packetText;
    try { packetText = record(packet) && typeof packet.ciphertext === 'string' ? packet.ciphertext : JSON.stringify(packet); } catch { packetText = 'invalid-packet'; }
    const digest = hash(packetText ?? 'invalid-packet');
    if (!packetId) {
      await store.update(state => { prune(state, now); quarantine(state, null, digest, 'INVALID_PACKET', now); });
      report('INVALID_PACKET');
      return false;
    }
    const existing = store.get().inbox.find(item => item.id === packetId);
    if (existing) {
      const sameRouting = exactKeys(packet, ['id', 'from', 'to', 'ciphertext', 'receivedAt']) && packet.from === peerId && packet.to === id &&
        ((typeof packet.receivedAt === 'string' && Number.isSafeInteger(Date.parse(packet.receivedAt))) || Number.isSafeInteger(packet.receivedAt));
      if (existing.hash !== digest || !sameRouting || existing.state !== 'pending') {
        await store.update(state => {
          if (existing.hash !== digest || !sameRouting) {
            quarantine(state, packetId, digest, 'ID_COLLISION', now);
            ack(state, packetId);
          } else ack(state, packetId);
        });
      }
      if (existing.hash !== digest || !sameRouting) report('ID_COLLISION');
      notify();
      return false;
    }
    let reason;
    try {
      if (!exactKeys(packet, ['id', 'from', 'to', 'ciphertext', 'receivedAt']) || packet.from !== peerId || packet.to !== id) throw fault('INVALID_ROUTING');
      // receivedAt is relay metadata, never the authority for expiry or replay retention.
      if (!(typeof packet.receivedAt === 'string' && Number.isSafeInteger(Date.parse(packet.receivedAt))) && !Number.isSafeInteger(packet.receivedAt)) throw fault('INVALID_PACKET');
      await decrypt(packet.ciphertext, { id: packetId, from: peerId, to: id });
    } catch (error) { reason = error.code || 'INVALID_ENVELOPE'; }
    await store.update(state => {
      prune(state, now);
      if (state.inbox.length >= MAX_RECORDS || (!reason && state.inbox.filter(item => item.state === 'pending').length >= MAX_PENDING)) throw fault('INBOX_CAPACITY');
      const item = { id: packetId, hash: digest, acceptedAt: now, retainUntil: now + DAY, attempts: 0, nextAt: 0, state: reason ? 'quarantined' : 'pending' };
      if (reason) {
        quarantine(state, packetId, digest, reason, now);
        ack(state, packetId);
      } else item.ciphertext = packet.ciphertext;
      state.inbox.push(item);
    });
    if (reason) report(reason);
    notify();
    return true;
  }

  async function pump() {
    while (running) {
      const now = Date.now();
      const snapshot = store.get();
      const incoming = snapshot.inbox.find(item => item.state === 'pending' && item.nextAt <= now);
      if (incoming) {
        const envelope = await decrypt(incoming.ciphertext, { id: incoming.id, from: peerId, to: id }, true);
        let succeeded = false;
        try {
          await onMessage(envelope);
          succeeded = true;
        } catch { report('HANDLER_FAILED'); }
        // Even close() waits for this commit: never ACK on a merely started handler.
        await store.update(state => {
          const item = state.inbox.find(candidate => candidate.id === incoming.id);
          if (succeeded) {
            item.state = 'done';
            delete item.ciphertext;
            item.nextAt = 0;
            item.retainUntil = Math.max(item.retainUntil, Date.now() + DAY);
            ack(state, item.id);
          } else {
            item.attempts++;
            item.nextAt = Date.now() + backoff(item.attempts);
          }
        });
        continue;
      }
      if (snapshot.acks.length && ackNextAt <= now) {
        const ids = snapshot.acks.slice(0, 64);
        try {
          const result = await request('ack', { ids });
          if (!exactKeys(result, ['acknowledged']) || result.acknowledged !== true) throw fault('INVALID_RELAY_RESPONSE');
          await store.update(state => { state.acks = state.acks.filter(packetId => !ids.includes(packetId)); });
          ackAttempts = 0;
          ackNextAt = 0;
        } catch (error) {
          if (running) report(error);
          ackNextAt = Date.now() + backoff(++ackAttempts);
        }
        continue;
      }
      const outgoing = snapshot.outbox.find(item => item.state === 'pending' && item.nextAt <= now);
      if (outgoing) {
        if (outgoing.expiresAt <= now) {
          await store.update(state => {
            const item = state.outbox.find(candidate => candidate.id === outgoing.id);
            item.state = 'expired';
            item.retainUntil = Date.now() + DAY;
            compact(item);
          });
          report('OUTGOING_EXPIRED');
          continue;
        }
        try {
          const result = await request('send', { id: outgoing.id, to: peerId, ciphertext: outgoing.ciphertext });
          if (!exactKeys(result, ['accepted']) || result.accepted !== true) throw fault('INVALID_RELAY_RESPONSE');
          await store.update(state => {
            const item = state.outbox.find(candidate => candidate.id === outgoing.id);
            item.state = 'sent';
            item.retainUntil = Date.now() + DAY;
            item.nextAt = 0;
            compact(item);
          });
        } catch (error) {
          if (running) report(error);
          await store.update(state => {
            const item = state.outbox.find(candidate => candidate.id === outgoing.id);
            item.attempts++;
            item.nextAt = Date.now() + backoff(item.attempts);
          });
        }
        continue;
      }
      const deadlines = [
        ...snapshot.inbox.filter(item => item.state === 'pending').map(item => item.nextAt),
        ...snapshot.outbox.filter(item => item.state === 'pending').map(item => item.nextAt),
        ...(snapshot.acks.length ? [ackNextAt] : []),
      ];
      await pausePump(deadlines.length ? Math.max(1, Math.min(...deadlines) - Date.now()) : Infinity);
    }
  }

  async function poll() {
    let failures = 0;
    let unchanged = 0;
    while (running) {
      const began = Date.now();
      let empty = true;
      let progressed = false;
      try {
        const result = await request('poll', {}, true);
        if (!exactKeys(result, ['items']) || !Array.isArray(result.items) || result.items.length > 16) throw fault('INVALID_RELAY_RESPONSE');
        empty = result.items.length === 0;
        for (const packet of result.items) {
          if (!running) break;
          try { progressed = (await receive(packet)) || progressed; } catch (error) {
            if (error.code === 'INBOX_CAPACITY') report('INBOX_CAPACITY');
            else throw error;
          }
        }
        lastSuccessfulPollAt = new Date().toISOString();
        lastPollError = null;
        failures = 0;
      } catch (error) {
        if (!running) break;
        // Store errors must fail closed; network/protocol errors are retryable and sanitized.
        if (error.code && !/^(?:RELAY_|HTTP_|INVALID_RELAY_|RESPONSE_|NETWORK_|REQUEST_)/.test(error.code)) throw error;
        report(error);
        lastPollError = { ...lastError };
        await delay(backoff(++failures));
      }
      unchanged = !empty && !progressed ? unchanged + 1 : 0;
      const minimum = unchanged ? Math.min(5000, 250 * (2 ** Math.min(unchanged - 1, 5))) : (empty ? 250 : 100);
      if (running) await delay(Math.max(1, minimum - (Date.now() - began)));
    }
  }

  async function doSend(kind, body, options) {
    if (!kinds.includes(kind) || !record(body) || !record(options) || Object.keys(options).some(option => !['id', 'expiresAt'].includes(option))) throw fault('INVALID_SEND');
    const packetId = options.id ?? randomUUID();
    if (!validId(packetId)) throw fault('INVALID_ID');
    const bodyJSON = canonical(body);
    if (bytes(bodyJSON) > MAX_PLAINTEXT) throw fault('MESSAGE_TOO_LARGE');
    const clonedBody = JSON.parse(bodyJSON);
    const digest = hash(canonical({ kind, body: clonedBody }));
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const suppliedExpiry = options.expiresAt === undefined ? undefined :
      (Number.isSafeInteger(options.expiresAt) ? options.expiresAt : timestamp(options.expiresAt));
    const previous = store.get().outbox.find(item => item.id === packetId);
    if (previous) {
      if (previous.digest !== digest || (suppliedExpiry !== undefined && suppliedExpiry !== previous.expiresAt)) throw fault('ID_COLLISION');
      notify();
      return { id: packetId };
    }
    const expiry = suppliedExpiry ?? now + (kind === 'command' ? 10 * 60 * 1000 : DAY);
    const envelope = { version: 1, id: packetId, from: id, to: peerId, createdAt, expiresAt: new Date(expiry).toISOString(), kind, body: clonedBody };
    validateEnvelope(envelope, { id: packetId, from: id, to: peerId }, now, false, kinds);
    const plaintext = encoder.encode(JSON.stringify(envelope));
    if (plaintext.byteLength > MAX_PLAINTEXT) throw fault('MESSAGE_TOO_LARGE');
    const ciphertext = await new CompactEncrypt(plaintext).setProtectedHeader({ alg: 'dir', enc: 'A256GCM' }).encrypt(key);
    if (!validCiphertext(ciphertext)) throw fault('MESSAGE_TOO_LARGE');
    await store.update(state => {
      prune(state, now);
      // Concurrent calls with the same id must keep the very first ciphertext.
      const existing = state.outbox.find(item => item.id === packetId);
      if (existing) {
        if (existing.digest !== digest || (suppliedExpiry !== undefined && suppliedExpiry !== existing.expiresAt)) throw fault('ID_COLLISION');
        return;
      }
      if (state.outbox.length >= MAX_OUTBOX || state.outbox.filter(item => item.state === 'pending').length >= MAX_PENDING) throw fault('OUTBOX_CAPACITY');
      state.outbox.push({ id: packetId, digest, ciphertext, createdAt: now, expiresAt: expiry, retainUntil: now + DAY, attempts: 0, nextAt: 0, state: 'pending' });
    });
    notify();
    return { id: packetId };
  }

  return {
    send(kind, body, options = {}) {
      if (closed || fatal) return Promise.reject(fault(closed ? 'ENDPOINT_CLOSED' : 'ENDPOINT_FAILED'));
      const operation = doSend(kind, body, options);
      sends.add(operation);
      operation.then(() => sends.delete(operation), () => sends.delete(operation));
      return operation;
    },
    start() {
      if (closed || fatal) throw fault(closed ? 'ENDPOINT_CLOSED' : 'ENDPOINT_FAILED');
      if (running) return;
      running = true;
      pumpPromise = pump().catch(fail);
      pollPromise = poll().catch(fail);
    },
    close() {
      if (!closePromise) {
        closed = true;
        stopOwned();
        closePromise = (async () => {
          await Promise.allSettled([relaySocket.close(), ...sends, pumpPromise, pollPromise].filter(Boolean));
          try { await store.close(); } finally { key.fill(0); receiptKey.fill(0); }
        })();
      }
      return closePromise;
    },
    status() {
      const connection = !running ? 'stopped' : lastPollError ? 'retrying' : lastSuccessfulPollAt ? 'connected' : 'connecting';
      const connectivity = { connection, lastSuccessfulPollAt, lastPollError: lastPollError ? { ...lastPollError } : null, transport: relaySocket.status() };
      if (closed) return { ...connectivity, role, id, peerId, relayOrigin: base.origin, running: false, closed: true, failed: fatal, lastError: lastError ? { ...lastError } : null };
      let state;
      try { state = store.get(); } catch {
        return { ...connectivity, role, id, peerId, relayOrigin: base.origin, running: false, closed: false, failed: true, lastError: lastError ? { ...lastError } : { code: 'STORAGE_FAILURE', at: new Date().toISOString() } };
      }
      return {
        ...connectivity, role, id, peerId, relayOrigin: base.origin, running, closed: false, failed: fatal,
        outbox: { pending: state.outbox.filter(item => item.state === 'pending').length, sent: state.outbox.filter(item => item.state === 'sent').length, expired: state.outbox.filter(item => item.state === 'expired').length },
        inbox: { pending: state.inbox.filter(item => item.state === 'pending').length, done: state.inbox.filter(item => item.state === 'done').length, quarantined: state.inbox.filter(item => item.state === 'quarantined').length },
        pendingAcks: state.acks.length, quarantineCount: state.quarantine.length,
        lastError: lastError ? { ...lastError } : null,
      };
    },
  };
}
