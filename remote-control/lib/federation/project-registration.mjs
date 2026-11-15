/** Worker-private native project effects, retained proof, and authority-checked public receipts. */
import { isDeepStrictEqual } from 'node:util'
import { FederationContractError } from './identity.mjs'
import { evaluateGrant } from './grants.mjs'

const MESSAGE = 'project registration is unavailable'
const CODES = new Set(['not-granted', 'grant-changed', 'action-unsupported', 'source-unavailable', 'page-too-large', 'invalid-message', 'request-conflict', 'outcome-unknown'])
const error = code => new FederationContractError(code, MESSAGE)
const fail = (code = 'source-unavailable') => { throw error(code) }
const safeCode = value => value instanceof FederationContractError && CODES.has(value.code) ? value.code : 'source-unavailable'
const positive = value => Number.isSafeInteger(value) && value > 0
function authority(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2
    || !Object.hasOwn(value, 'generation') || !Object.hasOwn(value, 'grantRevision')
    || !positive(value.generation) || !positive(value.grantRevision)) fail('invalid-message')
  return value
}
function publicCopy(value) {
  const freeze = value => { if (value && typeof value === 'object') { for (const member of Object.values(value)) freeze(member); Object.freeze(value) } return value }
  return freeze(structuredClone(value))
}

/**
 * Bind one private Worker journal to current policy and creation-time verified native closures.
 * @param {import('./project-registration.mjs').ProjectRegistrarOptions} options - caller-owned native owner and journal.
 * @returns {import('./project-registration.mjs').ProjectRegistrar} effect orchestration and read-only recovery.
 */
export function createProjectRegistrar({ journal, context, native, checkCanonicalPath, onCommitted }) {
  if (!journal || typeof context !== 'function' || typeof native?.prepare !== 'function' || typeof native?.register !== 'function'
    || typeof checkCanonicalPath !== 'function' || (onCommitted !== undefined && typeof onCommitted !== 'function')) fail()
  let binding
  try { binding = journal.snapshot().binding } catch { fail() }
  const prepare = native.prepare, registerNative = native.register
  if (binding.role !== 'worker') fail()
  const current = (signal, pinned, expected, row) => {
    if (signal.aborted) fail()
    let value, decision
    try {
      value = context()
      if (!value || value.machineKey !== binding.machineKey || value.principal?.kind !== 'controller' || value.principal.id !== binding.peerId
        || !positive(value.generation) || !positive(value.grantRevision)) fail('grant-changed')
      decision = evaluateGrant(value.grant, { principal: value.principal, machineKey: value.machineKey, action: 'project.register' }, {
        currentRevision: value.grantRevision, now: value.now,
        ...(value.remoteOwnedSessions === undefined ? {} : { remoteOwnedSessions: value.remoteOwnedSessions }),
        ...(value.remoteOwnedProjects === undefined ? {} : { remoteOwnedProjects: value.remoteOwnedProjects }),
      })
    } catch (cause) { throw error(safeCode(cause)) }
    if (!decision.allowed) fail(['grant/stale-revision', 'grant/expired', 'grant/revoked', 'grant/principal-mismatch', 'grant/machine-mismatch'].includes(decision.code) ? 'grant-changed' : 'not-granted')
    const result = { principal: { kind: value.principal.kind, id: value.principal.id }, machineKey: value.machineKey,
      generation: value.generation, grantRevision: value.grantRevision, projectGrant: decision.projectGrant }
    if (pinned && !isDeepStrictEqual(pinned, result)) fail('grant-changed')
    if (expected) {
      authority(expected)
      if (expected.generation !== result.generation || expected.grantRevision !== result.grantRevision) fail('grant-changed')
    }
    // Reused enrollments intentionally retain an older, narrower project policy.
    if (row?.projectGrant && !row.reuse && !isDeepStrictEqual(row.projectGrant, result.projectGrant)) fail('grant-changed')
    return result
  }
  const pathAllowed = path => {
    if (typeof path !== 'string' || path.length === 0) fail()
    try { checkCanonicalPath(path) } catch { fail() }
  }
  const notify = () => {
    if (onCommitted === undefined) return
    const result = onCommitted()
    // The caller promises synchronous invalidation. Contain an accidental async rejection without waiting on unbounded work.
    if (result && (typeof result === 'object' || typeof result === 'function') && typeof result.then === 'function') {
      void Promise.resolve(result).catch((_error) => {})
      fail('outcome-unknown')
    }
  }
  const operation = async (caller, work) => {
    const controller = new AbortController(), abort = () => { controller.abort(error('source-unavailable')) }
    caller.addEventListener('abort', abort, { once: true }); if (caller.aborted) abort()
    try { return await work(controller.signal) }
    finally { caller.removeEventListener('abort', abort) }
  }
  const proofMatches = (row, proof) => proof?.canonicalPath === row.canonicalPath
    && (row.existingWorkspaceId === undefined || proof.workspaceId === row.existingWorkspaceId)
  const retained = row => {
    if (row?.state !== 'committed' || row.result === undefined) fail('outcome-unknown')
    return publicCopy(row.result)
  }
  const api = {
    async register(request, signal) {
      return operation(signal, async ownedSignal => {
        let row, pinned, matched = false, dispatched = false
        try {
          pinned = current(ownedSignal)
          request = publicCopy(request)
          const existing = journal.row(request?.requestId)
          let prepared
          if (existing) {
            // The ledger validates the immutable raw body/CAS before any alias can be resolved again.
            row = await journal.reserve(request)
            matched = true
            current(ownedSignal, pinned, request.authority, row)
          } else {
            authority(request.authority); current(ownedSignal, pinned, request.authority)
            prepared = await prepare({ path: request.body?.path }, ownedSignal)
            current(ownedSignal, pinned, request.authority)
            pathAllowed(prepared?.canonicalPath)
            row = await journal.reserve(request, { canonicalPath: prepared.canonicalPath, projectGrant: pinned.projectGrant,
              ...(prepared.existingWorkspaceId === undefined ? {} : { existingWorkspaceId: prepared.existingWorkspaceId }) })
            matched = true
            current(ownedSignal, pinned, request.authority, row)
          }
          if (row.state === 'committed') { current(ownedSignal, pinned, request.authority, row); return retained(row) }
          if (row.state === 'failed') fail(row.errorCode ?? 'source-unavailable')
          if (row.state !== 'intent') fail('outcome-unknown')
          pathAllowed(row.canonicalPath)
          if (existing || prepared?.canonicalPath !== row.canonicalPath || prepared?.existingWorkspaceId !== row.existingWorkspaceId) {
            const checked = await prepare({ path: row.canonicalPath }, ownedSignal)
            current(ownedSignal, pinned, request.authority, row)
            if (checked?.canonicalPath !== row.canonicalPath || (row.existingWorkspaceId !== undefined && checked.existingWorkspaceId !== row.existingWorkspaceId)) fail()
          }
          current(ownedSignal, pinned, request.authority, row)
          row = await journal.markDispatched(request.requestId)
          dispatched = true
          current(ownedSignal, pinned, request.authority, row)
          const proof = await registerNative({ canonicalPath: row.canonicalPath }, ownedSignal)
          if (!proofMatches(row, proof)) fail('outcome-unknown')
          // Persist genuine native return attribution even when authority/cancellation changed during the effect.
          row = await journal.recordNativeProof(request.requestId, proof)
          current(ownedSignal, pinned, request.authority, row)
          row = await journal.commitWorker(request.requestId)
          current(ownedSignal, pinned, request.authority, row)
          notify()
          current(ownedSignal, pinned, request.authority, row)
          return retained(row)
        } catch (cause) {
          let latest
          try { latest = matched ? journal.row(request.requestId) : undefined } catch { /* Failure reporting never exposes a borrowed journal diagnostic. */ }
          if (dispatched || (latest && ['dispatched', 'unknown', 'committed'].includes(latest.state))) {
            if (dispatched && latest?.state !== 'committed') {
              try { await journal.markUnknown(request.requestId) } catch { /* The persisted dispatch/proof still prevents native replay. */ }
            }
            throw error('outcome-unknown')
          }
          const code = safeCode(cause)
          if (matched && latest?.state === 'intent' && code !== 'request-conflict') {
            try { await journal.failBeforeDispatch(request.requestId, code === 'outcome-unknown' ? 'source-unavailable' : code) }
            catch { /* No native dispatch occurred; an unsettled intent remains conservative. */ }
          }
          throw error(code)
        }
      })
    },
    async reconcile(requestId, signal) {
      return operation(signal, async ownedSignal => {
        let row
        try {
          const pinned = current(ownedSignal)
          row = journal.row(requestId)
          if (row === undefined) { current(ownedSignal, pinned); return publicCopy(journal.state(requestId)) }
          current(ownedSignal, pinned, row.authority, row)
          if (row.state === 'unknown' && row.nativeProof !== undefined) {
            pathAllowed(row.canonicalPath)
            const checked = await prepare({ path: row.canonicalPath }, ownedSignal)
            current(ownedSignal, pinned, row.authority, row)
            if (checked?.canonicalPath !== row.canonicalPath || checked.existingWorkspaceId !== row.nativeProof.workspaceId) fail('outcome-unknown')
            row = await journal.commitWorker(requestId)
            current(ownedSignal, pinned, row.authority, row)
            notify()
          }
          current(ownedSignal, pinned, row.authority, row)
          return publicCopy(journal.state(requestId))
        } catch (cause) {
          if (row?.state === 'unknown' || row?.state === 'dispatched' || row?.state === 'committed') throw error('outcome-unknown')
          throw error(safeCode(cause))
        }
      })
    },
  }
  return Object.freeze(api)
}
