/** Pair-owned project registration receipts; native paths and Workspace ids never enter public receipts. */
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { openJsonStore } from '../store.mjs'
import { canonicalJson } from './journal.mjs'
import { FederationContractError, parseProjectRef } from './identity.mjs'
import { parseProjectGrantTemplate } from './grants.mjs'

const MAX_OPERATIONS = 2048, MAX_PROJECTS = 256, MAX_PATH_BYTES = 8192
const states = new Set(['intent', 'dispatched', 'unknown', 'committed', 'failed'])
const failures = new Set(['not-granted', 'grant-changed', 'action-unsupported', 'source-unavailable', 'page-too-large', 'invalid-message', 'request-conflict'])
const fail = (code, message) => { throw new FederationContractError(code, message) }
const copy = value => JSON.parse(canonicalJson(value))
const hash = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
const same = (left, right) => canonicalJson(left) === canonicalJson(right)
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value)
const projectId = value => typeof value === 'string' && /^fpr_[a-f0-9]{32}$/.test(value)
function shape(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) fail('invalid-message', 'Invalid project registration fields')
  canonicalJson(value)
}
function text(value, maximum = MAX_PATH_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || Buffer.byteLength(value) > maximum) fail('invalid-message', 'Invalid project registration text')
  return value
}
function authority(value) {
  shape(value, ['generation', 'grantRevision'])
  for (const number of Object.values(value)) if (!Number.isSafeInteger(number) || number < 1 || Object.is(number, -0)) fail('invalid-message', 'Invalid project registration authority')
  return copy(value)
}
function body(value) { shape(value, ['path']); return { path: text(value.path) } }
function nativeProof(value) {
  shape(value, ['workspaceId', 'canonicalPath', 'title'])
  return { workspaceId: text(value.workspaceId, 256), canonicalPath: text(value.canonicalPath), title: text(value.title) }
}
function receipt(value, machineKey) {
  shape(value, ['ref', 'title'])
  const ref = parseProjectRef(value.ref)
  if (ref.machineKey !== machineKey || !projectId(ref.projectId)) fail('pairing-mismatch', 'Project receipt is outside the paired machine')
  return { ref, title: text(value.title) }
}
function checkedRequest(value) {
  shape(value, ['requestId', 'body', 'authority'])
  if (!requestId(value.requestId)) fail('invalid-message', 'Invalid project registration request id')
  return { requestId: value.requestId, body: body(value.body), authority: authority(value.authority) }
}
function preparation(value) {
  shape(value, ['canonicalPath', 'projectGrant'], ['existingWorkspaceId'])
  return { canonicalPath: text(value.canonicalPath), projectGrant: parseProjectGrantTemplate(value.projectGrant),
    ...(value.existingWorkspaceId === undefined ? {} : { existingWorkspaceId: text(value.existingWorkspaceId, 256) }) }
}
function publicRow(row) {
  return row === undefined ? { state: 'absent' } : { state: row.state, requestId: row.requestId, digest: row.digest, authority: copy(row.authority),
    ...(row.result === undefined ? {} : { result: copy(row.result) }), ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }) }
}

/**
 * Open one exclusively locked, trust-bound project ledger without changing the session-mutation journal.
 * @param {object} pair - validated immutable Worker or Controller pairing.
 * @returns {Promise<object>} registration identity, native proof, enrollment, and receipt operations.
 */
export async function openProjectJournal(pair) {
  const binding = { role: pair.role, id: pair.id, peerId: pair.peerId, machineKey: pair.machineKey, pairingGeneration: pair.pairingGeneration, keyFingerprint: pair.keyFingerprint }
  if (!['worker', 'controller'].includes(binding.role)) fail('pairing-mismatch', 'Invalid project journal role')
  const principal = { kind: 'controller', id: binding.role === 'worker' ? binding.peerId : binding.id }
  const keyOf = id => hash([principal.id, binding.machineKey, id])
  const bindingDigest = hash(binding)
  const initial = { version: 1, binding, operations: {}, projects: {} }
  const store = await openJsonStore(path.join(pair.stateDir, 'project-registration.v1.json'), initial)
  const rowOf = (state, id) => {
    if (!requestId(id)) fail('invalid-message', 'Invalid project registration request id')
    return state.operations[keyOf(id)]
  }
  const requireRow = (state, id) => {
    const row = rowOf(state, id)
    if (row === undefined) fail('outcome-unknown', 'Project registration identity is not retained')
    return row
  }
  function validate(state) {
    shape(state, ['version', 'binding', 'operations', 'projects'])
    if (state.version !== 1 || !same(state.binding, binding)) fail('pairing-mismatch', 'Project journal trust binding differs')
    shape(state.operations, [], Object.keys(state.operations)); shape(state.projects, [], Object.keys(state.projects))
    if (Object.keys(state.operations).length > MAX_OPERATIONS || Object.keys(state.projects).length > MAX_PROJECTS) fail('page-too-large', 'Project journal is full')
    const paths = new Set(), nativeIds = new Set()
    for (const [id, project] of Object.entries(state.projects)) {
      shape(project, ['projectId', 'canonicalPath', 'workspaceId', 'title', 'principal', 'machineKey', 'registerRequestId', 'projectGrant', 'bindingDigest'])
      if (binding.role !== 'worker' || id !== project.projectId || !projectId(id) || !same(project.principal, principal)
        || project.machineKey !== binding.machineKey || project.bindingDigest !== bindingDigest || !requestId(project.registerRequestId)) fail('pairing-mismatch', 'Project enrollment is outside its owner')
      nativeProof(projectProof(project)); parseProjectGrantTemplate(project.projectGrant)
      if (paths.has(project.canonicalPath) || nativeIds.has(project.workspaceId)) fail('invalid-message', 'Project journal repeats a native target')
      paths.add(project.canonicalPath); nativeIds.add(project.workspaceId)
    }
    let pending = 0
    for (const [key, row] of Object.entries(state.operations)) {
      shape(row, ['requestId', 'body', 'authority', 'digest', 'state'], ['canonicalPath', 'projectGrant', 'existingWorkspaceId', 'reservedProjectId', 'reuse', 'nativeProof', 'result', 'errorCode'])
      const request = checkedRequest({ requestId: row.requestId, body: row.body, authority: row.authority })
      if (key !== keyOf(row.requestId) || row.digest !== hash({ body: request.body, authority: request.authority }) || !states.has(row.state)) fail('invalid-message', 'Project registration identity is corrupt')
      if (['intent', 'dispatched', 'unknown'].includes(row.state)) pending++
      if (row.state === 'failed' ? !Object.hasOwn(row, 'errorCode') || !failures.has(row.errorCode) : Object.hasOwn(row, 'errorCode')) fail('invalid-message', 'Project registration failure is corrupt')
      if (binding.role === 'worker') {
        preparation({ canonicalPath: row.canonicalPath, projectGrant: row.projectGrant, ...(row.existingWorkspaceId === undefined ? {} : { existingWorkspaceId: row.existingWorkspaceId }) })
        if (!projectId(row.reservedProjectId) || typeof row.reuse !== 'boolean') fail('invalid-message', 'Project reservation is corrupt')
        if (row.nativeProof !== undefined && (!['dispatched', 'unknown', 'committed'].includes(row.state)
          || nativeProof(row.nativeProof).canonicalPath !== row.canonicalPath
          || (row.existingWorkspaceId !== undefined && row.nativeProof.workspaceId !== row.existingWorkspaceId))) fail('invalid-message', 'Native project proof has another target')
      } else if (['canonicalPath', 'projectGrant', 'existingWorkspaceId', 'reservedProjectId', 'reuse', 'nativeProof'].some(field => Object.hasOwn(row, field))) fail('invalid-message', 'Controller project journal contains native ownership')
      if (row.state === 'committed') {
        const result = receipt(row.result, binding.machineKey)
        if (binding.role === 'worker') {
          const project = state.projects[result.ref.projectId]
          if (!row.nativeProof || !project || result.ref.projectId !== row.reservedProjectId || !same(projectProof(project), row.nativeProof)
            || !same(project.projectGrant, row.projectGrant) || (!row.reuse && project.registerRequestId !== row.requestId)) fail('invalid-message', 'Committed project has no exact enrollment proof')
        }
      } else if (row.result !== undefined) fail('invalid-message', 'Uncommitted project contains a receipt')
    }
    if (pending > 1) fail('invalid-message', 'Project journal contains overlapping unsettled registrations')
    for (const project of Object.values(state.projects)) {
      const source = rowOf(state, project.registerRequestId)
      if (source?.state !== 'committed' || source.reservedProjectId !== project.projectId || source.reuse !== false) fail('invalid-message', 'Project enrollment has no original committed request')
    }
  }
  try {
    validate(store.get())
    await store.update(state => {
      for (const row of Object.values(state.operations)) if (row.state === 'dispatched') row.state = 'unknown'
    })
  } catch (error) { await store.close(); throw error }
  const update = async operation => {
    let result
    await store.update(state => { result = operation(state); validate(state) })
    return copy(result)
  }
  const api = {
    snapshot: () => store.get(),
    row: id => { const row = rowOf(store.get(), id); return row === undefined ? undefined : copy(row) },
    state: id => publicRow(rowOf(store.get(), id)),
    /** Retain the exact raw request and, on Worker only, its native canonical preparation before dispatch. */
    reserve: async (raw, prepared) => {
      const request = checkedRequest(raw), digest = hash({ body: request.body, authority: request.authority })
      return update(state => {
        const existing = rowOf(state, request.requestId)
        if (existing !== undefined) {
          if (existing.digest !== digest) fail('request-conflict', 'Project registration request identity changed')
          return existing
        }
        if (Object.values(state.operations).some(row => ['intent', 'dispatched', 'unknown'].includes(row.state))) fail('outcome-unknown', 'An earlier project registration is unsettled')
        if (Object.keys(state.operations).length >= MAX_OPERATIONS) fail('page-too-large', 'Project request history is full')
        const row = { ...request, digest, state: 'intent' }
        if (binding.role === 'worker') {
          const plan = preparation(prepared)
          const previous = Object.values(state.projects).find(project => project.canonicalPath === plan.canonicalPath)
          if ((previous && previous.workspaceId !== plan.existingWorkspaceId)
            || Object.values(state.projects).some(project => project.workspaceId === plan.existingWorkspaceId && project.canonicalPath !== plan.canonicalPath)) fail('source-unavailable', 'Registered native project identity changed')
          if (!previous && Object.keys(state.projects).length >= MAX_PROJECTS) fail('page-too-large', 'Project enrollment history is full')
          Object.assign(row, plan, { reservedProjectId: previous?.projectId ?? `fpr_${randomUUID().replaceAll('-', '')}`, reuse: previous !== undefined,
            projectGrant: previous?.projectGrant ?? plan.projectGrant })
        } else if (prepared !== undefined) fail('invalid-message', 'Controller cannot provide native project preparation')
        state.operations[keyOf(request.requestId)] = row
        return row
      })
    },
    /** Persist the admission to native dispatch; restart cannot silently retry this operation. */
    markDispatched: id => update(state => {
      const row = requireRow(state, id)
      if (row.state !== 'intent') fail('outcome-unknown', 'Project registration cannot be dispatched again')
      row.state = 'dispatched'; return row
    }),
    /** Preserve an uncertain native result rather than infer attribution from a matching directory. */
    markUnknown: id => update(state => {
      const row = requireRow(state, id)
      if (!['dispatched', 'unknown'].includes(row.state)) fail('outcome-unknown', 'Project registration has no uncertain dispatch')
      row.state = 'unknown'; return row
    }),
    /** A definite refusal is permitted only before dispatch and never overwrites a native proof. */
    failBeforeDispatch: (id, code) => update(state => {
      const row = requireRow(state, id)
      if (row.state !== 'intent' || !failures.has(code)) fail('outcome-unknown', 'Project dispatch cannot be declared uneffected')
      row.state = 'failed'; row.errorCode = code; return row
    }),
    /** Save only a genuine native return before making its enrollment/receipt atomic. */
    recordNativeProof: async (id, value) => {
      const proof = nativeProof(value)
      return update(state => {
        const row = requireRow(state, id)
        if (binding.role !== 'worker' || row.state !== 'dispatched' || proof.canonicalPath !== row.canonicalPath
          || (row.nativeProof !== undefined && !same(row.nativeProof, proof))) fail('outcome-unknown', 'Native project return does not prove the dispatched target')
        if ((row.existingWorkspaceId !== undefined && row.existingWorkspaceId !== proof.workspaceId)
          || (row.reuse && state.projects[row.reservedProjectId]?.workspaceId !== proof.workspaceId)
          || Object.values(state.projects).some(project => project.workspaceId === proof.workspaceId && project.canonicalPath !== proof.canonicalPath)) fail('outcome-unknown', 'Native project identity cannot be replaced')
        row.nativeProof = proof; return row
      })
    },
    /** Atomically publish a Worker enrollment and its receipt; unknown rows require an already retained exact native proof. */
    commitWorker: id => update(state => {
      const row = requireRow(state, id)
      if (binding.role !== 'worker') fail('pairing-mismatch', 'Controller cannot enroll a native workspace')
      if (row.state === 'committed') return row
      if (!['dispatched', 'unknown'].includes(row.state) || row.nativeProof === undefined) fail('outcome-unknown', 'Project registration has no retained native proof')
      const proof = nativeProof(row.nativeProof), previous = state.projects[row.reservedProjectId]
      if (previous && (!row.reuse || !same(projectProof(previous), proof) || !same(previous.projectGrant, row.projectGrant))) fail('outcome-unknown', 'Project enrollment cannot be retargeted')
      state.projects[row.reservedProjectId] = previous ?? { projectId: row.reservedProjectId, ...proof, principal, machineKey: binding.machineKey,
        registerRequestId: row.requestId, projectGrant: row.projectGrant, bindingDigest }
      row.result = { ref: { machineKey: binding.machineKey, projectId: row.reservedProjectId }, title: proof.title }
      row.state = 'committed'; return row
    }),
    /** Keep the authenticated Worker receipt on Controller; this never enrolls a native or imported session. */
    commitController: async (id, value) => {
      const result = receipt(value, binding.machineKey)
      return update(state => {
        const row = requireRow(state, id)
        if (binding.role !== 'controller' || !['dispatched', 'unknown', 'committed'].includes(row.state)
          || (row.result !== undefined && !same(row.result, result))) fail('outcome-unknown', 'Project receipt does not settle this Controller request')
        row.result = result; row.state = 'committed'; return row
      })
    },
    /** Policy-only committed ownership, intentionally without native ids or paths. */
    ownedProjects: () => Object.values(store.get().projects).map(project => ({ state: 'committed', principal: copy(project.principal), machineKey: project.machineKey,
      projectId: project.projectId, registerRequestId: project.registerRequestId, projectGrant: copy(project.projectGrant) })),
    /** Worker-only bindings for native resolution; callers must separately enforce current grant admission. */
    nativeBindings: () => Object.values(store.get().projects).map(project => ({ projectId: project.projectId, ...projectProof(project) })),
    close: () => store.close(),
  }
  return Object.freeze(api)
}
function projectProof(project) { return { workspaceId: project.workspaceId, canonicalPath: project.canonicalPath, title: project.title } }
