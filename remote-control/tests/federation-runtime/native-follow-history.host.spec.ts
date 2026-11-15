/** Mapper behavior with actual SDK Session events and LLM owners; full Loader/transport composition remains a separate integration. */
import { isDeepStrictEqual } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionSeq, snapshotSessionEvent, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { AssistantStreamAccumulator, assembleAssistantStream, expandAssistantStream, createMessage, createUserMessage, LlmAttemptId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, TimedStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, it, onTestFinished } from 'vitest'
import { projectNativeFollow, type NativeFollowHistoryBackend, type NativeFollowHistoryContext, type NativeFollowHistoryFrame } from '../../lib/federation/native-follow-history.mjs'

const exportClasses = ['conversation.user', 'conversation.assistant', 'tool.call', 'tool.result', 'usage']
function json(value: unknown): JsonValue {
  if (!isJsonValue(value)) throw new Error('SDK fixture must be JSON')
  // Stdlib JSON.parse is untyped; SDK checks validate the input and the materialized wire DTO.
  const copy: JsonValue = JSON.parse(JSON.stringify(value))
  if (!isJsonValue(copy)) throw new Error('SDK fixture must be JSON')
  return copy
}
function wire(event: SessionEvent): SessionWireEvent {
  return { type: event.type, seq: event.seq, time: event.time, data: json(event.data),
    ...(event.ignorable === true ? { ignorable: true } : {}),
    ...(event.sourceEventSeqs === undefined ? {} : { sourceEventSeqs: json(event.sourceEventSeqs) }),
    ...(event.surfaceOp === undefined ? {} : { surfaceOp: json(event.surfaceOp) }),
  }
}
function records(value: readonly AssistantStreamRecord[]): readonly JsonValue[] {
  const copy = json(value)
  if (!Array.isArray(copy)) throw new Error('SDK compact records must be an array')
  return copy
}
function compact(members: readonly TimedStreamChunk[]): readonly AssistantStreamRecord[] {
  const owner = new AssistantStreamAccumulator()
  for (const member of members) owner.push(member)
  return owner.snapshot()
}
function blocks(stream: readonly AssistantStreamRecord[], interrupted: boolean) {
  const owner = assembleAssistantStream(stream)
  return interrupted ? owner.interruptedBlocks() : owner.blocks()
}
function nativeEvents(session: Session): SessionEvent[] {
  const events: SessionEvent[] = []
  for (let seq = 0; seq < session.seq; seq++) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) throw new Error('SDK fixture lost a native event')
    events.push(event)
  }
  return events
}
const usage = (outputTokens: number) => ({ tokenUsage: { uncachedInputTokens: 10, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } })
async function fixture() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  const session = ctx.sessions.create(SessionId('sdk-native-map'), { meta: { cwd: '/PRIVATE_NATIVE_CWD' } })
  const first = session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'native request' }] }), { surfaceOp: 'append' })
  const context: NativeFollowHistoryContext = { generation: 7, grantRevision: 1, principal: { kind: 'controller', id: 'controller_mapper' }, now: 1,
    exportClasses, grant: { version: 1, grantId: 'mapper_sdk', principal: { kind: 'controller', id: 'controller_mapper' }, machineKey: 'worker', revision: 1, issuedAt: 0,
      projects: [{ projectId: 'demo', actions: ['session.list'], exportClasses, sessions: [{ sessionId: session.id, imported: true, actions: ['session.read', 'session.follow'] }] }] } }
  let reads = 0
  const backend: NativeFollowHistoryBackend = {
    async readDetails() { reads++; const events = nativeEvents(session); return { header: session.header, events, cursor: events.length - 1, running: false,
      projections: { asOfSeq: events.length - 1, values: usage(99) } } },
    validateNativeEvents(events) {
      const known = nativeEvents(session)
      for (const value of events) {
        const event = known.find(candidate => isDeepStrictEqual(candidate, value))
        if (event === undefined) throw new Error('unknown native fixture event')
        snapshotSessionEvent(event)
      }
    },
    nativeExpand: expandAssistantStream, nativeCreateCompactor: () => new AssistantStreamAccumulator(), nativeLiveAssistantBlocks: blocks,
  }
  const opening: Extract<SessionFollowFrame, { type: 'snapshot' }> = { type: 'snapshot', header: session.header, cursor: first.seq,
    records: [{ type: 'event', event: wire(first) }], hasMore: false, projections: { asOfSeq: first.seq, values: usage(1) }, assistantStream: { revision: 0 } }
  const map = (input: readonly SessionFollowFrame[]) => {
    const native = (async function* () { yield* input })()
    return projectNativeFollow({ frames: native, ref: { machineKey: 'worker', projectId: 'demo', sessionId: session.id }, backend,
      historyContext: () => context, check() {}, signal: new AbortController().signal,
      wrapFrame: frame => ({ version: 1, type: 'data', index: 0, frame }) })[Symbol.asyncIterator]()
  }
  return { session, first, opening, map, reads: () => reads }
}
const members: readonly TimedStreamChunk[] = [
  { time: 1, chunk: { type: 'text-delta', index: 12, text: 'Native answer' } },
  { time: 2, chunk: { type: 'reasoning-delta', index: 3, text: 'PRIVATE_NATIVE_REASONING' } },
  { time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
]
for (const kind of ['assistant/message', 'assistant/attempt'] as const) it(`delivers the actual ${kind} carrier before its native end with coherent exact-cut metrics`, async () => {
  const f = await fixture(), stream = compact(members), attemptId = LlmAttemptId(`sdk-${kind}`)
  const settled = kind === 'assistant/message'
    ? f.session.append('assistant/message', { turn: 1, step: 1, stream: [...stream], message: createMessage({ role: 'assistant',
      source: { kind: 'model', provider: 'native-provider', model: 'native-model' }, content: blocks(stream, false) }) }, { surfaceOp: 'append' })
    : f.session.append('assistant/attempt', { turn: 1, step: 1, stream: [...stream] })
  const tail = f.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'next native request' }] }), { surfaceOp: 'append' })
  const native: SessionFollowFrame[] = [f.opening,
    { type: 'assistant-stream', frame: { type: 'start', attemptId, revision: 1, startedAfterSeq: f.first.seq, turn: 1, step: 1 } },
    ...members.map((member, index): SessionFollowFrame => ({ type: 'assistant-stream', frame: { type: 'chunk', attemptId,
      revision: index + 2, index, time: member.time, chunk: json(member.chunk) } })),
    { type: 'event', event: wire(settled) },
    { type: 'assistant-stream', frame: { type: 'end', attemptId, revision: members.length + 2, index: members.length,
      outcome: { kind: 'committed', eventType: kind, seq: settled.seq } } },
    { type: 'event', event: wire(tail) },
  ]
  const iterator = f.map(native), output: NativeFollowHistoryFrame[] = []
  try {
    for (;;) { const step = await iterator.next(); if (step.done) break; output.push(step.value) }
  } finally { await iterator.return?.() }
  const first = output[0]
  if (first?.type !== 'snapshot') throw new Error('missing same-cut source opening')
  expect(first.page.throughSeq).toBe(f.first.seq); expect(first.projections.asOfSeq).toBe(f.first.seq)
  expect(first.projections.values.tokenUsage?.outputTokens).toBe(1)
  const carrierIndex = output.findIndex(frame => frame.type === 'records' && frame.records.some(record => record.type === 'event' ? record.event.seq === settled.seq : record.firstSeq <= settled.seq && record.lastSeq >= settled.seq))
  const endIndex = output.findIndex(frame => frame.type === 'assistant-stream' && frame.frame.type === 'end')
  expect(carrierIndex).toBeGreaterThan(0); expect(endIndex).toBeGreaterThan(carrierIndex)
  const carrier = output[carrierIndex], end = output[endIndex], last = output.at(-1)
  if (carrier?.type !== 'records' || end?.type !== 'assistant-stream' || end.frame.type !== 'end' || last?.type !== 'records') throw new Error('missing source settlement or exact-cut tail')
  expect(carrier.projections).toBeUndefined()
  expect(carrier.records[0]?.type).toBe(kind === 'assistant/message' ? 'event' : 'withheld')
  expect(end.frame.outcome.kind).toBe(kind === 'assistant/message' ? 'committed' : 'abandoned')
  expect(last.projections?.asOfSeq).toBe(tail.seq); expect(last.projections?.values.tokenUsage?.outputTokens).toBe(99)
  expect(f.reads()).toBe(3)
  expect(JSON.stringify(output)).not.toContain('PRIVATE_NATIVE_REASONING'); expect(JSON.stringify(output)).not.toContain('PRIVATE_NATIVE_CWD')
  const revisions = output.flatMap(frame => frame.type === 'assistant-stream' ? [frame.frame.revision] : [])
  expect(revisions).toEqual([1, 2, 3, 4])
})

it('preserves the native active compact opening cut while source revisions and safe block indices restart locally', async () => {
  const f = await fixture(), attemptId = LlmAttemptId('sdk-reconnect'), stream = compact(members)
  const baseline = { revision: 17, activeAttempt: { attemptId, startedAfterSeq: f.first.seq, turn: 1, step: 1, nextIndex: members.length, stream: records(stream) } }
  const iterator = f.map([{ ...f.opening, assistantStream: baseline }])
  try {
    const step = await iterator.next()
    if (step.done || step.value.type !== 'snapshot') throw new Error('missing native compact opening')
    expect(step.value.page.throughSeq).toBe(f.first.seq)
    expect(step.value.assistantStream.revision).toBe(0)
    expect(step.value.assistantStream.activeAttempt?.nextIndex).toBe(2)
    const safe = step.value.assistantStream.activeAttempt?.stream
    expect(JSON.stringify(safe)).toContain('Native answer'); expect(JSON.stringify(safe)).not.toContain('PRIVATE_NATIVE_REASONING')
    expect(f.reads()).toBe(1)
  } finally { await iterator.return?.() }
})

it('never truncates an oversized complete active Assistant baseline to make a source opening fit', async () => {
  const f = await fixture(), attemptId = LlmAttemptId('sdk-oversized-baseline')
  const large: readonly TimedStreamChunk[] = [{ time: 1, chunk: { type: 'text-delta', index: 1, text: '界'.repeat(12000) } }]
  const iterator = f.map([{ ...f.opening, assistantStream: { revision: 2, activeAttempt: { attemptId, startedAfterSeq: f.first.seq,
    turn: 1, step: 1, nextIndex: 1, stream: records(compact(large)) } } }])
  try { await expect(iterator.next()).rejects.toMatchObject({ code: 'page-too-large', message: 'native follow history projection failed' }) }
  finally { await iterator.return?.() }
})
