/** Real per-pair v2 relay runtime. No native Agent gateway, local mirror or chat-scoped authority reuse. */
import { randomUUID } from 'node:crypto'
import { mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import { openProjectJournal } from './project-journal.mjs'
import { createProjectRegistrar } from './project-registration.mjs'
import { createFileTransfers, SOURCE_FILE_CHUNK_BYTES } from './file-transfer.mjs'
import { sourceFileRequest, sourceUploadValue, sourcePromptUploads } from './file-codec.mjs'
import { openEndpoint } from '../endpoint.mjs'
import { openLiveChannel } from '../live-channel.mjs'
import { createLiveStreams } from './live-stream.mjs'
import { projectNativeFollow } from './native-follow-history.mjs'
import { canonicalJson, openFederationJournal } from './journal.mjs'
import { FederationContractError, parseSessionRef, parseProjectRef } from './identity.mjs'
import { evaluateGrant, effectiveProjectEntries, effectiveSessionEntries, grantAllows, grantStatus, sessionAdmissionAllowed } from './grants.mjs'
import { buildSourceCatalog, projectModelCatalog, projectModelCatalogPage } from './catalog.mjs'
import { buildHistoryPage, createHistorySnapshotFrame, createHistoryRecordsFrame } from './history.mjs'
import { projectNativeMetrics } from './metrics.mjs'
import { createRequest, createResponse, createFailureResponse, parseProtocolMessage, PROTOCOL_LIMITS, FAILURE_CODES, FEDERATION_FEATURES, NATIVE_HISTORY_FORMATS, createCapabilities, decodeExportCursor, jsonByteLength } from './protocol.mjs'

const fail = (code, message) => { throw new FederationContractError(code, message) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const safeInt = n => Number.isSafeInteger(n) && n >= 0 && !Object.is(n, -0)
const MUTATIONS = new Set(['session.create', 'session.prompt', 'session.cancel', 'model.select', 'project.register'])
const RESPONSE_BUDGET = PROTOCOL_LIMITS.maxFrameBytes - 2048
const codes = new Set(Object.values(FAILURE_CODES))
function exact(value, required, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('invalid-message', 'invalid operation fields')
}
function checkAbort(signal) { signal?.throwIfAborted() }
function selection(value) {
  exact(value, ['provider', 'model'], ['reasoningEffort'])
  if (['provider', 'model', ...(value.reasoningEffort === undefined ? [] : ['reasoningEffort'])].some(key => typeof value[key] !== 'string' || !value[key] || value[key].length > 256)) fail('invalid-message', 'invalid Worker model route')
  return value
}
function stamp(value) {
  exact(value, ['generation', 'frontierSeq', 'selection'])
  if (!safeInt(value.generation) || !Number.isSafeInteger(value.frontierSeq) || value.frontierSeq < -1) fail('invalid-message', 'invalid durable model stamp')
  if (value.selection !== null) selection(value.selection)
  return value
}

/** Open all authority journals before any endpoint may receive a command.
 * @param {object} settings - validated explicit v2 configuration.
 * @param {{backend?:object,onError?:(code:string)=>void,endpointFactory?:Function}} options - Worker-owned native boundary or test relay seam.
 * @returns {Promise<object>} actual pair runtimes and source notification/request API.
 */
export async function openFederationRuntime(settings, { backend, onError = () => {}, endpointFactory = openEndpoint } = {}) {
  const lifetime = new AbortController()
  const peers = new Map()
  let closed = false, closing
  const active = () => { if (closed) fail('source-unavailable', 'source runtime is closed') }
  try {
    for (const pair of settings.pairs) {
      await mkdir(pair.stateDir, { recursive: true, mode: 0o700 })
      if (await realpath(pair.stateDir) !== pair.stateDir) fail('pairing-mismatch', 'state directory changed canonical identity')
      const nativeJournal = await openFederationJournal(pair)
      const journal = Object.freeze({ ...nativeJournal, async installGrant(value) {
        const changed = await nativeJournal.installGrant(value), peer = peers.get(pair.machineKey)
        if (peer) peer.fileTransfers?.retire(authority(peer))
        return changed
      } })
      const peer = { pair, journal, endpoint: null, pending: new Map(), listeners: new Set(), revision: 0, notification: null, dirty: false, mutationsVerified: false, projectAdmissions: new Map(), liveChannel: null, liveStreams: null, projectJournal: null, projectOpening: null, projectRegistrar: null, projectRequestId: null, projectRegistrationSupported: false, fileTransfers: null }
      peers.set(pair.machineKey, peer)
      if (settings.role === 'worker') {
        await journal.installGrant(pair.grant)
        if (projectImplemented() && pair.grant?.version === 2) await ensureProjectJournal(peer)
        if (filesImplemented()) peer.fileTransfers = createFileTransfers({ timeoutMs: requestDeadline(peer),
          upload: async (ref, request, data, signal) => sourceUploadValue(await backend.files.upload(ref, request, data, signal)),
          attachment: (ref, file, signal) => backend.files.attachment(ref, file, signal),
          ...(imagesImplemented() ? { image: (ref, image, signal) => backend.files.image(ref, image, signal) } : {}),
          check: (ref, expected, direction) => filePolicy(peer, ref, expected, direction),
        })
      }
    }
    for (const peer of peers.values()) {
      peer.endpoint = await endpointFactory(peer.pair, {
        onMessage: async envelope => {
          try { await receive(peer, envelope) } catch (error) {
            if (['invalid-message', 'pairing-mismatch', 'page-too-large', 'grant-changed'].includes(error.code)) { onError(error.code); return }
            throw error
          }
        },
        onError: () => { onError('source-unavailable') },
      })
    }
  } catch (error) {
    for (const peer of peers.values()) { await peer.endpoint?.close(); await peer.projectJournal?.close(); await peer.journal.close() }
    throw error
  }

  function requestDeadline(peer) { return peer.pair.requestTimeoutMs ?? 15000 }
  function filesImplemented() { return ['upload', 'read', 'attachment'].every(key => typeof backend?.files?.[key] === 'function') }
  function imagesImplemented() { return typeof backend?.files?.image === 'function' && backend.files.imagesAvailable?.() === true }
  function filePolicy(peer, raw, expected, direction) {
    active(); checkAbort(lifetime.signal)
    const ref = nativeRef(peer, raw)
    checkAuthority(peer, expected)
    if (!filesImplemented() || !sessionClasses(peer, ref).includes('files')) fail('not-granted', 'source files are unavailable')
    if (direction === 'upload') { if (!ready()) fail('action-unsupported', 'source uploads are unavailable'); authorize(peer, 'session.prompt', ref) }
    else authorize(peer, 'session.read', ref, ['files'])
  }
  function fileCapabilities(peer, ref) {
    if (!filesImplemented()) return { files: false, attachments: false }
    const ctx = context(peer), classes = sessionClasses(peer, ref)
    if (!classes.includes('files')) return { files: false, attachments: false }
    const decide = (action, exportClasses) => grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey,
      projectId: ref.projectId, sessionId: ref.sessionId, action, ...(exportClasses === undefined ? {} : { exportClasses }) }, ctx.options)
    return { files: decide('session.read', ['files']), attachments: ready() && backend.files.canUpload?.(ref) === true && decide('session.prompt') }
  }
  function excludePrivateFile(canonical) {
    const key = value => process.platform === 'win32' ? value.toLowerCase() : value
    const contains = (a, b) => { const relative = path.relative(key(a), key(b)); return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) }
    if (settings.pairs.some(pair => contains(pair.stateDir, canonical) || contains(canonical, pair.stateDir))) fail('not-granted', 'source file is unavailable')
  }
  function projectImplemented() { return ['prepareProject', 'registerProject', 'setProjectBindings'].every(key => typeof backend?.[key] === 'function') }
  function hydrateProjects(peer) { backend?.setProjectBindings?.(peer.pair.machineKey, peer.projectJournal?.nativeBindings() ?? []) }
  async function ensureProjectJournal(peer) {
    if (peer.projectJournal) return peer.projectJournal
    if (!peer.projectOpening) peer.projectOpening = openProjectJournal(peer.pair).then(journal => {
      peer.projectJournal = journal
      const rows = Object.values(journal.snapshot().operations)
      peer.projectRequestId = rows.find(row => ['intent', 'dispatched', 'unknown'].includes(row.state))?.requestId ?? rows.at(-1)?.requestId ?? null
      if (settings.role === 'worker') {
        hydrateProjects(peer)
        peer.projectRegistrar = createProjectRegistrar({ journal, context: () => {
          const ctx = context(peer)
          return { principal: ctx.principal, machineKey: ctx.machineKey, generation: ctx.state.generation,
            grantRevision: ctx.grant.revision, grant: ctx.grant, now: ctx.options.now,
            remoteOwnedSessions: ctx.options.remoteOwnedSessions, remoteOwnedProjects: ctx.options.remoteOwnedProjects }
        }, native: { prepare: backend.prepareProject, register: backend.registerProject },
        checkCanonicalPath(canonical) {
          const key = value => process.platform === 'win32' ? value.toLowerCase() : value
          const contains = (a, b) => { const relative = path.relative(key(a), key(b)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }
          if (settings.pairs.some(pair => contains(pair.stateDir, canonical) || contains(canonical, pair.stateDir))) fail('source-unavailable', 'project directory is unavailable')
        }, onCommitted() { hydrateProjects(peer); void invalidate(peer, 'catalog') } })
      }
      return journal
    })
    return peer.projectOpening
  }
  function projectPermission(peer) {
    if (!projectImplemented() || !peer.projectRegistrar) return false
    try { const ctx = context(peer); return grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, action: 'project.register' }, ctx.options) }
    catch (error) { if (['not-granted', 'grant-changed'].includes(error.code)) return false; throw error }
  }
  function projectInventory(peer) {
    const rows = Object.entries(settings.projects).map(([projectId, project]) => ({ projectId, title: project.title ?? projectId }))
    const ids = new Set(rows.map(row => row.projectId))
    for (const entry of peer.projectJournal?.nativeBindings() ?? []) if (!ids.has(entry.projectId)) rows.push({ projectId: entry.projectId, title: entry.title })
    return rows
  }
  function authority(peer) {
    const state = peer.journal.snapshot()
    const current = { generation: state.generation, grantRevision: state.grant?.revision ?? null }
    peer.fileTransfers?.retire(current)
    return current
  }
  function responseAuthority(peer) { return { ...authority(peer), mutationsVerified: ready() } }
  function context(peer) {
    const state = peer.journal.snapshot()
    if (!state.grant) { peer.fileTransfers?.retire(null); fail('not-granted', 'source is unavailable') }
    const options = { currentRevision: state.lastGrantRevision, now: Date.now(), remoteOwnedSessions: Object.values(state.remoteOwnedSessions), remoteOwnedProjects: peer.projectJournal?.ownedProjects() ?? [] }
    if (grantStatus(state.grant, options).status !== 'active') { peer.fileTransfers?.retire(null); fail('grant-changed', 'source grant is inactive') }
    return { state, grant: state.grant, options, principal: { kind: 'controller', id: peer.pair.peerId }, machineKey: peer.pair.machineKey }
  }
  function authorize(peer, action, ref, classes) {
    const ctx = context(peer)
    const decision = evaluateGrant(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, projectId: ref.projectId,
      ...(action.startsWith('session.') && action !== 'session.create' || action === 'model.select' ? { sessionId: ref.sessionId } : {}),
      action, ...(classes === undefined ? {} : { exportClasses: classes }),
    }, ctx.options)
    if (!decision.allowed) fail(decision.code === 'grant/stale-revision' || decision.code === 'grant/expired' || decision.code === 'grant/revoked' ? 'grant-changed' : 'not-granted', 'source is unavailable')
    return ctx
  }
  function nativeRef(peer, raw, projectOnly = false) {
    const ref = projectOnly ? parseProjectRef(raw) : parseSessionRef(raw)
    if (ref.machineKey !== peer.pair.machineKey || (!Object.hasOwn(settings.projects, ref.projectId) && !peer.projectJournal?.nativeBindings().some(row => row.projectId === ref.projectId))) fail('source-unavailable', 'source is unavailable')
    return ref
  }
  function sessionClasses(peer, ref) {
    const ctx = context(peer)
    const entry = effectiveSessionEntries(ctx.grant, ref.projectId, ctx.options).find(row => row.sessionId === ref.sessionId)
    if (!entry || !sessionAdmissionAllowed(ctx.grant, ref, ctx.options)) fail('not-granted', 'source is unavailable')
    const project = effectiveProjectEntries(ctx.grant, ctx.options).find(row => row.projectId === ref.projectId)
    return entry.exportClasses ?? project.exportClasses
  }
  function ready() {
    return backend?.mutationReadiness?.durableJournal === 'verified' && backend?.mutationReadiness?.firstRouteCapture === 'verified'
  }
  function checkAuthority(peer, expected) {
    if (expected === undefined) return
    exact(expected, ['generation', 'grantRevision'])
    const current = authority(peer)
    if (expected.grantRevision !== null) context(peer)
    if (expected.generation !== current.generation || expected.grantRevision !== current.grantRevision) fail('grant-changed', 'source authority changed')
  }
  const historyRequest = (peer, ref, observation, request = {}) => {
    const ctx = context(peer)
    return { ...ref, generation: ctx.state.generation, grantRevision: ctx.grant.revision, principal: ctx.principal, grant: ctx.grant, now: ctx.options.now,
      remoteOwnedSessions: ctx.options.remoteOwnedSessions, remoteOwnedProjects: ctx.options.remoteOwnedProjects, events: observation.events, exportClasses: sessionClasses(peer, ref),
      validateNativeEvents: backend.validateNativeEvents, nativeAssistantBlocks: backend.nativeAssistantBlocks, ...(imagesImplemented() ? { nativeImages: true } : {}), maxBytes: RESPONSE_BUDGET, ...request }
  }
  const nativeLiveImplemented = () => ['readDetails', 'followNative', 'nativeExpand', 'nativeCreateCompactor', 'nativeLiveAssistantBlocks'].every(key => typeof backend?.[key] === 'function')
  function checkLive(peer, rawRef, expected) {
    active(); checkAbort(lifetime.signal)
    const ref = parseSessionRef(rawRef)
    if (ref.machineKey !== peer.pair.machineKey) fail('pairing-mismatch', 'live source names another machine')
    if (!peer.liveChannel?.status().running) fail('source-unavailable', 'live carrier is not available')
    if (settings.role === 'worker') {
      nativeRef(peer, ref); checkAuthority(peer, expected)
      const classes = sessionClasses(peer, ref)
      authorize(peer, 'session.read', ref, classes); authorize(peer, 'session.follow', ref, classes)
    } else {
      const observed = peer.journal.snapshot().remoteAuthority
      if (!observed || observed.metadataAuthorized === false || observed.generation !== expected.generation || observed.grantRevision !== expected.grantRevision) {
        fail('grant-changed', 'live binding authority changed')
      }
    }
  }
  function initializeLive(peer) {
    if (peer.liveChannel !== null) return
    peer.liveChannel = openLiveChannel({ ...peer.pair, role: settings.role }, {
      onMessage: body => { peer.liveStreams.receive(body) },
      onError: () => {
        peer.liveStreams?.failAll('source-unavailable')
        try { void Promise.resolve(onError('source-unavailable')).catch((_error) => { /* Diagnostics remain owned. */ }) }
        catch (_error) { /* Diagnostic failure never replaces source retirement. */ }
      },
    })
    peer.liveStreams = createLiveStreams({ role: settings.role, channel: peer.liveChannel,
      timeoutMs: peer.pair.requestTimeoutMs ?? 15000,
      check: (ref, expected) => { checkLive(peer, ref, expected) },
      ...(settings.role !== 'worker' ? {} : { open(spec, signal, wrapFrame) {
        checkLive(peer, spec.ref, spec.authority)
        if (!nativeLiveImplemented()) fail('action-unsupported', 'native live producer is unavailable')
        const cursor = spec.request.after === undefined ? undefined : decodeExportCursor(spec.request.after,
          { ...spec.ref, ...spec.authority, format: NATIVE_HISTORY_FORMATS.DETAILS })
        const scope = () => { checkAbort(signal); checkLive(peer, spec.ref, spec.authority) }
        const historyContext = () => {
          scope()
          const ctx = context(peer)
          return { generation: ctx.state.generation, grantRevision: ctx.grant.revision, principal: ctx.principal,
            grant: ctx.grant, now: ctx.options.now, remoteOwnedSessions: ctx.options.remoteOwnedSessions, remoteOwnedProjects: ctx.options.remoteOwnedProjects,
            exportClasses: sessionClasses(peer, spec.ref), ...(imagesImplemented() ? { nativeImages: true } : {}) }
        }
        return projectNativeFollow({ frames: backend.followNative(spec.ref, {}, signal), ref: spec.ref, backend,
          historyContext, check: scope, signal, wrapFrame: frame => {
            scope()
            if (frame.type === 'snapshot' && cursor && frame.page.throughSeq < cursor.throughSeq) fail('cursor-stale', 'native opening moved behind its durable cursor')
            return wrapFrame(frame)
          } })
      } }),
    })
  }
  async function ensureLive(peer, signal) {
    active(); checkAbort(signal)
    initializeLive(peer)
    const pending = peer.liveChannel.start()
    if (signal === undefined) { const ready = await pending; active(); return ready }
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (complete, value) => {
        if (settled) return
        settled = true; signal.removeEventListener('abort', abort); complete(value)
      }
      const abort = () => finish(reject, new FederationContractError('source-unavailable', 'live source read was cancelled'))
      signal.addEventListener('abort', abort, { once: true })
      pending.then(value => { if (closed) abort(); else finish(resolve, value) }, () => finish(reject, new FederationContractError('source-unavailable', 'live carrier is unavailable')))
      if (signal.aborted) abort()
    })
  }
  function requireCreateFollowup(ctx, ref) {
    const project = effectiveProjectEntries(ctx.grant, ctx.options).find(row => row.projectId === ref.projectId)
    const template = project?.createdSessionGrant
    if (!template || !['project.list', 'session.list'].every(action => project.actions.includes(action))
      || !['session.status', 'session.read', 'session.follow'].every(action => template.actions.includes(action))
      || !['conversation.user', 'conversation.assistant', 'turn'].every(type => template.exportClasses.includes(type))) fail('action-unsupported', 'ordinary create/open permissions are incomplete')
  }

  async function dispatch(peer, message, markNativeDispatch) {
    const { op, args, requestId } = message
    const valueBudget = PROTOCOL_LIMITS.maxFrameBytes - jsonByteLength(createResponse({ requestId, op, result: { authority: responseAuthority(peer), value: null } })) + 4
    if (op === 'hello') {
      exact(args, [])
      let visible = false
      try {
        const ctx = context(peer)
        visible = projectPermission(peer) || effectiveProjectEntries(ctx.grant, ctx.options).some(project => grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, projectId: project.projectId, action: 'project.list' }, ctx.options))
      } catch (error) { if (!['not-granted', 'grant-changed'].includes(error.code)) throw error }
      const liveAvailable = visible && nativeLiveImplemented() && await ensureLive(peer, lifetime.signal)
      return { protocol: 2, machine: visible ? { label: settings.label } : null,
        features: visible ? [
          ...(typeof backend?.modelCatalog === 'function' ? [FEDERATION_FEATURES.MODEL_CATALOG_PAGES] : []),
          ...(typeof backend?.readDetails === 'function' ? [FEDERATION_FEATURES.SESSION_DETAILS] : []),
          ...(liveAvailable ? [FEDERATION_FEATURES.SESSION_LIVE] : []),
          ...(projectPermission(peer) ? [FEDERATION_FEATURES.PROJECT_REGISTRATION] : []),
          ...(filesImplemented() ? [FEDERATION_FEATURES.SESSION_FILES] : []),
          ...(imagesImplemented() ? [FEDERATION_FEATURES.SESSION_IMAGES] : []),
        ] : [],
      }
    }
    if (!backend) fail('source-unavailable', 'native Worker boundary is unavailable')
    if (op === 'project.registration.state') {
      exact(args, [], ['requestId'])
      if (!peer.projectRegistrar) fail('action-unsupported', 'project registration is unavailable')
      const canRegister = projectPermission(peer), expected = authority(peer)
      if (!canRegister) return { canRegister: false, expected }
      const operation = args.requestId === undefined ? undefined : await peer.projectRegistrar.reconcile(args.requestId, lifetime.signal)
      checkAuthority(peer, expected); hydrateProjects(peer)
      return { canRegister: true, expected, ...(operation === undefined ? {} : { operation }) }
    }
    if (op === 'project.register') {
      exact(args, ['path', 'expectedAuthority'])
      if (!peer.projectRegistrar) fail('action-unsupported', 'project registration is unavailable')
      if (!projectPermission(peer)) fail('not-granted', 'project registration is unavailable')
      return peer.projectRegistrar.register({ requestId, body: { path: args.path }, authority: args.expectedAuthority }, lifetime.signal)
    }
    if (op === 'catalog') {
      exact(args, [], ['cursor'])
      const before = authority(peer), ctx = context(peer)
      const sessions = []
      for (const project of effectiveProjectEntries(ctx.grant, ctx.options)) {
        if (!grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, projectId: project.projectId, action: 'project.list' }, ctx.options)
          || !grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, projectId: project.projectId, action: 'session.list' }, ctx.options)) continue
        for (const entry of effectiveSessionEntries(ctx.grant, project.projectId, ctx.options)) {
          const ref = { machineKey: ctx.machineKey, projectId: project.projectId, sessionId: entry.sessionId }
          if (!sessionAdmissionAllowed(ctx.grant, ref, ctx.options)) continue
          let snapshot
          try { snapshot = await backend.read(ref, lifetime.signal) } catch (error) { if (error.code === 'source-unavailable') continue; throw error }
          sessions.push({ sessionId: entry.sessionId, projectId: project.projectId, updatedAt: Math.max(snapshot.header.createdAt, snapshot.events.at(-1)?.time ?? 0), running: snapshot.running, blank: !snapshot.events.some(event => event.type === 'user/message' || event.type === 'assistant/message') })
        }
      }
      checkAbort(lifetime.signal); checkAuthority(peer, before)
      const page = buildSourceCatalog({ machineKey: ctx.machineKey, generation: ctx.state.generation, grantRevision: ctx.grant.revision, principal: ctx.principal, grant: ctx.grant, now: ctx.options.now, remoteOwnedSessions: ctx.options.remoteOwnedSessions, remoteOwnedProjects: ctx.options.remoteOwnedProjects,
        projects: projectInventory(peer), sessions, ...(args.cursor === undefined ? {} : { cursor: args.cursor }), maxBytes: valueBudget })
      return { ...page, projects: page.projects.map(project => {
        let canCreate = false
        try { if (ready() && project.canCreate) { requireCreateFollowup(ctx, project.ref); canCreate = true } } catch (error) { if (error.code !== 'action-unsupported') throw error }
        return { ...project, canCreate }
      }), sessions: page.sessions.map(row => ({ ...row, capabilities: { ...row.capabilities, prompt: ready() && row.capabilities.prompt, cancel: ready() && row.capabilities.cancel, modelSelect: ready() && row.capabilities.modelSelect, create: false, ...fileCapabilities(peer, row.ref) } })) }
    }
    const allowedArgs = {
      'files.upload.start': ['request', 'expectedAuthority'], 'files.upload.chunk': ['request', 'expectedAuthority'],
      'files.upload.finish': ['request', 'expectedAuthority'], 'files.upload.cancel': ['request', 'expectedAuthority'],
      'files.read': ['request', 'expectedAuthority'], 'files.attachment': ['request', 'expectedAuthority'], 'files.image': ['request', 'expectedAuthority'],
      'session.bind': [], 'session.read': ['request', 'expectedAuthority'], 'session.follow': ['request', 'expectedAuthority'], 'session.status': ['expectedAuthority'],
      'session.bind.details': [], 'session.bind.live': [], 'session.read.details': ['request', 'expectedAuthority'], 'session.follow.details': ['request', 'expectedAuthority'],
      'model.catalog': ['expectedAuthority'], 'model.catalog.page': ['expectedAuthority', 'cursor'], 'model.state': ['expectedAuthority'], 'model.select': ['request', 'expectedAuthority'], 'session.create': ['expectedAuthority'], 'session.prompt': ['request', 'expectedAuthority'], 'session.cancel': ['expectedAuthority'],
    }
    if (!Object.hasOwn(allowedArgs, op)) fail('action-unsupported', 'operation is not supported')
    exact(args, ['ref'], allowedArgs[op])
    const ref = nativeRef(peer, args.ref, op === 'session.create')
    checkAuthority(peer, args.expectedAuthority)
    const before = authority(peer)
    const live = op === 'session.bind.live'
    const detailed = live || op.endsWith('.details')
    if (live && (!nativeLiveImplemented() || !await ensureLive(peer, lifetime.signal))) fail('action-unsupported', 'native live transport is unavailable')
    if (detailed && typeof backend.readDetails !== 'function') fail('action-unsupported', 'native session details are unavailable')
    const historyFormat = detailed ? NATIVE_HISTORY_FORMATS.DETAILS : NATIVE_HISTORY_FORMATS.LEGACY
    const readSnapshot = (ref, signal) => detailed ? backend.readDetails(ref, signal) : backend.read(ref, signal)
    if (op !== 'session.create') {
      const ctx = context(peer)
      if (!sessionAdmissionAllowed(ctx.grant, ref, ctx.options)) fail('source-unavailable', 'source is unavailable')
    }
    if (op.startsWith('files.')) {
      if (!peer.fileTransfers || !filesImplemented()) fail('action-unsupported', 'source files are unavailable')
      const method = op.slice('files.'.length), request = sourceFileRequest(method, args.request)
      const direction = method.startsWith('upload.') ? 'upload' : 'download'
      if (method !== 'upload.cancel') filePolicy(peer, ref, before, direction)
      if (method === 'upload.start') {
        if (request.kind === 'image' && !imagesImplemented()) fail('action-unsupported', 'native source images are unavailable')
        if (backend.files.canUpload?.(ref) !== true) fail('action-unsupported', 'source upload requires an already live Session')
        return peer.fileTransfers.start(ref, request, before)
      }
      if (method === 'upload.chunk') return peer.fileTransfers.chunk(ref, request, before)
      if (method === 'upload.finish') return peer.fileTransfers.finish(ref, request, before)
      if (method === 'upload.cancel') return peer.fileTransfers.cancel(ref, request, before)
      if (method === 'attachment') return peer.fileTransfers.attachment(ref, request, before)
      if (method === 'image') {
        if (!imagesImplemented()) fail('action-unsupported', 'native source images are unavailable')
        return peer.fileTransfers.image(ref, request, before)
      }
      const value = await backend.files.read(ref, request, lifetime.signal, excludePrivateFile)
      filePolicy(peer, ref, before, 'download')
      if (!(value.data instanceof Uint8Array) || value.data.byteLength > SOURCE_FILE_CHUNK_BYTES) fail('page-too-large', 'source file range exceeds its frame budget')
      return { absolutePath: value.absolutePath, version: value.version, ...(value.bytes === undefined ? {} : { bytes: value.bytes }),
        offset: value.offset, data: Buffer.from(value.data).toString('base64'), eof: value.eof }
    }
    if (op === 'session.bind' || op === 'session.bind.details' || live) {
      const classes = sessionClasses(peer, ref), ctx = context(peer)
      const decide = (action, exportClasses) => grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, projectId: ref.projectId, sessionId: ref.sessionId, action, ...(exportClasses ? { exportClasses } : {}) }, ctx.options)
      await readSnapshot(ref, lifetime.signal); checkAuthority(peer, before)
      const modelList = grantAllows(ctx.grant, { principal: ctx.principal, machineKey: ctx.machineKey, projectId: ref.projectId, action: 'model.list' }, ctx.options)
      const binary = fileCapabilities(peer, ref)
      return { ref, generation: ctx.state.generation, grantRevision: ctx.grant.revision, capabilities: createCapabilities({ history: classes.length > 0 && decide('session.read', classes) && decide('session.follow', classes), prompt: ready() && decide('session.prompt'), cancel: ready() && decide('session.cancel'), modelSelect: ready() && modelList && decide('model.select'), ...binary }), includeAssistantStream: live,
        ...(imagesImplemented() && (binary.files || binary.attachments) ? { nativeImages: true } : {}),
        ...(live ? { nativeDetails: true, nativeLive: true } : {}) }
    }
    if (op === 'session.status') {
      authorize(peer, 'session.status', ref)
      const snapshot = await backend.read(ref, lifetime.signal); checkAuthority(peer, before)
      return { running: snapshot.running }
    }
    if (op === 'model.catalog' || op === 'model.catalog.page') {
      const ctx = authorize(peer, 'model.list', ref)
      if (typeof backend.modelCatalog !== 'function') fail('action-unsupported', 'Worker model catalogs are not implemented')
      const modelCatalog = await backend.modelCatalog(lifetime.signal); checkAbort(lifetime.signal); checkAuthority(peer, before)
      const request = { modelCatalog, grant: ctx.grant, machineKey: ctx.machineKey, principal: ctx.principal, projectId: ref.projectId,
        grantRevision: ctx.grant.revision, now: Date.now(), remoteOwnedSessions: ctx.options.remoteOwnedSessions, remoteOwnedProjects: ctx.options.remoteOwnedProjects }
      return op === 'model.catalog'
        ? projectModelCatalog(request)
        : projectModelCatalogPage({ ...request, sessionId: ref.sessionId, generation: before.generation, maxBytes: valueBudget,
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }) })
    }
    if (op === 'model.state') {
      authorize(peer, 'session.status', ref); authorize(peer, 'model.list', ref)
      const state = await backend.modelState(ref, lifetime.signal); checkAuthority(peer, before)
      return { generation: before.generation, ...state }
    }
    if (['session.read', 'session.follow', 'session.read.details', 'session.follow.details'].includes(op)) {
      const readingPage = op === 'session.read' || op === 'session.read.details'
      const classes = sessionClasses(peer, ref)
      authorize(peer, 'session.read', ref, classes)
      if (!readingPage) authorize(peer, 'session.follow', ref, classes)
      const request = args.request ?? {}
      exact(request, [], readingPage ? ['beforeSeq', 'throughSeq', 'maxMessages'] : ['after', 'includeAssistantStream'])
      if (request.includeAssistantStream) fail('action-unsupported', 'live assistant transport is not implemented')
      const observation = await readSnapshot(ref, lifetime.signal)
      checkAbort(lifetime.signal); checkAuthority(peer, before)
      if (detailed && observation.cursor !== observation.events.length - 1) fail('invalid-message', 'native details do not match their observation cut')
      const history = request => historyRequest(peer, ref, observation, { ...request, format: historyFormat })
      const metrics = throughSeq => projectNativeMetrics({ baseline: observation.projections, throughSeq, exportClasses: classes }).projections
      if (readingPage) return buildHistoryPage(history({ ...request, maxBytes: valueBudget }))
      if (request.after === undefined) {
        const initial = buildHistoryPage(history({ maxBytes: valueBudget }))
        const emptyCut = { ...initial, records: [], coveredFromSeq: null, coveredThroughSeq: null, hasMore: false }
        const projections = detailed ? metrics(initial.throughSeq) : { asOfSeq: initial.throughSeq, values: {} }
        const metadata = createHistorySnapshotFrame({ page: emptyCut, header: observation.header, projections })
        const snapshotOverhead = jsonByteLength({ ...metadata, page: null }) - 4
        const page = buildHistoryPage(history({ maxBytes: valueBudget - snapshotOverhead }))
        return createHistorySnapshotFrame({ page, header: metadata.header, projections: metadata.projections })
      }
      const cursor = decodeExportCursor(request.after, { ...ref, ...before, format: historyFormat })
      if (cursor.beforeSeq !== cursor.throughSeq + 1 || cursor.throughSeq >= observation.events.length) fail('history-gap', 'native cursor no longer belongs to the observed cut')
      if (cursor.throughSeq === observation.events.length - 1) return { type: 'idle' }
      let end = Math.min(observation.events.length - 1, cursor.throughSeq + PROTOCOL_LIMITS.maxFollowBufferEvents)
      for (;;) {
        const page = buildHistoryPage(history({ throughSeq: end, fromSeq: cursor.throughSeq + 1, maxMessages: Number.MAX_SAFE_INTEGER }))
        const first = page.records[0]?.type === 'event' ? page.records[0].event.seq : page.records[0]?.firstSeq
        if (first === cursor.throughSeq + 1) {
          const frame = createHistoryRecordsFrame({ generation: page.generation, grantRevision: page.grantRevision, exportCursor: page.exportCursor, records: page.records,
            ...(detailed && end === observation.cursor ? { projections: metrics(end) } : {}) })
          if (jsonByteLength(frame) <= valueBudget) return frame
        }
        if (end <= cursor.throughSeq + 1) fail('page-too-large', 'one complete native follow record cannot fit')
        end--
      }
    }
    if (!MUTATIONS.has(op) || !ready()) fail('action-unsupported', 'native mutation readiness has not been verified')
    const request = args.request ?? {}
    if (op === 'session.create') requireCreateFollowup(authorize(peer, op, ref), ref)
    else if (op === 'model.select') { exact(request, ['expected', 'selection']); stamp(request.expected); selection(request.selection); authorize(peer, 'model.list', ref); authorize(peer, op, ref) }
    else if (op === 'session.prompt') {
      exact(request, ['text', 'expected'], ['uploads']); stamp(request.expected)
      const uploads = request.uploads === undefined ? [] : sourcePromptUploads(request.uploads)
      if (uploads.some(upload => upload.kind === 'image') && !imagesImplemented()) fail('action-unsupported', 'native source images are unavailable')
      if (typeof request.text !== 'string' || (!request.text.trim() && uploads.length === 0) || Buffer.byteLength(request.text) > 16000) fail('invalid-message', 'prompt requires text or staged files within its byte budget')
      authorize(peer, op, ref)
      if (uploads.length > 0) filePolicy(peer, ref, before, 'upload')
    } else authorize(peer, op, ref)
    const operation = { principal: peer.pair.peerId, machineKey: peer.pair.machineKey, requestId, action: op, target: ref, body: request, ...(op === 'session.prompt' ? { guard: request.expected } : {}) }
    const result = await peer.journal.execute(operation, async transaction => {
      const dispatchNative = async () => { await transaction.dispatch(); markNativeDispatch() }
      checkAuthority(peer, before)
      if (request.expected && request.expected.generation !== before.generation) fail('grant-changed', 'source generation changed')
      if (op === 'session.prompt' && request.uploads?.length) peer.fileTransfers.owned(ref, sourcePromptUploads(request.uploads), before)
      const recovery = {
        restore: agent => api.restoreAgent(agent),
        check: () => { checkAbort(lifetime.signal); checkAuthority(peer, before); authorize(peer, op === 'model.select' ? 'model.select' : op, ref); if (op === 'session.prompt' && request.uploads?.length) filePolicy(peer, ref, before, 'upload') },
        created: transaction.recordNativeCreation,
      }
      if (op === 'session.create') return backend.create({ ref, reservedSessionId: transaction.reservedSessionId }, dispatchNative, lifetime.signal, recovery)
      if (op === 'model.select') return { generation: before.generation, ...await backend.modelSelect(ref, { ...request, requestId: transaction.nativeRequestId }, dispatchNative, lifetime.signal, recovery) }
      if (op === 'session.prompt') return backend.prompt(ref, { ...request, requestId: transaction.nativeRequestId }, dispatchNative, lifetime.signal, recovery)
      return backend.cancel(ref, { requestId: transaction.nativeRequestId }, dispatchNative, lifetime.signal)
    })
    await invalidate(peer, op === 'session.create' ? 'authority' : 'catalog')
    return result
  }

  function notifyListeners(peer, reason) { if (reason === 'authority') peer.liveStreams?.failAll('grant-changed'); peer.revision++; for (const listener of [...peer.listeners]) { try { listener(reason) } catch (error) { onError('source-unavailable') } } }
  async function send(peer, body) {
    active(); checkAbort(lifetime.signal)
    if (jsonByteLength(body) > PROTOCOL_LIMITS.maxFrameBytes) fail('page-too-large', 'complete federation message exceeds its budget')
    return peer.endpoint.send('federation', body, { id: `fed_${randomUUID()}` })
  }
  async function invalidate(peer, reason) {
    if (closed || settings.role !== 'worker') return
    peer.dirty = true
    if (peer.notification) return
    const id = `notice_${randomUUID()}`
    peer.notification = id; peer.dirty = false
    try { await send(peer, { protocol: 2, type: 'notification', id, reason, authority: authority(peer) }) }
    catch (error) { peer.notification = null; peer.dirty = true; onError(error.code ?? 'source-unavailable') }
  }
  async function receive(peer, envelope) {
    active()
    if (envelope.from !== peer.pair.peerId || envelope.to !== peer.pair.id || envelope.kind !== 'federation') fail('pairing-mismatch', 'authenticated pair route mismatch')
    const body = envelope.body
    const rejectResponse = failure => {
      if (settings.role === 'controller' && record(body) && typeof body.requestId === 'string') peer.pending.get(body.requestId)?.reject(failure)
      throw failure
    }
    try { if (jsonByteLength(body) > PROTOCOL_LIMITS.maxFrameBytes) fail('page-too-large', 'incoming federation message exceeds budget') }
    catch (failure) { rejectResponse(failure) }
    if (body?.type === 'notification') {
      exact(body, ['protocol', 'type', 'id', 'reason', 'authority'])
      if (settings.role !== 'controller' || body.protocol !== 2 || !['catalog', 'authority'].includes(body.reason)) fail('invalid-message', 'invalid source notification')
      let changed
      try { changed = await peer.journal.observeAuthority(body.authority) } catch (error) {
        if (error.code !== 'grant-changed') throw error
        await send(peer, { protocol: 2, type: 'notification-ack', id: body.id }); return
      }
      if (changed) peer.projectAdmissions.clear()
      notifyListeners(peer, changed ? 'authority' : body.reason)
      await send(peer, { protocol: 2, type: 'notification-ack', id: body.id })
      return
    }
    if (body?.type === 'notification-ack') {
      exact(body, ['protocol', 'type', 'id'])
      if (settings.role !== 'worker' || body.protocol !== 2) fail('invalid-message', 'invalid notification acknowledgment')
      if (peer.notification === body.id) { peer.notification = null; if (peer.dirty) await invalidate(peer, 'catalog') }
      return
    }
    let message
    try { message = parseProtocolMessage(body) }
    catch (failure) { rejectResponse(failure) }
    if (settings.role === 'controller') {
      try {
        if (message.type !== 'response') fail('invalid-message', 'Controller accepts only correlated responses')
        const pending = peer.pending.get(message.requestId)
        if (!pending) return
        if (pending.op !== message.op) fail('invalid-message', 'operation response correlation mismatch')
        if (!message.ok) { const refusal = new FederationContractError(message.failure.code, 'remote source refused the operation'); refusal.remoteRefusal = true; pending.reject(refusal); return }
        exact(message.result, ['authority', 'value'])
        const admissions = []
        if (message.op === 'catalog' && Array.isArray(message.result.value?.projects)) {
          for (const project of message.result.value.projects) {
            const ref = parseProjectRef(project.ref)
            if (ref.machineKey !== peer.pair.machineKey) fail('pairing-mismatch', 'catalog project is outside paired machine')
            admissions.push(ref.projectId)
          }
        }
        if (message.op === 'hello') peer.projectRegistrationSupported = message.result.value?.features?.includes(FEDERATION_FEATURES.PROJECT_REGISTRATION) === true && message.result.value?.machine !== null
        const prior = peer.journal.snapshot().remoteAuthority
        const positiveMetadataLearned = message.op === 'hello' && message.result.value?.machine !== null
          && prior?.metadataAuthorized === undefined && prior?.generation === message.result.authority.generation
          && prior.grantRevision === message.result.authority.grantRevision
        const changed = await peer.journal.observeAuthority({ ...message.result.authority, ...(message.op === 'hello' ? { metadataAuthorized: message.result.value?.machine !== null } : {}) })
        const readinessChanged = peer.mutationsVerified !== (message.result.authority.mutationsVerified === true)
        peer.mutationsVerified = message.result.authority.mutationsVerified === true
        // First positive metadata proof preserves already authenticated numeric authority and project admissions.
        const authorityChanged = changed && !positiveMetadataLearned
        if (authorityChanged) peer.projectAdmissions.clear()
        for (const projectId of admissions) peer.projectAdmissions.set(projectId, { generation: message.result.authority.generation, grantRevision: message.result.authority.grantRevision })
        if (authorityChanged || readinessChanged) notifyListeners(peer, 'authority')
        else if (changed) notifyListeners(peer, 'catalog')
        pending.resolve(message.result.value)
        return
      } catch (failure) { rejectResponse(failure) }
    }
    if (message.type !== 'request') fail('invalid-message', 'Worker accepts only typed requests')
    let response, nativeDispatched = false, mutationReturned = false
    const mutation = MUTATIONS.has(message.op), startedAuthority = authority(peer)
    try {
      const value = await dispatch(peer, message, () => { nativeDispatched = true })
      mutationReturned = mutation
      checkAbort(lifetime.signal)
      if (message.op !== 'hello') {
        context(peer)
        const current = authority(peer)
        if (current.grantRevision !== startedAuthority.grantRevision || (message.op !== 'session.create' && current.generation !== startedAuthority.generation)) fail('grant-changed', 'source authority changed during operation')
      }
      response = createResponse({ requestId: message.requestId, op: message.op, result: { authority: responseAuthority(peer), value } })
    } catch (error) {
      // A failed receipt/envelope or later authority check cannot undo an effect.
      const code = mutation && (nativeDispatched || mutationReturned) ? 'outcome-unknown'
        : codes.has(error.code) ? error.code : error.code === 'request-conflict' ? 'invalid-message' : mutation ? 'outcome-unknown' : 'source-unavailable'
      response = createFailureResponse({ requestId: message.requestId, op: message.op, failure: { code } })
    }
    if (jsonByteLength(response) > PROTOCOL_LIMITS.maxFrameBytes) response = createFailureResponse({ requestId: message.requestId, op: message.op, failure: { code: mutation ? 'outcome-unknown' : 'page-too-large' } })
    await send(peer, response)
  }

  const api = {
    settings, peers,
    start() { active(); for (const peer of peers.values()) peer.endpoint.start() },
    subscribe(machineKey, listener) { active(); const peer = peers.get(machineKey); if (!peer) fail('source-unavailable', 'machine is not registered'); peer.listeners.add(listener); return () => peer.listeners.delete(listener) },
    revision(machineKey) { return peers.get(machineKey)?.revision ?? -1 },
    authority(machineKey) { const peer = peers.get(machineKey); return peer?.journal.snapshot().remoteAuthority ?? null },
    mutationReadiness: backend?.mutationReadiness,
    mutationsReady(machineKey) { return !closed && settings.role === 'controller' && peers.get(machineKey)?.mutationsVerified === true },
    async getProjectRegistrationState(machineKey, signal) {
      active(); checkAbort(signal)
      const peer = peers.get(machineKey)
      if (settings.role !== 'controller' || !peer) fail('source-unavailable', 'project registration is unavailable')
      const journal = await ensureProjectJournal(peer)
      active(); checkAbort(signal)
      let row = peer.projectRequestId === null ? undefined : journal.row(peer.projectRequestId)
      const observed = peer.journal.snapshot().remoteAuthority
      let expected = { generation: observed?.generation ?? 0, grantRevision: observed?.grantRevision ?? 0 }, canRegister = false
      if (peer.projectRegistrationSupported) {
        const value = await api.call(machineKey, 'project.registration.state', row ? { requestId: row.requestId } : {}, signal)
        exact(value, ['canRegister', 'expected'], ['operation']); exact(value.expected, ['generation', 'grantRevision'])
        if (typeof value.canRegister !== 'boolean' || ![value.expected.generation, value.expected.grantRevision].every(safeInt)) fail('invalid-message', 'invalid project state')
        expected = value.expected; canRegister = value.canRegister
        if (value.operation?.state === 'absent') exact(value.operation, ['state'])
        else if (value.operation !== undefined) {
          exact(value.operation, ['state', 'requestId', 'digest', 'authority'], ['result', 'errorCode'])
          if (!['intent', 'dispatched', 'unknown', 'committed', 'failed'].includes(value.operation.state)
            || !row || value.operation.requestId !== row.requestId || value.operation.digest !== row.digest || canonicalJson(value.operation.authority) !== canonicalJson(row.authority)) fail('invalid-message', 'project state correlation changed')
          if (value.operation.state === 'committed' && value.operation.result !== undefined) row = await journal.commitController(row.requestId, value.operation.result)
        }
      }
      active(); checkAbort(signal)
      const current = peer.journal.snapshot().remoteAuthority
      if (current && (current.generation !== expected.generation || (current.grantRevision ?? 0) !== expected.grantRevision)) fail('grant-changed', 'project authority changed')
      return { canRegister, expected, ...(row === undefined ? {} : { retained: { requestId: row.requestId, path: row.body.path,
        expected: row.authority, state: row.state, ...(row.result === undefined ? {} : { result: row.result.ref }) } }) }
    },
    getCreateState(machineKey, raw, signal) {
      active(); checkAbort(signal)
      const ref = parseProjectRef(raw), peer = peers.get(machineKey)
      if (settings.role !== 'controller' || !peer || ref.machineKey !== machineKey) fail('source-unavailable', 'create state is unavailable')
      const admitted = () => {
        const observed = peer.journal.snapshot().remoteAuthority, project = peer.projectAdmissions.get(ref.projectId)
        if (!observed || observed.grantRevision === null || observed.metadataAuthorized === false || !project || project.generation !== observed.generation || project.grantRevision !== observed.grantRevision) fail('grant-changed', 'current cached project admission is unavailable')
      }
      admitted()
      const result = peer.journal.getCreateState(ref)
      active(); checkAbort(signal); admitted()
      return result
    },
    liveReady(machineKey) {
      const peer = peers.get(machineKey)
      return !closed && peer?.liveChannel?.status().running === true && peer.liveChannel.status().supported === true
    },
    async prepareLive(machineKey, signal) {
      active(); checkAbort(signal)
      const peer = peers.get(machineKey)
      if (settings.role !== 'controller' || !peer) fail('source-unavailable', 'live machine is not registered')
      return ensureLive(peer, signal)
    },
    followLive(machineKey, rawRef, rawRequest, expectedAuthority, signal) {
      active(); checkAbort(signal)
      const ref = parseSessionRef(rawRef), peer = peers.get(machineKey)
      if (settings.role !== 'controller' || !peer || ref.machineKey !== machineKey) fail('source-unavailable', 'live source is not registered')
      const request = JSON.parse(canonicalJson(rawRequest)), expected = JSON.parse(canonicalJson(expectedAuthority))
      exact(request, ['includeAssistantStream'], ['after']); exact(expected, ['generation', 'grantRevision'])
      if (request.includeAssistantStream !== true || ![expected.generation, expected.grantRevision].every(value => Number.isSafeInteger(value) && value > 0)) fail('invalid-message', 'invalid live binding request')
      if (request.after !== undefined) decodeExportCursor(request.after, { ...ref, ...expected, format: NATIVE_HISTORY_FORMATS.DETAILS })
      const combined = AbortSignal.any([signal, lifetime.signal])
      return (async function* () {
        if (!await ensureLive(peer, combined)) fail('action-unsupported', 'live relay is unavailable')
        checkLive(peer, ref, expected)
        yield* peer.liveStreams.follow({ ref, authority: expected, request }, combined)
      })()
    },
    async call(machineKey, op, rawArgs, signal, id = `request_${randomUUID()}`) {
      active(); checkAbort(signal)
      if (settings.role !== 'controller') fail('action-unsupported', 'only Controller providers issue source requests')
      const peer = peers.get(machineKey)
      if (!peer) fail('source-unavailable', 'machine is not registered')
      // Snapshot and validate before a durable dispatch; the journal and wire
      // must retain the same body even if a caller mutates its input later.
      const outgoing = createRequest({ requestId: id, op, args: rawArgs }), args = outgoing.args
      const rpc = () => new Promise((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); peer.pending.delete(id) }
        const stop = timedOut => {
          cleanup()
          reject(MUTATIONS.has(op)
            ? new FederationContractError('outcome-unknown', 'source request stopped; no cancellation is implied')
            : timedOut ? new FederationContractError('request-timeout', 'source read deadline expired') : new DOMException('source read was cancelled', 'AbortError'))
        }
        const abort = () => stop(false)
        const timer = setTimeout(() => stop(true), requestDeadline(peer))
        peer.pending.set(id, { op, resolve: value => { cleanup(); resolve(value) }, reject: error => { cleanup(); reject(error) } })
        signal?.addEventListener('abort', abort, { once: true })
        void send(peer, outgoing).catch(error => { cleanup(); reject(error) })
      })
      if (op === 'project.register') {
        exact(args, ['path', 'expectedAuthority']); exact(args.expectedAuthority, ['generation', 'grantRevision'])
        const admitted = () => {
          active(); checkAbort(signal)
          const observed = peer.journal.snapshot().remoteAuthority
          if (!peer.projectRegistrationSupported) fail('action-unsupported', 'project registration is unavailable')
          if (!observed || observed.metadataAuthorized === false || observed.generation !== args.expectedAuthority.generation || observed.grantRevision !== args.expectedAuthority.grantRevision) fail('grant-changed', 'project authority changed')
        }
        admitted()
        const journal = await ensureProjectJournal(peer)
        admitted()
        let row = await journal.reserve({ requestId: id, body: { path: args.path }, authority: args.expectedAuthority }), dispatched = false
        peer.projectRequestId = id
        try {
          admitted()
          if (row.state === 'committed') return row.result
          if (row.state !== 'intent') fail('outcome-unknown', 'project request requires reconciliation')
          row = await journal.markDispatched(id); dispatched = true
          admitted()
          const value = await rpc()
          row = await journal.commitController(id, value)
          admitted()
          return row.result
        } catch (error) {
          if (dispatched) {
            if (journal.row(id)?.state !== 'committed') await journal.markUnknown(id)
            fail('outcome-unknown', 'project request requires reconciliation')
          }
          if (row.state === 'intent') await journal.failBeforeDispatch(id, codes.has(error.code) && error.code !== 'outcome-unknown' ? error.code : 'source-unavailable')
          throw error
        } finally { if (!closed) notifyListeners(peer, 'catalog') }
      }
      if (!MUTATIONS.has(op)) return rpc()
      const request = { principal: peer.pair.id, machineKey, requestId: id, action: op, target: args.ref, body: args.request ?? {} }
      try { return await peer.journal.execute(request, async transaction => { await transaction.dispatch(); return rpc() }, rpc) }
      finally { if (!closed) notifyListeners(peer, 'catalog') }
    },
    async committed(sessionId) {
      if (settings.role !== 'worker' || closed) return
      for (const peer of peers.values()) {
        try { const ctx = context(peer); if (effectiveProjectEntries(ctx.grant, ctx.options).some(project => sessionAdmissionAllowed(ctx.grant, { projectId: project.projectId, sessionId }, ctx.options))) await invalidate(peer, 'catalog') }
        catch (error) { if (!['not-granted', 'grant-changed'].includes(error.code)) onError('source-unavailable') }
      }
    },
    async restoreAgent(agent) {
      if (settings.role !== 'worker') return
      for (const peer of peers.values()) for (const guard of peer.journal.guardsFor(agent.id)) {
        if (typeof guard.nativeRequestId !== 'string') fail('outcome-unknown', 'legacy unscoped native correlation requires explicit reconciliation')
        if (backend.hasPromptEvidence?.(agent, guard.nativeRequestId, guard.expected)) { await peer.journal.confirmGuardEvidence(agent.id, guard.requestId); continue }
        authorize(peer, 'session.prompt', { machineKey: peer.pair.machineKey, projectId: guard.projectId, sessionId: agent.id })
        backend.restoreGuard(agent, guard.nativeRequestId, guard.expected, () => { checkAbort(lifetime.signal); authorize(peer, 'session.prompt', { machineKey: peer.pair.machineKey, projectId: guard.projectId, sessionId: agent.id }) })
      }
    },
    disposeAgent(agent) { backend?.disposeAgent?.(agent) },
    close() {
      if (closing !== undefined) return closing
      const completion = Promise.withResolvers()
      closing = completion.promise
      closed = true; lifetime.abort()
      for (const peer of peers.values()) {
        peer.liveStreams?.failAll('source-unavailable')
        for (const pending of [...peer.pending.values()]) pending.reject(new FederationContractError('source-unavailable', 'source provider was removed'))
        peer.listeners.clear()
      }
      void (async () => {
        const fileClosing = [...peers.values()].map(peer => peer.fileTransfers?.close())
        let nativeClosing
        try { nativeClosing = backend?.close?.() } catch (error) { nativeClosing = Promise.reject(error) }
        const outcomes = await Promise.allSettled([nativeClosing, ...fileClosing, ...[...peers.values()].flatMap(peer => [
          peer.endpoint.close(), peer.liveChannel?.close(), peer.liveStreams?.close(),
        ])])
        for (const peer of peers.values()) {
          if (peer.projectOpening) outcomes.push(...await Promise.allSettled([peer.projectOpening]))
          outcomes.push(...await Promise.allSettled([peer.projectJournal?.close(), peer.journal.close()]))
        }
        const failed = outcomes.find(outcome => outcome.status === 'rejected')
        if (failed) throw failed.reason
      })().then(completion.resolve, completion.reject)
      return closing
    },
  }
  return Object.freeze(api)
}
