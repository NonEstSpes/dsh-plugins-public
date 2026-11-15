/** Actual Client adapter and Session consume JSON from the native Loader-owned Source BFF. */
import assert from 'node:assert/strict'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createBrowserSource } from '../../../../../dsh-remote-core/packages/api/session-source-controller/src/client/adapter.ts'
import { Session } from '../../../../../dsh-remote-core/packages/api/session-controller/src/client/sessions/session.ts'
import { remoteSessionHandleOf } from '../../../../../dsh-remote-core/packages/api/session-controller/src/client/sources.ts'

/** @typedef {import('./bridge-types.d.mts').NativeDetailsBridge} NativeDetailsBridge */
/** @typedef {import('./bridge-types.d.mts').NativeDetailsClientProofResult} NativeDetailsClientProofResult */
/** @typedef {import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/client/adapter.ts').SourceRemote} SourceRemote */
/** @typedef {import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/types.ts').SourceBindingInfo} SourceBindingInfo */

/**
 * Assert native metrics and immutable foreign identity through real Client data consumers.
 * @param {NativeDetailsBridge} bridge - JSON-only native Source BFF transport and issuer-owned grant withdrawal.
 * @returns {Promise<NativeDetailsClientProofResult>} serialized observations; no SDK classes leave the Client realm.
 */
export async function proveClientSession(bridge) {
  /**
   * @template Value
   * @param {import('./bridge-types.d.mts').SourceCallMethod} method - actual Source BFF endpoint.
   * @param {Readonly<Record<string, unknown>>} args - named JSON arguments, preserving absent optional fields.
   * @param {AbortSignal | undefined} signal - local caller cancellation.
   * @returns {Promise<import('@deepseek-ai/dsh-typert-protocol').RemoteResult<Value>>} Client-owned result/error values.
   */
  async function call(method, args, signal) {
    /** @type {import('./bridge-types.d.mts').NativeDetailsWireResult<Value>} */
    const result = JSON.parse(await bridge.call(method, JSON.stringify(args), signal ?? new AbortController().signal))
    return result.ok ? { ok: true, value: result.value }
      : { ok: false, error: new RemoteError(result.error.code, result.error.message, {}) }
  }
  /**
   * @template Value
   * @param {import('./bridge-types.d.mts').SourceStreamMethod} method - actual Source BFF stream.
   * @param {Readonly<Record<string, unknown>>} args - named JSON arguments.
   * @param {AbortSignal | undefined} signal - local caller cancellation.
   * @returns {import('@deepseek-ai/dsh-typert-protocol').RemoteStreamHandle<Value, never>} one owned downlink; no Host objects or uplink items cross it.
   */
  function stream(method, args, signal) {
    const lifetime = new AbortController()
    const combined = signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal])
    /** @type {Promise<void> | undefined} */
    let closing
    let taken = false, firstPending = true, uplinkEnded = false
    /** @returns {AsyncGenerator<Value, void, unknown>} */
    async function* read() {
      try {
        combined.throwIfAborted()
        for await (const text of bridge.stream(method, JSON.stringify(args), combined)) {
          combined.throwIfAborted()
          /** @type {import('./bridge-types.d.mts').NativeDetailsWireResult<Value>} */
          const result = JSON.parse(text)
          if (!result.ok) throw new RemoteError(result.error.code, result.error.message, {})
          yield result.value
        }
      } catch (error) {
        // Explicit cancellation ends the downlink quietly; real BFF failures still reach Session.
        if (!combined.aborted) throw error
      } finally { signal?.removeEventListener('abort', cancelled) }
    }
    const iterator = read()
    /** @returns {Promise<void>} abort synchronously, then join the actual bridge iterator. */
    function dispose() {
      signal?.removeEventListener('abort', cancelled)
      lifetime.abort()
      closing ??= iterator.return(undefined).then(() => {})
      return closing
    }
    function cancelled() {
      // The retained closing promise reports cleanup failures to dispose/iterator.return.
      void dispose().catch((_error) => {})
    }
    signal?.addEventListener('abort', cancelled, { once: true })
    if (signal?.aborted) cancelled()
    // A generated stream opens on invocation, even before its single consumer asks for an item.
    const first = iterator.next()
    // Keep an unconsumed opening failure owned; next() still awaits the original rejected promise.
    void first.catch((_error) => {})
    return {
      [Symbol.asyncIterator]() {
        if (taken) throw new Error('source fixture downlink already has a consumer')
        taken = true
        return {
          /** @returns {Promise<IteratorResult<Value, void>>} */
          async next() {
            if (combined.aborted) { await dispose(); return { done: true, value: undefined } }
            const pending = firstPending ? first : iterator.next()
            firstPending = false
            const result = await pending
            if (combined.aborted) { await dispose(); return { done: true, value: undefined } }
            return result
          },
          /** @returns {Promise<IteratorResult<Value, void>>} */
          async return() { await dispose(); return { done: true, value: undefined } },
        }
      },
      /** @param {never} _item No input codec exists for these generated source streams. */
      send(_item) { throw new Error(uplinkEnded ? 'source fixture uplink has ended' : 'source fixture stream has no uplink') },
      // Half-closing the absent uplink never cancels the independent downlink.
      end() { uplinkEnded = true },
      async dispose() { await dispose() },
    }
  }
  /** @type {boolean[]} */
  const legacyFlags = []
  /** @type {boolean[]} */
  const detailFlags = []
  /** @type {string extends keyof SourceRemote ? never : SourceRemote} */
  const remote = {
    listMachines: signal => call('listMachines', {}, signal),
    observeMachines: signal => stream('observeMachines', {}, signal),
    catalog: (machineKey, cursor, signal) => call('catalog', { machineKey, cursor }, signal),
    async bind(ref, signal) {
      /** @type {import('@deepseek-ai/dsh-typert-protocol').RemoteResult<SourceBindingInfo>} */
      const result = await call('bind', { ref }, signal)
      if (result.ok) legacyFlags.push(result.value.nativeDetails === true)
      return result
    },
    async bindDetails(ref, signal) {
      /** @type {import('@deepseek-ai/dsh-typert-protocol').RemoteResult<SourceBindingInfo>} */
      const result = await call('bindDetails', { ref }, signal)
      if (result.ok) detailFlags.push(result.value.nativeDetails === true)
      return result
    },
    async bindLive(_ref, _signal) { throw new Error('native details proof never opts into live binding') },
    historyPage: (ref, epoch, request, signal) => call('historyPage', { ref, epoch, request }, signal),
    historyFollow: (ref, epoch, request, signal) => stream('historyFollow', { ref, epoch, request }, signal),
    status: (ref, epoch, signal) => call('status', { ref, epoch }, signal),
    modelCatalog: (ref, epoch, signal) => call('modelCatalog', { ref, epoch }, signal),
    modelState: (ref, epoch, signal) => call('modelState', { ref, epoch }, signal),
    modelSelect: (ref, epoch, request, signal) => call('modelSelect', { ref, epoch, request }, signal),
    getCreateState: (ref, registrationId, signal) => call('getCreateState', { ref, registrationId }, signal),
    create: (ref, registrationId, requestId, signal) => call('create', { ref, registrationId, requestId }, signal),
    prompt: (ref, epoch, request, signal) => call('prompt', { ref, epoch, request }, signal),
    cancel: (ref, epoch, request, signal) => call('cancel', { ref, epoch, request }, signal),
  }
  /** @type {import('../../../../../dsh-remote-core/packages/api/session-source-controller/src/types.ts').SourceMachine} */
  const machine = JSON.parse(bridge.machineJson)
  /** @type {import('@deepseek-ai/dsh-api-session-controller/types').RemoteSessionRef} */
  const ref = JSON.parse(bridge.refJson)
  /** @type {import('@deepseek-ai/dsh-api-session-controller/types').SessionProjectionBaseline} */
  const expected = JSON.parse(bridge.baselineJson)
  const connection = { generation: { getSnapshot: () => undefined, subscribe: () => () => {} } }
  const legacy = createBrowserSource(remote, connection, machine)
  const native = createBrowserSource(remote, connection, machine, { nativeDetails: true })
  const lifetime = new AbortController(), signal = lifetime.signal
  const keys = ['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown']
  /** @type {Session | undefined} */
  let session
  try {
    const oldBinding = await legacy.source.bind(ref, signal)
    const opening = oldBinding.history.follow({ includeAssistantStream: false }, signal)[Symbol.asyncIterator]()
    try {
      const first = await opening.next()
      if (first.done || first.value.type !== 'snapshot') throw new Error('legacy bind did not produce a snapshot')
      assert.deepEqual(first.value.projections.values, {})
    } finally { await opening.return?.() }
    assert.deepEqual(legacyFlags, [false])
    assert.deepEqual(detailFlags, [])

    const binding = await native.source.bind(ref, signal)
    assert.deepEqual(detailFlags, [true])
    session = new Session(remoteSessionHandleOf(ref), binding.remotes, { wireId: ref.sessionId,
      sourceRef: ref, sourceHistory: binding.history, includeAssistantStream: binding.includeAssistantStream })
    await session.open()
    assert.equal(session.getSnapshot().openState, 'open')
    const identity = session.getSnapshot().sourceRef
    assert.deepEqual(identity, ref)
    assert.equal(Object.isFrozen(identity), true)
    assert.equal(expected.asOfSeq, bridge.cut)
    assert.deepEqual(Object.keys(expected.values).sort(), [...keys].sort())
    const values = Object.fromEntries(keys.map(key => [key, session?.projections.get(key)]))
    assert.deepEqual(values, expected.values)
    for (const key of keys) assert.equal(session.projections.seqOf(key), bridge.cut)
    const projectedValuesJson = JSON.stringify(values)
    const sourceRefBeforeJson = JSON.stringify(identity)

    let finishWaiting = () => {}
    const current = session
    /** @type {Promise<void>} */
    const withdrawn = new Promise((resolve, reject) => {
      let stop = () => {}
      const timer = setTimeout(() => { stop(); reject(new Error('grant withdrawal did not clear Client projections')) }, 10_000)
      const inspect = () => {
        if (current.getSnapshot().openState !== 'error' || keys.some(key => current.projections.get(key) !== undefined)) return
        clearTimeout(timer); stop(); resolve()
      }
      stop = current.subscribe(inspect)
      finishWaiting = () => { clearTimeout(timer); stop() }
      inspect()
    })
    try { await Promise.all([bridge.revoke(), withdrawn]) } finally { finishWaiting() }
    assert.equal(session.getSnapshot().sourceRef, identity)
    for (const key of keys) {
      assert.equal(session.projections.get(key), undefined)
      assert.equal(session.projections.seqOf(key), undefined)
    }
    assert.deepEqual(session.eventSource.getSnapshot().entries, [])
    const sourceRefAfterRevokeJson = JSON.stringify(session.getSnapshot().sourceRef)
    await session.dispose()
    assert.equal(session.getSnapshot().sourceRef, identity)
    return { legacyFormat: 'legacy', projectedValuesJson, projectedCut: bridge.cut, sourceRefBeforeJson,
      sourceRefAfterRevokeJson, sourceRefAfterDisposeJson: JSON.stringify(session.getSnapshot().sourceRef), clearedProjectionKeys: keys }
  } finally {
    lifetime.abort()
    await session?.dispose()
    await legacy.dispose()
    await native.dispose()
  }
}
