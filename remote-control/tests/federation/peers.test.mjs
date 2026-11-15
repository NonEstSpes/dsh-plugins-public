import assert from 'node:assert/strict'
import test from 'node:test'

import { FederationContractError } from '../../lib/federation/identity.mjs'
import { createCapabilities } from '../../lib/federation/protocol.mjs'
import {
  MAX_PEERS,
  assertChannelIdentity,
  authorizePeerAction,
  createPeerRouter,
  decodePeerOperationKey,
  decodePeerReportKey,
  parsePeer,
  parsePeerSet,
  parseSourceStatus,
  peerOperationKey,
  peerReportKey,
  resolvePeer,
} from '../../lib/federation/peers.mjs'
import { FAILURE_CODES } from '../../lib/federation/protocol.mjs'

// Synthetic identities; not identifiers from an installed deployment.
const PRINCIPAL = Object.freeze({ kind: 'controller', id: 'controller_fixture_0001' })
const OTHER_PRINCIPAL = Object.freeze({ kind: 'controller', id: 'controller_aaaaaaaaaaaaaaaa' })
const MACHINE = 'worker_fixture_0001'
const OTHER_MACHINE = 'worker_aaaaaaaaaaaaaaaa'
const SESSION = 'session-11111111-1111-4111-8111-111111111111'

const CAPABILITIES = createCapabilities({ history: true, prompt: true, cancel: true, modelSelect: true })

function peer(overrides = {}) {
  return {
    machineKey: MACHINE,
    label: 'Рабочий ПК',
    stateDir: 'C:/state/fixture-worker',
    protocol: 2,
    capabilities: CAPABILITIES,
    ...overrides,
  }
}

function grant(overrides = {}) {
  return {
    version: 1,
    grantId: 'grant_abcdef12',
    principal: { ...PRINCIPAL },
    machineKey: MACHINE,
    revision: 3,
    issuedAt: 1000,
    projects: [{
      projectId: 'demo',
      actions: ['project.list', 'session.list'],
      exportClasses: ['conversation.user'],
      sessions: [{
        sessionId: SESSION,
        imported: true,
        actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'],
        exportClasses: ['conversation.user'],
      }],
    }],
    ...overrides,
  }
}

function request(overrides = {}) {
  return {
    router: createPeerRouter([peer()]),
    grants: [grant()],
    machineKey: MACHINE,
    principal: { ...PRINCIPAL },
    action: 'session.read',
    projectId: 'demo',
    sessionId: SESSION,
    exportClasses: ['conversation.user'],
    grantRevision: 3,
    now: 2000,
    ...overrides,
  }
}

function rejects(fn, code) {
  assert.throws(fn, error => error instanceof FederationContractError && error.code === code)
}

test('peer configuration is strict and protocol v2 is mandatory', () => {
  const parsed = parsePeer(peer())
  assert.equal(parsed.protocol, 2)
  assert.equal(parsed.label, 'Рабочий ПК')
  assert.equal(parsed.capabilities.history, true)
  assert.ok(Object.isFrozen(parsed))
  assert.equal(parsePeer({ machineKey: MACHINE, stateDir: 'C:/s', protocol: 2 }).capabilities.history, false)
  rejects(() => parsePeer(peer({ protocol: 1 })), FAILURE_CODES.ACTION_UNSUPPORTED)
  rejects(() => parsePeer({ ...peer(), protocol: undefined }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parsePeer(peer({ stateDir: '' })), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parsePeer(peer({ capabilities: { history: true } })), FAILURE_CODES.INVALID_MESSAGE)
})

test('peer set rejects duplicate machines and shared state directories', () => {
  const first = peer()
  const second = peer({ machineKey: OTHER_MACHINE, stateDir: 'C:/state/vps' })
  const set = parsePeerSet([first, second])
  assert.equal(set.length, 2)

  rejects(() => parsePeerSet([first, peer({ stateDir: 'C:/state/other' })]), FAILURE_CODES.PAIRING_MISMATCH)
  rejects(() => parsePeerSet([first, peer({ machineKey: OTHER_MACHINE, stateDir: 'C:/STATE/FIXTURE-WORKER/' })]), FAILURE_CODES.PAIRING_MISMATCH)
  rejects(() => parsePeerSet([]), FAILURE_CODES.INVALID_MESSAGE)
  const tooMany = Array.from({ length: MAX_PEERS + 1 }, (_, index) => peer({
    machineKey: `worker_machine_${index}`,
    stateDir: `C:/state/${index}`,
  }))
  rejects(() => parsePeerSet(tooMany), FAILURE_CODES.INVALID_MESSAGE)
})

test('router resolves exact machines and never falls back', () => {
  const router = createPeerRouter([peer()])
  assert.equal(resolvePeer(router, MACHINE).machineKey, MACHINE)
  rejects(() => resolvePeer(router, OTHER_MACHINE), FAILURE_CODES.SOURCE_UNAVAILABLE)
  rejects(() => resolvePeer(router, 'bad/machine'), 'identity/invalid-machine-key')
})

test('authorization requires exact peer, active grant, explicit class, and capability', () => {
  const allowed = authorizePeerAction(request())
  assert.equal(allowed.decision.allowed, true)
  assert.equal(allowed.peer.machineKey, MACHINE)
  assert.equal(allowed.decision.exportClasses[0], 'conversation.user')

  rejects(() => authorizePeerAction(request({ machineKey: OTHER_MACHINE })), FAILURE_CODES.SOURCE_UNAVAILABLE)
  rejects(() => authorizePeerAction(request({ grantRevision: 4 })), FAILURE_CODES.GRANT_CHANGED)
  rejects(() => authorizePeerAction(request({ exportClasses: ['reasoning'] })), FAILURE_CODES.NOT_GRANTED)
  rejects(() => authorizePeerAction(request({ principal: { ...OTHER_PRINCIPAL } })), FAILURE_CODES.PAIRING_MISMATCH)
  rejects(() => authorizePeerAction(request({ sessionId: 'session-22222222-2222-4222-8222-222222222222' })), FAILURE_CODES.NOT_GRANTED)

  const noCapability = createPeerRouter([peer({ capabilities: createCapabilities({}) })])
  rejects(() => authorizePeerAction(request({ router: noCapability })), FAILURE_CODES.ACTION_UNSUPPORTED)
})

test('operation and report namespaces are canonical and machine-scoped', () => {
  const operation = peerOperationKey(MACHINE, 'operation_1')
  assert.match(operation, /^fpo1\./)
  assert.deepEqual(decodePeerOperationKey(operation), { machineKey: MACHINE, operationId: 'operation_1' })
  assert.notEqual(peerOperationKey(MACHINE, 'operation_1'), peerOperationKey(OTHER_MACHINE, 'operation_1'))
  assert.notEqual(peerOperationKey(MACHINE, 'operation_1'), peerOperationKey(MACHINE, 'operation_2'))

  const report = peerReportKey(MACHINE, 'report_1')
  assert.match(report, /^fpr1\./)
  assert.deepEqual(decodePeerReportKey(report), { machineKey: MACHINE, reportId: 'report_1' })
  rejects(() => decodePeerOperationKey(report), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => peerOperationKey(MACHINE, 'bad/operation'), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => decodePeerOperationKey(`${operation}=`), FAILURE_CODES.INVALID_MESSAGE)

  assert.deepEqual(assertChannelIdentity({ channelMachineKey: MACHINE, token: operation, kind: 'operation' }), {
    machineKey: MACHINE, operationId: 'operation_1',
  })
  rejects(() => assertChannelIdentity({ channelMachineKey: OTHER_MACHINE, token: operation, kind: 'operation' }), FAILURE_CODES.PAIRING_MISMATCH)
})

test('source status keeps reachability, freshness, and presence independent', () => {
  const status = parseSourceStatus({
    machineKey: MACHINE,
    reachability: 'offline',
    catalogFreshness: 'stale',
    lastSeenAt: 1000,
    generation: 2,
    grantRevision: 3,
  })
  assert.equal(status.reachability, 'offline')
  assert.equal(status.catalogFreshness, 'stale')
  assert.equal(status.lastSeenAt, 1000)
  assert.ok(Object.isFrozen(status))
  rejects(() => parseSourceStatus({ machineKey: MACHINE, reachability: 'busy', catalogFreshness: 'fresh' }), FAILURE_CODES.INVALID_MESSAGE)
  rejects(() => parseSourceStatus({ machineKey: MACHINE, reachability: 'online', catalogFreshness: 'stale', lastSeenAt: -1 }), FAILURE_CODES.INVALID_MESSAGE)
})
