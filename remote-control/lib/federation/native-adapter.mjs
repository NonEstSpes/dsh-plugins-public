/** Worker-owned native boundary. Imports the serving Host's core only for explicit v2 Workers. */
import { FederationContractError } from './identity.mjs'
import { PROTOCOL_LIMITS } from './protocol.mjs'

const fail = (code, message) => { throw new FederationContractError(code, message) }
const absent = error => error?.code === 'SESSION_QUERY_SESSION_NOT_FOUND' || error?.code === 'session/not-found'

/** Verified live callbacks are a creation-time capability, separate from legacy reads and mutation policy. */
function createNativeLiveFace({ ctx, original, controllerOriginal, controllerOwner, llm, session, blocks }) {
  if (controllerOriginal === null || typeof controllerOriginal !== 'object' || !controllerOwner) return undefined
  const attest = Object.getOwnPropertyDescriptor(controllerOwner, 'ownsSourceFollowHelper')?.value
  const sourceFollow = Object.getOwnPropertyDescriptor(controllerOriginal, 'sourceFollow')?.value
  if (typeof attest !== 'function' || typeof sourceFollow !== 'function') return undefined
  const ownerReady = () => typeof attest === 'function' && typeof sourceFollow === 'function'
    && Object.getOwnPropertyDescriptor(controllerOwner, 'ownsSourceFollowHelper')?.value === attest
    && original(ctx.get('sessionController')) === controllerOriginal
    && Object.getOwnPropertyDescriptor(controllerOriginal, 'sourceFollow')?.value === sourceFollow
    && attest(controllerOriginal) === true
  if (!ownerReady()) return undefined
  const expand = llm.expandAssistantStream, assemble = llm.assembleAssistantStream, Accumulator = llm.AssistantStreamAccumulator
  if (typeof expand !== 'function' || typeof assemble !== 'function' || typeof Accumulator !== 'function' || typeof session.SessionId !== 'function') return undefined
  const push = Object.getOwnPropertyDescriptor(Accumulator.prototype, 'push')?.value
  const snapshot = Object.getOwnPropertyDescriptor(Accumulator.prototype, 'snapshot')?.value
  if (typeof push !== 'function' || typeof snapshot !== 'function') return undefined
  const lifetime = new AbortController(), active = new Set()
  const unavailable = () => new FederationContractError('source-unavailable', 'native follow owner is unavailable')
  const check = signal => {
    if (lifetime.signal.aborted || signal?.aborted || !ownerReady()
      || llm.expandAssistantStream !== expand || llm.assembleAssistantStream !== assemble || llm.AssistantStreamAccumulator !== Accumulator
      || Object.getOwnPropertyDescriptor(Accumulator.prototype, 'push')?.value !== push
      || Object.getOwnPropertyDescriptor(Accumulator.prototype, 'snapshot')?.value !== snapshot) throw unavailable()
  }
  return {
    nativeExpand(stream) { check(); const value = expand(stream); check(); return value },
    nativeLiveAssistantBlocks(stream, interrupted) { check(); const value = blocks(stream, interrupted); check(); return value },
    nativeCreateCompactor() {
      check()
      const accumulator = new Accumulator()
      check()
      return Object.freeze({
        push(member) { check(); push.call(accumulator, member); check() },
        snapshot() { check(); const value = snapshot.call(accumulator); check(); return value },
      })
    },
    followNative(ref, request, callerSignal) {
      check(callerSignal)
      const controller = new AbortController(), signal = AbortSignal.any([callerSignal, lifetime.signal, controller.signal])
      const iterator = (() => {
        try {
          return sourceFollow({ address: { kind: 'session', sessionId: session.SessionId(ref.sessionId) },
            ...(request.maxMessages === undefined ? {} : { maxMessages: request.maxMessages }),
            ...(request.turnWindow === undefined ? {} : { turnWindow: { ...request.turnWindow } }),
          }, { maxItems: PROTOCOL_LIMITS.maxFollowBufferEvents, maxBytes: PROTOCOL_LIMITS.maxFollowBufferBytes }, signal)[Symbol.asyncIterator]()
        } catch { throw unavailable() }
      })()
      let pending, closing
      const cleanup = () => { signal.removeEventListener('abort', abort); active.delete(owned) }
      const close = () => {
        if (closing) return closing
        const completion = Promise.withResolvers()
        closing = completion.promise
        signal.removeEventListener('abort', abort)
        controller.abort()
        // A native return joins its held read; also join any outer post-await publication guard.
        void (async () => {
          await Promise.allSettled([Promise.resolve().then(() => iterator.return?.())])
          while (pending) await Promise.allSettled([pending])
          cleanup()
          completion.resolve()
        })()
        return closing
      }
      const owned = { cancel() { controller.abort() }, close }
      const abort = () => { void close() }
      active.add(owned)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const result = {
        [Symbol.asyncIterator]: () => result,
        next() {
          if (signal.aborted) return Promise.reject(unavailable())
          if (pending) return Promise.reject(new FederationContractError('invalid-message', 'native follow already has a pending read'))
          const read = (async () => {
            try { check(signal); const step = await iterator.next(); check(signal); return step }
            catch { throw unavailable() }
          })()
          pending = read
          void read.then(step => { if (pending === read) pending = undefined; if (step.done) abort() }, () => { if (pending === read) pending = undefined; abort() })
          return read
        },
        async return() { await close(); return { done: true, value: undefined } },
      }
      return result
    },
    close() {
      const operations = [...active]
      lifetime.abort()
      for (const operation of operations) operation.cancel()
      return Promise.allSettled(operations.map(operation => operation.close())).then(() => {})
    },
  }
}

/** Independently verified project functions; the caller owns policy, effect attribution and private journals. */
function createNativeProjectFace({ ctx, original, controllerOriginal, controllerOwner }) {
  const data = (value, name) => value !== null && (typeof value === 'object' || typeof value === 'function')
    ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined
  let Constructor, prototype, attest, privateCheck, prepare, register
  try {
    Constructor = data(controllerOwner, 'SessionController'); prototype = data(Constructor, 'prototype')
    attest = data(controllerOwner, 'ownsSourceProjectHelpers'); privateCheck = data(Constructor, 'ownsSourceProjectHelpers')
    prepare = data(controllerOriginal, 'sourcePrepareProject'); register = data(controllerOriginal, 'sourceRegisterProject')
  } catch { return undefined }
  if (typeof Constructor !== 'function' || typeof attest !== 'function' || typeof privateCheck !== 'function'
    || typeof prepare !== 'function' || typeof register !== 'function' || !prototype) return undefined
  const ownerReady = () => {
    try {
      return data(controllerOwner, 'SessionController') === Constructor && data(controllerOwner, 'default') === Constructor
        && data(controllerOwner, 'ownsSourceProjectHelpers') === attest && data(Constructor, 'ownsSourceProjectHelpers') === privateCheck
        && data(Constructor, 'prototype') === prototype && Object.getPrototypeOf(controllerOriginal) === prototype
        && !Object.hasOwn(controllerOriginal, 'constructor') && data(prototype, 'constructor') === Constructor
        && original(ctx.get('sessionController')) === controllerOriginal
        && data(controllerOriginal, 'sourcePrepareProject') === prepare && data(controllerOriginal, 'sourceRegisterProject') === register
        && privateCheck(controllerOriginal) === true && attest(controllerOriginal) === true
    } catch { return false }
  }
  if (!ownerReady()) return undefined
  const lifetime = new AbortController(), active = new Set()
  const unavailable = () => new FederationContractError('source-unavailable', 'native project helper owner is unavailable')
  let closing
  const check = signal => { if (lifetime.signal.aborted || signal?.aborted || !ownerReady()) throw unavailable() }
  const call = (helper, request, caller) => {
    try { check(caller) } catch { return Promise.reject(unavailable()) }
    const controller = new AbortController(), completion = Promise.withResolvers()
    const cancel = () => { controller.abort(unavailable()) }
    const owned = { cancel, pending: completion.promise }
    // Admission precedes even a synchronous native callback that reenters Adapter.close().
    active.add(owned)
    caller.addEventListener('abort', cancel, { once: true })
    if (caller.aborted || lifetime.signal.aborted) cancel()
    void (async () => {
      try {
        check(controller.signal)
        const result = await helper(request, controller.signal)
        check(controller.signal)
        completion.resolve(result)
      } catch { completion.reject(unavailable()) }
      finally { caller.removeEventListener('abort', cancel); active.delete(owned) }
    })()
    return completion.promise
  }
  return {
    prepareProject(request, signal) { return call(prepare, { path: request.path }, signal) },
    registerProject(request, signal) { return call(register, { canonicalPath: request.canonicalPath }, signal) },
    close() {
      if (closing) return closing
      const completion = Promise.withResolvers()
      closing = completion.promise
      const operations = [...active]
      lifetime.abort(unavailable())
      for (const operation of operations) operation.cancel()
      void Promise.allSettled(operations.map(operation => operation.pending)).then(() => { completion.resolve() })
      return closing
    },
  }
}

/** Private native file face, independently attested and joined by this adapter's lifetime. */
function createNativeFilesFace({ ctx, original, controllerOriginal, controllerOwner }) {
  const own = (value, key) => value === null || value === undefined ? undefined : Object.getOwnPropertyDescriptor(value, key)?.value
  const Constructor = own(controllerOwner, 'SessionController'), attest = own(controllerOwner, 'ownsSourceFilesHelper')
  const privateCheck = own(Constructor, 'ownsSourceFilesHelper'), prototype = own(Constructor, 'prototype'), face = own(controllerOriginal, 'sourceFiles')
  const names = ['available', 'upload', 'read', 'attachment', 'prompt'], methods = Object.fromEntries(names.map(name => [name, own(face, name)]))
  const nativeImage = own(face, 'image'), nativeImagesAvailable = own(face, 'imagesAvailable')
  const ready = () => {
    try {
      return typeof Constructor === 'function' && typeof attest === 'function' && typeof privateCheck === 'function'
        && own(controllerOwner, 'SessionController') === Constructor && own(controllerOwner, 'default') === Constructor
        && own(controllerOwner, 'ownsSourceFilesHelper') === attest && own(Constructor, 'ownsSourceFilesHelper') === privateCheck
        && own(Constructor, 'prototype') === prototype && Object.getPrototypeOf(controllerOriginal) === prototype
        && !Object.hasOwn(controllerOriginal, 'constructor') && own(prototype, 'constructor') === Constructor
        && original(ctx.get('sessionController')) === controllerOriginal && own(controllerOriginal, 'sourceFiles') === face
        && Object.isFrozen(face) && names.every(name => typeof methods[name] === 'function' && own(face, name) === methods[name])
        && privateCheck(controllerOriginal) === true && attest(controllerOriginal) === true && methods.available() === true
    } catch { return false }
  }
  if (!ready()) return undefined
  const imagesReady = () => {
    try { return ready() && typeof nativeImage === 'function' && typeof nativeImagesAvailable === 'function'
      && own(face, 'image') === nativeImage && own(face, 'imagesAvailable') === nativeImagesAvailable && nativeImagesAvailable() === true }
    catch { return false }
  }
  const imagePresent = imagesReady()
  const lifetime = new AbortController(), active = new Set(), readers = new Set()
  const unavailable = () => new FederationContractError('source-unavailable', 'native source files are unavailable')
  let closing
  const check = signal => { if (lifetime.signal.aborted || signal?.aborted || !ready()) throw unavailable() }
  const call = (caller, invoke) => {
    const controller = new AbortController(), completion = Promise.withResolvers(), abort = () => { controller.abort(unavailable()) }
    const operation = { abort, pending: completion.promise }; active.add(operation)
    caller?.addEventListener('abort', abort, { once: true }); lifetime.signal.addEventListener('abort', abort, { once: true })
    if (caller?.aborted || lifetime.signal.aborted) abort()
    void (async () => {
      try { check(controller.signal); const value = await invoke(controller.signal); check(controller.signal); completion.resolve(value) }
      catch { completion.reject(unavailable()) }
      finally { caller?.removeEventListener('abort', abort); lifetime.signal.removeEventListener('abort', abort); active.delete(operation) }
    })()
    return completion.promise
  }
  return {
    files: Object.freeze({
      ...(imagePresent ? {
        imagesAvailable() { return !lifetime.signal.aborted && imagesReady() },
        image(ref, image, caller) {
          return { async *[Symbol.asyncIterator]() {
            check(caller)
            if (!imagesReady()) throw unavailable()
            const data = await call(caller, async owned => {
              if (!imagesReady()) throw unavailable()
              const value = await nativeImage({ sessionId: ref.sessionId, image }, owned)
              if (!imagesReady()) throw unavailable()
              return value
            })
            check(caller); if (!imagesReady()) throw unavailable()
            yield data
            check(caller); if (!imagesReady()) throw unavailable()
          } }
        },
      } : {}),
      canUpload(ref) { try { check(); return ctx.get('agents')?.get(ref.sessionId) !== undefined } catch { return false } },
      upload(ref, request, data, signal) { return call(signal, owned => methods.upload({ sessionId: ref.sessionId, ...request, data }, owned)) },
      read(ref, request, signal, checkPath) { return call(signal, owned => methods.read({ sessionId: ref.sessionId, ...request }, owned, checkPath)) },
      prompt(request, source, prepare, signal) { return call(signal, owned => methods.prompt(request, source, prepare, owned)) },
      attachment(ref, file, caller) {
        return { [Symbol.asyncIterator]() {
          check(caller)
          const controller = new AbortController(), completion = Promise.withResolvers()
          let iterator, returned
          const abort = () => {
            controller.abort(unavailable())
            if (iterator && returned === undefined) returned = Promise.resolve(iterator.return?.()).then(() => {}, () => {}).then(() => {
              readers.delete(reader); caller.removeEventListener('abort', abort); completion.resolve()
            })
          }
          const reader = { abort, pending: completion.promise }; readers.add(reader)
          caller.addEventListener('abort', abort, { once: true })
          iterator = methods.attachment({ sessionId: ref.sessionId, file }, controller.signal)[Symbol.asyncIterator]()
          if (caller.aborted || lifetime.signal.aborted) abort()
          return {
            async next() {
              try {
                const value = await call(controller.signal, () => iterator.next())
                if (value.done) { readers.delete(reader); caller.removeEventListener('abort', abort); completion.resolve() }
                return value
              } catch (error) { abort(); await returned; throw error }
            },
            async return() { abort(); await returned; return { done: true, value: undefined } },
          }
        } }
      },
    }),
    close() {
      if (closing) return closing
      const completion = Promise.withResolvers(); closing = completion.promise
      lifetime.abort(unavailable())
      for (const operation of active) operation.abort()
      for (const reader of readers) reader.abort()
      void Promise.allSettled([...active, ...readers].map(operation => operation.pending)).then(() => { completion.resolve() })
      return closing
    },
  }
}

/** Create the Worker adapter: reads stay passive; explicit cold mutations prepare before publication.
 * @param {{ctx:object,settings:object,native?:object,modelCatalogProviderTimeoutMs?:number}} options - native owner, explicit workspaces, optional local-only provider deadline, and source-test modules. Native tools/approval policy stay unchanged; sandbox-only full access is ordered separately.
 * @returns {Promise<object>} adapter whose readiness requires the exact NEW helper owner and native policy/durability APIs; stock or missing owner stays read-only.
 */
export async function createNativeAdapter({ ctx, settings, native, modelCatalogProviderTimeoutMs }) {
  if (modelCatalogProviderTimeoutMs !== undefined && (!Number.isSafeInteger(modelCatalogProviderTimeoutMs) || modelCatalogProviderTimeoutMs <= 0 || modelCatalogProviderTimeoutMs > 60000)) {
    fail('invalid-message', 'Worker provider deadline must be an explicit integer from 1 to 60000 milliseconds')
  }
  const llm = native?.llm ?? await import('@deepseek-ai/dsh-llm')
  const session = native?.session ?? await import('@deepseek-ai/dsh-session')
  const sandbox = native?.sandbox ?? await import('@deepseek-ai/dsh-sandbox-policy')
  const cordis = native?.cordis ?? await import('@deepseek-ai/cordis')
  const original = value => value?.[cordis.symbols.original] ?? value
  const controller = ctx.get('sessionController')
  const controllerOriginal = original(controller)
  let controllerOwner = native?.controllerOwner
  if (!controllerOwner) {
    try { controllerOwner = await import('@dsh-remote/worker-session-controller') } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !error.message.includes("Cannot find package '@dsh-remote/worker-session-controller'")) throw error
      // The distinct Worker owner is an optional capability, never stock API fallback.
    }
  }
  const catalogOwnerReady = () => typeof controllerOwner?.ownsSourceCatalogHelper === 'function'
    && controllerOwner.ownsSourceCatalogHelper(controllerOriginal) === true
    && original(ctx.get('sessionController')) === controllerOriginal
  const verifiedMutations = Object.freeze({ durableJournal: 'verified', firstRouteCapture: 'verified' })
  const ownerReady = () => typeof controllerOwner?.ownsSourceMutationHelpers === 'function'
    && controllerOwner.ownsSourceMutationHelpers(controllerOriginal) === true
    && original(ctx.get('sessionController')) === controllerOriginal
    && typeof ctx.get('sandboxPolicy')?.resolve === 'function'
    && typeof ctx.get('sessions')?.flush === 'function'
    && typeof sandbox.setSandboxMode === 'function'
  const prepareFullAccess = async agent => {
    let event
    if (ctx.sandboxPolicy.resolve({ session: agent.session }).mode !== 'danger-full-access') {
      sandbox.setSandboxMode(agent.session, 'danger-full-access')
      event = agent.session.eventAt(agent.session.seq - 1)
      if (event?.type !== 'sandbox/mode' || event.data.mode !== 'danger-full-access') fail('outcome-unknown', 'native sandbox preparation was not correlated')
    }
    if (await ctx.get('sessions').flush(agent.session) !== true) fail('outcome-unknown', 'native permission change lacks durable flush authority')
    return event
  }
  const guards = new Map(), projectBindings = new Map()
  const registryGet = registry => {
    for (let target = registry; target !== null && target !== undefined; target = Object.getPrototypeOf(target)) {
      const descriptor = Object.getOwnPropertyDescriptor(target, 'get')
      if (descriptor !== undefined) return typeof descriptor.value === 'function' ? descriptor.value : undefined
    }
    return undefined
  }
  const resolveProject = ref => {
    if (Object.hasOwn(settings.projects, ref.projectId)) return settings.projects[ref.projectId]
    const owner = projectBindings.get(ref.machineKey), binding = owner?.entries.get(ref.projectId)
    if (!binding || original(ctx.get('workspaceRegistry')) !== owner.registry || registryGet(owner.registry) !== owner.get) fail('source-unavailable', 'native project binding is unavailable')
    const workspace = owner.get.call(owner.registry, binding.workspaceId)
    if (!workspace || workspace.id !== binding.workspaceId || workspace.path !== binding.canonicalPath) fail('source-unavailable', 'native project binding is unavailable')
    return binding
  }
  const live = sessionId => {
    const agent = ctx.agents.get(sessionId)
    if (!agent) fail('source-unavailable', 'native Agent must already be prepared without resuming')
    return agent
  }
  const requireOriginalStamp = (agent, expected) => {
    const current = agent.model.current() ?? null
    const matches = current === null ? expected.selection === null : expected.selection !== null
      && current.provider === expected.selection.provider && current.model === expected.selection.model && current.reasoningEffort === expected.selection.reasoningEffort
    if (agent.status !== 'idle' || agent.session.seq - 1 !== expected.frontierSeq || !matches) fail('selection-conflict', 'native source changed before admission/publication')
  }
  const flushMutation = async agent => {
    if (await ctx.get('sessions').flush(agent.session) !== true) fail('outcome-unknown', 'native accepted mutation lacks durable receipt proof')
  }
  const prepare = async (ref, expected, signal, recovery) => {
    if (!recovery?.restore || !recovery?.check) fail('action-unsupported', 'durable source recovery setup is required')
    let agent = ctx.agents.get(ref.sessionId)
    if (!agent) {
      if (typeof controller.prepareSourceSession !== 'function') fail('action-unsupported', 'native unpublished source preparation is unavailable')
      agent = await controller.prepareSourceSession(ref.sessionId, async (_agentCtx, unpublished) => {
        requireOriginalStamp(unpublished, expected)
        signal?.throwIfAborted(); recovery.check()
        await recovery.restore(unpublished)
        requireOriginalStamp(unpublished, expected)
        return { commit: () => { signal?.throwIfAborted(); recovery.check(); requireOriginalStamp(unpublished, expected) } }
      })
    }
    requireOriginalStamp(agent, expected)
    await recovery.restore(agent)
    requireOriginalStamp(agent, expected)
    signal?.throwIfAborted(); recovery.check()
    return agent
  }
  const nativeCall = async operation => {
    try { return await operation() } catch (error) {
      if (error.code === 'session/selection-conflict' || error.code === 'session/source-unavailable') {
        const failure = new FederationContractError(error.code === 'session/selection-conflict' ? 'selection-conflict' : 'source-unavailable', 'native source operation was refused before admission')
        failure.remoteRefusal = true; throw failure
      }
      if (error.code === 'session/outcome-unknown') fail('outcome-unknown', 'native source preparation outcome is unknown')
      throw error
    }
  }
  const installGuard = (agent, requestId, expected, check) => {
    let installed = guards.get(agent)
    if (!installed) { installed = new Map(); guards.set(agent, installed) }
    if (installed.has(requestId)) return
    if (typeof controller.installPromptSelectionGuard !== 'function') fail('action-unsupported', 'native first-step guard is unavailable')
    const disposeRoute = controller.installPromptSelectionGuard(agent, requestId, expected)
    const disposeAuthority = agent.ctx.on('agent/pre-step', async (payload, next) => {
      const matches = payload.agent === agent && payload.messages.some(message => message.source.kind === 'user' && message.source.rpcId === requestId)
      if (!matches) return next()
      try {
        try { check?.() } catch (error) { return { kind: 'reject' } }
        return await next()
      } finally { disposeAuthority() }
    })
    installed.set(requestId, () => { disposeRoute(); disposeAuthority() })
  }
  const readSnapshot = async (ref, signal, projectionMode) => {
    signal?.throwIfAborted()
    let observation
    try {
      observation = await ctx.sessionQuery.observeSession(ref.sessionId, { signal, projectionMode })
      signal?.throwIfAborted()
      return { header: { ...observation.header }, events: [...observation.events], running: ctx.agents.get(ref.sessionId)?.status === 'running',
        ...(projectionMode === 'all' ? { cursor: observation.cursor, projections: observation.projections } : {}),
      }
    } catch (error) { if (absent(error)) fail('source-unavailable', 'session is unavailable'); throw error }
    finally { observation?.[Symbol.dispose]() }
  }
  const nativeAssistantBlocks = (stream, interrupted) => { const assembled = llm.assembleAssistantStream(stream); return interrupted ? assembled.interruptedBlocks() : assembled.blocks() }
  const liveFace = createNativeLiveFace({ ctx, original, controllerOriginal, controllerOwner, llm, session, blocks: nativeAssistantBlocks })
  const projectFace = createNativeProjectFace({ ctx, original, controllerOriginal, controllerOwner })
  const filesFace = createNativeFilesFace({ ctx, original, controllerOriginal, controllerOwner })
  return {
    ...liveFace,
    ...projectFace,
    ...filesFace,
    setProjectBindings(machineKey, entries) {
      if (entries.length === 0) { projectBindings.delete(machineKey); return }
      const registry = original(ctx.get('workspaceRegistry')), get = registryGet(registry)
      if (!registry || typeof get !== 'function') fail('source-unavailable', 'native project binding owner is unavailable')
      projectBindings.set(machineKey, { registry, get, entries: new Map(entries.map(entry => [entry.projectId,
        { workspaceId: entry.workspaceId, canonicalPath: entry.canonicalPath }])) })
    },
    get mutationReadiness() { return ownerReady() ? verifiedMutations : undefined },
    validateNativeEvents(events) {
      for (const event of events) {
        session.snapshotSessionEvent(event)
        if (event.type === 'assistant/message' || event.type === 'assistant/attempt') llm.expandAssistantStream(event.data.stream)
      }
    },
    nativeAssistantBlocks,
    read(ref, signal) { return readSnapshot(ref, signal, 'none') },
    readDetails(ref, signal) { return readSnapshot(ref, signal, 'all') },
    async modelCatalog(signal) {
      signal?.throwIfAborted()
      if (modelCatalogProviderTimeoutMs === undefined) {
        const result = await controller.modelCatalog(); signal?.throwIfAborted(); return result
      }
      if (!catalogOwnerReady()) fail('action-unsupported', 'bounded model catalogs require the exact Worker catalog helper')
      const result = await controller.sourceModelCatalog({ providerTimeoutMs: modelCatalogProviderTimeoutMs }, signal)
      signal?.throwIfAborted()
      if (!catalogOwnerReady()) fail('source-unavailable', 'Worker catalog helper owner changed during the read')
      return result
    },
    async modelState(ref, signal) {
      signal?.throwIfAborted()
      if (typeof controller.sourceModelState !== 'function') fail('action-unsupported', 'passive native model-state helper is unavailable')
      const result = await controller.sourceModelState(ref.sessionId)
      signal?.throwIfAborted()
      return result
    },
    hasPromptEvidence(agent, requestId, expected) {
      let turn, step, enteredStep
      for (let seq = 0; seq < agent.session.seq; seq++) {
        const event = agent.session.eventAt(seq)
        if (event.type === 'turn/start') { if (enteredStep) return false; turn = event.data.turn; step = undefined }
        if (event.type === 'step/start') { if (enteredStep) return false; step = event.data }
        if (!enteredStep && event.type === 'user/message' && event.data.source.kind === 'user' && event.data.source.rpcId === requestId) {
          if (step?.turn !== turn) return false
          enteredStep = { turn: step.turn, step: step.step }
        }
        if (event.type === 'request/header' && enteredStep && step?.turn === enteredStep.turn && step?.step === enteredStep.step) {
          const header = event.data.header, config = header.config
          const route = { provider: config.provider, model: config.model, ...(header.adapterDefaults?.reasoningEffort === true || config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) }
          return expected !== null && route.provider === expected.provider && route.model === expected.model && route.reasoningEffort === expected.reasoningEffort
        }
        if (enteredStep && (event.type === 'step/end' || event.type === 'turn/end')) return false
        if (event.type === 'turn/end') { turn = undefined; step = undefined }
      }
      return false
    },
    restoreGuard(agent, requestId, expected, check) { installGuard(agent, requestId, expected, check) },
    async create({ ref, reservedSessionId }, dispatch, signal, recovery) {
      const project = resolveProject(ref)
      if (!recovery?.created || !recovery?.check || typeof controller.createSourceSession !== 'function') fail('action-unsupported', 'native exact source creation and durable setup are required')
      signal?.throwIfAborted(); recovery.check()
      await dispatch()
      const current = resolveProject(ref)
      if (current.workspaceId !== project.workspaceId || current.canonicalPath !== project.canonicalPath) fail('outcome-unknown', 'native project binding changed')
      const result = await nativeCall(() => controller.createSourceSession({ sessionId: reservedSessionId, workspaceId: project.workspaceId }, async (_agentCtx, agent) => {
        if (agent.id !== reservedSessionId) fail('outcome-unknown', 'native create returned a replacement ID')
        const initialSelection = agent.model.current()
        if (initialSelection) agent.model.select(initialSelection)
        await prepareFullAccess(agent)
        await recovery.created({ sessionId: reservedSessionId, createdAt: agent.session.header.createdAt, initialSelection: initialSelection ?? null, frontierSeq: agent.session.seq - 1 })
        return { commit: () => { signal?.throwIfAborted(); recovery.check() } }
      })).catch(error => {
        if (error.code === 'source-unavailable') fail('outcome-unknown', 'reserved native creation is unavailable; no adoption or replacement')
        throw error
      })
      if (result.sessionId !== reservedSessionId) fail('outcome-unknown', 'native create returned a replacement ID')
      return { ...ref, sessionId: reservedSessionId }
    },
    async modelSelect(ref, request, dispatch, signal, recovery) {
      const agent = await prepare(ref, request.expected, signal, recovery)
      await dispatch()
      const result = await nativeCall(() => controller.selectSessionModel({ sessionId: ref.sessionId, ...request.selection, expectedFrontierSeq: request.expected.frontierSeq, expectedSelection: request.expected.selection }))
      await flushMutation(agent)
      return { frontierSeq: result.frontierSeq, selection: result.selected }
    },
    async prompt(ref, request, dispatch, signal, recovery) {
      const hasUploads = request.uploads?.length > 0
      if (hasUploads && !filesFace) fail('action-unsupported', 'verified native file admission is unavailable')
      const agent = await prepare(ref, request.expected, signal, recovery)
      installGuard(agent, request.requestId, request.expected.selection, recovery.check)
      signal?.throwIfAborted()
      if (!hasUploads && typeof controller.guardedSourcePrompt !== 'function') fail('action-unsupported', 'ordered native source admission is unavailable')
      const nativeRequest = { sessionId: ref.sessionId, requestId: request.requestId, mode: 'queue',
        content: [{ type: 'text', text: request.text }, ...(request.uploads ?? []).map(upload => ({ type: 'file', receiptId: upload.receiptId }))],
        requireIdle: true, expectedFrontierSeq: request.expected.frontierSeq, expectedSelection: request.expected.selection }
      const source = { kind: 'user', rpcId: request.requestId }
      const preparation = async prepared => {
        signal?.throwIfAborted(); recovery.check()
        const event = await prepareFullAccess(prepared)
        signal?.throwIfAborted(); recovery.check()
        return event
      }
      await dispatch()
      const result = hasUploads
        ? await filesFace.files.prompt(nativeRequest, source, preparation, signal).catch(() => { fail('outcome-unknown', 'native file prompt outcome is unknown') })
        : await nativeCall(() => controller.guardedSourcePrompt(nativeRequest, source, preparation))
      await flushMutation(agent)
      return result
    },
    async cancel(ref, request, dispatch, signal) {
      signal?.throwIfAborted(); const agent = live(ref.sessionId); await dispatch()
      const result = controller.cancel({ sessionId: ref.sessionId })
      await flushMutation(agent)
      return result
    },
    disposeAgent(agent) { for (const dispose of guards.get(agent)?.values() ?? []) dispose(); guards.delete(agent) },
    close() {
      // Accepted input may still be queued on a native Agent. Its Agent-owned
      // first-step listeners must survive provider teardown and reject via the
      // closed authority check, rather than be removed before the pending step.
      guards.clear(); projectBindings.clear()
      // Each close aborts synchronously; start both before waiting on either group.
      const pending = []
      if (liveFace) pending.push(liveFace.close())
      if (projectFace) pending.push(projectFace.close())
      if (filesFace) pending.push(filesFace.close())
      if (pending.length > 0) return Promise.allSettled(pending).then(() => {})
    },
  }
}
