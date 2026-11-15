import assert from 'node:assert/strict'
import test from 'node:test'

import { FederationContractError } from '../../lib/federation/identity.mjs'
import {
  ACTION_SCOPES,
  EXPORT_CLASSES,
  EXPORT_CLASS_SERIALIZER,
  FEDERATION_GRANTS_VERSION,
  GRANT_ACTIONS,
  GRANT_CODES,
  PENDING_EXPORT_CLASSES,
  PROJECT_ACTIONS,
  REVIEWED_EXPORT_CLASSES,
  SESSION_ACTIONS,
  assertReviewedExportClasses,
  assertRevisionAdvance,
  effectiveExportClasses,
  evaluateGrant,
  exportClassSerializerStatus,
  grantAllows,
  grantStatus,
  parseGrant,
  requireActiveGrant,
  requireReviewedExportClass,
} from '../../lib/federation/grants.mjs'

// Synthetic identities; not identifiers from an installed deployment.
const PRINCIPAL = Object.freeze({ kind: 'controller', id: 'controller_fixture_0001' })
const OTHER_PRINCIPAL = Object.freeze({ kind: 'controller', id: 'controller_aaaaaaaaaaaaaaaa' })
const MACHINE = 'worker_fixture_0001'
const OTHER_MACHINE = 'worker_aaaaaaaaaaaaaaaa'
const PROJECT = 'demo'
const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = 'session-22222222-2222-4222-8222-222222222222'
const PROJECT_ACTIONS_ALL = ['project.list', 'session.list', 'session.create', 'model.list']
const SESSION_ACTIONS_ALL = ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select']
const OPTS = Object.freeze({ currentRevision: 3, now: 2000 })

function baseGrant() {
  return {
    version: 1,
    grantId: 'grant_abcdef12',
    principal: { ...PRINCIPAL },
    machineKey: MACHINE,
    revision: 3,
    issuedAt: 1000,
    projects: [{
      projectId: PROJECT,
      actions: [...PROJECT_ACTIONS_ALL],
      exportClasses: ['conversation.user', 'conversation.assistant', 'tool.call'],
      sessions: [{
        sessionId: SESSION,
        imported: true,
        actions: [...SESSION_ACTIONS_ALL],
        exportClasses: ['conversation.user', 'conversation.assistant'],
      }],
    }],
  }
}

function request(extra = {}) {
  return {
    principal: { ...PRINCIPAL },
    machineKey: MACHINE,
    action: 'session.read',
    projectId: PROJECT,
    sessionId: SESSION,
    exportClasses: ['conversation.user'],
    ...extra,
  }
}

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && error.code === code)
}

test('grants contract exposes stable action/class tables', () => {
  assert.equal(FEDERATION_GRANTS_VERSION, 1)
  assert.ok(Object.isFrozen(GRANT_ACTIONS))
  assert.ok(Object.isFrozen(EXPORT_CLASSES))
  assert.ok(Object.isFrozen(GRANT_CODES))
  assert.deepEqual([...PROJECT_ACTIONS], ['project.list', 'session.list', 'session.create', 'model.list'])
  assert.deepEqual(Object.keys(ACTION_SCOPES).sort(), [...GRANT_ACTIONS].sort())
  assert.equal(ACTION_SCOPES['session.read'], 'session')
  assert.equal(ACTION_SCOPES['session.create'], 'project')
  assert.equal(EXPORT_CLASSES.includes('reasoning'), true)
  assert.equal(EXPORT_CLASSES.includes('tool.result'), true)
})

test('strict parser accepts a valid explicit grant and freezes it deeply', () => {
  const parsed = parseGrant(baseGrant())
  assert.equal(parsed.grantId, 'grant_abcdef12')
  assert.equal(parsed.revision, 3)
  assert.equal(parsed.projects[0].sessions[0].imported, true)
  assert.ok(Object.isFrozen(parsed))
  assert.ok(Object.isFrozen(parsed.projects))
  assert.ok(Object.isFrozen(parsed.projects[0].actions))
  assert.ok(Object.isFrozen(parsed.projects[0].sessions))
  assert.ok(Object.isFrozen(parsed.projects[0].sessions[0]))
})

test('parser rejects implicit/legacy/path fields everywhere', () => {
  for (const field of ['cwd', 'path', 'hostname', 'relayUrl', 'localSessionId', 'generation', 'pairingGeneration', 'legacy', 'allProjects', 'allSessions']) {
    const grant = baseGrant()
    grant[field] = 'x'
    rejects(() => parseGrant(grant), GRANT_CODES.FORBIDDEN_FIELD)
  }
  const projectCwd = baseGrant()
  projectCwd.projects[0].cwd = 'C:/repo'
  rejects(() => parseGrant(projectCwd), GRANT_CODES.FORBIDDEN_FIELD)
  const sessionCwd = baseGrant()
  sessionCwd.projects[0].sessions[0].cwd = 'C:/repo'
  rejects(() => parseGrant(sessionCwd), GRANT_CODES.FORBIDDEN_FIELD)
})

test('parser enforces versions, revisions, timestamps, and grant ids', () => {
  rejects(() => parseGrant({ ...baseGrant(), version: 3 }), GRANT_CODES.INVALID)
  rejects(() => parseGrant({ ...baseGrant(), revision: 0 }), GRANT_CODES.INVALID_REVISION)
  rejects(() => parseGrant({ ...baseGrant(), revision: 1.5 }), GRANT_CODES.INVALID_REVISION)
  rejects(() => parseGrant({ ...baseGrant(), issuedAt: -1 }), GRANT_CODES.INVALID_TIMESTAMP)
  rejects(() => parseGrant({ ...baseGrant(), expiresAt: 1000 }), GRANT_CODES.INVALID_TIMESTAMP)
  rejects(() => parseGrant({ ...baseGrant(), revokedAt: 999 }), GRANT_CODES.INVALID_TIMESTAMP)
  rejects(() => parseGrant({ ...baseGrant(), grantId: 'short' }), GRANT_CODES.INVALID)
  rejects(() => parseGrant({ ...baseGrant(), projects: [] }), GRANT_CODES.INVALID)
})

test('parser rejects implicit principals and invalid machines', () => {
  rejects(() => parseGrant({ ...baseGrant(), principal: { kind: 'agent', id: PRINCIPAL.id } }), GRANT_CODES.INVALID_PRINCIPAL)
  rejects(() => parseGrant({ ...baseGrant(), principal: { kind: 'controller', id: 'bad/id' } }), GRANT_CODES.INVALID_PRINCIPAL)
  rejects(() => parseGrant({ ...baseGrant(), machineKey: 'bad/key' }), GRANT_CODES.INVALID_MACHINE)
})

test('parser enforces action scopes, unknown actions, and duplicates', () => {
  const projectSessionAction = baseGrant()
  projectSessionAction.projects[0].actions = ['session.read']
  rejects(() => parseGrant(projectSessionAction), GRANT_CODES.ACTION_SCOPE_MISMATCH)

  const sessionProjectAction = baseGrant()
  sessionProjectAction.projects[0].sessions[0].actions = ['session.create']
  rejects(() => parseGrant(sessionProjectAction), GRANT_CODES.ACTION_SCOPE_MISMATCH)

  const unknownAction = baseGrant()
  unknownAction.projects[0].actions = ['legacy.prompt']
  rejects(() => parseGrant(unknownAction), GRANT_CODES.UNKNOWN_ACTION)

  const duplicateAction = baseGrant()
  duplicateAction.projects[0].actions = ['project.list', 'project.list']
  rejects(() => parseGrant(duplicateAction), GRANT_CODES.DUPLICATE_ACTION)

  const noImplicitSessions = baseGrant()
  noImplicitSessions.projects[0].sessions = [{
    sessionId: SESSION,
    imported: true,
    actions: [],
  }]
  const parsed = parseGrant(noImplicitSessions)
  const decision = evaluateGrant(parsed, request(), OPTS)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, GRANT_CODES.ACTION_NOT_GRANTED)
})

test('parser enforces export-class maximum and session narrowing', () => {
  const unknownClass = baseGrant()
  unknownClass.projects[0].exportClasses = ['conversation.transcript']
  rejects(() => parseGrant(unknownClass), GRANT_CODES.UNKNOWN_EXPORT_CLASS)

  const duplicateClass = baseGrant()
  duplicateClass.projects[0].exportClasses = ['conversation.user', 'conversation.user']
  rejects(() => parseGrant(duplicateClass), GRANT_CODES.DUPLICATE_EXPORT_CLASS)

  const sessionWidening = baseGrant()
  sessionWidening.projects[0].exportClasses = ['conversation.user']
  sessionWidening.projects[0].sessions[0].exportClasses = ['conversation.user', 'conversation.assistant']
  rejects(() => parseGrant(sessionWidening), GRANT_CODES.EXPORT_CLASS_SUBSET_VIOLATION)

  const missingImported = baseGrant()
  delete missingImported.projects[0].sessions[0].imported
  rejects(() => parseGrant(missingImported), GRANT_CODES.INVALID_SESSION)
})

test('parser rejects duplicate projects and duplicate explicit sessions', () => {
  const duplicateProject = baseGrant()
  duplicateProject.projects.push(JSON.parse(JSON.stringify(duplicateProject.projects[0])))
  rejects(() => parseGrant(duplicateProject), GRANT_CODES.DUPLICATE_PROJECT)

  const duplicateSession = baseGrant()
  duplicateSession.projects.push({
    projectId: 'demo-2',
    actions: [],
    exportClasses: [],
    sessions: [{
      sessionId: SESSION,
      imported: true,
      actions: [],
    }],
  })
  rejects(() => parseGrant(duplicateSession), GRANT_CODES.DUPLICATE_SESSION)
})

test('evaluation allows only explicitly granted actions and sessions', () => {
  const grant = parseGrant(baseGrant())

  assert.equal(grantAllows(grant, { ...request(), action: 'session.create', sessionId: undefined, exportClasses: undefined }, OPTS), false)
  assert.equal(grantAllows(grant, request(), OPTS), true)
  assert.equal(grantAllows(grant, request({ action: 'session.prompt', exportClasses: undefined }), OPTS), true)
  assert.equal(grantAllows(grant, request({ action: 'model.select', exportClasses: undefined }), OPTS), true)

  const missingSession = evaluateGrant(grant, request({ sessionId: OTHER_SESSION }), OPTS)
  assert.equal(missingSession.allowed, false)
  assert.equal(missingSession.code, GRANT_CODES.SESSION_NOT_GRANTED)

  const missingProject = evaluateGrant(grant, request({ projectId: 'demo-2' }), OPTS)
  assert.equal(missingProject.allowed, false)
  assert.equal(missingProject.code, GRANT_CODES.PROJECT_NOT_GRANTED)

  const noSessionEntry = baseGrant()
  noSessionEntry.projects[0].sessions = []
  const noSessionsGrant = evaluateGrant(parseGrant(noSessionEntry), request(), OPTS)
  assert.equal(noSessionsGrant.allowed, false)
  assert.equal(noSessionsGrant.code, GRANT_CODES.SESSION_NOT_GRANTED)
})

test('default-deny grant allows nothing', () => {
  const empty = baseGrant()
  empty.projects[0].actions = []
  empty.projects[0].exportClasses = []
  empty.projects[0].sessions = []
  const grant = parseGrant(empty)

  for (const [action, extra] of [
    ['project.list', { sessionId: undefined, exportClasses: undefined }],
    ['session.create', { sessionId: undefined, exportClasses: undefined }],
    ['session.read', { exportClasses: ['conversation.user'] }],
  ]) {
    const decision = evaluateGrant(grant, request({ action, ...extra }), OPTS)
    assert.equal(decision.allowed, false)
  }
})

test('no same-cwd or localSessionId adoption is accepted', () => {
  const grant = parseGrant(baseGrant())
  rejects(() => evaluateGrant(grant, request({ cwd: 'C:/repo' }), OPTS), GRANT_CODES.PATH_ADOPTION_NOT_ALLOWED)
  rejects(() => evaluateGrant(grant, request({ path: 'C:/repo' }), OPTS), GRANT_CODES.PATH_ADOPTION_NOT_ALLOWED)
  rejects(() => evaluateGrant(grant, request({ localSessionId: 'session-local' }), OPTS), GRANT_CODES.FORBIDDEN_FIELD)
  rejects(() => evaluateGrant(grant, request({ generation: 2 }), OPTS), GRANT_CODES.FORBIDDEN_FIELD)
  rejects(() => evaluateGrant(grant, request({ imported: true }), OPTS), GRANT_CODES.FORBIDDEN_FIELD)
})

test('stale, expired, and revoked revisions are denied with distinct codes', () => {
  const grant = parseGrant(baseGrant())

  const stale = evaluateGrant(grant, request(), { currentRevision: 4, now: 2000 })
  assert.equal(stale.allowed, false)
  assert.equal(stale.code, GRANT_CODES.STALE_REVISION)

  const expiredGrant = baseGrant()
  expiredGrant.expiresAt = 1500
  const expired = evaluateGrant(parseGrant(expiredGrant), request(), { currentRevision: 3, now: 2000 })
  assert.equal(expired.allowed, false)
  assert.equal(expired.code, GRANT_CODES.EXPIRED)

  const revokedGrant = baseGrant()
  revokedGrant.revokedAt = 1500
  const revoked = evaluateGrant(parseGrant(revokedGrant), request(), { currentRevision: 3, now: 2000 })
  assert.equal(revoked.allowed, false)
  assert.equal(revoked.code, GRANT_CODES.REVOKED)
})

test('principal and machine identity must match exactly', () => {
  const grant = parseGrant(baseGrant())

  const principal = evaluateGrant(grant, request({ principal: { ...OTHER_PRINCIPAL } }), OPTS)
  assert.equal(principal.allowed, false)
  assert.equal(principal.code, GRANT_CODES.PRINCIPAL_MISMATCH)

  const machine = evaluateGrant(grant, request({ machineKey: OTHER_MACHINE }), OPTS)
  assert.equal(machine.allowed, false)
  assert.equal(machine.code, GRANT_CODES.MACHINE_MISMATCH)
})

test('read/follow require explicit granted export classes; other actions reject them', () => {
  const grant = parseGrant(baseGrant())

  assert.equal(grantAllows(grant, request(), OPTS), true)
  assert.equal(grantAllows(grant, request({ action: 'session.follow' }), OPTS), true)

  const noClasses = evaluateGrant(grant, request({ exportClasses: undefined }), OPTS)
  assert.equal(noClasses.allowed, false)
  assert.equal(noClasses.code, GRANT_CODES.EXPORT_CLASS_REQUIRED)

  const emptyClasses = evaluateGrant(grant, request({ exportClasses: [] }), OPTS)
  assert.equal(emptyClasses.allowed, false)
  assert.equal(emptyClasses.code, GRANT_CODES.EXPORT_CLASS_REQUIRED)

  const reasoning = evaluateGrant(grant, request({ exportClasses: ['reasoning'] }), OPTS)
  assert.equal(reasoning.allowed, false)
  assert.equal(reasoning.code, GRANT_CODES.EXPORT_CLASS_NOT_GRANTED)

  const toolResult = evaluateGrant(grant, request({ exportClasses: ['tool.result'] }), OPTS)
  assert.equal(toolResult.allowed, false)
  assert.equal(toolResult.code, GRANT_CODES.EXPORT_CLASS_NOT_GRANTED)

  const toolCall = evaluateGrant(grant, request({ exportClasses: ['tool.call'] }), OPTS)
  assert.equal(toolCall.allowed, false)
  assert.equal(toolCall.code, GRANT_CODES.EXPORT_CLASS_NOT_GRANTED)

  const unexpected = evaluateGrant(grant, request({ action: 'session.prompt', exportClasses: ['conversation.user'] }), OPTS)
  assert.equal(unexpected.allowed, false)
  assert.equal(unexpected.code, GRANT_CODES.EXPORT_CLASS_UNEXPECTED)

  rejects(() => evaluateGrant(grant, request({ exportClasses: ['conversation.unknown'] }), OPTS), GRANT_CODES.UNKNOWN_EXPORT_CLASS)
  rejects(() => evaluateGrant(grant, request({ exportClasses: ['conversation.user', 'conversation.user'] }), OPTS), GRANT_CODES.DUPLICATE_EXPORT_CLASS)
})

test('session export classes narrow the project maximum', () => {
  const grant = parseGrant(baseGrant())
  assert.deepEqual(effectiveExportClasses(grant, { projectId: PROJECT }), ['conversation.user', 'conversation.assistant', 'tool.call'])
  assert.deepEqual(effectiveExportClasses(grant, { projectId: PROJECT, sessionId: SESSION }), ['conversation.user', 'conversation.assistant'])
  rejects(() => effectiveExportClasses(grant, { projectId: 'demo-2' }), GRANT_CODES.PROJECT_NOT_GRANTED)
  rejects(() => effectiveExportClasses(grant, { projectId: PROJECT, sessionId: OTHER_SESSION }), GRANT_CODES.SESSION_NOT_GRANTED)
})

test('a grant never authorizes raw export; only a reviewed schema-aware serializer does', () => {
  assert.deepEqual(REVIEWED_EXPORT_CLASSES, [
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
  assert.equal(PENDING_EXPORT_CLASSES.includes('reasoning'), true)
  assert.equal(PENDING_EXPORT_CLASSES.includes('tool.result'), false)
  assert.equal(EXPORT_CLASS_SERIALIZER['tool.call'], 'reviewed')
  assert.equal(EXPORT_CLASS_SERIALIZER['tool.result'], 'reviewed')
  assert.equal(PENDING_EXPORT_CLASSES.includes('files'), false)
  assert.equal(EXPORT_CLASS_SERIALIZER.files, 'reviewed')
  assert.equal(PENDING_EXPORT_CLASSES.includes('unknown'), true)
  assert.equal(EXPORT_CLASS_SERIALIZER['conversation.user'], 'reviewed')
  assert.equal(EXPORT_CLASS_SERIALIZER['reasoning'], 'pending')

  // Permission alone is not enough: the class is granted, yet raw serialization is withheld.
  const grantWithReasoning = baseGrant()
  grantWithReasoning.projects[0].exportClasses.push('reasoning')
  grantWithReasoning.projects[0].sessions[0].exportClasses.push('reasoning')
  const permitted = evaluateGrant(parseGrant(grantWithReasoning), request({ exportClasses: ['reasoning'] }), OPTS)
  assert.equal(permitted.allowed, true)
  assert.equal(exportClassSerializerStatus('reasoning'), 'pending')
  rejects(() => requireReviewedExportClass('reasoning'), GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING)
  rejects(() => assertReviewedExportClasses(['reasoning']), GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING)
  rejects(() => assertReviewedExportClasses(['conversation.user', 'reasoning']), GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING)
  rejects(() => exportClassSerializerStatus('not-a-class'), GRANT_CODES.UNKNOWN_EXPORT_CLASS)
  rejects(() => requireReviewedExportClass('not-a-class'), GRANT_CODES.UNKNOWN_EXPORT_CLASS)

  // Reviewed classes pass; a class becomes exportable only when the serializer support set is explicit.
  assert.equal(exportClassSerializerStatus('conversation.user'), 'reviewed')
  assert.equal(requireReviewedExportClass('conversation.user'), 'conversation.user')
  assert.deepEqual(assertReviewedExportClasses(['conversation.user', 'conversation.assistant']), ['conversation.user', 'conversation.assistant'])
  rejects(() => assertReviewedExportClasses(['reasoning'], ['reasoning']), GRANT_CODES.INVALID_OPTIONS)
  rejects(() => requireReviewedExportClass('reasoning', ['reasoning']), GRANT_CODES.INVALID_OPTIONS)
  rejects(() => assertReviewedExportClasses([]), GRANT_CODES.EXPORT_CLASS_REQUIRED)
  rejects(() => assertReviewedExportClasses(['conversation.user', 'conversation.user']), GRANT_CODES.DUPLICATE_EXPORT_CLASS)
})

test('scope violations are rejected before evaluation and action gaps are denied', () => {
  const grant = parseGrant(baseGrant())

  rejects(() => evaluateGrant(grant, { ...request(), action: 'session.create', sessionId: SESSION }, OPTS), GRANT_CODES.INVALID_REQUEST)
  rejects(() => evaluateGrant(grant, { ...request(), sessionId: undefined }, OPTS), GRANT_CODES.INVALID_REQUEST)
  rejects(() => evaluateGrant(grant, { ...request(), action: 'legacy.prompt' }, OPTS), GRANT_CODES.UNKNOWN_ACTION)

  const missingProjectAction = baseGrant()
  missingProjectAction.projects[0].actions = ['session.list']
  const projectDenied = evaluateGrant(parseGrant(missingProjectAction), request({ action: 'session.create', sessionId: undefined, exportClasses: undefined }), OPTS)
  assert.equal(projectDenied.allowed, false)
  assert.equal(projectDenied.code, GRANT_CODES.ACTION_NOT_GRANTED)

  const missingSessionAction = baseGrant()
  missingSessionAction.projects[0].sessions[0].actions = ['session.read']
  const sessionDenied = evaluateGrant(parseGrant(missingSessionAction), request({ action: 'session.prompt', exportClasses: undefined }), OPTS)
  assert.equal(sessionDenied.allowed, false)
  assert.equal(sessionDenied.code, GRANT_CODES.ACTION_NOT_GRANTED)
})

test('explicit existing sessions require imported:true and never gain implicit legacy access', () => {
  const imported = baseGrant()
  assert.equal(parseGrant(imported).projects[0].sessions[0].imported, true)

  const explicitNotImported = baseGrant()
  explicitNotImported.projects[0].sessions[0].imported = false
  const grant = parseGrant(explicitNotImported)
  assert.equal(grantAllows(grant, request(), OPTS), false)
  const proof = { principal: { ...PRINCIPAL }, machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION, createRequestId: 'create_fixture', state: 'committed' }
  assert.equal(grantAllows(grant, request(), { ...OPTS, remoteOwnedSessions: [proof] }), true)
  for (const wrong of [{ ...proof, projectId: 'elsewhere' }, { ...proof, machineKey: OTHER_MACHINE }, { ...proof, principal: OTHER_PRINCIPAL }, { ...proof, sessionId: OTHER_SESSION }]) {
    assert.equal(grantAllows(grant, request(), { ...OPTS, remoteOwnedSessions: [wrong] }), false)
  }
  rejects(() => grantAllows(grant, request(), { ...OPTS, remoteOwnedSessions: [{ ...proof, state: 'intent' }] }), GRANT_CODES.INVALID_OPTIONS)
  rejects(() => grantAllows(grant, request({ remoteOwnedSessions: [proof] }), OPTS), GRANT_CODES.INVALID_REQUEST)
  // Still only the explicitly listed session; nothing becomes reachable by default.
  assert.equal(grantAllows(grant, request({ sessionId: OTHER_SESSION }), OPTS), false)
  // Legacy ACL state (localSessionId) is not part of the grant contract at all.
  rejects(() => parseGrant({ ...baseGrant(), localSessionId: SESSION }), GRANT_CODES.FORBIDDEN_FIELD)
})

test('status helpers and revision advancement are strict', () => {
  const grant = parseGrant(baseGrant())
  assert.deepEqual(grantStatus(grant, OPTS), { status: 'active' })
  assert.equal(grantStatus(grant, { currentRevision: 4, now: 2000 }).status, 'stale')
  assert.equal(grantStatus(grant, { currentRevision: 3, now: 2000, ...{} }).code, undefined)
  const expired = baseGrant()
  expired.expiresAt = 1500
  assert.equal(grantStatus(parseGrant(expired), { currentRevision: 3, now: 2000 }).code, GRANT_CODES.EXPIRED)

  assert.equal(requireActiveGrant(grant, OPTS).revision, 3)
  rejects(() => requireActiveGrant(grant, { currentRevision: 4, now: 2000 }), GRANT_CODES.STALE_REVISION)

  assert.equal(assertRevisionAdvance(4, 3), 4)
  assert.equal(assertRevisionAdvance({ revision: 5 }, 3), 5)
  rejects(() => assertRevisionAdvance(3, 3), GRANT_CODES.REVISION_NOT_ADVANCED)
  rejects(() => assertRevisionAdvance(2, 3), GRANT_CODES.REVISION_NOT_ADVANCED)
  rejects(() => assertRevisionAdvance('4', 3), GRANT_CODES.INVALID_REVISION)
  rejects(() => assertRevisionAdvance(4, 0), GRANT_CODES.INVALID_OPTIONS)
})

test('evaluation options and malformed requests fail closed', () => {
  const grant = parseGrant(baseGrant())
  rejects(() => grantStatus(grant, { currentRevision: 0, now: 2000 }), GRANT_CODES.INVALID_OPTIONS)
  rejects(() => grantStatus(grant, { currentRevision: 3, now: -1 }), GRANT_CODES.INVALID_OPTIONS)
  rejects(() => evaluateGrant(grant, { ...request(), principal: { kind: 'controller', id: 'bad/id' } }, OPTS), GRANT_CODES.INVALID_PRINCIPAL)
  rejects(() => evaluateGrant(grant, { ...request(), projectId: 'bad/project' }, OPTS), GRANT_CODES.INVALID_PROJECT)
  rejects(() => evaluateGrant(grant, { ...request(), sessionId: 'bad/session' }, OPTS), GRANT_CODES.INVALID_SESSION)
  rejects(() => evaluateGrant(grant, { ...request(), machineKey: 'bad/machine' }, OPTS), GRANT_CODES.INVALID_MACHINE)
  rejects(() => evaluateGrant({ ...baseGrant(), revision: 0 }, request(), OPTS), GRANT_CODES.INVALID_REVISION)
})
