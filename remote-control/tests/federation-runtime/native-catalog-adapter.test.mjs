import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAdapter } from '../../lib/federation/native-adapter.mjs'

const catalog = { default: { provider: 'worker', model: 'a' }, routableProviders: ['worker'], groups: [], failures: [] }
function fixture() {
  const original = Symbol('original'), calls = { legacy: 0, bounded: [], agents: 0, sandbox: 0 }
  const controller = {
    async modelCatalog() { calls.legacy++; return catalog },
    async sourceModelCatalog(request, signal) { calls.bounded.push({ request, signal }); return catalog },
  }
  let current = controller
  const owner = { ownsSourceCatalogHelper: value => value === controller, ownsSourceMutationHelpers: () => false }
  const native = { llm: {}, session: {}, sandbox: { setSandboxMode() { calls.sandbox++ } }, cordis: { symbols: { original } }, controllerOwner: owner }
  const ctx = {
    get: name => name === 'sessionController' ? current : undefined,
    agents: { get() { calls.agents++; throw new Error('catalog must not activate or inspect an Agent') } },
  }
  return { ctx, native, controller, owner, calls, original, replace(value) { current = value } }
}
const signal = () => new AbortController().signal
const create = (f, budget, settings = {}) => createNativeAdapter({ ctx: f.ctx, native: f.native, settings, modelCatalogProviderTimeoutMs: budget })

for (const value of [0, -0, -1, 1.5, NaN, Infinity, '25', null, 60001]) {
  test(`invalid local provider budget ${String(value)} fails before SDK imports or native work`, async () => {
    await assert.rejects(createNativeAdapter({ ctx: {}, settings: {}, modelCatalogProviderTimeoutMs: value }), { code: 'invalid-message' })
  })
}

test('absent local policy preserves the ordinary catalog method without requiring a new owner', async () => {
  const f = fixture(); delete f.owner.ownsSourceCatalogHelper
  const backend = await create(f, undefined, { modelCatalogProviderTimeoutMs: 1, forceNativeReadiness: true })
  assert.deepEqual(await backend.modelCatalog(signal()), catalog)
  assert.equal(f.calls.legacy, 1)
  assert.equal(f.calls.bounded.length, 0)
  assert.equal(f.calls.agents, 0)
  assert.equal(f.calls.sandbox, 0)
})

test('explicit bounded mode calls only the owned helper with the captured local budget and caller signal', async () => {
  const f = fixture(), options = { ctx: f.ctx, native: f.native, settings: {}, modelCatalogProviderTimeoutMs: 250 }
  const backend = await createNativeAdapter(options), caller = signal()
  options.modelCatalogProviderTimeoutMs = 1
  assert.deepEqual(await backend.modelCatalog(caller, { providerTimeoutMs: 1 }), catalog)
  assert.deepEqual(f.calls.bounded, [{ request: { providerTimeoutMs: 250 }, signal: caller }])
  assert.equal(f.calls.legacy, 0)
  assert.equal(f.calls.agents, 0)
  assert.equal(f.calls.sandbox, 0)
  assert.equal(backend.mutationReadiness, undefined)
})

test('read owner verification stays independent of mutable helper or sandbox-policy readiness', async () => {
  const f = fixture(), backend = await create(f, 1)
  f.owner.ownsSourceMutationHelpers = () => false
  assert.deepEqual(await backend.modelCatalog(signal()), catalog)
  assert.equal(backend.mutationReadiness, undefined)
  assert.equal(f.calls.bounded.length, 1)
  assert.equal(f.calls.sandbox, 0)
})

for (const absent of ['missing verifier', 'rejected instance', 'different owner']) {
  test(`bounded mode refuses ${absent} without falling back to stock or force flags`, async () => {
    const f = fixture()
    if (absent === 'missing verifier') delete f.owner.ownsSourceCatalogHelper
    else if (absent === 'rejected instance') f.owner.ownsSourceCatalogHelper = () => false
    const backend = await create(f, 20, { forceNativeReadiness: true })
    if (absent === 'different owner') f.replace({ ...f.controller })
    await assert.rejects(backend.modelCatalog(signal()), { code: 'action-unsupported' })
    assert.equal(f.calls.legacy, 0)
    assert.equal(f.calls.bounded.length, 0)
  })
}

test('the Cordis original instance is verified while the serving traced facade receives the call', async () => {
  const f = fixture()
  f.replace({ ...f.controller, [f.original]: f.controller })
  const backend = await create(f, 20)
  assert.deepEqual(await backend.modelCatalog(signal()), catalog)
  assert.equal(f.calls.bounded.length, 1)
})

test('a helper owner replaced during a read cannot publish the old catalog', async () => {
  const f = fixture(), pending = Promise.withResolvers()
  f.controller.sourceModelCatalog = async () => pending.promise
  const backend = await create(f, 20), reading = backend.modelCatalog(signal())
  f.replace({ ...f.controller })
  pending.resolve(catalog)
  await assert.rejects(reading, { code: 'source-unavailable' })
  assert.equal(f.calls.legacy, 0)
})

test('caller cancellation is checked before helper dispatch and after its result', async () => {
  const f = fixture(), backend = await create(f, 20), already = new AbortController()
  already.abort()
  await assert.rejects(backend.modelCatalog(already.signal), error => error.name === 'AbortError')
  assert.equal(f.calls.bounded.length, 0)
  const pending = Promise.withResolvers(), caller = new AbortController()
  f.controller.sourceModelCatalog = async (_request, observed) => { assert.equal(observed, caller.signal); return pending.promise }
  const reading = backend.modelCatalog(caller.signal)
  caller.abort(); pending.resolve(catalog)
  await assert.rejects(reading, error => error.name === 'AbortError')
  assert.equal(f.calls.agents, 0)
})

test('both explicit endpoint budgets are accepted without inventing a default', async () => {
  for (const budget of [1, 60000]) {
    const f = fixture(), backend = await create(f, budget)
    await backend.modelCatalog(signal())
    assert.equal(f.calls.bounded[0].request.providerTimeoutMs, budget)
  }
})
