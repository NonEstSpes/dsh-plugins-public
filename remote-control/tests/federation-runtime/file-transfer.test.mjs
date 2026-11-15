/** One-credit file transport over native SDK stream callbacks; native persistence/Prompt composition is separate evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createFileTransfers } from '../../lib/federation/file-transfer.mjs'
import { sourceFileRef } from '../../lib/federation/file-codec.mjs'

const ref = { machineKey: 'worker-files', projectId: 'project', sessionId: 'native-session' }
const authority = { generation: 2, grantRevision: 1 }
const receipt = { kind: 'file', receiptId: 'native-receipt', file: { attachmentId: 'native-attachment', name: 'input.bin', bytes: 5 } }
const base64 = bytes => Buffer.from(bytes).toString('base64')

test('ordered chunks reach one native stream exactly once and only its completed receipt can enter a prompt', async () => {
  const received = [], calls = []
  const transfers = createFileTransfers({ timeoutMs: 1000, check() {}, async upload(target, request, data, signal) {
    calls.push({ target, request, signal })
    for await (const chunk of data) received.push(...chunk)
    return receipt
  } })
  try {
    const transfer = await transfers.start(ref, { kind: 'file', name: 'input.bin' }, authority)
    assert.deepEqual(await transfers.chunk(ref, { ...transfer, index: 0, data: base64([1, 2]) }, authority), { nextIndex: 1 })
    assert.deepEqual(await transfers.chunk(ref, { ...transfer, index: 0, data: base64([1, 2]) }, authority), { nextIndex: 1 })
    assert.deepEqual(await transfers.chunk(ref, { ...transfer, index: 1, data: base64([3, 4, 5]) }, authority), { nextIndex: 2 })
    assert.deepEqual(await transfers.finish(ref, { ...transfer, index: 2 }, authority), receipt)
    assert.deepEqual(await transfers.finish(ref, { ...transfer, index: 2 }, authority), receipt)
    assert.deepEqual(received, [1, 2, 3, 4, 5]); assert.equal(calls.length, 1)
    assert.throws(() => sourceFileRef({ ...receipt.file, url: 'https://PRIVATE_HOST/path' }), { code: 'invalid-message' })
    assert.throws(() => sourceFileRef({ ...receipt.file, name: 'C:\\PRIVATE\\file' }), { code: 'invalid-message' })
    assert.deepEqual(transfers.owned(ref, [{ receiptId: receipt.receiptId, kind: 'file' }], authority), [{ receiptId: receipt.receiptId, kind: 'file' }])
    assert.throws(() => transfers.owned({ ...ref, sessionId: 'other-session' }, [{ receiptId: receipt.receiptId, kind: 'file' }], authority), { code: 'not-granted' })
  } finally { await transfers.close() }
})

test('a transfer cannot change Session or authority, and revocation aborts its owned native stream', async () => {
  let allowed = true, ownedSignal
  const transfers = createFileTransfers({ timeoutMs: 1000, check() { if (!allowed) throw Object.assign(new Error('private grant detail'), { code: 'grant-changed' }) },
    async upload(_ref, _request, data, signal) { ownedSignal = signal; for await (const _chunk of data) {} return receipt } })
  try {
    const transfer = await transfers.start(ref, { kind: 'file', name: 'input.bin' }, authority)
    await assert.rejects(transfers.chunk({ ...ref, sessionId: 'other-session' }, { ...transfer, index: 0, data: base64([1]) }, authority), { code: 'not-granted' })
    allowed = false
    await assert.rejects(transfers.chunk(ref, { ...transfer, index: 0, data: base64([1]) }, authority), { code: 'grant-changed' })
    assert.equal(ownedSignal.aborted, true)
  } finally { await transfers.close() }
})

test('the pair deadline retires a lost upload and cancellation joins its held native work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  let ownedSignal
  const transfers = createFileTransfers({ timeoutMs: 1000, check() {}, async upload(_ref, _request, data, signal) {
    ownedSignal = signal; entered.resolve()
    try { for await (const _chunk of data) {} } catch (cause) { assert.equal(cause.code, 'source-unavailable') }
    await released.promise; return receipt
  } })
  const transfer = await transfers.start(ref, { kind: 'file', name: 'input.bin' }, authority)
  await entered.promise
  t.mock.timers.tick(1000)
  assert.equal(ownedSignal.aborted, true)
  let joined = false
  const cancelled = transfers.cancel(ref, transfer, authority).then(value => { joined = true; return value })
  assert.equal(ownedSignal.aborted, true); assert.equal(joined, false)
  released.resolve()
  assert.deepEqual(await cancelled, { cancelled: true }); await transfers.close()
  await assert.rejects(transfers.start(ref, { kind: 'file', name: 'input.bin' }, authority), { code: 'source-unavailable' })
})
