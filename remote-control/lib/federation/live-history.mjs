/** Instance-owned grant filtering of native Assistant frames; content assembly stays in the native owner. */
import { isDeepStrictEqual } from 'node:util'
import { FederationContractError } from './identity.mjs'
import { canonicalJson } from './journal.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS } from './protocol.mjs'

const MESSAGE = 'native live history projection failed'
const PRIVATE_BLOCKS = new Set(['reasoning', 'image', 'file', 'tool-addition', 'tool-removal'])
class ProjectionFailure extends Error {
  constructor(code) { super(MESSAGE); this.code = code }
}
const fail = (code = FAILURE_CODES.INVALID_MESSAGE) => { throw new ProjectionFailure(code) }
const integer = value => Number.isSafeInteger(value) && !Object.is(value, -0)
const count = value => integer(value) && value >= 0
const cursor = value => integer(value) && value >= -1
const text = value => typeof value === 'string'
const name = value => text(value) && value.length > 0
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
function valueOf(value, key) {
  if (!object(value)) fail()
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail()
  return descriptor.value
}
function fields(value, required, optional = []) {
  if (!object(value)) fail()
  const keys = Reflect.ownKeys(value)
  if (required.some(key => !Object.hasOwn(value, key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) fail()
}
function encoded(value) { return canonicalJson(value) }
function bytes(value) { return Buffer.byteLength(encoded(value), 'utf8') }
function detached(value) { return JSON.parse(encoded(value)) }
function freeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const member of Object.values(value)) freeze(member)
    Object.freeze(value)
  }
  return value
}
function blockKind(value) {
  if (value !== 'text' && value !== 'tool-call' && !PRIVATE_BLOCKS.has(value)) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
  return value
}

/**
 * Create one projector for one native follow generation and immutable grant decision.
 * @param {import('./live-history.mjs').LiveHistoryProjectorOptions} options - exact native owner callbacks and complete-envelope budget wrappers.
 * @returns {import('./live-history.mjs').LiveHistoryProjector} a pure synchronous projector; any failure retires the instance.
 */
export function createLiveHistoryProjector(options) {
  const { exportClasses, nativeExpand, nativeAssistantBlocks, nativeCreateCompactor, wrapBaseline, wrapFrame } = options
  if (!Array.isArray(exportClasses) || exportClasses.some(item => typeof item !== 'string')
    || [nativeExpand, nativeAssistantBlocks, nativeCreateCompactor, wrapBaseline, wrapFrame].some(item => typeof item !== 'function')) {
    throw new FederationContractError(FAILURE_CODES.INVALID_MESSAGE, MESSAGE)
  }
  const assistant = exportClasses.includes('conversation.assistant')
  const tools = assistant && exportClasses.includes('tool.call')
  let opened = false, closed = false, nativeRevision = 0, exportRevision = 0, active
  const visible = kind => kind === 'text' || (kind === 'tool-call' && tools)
  const close = () => { closed = true; active = undefined }
  const guarded = operation => {
    try {
      if (closed) fail(FAILURE_CODES.SOURCE_UNAVAILABLE)
      return operation()
    } catch (error) {
      const code = error instanceof ProjectionFailure ? error.code : FAILURE_CODES.INVALID_MESSAGE
      close()
      // Native callbacks, getters, JSON errors and wrappers may contain private diagnostics.
      throw new FederationContractError(code, MESSAGE)
    }
  }
  const budget = (payload, wrap) => {
    const result = freeze(detached(payload))
    if (bytes(wrap(result)) > PROTOCOL_LIMITS.maxFrameBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE)
    return result
  }
  const frame = payload => {
    if (!count(exportRevision + 1)) fail(FAILURE_CODES.HISTORY_GAP)
    const result = budget({ ...payload, revision: exportRevision + 1 }, wrapFrame)
    exportRevision++
    return Object.freeze([result])
  }
  const charge = (attempt, amount) => {
    if (!count(amount) || attempt.retainedBytes + amount > PROTOCOL_LIMITS.maxFollowBufferBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE)
    attempt.retainedBytes += amount
  }
  const attempt = (source, nextIndex = 0) => {
    const identity = {
      attemptId: valueOf(source, 'attemptId'), startedAfterSeq: valueOf(source, 'startedAfterSeq'),
      turn: valueOf(source, 'turn'), step: valueOf(source, 'step'),
    }
    if (!name(identity.attemptId) || !cursor(identity.startedAfterSeq) || !count(identity.turn) || !count(identity.step) || !count(nextIndex)) fail()
    const result = { ...identity, nativeNext: nextIndex, exportNext: 0, exportBlocks: 0, retainedBytes: 0, groups: new Map() }
    if (assistant) {
      result.original = nativeCreateCompactor()
      result.projected = nativeCreateCompactor()
      for (const compact of [result.original, result.projected]) {
        if (!compact || typeof compact.push !== 'function' || typeof compact.snapshot !== 'function') fail()
      }
      if (result.original === result.projected) fail()
    }
    return result
  }
  const publicBlock = block => {
    const type = blockKind(valueOf(block, 'type'))
    if (!visible(type)) return undefined
    if (type === 'text') {
      const content = valueOf(block, 'text')
      if (!text(content)) fail()
      return { type, text: content }
    }
    const id = valueOf(block, 'id'), tool = valueOf(block, 'name'), args = valueOf(block, 'arguments')
    if (!name(id) || !name(tool) || !text(args)) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
    return { type, id, name: tool, arguments: args }
  }
  const publicBlocks = blocks => {
    if (!Array.isArray(blocks)) fail()
    return blocks.flatMap(block => { const projected = publicBlock(block); return projected === undefined ? [] : [projected] })
  }
  const prove = (current, interrupted, expected) => {
    // This is called only at opening/terminal cuts, never for individual live chunks.
    for (const group of current.groups.values()) {
      if (!interrupted && group.type === 'tool-call' && group.exportIndex !== undefined && (!name(group.id) || !name(group.name))) {
        fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
      }
    }
    const original = current.original.snapshot(), projected = current.projected.snapshot()
    if (bytes(original) + bytes(projected) > PROTOCOL_LIMITS.maxFollowBufferBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE)
    const left = publicBlocks(nativeAssistantBlocks(original, interrupted))
    const right = publicBlocks(nativeAssistantBlocks(projected, interrupted))
    if (!isDeepStrictEqual(left, right) || (expected !== undefined && !isDeepStrictEqual(right, expected))) {
      fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
    }
    return { stream: projected, blocks: right }
  }
  const projectChunk = (current, time, chunk) => {
    if (!integer(time)) fail()
    const type = valueOf(chunk, 'type')
    if (type === 'usage') { fields(chunk, ['type', 'usage']); return undefined }
    if (type === 'finish') {
      fields(chunk, ['type', 'reason'], ['replayState'])
      const kind = valueOf(valueOf(chunk, 'reason'), 'kind')
      if (!['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(kind)) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
      // Failure details and replay state are never read. Abandonment/settlement retires interrupted presentation.
      if (kind === 'aborted' || kind === 'error') return undefined
      const safe = { type, reason: { kind } }, timed = { time, chunk: safe }
      charge(current, 2 * bytes(timed))
      current.original.push(timed); current.projected.push(detached(timed))
      current.exportNext++
      return safe
    }
    if (!['block-start', 'text-delta', 'reasoning-delta', 'tool-call-delta', 'block-end'].includes(type)) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
    const index = valueOf(chunk, 'index')
    if (!count(index)) fail()
    let group = current.groups.get(index)
    // Native first-close authority makes every later payload at this index irrelevant.
    if (group?.closed) return undefined
    let kind
    if (type === 'block-start') { fields(chunk, ['type', 'index', 'blockType']); kind = blockKind(valueOf(chunk, 'blockType')) }
    else if (type === 'block-end') { fields(chunk, ['type', 'index', 'block']); kind = blockKind(valueOf(valueOf(chunk, 'block'), 'type')) }
    else if (type === 'tool-call-delta') { fields(chunk, ['type', 'index', 'id', 'argumentsDelta'], ['name']); kind = 'tool-call' }
    else { fields(chunk, ['type', 'index', 'text']); kind = type === 'text-delta' ? 'text' : 'reasoning' }
    if (group === undefined) {
      if (current.groups.size >= PROTOCOL_LIMITS.maxFollowBufferEvents) fail(FAILURE_CODES.PAGE_TOO_LARGE)
      group = { type: kind, closed: false, ...(visible(kind) ? { exportIndex: current.exportBlocks++ } : {}) }
      charge(current, bytes({ index, ...group }))
      current.groups.set(index, group)
    } else if (group.type !== kind && (visible(group.type) || visible(kind))) {
      fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
    }
    if (type === 'block-end') group.closed = true
    if (group.exportIndex === undefined) return undefined
    let safe
    if (type === 'block-start') safe = { type, index, blockType: kind }
    else if (type === 'text-delta') {
      const delta = valueOf(chunk, 'text')
      if (!text(delta)) fail()
      safe = { type, index, text: delta }
    } else if (type === 'tool-call-delta') {
      const id = valueOf(chunk, 'id'), args = valueOf(chunk, 'argumentsDelta')
      const tool = Object.hasOwn(chunk, 'name') ? valueOf(chunk, 'name') : undefined
      if (!name(id) || !text(args) || (tool !== undefined && !name(tool))) fail()
      if ((group.id !== undefined && group.id !== id) || (group.name !== undefined && tool !== undefined && group.name !== tool)) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
      if (group.id === undefined) charge(current, bytes(id))
      if (group.name === undefined && tool !== undefined) charge(current, bytes(tool))
      group.id = id
      if (tool !== undefined) group.name = tool
      safe = { type, index, id, argumentsDelta: args, ...(tool === undefined ? {} : { name: tool }) }
    } else if (type === 'block-end') {
      const block = publicBlock(valueOf(chunk, 'block'))
      if (block === undefined) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
      if (kind === 'tool-call') {
        if ((group.id !== undefined && group.id !== block.id) || (group.name !== undefined && group.name !== block.name)) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
        if (group.id === undefined) charge(current, bytes(block.id))
        if (group.name === undefined) charge(current, bytes(block.name))
        group.id = block.id; group.name = block.name
      }
      safe = { type, index, block }
    } else fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
    const projected = { ...safe, index: group.exportIndex }
    const originalTimed = { time, chunk: safe }, projectedTimed = { time, chunk: projected }
    charge(current, bytes(originalTimed) + bytes(projectedTimed))
    current.original.push(detached(originalTimed)); current.projected.push(detached(projectedTimed))
    current.exportNext++
    return projected
  }
  const settlement = (source, outcome, current) => {
    fields(source, ['eventType', 'seq', 'turn', 'step', 'record'])
    for (const key of ['eventType', 'seq']) if (valueOf(source, key) !== valueOf(outcome, key)) fail(FAILURE_CODES.HISTORY_GAP)
    if (valueOf(source, 'turn') !== current.turn || valueOf(source, 'step') !== current.step
      || valueOf(outcome, 'seq') <= current.startedAfterSeq) fail(FAILURE_CODES.HISTORY_GAP)
    const record = valueOf(source, 'record'), recordType = valueOf(record, 'type')
    if (recordType === 'withheld') {
      fields(record, ['type', 'firstSeq', 'lastSeq', 'reason'])
      const first = valueOf(record, 'firstSeq'), last = valueOf(record, 'lastSeq')
      if (!count(first) || !count(last) || first > valueOf(outcome, 'seq') || last < valueOf(outcome, 'seq')
        || valueOf(record, 'reason') !== 'policy') fail(FAILURE_CODES.HISTORY_GAP)
      return { visible: false, interrupted: true }
    }
    if (recordType !== 'event') fail(FAILURE_CODES.HISTORY_GAP)
    fields(record, ['type', 'event'], ['redacted'])
    const event = valueOf(record, 'event'), data = valueOf(event, 'data')
    if (valueOf(event, 'type') !== valueOf(outcome, 'eventType') || valueOf(event, 'seq') !== valueOf(outcome, 'seq')
      || valueOf(data, 'turn') !== current.turn || valueOf(data, 'step') !== current.step) fail(FAILURE_CODES.HISTORY_GAP)
    const interrupted = valueOf(event, 'type') === 'assistant/attempt'
      || (Object.hasOwn(data, 'interrupted') && valueOf(data, 'interrupted') === true)
    const expected = valueOf(event, 'type') === 'assistant/message'
      ? publicBlocks(valueOf(valueOf(data, 'message'), 'content')) : undefined
    return { visible: true, interrupted, expected }
  }
  return Object.freeze({
    open(baseline) {
      return guarded(() => {
        if (opened) fail(FAILURE_CODES.HISTORY_GAP)
        fields(baseline, ['revision'], ['activeAttempt'])
        const revision = valueOf(baseline, 'revision')
        if (!count(revision)) fail()
        let opening
        if (Object.hasOwn(baseline, 'activeAttempt')) {
          const source = valueOf(baseline, 'activeAttempt')
          fields(source, ['attemptId', 'startedAfterSeq', 'turn', 'step', 'nextIndex', 'stream'])
          const nextIndex = valueOf(source, 'nextIndex')
          if (!count(nextIndex)) fail()
          active = attempt(source)
          if (assistant) {
            const stream = valueOf(source, 'stream')
            if (bytes(stream) > PROTOCOL_LIMITS.maxFollowBufferBytes) fail(FAILURE_CODES.PAGE_TOO_LARGE)
            const members = nativeExpand(stream)
            if (!Array.isArray(members) || members.length !== nextIndex) fail(FAILURE_CODES.HISTORY_GAP)
            for (const member of members) {
              fields(member, ['time', 'chunk'])
              projectChunk(active, valueOf(member, 'time'), valueOf(member, 'chunk'))
            }
            const proof = prove(active, false)
            if (!isDeepStrictEqual(proof.blocks, publicBlocks(nativeAssistantBlocks(stream, false)))) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED)
            opening = { attemptId: active.attemptId, startedAfterSeq: active.startedAfterSeq, turn: active.turn, step: active.step,
              nextIndex: active.exportNext, stream: proof.stream }
          }
          active.nativeNext = nextIndex
        }
        const result = budget({ revision: 0, ...(opening === undefined ? {} : { activeAttempt: opening }) }, wrapBaseline)
        nativeRevision = revision; exportRevision = 0; opened = true
        return result
      })
    },
    accept(input, committed) {
      return guarded(() => {
        if (!opened) fail(FAILURE_CODES.HISTORY_GAP)
        const type = valueOf(input, 'type'), revision = valueOf(input, 'revision'), id = valueOf(input, 'attemptId')
        if (!count(revision) || revision !== nativeRevision + 1 || !name(id)) fail(FAILURE_CODES.HISTORY_GAP)
        let result = Object.freeze([])
        if (type === 'start') {
          fields(input, ['type', 'attemptId', 'revision', 'startedAfterSeq', 'turn', 'step'])
          if (active !== undefined) fail(FAILURE_CODES.HISTORY_GAP)
          active = attempt(input)
          if (assistant) result = frame({ type, attemptId: id, startedAfterSeq: active.startedAfterSeq, turn: active.turn, step: active.step })
        } else {
          if (active === undefined || active.attemptId !== id) fail(FAILURE_CODES.HISTORY_GAP)
          const index = valueOf(input, 'index')
          if (!count(index) || index !== active.nativeNext) fail(FAILURE_CODES.HISTORY_GAP)
          if (type === 'chunk') {
            fields(input, ['type', 'attemptId', 'revision', 'index', 'time', 'chunk'])
            const time = valueOf(input, 'time')
            if (!integer(time)) fail()
            if (assistant) {
              const chunk = projectChunk(active, time, valueOf(input, 'chunk'))
              if (chunk !== undefined) result = frame({ type, attemptId: id, index: active.exportNext - 1, time, chunk })
            }
            if (!count(active.nativeNext + 1)) fail(FAILURE_CODES.HISTORY_GAP)
            active.nativeNext++
          } else if (type === 'end') {
            fields(input, ['type', 'attemptId', 'revision', 'index', 'outcome'])
            const outcome = valueOf(input, 'outcome'), kind = valueOf(outcome, 'kind')
            if (kind === 'committed') {
              fields(outcome, ['kind', 'eventType', 'seq'])
              if (!['assistant/message', 'assistant/attempt'].includes(valueOf(outcome, 'eventType')) || !count(valueOf(outcome, 'seq'))) fail()
            } else if (kind === 'abandoned') fields(outcome, ['kind'])
            else fail()
            if (assistant) {
              const proof = kind === 'committed' ? settlement(committed, outcome, active) : { visible: false, interrupted: true }
              prove(active, proof.interrupted, proof.expected)
              result = frame({ type, attemptId: id, index: active.exportNext,
                outcome: proof.visible ? { kind: 'committed', eventType: valueOf(outcome, 'eventType'), seq: valueOf(outcome, 'seq') } : { kind: 'abandoned' } })
            }
            active = undefined
          } else fail()
        }
        nativeRevision = revision
        return result
      })
    },
    close,
  })
}
