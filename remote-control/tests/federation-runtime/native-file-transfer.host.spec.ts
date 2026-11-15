/** Native file bytes and prompt admission through the immutable Worker, authenticated relay and ordinary SDK. */
import { createHash, randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { openNativeFilesWorker } from './fixtures/native-files-worker.host.ts'
import { createNativeAdapter } from '../../lib/federation/native-adapter.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import { createRelay } from '../../relay/server.mjs'

it('uploads native file bytes, admits the native file part once and downloads the verified bytes without a local mirror', async () => {
  const requests: GenerateOptions[] = []
  const worker = await openNativeFilesWorker(llm => new class extends llm.LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: provider } }
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return Promise.resolve([{ provider, id: 'native-files-model', name: 'Native files model' }]) }
    override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id, name: id }) }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Native attachment received' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native attachment received' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }())
  const owned: { close(): void | Promise<void> }[] = [worker]
  onTestFinished(async () => {
    const errors: unknown[] = []
    for (const resource of owned.reverse()) {
      try { await resource.close() } catch (error: unknown) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Native file fixture teardown failed')
  })
  const backend = await createNativeAdapter({ ctx: worker.ctx, settings: { projects: {} },
    native: { cordis: worker.cordis, llm: worker.llm, session: worker.session, sandbox: worker.sandbox, controllerOwner: worker.owner } })
  owned.push(backend)
  const controllerId = 'files-controller', workerId = 'files-worker', machineKey = 'native-files-machine'
  const controllerToken = randomBytes(32).toString('base64url'), workerToken = randomBytes(32).toString('base64url')
  const relay = createRelay({ directory: path.join(worker.root, 'relay'), pollMs: 20, devices: [
    { id: controllerId, peerId: workerId, tokenHash: createHash('sha256').update(controllerToken).digest('hex') },
    { id: workerId, peerId: controllerId, tokenHash: createHash('sha256').update(workerToken).digest('hex') },
  ] })
  owned.push(relay)
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (!address || typeof address === 'string') throw new Error('native file relay did not acquire its owned port')
  const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl: `http://127.0.0.1:${address.port}`, sharedKey: randomBytes(32).toString('base64url'), allowLoopback: true, requestTimeoutMs: 4000 }
  const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title', 'files']
  const grant = { version: 2, grantId: 'native-files-grant', principal: { kind: 'controller', id: controllerId }, machineKey, revision: 1, issuedAt: 0, projects: [],
    projectRegistration: { actions: ['project.register'], projectGrant: { actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses: classes,
      createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'], exportClasses: classes } } } }
  const workerSettings = await parseSettingsV2({ version: 2, role: 'worker', id: 'native-files-worker', machineKey, projects: {}, pairs: [
    { ...common, id: workerId, peerId: controllerId, relayToken: workerToken, stateDir: './worker-state', grant },
  ] }, path.join(worker.root, 'worker-settings.json'))
  const workerRuntime = await openFederationRuntime(workerSettings, { backend }); owned.push(workerRuntime); workerRuntime.start()
  const controllerSettings = await parseSettingsV2({ version: 2, role: 'controller', id: 'native-files-controller', pairs: [
    { ...common, id: controllerId, peerId: workerId, relayToken: controllerToken, stateDir: './controller-state' },
  ] }, path.join(worker.root, 'controller-settings.json'))
  const controllerRuntime = await openFederationRuntime(controllerSettings); owned.push(controllerRuntime); controllerRuntime.start()
  const pair = controllerSettings.pairs[0]
  if (!pair) throw new Error('native file Controller pairing was not retained')
  const provider = await createHostProvider({ runtime: controllerRuntime, pair, RemoteError: worker.protocol.RemoteError })
  const signal = new AbortController().signal
  const registration = await provider.projectRegistration.state(signal)
  const directory = path.join(worker.root, 'Worker file conversation'); await mkdir(directory)
  const project = await provider.projectRegistration.register({ requestId: 'native_file_project' as SessionRequestId, path: directory, expected: registration.expected }, signal)
  const ref = await provider.create(project, 'native_file_session' as SessionRequestId, signal)
  const binding = await provider.bind(ref, signal)
  expect(binding.capabilities.files).toBe(true); expect(binding.capabilities.attachments).toBe(true)
  const files = provider.files
  if (!files) throw new Error('verified Worker file provider was not negotiated')
  const original = Buffer.from('Verbatim native bytes Ж\u0000\n'.repeat(2200), 'utf8')
  const started = await files.uploadStart(ref, { kind: 'file', name: 'uploaded-Ж.bin' }, signal)
  let index = 0
  for (let offset = 0; offset < original.length; offset += 16 * 1024) {
    const next = await files.uploadChunk(ref, { transferId: started.transferId, index, data: original.subarray(offset, offset + 16 * 1024).toString('base64') }, signal)
    expect(next.nextIndex).toBe(++index)
  }
  const uploaded = await files.uploadFinish(ref, { transferId: started.transferId, index }, signal)
  if (uploaded.kind !== 'file') throw new Error('file upload returned another native attachment kind')
  expect(uploaded.file.name).toBe('uploaded-Ж.bin'); expect(uploaded.file.bytes).toBe(original.length)
  const expected = await provider.modelState(ref, signal)
  const prompt = { requestId: 'native_file_prompt' as SessionRequestId, expected, text: 'Inspect the uploaded file', uploads: [{ kind: 'file' as const, receiptId: uploaded.receiptId }] }
  expect(await provider.prompt(ref, prompt, signal)).toEqual({ accepted: true })
  const nativeId = worker.session.SessionId(ref.sessionId)
  const nativeOperation = Object.values(workerRuntime.peers.get(machineKey)?.journal.snapshot().operations ?? {})
    .find(row => row.action === 'session.prompt' && row.requestId === prompt.requestId)
  if (!nativeOperation || nativeOperation.state !== 'committed') throw new Error('native prompt operation did not retain its committed scoped identity')
  const isFilePrompt = (event: import('@deepseek-ai/dsh-session').SessionEvent): boolean => event.type === 'user/message'
    && 'rpcId' in event.data.source && event.data.source.rpcId === nativeOperation.nativeRequestId
    && event.data.content.some(part => part.type === 'file' && part.attachment.attachmentId === uploaded.file.attachmentId)
  await vi.waitFor(() => {
    const native = worker.ctx.sessions.get(nativeId)
    expect(native).toBeDefined()
    const messages = native?.snapshotEvents().filter(isFilePrompt) ?? []
    expect(messages).toHaveLength(1)
    const message = messages[0]
    if (message?.type !== 'user/message') throw new Error('native prompt message was not committed')
    expect(message.data.content).toContainEqual({ type: 'file', attachment: uploaded.file })
    expect(requests.length).toBeGreaterThan(0)
    expect(worker.ctx.agents.get(nativeId)?.status).toBe('idle')
  }, { timeout: 10_000 })
  const modelCalls = requests.length
  expect(await provider.prompt(ref, prompt, signal)).toEqual({ accepted: true })
  expect(worker.ctx.sessions.get(nativeId)?.snapshotEvents().filter(isFilePrompt)).toHaveLength(1)
  expect(requests).toHaveLength(modelCalls)
  const chunks: Buffer[] = []
  let transferId: typeof started.transferId | undefined
  for (let downloadIndex = 0; ; downloadIndex++) {
    const page = await files.attachment(ref, { file: uploaded.file, index: downloadIndex, ...(transferId === undefined ? {} : { transferId }) }, signal)
    expect(page.index).toBe(downloadIndex); transferId = page.transferId
    const bytes = Buffer.from(page.data, 'base64'); expect(bytes.length).toBeLessThanOrEqual(16 * 1024); chunks.push(bytes)
    if (page.eof) break
  }
  expect(Buffer.concat(chunks)).toEqual(original)
}, 30_000)
