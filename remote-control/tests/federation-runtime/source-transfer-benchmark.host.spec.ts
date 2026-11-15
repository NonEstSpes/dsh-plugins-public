/** One actual-SDK HTTP/JWE baseline; timings are observations, never latency acceptance thresholds. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { arch, platform, release } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { openNativeFilesWorker } from './fixtures/native-files-worker.host.ts'
import { createNativeAdapter } from '../../lib/federation/native-adapter.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import { createRelay } from '../../relay/server.mjs'

interface RouteCount { requests: number; requestBodyContentLengthBytes: number; missingRequestContentLength: number; responseBodyContentLengthBytes: number; missingResponseContentLength: number }
type Routes = Record<string, RouteCount>
interface DiskCount { files: number; bytes: number }
const routeNames = new Set(['/health', '/v1/send', '/v1/poll', '/v1/ack', '/v1/live/info', '/v1/live/send', '/v1/live/poll'])
const emptyRoute = (): RouteCount => ({ requests: 0, requestBodyContentLengthBytes: 0, missingRequestContentLength: 0, responseBodyContentLengthBytes: 0, missingResponseContentLength: 0 })
const length = (value: string | number | readonly string[] | undefined): number | undefined => {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const size = Number(value)
  return Number.isSafeInteger(size) && size >= 0 ? size : undefined
}
const copyRoutes = (routes: Routes): Routes => Object.fromEntries(Object.entries(routes).map(([key, value]) => [key, { ...value }]))
const routeDelta = (before: Routes, after: Routes): Routes => Object.fromEntries(Object.entries(after).map(([key, value]) => {
  const previous = before[key] ?? emptyRoute()
  return [key, { requests: value.requests - previous.requests, requestBodyContentLengthBytes: value.requestBodyContentLengthBytes - previous.requestBodyContentLengthBytes,
    missingRequestContentLength: value.missingRequestContentLength - previous.missingRequestContentLength,
    responseBodyContentLengthBytes: value.responseBodyContentLengthBytes - previous.responseBodyContentLengthBytes,
    missingResponseContentLength: value.missingResponseContentLength - previous.missingResponseContentLength }]
}))
const diskDelta = (before: Record<string, DiskCount>, after: Record<string, DiskCount>): Record<string, DiskCount> => Object.fromEntries(Object.entries(after).map(([key, value]) => [key,
  { files: value.files - (before[key]?.files ?? 0), bytes: value.bytes - (before[key]?.bytes ?? 0) }]))
const milliseconds = (start: number): number => Math.round((performance.now() - start) * 1000) / 1000
async function diskBytes(directory: string): Promise<DiskCount> {
  let entries
  try { entries = await readdir(directory, { withFileTypes: true }) }
  catch (error: unknown) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { files: 0, bytes: 0 }; throw error }
  const count = { files: 0, bytes: 0 }
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    let info
    try { info = await lstat(target) }
    catch (error: unknown) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error }
    if (info.isSymbolicLink()) throw new Error('benchmark-owned state directory contains a link')
    if (info.isDirectory()) { const nested = await diskBytes(target); count.files += nested.files; count.bytes += nested.bytes }
    else if (info.isFile()) { count.files++; count.bytes += info.size }
  }
  return count
}

async function measure(relayTransport: 'https' | 'auto'): Promise<void> {
  const owned: { close(): void | Promise<void> }[] = [], routes: Routes = {}, samples: object[] = []
  const started = performance.now(), memoryBaseline = process.memoryUsage(), memoryPeak = { ...memoryBaseline }
  const sampleMemory = (): void => {
    const value = process.memoryUsage()
    memoryPeak.rss = Math.max(memoryPeak.rss, value.rss); memoryPeak.heapUsed = Math.max(memoryPeak.heapUsed, value.heapUsed); memoryPeak.heapTotal = Math.max(memoryPeak.heapTotal, value.heapTotal)
    memoryPeak.external = Math.max(memoryPeak.external, value.external); memoryPeak.arrayBuffers = Math.max(memoryPeak.arrayBuffers, value.arrayBuffers)
  }
  const sampler = setInterval(sampleMemory, 50), controller = new AbortController()
  const deadline = setTimeout(() => { controller.abort(new Error('source transfer benchmark deadline')) }, 115_000)
  let closing: Promise<void> | undefined, closeMs: number | undefined, modelCalls = 0
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      const begin = performance.now(), errors: unknown[] = []
      controller.abort(new Error('source transfer benchmark closed'))
      for (const resource of owned.reverse()) { try { await resource.close() } catch (error: unknown) { errors.push(error) } }
      clearTimeout(deadline); clearInterval(sampler); sampleMemory(); closeMs = milliseconds(begin)
      if (errors.length > 0) throw new AggregateError(errors, 'source transfer benchmark teardown failed')
    })()
    return closing
  }
  onTestFinished(close)
  const worker = await openNativeFilesWorker(llm => new class extends llm.LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: provider } }
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return Promise.resolve([{ provider, id: 'native-files-model', name: 'Native files model' }]) }
    override resolveModel(provider: string, id: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id, name: id }) }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      modelCalls++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Native benchmark file received' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native benchmark file received' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }(), '0.1.7')
  owned.push(worker)
  const backend = await createNativeAdapter({ ctx: worker.ctx, settings: { projects: {} },
    native: { cordis: worker.cordis, llm: worker.llm, session: worker.session, sandbox: worker.sandbox, controllerOwner: worker.owner } })
  owned.push(backend)
  const controllerId = 'baseline-controller', workerId = 'baseline-worker', machineKey = 'source-baseline-machine'
  const controllerToken = randomBytes(32).toString('base64url'), workerToken = randomBytes(32).toString('base64url')
  const relay = createRelay({ directory: path.join(worker.root, 'relay'), pollMs: 20, devices: [
    { id: controllerId, peerId: workerId, tokenHash: createHash('sha256').update(controllerToken).digest('hex') },
    { id: workerId, peerId: controllerId, tokenHash: createHash('sha256').update(workerToken).digest('hex') },
  ] })
  owned.push(relay)
  const observe = (request: IncomingMessage, response: ServerResponse): void => {
    const route = routeNames.has(request.url ?? '') ? request.url : 'other'
    const key = `${request.method === 'POST' ? 'POST' : request.method === 'GET' ? 'GET' : 'OTHER'} ${route}`
    const count = routes[key] ??= emptyRoute(), requestBytes = length(request.headers['content-length'])
    count.requests++; if (requestBytes === undefined) count.missingRequestContentLength++; else count.requestBodyContentLengthBytes += requestBytes
    response.once('finish', () => {
      const responseBytes = length(response.getHeader('content-length'))
      if (responseBytes === undefined) count.missingResponseContentLength++; else count.responseBodyContentLengthBytes += responseBytes
    })
  }
  relay.server.on('request', observe)
  owned.push({ close() { relay.server.off('request', observe) } })
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (!address || typeof address === 'string') throw new Error('baseline relay did not acquire its owned port')
  const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl: `http://127.0.0.1:${address.port}`, sharedKey: randomBytes(32).toString('base64url'), allowLoopback: true, requestTimeoutMs: 4000,
    relayTransport, ...(relayTransport === 'auto' ? { relaySocketConnectTimeoutMs: 1000 } : {}) }
  const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title', 'files']
  const grant = { version: 2, grantId: 'source-baseline-grant', principal: { kind: 'controller', id: controllerId }, machineKey, revision: 1, issuedAt: 0, projects: [],
    projectRegistration: { actions: ['project.register'], projectGrant: { actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses: classes,
      createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'], exportClasses: classes } } } }
  const workerSettings = await parseSettingsV2({ version: 2, role: 'worker', id: 'baseline-worker', machineKey, projects: {}, pairs: [
    { ...common, id: workerId, peerId: controllerId, relayToken: workerToken, stateDir: './worker-state', grant },
  ] }, path.join(worker.root, 'worker-settings.json'))
  const workerRuntime = await openFederationRuntime(workerSettings, { backend }); owned.push(workerRuntime); workerRuntime.start()
  const controllerSettings = await parseSettingsV2({ version: 2, role: 'controller', id: 'baseline-controller', pairs: [
    { ...common, id: controllerId, peerId: workerId, relayToken: controllerToken, stateDir: './controller-state' },
  ] }, path.join(worker.root, 'controller-settings.json'))
  const controllerRuntime = await openFederationRuntime(controllerSettings); owned.push(controllerRuntime); controllerRuntime.start()
  const pair = controllerSettings.pairs[0]
  if (!pair) throw new Error('baseline Controller pairing was not retained')
  const provider = await createHostProvider({ runtime: controllerRuntime, pair, RemoteError: worker.protocol.RemoteError }), signal = controller.signal
  const startupMs = milliseconds(started), registerStart = performance.now()
  const registration = await provider.projectRegistration.state(signal), directory = path.join(worker.root, 'Baseline conversation')
  await mkdir(directory)
  const project = await provider.projectRegistration.register({ requestId: 'baseline_project' as SessionRequestId, path: directory, expected: registration.expected }, signal)
  const projectRegisterMs = milliseconds(registerStart), createStart = performance.now()
  const ref = await provider.create(project, 'baseline_session' as SessionRequestId, signal), binding = await provider.bind(ref, signal)
  expect(binding.capabilities.files).toBe(true); expect(binding.capabilities.attachments).toBe(true)
  const createAndBindMs = milliseconds(createStart), files = provider.files, nativeId = worker.session.SessionId(ref.sessionId)
  const privateDisk = async (): Promise<Record<string, DiskCount>> => ({
    workerPair: await diskBytes(path.join(worker.root, 'worker-state')), controllerPair: await diskBytes(path.join(worker.root, 'controller-state')), relay: await diskBytes(path.join(worker.root, 'relay')),
  })
  const transports = () => ({
    workerControl: workerRuntime.peers.get(machineKey)?.endpoint.status().transport,
    controllerControl: controllerRuntime.peers.get(machineKey)?.endpoint.status().transport,
    workerLive: workerRuntime.peers.get(machineKey)?.liveChannel?.status().transport,
    controllerLive: controllerRuntime.peers.get(machineKey)?.liveChannel?.status().transport,
  })
  const privateDiskBefore = await privateDisk(), transportBefore = transports()
  for (const bytes of [16 * 1024, 128 * 1024, 512 * 1024]) {
    signal.throwIfAborted()
    const original = Buffer.allocUnsafe(bytes)
    for (let index = 0; index < original.length; index++) original[index] = index % 251
    const diskBefore = await privateDisk(), httpBefore = copyRoutes(routes), callsBefore = modelCalls, uploadStart = performance.now()
    const transfer = await files.uploadStart(ref, { kind: 'file', name: `baseline-${bytes}.bin` }, signal)
    let uploadChunks = 0
    for (let offset = 0; offset < original.length; offset += 16 * 1024) {
      const next = await files.uploadChunk(ref, { transferId: transfer.transferId, index: uploadChunks, data: original.subarray(offset, offset + 16 * 1024).toString('base64') }, signal)
      expect(next.nextIndex).toBe(++uploadChunks)
    }
    const uploaded = await files.uploadFinish(ref, { transferId: transfer.transferId, index: uploadChunks }, signal)
    if (uploaded.kind !== 'file') throw new Error('baseline file upload returned another attachment kind')
    expect(uploaded.file.bytes).toBe(bytes)
    const uploadMs = milliseconds(uploadStart), httpUploaded = copyRoutes(routes), promptStart = performance.now(), expected = await provider.modelState(ref, signal)
    const prompt = { requestId: `baseline_prompt_${bytes}` as SessionRequestId, expected, text: 'Acknowledge this benchmark file', uploads: [{ kind: 'file' as const, receiptId: uploaded.receiptId }] }
    expect(await provider.prompt(ref, prompt, signal)).toEqual({ accepted: true })
    const operation = Object.values(workerRuntime.peers.get(machineKey)?.journal.snapshot().operations ?? {})
      .find(row => row.action === 'session.prompt' && row.requestId === prompt.requestId)
    if (!operation || operation.state !== 'committed') throw new Error('baseline prompt did not retain its committed native identity')
    await vi.waitFor(() => {
      const log = worker.ctx.sessions.get(nativeId)?.snapshotEvents() ?? []
      expect(log.filter(event => event.type === 'user/message' && 'rpcId' in event.data.source && event.data.source.rpcId === operation.nativeRequestId
        && event.data.content.some(part => part.type === 'file' && part.attachment.attachmentId === uploaded.file.attachmentId))).toHaveLength(1)
      expect(worker.ctx.agents.get(nativeId)?.status).toBe('idle'); expect(modelCalls).toBeGreaterThan(callsBefore)
    }, { timeout: 10_000, interval: 25 })
    const promptAndNativeIdleMs = milliseconds(promptStart), httpPrompted = copyRoutes(routes), downloadStart = performance.now()
    let transferId: typeof transfer.transferId | undefined, received = 0, downloadChunks = 0, downloadFrames = 0
    for (;;) {
      const page = await files.attachment(ref, { file: uploaded.file, index: downloadFrames, ...(transferId === undefined ? {} : { transferId }) }, signal)
      expect(page.index).toBe(downloadFrames++); transferId = page.transferId
      const chunk = Buffer.from(page.data, 'base64')
      expect(chunk.length).toBeLessThanOrEqual(16 * 1024)
      expect(chunk.equals(original.subarray(received, received + chunk.length))).toBe(true)
      received += chunk.length; if (chunk.length > 0) downloadChunks++
      if (page.eof) break
    }
    expect(received).toBe(bytes)
    const downloadMs = milliseconds(downloadStart), httpDownloaded = copyRoutes(routes), diskAfter = await privateDisk()
    sampleMemory()
    samples.push({ bytes, uploadChunks, downloadChunks, downloadFrames, durationsMs: { upload: uploadMs, promptModelStateAdmissionAndNativeIdle: promptAndNativeIdleMs, download: downloadMs },
      http: { upload: routeDelta(httpBefore, httpUploaded), prompt: routeDelta(httpUploaded, httpPrompted), download: routeDelta(httpPrompted, httpDownloaded) },
      privateDiskBefore: diskBefore, privateDiskAfter: diskAfter, privateDiskGrowth: diskDelta(diskBefore, diskAfter), modelCalls: modelCalls - callsBefore, verifiedNativeEofAndExactBytes: true })
  }
  const privateDiskAfter = await privateDisk(), httpBeforeClose = copyRoutes(routes), transportBeforeClose = transports()
  await close(); relay.server.off('request', observe)
  console.log('SOURCE_TRANSFER_AFTER_REPORT ' + JSON.stringify({ version: 1,
    context: { workerVersion: '0.1.7', sdk: 'canonical Loader composition', transport: relayTransport, endpointStateVersion: 2,
      network: '127.0.0.1 loopback; no TLS', relayPollMs: 20,
      chunkBytes: 16384, concurrency: 1, samplesPerSize: 1, nativeSessions: 1, model: 'scripted external LLM only', node: process.version, os: { platform: platform(), arch: arch(), release: release() },
      httpBytes: 'advertised Content-Length only; missing headers counted, not estimated; excludes headers/TLS/socket overhead',
      httpPhaseAttribution: 'observer event times include autonomous polling; response completion can cross phase cuts',
      memory: '50 ms process-wide samples include runner, Controller, Worker, Relay and test buffers; no forced GC; not isolated Worker RSS',
      disk: 'non-atomic snapshots of logical regular-file bytes in the three owned pair/relay directories; concurrently removed entries omitted; excludes native blobs and physical-allocation estimates' },
    durationsMs: { startup: startupMs, projectRegistration: projectRegisterMs, createAndBind: createAndBindMs, close: closeMs, total: milliseconds(started) },
    memory: { baseline: memoryBaseline, sampledPeak: memoryPeak }, privateDiskBefore, privateDiskAfter, privateDiskGrowth: diskDelta(privateDiskBefore, privateDiskAfter),
    transportBefore, transportBeforeClose, httpBeforeClose, httpTotal: copyRoutes(routes), samples }))
}
it('reports native source transfers over explicit HTTPS mode', () => measure('https'), 120_000)
it('reports native source transfers after compaction over automatic socket transport', () => measure('auto'), 120_000)
