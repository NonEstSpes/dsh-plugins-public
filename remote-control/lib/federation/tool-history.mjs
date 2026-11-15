/**
 * Closed, passive projection of validated native Tool event data.
 * The caller owns native log validation, export grants, source scope, surface metadata,
 * assistant-stream correlation, and the complete event-carrier/page byte budget.
 * Foreign consumers must render this data inertly, never invoke presenters, evaluate UI,
 * or resolve recorded paths against the Controller. No tool or filesystem code runs here.
 * @module dsh-remote-control/federation/tool-history
 */
import { FederationContractError } from './identity.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS, jsonByteLength } from './protocol.mjs'

/** Classes implemented by this data projector, not permission or automatic wire negotiation. */
export const TOOL_HISTORY_REVIEWED_CLASSES = Object.freeze(['tool.call', 'tool.result'])

const MAX_DATA_BYTES = PROTOCOL_LIMITS.maxPageBytes
const OMIT_META = Symbol('unreviewed tool metadata')
const HIDDEN_BLOCKS = new Set(['reasoning', 'image', 'file', 'tool-call', 'tool-addition', 'tool-removal'])
const STATIC_ERRORS = new Map([
  ['AutoReviewDeniedError', 'AUTO_REVIEW_DENIED'],
  ['ToolOutcomeUnknownError', 'TOOL_OUTCOME_UNKNOWN'],
  ['ToolNotStartedError', 'TOOL_NOT_STARTED'],
])
const own = (value, key) => Object.hasOwn(value, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const text = value => typeof value === 'string'
const identity = value => text(value) && value.length > 0
const invalid = () => { throw new FederationContractError(FAILURE_CODES.INVALID_MESSAGE, 'invalid native tool event data') }
const tooLarge = () => { throw new FederationContractError(FAILURE_CODES.PAGE_TOO_LARGE, 'projected native tool data exceeds its byte budget') }

function extras(value, allowed) {
  for (const key in value) if (own(value, key) && !allowed.includes(key)) return true
  return false
}

function shape(value, required, optional = []) {
  if (!record(value) || required.some(key => !own(value, key))) invalid()
  return extras(value, [...required, ...optional])
}

function freezeDeep(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) freezeDeep(value[key])
  return Object.freeze(value)
}

/** Account only explicitly constructed JSON; omitted private values are never serialized. */
class JsonBudget {
  bytes = 0
  charge(bytes) { this.bytes += bytes; if (this.bytes > MAX_DATA_BYTES) tooLarge() }
  value(value) {
    if (typeof value === 'string' && value.length > MAX_DATA_BYTES) tooLarge()
    this.charge(jsonByteLength(value))
    return value
  }
  object(fields) {
    const keys = Object.keys(fields)
    this.charge(2 + Math.max(0, keys.length - 1))
    for (const key of keys) this.charge(jsonByteLength(key) + 1)
    return fields
  }
  array(items) { this.charge(2 + Math.max(0, items.length - 1)); return items }
  included(value) { this.charge(jsonByteLength(value)); return value }
}

/** The validation pass retains no arrays, so malformed/unsupported metadata cannot trigger a size refusal. */
class MetaProjection {
  constructor(copy) { this.copy = copy; this.redacted = false; this.budget = copy ? new JsonBudget() : undefined }
  shape(value, required, optional = []) {
    if (!record(value) || required.some(key => !own(value, key))) throw OMIT_META
    this.redacted ||= extras(value, [...required, ...optional])
  }
  string(value) { if (!text(value)) throw OMIT_META; return this.scalar(value) }
  integer(value, min = 0) {
    if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min) throw OMIT_META
    return this.scalar(value)
  }
  boolean(value) { if (typeof value !== 'boolean') throw OMIT_META; return this.scalar(value) }
  scalar(value) { return this.copy ? this.budget.value(value) : value }
  object(fields) { return this.copy ? this.budget.object(fields) : undefined }
  array(value, project) {
    if (!Array.isArray(value)) throw OMIT_META
    const items = this.copy ? [] : undefined
    for (const item of value) {
      const projected = project(item)
      if (this.copy) items.push(projected)
    }
    return this.copy ? this.budget.array(items) : undefined
  }
}

function readMeta(value, project) {
  project.shape(value, ['path', 'offset', 'lines', 'totalLines'], ['lang'])
  const offset = project.integer(value.offset, 1), totalLines = project.integer(value.totalLines)
  let previous = offset - 1
  const fields = {
    path: project.string(value.path), offset,
    lines: project.array(value.lines, line => {
      project.shape(line, ['number', 'text'])
      const number = project.integer(line.number, 1)
      if (number < offset || number <= previous || number > totalLines) throw OMIT_META
      previous = number
      return project.object({ number, text: project.string(line.text) })
    }),
    totalLines,
  }
  if (own(value, 'lang')) fields.lang = project.string(value.lang)
  return project.object(fields)
}

function diffMeta(value, name, project) {
  const optional = name === 'write' ? ['path', 'operation'] : name === 'edit' ? ['path'] : ['stopped']
  project.shape(value, ['diffs'], optional)
  const fields = {
    diffs: project.array(value.diffs, diff => {
      project.shape(diff, ['path', 'oldText', 'newText'])
      return project.object({ path: project.string(diff.path),
        oldText: diff.oldText === null ? project.scalar(null) : project.string(diff.oldText),
        newText: project.string(diff.newText) })
    }),
  }
  if (optional.includes('path') && own(value, 'path')) fields.path = project.string(value.path)
  if (optional.includes('operation') && own(value, 'operation')) {
    if (!['create', 'update'].includes(value.operation)) throw OMIT_META
    fields.operation = project.string(value.operation)
  }
  if (optional.includes('stopped') && own(value, 'stopped')) fields.stopped = project.boolean(value.stopped)
  return project.object(fields)
}

function searchMeta(value, name, project) {
  const matches = name === 'grep'
  project.shape(value, ['shape', matches ? 'files' : 'paths', 'truncated', 'total'])
  if (value.shape !== (matches ? 'matches' : 'paths')) throw OMIT_META
  const fields = { shape: project.string(value.shape) }
  if (matches) {
    fields.files = project.array(value.files, file => {
      project.shape(file, ['path', 'matches'])
      return project.object({ path: project.string(file.path), matches: project.array(file.matches, match => {
        project.shape(match, ['lineNumber', 'line'])
        return project.object({ lineNumber: project.integer(match.lineNumber, 1), line: project.string(match.line) })
      }) })
    })
  } else fields.paths = project.array(value.paths, item => project.string(item))
  fields.truncated = project.boolean(value.truncated)
  fields.total = project.integer(value.total)
  return project.object(fields)
}

function webMeta(value, name, project) {
  if (name === 'web_fetch') {
    project.shape(value, ['url', 'statusCode', 'truncated'])
    return project.object({ url: project.string(value.url),
      statusCode: project.integer(value.statusCode, -Number.MAX_SAFE_INTEGER), truncated: project.boolean(value.truncated) })
  }
  project.shape(value, ['sources', 'truncated'], ['answer'])
  const fields = {
    sources: project.array(value.sources, source => {
      project.shape(source, ['url'], ['title', 'snippet', 'publishedAt'])
      const projected = { url: project.string(source.url) }
      for (const key of ['title', 'snippet', 'publishedAt']) if (own(source, key)) projected[key] = project.string(source[key])
      return project.object(projected)
    }),
    truncated: project.boolean(value.truncated),
  }
  if (own(value, 'answer')) fields.answer = project.string(value.answer)
  return project.object(fields)
}

function metadata(value, name, project) {
  switch (name) {
    case 'read': return readMeta(value, project)
    case 'edit':
    case 'write':
    case 'apply_patch': return diffMeta(value, name, project)
    case 'grep':
    case 'glob': return searchMeta(value, name, project)
    case 'web_search':
    case 'web_fetch': return webMeta(value, name, project)
    case 'bash':
    case 'pwsh':
      project.shape(value, ['cwd'])
      return project.object({ cwd: project.string(value.cwd) })
    default: throw OMIT_META
  }
}

function projectMetadata(value, name) {
  const validation = new MetaProjection(false)
  try { metadata(value, name, validation) } catch (error) {
    if (error === OMIT_META) return null
    throw error
  }
  const projection = new MetaProjection(true)
  return { meta: metadata(value, name, projection), redacted: validation.redacted || projection.redacted }
}

function resultContent(content, budget) {
  if (!Array.isArray(content)) invalid()
  let redacted = false, retained = 0
  // Decide whether the entire content is reviewable before bounding any retained text.
  for (const block of content) {
    if (!record(block) || !text(block.type)) invalid()
    if (block.type === 'text') { if (!text(block.text)) invalid(); retained++ }
    else if (HIDDEN_BLOCKS.has(block.type)) redacted = true
    else return null
  }
  if (content.length > 0 && retained === 0) return null
  const projected = []
  for (const block of content) {
    if (block.type !== 'text') continue
    redacted ||= extras(block, ['type', 'text'])
    projected.push(budget.object({ type: budget.value('text'), text: budget.value(block.text) }))
  }
  return { content: budget.array(projected), redacted }
}

/**
 * Copy reviewed Tool data without granting export or changing any native identity.
 * @param {object} event - complete native tool/call or tool/result event after Worker-native full-log validation.
 * @param {{toolName?:string}} [options] - result's name, derived ONLY from a matching earlier callId/turn/step in the original validated log; never wire input.
 * @returns {Readonly<{data:object,redacted:boolean}>|null} detached frozen data, or null to withhold an unsupported event; caller retains roots/surface metadata and enforces complete record/page limits.
 * @throws {FederationContractError} invalid reviewed fields or permitted data larger than 32 KiB; no arguments, text, or valid reviewed metadata are truncated.
 */
export function projectToolEvent(event, { toolName } = {}) {
  if (!record(event) || !text(event.type)) invalid()
  if (event.type !== 'tool/call' && event.type !== 'tool/result') return null
  const source = event.data
  const budget = new JsonBudget()
  if (event.type === 'tool/call') {
    const redacted = shape(source, ['turn', 'step', 'callId', 'name', 'arguments'])
    if (!count(source.turn) || !count(source.step) || !identity(source.callId) || !identity(source.name) || !text(source.arguments)) invalid()
    const data = budget.object({ turn: budget.value(source.turn), step: budget.value(source.step),
      callId: budget.value(source.callId), name: budget.value(source.name), arguments: budget.value(source.arguments) })
    return freezeDeep({ data, redacted })
  }
  let redacted = shape(source, ['turn', 'step', 'message'], ['error', 'meta'])
  if (!count(source.turn) || !count(source.step)) invalid()
  const message = source.message
  redacted = shape(message, ['id', 'role', 'source', 'toolCallId', 'content'], ['isError']) || redacted
  redacted = shape(message.source, ['kind', 'callId']) || redacted
  if (!identity(message.id) || message.role !== 'tool' || message.source.kind !== 'tool'
    || !identity(message.toolCallId) || message.source.callId !== message.toolCallId
    || (own(message, 'isError') && typeof message.isError !== 'boolean')
    || (own(source, 'error') && message.isError !== true)) invalid()
  const content = resultContent(message.content, budget)
  if (content === null) return null
  redacted ||= content.redacted
  const projectedMessage = {
    id: budget.value(message.id), role: budget.value('tool'),
    source: budget.object({ kind: budget.value('tool'), callId: budget.value(message.source.callId) }),
    toolCallId: budget.value(message.toolCallId), content: content.content,
  }
  if (own(message, 'isError')) projectedMessage.isError = budget.value(message.isError)
  const data = { turn: budget.value(source.turn), step: budget.value(source.step), message: budget.object(projectedMessage) }
  if (own(source, 'error')) {
    const error = source.error
    if (record(error) && STATIC_ERRORS.has(error.name) && STATIC_ERRORS.get(error.name) === error.code) {
      data.error = budget.object({ name: budget.value(error.name), code: budget.value(error.code) })
      redacted ||= extras(error, ['name', 'code'])
    } else redacted = true
  }
  if (own(source, 'meta')) {
    const projected = projectMetadata(source.meta, toolName)
    if (projected === null) redacted = true
    else { data.meta = budget.included(projected.meta); redacted ||= projected.redacted }
  }
  budget.object(data)
  return freezeDeep({ data, redacted })
}
