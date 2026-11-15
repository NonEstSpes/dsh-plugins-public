/** Native image normalization, receipt admission and authorized image bytes through the authenticated Source pair. */
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

it('normalizes an uploaded PNG on the Worker, admits its native image part once and reads the verified image bytes', async () => {
  const requests: GenerateOptions[] = []
  const worker = await openNativeFilesWorker(llm => new class extends llm.LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: provider } }
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return Promise.resolve([{ provider, id: 'native-files-model', name: 'Native image model' }]) }
    override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id, name: id }) }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Native image received' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native image received' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }(), '0.1.7')
  const owned: { close(): void | Promise<void> }[] = [worker]
  onTestFinished(async () => {
    const errors: unknown[] = []
    for (const resource of owned.reverse()) {
      try { await resource.close() } catch (error: unknown) { errors.push(error) }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Native image fixture teardown failed')
  })
  const backend = await createNativeAdapter({ ctx: worker.ctx, settings: { projects: {} },
    native: { cordis: worker.cordis, llm: worker.llm, session: worker.session, sandbox: worker.sandbox, controllerOwner: worker.owner } })
  owned.push(backend)
  const controllerId = 'image-controller', workerId = 'image-worker', machineKey = 'native-image-machine'
  const controllerToken = randomBytes(32).toString('base64url'), workerToken = randomBytes(32).toString('base64url')
  const relay = createRelay({ directory: path.join(worker.root, 'relay'), pollMs: 20, devices: [
    { id: controllerId, peerId: workerId, tokenHash: createHash('sha256').update(controllerToken).digest('hex') },
    { id: workerId, peerId: controllerId, tokenHash: createHash('sha256').update(workerToken).digest('hex') },
  ] })
  owned.push(relay)
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (!address || typeof address === 'string') throw new Error('native image relay did not acquire its owned port')
  const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl: `http://127.0.0.1:${address.port}`, sharedKey: randomBytes(32).toString('base64url'), allowLoopback: true, requestTimeoutMs: 4000 }
  const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title', 'files']
  const grant = { version: 2, grantId: 'native-image-grant', principal: { kind: 'controller', id: controllerId }, machineKey, revision: 1, issuedAt: 0, projects: [],
    projectRegistration: { actions: ['project.register'], projectGrant: { actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses: classes,
      createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'], exportClasses: classes } } } }
  const workerSettings = await parseSettingsV2({ version: 2, role: 'worker', id: 'native-image-worker', machineKey, projects: {}, pairs: [
    { ...common, id: workerId, peerId: controllerId, relayToken: workerToken, stateDir: './worker-state', grant },
  ] }, path.join(worker.root, 'worker-settings.json'))
  const workerRuntime = await openFederationRuntime(workerSettings, { backend }); owned.push(workerRuntime); workerRuntime.start()
  const controllerSettings = await parseSettingsV2({ version: 2, role: 'controller', id: 'native-image-controller', pairs: [
    { ...common, id: controllerId, peerId: workerId, relayToken: controllerToken, stateDir: './controller-state' },
  ] }, path.join(worker.root, 'controller-settings.json'))
  const controllerRuntime = await openFederationRuntime(controllerSettings); owned.push(controllerRuntime); controllerRuntime.start()
  const pair = controllerSettings.pairs[0]
  if (!pair) throw new Error('native image Controller pairing was not retained')
  const provider = await createHostProvider({ runtime: controllerRuntime, pair, RemoteError: worker.protocol.RemoteError })
  const signal = new AbortController().signal
  const registration = await provider.projectRegistration.state(signal)
  const directory = path.join(worker.root, 'Worker image conversation'); await mkdir(directory)
  const project = await provider.projectRegistration.register({ requestId: 'native_image_project' as SessionRequestId, path: directory, expected: registration.expected }, signal)
  const ref = await provider.create(project, 'native_image_session' as SessionRequestId, signal)
  const binding = await provider.bind(ref, signal)
  expect(binding.nativeImages).toBe(true)
  const files = provider.files
  if (!files?.image) throw new Error('verified native image extension was not negotiated')
  // The SDK's own attachment-store test uses this fully decoded RGB PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC', 'base64')
  const started = await files.uploadStart(ref, { kind: 'image', mediaType: 'image/png', name: 'pixel.png' }, signal)
  expect(await files.uploadChunk(ref, { transferId: started.transferId, index: 0, data: png.toString('base64') }, signal)).toEqual({ nextIndex: 1 })
  const uploaded = await files.uploadFinish(ref, { transferId: started.transferId, index: 1 }, signal)
  if (uploaded.kind !== 'image') throw new Error('image upload did not return a native normalized image reference')
  expect(uploaded.image.width).toBe(1); expect(uploaded.image.height).toBe(1)
  const attachments = worker.ctx.get('attachments')
  if (!attachments) throw new Error('native image store was not retained')
  const nativeImage = await attachments.readImage(uploaded.image, signal)
  const expected = await provider.modelState(ref, signal)
  const prompt = { requestId: 'native_image_prompt' as SessionRequestId, expected, text: 'Inspect the uploaded image', uploads: [{ kind: 'image' as const, receiptId: uploaded.receiptId }] }
  expect(await provider.prompt(ref, prompt, signal)).toEqual({ accepted: true })
  const nativeId = worker.session.SessionId(ref.sessionId)
  const operation = Object.values(workerRuntime.peers.get(machineKey)?.journal.snapshot().operations ?? {})
    .find(row => row.action === 'session.prompt' && row.requestId === prompt.requestId)
  if (!operation || operation.state !== 'committed') throw new Error('native image prompt did not retain its scoped identity')
  const isImagePrompt = (event: import('@deepseek-ai/dsh-session').SessionEvent): boolean => event.type === 'user/message'
    && 'rpcId' in event.data.source && event.data.source.rpcId === operation.nativeRequestId
    && event.data.content.some(part => part.type === 'image' && part.attachment.attachmentId === uploaded.image.attachmentId)
  await vi.waitFor(() => {
    expect(worker.ctx.sessions.get(nativeId)?.snapshotEvents().filter(isImagePrompt)).toHaveLength(1)
    expect(requests.length).toBeGreaterThan(0)
    expect(worker.ctx.agents.get(nativeId)?.status).toBe('idle')
  }, { timeout: 10_000 })
  const calls = requests.length
  expect(await provider.prompt(ref, prompt, signal)).toEqual({ accepted: true })
  expect(worker.ctx.sessions.get(nativeId)?.snapshotEvents().filter(isImagePrompt)).toHaveLength(1)
  expect(requests).toHaveLength(calls)
  const chunks: Buffer[] = []
  let transferId: typeof started.transferId | undefined
  for (let index = 0; ; index++) {
    const page = await files.image(ref, { image: uploaded.image, index, ...(transferId === undefined ? {} : { transferId }) }, signal)
    expect(page.index).toBe(index); transferId = page.transferId
    const bytes = Buffer.from(page.data, 'base64'); expect(bytes.length).toBeLessThanOrEqual(16 * 1024); chunks.push(bytes)
    if (page.eof) break
  }
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(nativeImage.data))
}, 30_000)
