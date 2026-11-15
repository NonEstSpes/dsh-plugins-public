/** Real Loader/include activation of the frozen Worker API; only external model-provider work is scripted. */
import { cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId, type GenerateOptions, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createNativeAdapter } from '../../lib/federation/native-adapter.mjs'
import { projectEvent } from '../../lib/federation/history.mjs'
import { projectNativeMetrics } from '../../lib/federation/metrics.mjs'
import { createRelay } from '../../relay/server.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import type { NativeDetailsBridge, SourceCallMethod, SourceFailureCode, SourceStreamMethod } from './fixtures/native-details/bridge-types.d.mts'
import type {} from '@deepseek-ai/dsh-api-session-source-controller'

const WORKER_NAME = '@dsh-remote/worker-session-controller'
const PREFIX = 'dsh-native-catalog-loader-'
const READ_BUDGET = 25
const DISPOSAL_BUDGET = 60_000
const workerPackage = new URL('../../plugin-native/worker-stage2-0.1.2/packages/worker-session-controller/', import.meta.url)
const apiManifest = new URL('../../../dsh-remote-core/packages/api/session-controller/package.json', import.meta.url)
const sourceRequire = createRequire(apiManifest)

interface PackageManifest {
  name: string
  version: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

interface WorkerOwner {
  readonly SessionController: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  readonly default: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  ownsSourceMutationHelpers(value: object): boolean
  ownsSourceCatalogHelper(value: object): boolean
}

// Runtime SDK classes must come from Node's single native graph, never Vite's source aliases.
const compositionPackages = [
  ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader'],
  ['@deepseek-ai/cordis-plugin-include', 'vendor/include'],
  ['@deepseek-ai/dsh-agent-loop-testkit', 'packages/test-support/agent-loop-testkit'],
  ['@deepseek-ai/dsh-fs-local', 'packages/fs/fs-local'],
  ['@deepseek-ai/dsh-session-persistence-jsonl', 'packages/session/session-persistence-jsonl'],
  ['@deepseek-ai/dsh-storage', 'packages/storage/storage'],
  ['@deepseek-ai/dsh-storage-json', 'packages/storage/storage-json'],
  ['@deepseek-ai/dsh-storage-domain', 'packages/storage/storage-domain'],
  ['@deepseek-ai/dsh-workspace', 'packages/workspace/workspace'],
  ['@deepseek-ai/dsh-credentials-local', 'packages/credentials/credentials-local'],
  ['@deepseek-ai/dsh-client-connection', 'packages/client/connection'],
  ['@deepseek-ai/dsh-client-file-upload', 'packages/client/file-upload'],
  ['@deepseek-ai/dsh-attachment-local', 'packages/attachment/attachment-local'],
  ['@deepseek-ai/dsh-agent-default-model', 'packages/core/agent-default-model'],
  ['@deepseek-ai/dsh-commands', 'packages/interaction/commands'],
  ['@deepseek-ai/dsh-typert-registry', 'packages/typert/registry'],
  ['@deepseek-ai/dsh-api-remote-access', 'packages/api/remote-access'],
  ['@deepseek-ai/dsh-api-gateway', 'packages/api/gateway'],
  ['@deepseek-ai/dsh-api-session-source-controller', 'packages/api/session-source-controller'],
  ['@deepseek-ai/dsh-session-query-sqlite', 'packages/session-query/session-query-sqlite'],
  ['@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'],
  ['@deepseek-ai/dsh-session-stats', 'packages/session/session-stats'],
  ['@deepseek-ai/dsh-token-meter', 'packages/llm/token-meter'],
] as const

async function manifestAt(filename: URL | string): Promise<PackageManifest> {
  return JSON.parse(await readFile(filename, 'utf8')) as PackageManifest
}

async function ownerPackageDirectory(name: string): Promise<string> {
  let directory = path.dirname(sourceRequire.resolve(name))
  for (;;) {
    try {
      if ((await manifestAt(path.join(directory, 'package.json'))).name === name) return await realpath(directory)
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`native SDK package root not found: ${name}`)
    directory = parent
  }
}

async function nativeGraph(root: string) {
  const manifest = await manifestAt(new URL('package.json', workerPackage))
  expect(manifest.name).toBe(WORKER_NAME)
  expect(manifest.version).toBe('0.1.2')
  const packages = new Map<string, string>()
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
    packages.set(name, await ownerPackageDirectory(name))
  }
  packages.set('@deepseek-ai/dsh-api-session-controller', await realpath(fileURLToPath(new URL('.', apiManifest))))
  for (const [name, folder] of compositionPackages) {
    const directory = await realpath(fileURLToPath(new URL(`../../../dsh-remote-core/${folder}/`, import.meta.url)))
    expect((await manifestAt(path.join(directory, 'package.json'))).name).toBe(name)
    if (packages.has(name)) expect(packages.get(name)).toBe(directory)
    packages.set(name, directory)
  }
  // Consume the built BFF as an isolated package, with all peers resolved by this same native graph.
  const bffName = '@deepseek-ai/dsh-api-session-source-controller', bffSource = packages.get(bffName)
  if (bffSource === undefined) throw new Error('native source BFF package is absent')
  const bffManifest = await manifestAt(path.join(bffSource, 'package.json'))
  for (const name of Object.keys({ ...bffManifest.dependencies, ...bffManifest.peerDependencies })) {
    if (!packages.has(name)) packages.set(name, await ownerPackageDirectory(name))
  }
  const bff = path.join(root, 'payloads', 'source-bff')
  await mkdir(bff, { recursive: true })
  await copyFile(path.join(bffSource, 'package.json'), path.join(bff, 'package.json'))
  await cp(path.join(bffSource, 'lib'), path.join(bff, 'lib'), { recursive: true })
  packages.set(bffName, bff)
  const canonical = path.join(root, 'payloads', 'canonical-worker-api')
  await mkdir(path.join(canonical, 'lib'), { recursive: true })
  for (const relative of ['package.json', 'lib/index.js', 'lib/controller-impl.js']) {
    await copyFile(new URL(relative, workerPackage), path.join(canonical, relative))
  }
  packages.set(WORKER_NAME, canonical)
  for (const [name, directory] of packages) {
    const target = path.join(root, 'node_modules', ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(directory, target, 'junction')
  }
  await writeFile(path.join(root, 'package.json'), '{"name":"native-catalog-loader-fixture","private":true,"type":"module"}\n')
  // Node 24 require(ESM) deliberately avoids Vitest's SDK/source module runner.
  const require = createRequire(path.join(root, 'package.json'))
  const cordis: typeof import('@deepseek-ai/cordis') = require('@deepseek-ai/cordis')
  const protocol: typeof import('@deepseek-ai/dsh-typert-protocol') = require('@deepseek-ai/dsh-typert-protocol')
  expect(Object.getPrototypeOf(protocol.TypertRemoteService.prototype)).toBe(cordis.Service.prototype)
  const owner: WorkerOwner = require(WORKER_NAME)
  expect(owner.default).toBe(owner.SessionController)
  return { require, cordis, owner }
}

function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  const unexpected = (): never => { throw new Error('this Loader composition does not use Node HMR operations') }
  return {
    version: 'v2', loadCache: new Map(), register: unexpected, getOrCreateModuleJob: unexpected,
    resolveSync: unexpected, load: unexpected,
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  }
}

function registryListeners(ctx: Context): number[] {
  return [
    (ctx.events.dispatch('emit', ['llm/adapters-updated']) as Array<() => unknown>).length,
    (ctx.events.dispatch('emit', ['llm/models-updated', 'worker-good']) as Array<() => unknown>).length,
  ]
}

it('boots the packaged bounded helper through cordis.yml and releases its concrete Loader owner', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), PREFIX)))
  let context: Context | undefined
  const backends: Array<Awaited<ReturnType<typeof createNativeAdapter>>> = []
  const carriers: Array<{ close(): void | Promise<unknown> }> = []
  let releaseProviders = (): void => {}
  onTestFinished(async () => {
    vi.useRealTimers()
    for (const carrier of [...carriers].reverse()) await carrier.close()
    for (const backend of backends) await backend.close()
    releaseProviders()
    await context?.fiber.dispose()
    const target = await realpath(root)
    expect(path.dirname(target)).toBe(await realpath(tmpdir()))
    expect(path.basename(target).startsWith(PREFIX)).toBe(true)
    await rm(target, { recursive: true, force: true })
  })
  const graph = await nativeGraph(root)
  const llm: typeof import('@deepseek-ai/dsh-llm') = graph.require('@deepseek-ai/dsh-llm')
  const session: typeof import('@deepseek-ai/dsh-session') = graph.require('@deepseek-ai/dsh-session')
  const sandbox: typeof import('@deepseek-ai/dsh-sandbox-policy') = graph.require('@deepseek-ai/dsh-sandbox-policy')
  const testkit: typeof import('@deepseek-ai/dsh-agent-loop-testkit') = graph.require('@deepseek-ai/dsh-agent-loop-testkit')
  const loader: typeof import('@deepseek-ai/cordis-plugin-loader') = graph.require('@deepseek-ai/cordis-plugin-loader')
  const include: typeof import('@deepseek-ai/cordis-plugin-include') = graph.require('@deepseek-ai/cordis-plugin-include')
  const fsLocal: typeof import('@deepseek-ai/dsh-fs-local') = graph.require('@deepseek-ai/dsh-fs-local')

  const slowListing = Promise.withResolvers<readonly LlmModelInfo[]>()
  const heldMetadata = Promise.withResolvers<LlmResolvedModelInfo>()
  const metadataStarted = Promise.withResolvers<AbortSignal | undefined>()
  const lateSecret = 'FICTIONAL_PROVIDER_SECRET_MUST_NOT_ESCAPE'
  let holdGoodMetadata = false
  let slowCalls = 0
  let streams = 0
  const resolved = (provider: string, model: string): LlmResolvedModelInfo => ({ provider, id: model, name: model,
    reasoning: { efforts: [
      { id: llm.ReasoningEffortId('low'), name: 'Low', description: 'Lower reasoning budget' },
      { id: llm.ReasoningEffortId('high'), name: 'High', description: 'Higher reasoning budget' },
    ], defaultEffort: llm.ReasoningEffortId('high') },
  })
  class ExternalCatalogAdapter extends llm.LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: provider === 'worker-good' ? 'Worker Good' : 'Worker Hung' } }
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
      if (provider === 'worker-hung') { slowCalls++; return slowListing.promise }
      return Promise.resolve([{ provider, id: 'good-model', name: 'Good model', description: 'Full native metadata', badge: { text: 'Fixture', tone: 'info' } }])
    }
    override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      if (holdGoodMetadata) { metadataStarted.resolve(signal); return heldMetadata.promise }
      return Promise.resolve(resolved(provider, model))
    }
    override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      streams++
      throw new Error('passive catalog unexpectedly resumed an Agent')
    }
  }
  releaseProviders = () => { slowListing.resolve([]); heldMetadata.resolve(resolved('worker-good', 'good-model')) }
  const external = new ExternalCatalogAdapter()
  const ctx = new graph.cordis.Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  const bootstrap = {
    name: 'native-catalog-core-bootstrap',
    async apply(owner: Context) {
      await owner.plugin(fsLocal.default, { cwd: root })
      await testkit.mountAgentLoopTestDependencies(owner, { workingDirectory: true })
      await testkit.mountAgentLoopTestHarness(owner)
    },
  }
  const providers = {
    name: 'native-catalog-external-providers', inject: ['llm'],
    apply(owner: Context) { owner.llm.registerAdapter(['worker-good', 'worker-hung'], external) },
  }
  const modules = new Map<string, unknown>(compositionPackages.map(([name]) => [name, graph.require(name)]))
  modules.set('@fixture/native-core', bootstrap)
  modules.set('@fixture/catalog-providers', providers)
  modules.set(WORKER_NAME, graph.owner)
  const rows = [
    { id: 'native-core', name: '@fixture/native-core' },
    { id: 'native-default', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'worker-good', model: 'good-model', reasoningEffort: 'high' } },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(root, 'native-sessions') } },
    { name: '@deepseek-ai/dsh-storage' },
    { name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(root, 'domain-data') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } },
    { name: '@deepseek-ai/dsh-workspace' },
    { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: root } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: path.join(root, 'fixture-credentials.yaml'), watch: false } },
    // Carrier registries are real; no webServer row is present and no port is opened.
    { name: '@deepseek-ai/dsh-client-connection' },
    { name: '@deepseek-ai/dsh-commands' },
    { name: '@deepseek-ai/dsh-client-file-upload' },
    { name: '@deepseek-ai/dsh-typert-registry' },
    { name: '@deepseek-ai/dsh-api-remote-access' },
    { name: '@deepseek-ai/dsh-api-gateway' },
    { id: 'native-source-bff', name: '@deepseek-ai/dsh-api-session-source-controller' },
    { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: path.join(root, 'derived-query.sqlite'), openAt: 'never' } },
    { name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only' } },
    { name: '@deepseek-ai/dsh-session-stats' },
    { name: '@deepseek-ai/dsh-token-meter' },
    { id: 'fixture-models', name: '@fixture/catalog-providers' },
    { id: 'packaged-worker', name: WORKER_NAME, config: { nativeOpen: false } },
  ]
  const configPath = path.join(root, 'cordis.yml')
  await writeFile(configPath, `${JSON.stringify(rows, null, 2)}\n`)
  await ctx.plugin(loader.default)
  ctx.loader.builtins.include = include.default
  ctx.loader.internal = moduleLoader(modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  const entry = [...ctx.loader.entries()].find(value => value.options.name === WORKER_NAME)
  if (entry?.fiber === undefined) throw new Error('the packaged Worker Loader entry did not activate')
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('Loader did not publish the native Session Controller')
  const original: object = Reflect.get(controller, graph.cordis.symbols.original)
  expect(Object.getPrototypeOf(original)).toBe(graph.owner.SessionController.prototype)
  expect(Object.getOwnPropertyDescriptor(Object.getPrototypeOf(original), 'constructor')?.value).toBe(graph.owner.SessionController)
  expect(graph.owner.ownsSourceMutationHelpers(original)).toBe(true)
  expect(graph.owner.ownsSourceCatalogHelper(original)).toBe(true)
  expect(ctx.get('webServer')).toBeUndefined()
  const sourceBff = ctx.get('sessionSourceController')
  if (sourceBff === undefined) throw new Error('Loader did not publish the real Source BFF')
  const bffModule: typeof import('@deepseek-ai/dsh-api-session-source-controller') = graph.require('@deepseek-ai/dsh-api-session-source-controller')
  const nativeProtocol: typeof import('@deepseek-ai/dsh-typert-protocol') = graph.require('@deepseek-ai/dsh-typert-protocol')
  expect(Object.getPrototypeOf(bffModule.SessionSourceController.prototype)).toBe(nativeProtocol.TypertRemoteService.prototype)
  expect(Object.getPrototypeOf(Reflect.get(sourceBff, graph.cordis.symbols.original))).toBe(bffModule.SessionSourceController.prototype)

  // A real cold native log would drive this queued input if a catalog read accidentally resumed it.
  const cold = session.SessionId('native-catalog-cold-session')
  const prepared = ctx.sessions.prepare(cold, { meta: { cwd: root } })
  const events: SessionEvent[] = [
    { type: 'model/selection', seq: session.SessionSeq(0), time: 1, data: { provider: 'worker-good', model: 'cold-model-never-resume' } },
    { type: 'agent/inbox/spliced', seq: session.SessionSeq(1), time: 2, data: { target: 'next-turn', start: 0,
      inserted: [llm.createUserMessage({ content: [{ type: 'text', text: 'must remain cold' }], source: { kind: 'user' } })] } },
  ]
  const writing = await ctx.sessionPersistence.create(prepared.header)
  try { await writing.append(events) } finally { await writing.close() }
  let created = 0
  ctx.on('agent/created', () => { created++; return undefined })
  const native = { cordis: graph.cordis, llm, session, sandbox, controllerOwner: graph.owner }
  const backend = await createNativeAdapter({ ctx, settings: { projects: {} }, native, modelCatalogProviderTimeoutMs: READ_BUDGET })
  backends.push(backend)
  expect(backend.mutationReadiness).toEqual({ durableJournal: 'verified', firstRouteCapture: 'verified' })
  const detailed = await backend.readDetails({ sessionId: cold }, new AbortController().signal)
  expect(detailed.cursor).toBe(events.length - 1)
  expect(detailed.events).toEqual(events)
  const metrics = projectNativeMetrics({ baseline: detailed.projections, throughSeq: detailed.cursor, exportClasses: ['statistics', 'usage', 'context.metrics'] })
  expect(metrics.availability).toEqual({ sessionStats: 'available', tokenUsage: 'available', contextPressure: 'available', contextBreakdown: 'available' })
  expect(metrics.projections.values.sessionStats).toEqual({ turns: 0, steps: 0, llmMs: 0, toolMs: 0, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0 })
  expect(metrics.projections.values.tokenUsage).toEqual({ uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
  const compact: Parameters<typeof backend.nativeAssistantBlocks>[0] = [
    { type: 'text-chunks', time0: 1, index: 12, dt: [], texts: ['visible text'] },
    { type: 'reasoning-chunks', time0: 2, index: 7, dt: [], texts: ['PRIVATE_NATIVE_REASONING'] },
    { type: 'tool-call-chunks', time0: 3, index: 2, id: ToolCallId('native-call'), name: 'read', dt: [], args: ['{"path":"worker.txt"}'] },
  ]
  const nativeBlocks = backend.nativeAssistantBlocks(compact, false)
  const rich = projectEvent({ type: 'assistant/message', seq: 0, time: 4, surfaceOp: 'append', data: { turn: 1, step: 1,
    message: { id: 'native-assistant', role: 'assistant', source: { kind: 'model', provider: 'worker-good', model: 'good-model' }, content: nativeBlocks }, stream: compact,
  } }, { format: 'native-details-v1', exportClasses: ['conversation.assistant', 'tool.call'], nativeAssistantBlocks: backend.nativeAssistantBlocks })
  expect(rich).toMatchObject({ withheld: false, redacted: true, event: { data: {
    message: { content: [{ type: 'text', text: 'visible text' }, { type: 'tool-call', id: 'native-call', name: 'read', arguments: '{"path":"worker.txt"}' }] },
    stream: [{ type: 'text-chunks', index: 0 }, { type: 'tool-call-chunks', index: 1 }],
  } } })
  expect(JSON.stringify(rich)).not.toContain('PRIVATE_NATIVE_REASONING')
  expect(ctx.agents.get(cold)).toBeUndefined()

  // Exercise private details over real HTTP/JWE before enabling their public negotiation.
  const devices = ['details-controller', 'details-worker'].map(id => ({
    id, peerId: id === 'details-controller' ? 'details-worker' : 'details-controller', token: randomBytes(32).toString('base64url'),
  }))
  const relay = createRelay({ directory: path.join(root, 'details-relay'),
    devices: devices.map(({ token, ...device }) => ({ ...device, tokenHash: createHash('sha256').update(token).digest('hex') })), pollMs: 20 })
  carriers.push(relay)
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (address === null || typeof address === 'string') throw new Error('details relay did not bind a loopback TCP port')
  const projectRoot = path.join(root, 'details-project-root')
  await mkdir(projectRoot)
  const workspace = await ctx.workspaceRegistry.create(projectRoot)
  const machineKey = 'native-details-loader-worker', projectId = 'details-project'
  const reference = { machineKey, projectId, sessionId: cold }
  const exportClasses = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'tool.call', 'tool.result', 'statistics', 'usage', 'context.metrics']
  const grant = { version: 1, grantId: 'details_loader_grant', principal: { kind: 'controller', id: 'details-controller' },
    machineKey, revision: 1, issuedAt: 0, projects: [{ projectId, actions: ['project.list', 'session.list', 'model.list'], exportClasses,
      sessions: [{ sessionId: cold, imported: true, actions: ['session.status', 'session.read', 'session.follow'], exportClasses }] }] }
  const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl: `http://127.0.0.1:${address.port}`,
    sharedKey: randomBytes(32).toString('base64url'), allowLoopback: true, requestTimeoutMs: 5_000 }
  const controllerDevice = devices[0], workerDevice = devices[1]
  if (controllerDevice === undefined || workerDevice === undefined) throw new Error('missing paired test devices')
  const workerSettings = await parseSettingsV2({ version: 2, role: 'worker', id: 'native-details-worker', machineKey,
    projects: { [projectId]: { workspaceId: workspace.id } }, pairs: [{ ...common, id: workerDevice.id, peerId: workerDevice.peerId,
      relayToken: workerDevice.token, stateDir: './details-worker-state', grant }] }, path.join(root, 'details-settings.json'),
  { resolveWorkspace: id => id === workspace.id ? workspace : undefined })
  const transportBackend = await createNativeAdapter({ ctx, settings: { projects: { [projectId]: { workspaceId: workspace.id } } }, native,
    modelCatalogProviderTimeoutMs: READ_BUDGET })
  backends.push(transportBackend)
  expect(typeof transportBackend.readDetails).toBe('function')
  const workerRuntime = await openFederationRuntime(workerSettings, { backend: transportBackend })
  carriers.push(workerRuntime)
  workerRuntime.start()
  const controllerSettings = await parseSettingsV2({ version: 2, role: 'controller', id: 'native-details-controller', pairs: [{ ...common,
    id: controllerDevice.id, peerId: controllerDevice.peerId, relayToken: controllerDevice.token, stateDir: './details-controller-state' }] },
  path.join(root, 'details-settings.json'))
  const controllerRuntime = await openFederationRuntime(controllerSettings)
  carriers.push(controllerRuntime)
  controllerRuntime.start()
  const privateFrame = await controllerRuntime.call(machineKey, 'session.follow.details', { ref: reference, request: { includeAssistantStream: false } }, new AbortController().signal)
  expect(privateFrame).toMatchObject({ type: 'snapshot', page: { throughSeq: detailed.cursor }, projections: metrics.projections })
  expect(created).toBe(0)
  expect(streams).toBe(0)
  expect(ctx.agents.get(cold)).toBeUndefined()
  const hello = await controllerRuntime.call(machineKey, 'hello', {}, new AbortController().signal)
  // Red-first rollout condition: a real details-capable Worker must negotiate independently of catalog support.
  expect(hello).toHaveProperty('features', expect.arrayContaining(['native-details-v1']))

  const controllerPair = controllerSettings.pairs[0]
  if (controllerPair === undefined) throw new Error('missing real Controller pair')
  const provider = await createHostProvider({ runtime: controllerRuntime, pair: controllerPair, RemoteError: nativeProtocol.RemoteError })
  const unregisterProvider = sourceBff.registerSource(provider)
  const brand: typeof import('@deepseek-ai/dsh-brand') = graph.require('@deepseek-ai/dsh-brand')
  const ownerAt = (method: SourceCallMethod | SourceStreamMethod, signal: AbortSignal) => {
    const invocation: import('@deepseek-ai/dsh-typert-protocol').RemoteInvocation = {
      request: { namespace: 'sessionSources', method, args: {} }, service: 'sessionSourceController', signal,
      peer: { id: brand.brandString<import('@deepseek-ai/dsh-typert-protocol').PeerId>('native-details-browser-owner'),
        ctx, principal: { kind: 'owner' }, interactions: 'answer', signal, dispose: async () => {} },
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    return ctx.extend({ invocation }).sessionSourceController
  }
  // Named JSON arguments model the local Typert hop without sharing a Host service or error instance.
  const parameters = {
    listMachines: [], observeMachines: [], catalog: ['machineKey', 'cursor'], bind: ['ref'], bindDetails: ['ref'],
    historyPage: ['ref', 'epoch', 'request'], historyFollow: ['ref', 'epoch', 'request'], status: ['ref', 'epoch'],
    modelCatalog: ['ref', 'epoch'], modelState: ['ref', 'epoch'], modelSelect: ['ref', 'epoch', 'request'],
    getCreateState: ['ref', 'registrationId'], create: ['ref', 'registrationId', 'requestId'],
    prompt: ['ref', 'epoch', 'request'], cancel: ['ref', 'epoch', 'request'],
  } as const satisfies Readonly<Record<SourceCallMethod | SourceStreamMethod, readonly string[]>>
  const dispatch = (method: SourceCallMethod | SourceStreamMethod, argsJson: string, signal: AbortSignal): unknown => {
    const args: Readonly<Record<string, unknown>> = JSON.parse(argsJson)
    const owner = ownerAt(method, signal)
    const operation: unknown = Reflect.get(owner, method)
    if (typeof operation !== 'function') throw new Error('unknown Source BFF endpoint')
    return Reflect.apply(operation, owner, [...parameters[method].map(name => args[name]), signal])
  }
  const failure = (error: unknown): { readonly code: SourceFailureCode; readonly message: string } => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    return { code: code === 'session-source/action-unsupported' || code === 'session-source/grant-changed' ? code : 'session-source/source-unavailable',
      message: 'Session source is not available' }
  }
  const asyncValues = (value: unknown): value is AsyncIterable<unknown> => typeof value === 'object' && value !== null
    && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === 'function'
  try {
    const listSignal = new AbortController().signal
    const [machine] = await ownerAt('listMachines', listSignal).listMachines(listSignal)
    if (machine === undefined) throw new Error('real Source BFF omitted the authorized Worker')
    expect(machine.supportsNativeDetails).toBe(true)
    const bridge: NativeDetailsBridge = {
      machineJson: JSON.stringify(machine), refJson: JSON.stringify(reference), baselineJson: JSON.stringify(metrics.projections), cut: detailed.cursor,
      async call(method, argsJson, signal) {
        try { return JSON.stringify({ ok: true, value: await dispatch(method, argsJson, signal) }) }
        catch (error) { return JSON.stringify({ ok: false, error: failure(error) }) }
      },
      async * stream(method, argsJson, signal) {
        try {
          const values = dispatch(method, argsJson, signal)
          if (!asyncValues(values)) throw new Error('Source BFF returned a non-stream result')
          for await (const value of values) yield JSON.stringify({ ok: true, value })
        } catch (error) { yield JSON.stringify({ ok: false, error: failure(error) }) }
      },
      async revoke() {
        const peer = workerRuntime.peers.get(machineKey)
        if (peer === undefined) throw new Error('Worker pairing vanished before issuer withdrawal')
        await peer.journal.installGrant(null)
        // The actual authenticated hello publishes the new authority and wakes the real Provider follow.
        await controllerRuntime.call(machineKey, 'hello', {}, new AbortController().signal)
      },
    }
    const { proveClientSession } = await import('./fixtures/native-details/client-proof.mjs')
    const observed = await proveClientSession(bridge)
    expect(observed.legacyFormat).toBe('legacy')
    expect(observed.projectedCut).toBe(detailed.cursor)
    expect(JSON.parse(observed.projectedValuesJson)).toEqual(metrics.projections.values)
    expect(JSON.parse(observed.sourceRefBeforeJson)).toEqual(reference)
    expect(observed.sourceRefAfterRevokeJson).toBe(observed.sourceRefBeforeJson)
    expect(observed.sourceRefAfterDisposeJson).toBe(observed.sourceRefBeforeJson)
    expect(observed.clearedProjectionKeys).toEqual(['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown'])
    expect(created).toBe(0)
    expect(streams).toBe(0)
    expect(ctx.agents.get(cold)).toBeUndefined()
  } finally { unregisterProvider() }
  for (const carrier of [...carriers].reverse()) await carrier.close()
  carriers.length = 0

  vi.useFakeTimers()
  const reading = backend.modelCatalog(new AbortController().signal)
  await vi.advanceTimersByTimeAsync(READ_BUDGET)
  const catalog = await reading
  expect(catalog.default).toEqual({ provider: 'worker-good', model: 'good-model', reasoningEffort: 'high' })
  expect(catalog.groups).toEqual([{ id: 'worker-good', name: 'Worker Good', models: [{ id: 'good-model', name: 'Good model',
    description: 'Full native metadata', badge: { text: 'Fixture', tone: 'info' }, reasoning: {
      efforts: [{ id: 'low', name: 'Low', description: 'Lower reasoning budget' }, { id: 'high', name: 'High', description: 'Higher reasoning budget' }], defaultEffort: 'high',
    } }] }])
  expect(catalog.routableProviders).toEqual(['worker-good'])
  expect(catalog.failures).toEqual([{ id: 'worker-hung', name: 'Worker Hung', message: 'Provider model catalogue read timed out.' }])
  expect(JSON.stringify(catalog)).not.toContain(lateSecret)
  expect(vi.getTimerCount()).toBe(0)
  vi.useRealTimers()
  expect(slowCalls).toBe(1)
  expect(created).toBe(0)
  expect(streams).toBe(0)
  expect(ctx.agents.get(cold)).toBeUndefined()
  expect(ctx.sessions.get(cold)).toBeUndefined()
  expect(ctx.sandboxPolicy.defaultMode).toBe('read-only')

  holdGoodMetadata = true
  const closing = await createNativeAdapter({ ctx, settings: { projects: {} }, native, modelCatalogProviderTimeoutMs: DISPOSAL_BUDGET })
  backends.push(closing)
  const pending = closing.modelCatalog(new AbortController().signal)
  const direct = controller.sourceModelCatalog({ providerTimeoutMs: DISPOSAL_BUDGET }, new AbortController().signal)
  const pendingRejected = expect(pending).rejects.toMatchObject({ code: 'source-unavailable' })
  const directRejected = expect(direct).rejects.toMatchObject({ code: 'source-unavailable' })
  const providerSignal = await metadataStarted.promise
  expect(providerSignal?.aborted).toBe(false)
  // Policy change and concurrent reads must retain the first uncancellable native list quarantine.
  expect(slowCalls).toBe(1)
  const listeners = registryListeners(ctx)
  await entry.fiber.dispose()
  await Promise.all([pendingRejected, directRejected])
  expect(providerSignal?.aborted).toBe(true)
  expect(ctx.get('sessionController')).toBeUndefined()
  expect(registryListeners(ctx)).toEqual(listeners.map(count => count - 1))
  expect(closing.mutationReadiness).toBeUndefined()
  await expect(closing.modelCatalog(new AbortController().signal)).rejects.toMatchObject({ code: 'action-unsupported' })
  await expect(controller.sourceModelCatalog({ providerTimeoutMs: DISPOSAL_BUDGET })).rejects.toMatchObject({ code: 'source-unavailable' })

  // Late provider errors are consumed after timeout/teardown and cannot replace the published static failure.
  slowListing.reject(new Error(lateSecret))
  heldMetadata.resolve(resolved('worker-good', 'good-model'))
  expect(JSON.stringify(catalog)).not.toContain(lateSecret)
  const stored = await ctx.sessionPersistence.open(cold, 'read')
  try { expect((await stored.read()).events).toEqual(events) } finally { await stored.close() }
  expect(created).toBe(0)
  expect(streams).toBe(0)
  expect(ctx.agents.get(cold)).toBeUndefined()
})
