/** One bounded native producer projected into grant-scoped source history; no Agent driving or journal mirror. */
import { isDeepStrictEqual } from 'node:util'
import { FederationContractError } from './identity.mjs'
import { buildHistoryPage, createHistoryRecordsFrame, createHistorySnapshotFrame } from './history.mjs'
import { createLiveHistoryProjector } from './live-history.mjs'
import { projectNativeMetrics } from './metrics.mjs'
import { FAILURE_CODES, NATIVE_HISTORY_FORMATS, PROTOCOL_LIMITS, jsonByteLength } from './protocol.mjs'

const MESSAGE = 'native follow history projection failed'
const codes = new Set(Object.values(FAILURE_CODES))
const fail = (code = FAILURE_CODES.INVALID_MESSAGE) => { throw new FederationContractError(code, MESSAGE) }
const integer = value => Number.isSafeInteger(value) && !Object.is(value, -0)
const cursor = value => integer(value) && value >= -1
const settlementEvent = event => event.type === 'assistant/message' || event.type === 'assistant/attempt'
const covering = (records, seq) => records.find(record => record.type === 'event' ? record.event.seq === seq : record.firstSeq <= seq && record.lastSeq >= seq)
const proof = (event, record) => ({ eventType: event.type, seq: event.seq, turn: event.data.turn, step: event.data.step, record })

/**
 * Project a single native cut and its uncovered increments with exact same-cut numeric metrics.
 * @param {import('./native-follow-history.mjs').NativeFollowHistoryOptions} options - verified native producer and Runtime-owned authority/envelope functions.
 * @returns {AsyncIterable<import('./native-follow-history.mjs').NativeFollowHistoryFrame>} one iterator; return and abort join native work and refuse overlapping reads.
 */
export function projectNativeFollow({ frames, ref, backend, historyContext, check, signal, wrapFrame }) {
  let closing, pending, returned, pinned, projector
  const safe = error => new FederationContractError(error instanceof FederationContractError && codes.has(error.code) ? error.code : FAILURE_CODES.INVALID_MESSAGE, MESSAGE)
  const context = () => {
    if (signal.aborted || closing) fail(FAILURE_CODES.SOURCE_UNAVAILABLE)
    try { check() } catch { fail(FAILURE_CODES.SOURCE_UNAVAILABLE) }
    let current
    try { current = historyContext() } catch { fail(FAILURE_CODES.SOURCE_UNAVAILABLE) }
    const identity = { generation: current.generation, grantRevision: current.grantRevision, principal: { ...current.principal }, exportClasses: [...current.exportClasses] }
    if (pinned && !isDeepStrictEqual(pinned, identity)) fail(FAILURE_CODES.CURSOR_STALE)
    pinned ??= identity
    return current
  }
  context()
  const native = frames[Symbol.asyncIterator]()
  const returnNative = () => {
    if (returned) return returned
    const completion = Promise.withResolvers()
    returned = completion.promise
    try { void Promise.resolve(native.return?.()).then(() => completion.resolve(), error => completion.reject(error)) }
    catch (error) { completion.reject(error) }
    return returned
  }
  const bounded = frame => {
    context()
    if (jsonByteLength(wrapFrame(frame)) > PROTOCOL_LIMITS.maxFrameBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE)
    context()
    return Object.freeze(frame)
  }
  const detailsAt = async (cut, header) => {
    context()
    const value = await backend.readDetails(ref, signal)
    context()
    if (!value || !cursor(value.cursor) || value.cursor < cut || !Array.isArray(value.events)
      || value.events.length !== value.cursor + 1 || value.header?.id !== ref.sessionId) fail(FAILURE_CODES.HISTORY_GAP)
    if (header && ['version', 'id', 'createdAt', 'isSeeded'].some(key => !isDeepStrictEqual(header[key], value.header[key]))) fail(FAILURE_CODES.HISTORY_GAP)
    if (value.projections !== undefined && value.projections.asOfSeq !== value.cursor) fail(FAILURE_CODES.HISTORY_GAP)
    return value
  }
  const pageAt = (events, throughSeq, fromSeq) => buildHistoryPage({ ...context(), ...ref, events, throughSeq, fromSeq,
    maxMessages: Math.max(1, throughSeq - fromSeq + 1), validateNativeEvents: backend.validateNativeEvents,
    nativeAssistantBlocks: backend.nativeLiveAssistantBlocks, format: NATIVE_HISTORY_FORMATS.DETAILS })
  const assistantEnvelope = frame => ({ type: 'assistant-stream', generation: pinned.generation, grantRevision: pinned.grantRevision, frame })
  const opening = async input => {
    if (!cursor(input.cursor) || input.header?.id !== ref.sessionId || !Array.isArray(input.records)
      || input.projections?.asOfSeq !== input.cursor || input.assistantStream === undefined) fail(FAILURE_CODES.HISTORY_GAP)
    const cut = input.cursor, start = input.records.length ? input.records[0].event?.seq : cut + 1
    if (!integer(start) || start < 0 || (input.records.length === 0 && cut !== -1)) fail(FAILURE_CODES.HISTORY_GAP)
    const observed = await detailsAt(cut, input.header)
    let events = observed.events.slice(0, cut + 1)
    for (let index = 0; index < input.records.length; index++) {
      const record = input.records[index]
      if (record.type !== 'event' || record.event?.seq !== start + index || !isDeepStrictEqual(record.event, events[start + index])) fail(FAILURE_CODES.HISTORY_GAP)
    }
    if (start + input.records.length !== cut + 1) fail(FAILURE_CODES.HISTORY_GAP)
    const metrics = projectNativeMetrics({ baseline: input.projections, throughSeq: cut, exportClasses: context().exportClasses }).projections
    let selected, fit, page = pageAt(events, cut, start)
    const carrier = { fit: undefined }
    fit = baseline => {
      for (;;) {
        const snapshot = { ...createHistorySnapshotFrame({ page, header: input.header, projections: metrics }), assistantStream: baseline }
        const wrapped = wrapFrame(snapshot)
        selected = snapshot
        if (jsonByteLength(wrapped) <= PROTOCOL_LIMITS.maxFrameBytes || page.coveredFromSeq === null || page.coveredFromSeq >= cut) return wrapped
        page = pageAt(events, cut, page.coveredFromSeq + 1)
      }
    }
    carrier.fit = fit
    const live = createLiveHistoryProjector({ exportClasses: context().exportClasses, nativeExpand: backend.nativeExpand,
      nativeCreateCompactor: backend.nativeCreateCompactor, nativeAssistantBlocks: backend.nativeLiveAssistantBlocks,
      wrapBaseline: baseline => { if (!carrier.fit) fail(); return carrier.fit(baseline) },
      wrapFrame: frame => { context(); return wrapFrame(assistantEnvelope(frame)) },
    })
    let baseline
    try { baseline = live.open(input.assistantStream) }
    catch (error) { live.close(); throw error }
    finally { carrier.fit = undefined; fit = undefined }
    if (!selected) { live.close(); fail() }
    const snapshot = bounded({ ...selected, assistantStream: baseline })
    let settlement
    const active = input.assistantStream.activeAttempt
    if (active) for (let index = cut; index > active.startedAfterSeq; index--) {
      const event = events[index]
      if (event && settlementEvent(event) && event.data.turn === active.turn && event.data.step === active.step) {
        const record = covering(snapshot.page.records, event.seq)
        if (record) settlement = proof(event, record)
        break
      }
    }
    events = []
    return { snapshot, live, cut, settlement }
  }
  const durable = async (event, cut) => {
    if (!event || !integer(event.seq) || event.seq !== cut + 1) fail(FAILURE_CODES.HISTORY_GAP)
    const observed = await detailsAt(event.seq)
    if (!isDeepStrictEqual(event, observed.events[event.seq])) fail(FAILURE_CODES.HISTORY_GAP)
    const page = pageAt(observed.events.slice(0, event.seq + 1), event.seq, event.seq)
    if (page.coveredFromSeq !== event.seq || page.coveredThroughSeq !== event.seq || page.records.length !== 1) fail(FAILURE_CODES.HISTORY_GAP)
    const projections = observed.cursor === event.seq && observed.projections !== undefined
      ? projectNativeMetrics({ baseline: observed.projections, throughSeq: event.seq, exportClasses: context().exportClasses }).projections : undefined
    const frame = bounded(createHistoryRecordsFrame({ generation: page.generation, grantRevision: page.grantRevision,
      exportCursor: page.exportCursor, records: page.records, ...(projections === undefined ? {} : { projections }) }))
    return { frame, settlement: settlementEvent(event) ? proof(event, page.records[0]) : undefined, cut: event.seq }
  }
  const inner = (async function* () {
    try {
      context()
      const first = await native.next()
      context()
      if (first.done || first.value?.type !== 'snapshot') fail(FAILURE_CODES.HISTORY_GAP)
      const initial = await opening(first.value)
      context()
      projector = initial.live
      let cut = initial.cut, settlement = initial.settlement
      yield bounded(initial.snapshot)
      for (;;) {
        context()
        const step = await native.next()
        context()
        if (step.done) return
        const input = step.value
        if (input?.type === 'event') {
          const value = await durable(input.event, cut)
          context()
          yield bounded(value.frame)
          cut = value.cut
          if (value.settlement) settlement = value.settlement
        } else if (input?.type === 'assistant-stream') {
          for (const frame of projector.accept(input.frame, settlement)) yield bounded(assistantEnvelope(frame))
          if (input.frame.type === 'end') settlement = undefined
        } else fail(FAILURE_CODES.HISTORY_GAP)
      }
    } catch (error) { throw safe(error) }
    finally {
      projector?.close()
      try { await returnNative() } catch (error) { throw safe(error) }
    }
  })()
  const close = () => {
    if (closing) return closing
    const completion = Promise.withResolvers()
    closing = completion.promise
    signal.removeEventListener('abort', abort)
    // Initiate native retirement before waiting for the generator's held next().
    const nativeClosed = returnNative(), generatorClosed = inner.return(undefined)
    void (async () => {
      await Promise.allSettled([nativeClosed, generatorClosed])
      while (pending) await Promise.allSettled([pending])
      projector?.close()
      completion.resolve()
    })()
    return closing
  }
  const abort = () => { void close() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const result = {
    [Symbol.asyncIterator]: () => result,
    next() {
      if (closing || signal.aborted) return Promise.reject(new FederationContractError(FAILURE_CODES.SOURCE_UNAVAILABLE, MESSAGE))
      if (pending) return Promise.reject(new FederationContractError(FAILURE_CODES.INVALID_MESSAGE, MESSAGE))
      const value = (async () => { const step = await inner.next(); context(); return step })()
      pending = value
      void value.then(step => { if (pending === value) pending = undefined; if (step.done) abort() }, () => { if (pending === value) pending = undefined; abort() })
      return value
    },
    async return() { await close(); return { done: true, value: undefined } },
  }
  return result
}
