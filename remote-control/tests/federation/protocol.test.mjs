import assert from 'node:assert/strict'
import test from 'node:test'

import { FederationContractError } from '../../lib/federation/identity.mjs'
import {
  FAILURE_CODES,
  FEDERATION_FEATURES,
  FEDERATION_PROTOCOL_VERSION,
  NATIVE_HISTORY_FORMATS,
  PROTOCOL_LIMITS,
  PROTOCOL_OPS,
  assertCapability,
  assertOpAllowed,
  createCapabilities,
  createEnd,
  createFailure,
  createFailureResponse,
  createFrame,
  createRequest,
  createResponse,
  decodeExportCursor,
  encodeExportCursor,
  jsonByteLength,
  parseCapabilities,
  parseFailure,
  parseFeatureManifest,
  parseProtocolMessage,
} from '../../lib/federation/protocol.mjs'

// Synthetic identities; not identifiers from an installed deployment.
const MACHINE = 'worker_fixture_0001'
const PROJECT = 'demo'
const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const REQUEST = 'request_012345'
const OPTS = { machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION, generation: 1, grantRevision: 3, throughSeq: 5, beforeSeq: 0 }

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && error.code === code)
}

test('protocol exposes v2 version, operation and failure vocabulary', () => {
  assert.equal(FEDERATION_PROTOCOL_VERSION, 2)
  assert.ok(Object.isFrozen(PROTOCOL_OPS))
  assert.ok(PROTOCOL_OPS.includes('session.read'))
  assert.ok(PROTOCOL_OPS.includes('model.select'))
  assert.ok(Object.isFrozen(FAILURE_CODES))
  assert.equal(FAILURE_CODES.HISTORY_GAP, 'history-gap')
  assert.ok(PROTOCOL_LIMITS.maxPayloadBytes < 59 * 1024)
})

test('optional feature manifests keep legacy and future peers additive without granting mutations', () => {
  assert.deepEqual(parseFeatureManifest(undefined), [])
  assert.deepEqual(parseFeatureManifest([]), [])
  const advertised = [FEDERATION_FEATURES.MODEL_CATALOG_PAGES, 'model-catalog-pages-v2', 'future-data-v1']
  const observed = parseFeatureManifest(advertised)
  assert.deepEqual(observed, [FEDERATION_FEATURES.MODEL_CATALOG_PAGES])
  advertised[0] = 'different-v1'
  assert.deepEqual(observed, [FEDERATION_FEATURES.MODEL_CATALOG_PAGES])
  assert.ok(Object.isFrozen(observed))
  assert.equal(assertOpAllowed('model.catalog.page', createCapabilities()).modelSelect, false)
  assert.deepEqual(createRequest({ requestId: REQUEST, op: 'hello' }).args, {}, 'hello requests stay compatible with the legacy exact empty arguments')
})

test('feature manifest parser rejects malformed, duplicate or unbounded metadata without echoing it', () => {
  for (const features of [null, {}, 'model-catalog-pages-v1', [null], [1], [''], ['bad feature'], ['SECRET\\nTOKEN'],
    ['x'.repeat(PROTOCOL_LIMITS.maxFeatureNameLength + 1)], Array(PROTOCOL_LIMITS.maxFeatureNames + 1).fill('one-v1'),
    ['one-v1', 'one-v1']]) rejects(() => parseFeatureManifest(features), FAILURE_CODES.INVALID_MESSAGE)
  assert.throws(() => parseFeatureManifest(['SECRET?token=private']), error => error.code === FAILURE_CODES.INVALID_MESSAGE && !error.message.includes('private'))
})

test('model catalog pages use ordinary bounded read request and response envelopes', () => {
  const args = { ref: { machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION }, expectedAuthority: { generation: 1, grantRevision: 3 }, cursor: 'opaque-cursor' }
  const request = createRequest({ requestId: REQUEST, op: 'model.catalog.page', args })
  assert.deepEqual(parseProtocolMessage(request), request)
  const response = createResponse({ requestId: REQUEST, op: request.op, result: { authority: { generation: 1, grantRevision: 3 }, value: {} } })
  assert.deepEqual(parseProtocolMessage(response), response)
  rejects(() => createRequest({ requestId: REQUEST, op: request.op, args: { oversized: '界'.repeat(PROTOCOL_LIMITS.maxPayloadBytes) } }), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('native-detail cursors bind the export interpretation without changing legacy bytes', () => {
  const legacy = encodeExportCursor(OPTS), details = encodeExportCursor({ ...OPTS, format: NATIVE_HISTORY_FORMATS.DETAILS })
  assert.equal(legacy, 'fec1.' + Buffer.from(JSON.stringify(Object.values(OPTS))).toString('base64url'))
  assert.ok(details.startsWith('fec2.'))
  assert.deepEqual(decodeExportCursor(legacy, { format: NATIVE_HISTORY_FORMATS.LEGACY }), OPTS)
  assert.deepEqual(decodeExportCursor(details, { ...OPTS, format: NATIVE_HISTORY_FORMATS.DETAILS }), { ...OPTS, format: NATIVE_HISTORY_FORMATS.DETAILS })
  rejects(() => decodeExportCursor(details, { format: NATIVE_HISTORY_FORMATS.LEGACY }), FAILURE_CODES.CURSOR_STALE)
  rejects(() => decodeExportCursor(legacy, { format: NATIVE_HISTORY_FORMATS.DETAILS }), FAILURE_CODES.CURSOR_STALE)
  rejects(() => decodeExportCursor(details, { machineKey: 'other-machine' }), FAILURE_CODES.CURSOR_STALE)
  rejects(() => decodeExportCursor(details, { grantRevision: OPTS.grantRevision + 1 }), FAILURE_CODES.CURSOR_STALE)
  rejects(() => encodeExportCursor({ ...OPTS, format: 'native-details-v2' }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => encodeExportCursor({ ...OPTS, format: 'legacy' }), FAILURE_CODES.INVALID_MESSAGE)
  for (const tuple of [Object.values(OPTS), [...Object.values(OPTS), 'native-details-v2'], [...Object.values(OPTS), NATIVE_HISTORY_FORMATS.DETAILS, 'extra']]) {
    rejects(() => decodeExportCursor('fec2.' + Buffer.from(JSON.stringify(tuple)).toString('base64url')), FAILURE_CODES.INVALID_MESSAGE)
  }
})

test('capabilities default deny and strict-parse', () => {
  const empty = createCapabilities()
  assert.equal(empty.history, false)
  assert.equal(Object.isFrozen(empty), true)
  const history = createCapabilities({ history: true })
  assert.equal(history.history, true)
  assert.equal(history.prompt, false)

  assert.equal(parseCapabilities(history).history, true)
  rejects(() => parseCapabilities({ history: true }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => createCapabilities({ unknownCapability: true }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => createCapabilities({ history: 'yes' }), FAILURE_CODES.INVALID_MESSAGE)

  assert.equal(assertCapability(history, 'history').history, true)
  rejects(() => assertCapability(history, 'prompt'), FAILURE_CODES.ACTION_UNSUPPORTED)
  assert.equal(assertOpAllowed('session.read', history).history, true)
  rejects(() => assertOpAllowed('session.read', empty), FAILURE_CODES.ACTION_UNSUPPORTED)
  rejects(() => assertOpAllowed('model.select', empty), FAILURE_CODES.ACTION_UNSUPPORTED)
  assert.equal(assertOpAllowed('hello', empty).history, false)
  rejects(() => assertOpAllowed('nonexistent.op', history), FAILURE_CODES.ACTION_UNSUPPORTED)
})

test('request/response messages are canonical, bounded, and strict', () => {
  const request = createRequest({ requestId: REQUEST, op: 'catalog', args: { cursor: null } })
  assert.equal(request.protocol, 2)
  assert.equal(request.type, 'request')
  assert.deepEqual(parseProtocolMessage(request), request)
  rejects(() => createRequest({ requestId: 'short', op: 'catalog' }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => createRequest({ requestId: REQUEST, op: 'not-an-op' }), FAILURE_CODES.ACTION_UNSUPPORTED)
  rejects(() => createRequest({ requestId: REQUEST, op: 'catalog', args: { value: Number.NaN } }), FAILURE_CODES.INVALID_MESSAGE)
  const cyclic = {}
  cyclic.self = cyclic
  rejects(() => createRequest({ requestId: REQUEST, op: 'catalog', args: cyclic }), FAILURE_CODES.INVALID_MESSAGE)

  const response = createResponse({ requestId: REQUEST, op: 'catalog', result: { projects: [] } })
  assert.equal(response.ok, true)
  assert.deepEqual(parseProtocolMessage(response), response)

  const failure = createFailure(FAILURE_CODES.NOT_GRANTED, 'not granted')
  assert.deepEqual(failure, { code: 'not-granted', message: 'not granted' })
  assert.deepEqual(parseFailure(failure), failure)
  rejects(() => createFailure('unknown-code'), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => createFailure(FAILURE_CODES.NOT_GRANTED, 'bad\nmessage'), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => createFailure(FAILURE_CODES.NOT_GRANTED, 'x'.repeat(300)), FAILURE_CODES.INVALID_MESSAGE)
})

test('failure responses are typed and never carry arbitrary fields', () => {
  const failure = createFailure(FAILURE_CODES.GRANT_CHANGED)
  const response = createFailureResponse({ requestId: REQUEST, op: 'session.read', failure })
  assert.equal(response.ok, false)
  assert.deepEqual(response.failure, failure)
  assert.deepEqual(parseProtocolMessage(response), response)
  rejects(
    () => createFailureResponse({ requestId: REQUEST, op: 'session.read', failure: { code: 'not-granted', extra: 'secret' } }),
    FAILURE_CODES.INVALID_MESSAGE,
  )
})

test('stream frames and end markers are op-gated', () => {
  const frame = createFrame({ requestId: REQUEST, op: 'session.follow', index: 0, frame: { type: 'snapshot' } })
  assert.equal(frame.type, 'frame')
  assert.equal(frame.index, 0)
  assert.deepEqual(parseProtocolMessage(frame), frame)
  rejects(() => createFrame({ requestId: REQUEST, op: 'catalog', index: 0, frame: {} }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => createFrame({ requestId: REQUEST, op: 'session.follow', index: -1, frame: {} }), FAILURE_CODES.INVALID_MESSAGE)

  const end = createEnd({ requestId: REQUEST, op: 'session.follow' })
  assert.equal(end.ok, true)
  assert.deepEqual(parseProtocolMessage(end), end)
  const failedEnd = createEnd({ requestId: REQUEST, op: 'session.follow', failure: { code: 'history-gap' } })
  assert.equal(failedEnd.ok, false)
  assert.deepEqual(parseProtocolMessage(failedEnd), failedEnd)
})

test('protocol message parser rejects unknown types, versions, and extra keys', () => {
  const request = createRequest({ requestId: REQUEST, op: 'catalog' })
  rejects(() => parseProtocolMessage({ ...request, protocol: 3 }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parseProtocolMessage({ ...request, type: 'unknown' }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parseProtocolMessage({ ...request, extra: true }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parseProtocolMessage(null), FAILURE_CODES.INVALID_MESSAGE)
})

test('export cursors round-trip, stay opaque, and verify their binding', () => {
  const token = encodeExportCursor(OPTS)
  assert.match(token, /^fec1\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeExportCursor(token, { machineKey: MACHINE, generation: 1, grantRevision: 3 }), OPTS)
  rejects(() => decodeExportCursor(token, { machineKey: 'worker_other' }), FAILURE_CODES.CURSOR_STALE)
  rejects(() => decodeExportCursor(token, { generation: 2 }), FAILURE_CODES.CURSOR_STALE)
  rejects(() => decodeExportCursor(`${token}=`), FAILURE_CODES.INVALID_MESSAGE)

  // Non-canonical JSON spelling is rejected instead of being silently accepted.
  const spaced = `fec1.${Buffer.from(JSON.stringify([MACHINE, PROJECT, SESSION, 1, 3, 5, 0]).replace(/,/g, ', ')).toString('base64url')}`
  assert.notEqual(spaced, token)
  rejects(() => decodeExportCursor(spaced), FAILURE_CODES.INVALID_MESSAGE)

  const emptyLog = encodeExportCursor({ ...OPTS, throughSeq: -1, beforeSeq: 0 })
  assert.equal(decodeExportCursor(emptyLog).throughSeq, -1)
  rejects(() => encodeExportCursor({ ...OPTS, beforeSeq: -1 }), FAILURE_CODES.INVALID_MESSAGE)
})

test('jsonByteLength uses UTF-8 canonical JSON bytes', () => {
  assert.equal(jsonByteLength({ a: 1 }), Buffer.byteLength('{"a":1}'))
  assert.ok(jsonByteLength({ text: 'привет' }) > jsonByteLength({ text: 'hi' }))
})
