/** Project-face ownership/lifetime units; actual compiled SDK/Loader evidence is a separate Host composition. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAdapter } from '../../lib/federation/native-adapter.mjs'

const SECRET = 'PRIVATE_NATIVE_PROJECT_ERROR_OR_PATH'
const prepared = { canonicalPath: '/native/canonical', existingWorkspaceId: 'native-workspace' }
const registered = { canonicalPath: '/native/canonical', workspaceId: 'native-workspace', title: 'Native project' }
const empty = { type: 'snapshot', cursor: -1, records: [], hasMore: false, projections: { asOfSeq: -1, values: {} }, assistantStream: { revision: 0 } }
function fixture({ live = false } = {}) {
  const original = Symbol('original'), calls = { prepare: [], register: [], follow: [], returns: 0 }, hooks = {}, reads = []
  let current
  class UnitController {
    #prepare
    #register
    #follow
    constructor() {
      this.#prepare = async (request, signal) => {
        const release = Promise.withResolvers(), call = { request, signal, release }; calls.prepare.push(call)
        return hooks.prepare ? hooks.prepare(call) : prepared
      }
      this.#register = async (request, signal) => {
        const release = Promise.withResolvers(), call = { request, signal, release }; calls.register.push(call)
        return hooks.register ? hooks.register(call) : registered
      }
      this.#follow = (_request, _budget, signal) => {
        const release = Promise.withResolvers(), call = { signal, release }; calls.follow.push(call)
        let reading
        return { [Symbol.asyncIterator]() { return this }, next() { reading = release.promise; return reading },
          async return() { calls.returns++; await reading; return { done: true, value: undefined } } }
      }
      this.sourcePrepareProject = this.#prepare; this.sourceRegisterProject = this.#register
      if (live) this.sourceFollow = this.#follow
    }
    static ownsSourceProjectHelpers(value) {
      return typeof value === 'object' && value !== null && #prepare in value && #register in value
        && Object.getOwnPropertyDescriptor(value, 'sourcePrepareProject')?.value === value.#prepare
        && Object.getOwnPropertyDescriptor(value, 'sourceRegisterProject')?.value === value.#register
    }
    static ownsSourceFollowHelper(value) {
      return typeof value === 'object' && value !== null && #follow in value
        && Object.getOwnPropertyDescriptor(value, 'sourceFollow')?.value === value.#follow
    }
  }
  const controller = new UnitController(); current = controller
  const owner = { SessionController: UnitController, default: UnitController,
    ownsSourceProjectHelpers: value => UnitController.ownsSourceProjectHelpers(value),
    ownsSourceFollowHelper: value => UnitController.ownsSourceFollowHelper(value),
    ownsSourceMutationHelpers: () => false, ownsSourceCatalogHelper: () => false }
  class UnitCompactor { push() {} snapshot() { return [] } }
  const native = { cordis: { symbols: { original } }, controllerOwner: owner, sandbox: {}, session: { SessionId: value => value }, llm: {
    AssistantStreamAccumulator: UnitCompactor, expandAssistantStream: value => value,
    assembleAssistantStream: () => ({ blocks: () => ['legacy-native-block'], interruptedBlocks: () => ['legacy-native-interrupted'] }),
  } }
  const ctx = { get(name) { if (name === 'sessionController') return current; throw new Error(`unexpected business fallback: ${name}`) } }
  return { ctx, native, owner, controller, UnitController, calls, hooks, reads, original, replace(value) { current = value } }
}
const create = f => createNativeAdapter({ ctx: f.ctx, native: f.native, settings: { projects: {} } })
const signal = () => new AbortController().signal
const unavailable = error => error.code === 'source-unavailable' && error.message === 'native project helper owner is unavailable'
  && error.cause === undefined && error.detail === undefined && !JSON.stringify(error).includes(SECRET)
const getter = (target, key, f) => Object.defineProperty(target, key, { configurable: true, get() { f.reads.push(key); throw new Error(SECRET) } })

for (const mode of ['old-attestor', 'rejected', 'module-getter', 'prepare-getter', 'register-getter', 'static-getter', 'module-constructor', 'default-constructor', 'own-constructor', 'forged-private-owner']) test(`project face is absent for ${mode} without changing legacy native APIs`, async () => {
  const f = fixture()
  if (mode === 'old-attestor') delete f.owner.ownsSourceProjectHelpers
  if (mode === 'rejected') f.owner.ownsSourceProjectHelpers = () => false
  if (mode === 'module-getter') getter(f.owner, 'ownsSourceProjectHelpers', f)
  if (mode === 'prepare-getter') getter(f.controller, 'sourcePrepareProject', f)
  if (mode === 'register-getter') getter(f.controller, 'sourceRegisterProject', f)
  if (mode === 'static-getter') getter(f.UnitController, 'ownsSourceProjectHelpers', f)
  if (mode === 'module-constructor') f.owner.SessionController = class Other {}
  if (mode === 'default-constructor') f.owner.default = class Other {}
  if (mode === 'own-constructor') Object.defineProperty(f.controller, 'constructor', { value: f.UnitController })
  if (mode === 'forged-private-owner') {
    const forged = Object.create(f.UnitController.prototype)
    forged.sourcePrepareProject = f.controller.sourcePrepareProject; forged.sourceRegisterProject = f.controller.sourceRegisterProject
    f.replace(forged)
  }
  const backend = await create(f)
  assert.equal('prepareProject' in backend, false); assert.equal('registerProject' in backend, false)
  assert.equal(typeof backend.read, 'function'); assert.equal(typeof backend.modelCatalog, 'function'); assert.equal(typeof backend.prompt, 'function')
  assert.equal(backend.mutationReadiness, undefined); assert.deepEqual(backend.nativeAssistantBlocks([], false), ['legacy-native-block'])
  assert.deepEqual(f.reads, []); assert.equal(backend.close(), undefined)
})

test('late attestor additions or force flags never enable the absent creation-time face', async () => {
  const f = fixture(), attest = f.owner.ownsSourceProjectHelpers
  delete f.owner.ownsSourceProjectHelpers
  const backend = await createNativeAdapter({ ctx: f.ctx, native: f.native, settings: { projects: {} }, forceProjectRegistration: true })
  f.owner.ownsSourceProjectHelpers = attest
  assert.equal(backend.prepareProject, undefined); assert.equal(backend.registerProject, undefined)
  assert.equal(backend.close(), undefined)
})

test('captured private closures serve the current traced original without calling facade shadows or normalizing paths', async () => {
  const f = fixture(), facade = { [f.original]: f.controller }
  getter(facade, 'sourcePrepareProject', f); getter(facade, 'sourceRegisterProject', f)
  f.replace(facade)
  const backend = await create(f)
  assert.equal(await backend.prepareProject({ path: '/RAW/../Native/Exact' }, signal()), prepared)
  assert.equal(await backend.registerProject({ canonicalPath: '/native/canonical' }, signal()), registered)
  assert.deepEqual(f.calls.prepare[0].request, { path: '/RAW/../Native/Exact' })
  assert.deepEqual(f.calls.register[0].request, { canonicalPath: '/native/canonical' })
  assert.deepEqual(f.reads, [])
  await backend.close()
  await assert.rejects(backend.prepareProject({ path: 'unchanged' }, signal()), unavailable)
})

const changes = [
  f => { f.controller.sourcePrepareProject = async () => prepared },
  f => { f.controller.sourceRegisterProject = async () => registered },
  f => { f.owner.ownsSourceProjectHelpers = () => true },
  f => { f.UnitController.ownsSourceProjectHelpers = () => true },
  f => { f.owner.SessionController = class Replacement {} },
  f => { f.owner.default = class Replacement {} },
  f => { Object.defineProperty(f.UnitController.prototype, 'constructor', { value: class Replacement {}, configurable: true }) },
  f => { f.replace(new f.UnitController()) },
]
test('helper, module, static and exact serving-owner replacements refuse before native admission', async () => {
  for (const change of changes) {
    const f = fixture(), backend = await create(f)
    change(f)
    await assert.rejects(backend.prepareProject({ path: '/request' }, signal()), unavailable)
    await assert.rejects(backend.registerProject({ canonicalPath: '/native/canonical' }, signal()), unavailable)
    assert.equal(f.calls.prepare.length + f.calls.register.length, 0)
    await backend.close()
  }
})

test('post-await replacement never publishes a late native registration or preparation result', async () => {
  for (const change of changes) {
    const f = fixture(); f.hooks.register = call => call.release.promise
    const backend = await create(f), rejected = assert.rejects(backend.registerProject({ canonicalPath: '/native/canonical' }, signal()), unavailable)
    change(f); f.calls.register[0].release.resolve(registered)
    await rejected; await backend.close()
  }
  const f = fixture(); f.hooks.prepare = call => call.release.promise
  const backend = await create(f), rejected = assert.rejects(backend.prepareProject({ path: '/request' }, signal()), unavailable)
  f.controller.sourcePrepareProject = () => prepared; f.calls.prepare[0].release.resolve(prepared)
  await rejected; await backend.close()
})

test('caller cancellation never reads its arbitrary reason and still joins held native work', async () => {
  const f = fixture(), caller = new AbortController()
  f.hooks.prepare = call => call.release.promise
  const backend = await create(f)
  Object.defineProperty(caller.signal, 'reason', { get() { f.reads.push('private-reason'); throw new Error(SECRET) } })
  const rejected = assert.rejects(backend.prepareProject({ path: '/request' }, caller.signal), unavailable)
  caller.abort({ secret: SECRET })
  assert.equal(f.calls.prepare[0].signal.aborted, true); assert.notEqual(f.calls.prepare[0].signal, caller.signal)
  assert.equal(JSON.stringify(f.calls.prepare[0].signal.reason).includes(SECRET), false)
  let done = false
  const closed = backend.close().then(() => { done = true })
  assert.equal(done, false); f.calls.prepare[0].release.resolve(prepared)
  await Promise.all([rejected, closed]); assert.equal(done, true); assert.deepEqual(f.reads, [])
  const pre = new AbortController(); pre.abort(SECRET)
  await assert.rejects(backend.registerProject({ canonicalPath: '/native/canonical' }, pre.signal), unavailable)
  assert.equal(f.calls.register.length, 0)
})

test('native private errors become static unavailable rejections before and after a possible registration effect', async () => {
  const f = fixture(), backend = await create(f)
  f.hooks.prepare = () => { throw new Error(SECRET) }; f.hooks.register = () => { throw Object.assign(new Error(SECRET), { code: SECRET }) }
  await assert.rejects(backend.prepareProject({ path: '/request' }, signal()), unavailable)
  await assert.rejects(backend.registerProject({ canonicalPath: '/native/canonical' }, signal()), unavailable)
  await backend.close()
})

test('close aborts all finite project calls and live readers before joining any held result', async () => {
  const f = fixture({ live: true }); f.hooks.prepare = call => call.release.promise; f.hooks.register = call => call.release.promise
  const backend = await create(f), reader = backend.followNative({ sessionId: 'passive-session' }, {}, signal())[Symbol.asyncIterator]()
  const rejected = [assert.rejects(reader.next(), { code: 'source-unavailable' }),
    assert.rejects(backend.prepareProject({ path: '/one' }, signal()), unavailable),
    assert.rejects(backend.registerProject({ canonicalPath: '/two' }, signal()), unavailable)]
  let joined = false
  const closing = backend.close().then(() => { joined = true })
  for (const call of [...f.calls.prepare, ...f.calls.register, ...f.calls.follow]) assert.equal(call.signal.aborted, true)
  assert.equal(joined, false)
  f.calls.prepare[0].release.resolve(prepared); await rejected[1]; assert.equal(joined, false)
  f.calls.register[0].release.resolve(registered); await rejected[2]; assert.equal(joined, false)
  f.calls.follow[0].release.resolve({ done: false, value: empty })
  await Promise.all([...rejected, closing]); assert.equal(joined, true); assert.equal(f.calls.returns, 1)
  await assert.rejects(backend.prepareProject({ path: '/late' }, signal()), unavailable)
})

test('a synchronous native callback can reenter close without escaping tracked admission', async () => {
  const f = fixture(), release = Promise.withResolvers()
  let backend, closing, joined = false
  f.hooks.prepare = () => { closing = backend.close().then(() => { joined = true }); return release.promise }
  backend = await create(f)
  const rejected = assert.rejects(backend.prepareProject({ path: '/request' }, signal()), unavailable)
  assert.equal(f.calls.prepare[0].signal.aborted, true); assert.equal(joined, false)
  release.resolve(prepared)
  await Promise.all([rejected, closing]); assert.equal(joined, true)
})
