/** Additive project-registration policy; ownership is supplied only by the verified private Worker journal. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import {
  ACTION_SCOPES, FEDERATION_GRANTS_VERSION, PROJECT_REGISTRATION_GRANTS_VERSION, MACHINE_ACTIONS,
  PROJECT_ACTIONS, SESSION_ACTIONS, GRANT_CODES as C, parseGrant, parseProjectGrantTemplate,
  evaluateGrant, effectiveProjectEntries, effectiveSessionEntries, effectiveExportClasses, sessionAdmissionAllowed,
} from '../../lib/federation/grants.mjs'

const principal = { kind: 'controller', id: 'controller_fixture' }, machineKey = 'worker_fixture', projectId = 'fpr_registered'
const copy = value => structuredClone(value)
const template = () => ({ actions: ['project.list', 'session.list', 'session.create', 'model.list'],
  exportClasses: ['conversation.user', 'conversation.assistant', 'usage'],
  createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt'], exportClasses: ['conversation.user', 'conversation.assistant'] } })
const explicit = (id = 'explicit') => ({ projectId: id, actions: [], exportClasses: [], sessions: [] })
const v1 = () => ({ version: 1, grantId: 'grant_fixture', principal: copy(principal), machineKey, revision: 1, issuedAt: 10, projects: [explicit()] })
const v2 = (policy = template()) => ({ ...v1(), version: 2, projects: [], projectRegistration: { actions: ['project.register'], projectGrant: copy(policy) } })
const owned = (id = projectId, policy = template()) => ({ state: 'committed', principal: copy(principal), machineKey, projectId: id,
  registerRequestId: `register_${id}`, projectGrant: copy(policy) })
const sessionOwned = (sessionId = 'created-session') => ({ state: 'committed', principal: copy(principal), machineKey, projectId,
  sessionId, createRequestId: `create_${sessionId}` })
const options = (rows = [owned()], extra = {}) => ({ currentRevision: 1, now: 20, remoteOwnedProjects: rows, ...extra })
const machineRequest = () => ({ principal: copy(principal), machineKey, action: 'project.register' })
const request = (action, extra = {}) => ({ principal: copy(principal), machineKey, projectId, action, ...extra })
const rejects = (fn, code) => assert.throws(fn, error => error instanceof FederationContractError && error.code === code)

function frozen(value) {
  if (value === null || typeof value !== 'object') return
  assert.equal(Object.isFrozen(value), true)
  for (const child of Object.values(value)) frozen(child)
}

test('V1 normalized bytes and scoped action tables remain unchanged; only V2 adds the machine permission', () => {
  const old = v1()
  assert.equal(FEDERATION_GRANTS_VERSION, 1); assert.equal(PROJECT_REGISTRATION_GRANTS_VERSION, 2)
  assert.equal(JSON.stringify(parseGrant(old)), JSON.stringify(old))
  assert.deepEqual(PROJECT_ACTIONS, ['project.list', 'session.list', 'session.create', 'model.list'])
  assert.deepEqual(SESSION_ACTIONS, ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'])
  assert.deepEqual(MACHINE_ACTIONS, ['project.register']); assert.equal(ACTION_SCOPES['project.register'], 'machine')
  rejects(() => parseGrant({ ...old, projectRegistration: v2().projectRegistration }), C.INVALID)
  rejects(() => parseGrant({ ...old, projects: [] }), C.INVALID)
  rejects(() => parseGrant({ ...old, version: 3 }), C.INVALID)
  assert.deepEqual(effectiveProjectEntries(old, options()), parseGrant(old).projects)
  assert.equal(evaluateGrant(old, machineRequest(), options()).code, C.ACTION_NOT_GRANTED)
})

test('V2 machine-only grant copies and deeply freezes the exact approved template', () => {
  const raw = v2(), parsed = parseGrant(raw)
  assert.equal(parsed.version, 2); assert.deepEqual(parsed.projects, [])
  const decision = evaluateGrant(parsed, machineRequest(), options())
  assert.equal(decision.allowed, true); assert.equal(decision.action, 'project.register')
  assert.deepEqual(decision.projectGrant, template()); frozen(parsed); frozen(decision)
  raw.projectRegistration.projectGrant.actions.push('project.list')
  assert.deepEqual(parsed.projectRegistration.projectGrant.actions, template().actions)
  assert.equal(Object.hasOwn(decision, 'projectId'), false)
})

test('machine permission is default-deny and lifecycle/identity checks precede permission disclosure', () => {
  const absent = v2(); delete absent.projectRegistration
  assert.equal(evaluateGrant(absent, machineRequest(), options()).code, C.ACTION_NOT_GRANTED)
  for (const [grant, opts, code] of [
    [{ ...absent, expiresAt: 15 }, options(), C.EXPIRED],
    [{ ...absent, revokedAt: 15 }, options(), C.REVOKED],
    [absent, options([], { currentRevision: 2 }), C.STALE_REVISION],
  ]) assert.equal(evaluateGrant(grant, machineRequest(), opts).code, code)
  assert.equal(evaluateGrant(v2(), { ...machineRequest(), principal: { kind: 'controller', id: 'other_controller' } }, options()).code, C.PRINCIPAL_MISMATCH)
  assert.equal(evaluateGrant(v2(), { ...machineRequest(), machineKey: 'other_worker' }, options()).code, C.MACHINE_MISMATCH)
  for (const grant of [{ ...v2(), expiresAt: 15 }, { ...v2(), revokedAt: 15 }]) assert.deepEqual(effectiveProjectEntries(grant, options()), [])
})

test('machine requests accept no project/session/export keys, even undefined or an injected ownership list', () => {
  for (const key of ['projectId', 'sessionId', 'exportClasses']) rejects(() => evaluateGrant(v2(), { ...machineRequest(), [key]: undefined }, options()), C.INVALID_REQUEST)
  rejects(() => evaluateGrant(v2(), { ...machineRequest(), remoteOwnedProjects: [owned()] }, options()), C.INVALID_REQUEST)
  for (const key of ['path', 'cwd']) rejects(() => evaluateGrant(v2(), { ...machineRequest(), [key]: 'PRIVATE_PATH' }, options()), C.PATH_ADOPTION_NOT_ALLOWED)
})

test('project policy templates exclude all native identifiers, inventories and paths without echoing their contents', () => {
  for (const key of ['path', 'cwd', 'projectId', 'sessions', 'sessionId', 'workspaceId', 'nativeWorkspaceId', 'imported', 'allSessions', 'localSessionId', 'C:/PRIVATE_KEY']) {
    assert.throws(() => parseProjectGrantTemplate({ ...template(), [key]: 'PRIVATE_NATIVE_PATH' }), error => error instanceof FederationContractError
      && error.message === 'project grant template is invalid' && !JSON.stringify(error).includes('PRIVATE'))
  }
  const result = parseProjectGrantTemplate(template()); frozen(result)
  rejects(() => parseProjectGrantTemplate({ ...template(), actions: ['session.read'] }), C.ACTION_SCOPE_MISMATCH)
  rejects(() => parseProjectGrantTemplate({ ...template(), actions: ['project.register'] }), C.ACTION_SCOPE_MISMATCH)
  rejects(() => parseProjectGrantTemplate({ ...template(), actions: ['project.list', 'project.list'] }), C.DUPLICATE_ACTION)
  rejects(() => parseProjectGrantTemplate({ ...template(), exportClasses: ['unknown.private'] }), C.UNKNOWN_EXPORT_CLASS)
  rejects(() => parseProjectGrantTemplate({ ...template(), createdSessionGrant: { actions: ['project.list'], exportClasses: [] } }), C.ACTION_SCOPE_MISMATCH)
  rejects(() => parseProjectGrantTemplate({ actions: [], exportClasses: [], createdSessionGrant: { actions: [], exportClasses: ['usage'] } }), C.EXPORT_CLASS_SUBSET_VIOLATION)
})

test('project-registration permission has one exact machine action and no additional fields', () => {
  for (const actions of [[], ['session.create'], ['project.register', 'project.register']]) {
    assert.throws(() => parseGrant({ ...v2(), projectRegistration: { actions, projectGrant: template() } }), FederationContractError)
  }
  rejects(() => parseGrant({ ...v2(), projectRegistration: { ...v2().projectRegistration, path: 'PRIVATE_PATH' } }), C.INVALID_PROJECT)
  rejects(() => parseGrant({ ...v2(), projectRegistration: null }), C.INVALID_PROJECT)
})

test('only qualified committed projects derive entries and every derived session inventory is empty', () => {
  const foreign = [{ ...owned('foreign-principal'), principal: { kind: 'controller', id: 'other_controller' } }, { ...owned('foreign-machine'), machineKey: 'other_worker' }]
  const grant = v2(); grant.projects.push(explicit())
  const entries = effectiveProjectEntries(grant, options([owned(), ...foreign]))
  assert.deepEqual(entries.map(row => row.projectId), ['explicit', projectId])
  assert.deepEqual(entries[1].actions, template().actions); assert.deepEqual(entries[1].sessions, [])
  assert.deepEqual(effectiveSessionEntries(grant, projectId, options()), [])
  frozen(entries)
})

test('captured project and nested session policy intersect the current template without future widening', () => {
  const captured = { actions: ['project.list', 'session.list', 'session.create'], exportClasses: ['conversation.user'],
    createdSessionGrant: { actions: ['session.read', 'session.follow'], exportClasses: ['conversation.user'] } }
  const broad = v2(), row = owned(projectId, captured), opts = options([row], { remoteOwnedSessions: [sessionOwned()] })
  const derived = effectiveProjectEntries(broad, opts)[0]
  assert.deepEqual(derived, { projectId, ...captured, sessions: [] })
  assert.equal(evaluateGrant(broad, request('model.list'), opts).code, C.ACTION_NOT_GRANTED)
  assert.equal(evaluateGrant(broad, request('session.prompt', { sessionId: 'created-session' }), opts).code, C.ACTION_NOT_GRANTED)
  assert.equal(evaluateGrant(broad, request('session.read', { sessionId: 'created-session', exportClasses: ['conversation.user'] }), opts).allowed, true)
  broad.projectRegistration.projectGrant.exportClasses.push('statistics')
  broad.projectRegistration.projectGrant.createdSessionGrant.actions.push('session.cancel')
  assert.deepEqual(effectiveProjectEntries(broad, opts)[0], derived)
})

test('current narrowing immediately removes project actions, exports and nested creation/session rights', () => {
  const raw = v2(), opts = options([], { remoteOwnedProjects: [owned()], remoteOwnedSessions: [sessionOwned()] })
  raw.projectRegistration.projectGrant.actions = ['project.list', 'session.list', 'session.create']
  raw.projectRegistration.projectGrant.exportClasses = ['conversation.user']
  raw.projectRegistration.projectGrant.createdSessionGrant = { actions: ['session.read'], exportClasses: ['conversation.user'] }
  assert.deepEqual(effectiveSessionEntries(raw, projectId, opts), [{ sessionId: 'created-session', imported: false, actions: ['session.read'], exportClasses: ['conversation.user'] }])
  assert.equal(evaluateGrant(raw, request('session.read', { sessionId: 'created-session', exportClasses: ['conversation.assistant'] }), opts).code, C.EXPORT_CLASS_NOT_GRANTED)
  assert.equal(evaluateGrant(raw, request('session.follow', { sessionId: 'created-session', exportClasses: ['conversation.user'] }), opts).code, C.ACTION_NOT_GRANTED)
  raw.projectRegistration.projectGrant.actions = ['project.list']
  assert.deepEqual(effectiveSessionEntries(raw, projectId, opts), [])
  assert.equal(evaluateGrant(raw, request('session.create'), opts).code, C.ACTION_NOT_GRANTED)
  delete raw.projectRegistration.projectGrant.createdSessionGrant
  assert.equal(effectiveProjectEntries(raw, opts)[0].createdSessionGrant, undefined)
})

test('explicit project denial always wins and removing machine permission revokes only derived projects', () => {
  const grant = v2(); grant.projects.push(explicit(projectId))
  assert.deepEqual(effectiveProjectEntries(grant, options())[0], explicit(projectId))
  assert.equal(evaluateGrant(grant, request('session.list'), options()).code, C.ACTION_NOT_GRANTED)
  const derived = v2(); delete derived.projectRegistration
  assert.deepEqual(effectiveProjectEntries(derived, options()), [])
  assert.equal(evaluateGrant(derived, request('project.list'), options()).code, C.PROJECT_NOT_GRANTED)
  derived.projects.push({ ...explicit(projectId), actions: ['project.list'] })
  assert.equal(evaluateGrant(derived, request('project.list'), options()).allowed, true)
})

test('registering an existing native workspace never imports any of its old native sessions', () => {
  const grant = v2(), opts = options()
  for (const sessionId of ['old-native-1', 'old-native-2', 'created-session']) {
    assert.equal(sessionAdmissionAllowed(grant, { projectId, sessionId }, opts), false)
    assert.equal(evaluateGrant(grant, request('session.read', { sessionId, exportClasses: ['conversation.user'] }), opts).code, C.SESSION_NOT_GRANTED)
  }
  rejects(() => effectiveExportClasses(grant, { projectId, sessionId: 'old-native-1' }, opts), C.SESSION_NOT_GRANTED)
  rejects(() => effectiveProjectEntries(grant, options([{ ...owned(), sessionIds: ['old-native-1'] }])), C.INVALID_OPTIONS)
})

test('new sessions still need the existing exact Worker committed create proof, never imported:false alone', () => {
  const grant = v2(), opts = options([], { remoteOwnedProjects: [owned()], remoteOwnedSessions: [sessionOwned()] })
  assert.equal(sessionAdmissionAllowed(grant, { projectId, sessionId: 'created-session' }, opts), true)
  for (const row of [{ ...sessionOwned(), projectId: 'elsewhere' }, { ...sessionOwned(), machineKey: 'other_worker' }, { ...sessionOwned(), principal: { kind: 'controller', id: 'other_controller' } }]) {
    assert.equal(sessionAdmissionAllowed(grant, { projectId, sessionId: 'created-session' }, options([owned()], { remoteOwnedSessions: [row] })), false)
  }
  const explicitGrant = v2(); explicitGrant.projects.push({ ...explicit(projectId), exportClasses: ['conversation.user'], sessions: [{ sessionId: 'unowned', imported: false, actions: ['session.read'] }] })
  assert.equal(evaluateGrant(explicitGrant, request('session.read', { sessionId: 'unowned', exportClasses: ['conversation.user'] }), options()).code, C.SESSION_NOT_GRANTED)
})

test('optional effective-export options share derived policy while the old two-argument face stays explicit-only', () => {
  const grant = v2(), opts = options([owned()], { remoteOwnedSessions: [sessionOwned()] })
  assert.deepEqual(effectiveExportClasses(grant, { projectId }, opts), template().exportClasses)
  assert.deepEqual(effectiveExportClasses(grant, { projectId, sessionId: 'created-session' }, opts), template().createdSessionGrant.exportClasses)
  rejects(() => effectiveExportClasses(grant, { projectId }), C.PROJECT_NOT_GRANTED)
  rejects(() => effectiveExportClasses({ ...grant, expiresAt: 15 }, { projectId }, opts), C.EXPIRED)
})

test('committed project inventories cap at256 and reject duplicate identity or request correlations', () => {
  const rows = Array.from({ length: 256 }, (_, index) => owned(`p-${index}`))
  assert.equal(effectiveProjectEntries(v2(), options(rows)).length, 256)
  rejects(() => effectiveProjectEntries(v2(), options([...rows, owned('p-extra')])), C.INVALID_OPTIONS)
  rejects(() => effectiveProjectEntries(v2(), options([owned(), owned()])), C.INVALID_OPTIONS)
  rejects(() => effectiveProjectEntries(v2(), options([owned(), { ...owned('another-project'), registerRequestId: owned().registerRequestId }])), C.INVALID_OPTIONS)
})

test('unverified, malformed or path-bearing project ownership fails with static policy errors', () => {
  for (const state of ['intent', 'unknown', 'prepared']) rejects(() => effectiveProjectEntries(v2(), options([{ ...owned(), state }])), C.INVALID_OPTIONS)
  for (const bad of [null, {}, { ...owned(), projectId: 'bad/id' }, { ...owned(), registerRequestId: 'short' }, { ...owned(), nativeWorkspaceId: 'PRIVATE_NATIVE_ID' }, { ...owned(), path: 'PRIVATE_NATIVE_PATH' }]) {
    assert.throws(() => effectiveProjectEntries(v2(), options([bad])), error => error.code === C.INVALID_OPTIONS && error.message === 'Worker project ownership is invalid' && !JSON.stringify(error).includes('PRIVATE'))
  }
  rejects(() => effectiveProjectEntries(v2(), { ...options(), remoteOwnedProjects: null }), C.INVALID_OPTIONS)
  const row = owned(), entries = effectiveProjectEntries(v2(), options([row]))
  row.projectGrant.actions.push('project.list')
  assert.deepEqual(entries[0].actions, template().actions)
})
