import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveHistoryProjector } from '../../lib/federation/live-history.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import { canonicalJson } from '../../lib/federation/journal.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS, jsonByteLength } from '../../lib/federation/protocol.mjs'

const SECRET = 'PRIVATE_LIVE_OWNER_DIAGNOSTIC_927'
const clone = value => structuredClone(value)
const freeze = value => { if (value && typeof value === 'object') { for (const member of Object.values(value)) freeze(member); Object.freeze(value) } return value }
const timed = (time, chunk) => ({ time, chunk })
const textDelta = (index, text) => ({ type: 'text-delta', index, text })
const textBlock = text => ({ type: 'text', text })
const records = members => members.map(member => ({ type: 'chunk', ...clone(member) }))
const start = (revision = 1) => ({ type: 'start', attemptId: 'attempt-a', revision, startedAfterSeq: 5, turn: 1, step: 2 })
const chunk = (index, member, revision = index + 2) => ({ type: 'chunk', attemptId: 'attempt-a', revision, index, ...member })
const end = (index, revision = index + 2, eventType = 'assistant/message') => ({ type: 'end', attemptId: 'attempt-a', revision, index,
  outcome: { kind: 'committed', eventType, seq: 6 } })
const withheld = (eventType = 'assistant/attempt') => ({ eventType, seq: 6, turn: 1, step: 2,
  record: { type: 'withheld', firstSeq: 6, lastSeq: 6, reason: 'policy' } })
const visible = content => ({ eventType: 'assistant/message', seq: 6, turn: 1, step: 2,
  record: { type: 'event', event: { type: 'assistant/message', seq: 6, time: 99, surfaceOp: 'append', data: { turn: 1, step: 2,
    message: { id: 'assistant-a', role: 'assistant', source: { kind: 'model', provider: 'fixture', model: 'fixture' }, content } } } } })

// Fixed native-output vectors only. This fixture does not implement assembly or claim SDK equivalence.
// Lead-owned native Vitest evidence supplies the real expand/Accumulator/assemble callbacks separately.
function ownerFixture() {
  const expansions = new Map(), proofs = new Map()
  const calls = { expand: 0, assemble: 0, snapshot: 0, push: 0, factory: 0 }
  return {
    calls,
    expansion(stream, members) { expansions.set(canonicalJson(stream), freeze(clone(members))) },
    proof(stream, blocks, interrupted = false) { proofs.set(canonicalJson([stream, interrupted]), freeze(clone(blocks))) },
    nativeExpand(stream) {
      calls.expand++
      const result = expansions.get(canonicalJson(stream))
      assert.notEqual(result, undefined, 'missing fixed native expansion vector')
      return result
    },
    nativeAssistantBlocks(stream, interrupted) {
      calls.assemble++
      const result = proofs.get(canonicalJson([stream, interrupted]))
      assert.notEqual(result, undefined, 'missing fixed native assembly vector')
      return result
    },
    nativeCreateCompactor() {
      calls.factory++
      const members = []
      return {
        push(member) { calls.push++; members.push(clone(member)) },
        snapshot() { calls.snapshot++; return freeze(records(members)) },
      }
    },
  }
}
function harness(options = {}) {
  const owner = ownerFixture()
  const projector = createLiveHistoryProjector({ exportClasses: ['conversation.assistant', 'tool.call'], ...owner,
    wrapBaseline: baseline => ({ protocol: 2, value: { assistantStream: baseline } }),
    wrapFrame: frame => ({ protocol: 2, value: { type: 'assistant-stream', frame } }), ...options })
  return { owner, projector }
}
function failed(operation, code = FAILURE_CODES.INVALID_MESSAGE) {
  assert.throws(operation, error => error instanceof FederationContractError && error.code === code
    && error.message === 'native live history projection failed' && error.detail === undefined && error.cause === undefined
    && !JSON.stringify(error).includes(SECRET))
}

test('filters private chunks with dense exported frame revisions, chunk indexes and first-seen block indexes', () => {
  const { owner, projector } = harness()
  assert.deepEqual(projector.open({ revision: 10 }), { revision: 0 })
  assert.equal(projector.accept(start(11))[0].revision, 1)
  let reads = 0
  const usage = { type: 'usage', get usage() { reads++; throw new Error(SECRET) } }
  const finish = { type: 'finish', reason: { kind: 'stop' }, get replayState() { reads++; throw new Error(SECRET) } }
  const members = [timed(10, { type: 'block-start', index: 9, blockType: 'reasoning' }),
    timed(11, { type: 'reasoning-delta', index: 9, get text() { reads++; throw new Error(SECRET) } }),
    timed(13, textDelta(12, 'hello')), timed(14, { type: 'tool-call-delta', index: 3, id: 'call-a', name: 'read', argumentsDelta: '{"x":' }),
    timed(15, { type: 'tool-call-delta', index: 3, id: 'call-a', argumentsDelta: '1}' }), timed(16, usage), timed(17, finish)]
  const output = members.flatMap((member, index) => projector.accept(chunk(index, member, index + 12)))
  assert.deepEqual(output.map(frame => [frame.revision, frame.index, frame.chunk.index]), [[2, 0, 0], [3, 1, 1], [4, 2, 1], [5, 3, undefined]])
  assert.equal(output[1].chunk.argumentsDelta, '{"x":')
  assert.equal(output[2].chunk.argumentsDelta, '1}')
  assert.equal(reads, 0)
  assert.equal(owner.calls.assemble, 0)
  assert.equal(owner.calls.snapshot, 0)
  const safe = [members[2], members[3], members[4], timed(17, { type: 'finish', reason: { kind: 'stop' } })]
  const dense = [timed(13, textDelta(0, 'hello')), timed(14, { ...members[3].chunk, index: 1 }),
    timed(15, { ...members[4].chunk, index: 1 }), safe[3]]
  const blocks = [textBlock('hello'), { type: 'tool-call', id: 'call-a', name: 'read', arguments: '{"x":1}' }]
  owner.proof(records(safe), blocks); owner.proof(records(dense), blocks)
  const terminal = projector.accept(end(7, 19), visible(blocks))[0]
  assert.deepEqual(terminal, { type: 'end', attemptId: 'attempt-a', revision: 6, index: 4,
    outcome: { kind: 'committed', eventType: 'assistant/message', seq: 6 } })
  assert.equal(owner.calls.assemble, 2)
  assert.equal(Object.isFrozen(output[1].chunk), true)
  assert.equal(Object.isFrozen(terminal.outcome), true)
  assert.equal(JSON.stringify(output).includes('reasoning'), false)
  assert.equal(JSON.stringify(output).includes(SECRET), false)
})

test('reconnect expansion preserves exact member timing and filtered prefix counters without per-chunk full proofs', () => {
  const { owner, projector } = harness()
  const source = freeze([{ type: 'reasoning-chunks', time0: 1, index: 2, dt: [], texts: [SECRET] },
    { type: 'text-chunks', time0: 5, index: 12, dt: [2], texts: ['a', 'b'] }])
  const expanded = [timed(1, { type: 'reasoning-delta', index: 2, text: SECRET }), timed(5, textDelta(12, 'a')), timed(7, textDelta(12, 'b'))]
  owner.expansion(source, expanded)
  owner.proof(source, [{ type: 'reasoning', text: SECRET }, textBlock('ab')])
  owner.proof(records(expanded.slice(1)), [textBlock('ab')])
  const dense = [timed(5, textDelta(0, 'a')), timed(7, textDelta(0, 'b'))]
  owner.proof(records(dense), [textBlock('ab')])
  const opening = projector.open({ revision: 70, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 5, turn: 1, step: 2, nextIndex: 3, stream: source } })
  assert.equal(opening.revision, 0)
  assert.equal(opening.activeAttempt.nextIndex, 2)
  assert.deepEqual(opening.activeAttempt.stream, records(dense))
  assert.equal(Object.isFrozen(opening.activeAttempt.stream[0].chunk), true)
  const counts = clone(owner.calls)
  const next = projector.accept(chunk(3, timed(9, textDelta(12, 'c')), 71))[0]
  assert.deepEqual([next.index, next.revision, next.time, next.chunk.index], [2, 1, 9, 0])
  assert.equal(owner.calls.expand, counts.expand)
  assert.equal(owner.calls.assemble, counts.assemble)
  assert.equal(owner.calls.snapshot, counts.snapshot)
  owner.proof(records([...expanded.slice(1), timed(9, textDelta(12, 'c'))]), [textBlock('abc')])
  owner.proof(records([...dense, timed(9, textDelta(0, 'c'))]), [textBlock('abc')])
  assert.equal(projector.accept(end(4, 72), visible([textBlock('abc')]))[0].index, 3)
})

test('denied Assistant grants never read payload getters or call native owners while original counters remain checked', () => {
  const { owner, projector } = harness({ exportClasses: ['tool.call', 'reasoning', 'usage'] })
  let reads = 0
  assert.deepEqual(projector.open({ revision: 5, activeAttempt: { attemptId: 'attempt-a', startedAfterSeq: 5, turn: 1, step: 2,
    nextIndex: 2, get stream() { reads++; throw new Error(SECRET) } } }), { revision: 0 })
  assert.deepEqual(projector.accept({ type: 'chunk', attemptId: 'attempt-a', revision: 6, index: 2, time: 5,
    get chunk() { reads++; throw new Error(SECRET) } }), [])
  assert.deepEqual(projector.accept(end(3, 7)), [])
  assert.equal(reads, 0)
  assert.deepEqual(owner.calls, { expand: 0, assemble: 0, snapshot: 0, push: 0, factory: 0 })
  failed(() => projector.accept(start(9)), FAILURE_CODES.HISTORY_GAP)
})

test('withheld assistant/attempt proves presentation abandonment rather than false committed settlement', () => {
  const { owner, projector } = harness({ exportClasses: ['conversation.assistant'] })
  projector.open({ revision: 0 }); projector.accept(start())
  const member = timed(1, textDelta(9, 'answer'))
  projector.accept(chunk(0, member))
  owner.proof(records([member]), [textBlock('answer')], true)
  owner.proof(records([timed(1, textDelta(0, 'answer'))]), [textBlock('answer')], true)
  const terminal = projector.accept(end(1, 3, 'assistant/attempt'), withheld())[0]
  assert.deepEqual(terminal.outcome, { kind: 'abandoned' })
  assert.equal(terminal.index, 1)
  assert.equal(projector.accept({ ...start(4), attemptId: 'attempt-b' })[0].revision, 4)
})

test('Tool calls require their own grant and denied argument getters are untouched', () => {
  const { owner, projector } = harness({ exportClasses: ['conversation.assistant'] })
  projector.open({ revision: 0 }); projector.accept(start())
  let reads = 0
  assert.deepEqual(projector.accept(chunk(0, timed(1, { type: 'tool-call-delta', index: 9,
    get id() { reads++; throw new Error(SECRET) }, get argumentsDelta() { reads++; throw new Error(SECRET) } }))), [])
  owner.proof([], [], true)
  assert.deepEqual(projector.accept(end(1, 3, 'assistant/attempt'), withheld())[0].outcome, { kind: 'abandoned' })
  assert.equal(reads, 0)
})

test('first close ignores all later payloads at that index without inspecting them', () => {
  const { owner, projector } = harness()
  projector.open({ revision: 0 }); projector.accept(start())
  const members = [timed(1, textDelta(5, 'delta')), timed(2, { type: 'block-end', index: 5, block: textBlock('closed') })]
  members.forEach((member, index) => projector.accept(chunk(index, member)))
  let reads = 0
  assert.deepEqual(projector.accept(chunk(2, timed(3, { type: 'text-delta', index: 5, get text() { reads++; throw new Error(SECRET) } }))), [])
  assert.deepEqual(projector.accept(chunk(3, timed(4, { type: 'block-end', index: 5, get block() { reads++; throw new Error(SECRET) } }))), [])
  owner.proof(records(members), [textBlock('closed')], true)
  owner.proof(records([timed(1, textDelta(0, 'delta')), timed(2, { type: 'block-end', index: 0, block: textBlock('closed') })]), [textBlock('closed')], true)
  assert.equal(projector.accept(end(4, 6, 'assistant/attempt'), withheld())[0].index, 2)
  assert.equal(reads, 0)
})

test('an interrupted partial Tool retires safely without reading failure details or fabricating its identity', () => {
  const { owner, projector } = harness()
  projector.open({ revision: 0 }); projector.accept(start())
  const member = timed(1, { type: 'block-start', index: 9, blockType: 'tool-call' })
  projector.accept(chunk(0, member))
  let reads = 0
  assert.deepEqual(projector.accept(chunk(1, timed(2, { type: 'finish', reason: { kind: 'aborted',
    get failure() { reads++; throw new Error(SECRET) } } }))), [])
  owner.proof(records([member]), [], true)
  owner.proof(records([timed(1, { type: 'block-start', index: 0, blockType: 'tool-call' })]), [], true)
  const terminal = projector.accept({ type: 'end', attemptId: 'attempt-a', revision: 4, index: 2, outcome: { kind: 'abandoned' } })[0]
  assert.deepEqual(terminal.outcome, { kind: 'abandoned' })
  assert.equal(terminal.index, 1)
  assert.equal(reads, 0)
})

test('partial Tool identity changes and unknown content fail instead of inventing replacement blocks', () => {
  const { projector } = harness()
  projector.open({ revision: 0 }); projector.accept(start())
  projector.accept(chunk(0, timed(1, { type: 'tool-call-delta', index: 2, id: 'one', name: 'read', argumentsDelta: '{' })))
  failed(() => projector.accept(chunk(1, timed(2, { type: 'tool-call-delta', index: 2, id: 'two', argumentsDelta: '}' }))), FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
  const second = harness().projector
  second.open({ revision: 0 }); second.accept(start())
  failed(() => second.accept(chunk(0, timed(1, { type: 'block-start', index: 0, blockType: 'future-private' }))), FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
})

for (const [label, input] of [
  ['native revision gap', chunk(0, timed(1, textDelta(1, 'x')), 3)],
  ['native frame index gap', chunk(1, timed(1, textDelta(1, 'x')), 2)],
  ['wrong attempt identity', { ...chunk(0, timed(1, textDelta(1, 'x'))), attemptId: 'different' }],
  ['overlapping native start', start(2)],
]) test(`${label} retires the projector and never becomes a dense-looking export`, () => {
  const { projector } = harness()
  projector.open({ revision: 0 }); projector.accept(start())
  failed(() => projector.accept(input), FAILURE_CODES.HISTORY_GAP)
  failed(() => projector.accept(start(1)), FAILURE_CODES.SOURCE_UNAVAILABLE)
})

test('missing or mismatched committed visibility fails instead of leaving a held terminal', () => {
  for (const proof of [undefined, { ...withheld(), seq: 7 }, { ...withheld(), turn: 8 },
    { ...withheld(), record: { type: 'withheld', firstSeq: 7, lastSeq: 9, reason: 'policy' } }]) {
    const { projector } = harness()
    projector.open({ revision: 0 }); projector.accept(start())
    failed(() => projector.accept(end(0, 2, 'assistant/attempt'), proof), proof === undefined ? FAILURE_CODES.INVALID_MESSAGE : FAILURE_CODES.HISTORY_GAP)
  }
})

test('complete actual wrappers enforce exact bytes including multibyte scope data', () => {
  const base = jsonByteLength({ scope: '', baseline: { revision: 0 } })
  const exact = harness({ wrapBaseline: baseline => ({ scope: 'x'.repeat(PROTOCOL_LIMITS.maxFrameBytes - base), baseline }) }).projector
  assert.deepEqual(exact.open({ revision: 0 }), { revision: 0 })
  const over = harness({ wrapBaseline: baseline => ({ scope: 'x'.repeat(PROTOCOL_LIMITS.maxFrameBytes - base + 1), baseline }) }).projector
  failed(() => over.open({ revision: 0 }), FAILURE_CODES.PAGE_TOO_LARGE)
  const multibyte = harness({ wrapFrame: frame => ({ frame, scope: '😀'.repeat(PROTOCOL_LIMITS.maxFrameBytes / 2) }) }).projector
  multibyte.open({ revision: 0 })
  failed(() => multibyte.accept(start()), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('mapping slots and conservatively retained bytes are bounded independently of frame filtering', () => {
  const hidden = harness().projector
  hidden.open({ revision: 0 }); hidden.accept(start())
  for (let index = 0; index < PROTOCOL_LIMITS.maxFollowBufferEvents; index++) {
    assert.deepEqual(hidden.accept(chunk(index, timed(index, { type: 'block-start', index: index * 3, blockType: 'reasoning' }))), [])
  }
  failed(() => hidden.accept(chunk(PROTOCOL_LIMITS.maxFollowBufferEvents,
    timed(1, { type: 'block-start', index: 10000, blockType: 'reasoning' }))), FAILURE_CODES.PAGE_TOO_LARGE)
  const retained = harness().projector
  retained.open({ revision: 0 }); retained.accept(start())
  for (let index = 0; index < 6; index++) retained.accept(chunk(index, timed(index, textDelta(0, 'x'.repeat(20000)))))
  failed(() => retained.accept(chunk(6, timed(6, textDelta(0, 'x'.repeat(20000))))), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('native callback and wrapper diagnostics are replaced and close remains idempotent', () => {
  const native = harness({ nativeCreateCompactor() { throw new Error(SECRET) } }).projector
  native.open({ revision: 0 })
  failed(() => native.accept(start()))
  const wrapped = harness({ wrapBaseline() { throw new Error(SECRET) } }).projector
  failed(() => wrapped.open({ revision: 0 }))
  const { projector } = harness()
  projector.close(); projector.close()
  failed(() => projector.open({ revision: 0 }), FAILURE_CODES.SOURCE_UNAVAILABLE)
})
