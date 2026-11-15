import { z } from 'zod';

export const RESULT_KEY = 'remote-control.result';
export const ResultSchema = z.object({
  turn: z.number().int(), endedSeq: z.number().int(), status: z.string(),
  text: z.string(), truncated: z.boolean(), finishedAt: z.string(), requestIds: z.array(z.string()),
  inbox: z.object({ 'next-turn': z.array(z.string().nullable()), 'next-step': z.array(z.string().nullable()) }),
});
export function initialResult() {
  return { turn: -1, endedSeq: -1, status: 'idle', text: '', truncated: false, finishedAt: '', requestIds: [], inbox: { 'next-turn': [], 'next-step': [] } };
}
export function foldResult(state, event) {
  if (event.type === 'agent/inbox/spliced') {
    const { target, start, removedCount = 0, inserted = [], outcome } = event.data;
    if (target !== 'next-turn' && target !== 'next-step') return state;
    const queue = [...state.inbox[target]];
    const ids = inserted.map(message => typeof message.source?.rpcId === 'string' ? message.source.rpcId : null);
    const removed = queue.splice(start, removedCount, ...ids).filter(Boolean);
    const inbox = { ...state.inbox, [target]: queue };
    if (outcome === 'canceled' || state.status !== 'running') return { ...state, inbox };
    return { ...state, inbox, requestIds: [...new Set([...state.requestIds, ...removed])] };
  }
  if (event.type === 'turn/start') return { ...state, turn: event.data.turn, status: 'running', text: '', truncated: false, requestIds: [] };
  if (event.type === 'user/message' && event.surfaceOp === 'append' && state.turn >= 0) {
    const requestId = event.data.source?.rpcId;
    if (typeof requestId === 'string' && !state.requestIds.includes(requestId)) return { ...state, requestIds: [...state.requestIds.slice(-31), requestId] };
  }
  if (event.type === 'assistant/message' && event.surfaceOp === 'append' && event.data.turn === state.turn) {
    const full = (event.data.message?.content || []).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
    const raw = Buffer.from(full, 'utf8');
    let clipped = raw.subarray(0, 16000).toString('utf8');
    while (Buffer.byteLength(clipped) > 16000) clipped = clipped.slice(0, -1);
    return { ...state, text: clipped, truncated: raw.length > 16000 };
  }
  if (event.type === 'turn/end') return { ...state, turn: event.data.turn, endedSeq: event.seq, status: event.data.reason.kind === 'error' ? 'failed' : event.data.reason.kind, finishedAt: new Date(event.time).toISOString() };
  return state;
}
export const resultProjection = {
  key: RESULT_KEY, stateVersion: 3, stateSchema: ResultSchema,
  init: initialResult, apply: foldResult,
  // Host-only derived state; never duplicate transcript contents in the browser wire.
};
