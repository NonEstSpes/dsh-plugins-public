import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createModelCatalogAccumulator, projectModelCatalog, projectModelCatalogPage } from '../../lib/federation/catalog.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import { GRANT_CODES } from '../../lib/federation/grants.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS } from '../../lib/federation/protocol.mjs'

const PRINCIPAL = Object.freeze({ kind: 'controller', id: 'controller_abcdef12' })
const SCOPE = Object.freeze({ machineKey: 'worker_abcdef12', projectId: 'demo', sessionId: 'session-abcdef12', generation: 2, grantRevision: 3 })
const SAFE_FAILURE = 'Provider model catalogue is unavailable on the Worker.'
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8')
const digest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
const clone = value => structuredClone(value)

function native(count = 2) {
  return {
    default: { provider: 'provider-a', model: 'model-0', reasoningEffort: 'default' },
    routableProviders: count === 0 ? [] : ['provider-a'],
    groups: [{ id: 'provider-a', name: 'Provider A', models: Array.from({ length: count }, (_, index) => ({
      id: `model-${index}`, name: `Модель 🚀 ${index} ${'名称'.repeat(8)}`,
      reasoning: { efforts: [{ id: 'default', name: 'По умолчанию' }, { id: 'high', name: 'Высокий' }], defaultEffort: 'default' },
    })) }],
    failures: [],
  }
}

function grant(scope = SCOPE) {
  return {
    version: 1, grantId: 'grant_abcdef12', principal: { ...PRINCIPAL }, machineKey: scope.machineKey,
    revision: scope.grantRevision, issuedAt: 1000,
    projects: [{ projectId: scope.projectId, actions: ['project.list', 'model.list'], exportClasses: [], sessions: [] }],
  }
}

function request(modelCatalog = native(), overrides = {}) {
  const value = { ...SCOPE, modelCatalog, principal: PRINCIPAL, now: 2000, ...overrides }
  return { ...value, grant: Object.hasOwn(overrides, 'grant') ? overrides.grant : grant(value) }
}

function legacyRequest(modelCatalog, overrides = {}) {
  const { sessionId, generation, ...value } = request(modelCatalog, overrides)
  return value
}

function pagesFor(modelCatalog = native(200), overrides = {}) {
  const pages = []
  let cursor
  do {
    const page = projectModelCatalogPage(request(modelCatalog, { maxBytes: 4096, ...overrides, ...(cursor === undefined ? {} : { cursor }) }))
    pages.push(page)
    assert.ok(pages.length <= 256, 'fixture must finish within the protocol page limit')
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return pages
}

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && error.code === code)
}

function cursor(scope, catalogId, offset) {
  return 'fmc1.' + Buffer.from(JSON.stringify([scope.machineKey, scope.projectId, scope.sessionId, scope.generation, scope.grantRevision, catalogId, offset]), 'utf8').toString('base64url')
}

function recordPage(catalogId, records, start, totalRecords, scope = SCOPE) {
  const end = start + records.length
  return { scope: { ...scope }, catalogId, default: { provider: 'p', model: 'm' }, start, totalRecords, records,
    ...(end === totalRecords ? {} : { nextCursor: cursor(scope, catalogId, end) }) }
}

test('model pages preserve group/model/effort/failure order and independent routable provider order', () => {
  const value = native()
  value.groups.push({ id: 'empty', name: 'Empty', models: [] }, { id: 'provider-b', name: 'Provider B', models: [{ id: 'shared', name: 'Shared' }] })
  value.routableProviders = ['provider-b', 'provider-a']
  value.failures = [{ id: 'offline', name: 'Offline', message: 'secret token https://private.invalid' }]
  value.groups[0].description = 'secret description'
  value.groups[0].models[0].description = 'secret model metadata'
  value.groups[0].models[0].badge = { text: 'secret badge' }
  value.groups[0].models[0].reasoning.efforts[0].description = 'secret effort metadata'
  const expected = projectModelCatalog(legacyRequest(value))
  const page = projectModelCatalogPage(request(value))
  assert.deepEqual(page.scope, SCOPE)
  assert.equal(page.nextCursor, undefined)
  assert.equal(page.catalogId, digest(expected))
  assert.equal(JSON.stringify(page).includes('secret'), false)
  assert.deepEqual(page.records.filter(row => row.type === 'provider').map(row => [row.id, row.routable, row.routableIndex]), [
    ['provider-a', true, 1], ['empty', false, undefined], ['provider-b', true, 0],
  ])
  const accumulator = createModelCatalogAccumulator(SCOPE)
  assert.equal(accumulator.accept(page), undefined)
  assert.deepEqual(accumulator.result(), expected)
  assert.equal(Object.isFrozen(accumulator.result().groups[0].models[0].reasoning.efforts), true)
  assert.equal(accumulator.result().failures[0].message, SAFE_FAILURE)
})

test('large catalogs round-trip across bounded multibyte pages while legacy remains at 32 KiB', () => {
  const value = native(200)
  assert.ok(bytes(value) > PROTOCOL_LIMITS.maxPageBytes)
  rejects(() => projectModelCatalog(legacyRequest(value)), FAILURE_CODES.PAGE_TOO_LARGE)
  const pages = pagesFor(value)
  assert.ok(pages.length > 1)
  const accumulator = createModelCatalogAccumulator(SCOPE)
  rejects(() => accumulator.result(), FAILURE_CODES.CATALOG_STALE)
  for (const page of pages) {
    assert.ok(bytes(page) <= 4096)
    assert.deepEqual(page.scope, SCOPE)
    assert.equal(accumulator.accept(page), page.nextCursor)
  }
  assert.deepEqual(accumulator.result(), value)
})

test('page budgets include final scope/default metadata and exact UTF-8 bytes, not character length', () => {
  const value = { default: { provider: '提供方🚀', model: 'модель' }, routableProviders: [], groups: [], failures: [] }
  const full = projectModelCatalogPage(request(value))
  assert.ok(bytes(full) > JSON.stringify(full).length)
  assert.deepEqual(projectModelCatalogPage(request(value, { maxBytes: bytes(full) })), full)
  rejects(() => projectModelCatalogPage(request(value, { maxBytes: bytes(full) - 1 })), FAILURE_CODES.PAGE_TOO_LARGE)
  const accumulator = createModelCatalogAccumulator(SCOPE)
  accumulator.accept(full)
  assert.deepEqual(accumulator.result(), value)
})

test('a final page may fit even when an intermediate continuation cursor would not', () => {
  const value = native(1)
  value.groups[0].models = [{ id: 'model-0', name: 'M' }]
  const full = projectModelCatalogPage(request(value))
  const budget = bytes(full)
  assert.ok(bytes({ ...full, records: [full.records[0]], nextCursor: cursor(SCOPE, full.catalogId, 1) }) > budget)
  assert.deepEqual(projectModelCatalogPage(request(value, { maxBytes: budget })), full)
})

test('empty provider groups and fully empty catalogs are complete without synthetic records', () => {
  for (const value of [native(0), { default: { provider: '', model: '' }, routableProviders: [], groups: [], failures: [] }]) {
    const page = projectModelCatalogPage(request(value))
    const accumulator = createModelCatalogAccumulator(SCOPE)
    accumulator.accept(page)
    assert.deepEqual(accumulator.result(), value)
    assert.equal(page.totalRecords, value.groups.length)
  }
})

test('each page rechecks model.list, revocation, grant revision and original ownership context', () => {
  const value = native(30), first = projectModelCatalogPage(request(value, { maxBytes: 1500 }))
  assert.ok(first.nextCursor)
  const denied = grant(); denied.projects[0].actions = ['project.list']
  rejects(() => projectModelCatalogPage(request(value, { cursor: first.nextCursor, grant: denied })), FAILURE_CODES.NOT_GRANTED)
  rejects(() => projectModelCatalogPage(request(value, { cursor: first.nextCursor, grantRevision: 4, grant: grant() })), FAILURE_CODES.NOT_GRANTED)
  rejects(() => projectModelCatalogPage(request(value, { cursor: first.nextCursor, grant: { ...grant(), revokedAt: 1500 } })), FAILURE_CODES.NOT_GRANTED)
  assert.deepEqual(projectModelCatalog(legacyRequest(native(), { remoteOwnedSessions: [] })), native())
  assert.ok(projectModelCatalogPage(request(native(), { remoteOwnedSessions: [] })))
  rejects(() => projectModelCatalogPage(request(native(), { remoteOwnedSessions: 'not-an-inventory' })), GRANT_CODES.INVALID_OPTIONS)
})

for (const [key, next, code] of [
  ['machineKey', 'other-worker', FAILURE_CODES.CURSOR_STALE],
  ['projectId', 'other-project', FAILURE_CODES.CURSOR_STALE],
  ['sessionId', 'other-session', FAILURE_CODES.CURSOR_STALE],
  ['generation', 3, FAILURE_CODES.CATALOG_STALE],
  ['grantRevision', 4, FAILURE_CODES.CATALOG_STALE],
]) {
  test(`model continuation rejects a different ${key} even with identical catalogs`, () => {
    const value = native(30), first = projectModelCatalogPage(request(value, { maxBytes: 1500 }))
    rejects(() => projectModelCatalogPage(request(value, { [key]: next, cursor: first.nextCursor })), code)
  })
  test(`final page without a cursor cannot cross ${key} scope`, () => {
    for (const value of [native(), { default: { provider: 'p', model: 'm' }, routableProviders: [], groups: [], failures: [] }]) {
      const final = clone(projectModelCatalogPage(request(value)))
      final.scope[key] = next
      rejects(() => createModelCatalogAccumulator(SCOPE).accept(final), code)
    }
  })
}

test('cursors reject catalog changes, malformed encodings and out-of-range offsets', () => {
  const value = native(30), first = projectModelCatalogPage(request(value, { maxBytes: 1500 }))
  const changed = clone(value); changed.groups[0].models[0].name = 'Changed'
  rejects(() => projectModelCatalogPage(request(changed, { cursor: first.nextCursor })), FAILURE_CODES.CATALOG_STALE)
  for (const token of ['bad', first.nextCursor + '=', 'fmc1.' + Buffer.from('[]').toString('base64url')]) rejects(() => projectModelCatalogPage(request(value, { cursor: token })), FAILURE_CODES.INVALID_MESSAGE)
  const text = Buffer.from(first.nextCursor.slice(5), 'base64url').toString('utf8')
  const alias = 'fmc1.' + Buffer.from(' ' + text, 'utf8').toString('base64url')
  rejects(() => projectModelCatalogPage(request(value, { cursor: alias })), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => projectModelCatalogPage(request(value, { cursor: cursor(SCOPE, first.catalogId, first.totalRecords) })), FAILURE_CODES.CURSOR_STALE)
})

test('the accumulator refuses missing, repeated, conflicting or incomplete page sequences', () => {
  const pages = pagesFor(native(30), { maxBytes: 1500 })
  assert.ok(pages.length > 2)
  for (const changed of [
    pages[0], pages[2],
    { ...pages[1], totalRecords: pages[1].totalRecords + 1 },
    { ...pages[1], catalogId: 'a'.repeat(64) },
    { ...pages[1], default: { provider: 'other', model: 'other' } },
  ]) {
    const accumulator = createModelCatalogAccumulator(SCOPE)
    accumulator.accept(pages[0])
    rejects(() => accumulator.result(), FAILURE_CODES.CATALOG_STALE)
    rejects(() => accumulator.accept(changed), FAILURE_CODES.CATALOG_STALE)
    rejects(() => accumulator.result(), FAILURE_CODES.CATALOG_STALE)
  }
  const first = clone(pages[0]); delete first.nextCursor
  rejects(() => createModelCatalogAccumulator(SCOPE).accept(first), FAILURE_CODES.CATALOG_STALE)
})

test('hash completion rejects changed valid records and exposes no partial result', () => {
  const page = clone(projectModelCatalogPage(request(native())))
  page.records[1].model.name = 'Tampered but schema-valid'
  const accumulator = createModelCatalogAccumulator(SCOPE)
  rejects(() => accumulator.accept(page), FAILURE_CODES.CATALOG_STALE)
  rejects(() => accumulator.result(), FAILURE_CODES.CATALOG_STALE)
})

test('accepted data is owned by the accumulator, not mutable caller pages or scope objects', () => {
  const scope = { ...SCOPE }, page = clone(projectModelCatalogPage(request(native())))
  const accumulator = createModelCatalogAccumulator(scope)
  accumulator.accept(page)
  scope.machineKey = 'other-worker'
  page.default.model = 'changed'
  page.records[1].model.reasoning.efforts[0].name = 'Changed'
  assert.deepEqual(accumulator.result(), native())
})

test('record ordering, provider/model uniqueness, safe metadata and routable ranks are strict', () => {
  const value = native(1), page = projectModelCatalogPage(request(value))
  const provider = page.records[0], model = page.records[1]
  const failure = { type: 'failure', failure: { id: 'offline', name: 'Offline', message: SAFE_FAILURE } }
  const cases = [
    [model, provider], [provider, model, provider], [provider, model, model],
    [provider, { ...model, providerId: 'wrong-provider' }],
    [provider, model, failure, model], [provider, model, failure, failure],
    [{ ...provider, routableIndex: 1 }, model], [{ ...provider, routable: false }, model],
    [provider, { ...model, model: { ...model.model, description: 'raw metadata' } }],
    [provider, model, { ...failure, failure: { ...failure.failure, message: 'secret raw provider failure' } }],
    [provider, { type: 'unknown' }],
  ]
  for (const records of cases) {
    const changed = { ...page, records, totalRecords: records.length }
    rejects(() => createModelCatalogAccumulator(SCOPE).accept(changed), FAILURE_CODES.INVALID_MESSAGE)
  }
  const duplicateRank = { ...provider, id: 'other-provider', name: 'Other' }
  rejects(() => createModelCatalogAccumulator(SCOPE).accept({ ...page, records: [provider, model, duplicateRank], totalRecords: 3 }), FAILURE_CODES.INVALID_MESSAGE)
})

test('default, record/page bounds and one indivisible oversized model fail visibly', () => {
  for (const maxBytes of [0, -1, PROTOCOL_LIMITS.maxPageBytes + 1]) rejects(() => projectModelCatalogPage(request(native(), { maxBytes })), FAILURE_CODES.PAGE_TOO_LARGE)
  const huge = native(1); huge.groups[0].models[0].name = '界'.repeat(PROTOCOL_LIMITS.maxPageBytes)
  rejects(() => projectModelCatalogPage(request(huge)), FAILURE_CODES.PAGE_TOO_LARGE)
  const many = native(0); many.groups = Array.from({ length: 65537 }, (_, index) => ({ id: `p${index}`, name: 'P', models: [] }))
  rejects(() => projectModelCatalogPage(request(many)), FAILURE_CODES.PAGE_TOO_LARGE)
  const large = native(0); large.groups[0].name = 'x'.repeat(4 * 1024 * 1024)
  rejects(() => projectModelCatalogPage(request(large)), FAILURE_CODES.PAGE_TOO_LARGE)
  const invalid = clone(projectModelCatalogPage(request(native())))
  invalid.totalRecords = 65537
  rejects(() => createModelCatalogAccumulator(SCOPE).accept(invalid), FAILURE_CODES.PAGE_TOO_LARGE)
  const repeatedProviderId = 'p'.repeat(10000)
  const expanded = native(1000); expanded.groups[0].id = repeatedProviderId; expanded.routableProviders = [repeatedProviderId]
  rejects(() => projectModelCatalogPage(request(expanded)), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('the accumulator cannot consume more than 256 small valid continuation pages', () => {
  const groups = Array.from({ length: 257 }, (_, index) => ({ id: `p${index}`, name: 'P', models: [] }))
  const value = { default: { provider: 'p', model: 'm' }, routableProviders: [], groups, failures: [] }
  const catalogId = digest(value), accumulator = createModelCatalogAccumulator(SCOPE)
  for (let index = 0; index < 256; index++) accumulator.accept(recordPage(catalogId, [{ type: 'provider', id: groups[index].id, name: 'P', routable: false }], index, 257))
  rejects(() => accumulator.accept(recordPage(catalogId, [{ type: 'provider', id: 'p256', name: 'P', routable: false }], 256, 257)), FAILURE_CODES.PAGE_TOO_LARGE)
  rejects(() => accumulator.result(), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('the accumulator enforces the normalized 4 MiB bound before exposing a catalog', () => {
  const accumulator = createModelCatalogAccumulator(SCOPE), catalogId = 'a'.repeat(64)
  accumulator.accept(recordPage(catalogId, [{ type: 'provider', id: 'p', name: 'P', routable: false }], 0, 190))
  let rejected = false
  for (let index = 1; index < 190; index++) {
    const page = recordPage(catalogId, [{ type: 'model', providerId: 'p', model: { id: `m${index}`, name: 'x'.repeat(24000) } }], index, 190)
    try { accumulator.accept(page) } catch (error) {
      assert.equal(error.code, FAILURE_CODES.PAGE_TOO_LARGE)
      rejected = true
      break
    }
  }
  assert.equal(rejected, true)
  rejects(() => accumulator.result(), FAILURE_CODES.PAGE_TOO_LARGE)
})
