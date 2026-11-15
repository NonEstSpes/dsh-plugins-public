/**
 * Per-pair peer routing: strict peer configuration, compound operation namespaces,
 * capability-gated resolution, and grant-backed authorization.
 *
 * Every machine is an independent paired endpoint with its own state directory and
 * capability set. Resolution is exact: an unknown or removed machine never falls back
 * to local or to another peer. A grant document authorizes the domain action, then the
 * negotiated capability authorizes the transport operation; both must pass.
 *
 * This module is pure: no I/O, no configuration, no process state.
 *
 * @module dsh-remote-control/federation/peers
 */

import { FederationContractError, MACHINE_KEY_PATTERN, parseMachineKey } from './identity.mjs'
import { evaluateGrant, parseGrant } from './grants.mjs'
import {
  FAILURE_CODES,
  FEDERATION_PROTOCOL_VERSION,
  PROTOCOL_LIMITS,
  assertCapability,
  createCapabilities,
  parseCapabilities,
} from './protocol.mjs'

/** Maximum paired machines in one Controller configuration. */
export const MAX_PEERS = 16

const PEER_KEYS = ['machineKey', 'stateDir', 'protocol']
const PEER_OPTIONAL = ['label', 'capabilities']
const ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/
const OP_KEY_PREFIX = 'fpo1.'
const REPORT_KEY_PREFIX = 'fpr1.'
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const REACHABILITY = Object.freeze(['unknown', 'online', 'offline'])
const FRESHNESS = Object.freeze(['never', 'fresh', 'stale'])

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

function parseStateDir(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) fail(FAILURE_CODES.INVALID_MESSAGE, 'peer stateDir is invalid')
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(FAILURE_CODES.INVALID_MESSAGE, 'peer stateDir contains control characters')
  return value
}

function stateDirKey(value) {
  // Windows and macOS compare paths case-insensitively; reject shared state dirs early.
  return value.trim().replace(/[\\/]+/g, '/').replace(/\/+$/g, '').toLowerCase()
}

/**
 * Parse one paired machine configuration.
 * @param {unknown} value - candidate peer.
 * @returns {Readonly<object>} frozen peer.
 */
export function parsePeer(value) {
  assertRecord(value, 'peer', PEER_KEYS, PEER_OPTIONAL)
  const machineKey = parseMachineKey(value.machineKey)
  if (value.protocol === undefined) fail(FAILURE_CODES.INVALID_MESSAGE, 'peer requires "protocol"')
  if (value.protocol !== FEDERATION_PROTOCOL_VERSION) fail(FAILURE_CODES.ACTION_UNSUPPORTED, 'peer must negotiate federation protocol v2')
  const stateDir = parseStateDir(value.stateDir)
  if (value.label !== undefined) {
    if (typeof value.label !== 'string' || value.label.length === 0 || value.label.length > 128 || /[\u0000-\u001f\u007f]/.test(value.label)) {
      fail(FAILURE_CODES.INVALID_MESSAGE, 'peer label is invalid')
    }
  }
  const capabilities = value.capabilities === undefined
    ? createCapabilities({})
    : parseCapabilities(value.capabilities)
  return freezeDeep({
    machineKey,
    ...(value.label === undefined ? {} : { label: value.label }),
    stateDir,
    protocol: FEDERATION_PROTOCOL_VERSION,
    capabilities,
  })
}

/**
 * Parse a complete peer set: unique machine keys and unique state directories, bounded size.
 * @param {unknown} value - array of peer configurations.
 * @returns {Readonly<object[]>} frozen peer list.
 */
export function parsePeerSet(value) {
  if (!Array.isArray(value)) fail(FAILURE_CODES.INVALID_MESSAGE, 'peer set must be an array')
  if (value.length === 0 || value.length > MAX_PEERS) fail(FAILURE_CODES.INVALID_MESSAGE, `peer set must contain 1-${MAX_PEERS} entries`)
  const peers = value.map(parsePeer)
  const machineKeys = new Set()
  const stateDirs = new Set()
  for (const peer of peers) {
    if (machineKeys.has(peer.machineKey)) fail(FAILURE_CODES.PAIRING_MISMATCH, 'peer set names one machine twice', { machineKey: peer.machineKey })
    machineKeys.add(peer.machineKey)
    const key = stateDirKey(peer.stateDir)
    if (stateDirs.has(key)) fail(FAILURE_CODES.PAIRING_MISMATCH, 'peer set shares a state directory', { machineKey: peer.machineKey })
    stateDirs.add(key)
  }
  return Object.freeze(peers)
}

/**
 * Build an immutable exact-match router over a peer set.
 * @param {unknown} peers - peer configurations.
 * @returns {Readonly<object>} frozen router.
 */
export function createPeerRouter(peers) {
  const parsed = parsePeerSet(peers)
  return freezeDeep({ peers: parsed })
}

/**
 * Resolve one peer by stable machine key. Unknown machines never fall back.
 * @param {unknown} router - peer router.
 * @param {unknown} machineKey - machine identity.
 * @returns {Readonly<object>} the exact peer.
 */
export function resolvePeer(router, machineKey) {
  if (!isRecord(router) || !Array.isArray(router.peers)) fail(FAILURE_CODES.INVALID_MESSAGE, 'peer router is invalid')
  const key = parseMachineKey(machineKey)
  const peer = router.peers.find(entry => entry.machineKey === key)
  if (peer === undefined) fail(FAILURE_CODES.SOURCE_UNAVAILABLE, 'paired machine is unknown or removed', { machineKey: key })
  return peer
}

/** Grants action to negotiated capability. */
const ACTION_CAPABILITY = Object.freeze({
  'session.prompt': 'prompt',
  'session.cancel': 'cancel',
  'session.read': 'history',
  'session.follow': 'history',
  'model.select': 'modelSelect',
  'session.create': 'create',
})

function mapGrantCode(code) {
  if (code === 'grant/stale-revision' || code === 'grant/expired' || code === 'grant/revoked') return FAILURE_CODES.GRANT_CHANGED
  if (code === 'grant/principal-mismatch' || code === 'grant/machine-mismatch') return FAILURE_CODES.PAIRING_MISMATCH
  return FAILURE_CODES.NOT_GRANTED
}

/**
 * Authorize one domain action: exact peer, active grant, explicit action/class, negotiated capability.
 * @param {{ router: unknown, grants: readonly unknown[], machineKey: string, principal: Readonly<object>,
 *   action: string, projectId: string, sessionId?: string, exportClasses?: readonly string[],
 *   grantRevision: number, now: number }} request - authorization request.
 * @returns {Readonly<object>} frozen `{ peer, grant, decision }`.
 */
export function authorizePeerAction(request) {
  assertRecord(request, 'peer authorization', [
    'router', 'grants', 'machineKey', 'principal', 'action', 'projectId', 'grantRevision', 'now',
  ], ['sessionId', 'exportClasses', 'remoteOwnedSessions'])
  if (!Array.isArray(request.grants)) fail(FAILURE_CODES.INVALID_MESSAGE, 'grants must be an array')
  if (!isNonNegativeInteger(request.grantRevision) || !isNonNegativeInteger(request.now)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'authorization revisions must be non-negative integers')
  }
  const machineKey = parseMachineKey(request.machineKey)
  const peer = resolvePeer(request.router, machineKey)
  const candidate = request.grants
    .map(parseGrant)
    .find(grant => grant.machineKey === machineKey && grant.revision === request.grantRevision)
  if (candidate === undefined) fail(FAILURE_CODES.GRANT_CHANGED, 'no grant matches the machine and revision')
  const decision = evaluateGrant(candidate, {
    principal: request.principal,
    machineKey,
    action: request.action,
    projectId: request.projectId,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    ...(request.exportClasses === undefined ? {} : { exportClasses: [...request.exportClasses] }),
  }, { currentRevision: request.grantRevision, now: request.now, ...(request.remoteOwnedSessions === undefined ? {} : { remoteOwnedSessions: request.remoteOwnedSessions }) })
  if (!decision.allowed) fail(mapGrantCode(decision.code), 'action is not granted', { reason: decision.code })
  const additionalAction = request.action === 'model.select' ? 'model.list' : request.action === 'session.follow' ? 'session.read' : undefined
  if (additionalAction !== undefined) {
    const additional = evaluateGrant(candidate, {
      principal: request.principal, machineKey, action: additionalAction, projectId: request.projectId,
      ...(additionalAction === 'session.read' ? { sessionId: request.sessionId, exportClasses: request.exportClasses } : {}),
    }, { currentRevision: request.grantRevision, now: request.now, ...(request.remoteOwnedSessions === undefined ? {} : { remoteOwnedSessions: request.remoteOwnedSessions }) })
    if (!additional.allowed) fail(mapGrantCode(additional.code), 'combined endpoint permission is not granted', { reason: additional.code })
  }
  const capability = ACTION_CAPABILITY[request.action]
  if (capability !== undefined) assertCapability(peer.capabilities, capability)
  return freezeDeep({ peer, grant: candidate, decision })
}

/**
 * Build one canonical operation namespace key for a paired machine.
 * @param {unknown} machineKey - stable machine identity.
 * @param {unknown} operationId - operation identity.
 * @returns {string} opaque namespace key beginning with `fpo1.`.
 */
export function peerOperationKey(machineKey, operationId) {
  const key = parseMachineKey(machineKey)
  if (typeof operationId !== 'string' || !ID_PATTERN.test(operationId)) fail(FAILURE_CODES.INVALID_MESSAGE, 'operationId has an unsupported format')
  return `${OP_KEY_PREFIX}${Buffer.from(JSON.stringify([key, operationId]), 'utf8').toString('base64url')}`
}

/**
 * Build one canonical report namespace key for a paired machine.
 * @param {unknown} machineKey - stable machine identity.
 * @param {unknown} reportId - report identity.
 * @returns {string} opaque namespace key beginning with `fpr1.`.
 */
export function peerReportKey(machineKey, reportId) {
  const key = parseMachineKey(machineKey)
  if (typeof reportId !== 'string' || !ID_PATTERN.test(reportId)) fail(FAILURE_CODES.INVALID_MESSAGE, 'reportId has an unsupported format')
  return `${REPORT_KEY_PREFIX}${Buffer.from(JSON.stringify([key, reportId]), 'utf8').toString('base64url')}`
}

/**
 * Decode one operation namespace key.
 * @param {unknown} token - opaque key.
 * @returns {Readonly<{ machineKey: string, operationId: string }>} frozen identity pair.
 */
export function decodePeerOperationKey(token) {
  return decodePairKey(token, OP_KEY_PREFIX, 'operationId')
}

/**
 * Decode one report namespace key.
 * @param {unknown} token - opaque key.
 * @returns {Readonly<{ machineKey: string, reportId: string }>} frozen identity pair.
 */
export function decodePeerReportKey(token) {
  return decodePairKey(token, REPORT_KEY_PREFIX, 'reportId')
}

function decodePairKey(token, prefix, label) {
  if (typeof token !== 'string' || !token.startsWith(prefix)) fail(FAILURE_CODES.INVALID_MESSAGE, 'namespace key has an unsupported prefix')
  if (token.length > PROTOCOL_LIMITS.maxCursorBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'namespace key exceeds the decode budget')
  const body = token.slice(prefix.length)
  if (!BASE64URL_PATTERN.test(body)) fail(FAILURE_CODES.INVALID_MESSAGE, 'namespace key is not base64url')
  let text
  try {
    text = Buffer.from(body, 'base64url').toString('utf8')
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'namespace key cannot be decoded')
  }
  if (Buffer.from(text, 'utf8').toString('base64url') !== body) fail(FAILURE_CODES.INVALID_MESSAGE, 'namespace key is not canonical')
  let pair
  try {
    pair = JSON.parse(text)
  } catch {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'namespace key does not contain JSON')
  }
  if (!Array.isArray(pair) || pair.length !== 2 || JSON.stringify(pair) !== text) fail(FAILURE_CODES.INVALID_MESSAGE, 'namespace key tuple is invalid')
  const machineKey = parseMachineKey(pair[0])
  if (typeof pair[1] !== 'string' || !ID_PATTERN.test(pair[1])) fail(FAILURE_CODES.INVALID_MESSAGE, `namespace ${label} is invalid`)
  return Object.freeze({ machineKey, [label]: pair[1] })
}

/**
 * Strict source status parser. Reachability, freshness, and presence stay independent.
 * @param {unknown} value - candidate status.
 * @returns {Readonly<object>} frozen status.
 */
export function parseSourceStatus(value) {
  assertRecord(value, 'source status', ['machineKey', 'reachability', 'catalogFreshness'], ['lastSeenAt', 'generation', 'grantRevision'])
  const machineKey = parseMachineKey(value.machineKey)
  if (!REACHABILITY.includes(value.reachability)) fail(FAILURE_CODES.INVALID_MESSAGE, 'source reachability is invalid')
  if (!FRESHNESS.includes(value.catalogFreshness)) fail(FAILURE_CODES.INVALID_MESSAGE, 'source catalog freshness is invalid')
  if (value.lastSeenAt !== undefined && !isNonNegativeInteger(value.lastSeenAt)) fail(FAILURE_CODES.INVALID_MESSAGE, 'source lastSeenAt is invalid')
  if (value.generation !== undefined && !isNonNegativeInteger(value.generation)) fail(FAILURE_CODES.INVALID_MESSAGE, 'source generation is invalid')
  if (value.grantRevision !== undefined && !isNonNegativeInteger(value.grantRevision)) fail(FAILURE_CODES.INVALID_MESSAGE, 'source grantRevision is invalid')
  return freezeDeep({
    machineKey,
    reachability: value.reachability,
    catalogFreshness: value.catalogFreshness,
    ...(value.lastSeenAt === undefined ? {} : { lastSeenAt: value.lastSeenAt }),
    ...(value.generation === undefined ? {} : { generation: value.generation }),
    ...(value.grantRevision === undefined ? {} : { grantRevision: value.grantRevision }),
  })
}

/**
 * Validate that an operation key names the same peer as the authenticated channel.
 * @param {{ channelMachineKey: string, token: string, kind: 'operation' | 'report' }} value - comparison.
 * @returns {Readonly<object>} frozen decoded identity pair.
 */
export function assertChannelIdentity(value) {
  assertRecord(value, 'channel identity', ['channelMachineKey', 'token', 'kind'])
  const channelMachineKey = parseMachineKey(value.channelMachineKey)
  const decoded = value.kind === 'report' ? decodePeerReportKey(value.token) : decodePeerOperationKey(value.token)
  if (decoded.machineKey !== channelMachineKey) fail(FAILURE_CODES.PAIRING_MISMATCH, 'namespace key belongs to another paired machine')
  return decoded
}

/** Export limits for callers that build peer configuration forms. */
export const PEER_LIMITS = Object.freeze({ maxPeers: MAX_PEERS, maxOperationId: PROTOCOL_LIMITS.maxOperationIdLength })
