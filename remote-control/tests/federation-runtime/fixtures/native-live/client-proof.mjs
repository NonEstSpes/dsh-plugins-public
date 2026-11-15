/** Real Client source ownership, Session, and Chat business assembly over a JSON-only BFF transport. */
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import * as sourcePlugin from '../../../../../dsh-remote-core/packages/api/session-source-controller/src/client/index.ts'
import { ClientSessionSources, remoteSessionHandleOf } from '../../../../../dsh-remote-core/packages/api/session-controller/src/client/sources.ts'
import { Session } from '../../../../../dsh-remote-core/packages/api/session-controller/src/client/sessions/session.ts'
import { ConversationNodeAssembler } from '../../../../../dsh-remote-core/packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { ConversationEventRegistry } from '../../../../../dsh-remote-core/packages/client/ui-conversation/src/client/conversation/event-registry.ts'
import { ConversationViewRegistry } from '../../../../../dsh-remote-core/packages/client/ui-conversation/src/client/conversation/view-registry.ts'
import { assistantDefinition } from '../../../../../dsh-remote-core/packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../../../../../dsh-remote-core/packages/client/ui-chat/src/client/conversation-nodes/chat-snapshot-builder.ts'

/** @typedef {import('./bridge-types.d.mts').NativeLiveBridge} NativeLiveBridge */
/** @typedef {import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/client/adapter.ts').SourceRemote} SourceRemote */
/**
 * Await an observable fact, owning its subscriptions and timeout even on failure.
 * @param {() => boolean} predicate - actual Client observation.
 * @param {(listener: () => void) => () => void} subscribe - owning observable sources.
 * @param {string} label - bounded diagnostic.
 * @returns {Promise<void>} settled when the fact holds.
 */
function waitFor(predicate, subscribe, label) {
  return new Promise((resolve, reject) => {
    let stop = () => {}
    const timer = setTimeout(() => { stop(); reject(new Error(label)) }, 15_000)
    const inspect = () => {
      try { if (!predicate()) return } catch (error) { clearTimeout(timer); stop(); reject(error); return }
      clearTimeout(timer); stop(); resolve()
    }
    stop = subscribe(inspect); inspect()
  })
}

/**
 * Consume one paced actual AgentLoop attempt through the native Source BFF.
 * @param {NativeLiveBridge} bridge - serialized native Host transport and explicit external input gates.
 * @returns {Promise<import('./bridge-types.d.mts').NativeLiveClientProofResult>} JSON-only user-facing observations.
 */
export async function proveClientSession(bridge) {
  /**
   * @template Value
   * @param {import('./bridge-types.d.mts').SourceCallMethod} method - generated BFF endpoint.
   * @param {Readonly<Record<string, unknown>>} args - named JSON arguments.
   * @param {AbortSignal | undefined} signal - local caller lifetime.
   * @returns {Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<Value>>} realm-local values/errors.
   */
  async function call(method, args, signal) {
    /** @type {import('./bridge-types.d.mts').NativeLiveWireResult<Value>} */
    const result = JSON.parse(await bridge.call(method, JSON.stringify(args), signal ?? new AbortController().signal))
    return result.ok ? { ok: true, value: result.value } : { ok: false, error: new RemoteError(result.error.code, result.error.message, {}) }
  }
  /**
   * @template Value
   * @param {import('./bridge-types.d.mts').SourceStreamMethod} method - generated BFF stream.
   * @param {Readonly<Record<string, unknown>>} args - named JSON arguments.
   * @param {AbortSignal | undefined} signal - local caller lifetime.
   * @returns {import('@deepseek-ai/dsh-typert-protocol').RemoteStreamHandle<Value, never>} one owned real downlink.
   */
  function stream(method, args, signal) {
    const lifetime = new AbortController(), combined = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    /** @type {Promise<void> | undefined} */
    let closing
    let taken = false, firstPending = true, uplinkEnded = false
    /** @returns {AsyncGenerator<Value, void, unknown>} */
    async function* read() {
      try {
        combined.throwIfAborted()
        for await (const text of bridge.stream(method, JSON.stringify(args), combined)) {
          combined.throwIfAborted()
          /** @type {import('./bridge-types.d.mts').NativeLiveWireResult<Value>} */
          const result = JSON.parse(text)
          if (!result.ok) throw new RemoteError(result.error.code, result.error.message, {})
          if (method === 'observeMachines') {
            /** @type {readonly import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/types.ts').SourceMachine[]} */
            const rows = JSON.parse(JSON.stringify(result.value))
            bridge.trace('client-observeMachines', JSON.stringify(rows.map(({ machineKey, registrationId, authorityRevision, catalogRevision }) => ({ machineKey, registrationId, authorityRevision, catalogRevision }))))
          }
          yield result.value
        }
      } catch (error) { if (!combined.aborted) throw error }
      finally { signal?.removeEventListener('abort', cancelled) }
    }
    const iterator = read()
    /** @returns {Promise<void>} abort before joining the held actual transport read. */
    function dispose() {
      signal?.removeEventListener('abort', cancelled); lifetime.abort()
      closing ??= iterator.return(undefined).then(() => {})
      return closing
    }
    function cancelled() { void dispose().catch((_error) => {}) }
    signal?.addEventListener('abort', cancelled, { once: true }); if (signal?.aborted) cancelled()
    const first = iterator.next(); void first.catch((_error) => {})
    return {
      [Symbol.asyncIterator]() {
        if (taken) throw new Error('Client proof downlink already has a consumer')
        taken = true
        return {
          /** @returns {Promise<IteratorResult<Value, void>>} */
          async next() {
            if (combined.aborted) { await dispose(); return { done: true, value: undefined } }
            const pending = firstPending ? first : iterator.next(); firstPending = false
            const step = await pending
            if (combined.aborted) { await dispose(); return { done: true, value: undefined } }
            return step
          },
          /** @returns {Promise<IteratorResult<Value, void>>} */
          async return() { await dispose(); return { done: true, value: undefined } },
        }
      },
      /** @param {never} _item There is no uplink codec on Source BFF history. */
      send(_item) { throw new Error(uplinkEnded ? 'Client proof uplink ended' : 'Client proof stream has no uplink') },
      end() { uplinkEnded = true }, async dispose() { await dispose() },
    }
  }
  /** @type {import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/types.ts').SourceBindingInfo[]} */
  const liveBindings = []
  /** @type {string extends keyof SourceRemote ? never : SourceRemote} */
  const remote = {
    listMachines: signal => call('listMachines', {}, signal), observeMachines: signal => stream('observeMachines', {}, signal),
    catalog: (machineKey, cursor, signal) => call('catalog', { machineKey, cursor }, signal),
    bind: (ref, signal) => call('bind', { ref }, signal), bindDetails: (ref, signal) => call('bindDetails', { ref }, signal),
    async bindLive(ref, signal) {
      /** @type {import('@deepseek-ai/dsh-typert-protocol').RemoteResult<import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/types.ts').SourceBindingInfo>} */
      bridge.trace('client-before-bindLive', JSON.stringify({ machineKey: ref.machineKey }))
      const result = await call('bindLive', { ref }, signal)
      bridge.trace('client-after-bindLive', JSON.stringify(result.ok ? { ok: true, registrationId: result.value.registrationId, generation: result.value.generation, grantRevision: result.value.grantRevision } : { ok: false, code: result.error.code }))
      if (result.ok) liveBindings.push(result.value)
      return result
    },
    historyPage: (ref, epoch, request, signal) => call('historyPage', { ref, epoch, request }, signal),
    historyFollow: (ref, epoch, request, signal) => stream('historyFollow', { ref, epoch, request }, signal),
    status: (ref, epoch, signal) => call('status', { ref, epoch }, signal),
    modelCatalog: (ref, epoch, signal) => call('modelCatalog', { ref, epoch }, signal), modelState: (ref, epoch, signal) => call('modelState', { ref, epoch }, signal),
    modelSelect: (ref, epoch, request, signal) => call('modelSelect', { ref, epoch, request }, signal),
    getCreateState: (ref, registrationId, signal) => call('getCreateState', { ref, registrationId }, signal),
    create: (ref, registrationId, requestId, signal) => call('create', { ref, registrationId, requestId }, signal),
    prompt: (ref, epoch, request, signal) => call('prompt', { ref, epoch, request }, signal), cancel: (ref, epoch, request, signal) => call('cancel', { ref, epoch, request }, signal),
  }
  /** @type {import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/types.ts').SourceMachine} */
  const machine = JSON.parse(bridge.machineJson)
  /** @type {import('@deepseek-ai/dsh-api-session-controller/types').RemoteSessionRef} */
  const ref = JSON.parse(bridge.refJson)
  /** @type {import('@deepseek-ai/dsh-api-session-controller/types').SessionProjectionBaseline} */
  const expected = JSON.parse(bridge.baselineJson)
  const ctx = new Context(), registry = new ClientSessionSources(), lifetime = new AbortController()
  // Only this generated namespace and retry clock are transport inputs; business ownership is the actual registry/apply.
  ctx.reflect.provide('connection', { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } }, undefined)
  ctx.reflect.provide('remote', { sessionSources: remote }, undefined)
  ctx.provide('remote.sessionSources', remote); ctx.provide('sessionSources', registry)
  const stopTools = registry.registerNativeDetailsConsumer('tools'), stopMetrics = registry.registerNativeDetailsConsumer('metrics')
  const definitions = new ConversationEventRegistry(ctx), views = new ConversationViewRegistry(ctx)
  const stopAssistant = definitions.register(assistantDefinition), stopView = views.register(chatViewDefinition)
  const assembler = new ConversationNodeAssembler(definitions, views)
  assembler.activateTarget('chat')
  /** @type {Session | undefined} */
  let session
  let stopFeed = () => {}, stopRemoval = () => {}
  try {
    await ctx.plugin(sourcePlugin)
    await waitFor(() => registry.sourceFor(machine.machineKey) !== undefined, listener => registry.sources.subscribe(listener), 'real Client source registration did not appear')
    await registry.refreshSource(machine.machineKey)
    await waitFor(() => registry.sourceFor(machine.machineKey) !== undefined, listener => registry.sources.subscribe(listener), 'refreshed Client source registration did not appear')
    const source = registry.sourceFor(machine.machineKey)
    if (source === undefined) throw new Error('refreshed real Client source registration disappeared')
    const binding = await source.bind(ref, lifetime.signal)
    assert.equal(binding.includeAssistantStream, true)
    assert.equal(liveBindings.length, 1); assert.equal(liveBindings[0]?.nativeDetails, true); assert.equal(liveBindings[0]?.nativeLive, true)
    const current = new Session(remoteSessionHandleOf(ref), binding.remotes, { wireId: ref.sessionId, sourceRef: ref,
      sourceHistory: binding.history, includeAssistantStream: binding.includeAssistantStream })
    session = current
    // This fixture owns its directly constructed Session; the real registry withdrawal uses the Core journal-retirement API.
    stopRemoval = registry.onSourceRemoved(removed => { if (removed === source) current.failSourceJournal() })
    let revision = -1, settlements = 0
    const acceptFeed = () => {
      const window = current.eventSource.getSnapshot()
      if (window.revision === revision) return
      if (window.revision !== revision + 1 || window.change.kind === 'replace') assembler.replaceWindow(window.entries, window.hasMore)
      else switch (window.change.kind) {
        case 'append': for (const entry of window.change.entries) assembler.append(entry); break
        case 'prepend': assembler.prepend(window.change.entries, window.hasMore); break
        case 'settle-assistant': settlements++; assembler.settleAssistant(window.change.attemptId, window.change.entry); break
      }
      revision = window.revision; assembler.flush()
    }
    stopFeed = current.eventSource.subscribe(acceptFeed); acceptFeed()
    /** @returns {import('../../../../../dsh-remote-core/packages/client/ui-chat/src/client/contract/chat-nodes.ts').AssistantChatData | undefined} current actual Chat Assistant node data. */
    function assistant() {
      const chat = assembler.get('chat'), turn = chat?.timeline.turnOrder.at(-1)
      if (chat === undefined || turn === undefined) return undefined
      return chat.nodes.turnDataSource(turn, 'assistant-step').getSnapshot().at(-1)
    }
    /** @returns {string} actual business-assembled text, not a second stream fold. */
    const text = () => assistant()?.blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('') ?? ''
    /** @param {() => void} listener - Client observation callback. @returns {() => void} combined disposer. */
    const changes = listener => {
      const stops = [current.subscribe(listener), current.eventSource.subscribe(listener), registry.sources.subscribe(listener),
        current.projections.faceOf('sessionStats').subscribe(listener), current.projections.faceOf('tokenUsage').subscribe(listener),
        current.projections.faceOf('contextPressure').subscribe(listener), current.projections.faceOf('contextBreakdown').subscribe(listener)]
      return () => { for (const stop of stops) stop() }
    }
    await current.open()
    assert.equal(current.getSnapshot().openState, 'open')
    const identity = current.getSnapshot().sourceRef
    assert.deepEqual(identity, ref); assert.equal(Object.isFrozen(identity), true)
    const keys = ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown']
    assert.deepEqual(Object.keys(expected.values).sort(), [...keys].sort()); assert.equal(expected.asOfSeq, bridge.cut)
    for (const key of keys) { assert.deepEqual(current.projections.get(key), expected.values[key]); assert.equal(current.projections.seqOf(key), bridge.cut) }
    const sourceRefBeforeJson = JSON.stringify(identity)
    await bridge.startPrompt()
    /** @type {string[]} */
    const transientTexts = []
    for (let index = 0; index < bridge.parts.length; index++) {
      await bridge.releasePart(index)
      const prefix = bridge.parts.slice(0, index + 1).join('')
      await waitFor(() => text() === prefix && assistant()?.status === 'running', changes, 'actual Client Chat did not publish transient native text')
      assert.equal(current.eventSource.getSnapshot().entries.some(row => row.type === 'event' && row.event.type === 'assistant/message'), false)
      transientTexts.push(text())
    }
    /** @type {import('./bridge-types.d.mts').NativeLiveFinal} */
    const final = JSON.parse(await bridge.finish())
    try {
      await waitFor(() => assistant()?.status === 'settled' && text() === bridge.parts.join('') && settlements > 0
        && keys.every(key => current.projections.seqOf(key) === final.cut), changes, 'actual native settlement or exact-cut final metrics did not reach Client')
    } catch (error) {
      const snapshot = current.getSnapshot()
      bridge.trace('client-final-timeout', JSON.stringify({ openState: snapshot.openState, errorCode: snapshot.openError?.code,
        assistantStatus: assistant()?.status, textLen: text().length, expectedTextLen: bridge.parts.join('').length, settlements,
        eventTail: current.eventSource.getSnapshot().entries.slice(-8).map(row => row.type === 'event' ? { type: row.event.type, seq: row.event.seq } : { type: row.type }),
        metrics: keys.map(key => ({ key, actualSeq: current.projections.seqOf(key), actualValue: current.projections.get(key), expectedSeq: final.cut, expectedValue: final.projections.values[key] })),
        expectedCut: final.cut, settlementSeq: final.settlementSeq }))
      throw error
    }
    assert.ok(current.eventSource.getSnapshot().entries.some(row => row.type === 'event' && row.event.type === 'assistant/message' && row.event.seq === final.settlementSeq))
    for (const key of keys) assert.deepEqual(current.projections.get(key), final.projections.values[key])
    const projectedValuesJson = JSON.stringify(Object.fromEntries(keys.map(key => [key, current.projections.get(key)])))
    assert.equal(projectedValuesJson.includes('PRIVATE_'), false)
    const settledText = text()
    await bridge.holdForWithdrawal()
    await Promise.all([bridge.revoke(), waitFor(() => current.getSnapshot().openState === 'error'
      && keys.every(key => current.projections.get(key) === undefined), changes, 'real machine withdrawal did not retire Client held-frame ownership')])
    assert.equal(current.getSnapshot().sourceRef, identity)
    assert.deepEqual(current.eventSource.getSnapshot().entries, [])
    assert.equal(text(), '')
    for (const key of keys) { assert.equal(current.projections.get(key), undefined); assert.equal(current.projections.seqOf(key), undefined) }
    const sourceRefAfterRevokeJson = JSON.stringify(current.getSnapshot().sourceRef)
    await current.dispose(); assert.equal(current.getSnapshot().sourceRef, identity)
    return { bindingLive: true, transientTexts, settledText, openingCut: bridge.cut, finalCut: final.cut, settlementSeq: final.settlementSeq,
      projectedValuesJson, sourceRefBeforeJson, sourceRefAfterRevokeJson, sourceRefAfterDisposeJson: JSON.stringify(current.getSnapshot().sourceRef), clearedProjectionKeys: keys }
  } finally {
    lifetime.abort(); stopRemoval(); stopFeed(); await session?.dispose(); stopAssistant(); stopView(); stopTools(); stopMetrics()
    await ctx.fiber.dispose(); registry.dispose()
  }
}
