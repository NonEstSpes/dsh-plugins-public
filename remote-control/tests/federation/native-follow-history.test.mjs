/** Mapper units for cut/coverage/lifetime limits; actual SDK compaction and settlement are separate Host evidence. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { projectNativeFollow } from '../../lib/federation/native-follow-history.mjs'
import { decodeExportCursor, jsonByteLength, PROTOCOL_LIMITS } from '../../lib/federation/protocol.mjs'

const ref = { machineKey: 'worker', projectId: 'demo', sessionId: 'session-1' }
const principal = { kind: 'controller', id: 'controller_fixture' }
const classes = ['conversation.user', 'tool.call', 'tool.result', 'usage']
const header = { version: 4, id: ref.sessionId, createdAt: 0, isSeeded: false, cwd: 'PRIVATE_PATH' }
const human = (seq, text = `hello-${seq}`) => ({ type: 'user/message', seq, time: seq + 1, surfaceOp: 'append',
  data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const metrics = (asOfSeq, outputTokens = 1) => ({ asOfSeq, values: { tokenUsage: { uncachedInputTokens: 10, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 } } })
const snapshot = (events, cut = events.length - 1, start = 0, projections = metrics(cut)) => ({ type: 'snapshot', header, cursor: cut,
  records: events.slice(start, cut + 1).map(event => ({ type: 'event', event })), hasMore: start > 0, projections, assistantStream: { revision: 0 } })
function fixture(events, entries, options = {}) {
  const exportClasses = options.classes ?? classes
  const grant = { version: 1, grantId: 'mapper_grant', principal, machineKey: ref.machineKey, revision: 1, issuedAt: 0,
    projects: [{ projectId: ref.projectId, actions: ['session.list'], exportClasses,
      sessions: [{ sessionId: ref.sessionId, imported: true, actions: ['session.read', 'session.follow'] }] }] }
  const state = { reads: 0, next: 0, returns: 0, current: true, generation: 1, held: undefined }
  const abort = new AbortController(), release = Promise.withResolvers()
  const native = {
    [Symbol.asyncIterator]() { return this },
    next() { state.next++; return entries.length ? Promise.resolve({ done: false, value: entries.shift() }) : release.promise },
    async return() { state.returns++; if (state.held) await state.held; return { done: true, value: undefined } },
  }
  const backend = {
    async readDetails() {
      state.reads++
      if (options.read) await options.read()
      return { header, events, cursor: events.length - 1, projections: options.detailsMetrics ?? metrics(events.length - 1, 999) }
    },
    validateNativeEvents() {},
    nativeExpand() { throw new Error('denied Assistant expansion must not run') },
    nativeCreateCompactor() { throw new Error('denied Assistant compaction must not run') },
    nativeLiveAssistantBlocks() { throw new Error('denied Assistant assembly must not run') },
  }
  const wrapFrame = options.wrap ?? (frame => ({ version: 1, type: 'data', id: 'mapper-stream', ref,
    authority: { generation: 1, grantRevision: 1 }, index: 0, frame }))
  const context = () => ({ generation: state.generation, grantRevision: 1, principal, grant, now: 1, exportClasses })
  const iterator = projectNativeFollow({ frames: native, ref, backend, historyContext: context,
    check() { if (!state.current) throw new Error('PRIVATE_AUTHORITY_FAILURE') }, signal: abort.signal, wrapFrame })[Symbol.asyncIterator]()
  return { iterator, state, native, release, abort, backend, wrapFrame }
}

test('uses native opening cut/window and older Tool context while omitting future details metrics', async () => {
  const call = { type: 'tool/call', seq: 0, time: 1, data: { turn: 1, step: 1, callId: 'call-a', name: 'read', arguments: '{"path":"file.txt"}' } }
  const result = { type: 'tool/result', seq: 1, time: 2, surfaceOp: 'append', data: { turn: 1, step: 1,
    message: { id: 'tool-result', role: 'tool', source: { kind: 'tool', callId: 'call-a' }, toolCallId: 'call-a', content: [{ type: 'text', text: 'old Tool call' }] },
    meta: { path: 'file.txt', offset: 1, lines: [{ number: 1, text: 'old Tool call' }], totalLines: 1 } } }
  const events = [call, result, human(2)], f = fixture(events, [snapshot(events, 1, 1, metrics(1, 12)), { type: 'event', event: events[2] }])
  try {
    const first = (await f.iterator.next()).value
    assert.equal(first.page.throughSeq, 1); assert.equal(first.page.coveredFromSeq, 1); assert.equal(first.page.hasMore, true)
    assert.deepEqual(first.page.records[0].event.data.meta, result.data.meta)
    assert.equal(first.projections.asOfSeq, 1); assert.equal(first.projections.values.tokenUsage.outputTokens, 12)
    assert.equal(JSON.stringify(first).includes('PRIVATE_PATH'), false)
    assert.deepEqual(first.assistantStream, { revision: 0 })
    assert.equal(decodeExportCursor(first.page.exportCursor).format, 'native-details-v1')
    const next = (await f.iterator.next()).value
    assert.equal(next.type, 'records'); assert.equal(next.projections.asOfSeq, 2)
    assert.equal(next.projections.values.tokenUsage.outputTokens, 999)
    assert.equal(f.state.reads, 2)
  } finally { await f.iterator.return() }
})

test('reads details only for opening and durable events, not denied private live chunks', async () => {
  const events = [human(0), human(1)], frames = [snapshot(events, 0),
    { type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: 0, turn: 1, step: 1 } },
    { type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt', revision: 2, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, get text() { throw new Error('PRIVATE_CHUNK') } } } },
    { type: 'assistant-stream', frame: { type: 'end', attemptId: 'attempt', revision: 3, index: 1, outcome: { kind: 'abandoned' } } },
    { type: 'event', event: events[1] }]
  const f = fixture(events, frames)
  try {
    await f.iterator.next()
    const durable = (await f.iterator.next()).value
    assert.equal(durable.type, 'records'); assert.equal(durable.records[0].event.seq, 1)
    assert.equal(f.state.reads, 2)
  } finally { await f.iterator.return() }
})

test('future details metrics are absent until the exact delivered durable coverage reaches their cut', async () => {
  const events = [human(0), human(1), human(2)], f = fixture(events, [snapshot(events, 0), { type: 'event', event: events[1] }, { type: 'event', event: events[2] }])
  try {
    await f.iterator.next()
    const earlier = (await f.iterator.next()).value
    assert.equal(Object.hasOwn(earlier, 'projections'), false)
    assert.equal(decodeExportCursor(earlier.exportCursor).throughSeq, 1)
    const exact = (await f.iterator.next()).value
    assert.equal(exact.projections.asOfSeq, 2)
    assert.equal(exact.projections.values.tokenUsage.outputTokens, 999)
  } finally { await f.iterator.return() }
})

test('shrinks only durable opening coverage against the full multibyte transport envelope without truncation', async () => {
  const text = '界'.repeat(1000), events = Array.from({ length: 10 }, (_, seq) => human(seq, text))
  const wrap = frame => ({ version: 1, type: 'data', pad: 'x'.repeat(5000), index: 0, frame })
  const f = fixture(events, [snapshot(events)], { wrap })
  try {
    const frame = (await f.iterator.next()).value
    assert.ok(jsonByteLength(wrap(frame)) <= PROTOCOL_LIMITS.maxFrameBytes)
    assert.equal(frame.page.throughSeq, 9); assert.equal(frame.page.coveredThroughSeq, 9)
    assert.ok(frame.page.coveredFromSeq > 0); assert.equal(frame.page.hasMore, true)
    for (const record of frame.page.records) assert.equal(record.event.data.content[0].text, text)
    assert.deepEqual(frame.assistantStream, { revision: 0 })
  } finally { await f.iterator.return() }
})

for (const mismatch of ['window', 'sequence', 'header', 'details-cut']) test(`rejects malformed native ${mismatch} without private diagnostic output`, async () => {
  const events = [human(0), human(1)], first = snapshot(events, 0)
  const entries = [first]
  if (mismatch === 'window') first.records[0] = { type: 'event', event: human(0, 'wrong native payload') }
  if (mismatch === 'sequence') entries.push({ type: 'event', event: events[0] })
  if (mismatch === 'header') first.header = { ...header, id: 'other-session' }
  const f = fixture(events, entries, { detailsMetrics: mismatch === 'details-cut' ? metrics(0) : metrics(1) })
  try {
    if (mismatch === 'sequence') await f.iterator.next()
    await assert.rejects(f.iterator.next(), { code: 'history-gap', message: 'native follow history projection failed' })
  } finally { await f.iterator.return() }
  assert.equal(f.state.returns, 1)
})

test('scope change while readDetails is held retires native work before a late opening can publish', async () => {
  const gate = Promise.withResolvers(), entered = Promise.withResolvers(), events = [human(0)]
  const f = fixture(events, [snapshot(events)], { read() { entered.resolve(); return gate.promise } })
  const rejected = assert.rejects(f.iterator.next(), { code: 'source-unavailable', message: 'native follow history projection failed' })
  try { await entered.promise; f.state.current = false }
  finally { gate.resolve(); await rejected; await f.iterator.return() }
  assert.equal(f.state.returns, 1)
})

test('one outstanding next and return join a held native read without publishing its late event', async () => {
  const events = [human(0)], f = fixture(events, [snapshot(events)])
  await f.iterator.next()
  f.state.held = f.release.promise
  const rejected = assert.rejects(f.iterator.next(), { code: 'source-unavailable' })
  await assert.rejects(f.iterator.next(), { code: 'invalid-message' })
  let done = false
  const closing = f.iterator.return().then(() => { done = true })
  assert.equal(f.state.returns, 1); assert.equal(done, false)
  f.release.resolve({ done: false, value: { type: 'event', event: human(1) } })
  await Promise.all([rejected, closing]); assert.equal(done, true)
})

test('a changed numeric authority cannot reuse the pinned physical follow', async () => {
  const events = [human(0)], f = fixture(events, [snapshot(events)])
  await f.iterator.next()
  f.state.generation = 2
  await assert.rejects(f.iterator.next(), { code: 'cursor-stale' })
  await f.iterator.return()
})
