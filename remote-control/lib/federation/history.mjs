/**
 * Federation native visible history: schema-aware export projection, withheld coverage,
 * and bounded passive read pages.
 *
 * The Worker's durable `SessionEvent` log is the only source. Each permitted event keeps
 * its native `seq`/`time`/turn/step identity; intentionally unexported events become
 * explicit `withheld` ranges, never invented assistant/user text or native blocks.
 * Known mixed content exports permitted text plus carrier-only redaction metadata.
 * Native owner assembly proves first-seen index correspondence and the genuine
 * filtered compact stream; no assembler algorithm is duplicated here. Unknown or
 * unprovable content, injected context and unsafe reason variants withhold whole.
 * Required genuine native assistant streams remain present.
 * Hidden surface replacements fail with export-policy-unsupported pending a safe
 * reader. Worker validates the complete native log before policy projection.
 * Follow transport is passive and never activates an Agent.
 *
 * This module is pure: no I/O, no configuration, no process state.
 *
 * @module dsh-remote-control/federation/history
 */

import { isDeepStrictEqual } from 'node:util'
import { projectToolEvent } from './tool-history.mjs'
import { parseMetricsProjection } from './metrics.mjs'
import { sourceFileRef, sourceImageRef } from './file-codec.mjs'
import { FederationContractError, parseMachineKey, parseProjectId, parseSessionId } from './identity.mjs'
import { REVIEWED_EXPORT_CLASSES, evaluateGrant, parseGrant, requireReviewedExportClass } from './grants.mjs'
import {
  FAILURE_CODES,
  PROTOCOL_LIMITS,
  NATIVE_HISTORY_FORMATS,
  decodeExportCursor,
  encodeExportCursor,
  jsonByteLength,
} from './protocol.mjs'

/** Reviewed export classes for this projection; everything else is withheld by policy. */
export const HISTORY_REVIEWED_CLASSES = Object.freeze([...REVIEWED_EXPORT_CLASSES])

/** Explicit maximum page size kept well below the transport plaintext cap. */
const MAX_PAGE_BYTES = PROTOCOL_LIMITS.maxPageBytes

const EVENT_CLASS = Object.freeze({
  'user/message': 'conversation.user',
  'assistant/message': 'conversation.assistant',
  'system/message': 'conversation.system',
  'developer/message': 'conversation.developer',
  'tool/call': 'tool.call',
  'tool/result': 'tool.result',
  'turn/start': 'turn',
  'turn/end': 'turn',
  'step/start': 'turn',
  'step/end': 'turn',
  'model/selection': 'model.selection',
  'session/title': 'title',
  'todo/write': 'todo',
  'goal/change': 'goal',
  'usage': 'usage',
  'assistant/attempt': 'unknown',
})

const REVIEWED_CLASS_SET = new Set(HISTORY_REVIEWED_CLASSES)
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message', 'tool/result'])

const fail = (code, message, detail) => { throw new FederationContractError(code, message, detail) }
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const isSafeInteger = value => Number.isSafeInteger(value)
const isNonNegativeInteger = value => Number.isSafeInteger(value) && value >= 0

function freezeDeep(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

function assertRecord(value, subject, required, optional = []) {
  if (!isRecord(value)) fail(FAILURE_CODES.INVALID_MESSAGE, `${subject} must be a plain JSON object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(FAILURE_CODES.INVALID_MESSAGE, `${subject} carries unknown field "${key}"`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(FAILURE_CODES.INVALID_MESSAGE, `${subject} requires "${key}"`)
  }
  return value
}

/** Classify one native Session event; unknown types are `unknown`, which is denied by default. */
export function classOf(eventType) {
  return Object.hasOwn(EVENT_CLASS, eventType) ? EVENT_CLASS[eventType] : 'unknown'
}

function toolCallBlock(block) {
  if (!isRecord(block) || block.type !== 'tool-call' || !nonempty(block.id) || !nonempty(block.name) || typeof block.arguments !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native tool-call block')
  return { type: 'tool-call', id: block.id, name: block.name, arguments: block.arguments }
}

function projectedContent(content, includeToolCalls, includeFiles = false, includeImages = false) {
  return content.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }]
    : includeToolCalls && block.type === 'tool-call' ? [toolCallBlock(block)]
      : includeFiles && block.type === 'file' ? [{ type: 'file', attachment: sourceFileRef(block.attachment) }]
        : includeFiles && includeImages && block.type === 'image' ? [{ type: 'image', attachment: sourceImageRef(block.attachment) }] : [])
}

function projectMessage(message, role, includeToolCalls = false, includeFiles = false, includeImages = false) {
  assertRecord(message, `${role} message`, ['id', 'content', 'role', 'source'])
  if (typeof message.id !== 'string' || message.id.length === 0 || message.role !== role) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native message identity/role')
  if (!isRecord(message.source) || typeof message.source.kind !== 'string' || !message.source.kind) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native message source')
  if (!Array.isArray(message.content)) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native message content')
  for (const block of message.content) {
    if (!isRecord(block) || typeof block.type !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native block')
    if (block.type === 'text' && typeof block.text !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native text')
  }
  if (role === 'assistant' && (message.source.kind !== 'model' || !nonempty(message.source.provider) || !nonempty(message.source.model))) fail(FAILURE_CODES.INVALID_MESSAGE, 'assistant requires native provider/model source')
  if (role === 'user' && message.source.kind !== 'user') return null
  if (message.content.some(block => !KNOWN_CONTENT_TYPES.has(block.type))) return null
  const source = role === 'user' ? { kind: 'user' } : { kind: 'model', provider: message.source.provider, model: message.source.model }
  const content = projectedContent(message.content, role === 'assistant' && includeToolCalls, role === 'user' && includeFiles, role === 'user' && includeImages)
  const projected = { id: message.id, role, source, content }
  return { message: projected, redacted: !isDeepStrictEqual(projected, message) }
}

const nonempty = value => typeof value === 'string' && value.length > 0

const KNOWN_CONTENT_TYPES = new Set(['text', 'reasoning', 'tool-call', 'image', 'file', 'tool-addition', 'tool-removal'])

function validateRun(row) {
  const tool = row.type === 'tool-call-chunks'
  assertRecord(row, 'native compact run', ['type', 'time0', 'index', 'dt', tool ? 'args' : 'texts', ...(tool ? ['id'] : [])], tool ? ['name'] : [])
  const members = tool ? row.args : row.texts
  if (!isSafeInteger(row.time0) || !isNonNegativeInteger(row.index) || !Array.isArray(members)
    || members.length === 0 || !members.every(text => typeof text === 'string')
    || !Array.isArray(row.dt) || row.dt.length !== members.length - 1 || !row.dt.every(isSafeInteger)
    || (tool && (!nonempty(row.id) || (row.name !== undefined && !nonempty(row.name))))) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native compact run')
  let time = row.time0
  for (const dt of row.dt) { time += dt; if (!isSafeInteger(time)) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native stream time') }
}

function nativeBlocks(assemble, stream, interrupted) {
  try {
    const blocks = assemble(stream, interrupted)
    if (!Array.isArray(blocks)) fail(FAILURE_CODES.INVALID_MESSAGE, 'native assembler must be synchronous')
    return blocks
  } catch (error) {
    // Adapter exceptions can contain private source values; no raw diagnostic leaves here.
    fail(FAILURE_CODES.INVALID_MESSAGE, 'native assistant assembly failed')
  }
}

/** Retain granted text/tool-call records, proving first-seen correspondence with the native owner. */
function textStream(stream, originalContent, interrupted, assemble, includeToolCalls = false) {
  if (!Array.isArray(stream)) fail(FAILURE_CODES.INVALID_MESSAGE, 'native assistant stream is required')
  if (typeof assemble !== 'function') fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED, 'Worker native assistant assembler is required')
  const groups = new Map()
  let lastFinish
  for (const row of stream) {
    if (!isRecord(row) || typeof row.type !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native compact record')
    let index
    if (['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(row.type)) {
      validateRun(row)
      index = row.index
    } else if (row.type === 'chunk') {
      assertRecord(row, 'native raw record', ['type', 'time', 'chunk'])
      if (!isSafeInteger(row.time) || !isRecord(row.chunk)) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native raw record')
      const chunk = row.chunk
      if (chunk.type === 'block-start') {
        assertRecord(chunk, 'native block start', ['type', 'index', 'blockType'])
        if (!KNOWN_CONTENT_TYPES.has(chunk.blockType)) return null
        index = chunk.index
      } else if (chunk.type === 'block-end') {
        assertRecord(chunk, 'native block end', ['type', 'index', 'block'])
        if (!isRecord(chunk.block) || !KNOWN_CONTENT_TYPES.has(chunk.block.type)) return null
        if (chunk.block.type === 'text' && typeof chunk.block.text !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native text block end')
        index = chunk.index
      } else if (includeToolCalls && chunk.type === 'tool-call-delta') {
        assertRecord(chunk, 'native tool-call delta', ['type', 'index', 'id', 'argumentsDelta'], ['name'])
        if (!nonempty(chunk.id) || typeof chunk.argumentsDelta !== 'string' || (chunk.name !== undefined && !nonempty(chunk.name))) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native tool-call delta')
        index = chunk.index
      } else if (includeToolCalls && chunk.type === 'text-delta') {
        assertRecord(chunk, 'native text delta', ['type', 'index', 'text'])
        if (typeof chunk.text !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native text delta')
        index = chunk.index
      } else if (chunk.type === 'finish') {
        if (!isRecord(chunk.reason) || !['stop', 'tool-calls', 'max-tokens', 'aborted', 'error'].includes(chunk.reason.kind)) return null
        lastFinish = row
      } else if (chunk.type !== 'usage') return null
    } else return null
    if (index !== undefined) {
      if (!isNonNegativeInteger(index)) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native block index')
      if (!groups.has(index)) groups.set(index, [])
      groups.get(index).push(row)
    }
  }
  const originalBlocks = nativeBlocks(assemble, stream, interrupted)
  if (!isDeepStrictEqual(originalBlocks, originalContent)) return null
  // Map insertion follows native first-seen order, NOT numeric index or content offset.
  const canonicalByIndex = []
  const indexMap = new Map()
  let nextBlock = 0
  for (const [index, rows] of groups) {
    const blocks = nativeBlocks(assemble, lastFinish === undefined ? rows : [...rows, lastFinish], interrupted)
    if (blocks.length > 1) return null
    canonicalByIndex.push(...blocks)
    if (blocks.length === 1 && (blocks[0].type === 'text' || (includeToolCalls && blocks[0].type === 'tool-call'))) indexMap.set(index, nextBlock++)
  }
  if (!isDeepStrictEqual(canonicalByIndex, originalBlocks)) return null
  const projected = []
  const closed = new Set()
  for (const row of stream) {
    const originalIndex = row.type === 'chunk' ? row.chunk.index : row.index
    // Native first-close authority ignores all later deltas/re-closes at this index;
    // ignored payloads are not established visible content and must not be exported.
    if (closed.has(originalIndex)) continue
    if (row.type === 'chunk' && row.chunk.type === 'block-end') closed.add(originalIndex)
    const index = indexMap.get(originalIndex)
    if (index === undefined) continue
    if (row.type === 'text-chunks') {
      projected.push({ type: row.type, time0: row.time0, index, dt: [...row.dt], texts: [...row.texts] })
    } else if (includeToolCalls && row.type === 'tool-call-chunks') {
      projected.push({ type: row.type, time0: row.time0, index, dt: [...row.dt], id: row.id, ...(row.name === undefined ? {} : { name: row.name }), args: [...row.args] })
    } else if (row.type === 'chunk' && row.chunk.type === 'block-start' && (row.chunk.blockType === 'text' || (includeToolCalls && row.chunk.blockType === 'tool-call'))) {
      projected.push({ type: 'chunk', time: row.time, chunk: { type: 'block-start', index, blockType: row.chunk.blockType } })
    } else if (row.type === 'chunk' && row.chunk.type === 'block-end' && (row.chunk.block.type === 'text' || (includeToolCalls && row.chunk.block.type === 'tool-call'))) {
      const block = row.chunk.block.type === 'text' ? { type: 'text', text: row.chunk.block.text } : toolCallBlock(row.chunk.block)
      projected.push({ type: 'chunk', time: row.time, chunk: { type: 'block-end', index, block } })
    } else if (includeToolCalls && row.type === 'chunk' && row.chunk.type === 'text-delta') {
      projected.push({ type: 'chunk', time: row.time, chunk: { type: 'text-delta', index, text: row.chunk.text } })
    } else if (includeToolCalls && row.type === 'chunk' && row.chunk.type === 'tool-call-delta') {
      projected.push({ type: 'chunk', time: row.time, chunk: { type: 'tool-call-delta', index, id: row.chunk.id, argumentsDelta: row.chunk.argumentsDelta, ...(row.chunk.name === undefined ? {} : { name: row.chunk.name }) } })
    }
  }
  const allowedContent = projectedContent(originalContent, includeToolCalls)
  if (!isDeepStrictEqual(nativeBlocks(assemble, projected, interrupted), allowedContent)) return null
  return { stream: projected, redacted: !isDeepStrictEqual(projected, stream) }
}

function projectSurfaceMeta(event, projected) {
  const meta = {}
  if (event.surfaceOp !== undefined) {
    if (event.surfaceOp === 'append') meta.surfaceOp = 'append'
    else if (isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace'
      && Object.keys(event.surfaceOp).length === 3
      && isNonNegativeInteger(event.surfaceOp.startSeq) && isNonNegativeInteger(event.surfaceOp.endSeq)
      && event.surfaceOp.startSeq < event.seq && event.surfaceOp.endSeq < event.seq) {
      meta.surfaceOp = { op: 'replace', startSeq: event.surfaceOp.startSeq, endSeq: event.surfaceOp.endSeq }
    } else fail(FAILURE_CODES.INVALID_MESSAGE, 'event surfaceOp is invalid')
  }
  if (event.sourceEventSeqs !== undefined) {
    if (!Array.isArray(event.sourceEventSeqs) || !event.sourceEventSeqs.every(seq => isSafeInteger(seq) && seq >= 0)) {
      fail(FAILURE_CODES.INVALID_MESSAGE, 'event sourceEventSeqs is invalid')
    }
    meta.sourceEventSeqs = [...event.sourceEventSeqs]
  }
  return { ...meta, data: projected.data }
}

function projectTurnReason(reason) {
  if (!isRecord(reason) || typeof reason.kind !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'turn end reason is invalid')
  if (!['completed', 'blocked', 'max-tokens', 'interrupted', 'forked'].includes(reason.kind)) return null
  assertRecord(reason, 'native turn reason', ['kind'])
  return { kind: reason.kind }
}

/**
 * Project one permitted native event through its owning schema.
 * @param {unknown} event - native Session event already admitted by its owning validator; low-level projection is not native input validation.
 * @param {{ exportClasses: readonly string[], nativeAssistantBlocks?: (stream: readonly object[], interrupted: boolean) => readonly object[], format?: 'legacy'|'native-details-v1', toolName?:string, nativeImages?:true }} options - granted classes, Worker-native assembly, negotiated interpretation and earlier native call name; never copied from wire.
 * @returns {Readonly<object>} frozen projected event plus a `withheld` flag.
 */
export function projectEvent(event, { exportClasses, nativeAssistantBlocks, format = NATIVE_HISTORY_FORMATS.LEGACY, toolName, nativeImages }) {
  if (!Object.values(NATIVE_HISTORY_FORMATS).includes(format)) fail(FAILURE_CODES.INVALID_MESSAGE, 'unsupported native history format')
  const includeToolCalls = format === NATIVE_HISTORY_FORMATS.DETAILS && exportClasses.includes('tool.call')
  if (!isRecord(event)) fail(FAILURE_CODES.INVALID_MESSAGE, 'event must be a plain JSON object')
  if (typeof event.type !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'event type is invalid')
  if (!isNonNegativeInteger(event.seq)) fail(FAILURE_CODES.INVALID_MESSAGE, 'event seq is invalid')
  if (!isSafeInteger(event.time)) fail(FAILURE_CODES.INVALID_MESSAGE, 'event time is invalid')
  const classOfEvent = classOf(event.type)
  const withheld = () => {
    if (isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace') fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED, 'policy-hidden surface replacement requires a reviewed reader')
    return Object.freeze({ withheld: true, seq: event.seq, class: classOfEvent })
  }
  const requested = new Set(exportClasses)
  if (format !== NATIVE_HISTORY_FORMATS.DETAILS && ['tool/call', 'tool/result'].includes(event.type)) return withheld()
  if (!requested.has(classOfEvent) || !REVIEWED_CLASS_SET.has(classOfEvent)) return withheld()
  requireReviewedExportClass(classOfEvent)
  if (SURFACE_EVENT_TYPES.has(event.type) && event.surfaceOp === undefined) fail(FAILURE_CODES.INVALID_MESSAGE, 'native surfaceOp is required')
  if (event.type === 'assistant/message' && event.sourceEventSeqs !== undefined) fail(FAILURE_CODES.INVALID_MESSAGE, 'native assistant cannot cite sourceEventSeqs')
  if (!isRecord(event.data)) fail(FAILURE_CODES.INVALID_MESSAGE, 'event data must be a plain JSON object')
  if (['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type)) {
    if (!isNonNegativeInteger(event.data.turn) || (event.type.startsWith('step/') && !isNonNegativeInteger(event.data.step))) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native turn/step')
  }
  let projected
  switch (event.type) {
    case 'user/message': {
      const message = projectMessage(event.data, 'user', false, requested.has('files'), nativeImages === true)
      if (message === null) return withheld()
      projected = { data: message.message, redacted: message.redacted }
      break
    }
    case 'assistant/message': {
      assertRecord(event.data, 'assistant message event', ['turn', 'step', 'message', 'stream'], ['usage', 'interrupted'])
      const message = projectMessage(event.data.message, 'assistant', includeToolCalls)
      if (!Array.isArray(event.data.stream)) fail(FAILURE_CODES.INVALID_MESSAGE, 'native assistant stream is required')
      if (!isNonNegativeInteger(event.data.turn) || !isNonNegativeInteger(event.data.step)) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native settlement turn/step')
      if (event.data.interrupted !== undefined && event.data.interrupted !== true) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native interrupted marker')
      if (message === null) return withheld()
      const stream = textStream(event.data.stream, event.data.message.content, event.data.interrupted === true, nativeAssistantBlocks, includeToolCalls)
      if (stream === null) return withheld()
      projected = { data: { turn: event.data.turn, step: event.data.step, message: message.message, stream: stream.stream,
        ...(event.data.interrupted === true ? { interrupted: true } : {}) },
        redacted: message.redacted || stream.redacted || event.data.usage !== undefined }
      break
    }
    case 'tool/call':
    case 'tool/result': {
      const tool = projectToolEvent(event, { toolName })
      if (tool === null) return withheld()
      projected = tool
      break
    }
    case 'turn/start':
      assertRecord(event.data, 'turn start event', ['turn'])
      projected = { data: { turn: event.data.turn }, redacted: false }
      break
    case 'turn/end':
      assertRecord(event.data, 'turn end event', ['turn', 'reason'])
      { const reason = projectTurnReason(event.data.reason)
        if (reason === null) return withheld()
        projected = { data: { turn: event.data.turn, reason } }
      }
      break
    case 'step/start':
    case 'step/end':
      assertRecord(event.data, 'step event', ['turn', 'step'])
      projected = { data: { turn: event.data.turn, step: event.data.step }, redacted: false }
      break
    case 'model/selection':
      assertRecord(event.data, 'model selection event', ['provider', 'model'], ['reasoningEffort'])
      if (!nonempty(event.data.provider) || !nonempty(event.data.model) || (event.data.reasoningEffort !== undefined && !nonempty(event.data.reasoningEffort))) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native model route')
      projected = {
        data: {
          provider: event.data.provider,
          model: event.data.model,
          ...(event.data.reasoningEffort === undefined ? {} : { reasoningEffort: event.data.reasoningEffort }),
        },
        redacted: false,
      }
      break
    case 'session/title':
      assertRecord(event.data, 'session title event', ['title', 'messageSeqs', 'source'])
      if (!nonempty(event.data.title) || !Array.isArray(event.data.messageSeqs) || !event.data.messageSeqs.every(seq => isNonNegativeInteger(seq) && seq < event.seq) || !isRecord(event.data.source)) fail(FAILURE_CODES.INVALID_MESSAGE, 'session title is invalid')
      if (!['fallback', 'user'].includes(event.data.source.kind)) return withheld()
      assertRecord(event.data.source, 'native title source', ['kind'])
      projected = { data: { title: event.data.title, messageSeqs: [...event.data.messageSeqs], source: { kind: event.data.source.kind } } }
      break
    default:
      return withheld()
  }
  const wireEvent = {
    type: event.type,
    seq: event.seq,
    time: event.time,
    ...projectSurfaceMeta(event, projected),
  }
  return Object.freeze({ withheld: false, event: freezeDeep(wireEvent), ...(projected.redacted ? { redacted: true } : {}) })
}

function validateNativeEvents(events) {
  if (!Array.isArray(events)) fail(FAILURE_CODES.INVALID_MESSAGE, 'events must be an array')
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (!isRecord(event) || !isNonNegativeInteger(event.seq) || event.seq !== index) {
      fail(FAILURE_CODES.HISTORY_GAP, 'native event sequence is not contiguous from 0')
    }
  }
  return events
}

function appendOriginMessage(event) {
  return SURFACE_EVENT_TYPES.has(event.type) && event.type !== 'tool/result' && event.surfaceOp === 'append'
}

function pageStart(events, end, maxMessages) {
  let count = 0
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index]
    if (!appendOriginMessage(event)) continue
    count++
    if (count >= maxMessages) {
      let start = event.seq
      if (Array.isArray(event.sourceEventSeqs)) {
        for (const source of event.sourceEventSeqs) if (isSafeInteger(source) && source < start) start = source
      }
      return start
    }
  }
  return 0
}

/** Resolve metadata schemas only from earlier matching calls in the validated original log. */
function toolResultNames(events, throughSeq) {
  const calls = new Map(), results = new Map()
  const key = (data, id) => JSON.stringify([data.turn, data.step, id])
  for (let index = 0; index <= throughSeq; index++) {
    const event = events[index]
    if (event.type === 'tool/call') calls.set(key(event.data, event.data.callId), event.data.name)
    else if (event.type === 'tool/result') {
      const name = calls.get(key(event.data, event.data.message.toolCallId))
      if (name !== undefined) results.set(event.seq, name)
    }
  }
  return results
}

function recordsFor(events, start, end, exportClasses, nativeAssistantBlocks, format, toolNames, nativeImages) {
  const records = []
  let withheld = null
  for (let index = start; index < end; index++) {
    const event = events[index]
    const projected = projectEvent(event, { exportClasses, nativeAssistantBlocks, format, toolName: toolNames?.get(event.seq), nativeImages })
    if (projected.withheld) {
      if (withheld !== null && withheld.lastSeq + 1 === event.seq) withheld.lastSeq = event.seq
      else if (withheld !== null) {
        records.push(withheld)
        withheld = { type: 'withheld', firstSeq: event.seq, lastSeq: event.seq, reason: 'policy' }
      } else withheld = { type: 'withheld', firstSeq: event.seq, lastSeq: event.seq, reason: 'policy' }
      continue
    }
    if (withheld !== null) {
      records.push(withheld)
      withheld = null
    }
    records.push({ type: 'event', event: projected.event, ...(projected.redacted ? { redacted: true } : {}) })
  }
  if (withheld !== null) records.push(withheld)
  return records
}

/**
 * Build one bounded native visible history page.
 *
 * @param {{ machineKey: string, projectId: string, sessionId: string, generation: number,
 *   grantRevision: number, principal: Readonly<object>, grant: unknown, now: number,
 *   events: readonly unknown[], exportClasses: readonly string[],
 *   validateNativeEvents: (events: readonly unknown[]) => void,
 *   nativeAssistantBlocks?: (stream: readonly object[], interrupted: boolean) => readonly object[],
 *   remoteOwnedSessions?: readonly object[],
 *   throughSeq?: number, beforeSeq?: number, fromSeq?: number, maxMessages?: number, maxBytes?: number, format?: 'legacy'|'native-details-v1', nativeImages?:true }} request - Worker-owned context; validator, format and ownership must never be copied from wire args.
 * @returns {Readonly<object>} frozen source history page.
 */
export function buildHistoryPage(request) {
  assertRecord(request, 'history page request', [
    'machineKey', 'projectId', 'sessionId', 'generation', 'grantRevision', 'principal', 'grant', 'now', 'events', 'exportClasses', 'validateNativeEvents',
  ], ['throughSeq', 'beforeSeq', 'maxMessages', 'maxBytes', 'remoteOwnedSessions', 'remoteOwnedProjects', 'nativeAssistantBlocks', 'format', 'fromSeq', 'nativeImages'])
  if (request.nativeImages !== undefined && request.nativeImages !== true) fail(FAILURE_CODES.INVALID_MESSAGE, 'native image projection requires the verified image owner')
  const machineKey = parseMachineKey(request.machineKey)
  const projectId = parseProjectId(request.projectId)
  const sessionId = parseSessionId(request.sessionId)
  if (!isNonNegativeInteger(request.generation) || !isNonNegativeInteger(request.grantRevision) || !isNonNegativeInteger(request.now)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'history generations must be non-negative integers')
  }
  if (!Array.isArray(request.exportClasses) || request.exportClasses.length === 0) {
    fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED, 'history requires at least one export class')
  }
  const grant = parseGrant(request.grant)
  if (grant.machineKey !== machineKey) fail(FAILURE_CODES.NOT_GRANTED, 'grant belongs to another machine')
  const options = { currentRevision: request.grantRevision, now: request.now, ...(request.remoteOwnedSessions === undefined ? {} : { remoteOwnedSessions: request.remoteOwnedSessions }), ...(request.remoteOwnedProjects === undefined ? {} : { remoteOwnedProjects: request.remoteOwnedProjects }) }
  const decision = evaluateGrant(grant, {
    principal: request.principal,
    machineKey,
    action: 'session.read',
    projectId,
    sessionId,
    exportClasses: [...request.exportClasses],
  }, options)
  if (!decision.allowed) fail(FAILURE_CODES.NOT_GRANTED, 'history is not granted', { reason: decision.code })
  const exportClasses = [...decision.exportClasses]
  const events = validateNativeEvents(request.events)
  if (typeof request.validateNativeEvents !== 'function') fail(FAILURE_CODES.INVALID_MESSAGE, 'Worker native log validator is required')
  try {
    const result = request.validateNativeEvents(events)
    if (result !== undefined) fail(FAILURE_CODES.INVALID_MESSAGE, 'native validator must be synchronous and return void')
  } catch (error) {
    // Native diagnostics may contain private payloads; only a stable code crosses export.
    fail(FAILURE_CODES.INVALID_MESSAGE, 'Worker native log validation failed')
  }
  const throughSeq = request.throughSeq === undefined ? (events.length === 0 ? -1 : events.length - 1) : request.throughSeq
  if (!isSafeInteger(throughSeq) || throughSeq < -1 || throughSeq > events.length - 1) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'history throughSeq is out of range')
  }
  const beforeSeq = request.beforeSeq === undefined ? throughSeq + 1 : request.beforeSeq
  if (!isSafeInteger(beforeSeq) || beforeSeq < 0) fail(FAILURE_CODES.INVALID_MESSAGE, 'history beforeSeq is out of range')
  const maxMessages = request.maxMessages === undefined ? 50 : request.maxMessages
  if (!Number.isSafeInteger(maxMessages) || maxMessages <= 0) fail(FAILURE_CODES.INVALID_MESSAGE, 'history maxMessages is invalid')
  const maxBytes = request.maxBytes === undefined ? MAX_PAGE_BYTES : request.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_PAGE_BYTES) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'history maxBytes exceeds the page budget')
  const format = request.format === undefined ? NATIVE_HISTORY_FORMATS.LEGACY : request.format
  if (!Object.values(NATIVE_HISTORY_FORMATS).includes(format)) fail(FAILURE_CODES.INVALID_MESSAGE, 'unsupported native history format')
  const toolNames = format === NATIVE_HISTORY_FORMATS.DETAILS ? toolResultNames(events, throughSeq) : undefined
  const end = Math.min(beforeSeq, throughSeq + 1)
  const fromSeq = request.fromSeq === undefined ? 0 : request.fromSeq
  if (!isNonNegativeInteger(fromSeq) || fromSeq > end) fail(FAILURE_CODES.INVALID_MESSAGE, 'history forward boundary is out of range')
  let start = Math.max(fromSeq, throughSeq < 0 ? 0 : pageStart(events, end, maxMessages))
  let records = recordsFor(events, start, end, exportClasses, request.nativeAssistantBlocks, format, toolNames, request.nativeImages)
  const initialRecordCount = records.length
  const exportCursor = encodeExportCursor({
    machineKey, projectId, sessionId,
    generation: request.generation,
    grantRevision: request.grantRevision,
    throughSeq,
    beforeSeq: throughSeq + 1, // delivery after-position, never the backward-page boundary
    ...(format === NATIVE_HISTORY_FORMATS.DETAILS ? { format } : {}),
  })
  const makePage = () => ({
    generation: request.generation, grantRevision: request.grantRevision, exportCursor, throughSeq,
    coveredFromSeq: records.length === 0 ? null : start,
    coveredThroughSeq: records.length === 0 ? null : end - 1,
    records, hasMore: records.length > 0 && start > 0,
  })
  while (jsonByteLength(makePage()) > maxBytes && start < end) {
    start++
    records = recordsFor(events, start, end, exportClasses, request.nativeAssistantBlocks, format, toolNames, request.nativeImages)
  }
  if (jsonByteLength(makePage()) > maxBytes || (records.length === 0 && initialRecordCount > 0)) fail(FAILURE_CODES.PAGE_TOO_LARGE, 'complete history page cannot fit one native record')
  return freezeDeep(makePage())
}

/**
 * Strict source history page parser; optionally verifies the export cursor binding.
 * @param {unknown} value - candidate page.
 * @param {{ machineKey: string, projectId: string, sessionId: string, generation: number, grantRevision: number }} [expected] - binding.
 * @returns {Readonly<object>} frozen page.
 */
export function parseHistoryPage(value, expected) {
  assertRecord(value, 'history page', ['generation', 'grantRevision', 'exportCursor', 'throughSeq', 'coveredFromSeq', 'coveredThroughSeq', 'records', 'hasMore'])
  if (!isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.grantRevision)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'history page generations are invalid')
  }
  if (!isSafeInteger(value.throughSeq) || value.throughSeq < -1) fail(FAILURE_CODES.INVALID_MESSAGE, 'history page throughSeq is invalid')
  if (typeof value.hasMore !== 'boolean') fail(FAILURE_CODES.INVALID_MESSAGE, 'history page hasMore must be boolean')
  const cursor = decodeExportCursor(value.exportCursor, expected)
  if (cursor.generation !== value.generation || cursor.grantRevision !== value.grantRevision || cursor.throughSeq !== value.throughSeq || cursor.beforeSeq !== value.throughSeq + 1) fail(FAILURE_CODES.CURSOR_STALE, 'history cursor disagrees with its page cut or authority')
  if (!Array.isArray(value.records)) fail(FAILURE_CODES.INVALID_MESSAGE, 'history page records are invalid')
  const records = value.records.map(record => {
    if (!isRecord(record) || typeof record.type !== 'string') fail(FAILURE_CODES.INVALID_MESSAGE, 'history record is invalid')
    if (record.type === 'withheld') {
      assertRecord(record, 'withheld record', ['type', 'firstSeq', 'lastSeq', 'reason'])
      if (!isNonNegativeInteger(record.firstSeq) || !isNonNegativeInteger(record.lastSeq) || record.lastSeq < record.firstSeq) {
        fail(FAILURE_CODES.INVALID_MESSAGE, 'withheld record range is invalid')
      }
      if (record.reason !== 'policy') fail(FAILURE_CODES.INVALID_MESSAGE, 'withheld record reason is invalid')
      return { type: 'withheld', firstSeq: record.firstSeq, lastSeq: record.lastSeq, reason: 'policy' }
    }
    if (record.type !== 'event') fail(FAILURE_CODES.INVALID_MESSAGE, 'unknown history record type')
    assertRecord(record, 'event record', ['type', 'event'], ['redacted'])
    if (Object.hasOwn(record, 'redacted') && record.redacted !== true) fail(FAILURE_CODES.INVALID_MESSAGE, 'redacted carrier must be true when present')
    return { type: 'event', event: record.event, ...(record.redacted === true ? { redacted: true } : {}) }
  })
  let next = value.coveredFromSeq
  if (records.length === 0) {
    if (next !== null || value.coveredThroughSeq !== null || value.hasMore) fail(FAILURE_CODES.HISTORY_GAP, 'empty history page cannot claim coverage or continuation')
  } else {
    if (!isNonNegativeInteger(next) || !isNonNegativeInteger(value.coveredThroughSeq)) fail(FAILURE_CODES.HISTORY_GAP, 'history coverage is required')
    for (const record of records) {
      const first = record.type === 'event' ? record.event?.seq : record.firstSeq
      const last = record.type === 'event' ? record.event?.seq : record.lastSeq
      if (first !== next || !isNonNegativeInteger(last) || last < first) fail(FAILURE_CODES.HISTORY_GAP, 'history record coverage gap or overlap')
      next = last + 1
    }
    if (next - 1 !== value.coveredThroughSeq || value.coveredThroughSeq > value.throughSeq) fail(FAILURE_CODES.HISTORY_GAP, 'history coverage exceeds declared cut')
  }
  return freezeDeep({
    generation: value.generation,
    grantRevision: value.grantRevision,
    exportCursor: value.exportCursor,
    throughSeq: value.throughSeq,
    coveredFromSeq: value.coveredFromSeq,
    coveredThroughSeq: value.coveredThroughSeq,
    records,
    hasMore: value.hasMore,
  })
}

/**
 * Build a passive follow snapshot frame. Assistant process-local streams are omitted in v0.
 * @param {{ page: unknown, header: unknown, projections: unknown }} value - snapshot parts.
 * @returns {Readonly<object>} frozen snapshot frame.
 */
export function createHistorySnapshotFrame(value) {
  assertRecord(value, 'history snapshot', ['page', 'header', 'projections'])
  const page = parseHistoryPage(value.page)
  assertRecord(value.header, 'native wire header', ['version', 'id', 'createdAt', 'isSeeded'], ['cwd', 'parentSession', 'origin', 'delegationDepth', 'agentPreset'])
  if (!isNonNegativeInteger(value.header.version) || !isNonNegativeInteger(value.header.createdAt) || typeof value.header.isSeeded !== 'boolean') fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid native wire header')
  const id = parseSessionId(value.header.id)
  assertRecord(value.projections, 'native projections', ['asOfSeq', 'values'])
  if (!isSafeInteger(value.projections.asOfSeq) || value.projections.asOfSeq < -1 || !isRecord(value.projections.values)) fail(FAILURE_CODES.INVALID_MESSAGE, 'invalid projection baseline')
  if (value.projections.asOfSeq !== page.throughSeq) fail(FAILURE_CODES.HISTORY_GAP, 'projection baseline does not match native snapshot cut')
  const format = decodeExportCursor(page.exportCursor).format ?? NATIVE_HISTORY_FORMATS.LEGACY
  if (format === NATIVE_HISTORY_FORMATS.LEGACY && Object.keys(value.projections.values).length > 0) fail(FAILURE_CODES.EXPORT_POLICY_UNSUPPORTED, 'legacy history does not support native metrics')
  const projections = parseMetricsProjection(value.projections, page.throughSeq)
  return freezeDeep({
    type: 'snapshot', page,
    header: { version: value.header.version, id, createdAt: value.header.createdAt, isSeeded: value.header.isSeeded },
    projections,
  })
}

/**
 * Build a live records frame carrying policy-filtered records after a pinned snapshot.
 * @param {{ generation: number, grantRevision: number, exportCursor: string, records: readonly unknown[] }} value - already grant-checked projected carriers from this binding; never raw native events. Worker must reauthorize every follow batch before calling.
 * @returns {Readonly<object>} frozen records frame.
 */
export function createHistoryRecordsFrame(value) {
  assertRecord(value, 'history records frame', ['generation', 'grantRevision', 'exportCursor', 'records'], ['projections'])
  if (!isNonNegativeInteger(value.generation) || !isNonNegativeInteger(value.grantRevision)) {
    fail(FAILURE_CODES.INVALID_MESSAGE, 'history frame generations are invalid')
  }
  if (!Array.isArray(value.records)) fail(FAILURE_CODES.INVALID_MESSAGE, 'history frame records are invalid')
  let projections
  if (value.projections !== undefined) {
    const cursor = decodeExportCursor(value.exportCursor, { generation: value.generation, grantRevision: value.grantRevision, format: NATIVE_HISTORY_FORMATS.DETAILS })
    projections = parseMetricsProjection(value.projections, cursor.throughSeq)
  }
  return freezeDeep({
    type: 'records',
    generation: value.generation,
    grantRevision: value.grantRevision,
    exportCursor: value.exportCursor,
    records: value.records,
    ...(projections === undefined ? {} : { projections }),
  })
}
