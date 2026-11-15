/**
 * Canonical federation identity helpers.
 *
 * A federation reference is a compound tuple `(machineKey, projectId, sessionId)`.
 * Callers must never split or join raw identifiers to build one: the opaque token
 * encodes the exact tuple and decoding rejects every non-canonical spelling, so two
 * different tuples cannot collide through separators or base64url aliases.
 *
 * `machineKey` is the durable paired harness/profile identity. Trust `pairingGeneration`
 * and the key fingerprint are a separate binding: an authorized key rotation keeps the
 * machine identity, while an unrelated pairing keeps its own identity and inherits no
 * grants or caches. {@link machineContinuity} classifies trust facts for display and
 * reconciliation probes; it is informational and never authorizes a rotation, a grant,
 * or access. Authorization stays with the explicit user-only grant path.
 *
 * Identifier character limits are adapter compatibility constraints, not a claim
 * about the unrestricted native `SessionId(string)` brand. Project IDs match paired
 * config IDs; session IDs use the documented adapter subset. Before wiring, the real IDs of every paired
 * machine must be audited against these parsers; an ID outside them fails loudly at
 * parse time instead of being silently skipped.
 *
 * This module is pure: no I/O, no configuration, no process state.
 *
 * @module dsh-remote-control/federation/identity
 */

/** Identity contract version carried by every opaque token prefix. */
export const FEDERATION_IDENTITY_VERSION = 1

/** Stable paired machine identity. Hostnames, paths, and URLs are never identities. */
export const MACHINE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
/** Worker-configured project identifier; matches remote-control's paired config IDs. */
export const PROJECT_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/
/**
 * Remote native Session identifier.
 *
 * Native SessionId(string) only brands the supplied string (core/session/src/types.ts).
 * It has no native charset restriction. This adapter retains its explicit 1–128 ASCII
 * letters/digits/underscore/dot/dash subset; it does not claim universal native support.
 * Store-generated session-<counter> and reserved session-<uuid> fit this subset.
 * Inventory audit is mandatory before wiring; unsupported existing IDs must produce
 * an explicit compatibility error, never be silently skipped or auto-normalized.
 */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

/** Human-readable supported session-id domain; the pattern above is authoritative. */
export const SUPPORTED_SESSION_ID_DOMAIN = Object.freeze({
  shapes: Object.freeze(['1–128 ASCII letters/digits/underscore/dot/dash']),
  generatedBy: 'adapter subset; native SessionId(string) is unrestricted',
})

/** Upper bound applied before decoding an opaque tuple token. */
export const MAX_OPAQUE_TOKEN_BYTES = 4096
/** Lowercase SHA-256 hex of the pairing key material; a trust fact, never an identity. */
export const TRUST_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/

/** Opaque token prefixes; the version digit changes with the encoding contract. */
export const SESSION_REF_PREFIX = 'fr1s.'
/** Opaque project token prefix. */
export const PROJECT_REF_PREFIX = 'fr1p.'

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,127}$/u
const RESERVED_COMPONENTS = new Set(['__proto__', 'constructor', 'prototype'])
const SESSION_REF_KEYS = ['machineKey', 'projectId', 'sessionId']
const PROJECT_REF_KEYS = ['machineKey', 'projectId']
const MACHINE_IDENTITY_KEYS = ['machineKey', 'label']
const TRUST_BINDING_KEYS = ['machineKey', 'pairingGeneration', 'keyFingerprint']
const IDENTITY_FORBIDDEN_FIELDS = ['cwd', 'path', 'hostname', 'relayUrl', 'url', 'localSessionId', 'generation', 'pairingGeneration']

/** Stable failure codes for the identity contract. */
export const IDENTITY_CODES = Object.freeze({
  INVALID: 'identity/invalid',
  FORBIDDEN_FIELD: 'identity/forbidden-field',
  INVALID_MACHINE_KEY: 'identity/invalid-machine-key',
  INVALID_PROJECT_ID: 'identity/invalid-project-id',
  INVALID_SESSION_ID: 'identity/invalid-session-id',
  INVALID_SESSION_REF: 'identity/invalid-session-ref',
  INVALID_PROJECT_REF: 'identity/invalid-project-ref',
  INVALID_IDENTITY: 'identity/invalid-identity',
  INVALID_TRUST_BINDING: 'identity/invalid-trust-binding',
  INVALID_TOKEN: 'identity/invalid-token',
  NON_CANONICAL_TOKEN: 'identity/non-canonical-token',
  VALUE_TOO_LONG: 'identity/value-too-long',
})

/**
 * Typed contract failure raised by strict parsers.
 */
export class FederationContractError extends Error {
  /**
   * @param {string} code - stable machine-readable code.
   * @param {string} message - safe human-readable message.
   * @param {unknown} [detail] - optional machine-readable detail, never credentials.
   */
  constructor(code, message, detail) {
    super(message)
    this.name = 'FederationContractError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

const fail = (code, message, detail) => { throw new FederationContractError(code, message, detail) }

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const isSafePositiveInteger = value => Number.isSafeInteger(value) && value > 0

function assertRecord(value, subject, { required, optional = [], forbidden = [], code = IDENTITY_CODES.INVALID } = {}) {
  if (!isRecord(value)) fail(code, `${subject} must be a plain JSON object`, { subject })
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue
    if (forbidden.includes(key)) fail(IDENTITY_CODES.FORBIDDEN_FIELD, `${subject} must not carry "${key}"`, { subject, field: key })
    fail(code, `${subject} carries unknown field "${key}"`, { subject, field: key })
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${subject} requires "${key}"`, { subject, field: key })
  }
  return value
}

function parseComponent(value, pattern, code, label) {
  if (typeof value !== 'string') fail(code, `${label} must be a string`, { field: label })
  if (value.length > 128) fail(IDENTITY_CODES.VALUE_TOO_LONG, `${label} exceeds 128 characters`, { field: label })
  if (!pattern.test(value)) fail(code, `${label} has an unsupported format`, { field: label })
  if (RESERVED_COMPONENTS.has(value)) fail(code, `${label} is reserved`, { field: label })
  return value
}

/**
 * Parse a stable paired machine identity.
 * @param {unknown} value - candidate machine key.
 * @returns {string} the validated machine key.
 */
export function parseMachineKey(value) {
  return parseComponent(value, MACHINE_KEY_PATTERN, IDENTITY_CODES.INVALID_MACHINE_KEY, 'machineKey')
}

/**
 * Parse a Worker project identifier.
 * @param {unknown} value - candidate project id.
 * @returns {string} the validated project id.
 */
export function parseProjectId(value) {
  return parseComponent(value, PROJECT_ID_PATTERN, IDENTITY_CODES.INVALID_PROJECT_ID, 'projectId')
}

/**
 * Parse a remote native Session identifier.
 * @param {unknown} value - candidate session id.
 * @returns {string} the validated session id.
 */
export function parseSessionId(value) {
  return parseComponent(value, SESSION_ID_PATTERN, IDENTITY_CODES.INVALID_SESSION_ID, 'sessionId')
}

/**
 * Build a frozen machine identity. Trust generation and key fingerprint are not identity.
 * @param {{ machineKey: string, label?: string }} value - identity fields.
 * @returns {Readonly<{ machineKey: string, label?: string }>} frozen identity.
 */
export function createMachineIdentity(value) {
  assertRecord(value, 'machine identity', {
    required: ['machineKey'],
    optional: ['label'],
    forbidden: IDENTITY_FORBIDDEN_FIELDS,
    code: IDENTITY_CODES.INVALID_IDENTITY,
  })
  const identity = { machineKey: parseMachineKey(value.machineKey) }
  if (value.label !== undefined) {
    if (typeof value.label !== 'string' || !LABEL_PATTERN.test(value.label) || value.label.trim() !== value.label) {
      fail(IDENTITY_CODES.INVALID_IDENTITY, 'machine identity label has an unsupported format', { field: 'label' })
    }
    identity.label = value.label
  }
  return Object.freeze(identity)
}

/**
 * Strict machine identity parser.
 * @param {unknown} value - candidate identity.
 * @returns {Readonly<{ machineKey: string, label?: string }>} frozen identity.
 */
export function parseMachineIdentity(value) {
  return createMachineIdentity(value)
}

/**
 * Build a frozen pairing trust binding, which is separate from the durable identity.
 * @param {{ machineKey: string, pairingGeneration: number, keyFingerprint: string }} value - trust fields.
 * @returns {Readonly<{ machineKey: string, pairingGeneration: number, keyFingerprint: string }>} frozen binding.
 */
export function createTrustBinding(value) {
  assertRecord(value, 'trust binding', {
    required: TRUST_BINDING_KEYS,
    forbidden: IDENTITY_FORBIDDEN_FIELDS.filter(field => field !== 'pairingGeneration'),
    code: IDENTITY_CODES.INVALID_TRUST_BINDING,
  })
  const machineKey = parseMachineKey(value.machineKey)
  if (!isSafePositiveInteger(value.pairingGeneration)) {
    fail(IDENTITY_CODES.INVALID_TRUST_BINDING, 'pairingGeneration must be a positive safe integer', { field: 'pairingGeneration' })
  }
  if (typeof value.keyFingerprint !== 'string' || !TRUST_FINGERPRINT_PATTERN.test(value.keyFingerprint)) {
    fail(IDENTITY_CODES.INVALID_TRUST_BINDING, 'keyFingerprint must be lowercase SHA-256 hex', { field: 'keyFingerprint' })
  }
  return Object.freeze({ machineKey, pairingGeneration: value.pairingGeneration, keyFingerprint: value.keyFingerprint })
}

/**
 * Strict trust binding parser.
 * @param {unknown} value - candidate binding.
 * @returns {Readonly<{ machineKey: string, pairingGeneration: number, keyFingerprint: string }>} frozen binding.
 */
export function parseTrustBinding(value) {
  return createTrustBinding(value)
}

/**
 * Classify two trust bindings without treating a rotation as a new machine.
 * This is an informational reconciliation probe, never an authorization decision:
 * `rotated` does not grant continuity, and `same-pairing` does not grant access.
 * @param {unknown} previous - earlier binding.
 * @param {unknown} next - later binding.
 * @returns {'same-pairing' | 'rotated' | 'fingerprint-mismatch' | 'different-machine'} continuity class.
 */
export function machineContinuity(previous, next) {
  const left = parseTrustBinding(previous)
  const right = parseTrustBinding(next)
  if (left.machineKey !== right.machineKey) return 'different-machine'
  if (left.pairingGeneration === right.pairingGeneration) {
    return left.keyFingerprint === right.keyFingerprint ? 'same-pairing' : 'fingerprint-mismatch'
  }
  if (right.pairingGeneration < left.pairingGeneration) return 'fingerprint-mismatch'
  return left.keyFingerprint === right.keyFingerprint ? 'fingerprint-mismatch' : 'rotated'
}

/**
 * Build a frozen project reference.
 * @param {{ machineKey: string, projectId: string }} value - reference fields.
 * @returns {Readonly<{ machineKey: string, projectId: string }>} frozen reference.
 */
export function createProjectRef(value) {
  assertRecord(value, 'project reference', {
    required: PROJECT_REF_KEYS,
    forbidden: IDENTITY_FORBIDDEN_FIELDS,
    code: IDENTITY_CODES.INVALID_PROJECT_REF,
  })
  return Object.freeze({
    machineKey: parseMachineKey(value.machineKey),
    projectId: parseProjectId(value.projectId),
  })
}

/**
 * Strict project reference parser.
 * @param {unknown} value - candidate reference.
 * @returns {Readonly<{ machineKey: string, projectId: string }>} frozen reference.
 */
export function parseProjectRef(value) {
  return createProjectRef(value)
}

/**
 * Build a frozen compound session reference.
 * @param {{ machineKey: string, projectId: string, sessionId: string }} value - reference fields.
 * @returns {Readonly<{ machineKey: string, projectId: string, sessionId: string }>} frozen reference.
 */
export function createSessionRef(value) {
  assertRecord(value, 'session reference', {
    required: SESSION_REF_KEYS,
    forbidden: IDENTITY_FORBIDDEN_FIELDS,
    code: IDENTITY_CODES.INVALID_SESSION_REF,
  })
  return Object.freeze({
    machineKey: parseMachineKey(value.machineKey),
    projectId: parseProjectId(value.projectId),
    sessionId: parseSessionId(value.sessionId),
  })
}

/**
 * Strict compound session reference parser.
 * @param {unknown} value - candidate reference.
 * @returns {Readonly<{ machineKey: string, projectId: string, sessionId: string }>} frozen reference.
 */
export function parseSessionRef(value) {
  return createSessionRef(value)
}

/**
 * Canonical tuple of a session reference, in encoding order.
 * @param {unknown} value - candidate reference.
 * @returns {readonly [string, string, string]} frozen tuple.
 */
export function canonicalSessionTuple(value) {
  const ref = createSessionRef(value)
  return Object.freeze([ref.machineKey, ref.projectId, ref.sessionId])
}

/**
 * Canonical tuple of a project reference, in encoding order.
 * @param {unknown} value - candidate reference.
 * @returns {readonly [string, string]} frozen tuple.
 */
export function canonicalProjectTuple(value) {
  const ref = createProjectRef(value)
  return Object.freeze([ref.machineKey, ref.projectId])
}

function encodeTuple(prefix, tuple) {
  return `${prefix}${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}`
}

function decodeTuple(token, prefix, length, code, subject) {
  if (typeof token !== 'string') fail(code, `${subject} token must be a string`, { subject })
  if (token.length > MAX_OPAQUE_TOKEN_BYTES) fail(IDENTITY_CODES.VALUE_TOO_LONG, `${subject} token exceeds the decode budget`, { subject })
  if (!token.startsWith(prefix)) fail(code, `${subject} token has an unsupported prefix`, { subject })
  const body = token.slice(prefix.length)
  if (!BASE64URL_PATTERN.test(body)) fail(code, `${subject} token body is not base64url`, { subject })
  let text
  try {
    text = Buffer.from(body, 'base64url').toString('utf8')
  } catch {
    fail(code, `${subject} token body cannot be decoded`, { subject })
  }
  if (Buffer.from(text, 'utf8').toString('base64url') !== body) {
    fail(IDENTITY_CODES.NON_CANONICAL_TOKEN, `${subject} token is not canonical base64url`, { subject })
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    fail(code, `${subject} token does not contain JSON`, { subject })
  }
  if (!Array.isArray(parsed) || parsed.length !== length) fail(code, `${subject} token tuple has the wrong arity`, { subject })
  if (JSON.stringify(parsed) !== text) fail(IDENTITY_CODES.NON_CANONICAL_TOKEN, `${subject} token JSON is not canonical`, { subject })
  return parsed
}

/**
 * Encode a compound session reference as one opaque canonical token.
 * @param {unknown} value - session reference.
 * @returns {string} opaque token beginning with `fr1s.`.
 */
export function encodeSessionRef(value) {
  return encodeTuple(SESSION_REF_PREFIX, canonicalSessionTuple(value))
}

/**
 * Decode one opaque session token; aliases and non-canonical spellings are rejected.
 * @param {unknown} token - opaque token.
 * @returns {Readonly<{ machineKey: string, projectId: string, sessionId: string }>} frozen reference.
 */
export function decodeSessionRef(token) {
  const [machineKey, projectId, sessionId] = decodeTuple(
    token, SESSION_REF_PREFIX, 3, IDENTITY_CODES.INVALID_TOKEN, 'session reference',
  )
  return createSessionRef({ machineKey, projectId, sessionId })
}

/**
 * Test whether a value is a canonical session reference token.
 * @param {unknown} token - candidate.
 * @returns {boolean} whether it decodes.
 */
export function isSessionRefToken(token) {
  try {
    decodeSessionRef(token)
    return true
  } catch {
    return false
  }
}

/**
 * Encode a project reference as one opaque canonical token.
 * @param {unknown} value - project reference.
 * @returns {string} opaque token beginning with `fr1p.`.
 */
export function encodeProjectRef(value) {
  return encodeTuple(PROJECT_REF_PREFIX, canonicalProjectTuple(value))
}

/**
 * Decode one opaque project token; aliases and non-canonical spellings are rejected.
 * @param {unknown} token - opaque token.
 * @returns {Readonly<{ machineKey: string, projectId: string }>} frozen reference.
 */
export function decodeProjectRef(token) {
  const [machineKey, projectId] = decodeTuple(
    token, PROJECT_REF_PREFIX, 2, IDENTITY_CODES.INVALID_TOKEN, 'project reference',
  )
  return createProjectRef({ machineKey, projectId })
}

/**
 * Test whether a value is a canonical project reference token.
 * @param {unknown} token - candidate.
 * @returns {boolean} whether it decodes.
 */
export function isProjectRefToken(token) {
  try {
    decodeProjectRef(token)
    return true
  } catch {
    return false
  }
}

/**
 * Canonical opaque key for a session reference, safe for maps and messages.
 * @param {unknown} value - session reference.
 * @returns {string} canonical token.
 */
export function sessionRefKey(value) {
  return encodeSessionRef(value)
}

/**
 * Canonical opaque key for a project reference, safe for maps and messages.
 * @param {unknown} value - project reference.
 * @returns {string} canonical token.
 */
export function projectRefKey(value) {
  return encodeProjectRef(value)
}

/**
 * Compare two compound session references by canonical tuple.
 * @param {unknown} left - first reference.
 * @param {unknown} right - second reference.
 * @returns {boolean} whether both references name the same tuple.
 */
export function sameSessionRef(left, right) {
  const a = canonicalSessionTuple(left)
  const b = canonicalSessionTuple(right)
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

/**
 * Compare two project references by canonical tuple.
 * @param {unknown} left - first reference.
 * @param {unknown} right - second reference.
 * @returns {boolean} whether both references name the same tuple.
 */
export function sameProjectRef(left, right) {
  const a = canonicalProjectTuple(left)
  const b = canonicalProjectTuple(right)
  return a[0] === b[0] && a[1] === b[1]
}
