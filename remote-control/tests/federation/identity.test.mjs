import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FEDERATION_IDENTITY_VERSION,
  IDENTITY_CODES,
  FederationContractError,
  canonicalProjectTuple,
  canonicalSessionTuple,
  createMachineIdentity,
  createProjectRef,
  createSessionRef,
  createTrustBinding,
  decodeProjectRef,
  decodeSessionRef,
  encodeProjectRef,
  encodeSessionRef,
  isProjectRefToken,
  isSessionRefToken,
  machineContinuity,
  parseMachineIdentity,
  parseMachineKey,
  parseProjectId,
  parseProjectRef,
  parseSessionId,
  parseSessionRef,
  parseTrustBinding,
  projectRefKey,
  sameProjectRef,
  sameSessionRef,
  sessionRefKey,
} from '../../lib/federation/identity.mjs'

// Synthetic identities; not identifiers from an installed deployment.
const MACHINE = 'worker_fixture_0001'
const OTHER_MACHINE = 'worker_aaaaaaaaaaaaaaaa'
const PROJECT = 'demo'
const SESSION = 'session-11111111-1111-4111-8111-111111111111'
const SESSION_REF = Object.freeze({ machineKey: MACHINE, projectId: PROJECT, sessionId: SESSION })

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && error.code === code)
}

test('identity contract exposes version and stable codes', () => {
  assert.equal(FEDERATION_IDENTITY_VERSION, 1)
  assert.equal(IDENTITY_CODES.INVALID_TOKEN, 'identity/invalid-token')
  assert.ok(Object.isFrozen(IDENTITY_CODES))
})

test('component parsers accept representative paired/native ids and reject unsafe spellings', () => {
  // Synthetic paired/native-format identities must pass unchanged.
  assert.equal(parseMachineKey(MACHINE), MACHINE)
  assert.equal(parseMachineKey(OTHER_MACHINE), OTHER_MACHINE)
  assert.equal(parseProjectId('demo'), 'demo')
  assert.equal(parseSessionId('session-11111111-1111-4111-8111-111111111111'), 'session-11111111-1111-4111-8111-111111111111')
  assert.equal(parseSessionId('session-22222222-2222-4222-8222-222222222222'), 'session-22222222-2222-4222-8222-222222222222')

  assert.equal(parseProjectId('project_v2-demo'), 'project_v2-demo')
  assert.equal(parseSessionId('session-a.b_c-d'), 'session-a.b_c-d')

  for (const value of ['', 'a/b', 'a\\b', 'a b', 'a\0b', '__proto__', 'constructor', 7, null]) {
    rejects(() => parseSessionId(value), IDENTITY_CODES.INVALID_SESSION_ID)
  }
  rejects(() => parseSessionId('x'.repeat(129)), IDENTITY_CODES.VALUE_TOO_LONG)
  rejects(() => parseMachineKey('machine.with.dot'), IDENTITY_CODES.INVALID_MACHINE_KEY)
  rejects(() => parseProjectId('project.with.dot'), IDENTITY_CODES.INVALID_PROJECT_ID)
  rejects(() => parseProjectId('/root'), IDENTITY_CODES.INVALID_PROJECT_ID)
})

test('compound session reference is strict, frozen, and cannot carry paths or extra fields', () => {
  const ref = createSessionRef(SESSION_REF)
  assert.deepEqual(ref, SESSION_REF)
  assert.ok(Object.isFrozen(ref))
  assert.equal(ref.machineKey, MACHINE)

  rejects(() => createSessionRef({ ...SESSION_REF, cwd: 'C:/repo' }), IDENTITY_CODES.FORBIDDEN_FIELD)
  rejects(() => createSessionRef({ ...SESSION_REF, hostname: 'fixture-worker' }), IDENTITY_CODES.FORBIDDEN_FIELD)
  rejects(() => createSessionRef({ ...SESSION_REF, localSessionId: 'session-local' }), IDENTITY_CODES.FORBIDDEN_FIELD)
  rejects(() => createSessionRef({ machineKey: MACHINE, projectId: PROJECT }), IDENTITY_CODES.INVALID_SESSION_REF)
  rejects(() => createSessionRef({ ...SESSION_REF, extra: true }), IDENTITY_CODES.INVALID_SESSION_REF)
})

test('opaque session token round-trips without splitting raw identifiers', () => {
  const token = encodeSessionRef(SESSION_REF)
  assert.match(token, /^fr1s\.[A-Za-z0-9_-]+$/)
  assert.deepEqual(decodeSessionRef(token), SESSION_REF)
  assert.equal(sessionRefKey(SESSION_REF), token)
  assert.equal(isSessionRefToken(token), true)
  assert.equal(isSessionRefToken(encodeProjectRef({ machineKey: MACHINE, projectId: PROJECT })), false)
})

test('different tuples always produce different opaque tokens', () => {
  const base = encodeSessionRef(SESSION_REF)
  for (const candidate of [
    { ...SESSION_REF, machineKey: OTHER_MACHINE },
    { ...SESSION_REF, projectId: 'demo-2' },
    { ...SESSION_REF, sessionId: 'session-a.b_c-d' },
  ]) {
    const token = encodeSessionRef(candidate)
    assert.notEqual(token, base)
    assert.deepEqual(decodeSessionRef(token), candidate)
  }
  // A dot or dash inside a component cannot be mistaken for a tuple separator.
  const tricky = {
    machineKey: MACHINE,
    projectId: 'a_b',
    sessionId: 'c-d.e',
  }
  const decoded = decodeSessionRef(encodeSessionRef(tricky))
  assert.deepEqual(decoded, tricky)
  assert.equal(sameSessionRef(decoded, tricky), true)
  assert.equal(sameSessionRef(decoded, { ...tricky, sessionId: 'c-d.f' }), false)
})

test('non-canonical and malformed session tokens are rejected', () => {
  const token = encodeSessionRef(SESSION_REF)
  const body = token.slice('fr1s.'.length)
  const spacedJson = JSON.stringify([MACHINE, PROJECT, SESSION]).replace(/,/g, ', ')
  const spacedToken = `fr1s.${Buffer.from(spacedJson, 'utf8').toString('base64url')}`

  assert.notEqual(spacedToken, token)
  assert.throws(() => decodeSessionRef(spacedToken), /canonical/)
  rejects(() => decodeSessionRef(`${token}=`), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef('fr1s.%%%'), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef('fr2s.abc'), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef('not-a-token'), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef(`fr1s.${Buffer.from('["only","two"]').toString('base64url')}`), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef(`fr1s.${Buffer.from('123').toString('base64url')}`), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => decodeSessionRef(`fr1s.${Buffer.from(JSON.stringify([MACHINE, PROJECT, 3])).toString('base64url')}`), IDENTITY_CODES.INVALID_SESSION_ID)
  assert.equal(Buffer.from(body, 'base64url').length > 0, true)
})

test('project reference and token are strict as well', () => {
  const ref = createProjectRef({ machineKey: MACHINE, projectId: PROJECT })
  assert.deepEqual(ref, { machineKey: MACHINE, projectId: PROJECT })
  assert.ok(Object.isFrozen(ref))
  const token = encodeProjectRef(ref)
  assert.match(token, /^fr1p\./)
  assert.deepEqual(decodeProjectRef(token), ref)
  assert.equal(projectRefKey(ref), token)
  assert.equal(isProjectRefToken(token), true)
  assert.equal(isProjectRefToken(encodeSessionRef(SESSION_REF)), false)
  rejects(() => decodeProjectRef(encodeSessionRef(SESSION_REF)), IDENTITY_CODES.INVALID_TOKEN)
  rejects(() => createProjectRef({ ...ref, cwd: 'C:/repo' }), IDENTITY_CODES.FORBIDDEN_FIELD)
  assert.equal(sameProjectRef(ref, { machineKey: MACHINE, projectId: PROJECT }), true)
  assert.deepEqual(canonicalProjectTuple(ref), [MACHINE, PROJECT])
  assert.deepEqual(canonicalSessionTuple(SESSION_REF), [MACHINE, PROJECT, SESSION])
  assert.ok(Object.isFrozen(canonicalSessionTuple(SESSION_REF)))
})

test('machine identity is durable and strict', () => {
  const identity = createMachineIdentity({ machineKey: MACHINE, label: 'Рабочий ПК' })
  assert.deepEqual(identity, { machineKey: MACHINE, label: 'Рабочий ПК' })
  assert.ok(Object.isFrozen(identity))
  assert.deepEqual(parseMachineIdentity({ machineKey: MACHINE }), { machineKey: MACHINE })

  rejects(() => createMachineIdentity({ machineKey: MACHINE, hostname: 'fixture-worker' }), IDENTITY_CODES.FORBIDDEN_FIELD)
  rejects(() => createMachineIdentity({ machineKey: MACHINE, cwd: 'C:/repo' }), IDENTITY_CODES.FORBIDDEN_FIELD)
  rejects(() => createMachineIdentity({ machineKey: MACHINE, label: ' padded ' }), IDENTITY_CODES.INVALID_IDENTITY)
  rejects(() => createMachineIdentity({ machineKey: MACHINE, label: 'bad\nlabel' }), IDENTITY_CODES.INVALID_IDENTITY)
})

test('trust generation is separate from machine identity and rotation keeps the machine', () => {
  const first = createTrustBinding({
    machineKey: MACHINE,
    pairingGeneration: 1,
    keyFingerprint: 'a'.repeat(64),
  })
  const rotated = createTrustBinding({
    machineKey: MACHINE,
    pairingGeneration: 2,
    keyFingerprint: 'b'.repeat(64),
  })
  const otherMachine = createTrustBinding({
    machineKey: OTHER_MACHINE,
    pairingGeneration: 1,
    keyFingerprint: 'a'.repeat(64),
  })

  assert.equal(first.machineKey, rotated.machineKey)
  assert.notEqual(first.pairingGeneration, rotated.pairingGeneration)
  assert.equal(machineContinuity(first, first), 'same-pairing')
  assert.equal(machineContinuity(first, rotated), 'rotated')
  assert.equal(machineContinuity(first, { ...rotated, keyFingerprint: first.keyFingerprint }), 'fingerprint-mismatch')
  assert.equal(machineContinuity(first, otherMachine), 'different-machine')

  rejects(() => createTrustBinding({ ...first, keyFingerprint: 'A'.repeat(64) }), IDENTITY_CODES.INVALID_TRUST_BINDING)
  rejects(() => createTrustBinding({ ...first, pairingGeneration: 0 }), IDENTITY_CODES.INVALID_TRUST_BINDING)
  rejects(() => createTrustBinding({ ...first, machineKey: 'bad/key' }), IDENTITY_CODES.INVALID_MACHINE_KEY)
  assert.deepEqual(parseTrustBinding(first), first)
})

test('duplicate or malformed object inputs fail with a typed contract error', () => {
  for (const value of [null, [], 'text', 3, new Date()]) {
    rejects(() => parseSessionRef(value), IDENTITY_CODES.INVALID_SESSION_REF)
  }
  assert.throws(
    () => parseSessionRef(null),
    error => error instanceof FederationContractError && error.name === 'FederationContractError',
  )
})
