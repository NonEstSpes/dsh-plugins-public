// Pure JSON projection helpers: deliberately independent of Harness and Vue.
import { cloneJsonBounded, isRecord, normalizeFields, validateFields } from './validation.js';
export const PROJECTION_KEY = 'localInteractiveReplies';
export const MAX_ITEMS = 64;
export const MAX_PER_TURN = 8;
export const MAX_HISTORY = 16;
export const MAX_CODE_LENGTH = 32768;
export const MAX_REPLY_LENGTH = 65536;
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0);
const natural = value => Number.isSafeInteger(value) && value >= 0;
export const logicalId = spec => spec.schemaVersion === 2 ? spec.id : spec.callId;
export const structuralRevision = spec => spec.schemaVersion === 2 ? spec.revision : 1;
const placementTurn = spec => spec.schemaVersion === 2 ? spec.anchorTurn : spec.turn;

/** Return a detached canonical v1/v2 spec, or null. Never compile/evaluate source. */
export function validateSpec(value) {
  if (!isRecord(value) || ![1, 2].includes(value.schemaVersion) || !text(value.sessionId, 256) || !text(value.callId, 512) || !natural(value.turn) || !natural(value.createdAt) || !text(value.title, 200) || !text(value.template, MAX_CODE_LENGTH) || !text(value.script, MAX_CODE_LENGTH, true)) return null;
  const common = { schemaVersion: value.schemaVersion, sessionId: value.sessionId, turn: value.turn, callId: value.callId, createdAt: value.createdAt, title: value.title, template: value.template, script: value.script };
  if (value.schemaVersion === 1) return common;
  if (!text(value.id, 512) || !natural(value.revision) || value.revision < 1 || !natural(value.dataVersion) || !natural(value.anchorTurn) || value.anchorTurn > value.turn || !Object.hasOwn(value, 'data') || !Array.isArray(value.fields)) return null;
  try { return { ...common, id: value.id, revision: value.revision, dataVersion: value.dataVersion, anchorTurn: value.anchorTurn, data: cloneJsonBounded(value.data), fields: normalizeFields(value.fields) }; } catch { return null; }
}

export function createState(header = {}, inheritedEventCount = 0) {
  return { sessionId: typeof header.id === 'string' ? header.id : '', inheritedEventCount, items: [] };
}

export function normalizeReply(value) {
  if (!isRecord(value) || value.kind !== 'interactive-ui-reply' || ![1, 2].includes(value.version) || !text(value.sessionId, 256) || !text(value.callId, 512) || !Object.hasOwn(value, 'values') || !text(value.summary, 2000, true)) return null;
  const allowed = ['kind', 'version', 'sessionId', 'callId', 'values', 'summary', ...(value.version === 2 ? ['id', 'revision'] : [])];
  if (Object.keys(value).some(key => !allowed.includes(key))) return null;
  if (value.version === 2 && (!text(value.id, 512) || !natural(value.revision) || value.revision < 1)) return null;
  try {
    const reply = { kind: value.kind, version: value.version, sessionId: value.sessionId, callId: value.callId, values: cloneJsonBounded(value.values), summary: value.summary, ...(value.version === 2 ? { id: value.id, revision: value.revision } : {}) };
    cloneJsonBounded(reply, MAX_REPLY_LENGTH);
    return reply;
  } catch { return null; }
}

/** Only explicit human messages; model/developer/tool sources never count. */
export function parseReply(message) {
  if (!isRecord(message) || message.role !== 'user' || message.source?.kind !== 'user' || !Array.isArray(message.content) || message.content.length !== 1) return null;
  const block = message.content[0];
  if (block?.type !== 'text' || !text(block.text, MAX_REPLY_LENGTH)) return null;
  try { return normalizeReply(JSON.parse(block.text)); } catch { return null; }
}

/** Validate against the live same-session card. Pure; admission must be atomic separately. */
export function validateReplyAgainstState(state, envelope) {
  const reply = normalizeReply(envelope);
  if (!reply) return { ok: false, code: 'invalid-envelope' };
  if (reply.sessionId !== state.sessionId) return { ok: false, code: 'foreign-session' };
  const item = state.items.find(item => item.spec.sessionId === reply.sessionId && logicalId(item.spec) === (reply.version === 2 ? reply.id : reply.callId));
  if (!item) return { ok: false, code: 'missing-card' };
  if ((item.spec.schemaVersion === 2) !== (reply.version === 2) || structuralRevision(item.spec) !== (reply.revision ?? 1)) return { ok: false, code: 'stale-revision' };
  if (item.submission !== null) return { ok: false, code: 'already-submitted' };
  const validation = validateFields(item.spec.fields ?? [], reply.values);
  if (!validation.ok) return { ok: false, code: 'invalid-values', errors: validation.errors };
  // callId is diagnostic in v2: data-only updates do not invalidate an open form.
  return { ok: true, reply, item };
}

function bounded(items) {
  const counts = new Map(), kept = [];
  for (let index = items.length - 1; index >= 0 && kept.length < MAX_ITEMS; index--) {
    const item = items[index], key = JSON.stringify([item.spec.sessionId, placementTurn(item.spec)]), count = counts.get(key) ?? 0;
    if (count >= MAX_PER_TURN) continue;
    counts.set(key, count + 1); kept.push(item);
  }
  return kept.reverse();
}

const sameStructure = (a, b) => a.template === b.template && a.script === b.script && JSON.stringify(a.fields) === JSON.stringify(b.fields);

export function applyEvent(state, event) {
  if (!event || !natural(event.seq)) return state;
  if (event.type === 'tool/result') {
    const data = event.data, message = data?.message;
    if (!isRecord(data) || message?.role !== 'tool' || message.isError === true || data.error != null || message.source?.kind !== 'tool') return state;
    const spec = validateSpec(data.meta?.interactiveReply);
    if (!spec || data.turn !== spec.turn || message.toolCallId !== spec.callId || message.source.callId !== spec.callId || (spec.sessionId !== state.sessionId && event.seq >= state.inheritedEventCount)) return state;
    const index = state.items.findIndex(item => item.spec.sessionId === spec.sessionId && logicalId(item.spec) === logicalId(spec));
    if (index < 0) return { ...state, items: bounded([...state.items, { spec, resultSeq: event.seq, submission: null }]) };
    const previous = state.items[index];
    if (spec.callId === previous.spec.callId || event.seq <= previous.resultSeq || spec.schemaVersion !== 2 || previous.spec.schemaVersion !== 2 || spec.anchorTurn !== previous.spec.anchorTurn || spec.createdAt !== previous.spec.createdAt) return state;
    const old = previous.spec;
    let next;
    if (spec.revision === old.revision && spec.dataVersion === old.dataVersion + 1 && sameStructure(old, spec)) next = { ...previous, spec, resultSeq: event.seq };
    else if (spec.revision === old.revision + 1 && spec.dataVersion === 0) {
      const history = [...(previous.history ?? []), ...(previous.submission === null ? [] : [{ revision: old.revision, ...previous.submission }])].slice(-MAX_HISTORY);
      next = { spec, resultSeq: event.seq, submission: null, ...(history.length ? { history } : {}) };
    } else return state;
    const items = state.items.slice(); items[index] = next;
    return { ...state, items };
  }
  if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) {
    let next = state;
    for (const message of event.data.inserted) next = applyEvent(next, { type: 'user/message', seq: event.seq, data: message });
    return next;
  }
  if (event.type === 'user/message') {
    const reply = parseReply(event.data);
    if (!reply || (reply.sessionId !== state.sessionId && event.seq >= state.inheritedEventCount)) return state;
    // Inherited accepted history is replayed under its original Session identity.
    const checked = validateReplyAgainstState({ ...state, sessionId: reply.sessionId }, reply);
    if (!checked.ok) return state;
    const index = state.items.indexOf(checked.item), items = state.items.slice();
    items[index] = { ...checked.item, submission: { values: reply.values, summary: reply.summary, seq: event.seq } };
    return { ...state, items };
  }
  return state;
}

function validSubmission(submission) {
  if (!isRecord(submission) || !natural(submission.seq) || !text(submission.summary, 2000, true) || !Object.hasOwn(submission, 'values')) return false;
  try { cloneJsonBounded(submission.values); return true; } catch { return false; }
}

/** Cached-state parser preserves identity; stateVersion2 forces old caches to refold. */
export function parseState(value) {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !natural(value.inheritedEventCount) || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new TypeError('Invalid interactive replies projection');
  const counts = new Map(), seen = new Set();
  for (const item of value.items) {
    if (!isRecord(item) || !validateSpec(item.spec) || !natural(item.resultSeq)) throw new TypeError('Invalid interactive reply item');
    const id = JSON.stringify([item.spec.sessionId, logicalId(item.spec)]), turn = JSON.stringify([item.spec.sessionId, placementTurn(item.spec)]), count = (counts.get(turn) ?? 0) + 1;
    if (seen.has(id) || count > MAX_PER_TURN) throw new TypeError('Invalid interactive reply bounds');
    seen.add(id); counts.set(turn, count);
    if (item.submission !== null && (!validSubmission(item.submission) || !validateFields(item.spec.fields ?? [], item.submission.values).ok)) throw new TypeError('Invalid interactive reply submission');
    if (item.history !== undefined) {
      if (item.spec.schemaVersion !== 2 || !Array.isArray(item.history) || item.history.length > MAX_HISTORY) throw new TypeError('Invalid reply history');
      let last = 0;
      for (const snapshot of item.history) {
        if (!validSubmission(snapshot) || !natural(snapshot.revision) || snapshot.revision <= last || snapshot.revision >= item.spec.revision) throw new TypeError('Invalid historical submission');
        last = snapshot.revision;
      }
    }
  }
  return value;
}
