// Pure submission journal; no browser or Harness dependency. Never sends on load.
const activeSubmissions = new Map();
export const MAX_REPLY_BYTES = 32768;

export function cloneReply(value) {
  let nodes = 0;
  const visit = (item, depth) => {
    if (++nodes > 10000 || depth > 32) throw new Error('tooLarge');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object') throw new Error('tooLarge');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('tooLarge');
    if (Array.isArray(item)) {
      for (let i = 0; i < item.length; i++) { if (!Object.hasOwn(item, i)) throw new Error('tooLarge'); visit(item[i], depth + 1); }
    } else {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string' || !Object.prototype.propertyIsEnumerable.call(item, key)) throw new Error('tooLarge');
        visit(item[key], depth + 1);
      }
    }
  };
  visit(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > MAX_REPLY_BYTES) throw new Error('tooLarge');
  return JSON.parse(text);
}

export function createSubmissionFlow({ storage, uuid, sessionId, callId, id = callId, revision = 1, version = 1, send, canSend = () => true, lock = (_key, operation) => operation() }) {
  const key = version === 1
    ? `local.interactive-replies.submission:${sessionId}:${callId}`
    : 'local.interactive-replies.submission:v2:' + [sessionId, id, revision].map(value => encodeURIComponent(String(value))).join(':');
  function readJournal() {
    let text;
    try { text = storage.getItem(key); } catch { throw new Error('storage'); }
    if (text === null) return null;
    let record;
    try { record = JSON.parse(text); } catch { throw new Error('storage'); }
    if (!record || !['pending', 'sent'].includes(record.status) || typeof record.requestId !== 'string' || !record.requestId || record.envelope?.kind !== 'interactive-ui-reply' || record.envelope.version !== version || record.envelope.sessionId !== sessionId || (version === 1 ? record.envelope.callId !== callId : record.envelope.id !== id || record.envelope.revision !== revision) || typeof record.envelope.summary !== 'string' || record.envelope.summary.length > 2000 || !Object.hasOwn(record.envelope, 'values')) throw new Error('storage');
    cloneReply(record.envelope.values);
    return record;
  }
  function persist(record) {
    try { storage.setItem(key, JSON.stringify(record)); } catch { throw new Error('storage'); }
  }
  function snapshot() {
    const journal = readJournal();
    return { status: activeSubmissions.has(key) ? 'sending' : journal?.status ?? 'idle', journal };
  }
  async function dispatch(values, summary = '') {
    if (!canSend()) throw new Error('unavailable');
    if (activeSubmissions.has(key)) return { accepted: false, reason: 'sending' };
    let record = readJournal();
    if (record?.status === 'sent') return { accepted: true, alreadySent: true };
    if (record === null) {
      if (typeof summary !== 'string' || summary.length > 2000) throw new Error('tooLarge');
      record = {
        status: 'pending', requestId: uuid(),
        envelope: { kind: 'interactive-ui-reply', version, sessionId, callId, ...(version === 2 ? { id, revision } : {}), values: cloneReply(values), summary },
      };
      // Persist before touching the network, so uncertain outcomes retry exactly.
      persist(record);
    }
    const requestId = record.requestId;
    activeSubmissions.set(key, requestId);
    try {
      const result = await send({ requestId, text: JSON.stringify(record.envelope) });
      if (!result || result.ok !== true || result.value?.accepted !== true) {
        // Only an authenticated, explicit refusal before admission is definitive.
        // Network loss/5xx never discards a possibly accepted request identity.
        if (result?.definitive === true) {
          const current = readJournal();
          if (current?.requestId !== requestId) throw new Error('storage');
          try { storage.removeItem(key); } catch { throw new Error('storage'); }
        }
        const error = new Error(result?.error?.message || 'unavailable');
        error.code = result?.error?.code;
        error.errors = result?.error?.errors;
        throw error;
      }
      const current = readJournal();
      if (current?.requestId !== requestId) throw new Error('storage');
      persist({ ...current, status: 'sent' });
      return { accepted: true };
    } finally {
      if (activeSubmissions.get(key) === requestId) activeSubmissions.delete(key);
    }
  }
  function submit(values, summary = '') {
    // The browser supplies a same-origin Web Lock; re-read only inside it.
    return lock(key, () => dispatch(values, summary));
  }
  return { snapshot, submit, key };
}
