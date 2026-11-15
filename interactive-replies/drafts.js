import { cloneReply } from './submission.js';

// Only explicit JSON draft state is persisted; arbitrary Vue refs/functions aren't.
export function createDraftStore({ storage, sessionId, id, revision, clock = Date.now }) {
  const key = 'local.interactive-replies.draft:' + [sessionId, id, revision].map(value => encodeURIComponent(String(value))).join(':');
  let expectedText;
  function getText() { try { return storage.getItem(key); } catch { throw new Error('draftStorage'); } }
  function load() {
    const text = getText();
    expectedText = text;
    if (text === null) return {};
    let record;
    try { record = JSON.parse(text); } catch { throw new Error('draftCorrupt'); }
    if (record?.version !== 1 || record.sessionId !== sessionId || record.id !== id || record.revision !== revision || !Number.isFinite(record.savedAt) || !record.value || typeof record.value !== 'object' || Array.isArray(record.value)) throw new Error('draftCorrupt');
    try { return cloneReply(record.value); } catch { throw new Error('draftCorrupt'); }
  }
  function save(value) {
    const detached = cloneReply(value);
    if (!detached || typeof detached !== 'object' || Array.isArray(detached)) throw new Error('draftCorrupt');
    if (expectedText === undefined) throw new Error('draftNotLoaded');
    if (getText() !== expectedText) throw new Error('draftConflict');
    const text = JSON.stringify({ version: 1, sessionId, id, revision, savedAt: clock(), value: detached });
    try { storage.setItem(key, text); } catch { throw new Error('draftStorage'); }
    expectedText = text;
    return true;
  }
  function clear() {
    try { storage.removeItem(key); } catch { throw new Error('draftStorage'); }
    expectedText = null;
  }
  return { key, load, save, clear };
}
