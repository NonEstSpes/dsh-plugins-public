/** Owner BFF provider for a real paired Worker; no Agent tool or native RPC forwarding. */
import { createWireCodec } from './wire-codec.mjs'
import { createModelCatalogAccumulator } from './catalog.mjs'
import { FederationContractError, parseProjectRef, parseSessionRef } from './identity.mjs'
import { FEDERATION_FEATURES, FEDERATION_PROTOCOL_VERSION, NATIVE_HISTORY_FORMATS, PROTOCOL_LIMITS, jsonByteLength, parseFeatureManifest } from './protocol.mjs'
import { parseHistoryReplyFrame, parseHistoryReplyPage, parseLiveHistoryReplyFrame } from './history-replies.mjs'
import { sourceDiagnostic } from './diagnostics.mjs'
import { sourceFileRequest, sourceUploadValue } from './file-codec.mjs'

/** Build a machine provider with one real registration-scoped wire codec.
 * @param {{runtime:object,pair:object,RemoteError?:Function}} options - authenticated Controller runtime and shared native error class.
 * @returns {Promise<object>} provider registered with sessionSourceController by the Host.
 */
export async function createHostProvider({ runtime, pair, RemoteError }) {
  const ErrorClass = RemoteError ?? (await import('@deepseek-ai/dsh-typert-protocol')).RemoteError
  const codec = createWireCodec({ machineKey: pair.machineKey })
  const verifiedMutations = Object.freeze({ durableJournal: 'verified', firstRouteCapture: 'verified' })
  const error = (original, stage) => {
    const diagnostic = sourceDiagnostic(original, stage)
    return new ErrorClass(diagnostic.endpointCode, diagnostic.message, {})
  }
  const call = async (op, args, signal, id) => {
    try { return await runtime.call(pair.machineKey, op, args, signal, id) } catch (failure) {
      if (op !== 'hello' && ['grant-changed', 'not-granted'].includes(failure?.code) && !signal?.aborted) {
        try { await runtime.call(pair.machineKey, 'hello', {}, signal) } catch (refreshError) { /* An uncertain refresh never removes locally authorized offline metadata. */ }
      }
      throw error(failure, op)
    }
  }
  let negotiation
  const negotiate = signal => {
    signal?.throwIfAborted()
    if (!negotiation) {
      const pending = call('hello', {}, undefined).then(value => {
        try {
          if (!value || value.protocol !== FEDERATION_PROTOCOL_VERSION || !Object.hasOwn(value, 'machine')) {
            throw new FederationContractError('invalid-message', 'invalid Worker hello')
          }
          return parseFeatureManifest(value.features)
        } catch (failure) { throw error(failure, 'hello') }
      })
      const shared = pending.finally(() => { if (negotiation === shared) negotiation = undefined })
      negotiation = shared
    }
    const shared = negotiation
    // Each reader owns its wait, not the other readers' authenticated hello.
    // Runtime teardown or its configured read deadline bounds an unobserved call.
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (complete, value) => {
        if (settled) return
        settled = true; signal?.removeEventListener('abort', abort); complete(value)
      }
      const abort = () => finish(reject, error(new DOMException('source read was cancelled', 'AbortError'), 'hello'))
      signal?.addEventListener('abort', abort, { once: true })
      shared.then(value => finish(resolve, value), failure => finish(reject, failure))
      if (signal?.aborted) abort()
    })
  }
  const authority = async signal => {
    if (runtime.authority(pair.machineKey) === null) await call('hello', {}, signal)
    const observed = runtime.authority(pair.machineKey)
    if (observed?.grantRevision === null || !observed) throw error({ code: 'source-unavailable' }, 'hello')
    return { generation: observed.generation, grantRevision: observed.grantRevision }
  }
  const boundCall = async (op, ref, request, signal, id) => call(op, { ref, expectedAuthority: await authority(signal), ...(request === undefined ? {} : { request }) }, signal, id)
  const wait = (revision, signal) => new Promise((resolve, reject) => {
    let dispose = () => {}
    const finish = () => { dispose(); signal.removeEventListener('abort', abort); resolve() }
    const abort = () => { dispose(); signal.removeEventListener('abort', abort); reject(error(new DOMException('source read was cancelled', 'AbortError'), 'session.follow')) }
    dispose = runtime.subscribe(pair.machineKey, finish)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    else if (runtime.revision(pair.machineKey) !== revision) finish()
  })
  const targetRef = ref => {
    const target = parseSessionRef(ref)
    if (target.machineKey !== pair.machineKey) throw new FederationContractError('source-unavailable', 'source reference belongs to another machine')
    return target
  }
  const bind = async (ref, signal, detailed = false, live = false) => {
    const op = live ? 'session.bind.live' : detailed ? 'session.bind.details' : 'session.bind'
    try {
      const target = targetRef(ref)
      const native = await call(op, { ref: target }, signal)
      if (!native?.ref || ['machineKey', 'projectId', 'sessionId'].some(key => native.ref[key] !== target[key])
        || (live ? native.includeAssistantStream !== true || native.nativeLive !== true || native.nativeDetails !== true
          : native.includeAssistantStream !== false || native.nativeLive !== undefined)) {
        throw new FederationContractError('invalid-message', 'Worker binding does not match its negotiated mode')
      }
      const value = codec.toWire('binding', native)
      const { ref: _checkedRef, ...info } = value
      return detailed ? { ...info, nativeDetails: true } : info
    } catch (failure) { throw error(failure, op) }
  }
  const liveBindings = new Map()
  const liveKey = ref => JSON.stringify([ref.machineKey, ref.projectId, ref.sessionId])
  const sameAuthority = (left, right) => left && right && right.metadataAuthorized !== false && left.generation === right.generation && left.grantRevision === right.grantRevision
  const bindLive = async (rawRef, signal) => {
    const ref = targetRef(rawRef), key = liveKey(ref), observed = runtime.authority(pair.machineKey)
    signal.throwIfAborted()
    for (const [cachedKey, value] of liveBindings) if (!sameAuthority(value.authority, observed)) liveBindings.delete(cachedKey)
    const cached = liveBindings.get(key)
    // BFF validation runs for every frame; only the first live handshake uses durable RPC.
    if (cached && sameAuthority(cached.authority, observed) && runtime.liveReady?.(pair.machineKey) === true) {
      liveBindings.delete(key); liveBindings.set(key, cached)
      return cached.info
    }
    liveBindings.delete(key)
    const features = await negotiate(signal)
    if (!features.includes(FEDERATION_FEATURES.SESSION_LIVE)) return bind(ref, signal, features.includes(FEDERATION_FEATURES.SESSION_DETAILS))
    if (!features.includes(FEDERATION_FEATURES.SESSION_DETAILS) || typeof runtime.prepareLive !== 'function' || !await runtime.prepareLive(pair.machineKey, signal)) {
      throw error({ code: 'action-unsupported' }, 'session.bind.live')
    }
    const info = await bind(ref, signal, true, true), current = runtime.authority(pair.machineKey)
    if (!current || current.metadataAuthorized === false || current.grantRevision === null || !runtime.liveReady(pair.machineKey)
      || info.generation !== codec.encodeGeneration(current.generation) || info.grantRevision !== codec.encodeGrantRevision(current.grantRevision)) {
      throw error({ code: 'grant-changed' }, 'session.bind.live')
    }
    // These are reusable metadata receipts, not replay guards; eviction forces a fresh bind without retiring an active reader.
    if (!liveBindings.has(key) && liveBindings.size >= PROTOCOL_LIMITS.maxFollowBufferEvents) liveBindings.delete(liveBindings.keys().next().value)
    liveBindings.set(key, Object.freeze({ authority: Object.freeze({ generation: current.generation, grantRevision: current.grantRevision }), info: Object.freeze(info) }))
    return info
  }
  const historyWire = (kind, value, ref, detailed, op) => {
    try {
      const format = detailed ? NATIVE_HISTORY_FORMATS.DETAILS : NATIVE_HISTORY_FORMATS.LEGACY
      const native = kind === 'history-page' ? parseHistoryReplyPage(value, ref, format) : parseHistoryReplyFrame(value, ref, format)
      const wire = codec.toWire(kind, native)
      if (jsonByteLength(wire) > PROTOCOL_LIMITS.maxFrameBytes) throw new FederationContractError('page-too-large', 'complete local source frame exceeds budget')
      return wire
    } catch (failure) { throw error(failure, op) }
  }
  const historyPage = async (ref, request, signal, detailed = false) => {
    const op = detailed ? 'session.read.details' : 'session.read'
    return historyWire('history-page', await boundCall(op, ref, request, signal), ref, detailed, op)
  }
  const historyFollow = async function* (ref, request, signal, detailed = false) {
    if (request.includeAssistantStream) throw error({ code: 'action-unsupported' }, 'session.follow')
    const op = detailed ? 'session.follow.details' : 'session.follow'
    let after = request.after
    while (!signal.aborted) {
      const revision = runtime.revision(pair.machineKey)
      const value = await boundCall(op, ref, { includeAssistantStream: false, ...(after === undefined ? {} : { after }) }, signal)
      signal.throwIfAborted()
      if (value.type === 'idle') { await wait(revision, signal); continue }
      const wire = historyWire('history-frame', value, ref, detailed, op)
      after = value.type === 'snapshot' ? value.page.exportCursor : value.exportCursor
      yield wire
    }
  }
  const fileCall = async (method, ref, request, signal) => {
    const op = `files.${method}`
    try {
      const target = targetRef(ref), checked = sourceFileRequest(method, request)
      if (method === 'upload.start' || (['attachment', 'image'].includes(method) && request.transferId === undefined)) {
        const features = await negotiate(signal)
        const required = method === 'image' || request.kind === 'image' ? FEDERATION_FEATURES.SESSION_IMAGES : FEDERATION_FEATURES.SESSION_FILES
        if (!features.includes(required)) throw new FederationContractError('action-unsupported', 'source attachment capability is unavailable')
      }
      const value = await boundCall(op, target, checked, signal)
      return method === 'upload.finish' ? sourceUploadValue(value) : value
    } catch (failure) { throw error(failure, op) }
  }
  return Object.freeze({
    machineKey: pair.machineKey,
    // A fresh authenticated Worker response is required in this Controller lifetime;
    // persisted readiness or transport delivery alone never enables owner mutations.
    get mutationReadiness() { return runtime.mutationsReady?.(pair.machineKey) === true ? verifiedMutations : undefined },
    subscribeChanges: listener => runtime.subscribe(pair.machineKey, listener),
    machine(signal) {
      signal.throwIfAborted();
      const known = runtime.authority(pair.machineKey);
      return known?.grantRevision === null || known?.metadataAuthorized === false ? null : { label: pair.label ?? pair.machineKey };
    },
    async catalog(cursor, signal) { return codec.toWire('catalog', await call('catalog', cursor === undefined ? {} : { cursor }, signal)) },
    files: Object.freeze({
      uploadStart: (ref, request, signal) => fileCall('upload.start', ref, request, signal),
      uploadChunk: (ref, request, signal) => fileCall('upload.chunk', ref, request, signal),
      uploadFinish: (ref, request, signal) => fileCall('upload.finish', ref, request, signal),
      uploadCancel: (ref, request, signal) => fileCall('upload.cancel', ref, request, signal),
      read: (ref, request, signal) => fileCall('read', ref, request, signal),
      attachment: (ref, request, signal) => fileCall('attachment', ref, request, signal),
      image: (ref, request, signal) => fileCall('image', ref, request, signal),
    }),
    projectRegistration: Object.freeze({
      async state(signal) {
        try {
          await negotiate(signal)
          return codec.toWire('project-registration-state', await runtime.getProjectRegistrationState(pair.machineKey, signal))
        } catch (failure) { throw error(failure, 'project.registration.state') }
      },
      async register(request, signal) {
        try {
          const features = await negotiate(signal)
          if (!features.includes(FEDERATION_FEATURES.PROJECT_REGISTRATION)) throw new FederationContractError('action-unsupported', 'project registration is unavailable')
          const native = codec.fromWire('project-registration-request', request)
          const receipt = await call('project.register', { path: native.path, expectedAuthority: native.expected }, signal, native.requestId)
          const ref = parseProjectRef(receipt.ref)
          if (ref.machineKey !== pair.machineKey) throw new FederationContractError('invalid-message', 'project receipt names another machine')
          return ref
        } catch (failure) { throw error(failure, 'project.register') }
      },
    }),
    bind: (ref, signal) => bind(ref, signal),
    historyPage: (ref, request, signal) => historyPage(ref, request, signal),
    historyFollow: (ref, request, signal) => historyFollow(ref, request, signal),
    details: Object.freeze({
      async bind(ref, signal) {
        let target
        try {
          target = parseSessionRef(ref)
          if (target.machineKey !== pair.machineKey) throw new FederationContractError('source-unavailable', 'source reference belongs to another machine')
        } catch (failure) { throw error(failure, 'session.bind.details') }
        const features = await negotiate(signal)
        return bind(target, signal, features.includes(FEDERATION_FEATURES.SESSION_DETAILS))
      },
      historyPage: (ref, request, signal) => historyPage(ref, request, signal, true),
      historyFollow: (ref, request, signal) => historyFollow(ref, request, signal, true),
    }),
    live: Object.freeze({
      bind: bindLive,
      historyPage: (ref, request, signal) => historyPage(ref, request, signal, true),
      async *historyFollow(rawRef, request, signal) {
        const ref = targetRef(rawRef), binding = liveBindings.get(liveKey(ref))
        if (!binding || request.includeAssistantStream !== true || !sameAuthority(binding.authority, runtime.authority(pair.machineKey))
          || !runtime.liveReady?.(pair.machineKey)) throw error({ code: 'grant-changed' }, 'session.follow.live')
        try {
          for await (const value of runtime.followLive(pair.machineKey, ref, request, binding.authority, signal)) {
            signal.throwIfAborted()
            if (!sameAuthority(binding.authority, runtime.authority(pair.machineKey)) || !runtime.liveReady(pair.machineKey)) {
              throw new FederationContractError('grant-changed', 'live binding authority changed')
            }
            const native = parseLiveHistoryReplyFrame(value, ref, binding.authority)
            const wire = codec.toWire('live-history-frame', native)
            if (jsonByteLength(wire) > PROTOCOL_LIMITS.maxFrameBytes) throw new FederationContractError('page-too-large', 'complete local live frame exceeds budget')
            yield wire
          }
        } catch (failure) {
          liveBindings.delete(liveKey(ref))
          if (!signal.aborted && ['grant-changed', 'not-granted'].includes(failure?.code)) {
            try { await call('hello', {}, signal) } catch (_refreshError) { /* A failed refresh does not authorize another source. */ }
          }
          throw error(failure, 'session.follow.live')
        }
      },
    }),
    async status(ref, signal) { return boundCall('session.status', ref, undefined, signal) },
    async modelCatalog(ref, signal) {
      let target
      try {
        target = parseSessionRef(ref)
        if (target.machineKey !== pair.machineKey) throw new FederationContractError('source-unavailable', 'source reference belongs to another machine')
      } catch (failure) { throw error(failure, 'model.catalog') }
      // Re-negotiate on explicit loads so an upgraded/reconnected Worker is not
      // pinned to stale feature metadata. Overlapping readers share only hello.
      const features = await negotiate(signal)
      if (!features.includes(FEDERATION_FEATURES.MODEL_CATALOG_PAGES)) return boundCall('model.catalog', target, undefined, signal)
      const pinned = await authority(signal)
      let accumulator
      try { accumulator = createModelCatalogAccumulator({ ...target, ...pinned }) }
      catch (failure) { throw error(failure, 'model.catalog.page') }
      let cursor
      do {
        signal?.throwIfAborted()
        const page = await call('model.catalog.page', { ref: target, expectedAuthority: pinned,
          ...(cursor === undefined ? {} : { cursor }) }, signal)
        try { cursor = accumulator.accept(page) }
        catch (failure) { throw error(failure, 'model.catalog.page') }
      } while (cursor !== undefined)
      signal?.throwIfAborted()
      try { return accumulator.result() }
      catch (failure) { throw error(failure, 'model.catalog.page') }
    },
    async modelState(ref, signal) { return codec.toWire('model-stamp', await boundCall('model.state', ref, undefined, signal)) },
    async modelSelect(ref, request, signal) {
      let expected
      try { expected = codec.fromWire('model-stamp', request.expected) } catch (failure) { throw error({ code: 'grant-changed' }, 'model.select') }
      return codec.toWire('model-ack', await boundCall('model.select', ref, { expected, selection: request.selection }, signal, request.requestId))
    },
    async getCreateState(ref, signal) {
      try { return runtime.getCreateState(pair.machineKey, ref, signal) } catch (failure) { throw error(failure, 'session.create') }
    },
    async create(ref, requestId, signal) { return boundCall('session.create', ref, undefined, signal, requestId) },
    async prompt(ref, request, signal) {
      let expected
      try { expected = codec.fromWire('model-stamp', request.expected) } catch (failure) { throw error({ code: 'grant-changed' }, 'session.prompt') }
      return boundCall('session.prompt', ref, { text: request.text, expected, ...(request.uploads === undefined ? {} : { uploads: request.uploads }) }, signal, request.requestId)
    },
    async cancel(ref, request, signal) { return boundCall('session.cancel', ref, undefined, signal, request.requestId) },
  })
}
