/**
 * Independent adversarial review tests for the federation foundation.
 *
 * Owned by the independent verifier (task-10). These tests do not import the
 * production widgets or wiring; they probe the pure identity/grants modules at
 * boundaries the author tests do not cover. They are intentionally separate from
 * `tests/federation/*.test.mjs` so that author coverage is not rewritten.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FederationContractError,
  IDENTITY_CODES,
  canonicalSessionTuple,
  createSessionRef,
  createTrustBinding,
  decodeProjectRef,
  decodeSessionRef,
  encodeProjectRef,
  encodeSessionRef,
  isProjectRefToken,
  isSessionRefToken,
  machineContinuity,
  parseProjectId,
  parseSessionId,
  sameSessionRef,
  sessionRefKey,
} from '../lib/federation/identity.mjs'

import {
  EXPORT_CLASSES,
  GRANT_CODES,
  REVIEWED_EXPORT_CLASSES,
  assertReviewedExportClasses,
  assertRevisionAdvance,
  effectiveExportClasses,
  evaluateGrant,
  exportClassSerializerStatus,
  grantStatus,
  parseGrant,
  requireReviewedExportClass,
} from '../lib/federation/grants.mjs'

const PRINCIPAL = { kind: 'controller', id: 'controller_reviewer_0001' }
const MACHINE = 'worker_machine_a'
const OTHER_MACHINE = 'worker_machine_b'
const PROJECT = 'demo'
const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const OTHER_SESSION = 'session-22222222-2222-4222-8222-222222222222'
const OPTS = { currentRevision: 7, now: 10_000 }

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && error.code === code)
}

function grantDocument() {
  return {
    version: 1,
    grantId: 'grant_review_0001',
    principal: { ...PRINCIPAL },
    machineKey: MACHINE,
    revision: 7,
    issuedAt: 1_000,
    projects: [{
      projectId: PROJECT,
      actions: ['project.list', 'session.list', 'session.create', 'model.list'],
      exportClasses: ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title', 'files'],
      sessions: [{
        sessionId: SESSION,
        imported: true,
        actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'],
        exportClasses: ['conversation.user', 'conversation.assistant', 'turn'],
      }],
    }],
  }
}

function readRequest(extra = {}) {
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

test('identity: separator-like characters cannot collapse two different tuples', () => {
  const tuples = [
    { machineKey: 'm-a', projectId: 'p_b', sessionId: 's.c' },
    { machineKey: 'm_a', projectId: 'p-b', sessionId: 's_c' },
    { machineKey: 'm', projectId: 'a-b', sessionId: 'c_d.e' },
    { machineKey: 'm', projectId: 'a_b', sessionId: 'c-d.e' },
  ]
  const tokens = tuples.map(tuple => encodeSessionRef(tuple))
  assert.equal(new Set(tokens).size, tokens.length)
  for (let index = 0; index < tuples.length; index++) {
    assert.deepEqual(decodeSessionRef(tokens[index]), tuples[index])
    assert.equal(sessionRefKey(tuples[index]), tokens[index])
    for (let other = 0; other < tuples.length; other++) {
      if (index !== other) assert.equal(sameSessionRef(tuples[index], tuples[other]), false)
    }
  }
})

test('identity: non-canonical JSON spellings of the same tuple are rejected', () => {
  const tuple = [MACHINE, PROJECT, SESSION]
  const canonical = JSON.stringify(tuple)
  const variants = [
    JSON.stringify(tuple).replace(/,/g, ', '),
    JSON.stringify(tuple).replace(/,/g, ' ,'),
    JSON.stringify(tuple, null, 1),
    canonical.replace('session-', 'session\\u002d'),
  ]
  for (const text of variants) {
    const token = `fr1s.${Buffer.from(text, 'utf8').toString('base64url')}`
    rejects(() => decodeSessionRef(token), IDENTITY_CODES.NON_CANONICAL_TOKEN)
  }
})

test('identity: encoding prefixes cannot be confused across session and project tokens', () => {
  const sessionToken = encodeSessionRef({ machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION })
  const projectToken = encodeProjectRef({ machineKey: MACHINE, projectId: PROJECT })
  assert.equal(isSessionRefToken(projectToken), false)
  assert.equal(isProjectRefToken(sessionToken), false)
  rejects(() => decodeProjectRef(sessionToken), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef(projectToken), IDENTITY_CODES.INVALID_TOKEN)
})

test('identity: prototype-pollution components fail closed for every parser', () => {
  for (const value of ['__proto__', 'constructor', 'prototype']) {
    rejects(() => parseMachineIdLike(value), IDENTITY_CODES.INVALID_MACHINE_KEY)
    rejects(() => parseProjectId(value), IDENTITY_CODES.INVALID_PROJECT_ID)
    rejects(() => parseSessionId(value), IDENTITY_CODES.INVALID_SESSION_ID)
  }
})

// parseMachineKey is exercised through the ref parser to keep the import list small.
function parseMachineIdLike(value) {
  return createSessionRef({ machineKey: value, projectId: PROJECT, sessionId: SESSION })
}

test('identity: trust facts are separate from identity and rotation is informational', () => {
  const first = createTrustBinding({ machineKey: MACHINE, pairingGeneration: 1, keyFingerprint: 'a'.repeat(64) })
  const same = createTrustBinding({ machineKey: MACHINE, pairingGeneration: 1, keyFingerprint: 'a'.repeat(64) })
  assert.equal(machineContinuity(first, same), 'same-pairing')
  assert.equal(machineContinuity(first, { ...first, pairingGeneration: 2, keyFingerprint: 'a'.repeat(64) }), 'fingerprint-mismatch')
  assert.equal(machineContinuity(first, { ...first, pairingGeneration: 1, keyFingerprint: 'b'.repeat(64) }), 'fingerprint-mismatch')
  assert.equal(machineContinuity(first, { ...first, machineKey: OTHER_MACHINE }), 'different-machine')
  // A non-positive generation cannot be constructed, so a "lower generation" probe is impossible.
  rejects(() => createTrustBinding({ machineKey: MACHINE, pairingGeneration: 0, keyFingerprint: 'a'.repeat(64) }), IDENTITY_CODES.INVALID_TRUST_BINDING)
  assert.equal(createTrustBinding(first).pairingGeneration, 1)
  // Trust facts cannot be smuggled into the durable identity or a ref.
  rejects(() => createSessionRef({ machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION, pairingGeneration: 1 }), IDENTITY_CODES.FORBIDDEN_FIELD)
})

test('identity: oversized opaque token fails closed instead of being accepted', () => {
  const token = `fr1s.${Buffer.from(JSON.stringify([MACHINE, PROJECT, 'x'.repeat(10_000)])).toString('base64url')}`
  rejects(() => decodeSessionRef(token), IDENTITY_CODES.VALUE_TOO_LONG)
})

test('identity: canonical tuple is frozen and independent from a later object mutation', () => {
  const input = { machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION }
  const tuple = canonicalSessionTuple(input)
  assert.ok(Object.isFrozen(tuple))
  input.sessionId = OTHER_SESSION
  assert.deepEqual(tuple, [MACHINE, PROJECT, SESSION])
  assert.equal(sameSessionRef({ machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION }, input), false)
})

test('grants: same native session id on another machine is a machine mismatch, not a session lookup', () => {
  const grant = parseGrant(grantDocument())
  const decision = evaluateGrant(grant, readRequest({ machineKey: OTHER_MACHINE }), OPTS)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, GRANT_CODES.MACHINE_MISMATCH)
  // Same session id under a different, ungranted project must not fall through either.
  const otherProject = evaluateGrant(grant, readRequest({ projectId: 'other' }), OPTS)
  assert.equal(otherProject.code, GRANT_CODES.PROJECT_NOT_GRANTED)
})

test('grants: explicit empty session export set narrows the project maximum to nothing', () => {
  const document = grantDocument()
  document.projects[0].sessions[0].exportClasses = []
  const grant = parseGrant(document)
  assert.deepEqual(effectiveExportClasses(grant, { projectId: PROJECT, sessionId: SESSION }), [])
  const decision = evaluateGrant(grant, readRequest(), OPTS)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, GRANT_CODES.EXPORT_CLASS_NOT_GRANTED)
})

test('grants: inherited project classes are used only when the session entry omits its own set', () => {
  const document = grantDocument()
  delete document.projects[0].sessions[0].exportClasses
  const grant = parseGrant(document)
  assert.deepEqual(
    effectiveExportClasses(grant, { projectId: PROJECT, sessionId: SESSION }),
    ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title', 'files'],
  )
})

test('grants: every non-read action rejects a requested export-class list', () => {
  const grant = parseGrant(grantDocument())
  for (const action of ['session.status', 'session.prompt', 'session.cancel', 'model.select']) {
    const decision = evaluateGrant(grant, readRequest({ action, exportClasses: ['conversation.user'] }), OPTS)
    assert.equal(decision.allowed, false, action)
    assert.equal(decision.code, GRANT_CODES.EXPORT_CLASS_UNEXPECTED, action)
  }
  for (const action of ['session.read', 'session.follow']) {
    const decision = evaluateGrant(grant, readRequest({ action, exportClasses: undefined }), OPTS)
    assert.equal(decision.allowed, false, action)
    assert.equal(decision.code, GRANT_CODES.EXPORT_CLASS_REQUIRED, action)
  }
})

test('grants: permission to a pending export class never passes the serializer gate', () => {
  const grant = parseGrant(grantDocument())
  // `files` is granted at project level but has no reviewed serializer.
  assert.equal(exportClassSerializerStatus('files'), 'pending')
  rejects(() => requireReviewedExportClass('files'), GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING)
  rejects(() => assertReviewedExportClasses(['files']), GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING)
  for (const exportClass of ['conversation.system', 'conversation.developer', 'tool.call', 'tool.result', 'reasoning', 'unknown']) {
    assert.equal(exportClassSerializerStatus(exportClass), 'pending', exportClass)
    rejects(() => requireReviewedExportClass(exportClass), GRANT_CODES.EXPORT_CLASS_SERIALIZER_PENDING)
  }
  for (const exportClass of REVIEWED_EXPORT_CLASSES) {
    assert.equal(exportClassSerializerStatus(exportClass), 'reviewed', exportClass)
  }
  // The permissive `reviewed` override is deliberately visible here: callers must not pass it.
  assert.deepEqual(assertReviewedExportClasses(['reasoning'], ['reasoning']), ['reasoning'])
})

test('grants: expiry and revocation boundaries are inclusive and revocation wins', () => {
  const expiring = grantDocument()
  expiring.expiresAt = 9_000
  const expiringGrant = parseGrant(expiring)
  assert.equal(grantStatus(expiringGrant, { currentRevision: 7, now: 8_999 }).status, 'active')
  assert.equal(grantStatus(expiringGrant, { currentRevision: 7, now: 9_000 }).status, 'expired')

  const revoked = grantDocument()
  revoked.revokedAt = 9_000
  const revokedGrant = parseGrant(revoked)
  assert.equal(grantStatus(revokedGrant, { currentRevision: 7, now: 8_999 }).status, 'active')
  assert.equal(grantStatus(revokedGrant, { currentRevision: 7, now: 9_000 }).status, 'revoked')
  // A stale revision cannot resurrect a revoked/expired grant.
  assert.equal(grantStatus(revokedGrant, { currentRevision: 8, now: 9_000 }).code, GRANT_CODES.REVOKED)
})

test('grants: a future revision is stale until the authority adopts it', () => {
  const document = grantDocument()
  document.revision = 8
  const decision = evaluateGrant(parseGrant(document), readRequest(), OPTS)
  assert.equal(decision.allowed, false)
  assert.equal(decision.code, GRANT_CODES.STALE_REVISION)
})

test('grants: revision advancement is strictly monotonic within safe integers', () => {
  assert.equal(assertRevisionAdvance(8, 7), 8)
  assert.equal(assertRevisionAdvance({ revision: Number.MAX_SAFE_INTEGER }, Number.MAX_SAFE_INTEGER - 1), Number.MAX_SAFE_INTEGER)
  rejects(() => assertRevisionAdvance(Number.MAX_SAFE_INTEGER + 1, 7), GRANT_CODES.INVALID_REVISION)
  rejects(() => assertRevisionAdvance(7, 7), GRANT_CODES.REVISION_NOT_ADVANCED)
  rejects(() => assertRevisionAdvance(-1, 7), GRANT_CODES.INVALID_REVISION)
})

test('grants: request field smuggling and prototype-shaped values fail closed', () => {
  const grant = parseGrant(grantDocument())
  for (const [key, value, code] of [
    ['pairingGeneration', 1, GRANT_CODES.FORBIDDEN_FIELD],
    ['legacy', true, GRANT_CODES.FORBIDDEN_FIELD],
    ['path', 'C:/repo', GRANT_CODES.PATH_ADOPTION_NOT_ALLOWED],
    ['cwd', 'C:/repo', GRANT_CODES.PATH_ADOPTION_NOT_ALLOWED],
    ['__proto__', {}, GRANT_CODES.INVALID_REQUEST],
  ]) {
    const request = readRequest()
    Object.defineProperty(request, key, { value, enumerable: true, configurable: true })
    rejects(() => evaluateGrant(grant, request, OPTS), code)
  }
  rejects(() => evaluateGrant(grant, readRequest({ principal: { kind: 'Controller', id: PRINCIPAL.id } }), OPTS), GRANT_CODES.INVALID_PRINCIPAL)
  rejects(() => evaluateGrant(grant, readRequest({ action: '__proto__', exportClasses: undefined }), OPTS), GRANT_CODES.UNKNOWN_ACTION)
  rejects(() => evaluateGrant(grant, readRequest({ exportClasses: ['__proto__'] }), OPTS), GRANT_CODES.UNKNOWN_EXPORT_CLASS)
})

test('grants: duplicate explicit session ids across projects are rejected', () => {
  const document = grantDocument()
  document.projects.push({
    projectId: 'demo-2',
    actions: [],
    exportClasses: [],
    sessions: [{ sessionId: SESSION, imported: true, actions: [] }],
  })
  rejects(() => parseGrant(document), GRANT_CODES.DUPLICATE_SESSION)
})

test('grants: imported flag is surfaced in the decision but is not an access check', () => {
  const document = grantDocument()
  document.projects[0].sessions[0].imported = false
  const grant = parseGrant(document)
  const decision = evaluateGrant(grant, readRequest(), OPTS)
  // Review finding: the pure contract cannot know whether a native session predates
  // the federation, so `imported` is informational here; issuance/binding must enforce it.
  assert.equal(decision.allowed, true)
  assert.equal(decision.imported, false)
})

test('grants: every export class has an explicit serializer status and a reviewed/withheld split', () => {
  assert.equal(new Set(EXPORT_CLASSES).size, EXPORT_CLASSES.length)
  for (const exportClass of EXPORT_CLASSES) {
    const status = exportClassSerializerStatus(exportClass)
    assert.ok(status === 'reviewed' || status === 'pending', exportClass)
  }
  assert.equal(EXPORT_CLASSES.includes('turn'), true)
  assert.equal(REVIEWED_EXPORT_CLASSES.includes('turn'), true)
})
