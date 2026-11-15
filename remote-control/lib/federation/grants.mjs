/**
 * Strict federation grants: explicit principal, machine, project and session permissions.
 *
 * A grant is a user-issued, versioned document. Nothing is implicit:
 * - projects are explicit or verified registrations bounded by captured/current templates;
 * - existing native sessions require explicit import, never project-registration adoption;
 * - actions are split by machine, project and session scope and never wildcarded;
 * - export classes are opt-in per project and can only be narrowed per session;
 * - an existing native session enters only through its own `imported: true` entry
 *   (never through cwd/path coincidence and never through the legacy localSessionId ACL);
 * - the latest revision wins; stale, expired, and revoked grants are denied.
 *
 * Parsers are strict (exact keys, frozen output). Evaluation returns a typed decision
 * instead of throwing for ordinary denials, so callers can fail closed without turning
 * a permission answer into a transport error.
 *
 * This module is pure: no I/O, no configuration, no process state.
 *
 * @module dsh-remote-control/federation/grants
 */

import {
  FederationContractError,
  IDENTITY_CODES,
  parseMachineKey,
  parseProjectId,
  parseSessionId,
} from './identity.mjs'

/** Grants document version. */
export const FEDERATION_GRANTS_VERSION = 1
/** Additive grant document version for explicit machine-owned project registration. */
export const PROJECT_REGISTRATION_GRANTS_VERSION = 2
/** Actions authorized only at machine scope. */
export const MACHINE_ACTIONS = Object.freeze(['project.register'])

/** Actions that a project-level entry can grant. */
export const PROJECT_ACTIONS = Object.freeze([
  'project.list',
  'session.list',
  'session.create',
  'model.list',
])

/** Actions that require an explicit session entry. */
export const SESSION_ACTIONS = Object.freeze([
  'session.status',
  'session.read',
  'session.follow',
  'session.prompt',
  'session.cancel',
  'model.select',
])

/** Every action the grants contract knows. */
export const GRANT_ACTIONS = Object.freeze([...MACHINE_ACTIONS, ...PROJECT_ACTIONS, ...SESSION_ACTIONS])

/** Action to scope table. */
export const ACTION_SCOPES = Object.freeze(Object.fromEntries(
  GRANT_ACTIONS.map(action => [action, MACHINE_ACTIONS.includes(action) ? 'machine' : PROJECT_ACTIONS.includes(action) ? 'project' : 'session']),
))

/**
 * Export classes. `conversation.user` and `conversation.assistant` are still opt-in;
 * tool output, metrics, reasoning, and files require their own explicit grants and reviewed serializers.
 */
export const EXPORT_CLASSES = Object.freeze([
  'conversation.user',
  'conversation.assistant',
  'conversation.system',
  'conversation.developer',
  'tool.call',
  'tool.result',
  'reasoning',
  'files',
  'turn',
  'model.selection',
  'todo',
  'goal',
  'title',
  'statistics',
  'context.metrics',
  'usage',
  'command',
  'unknown',
])

/**
 * Fixed serializer allowlist ratified by the v0 design, not a certificate of
 * independent serializer/runtime acceptance. Native fixture and integration review
 * are separate pre-wiring gates. A grant may name another class, but permission alone never authorizes raw export:
 * the serializer gate must also pass, and an unknown class fails closed.
 */
export const REVIEWED_EXPORT_CLASSES = Object.freeze([
  'conversation.user',
  'conversation.assistant',
  'tool.call',
  'tool.result',
  'turn',
  'model.selection',
  'title',
  'statistics',
  'context.metrics',
  'usage',
  'files',
])

/** Known export classes without a reviewed serializer yet; granted but withheld from raw export. */
export const PENDING_EXPORT_CLASSES = Object.freeze(
  EXPORT_CLASSES.filter(exportClass => !REVIEWED_EXPORT_CLASSES.includes(exportClass)),
)

/** Per-class serializer status; `pending` classes are withheld rather than serialized raw. */
export const EXPORT_CLASS_SERIALIZER = Object.freeze(Object.fromEntries(
  EXPORT_CLASSES.map(exportClass => [exportClass, REVIEWED_EXPORT_CLASSES.includes(exportClass) ? 'reviewed' : 'pending']),
))

const READ_ACTIONS = new Set(['session.read', 'session.follow'])

/** Stable grant failure/decision codes. */
export const GRANT_CODES = Object.freeze({
  INVALID: 'grant/invalid',
  INVALID_REQUEST: 'grant/invalid-request',
  INVALID_OPTIONS: 'grant/invalid-options',
  FORBIDDEN_FIELD: 'grant/forbidden-field',
  INVALID_PRINCIPAL: 'grant/invalid-principal',
  INVALID_MACHINE: 'grant/invalid-machine',
  INVALID_REVISION: 'grant/invalid-revision',
  INVALID_TIMESTAMP: 'grant/invalid-timestamp',
  INVALID_PROJECT: 'grant/invalid-project',
  INVALID_SESSION: 'grant/invalid-session',
  UNKNOWN_ACTION: 'grant/unknown-action',
  ACTION_SCOPE_MISMATCH: 'grant/action-scope-mismatch',
  UNKNOWN_EXPORT_CLASS: 'grant/unknown-export-class',
  DUPLICATE_PROJECT: 'grant/duplicate-project',
  DUPLICATE_SESSION: 'grant/duplicate-session',
  DUPLICATE_ACTION: 'grant/duplicate-action',
  DUPLICATE_EXPORT_CLASS: 'grant/duplicate-export-class',
  EXPORT_CLASS_SUBSET_VIOLATION: 'grant/export-class-subset-violation',
  STALE_REVISION: 'grant/stale-revision',
  EXPIRED: 'grant/expired',
  REVOKED: 'grant/revoked',
  PRINCIPAL_MISMATCH: 'grant/principal-mismatch',
  MACHINE_MISMATCH: 'grant/machine-mismatch',
  PROJECT_NOT_GRANTED: 'grant/project-not-granted',
  SESSION_NOT_GRANTED: 'grant/session-not-granted',
  ACTION_NOT_GRANTED: 'grant/action-not-granted',
  EXPORT_CLASS_REQUIRED: 'grant/export-class-required',
  EXPORT_CLASS_NOT_GRANTED: 'grant/export-class-not-granted',
  EXPORT_CLASS_UNEXPECTED: 'grant/export-class-unexpected',
  EXPORT_CLASS_SERIALIZER_PENDING: 'grant/export-class-serializer-pending',
  PATH_ADOPTION_NOT_ALLOWED: 'grant/path-adoption-not-allowed',
  REVISION_NOT_ADVANCED: 'grant/revision-not-advanced',
})

const ACTION_SET = new Set(GRANT_ACTIONS)
const EXPORT_CLASS_SET = new Set(EXPORT_CLASSES)
const MACHINE_ACTION_SET = new Set(MACHINE_ACTIONS)
const PROJECT_ACTION_SET = new Set(PROJECT_ACTIONS)
const SESSION_ACTION_SET = new Set(SESSION_ACTIONS)
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/
const GRANT_TOP_FORBIDDEN = Object.freeze([
  'cwd', 'path', 'hostname', 'relayUrl', 'url', 'localSessionId', 'generation',
  'pairingGeneration', 'legacy', 'wildcard', 'allSessions', 'allProjects',
])
const REQUEST_FORBIDDEN = Object.freeze([
  'localSessionId', 'hostname', 'relayUrl', 'url', 'generation', 'pairingGeneration',
  'legacy', 'wildcard', 'imported',
])
const PATH_FIELDS = new Set(['cwd', 'path'])

const fail = (code, message, detail) => { throw new FederationContractError(code, message, detail) }

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)

const isSafePositiveInteger = value => Number.isSafeInteger(value) && value > 0
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0

function assertRecord(value, subject, { required, optional = [], forbidden = [], code = GRANT_CODES.INVALID } = {}) {
  if (!isRecord(value)) fail(code, `${subject} must be a plain JSON object`, { subject })
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue
    if (RESERVED_KEYS.has(key)) fail(GRANT_CODES.FORBIDDEN_FIELD, `${subject} carries a reserved field`, { subject })
    if (forbidden.includes(key)) fail(GRANT_CODES.FORBIDDEN_FIELD, `${subject} must not carry "${key}"`, { subject, field: key })
    fail(code, `${subject} carries unknown field "${key}"`, { subject, field: key })
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(code, `${subject} requires "${key}"`, { subject, field: key })
  }
  return value
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

function parseStringArray(value, subject, allowed, code, duplicateCode) {
  if (!Array.isArray(value)) fail(code, `${subject} must be an array`, { subject })
  if (value.length > 64) fail(code, `${subject} exceeds 64 entries`, { subject })
  const seen = new Set()
  const result = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.has(entry)) fail(code, `${subject} contains an unsupported value`, { subject })
    if (seen.has(entry)) fail(duplicateCode, `${subject} contains a duplicate value`, { subject })
    seen.add(entry)
    result.push(entry)
  }
  return result
}

function parseActions(value, subject, scope) {
  const allowed = scope === 'machine' ? MACHINE_ACTION_SET : scope === 'project' ? PROJECT_ACTION_SET : SESSION_ACTION_SET
  const result = []
  const seen = new Set()
  if (!Array.isArray(value)) fail(GRANT_CODES.INVALID, `${subject} must be an array`, { subject })
  if (value.length > 32) fail(GRANT_CODES.INVALID, `${subject} exceeds 32 entries`, { subject })
  for (const action of value) {
    if (typeof action !== 'string' || !ACTION_SET.has(action)) {
      fail(GRANT_CODES.UNKNOWN_ACTION, `${subject} contains an unknown action`, { subject })
    }
    if (!allowed.has(action)) {
      fail(GRANT_CODES.ACTION_SCOPE_MISMATCH, `${subject} contains an action outside its scope`, { subject, action })
    }
    if (seen.has(action)) fail(GRANT_CODES.DUPLICATE_ACTION, `${subject} contains a duplicate action`, { subject, action })
    seen.add(action)
    result.push(action)
  }
  return result
}

function parseExportClasses(value, subject, maximum) {
  const classes = parseStringArray(
    value, subject, EXPORT_CLASS_SET, GRANT_CODES.UNKNOWN_EXPORT_CLASS, GRANT_CODES.DUPLICATE_EXPORT_CLASS,
  )
  if (maximum !== undefined) {
    const allowed = new Set(maximum)
    for (const entry of classes) {
      if (!allowed.has(entry)) {
        fail(GRANT_CODES.EXPORT_CLASS_SUBSET_VIOLATION, `${subject} exceeds the project maximum`, { subject, exportClass: entry })
      }
    }
  }
  return classes
}

function parsePrincipal(value) {
  assertRecord(value, 'grant principal', {
    required: ['kind', 'id'],
    code: GRANT_CODES.INVALID_PRINCIPAL,
  })
  if (value.kind !== 'controller') {
    fail(GRANT_CODES.INVALID_PRINCIPAL, 'grant principal must be a controller', { field: 'kind' })
  }
  let id
  try {
    id = parseMachineKey(value.id)
  } catch {
    fail(GRANT_CODES.INVALID_PRINCIPAL, 'grant principal id has an unsupported format', { field: 'id' })
  }
  return { kind: 'controller', id }
}

function parseMachine(value) {
  try {
    return parseMachineKey(value)
  } catch {
    fail(GRANT_CODES.INVALID_MACHINE, 'grant machineKey has an unsupported format', { field: 'machineKey' })
  }
}

function parseCreatedSessionGrant(value, maximum) {
  assertRecord(value, 'created session grant template', { required: ['actions', 'exportClasses'], code: GRANT_CODES.INVALID_PROJECT })
  return {
    actions: parseActions(value.actions, 'created session actions', 'session'),
    exportClasses: parseExportClasses(value.exportClasses, 'created session export classes', maximum),
  }
}

/** Parse the captured/current project policy, never a native workspace or session inventory.
 * @param {unknown} value - untrusted project permission template.
 * @returns {Readonly<object>} frozen copied policy with no identifiers or paths.
 */
export function parseProjectGrantTemplate(value) {
  try {
    assertRecord(value, 'project grant template', { required: ['actions', 'exportClasses'], optional: ['createdSessionGrant'], code: GRANT_CODES.INVALID_PROJECT })
    const actions = parseActions(value.actions, 'project template actions', 'project')
    const exportClasses = parseExportClasses(value.exportClasses, 'project template export classes')
    const createdSessionGrant = value.createdSessionGrant === undefined ? undefined : parseCreatedSessionGrant(value.createdSessionGrant, exportClasses)
    return deepFreeze({ actions, exportClasses, ...(createdSessionGrant === undefined ? {} : { createdSessionGrant }) })
  } catch (error) {
    fail(error instanceof FederationContractError ? error.code : GRANT_CODES.INVALID_PROJECT, 'project grant template is invalid')
  }
}

function parseProjectRegistration(value) {
  try {
    assertRecord(value, 'project registration grant', { required: ['actions', 'projectGrant'], code: GRANT_CODES.INVALID_PROJECT })
    const actions = parseActions(value.actions, 'project registration actions', 'machine')
    if (actions.length !== 1) fail(GRANT_CODES.INVALID_PROJECT, 'project registration requires its explicit action')
    return { actions, projectGrant: parseProjectGrantTemplate(value.projectGrant) }
  } catch (error) {
    fail(error instanceof FederationContractError ? error.code : GRANT_CODES.INVALID_PROJECT, 'project registration grant is invalid')
  }
}

function parseProject(value, seenSessions, seenProjects) {
  assertRecord(value, 'grant project', {
    required: ['projectId', 'actions', 'exportClasses', 'sessions'],
    optional: ['createdSessionGrant'],
    forbidden: GRANT_TOP_FORBIDDEN,
    code: GRANT_CODES.INVALID_PROJECT,
  })
  let projectId
  try {
    projectId = parseProjectId(value.projectId)
  } catch {
    fail(GRANT_CODES.INVALID_PROJECT, 'grant projectId has an unsupported format', { field: 'projectId' })
  }
  if (seenProjects.has(projectId)) fail(GRANT_CODES.DUPLICATE_PROJECT, 'grant names one project twice', { field: 'projectId' })
  seenProjects.add(projectId)
  const actions = parseActions(value.actions, 'grant project actions', 'project')
  const exportClasses = parseExportClasses(value.exportClasses, 'grant project export classes')
  if (!Array.isArray(value.sessions)) fail(GRANT_CODES.INVALID_PROJECT, 'grant project sessions must be an array', { field: 'sessions' })
  if (value.sessions.length > 256) fail(GRANT_CODES.INVALID_PROJECT, 'grant project sessions exceeds 256 entries', { field: 'sessions' })
  const sessions = value.sessions.map(session => parseSession(session, exportClasses, seenSessions))
  let createdSessionGrant
  if (value.createdSessionGrant !== undefined) {
    createdSessionGrant = parseCreatedSessionGrant(value.createdSessionGrant, exportClasses)
  }
  return { projectId, actions, exportClasses, sessions, ...(createdSessionGrant === undefined ? {} : { createdSessionGrant }) }
}

function parseSession(value, projectExportClasses, seenSessions) {
  assertRecord(value, 'grant session', {
    required: ['sessionId', 'imported', 'actions'],
    optional: ['exportClasses'],
    forbidden: GRANT_TOP_FORBIDDEN,
    code: GRANT_CODES.INVALID_SESSION,
  })
  let sessionId
  try {
    sessionId = parseSessionId(value.sessionId)
  } catch {
    fail(GRANT_CODES.INVALID_SESSION, 'grant sessionId has an unsupported format', { field: 'sessionId' })
  }
  if (typeof value.imported !== 'boolean') fail(GRANT_CODES.INVALID_SESSION, 'grant session.imported must be a boolean', { field: 'imported' })
  const actions = parseActions(value.actions, 'grant session actions', 'session')
  const exportClasses = value.exportClasses === undefined
    ? undefined
    : parseExportClasses(value.exportClasses, 'grant session export classes', projectExportClasses)
  if (seenSessions.has(sessionId)) fail(GRANT_CODES.DUPLICATE_SESSION, 'grant names one session twice', { field: 'sessionId' })
  seenSessions.add(sessionId)
  return { sessionId, imported: value.imported, actions, exportClasses }
}

/**
 * Strict grant parser. Unknown keys, implicit paths, wildcards, and legacy fields are rejected.
 * @param {unknown} value - candidate grant document.
 * @returns {Readonly<object>} frozen normalized grant.
 */
export function parseGrant(value) {
  assertRecord(value, 'grant', {
    required: ['version', 'grantId', 'principal', 'machineKey', 'revision', 'issuedAt', 'projects'],
    optional: ['expiresAt', 'revokedAt', ...(isRecord(value) && value.version === PROJECT_REGISTRATION_GRANTS_VERSION ? ['projectRegistration'] : [])],
    forbidden: GRANT_TOP_FORBIDDEN,
    code: GRANT_CODES.INVALID,
  })
  if (value.version !== FEDERATION_GRANTS_VERSION && value.version !== PROJECT_REGISTRATION_GRANTS_VERSION) fail(GRANT_CODES.INVALID, 'unsupported grants version', { field: 'version' })
  if (typeof value.grantId !== 'string' || !GRANT_ID_PATTERN.test(value.grantId) || RESERVED_KEYS.has(value.grantId)) {
    fail(GRANT_CODES.INVALID, 'grantId has an unsupported format', { field: 'grantId' })
  }
  const principal = parsePrincipal(value.principal)
  const machineKey = parseMachine(value.machineKey)
  if (!isSafePositiveInteger(value.revision)) fail(GRANT_CODES.INVALID_REVISION, 'revision must be a positive safe integer', { field: 'revision' })
  if (!isNonNegativeInteger(value.issuedAt)) fail(GRANT_CODES.INVALID_TIMESTAMP, 'issuedAt must be epoch milliseconds', { field: 'issuedAt' })
  if (value.expiresAt !== undefined) {
    if (!isNonNegativeInteger(value.expiresAt) || value.expiresAt <= value.issuedAt) {
      fail(GRANT_CODES.INVALID_TIMESTAMP, 'expiresAt must be after issuedAt', { field: 'expiresAt' })
    }
  }
  if (value.revokedAt !== undefined) {
    if (!isNonNegativeInteger(value.revokedAt) || value.revokedAt < value.issuedAt) {
      fail(GRANT_CODES.INVALID_TIMESTAMP, 'revokedAt must not precede issuedAt', { field: 'revokedAt' })
    }
  }
  const minimumProjects = value.version === FEDERATION_GRANTS_VERSION ? 1 : 0
  if (!Array.isArray(value.projects) || value.projects.length < minimumProjects || value.projects.length > 64) {
    fail(GRANT_CODES.INVALID, `grant projects must contain ${minimumProjects}-64 entries`, { field: 'projects' })
  }
  const seenProjects = new Set()
  const seenSessions = new Set()
  const projects = value.projects.map(project => parseProject(project, seenSessions, seenProjects))
  const projectRegistration = value.version === PROJECT_REGISTRATION_GRANTS_VERSION && value.projectRegistration !== undefined ? parseProjectRegistration(value.projectRegistration) : undefined
  const parsed = {
    version: value.version,
    grantId: value.grantId,
    principal,
    machineKey,
    revision: value.revision,
    issuedAt: value.issuedAt,
    ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
    ...(value.revokedAt === undefined ? {} : { revokedAt: value.revokedAt }),
    projects,
    ...(projectRegistration === undefined ? {} : { projectRegistration }),
  }
  return deepFreeze(parsed)
}

function parseProjectOwnership(value) {
  try {
    if (!Array.isArray(value) || value.length > 256) fail(GRANT_CODES.INVALID_OPTIONS, 'invalid project ownership inventory')
    const projects = new Set(), requests = new Set(), entries = []
    for (const row of value) {
      assertRecord(row, 'Worker committed project ownership', {
        required: ['state', 'principal', 'machineKey', 'projectId', 'registerRequestId', 'projectGrant'], code: GRANT_CODES.INVALID_OPTIONS,
      })
      const principal = parsePrincipal(row.principal), machineKey = parseMachineKey(row.machineKey), projectId = parseProjectId(row.projectId)
      if (row.state !== 'committed' || typeof row.registerRequestId !== 'string' || !GRANT_ID_PATTERN.test(row.registerRequestId) || RESERVED_KEYS.has(row.registerRequestId)) fail(GRANT_CODES.INVALID_OPTIONS, 'project ownership requires a committed registration')
      const projectKey = JSON.stringify([principal.kind, principal.id, machineKey, projectId])
      const requestKey = JSON.stringify([principal.kind, principal.id, machineKey, row.registerRequestId])
      if (projects.has(projectKey) || requests.has(requestKey)) fail(GRANT_CODES.INVALID_OPTIONS, 'duplicate project ownership')
      projects.add(projectKey); requests.add(requestKey)
      entries.push({ state: 'committed', principal, machineKey, projectId, registerRequestId: row.registerRequestId, projectGrant: parseProjectGrantTemplate(row.projectGrant) })
    }
    return deepFreeze(entries)
  } catch { fail(GRANT_CODES.INVALID_OPTIONS, 'Worker project ownership is invalid') }
}

function parseOptions(options) {
  assertRecord(options, 'grant evaluation options', {
    required: ['currentRevision', 'now'],
    optional: ['remoteOwnedSessions', 'remoteOwnedProjects'],
    code: GRANT_CODES.INVALID_OPTIONS,
  })
  if (!isSafePositiveInteger(options.currentRevision)) {
    fail(GRANT_CODES.INVALID_OPTIONS, 'currentRevision must be a positive safe integer', { field: 'currentRevision' })
  }
  if (!isNonNegativeInteger(options.now)) {
    fail(GRANT_CODES.INVALID_OPTIONS, 'now must be epoch milliseconds', { field: 'now' })
  }
  const remoteOwnedSessions = options.remoteOwnedSessions ?? []
  if (!Array.isArray(remoteOwnedSessions) || remoteOwnedSessions.length > 256) fail(GRANT_CODES.INVALID_OPTIONS, 'invalid Worker ownership inventory')
  for (const row of remoteOwnedSessions) {
    assertRecord(row, 'Worker committed ownership', {
      required: ['principal', 'machineKey', 'projectId', 'sessionId', 'createRequestId', 'state'], code: GRANT_CODES.INVALID_OPTIONS,
    })
    parsePrincipal(row.principal)
    parseMachineKey(row.machineKey)
    parseProjectId(row.projectId)
    parseSessionId(row.sessionId)
    if (row.state !== 'committed' || typeof row.createRequestId !== 'string' || !GRANT_ID_PATTERN.test(row.createRequestId)) {
      fail(GRANT_CODES.INVALID_OPTIONS, 'ownership requires a committed correlated create result')
    }
  }
  const remoteOwnedProjects = parseProjectOwnership(options.remoteOwnedProjects === undefined ? [] : options.remoteOwnedProjects)
  return { currentRevision: options.currentRevision, now: options.now, remoteOwnedSessions, remoteOwnedProjects }
}

function statusOf(grant, options) {
  if (grant.revokedAt !== undefined && options.now >= grant.revokedAt) {
    return Object.freeze({ status: 'revoked', code: GRANT_CODES.REVOKED })
  }
  if (grant.expiresAt !== undefined && options.now >= grant.expiresAt) {
    return Object.freeze({ status: 'expired', code: GRANT_CODES.EXPIRED })
  }
  if (grant.revision !== options.currentRevision) {
    return Object.freeze({ status: 'stale', code: GRANT_CODES.STALE_REVISION })
  }
  return Object.freeze({ status: 'active' })
}

/**
 * Classify a grant against the current revision and clock.
 * @param {unknown} grant - parsed or raw grant.
 * @param {{ currentRevision: number, now: number }} options - authority revision and epoch ms.
 * @returns {Readonly<{ status: 'active'|'stale'|'expired'|'revoked', code?: string }>} status.
 */
export function grantStatus(grant, options) {
  const parsed = parseGrant(grant)
  return statusOf(parsed, parseOptions(options))
}

/**
 * Require an active grant or throw its typed denial code.
 * @param {unknown} grant - parsed or raw grant.
 * @param {{ currentRevision: number, now: number }} options - authority revision and epoch ms.
 * @returns {Readonly<object>} the parsed grant.
 */
export function requireActiveGrant(grant, options) {
  const parsed = parseGrant(grant)
  const status = statusOf(parsed, parseOptions(options))
  if (status.status !== 'active') {
    fail(status.code, `grant is not active: ${status.status}`, { status: status.status })
  }
  return parsed
}

/**
 * Require a strictly newer revision; used by future user-only issuance paths.
 * @param {number | { revision: number }} next - next revision or candidate grant.
 * @param {number} currentRevision - active revision.
 * @returns {number} accepted next revision.
 */
export function assertRevisionAdvance(next, currentRevision) {
  if (!isSafePositiveInteger(currentRevision)) {
    fail(GRANT_CODES.INVALID_OPTIONS, 'currentRevision must be a positive safe integer', { field: 'currentRevision' })
  }
  const nextRevision = typeof next === 'number'
    ? next
    : (isRecord(next) ? next.revision : undefined)
  if (!isSafePositiveInteger(nextRevision)) {
    fail(GRANT_CODES.INVALID_REVISION, 'next revision must be a positive safe integer', { field: 'revision' })
  }
  if (nextRevision <= currentRevision) {
    fail(GRANT_CODES.REVISION_NOT_ADVANCED, 'next revision must advance past the current revision', {
      currentRevision, nextRevision,
    })
  }
  return nextRevision
}

const intersection = (captured, current) => captured.filter(value => current.includes(value))
function intersectProjectTemplate(captured, current) {
  const actions = intersection(captured.actions, current.actions), exportClasses = intersection(captured.exportClasses, current.exportClasses)
  const createdSessionGrant = captured.createdSessionGrant && current.createdSessionGrant ? {
    actions: intersection(captured.createdSessionGrant.actions, current.createdSessionGrant.actions),
    exportClasses: intersection(captured.createdSessionGrant.exportClasses, current.createdSessionGrant.exportClasses).filter(value => exportClasses.includes(value)),
  } : undefined
  return { actions, exportClasses, ...(createdSessionGrant === undefined ? {} : { createdSessionGrant }) }
}
function projectsOf(grant, options) {
  const entries = [...grant.projects], ids = new Set(entries.map(row => row.projectId))
  const permission = grant.version === PROJECT_REGISTRATION_GRANTS_VERSION ? grant.projectRegistration : undefined
  if (!permission?.actions.includes('project.register')) return entries
  for (const row of options.remoteOwnedProjects) {
    if (ids.has(row.projectId) || row.principal.kind !== grant.principal.kind || row.principal.id !== grant.principal.id || row.machineKey !== grant.machineKey) continue
    ids.add(row.projectId)
    entries.push({ projectId: row.projectId, ...intersectProjectTemplate(row.projectGrant, permission.projectGrant), sessions: [] })
  }
  return entries
}

/** Resolve explicit projects and verified captured/current registration policies, never native session inventories.
 * @param {unknown} grant - current Worker grant.
 * @param {object} options - current revision, clock and verified committed ownership.
 * @returns {readonly object[]} active frozen project entries; explicit entries always win.
 */
export function effectiveProjectEntries(grant, options) {
  const parsed = parseGrant(grant), checked = parseOptions(options)
  return deepFreeze(statusOf(parsed, checked).status === 'active' ? projectsOf(parsed, checked) : [])
}

function ownedFor(grant, projectId, sessionId, options) {
  return options.remoteOwnedSessions.some(row => row.principal.kind === grant.principal.kind && row.principal.id === grant.principal.id
    && row.machineKey === grant.machineKey && row.projectId === projectId && row.sessionId === sessionId)
}

function sessionsOf(grant, project, options) {
  const entries = [...project.sessions]
  if (!project.createdSessionGrant || !project.actions.includes('session.create')) return entries
  const ids = new Set(entries.map(row => row.sessionId))
  for (const row of options.remoteOwnedSessions) {
    if (ids.has(row.sessionId) || !ownedFor(grant, project.projectId, row.sessionId, options)) continue
    ids.add(row.sessionId)
    entries.push({ sessionId: row.sessionId, imported: false, actions: [...project.createdSessionGrant.actions], exportClasses: [...project.createdSessionGrant.exportClasses] })
  }
  return entries
}

/** Read explicit or currently template-derived entries for verified created sessions.
 * @param {unknown} grant - Worker grant authority.
 * @param {string} projectId - exact project.
 * @param {object} options - Worker-owned active revision, clock and committed ownership inventory.
 * @returns {readonly object[]} entries without widening explicit per-session decisions.
 */
export function effectiveSessionEntries(grant, projectId, options) {
  const parsed = parseGrant(grant), checked = parseOptions(options)
  if (statusOf(parsed, checked).status !== 'active') return Object.freeze([])
  const project = projectsOf(parsed, checked).find(row => row.projectId === parseProjectId(projectId))
  return deepFreeze(project ? sessionsOf(parsed, project, checked) : [])
}

/** Check explicit import or Worker-journal-backed ownership, without granting an action.
 * @param {unknown} grant - explicit grant document.
 * @param {{projectId:string,sessionId:string}} ref - exact session.
 * @param {object} options - Worker-owned revision, clock and committed ownership inventory.
 * @returns {boolean} whether session admission is supported by current authority.
 */
export function sessionAdmissionAllowed(grant, ref, options) {
  // Internal parsed evaluation requests may carry other action fields; admission
  // reads only the exact native tuple, never path or display metadata.
  if (!isRecord(ref)) fail(GRANT_CODES.INVALID_REQUEST, 'session admission requires a reference')
  parseProjectId(ref.projectId)
  parseSessionId(ref.sessionId)
  const parsed = parseGrant(grant)
  const checked = parseOptions(options)
  if (statusOf(parsed, checked).status !== 'active') return false
  const project = projectsOf(parsed, checked).find(row => row.projectId === ref.projectId)
  const session = project && sessionsOf(parsed, project, checked).find(row => row.sessionId === ref.sessionId)
  if (!session) return false
  const owned = ownedFor(parsed, ref.projectId, ref.sessionId, checked)
  return session.imported ? !owned : owned
}

const deny = (code, detail) => Object.freeze({ allowed: false, code, ...(detail === undefined ? {} : { detail }) })

function parseEvaluationRequest(value) {
  if (!isRecord(value)) fail(GRANT_CODES.INVALID_REQUEST, 'grant request must be a plain JSON object')
  const allowed = new Set(['principal', 'machineKey', 'action', 'projectId', 'sessionId', 'exportClasses'])
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue
    if (PATH_FIELDS.has(key)) {
      fail(GRANT_CODES.PATH_ADOPTION_NOT_ALLOWED, 'path-based adoption is not allowed', { field: key })
    }
    if (REQUEST_FORBIDDEN.includes(key)) {
      fail(GRANT_CODES.FORBIDDEN_FIELD, `grant request must not carry "${key}"`, { field: key })
    }
    fail(GRANT_CODES.INVALID_REQUEST, `grant request carries unknown field "${key}"`, { field: key })
  }
  for (const key of ['principal', 'machineKey', 'action']) {
    if (!Object.hasOwn(value, key)) fail(GRANT_CODES.INVALID_REQUEST, `grant request requires "${key}"`, { field: key })
  }
  if (typeof value.action !== 'string' || !ACTION_SET.has(value.action)) {
    fail(GRANT_CODES.UNKNOWN_ACTION, 'grant request carries an unknown action', { field: 'action' })
  }
  if (ACTION_SCOPES[value.action] === 'machine') {
    if (['projectId', 'sessionId', 'exportClasses'].some(key => Object.hasOwn(value, key))) fail(GRANT_CODES.INVALID_REQUEST, 'machine-scoped action accepts no project, session or export fields')
    return { principal: parsePrincipal(value.principal), machineKey: parseMachine(value.machineKey), action: value.action }
  }
  if (value.projectId === undefined) fail(GRANT_CODES.INVALID_REQUEST, 'grant request requires "projectId"', { field: 'projectId' })
  const machineKey = parseMachine(value.machineKey)
  const projectId = (() => {
    try {
      return parseProjectId(value.projectId)
    } catch {
      fail(GRANT_CODES.INVALID_PROJECT, 'grant request projectId has an unsupported format', { field: 'projectId' })
    }
  })()
  const principal = parsePrincipal(value.principal)
  const scope = ACTION_SCOPES[value.action]
  let sessionId
  if (scope === 'session') {
    if (value.sessionId === undefined) fail(GRANT_CODES.INVALID_REQUEST, 'session-scoped action requires "sessionId"', { field: 'sessionId' })
    try {
      sessionId = parseSessionId(value.sessionId)
    } catch {
      fail(GRANT_CODES.INVALID_SESSION, 'grant request sessionId has an unsupported format', { field: 'sessionId' })
    }
  } else if (value.sessionId !== undefined) {
    fail(GRANT_CODES.INVALID_REQUEST, 'project-scoped action must not carry "sessionId"', { field: 'sessionId' })
  }
  let exportClasses
  if (value.exportClasses !== undefined) {
    if (!Array.isArray(value.exportClasses) || value.exportClasses.length > EXPORT_CLASSES.length) fail(GRANT_CODES.INVALID_REQUEST, 'exportClasses must be an array of at most 16 entries', { field: 'exportClasses' })
    const seen = new Set()
    exportClasses = []
    for (const entry of value.exportClasses) {
      if (typeof entry !== 'string' || !EXPORT_CLASS_SET.has(entry)) {
        fail(GRANT_CODES.UNKNOWN_EXPORT_CLASS, 'requested export class is unknown', { field: 'exportClasses' })
      }
      if (seen.has(entry)) fail(GRANT_CODES.DUPLICATE_EXPORT_CLASS, 'requested export class is duplicated', { field: 'exportClasses' })
      seen.add(entry)
      exportClasses.push(entry)
    }
  }
  return { principal, machineKey, action: value.action, projectId, sessionId, exportClasses }
}

/**
 * Evaluate one action request against a grant. Ordinary denials return `allowed: false`.
 * @param {unknown} grant - parsed or raw grant.
 * @param {unknown} request - `{ principal, machineKey, action, projectId, sessionId?, exportClasses? }`.
 * @param {{ currentRevision: number, now: number }} options - authority revision and epoch ms.
 * @returns {Readonly<object>} frozen allow/deny decision.
 */
export function evaluateGrant(grant, request, options) {
  const parsed = parseGrant(grant)
  const evaluatedOptions = parseOptions(options)
  const input = parseEvaluationRequest(request)
  const status = statusOf(parsed, evaluatedOptions)
  if (status.status !== 'active') return deny(status.code, { status: status.status })
  if (input.principal.kind !== parsed.principal.kind || input.principal.id !== parsed.principal.id) {
    return deny(GRANT_CODES.PRINCIPAL_MISMATCH)
  }
  if (input.machineKey !== parsed.machineKey) return deny(GRANT_CODES.MACHINE_MISMATCH)
  if (ACTION_SCOPES[input.action] === 'machine') {
    const permission = parsed.version === PROJECT_REGISTRATION_GRANTS_VERSION ? parsed.projectRegistration : undefined
    if (!permission?.actions.includes(input.action)) return deny(GRANT_CODES.ACTION_NOT_GRANTED, { action: input.action })
    return Object.freeze({ allowed: true, action: input.action, projectGrant: permission.projectGrant })
  }
  const project = projectsOf(parsed, evaluatedOptions).find(entry => entry.projectId === input.projectId)
  if (project === undefined) return deny(GRANT_CODES.PROJECT_NOT_GRANTED)
  const requiresExport = READ_ACTIONS.has(input.action)
  if (requiresExport) {
    if (input.exportClasses === undefined || input.exportClasses.length === 0) {
      return deny(GRANT_CODES.EXPORT_CLASS_REQUIRED, { action: input.action })
    }
  } else if (input.exportClasses !== undefined) {
    return deny(GRANT_CODES.EXPORT_CLASS_UNEXPECTED, { action: input.action })
  }
  if (ACTION_SCOPES[input.action] === 'project') {
    if (!project.actions.includes(input.action) || (input.action === 'session.create' && project.createdSessionGrant === undefined)) return deny(GRANT_CODES.ACTION_NOT_GRANTED, { action: input.action })
    return Object.freeze({
      allowed: true,
      action: input.action,
      projectId: input.projectId,
      exportClasses: Object.freeze([]),
    })
  }
  const session = sessionsOf(parsed, project, evaluatedOptions).find(entry => entry.sessionId === input.sessionId)
  if (session === undefined) return deny(GRANT_CODES.SESSION_NOT_GRANTED)
  // This evidence comes only from the authenticated Worker's durable create journal,
  // never from request fields, reserved IDs, cwd, or an existing matching native row.
  if (!sessionAdmissionAllowed(parsed, input, evaluatedOptions)) {
    return deny(GRANT_CODES.SESSION_NOT_GRANTED)
  }
  if (!session.actions.includes(input.action)) return deny(GRANT_CODES.ACTION_NOT_GRANTED, { action: input.action })
  const effectiveClasses = session.exportClasses ?? project.exportClasses
  if (requiresExport) {
    const allowed = new Set(effectiveClasses)
    for (const exportClass of input.exportClasses) {
      if (!allowed.has(exportClass)) return deny(GRANT_CODES.EXPORT_CLASS_NOT_GRANTED, { exportClass })
    }
  }
  return Object.freeze({
    allowed: true,
    action: input.action,
    projectId: input.projectId,
    sessionId: input.sessionId,
    imported: session.imported,
    exportClasses: Object.freeze(requiresExport ? [...input.exportClasses] : []),
  })
}

/**
 * Boolean convenience wrapper over {@link evaluateGrant}.
 * @param {unknown} grant - parsed or raw grant.
 * @param {unknown} request - evaluation request.
 * @param {{ currentRevision: number, now: number }} options - authority revision and epoch ms.
 * @returns {boolean} whether the request is allowed.
 */
export function grantAllows(grant, request, options) {
  return evaluateGrant(grant, request, options).allowed
}

/**
 * Effective export classes after project maximum plus optional session narrowing.
 * Missing project/session grants fail explicitly instead of silently widening access.
 * @param {unknown} grant - parsed or raw grant.
 * @param {{ projectId: string, sessionId?: string }} ref - granted project and optional session.
 * @param {object} [options] - current authority and verified ownership for derived entries.
 * @returns {readonly string[]} frozen allowed classes.
 */
export function effectiveExportClasses(grant, ref, options) {
  const parsed = parseGrant(grant)
  assertRecord(ref, 'grant export reference', {
    required: ['projectId'],
    optional: ['sessionId'],
    forbidden: GRANT_TOP_FORBIDDEN,
    code: GRANT_CODES.INVALID_REQUEST,
  })
  let projectId
  try {
    projectId = parseProjectId(ref.projectId)
  } catch {
    fail(GRANT_CODES.INVALID_PROJECT, 'export reference projectId has an unsupported format', { field: 'projectId' })
  }
  const checked = options === undefined ? undefined : parseOptions(options)
  if (checked) {
    const status = statusOf(parsed, checked)
    if (status.status !== 'active') fail(status.code, `grant is not active: ${status.status}`, { status: status.status })
  }
  const project = (checked ? projectsOf(parsed, checked) : parsed.projects).find(entry => entry.projectId === projectId)
  if (project === undefined) fail(GRANT_CODES.PROJECT_NOT_GRANTED, 'project is not granted', { projectId })
  if (ref.sessionId === undefined) return Object.freeze([...project.exportClasses])
  let sessionId
  try {
    sessionId = parseSessionId(ref.sessionId)
  } catch {
    fail(GRANT_CODES.INVALID_SESSION, 'export reference sessionId has an unsupported format', { field: 'sessionId' })
  }
  const session = (checked ? sessionsOf(parsed, project, checked) : project.sessions).find(entry => entry.sessionId === sessionId)
  if (session === undefined) fail(GRANT_CODES.SESSION_NOT_GRANTED, 'session is not granted', { projectId, sessionId })
  return Object.freeze([...(session.exportClasses ?? project.exportClasses)])
}

/**
 * Serializer status for one known export class.
 * @param {unknown} exportClass - export class name.
 * @returns {'reviewed' | 'pending'} serializer status; unknown classes fail closed.
 */
export function exportClassSerializerStatus(exportClass) {
  if (typeof exportClass !== 'string' || !EXPORT_CLASS_SET.has(exportClass)) {
    fail(GRANT_CODES.UNKNOWN_EXPORT_CLASS, 'export class is unknown', { field: 'exportClass' })
  }
  return EXPORT_CLASS_SERIALIZER[exportClass]
}

const REVIEWED_CLASS_SET = new Set(REVIEWED_EXPORT_CLASSES)

/**
 * Require a reviewed schema-aware serializer for one export class.
 * Unknown classes fail closed with `grant/unknown-export-class`; known classes whose
 * serializer is not reviewed fail closed with `grant/export-class-serializer-pending`.
 * @param {unknown} exportClass - export class name.
 * @returns {string} the accepted class.
 */
export function requireReviewedExportClass(exportClass) {
  if (arguments.length !== 1) fail(GRANT_CODES.INVALID_OPTIONS, 'serializer review overrides are forbidden')
  if (typeof exportClass !== 'string' || !EXPORT_CLASS_SET.has(exportClass)) {
    fail(GRANT_CODES.UNKNOWN_EXPORT_CLASS, 'export class is unknown', { field: 'exportClass' })
  }
  if (!REVIEWED_CLASS_SET.has(exportClass)) {
    fail(GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING, `export class "${exportClass}" has no reviewed serializer`, { exportClass })
  }
  return exportClass
}

/**
 * Require reviewed serializers for a whole requested class list, atomically.
 * A grant-only allow decision is not enough to emit raw content.
 * @param {readonly string[]} classes - requested export classes.
 * @returns {readonly string[]} frozen accepted classes, preserving order.
 */
export function assertReviewedExportClasses(classes) {
  if (arguments.length !== 1) fail(GRANT_CODES.INVALID_OPTIONS, 'serializer review overrides are forbidden')
  if (Array.isArray(classes) && classes.length > EXPORT_CLASSES.length) fail(GRANT_CODES.INVALID_REQUEST, 'too many export classes')
  if (!Array.isArray(classes) || classes.length === 0) {
    fail(GRANT_CODES.EXPORT_CLASS_REQUIRED, 'at least one export class is required', { field: 'classes' })
  }
  const seen = new Set()
  for (const exportClass of classes) {
    if (seen.has(exportClass)) fail(GRANT_CODES.DUPLICATE_EXPORT_CLASS, 'export classes contain a duplicate', { field: 'classes' })
    seen.add(exportClass)
    requireReviewedExportClass(exportClass)
  }
  return Object.freeze([...classes])
}
