/** Actual frozen Worker Loader → native AgentLoop → HTTP/JWE Runtime → Source BFF → separate Client Session/Chat proof. */
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionRequestId, SourceHistoryFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-api-session-source-controller'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createNativeAdapter, type NativeAdapter } from '../../lib/federation/native-adapter.mjs'
import { projectNativeMetrics } from '../../lib/federation/metrics.mjs'
import { createRelay } from '../../relay/server.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'
import type { NativeLiveBridge, NativeLiveClientProofResult, SourceCallMethod, SourceFailureCode, SourceStreamMethod } from './fixtures/native-live/bridge-types.d.mts'

const WORKER = '@dsh-remote/worker-session-controller', BFF = '@deepseek-ai/dsh-api-session-source-controller', PREFIX = 'dsh-native-live-composition-'
const workerPackage = new URL('../../plugin-native/worker-stage3-0.1.4/packages/worker-session-controller/', import.meta.url)
const sourceRequire = createRequire(new URL('../../../dsh-remote-core/packages/api/session-controller/package.json', import.meta.url))
interface Manifest { readonly name: string; readonly version: string; readonly dependencies?: Record<string, string>; readonly peerDependencies?: Record<string, string> }
interface WorkerOwner {
  readonly SessionController: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  readonly default: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  ownsSourceMutationHelpers(value: unknown): boolean
  ownsSourceCatalogHelper(value: unknown): boolean
  ownsSourceFollowHelper(value: unknown): boolean
}
const compositionPackages = [
  ['@deepseek-ai/cordis-plugin-loader', 'vendor/loader'], ['@deepseek-ai/cordis-plugin-include', 'vendor/include'],
  ['@deepseek-ai/dsh-agent-loop-testkit', 'packages/test-support/agent-loop-testkit'], ['@deepseek-ai/dsh-fs-local', 'packages/fs/fs-local'],
  ['@deepseek-ai/dsh-session-persistence-jsonl', 'packages/session/session-persistence-jsonl'], ['@deepseek-ai/dsh-storage', 'packages/storage/storage'],
  ['@deepseek-ai/dsh-storage-json', 'packages/storage/storage-json'], ['@deepseek-ai/dsh-storage-domain', 'packages/storage/storage-domain'],
  ['@deepseek-ai/dsh-workspace', 'packages/workspace/workspace'], ['@deepseek-ai/dsh-credentials-local', 'packages/credentials/credentials-local'],
  ['@deepseek-ai/dsh-client-connection', 'packages/client/connection'], ['@deepseek-ai/dsh-client-file-upload', 'packages/client/file-upload'],
  ['@deepseek-ai/dsh-attachment-local', 'packages/attachment/attachment-local'], ['@deepseek-ai/dsh-agent-default-model', 'packages/core/agent-default-model'],
  ['@deepseek-ai/dsh-commands', 'packages/interaction/commands'], ['@deepseek-ai/dsh-typert-registry', 'packages/typert/registry'],
  ['@deepseek-ai/dsh-api-remote-access', 'packages/api/remote-access'], ['@deepseek-ai/dsh-api-gateway', 'packages/api/gateway'],
  [BFF, 'packages/api/session-source-controller'], ['@deepseek-ai/dsh-session-query-sqlite', 'packages/session-query/session-query-sqlite'],
  ['@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'], ['@deepseek-ai/dsh-session-stats', 'packages/session/session-stats'],
  ['@deepseek-ai/dsh-token-meter', 'packages/llm/token-meter'], ['@deepseek-ai/dsh-session-title', 'packages/session/session-title'],
] as const
async function manifestAt(filename: URL | string): Promise<Manifest> { return JSON.parse(await readFile(filename, 'utf8')) }
async function packageRoot(name: string): Promise<string> {
  let directory = path.dirname(sourceRequire.resolve(name))
  for (;;) {
    try { if ((await manifestAt(path.join(directory, 'package.json'))).name === name) return realpath(directory) }
    catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`canonical SDK package not found: ${name}`)
    directory = parent
  }
}
function ownedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
async function unlinkFixtureLinks(directory: string, root: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.resolve(directory, entry.name)
    if (!ownedPath(root, target)) throw new Error('native live fixture cleanup escaped its root')
    const info = await lstat(target)
    if (info.isSymbolicLink()) await unlink(target)
    else if (info.isDirectory()) await unlinkFixtureLinks(target, root)
  }
}
async function nativeGraph(root: string) {
  const manifest = await manifestAt(new URL('package.json', workerPackage))
  expect(manifest.name).toBe(WORKER); expect(manifest.version).toBe('0.1.4')
  const packages = new Map<string, string>()
  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) packages.set(name, await packageRoot(name))
  for (const [name, folder] of compositionPackages) {
    const directory = await realpath(fileURLToPath(new URL(`../../../dsh-remote-core/${folder}/`, import.meta.url)))
    expect((await manifestAt(path.join(directory, 'package.json'))).name).toBe(name)
    if (packages.has(name)) expect(packages.get(name)).toBe(directory)
    packages.set(name, directory)
  }
  for (const packageName of [BFF, '@deepseek-ai/dsh-session-title']) {
    const directory = packages.get(packageName)
    if (directory === undefined) throw new Error(`canonical composition package is absent: ${packageName}`)
    const declared = await manifestAt(path.join(directory, 'package.json'))
    for (const name of Object.keys({ ...declared.dependencies, ...declared.peerDependencies })) if (!packages.has(name)) packages.set(name, await packageRoot(name))
  }
  const source = packages.get(BFF)
  if (source === undefined) throw new Error('canonical Source BFF package is absent')
  const bff = path.join(root, 'payloads', 'source-bff')
  await mkdir(bff, { recursive: true }); await copyFile(path.join(source, 'package.json'), path.join(bff, 'package.json'))
  await cp(path.join(source, 'lib'), path.join(bff, 'lib'), { recursive: true }); packages.set(BFF, bff)
  const canonical = path.join(root, 'payloads', 'canonical-worker-api')
  await mkdir(path.join(canonical, 'lib'), { recursive: true })
  for (const relative of ['package.json', 'lib/index.js', 'lib/controller-impl.js']) await copyFile(new URL(relative, workerPackage), path.join(canonical, relative))
  packages.set(WORKER, canonical)
  for (const [name, directory] of packages) {
    const target = path.join(root, 'node_modules', ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true }); await symlink(directory, target, 'junction')
  }
  await writeFile(path.join(root, 'package.json'), '{"name":"native-live-composition-fixture","private":true,"type":"module"}\n')
  // Node require(ESM) keeps the artifact owners on one graph; Client imports remain exclusively in their .mjs realm.
  const require = createRequire(path.join(root, 'package.json'))
  const cordis: typeof import('@deepseek-ai/cordis') = require('@deepseek-ai/cordis')
  const protocol: typeof import('@deepseek-ai/dsh-typert-protocol') = require('@deepseek-ai/dsh-typert-protocol')
  expect(Object.getPrototypeOf(protocol.TypertRemoteService.prototype)).toBe(cordis.Service.prototype)
  const owner: WorkerOwner = require(WORKER)
  expect(owner.default).toBe(owner.SessionController)
  return { require, cordis, protocol, owner }
}
function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  const unexpected = (): never => { throw new Error('native live composition does not perform Node HMR') }
  return { version: 'v2', loadCache: new Map(), register: unexpected, getOrCreateModuleJob: unexpected, resolveSync: unexpected, load: unexpected,
    async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected Loader import ${specifier}`); return modules.get(specifier) } }
}
async function abortable(wait: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  signal?.throwIfAborted()
  if (signal === undefined) return wait
  await new Promise<void>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(new Error('native live fixture operation aborted')) }
    signal.addEventListener('abort', aborted, { once: true })
    void wait.then(() => { signal.removeEventListener('abort', aborted); resolve() }, error => { signal.removeEventListener('abort', aborted); reject(error) })
    if (signal.aborted) aborted()
  })
}

it('shows actual native transient Chat text then commits metrics and retires a held carrier after issuer withdrawal', async () => {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent, PREFIX)))
  const parts = ['Native ', 'live ', 'Client ', 'answer'], gates = parts.map(() => Promise.withResolvers<void>())
  const terminalGate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), heldEntered = Promise.withResolvers<void>(), heldRelease = Promise.withResolvers<void>()
  const nativeEnd = Promise.withResolvers<void>(), carriers: Array<{ close(): void | Promise<unknown> }> = []
  const pressureLifetime = new AbortController(), pressureReaders: AsyncIterator<SourceHistoryFrame>[] = [], burstProduced = Promise.withResolvers<void>()
  let modelPhase: 'paced' | 'burst' = 'paced', emittedBurstChunks = 0, stopBurst = () => {}
  let context: Context | undefined, backend: NativeAdapter | undefined, unregister = () => {}, stopTrace = () => {}, held = false
  onTestFinished(async () => {
    for (const gate of gates) gate.resolve()
    terminalGate.resolve(); heldRelease.resolve(); pressureLifetime.abort(); burstProduced.resolve()
    const failures: unknown[] = []
    const stops = [() => stopBurst(), ...[...pressureReaders].reverse().map(reader => async () => { await reader.return?.() }),
      () => stopTrace(), () => unregister(), ...[...carriers].reverse().map(carrier => () => carrier.close()), () => backend?.close(), () => context?.fiber.dispose()]
    for (const stop of stops) { try { await stop() } catch (error: unknown) { failures.push(error) } }
    vi.restoreAllMocks()
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent); expect(path.basename(root).startsWith(PREFIX)).toBe(true)
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    await unlinkFixtureLinks(root, root); await rm(root, { recursive: true, force: true })
    if (failures.length > 0) throw failures[0]
  })
  const graph = await nativeGraph(root)
  const llm: typeof import('@deepseek-ai/dsh-llm') = graph.require('@deepseek-ai/dsh-llm')
  const session: typeof import('@deepseek-ai/dsh-session') = graph.require('@deepseek-ai/dsh-session')
  const sandbox: typeof import('@deepseek-ai/dsh-sandbox-policy') = graph.require('@deepseek-ai/dsh-sandbox-policy')
  const testkit: typeof import('@deepseek-ai/dsh-agent-loop-testkit') = graph.require('@deepseek-ai/dsh-agent-loop-testkit')
  const loader: typeof import('@deepseek-ai/cordis-plugin-loader') = graph.require('@deepseek-ai/cordis-plugin-loader')
  const include: typeof import('@deepseek-ai/cordis-plugin-include') = graph.require('@deepseek-ai/cordis-plugin-include')
  const fsLocal: typeof import('@deepseek-ai/dsh-fs-local') = graph.require('@deepseek-ai/dsh-fs-local')
  const brand: typeof import('@deepseek-ai/dsh-brand') = graph.require('@deepseek-ai/dsh-brand')
  const requests: GenerateOptions[] = []
  class ExternalAdapter extends llm.LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: provider } }
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return Promise.resolve([{ provider, id: 'native-model', name: 'Native model' }]) }
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options); entered.resolve()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      if (modelPhase === 'burst') {
        // Native AgentLoop pulls all model chunks independently of the paused Source consumer.
        for (let index = 0; index < 640; index++) {
          options.signal?.throwIfAborted(); emittedBurstChunks++
          yield { type: 'text-delta', index: 0, text: 'x' }
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'x'.repeat(640) } }
        yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 640, cacheReadTokens: 0, cacheWriteTokens: 0 } }
        burstProduced.resolve()
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      for (let index = 0; index < gates.length; index++) {
        const gate = gates[index], part = parts[index]
        if (gate === undefined || part === undefined) throw new Error('external model fixture lost its input gate')
        await abortable(gate.promise, options.signal)
        yield { type: 'text-delta', index: 0, text: part }
      }
      await abortable(terminalGate.promise, options.signal)
      yield { type: 'block-end', index: 0, block: { type: 'text', text: parts.join('') } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const external = new ExternalAdapter(), ctx = new graph.cordis.Context()
  context = ctx; ctx.baseUrl = `${pathToFileURL(root).href}/`
  const bootstrap = { name: 'native-live-composition-bootstrap', async apply(owner: Context) {
    await owner.plugin(fsLocal.default, { cwd: root })
    await testkit.mountAgentLoopTestDependencies(owner, { workingDirectory: true }); await testkit.mountAgentLoopTestHarness(owner)
  } }
  const providers = { name: 'native-live-composition-provider', inject: ['llm'], apply(owner: Context) { owner.llm.registerAdapter(['native-provider'], external) } }
  const modules = new Map<string, unknown>(compositionPackages.map(([name]) => [name, graph.require(name)]))
  modules.set('@fixture/native-live-core', bootstrap); modules.set('@fixture/native-live-provider', providers); modules.set(WORKER, graph.owner)
  const rows = [
    { name: '@fixture/native-live-core' }, { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'native-provider', model: 'native-model' } },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(root, 'sessions') } },
    { name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(root, 'domain') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-workspace' },
    { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: root } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: path.join(root, 'fixture-credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-client-connection' }, { name: '@deepseek-ai/dsh-commands' }, { name: '@deepseek-ai/dsh-client-file-upload' },
    { name: '@deepseek-ai/dsh-typert-registry' }, { name: '@deepseek-ai/dsh-api-remote-access' }, { name: '@deepseek-ai/dsh-api-gateway' },
    { name: BFF }, { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: path.join(root, 'query.sqlite'), openAt: 'never' } },
    { name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only' } }, { name: '@deepseek-ai/dsh-session-stats' }, { name: '@deepseek-ai/dsh-token-meter' },
    { name: '@deepseek-ai/dsh-session-title', config: { fallbackMaxWords: 8, fallbackMaxBytes: 96, maxTitleBytes: 120 } },
    { name: '@fixture/native-live-provider' }, { name: WORKER, config: { nativeOpen: false } },
  ]
  const configPath = path.join(root, 'cordis.yml')
  await writeFile(configPath, `${JSON.stringify(rows, null, 2)}\n`)
  await ctx.plugin(loader.default); ctx.loader.builtins.include = include.default; ctx.loader.internal = moduleLoader(modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.get('webServer')).toBeUndefined(); expect(ctx.get('sessionTitle')).toBeDefined()
  const controller = ctx.get('sessionController'), sourceBff = ctx.get('sessionSourceController')
  if (controller === undefined || sourceBff === undefined) throw new Error('native Loader omitted a real Controller or Source BFF')
  const original: object = Reflect.get(controller, graph.cordis.symbols.original)
  expect(Object.getPrototypeOf(original)).toBe(graph.owner.SessionController.prototype)
  expect(graph.owner.ownsSourceFollowHelper(original)).toBe(true)
  expect(graph.owner.ownsSourceMutationHelpers(original)).toBe(true); expect(graph.owner.ownsSourceCatalogHelper(original)).toBe(true)
  const projectRoot = path.join(root, 'project'); await mkdir(projectRoot)
  const workspace = await ctx.workspaceRegistry.create(projectRoot)
  const created = await controller.create({ sessionId: session.SessionId('actual-native-live-client'), cwd: projectRoot })
  const agent = ctx.agents.get(created.sessionId)
  if (agent === undefined) throw new Error('real Controller.create omitted its registered Agent')
  expect(requests).toEqual([])
  const machineKey = 'native-live-loader-worker', projectId = 'native-project', reference = { machineKey, projectId, sessionId: agent.session.id }
  const exportClasses = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'tool.call', 'tool.result', 'statistics', 'usage', 'context.metrics']
  const native = { cordis: graph.cordis, llm, session, sandbox, controllerOwner: graph.owner }
  const nativeBackend = await createNativeAdapter({ ctx, settings: { projects: { [projectId]: { workspaceId: workspace.id } } }, native })
  backend = nativeBackend
  expect(typeof nativeBackend.followNative).toBe('function'); expect(typeof nativeBackend.nativeLiveAssistantBlocks).toBe('function')
  const initial = await nativeBackend.readDetails(reference, new AbortController().signal)
  const baseline = projectNativeMetrics({ baseline: initial.projections, throughSeq: initial.cursor, exportClasses })
  expect(baseline.availability).toEqual({ sessionStats: 'available', tokenUsage: 'available', contextPressure: 'available', contextBreakdown: 'available' })
  const devices = ['native-live-controller', 'native-live-worker'].map(id => ({ id,
    peerId: id === 'native-live-controller' ? 'native-live-worker' : 'native-live-controller', token: randomBytes(32).toString('base64url') }))
  const relay = createRelay({ directory: path.join(root, 'relay'), devices: devices.map(({ token, ...device }) => ({ ...device, tokenHash: createHash('sha256').update(token).digest('hex') })), pollMs: 20 })
  carriers.push(relay)
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (address === null || typeof address === 'string') throw new Error('native live relay did not bind a loopback TCP port')
  const a = devices[0], b = devices[1]
  if (a === undefined || b === undefined) throw new Error('native live paired devices are absent')
  const grant = { version: 1, grantId: 'native_live_loader_grant', principal: { kind: 'controller', id: a.id }, machineKey, revision: 1, issuedAt: 0,
    projects: [{ projectId, actions: ['project.list', 'session.list', 'model.list'], exportClasses,
      sessions: [{ sessionId: agent.session.id, imported: true, actions: ['session.status', 'session.read', 'session.follow'], exportClasses }] }] }
  const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl: `http://127.0.0.1:${address.port}`, sharedKey: randomBytes(32).toString('base64url'), allowLoopback: true, requestTimeoutMs: 5_000 }
  const workerSettings = await parseSettingsV2({ version: 2, role: 'worker', id: 'native-live-worker', machineKey,
    projects: { [projectId]: { workspaceId: workspace.id } }, pairs: [{ ...common, id: b.id, peerId: b.peerId, relayToken: b.token, stateDir: './worker-state', grant }] },
  path.join(root, 'settings.json'), { resolveWorkspace: id => id === workspace.id ? workspace : undefined })
  const workerRuntime = await openFederationRuntime(workerSettings, { backend: nativeBackend }); carriers.push(workerRuntime); workerRuntime.start()
  const controllerSettings = await parseSettingsV2({ version: 2, role: 'controller', id: 'native-live-controller', pairs: [{ ...common,
    id: a.id, peerId: a.peerId, relayToken: a.token, stateDir: './controller-state' }] }, path.join(root, 'settings.json'))
  const controllerRuntime = await openFederationRuntime(controllerSettings); carriers.push(controllerRuntime); controllerRuntime.start()
  const pair = controllerSettings.pairs[0]
  if (pair === undefined) throw new Error('real Controller pairing is absent')
  const provider = await createHostProvider({ runtime: controllerRuntime, pair, RemoteError: graph.protocol.RemoteError })
  unregister = sourceBff.registerSource(provider)
  const ownerAt = (method: SourceCallMethod | SourceStreamMethod, signal: AbortSignal) => {
    const invocation: import('@deepseek-ai/dsh-typert-protocol').RemoteInvocation = {
      request: { namespace: 'sessionSources', method, args: {} }, service: 'sessionSourceController', signal,
      peer: { id: brand.brandString<import('@deepseek-ai/dsh-typert-protocol').PeerId>('native-live-browser-owner'), ctx,
        principal: { kind: 'owner' }, interactions: 'answer', signal, dispose: async () => {} },
      uplink: <In>(): AsyncIterable<In> => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
    }
    return ctx.extend({ invocation }).sessionSourceController
  }
  const parameters = {
    listMachines: [], observeMachines: [], catalog: ['machineKey', 'cursor'], bind: ['ref'], bindDetails: ['ref'], bindLive: ['ref'],
    historyPage: ['ref', 'epoch', 'request'], historyFollow: ['ref', 'epoch', 'request'], status: ['ref', 'epoch'],
    modelCatalog: ['ref', 'epoch'], modelState: ['ref', 'epoch'], modelSelect: ['ref', 'epoch', 'request'],
    getCreateState: ['ref', 'registrationId'], create: ['ref', 'registrationId', 'requestId'], prompt: ['ref', 'epoch', 'request'], cancel: ['ref', 'epoch', 'request'],
  } as const satisfies Readonly<Record<SourceCallMethod | SourceStreamMethod, readonly string[]>>
  const dispatch = (method: SourceCallMethod | SourceStreamMethod, argsJson: string, signal: AbortSignal): unknown => {
    const args: Readonly<Record<string, unknown>> = JSON.parse(argsJson), owner = ownerAt(method, signal), operation: unknown = Reflect.get(owner, method)
    if (typeof operation !== 'function') throw new Error('unknown native Source BFF endpoint')
    return Reflect.apply(operation, owner, [...parameters[method].map(name => args[name]), signal])
  }
  const failure = (error: unknown): { readonly code: SourceFailureCode; readonly message: string } => {
    const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    return { code: code === 'session-source/action-unsupported' || code === 'session-source/grant-changed' ? code : 'session-source/source-unavailable', message: 'Session source is not available' }
  }
  const asyncValues = (value: unknown): value is AsyncIterable<unknown> => typeof value === 'object' && value !== null && Symbol.asyncIterator in value && typeof value[Symbol.asyncIterator] === 'function'
  const listSignal = new AbortController().signal, [machine] = await ownerAt('listMachines', listSignal).listMachines(listSignal)
  if (machine === undefined) throw new Error('actual Source BFF omitted the granted native machine')
  expect(machine.supportsNativeDetails).toBe(true); expect(machine.supportsNativeLive).toBe(true)
  const durableOutboxes = () => [controllerRuntime, workerRuntime].map(runtime => {
    const peer = runtime.peers.get(machineKey)
    if (peer === undefined) throw new Error('native live pairing disappeared before outbox observation')
    return peer.endpoint.status().outbox
  })
  const diagnostics: Array<Readonly<Record<string, unknown>>> = []
  const trace = (phase: string, observationJson: string): void => {
    const peer = controllerRuntime.peers.get(machineKey)
    diagnostics.push({ phase, observation: JSON.parse(observationJson), root: { revision: controllerRuntime.revision(machineKey),
      authority: controllerRuntime.authority(machineKey), liveReady: controllerRuntime.liveReady(machineKey), mutationsVerified: peer?.mutationsVerified,
      controllerLive: peer?.liveStreams?.status(), workerLive: workerRuntime.peers.get(machineKey)?.liveStreams?.status() } })
  }
  stopTrace = controllerRuntime.subscribe(machineKey, reason => { trace(`runtime-${reason}`, '{}') })
  trace('host-initial-machine', JSON.stringify({ registrationId: machine.registrationId, authorityRevision: machine.authorityRevision, catalogRevision: machine.catalogRevision }))
  let beforeChunks = durableOutboxes(), durableDelivered = false, committedEnds = 0, historyReaders = 0
  const bridge: NativeLiveBridge = {
    trace,
    machineJson: JSON.stringify(machine), refJson: JSON.stringify(reference), baselineJson: JSON.stringify(baseline.projections), cut: initial.cursor, parts,
    async call(method, argsJson, signal) {
      if (method === 'bindLive') trace('host-before-bindLive', '{}')
      try {
        const value = await dispatch(method, argsJson, signal)
        if (method === 'bindLive') trace('host-after-bindLive', '{"ok":true}')
        return JSON.stringify({ ok: true, value })
      } catch (error) {
        const normalized = failure(error)
        if (method === 'bindLive') trace('host-after-bindLive', JSON.stringify({ ok: false, code: normalized.code }))
        return JSON.stringify({ ok: false, error: normalized })
      }
    },
    async *stream(method, argsJson, signal) {
      if (method === 'historyFollow') historyReaders++
      try {
        const values = dispatch(method, argsJson, signal)
        if (!asyncValues(values)) throw new Error('actual Source BFF returned a non-stream result')
        for await (const value of values) {
          const encoded = JSON.stringify(value)
          if (method === 'historyFollow') {
            const frame: SourceHistoryFrame = JSON.parse(encoded)
            trace('host-history-frame', JSON.stringify(frame.type === 'snapshot' ? { type: frame.type, cut: frame.page.throughSeq, projectionsAsOf: frame.projections.asOfSeq }
              : frame.type === 'records' ? { type: frame.type, projectionsAsOf: frame.projections?.asOfSeq, records: frame.records.map(row => row.type === 'event' ? { type: row.event.type, seq: row.event.seq } : { type: row.type, firstSeq: row.firstSeq, lastSeq: row.lastSeq }) }
                : { type: frame.type, nativeType: frame.frame.type, revision: frame.frame.revision, ...(frame.frame.type === 'end' ? { outcome: frame.frame.outcome } : {}) }))
            if (frame.type === 'records') durableDelivered ||= frame.records.some(row => row.type === 'event' && row.event.type === 'assistant/message')
            if (frame.type === 'assistant-stream' && frame.frame.type === 'end') {
              expect(durableDelivered).toBe(true); expect(frame.frame.outcome.kind).toBe('committed'); committedEnds++; nativeEnd.resolve()
            }
            if (held) { held = false; heldEntered.resolve(); await abortable(heldRelease.promise, signal) }
          }
          signal.throwIfAborted()
          yield JSON.stringify({ ok: true, value: JSON.parse(encoded) })
        }
      } catch (error) { if (!signal.aborted) yield JSON.stringify({ ok: false, error: failure(error) }) }
    },
    async startPrompt() {
      expect(requests).toEqual([]); beforeChunks = durableOutboxes()
      const peer = workerRuntime.peers.get(machineKey)
      expect(peer?.liveStreams?.status().active).toBe(1)
      await controller.prompt({ requestId: brand.brandString<SessionRequestId>('native-live-composition-prompt'), sessionId: agent.session.id,
        mode: 'queue', content: [{ type: 'text', text: 'Explicitly produce one native live answer' }] }, new AbortController().signal)
      await entered.promise
    },
    async releasePart(index) { const gate = gates[index]; if (gate === undefined) throw new Error('unknown native provider part'); gate.resolve() },
    async finish() {
      terminalGate.resolve(); await nativeEnd.promise
      await vi.waitFor(() => { expect(agent.session.snapshotEvents().some(event => event.type === 'turn/end')).toBe(true) })
      const detailed = await nativeBackend.readDetails(reference, new AbortController().signal)
      const metrics = projectNativeMetrics({ baseline: detailed.projections, throughSeq: detailed.cursor, exportClasses })
      const settled = detailed.events.findLast(event => event.type === 'assistant/message')
      if (settled === undefined) throw new Error('native AgentLoop did not commit an Assistant message')
      trace('host-final-native', JSON.stringify({ cut: detailed.cursor, settlementSeq: settled.seq, projections: metrics.projections }))
      return JSON.stringify({ cut: detailed.cursor, projections: metrics.projections, settlementSeq: settled.seq })
    },
    async holdForWithdrawal() {
      expect(durableOutboxes()).toEqual(beforeChunks)
      held = true
      await controller.rename({ sessionId: agent.session.id, title: 'PRIVATE_LATE_NATIVE_TITLE' })
      await heldEntered.promise
    },
    async revoke() {
      const peer = workerRuntime.peers.get(machineKey)
      if (peer === undefined) throw new Error('real Worker pairing vanished before withdrawal')
      await peer.journal.installGrant(null)
      await controllerRuntime.call(machineKey, 'hello', {}, new AbortController().signal)
      // The real Client apply observes machines independently and aborts the held stream before it can publish.
    },
  }
  const { proveClientSession } = await import('./fixtures/native-live/client-proof.mjs')
  let observed: NativeLiveClientProofResult
  try { observed = await proveClientSession(bridge) }
  catch (error) {
    const final = diagnostics.filter(row => row.phase === 'host-final-native' || row.phase === 'client-final-timeout')
      .map(({ phase, observation }) => ({ phase, observation }))
    const tail = diagnostics.slice(-8).map(({ phase, observation }) => ({ phase, observation }))
    throw new Error(`native live final state: ${JSON.stringify(final)}; recent frames: ${JSON.stringify(tail)}`, { cause: error })
  }
  expect(observed.bindingLive).toBe(true); expect(observed.transientTexts).toEqual(parts.map((_part, index) => parts.slice(0, index + 1).join('')))
  expect(observed.settledText).toBe(parts.join('')); expect(observed.openingCut).toBe(initial.cursor)
  expect(observed.finalCut).toBeGreaterThan(observed.settlementSeq)
  expect(observed.sourceRefAfterRevokeJson).toBe(observed.sourceRefBeforeJson); expect(observed.sourceRefAfterDisposeJson).toBe(observed.sourceRefBeforeJson)
  expect(JSON.parse(observed.sourceRefBeforeJson)).toEqual(reference)
  expect(observed.clearedProjectionKeys).toEqual(['sessionStats', 'tokenUsage', 'contextPressure', 'contextBreakdown'])
  expect(requests).toHaveLength(1); expect(historyReaders).toBe(1); expect(committedEnds).toBe(1)
  expect(JSON.stringify(observed)).not.toContain('PRIVATE_')
  await vi.waitFor(() => { expect(workerRuntime.peers.get(machineKey)?.liveStreams?.status().active).toBe(0) })
  expect(graph.owner.ownsSourceFollowHelper(original)).toBe(true)

  // Separate pressure phase: Native generation is independent, while one actual Source consumer grants no further credit.
  const workerPeer = workerRuntime.peers.get(machineKey)
  if (workerPeer === undefined) throw new Error('native Worker pairing disappeared before pressure regrant')
  await workerPeer.journal.installGrant({ ...grant, revision: 2 })
  await controllerRuntime.call(machineKey, 'hello', {}, pressureLifetime.signal)
  const authorized = await provider.catalog(undefined, pressureLifetime.signal)
  const authorizedSession = authorized.sessions.find(row => row.ref.sessionId === reference.sessionId)
  if (authorizedSession === undefined) throw new Error('revision2 catalog omitted the real native Session')
  const pressureRef = Object.freeze({ ...authorizedSession.ref }), pressureRefJson = JSON.stringify(pressureRef)
  expect(pressureRef).toEqual(reference)
  const rebound = await provider.live.bind(pressureRef, pressureLifetime.signal)
  expect(rebound.nativeLive).toBe(true); expect(rebound.includeAssistantStream).toBe(true)
  const paused = provider.live.historyFollow(pressureRef, { includeAssistantStream: true }, pressureLifetime.signal)[Symbol.asyncIterator]()
  pressureReaders.push(paused)
  const opening = await paused.next()
  if (opening.done || opening.value.type !== 'snapshot') throw new Error('actual pressure follow omitted its native snapshot')
  expect(opening.value.header.id).toBe(pressureRef.sessionId)
  expect(opening.value.page.grantRevision).toBe(rebound.grantRevision)
  expect(opening.value.page.generation).toBe(rebound.generation)
  await vi.waitFor(() => { expect(durableOutboxes().map(outbox => outbox?.pending)).toEqual([0, 0]) }, { timeout: 5_000 })
  const beforeBurstOutboxes = durableOutboxes(), pressureCut = opening.value.page.throughSeq
  const turnCommitted = Promise.withResolvers<void>()
  let burstSettlementSeq: number | undefined
  stopBurst = ctx.on('session/event', (subject, event) => {
    if (subject !== agent.session || event.seq <= pressureCut) return
    if (event.type === 'assistant/message') burstSettlementSeq = event.seq
    if (event.type === 'turn/end' && burstSettlementSeq !== undefined) turnCommitted.resolve()
  })
  modelPhase = 'burst'
  // No next() occurs between this explicit native prompt and the full native commit.
  await controller.prompt({ requestId: brand.brandString<SessionRequestId>('native-independent-burst-prompt'), sessionId: agent.session.id,
    mode: 'queue', content: [{ type: 'text', text: 'Explicitly produce the independent native burst' }] }, pressureLifetime.signal)
  const deadline = new AbortController(), deadlineTimer = setTimeout(() => { deadline.abort() }, 15_000)
  try { await abortable(Promise.all([burstProduced.promise, turnCommitted.promise]).then(() => {}), AbortSignal.any([pressureLifetime.signal, deadline.signal])) }
  finally { clearTimeout(deadlineTimer); await stopBurst(); stopBurst = () => {} }
  expect(emittedBurstChunks).toBe(640); expect(requests).toHaveLength(2)
  const burstDetails = await nativeBackend.readDetails(reference, pressureLifetime.signal)
  const burstMessage = burstDetails.events.findLast(event => event.type === 'assistant/message')
  if (burstMessage === undefined || burstMessage.type !== 'assistant/message') throw new Error('independent native burst did not commit its real Assistant message')
  expect(burstMessage.seq).toBe(burstSettlementSeq)
  expect(burstMessage.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')).toBe('x'.repeat(640))
  const burstMetrics = projectNativeMetrics({ baseline: burstDetails.projections, throughSeq: burstDetails.cursor, exportClasses })
  expect(burstMetrics.availability).toEqual({ sessionStats: 'available', tokenUsage: 'available', contextPressure: 'available', contextBreakdown: 'available' })
  expect(burstMetrics.projections.asOfSeq).toBe(burstDetails.cursor)
  const pausedCounts = [controllerRuntime, workerRuntime].map(runtime => runtime.peers.get(machineKey)?.liveStreams?.status())
  for (const counts of pausedCounts) {
    if (counts === undefined) throw new Error('pressure manager disappeared before its bounded-state observation')
    expect(counts.active).toBeLessThanOrEqual(1); expect(counts.pendingReads).toBeLessThanOrEqual(1)
    expect(counts.retainedBytes).toBeLessThanOrEqual(256 * 1024)
  }
  expect(durableOutboxes()).toEqual(beforeBurstOutboxes)
  const refusal: unknown = await paused.next().then(() => { throw new Error('paused native follow silently continued after its independent 640-chunk overflow') }, (error: unknown) => error)
  if (!(refusal instanceof graph.protocol.RemoteError)) throw new Error('paused native follow did not return its maintained static Source error')
  expect(refusal.code).toBe('session-source/source-unavailable')
  expect(refusal.message).not.toContain('PRIVATE_')
  await paused.return?.()
  await vi.waitFor(() => {
    for (const runtime of [controllerRuntime, workerRuntime]) {
      const counts = runtime.peers.get(machineKey)?.liveStreams?.status()
      expect(counts?.active).toBe(0); expect(counts?.pendingReads).toBe(0); expect(counts?.pendingSends).toBe(0)
    }
  }, { timeout: 5_000 })
  expect(durableOutboxes()).toEqual(beforeBurstOutboxes)
  // A failed follow retires its metadata receipt. Rebind explicitly before a new physical native rebaseline.
  const freshBinding = await provider.live.bind(pressureRef, pressureLifetime.signal)
  expect(freshBinding.generation).toBe(rebound.generation); expect(freshBinding.grantRevision).toBe(rebound.grantRevision)
  expect(freshBinding.capabilities).toEqual(rebound.capabilities)
  expect(freshBinding.nativeLive).toBe(true); expect(freshBinding.includeAssistantStream).toBe(true)
  expect(pressureRef).toEqual(reference)
  await vi.waitFor(() => { expect(durableOutboxes().map(outbox => outbox?.pending)).toEqual([0, 0]) }, { timeout: 5_000 })
  const beforeFreshOutboxes = durableOutboxes()
  // The fresh follow reads the durable native commit without resuming a model or inventing a replacement message.
  const fresh = provider.live.historyFollow(pressureRef, { includeAssistantStream: true }, pressureLifetime.signal)[Symbol.asyncIterator]()
  pressureReaders.push(fresh)
  try {
    const first = await fresh.next()
    if (first.done || first.value.type !== 'snapshot') throw new Error('fresh native pressure follow did not rebaseline')
    expect(first.value.header.id).toBe(pressureRef.sessionId)
    expect(first.value.page.generation).toBe(freshBinding.generation); expect(first.value.page.grantRevision).toBe(freshBinding.grantRevision)
    expect(first.value.page.throughSeq).toBe(burstDetails.cursor)
    expect(first.value.projections.asOfSeq).toBe(burstDetails.cursor)
    expect(first.value.projections.values).toEqual(burstMetrics.projections.values)
    const restored = first.value.page.records.find(row => row.type === 'event' && row.event.type === 'assistant/message' && row.event.seq === burstSettlementSeq)
    expect(restored).toEqual(expect.objectContaining({ type: 'event', event: expect.objectContaining({ type: 'assistant/message', seq: burstSettlementSeq }) }))
    expect(JSON.stringify(restored)).toContain('x'.repeat(640))
  } finally { await fresh.return?.() }
  expect(JSON.stringify(pressureRef)).toBe(pressureRefJson); expect(requests).toHaveLength(2)
  expect(durableOutboxes()).toEqual(beforeFreshOutboxes)
  await vi.waitFor(() => { expect(workerRuntime.peers.get(machineKey)?.liveStreams?.status().active).toBe(0) })
  expect(graph.owner.ownsSourceFollowHelper(original)).toBe(true)
  console.info('native bounded pressure', JSON.stringify({ generatedChunks: emittedBurstChunks, nativeCommittedChars: 640, nativeCut: burstDetails.cursor,
    refusalCode: refusal.code, refusalMessage: refusal.message, pausedCounts, burstOutboxes: beforeBurstOutboxes, rebaselineOutboxes: beforeFreshOutboxes, freshRebaseline: true }))
}, 90_000)
