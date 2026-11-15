/** Pure live export uses the maintained native compactor/assembler; not a transport or physical Worker acceptance. */
import { describe, expect, it } from 'vitest'
import { AssistantStreamAccumulator, assembleAssistantStream, expandAssistantStream, LlmAttemptId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { AssistantStreamRecord, TimedStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { isJsonValue, snapshotJsonValue, type JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ExportCursor, ExportGeneration, GrantRevision, SessionAssistantStreamBaseline, SessionAssistantStreamFrame, SourceHistoryFrame } from '../../../dsh-remote-core/packages/api/session-controller/src/types.ts'
import { createLiveHistoryProjector, type LiveHistorySettlement } from '../../lib/federation/live-history.mjs'

const attemptId = LlmAttemptId('live-native-owner-attempt')
const rawArguments = ' { "path" : "worker.txt" } '
const toolId = ToolCallId('live-native-tool')
const generation = 'native-live-generation' as ExportGeneration
const grantRevision = 'native-live-grant' as GrantRevision
const exportCursor = 'native-live-opening' as ExportCursor

function json(value: unknown): value is JsonValue { return isJsonValue(value) }
function wire(value: unknown): JsonValue {
  if (!json(value)) throw new Error('native fixture value was not JSON serializable')
  const result = snapshotJsonValue(value)
  if (result === undefined) throw new Error('native fixture value was not JSON serializable')
  return result
}
function wireRecords(value: readonly AssistantStreamRecord[]): readonly JsonValue[] {
  const result = wire(value)
  if (!Array.isArray(result)) throw new Error('native compact records must be an array')
  return result
}
function blocks(stream: readonly AssistantStreamRecord[], interrupted: boolean) {
  const assembled = assembleAssistantStream(stream)
  return interrupted ? assembled.interruptedBlocks() : assembled.blocks()
}
function compact(input: readonly TimedStreamChunk[]): readonly AssistantStreamRecord[] {
  const accumulator = new AssistantStreamAccumulator()
  for (const member of input) accumulator.push(member)
  return accumulator.snapshot()
}
function projector(classes: readonly string[] = ['conversation.assistant', 'tool.call']) {
  return createLiveHistoryProjector({ exportClasses: classes, nativeExpand: expandAssistantStream,
    nativeAssistantBlocks: blocks, nativeCreateCompactor: () => new AssistantStreamAccumulator(),
    wrapBaseline: assistantStream => ({ type: 'snapshot', page: { generation, grantRevision, exportCursor,
      throughSeq: 0, coveredFromSeq: null, coveredThroughSeq: null, hasMore: false, records: [] },
    header: { version: 1, id: SessionId('native-live-session'), createdAt: 0, isSeeded: false },
    projections: { asOfSeq: 0, values: {} }, assistantStream } satisfies SourceHistoryFrame),
    wrapFrame: frame => ({ type: 'assistant-stream', generation, grantRevision, frame } satisfies SourceHistoryFrame),
  })
}
function members(): readonly TimedStreamChunk[] {
  return [
    { time: 1, chunk: { type: 'block-start', index: 12, blockType: 'text' } },
    { time: 2, chunk: { type: 'text-delta', index: 12, text: 'Native text' } },
    { time: 3, chunk: { type: 'block-end', index: 12, block: { type: 'text', text: 'Native text' } } },
    { time: 4, chunk: { type: 'block-start', index: 7, blockType: 'reasoning' } },
    { time: 5, chunk: { type: 'reasoning-delta', index: 7, text: 'PRIVATE_NATIVE_REASONING' } },
    { time: 6, chunk: { type: 'block-end', index: 7, block: { type: 'reasoning', text: 'PRIVATE_NATIVE_REASONING' } } },
    { time: 7, chunk: { type: 'block-start', index: 2, blockType: 'tool-call' } },
    { time: 8, chunk: { type: 'tool-call-delta', index: 2, id: toolId, name: 'read', argumentsDelta: rawArguments } },
    { time: 9, chunk: { type: 'block-end', index: 2, block: { type: 'tool-call', id: toolId, name: 'read', arguments: rawArguments } } },
    { time: 10, chunk: { type: 'usage', usage: { inputTokens: 123, outputTokens: 456 } } },
    { time: 11, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
  ]
}
function projectedMembers(): readonly TimedStreamChunk[] {
  return [
    { time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
    { time: 2, chunk: { type: 'text-delta', index: 0, text: 'Native text' } },
    { time: 3, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Native text' } } },
    { time: 7, chunk: { type: 'block-start', index: 1, blockType: 'tool-call' } },
    { time: 8, chunk: { type: 'tool-call-delta', index: 1, id: toolId, name: 'read', argumentsDelta: rawArguments } },
    { time: 9, chunk: { type: 'block-end', index: 1, block: { type: 'tool-call', id: toolId, name: 'read', arguments: rawArguments } } },
    { time: 11, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } },
  ]
}
function opening(input: readonly TimedStreamChunk[], revision = 41): SessionAssistantStreamBaseline {
  return { revision, activeAttempt: { attemptId, startedAfterSeq: SessionSeq(0), turn: 1, step: 1,
    nextIndex: input.length, stream: wireRecords(compact(input)) } }
}
function start(revision = 1): SessionAssistantStreamFrame {
  return { type: 'start', attemptId, revision, startedAfterSeq: SessionSeq(0), turn: 1, step: 1 }
}
function chunk(member: TimedStreamChunk, index: number): SessionAssistantStreamFrame {
  return { type: 'chunk', attemptId, revision: index + 2, index, time: member.time, chunk: wire(member.chunk) }
}
function end(input: readonly TimedStreamChunk[]): SessionAssistantStreamFrame {
  return { type: 'end', attemptId, revision: input.length + 2, index: input.length,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } }
}
function settlement(visible: boolean): LiveHistorySettlement {
  return { eventType: 'assistant/message', seq: 1, turn: 1, step: 1, record: visible
    ? { type: 'event', event: { type: 'assistant/message', seq: 1, time: 12, surfaceOp: 'append', data: { turn: 1, step: 1,
      message: { content: [{ type: 'text', text: 'Native text' }, { type: 'tool-call', id: toolId, name: 'read', arguments: rawArguments }] } } } }
    : { type: 'withheld', firstSeq: 1, lastSeq: 1, reason: 'policy' } }
}

describe('live projection with maintained native LLM owners', () => {
  it('remaps a native compact opening without private reasoning or usage and preserves raw tool arguments', () => {
    const p = projector()
    try {
      const value = p.open(opening(members()))
      expect(value.revision).toBe(0)
      const active = value.activeAttempt
      if (active === undefined) throw new Error('native active attempt was lost')
      expect(active).toMatchObject({ attemptId, startedAfterSeq: 0, turn: 1, step: 1, nextIndex: 7 })
      expect(active.stream).toEqual(wireRecords(compact(projectedMembers())))
      expect(expandAssistantStream(compact(projectedMembers())).map(member => member.time)).toEqual([1, 2, 3, 7, 8, 9, 11])
      expect(blocks(compact(projectedMembers()), false)).toEqual(blocks(compact(members()), false).filter(block => block.type !== 'reasoning'))
      expect(JSON.stringify(value)).not.toContain('PRIVATE_NATIVE_REASONING')
      expect(JSON.stringify(value)).not.toContain('inputTokens')
      expect(JSON.stringify(value)).toContain(JSON.stringify(rawArguments).slice(1, -1))
      expect(Object.isFrozen(value)).toBe(true)
    } finally { p.close() }
  })

  it('uses dense live revisions and indexes while matching the native opening projection', () => {
    const input = members(), p = projector(), reconnect = projector()
    try {
      expect(p.open({ revision: 0 })).toEqual({ revision: 0 })
      const frames: SessionAssistantStreamFrame[] = [...p.accept(start())]
      input.forEach((member, index) => { frames.push(...p.accept(chunk(member, index))) })
      const ending = p.accept(end(input), settlement(true))
      frames.push(...ending)
      expect(frames.map(frame => frame.revision)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
      const live = frames.flatMap(frame => frame.type === 'chunk' ? [{ time: frame.time, chunk: frame.chunk }] : [])
      const baseline = reconnect.open(opening(input)).activeAttempt
      if (baseline === undefined) throw new Error('reconnect baseline omitted the attempt')
      expect(live).toEqual(expandAssistantStream(compact(projectedMembers())).map(member => ({ time: member.time, chunk: wire(member.chunk) })))
      expect(baseline.stream).toEqual(wireRecords(compact(projectedMembers())))
      expect(ending).toEqual([{ type: 'end', revision: 9, attemptId, index: 7,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } }])
    } finally { p.close(); reconnect.close() }
  })

  it('abandons a policy-withheld native settlement instead of claiming an unseen commit', () => {
    const input = members(), p = projector()
    try {
      p.open({ revision: 0 }); p.accept(start())
      input.forEach((member, index) => { p.accept(chunk(member, index)) })
      expect(p.accept(end(input), settlement(false))).toEqual([{ type: 'end', revision: 9, attemptId,
        index: 7, outcome: { kind: 'abandoned' } }])
    } finally { p.close() }
  })

  it('keeps the first native block close authoritative across a reconnect', () => {
    const input: readonly TimedStreamChunk[] = [
      { time: 1, chunk: { type: 'text-delta', index: 12, text: 'first' } },
      { time: 2, chunk: { type: 'block-end', index: 12, block: { type: 'text', text: 'first' } } },
      { time: 3, chunk: { type: 'text-delta', index: 12, text: 'PRIVATE_LATE_SUFFIX' } },
      { time: 4, chunk: { type: 'block-end', index: 12, block: { type: 'text', text: 'PRIVATE_LATE_CLOSE' } } },
    ]
    const p = projector()
    try {
      const value = p.open(opening(input))
      expect(value.activeAttempt?.nextIndex).toBe(2)
      expect(JSON.stringify(value)).not.toContain('PRIVATE_LATE')
    } finally { p.close() }
  })
})
