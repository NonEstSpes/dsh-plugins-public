/** File vertical through real Runtime/Provider/journals; only native business callbacks and the transport are unit seams. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'

class TestRemoteError extends Error { constructor(code, message, details) { super(message); this.code = code; this.details = details } }
const signal = () => new AbortController().signal

test('one source file streams to its native receipt, enters the original guarded prompt and downloads only through verified EOF', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-source-files-'))), resources = []
  t.after(async () => {
    for (const resource of resources.reverse()) await resource.close()
    const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.equal(path.basename(target).startsWith('dsh-source-files-'), true)
    await rm(target, { recursive: true, force: true })
  })
  const ref = { machineKey: 'worker-files', projectId: 'project', sessionId: 'native-session' }
  const classes = ['conversation.user', 'conversation.assistant', 'turn', 'files']
  const grant = { version: 1, grantId: 'grant_files', principal: { kind: 'controller', id: 'controller-files' }, machineKey: ref.machineKey, revision: 1, issuedAt: 0,
    projects: [{ projectId: ref.projectId, actions: ['project.list', 'session.list', 'model.list'], exportClasses: classes,
      sessions: [{ sessionId: ref.sessionId, imported: true, actions: ['session.status', 'session.read', 'session.follow', 'session.prompt'], exportClasses: classes }] }] }
  const common = { machineKey: ref.machineKey, pairingGeneration: 1, keyFingerprint: 'a'.repeat(64), sharedKey: randomBytes(32).toString('base64url'), requestTimeoutMs: 1000 }
  const workerPair = { ...common, role: 'worker', id: 'worker-files-endpoint', peerId: 'controller-files', stateDir: path.join(root, 'worker'), grant }
  const controllerPair = { ...common, role: 'controller', id: workerPair.peerId, peerId: workerPair.id, stateDir: path.join(root, 'controller') }
  const receivers = new Map()
  const endpointFactory = async (pair, handlers) => {
    receivers.set(pair.id, handlers)
    return { start() {}, async close() { receivers.delete(pair.id) }, async send(kind, body) { await receivers.get(pair.peerId)?.onMessage({ from: pair.id, to: pair.peerId, kind, body: structuredClone(body) }) } }
  }
  const state = { bytes: [], uploads: 0, prompts: 0, verified: false, events: [] }
  const file = { attachmentId: 'native-content-address', name: 'input.bin', bytes: 5 }, receiptId = 'native-receipt'
  const backend = { mutationReadiness: { durableJournal: 'verified', firstRouteCapture: 'verified' },
    validateNativeEvents() {}, nativeAssistantBlocks: () => [], restoreGuard() {}, close() {},
    async read() { return { header: { version: 4, id: ref.sessionId, createdAt: 1, isSeeded: false }, events: structuredClone(state.events), running: false } },
    async modelState() { return { frontierSeq: state.events.length - 1, selection: { provider: 'native', model: 'model' } } },
    async prompt(target, request, dispatch) {
      await dispatch(); state.prompts++; assert.deepEqual(target, ref); assert.deepEqual(request.uploads, [{ kind: 'file', receiptId }])
      state.events.push({ type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: { id: 'native-message', role: 'user', source: { kind: 'user', rpcId: request.requestId },
        content: [{ type: 'text', text: request.text }, { type: 'file', attachment: file }] } })
      return { accepted: true }
    },
    files: { canUpload: () => true,
      async upload(target, request, data) { state.uploads++; assert.deepEqual(target, ref); assert.equal(request.name, 'input.bin'); for await (const bytes of data) state.bytes.push(...bytes); return { kind: 'file', receiptId, file } },
      async read() { throw new Error('attachment download must not use workspace file reads') },
      async *attachment(target, attachment) { assert.deepEqual(target, ref); assert.deepEqual(attachment, file); assert.equal(state.prompts, 1); yield Uint8Array.from(state.bytes); state.verified = true },
    },
  }
  const worker = await openFederationRuntime({ role: 'worker', label: 'Worker', projects: { project: { workspaceId: 'native-workspace' } }, pairs: [workerPair] }, { backend, endpointFactory })
  resources.push(worker)
  const controller = await openFederationRuntime({ role: 'controller', projects: {}, pairs: [controllerPair] }, { endpointFactory }); resources.push(controller)
  const provider = await createHostProvider({ runtime: controller, pair: controllerPair, RemoteError: TestRemoteError })
  const binding = await provider.bind(ref, signal()); assert.equal(binding.capabilities.files, true); assert.equal(binding.capabilities.attachments, true)
  const expected = await provider.modelState(ref, signal())
  const transfer = await provider.files.uploadStart(ref, { kind: 'file', name: 'input.bin' }, signal())
  await provider.files.uploadChunk(ref, { ...transfer, index: 0, data: Buffer.from([1, 2]).toString('base64') }, signal())
  await provider.files.uploadChunk(ref, { ...transfer, index: 1, data: Buffer.from([3, 4, 5]).toString('base64') }, signal())
  const uploaded = await provider.files.uploadFinish(ref, { ...transfer, index: 2 }, signal())
  assert.deepEqual(uploaded, { kind: 'file', receiptId, file }); assert.equal(state.prompts, 0); assert.equal(state.events.length, 0)
  await provider.prompt(ref, { requestId: 'prompt_with_file', text: 'Inspect this file', expected, uploads: [{ kind: 'file', receiptId }] }, signal())
  const history = await provider.historyPage(ref, { maxMessages: 20 }, signal())
  assert.equal(history.records[0].event.data.content[1].type, 'file')
  assert.deepEqual(history.records[0].event.data.content[1].attachment, file)
  const first = await provider.files.attachment(ref, { file, index: 0 }, signal())
  assert.equal(first.eof, false); assert.deepEqual([...Buffer.from(first.data, 'base64')], [1, 2, 3, 4, 5]); assert.equal(state.verified, false)
  const last = await provider.files.attachment(ref, { file, transferId: first.transferId, index: 1 }, signal())
  assert.equal(last.eof, true); assert.equal(state.verified, true); assert.equal(state.uploads, 1); assert.equal(state.prompts, 1)
})
