/** One external vertical slice: real pair journals/Runtime/Provider with unit-native callbacks and an owned relay seam. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'

class TestRemoteError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details } }
const signal = () => new AbortController().signal
async function fixture(t, allowed = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-project-vertical-'))), resources = []
  const directory = path.join(root, 'native-project'); await mkdir(directory)
  const machineKey = 'worker-project', principal = { kind: 'controller', id: 'controller-endpoint' }
  const projectGrant = { actions: ['project.list', 'session.list', 'session.create'], exportClasses: ['conversation.user', 'conversation.assistant', 'turn'],
    createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow'], exportClasses: ['conversation.user', 'conversation.assistant', 'turn'] } }
  const grant = { version: 2, grantId: 'grant_vertical', principal, machineKey, revision: 1, issuedAt: 0, projects: [],
    ...(allowed ? { projectRegistration: { actions: ['project.register'], projectGrant } } : {}) }
  const common = { machineKey, protocol: 2, pairingGeneration: 1, keyFingerprint: 'a'.repeat(64), sharedKey: randomBytes(32).toString('base64url'), requestTimeoutMs: 250 }
  const workerPair = { ...common, role: 'worker', id: 'worker-endpoint', peerId: principal.id, stateDir: path.join(root, 'worker-state'), grant }
  const controllerPair = { ...common, role: 'controller', id: principal.id, peerId: workerPair.id, stateDir: path.join(root, 'controller-state') }
  const receivers = new Map(), packets = [], transport = { dropRegisterResponse: false, dropRegisterRequest: false }
  const endpointFactory = async (pair, handlers) => {
    receivers.set(pair.id, handlers)
    return { start() {}, async close() { receivers.delete(pair.id) }, async send(kind, body) {
      const packet = { from: pair.id, to: pair.peerId, kind, body: structuredClone(body) }; packets.push(packet)
      if (!(body.op === 'project.register' && ((transport.dropRegisterResponse && body.type === 'response') || (transport.dropRegisterRequest && body.type === 'request')))) await receivers.get(pair.peerId)?.onMessage(packet)
    } }
  }
  const effects = { prepared: 0, registered: 0, reads: 0, bindings: [] }
  const backend = { validateNativeEvents() {}, nativeAssistantBlocks: () => [],
    async prepareProject(request, operationSignal) { operationSignal.throwIfAborted(); effects.prepared++; return { canonicalPath: directory,
      ...(effects.registered ? { existingWorkspaceId: 'native-existing-workspace' } : {}) } },
    async registerProject(request, operationSignal) { operationSignal.throwIfAborted(); effects.registered++; return { canonicalPath: request.canonicalPath, workspaceId: 'native-existing-workspace', title: 'Registered project' } },
    setProjectBindings(machine, entries) { assert.equal(machine, machineKey); effects.bindings = structuredClone(entries) },
    async read() { effects.reads++; throw new Error('old native sessions must never be queried') }, close() {} }
  const worker = await openFederationRuntime({ role: 'worker', label: 'Worker', projects: {}, pairs: [workerPair] }, { backend, endpointFactory }); resources.push(worker); worker.start()
  const controller = await openFederationRuntime({ role: 'controller', projects: {}, pairs: [controllerPair] }, { endpointFactory }); resources.push(controller); controller.start()
  const provider = await createHostProvider({ runtime: controller, pair: controllerPair, RemoteError: TestRemoteError })
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close()
    const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.equal(path.basename(target).startsWith('dsh-project-vertical-'), true)
    await rm(target, { recursive: true, force: true })
  })
  return { provider, worker, controller, machineKey, directory, effects, packets, transport }
}

test('a permitted Worker path becomes an opaque catalog project without adopting any old native session', async t => {
  const f = await fixture(t), state = await f.provider.projectRegistration.state(signal())
  assert.equal(state.canRegister, true); assert.equal(typeof state.expected.generation, 'string'); assert.equal(typeof state.expected.grantRevision, 'string')
  const request = { requestId: 'register_vertical', path: f.directory, expected: state.expected }
  const ref = await f.provider.projectRegistration.register(request, signal())
  assert.equal(ref.machineKey, f.machineKey); assert.match(ref.projectId, /^fpr_[a-f0-9]{32}$/)
  const catalog = await f.provider.catalog(undefined, signal())
  assert.deepEqual(catalog.projects.map(row => row.ref), [ref]); assert.deepEqual(catalog.sessions, [])
  assert.equal(f.effects.registered, 1); assert.equal(f.effects.bindings[0].workspaceId, 'native-existing-workspace')
  await assert.rejects(f.provider.bind({ ...ref, sessionId: 'pre-existing-native-session' }, signal()))
  assert.equal(f.effects.reads, 0)
  assert.deepEqual(await f.provider.projectRegistration.register(request, signal()), ref); assert.equal(f.effects.registered, 1)
  const retained = await f.provider.projectRegistration.state(signal())
  assert.equal(retained.retained.requestId, request.requestId); assert.equal(retained.retained.path, f.directory)
  assert.deepEqual(retained.retained.result, ref); assert.equal(retained.retained.state, 'committed')
})

test('an ungranted machine does not advertise or dispatch project registration', async t => {
  const f = await fixture(t, false), state = await f.provider.projectRegistration.state(signal())
  assert.equal(state.canRegister, false)
  await assert.rejects(f.provider.projectRegistration.register({ requestId: 'register_denied', path: f.directory, expected: state.expected }, signal()))
  assert.equal(f.effects.prepared, 0); assert.equal(f.effects.registered, 0)
  assert.equal(f.packets.some(packet => packet.body.type === 'request' && packet.body.op === 'project.register'), false)
})

test('an unknown Worker request stays retained and is never guessed or replayed by state reads', async t => {
  const f = await fixture(t), initial = await f.provider.projectRegistration.state(signal())
  f.transport.dropRegisterRequest = true
  await assert.rejects(f.provider.projectRegistration.register({ requestId: 'register_never_received', path: f.directory, expected: initial.expected }, signal()), { code: 'session/outcome-unknown' })
  const state = await f.provider.projectRegistration.state(signal())
  assert.equal(state.retained.state, 'unknown'); assert.equal(state.retained.requestId, 'register_never_received')
  assert.equal(f.effects.registered, 0)
  assert.equal(f.packets.filter(packet => packet.body.type === 'request' && packet.body.op === 'project.register').length, 1)
})

test('a lost receipt retains one unknown request; read-state settles it without another mutation or replacement ID', async t => {
  const f = await fixture(t), initial = await f.provider.projectRegistration.state(signal())
  const request = { requestId: 'register_lost_reply', path: f.directory, expected: initial.expected }
  f.transport.dropRegisterResponse = true
  await assert.rejects(f.provider.projectRegistration.register(request, signal()), { code: 'session/outcome-unknown' })
  await assert.rejects(f.provider.projectRegistration.register({ ...request, requestId: 'register_forbidden_replacement' }, signal()), { code: 'session/outcome-unknown' })
  f.transport.dropRegisterResponse = false
  const state = await f.provider.projectRegistration.state(signal())
  assert.equal(state.retained.requestId, request.requestId); assert.equal(state.retained.state, 'committed')
  assert.equal(f.effects.registered, 1)
  assert.equal(f.packets.filter(packet => packet.body.type === 'request' && packet.body.op === 'project.register').length, 1)
})
