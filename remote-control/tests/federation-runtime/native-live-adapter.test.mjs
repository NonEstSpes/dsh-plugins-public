/** Focused adapter ownership/lifetime units. The separate compiled-owner Host spec is the actual native SDK proof. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAdapter } from '../../lib/federation/native-adapter.mjs'
import { PROTOCOL_LIMITS } from '../../lib/federation/protocol.mjs'

const opening = { type: 'snapshot', cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }
function fixture() {
  const original = Symbol('original'), calls = [], counters = { next: 0, returns: 0, push: 0, snapshots: 0, assemble: 0 }
  let current, held = false, onExpand = () => {}
  class UnitCompactor {
    push() { counters.push++ }
    snapshot() { counters.snapshots++; return [] }
  }
  const controller = {
    follow() { throw new Error('public follow must not be called') },
    control() { throw new Error('Host-wide control must not be called') },
    sourceFollow(request, budget, signal) {
      const release = Promise.withResolvers(), call = { request, budget, signal, release }
      calls.push(call)
      let reading
      return {
        [Symbol.asyncIterator]() { return this },
        next() { counters.next++; reading = held ? release.promise : Promise.resolve({ done: false, value: opening }); return reading },
        async return() { counters.returns++; await reading; return { done: true, value: undefined } },
      }
    },
  }
  current = controller
  const helper = controller.sourceFollow
  const owner = { ownsSourceFollowHelper: value => value === controller && Object.getOwnPropertyDescriptor(value, 'sourceFollow')?.value === helper,
    ownsSourceMutationHelpers: () => false, ownsSourceCatalogHelper: () => false }
  const native = { cordis: { symbols: { original } }, controllerOwner: owner, sandbox: {}, session: { SessionId: value => value }, llm: {
    AssistantStreamAccumulator: UnitCompactor,
    expandAssistantStream(value) { onExpand(); return value },
    assembleAssistantStream() { counters.assemble++; return { blocks: () => ['native-block'], interruptedBlocks: () => ['native-interrupted'] } },
  } }
  const ctx = { get: name => name === 'sessionController' ? current : undefined }
  return { ctx, native, controller, owner, calls, counters, original, replace(value) { current = value }, hold() { held = true }, expanding(fn) { onExpand = fn } }
}
const create = f => createNativeAdapter({ ctx: f.ctx, native: f.native, settings: { projects: {} } })
const signal = () => new AbortController().signal

for (const missing of ['attestor', 'rejected', 'getter']) test(`live capability is absent for ${missing} without changing legacy assembly`, async () => {
  const f = fixture(), reads = []
  if (missing === 'attestor') delete f.owner.ownsSourceFollowHelper
  if (missing === 'rejected') f.owner.ownsSourceFollowHelper = () => false
  if (missing === 'getter') Object.defineProperty(f.controller, 'sourceFollow', { get() { reads.push('getter'); return () => {} } })
  const backend = await create(f)
  for (const name of ['followNative', 'nativeExpand', 'nativeCreateCompactor', 'nativeLiveAssistantBlocks']) assert.equal(name in backend, false)
  assert.deepEqual(backend.nativeAssistantBlocks([], false), ['native-block'])
  assert.deepEqual(reads, [])
  assert.equal(backend.close(), undefined)
})

test('creation-time verification cannot be enabled later by adding an attestor or force flag', async () => {
  const f = fixture(), verify = f.owner.ownsSourceFollowHelper
  delete f.owner.ownsSourceFollowHelper
  const backend = await create(f)
  f.owner.ownsSourceFollowHelper = verify
  assert.equal(backend.followNative, undefined)
  const replacement = await create(f)
  assert.equal(typeof replacement.followNative, 'function')
  await replacement.close()
})

test('dispatches only the constructor helper with exact native address/page window and protocol upstream limits', async () => {
  const f = fixture(), backend = await create(f)
  f.replace({ [f.original]: f.controller, follow() { throw new Error('facade must not receive the private helper') } })
  const window = { minMessages: 3, minTurns: 2 }, caller = new AbortController()
  const frames = backend.followNative({ sessionId: 'native-target' }, { maxMessages: 17, turnWindow: window, activate: true, assistantStream: false }, caller.signal)
  window.minMessages = 999
  assert.deepEqual(await frames.next(), { done: false, value: opening })
  assert.deepEqual(f.calls[0].request, { address: { kind: 'session', sessionId: 'native-target' }, maxMessages: 17, turnWindow: { minMessages: 3, minTurns: 2 } })
  assert.deepEqual(f.calls[0].budget, { maxItems: PROTOCOL_LIMITS.maxFollowBufferEvents, maxBytes: PROTOCOL_LIMITS.maxFollowBufferBytes })
  assert.equal(f.calls[0].signal.aborted, false)
  await frames.return()
  assert.equal(f.calls[0].signal.aborted, true)
  assert.equal(f.counters.returns, 1)
  await backend.close()
})

test('checks replacement after awaited native next and joins the retired native iterator', async () => {
  const f = fixture(); f.hold()
  const backend = await create(f), frames = backend.followNative({ sessionId: 'native-target' }, {}, signal())
  const rejected = assert.rejects(frames.next(), { code: 'source-unavailable', message: 'native follow owner is unavailable' })
  f.replace({ ...f.controller })
  f.calls[0].release.resolve({ done: false, value: { ...opening, PRIVATE: 'never published' } })
  await rejected
  await frames.return()
  assert.equal(f.counters.returns, 1)
  await backend.close()
})

test('rejects overlapping next without adding native reads or cancelling the admitted read', async () => {
  const f = fixture(); f.hold()
  const backend = await create(f), frames = backend.followNative({ sessionId: 'native-target' }, {}, signal()), first = frames.next()
  await assert.rejects(frames.next(), { code: 'invalid-message' })
  assert.equal(f.counters.next, 1)
  assert.equal(f.calls[0].signal.aborted, false)
  f.calls[0].release.resolve({ done: false, value: opening })
  assert.deepEqual(await first, { done: false, value: opening })
  await frames.return()
  await backend.close()
})

test('close aborts every native reader before awaiting any held read and joins late results without publication', async () => {
  const f = fixture(); f.hold()
  const backend = await create(f)
  const a = backend.followNative({ sessionId: 'a' }, {}, signal()), b = backend.followNative({ sessionId: 'b' }, {}, signal())
  const rejected = Promise.all([assert.rejects(a.next(), { code: 'source-unavailable' }), assert.rejects(b.next(), { code: 'source-unavailable' })])
  let joined = false
  const closing = backend.close().then(() => { joined = true })
  assert.deepEqual(f.calls.map(call => call.signal.aborted), [true, true])
  await Promise.resolve()
  assert.equal(joined, false)
  for (const call of f.calls) call.release.resolve({ done: false, value: opening })
  await Promise.all([rejected, closing])
  assert.equal(joined, true)
  assert.equal(f.counters.returns, 2)
})

test('guards live expansion, live assembly and already-created native compactors while legacy assembly stays unchanged', async () => {
  const f = fixture(), backend = await create(f), compactor = backend.nativeCreateCompactor()
  compactor.push({ time: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } })
  assert.deepEqual(compactor.snapshot(), [])
  assert.deepEqual(backend.nativeLiveAssistantBlocks([], true), ['native-interrupted'])
  f.expanding(() => { f.replace({ ...f.controller }) })
  assert.throws(() => backend.nativeExpand([]), { code: 'source-unavailable' })
  for (const callback of [() => compactor.push({}), () => compactor.snapshot(), () => backend.nativeCreateCompactor(), () => backend.nativeLiveAssistantBlocks([], false)]) assert.throws(callback, { code: 'source-unavailable' })
  assert.equal(f.counters.push, 1); assert.equal(f.counters.snapshots, 1); assert.equal(f.counters.assemble, 1)
  assert.deepEqual(backend.nativeAssistantBlocks([], false), ['native-block'])
  await backend.close()
})
