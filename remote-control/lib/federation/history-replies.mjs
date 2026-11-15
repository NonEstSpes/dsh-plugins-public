/** Validate Worker history replies against the binding's exact format and cursor scope before local BFF delivery. */
import { FederationContractError } from './identity.mjs'
import { parseHistoryPage, createHistorySnapshotFrame, createHistoryRecordsFrame } from './history.mjs'
import { NATIVE_HISTORY_FORMATS, PROTOCOL_LIMITS, decodeExportCursor, jsonByteLength } from './protocol.mjs'
import { canonicalJson } from './journal.mjs'

const fail = () => { throw new FederationContractError('invalid-message', 'invalid source history reply') }
const first = record => record.type === 'event' ? record.event.seq : record.firstSeq
const last = record => record.type === 'event' ? record.event.seq : record.lastSeq
const legacyTypes = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message',
  'turn/start', 'turn/end', 'step/start', 'step/end', 'model/selection', 'session/title', 'todo/write', 'goal/change', 'usage'])

function recordsPolicy(records, format) {
  if (format !== NATIVE_HISTORY_FORMATS.LEGACY) return
  for (const record of records) {
    if (record.type !== 'event') continue
    if (!legacyTypes.has(record.event.type)) fail()
    if (record.event.type !== 'assistant/message') continue
    // Cached Clients can dispatch Tool presenters from either the durable
    // blocks or their compact stream. Legacy permits neither entry route.
    const visit = value => {
      if (value === null || typeof value !== 'object') return
      if (value.type === 'tool-call' || value.type === 'tool-call-chunks'
        || value.type === 'tool-call-delta' || value.blockType === 'tool-call') fail()
      for (const child of Object.values(value)) visit(child)
    }
    visit(record.event.data)
  }
}

/**
 * Check a backwards page against the exact qualified ref and selected format.
 * @param {object} value - untrusted native-number Worker page.
 * @param {object} ref - captured machine/project/session identity.
 * @param {'legacy'|'native-details-v1'} format - locally selected binding format.
 * @returns {Readonly<object>} checked immutable page.
 */
export function parseHistoryReplyPage(value, ref, format) {
  const page = parseHistoryPage(value, { ...ref, format })
  recordsPolicy(page.records, format)
  return page
}

/**
 * Check one snapshot or records delivery without inferring a format from its payload.
 * @param {object} value - untrusted Worker follow reply, excluding idle.
 * @param {object} ref - captured machine/project/session identity.
 * @param {'legacy'|'native-details-v1'} format - locally selected binding format.
 * @returns {Readonly<object>} checked immutable frame.
 */
export function parseHistoryReplyFrame(value, ref, format) {
  if (value?.type === 'snapshot') {
    const page = parseHistoryReplyPage(value.page, ref, format)
    if (value.header?.id !== ref.sessionId || Object.keys(value).some(key => !['type', 'page', 'header', 'projections'].includes(key))) fail()
    return createHistorySnapshotFrame({ page, header: value.header, projections: value.projections })
  }
  if (value?.type !== 'records') fail()
  const { type, ...parts } = value
  const frame = createHistoryRecordsFrame(parts)
  const cursor = decodeExportCursor(frame.exportCursor, { ...ref, format, generation: frame.generation, grantRevision: frame.grantRevision })
  if (frame.records.length > 0 && last(frame.records.at(-1)) !== cursor.throughSeq) fail()
  const page = parseHistoryReplyPage({ generation: frame.generation, grantRevision: frame.grantRevision,
    exportCursor: frame.exportCursor, throughSeq: cursor.throughSeq,
    coveredFromSeq: frame.records.length === 0 ? null : first(frame.records[0]),
    coveredThroughSeq: frame.records.length === 0 ? null : last(frame.records.at(-1)),
    hasMore: false, records: frame.records,
  }, ref, format)
  if (frame.projections !== undefined && frame.records.length === 0) fail()
  return Object.freeze({ ...frame, records: page.records })
}

const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const integer = value => Number.isSafeInteger(value) && !Object.is(value, -0)
const text = value => typeof value === 'string' && value.length > 0
function closed(value, required, optional = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    || required.some(key => !Object.hasOwn(value, key))) fail()
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail()
  }
}
function liveBlock(block) {
  if (block?.type === 'text') {
    closed(block, ['type', 'text']); if (typeof block.text !== 'string') fail()
  } else {
    closed(block, ['type', 'id', 'name', 'arguments'])
    if (block.type !== 'tool-call' || !text(block.id) || !text(block.name) || typeof block.arguments !== 'string') fail()
  }
}
function liveChunk(chunk) {
  switch (chunk?.type) {
    case 'block-start':
      closed(chunk, ['type', 'index', 'blockType'])
      if (!count(chunk.index) || !['text', 'tool-call'].includes(chunk.blockType)) fail()
      break
    case 'text-delta':
      closed(chunk, ['type', 'index', 'text']); if (!count(chunk.index) || typeof chunk.text !== 'string') fail()
      break
    case 'tool-call-delta':
      closed(chunk, ['type', 'index', 'id', 'argumentsDelta'], ['name'])
      if (!count(chunk.index) || !text(chunk.id) || typeof chunk.argumentsDelta !== 'string' || (Object.hasOwn(chunk, 'name') && !text(chunk.name))) fail()
      break
    case 'block-end':
      closed(chunk, ['type', 'index', 'block']); if (!count(chunk.index)) fail(); liveBlock(chunk.block)
      break
    case 'finish':
      closed(chunk, ['type', 'reason']); closed(chunk.reason, ['kind'])
      if (!['stop', 'tool-calls', 'max-tokens'].includes(chunk.reason.kind)) fail()
      break
    default: fail()
  }
}
function liveBaseline(value) {
  closed(value, ['revision'], ['activeAttempt']); if (!count(value.revision)) fail()
  if (!Object.hasOwn(value, 'activeAttempt')) return
  const active = value.activeAttempt
  closed(active, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex', 'stream'])
  if (!text(active.attemptId) || !integer(active.startedAfterSeq) || active.startedAfterSeq < -1
    || !count(active.turn) || !count(active.step) || !count(active.nextIndex) || !Array.isArray(active.stream)) fail()
  let members = 0
  for (const record of active.stream) {
    if (record?.type === 'chunk') {
      closed(record, ['type', 'time', 'chunk']); if (!integer(record.time)) fail(); liveChunk(record.chunk); members++
      continue
    }
    const tool = record?.type === 'tool-call-chunks'
    if (!tool && record?.type !== 'text-chunks') fail()
    closed(record, tool ? ['type', 'time0', 'index', 'dt', 'id', 'args'] : ['type', 'time0', 'index', 'dt', 'texts'], tool ? ['name'] : [])
    const values = tool ? record.args : record.texts
    if (!count(record.index) || !integer(record.time0) || !Array.isArray(record.dt) || !record.dt.every(integer)
      || !Array.isArray(values) || values.length === 0 || values.length !== record.dt.length + 1 || !values.every(value => typeof value === 'string')
      || (tool && (!text(record.id) || (Object.hasOwn(record, 'name') && !text(record.name))))) fail()
    members += values.length
    if (!count(members)) fail()
  }
  if (members !== active.nextIndex) fail()
}
function liveFrame(value) {
  if (value?.type === 'start') {
    closed(value, ['type', 'revision', 'attemptId', 'startedAfterSeq', 'turn', 'step'])
    if (!integer(value.startedAfterSeq) || value.startedAfterSeq < -1 || !count(value.turn) || !count(value.step)) fail()
  } else if (value?.type === 'chunk') {
    closed(value, ['type', 'revision', 'attemptId', 'index', 'time', 'chunk'])
    if (!count(value.index) || !integer(value.time)) fail(); liveChunk(value.chunk)
  } else if (value?.type === 'end') {
    closed(value, ['type', 'revision', 'attemptId', 'index', 'outcome'])
    if (!count(value.index)) fail()
    if (value.outcome?.kind === 'abandoned') closed(value.outcome, ['kind'])
    else {
      closed(value.outcome, ['kind', 'eventType', 'seq'])
      if (value.outcome.kind !== 'committed' || !['assistant/message', 'assistant/attempt'].includes(value.outcome.eventType) || !count(value.outcome.seq)) fail()
    }
  } else fail()
  if (!count(value.revision) || !text(value.attemptId)) fail()
}

/**
 * Read explicitly negotiated live replies before opaque version mapping. Native content assembly stays in its owner.
 * @param {object} value - untrusted source frame from the derived-live carrier.
 * @param {object} ref - exact binding reference.
 * @param {{generation:number,grantRevision:number}} authority - immutable binding authority.
 * @returns {Readonly<object>} detached reviewed frame; dense stream checks remain in the carrier and native Client reader.
 */
export function parseLiveHistoryReplyFrame(value, ref, authority) {
  if (jsonByteLength(value) > PROTOCOL_LIMITS.maxFrameBytes) fail()
  let result
  if (value?.type === 'snapshot') {
    closed(value, ['type', 'page', 'header', 'projections', 'assistantStream'])
    liveBaseline(value.assistantStream)
    const { assistantStream, ...base } = value
    const snapshot = parseHistoryReplyFrame(base, ref, NATIVE_HISTORY_FORMATS.DETAILS)
    if (assistantStream.activeAttempt?.startedAfterSeq > snapshot.page.throughSeq) fail()
    result = { ...snapshot, assistantStream }
  } else if (value?.type === 'assistant-stream') {
    closed(value, ['type', 'generation', 'grantRevision', 'frame'])
    if (!count(value.generation) || !count(value.grantRevision)) fail()
    liveFrame(value.frame); result = value
  } else result = parseHistoryReplyFrame(value, ref, NATIVE_HISTORY_FORMATS.DETAILS)
  const scoped = result.type === 'snapshot' ? result.page : result
  if (scoped.generation !== authority.generation || scoped.grantRevision !== authority.grantRevision) fail()
  return Object.freeze(JSON.parse(canonicalJson(result)))
}
