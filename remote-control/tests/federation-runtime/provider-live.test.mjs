import test from 'node:test'
import assert from 'node:assert/strict'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import { buildHistoryPage } from '../../lib/federation/history.mjs'
import { FEDERATION_FEATURES } from '../../lib/federation/protocol.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'

const ref = Object.freeze({ machineKey: 'worker', projectId: 'demo', sessionId: 'session' })
const authority = Object.freeze({ generation: 7, grantRevision: 1 })
class RemoteError extends Error { constructor(code, message) { super(message); this.code = code } }
const caps = { history: true }
const signal = () => new AbortController().signal
function fixture(features = [FEDERATION_FEATURES.SESSION_DETAILS, FEDERATION_FEATURES.SESSION_LIVE]) {
  const calls = [], state = { authority: { ...authority }, ready: true, refusal: false, foreign: false, preparations: 0 }
  const runtime = {
    authority: () => state.authority, liveReady: () => state.ready,
    prepareLive: async () => { state.preparations++; return state.ready },
    subscribe: () => () => {}, revision: () => 0,
    async call(_machine, op, args) {
      calls.push(op)
      if (op === 'hello') return { protocol: 2, machine: { label: 'Worker' }, features }
      if (op === 'session.bind.live' && state.refusal) throw new FederationContractError('action-unsupported', 'PRIVATE')
      if (op.startsWith('session.bind')) return { ref: state.foreign ? { ...args.ref, sessionId: 'other' } : args.ref,
        ...state.authority, capabilities: caps, includeAssistantStream: op === 'session.bind.live',
        ...(op === 'session.bind.live' ? { nativeDetails: true, nativeLive: true } : {}) }
      throw new Error('unexpected fixture operation')
    },
    async *followLive(_machine, target, request, captured) {
      assert.deepEqual(target, ref); assert.equal(request.includeAssistantStream, true); assert.deepEqual(captured, authority)
      const grant = { version: 1, grantId: 'live-provider', principal: { kind: 'controller', id: 'controller' }, machineKey: 'worker', revision: 1, issuedAt: 0,
        projects: [{ projectId: 'demo', actions: ['session.list'], exportClasses: ['conversation.assistant'],
          sessions: [{ sessionId: 'session', imported: true, actions: ['session.read', 'session.follow'] }] }] }
      const page = buildHistoryPage({ ...ref, ...authority, principal: grant.principal, grant, now: 1, events: [],
        exportClasses: ['conversation.assistant'], validateNativeEvents() {}, format: 'native-details-v1' })
      yield { type: 'snapshot', page, header: { version: 1, id: ref.sessionId, createdAt: 1, isSeeded: false },
        projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }
      yield { type: 'assistant-stream', ...authority, frame: { type: 'start', attemptId: 'attempt', revision: 1, startedAfterSeq: -1, turn: 0, step: 0 } }
      for (let index = 0; index < 640; index++) yield { type: 'assistant-stream', ...authority,
        frame: { type: 'chunk', attemptId: 'attempt', revision: index + 2, index, time: index,
          chunk: { type: 'text-delta', index: 0, text: 'x' } } }
    },
  }
  return { calls, state, runtime, provider: () => createHostProvider({ runtime, pair: { machineKey: 'worker' }, RemoteError }) }
}

test('one explicit live handshake revalidates640 frames without durable per-frame calls or promoting legacy binds', async () => {
  const f = fixture(), provider = await f.provider(), info = await provider.live.bind(ref, signal())
  assert.equal(info.nativeDetails, true); assert.equal(info.nativeLive, true); assert.equal(info.includeAssistantStream, true)
  let count = 0
  for await (const frame of provider.live.historyFollow(ref, { includeAssistantStream: true }, signal())) {
    assert.equal((await provider.live.bind(ref, signal())).generation, info.generation)
    if (frame.type === 'assistant-stream') assert.equal(frame.generation, info.generation)
    count++
  }
  assert.equal(count, 642)
  assert.deepEqual(f.calls, ['hello', 'session.bind.live']); assert.equal(f.state.preparations, 1)
  assert.equal((await provider.bind(ref, signal())).includeAssistantStream, false)
  const detail = await provider.details.bind(ref, signal())
  assert.equal(detail.nativeDetails, true); assert.equal(detail.nativeLive, undefined); assert.equal(detail.includeAssistantStream, false)
})

test('missing live feature falls back honestly without probing or enabling assistant output', async () => {
  const f = fixture([FEDERATION_FEATURES.SESSION_DETAILS]), provider = await f.provider()
  const info = await provider.live.bind(ref, signal())
  assert.equal(info.nativeDetails, true); assert.equal(info.nativeLive, undefined); assert.equal(info.includeAssistantStream, false)
  assert.equal(f.state.preparations, 0); assert.deepEqual(f.calls, ['hello', 'session.bind.details'])
})

test('an advertised live refusal never downgrades and no private message reaches diagnostics', async () => {
  const f = fixture(), provider = await f.provider(); f.state.refusal = true
  await assert.rejects(provider.live.bind(ref, signal()), error => error.code === 'session-source/action-unsupported' && !error.message.includes('PRIVATE'))
  assert.deepEqual(f.calls, ['hello', 'session.bind.live'])
})

test('a cached live binding cannot relabel frames after known authority changes', async () => {
  const f = fixture(), provider = await f.provider(); await provider.live.bind(ref, signal())
  const reader = provider.live.historyFollow(ref, { includeAssistantStream: true }, signal())[Symbol.asyncIterator]()
  assert.equal((await reader.next()).value.type, 'snapshot')
  f.state.authority = { generation: 8, grantRevision: 2 }
  await assert.rejects(reader.next(), error => error.code === 'session-source/grant-changed')
  assert.equal(f.calls.at(-1), 'hello')
})

test('known metadata withdrawal refuses both cached and newly returned positive binding capabilities', async () => {
  const f = fixture(), provider = await f.provider(); await provider.live.bind(ref, signal())
  f.state.authority = { ...authority, metadataAuthorized: false }
  await assert.rejects(provider.live.bind(ref, signal()), error => error.code === 'session-source/grant-changed')
  assert.equal(f.calls.filter(op => op === 'session.bind.live').length, 2, 'The old receipt was not returned')
})

test('sequential live sessions and an authority rollover cannot permanently exhaust the metadata cache', async () => {
  const f = fixture(), provider = await f.provider()
  for (let index = 0; index < 300; index++) {
    assert.equal((await provider.live.bind({ ...ref, sessionId: `session-${index}` }, signal())).nativeLive, true)
  }
  f.state.authority = { generation: 8, grantRevision: 2 }
  const current = await provider.live.bind({ ...ref, sessionId: 'after-rollover' }, signal())
  assert.equal(current.nativeLive, true)
  const calls = f.calls.length
  await provider.live.bind({ ...ref, sessionId: 'after-rollover' }, signal())
  assert.equal(f.calls.length, calls, 'A fresh current receipt remains reusable without RPC')
})

test('binding responses must preserve the exact session reference, not only the machine', async () => {
  const f = fixture(), provider = await f.provider(); f.state.foreign = true
  await assert.rejects(provider.bind(ref, signal()), error => error.code === 'session-source/source-unavailable')
})
