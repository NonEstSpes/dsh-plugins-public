import assert from 'node:assert/strict'
import test from 'node:test'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import { projectModelCatalog, projectModelCatalogPage } from '../../lib/federation/catalog.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import { FEDERATION_FEATURES, PROTOCOL_LIMITS, jsonByteLength, encodeExportCursor } from '../../lib/federation/protocol.mjs'

const REF = { machineKey: 'worker-fixture', projectId: 'demo', sessionId: 'session-fixture' }
const PRINCIPAL = { kind: 'controller', id: 'controller-fixture' }
const SECRET = 'Bearer private-token C:\\Users\\Private\\secret.json'
class TestRemoteError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details } }
const grant = revision => ({ version: 1, grantId: 'grant_fixture', principal: PRINCIPAL, machineKey: REF.machineKey, revision, issuedAt: 0,
  projects: [{ projectId: REF.projectId, actions: ['project.list', 'model.list'], exportClasses: [], sessions: [] }] })
function catalog(count = 2) {
  return { default: { provider: 'worker', model: 'm-0', reasoningEffort: 'moderate' }, routableProviders: ['worker'], failures: [],
    groups: [{ id: 'worker', name: 'Worker', models: Array.from({ length: count }, (_, i) => ({ id: `m-${i}`, name: `Model ${i} ${'模型Ж'.repeat(16)}`,
      reasoning: { efforts: [{ id: 'moderate', name: 'Moderate' }, { id: 'max', name: 'Maximum' }], defaultEffort: 'moderate' } })) }] }
}
async function bench(features, native = catalog()) {
  const state = { features: arguments.length === 0 ? [FEDERATION_FEATURES.MODEL_CATALOG_PAGES] : features, native, authority: { generation: 1, grantRevision: 1 } }, calls = []
  const context = () => ({ modelCatalog: state.native, grant: grant(state.authority.grantRevision), machineKey: REF.machineKey,
    principal: PRINCIPAL, projectId: REF.projectId, grantRevision: state.authority.grantRevision, now: 1 })
  const handlers = {
    hello: async () => ({ protocol: 2, machine: { label: 'Worker' }, ...(state.features === undefined ? {} : { features: state.features }) }),
    'model.catalog': async () => projectModelCatalog(context()),
    'model.catalog.page': async args => {
      if (JSON.stringify(args.expectedAuthority) !== JSON.stringify(state.authority)) throw new FederationContractError('grant-changed', SECRET)
      return projectModelCatalogPage({ ...context(), sessionId: args.ref.sessionId, generation: state.authority.generation,
        maxBytes: 4096, ...(args.cursor === undefined ? {} : { cursor: args.cursor }) })
    },
  }
  const runtime = {
    authority: () => ({ ...state.authority }), mutationsReady: () => false,
    async call(machineKey, op, args, signal, id) {
      assert.equal(machineKey, REF.machineKey)
      signal?.throwIfAborted()
      calls.push({ op, args: structuredClone(args), signal, id })
      if (!handlers[op]) throw new FederationContractError('action-unsupported', SECRET)
      const value = await handlers[op](args, signal, id)
      signal?.throwIfAborted()
      return value
    },
  }
  const provider = await createHostProvider({ runtime, pair: { machineKey: REF.machineKey }, RemoteError: TestRemoteError })
  return { state, calls, handlers, provider, runtime }
}
const signal = () => new AbortController().signal

function binding(b) {
  return { ref: REF, ...b.state.authority, capabilities: { history: true }, includeAssistantStream: false }
}

test('old provider bind remains legacy even when another browser requests native details', async () => {
  const b = await bench([FEDERATION_FEATURES.SESSION_DETAILS])
  b.handlers['session.bind'] = async () => binding(b)
  b.handlers['session.bind.details'] = async () => binding(b)
  const legacy = await b.provider.bind(REF, signal())
  const detailed = await b.provider.details.bind(REF, signal())
  const otherLegacy = await b.provider.bind(REF, signal())
  assert.equal(legacy.nativeDetails, undefined)
  assert.equal(detailed.nativeDetails, true)
  assert.equal(otherLegacy.nativeDetails, undefined)
  assert.deepEqual(b.calls.map(call => call.op), ['session.bind', 'hello', 'session.bind.details', 'session.bind'])
  assert.equal(detailed.generation, legacy.generation)
  assert.equal(detailed.grantRevision, legacy.grantRevision)
})

for (const features of [undefined, [], ['native-details-v2']]) {
  test(`a detailed browser binds legacy when the Worker does not advertise its exact format: ${JSON.stringify(features)}`, async () => {
    const b = await bench(features)
    b.handlers['session.bind'] = async () => binding(b)
    assert.equal((await b.provider.details.bind(REF, signal())).nativeDetails, undefined)
    assert.deepEqual(b.calls.map(call => call.op), ['hello', 'session.bind'])
  })
}

test('detailed negotiation captures the exact source ref before yielding', async () => {
  const b = await bench([FEDERATION_FEATURES.SESSION_DETAILS]), gate = Promise.withResolvers()
  b.handlers.hello = () => gate.promise
  b.handlers['session.bind.details'] = async () => binding(b)
  const requested = { ...REF }
  const pending = b.provider.details.bind(requested, signal())
  requested.projectId = 'different-project'
  gate.resolve({ protocol: 2, machine: { label: 'Worker' }, features: [FEDERATION_FEATURES.SESSION_DETAILS] })
  await pending
  assert.deepEqual(b.calls.at(-1).args.ref, REF)
  assert.equal(requested.projectId, 'different-project')
})

test('an advertised but refused detailed bind never falls back to legacy', async () => {
  const b = await bench([FEDERATION_FEATURES.SESSION_DETAILS])
  b.handlers['session.bind'] = async () => binding(b)
  b.handlers['session.bind.details'] = async () => { throw new FederationContractError('action-unsupported', SECRET) }
  await assert.rejects(b.provider.details.bind(REF, signal()), error => error.code === 'session-source/action-unsupported' && !error.message.includes(SECRET))
  assert.deepEqual(b.calls.map(call => call.op), ['hello', 'session.bind.details'])
})

test('detailed history uses only detailed operations while the base face remains legacy', async () => {
  const b = await bench([FEDERATION_FEATURES.SESSION_DETAILS])
  const page = format => ({ generation: 1, grantRevision: 1, records: [], throughSeq: -1,
    coveredFromSeq: null, coveredThroughSeq: null, hasMore: false,
    exportCursor: encodeExportCursor({ ...REF, generation: 1, grantRevision: 1, throughSeq: -1, beforeSeq: 0,
      ...(format === undefined ? {} : { format }) }),
  })
  b.handlers['session.read'] = async () => page()
  b.handlers['session.read.details'] = async () => page('native-details-v1')
  const detailed = await b.provider.details.historyPage(REF, { maxMessages: 10 }, signal())
  const legacy = await b.provider.historyPage(REF, { maxMessages: 10 }, signal())
  assert.equal(detailed.exportCursor.startsWith('fec2.'), true)
  assert.equal(legacy.exportCursor.startsWith('fec1.'), true)
  assert.equal(detailed.generation, legacy.generation)
  assert.deepEqual(b.calls.map(call => call.op), ['session.read.details', 'session.read'])
  for (const call of b.calls) assert.deepEqual(call.args.expectedAuthority, b.state.authority)
})

test('the complete mapped source page accepts its exact multibyte byte limit and refuses one more byte', async () => {
  const b = await bench(), version = { generation: 1, grantRevision: 1 }
  let text = ''
  b.handlers['session.read'] = async () => ({ ...version, throughSeq: 0, coveredFromSeq: 0, coveredThroughSeq: 0, hasMore: false,
    exportCursor: encodeExportCursor({ ...REF, ...version, throughSeq: 0, beforeSeq: 1 }),
    records: [{ type: 'event', event: { seq: 0, time: 0, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text }] } } }],
  })
  const empty = await b.provider.historyPage(REF, {}, signal())
  const room = PROTOCOL_LIMITS.maxFrameBytes - jsonByteLength(empty)
  text = 'Ж'.repeat(Math.floor(room / 2)) + (room % 2 === 1 ? 'x' : '')
  const exact = await b.provider.historyPage(REF, {}, signal())
  assert.equal(jsonByteLength(exact), PROTOCOL_LIMITS.maxFrameBytes)
  text += 'x'
  await assert.rejects(b.provider.historyPage(REF, {}, signal()), error => error.message.startsWith('session.read: page-too-large.'))
})

test('one cancelled detailed negotiation does not cancel another browser bind', async () => {
  const b = await bench([FEDERATION_FEATURES.SESSION_DETAILS]), gate = Promise.withResolvers()
  b.handlers.hello = () => gate.promise
  b.handlers['session.bind.details'] = async () => binding(b)
  const first = new AbortController(), second = new AbortController()
  const stopped = b.provider.details.bind(REF, first.signal), survivor = b.provider.details.bind(REF, second.signal)
  const rejected = assert.rejects(stopped, error => error.message.includes('cancelled'))
  first.abort(); await rejected
  gate.resolve({ protocol: 2, machine: { label: 'Worker' }, features: [FEDERATION_FEATURES.SESSION_DETAILS] })
  assert.equal((await survivor).nativeDetails, true)
  assert.deepEqual(b.calls.map(call => call.op), ['hello', 'session.bind.details'])
})

test('provider negotiates before atomically returning a full model catalog larger than one frame', async () => {
  const native = catalog(140), b = await bench(undefined, native)
  assert.ok(jsonByteLength(native) > PROTOCOL_LIMITS.maxFrameBytes)
  await assert.rejects(b.provider.modelCatalog(REF, signal()), error => error.code === 'session-source/source-unavailable' && error.message.includes('model.catalog: page-too-large'))
  b.calls.length = 0
  b.state.features = [FEDERATION_FEATURES.MODEL_CATALOG_PAGES]
  const result = await b.provider.modelCatalog(REF, signal())
  assert.deepEqual(result, native)
  assert.equal(b.calls[0].op, 'hello')
  assert.equal(b.calls.some(call => call.op === 'model.catalog'), false)
  assert.ok(b.calls.filter(call => call.op === 'model.catalog.page').length > 1)
  for (const call of b.calls.filter(call => call.op === 'model.catalog.page')) {
    assert.deepEqual(call.args.ref, REF)
    assert.deepEqual(call.args.expectedAuthority, { generation: 1, grantRevision: 1 })
  }
  assert.equal(b.provider.mutationReadiness, undefined, 'features do not attest mutation readiness')
})

for (const features of [undefined, [], ['model-catalog-pages-v2', 'future-data-v1']]) {
  test(`legacy or unknown-only manifest ${JSON.stringify(features)} stays on the old read without local fallback`, async () => {
    const b = await bench(features)
    assert.deepEqual(await b.provider.modelCatalog(REF, signal()), b.state.native)
    assert.deepEqual(b.calls.map(call => call.op), ['hello', 'model.catalog'])
  })
}

for (const malformed of [null, {}, ['model-catalog-pages-v1', 'model-catalog-pages-v1'], ['SECRET?token=private']]) {
  test(`malformed hello manifest ${JSON.stringify(malformed)} fails before inventory calls`, async () => {
    const b = await bench(malformed)
    await assert.rejects(b.provider.modelCatalog(REF, signal()), error => error.code === 'session-source/source-unavailable'
      && error.message.startsWith('hello: invalid-message.') && !error.message.includes('private'))
    assert.deepEqual(b.calls.map(call => call.op), ['hello'])
  })
}

test('an advertised but refused page operation is not silently downgraded to legacy', async () => {
  const b = await bench()
  b.handlers['model.catalog.page'] = async () => { throw new FederationContractError('action-unsupported', SECRET) }
  await assert.rejects(b.provider.modelCatalog(REF, signal()), error => error.code === 'session-source/action-unsupported'
    && error.message.startsWith('model.catalog.page: action-unsupported.') && !error.message.includes(SECRET))
  assert.deepEqual(b.calls.map(call => call.op), ['hello', 'model.catalog.page'])
})

test('shared hello lets one reader cancel without canceling another reader or leaving a pinned legacy feature', async () => {
  const b = await bench(), gate = Promise.withResolvers()
  b.handlers.hello = () => gate.promise
  const first = new AbortController(), second = new AbortController()
  const stopped = b.provider.modelCatalog(REF, first.signal), survivor = b.provider.modelCatalog(REF, second.signal)
  const rejected = assert.rejects(stopped, error => error.message.startsWith('hello: cancelled.'))
  first.abort(); await rejected
  assert.equal(b.calls.length, 1)
  assert.equal(b.calls[0].signal, undefined, 'one UI reader must not own the shared transport signal')
  gate.resolve({ protocol: 2, machine: { label: 'Worker' }, features: [FEDERATION_FEATURES.MODEL_CATALOG_PAGES] })
  assert.deepEqual(await survivor, b.state.native)
  b.handlers.hello = async () => ({ protocol: 2, machine: { label: 'Legacy after reconnect' } })
  const before = b.calls.length
  assert.deepEqual(await b.provider.modelCatalog(REF, signal()), b.state.native)
  assert.deepEqual(b.calls.slice(before).map(call => call.op), ['hello', 'model.catalog'])
})

test('catalog calls capture immutable source identity before awaiting negotiation', async () => {
  const b = await bench(), gate = Promise.withResolvers(), mutable = { ...REF }
  b.handlers.hello = () => gate.promise
  const loading = b.provider.modelCatalog(mutable, signal())
  mutable.projectId = 'other'; mutable.sessionId = 'different'
  gate.resolve({ protocol: 2, machine: {}, features: [FEDERATION_FEATURES.MODEL_CATALOG_PAGES] })
  assert.deepEqual(await loading, b.state.native)
  assert.deepEqual(b.calls.find(call => call.op === 'model.catalog.page').args.ref, REF)
  const count = b.calls.length
  await assert.rejects(b.provider.modelCatalog({ ...REF, machineKey: 'another-worker' }, signal()), { code: 'session-source/source-unavailable' })
  assert.equal(b.calls.length, count)
})

test('authority change after the first page refuses the sequence with its original captured authority', async () => {
  const b = await bench([FEDERATION_FEATURES.MODEL_CATALOG_PAGES], catalog(140))
  const page = b.handlers['model.catalog.page']
  let pages = 0
  b.handlers['model.catalog.page'] = async args => {
    const result = await page(args)
    if (++pages === 1) b.state.authority = { generation: 2, grantRevision: 2 }
    return result
  }
  await assert.rejects(b.provider.modelCatalog(REF, signal()), error => error.code === 'session-source/grant-changed'
    && error.message.startsWith('model.catalog.page: grant-changed.'))
  assert.ok(b.calls.filter(call => call.op === 'model.catalog.page').length > 1)
  for (const call of b.calls.filter(call => call.op === 'model.catalog.page')) assert.deepEqual(call.args.expectedAuthority, { generation: 1, grantRevision: 1 })
  assert.equal(b.calls.some(call => call.op === 'model.catalog'), false)
})

for (const corrupt of [
  page => { page.scope.sessionId = 'other-session' },
  page => { page.records[0].name = 'tampered' },
  page => { delete page.scope },
]) {
  test('foreign or corrupt complete pages never publish a partial or re-labelled inventory', async () => {
    const b = await bench(), page = b.handlers['model.catalog.page']
    b.handlers['model.catalog.page'] = async args => { const value = structuredClone(await page(args)); corrupt(value); return value }
    await assert.rejects(b.provider.modelCatalog(REF, signal()), error => ['session-source/source-unavailable', 'session-source/grant-changed'].includes(error.code))
    assert.equal(b.calls.some(call => call.op === 'model.catalog'), false)
  })
}

test('provider failures remain sanitized while successful groups and complete efforts are retained', async () => {
  const native = catalog(), b = await bench([FEDERATION_FEATURES.MODEL_CATALOG_PAGES], { ...native, failures: [{ id: 'bad', name: 'Failed provider', message: SECRET }] })
  const result = await b.provider.modelCatalog(REF, signal())
  assert.deepEqual(result.groups, native.groups)
  assert.deepEqual(result.failures, [{ id: 'bad', name: 'Failed provider', message: 'Provider model catalogue is unavailable on the Worker.' }])
  assert.equal(JSON.stringify(result).includes(SECRET), false)
})

test('read deadline and caller cancellation stay distinct through the provider', async () => {
  for (const failure of [new FederationContractError('request-timeout', SECRET), new DOMException(SECRET, 'AbortError')]) {
    const b = await bench()
    b.handlers['model.catalog.page'] = async () => { throw failure }
    await assert.rejects(b.provider.modelCatalog(REF, signal()), error => error.code === 'session-source/source-unavailable'
      && error.message.startsWith(`model.catalog.page: ${failure.name === 'AbortError' ? 'cancelled' : 'request-timeout'}.`)
      && !error.message.includes(SECRET))
  }
})

for (const [code, endpoint, reason] of [
  ['OUTBOX_CAPACITY', 'session-source/source-unavailable', 'local-outbox-full'],
  ['INBOX_CAPACITY', 'session-source/source-unavailable', 'local-inbox-full'],
  ['request-timeout', 'session-source/source-unavailable', 'request-timeout'],
  ['not-granted', 'session-source/source-unavailable', 'not-granted'],
  ['page-too-large', 'session-source/source-unavailable', 'page-too-large'],
  ['invalid-message', 'session-source/source-unavailable', 'invalid-message'],
  ['cursor-stale', 'session-source/grant-changed', 'cursor-stale'],
  ['outcome-unknown', 'session/outcome-unknown', 'outcome-unknown'],
  ['selection-conflict', 'session/selection-conflict', 'selection-conflict'],
]) {
  test(`nested bind catches retain the trusted ${code} diagnostic and original stage`, async () => {
    for (const detailed of [false, true]) {
      const b = await bench([FEDERATION_FEATURES.SESSION_DETAILS]), created = []
      class ObservedRemoteError extends TestRemoteError {
        constructor(...args) { super(...args); created.push(this) }
      }
      const provider = await createHostProvider({ runtime: b.runtime, pair: { machineKey: REF.machineKey }, RemoteError: ObservedRemoteError })
      const op = detailed ? 'session.bind.details' : 'session.bind'
      b.handlers[op] = async () => { throw Object.assign(new Error(SECRET), { code, details: { secret: SECRET }, cause: new Error(SECRET), path: SECRET, key: SECRET }) }
      await assert.rejects(detailed ? provider.details.bind(REF, signal()) : provider.bind(REF, signal()), error => {
        assert.equal(error.code, endpoint)
        assert.ok(error.message.startsWith(`${op}: ${reason}. `), error.message)
        assert.ok(Buffer.byteLength(error.message, 'utf8') < 200)
        assert.equal(error.message.includes(SECRET), false)
        assert.deepEqual(error.details, {})
        assert.deepEqual(created, [error], 'only the provider-minted error identity survives the outer catch')
        return true
      })
    }
  })
}

test('forged RemoteError objects are statically sanitized instead of trusted by class or message', async () => {
  const b = await bench()
  for (const code of ['session-source/source-unavailable', 'OUTBOX_CAPACITY', 'request-timeout', 'untrusted-code']) {
    const forged = new TestRemoteError(code, `session.bind: request-timeout. ${SECRET}`, { code: 'OUTBOX_CAPACITY', secret: SECRET })
    forged.cause = { code: 'outcome-unknown', message: SECRET }
    b.handlers['session.bind'] = async () => { throw forged }
    const reason = code === 'OUTBOX_CAPACITY' ? 'local-outbox-full' : code === 'request-timeout' ? 'request-timeout' : 'source-unavailable'
    await assert.rejects(b.provider.bind(REF, signal()), error => {
      assert.notEqual(error, forged)
      assert.equal(error.code, 'session-source/source-unavailable')
      assert.ok(error.message.startsWith(`session.bind: ${reason}. `), error.message)
      assert.equal(error.message.includes(SECRET), false)
      assert.deepEqual(error.details, {})
      return true
    })
  }
})

test('safe errors minted by another provider do not carry trusted provenance', async () => {
  const b = await bench()
  b.handlers['session.bind'] = async () => { throw new FederationContractError('request-timeout', SECRET) }
  let otherError
  await assert.rejects(b.provider.bind(REF, signal()), error => { otherError = error; return true })
  const provider = await createHostProvider({ runtime: b.runtime, pair: { machineKey: REF.machineKey }, RemoteError: TestRemoteError })
  b.handlers['session.bind'] = async () => { throw otherError }
  await assert.rejects(provider.bind(REF, signal()), error => {
    assert.notEqual(error, otherError)
    assert.equal(error.message, 'session.bind: source-unavailable. The remote source is unavailable.')
    return true
  })
})

test('nested bind catches retain cancellation precedence except for mutation and selection locks', async () => {
  const b = await bench()
  for (const [code, endpoint, reason] of [
    ['OUTBOX_CAPACITY', 'session-source/source-unavailable', 'cancelled'],
    ['request-timeout', 'session-source/source-unavailable', 'cancelled'],
    ['outcome-unknown', 'session/outcome-unknown', 'outcome-unknown'],
    ['selection-conflict', 'session/selection-conflict', 'selection-conflict'],
  ]) {
    b.handlers['session.bind'] = async () => { throw Object.assign(new Error(SECRET), { code, name: 'AbortError' }) }
    await assert.rejects(b.provider.bind(REF, signal()), error => {
      assert.equal(error.code, endpoint)
      assert.ok(error.message.startsWith(`session.bind: ${reason}. `), error.message)
      assert.equal(error.message.includes(SECRET), false)
      return true
    })
  }
})

test('bind never reads arbitrary RemoteError message, details, cause, path or key', async () => {
  const b = await bench(), inspected = [], forged = new TestRemoteError('OUTBOX_CAPACITY', SECRET, {})
  for (const field of ['message', 'details', 'cause', 'path', 'key']) {
    Object.defineProperty(forged, field, { get() { inspected.push(field); throw new Error(SECRET) } })
  }
  b.handlers['session.bind'] = async () => { throw forged }
  await assert.rejects(b.provider.bind(REF, signal()), error => {
    assert.equal(error.message, 'session.bind: local-outbox-full. The local transport outbox is full.')
    assert.deepEqual(inspected, [])
    return true
  })
})

test('model mutation errors preserve retained request ID and unknown lock despite new diagnostics', async () => {
  const b = await bench(), id = 'retained_model_operation'
  b.handlers['model.state'] = async () => ({ generation: 1, frontierSeq: 0, selection: b.state.native.default })
  b.handlers['model.select'] = async () => { throw new FederationContractError('outcome-unknown', SECRET) }
  const expected = await b.provider.modelState(REF, signal())
  await assert.rejects(b.provider.modelSelect(REF, { expected, selection: b.state.native.default, requestId: id }, signal()), error => error.code === 'session/outcome-unknown'
    && error.message.startsWith('model.select: outcome-unknown.') && !error.message.includes(SECRET))
  const selected = b.calls.find(call => call.op === 'model.select')
  assert.equal(selected.id, id)
  assert.deepEqual(selected.args.request.expected, { generation: 1, frontierSeq: 0, selection: b.state.native.default })
})
