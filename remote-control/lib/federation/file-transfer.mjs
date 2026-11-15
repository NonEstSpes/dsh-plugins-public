/** Pair-owned native file streams: one credit, fixed source frames, no whole-file buffer or Session effects. */
import { randomUUID, createHash } from 'node:crypto'
import { FederationContractError } from './identity.mjs'

export const SOURCE_FILE_CHUNK_BYTES = 16384
const MAX_TRANSFERS = 256
const error = code => new FederationContractError(code, 'source file transfer is unavailable')
const fail = (code = 'source-unavailable') => { throw error(code) }
const safe = cause => error(['grant-changed', 'not-granted', 'action-unsupported', 'invalid-message', 'page-too-large'].includes(cause?.code) ? cause.code : 'source-unavailable')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const integer = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
const hash = value => createHash('sha256').update(value).digest('hex')

/** @param {{upload:Function,attachment?:Function,check:Function}} options Verified native SDK callbacks and current pair/ref/policy guard. @returns One instance-owned transfer aggregate; closing aborts every operation before joining any. */
export function createFileTransfers({ upload, attachment, image, check, timeoutMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('invalid-message')
  const rows = new Map(), receipts = new Map()
  let closed = false, closing
  const admit = (ref, authority, direction) => { if (closed) fail(); try { check(ref, authority, direction) } catch (cause) { throw safe(cause) } }
  const stop = row => {
    clearTimeout(row.timer)
    row.cancelled = true; row.remainder = undefined; row.controller.abort(error('source-unavailable'))
    row.slot?.ack.reject(error('source-unavailable')); row.wake?.resolve(); row.wake = undefined
    if (row.iterator && row.returned === undefined) row.returned = Promise.resolve(row.iterator.return?.()).then(() => {}, () => {})
    if (row.result) receipts.delete(row.result.receiptId)
  }
  const arm = row => { clearTimeout(row.timer); row.timer = setTimeout(() => { stop(row) }, timeoutMs) }
  const current = row => {
    if (row.cancelled) fail()
    try { admit(row.ref, row.authority, row.direction) } catch (cause) { stop(row); throw cause }
    if (row.failure) throw row.failure
  }
  const owned = (ref, uploads, authority) => {
    admit(ref, authority, 'upload')
    for (const value of uploads) {
      const row = receipts.get(value.receiptId)
      if (!row || !same(row.ref, ref) || !same(row.authority, authority) || row.result.kind !== value.kind || row.cancelled) fail('not-granted')
    }
    return uploads.map(value => ({ receiptId: value.receiptId, kind: value.kind }))
  }
  const find = (ref, request, authority) => {
    const row = rows.get(request.transferId)
    if (!row || !same(row.ref, ref)) fail('not-granted')
    if (!same(row.authority, authority)) fail('grant-changed')
    current(row)
    return row
  }
  const reserve = (ref, authority, direction) => {
    admit(ref, authority, direction)
    if (rows.size >= MAX_TRANSFERS) fail('page-too-large')
    if ([...rows.values()].some(row => !row.finished && !row.cancelled && row.direction === direction)) fail('outcome-unknown')
    const row = { transferId: `file_${randomUUID()}`, ref: structuredClone(ref), authority: structuredClone(authority), direction,
      controller: new AbortController(), nextIndex: 0, cancelled: false, finished: false }
    rows.set(row.transferId, row); arm(row)
    return row
  }
  const download = async (ref, request, authority, kind) => {
    const read = kind === 'image' ? image : attachment, reference = kind === 'image' ? request.image : request.file
    if (typeof read !== 'function') fail('action-unsupported')
    let row
    if (request.transferId === undefined) {
      if (request.index !== 0) fail('invalid-message')
      row = reserve(ref, authority, 'download'); row.reference = structuredClone(reference); row.mediaKind = kind
      row.iterator = read(row.ref, row.reference, row.controller.signal)[Symbol.asyncIterator]()
    } else row = find(ref, request, authority)
    if (row.direction !== 'download' || row.mediaKind !== kind || !same(row.reference, reference) || !integer(request.index)) fail('not-granted')
    if (request.index === row.nextIndex - 1 && row.lastFrame) return row.lastFrame
    if (request.index !== row.nextIndex || row.pending || row.finished) fail('invalid-message')
    current(row); arm(row)
    if (!row.remainder?.length) {
      row.pending = row.iterator.next()
      let next
      try { next = await row.pending } catch (cause) { stop(row); throw safe(cause) } finally { row.pending = undefined }
      current(row)
      if (next.done) {
        row.finished = true; clearTimeout(row.timer)
        return row.lastFrame = { transferId: row.transferId, index: row.nextIndex++, data: '', eof: true }
      }
      row.remainder = next.value
    }
    const bytes = row.remainder.subarray(0, SOURCE_FILE_CHUNK_BYTES)
    row.remainder = row.remainder.length > bytes.length ? row.remainder.subarray(bytes.length) : undefined
    return row.lastFrame = { transferId: row.transferId, index: row.nextIndex++, data: Buffer.from(bytes).toString('base64'), eof: false }
  }
  return Object.freeze({
    async start(ref, request, authority) {
      if (!['file', 'image'].includes(request.kind)) fail('action-unsupported')
      if (request.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(request.mediaType)) fail('invalid-message')
      const row = reserve(ref, authority, 'upload')
      row.request = { name: request.name, kind: request.kind, ...(request.kind === 'image' ? { mediaType: request.mediaType } : {}) }
      const data = (async function* () {
        try {
          for (;;) {
            current(row)
            if (!row.slot && !row.eof) { row.wake = Promise.withResolvers(); await row.wake.promise; row.wake = undefined }
            current(row)
            if (!row.slot) { if (row.eof) return; continue }
            const slot = row.slot
            yield slot.bytes
            row.slot = undefined; slot.ack.resolve()
          }
        } finally { row.slot?.ack.reject(error('source-unavailable')); row.slot = undefined }
      })()
      // Track completion before invoking even a reentrant native callback.
      const completion = Promise.withResolvers(); row.done = completion.promise
      void (async () => {
        try {
          const value = await upload(row.ref, row.request, data, row.controller.signal)
          current(row); row.result = value
        } catch (cause) { row.failure = safe(cause); row.slot?.ack.reject(row.failure); row.wake?.resolve() }
        finally { completion.resolve() }
      })()
      current(row)
      return { transferId: row.transferId }
    },
    async chunk(ref, request, authority) {
      const row = find(ref, request, authority)
      if (row.direction !== 'upload' || !integer(request.index) || typeof request.data !== 'string') fail('invalid-message')
      const bytes = Buffer.from(request.data, 'base64')
      if (bytes.length === 0 || bytes.length > SOURCE_FILE_CHUNK_BYTES || bytes.toString('base64') !== request.data) fail('invalid-message')
      const digest = hash(bytes)
      if (request.index === row.nextIndex - 1 && row.lastDigest === digest) return { nextIndex: row.nextIndex }
      if (request.index !== row.nextIndex || row.slot || row.eof || row.finished) fail('invalid-message')
      arm(row)
      const ack = Promise.withResolvers(); row.slot = { bytes, ack }; row.wake?.resolve()
      await ack.promise; current(row); arm(row)
      row.lastDigest = digest; row.nextIndex++
      return { nextIndex: row.nextIndex }
    },
    async finish(ref, request, authority) {
      const row = find(ref, request, authority)
      if (row.direction !== 'upload' || request.index !== row.nextIndex || row.slot) fail('invalid-message')
      row.eof = true; row.wake?.resolve()
      await row.done; current(row)
      if (!row.result) fail()
      row.finished = true; clearTimeout(row.timer); receipts.set(row.result.receiptId, row)
      return row.result
    },
    async cancel(ref, request, authority) {
      const row = rows.get(request.transferId)
      if (!row || !same(row.ref, ref) || !same(row.authority, authority)) fail('not-granted')
      admit(ref, authority, row.direction)
      stop(row)
      await Promise.allSettled([row.done, row.pending, row.returned])
      return { cancelled: true }
    },
    owned,
    attachment: (ref, request, authority) => download(ref, request, authority, 'file'),
    image: (ref, request, authority) => download(ref, request, authority, 'image'),
    retire(authority) { for (const row of rows.values()) if (!same(row.authority, authority)) stop(row) },
    close() {
      if (closing) return closing
      closed = true
      for (const row of rows.values()) stop(row)
      closing = Promise.allSettled([...rows.values()].flatMap(row => [row.done, row.pending, row.returned])).then(() => { rows.clear(); receipts.clear() })
      return closing
    },
  })
}
