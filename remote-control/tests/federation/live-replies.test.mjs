import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLiveHistoryReplyFrame, parseHistoryReplyFrame } from '../../lib/federation/history-replies.mjs'
import { createWireCodec } from '../../lib/federation/wire-codec.mjs'
import { buildHistoryPage } from '../../lib/federation/history.mjs'
const ref = { machineKey: 'worker', projectId: 'demo', sessionId: 'session' }, authority = { generation: 2, grantRevision: 1 }
const raw = frame => ({ type: 'assistant-stream', ...authority, frame })
const start = { type: 'start', revision: 1, attemptId: 'attempt', startedAfterSeq: -1, turn: 0, step: 0 }
function snapshot() {
  const principal = { kind: 'controller', id: 'controller' }, exportClasses = ['conversation.assistant']
  const grant = { version: 1, grantId: 'reply_live', principal, machineKey: 'worker', revision: 1, issuedAt: 0,
    projects: [{ projectId: 'demo', actions: ['session.list'], exportClasses, sessions: [{ sessionId: 'session', imported: true, actions: ['session.read', 'session.follow'] }] }] }
  const page = buildHistoryPage({ ...ref, ...authority, principal, grant, exportClasses, now: 1, events: [], validateNativeEvents() {}, format: 'native-details-v1' })
  return { type: 'snapshot', page, header: { version: 1, id: 'session', createdAt: 1, isSeeded: false }, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }
}

test('only the explicitly live reader and codec accept assistant frames', () => {
  const codec = createWireCodec({ machineKey: ref.machineKey }), value = raw(start)
  const parsed = parseLiveHistoryReplyFrame(value, ref, authority)
  const wire = codec.toWire('live-history-frame', parsed)
  assert.match(wire.generation, /^feg1\./); assert.match(wire.grantRevision, /^fgr1\./)
  assert.deepEqual(codec.fromWire('live-history-frame', wire), value)
  assert.throws(() => codec.toWire('history-frame', value))
  assert.throws(() => parseHistoryReplyFrame(value, ref, 'native-details-v1'))
  assert.throws(() => parseLiveHistoryReplyFrame(value, ref, { ...authority, generation: 3 }))
})

test('live opening keeps the exact details cursor and detached baseline while legacy readers reject it', () => {
  const value = snapshot(), result = parseLiveHistoryReplyFrame(value, ref, authority)
  assert.match(result.page.exportCursor, /^fec2\./)
  value.assistantStream.revision = 10
  assert.equal(result.assistantStream.revision, 0)
  assert.throws(() => parseHistoryReplyFrame(value, ref, 'native-details-v1'))
  assert.throws(() => parseLiveHistoryReplyFrame({ ...snapshot(), header: { ...snapshot().header, id: 'other' } }, ref, authority))
})

for (const frame of [
  { ...start, PRIVATE_REASONING: 'no' },
  { type: 'chunk', revision: 2, attemptId: 'attempt', index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'PRIVATE' } },
  { type: 'chunk', revision: 2, attemptId: 'attempt', index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x', usage: {} } },
  { type: 'end', revision: 3, attemptId: 'attempt', index: 1, outcome: { kind: 'committed', eventType: 'tool/result', seq: 0 } },
]) test('closed live replies refuse private or unsupported native fields', () => {
  assert.throws(() => parseLiveHistoryReplyFrame(raw(frame), ref, authority), error => error.code === 'invalid-message' && !error.message.includes('PRIVATE'))
})

test('live parser rejects a baseline whose filtered chunk count or opening cut is inconsistent', () => {
  const activeAttempt = { attemptId: 'attempt', startedAfterSeq: -1, turn: 0, step: 0, nextIndex: 1,
    stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['a', 'b'] }] }
  assert.throws(() => parseLiveHistoryReplyFrame({ ...snapshot(), assistantStream: { revision: 0, activeAttempt } }, ref, authority))
  activeAttempt.nextIndex = 2; activeAttempt.startedAfterSeq = 0
  assert.throws(() => parseLiveHistoryReplyFrame({ ...snapshot(), assistantStream: { revision: 0, activeAttempt } }, ref, authority))
})
