/** Real private journal with unit-only native callbacks; actual SDK/Loader composition is separate evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, lstat, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { openProjectJournal } from '../../lib/federation/project-journal.mjs'
import { createProjectRegistrar } from '../../lib/federation/project-registration.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'

const CANONICAL = '/worker/canonical', RAW = '/worker/raw-alias', NATIVE_ID = 'opaque-native-workspace', SECRET = 'PRIVATE_NATIVE_ERROR_OR_PATH'
const policy = () => ({ actions: ['project.list', 'session.list', 'session.create'], exportClasses: ['conversation.user'],
  createdSessionGrant: { actions: ['session.read'], exportClasses: ['conversation.user'] } })
const request = (requestId = 'register_one', raw = RAW) => ({ requestId, body: { path: raw }, authority: { generation: 2, grantRevision: 1 } })
const code = expected => error => error instanceof FederationContractError && error.code === expected && error.message === 'project registration is unavailable'
const signal = () => new AbortController().signal
async function fixture(t) {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent, 'dsh-project-registrar-')))
  const pair = { role: 'worker', id: 'worker', peerId: 'controller', machineKey: 'worker-machine', pairingGeneration: 1, keyFingerprint: 'f'.repeat(64), stateDir: root }
  let journal = await openProjectJournal(pair)
  const state = { generation: 2, grantRevision: 1, principal: { kind: 'controller', id: 'controller' }, machineKey: pair.machineKey, now: 20,
    grant: { version: 2, grantId: 'grant_registrar', principal: { kind: 'controller', id: 'controller' }, machineKey: pair.machineKey,
      revision: 1, issuedAt: 10, projects: [], projectRegistration: { actions: ['project.register'], projectGrant: policy() } } }
  const effects = { prepare: [], register: [], guards: [], notified: 0 }, hooks = {}, nativeState = { workspaceId: undefined, rawTarget: CANONICAL }
  const native = {
    async prepare(input, ownedSignal) {
      effects.prepare.push({ path: input.path, signal: ownedSignal })
      if (hooks.prepare) return hooks.prepare(input, ownedSignal)
      return { canonicalPath: input.path === CANONICAL ? CANONICAL : nativeState.rawTarget,
        ...(nativeState.workspaceId === undefined ? {} : { existingWorkspaceId: nativeState.workspaceId }) }
    },
    async register(input, ownedSignal) {
      effects.register.push({ ...input, signal: ownedSignal })
      assert.equal(journal.row('register_one')?.state === 'dispatched' || Object.values(journal.snapshot().operations).some(row => row.state === 'dispatched'), true)
      if (hooks.register) return hooks.register(input, ownedSignal)
      nativeState.workspaceId ??= NATIVE_ID
      return { canonicalPath: input.canonicalPath, workspaceId: nativeState.workspaceId, title: 'Public project' }
    },
  }
  const guard = canonical => { effects.guards.push(canonical); if (hooks.guard) hooks.guard(canonical) }
  const make = (overrides = {}) => createProjectRegistrar({ journal, context: () => state, native, checkCanonicalPath: guard,
    onCommitted: () => { effects.notified++ }, ...overrides })
  t.after(async () => {
    await journal.close()
    assert.equal(await realpath(root), root); assert.equal(path.dirname(root), parent); assert.equal(path.basename(root).startsWith('dsh-project-registrar-'), true)
    assert.equal((await lstat(root)).isSymbolicLink(), false)
    await rm(root, { recursive: true, force: true })
  })
  return { state, effects, hooks, nativeState, native, make, get journal() { return journal }, async reopen() { await journal.close(); journal = await openProjectJournal(pair) } }
}

test('register preserves dispatch→genuine proof→atomic enrollment order and emits only a frozen path-free receipt', async t => {
  const f = await fixture(t), registrar = f.make(), result = await registrar.register(request(), signal())
  assert.equal(f.journal.row('register_one').state, 'committed'); assert.equal(f.effects.register.length, 1)
  assert.equal(f.effects.notified, 1); assert.equal(result.ref.machineKey, 'worker-machine'); assert.match(result.ref.projectId, /^fpr_[a-f0-9]{32}$/)
  assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.ref), true)
  assert.equal(f.journal.nativeBindings()[0].canonicalPath, CANONICAL)
  for (const value of [RAW, CANONICAL, NATIVE_ID, 'nativeProof', 'workspaceId']) assert.equal(JSON.stringify(result).includes(value), false)
  const repeated = await registrar.register(request(), signal())
  assert.deepEqual(repeated, result); assert.equal(f.effects.prepare.length, 1); assert.equal(f.effects.register.length, 1); assert.equal(f.effects.notified, 1)
  assert.equal((await registrar.reconcile('register_one', signal())).state, 'committed')
})

test('a queued native preparation retains the original raw body and authority instead of later caller mutations', async t => {
  const f = await fixture(t), input = request()
  f.hooks.prepare = async () => { input.body.path = '/changed-by-caller'; input.authority.generation = 99; return { canonicalPath: CANONICAL } }
  await f.make().register(input, signal())
  assert.equal(f.journal.row('register_one').body.path, RAW); assert.equal(f.journal.row('register_one').authority.generation, 2)
})

test('changed raw body or request CAS conflicts without re-resolving aliases or failing another retained intent', async t => {
  const f = await fixture(t)
  const reserved = await f.journal.reserve(request(), { canonicalPath: CANONICAL, projectGrant: policy() })
  await assert.rejects(f.make().register(request('register_one', '/different-raw'), signal()), code('request-conflict'))
  await assert.rejects(f.make().register({ ...request(), authority: { generation: 3, grantRevision: 1 } }, signal()), code('request-conflict'))
  assert.deepEqual(f.journal.row('register_one'), reserved); assert.equal(f.effects.prepare.length, 0); assert.equal(f.effects.register.length, 0)
})

test('intent retry prepares only captured canonical spelling, never a retargeted original alias', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), { canonicalPath: CANONICAL, projectGrant: policy() })
  f.nativeState.rawTarget = '/worker/retargeted'
  await f.make().register(request(), signal())
  assert.deepEqual(f.effects.prepare.map(row => row.path), [CANONICAL])
  assert.deepEqual(f.effects.register.map(row => row.canonicalPath), [CANONICAL])
})

test('authority loss or template change during preparation fails before dispatch', async t => {
  for (const mutate of [state => { state.generation++ }, state => { state.grant.projectRegistration.projectGrant.actions = [] }]) {
    const f = await fixture(t)
    f.hooks.prepare = async () => { mutate(f.state); return { canonicalPath: CANONICAL } }
    await assert.rejects(f.make().register(request(), signal()), code('grant-changed'))
    assert.equal(f.effects.register.length, 0); assert.equal(f.journal.state('register_one').state, 'absent')
  }
})

test('canonical Worker-private path exclusions run before reservation or native mutation', async t => {
  const f = await fixture(t)
  f.hooks.guard = () => { throw new Error(SECRET) }
  await assert.rejects(f.make().register(request(), signal()), code('source-unavailable'))
  assert.equal(f.journal.state('register_one').state, 'absent'); assert.equal(f.effects.register.length, 0)
  assert.deepEqual(f.effects.guards, [CANONICAL])
  assert.throws(() => f.make({ checkCanonicalPath: undefined }), code('source-unavailable'))
})

test('post-dispatch authority loss is uncertain even if no native call has started', async t => {
  const f = await fixture(t), actual = f.journal
  const observed = { ...actual, async markDispatched(id) { const row = await actual.markDispatched(id); f.state.generation++; return row } }
  await assert.rejects(f.make({ journal: observed }).register(request(), signal()), code('outcome-unknown'))
  assert.equal(f.effects.register.length, 0); assert.equal(actual.state('register_one').state, 'unknown')
})

test('genuine native proof is retained before authority is checked after the native effect', async t => {
  const f = await fixture(t)
  f.hooks.register = async input => { f.nativeState.workspaceId = NATIVE_ID; f.state.generation++; return { canonicalPath: input.canonicalPath, workspaceId: NATIVE_ID, title: 'Public project' } }
  await assert.rejects(f.make().register(request(), signal()), code('outcome-unknown'))
  const row = f.journal.row('register_one')
  assert.equal(row.state, 'unknown'); assert.equal(row.nativeProof.workspaceId, NATIVE_ID); assert.equal(f.journal.ownedProjects().length, 0)
})

test('authority loss after proof persistence cannot enroll or publish the project', async t => {
  const f = await fixture(t), actual = f.journal
  const observed = { ...actual, async recordNativeProof(id, proof) { const row = await actual.recordNativeProof(id, proof); f.state.generation++; return row } }
  await assert.rejects(f.make({ journal: observed }).register(request(), signal()), code('outcome-unknown'))
  assert.equal(actual.row('register_one').nativeProof.workspaceId, NATIVE_ID); assert.equal(actual.state('register_one').state, 'unknown')
  assert.deepEqual(actual.ownedProjects(), []); assert.equal(f.effects.notified, 0)
})

test('a hidden post-commit receipt and a failing catalog callback never overwrite the actual committed effect', async t => {
  const f = await fixture(t), actual = f.journal
  const observed = { ...actual, async commitWorker(id) { const row = await actual.commitWorker(id); f.state.generation++; return row } }
  await assert.rejects(f.make({ journal: observed }).register(request(), signal()), code('outcome-unknown'))
  assert.equal(actual.state('register_one').state, 'committed'); assert.equal(actual.ownedProjects().length, 1); assert.equal(f.effects.notified, 0)
  const other = await fixture(t)
  const registrar = other.make({ onCommitted() { throw new Error(SECRET) } })
  await assert.rejects(registrar.register(request(), signal()), code('outcome-unknown'))
  assert.equal(other.journal.state('register_one').state, 'committed')
  assert.equal((await registrar.register(request(), signal())).title, 'Public project'); assert.equal(other.effects.register.length, 1)
})

test('unknown without retained native proof stays unknown after restart and never guesses from path existence', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), { canonicalPath: CANONICAL, projectGrant: policy() }); await f.journal.markDispatched('register_one')
  await f.reopen(); f.nativeState.workspaceId = NATIVE_ID
  const registrar = f.make(), publicState = await registrar.reconcile('register_one', signal())
  assert.equal(publicState.state, 'unknown'); assert.equal(f.effects.prepare.length, 0); assert.equal(f.effects.register.length, 0)
  await assert.rejects(registrar.register(request(), signal()), code('outcome-unknown'))
  assert.equal(f.effects.register.length, 0); assert.deepEqual(f.journal.ownedProjects(), [])
})

test('exact retained proof recovers through readonly native preparation and pure journal commit only', async t => {
  const f = await fixture(t)
  f.hooks.register = async input => { f.nativeState.workspaceId = NATIVE_ID; f.state.generation++; return { canonicalPath: input.canonicalPath, workspaceId: NATIVE_ID, title: 'Public project' } }
  await assert.rejects(f.make().register(request(), signal()), code('outcome-unknown'))
  f.state.generation = 2; delete f.hooks.register; await f.reopen()
  const state = await f.make().reconcile('register_one', signal())
  assert.equal(state.state, 'committed'); assert.equal(f.effects.register.length, 1); assert.equal(f.effects.prepare.at(-1).path, CANONICAL)
  for (const value of [RAW, CANONICAL, NATIVE_ID, 'nativeProof', 'projectGrant']) assert.equal(JSON.stringify(state).includes(value), false)
})

test('reconciliation refuses proof retarget and an older authority instead of creating or reenrolling', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), { canonicalPath: CANONICAL, projectGrant: policy() }); await f.journal.markDispatched('register_one')
  await f.journal.recordNativeProof('register_one', { canonicalPath: CANONICAL, workspaceId: NATIVE_ID, title: 'Public project' }); await f.journal.markUnknown('register_one')
  f.hooks.prepare = async () => ({ canonicalPath: '/different-canonical', existingWorkspaceId: NATIVE_ID })
  await assert.rejects(f.make().reconcile('register_one', signal()), code('outcome-unknown'))
  delete f.hooks.prepare; f.state.generation++
  await assert.rejects(f.make().reconcile('register_one', signal()), code('outcome-unknown'))
  assert.equal(f.effects.register.length, 0); assert.deepEqual(f.journal.ownedProjects(), [])
})

test('known native identity or canonical return cannot be replaced after dispatch', async t => {
  for (const proof of [{ canonicalPath: CANONICAL, workspaceId: 'replacement-id', title: 'Public' }, { canonicalPath: '/wrong-canonical', workspaceId: NATIVE_ID, title: 'Public' }]) {
    const f = await fixture(t); f.nativeState.workspaceId = NATIVE_ID
    f.hooks.register = async () => proof
    await assert.rejects(f.make().register(request(), signal()), code('outcome-unknown'))
    assert.equal(f.journal.row('register_one').nativeProof, undefined); assert.equal(f.journal.state('register_one').state, 'unknown')
    assert.deepEqual(f.journal.ownedProjects(), [])
  }
})

test('concurrent same-id read/retry never marks another live dispatch unknown or repeats its effect', async t => {
  const f = await fixture(t), entered = Promise.withResolvers(), release = Promise.withResolvers()
  f.hooks.register = async input => { entered.resolve(); await release.promise; return { canonicalPath: input.canonicalPath, workspaceId: NATIVE_ID, title: 'Public project' } }
  const registrar = f.make(), first = registrar.register(request(), signal())
  try {
    await entered.promise
    await assert.rejects(registrar.register(request(), signal()), code('outcome-unknown'))
    assert.equal(f.journal.state('register_one').state, 'dispatched'); assert.equal(f.effects.register.length, 1)
  } finally { release.resolve(); await first }
  assert.equal(f.journal.state('register_one').state, 'committed')
})

test('native/private errors and arbitrary caller abort reasons never cross the public error or native signal', async t => {
  const f = await fixture(t)
  f.hooks.prepare = async () => { throw new Error(SECRET) }
  await assert.rejects(f.make().register(request(), signal()), error => code('source-unavailable')(error) && !JSON.stringify(error).includes(SECRET) && error.cause === undefined && error.detail === undefined)
  const other = await fixture(t), caller = new AbortController()
  other.hooks.register = async (input, ownedSignal) => {
    caller.abort({ private: SECRET })
    assert.notEqual(ownedSignal, caller.signal); assert.equal(ownedSignal.aborted, true); assert.equal(JSON.stringify(ownedSignal.reason).includes(SECRET), false)
    return { canonicalPath: input.canonicalPath, workspaceId: NATIVE_ID, title: 'Public project' }
  }
  await assert.rejects(other.make().register(request(), caller.signal), code('outcome-unknown'))
  assert.equal(other.journal.row('register_one').nativeProof.workspaceId, NATIVE_ID)
})

test('same canonical native enrollment reuses its opaque project id without broadening old captured policy', async t => {
  const f = await fixture(t), first = await f.make().register(request(), signal())
  f.state.generation = 3; f.state.grantRevision = 2; f.state.grant.revision = 2
  f.state.grant.projectRegistration.projectGrant.actions.push('model.list')
  const secondRequest = { ...request('register_two'), authority: { generation: 3, grantRevision: 2 } }
  const second = await f.make().register(secondRequest, signal())
  assert.deepEqual(second.ref, first.ref); assert.equal(f.journal.ownedProjects().length, 1)
  assert.deepEqual(f.journal.ownedProjects()[0].projectGrant, policy())
  assert.equal(f.journal.row('register_two').reuse, true)
})

test('an accidental asynchronous catalog callback is contained without hanging or losing a committed receipt', async t => {
  const f = await fixture(t)
  await assert.rejects(f.make({ onCommitted: () => Promise.reject(new Error(SECRET)) }).register(request(), signal()), code('outcome-unknown'))
  assert.equal(f.journal.state('register_one').state, 'committed'); assert.equal(f.journal.ownedProjects().length, 1)
})

test('missing current machine permission and foreign owner context fail before any native observation', async t => {
  const f = await fixture(t); delete f.state.grant.projectRegistration
  await assert.rejects(f.make().register(request(), signal()), code('not-granted'))
  f.state.principal.id = 'foreign-controller'
  await assert.rejects(f.make().reconcile('register_one', signal()), code('grant-changed'))
  assert.equal(f.effects.prepare.length, 0); assert.equal(f.effects.register.length, 0)
})
