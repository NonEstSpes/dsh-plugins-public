// Owner-only exact Connection Fetch adapter. Do not expose this operation as a model tool.
// Installed dsh-client-connection's exact-route dispatcher rejects non-owner peers
// before calling route.fetch; dsh-agent-loop followup commits its inbox synchronously.
import { PROJECTION_KEY, parseReply, validateReplyAgainstState } from './state.js';
import { cloneJsonBounded, isRecord } from './validation.js';
export const SUBMIT_PATH = '/api/interactive-replies/submit';
export const MAX_REQUEST_BYTES = 65536;
const fail = (code, extra = {}) => ({ accepted: false, code, ...extra, definitive: true });

function requestValue(value) {
  const request = cloneJsonBounded(value, MAX_REQUEST_BYTES);
  if (!isRecord(request) || Object.keys(request).some(key => !['requestId', 'envelope', 'clientTimeZone'].includes(key)) || typeof request.requestId !== 'string' || !request.requestId.trim() || request.requestId.length > 256 || !isRecord(request.envelope) || typeof request.envelope.sessionId !== 'string' || !request.envelope.sessionId.trim() || request.envelope.sessionId.length > 256) throw new TypeError('Invalid submission request');
  return request;
}

function timeZone(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 128 || (value !== 'UTC' && !/^[A-Za-z_+-]+\/[A-Za-z0-9_+./-]+$/.test(value))) throw new TypeError('Invalid clientTimeZone');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; } catch { throw new TypeError('Invalid clientTimeZone'); }
}

// Durable insertions are receipts even when the input has since been claimed or
// canceled. Never turn a retry of accepted input into a second human message.
function admittedMessages(agent) {
  const messages = [...agent.inbox.nextTurn, ...agent.inbox.nextStep];
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'user/message') messages.push(event.data);
    else if (event.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)) messages.push(...event.data.inserted);
  }
  return messages.filter(message => message?.role === 'user' && message.source?.kind === 'user');
}
const matchesRequest = (messages, id) => messages.some(message => message.source.rpcId === id);
const sameCard = (a, b) => a.sessionId === b.sessionId && a.version === b.version && (a.version === 2 ? a.id === b.id && a.revision === b.revision : a.callId === b.callId);
function freezeDeep(value) {
  if (value !== null && typeof value === 'object') { Object.values(value).forEach(freezeDeep); Object.freeze(value); }
  return value;
}

/** Must only be called by the authenticated owner-only exact Fetch adapter. */
export async function admitOwnerReply(ctx, input, signal) {
  let request;
  try { request = requestValue(input); } catch { return fail('invalid-request'); }
  signal.throwIfAborted();
  const resolved = await ctx.sessionController.resolveAgent(request.envelope.sessionId);
  signal.throwIfAborted();
  if ('error' in resolved) return fail(resolved.error.code ?? 'session-unavailable');
  const agent = resolved.agent;
  const messages = admittedMessages(agent);
  // This intentionally precedes current schema/revision/time-zone validation.
  if (matchesRequest(messages, request.requestId)) return { accepted: true };
  let clientTimeZone;
  try { clientTimeZone = timeZone(request.clientTimeZone); } catch { return fail('invalid-time-zone'); }
  const state = ctx.sessionProjections.stateOf(agent.session, PROJECTION_KEY);
  if (!state) return fail('projection-unavailable');
  const checked = validateReplyAgainstState(state, request.envelope);
  if (!checked.ok) return fail(checked.code, checked.errors ? { errors: checked.errors } : {});
  if (messages.some(message => { const reply = parseReply(message); return reply && sameCard(reply, checked.reply); })) return fail('already-admitted');
  signal.throwIfAborted();
  const message = freezeDeep({ id: globalThis.crypto.randomUUID(), role: 'user', content: [{ type: 'text', text: JSON.stringify(checked.reply) }], source: { kind: 'user', rpcId: request.requestId, ...(clientTimeZone === undefined ? {} : { clientTimeZone }) } });
  // No await from the live projection read through this durable synchronous
  // followup. A reentrant wake error can happen after inbox insertion committed.
  try { agent.followup(message); } catch (error) {
    if (matchesRequest(admittedMessages(agent), request.requestId)) return { accepted: true };
    throw error; // Unknown outcome: never issue a definitive negative receipt.
  }
  return { accepted: true };
}

const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export function createSubmitRoute(ctx) {
  return {
    path: SUBMIT_PATH, methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method !== 'POST') return response(fail('method-not-allowed'), 405);
        if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') return response(fail('invalid-content-type'), 415);
        const declared = request.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) return response(fail('request-too-large'), 413);
        const body = await request.text();
        if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES) return response(fail('request-too-large'), 413);
        let value;
        try { value = JSON.parse(body); } catch { return response(fail('invalid-json'), 400); }
        return response(await admitOwnerReply(ctx, value, request.signal));
      } catch {
        // A carrier failure/abort can overlap a successful durable append.
        return response({ accepted: false, code: 'admission-unknown' }, 500);
      }
    },
  };
}
