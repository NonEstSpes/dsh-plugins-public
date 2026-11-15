import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import { FEDERATION_FEATURES, PROTOCOL_LIMITS, jsonByteLength } from '../../lib/federation/protocol.mjs'
import { parseProtocolMessage as parseLegacyMessage } from '../../plugin-bridge/bundle-v3/lib/federation/protocol.mjs'

class TestRemoteError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details } }
const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']
function catalog(count = 3) {
  return { default: { provider: 'worker', model: 'm-0', reasoningEffort: 'moderate' }, routableProviders: ['worker'], failures: [],
    groups: [{ id: 'worker', name: 'Worker', models: Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, name: `Model ${i} ${'模型Ж'.repeat(24)}`,
      reasoning: { efforts: [{ id: 'moderate', name: 'Moderate' }, { id: 'max', name: 'Maximum' }], defaultEffort: 'moderate' } })) }] }
}
async function fixture(t, { count = 3, mutable = false, timeout = 1000, longIds = false, revision = 1, modelList = true, exportClasses = classes } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-fed-stage2-'))), resources = []
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close()
    const target = await realpath(root)
    assert.equal(path.dirname(target), await realpath(os.tmpdir()))
    assert.ok(path.basename(target).startsWith('dsh-fed-stage2-'))
    await rm(target, { recursive: true, force: true })
  })
  const ref = { machineKey: longIds ? 'w'.repeat(80) : 'worker-fixture', projectId: longIds ? 'p'.repeat(100) : 'demo', sessionId: longIds ? 's'.repeat(128) : 'session-main' }
  const principal = { kind: 'controller', id: 'controller-endpoint' }
  const grant = { version: 1, grantId: 'grant_fixture', principal, machineKey: ref.machineKey, revision, issuedAt: 0,
    projects: [{ projectId: ref.projectId, actions: ['project.list', 'session.list', ...(modelList ? ['model.list'] : [])], exportClasses,
      sessions: [{ sessionId: ref.sessionId, imported: true, actions: ['session.status', 'session.read', 'session.follow', 'model.select'], exportClasses }] }] }
  const key = randomBytes(32).toString('base64url')
  const common = { machineKey: ref.machineKey, protocol: 2, pairingGeneration: 1, keyFingerprint: 'a'.repeat(64), sharedKey: key, requestTimeoutMs: timeout }
  const workerPair = { ...common, role: 'worker', id: 'worker-endpoint', peerId: principal.id, stateDir: path.join(root, 'worker-state'), grant }
  const controllerPair = { ...common, role: 'controller', id: principal.id, peerId: workerPair.id, stateDir: path.join(root, 'controller-state') }
  const receivers = new Map(), packets = [], observed = Promise.withResolvers()
  const transport = { drop: () => false, transform: value => value }
  const endpointFactory = async (pair, handlers) => {
    let closed = false
    receivers.set(pair.id, handlers)
    return {
      start() {}, async close() { closed = true; receivers.delete(pair.id) },
      async send(kind, body) {
        if (closed) throw new Error('test endpoint closed')
        const original = { from: pair.id, to: pair.peerId, kind, body: structuredClone(body) }
        packets.push(original); observed.resolve(original)
        if (!transport.drop(original)) {
          const message = transport.transform(structuredClone(original))
          await receivers.get(pair.peerId)?.onMessage(message)
        }
        return 'delivered'
      },
    }
  }
  const state = { native: catalog(count), modelReads: 0, selections: 0 }, effects = Promise.withResolvers()
  const backend = {
    ...(mutable ? { mutationReadiness: { durableJournal: 'verified', firstRouteCapture: 'verified' } } : {}), // Test-only, not physical native attestation.
    async modelCatalog() { state.modelReads++; return structuredClone(state.native) },
    async read() { return { header: { id: ref.sessionId, createdAt: 1 }, events: [], running: false } },
    async modelState() { return { frontierSeq: -1, selection: state.native.default } },
    async modelSelect(_ref, request, dispatch) { await dispatch(); state.selections++; effects.resolve(); return { frontierSeq: 0, selection: request.selection,
      ...(state.padding === undefined ? {} : { padding: state.padding }) } },
    validateNativeEvents() {}, nativeAssistantBlocks: () => [], close() {},
  }
  const worker = await openFederationRuntime({ role: 'worker', label: 'Worker', projects: { [ref.projectId]: { root: path.join(root, 'project'), workspaceId: 'native-workspace' } }, pairs: [workerPair] }, { backend, endpointFactory })
  resources.push(worker); worker.start()
  const controller = await openFederationRuntime({ role: 'controller', projects: {}, pairs: [controllerPair] }, { endpointFactory })
  resources.push(controller); controller.start()
  const provider = await createHostProvider({ runtime: controller, pair: controllerPair, RemoteError: TestRemoteError })
  return { ref, grant, worker, controller, provider, state, packets, transport, observed, effects, backend }
}
const signal = () => new AbortController().signal
const authority = f => {
  const snapshot = f.worker.peers.get(f.ref.machineKey).journal.snapshot()
  return { generation: snapshot.generation, grantRevision: snapshot.grant.revision }
}

const nativeStats = turns => ({ turns, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
function detailsBackend(f, events = [], values = { sessionStats: nativeStats(0) }) {
  f.state.events = events; f.state.values = values
  const snapshot = () => ({ header: { version: 1, id: f.ref.sessionId, createdAt: 1, isSeeded: false }, events: structuredClone(f.state.events), running: false })
  f.backend.read = async () => snapshot()
  f.backend.readDetails = async () => ({ ...snapshot(), cursor: f.state.events.length - 1,
    projections: { asOfSeq: f.state.events.length - 1, values: structuredClone(f.state.values) } })
}
const toolCall = (seq, args = '{"path":"worker.txt"}') => ({ type: 'tool/call', seq, time: seq + 1, data: { turn: 1, step: 1, callId: 'native-call', name: 'read', arguments: args } })
const richClasses = [...classes, 'tool.call', 'tool.result', 'statistics']

test('native details advertise read support without promoting a legacy browser binding', async t => {
  const f = await fixture(t, { exportClasses: richClasses })
  detailsBackend(f, [toolCall(0)])
  const hello = await f.controller.call(f.ref.machineKey, 'hello', {}, signal())
  assert.equal(hello.features.includes(FEDERATION_FEATURES.SESSION_DETAILS), true)
  const binding = await f.provider.bind(f.ref, signal())
  assert.equal(binding.includeAssistantStream, false)
  const oldPage = await f.provider.historyPage(f.ref, { maxMessages: 50 }, signal())
  assert.deepEqual(oldPage.records, [{ type: 'withheld', firstSeq: 0, lastSeq: 0, reason: 'policy' }])
  assert.equal(f.packets.some(packet => packet.body.type === 'request' && packet.body.op.endsWith('.details')), false)
})

test('detail and model inventory features track independent native read providers', async t => {
  const f = await fixture(t)
  assert.deepEqual((await f.controller.call(f.ref.machineKey, 'hello', {}, signal())).features, [FEDERATION_FEATURES.MODEL_CATALOG_PAGES])
  detailsBackend(f)
  delete f.backend.modelCatalog
  assert.deepEqual((await f.controller.call(f.ref.machineKey, 'hello', {}, signal())).features, [FEDERATION_FEATURES.SESSION_DETAILS])
  assert.equal(f.provider.mutationReadiness, undefined)
  delete f.backend.readDetails
  assert.deepEqual((await f.controller.call(f.ref.machineKey, 'hello', {}, signal())).features, [])
})

test('private detailed history keeps explicit tool grants, coherent metrics and format-bound cursors', async t => {
  const f = await fixture(t, { exportClasses: richClasses })
  detailsBackend(f, [toolCall(0)], { sessionStats: nativeStats(2), tokenUsage: { PRIVATE_UNGRANTED: true }, arbitraryCheckpoint: { PRIVATE: 'never export' } })
  const args = { ref: f.ref, expectedAuthority: authority(f) }
  const page = await f.controller.call(f.ref.machineKey, 'session.read.details', { ...args, request: { maxMessages: 50 } }, signal())
  assert.equal(page.records[0].event.data.arguments, '{"path":"worker.txt"}')
  assert.ok(page.exportCursor.startsWith('fec2.'))
  const opened = await f.controller.call(f.ref.machineKey, 'session.follow.details', args, signal())
  assert.deepEqual(opened.projections, { asOfSeq: 0, values: { sessionStats: nativeStats(2) } })
  assert.equal(JSON.stringify(opened).includes('PRIVATE'), false)
  const legacy = await f.controller.call(f.ref.machineKey, 'session.follow', args, signal())
  assert.ok(legacy.page.exportCursor.startsWith('fec1.'))
  assert.deepEqual(legacy.projections, { asOfSeq: 0, values: {} })
  for (const [op, after] of [['session.follow', page.exportCursor], ['session.follow.details', legacy.page.exportCursor]]) {
    await assert.rejects(f.controller.call(f.ref.machineKey, op, { ...args, request: { after } }, signal()), { code: 'cursor-stale' })
  }
  for (const packet of f.packets) assert.ok(jsonByteLength(packet.body) <= PROTOCOL_LIMITS.maxFrameBytes)
})

test('detailed reads neither infer aggregate grants nor fake unsupported native metrics as zero', async t => {
  const f = await fixture(t, { exportClasses: [...classes, 'tool.call'] })
  detailsBackend(f, [toolCall(0)], { sessionStats: { PRIVATE_INVALID: 'not granted' } })
  const opened = await f.controller.call(f.ref.machineKey, 'session.follow.details', { ref: f.ref }, signal())
  assert.deepEqual(opened.projections, { asOfSeq: 0, values: {} })
  delete f.backend.readDetails
  await assert.rejects(f.controller.call(f.ref.machineKey, 'session.read.details', { ref: f.ref }, signal()), { code: 'action-unsupported' })
})

test('metrics remain absent while a capped native follow batch is behind the observed cut', async t => {
  const f = await fixture(t, { exportClasses: richClasses })
  detailsBackend(f)
  const initial = await f.controller.call(f.ref.machineKey, 'session.follow.details', { ref: f.ref }, signal())
  f.state.events = Array.from({ length: PROTOCOL_LIMITS.maxFollowBufferEvents + 2 }, (_, seq) => ({ type: 'future/private', seq, time: seq, data: { PRIVATE: true } }))
  f.state.values.sessionStats = nativeStats(37)
  const first = await f.controller.call(f.ref.machineKey, 'session.follow.details', { ref: f.ref, request: { after: initial.page.exportCursor } }, signal())
  assert.equal(first.type, 'records')
  assert.equal(first.projections, undefined)
  assert.equal(first.records[0].lastSeq, PROTOCOL_LIMITS.maxFollowBufferEvents - 1)
  const final = await f.controller.call(f.ref.machineKey, 'session.follow.details', { ref: f.ref, request: { after: first.exportCursor } }, signal())
  assert.deepEqual(final.projections, { asOfSeq: f.state.events.length - 1, values: { sessionStats: nativeStats(37) } })
  assert.equal(JSON.stringify(final).includes('PRIVATE'), false)
})

test('detailed views reject skewed native cuts and oversized native records without truncation', async t => {
  const f = await fixture(t, { exportClasses: richClasses })
  detailsBackend(f, [toolCall(0, '界'.repeat(12000))])
  await assert.rejects(f.controller.call(f.ref.machineKey, 'session.read.details', { ref: f.ref }, signal()), { code: 'page-too-large' })
  detailsBackend(f, [toolCall(0)])
  const read = f.backend.readDetails
  f.backend.readDetails = async (...args) => ({ ...await read(...args), cursor: 99 })
  await assert.rejects(f.controller.call(f.ref.machineKey, 'session.follow.details', { ref: f.ref }, signal()), { code: 'invalid-message' })
})

test('new Worker hello is accepted by the frozen legacy parser and never grants mutation readiness from features', async t => {
  const f = await fixture(t)
  detailsBackend(f)
  const hello = await f.controller.call(f.ref.machineKey, 'hello', {}, signal())
  assert.deepEqual(hello.features, [FEDERATION_FEATURES.MODEL_CATALOG_PAGES, FEDERATION_FEATURES.SESSION_DETAILS])
  assert.equal(f.provider.mutationReadiness, undefined)
  const binding = await f.provider.bind(f.ref, signal())
  assert.equal(binding.capabilities.modelSelect, false)
  const legacy = await f.controller.call(f.ref.machineKey, 'model.catalog', { ref: f.ref }, signal())
  assert.deepEqual(legacy, f.state.native)
  for (const packet of f.packets.filter(packet => packet.body.type === 'response' && ['hello', 'model.catalog'].includes(packet.body.op))) {
    assert.deepEqual(parseLegacyMessage(packet.body), packet.body)
  }
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', { ref: f.ref,
    request: { expected: { generation: authority(f).generation, frontierSeq: -1, selection: f.state.native.default }, selection: f.state.native.default } }, signal()), { code: 'action-unsupported' })
  assert.equal(f.state.selections, 0)
})

test('complete response wrappers stay within 32 KiB for large multibyte catalogs and maximum identity lengths', async t => {
  const f = await fixture(t, { count: 300, longIds: true, revision: Number.MAX_SAFE_INTEGER })
  assert.ok(jsonByteLength(f.state.native) > PROTOCOL_LIMITS.maxFrameBytes)
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.catalog', { ref: f.ref }, signal()), { code: 'page-too-large' })
  assert.deepEqual(await f.provider.modelCatalog(f.ref, signal()), f.state.native)
  const responses = f.packets.filter(packet => packet.body.op === 'model.catalog.page' && packet.body.type === 'response')
  assert.ok(responses.length > 1)
  assert.ok(responses.some(packet => jsonByteLength(packet.body) > 32000))
  for (const packet of f.packets) assert.ok(jsonByteLength(packet.body) <= PROTOCOL_LIMITS.maxFrameBytes)
  const first = await f.controller.call(f.ref.machineKey, 'model.catalog.page', { ref: f.ref, expectedAuthority: authority(f) }, signal(), 'R'.repeat(80))
  assert.ok(first.nextCursor)
  assert.ok(jsonByteLength(f.packets.at(-1).body) <= PROTOCOL_LIMITS.maxFrameBytes)
})

test('a legacy Worker manifest selects only the bounded legacy route and never a new page operation', async t => {
  const f = await fixture(t)
  f.transport.transform = packet => {
    if (packet.body.op === 'hello' && packet.body.type === 'response' && packet.body.ok) delete packet.body.result.value.features
    return packet
  }
  assert.deepEqual(await f.provider.modelCatalog(f.ref, signal()), f.state.native)
  assert.equal(f.packets.some(packet => packet.body.type === 'request' && packet.body.op === 'model.catalog.page'), false)
})

test('page and legacy reads enforce model-list grant before invoking the native model registry', async t => {
  const f = await fixture(t, { modelList: false })
  for (const op of ['model.catalog.page', 'model.catalog']) {
    await assert.rejects(f.controller.call(f.ref.machineKey, op, { ref: f.ref }, signal()), { code: 'not-granted' })
  }
  assert.equal(f.state.modelReads, 0)
  await assert.rejects(f.provider.modelCatalog(f.ref, signal()), error => error.code === 'session-source/source-unavailable' && error.message.includes('not-granted'))
  assert.equal(f.state.modelReads, 0)
})

test('page reads reject another machine or unadmitted native Session before model inventory', async t => {
  const f = await fixture(t)
  for (const ref of [{ ...f.ref, machineKey: 'another-worker' }, { ...f.ref, sessionId: 'unadmitted-session' }]) {
    await assert.rejects(f.controller.call(f.ref.machineKey, 'model.catalog.page', { ref }, signal()), { code: 'source-unavailable' })
  }
  assert.equal(f.state.modelReads, 0)
})

test('continuations reject changed models and stale grant authority instead of silently splicing catalogs', async t => {
  const f = await fixture(t, { count: 300 }), expected = authority(f)
  const first = await f.controller.call(f.ref.machineKey, 'model.catalog.page', { ref: f.ref, expectedAuthority: expected }, signal())
  assert.ok(first.nextCursor)
  f.state.native.groups[0].models[0].name = 'Changed after first page'
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.catalog.page', { ref: f.ref, expectedAuthority: expected, cursor: first.nextCursor }, signal()), { code: 'catalog-stale' })
  const nextGrant = structuredClone(f.grant); nextGrant.revision++
  await f.worker.peers.get(f.ref.machineKey).journal.installGrant(nextGrant)
  const reads = f.state.modelReads
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.catalog.page', { ref: f.ref, expectedAuthority: expected, cursor: first.nextCursor }, signal()), { code: 'grant-changed' })
  assert.equal(f.state.modelReads, reads)
})

test('model-page arguments stay exact and a too-large indivisible record returns a typed failure', async t => {
  const f = await fixture(t)
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.catalog.page', { ref: f.ref, localPath: 'C:\\PRIVATE' }, signal()), { code: 'invalid-message' })
  f.state.native.groups[0].models[0].name = '界'.repeat(PROTOCOL_LIMITS.maxFrameBytes)
  await assert.rejects(f.provider.modelCatalog(f.ref, signal()), error => error.code === 'session-source/source-unavailable'
    && error.message.startsWith('model.catalog.page: page-too-large.') && !error.message.includes('PRIVATE'))
})

test('read deadlines and read cancellation are distinct, clear pending requests, and do not become unknown mutations', async t => {
  const f = await fixture(t, { timeout: 30 })
  f.transport.drop = () => true
  await assert.rejects(f.controller.call(f.ref.machineKey, 'hello', {}, signal()), { code: 'request-timeout' })
  assert.equal(f.controller.peers.get(f.ref.machineKey).pending.size, 0)
  const caller = new AbortController(), reading = f.controller.call(f.ref.machineKey, 'hello', {}, caller.signal)
  const rejected = assert.rejects(reading, error => error.name === 'AbortError')
  caller.abort(); await rejected
  assert.equal(f.controller.peers.get(f.ref.machineKey).pending.size, 0)
})

for (const [name, corrupt, code] of [
  ['extra response fields', body => { body.unexpected = true }, 'invalid-message'],
  ['wrong protocol', body => { body.protocol = 999 }, 'invalid-message'],
  ['different correlated operation', body => { body.op = 'model.state' }, 'invalid-message'],
  ['invalid authority', body => { body.result.authority.generation = -1 }, 'invalid-message'],
  ['oversized authenticated frame', body => { body.result.value.extra = '界'.repeat(PROTOCOL_LIMITS.maxFrameBytes) }, 'page-too-large'],
]) {
  test(`correlated ${name} rejects immediately instead of being mislabeled a deadline`, async t => {
    const f = await fixture(t, { mutable: true })
    f.transport.transform = packet => {
      if (packet.body.type === 'response' && packet.body.op === 'hello') corrupt(packet.body)
      return packet
    }
    await assert.rejects(f.controller.call(f.ref.machineKey, 'hello', {}, signal()), { code })
    assert.equal(f.controller.peers.get(f.ref.machineKey).pending.size, 0)
    assert.equal(f.controller.authority(f.ref.machineKey), null)
    assert.equal(f.controller.mutationsReady(f.ref.machineKey), false)
  })
}

test('malformed project metadata commits neither partial create admission nor authority readiness', async t => {
  const f = await fixture(t, { mutable: true })
  f.transport.transform = packet => {
    if (packet.body.type === 'response' && packet.body.op === 'catalog' && packet.body.ok) {
      const bad = structuredClone(packet.body.result.value.projects[0]); bad.ref.machineKey = 'other-worker'
      packet.body.result.value.projects.push(bad)
    }
    return packet
  }
  await assert.rejects(f.controller.call(f.ref.machineKey, 'catalog', {}, signal()), { code: 'pairing-mismatch' })
  assert.equal(f.controller.peers.get(f.ref.machineKey).projectAdmissions.size, 0)
  assert.equal(f.controller.authority(f.ref.machineKey), null)
  assert.equal(f.controller.mutationsReady(f.ref.machineKey), false)
})

test('corrupt mutation acknowledgements remain unknown rather than a definite protocol refusal', async t => {
  const f = await fixture(t, { mutable: true }), id = 'corrupt_ack_model_operation'
  const args = { ref: f.ref, expectedAuthority: authority(f), request: {
    expected: { generation: authority(f).generation, frontierSeq: -1, selection: f.state.native.default },
    selection: { provider: 'worker', model: 'm-1' },
  } }
  f.transport.transform = packet => {
    if (packet.body.type === 'response' && packet.body.op === 'model.select') packet.body.invalid = true
    return packet
  }
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', args, signal(), id), { code: 'outcome-unknown' })
  assert.equal(f.state.selections, 1)
  f.transport.transform = value => value
  const ack = await f.controller.call(f.ref.machineKey, 'model.select', args, signal(), id)
  assert.deepEqual(ack.selection, args.request.selection)
  assert.equal(f.state.selections, 1)
})

test('local validation fails before allocating pending work or marking a mutation dispatched', async t => {
  const f = await fixture(t, { mutable: true })
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', { ref: f.ref, request: { invalid: Number.NaN } }, signal(), 'invalid_local_operation'), { code: 'invalid-message' })
  await assert.rejects(f.controller.call(f.ref.machineKey, 'not-an-operation', {}, signal()), { code: 'action-unsupported' })
  assert.equal(f.controller.peers.get(f.ref.machineKey).pending.size, 0)
  assert.deepEqual(f.controller.peers.get(f.ref.machineKey).journal.snapshot().operations, {})
  assert.equal(f.packets.length, 0)
})

test('the durable ledger and wire retain the same immutable body across asynchronous dispatch', async t => {
  const f = await fixture(t, { mutable: true })
  const args = { ref: { ...f.ref }, expectedAuthority: authority(f), request: {
    expected: { generation: authority(f).generation, frontierSeq: -1, selection: { ...f.state.native.default } },
    selection: { provider: 'worker', model: 'm-1', reasoningEffort: 'max' },
  } }
  const original = structuredClone(args)
  const selecting = f.controller.call(f.ref.machineKey, 'model.select', args, signal(), 'immutable_model_operation')
  args.ref.sessionId = 'different-session'; args.request.selection.model = 'different-model'
  const result = await selecting
  assert.deepEqual(result.selection, original.request.selection)
  const request = f.packets.find(packet => packet.body.type === 'request' && packet.body.op === 'model.select')
  assert.deepEqual(request.body.args, original)
  assert.equal(f.state.selections, 1)
})

for (const budget of ['result', 'envelope']) {
  test(`post-effect ${budget} size failure remains unknown and cannot permit a replacement operation`, async t => {
    const f = await fixture(t, { mutable: true }), id = 'A'.repeat(80)
    const args = { ref: f.ref, expectedAuthority: authority(f), request: {
      expected: { generation: authority(f).generation, frontierSeq: -1, selection: f.state.native.default },
      selection: { provider: 'worker', model: 'm-1' },
    } }
    const response = { protocol: 2, type: 'response', requestId: id, op: 'model.select', ok: true,
      result: { authority: { ...authority(f), mutationsVerified: true }, value: { generation: authority(f).generation, frontierSeq: 0, selection: args.request.selection, padding: '' } } }
    f.state.padding = budget === 'result' ? '界'.repeat(PROTOCOL_LIMITS.maxFrameBytes)
      : 'x'.repeat(PROTOCOL_LIMITS.maxFrameBytes - jsonByteLength(response) + 1)
    if (budget === 'envelope') {
      response.result.value.padding = f.state.padding
      assert.ok(jsonByteLength(response.result) <= PROTOCOL_LIMITS.maxPayloadBytes)
      assert.equal(jsonByteLength(response), PROTOCOL_LIMITS.maxFrameBytes + 1)
    }
    await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', args, signal(), id), { code: 'outcome-unknown' })
    assert.equal(f.state.selections, 1)
    const entry = Object.values(f.controller.peers.get(f.ref.machineKey).journal.snapshot().operations).find(row => row.requestId === id)
    assert.equal(entry.state, 'unknown')
    await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', args, signal(), 'replacement_model_operation'), { code: 'outcome-unknown' })
    await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', args, signal(), id), { code: 'outcome-unknown' })
    assert.equal(f.state.selections, 1)
    const requests = f.packets.filter(packet => packet.body.type === 'request' && packet.body.op === 'model.select')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].body.requestId, requests[1].body.requestId)
    assert.deepEqual(requests[0].body.args, requests[1].body.args)
  })
}

test('a lost mutation acknowledgement remains unknown and reconciles the identical operation without a second native effect', async t => {
  const f = await fixture(t, { mutable: true, timeout: 1000 }), id = 'model_operation_retained'
  const args = { ref: f.ref, expectedAuthority: authority(f), request: {
    expected: { generation: authority(f).generation, frontierSeq: -1, selection: f.state.native.default },
    selection: { provider: 'worker', model: 'm-1', reasoningEffort: 'max' },
  } }
  f.transport.drop = packet => packet.body.type === 'response' && packet.body.op === 'model.select'
  await assert.rejects(f.controller.call(f.ref.machineKey, 'model.select', args, signal(), id), { code: 'outcome-unknown' })
  assert.equal(f.state.selections, 1)
  f.transport.drop = () => false
  const ack = await f.controller.call(f.ref.machineKey, 'model.select', args, signal(), id)
  assert.deepEqual(ack.selection, args.request.selection)
  assert.equal(f.state.selections, 1)
  const requests = f.packets.filter(packet => packet.body.type === 'request' && packet.body.op === 'model.select')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].body.requestId, requests[1].body.requestId)
  assert.deepEqual(requests[0].body.args, requests[1].body.args)
})
