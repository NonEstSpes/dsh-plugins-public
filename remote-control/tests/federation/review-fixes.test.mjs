import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeSessionRef, decodeProjectRef } from '../../lib/federation/identity.mjs'
import { decodeCatalogCursor, buildSourceCatalog } from '../../lib/federation/catalog.mjs'
import { decodeExportCursor, assertOpAllowed, createCapabilities, jsonByteLength } from '../../lib/federation/protocol.mjs'
import { decodePeerOperationKey, decodePeerReportKey, authorizePeerAction, createPeerRouter } from '../../lib/federation/peers.mjs'
import { evaluateGrant, requireReviewedExportClass, assertReviewedExportClasses, EXPORT_CLASSES } from '../../lib/federation/grants.mjs'
import { buildHistoryPage, parseHistoryPage, createHistorySnapshotFrame } from '../../lib/federation/history.mjs'

const principal = { kind: 'controller', id: 'controller_fixture' }
const sessionId = 'session-1'
const grant = () => ({ version: 1, grantId: 'grant_fixture', principal, machineKey: 'worker', revision: 1, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list', 'session.list', 'model.list'], exportClasses: ['conversation.user'], sessions: [{ sessionId, imported: true, actions: ['session.status', 'session.read', 'session.follow', 'model.select'] }] }] })
const event = (seq, text = 'hello') => ({ type: 'user/message', seq, time: seq, surfaceOp: 'append', data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const pageRequest = (extra = {}) => ({ machineKey: 'worker', projectId: 'demo', sessionId, generation: 1, grantRevision: 1, principal, grant: grant(), now: 1, events: [event(0), event(1)], exportClasses: ['conversation.user'], validateNativeEvents: () => {}, ...extra })
const request = () => ({ principal, machineKey: 'worker', projectId: 'demo', sessionId, action: 'session.read', exportClasses: ['conversation.user'] })
const options = { currentRevision: 1, now: 1 }
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)

test('every opaque token decoder rejects oversize before base64 allocation', () => {
  const original = Buffer.from
  let calls = 0
  Buffer.from = (...args) => { calls++; return original(...args) }
  try {
    for (const [decode, prefix] of [[decodeSessionRef, 'fr1s.'], [decodeProjectRef, 'fr1p.'], [decodeCatalogCursor, 'fcc1.'], [decodeExportCursor, 'fec1.'], [decodePeerOperationKey, 'fpo1.'], [decodePeerReportKey, 'fpr1.']]) {
      assert.throws(() => decode(prefix + 'A'.repeat(8192)))
    }
    assert.equal(calls, 0)
  } finally { Buffer.from = original }
})

test('serializer override is forbidden, including apparently safe overrides', () => {
  rejects(() => requireReviewedExportClass('reasoning', ['reasoning']), 'grant/invalid-options')
  rejects(() => assertReviewedExportClasses(['conversation.user'], ['conversation.user']), 'grant/invalid-options')
  rejects(() => evaluateGrant(grant(), { ...request(), exportClasses: Array(EXPORT_CLASSES.length + 1).fill('conversation.user') }, options), 'grant/invalid-request')
})

test('no grant document is denial; peer entry never synthesizes revision zero', () => {
  const router = createPeerRouter([{ machineKey: 'worker', protocol: 2, stateDir: 'fixture', capabilities: createCapabilities() }])
  rejects(() => authorizePeerAction({ router, grants: [], machineKey: 'worker', principal, action: 'session.status', projectId: 'demo', sessionId, grantRevision: 1, now: 1 }), 'grant-changed')
  assert.equal(assertOpAllowed('session.status', createCapabilities()).history, false)
  assert.equal(assertOpAllowed('model.catalog', createCapabilities()).modelSelect, false)
})

test('catalog imported:false is not adopted from matching native inventory', () => {
  const g = grant()
  g.projects[0].sessions[0].imported = false
  const input = { machineKey: 'worker', generation: 1, grantRevision: 1, principal, grant: g, now: 1, projects: [{ projectId: 'demo' }], sessions: [{ sessionId, projectId: 'demo', updatedAt: 1, running: false, blank: false }] }
  assert.equal(buildSourceCatalog(input).sessions.length, 0)
  const proof = { principal, machineKey: 'worker', projectId: 'demo', sessionId, createRequestId: 'create_fixture', state: 'committed' }
  assert.equal(buildSourceCatalog({ ...input, remoteOwnedSessions: [proof] }).sessions.length, 1)
  g.projects[0].actions = []
  const denied = buildSourceCatalog({ ...input, remoteOwnedSessions: [proof] })
  assert.deepEqual(denied.projects, [])
  assert.deepEqual(denied.sessions, [])
})

test('whole history page budget includes cursor/coverage and respects exact-byte boundary', () => {
  const full = buildHistoryPage(pageRequest())
  const exact = jsonByteLength(full)
  assert.equal(jsonByteLength(buildHistoryPage(pageRequest({ maxBytes: exact }))), exact)
  const smaller = buildHistoryPage(pageRequest({ maxBytes: exact - 1 }))
  assert.equal(smaller.hasMore, true)
  assert.ok(jsonByteLength(smaller) <= exact - 1)
  const older = buildHistoryPage(pageRequest({ beforeSeq: smaller.coveredFromSeq }))
  assert.equal(older.coveredThroughSeq + 1, smaller.coveredFromSeq)
  // The cursor follows the fixed cut, not this backwards slice.
  assert.equal(older.exportCursor, full.exportCursor)
})

test('page parser rejects unknown carrier kind and cursor/body authority disagreement', () => {
  const page = buildHistoryPage(pageRequest())
  rejects(() => parseHistoryPage({ ...page, records: [{ type: 'invented', event: event(0) }] }), 'invalid-message')
  for (const patch of [{ generation: 2 }, { grantRevision: 2 }, { throughSeq: 2 }]) rejects(() => parseHistoryPage({ ...page, ...patch }), 'cursor-stale')
  rejects(() => createHistorySnapshotFrame({ page, header: { version: 4, id: sessionId, createdAt: 0, isSeeded: false }, projections: { asOfSeq: 0, values: {} } }), 'history-gap')
})

test('Worker native validator runs before projection, and failures never disclose diagnostics', () => {
  let calls = 0
  const page = buildHistoryPage(pageRequest({ validateNativeEvents: log => { calls++; assert.equal(log.length, 2) } }))
  assert.equal(page.records.length, 2)
  assert.equal(calls, 1)
  assert.throws(() => buildHistoryPage(pageRequest({ validateNativeEvents: () => { throw new Error('SECRET') } })), error => error.code === 'invalid-message' && !error.message.includes('SECRET'))
  rejects(() => buildHistoryPage(pageRequest({ validateNativeEvents: undefined })), 'invalid-message')
})

test('partial redaction lives only in the event carrier and false/unknown flags are refused', () => {
  const mixed = event(0)
  mixed.data.content.push({ type: 'image', attachment: { name: 'SECRET' } })
  const page = buildHistoryPage(pageRequest({ events: [mixed] }))
  assert.equal(page.records[0].redacted, true)
  assert.equal(Object.hasOwn(page.records[0].event, 'redacted'), false)
  assert.equal(JSON.stringify(page).includes('SECRET'), false)
  assert.deepEqual(parseHistoryPage(page), page)
  for (const value of [false, 'true', 1, null]) rejects(() => parseHistoryPage({ ...page, records: [{ ...page.records[0], redacted: value }] }), 'invalid-message')
  rejects(() => parseHistoryPage({ ...page, records: [{ ...page.records[0], streamWithheld: true }] }), 'invalid-message')
})
