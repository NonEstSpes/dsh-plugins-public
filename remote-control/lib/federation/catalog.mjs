/**
 * Federation catalog: grant-filtered machine project/session rows and the remote
 * model catalog projection.
 *
 * The Worker owns the authoritative inventory: only explicitly shared projects and
 * explicitly granted sessions (including pre-existing sessions with `imported: true`)
 * reach this builder. Missing input means absent; the builder never enumerates native
 * sessions, never derives identity from cwd/path, and never falls back to local data.
 * Denied and absent resources are deliberately indistinguishable to callers.
 *
 * Pages are bounded, deterministic, and complete-marked: a page is either continued by
 * an opaque cursor or it is the complete page sequence. Nothing is silently truncated.
 *
 * This module is pure: no I/O, no configuration, no process state.
 *
 * @module dsh-remote-control/federation/catalog
 */

import { createHash } from 'node:crypto'
import { FederationContractError, parseMachineKey, parseProjectId, parseSessionId, projectRefKey } from './identity.mjs'
import {
  ACTION_SCOPES,
  effectiveSessionEntries,
  effectiveProjectEntries,
  evaluateGrant,
  grantAllows,
  parseGrant,
  sessionAdmissionAllowed,
} from './grants.mjs'
import {
  FAILURE_CODES,
  PROTOCOL_LIMITS,
  createCapabilities,
  jsonByteLength,
  parseCapabilities,
} from './protocol.mjs'

const CATALOG_CURSOR_PREFIX = 'fcc1.'
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const CURSOR_KEYS = ['machineKey', 'generation', 'grantRevision', 'offset']
const CAPABILITY_KEYS_SET = new Set([
  'prompt', 'cancel', 'history', 'modelSelect', 'create',
  'rename', 'fork', 'queueEdit', 'attachments', 'files', 'approvals', 'commands',
])
const MODEL_SELECTION_KEYS = ['provider', 'model', 'reasoningEffort']
const MODEL_EFFORT_KEYS = ['id', 'name']
const MODEL_CATALOG_SCOPE_KEYS = ['machineKey', 'projectId', 'sessionId', 'generation', 'grantRevision']
const MODEL_CATALOG_REQUEST_KEYS = ['modelCatalog', 'grant', 'machineKey', 'principal', 'projectId', 'grantRevision', 'now']
const MODEL_CATALOG_CURSOR_PREFIX = 'fmc1.'
const MODEL_CATALOG_FAILURE = 'Provider model catalogue is unavailable on the Worker.'
// Serialized catalog bytes, records and page count independently bound retained data and continuation work.
const MODEL_CATALOG_LIMITS = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxRecords: 65536, maxPages: 256 })
const isCount = value => isNonNegativeInteger(value) && !Object.is(value, -0)

const fail = (code, message, detail) => { throw new FederationContractError(code, message, detail) }
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0

function assertRecord(value, subject, required, optional = []) {
  if (!isRecord(value)) fail(FAILURE_CODES.INVALID_MESSAGE, `${subject} must be a plain JSON object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(FAILURE_CODES.INVALID_MESSAGE, `${subject} carries unknown field "${key}"`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(FAILURE_CODES.INVALID_MESSAGE, `${subject} requires "${key}"`)
  }
  return value
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

function parseSourceProject(value) {
  assertRecord(value, 'source project', ['ref', 'title', 'canCreate'])
  assertRecord(value.ref, 'source project ref', ['machineKey', 'projectId'])
  if (typeof value.title !== 'string' || value.title.length > 256 || /[\u0000-\u001f\u007f]/.test(value.title)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'source project title is invalid')
  }
  if (typeof value.canCreate !== 'boolean') fail(FAILURE_CODES.INVALID_MESSAGE, 'source project canCreate must be boolean')
  return {
    ref: Object.freeze({
      machineKey: parseMachineKey(value.ref.machineKey),
      projectId: parseProjectId(value.ref.projectId),
    }),
    title: value.title,
    canCreate: value.canCreate,
  }
}

function parseSourceSession(value) {
  assertRecord(value, 'source session', ['ref', 'updatedAt', 'capabilities'], ['title', 'running', 'blank'])
  assertRecord(value.ref, 'source session ref', ['machineKey', 'projectId', 'sessionId'])
  if (value.title !== undefined && (typeof value.title !== 'string' || value.title.length > 256 || /[\u0000-\u001f\u007f]/.test(value.title))) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'source session title is invalid')
  }
  if (!Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0) fail(FAILURE_CODES.INVALID_MESSAGE, 'source session updatedAt is invalid')
  if (Object.hasOwn(value, 'running') !== Object.hasOwn(value, 'blank') || (Object.hasOwn(value, 'running') && (typeof value.running !== 'boolean' || typeof value.blank !== 'boolean'))) fail(FAILURE_CODES.INVALID_MESSAGE, 'source session status flags must be present together as booleans')
  return {
    ref: Object.freeze({
      machineKey: parseMachineKey(value.ref.machineKey),
      projectId: parseProjectId(value.ref.projectId),
      sessionId: parseSessionId(value.ref.sessionId),
    }),
    ...(value.title === undefined ? {} : { title: value.title }),
    updatedAt: value.updatedAt,
    ...(Object.hasOwn(value, 'running') ? { running: value.running, blank: value.blank } : {}),
    capabilities: parseCapabilities(value.capabilities),
  }
}

/**
 * Strict source catalog page parser, used on the wire and in tests.
 * @param {unknown} value - candidate page.
 * @returns {Readonly<object>} frozen page.
 */
export function parseSourceCatalogPage(value) {
  assertRecord(value, 'source catalog page', ['generation', 'grantRevision', 'projects', 'sessions'], ['nextCursor'])
  if (!isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.grantRevision)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog page generations must be non-negative integers')
  }
  if (!Array.isArray(value.projects) || !Array.isArray(value.sessions)) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog page arrays are invalid')
  if (value.nextCursor !== undefined) {
    if (typeof value.nextCursor !== 'string' || !value.nextCursor.startsWith(CATALOG_CURSOR_PREFIX)) {
      fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog nextCursor is invalid')
    }
  }
  return freezeDeep({
    generation: value.generation,
    grantRevision: value.grantRevision,
    projects: value.projects.map(parseSourceProject),
    sessions: value.sessions.map(parseSourceSession),
    ...(value.nextCursor === undefined ? {} : { nextCursor: value.nextCursor }),
  })
}

/**
 * Encode an opaque catalog cursor bound to machine and visibility generation.
 * @param {{ machineKey: string, generation: number, grantRevision: number, offset: number }} value - cursor fields.
 * @returns {string} opaque cursor beginning with `fcc1.`.
 */
export function encodeCatalogCursor(value) {
  assertRecord(value, 'catalog cursor', CURSOR_KEYS)
  const machineKey = parseMachineKey(value.machineKey)
  if (!isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.grantRevision) || !isNonNegativeInteger(value.offset)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor numbers are invalid')
  }
  const tuple = [machineKey, value.generation, value.grantRevision, value.offset]
  const token = `${CATALOG_CURSOR_PREFIX}${Buffer.from(JSON.stringify(tuple), 'utf8').toString('base64url')}`
  if (Buffer.byteLength(token, 'utf8') > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'catalog cursor is too large')
  return token
}

/**
 * Decode and verify an opaque catalog cursor.
 * @param {unknown} token - opaque cursor.
 * @param {{ machineKey: string, generation: number, grantRevision: number }} expected - expected binding.
 * @returns {Readonly<object>} frozen cursor fields.
 */
export function decodeCatalogCursor(token, expected) {
  if (typeof token !== 'string' || !token.startsWith(CATALOG_CURSOR_PREFIX)) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor prefix is invalid')
  if (token.length > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'catalog cursor exceeds the decode budget')
  const body = token.slice(CATALOG_CURSOR_PREFIX.length)
  if (!BASE64URL_PATTERN.test(body)) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor is not base64url')
  let text
  try {
    text = Buffer.from(body, 'base64url').toString('utf8')
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor cannot be decoded')
  }
  if (Buffer.from(text, 'utf8').toString('base64url') !== body) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor is not canonical')
  let tuple
  try {
    tuple = JSON.parse(text)
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor does not contain JSON')
  }
  if (!Array.isArray(tuple) || tuple.length !== CURSOR_KEYS.length || JSON.stringify(tuple) !== text) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor tuple is invalid')
  }
  assertRecord(expected, 'catalog cursor expectation', ['machineKey', 'generation', 'grantRevision'])
  const decoded = {
    machineKey: parseMachineKey(tuple[0]),
    generation: tuple[1],
    grantRevision: tuple[2],
    offset: tuple[3],
  }
  if (![1, 2, 3].every(index => isNonNegativeInteger(tuple[index]))) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog cursor numbers are invalid')
  if (decoded.machineKey !== expected.machineKey) fail(FAILURE_CODES.CURSOR_STALE, 'catalog cursor names another machine')
  if (decoded.generation !== expected.generation || decoded.grantRevision !== expected.grantRevision) {
    fail(FAILURE_CODES.CATALOG_STALE, 'catalog cursor belongs to another visibility generation')
  }
  return Object.freeze(decoded)
}

function principalOf(request) {
  if (!isRecord(request) || !isRecord(request.grant) || !isRecord(request.principal)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog build requires grant and principal')
  }
  return request.principal
}

function sessionCapabilitiesOf({ grant, principal, machineKey, projectId, sessionId, exportClasses, options }) {
  const base = Object.fromEntries([...CAPABILITY_KEYS_SET].map(key => [key, false]))
  const decide = (action, extra = {}) => grantAllows(grant, {
    principal,
    machineKey,
    action,
    projectId,
    ...(ACTION_SCOPES[action] === 'session' && sessionId !== undefined ? { sessionId } : {}),
    ...extra,
  }, options)
  const history = exportClasses.length > 0 && decide('session.read', { exportClasses: [...exportClasses] })
    && decide('session.follow', { exportClasses: [...exportClasses] })
  return createCapabilities({
    ...base,
    prompt: decide('session.prompt'),
    cancel: decide('session.cancel'),
    history,
    modelSelect: decide('model.list') && decide('model.select'),
  })
}

/**
 * Build one grant-filtered source catalog page.
 *
 * @param {{ machineKey: string, generation: number, grantRevision: number,
 *   principal: Readonly<object>, grant: unknown, now: number,
 *   projects: readonly { projectId: string, title?: string }[],
 *   sessions: readonly { sessionId: string, projectId: string, title?: string,
 *     updatedAt: number, running: boolean, blank: boolean }[],
 *   cursor?: string, maxItems?: number, maxBytes?: number }} request - authoritative inventory and paging.
 * @returns {Readonly<object>} frozen source catalog page.
 */
export function buildSourceCatalog(request) {
  assertRecord(request, 'catalog build request', [
    'machineKey', 'generation', 'grantRevision', 'principal', 'grant', 'now', 'projects', 'sessions',
  ], ['cursor', 'maxItems', 'maxBytes', 'remoteOwnedSessions', 'remoteOwnedProjects'])
  const machineKey = parseMachineKey(request.machineKey)
  if (!isNonNegativeInteger(request.generation) || !isNonNegativeInteger(request.grantRevision) || !isNonNegativeInteger(request.now)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog build generations must be non-negative integers')
  }
  const grant = parseGrant(request.grant)
  if (grant.machineKey !== machineKey) fail(FAILURE_CODES.NOT_GRANTED, 'grant belongs to another machine')
  const options = { currentRevision: request.grantRevision, now: request.now, ...(request.remoteOwnedSessions === undefined ? {} : { remoteOwnedSessions: request.remoteOwnedSessions }), ...(request.remoteOwnedProjects === undefined ? {} : { remoteOwnedProjects: request.remoteOwnedProjects }) }
  const principal = principalOf(request)
  for (const key of ['kind', 'id']) {
    if (!Object.hasOwn(principal, key)) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog principal is invalid')
  }
  const maxItems = request.maxItems === undefined ? 50 : request.maxItems
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0 || maxItems > 200) fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog maxItems is invalid')
  const maxBytes = request.maxBytes === undefined ? PROTOCOL_LIMITS.maxPageBytes : request.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > PROTOCOL_LIMITS.maxPageBytes) {
    fail(FAILURE_CODES.PAGE_TOO_LARGE, 'catalog maxBytes exceeds the plaintext budget')
  }

  const projectById = new Map()
  for (const project of request.projects) {
    assertRecord(project, 'inventory project', ['projectId'], ['title'])
    const projectId = parseProjectId(project.projectId)
    if (projectById.has(projectId)) fail(FAILURE_CODES.INVALID_MESSAGE, 'inventory names one project twice')
    projectById.set(projectId, project)
  }
  const sessionById = new Map()
  for (const session of request.sessions) {
    assertRecord(session, 'inventory session', ['sessionId', 'projectId', 'updatedAt', 'running', 'blank'], ['title'])
    const sessionId = parseSessionId(session.sessionId)
    if (sessionById.has(sessionId)) fail(FAILURE_CODES.INVALID_MESSAGE, 'inventory names one session twice')
    if (!Number.isSafeInteger(session.updatedAt) || session.updatedAt < 0) fail(FAILURE_CODES.INVALID_MESSAGE, 'inventory session updatedAt is invalid')
    if (typeof session.running !== 'boolean' || typeof session.blank !== 'boolean') fail(FAILURE_CODES.INVALID_MESSAGE, 'inventory session flags are invalid')
    sessionById.set(sessionId, session)
  }

  const projects = []
  for (const projectGrant of effectiveProjectEntries(grant, options)) {
    const inventoryProject = projectById.get(projectGrant.projectId)
    if (inventoryProject === undefined) continue // shared inventory is authoritative; absent grants are not leaks
    if (!grantAllows(grant, { principal, machineKey, action: 'project.list', projectId: projectGrant.projectId }, options)) continue
    const template = projectGrant.createdSessionGrant
    const canOpenCreated = template !== undefined
      && projectGrant.actions.includes('session.list')
      && ['session.status', 'session.read', 'session.follow'].every(action => template.actions.includes(action))
      && ['conversation.user', 'conversation.assistant', 'turn'].every(type => template.exportClasses.includes(type))
    const canCreate = canOpenCreated && grantAllows(grant, {
      principal, machineKey, action: 'session.create', projectId: projectGrant.projectId,
    }, options)
    projects.push(parseSourceProject({
      ref: { machineKey, projectId: projectGrant.projectId },
      title: typeof inventoryProject.title === 'string' ? inventoryProject.title : projectGrant.projectId,
      canCreate,
    }))
  }
  projects.sort((left, right) => projectRefKey(left.ref).localeCompare(projectRefKey(right.ref)))

  const allowedSessions = []
  for (const project of effectiveProjectEntries(grant, options)) {
    if (!projects.some(row => row.ref.projectId === project.projectId)
      || !grantAllows(grant, { principal, machineKey, action: 'session.list', projectId: project.projectId }, options)) continue
    for (const session of effectiveSessionEntries(grant, project.projectId, options)) {
      if (!sessionAdmissionAllowed(grant, { projectId: project.projectId, sessionId: session.sessionId }, options)) continue
      const inventorySession = sessionById.get(session.sessionId)
      if (inventorySession === undefined) continue
      if (inventorySession.projectId !== project.projectId) continue
      const exportClasses = session.exportClasses ?? project.exportClasses
      const capabilities = sessionCapabilitiesOf({
        grant, principal, machineKey, projectId: project.projectId, sessionId: session.sessionId, exportClasses, options,
      })
      allowedSessions.push(parseSourceSession({
        ref: { machineKey, projectId: project.projectId, sessionId: session.sessionId },
        ...(typeof inventorySession.title === 'string' ? { title: inventorySession.title } : {}),
        updatedAt: inventorySession.updatedAt,
        ...(grantAllows(grant, { principal, machineKey, projectId: project.projectId, sessionId: session.sessionId, action: 'session.status' }, options)
          ? { running: inventorySession.running, blank: inventorySession.blank } : {}),
        capabilities,
      }))
    }
  }
  allowedSessions.sort((left, right) => {
    const byProject = left.ref.projectId.localeCompare(right.ref.projectId)
    return byProject !== 0 ? byProject : left.ref.sessionId.localeCompare(right.ref.sessionId)
  })

  let offset = 0
  if (request.cursor !== undefined) {
    const decoded = decodeCatalogCursor(request.cursor, { machineKey, generation: request.generation, grantRevision: request.grantRevision })
    offset = decoded.offset
  }
  if (offset > allowedSessions.length) fail(FAILURE_CODES.CURSOR_STALE, 'catalog cursor is past the catalog end')
  const pageSessions = []
  let index = offset
  while (index < allowedSessions.length && pageSessions.length < maxItems) {
    const candidate = [...pageSessions, allowedSessions[index]]
    const candidatePage = { generation: request.generation, grantRevision: request.grantRevision, projects: offset === 0 ? projects : [], sessions: candidate }
    if (jsonByteLength(candidatePage) > maxBytes) {
      if (candidate.length === 1) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'a single source session row exceeds the page budget')
      break
    }
    pageSessions.push(allowedSessions[index])
    index++
  }
  const nextCursor = index < allowedSessions.length
    ? encodeCatalogCursor({ machineKey, generation: request.generation, grantRevision: request.grantRevision, offset: index })
    : undefined
  const page = parseSourceCatalogPage({
    generation: request.generation,
    grantRevision: request.grantRevision,
    projects: offset === 0 ? projects : [],
    sessions: pageSessions,
    ...(nextCursor === undefined ? {} : { nextCursor }),
  })
  if (jsonByteLength(page) > maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'complete catalog page exceeds the byte budget')
  return page
}

function boundedText(value, maxBytes) {
  if (maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog text exceeds its byte budget')
}

function parseModelEffort(value, maxBytes) {
  assertRecord(value, 'model effort', ['id', 'name'], ['description'])
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.name !== 'string' || value.name.length === 0) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'model effort fields are invalid')
  }
  boundedText(value.id, maxBytes); boundedText(value.name, maxBytes)
  return { id: value.id, name: value.name }
}

function parseModel(value, maxBytes) {
  assertRecord(value, 'catalog model', ['id', 'name'], ['reasoning', 'description', 'badge'])
  if (typeof value.id !== 'string' || value.id.length === 0 || typeof value.name !== 'string' || value.name.length === 0) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'catalog model fields are invalid')
  }
  boundedText(value.id, maxBytes); boundedText(value.name, maxBytes)
  const model = { id: value.id, name: value.name }
  if (value.reasoning !== undefined) {
    assertRecord(value.reasoning, 'model reasoning', ['efforts'], ['defaultEffort'])
    if (!Array.isArray(value.reasoning.efforts)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model reasoning efforts must be an array')
    if (value.reasoning.defaultEffort !== undefined
      && (typeof value.reasoning.defaultEffort !== 'string' || value.reasoning.defaultEffort.length === 0)) {
      fail(FAILURE_CODES.INVALID_MESSAGE, 'model reasoning defaultEffort is invalid')
    }
    if (value.reasoning.defaultEffort !== undefined) boundedText(value.reasoning.defaultEffort, maxBytes)
    model.reasoning = { efforts: [], ...(value.reasoning.defaultEffort === undefined ? {} : { defaultEffort: value.reasoning.defaultEffort }) }
    let bytes = maxBytes === undefined ? 0 : jsonByteLength(model)
    for (const input of value.reasoning.efforts) {
      const effort = parseModelEffort(input, maxBytes)
      if (maxBytes !== undefined) {
        bytes += jsonByteLength(effort) + (model.reasoning.efforts.length === 0 ? 0 : 1)
        if (bytes > maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'one complete model cannot fit the page budget')
      }
      model.reasoning.efforts.push(effort)
    }
  }
  if (maxBytes !== undefined && jsonByteLength(model) > maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'one complete model cannot fit the page budget')
  return model
}

function parseModelSelection(value, maxBytes) {
  if (value === undefined) return undefined
  assertRecord(value, 'model selection', MODEL_SELECTION_KEYS.slice(0, 2), ['reasoningEffort'])
  if (typeof value.provider !== 'string' || typeof value.model !== 'string'
    || (value.reasoningEffort !== undefined && typeof value.reasoningEffort !== 'string')) fail(FAILURE_CODES.INVALID_MESSAGE, 'model selection fields are invalid')
  boundedText(value.provider, maxBytes); boundedText(value.model, maxBytes)
  if (value.reasoningEffort !== undefined) boundedText(value.reasoningEffort, maxBytes)
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) }
}

function parseModelFailure(value) {
  assertRecord(value, 'native model failure', ['id', 'name', 'message'])
  if (typeof value.id !== 'string' || !value.id || value.id.length > 256 || typeof value.name !== 'string' || !value.name || value.name.length > 256 || typeof value.message !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'native model failure is invalid')
  return { id: value.id, name: value.name, message: MODEL_CATALOG_FAILURE }
}

function modelCatalogValue(request, bounded = false) {
  const machineKey = parseMachineKey(request.machineKey), projectId = parseProjectId(request.projectId)
  const grant = parseGrant(request.grant)
  if (grant.machineKey !== machineKey) fail(FAILURE_CODES.NOT_GRANTED, 'grant belongs to another machine')
  const options = { currentRevision: request.grantRevision, now: request.now, ...(request.remoteOwnedSessions === undefined ? {} : { remoteOwnedSessions: request.remoteOwnedSessions }), ...(request.remoteOwnedProjects === undefined ? {} : { remoteOwnedProjects: request.remoteOwnedProjects }) }
  if (!grantAllows(grant, { principal: request.principal, machineKey, action: 'model.list', projectId }, options)) fail(FAILURE_CODES.NOT_GRANTED, 'model catalog is not granted for this project')
  const input = request.modelCatalog
  assertRecord(input, 'native model catalog', ['default', 'groups', 'routableProviders', 'failures'])
  const defaultSelection = parseModelSelection(input.default, bounded ? MODEL_CATALOG_LIMITS.maxBytes : undefined)
  if (defaultSelection === undefined) fail(FAILURE_CODES.INVALID_MESSAGE, 'native model catalog requires a default selection')
  if (!Array.isArray(input.groups) || !Array.isArray(input.failures) || !Array.isArray(input.routableProviders)) fail(FAILURE_CODES.INVALID_MESSAGE, 'native model catalog arrays are invalid')
  if (bounded && (input.groups.length + input.failures.length > MODEL_CATALOG_LIMITS.maxRecords || input.routableProviders.length > MODEL_CATALOG_LIMITS.maxRecords)) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog record count exceeds its budget')
  const projected = { default: defaultSelection, routableProviders: [], groups: [], failures: [] }
  let bytes = bounded ? jsonByteLength(projected) : 0, records = 0
  const add = (value, comma, record = true) => {
    if (!bounded) return
    if (record && ++records > MODEL_CATALOG_LIMITS.maxRecords) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog record count exceeds its budget')
    bytes += jsonByteLength(value) + (comma ? 1 : 0)
    if (bytes > MODEL_CATALOG_LIMITS.maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'normalized model catalog exceeds its byte budget')
  }
  if (bounded && bytes > MODEL_CATALOG_LIMITS.maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'normalized model catalog exceeds its byte budget')
  for (const id of input.routableProviders) {
    if (typeof id !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'native routable provider list is invalid')
    boundedText(id, bounded ? MODEL_CATALOG_LIMITS.maxBytes : undefined)
    add(id, projected.routableProviders.length > 0, false)
    projected.routableProviders.push(id)
  }
  const providerIds = new Set(), nonemptyProviders = new Set(), failureIds = new Set()
  for (const group of input.groups) {
    assertRecord(group, 'model catalog group', ['id', 'name', 'models'], ['description'])
    if (typeof group.id !== 'string' || !group.id || typeof group.name !== 'string' || !group.name || !Array.isArray(group.models)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog group fields are invalid')
    if (bounded && providerIds.has(group.id)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog contains a duplicate provider')
    boundedText(group.id, bounded ? MODEL_CATALOG_LIMITS.maxBytes : undefined); boundedText(group.name, bounded ? MODEL_CATALOG_LIMITS.maxBytes : undefined)
    providerIds.add(group.id)
    if (group.models.length > 0) nonemptyProviders.add(group.id)
    const projectedGroup = { id: group.id, name: group.name, models: [] }, modelIds = new Set()
    add(projectedGroup, projected.groups.length > 0)
    projected.groups.push(projectedGroup)
    for (const inputModel of group.models) {
      const model = parseModel(inputModel, bounded ? PROTOCOL_LIMITS.maxPageBytes : undefined)
      if (bounded && modelIds.has(model.id)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog contains a duplicate model')
      modelIds.add(model.id)
      add(model, projectedGroup.models.length > 0)
      projectedGroup.models.push(model)
    }
  }
  if (projected.routableProviders.some(id => !nonemptyProviders.has(id)) || new Set(projected.routableProviders).size !== projected.routableProviders.length) fail(FAILURE_CODES.INVALID_MESSAGE, 'native routable provider list is invalid')
  for (const inputFailure of input.failures) {
    const failure = parseModelFailure(inputFailure)
    if (bounded && failureIds.has(failure.id)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog contains a duplicate failure')
    failureIds.add(failure.id)
    add(failure, projected.failures.length > 0)
    projected.failures.push(failure)
  }
  return freezeDeep(projected)
}

/**
 * Project the native Worker model catalog with schema-aware field selection.
 * Every effort and its default is retained; unsafe metadata is omitted and provider failures are sanitized.
 * @param {{modelCatalog:unknown,grant:unknown,machineKey:string,principal:object,projectId:string,grantRevision:number,now:number,remoteOwnedSessions?:unknown}} request - native catalog and original grant context.
 * @returns {Readonly<object>} complete native ModelCatalog, never more than the legacy 32 KiB page budget.
 */
export function projectModelCatalog(request) {
  assertRecord(request, 'model catalog request', MODEL_CATALOG_REQUEST_KEYS, ['remoteOwnedSessions', 'remoteOwnedProjects'])
  const projected = modelCatalogValue(request)
  if (jsonByteLength(projected) > PROTOCOL_LIMITS.maxPageBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog exceeds the page budget; page by provider instead of truncating models or efforts')
  return projected
}

function parseModelScope(value) {
  assertRecord(value, 'model catalog scope', MODEL_CATALOG_SCOPE_KEYS)
  if (!isCount(value.generation) || !isCount(value.grantRevision)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog scope generations are invalid')
  return Object.freeze({ machineKey: parseMachineKey(value.machineKey), projectId: parseProjectId(value.projectId), sessionId: parseSessionId(value.sessionId), generation: value.generation, grantRevision: value.grantRevision })
}

function sameModelScope(value, expected) {
  for (const key of MODEL_CATALOG_SCOPE_KEYS) {
    if (value[key] !== expected[key]) fail(key === 'generation' || key === 'grantRevision' ? FAILURE_CODES.CATALOG_STALE : FAILURE_CODES.CURSOR_STALE, 'model catalog belongs to another scope')
  }
}

function modelCatalogId(value) { return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex') }

function encodeModelCursor(scope, catalogId, offset) {
  const text = JSON.stringify([...MODEL_CATALOG_SCOPE_KEYS.map(key => scope[key]), catalogId, offset])
  const cursor = MODEL_CATALOG_CURSOR_PREFIX + Buffer.from(text, 'utf8').toString('base64url')
  if (Buffer.byteLength(cursor, 'utf8') > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog cursor exceeds its byte budget')
  return cursor
}

function decodeModelCursor(cursor, scope, catalogId) {
  if (typeof cursor !== 'string' || !cursor.startsWith(MODEL_CATALOG_CURSOR_PREFIX)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog cursor prefix is invalid')
  if (Buffer.byteLength(cursor, 'utf8') > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog cursor exceeds its byte budget')
  const encoded = cursor.slice(MODEL_CATALOG_CURSOR_PREFIX.length)
  if (!BASE64URL_PATTERN.test(encoded)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog cursor is not base64url')
  const text = Buffer.from(encoded, 'base64url').toString('utf8')
  if (Buffer.from(text, 'utf8').toString('base64url') !== encoded) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog cursor is not canonical')
  let tuple
  try { tuple = JSON.parse(text) } catch (error) { fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog cursor does not contain JSON') }
  if (!Array.isArray(tuple) || tuple.length !== 7 || JSON.stringify(tuple) !== text) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog cursor tuple is invalid')
  const decoded = parseModelScope(Object.fromEntries(MODEL_CATALOG_SCOPE_KEYS.map((key, index) => [key, tuple[index]])))
  sameModelScope(decoded, scope)
  if (typeof tuple[5] !== 'string' || !/^[a-f0-9]{64}$/.test(tuple[5]) || !isCount(tuple[6])) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog cursor fields are invalid')
  if (tuple[5] !== catalogId) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog changed during pagination')
  return tuple[6]
}

function modelRecords(catalog) {
  const routable = new Map(catalog.routableProviders.map((id, index) => [id, index]))
  const records = [], sizes = []
  let bytes = 0
  const append = record => {
    const size = jsonByteLength(record)
    bytes += size
    // Repeated providerId fields can expand a small native catalog; this is a necessary page-count bound.
    if (size > PROTOCOL_LIMITS.maxPageBytes || bytes > MODEL_CATALOG_LIMITS.maxPages * PROTOCOL_LIMITS.maxPageBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog wire records exceed the page budget')
    records.push(record); sizes.push(size)
  }
  for (const group of catalog.groups) {
    const routableIndex = routable.get(group.id)
    append({ type: 'provider', id: group.id, name: group.name, routable: routableIndex !== undefined, ...(routableIndex === undefined ? {} : { routableIndex }) })
    for (const model of group.models) append({ type: 'model', providerId: group.id, model })
  }
  for (const failure of catalog.failures) append({ type: 'failure', failure })
  return { records, sizes }
}

/**
 * Build one bounded, grant-checked model catalog page; full models and effort lists are indivisible.
 * Every page, including a final empty page, carries the exact machine/project/session/authority scope.
 * @param {{modelCatalog:unknown,grant:unknown,machineKey:string,principal:object,projectId:string,sessionId:string,generation:number,grantRevision:number,now:number,maxBytes?:number,cursor?:string,remoteOwnedSessions?:unknown}} request - native catalog, original grant context, full scope and complete page byte budget.
 * @returns {Readonly<object>} scoped hash-bound page with a cursor only while more records remain.
 */
export function projectModelCatalogPage(request) {
  assertRecord(request, 'model catalog page request', [...MODEL_CATALOG_REQUEST_KEYS, 'sessionId', 'generation'], ['maxBytes', 'cursor', 'remoteOwnedSessions', 'remoteOwnedProjects'])
  const scope = parseModelScope(Object.fromEntries(MODEL_CATALOG_SCOPE_KEYS.map(key => [key, request[key]])))
  const maxBytes = request.maxBytes === undefined ? PROTOCOL_LIMITS.maxPageBytes : request.maxBytes
  if (!isCount(maxBytes) || maxBytes === 0 || maxBytes > PROTOCOL_LIMITS.maxPageBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog page budget is invalid')
  const catalog = modelCatalogValue(request, true), catalogId = modelCatalogId(catalog)
  const { records: allRecords, sizes } = modelRecords(catalog)
  const start = request.cursor === undefined ? 0 : decodeModelCursor(request.cursor, scope, catalogId)
  if (start > allRecords.length || (request.cursor !== undefined && start === allRecords.length)) fail(FAILURE_CODES.CURSOR_STALE, 'model catalog cursor is past its records')
  const page = { scope, catalogId, default: catalog.default, start, totalRecords: allRecords.length, records: [] }
  const remaining = allRecords.slice(start)
  const finalBytes = jsonByteLength(page) + sizes.slice(start).reduce((sum, size) => sum + size, 0) + Math.max(0, remaining.length - 1)
  // Removing a final continuation cursor can make several small records fit when the first alone would not.
  if (finalBytes <= maxBytes) return freezeDeep({ ...page, records: remaining })
  let recordBytes = 0
  for (let index = start; index < allRecords.length - 1; index++) {
    const candidateBytes = recordBytes + sizes[index] + (page.records.length === 0 ? 0 : 1)
    const nextCursor = encodeModelCursor(scope, catalogId, index + 1)
    if (jsonByteLength({ ...page, records: [], nextCursor }) + candidateBytes > maxBytes) break
    page.records.push(allRecords[index]); recordBytes = candidateBytes
  }
  if (page.records.length === 0) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'one complete model catalog record cannot fit its scoped page')
  return freezeDeep({ ...page, nextCursor: encodeModelCursor(scope, catalogId, start + page.records.length) })
}

function parseWireModel(value) {
  assertRecord(value, 'paged model', ['id', 'name'], ['reasoning'])
  if (value.reasoning !== undefined) {
    assertRecord(value.reasoning, 'paged model reasoning', ['efforts'], ['defaultEffort'])
    if (!Array.isArray(value.reasoning.efforts)) fail(FAILURE_CODES.INVALID_MESSAGE, 'paged model efforts are invalid')
    for (const effort of value.reasoning.efforts) assertRecord(effort, 'paged model effort', MODEL_EFFORT_KEYS)
  }
  return parseModel(value, PROTOCOL_LIMITS.maxPageBytes)
}

/**
 * Own one bounded model-page sequence; no partial catalog is returned and any rejected page poisons it.
 * Every page is checked against the full captured scope, even when its final page has no cursor.
 * @param {{machineKey:string,projectId:string,sessionId:string,generation:number,grantRevision:number}} value - exact bound source authority.
 * @returns {{accept:(page:unknown)=>string|undefined,result:()=>Readonly<object>}} strict continuation acceptance and complete immutable ModelCatalog access.
 */
export function createModelCatalogAccumulator(value) {
  const scope = parseModelScope(value)
  let catalog, catalogId, defaultText, totalRecords, offset = 0, pages = 0, bytes = 0, currentGroup, currentModels, failuresStarted = false, complete = false, failed
  const providerIds = new Map(), failureIds = new Set(), routable = new Map()
  function addBytes(item, comma) {
    bytes += jsonByteLength(item) + (comma ? 1 : 0)
    if (bytes > MODEL_CATALOG_LIMITS.maxBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'assembled model catalog exceeds its byte budget')
  }
  function accept(input) {
    if (failed) throw failed
    try {
      if (complete) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog is already complete')
      if (++pages > MODEL_CATALOG_LIMITS.maxPages) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog exceeds its page count budget')
      assertRecord(input, 'model catalog page', ['scope', 'catalogId', 'default', 'start', 'totalRecords', 'records'], ['nextCursor'])
      sameModelScope(parseModelScope(input.scope), scope)
      if (typeof input.catalogId !== 'string' || !/^[a-f0-9]{64}$/.test(input.catalogId) || !isCount(input.start) || !isCount(input.totalRecords)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog page identity is invalid')
      if (input.totalRecords > MODEL_CATALOG_LIMITS.maxRecords || !Array.isArray(input.records) || input.records.length > MODEL_CATALOG_LIMITS.maxRecords) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog record count exceeds its budget')
      let pageBytes
      try { pageBytes = jsonByteLength(input) } catch (error) { fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog page is not JSON') }
      if (pageBytes > PROTOCOL_LIMITS.maxPageBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'model catalog page exceeds its byte budget')
      const selection = parseModelSelection(input.default, PROTOCOL_LIMITS.maxPageBytes)
      if (selection === undefined) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog page requires its default selection')
      if (catalog === undefined) {
        catalogId = input.catalogId; defaultText = JSON.stringify(selection); totalRecords = input.totalRecords
        catalog = { default: selection, routableProviders: [], groups: [], failures: [] }
        bytes = jsonByteLength(catalog)
      }
      if (input.catalogId !== catalogId || JSON.stringify(selection) !== defaultText || input.totalRecords !== totalRecords) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog page identity changed')
      if (input.start !== offset || input.records.length + offset > totalRecords) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog page is missing, repeated or out of order')
      const end = offset + input.records.length
      if (input.nextCursor === undefined) {
        if (end !== totalRecords) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog terminated before all records arrived')
      } else {
        if (input.records.length === 0 || end >= totalRecords) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog continuation makes no progress')
        if (decodeModelCursor(input.nextCursor, scope, catalogId) !== end) fail(FAILURE_CODES.CURSOR_STALE, 'model catalog continuation offset is invalid')
      }
      for (const record of input.records) {
        if (!isRecord(record)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog record is invalid')
        if (record.type === 'provider') {
          assertRecord(record, 'model catalog provider record', ['type', 'id', 'name', 'routable'], ['routableIndex'])
          if (failuresStarted || typeof record.id !== 'string' || !record.id || typeof record.name !== 'string' || !record.name || typeof record.routable !== 'boolean' || providerIds.has(record.id)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog provider record is invalid or repeated')
          if (record.routable) {
            if (!isCount(record.routableIndex) || record.routableIndex >= MODEL_CATALOG_LIMITS.maxRecords || routable.has(record.routableIndex)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog routable ordering is invalid')
            routable.set(record.routableIndex, record.id)
            addBytes(record.id, catalog.routableProviders.length > 0)
            catalog.routableProviders.push(record.id)
          } else if (Object.hasOwn(record, 'routableIndex')) fail(FAILURE_CODES.INVALID_MESSAGE, 'nonroutable provider carries an ordering index')
          currentGroup = { id: record.id, name: record.name, models: [] }; currentModels = new Set()
          providerIds.set(record.id, currentGroup)
          addBytes(currentGroup, catalog.groups.length > 0)
          catalog.groups.push(currentGroup)
        } else if (record.type === 'model') {
          assertRecord(record, 'model catalog model record', ['type', 'providerId', 'model'])
          if (failuresStarted || currentGroup === undefined || record.providerId !== currentGroup.id) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog model has no current provider')
          const model = parseWireModel(record.model)
          if (currentModels.has(model.id)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog contains a repeated model')
          currentModels.add(model.id)
          addBytes(model, currentGroup.models.length > 0)
          currentGroup.models.push(model)
        } else if (record.type === 'failure') {
          assertRecord(record, 'model catalog failure record', ['type', 'failure'])
          const failure = parseModelFailure(record.failure)
          if (record.failure.message !== MODEL_CATALOG_FAILURE || failureIds.has(failure.id)) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog failure is not sanitized or is repeated')
          failuresStarted = true; failureIds.add(failure.id)
          addBytes(failure, catalog.failures.length > 0)
          catalog.failures.push(failure)
        } else fail(FAILURE_CODES.INVALID_MESSAGE, 'unknown model catalog record type')
      }
      offset = end
      if (input.nextCursor !== undefined) return input.nextCursor
      catalog.routableProviders = Array.from({ length: routable.size }, (_, index) => {
        const id = routable.get(index)
        if (id === undefined || !providerIds.get(id)?.models.length) fail(FAILURE_CODES.INVALID_MESSAGE, 'model catalog routable ordering is incomplete')
        return id
      })
      if (modelCatalogId(catalog) !== catalogId) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog completion hash does not match')
      complete = true; freezeDeep(catalog)
      return undefined
    } catch (error) {
      failed = error instanceof FederationContractError ? error : new FederationContractError(FAILURE_CODES.INVALID_MESSAGE, 'model catalog page could not be accepted')
      catalog = undefined; currentGroup = undefined; currentModels = undefined
      providerIds.clear(); failureIds.clear(); routable.clear()
      throw failed
    }
  }
  return Object.freeze({
    accept,
    result() {
      if (failed) throw failed
      if (!complete) fail(FAILURE_CODES.CATALOG_STALE, 'model catalog page sequence is incomplete')
      return catalog
    },
  })
}
