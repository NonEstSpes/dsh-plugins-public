/** Additive image transport over SDK callbacks; the actual PNG normalization and Native log proof use the separate Loader composition. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createFileTransfers } from '../../lib/federation/file-transfer.mjs'
import { sourceFileRequest, sourceUploadValue, sourceImageRef, sourcePromptUploads } from '../../lib/federation/file-codec.mjs'

const ref = { machineKey: 'worker-image', projectId: 'project', sessionId: 'native-session' }, authority = { generation: 2, grantRevision: 1 }
const image = { attachmentId: 'normalized-native-image', mediaType: 'image/png', bytes: 5, width: 12, height: 9, name: 'input.png', originalDimensions: { width: 24, height: 18 } }
const receipt = { kind: 'image', receiptId: 'native-image-receipt', image }

test('declared image MIME reaches one native stream and only the SDK normalized image receipt enters the retained prompt', async () => {
  const received = [], calls = []
  const transfers = createFileTransfers({ timeoutMs: 1000, check() {}, async upload(target, request, data) {
    calls.push({ target, request }); for await (const bytes of data) received.push(...bytes)
    return sourceUploadValue(receipt)
  } })
  try {
    const request = sourceFileRequest('upload.start', { name: 'input.png', kind: 'image', mediaType: 'image/png' })
    assert.throws(() => sourceFileRequest('upload.start', { name: 'input.png', kind: 'image' }), { code: 'invalid-message' })
    assert.deepEqual(sourceFileRequest('upload.start', { name: 'plain.bin', kind: 'file' }), { name: 'plain.bin', kind: 'file' })
    const transfer = await transfers.start(ref, request, authority)
    await transfers.chunk(ref, { ...transfer, index: 0, data: Buffer.from([1, 2]).toString('base64') }, authority)
    await transfers.chunk(ref, { ...transfer, index: 1, data: Buffer.from([3, 4, 5]).toString('base64') }, authority)
    assert.deepEqual(await transfers.finish(ref, { ...transfer, index: 2 }, authority), receipt)
    assert.deepEqual(received, [1, 2, 3, 4, 5]); assert.equal(calls.length, 1); assert.deepEqual(calls[0].request, request)
    const uploads = sourcePromptUploads([{ kind: 'image', receiptId: receipt.receiptId }])
    assert.deepEqual(transfers.owned(ref, uploads, authority), uploads)
    assert.deepEqual(sourceImageRef(image), image)
    assert.throws(() => sourceImageRef({ ...image, url: 'https://PRIVATE_NATIVE_HOST/image' }), { code: 'invalid-message' })
  } finally { await transfers.close() }
})

test('verified native image bytes use the existing download identity and refuse a foreign Session without another native read', async () => {
  let reads = 0, completed = false
  const transfers = createFileTransfers({ timeoutMs: 1000, check() {}, async upload() { throw new Error('download must not upload') },
    async *image(target, value) { reads++; assert.deepEqual(target, ref); assert.deepEqual(value, image); yield Uint8Array.from([1, 2, 3, 4, 5]); completed = true } })
  try {
    const first = await transfers.image(ref, { image, index: 0 }, authority)
    assert.equal(first.eof, false); assert.deepEqual([...Buffer.from(first.data, 'base64')], [1, 2, 3, 4, 5])
    await assert.rejects(transfers.image({ ...ref, sessionId: 'foreign-session' }, { image, transferId: first.transferId, index: 1 }, authority), { code: 'not-granted' })
    const last = await transfers.image(ref, { image, transferId: first.transferId, index: 1 }, authority)
    assert.equal(last.eof, true); assert.equal(completed, true); assert.equal(reads, 1)
    assert.deepEqual(await transfers.image(ref, { image, transferId: first.transferId, index: 1 }, authority), last)
  } finally { await transfers.close() }
})
