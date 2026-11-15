import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, createHash } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createRelay } from '../../relay/server.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import { RemoteControlHost } from '../../index.js'
import { createRequire } from 'node:module'
const sdkRequire = createRequire(new URL('../../../dsh-remote-core/packages/api/session-controller/package.json', import.meta.url))
const { AssistantStreamAccumulator, expandAssistantStream, assembleAssistantStream } = sdkRequire('@deepseek-ai/dsh-llm')

const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']
const textEvent = (seq, text) => ({ type: 'user/message', seq, time: 100 + seq, surfaceOp: 'append', data: { id: `message-${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
class TestRemoteError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details } }
const grant = (machineKey, peerId, revision = 1) => ({ version: 1, grantId: 'grant_fixture', principal: { kind: 'controller', id: peerId }, machineKey, revision, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses: classes, createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'], exportClasses: classes }, sessions: [{ sessionId: 'session-1', imported: true, actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'], exportClasses: classes }] }] })
function fakeNative(label, mutable = false) {
  const sessions = new Map([['session-1', { header: { version: 4, id: 'session-1', createdAt: 1, isSeeded: false }, events: [textEvent(0, `${label} private native history`)], running: false }]])
  const effects = { creates: 0, prompts: 0, selects: 0, cancels: 0, reads: 0 }
  return {
    sessions, effects,
    ...(mutable ? { mutationReadiness: { durableJournal: 'verified', firstRouteCapture: 'verified' } } : {}), // Fake-only attestation; NOT native acceptance.
    validateNativeEvents: () => {},
    nativeAssistantBlocks: () => [],
    async read(ref, signal) { signal.throwIfAborted(); effects.reads++; const state = sessions.get(ref.sessionId); if (!state) throw Object.assign(new Error('SECRET_ABSENT'), { code: 'source-unavailable' }); return structuredClone(state) },
    async modelCatalog() { return { default: { provider: 'worker-provider', model: `model-${label}`, reasoningEffort: 'moderate' }, routableProviders: ['worker-provider'], failures: [], groups: [{ id: 'worker-provider', name: label, models: [{ id: `model-${label}`, name: `Model ${label}`, reasoning: { efforts: [{ id: 'moderate', name: 'Moderate' }, { id: 'max', name: 'Maximum' }], defaultEffort: 'moderate' } }] }] } },
    async modelState(ref) { return { frontierSeq: sessions.get(ref.sessionId).events.length - 1, selection: { provider: 'worker-provider', model: `model-${label}`, reasoningEffort: 'moderate' } } },
    async create({ ref, reservedSessionId }, dispatch) { await dispatch(); effects.creates++; sessions.set(reservedSessionId, { header: { version: 4, id: reservedSessionId, createdAt: 1, isSeeded: false }, events: [], running: false }); return { ...ref, sessionId: reservedSessionId } },
    async prompt(ref, request, dispatch) { await dispatch(); effects.prompts++; const state = sessions.get(ref.sessionId); state.events.push(textEvent(state.events.length, request.text)); return { accepted: true } },
    async modelSelect(ref, request, dispatch) { await dispatch(); effects.selects++; return { frontierSeq: sessions.get(ref.sessionId).events.length - 1, selection: request.selection } },
    async cancel(ref, request, dispatch) { await dispatch(); effects.cancels++; return { accepted: true } },
    restoreGuard() {}, close() {},
  }
}

// Synthetic producer, actual SDK compactor/readers and actual HTTP/JWE. Not a native Loader acceptance.
function fakeLive(backend) {
  backend.effects.follows = 0; backend.effects.followClosed = 0
  backend.readDetails = async (ref, signal) => { const value = await backend.read(ref, signal); return { ...value,
    cursor: value.events.length - 1, projections: { asOfSeq: value.events.length - 1, values: {} } } }
  backend.nativeExpand = expandAssistantStream
  backend.nativeCreateCompactor = () => new AssistantStreamAccumulator()
  backend.nativeLiveAssistantBlocks = backend.nativeAssistantBlocks = (stream, interrupted) => {
    const owner = assembleAssistantStream(stream); return interrupted ? owner.interruptedBlocks() : owner.blocks()
  }
  backend.followNative = async function* (ref, _request, signal) {
    backend.effects.follows++
    try {
      const state = backend.sessions.get(ref.sessionId), initial = await backend.readDetails(ref, signal)
      yield { type: 'snapshot', header: initial.header, cursor: initial.cursor, hasMore: false,
        records: initial.events.map(event => ({ type: 'event', event })), projections: initial.projections, assistantStream: { revision: 0 } }
      let revision = 0, index = 0
      const attemptId = 'runtime-native-attempt', owner = new AssistantStreamAccumulator()
      yield { type: 'assistant-stream', frame: { type: 'start', revision: ++revision, attemptId, startedAfterSeq: initial.cursor, turn: 1, step: 1 } }
      const chunks = [{ type: 'block-start', index: 0, blockType: 'text' },
        ...Array.from({ length: 640 }, () => ({ type: 'text-delta', index: 0, text: 'x' })),
        { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(640) } }, { type: 'finish', reason: { kind: 'stop' } }]
      for (const chunk of chunks) {
        signal.throwIfAborted(); owner.push({ time: index, chunk })
        yield { type: 'assistant-stream', frame: { type: 'chunk', revision: ++revision, attemptId, index, time: index++, chunk } }
      }
      const event = { type: 'assistant/message', seq: state.events.length, time: 1000, surfaceOp: 'append', data: { turn: 1, step: 1,
        message: { id: 'runtime-assistant', role: 'assistant', source: { kind: 'model', provider: 'worker-provider', model: 'model-a' }, content: [{ type: 'text', text: 'x'.repeat(640) }] }, stream: owner.snapshot() } }
      state.events.push(event); yield { type: 'event', event }
      yield { type: 'assistant-stream', frame: { type: 'end', revision: ++revision, attemptId, index, outcome: { kind: 'committed', eventType: event.type, seq: event.seq } } }
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
    } finally { backend.effects.followClosed++ }
  }
  return backend
}

async function setup(t, { mutable = false, live = false } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-fed-runtime-')))
  const resources = []
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close()
    const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.ok(path.basename(target).startsWith('dsh-fed-runtime-')); await rm(target, { recursive: true, force: true })
  })
  const devices = ['controller-a', 'worker-a', 'controller-b', 'worker-b'].map(id => ({ id, peerId: id.startsWith('controller') ? id.replace('controller', 'worker') : id.replace('worker', 'controller'), token: randomBytes(32).toString('base64url') }))
  const relay = createRelay({ directory: path.join(root, 'relay'), devices: devices.map(({ token, ...value }) => ({ ...value, tokenHash: createHash('sha256').update(token).digest('hex') })), pollMs: 20 })
  resources.push(relay)
  await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const relayUrl = `http://127.0.0.1:${relay.server.address().port}`
  const controllerPairs = [], workers = [], backends = []
  for (const [i, suffix] of ['a', 'b'].entries()) {
    const machineKey = `stable-machine-${suffix}`, key = randomBytes(32).toString('base64url')
    const controller = devices.find(device => device.id === `controller-${suffix}`), worker = devices.find(device => device.id === `worker-${suffix}`)
    const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl, sharedKey: key, allowLoopback: true, requestTimeoutMs: 1500 }
    controllerPairs.push({ ...common, id: controller.id, peerId: controller.peerId, relayToken: controller.token, stateDir: `./controller-${suffix}`, label: `Locally authorized ${suffix}` })
    const project = path.join(root, `project-${suffix}`); await mkdir(project)
    const config = { version: 2, role: 'worker', id: `logical-worker-${suffix}`, machineKey, projects: { demo: { workspaceId: `workspace-${suffix}` } }, pairs: [{ ...common, id: worker.id, peerId: worker.peerId, relayToken: worker.token, stateDir: `./worker-${suffix}`, grant: grant(machineKey, worker.peerId) }] }
    const settings = await parseSettingsV2(config, path.join(root, 'settings.json'), { resolveWorkspace: () => ({ path: project }) })
    const backend = live ? fakeLive(fakeNative(suffix, mutable)) : fakeNative(suffix, mutable), runtime = await openFederationRuntime(settings, { backend })
    resources.push(runtime); workers.push(runtime); backends.push(backend); runtime.start()
  }
  const settings = await parseSettingsV2({ version: 2, role: 'controller', id: 'logical-controller', pairs: controllerPairs }, path.join(root, 'settings.json'))
  const controller = await openFederationRuntime(settings)
  resources.push(controller); controller.start()
  const providers = await Promise.all(settings.pairs.map(pair => createHostProvider({ runtime: controller, pair, RemoteError: TestRemoteError })))
  return { root, relay, controller, workers, backends, providers, settings }
}

test('cold live negotiation learns positive metadata without invalidating the same authenticated numeric authority', async t => {
  const { controller, providers } = await setup(t, { live: true })
  const provider = providers[0], ref = { machineKey: provider.machineKey, projectId: 'demo', sessionId: 'session-1' }
  const signal = new AbortController().signal
  await provider.catalog(undefined, signal)
  const before = controller.authority(ref.machineKey), peer = controller.peers.get(ref.machineKey), reasons = []
  assert.equal(before.metadataAuthorized, undefined); assert.equal(peer.projectAdmissions.has(ref.projectId), true)
  const stop = controller.subscribe(ref.machineKey, reason => { reasons.push(reason) }); t.after(stop)
  assert.equal((await provider.live.bind(ref, signal)).nativeLive, true)
  const after = controller.authority(ref.machineKey)
  assert.equal(after.generation, before.generation); assert.equal(after.grantRevision, before.grantRevision)
  assert.equal(after.metadataAuthorized, true); assert.equal(peer.projectAdmissions.has(ref.projectId), true)
  assert.deepEqual(reasons, ['catalog'])
})

test('known metadata withdrawal at the same counters still retires authority after grant expiry', async t => {
  const { controller, workers, providers } = await setup(t)
  const provider = providers[0], signal = new AbortController().signal, machine = provider.machineKey
  const workerPeer = workers[0].peers.get(machine), deadline = Date.now() + 10_000
  await workerPeer.journal.installGrant({ ...grant(machine, workerPeer.pair.peerId, 2), expiresAt: deadline })
  await controller.call(machine, 'hello', {}, signal)
  const before = controller.authority(machine), reasons = []
  const stop = controller.subscribe(machine, reason => { reasons.push(reason) }); t.after(stop)
  t.mock.timers.enable({ apis: ['Date'], now: deadline + 1 })
  const response = await controller.call(machine, 'hello', {}, signal)
  assert.equal(response.machine, null)
  const after = controller.authority(machine)
  assert.equal(after.generation, before.generation); assert.equal(after.grantRevision, before.grantRevision)
  assert.equal(after.metadataAuthorized, false); assert.deepEqual(reasons, ['authority'])
})

test('one live Runtime producer sends640 chunks over HTTP/JWE without durable per-frame messages', async t => {
  const { controller, workers, backends, providers } = await setup(t, { live: true })
  const provider = providers[0], ref = { machineKey: provider.machineKey, projectId: 'demo', sessionId: 'session-1' }
  const abort = new AbortController(); t.after(() => abort.abort())
  const info = await provider.live.bind(ref, abort.signal)
  assert.equal(info.nativeLive, true); assert.equal(info.includeAssistantStream, true)
  const durable = () => [controller.peers.get(ref.machineKey).endpoint.status().outbox, workers[0].peers.get(ref.machineKey).endpoint.status().outbox]
  const before = durable(), reader = provider.live.historyFollow(ref, { includeAssistantStream: true }, abort.signal)[Symbol.asyncIterator]()
  let chunks = 0, settled = false, ended = false
  try {
    for (;;) {
      const step = await reader.next(); assert.equal(step.done, false)
      const frame = step.value
      await provider.live.bind(ref, abort.signal)
      if (frame.type === 'records') settled ||= frame.records.some(record => record.type === 'event' && record.event.type === 'assistant/message')
      if (frame.type === 'assistant-stream' && frame.frame.type === 'chunk' && frame.frame.chunk.type === 'text-delta') chunks++
      if (frame.type === 'assistant-stream' && frame.frame.type === 'end') {
        assert.equal(settled, true); assert.equal(frame.frame.outcome.kind, 'committed'); ended = true; break
      }
    }
  } finally { await reader.return() }
  assert.equal(ended, true); assert.equal(chunks, 640); assert.equal(backends[0].effects.follows, 1)
  assert.deepEqual(durable(), before, 'Live data and BFF revalidation do not append durable endpoint messages')
  await workers[0].close()
  assert.equal(backends[0].effects.followClosed, 1)
  assert.equal(workers[0].peers.get(ref.machineKey).liveStreams.status().active, 0)
})

test('provider create-state reads cached project admission offline and settlement notifies catalog without replay', async t => {
  const { controller, workers, backends, providers } = await setup(t, { mutable: true })
  const provider = providers[0], signal = new AbortController().signal
  const ref = { machineKey: provider.machineKey, projectId: 'demo' }
  await assert.rejects(provider.getCreateState(ref, signal), { code: 'session-source/grant-changed' })
  await provider.catalog(undefined, signal)
  await workers[0].close()
  controller.peers.get(provider.machineKey).mutationsVerified = false // inquiry is not a mutation/readiness probe
  assert.deepEqual(await provider.getCreateState(ref, signal), { state: 'idle' })
  const committedId = 'known_committed_create', committedRef = { ...ref, sessionId: 'native-known-result' }
  await controller.peers.get(provider.machineKey).journal.execute({ principal: 'controller-a', machineKey: provider.machineKey, requestId: committedId, action: 'session.create', target: ref, body: {} }, async tx => { await tx.dispatch(); return committedRef })
  assert.deepEqual(await provider.getCreateState(ref, signal), { state: 'committed', requestId: committedId, ref: committedRef })
  await assert.rejects(provider.getCreateState({ ...ref, projectId: 'never-admitted' }, signal), { code: 'session-source/grant-changed' })
  await assert.rejects(provider.getCreateState({ ...ref, machineKey: providers[1].machineKey }, signal), { code: 'session-source/source-unavailable' })
  const changes = [], dispose = provider.subscribeChanges(reason => changes.push(reason)); t.after(dispose)
  const requestId = 'offline_create_original'
  await assert.rejects(controller.call(provider.machineKey, 'session.create', { ref }, signal, requestId), { code: 'outcome-unknown' })
  assert.deepEqual(await provider.getCreateState(ref, signal), { state: 'unknown', requestId })
  assert.deepEqual(await provider.getCreateState(ref, signal), { state: 'unknown', requestId })
  assert.ok(changes.includes('catalog'), 'settlement notifies an existing source observer')
  assert.equal(backends[0].effects.creates, 0)
})

test('real HTTP/JWE pairs isolate colliding native IDs, Worker model catalogs, passive histories and source notifications', async t => {
  const { controller, workers, backends, providers } = await setup(t)
  const signal = new AbortController()
  t.after(() => signal.abort())
  for (const [i, provider] of providers.entries()) {
    const ref = { machineKey: provider.machineKey, projectId: 'demo', sessionId: 'session-1' }
    assert.deepEqual(await provider.machine(signal.signal), { label: `Locally authorized ${i === 0 ? 'a' : 'b'}` })
    const catalog = await provider.catalog(undefined, signal.signal)
    assert.equal(catalog.sessions.length, 1)
    assert.equal(catalog.sessions[0].ref.machineKey, provider.machineKey)
    assert.equal(catalog.projects[0].canCreate, false, 'Unverified real mutation readiness is not advertised')
    const binding = await provider.bind(ref, signal.signal)
    assert.match(binding.generation, /^feg1\./)
    assert.match(binding.grantRevision, /^fgr1\./)
    assert.equal(binding.capabilities.prompt, false)
    const page = await provider.historyPage(ref, { maxMessages: 50 }, signal.signal)
    assert.equal(page.records[0].event.data.content[0].text, `${i === 0 ? 'a' : 'b'} private native history`)
    const modelCatalog = await provider.modelCatalog(ref, signal.signal)
    assert.equal(modelCatalog.default.model, `model-${i === 0 ? 'a' : 'b'}`)
    assert.deepEqual(modelCatalog.groups[0].models[0].reasoning.efforts.map(effort => effort.id), ['moderate', 'max'])
    await assert.rejects(provider.prompt(ref, { text: 'must not run', requestId: 'request_blocked', expected: await provider.modelState(ref, signal.signal) }, signal.signal), error => error.code === 'session-source/action-unsupported')
    assert.equal(backends[i].effects.prompts, 0)
  }
  const ref = { machineKey: providers[0].machineKey, projectId: 'demo', sessionId: 'session-1' }
  const follow = providers[0].historyFollow(ref, { includeAssistantStream: false }, signal.signal)[Symbol.asyncIterator]()
  const opening = await follow.next()
  assert.equal(opening.value.type, 'snapshot')
  const next = follow.next()
  const native = backends[0].sessions.get('session-1')
  native.events.push(textEvent(1, 'native committed append'))
  await workers[0].committed('session-1')
  const appended = await next
  assert.equal(appended.value.type, 'records')
  assert.equal(appended.value.records[0].event.seq, 1)
  assert.equal(appended.value.records[0].event.data.content[0].text, 'native committed append')
  assert.equal(appended.value.generation, opening.value.page.generation)
  signal.abort(); await follow.return()
  assert.equal(backends[0].effects.creates + backends[0].effects.prompts, 0)
  assert.notEqual(controller.peers.get(providers[0].machineKey).pair.stateDir, controller.peers.get(providers[1].machineKey).pair.stateDir)
})

test('owner mutation readiness needs a fresh authenticated response per pair and withdraws with Worker support', async t => {
  const { providers, backends } = await setup(t, { mutable: true })
  const signal = new AbortController().signal
  assert.equal(providers[0].mutationReadiness, undefined)
  assert.equal(providers[1].mutationReadiness, undefined)
  await providers[0].catalog(undefined, signal)
  assert.deepEqual(providers[0].mutationReadiness, { durableJournal: 'verified', firstRouteCapture: 'verified' })
  assert.equal(providers[1].mutationReadiness, undefined, 'another pair cannot reuse the first Worker attestation')
  delete backends[0].mutationReadiness
  await providers[0].catalog(undefined, signal)
  assert.equal(providers[0].mutationReadiness, undefined)
})

test('one offline Worker retains safe local machine metadata and cannot prevent another pair from reading', async t => {
  const { providers, workers } = await setup(t)
  const signal = new AbortController().signal
  await providers[0].catalog(undefined, signal)
  await providers[1].catalog(undefined, signal)
  await workers[1].close()
  const started = Date.now()
  assert.deepEqual(await providers[1].machine(signal), { label: 'Locally authorized b' })
  assert.ok(Date.now() - started < 100, 'machine() is a local metadata lookup, not network liveness')
  await assert.rejects(providers[1].catalog(undefined, signal), error => error.code === 'session-source/source-unavailable')
  const healthy = await providers[0].catalog(undefined, signal)
  assert.equal(healthy.sessions[0].ref.machineKey, providers[0].machineKey)
})

test('Worker current grant and authenticated principal win over body spoofing, revocation and stale frames', async t => {
  const { controller, workers, providers, backends } = await setup(t)
  const signal = new AbortController().signal, machineKey = providers[0].machineKey
  const ref = { machineKey, projectId: 'demo', sessionId: 'session-1' }
  await providers[0].catalog(undefined, signal)
  await assert.rejects(controller.call(machineKey, 'session.status', { ref, principal: { kind: 'controller', id: 'spoofed' } }, signal), error => error.code === 'invalid-message')
  const peer = [...workers[0].peers.values()][0]
  const revoked = grant(machineKey, peer.pair.peerId, 2)
  revoked.revokedAt = 1
  await peer.journal.installGrant(revoked)
  const before = backends[0].effects.reads
  await assert.rejects(providers[0].historyPage(ref, { maxMessages: 50 }, signal), error => error.code === 'session-source/grant-changed')
  assert.equal(backends[0].effects.reads, before, 'revoked data is refused before native I/O')
  assert.equal(await providers[0].machine(signal), null, 'known denial differs from an ordinary offline timeout')
})

test('journaled fake mutations reconcile exact IDs and enroll only actually created sessions under current template', async t => {
  const { controller, workers, backends, providers } = await setup(t, { mutable: true })
  const signal = new AbortController().signal, machineKey = providers[0].machineKey
  const project = { machineKey, projectId: 'demo' }
  const created = await controller.call(machineKey, 'session.create', { ref: project }, signal, 'create_reconcile')
  assert.match(created.sessionId, /^session-/)
  assert.equal(backends[0].effects.creates, 1)
  assert.deepEqual(await controller.call(machineKey, 'session.create', { ref: project }, signal, 'create_reconcile'), created)
  assert.equal(backends[0].effects.creates, 1)
  const catalog = await controller.call(machineKey, 'catalog', {}, signal)
  assert.ok(catalog.sessions.some(row => row.ref.sessionId === created.sessionId))
  const ref = { machineKey, projectId: 'demo', sessionId: created.sessionId }
  const expected = await controller.call(machineKey, 'model.state', { ref }, signal)
  await controller.call(machineKey, 'session.prompt', { ref, request: { text: 'accepted once', expected } }, signal, 'prompt_reconcile')
  await controller.call(machineKey, 'session.prompt', { ref, request: { text: 'accepted once', expected } }, signal, 'prompt_reconcile')
  assert.equal(backends[0].effects.prompts, 1)
  await assert.rejects(controller.call(machineKey, 'session.prompt', { ref, request: { text: 'different', expected } }, signal, 'prompt_reconcile'), error => error.code === 'request-conflict')
  const peer = [...workers[0].peers.values()][0], narrowed = grant(machineKey, peer.pair.peerId, 2)
  delete narrowed.projects[0].createdSessionGrant
  await peer.journal.installGrant(narrowed)
  await assert.rejects(controller.call(machineKey, 'session.status', { ref }, signal), error => error.code === 'source-unavailable')
})

test('v2 agent-tool entry exposes no peer, project, model, session or history inventory', async () => {
  const host = new RemoteControlHost({}, {})
  host.federation = { settings: { pairs: [{ relayToken: 'SECRET', machineKey: 'PRIVATE' }] } }
  const status = await host.execute({ action: 'status' }, 'local-chat')
  assert.equal(status.status, 'ui-only-unavailable')
  assert.equal(JSON.stringify(status).includes('PRIVATE'), false)
  assert.equal(JSON.stringify(status).includes('SECRET'), false)
  assert.equal(Object.hasOwn(status, 'peers'), false)
  await assert.rejects(host.execute({ action: 'create', projectId: 'demo' }, 'local-chat'))
})
