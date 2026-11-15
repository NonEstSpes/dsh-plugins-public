/** Durable per-pair federation authority and idempotency. No implicit adoption or replay. */
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openJsonStore } from '../store.mjs'
import { FederationContractError, parseSessionRef, parseProjectRef } from './identity.mjs'
import { parseGrant } from './grants.mjs'

const fail = (code, message) => { throw new FederationContractError(code, message) }
const json = value => JSON.parse(JSON.stringify(value))
/** Canonical JSON for body/trust/grant identity; object property order is not authority.
 * @param {unknown} value - JSON-only value.
 * @returns {string} canonical representation.
 */
export function canonicalJson(value) {
  const seen = new Set()
  const visit = (item, depth) => {
    if (depth > 32) fail('invalid-message', 'JSON value is too deep')
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item)
    if (typeof item === 'number' && Number.isFinite(item) && !Object.is(item, -0)) return JSON.stringify(item)
    if (!item || typeof item !== 'object' || seen.has(item)) fail('invalid-message', 'value must be acyclic JSON')
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) fail('invalid-message', 'value must be plain JSON')
    seen.add(item)
    let result
    if (Array.isArray(item)) {
      const entries = []
      for (let i = 0; i < item.length; i++) {
        if (!Object.hasOwn(item, i)) fail('invalid-message', 'sparse arrays are forbidden')
        entries.push(visit(item[i], depth + 1))
      }
      result = `[${entries.join(',')}]`
    } else {
      const entries = []
      for (const key of Reflect.ownKeys(item).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('invalid-message', 'JSON accessors are forbidden')
        entries.push(`${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`)
      }
      result = `{${entries.join(',')}}`
    }
    seen.delete(item)
    return result
  }
  return visit(value, 0)
}
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)
const MAX_OPERATIONS = 2048

function originalRow(row) { const copy = { ...row }; delete copy.ownerDisposition; return copy }
function eligibleUnknownCreate(state, row) {
  const b = state.binding
  if (state.version !== 2 || !b || !['controller', 'worker'].includes(b.role) || row.state !== 'unknown' || row.action !== 'session.create' || row.machineKey !== b.machineKey || row.principal !== (b.role === 'controller' ? b.id : b.peerId) || Object.hasOwn(row, 'result') || Object.hasOwn(row, 'nativeCreatedProof')) return false
  const target = parseProjectRef(row.target)
  if (target.machineKey !== b.machineKey || !requestId(row.requestId) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest) || typeof row.reservedSessionId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(row.reservedSessionId)) return false
  if (state.operations?.[hash([row.principal, row.machineKey, row.requestId])] !== row || row.nativeRequestId !== `frpc_${hash([b.machineKey, b.id, b.peerId, b.pairingGeneration, b.keyFingerprint, row.requestId, row.target, row.digest])}`) return false
  return !Object.entries(state.remoteOwnedSessions ?? {}).some(([id, owned]) => id === row.reservedSessionId || owned.createRequestId === row.requestId)
}
function ownerAbandonedCreate(state, row) {
  try {
    if (!eligibleUnknownCreate(state, row)) return false
    const marker = row.ownerDisposition
    return marker && Object.keys(marker).sort().join(',') === 'acknowledgedAt,bindingDigest,kind,reservationDigest,rowDigest,version'
      && marker.version === 1 && marker.kind === 'owner-abandoned-create' && Number.isSafeInteger(marker.acknowledgedAt) && marker.acknowledgedAt >= 0
      && marker.bindingDigest === hash(state.binding) && marker.rowDigest === hash(originalRow(row)) && marker.reservationDigest === hash({ reservedSessionId: row.reservedSessionId ?? null })
  } catch (error) { return false }
}
/** Pure, read-only plan for one owner-selected unknown create; hashes bind the exact existing row and trust identity. */
export function planUnknownCreateAcknowledgement(state, target) {
  const ref = parseProjectRef({ machineKey: target.machineKey, projectId: target.projectId })
  const entries = Object.entries(state.operations ?? {}).filter(([, row]) => row.requestId === target.requestId && row.machineKey === ref.machineKey && canonicalJson(row.target) === canonicalJson(ref))
  if (entries.length !== 1 || !eligibleUnknownCreate(state, entries[0][1]) || Object.hasOwn(entries[0][1], 'ownerDisposition')) fail('outcome-unknown', 'owner acknowledgement requires one unmodified unknown create without native proof, result or ownership')
  const [operationKey, row] = entries[0]
  return { version: 1, operationKey, requestId: row.requestId, machineKey: ref.machineKey, projectId: ref.projectId, bindingDigest: hash(state.binding), rowDigest: hash(row), reservationDigest: hash({ reservedSessionId: row.reservedSessionId ?? null }) }
}
/** Offline journal maintenance only: exclusive existing store, exact plan CAS, one disposition field; never startup recovery or native work. */
export async function acknowledgeUnknownCreate(filename, expected, acknowledgedAt = Date.now(), checkOffline) {
  if (typeof checkOffline !== 'function') fail('invalid-message', 'an explicit offline lifecycle checker is required')
  if (!Number.isSafeInteger(acknowledgedAt) || acknowledgedAt < 0) fail('invalid-message', 'invalid owner acknowledgement time')
  const store = await openJsonStore(filename, undefined, { existingOnly: true })
  try {
    await store.update(async state => {
      await checkOffline()
      const actual = planUnknownCreateAcknowledgement(state, expected)
      if (canonicalJson(actual) !== canonicalJson(expected)) fail('request-conflict', 'owner acknowledgement plan changed; no write permitted')
      state.operations[actual.operationKey].ownerDisposition = { version: 1, kind: 'owner-abandoned-create', bindingDigest: actual.bindingDigest, rowDigest: actual.rowDigest, reservationDigest: actual.reservationDigest, acknowledgedAt }
    })
  } finally { await store.close() }
}

/** Open the exclusive pair journal and restore conservative unknown outcomes before dispatch.
 * @param {object} pair - validated immutable pair configuration with trust pin.
 * @returns {Promise<object>} journal authority/operation API.
 */
export async function openFederationJournal(pair) {
  const binding = { role: pair.role, id: pair.id, peerId: pair.peerId, machineKey: pair.machineKey, pairingGeneration: pair.pairingGeneration, keyFingerprint: pair.keyFingerprint }
  const initial = { version: 2, binding, generation: 1, lastGrantRevision: null, grantDigest: null, grant: null, operations: {}, remoteOwnedSessions: {} }
  const store = await openJsonStore(path.join(pair.stateDir, 'federation.json'), initial)
  let chain = Promise.resolve()
  let authorityChain = Promise.resolve()
  let closed = false
  const serial = fn => {
    const operation = chain.then(() => { if (closed) fail('source-unavailable', 'pair journal is closed'); return fn() })
    chain = operation.catch(() => {})
    return operation
  }
  try {
    const state = store.get()
    if (state.version !== 2 || canonicalJson(state.binding) !== canonicalJson(binding) || !Number.isSafeInteger(state.generation) || state.generation < 1 || !state.operations || !state.remoteOwnedSessions || Object.keys(state.operations).length > MAX_OPERATIONS) fail('pairing-mismatch', 'journal trust binding or structure mismatch')
    await store.update(next => {
      for (const row of Object.values(next.operations)) {
        if (!row || !['intent', 'dispatched', 'unknown', 'committed', 'failed'].includes(row.state) || !requestId(row.requestId) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)) fail('invalid-message', 'operation journal is corrupt')
        if (row.state === 'intent' || row.state === 'dispatched') row.state = 'unknown'
      }
    })
  } catch (error) { await store.close(); throw error }

  const api = {
    binding: Object.freeze(binding),
    snapshot: () => store.get(),
    observeAuthority: authority => {
      const operation = authorityChain.then(async () => {
      if (closed) fail('source-unavailable', 'pair journal is closed')
      if (!authority || !Number.isSafeInteger(authority.generation) || authority.generation < 1 || !(authority.grantRevision === null || (Number.isSafeInteger(authority.grantRevision) && authority.grantRevision > 0))) fail('invalid-message', 'invalid authenticated authority')
      const prior = store.get().remoteAuthority
      if (prior && (authority.generation < prior.generation || (authority.generation === prior.generation && authority.grantRevision !== prior.grantRevision)
        || (authority.grantRevision !== null && prior.highestGrantRevision !== null && authority.grantRevision < prior.highestGrantRevision))) fail('grant-changed', 'authenticated authority moved backwards')
      if (authority.metadataAuthorized !== undefined && typeof authority.metadataAuthorized !== 'boolean') fail('invalid-message', 'invalid metadata authorization')
      if (authority.mutationsVerified !== undefined && typeof authority.mutationsVerified !== 'boolean') fail('invalid-message', 'invalid authenticated mutation support')
      await store.update(next => { next.remoteAuthority = { ...authority, ...(authority.metadataAuthorized === undefined && prior?.metadataAuthorized !== undefined ? { metadataAuthorized: prior.metadataAuthorized } : {}), highestGrantRevision: authority.grantRevision ?? prior?.highestGrantRevision ?? null } })
      return prior === undefined || authority.generation !== prior.generation || authority.grantRevision !== prior.grantRevision || (authority.metadataAuthorized !== undefined && authority.metadataAuthorized !== prior.metadataAuthorized)
      })
      authorityChain = operation.catch(() => {})
      return operation
    },
    /** Config reload is issuer input, not permission to roll durable authority backwards. */
    installGrant: candidate => serial(async () => {
      const grant = candidate === null || candidate === undefined ? null : json(parseGrant(candidate))
      if (grant && (grant.machineKey !== pair.machineKey || grant.principal.id !== pair.peerId)) fail('pairing-mismatch', 'grant does not name this authenticated pair')
      const before = store.get()
      const digest = grant === null ? null : hash(grant)
      if (grant && before.lastGrantRevision !== null && (grant.revision < before.lastGrantRevision || (grant.revision === before.lastGrantRevision && (digest !== before.grantDigest || before.grant === null)))) fail('grant-changed', 'grant revision must advance after modification or withdrawal')
      const unchanged = grant === null ? before.grant === null : before.grant !== null && digest === before.grantDigest
      if (unchanged) return before
      return store.update(next => {
        if (next.generation === Number.MAX_SAFE_INTEGER) fail('grant-changed', 'authority generation exhausted')
        next.generation++
        next.grant = grant
        if (grant) { next.lastGrantRevision = grant.revision; next.grantDigest = digest }
      })
    }),
    /** Persist intent/digest before the executor can mark dispatch; duplicate bodies never re-run. */
    execute: (operation, executor, reconcile) => serial(async () => {
      if (!requestId(operation.requestId) || !['session.create', 'session.prompt', 'session.cancel', 'model.select'].includes(operation.action) || operation.principal !== (pair.role === 'worker' ? pair.peerId : pair.id) || operation.machineKey !== pair.machineKey) fail('invalid-message', 'invalid authenticated mutation')
      const key = hash([operation.principal, operation.machineKey, operation.requestId])
      const digest = hash(operation)
      const existing = store.get().operations[key]
      if (existing) {
        if (Object.hasOwn(existing, 'ownerDisposition')) fail('outcome-unknown', 'this original operation was owner-abandoned; it is permanently non-replayable')
        if (existing.digest !== digest) fail('request-conflict', 'operation ID already names a different body or target')
        if (existing.state === 'committed') return json(existing.result)
        if (existing.state === 'failed') fail(existing.code, 'operation was rejected before native dispatch')
        if (pair.role === 'controller' && typeof reconcile === 'function') {
          try {
            const result = json(await reconcile())
            await store.update(next => { next.operations[key].state = 'committed'; next.operations[key].result = result })
            return result
          } catch (_error) {
            // A later refusal or lost receipt cannot disprove the original effect.
            fail('outcome-unknown', 'operation outcome is still unknown; reconcile this exact ID')
          }
        }
        fail('outcome-unknown', 'operation outcome is unknown; reconcile this exact ID')
      }
      const current = store.get()
      if (Object.values(current.operations).some(row => ['intent', 'dispatched', 'unknown'].includes(row.state) && canonicalJson(row.target) === canonicalJson(operation.target) && !(operation.action === 'session.create' && row.requestId !== operation.requestId && ownerAbandonedCreate(current, row)))) fail('outcome-unknown', 'target has an unresolved operation; exact-ID reconciliation is required')
      if (Object.keys(store.get().operations).length >= MAX_OPERATIONS) fail('action-unsupported', 'operation journal is full; explicit archival is required')
      const nativeRequestId = `frpc_${hash([binding.machineKey, binding.id, binding.peerId, binding.pairingGeneration, binding.keyFingerprint, operation.requestId, operation.target, digest])}`
      const row = { requestId: operation.requestId, nativeRequestId, principal: operation.principal, machineKey: operation.machineKey, action: operation.action, target: operation.target, digest, state: 'intent', ...(operation.action === 'session.create' ? { reservedSessionId: `session-${randomUUID()}` } : {}), ...(operation.guard === undefined ? {} : { guard: json(operation.guard) }) }
      await store.update(next => { next.operations[key] = row })
      let dispatched = false
      const context = {
        reservedSessionId: row.reservedSessionId,
        nativeRequestId: row.nativeRequestId,
        dispatch: async () => { await store.update(next => { next.operations[key].state = 'dispatched' }); dispatched = true },
        recordNativeCreation: async proof => {
          if (pair.role !== 'worker' || row.action !== 'session.create' || proof.sessionId !== row.reservedSessionId || !Number.isSafeInteger(proof.createdAt) || proof.createdAt < 0) fail('outcome-unknown', 'native creation proof does not match the reserved intent')
          await store.update(next => { next.operations[key].nativeCreatedProof = json(proof) })
        },
      }
      try {
        const committed = json(await executor(context))
        await store.update(next => {
          next.operations[key].state = 'committed'; next.operations[key].result = committed
          if (row.action === 'session.create' && pair.role === 'worker') {
            if (next.generation === Number.MAX_SAFE_INTEGER) fail('grant-changed', 'authority generation exhausted')
            next.generation++
            if (committed.sessionId !== row.reservedSessionId) fail('outcome-unknown', 'native create returned a replacement ID')
            next.remoteOwnedSessions[row.reservedSessionId] = { principal: { kind: 'controller', id: pair.peerId }, machineKey: pair.machineKey, projectId: operation.target.projectId, sessionId: row.reservedSessionId, createRequestId: row.requestId, state: 'committed' }
          }
        })
        return committed
      } catch (error) {
        const unknown = (dispatched && error?.remoteRefusal !== true) || error?.code === 'outcome-unknown'
        const safe = ['selection-conflict', 'action-unsupported', 'source-unavailable', 'grant-changed', 'not-granted', 'invalid-message'].includes(error?.code) ? error.code : 'action-unsupported'
        try { await store.update(next => { next.operations[key].state = unknown ? 'unknown' : 'failed'; next.operations[key].code = unknown ? 'outcome-unknown' : safe }) }
        catch (persistError) {
          if (unknown) fail('outcome-unknown', 'operation outcome could not be recorded; reconcile this exact ID')
          throw persistError
        }
        fail(unknown ? 'outcome-unknown' : safe, unknown ? 'operation outcome is unknown; reconcile this exact ID' : 'native operation was not dispatched')
      }
    }),
    /** Read one exact Controller project: unresolved first, otherwise latest committed native result; never dispatches. */
    getCreateState: target => {
      if (closed) fail('source-unavailable', 'pair journal is closed')
      if (pair.role !== 'controller' || target.machineKey !== pair.machineKey) fail('source-unavailable', 'create state is unavailable')
      const state = store.get()
      const rows = Object.values(state.operations).filter(entry => entry.action === 'session.create' && entry.principal === pair.id && entry.machineKey === pair.machineKey && canonicalJson(entry.target) === canonicalJson(target))
      const abandoned = rows.findLast(row => ownerAbandonedCreate(state, row))
      const notice = abandoned ? { previousUnknownCreate: { requestId: abandoned.requestId, disposition: 'owner-abandoned' } } : {}
      const unresolved = rows.find(row => ['intent', 'dispatched', 'unknown'].includes(row.state) && !ownerAbandonedCreate(state, row))
      if (unresolved) return { state: unresolved.state === 'unknown' ? 'unknown' : 'pending', requestId: unresolved.requestId, ...notice }
      const committed = rows.findLast(row => row.state === 'committed')
      if (!committed) return { state: 'idle', ...notice }
      let ref
      try { ref = parseSessionRef(committed.result) } catch (error) { fail('outcome-unknown', 'committed create reference requires explicit reconciliation') }
      if (ref.machineKey !== target.machineKey || ref.projectId !== target.projectId) fail('outcome-unknown', 'committed create reference does not match its project')
      return { state: 'committed', requestId: committed.requestId, ref, ...notice }
    },
    /** Return only journal-backed guard records; caller restores on agent/created before work. */
    guardsFor: sessionId => Object.values(store.get().operations).filter(row => row.action === 'session.prompt' && row.target.sessionId === sessionId && row.guard && !row.guardCaptured && ['intent', 'dispatched', 'unknown', 'committed'].includes(row.state)).map(row => ({ requestId: row.requestId, nativeRequestId: row.nativeRequestId, expected: row.guard.selection, projectId: row.target.projectId })),
    confirmGuardEvidence: (sessionId, requestId) => store.update(next => {
      const row = Object.values(next.operations).find(entry => entry.action === 'session.prompt' && entry.target.sessionId === sessionId && entry.requestId === requestId)
      if (!row) fail('outcome-unknown', 'native guard evidence has no journal correlation')
      row.guardCaptured = true
    }),
    close: async () => { await Promise.all([chain, authorityChain]); closed = true; await store.close() },
  }
  return Object.freeze(api)
}
