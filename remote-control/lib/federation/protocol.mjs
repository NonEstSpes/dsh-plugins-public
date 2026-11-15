/**
 * Federation v2 transport contract: typed request/response/frame envelopes,
 * capability gating, failure vocabulary, opaque export cursors, and bounded JSON.
 *
 * The existing `command`/`response`/`report` wire stays untouched. Federation v2
 * runs as a separate, config-agreed capability channel; every message is strict,
 * bounded, and carries the compound reference it names. A successful transport
 * poll is not a heartbeat, and a denied or absent source never falls back to local.
 *
 * This module is pure: no I/O, no configuration, no process state.
 *
 * @module dsh-remote-control/federation/protocol
 */

import {
  FederationContractError,
  MACHINE_KEY_PATTERN,
  PROJECT_ID_PATTERN,
  SESSION_ID_PATTERN,
} from './identity.mjs'

/** Federation addon protocol version. */
export const FEDERATION_PROTOCOL_VERSION = 2

/** Operations carried by federation requests. */
export const PROTOCOL_OPS = Object.freeze([
  'hello',
  'catalog',
  'project.registration.state',
  'project.register',
  'files.upload.start',
  'files.upload.chunk',
  'files.upload.finish',
  'files.upload.cancel',
  'files.read',
  'files.attachment',
  'files.image',
  'session.bind',
  'session.bind.details',
  'session.bind.live',
  'session.read.details',
  'session.follow.details',
  'session.create',
  'session.prompt',
  'session.cancel',
  'model.state',
  'session.read',
  'session.follow',
  'session.status',
  'model.catalog',
  'model.catalog.page',
  'model.select',
])

/** Native history interpretations; a cursor may never cross these export formats. */
export const NATIVE_HISTORY_FORMATS = Object.freeze({ LEGACY: 'legacy', DETAILS: 'native-details-v1' })

/** Optional wire extensions. Names include their contract version; they never grant access. */
export const FEDERATION_FEATURES = Object.freeze({ MODEL_CATALOG_PAGES: 'model-catalog-pages-v1', SESSION_DETAILS: NATIVE_HISTORY_FORMATS.DETAILS, SESSION_LIVE: 'native-assistant-stream-v1', PROJECT_REGISTRATION: 'native-project-registration-v1', SESSION_FILES: 'native-source-files-v1', SESSION_IMAGES: 'native-source-images-v1' })

/** Operations that produce a frame sequence. */
export const STREAM_OPS = Object.freeze(['session.follow', 'session.follow.details'])

/** Capability keys, aligned with the frozen `SessionSourceCapabilities` field set. */
export const CAPABILITY_KEYS = Object.freeze([
  'prompt', 'cancel', 'history', 'modelSelect', 'create',
  'rename', 'fork', 'queueEdit', 'attachments', 'files', 'approvals', 'commands',
])

/** v0 capability defaults: every optional class denied until explicitly negotiated. */
export const DEFAULT_CAPABILITIES = Object.freeze(Object.fromEntries(CAPABILITY_KEYS.map(key => [key, false])))

/** Capability required by each operation. */
export const OP_CAPABILITY = Object.freeze({
  'session.read': 'history',
  'session.follow': 'history',
  'session.read.details': 'history',
  'session.follow.details': 'history',
  'model.select': 'modelSelect',
  'session.create': 'create',
  'session.prompt': 'prompt',
  'session.cancel': 'cancel',
  'files.upload.start': 'attachments',
  'files.upload.chunk': 'attachments',
  'files.upload.finish': 'attachments',
  'files.read': 'files',
  'files.attachment': 'files',
  'files.image': 'files',
})

/** Typed failure codes; the same vocabulary is used on the wire and in helpers. */
export const FAILURE_CODES = Object.freeze({
  SOURCE_UNAVAILABLE: 'source-unavailable',
  ACTION_UNSUPPORTED: 'action-unsupported',
  GRANT_CHANGED: 'grant-changed',
  CATALOG_STALE: 'catalog-stale',
  SELECTION_CONFLICT: 'selection-conflict',
  OUTCOME_UNKNOWN: 'outcome-unknown',
  HISTORY_GAP: 'history-gap',
  EXPORT_POLICY_UNSUPPORTED: 'export-policy-unsupported',
  CURSOR_STALE: 'cursor-stale',
  PAGE_TOO_LARGE: 'page-too-large',
  INVALID_MESSAGE: 'invalid-message',
  NOT_GRANTED: 'not-granted',
  PAIRING_MISMATCH: 'pairing-mismatch',
})

const FAILURE_SET = new Set(Object.values(FAILURE_CODES))

/** Bounded payload limits. The transport's own caps (59/80/100 KiB) are never raised here. */
export const PROTOCOL_LIMITS = Object.freeze({
  maxPayloadBytes: 32 * 1024,
  maxPageBytes: 32 * 1024,
  maxFrameBytes: 32 * 1024,
  maxFollowBufferEvents: 256,
  maxFollowBufferBytes: 256 * 1024,
  maxCursorBytes: 1024,
  maxJsonDepth: 32,
  maxFailureMessageLength: 200,
  maxOperationIdLength: 80,
  maxFeatureNames: 32,
  maxFeatureNameLength: 64,
})

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const CURSOR_PREFIX = 'fec1.'
const DETAILS_CURSOR_PREFIX = 'fec2.'
const DETAILS_FORMAT = NATIVE_HISTORY_FORMATS.DETAILS
const CURSOR_KEYS = ['machineKey', 'projectId', 'sessionId', 'generation', 'grantRevision', 'throughSeq', 'beforeSeq']

const fail = (code, message, detail) => { throw new FederationContractError(code, message, detail) }

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const isSafeInteger = value => Number.isSafeInteger(value)
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0

function exactKeys(value, required, optional = []) {
  if (!isRecord(value)) return false
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return keys.length >= required.length && keys.every(key => allowed.has(key))
    && required.every(key => Object.hasOwn(value, key))
}

function assertMessageRecord(value, required, optional = []) {
  if (!exactKeys(value, required, optional)) fail(FAILURE_CODES.INVALID_MESSAGE, 'message fields are invalid')
  return value
}

function snapshotJson(value, label, maxBytes = PROTOCOL_LIMITS.maxPayloadBytes) {
  const seen = new Set()
  let depth = 0
  function visit(item, level) {
    if (level > PROTOCOL_LIMITS.maxJsonDepth) fail(FAILURE_CODES.INVALID_MESSAGE, `${label} is too deep`)
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) fail(FAILURE_CODES.INVALID_MESSAGE, `${label} contains a non-finite number`)
      return
    }
    if (typeof item !== 'object') fail(FAILURE_CODES.INVALID_MESSAGE, `${label} contains a non-JSON value`)
    if (seen.has(item)) fail(FAILURE_CODES.INVALID_MESSAGE, `${label} contains a cycle`)
    seen.add(item)
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) visit(item[index], level + 1)
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        fail(FAILURE_CODES.INVALID_MESSAGE, `${label} contains a non-plain object`)
      }
      for (const key of Object.keys(item)) visit(item[key], level + 1)
    }
    seen.delete(item)
  }
  visit(value, 0)
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, `${label} cannot be serialized`)
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, `${label} exceeds the byte budget`)
  return deepFreeze(JSON.parse(text))
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/**
 * Build a capability snapshot, denying every key not explicitly set to `true`.
 * @param {Partial<Record<string, boolean>>} [value] - capability overrides.
 * @returns {Readonly<Record<string, boolean>>} frozen complete capability map.
 */
export function createCapabilities(value = {}) {
  if (!isRecord(value)) fail(FAILURE_CODES.INVALID_MESSAGE, 'capabilities must be an object')
  for (const key of Object.keys(value)) {
    if (!CAPABILITY_KEYS.includes(key)) fail(FAILURE_CODES.INVALID_MESSAGE, `unknown capability "${key}"`)
    if (typeof value[key] !== 'boolean') fail(FAILURE_CODES.INVALID_MESSAGE, `capability "${key}" must be boolean`)
  }
  return Object.freeze(Object.fromEntries(CAPABILITY_KEYS.map(key => [key, value[key] === true])))
}

/**
 * Strict capability parser: every key is required and boolean.
 * @param {unknown} value - candidate capability map.
 * @returns {Readonly<Record<string, boolean>>} frozen capability map.
 */
export function parseCapabilities(value) {
  if (!exactKeys(value, CAPABILITY_KEYS)) fail(FAILURE_CODES.INVALID_MESSAGE, 'capabilities must carry exactly the known keys')
  return createCapabilities(value)
}

/**
 * Require one negotiated capability.
 * @param {unknown} capabilities - capability map.
 * @param {string} capability - capability key.
 * @returns {Readonly<Record<string, boolean>>} the parsed capabilities.
 */
export function assertCapability(capabilities, capability) {
  const parsed = createCapabilities(capabilities)
  if (!CAPABILITY_KEYS.includes(capability)) fail(FAILURE_CODES.INVALID_MESSAGE, 'unknown capability')
  if (parsed[capability] !== true) {
    fail(FAILURE_CODES.ACTION_UNSUPPORTED, `capability "${capability}" is not negotiated`, { capability })
  }
  return parsed
}

/**
 * Require the capability an operation depends on.
 * @param {string} op - protocol operation.
 * @param {unknown} capabilities - capability map.
 * @returns {Readonly<Record<string, boolean>>} the parsed capabilities.
 */
export function assertOpAllowed(op, capabilities) {
  if (!PROTOCOL_OPS.includes(op)) fail(FAILURE_CODES.ACTION_UNSUPPORTED, `unknown operation "${op}"`, { op })
  const capability = OP_CAPABILITY[op]
  if (capability === undefined) return createCapabilities(capabilities)
  return assertCapability(capabilities, capability)
}

/**
 * Read a bounded hello manifest. Absence is a legacy peer, not implicit support;
 * well-formed future names are ignored so optional extensions stay additive.
 * @param {unknown} value - optional authenticated Worker hello features.
 * @returns {readonly string[]} implemented, explicitly advertised feature names.
 */
export function parseFeatureManifest(value) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value) || value.length > PROTOCOL_LIMITS.maxFeatureNames) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid feature manifest')
  const known = new Set(Object.values(FEDERATION_FEATURES)), seen = new Set()
  for (const feature of value) {
    if (typeof feature !== 'string' || feature.length > PROTOCOL_LIMITS.maxFeatureNameLength || !/^[a-z][a-z0-9-]*$/.test(feature) || seen.has(feature)) {
      fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid feature manifest')
    }
    seen.add(feature)
  }
  return Object.freeze([...seen].filter(feature => known.has(feature)))
}

/**
 * Build one typed failure payload.
 * @param {string} code - failure code from {@link FAILURE_CODES}.
 * @param {string} [message] - short safe message; never paths, secrets, or raw backend output.
 * @returns {Readonly<{ code: string, message?: string }>} frozen failure.
 */
export function createFailure(code, message) {
  if (!FAILURE_SET.has(code)) fail(FAILURE_CODES.INVALID_MESSAGE, 'unknown failure code', { code })
  if (message !== undefined) {
    if (typeof message !== 'string' || message.length === 0 || message.length > PROTOCOL_LIMITS.maxFailureMessageLength) {
      fail(FAILURE_CODES.INVALID_MESSAGE, 'failure message has an unsupported length')
    }
    if (/[\u0000-\u001f\u007f]/.test(message)) fail(FAILURE_CODES.INVALID_MESSAGE, 'failure message contains control characters')
  }
  return Object.freeze({ code, ...(message === undefined ? {} : { message }) })
}

/**
 * Strict failure payload parser.
 * @param {unknown} value - candidate failure.
 * @returns {Readonly<{ code: string, message?: string }>} frozen failure.
 */
export function parseFailure(value) {
  if (!exactKeys(value, ['code'], ['message'])) fail(FAILURE_CODES.INVALID_MESSAGE, 'failure fields are invalid')
  return createFailure(value.code, value.message)
}

function assertOperationId(value) {
  if (typeof value !== 'string' || !REQUEST_ID_PATTERN.test(value) || value.length > PROTOCOL_LIMITS.maxOperationIdLength) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'requestId has an unsupported format')
  }
  return value
}

function assertOp(value) {
  if (typeof value !== 'string' || !PROTOCOL_OPS.includes(value)) fail(FAILURE_CODES.ACTION_UNSUPPORTED, 'unknown operation')
  return value
}

function assertProtocol(value) {
  if (value !== FEDERATION_PROTOCOL_VERSION) fail(FAILURE_CODES.INVALID_MESSAGE, 'unsupported federation protocol version')
  return value
}

/**
 * Build a validated request envelope.
 * @param {{ requestId: string, op: string, args?: unknown }} value - request fields.
 * @returns {Readonly<object>} frozen request.
 */
export function createRequest(value) {
  assertMessageRecord(value, ['requestId', 'op'], ['args'])
  const requestId = assertOperationId(value.requestId)
  const op = assertOp(value.op)
  const args = snapshotJson(value.args === undefined ? {} : value.args, 'request arguments')
  return Object.freeze({ protocol: FEDERATION_PROTOCOL_VERSION, type: 'request', requestId, op, args })
}

/**
 * Build a validated success response envelope.
 * @param {{ requestId: string, op: string, result: unknown }} value - response fields.
 * @returns {Readonly<object>} frozen response.
 */
export function createResponse(value) {
  assertMessageRecord(value, ['requestId', 'op', 'result'])
  const requestId = assertOperationId(value.requestId)
  const op = assertOp(value.op)
  const result = snapshotJson(value.result, 'response result')
  return Object.freeze({ protocol: FEDERATION_PROTOCOL_VERSION, type: 'response', requestId, op, ok: true, result })
}

/**
 * Build a validated typed-failure response envelope.
 * @param {{ requestId: string, op: string, failure: unknown }} value - failure response fields.
 * @returns {Readonly<object>} frozen response.
 */
export function createFailureResponse(value) {
  assertMessageRecord(value, ['requestId', 'op', 'failure'])
  const requestId = assertOperationId(value.requestId)
  const op = assertOp(value.op)
  const failure = parseFailure(value.failure)
  return Object.freeze({ protocol: FEDERATION_PROTOCOL_VERSION, type: 'response', requestId, op, ok: false, failure })
}

/**
 * Build one stream frame envelope.
 * @param {{ requestId: string, op: string, index: number, frame: unknown }} value - frame fields.
 * @returns {Readonly<object>} frozen frame.
 */
export function createFrame(value) {
  assertMessageRecord(value, ['requestId', 'op', 'index', 'frame'])
  const requestId = assertOperationId(value.requestId)
  const op = assertOp(value.op)
  if (!STREAM_OPS.includes(op)) fail(FAILURE_CODES.INVALID_MESSAGE, 'operation does not carry frames')
  if (!isNonNegativeInteger(value.index)) fail(FAILURE_CODES.INVALID_MESSAGE, 'frame index must be a non-negative integer')
  const frame = snapshotJson(value.frame, 'stream frame', PROTOCOL_LIMITS.maxFrameBytes)
  return Object.freeze({ protocol: FEDERATION_PROTOCOL_VERSION, type: 'frame', requestId, op, index: value.index, frame })
}

/**
 * Build the terminal stream envelope.
 * @param {{ requestId: string, op: string, failure?: unknown }} value - end fields.
 * @returns {Readonly<object>} frozen end.
 */
export function createEnd(value) {
  assertMessageRecord(value, ['requestId', 'op'], ['failure'])
  const requestId = assertOperationId(value.requestId)
  const op = assertOp(value.op)
  if (!STREAM_OPS.includes(op)) fail(FAILURE_CODES.INVALID_MESSAGE, 'operation does not carry frames')
  if (value.failure === undefined) {
    return Object.freeze({ protocol: FEDERATION_PROTOCOL_VERSION, type: 'end', requestId, op, ok: true })
  }
  return Object.freeze({ protocol: FEDERATION_PROTOCOL_VERSION, type: 'end', requestId, op, ok: false, failure: parseFailure(value.failure) })
}

/**
 * Strict parser for every federation message type.
 * @param {unknown} value - candidate message.
 * @returns {Readonly<object>} frozen normalized message.
 */
export function parseProtocolMessage(value) {
  if (!isRecord(value)) fail(FAILURE_CODES.INVALID_MESSAGE, 'message must be a plain JSON object')
  assertProtocol(value.protocol)
  switch (value.type) {
    case 'request':
      assertMessageRecord(value, ['protocol', 'type', 'requestId', 'op', 'args'])
      return createRequest({ requestId: value.requestId, op: value.op, args: value.args })
    case 'response':
      if (value.ok === true) {
        assertMessageRecord(value, ['protocol', 'type', 'requestId', 'op', 'ok', 'result'])
        return createResponse({ requestId: value.requestId, op: value.op, result: value.result })
      }
      assertMessageRecord(value, ['protocol', 'type', 'requestId', 'op', 'ok', 'failure'])
      if (value.ok !== false) fail(FAILURE_CODES.INVALID_MESSAGE, 'response ok flag is invalid')
      return createFailureResponse({ requestId: value.requestId, op: value.op, failure: value.failure })
    case 'frame':
      assertMessageRecord(value, ['protocol', 'type', 'requestId', 'op', 'index', 'frame'])
      return createFrame({ requestId: value.requestId, op: value.op, index: value.index, frame: value.frame })
    case 'end':
      if (value.ok === true) {
        assertMessageRecord(value, ['protocol', 'type', 'requestId', 'op', 'ok'])
        return createEnd({ requestId: value.requestId, op: value.op })
      }
      assertMessageRecord(value, ['protocol', 'type', 'requestId', 'op', 'ok', 'failure'])
      if (value.ok !== false) fail(FAILURE_CODES.INVALID_MESSAGE, 'end ok flag is invalid')
      return createEnd({ requestId: value.requestId, op: value.op, failure: value.failure })
    default:
      fail(FAILURE_CODES.INVALID_MESSAGE, 'unknown message type')
  }
}

function assertRefPart(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) fail(FAILURE_CODES.INVALID_MESSAGE, `${label} has an unsupported format`)
  return value
}

/**
 * Encode one opaque export cursor bound to a compound reference and visibility generation.
 * @param {{ machineKey: string, projectId: string, sessionId: string, generation: number,
 *   grantRevision: number, throughSeq: number, beforeSeq: number, format?: 'native-details-v1' }} value - cursor fields; omitted format preserves the legacy bytes.
 * @returns {string} opaque cursor beginning with `fec1.` or format-bound `fec2.`.
 */
export function encodeExportCursor(value) {
  assertMessageRecord(value, CURSOR_KEYS, ['format'])
  if (value.format !== undefined && value.format !== DETAILS_FORMAT) fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor format is unsupported')
  const tuple = [
    assertRefPart(value.machineKey, MACHINE_KEY_PATTERN, 'machineKey'),
    assertRefPart(value.projectId, PROJECT_ID_PATTERN, 'projectId'),
    assertRefPart(value.sessionId, SESSION_ID_PATTERN, 'sessionId'),
    value.generation,
    value.grantRevision,
    value.throughSeq,
    value.beforeSeq,
  ]
  if (![3, 4, 5, 6].every(index => isSafeInteger(tuple[index]))) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor numbers must be safe integers')
  }
  if (tuple[3] < 0 || tuple[4] < 0 || tuple[5] < -1 || tuple[6] < 0) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor numbers are out of range')
  }
  if (value.format !== undefined) tuple.push(value.format)
  const prefix = value.format === undefined ? CURSOR_PREFIX : DETAILS_CURSOR_PREFIX
  const token = `${prefix}${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}`
  if (Buffer.byteLength(token, 'utf8') > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'cursor exceeds the byte budget')
  return token
}

/**
 * Decode an opaque export cursor and verify its binding.
 * @param {unknown} token - opaque cursor.
 * @param {{ machineKey?: string, projectId?: string, sessionId?: string,
 *   generation?: number, grantRevision?: number, format?: 'legacy' | 'native-details-v1' }} [expected] - expected reference, visibility and optional export interpretation.
 * @returns {Readonly<object>} frozen cursor fields.
 */
export function decodeExportCursor(token, expected = {}) {
  const details = typeof token === 'string' && token.startsWith(DETAILS_CURSOR_PREFIX)
  if (typeof token !== 'string' || (!details && !token.startsWith(CURSOR_PREFIX))) fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor has an unsupported prefix')
  if (token.length > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'cursor exceeds the decode budget')
  const body = token.slice((details ? DETAILS_CURSOR_PREFIX : CURSOR_PREFIX).length)
  if (!BASE64URL_PATTERN.test(body)) fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor is not base64url')
  let text
  try {
    text = Buffer.from(body, 'base64url').toString('utf8')
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor cannot be decoded')
  }
  if (Buffer.from(text, 'utf8').toString('base64url') !== body) fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor is not canonical')
  let tuple
  try {
    tuple = JSON.parse(text)
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor does not contain JSON')
  }
  if (!Array.isArray(tuple) || tuple.length !== CURSOR_KEYS.length + (details ? 1 : 0) || JSON.stringify(tuple) !== text || (details && tuple[7] !== DETAILS_FORMAT)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor tuple is invalid')
  }
  const cursor = {
    machineKey: assertRefPart(tuple[0], MACHINE_KEY_PATTERN, 'machineKey'),
    projectId: assertRefPart(tuple[1], PROJECT_ID_PATTERN, 'projectId'),
    sessionId: assertRefPart(tuple[2], SESSION_ID_PATTERN, 'sessionId'),
    generation: tuple[3],
    grantRevision: tuple[4],
    throughSeq: tuple[5],
    beforeSeq: tuple[6],
    ...(details ? { format: DETAILS_FORMAT } : {}),
  }
  if (![3, 4, 5, 6].every(index => isSafeInteger(tuple[index]))) fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor numbers are invalid')
  if (tuple[3] < 0 || tuple[4] < 0 || tuple[5] < -1 || tuple[6] < 0) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor numbers are out of range')
  }
  if (!isRecord(expected)) fail(FAILURE_CODES.INVALID_MESSAGE, 'cursor expectation must be an object')
  for (const key of ['machineKey', 'projectId', 'sessionId']) {
    if (expected[key] !== undefined && expected[key] !== cursor[key]) fail(FAILURE_CODES.CURSOR_STALE, 'cursor names another reference', { field: key })
  }
  for (const key of ['generation', 'grantRevision']) {
    if (expected[key] !== undefined && expected[key] !== cursor[key]) fail(FAILURE_CODES.CURSOR_STALE, 'cursor belongs to another visibility generation', { field: key })
  }
  if (expected.format !== undefined && expected.format !== (cursor.format ?? 'legacy')) fail(FAILURE_CODES.CURSOR_STALE, 'cursor belongs to another native export format')
  return Object.freeze(cursor)
}

/**
 * Measure the canonical JSON byte size used by page budgets.
 * @param {unknown} value - JSON value.
 * @returns {number} UTF-8 byte length of `JSON.stringify(value)`.
 */
export function jsonByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}
