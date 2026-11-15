/** Closed source file fields: native content-addressed references, bounded requests and no provider metadata or URLs. */
import { FederationContractError } from './identity.mjs'
import { SOURCE_FILE_CHUNK_BYTES } from './file-transfer.mjs'
const fail = () => { throw new FederationContractError('invalid-message', 'source file fields are invalid') }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, required, optional = []) => {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail()
}
const count = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}(?::[A-Za-z0-9_-]{1,256})?$/.test(value) && !/^(?:https?|file|data|blob):/i.test(value)
const imageTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const positive = value => count(value) && value > 0
const name = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\\/\u0000-\u001f\u007f]/.test(value)

/** @param {unknown} value A native or source file reference. @returns {Readonly<object>} Only the exact opaque id, safe leaf name and byte length. */
export function sourceFileRef(value) {
  exact(value, ['attachmentId', 'name', 'bytes'])
  if (!id(value.attachmentId) || !name(value.name) || !count(value.bytes)) fail()
  return Object.freeze({ attachmentId: value.attachmentId, name: value.name, bytes: value.bytes })
}
/** @param {unknown} value A native normalized image reference. @returns {Readonly<object>} Exact native MIME, dimensions, byte length and safe optional metadata only. */
export function sourceImageRef(value) {
  exact(value, ['attachmentId', 'mediaType', 'bytes', 'width', 'height'], ['name', 'originalDimensions'])
  if (!id(value.attachmentId) || !imageTypes.has(value.mediaType) || !positive(value.bytes) || !positive(value.width) || !positive(value.height)
    || (value.name !== undefined && !name(value.name))) fail()
  let originalDimensions
  if (value.originalDimensions !== undefined) {
    exact(value.originalDimensions, ['width', 'height'])
    if (!positive(value.originalDimensions.width) || !positive(value.originalDimensions.height)) fail()
    originalDimensions = Object.freeze({ width: value.originalDimensions.width, height: value.originalDimensions.height })
  }
  return Object.freeze({ attachmentId: value.attachmentId, mediaType: value.mediaType, bytes: value.bytes, width: value.width, height: value.height,
    ...(value.name === undefined ? {} : { name: value.name }), ...(originalDimensions === undefined ? {} : { originalDimensions }) })
}
/** @param {unknown} value A completed native SDK upload. @returns {Readonly<object>} One reviewed file or normalized image receipt, never a URL, filesystem path or arbitrary metadata. */
export function sourceUploadValue(value) {
  if (value?.kind === 'image') {
    exact(value, ['kind', 'receiptId', 'image'])
    if (!id(value.receiptId)) fail()
    return Object.freeze({ kind: 'image', receiptId: value.receiptId, image: sourceImageRef(value.image) })
  }
  exact(value, ['kind', 'receiptId', 'file'])
  if (value.kind !== 'file' || !id(value.receiptId)) fail()
  return Object.freeze({ kind: 'file', receiptId: value.receiptId, file: sourceFileRef(value.file) })
}
/** @param {string} operation Exact source file operation. @param {unknown} request Untrusted wire fields. @returns {Readonly<object>} A closed request with explicit native byte ranges. */
export function sourceFileRequest(operation, request) {
  if (operation === 'upload.start') {
    exact(request, ['name', 'kind'], request?.kind === 'image' ? ['mediaType'] : [])
    if (!name(request.name) || !['file', 'image'].includes(request.kind) || (request.kind === 'image' && !imageTypes.has(request.mediaType))) fail()
  } else if (operation === 'upload.chunk') {
    exact(request, ['transferId', 'index', 'data'])
    if (!id(request.transferId) || !count(request.index) || typeof request.data !== 'string' || request.data.length > Math.ceil(SOURCE_FILE_CHUNK_BYTES / 3) * 4) fail()
  } else if (operation === 'upload.finish') {
    exact(request, ['transferId', 'index']); if (!id(request.transferId) || !count(request.index)) fail()
  } else if (operation === 'upload.cancel') {
    exact(request, ['transferId']); if (!id(request.transferId)) fail()
  } else if (operation === 'read') {
    exact(request, ['path'], ['offset', 'length', 'expectedVersion'])
    if (typeof request.path !== 'string' || !request.path || request.path.includes('\0') || Buffer.byteLength(request.path) > 8192
      || (request.offset !== undefined && !count(request.offset)) || (request.length !== undefined && (!count(request.length) || request.length === 0 || request.length > SOURCE_FILE_CHUNK_BYTES))
      || (request.expectedVersion !== undefined && (typeof request.expectedVersion !== 'string' || !request.expectedVersion || request.expectedVersion.length > 1024))) fail()
    return Object.freeze({ ...request, offset: request.offset ?? 0, length: request.length ?? SOURCE_FILE_CHUNK_BYTES })
  } else if (operation === 'image') {
    exact(request, ['image', 'index'], ['transferId'])
    if (!count(request.index) || (request.transferId !== undefined && !id(request.transferId))) fail()
    return Object.freeze({ ...request, image: sourceImageRef(request.image) })
  } else if (operation === 'attachment') {
    exact(request, ['file', 'index'], ['transferId'])
    if (!count(request.index) || (request.transferId !== undefined && !id(request.transferId))) fail()
    return Object.freeze({ ...request, file: sourceFileRef(request.file) })
  } else fail()
  return Object.freeze({ ...request })
}
/** @param {unknown} value Exact receipt selectors inside a journaled prompt. @returns {readonly object[]} Copied opaque selectors without attachment ids or byte payloads. */
export function sourcePromptUploads(value) {
  if (!Array.isArray(value) || value.length > 256) fail()
  const seen = new Set()
  return Object.freeze(value.map(row => {
    exact(row, ['receiptId', 'kind'])
    if (!id(row.receiptId) || !['file', 'image'].includes(row.kind) || seen.has(row.receiptId)) fail()
    seen.add(row.receiptId)
    return Object.freeze({ receiptId: row.receiptId, kind: row.kind })
  }))
}
