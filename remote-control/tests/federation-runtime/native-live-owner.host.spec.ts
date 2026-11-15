/** Real Loader/compiled Worker0.1.4 proof on one canonical Node SDK graph; only the external LLM stream is scripted. */
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionFollowFrame, SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { createNativeAdapter, type NativeAdapter } from '../../lib/federation/native-adapter.mjs'

const WORKER = '@dsh-remote/worker-session-controller', PREFIX = 'dsh-native-live-owner-'
const artifact = new URL('../../plugin-native/worker-stage3-0.1.4/', import.meta.url)
const workerPackage = new URL('packages/worker-session-controller/', artifact)
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
  ['@deepseek-ai/dsh-session-query-sqlite', 'packages/session-query/session-query-sqlite'], ['@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'],
] as const
async function manifestAt(filename: URL | string): Promise<Manifest> { return JSON.parse(await readFile(filename, 'utf8')) as Manifest }
async function packageRoot(name: string): Promise<string> {
  let directory = path.dirname(sourceRequire.resolve(name))
  for (;;) {
    try { if ((await manifestAt(path.join(directory, 'package.json'))).name === name) return realpath(directory) }
    catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`native SDK package not found: ${name}`)
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
    if (!ownedPath(root, target)) throw new Error('native fixture cleanup escaped its root')
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
  const canonical = path.join(root, 'payloads/canonical-worker')
  await mkdir(path.join(canonical, 'lib'), { recursive: true })
  for (const relative of ['package.json', 'lib/index.js', 'lib/controller-impl.js']) await copyFile(new URL(relative, workerPackage), path.join(canonical, relative))
  packages.set(WORKER, canonical)
  for (const [name, directory] of packages) {
    const target = path.join(root, 'node_modules', ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true }); await symlink(directory, target, 'junction')
  }
  await writeFile(path.join(root, 'package.json'), '{"name":"native-live-loader-fixture","private":true,"type":"module"}\n')
  const require = createRequire(path.join(root, 'package.json'))
  const cordis: typeof import('@deepseek-ai/cordis') = require('@deepseek-ai/cordis')
  const protocol: typeof import('@deepseek-ai/dsh-typert-protocol') = require('@deepseek-ai/dsh-typert-protocol')
  const owner: WorkerOwner = require(WORKER)
  expect(Object.getPrototypeOf(protocol.TypertRemoteService.prototype)).toBe(cordis.Service.prototype)
  expect(owner.default).toBe(owner.SessionController)
  return { require, cordis, owner }
}
function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  const unexpected = (): never => { throw new Error('fixture does not perform Node HMR') }
  return { version: 'v2', loadCache: new Map(), register: unexpected, getOrCreateModuleJob: unexpected, resolveSync: unexpected, load: unexpected,
    async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected Loader import ${specifier}`); return modules.get(specifier) } }
}

it('loads the independently owned bounded native producer without changing public faces or resuming cold input', async () => {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent, PREFIX)))
  let context: Context | undefined
  const backends: NativeAdapter[] = [], readers: Promise<unknown>[] = [], streamRelease = Promise.withResolvers<void>(), readRelease = Promise.withResolvers<void>()
  onTestFinished(async () => {
    streamRelease.resolve(); readRelease.resolve()
    for (const backend of backends) await backend.close()
    await Promise.allSettled(readers)
    vi.restoreAllMocks()
    await context?.fiber.dispose()
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent); expect(path.basename(root).startsWith(PREFIX)).toBe(true)
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    await unlinkFixtureLinks(root, root)
    await rm(root, { recursive: true, force: true })
  })
  const graph = await nativeGraph(root)
  const llm: typeof import('@deepseek-ai/dsh-llm') = graph.require('@deepseek-ai/dsh-llm')
  const session: typeof import('@deepseek-ai/dsh-session') = graph.require('@deepseek-ai/dsh-session')
  const sandbox: typeof import('@deepseek-ai/dsh-sandbox-policy') = graph.require('@deepseek-ai/dsh-sandbox-policy')
  const testkit: typeof import('@deepseek-ai/dsh-agent-loop-testkit') = graph.require('@deepseek-ai/dsh-agent-loop-testkit')
  const loader: typeof import('@deepseek-ai/cordis-plugin-loader') = graph.require('@deepseek-ai/cordis-plugin-loader')
  const include: typeof import('@deepseek-ai/cordis-plugin-include') = graph.require('@deepseek-ai/cordis-plugin-include')
  const fsLocal: typeof import('@deepseek-ai/dsh-fs-local') = graph.require('@deepseek-ai/dsh-fs-local')
  const requests: GenerateOptions[] = [], enteredStream = Promise.withResolvers<void>()
  class ExternalAdapter extends llm.LlmAdapter {
    override providerInfo(provider: string) { return { id: provider, name: provider } }
    override listModels(provider: string): Promise<readonly LlmModelInfo[]> { return Promise.resolve([{ provider, id: 'native-model', name: 'Native model' }]) }
    override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> { return Promise.resolve({ provider, id: model, name: model }) }
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      requests.push(options); enteredStream.resolve()
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Native live text' }
      await streamRelease.promise
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Native live text' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const external = new ExternalAdapter(), ctx = new graph.cordis.Context()
  context = ctx; ctx.baseUrl = `${pathToFileURL(root).href}/`
  const bootstrap = { name: 'native-live-bootstrap', async apply(owner: Context) {
    await owner.plugin(fsLocal.default, { cwd: root })
    await testkit.mountAgentLoopTestDependencies(owner, { workingDirectory: true })
    await testkit.mountAgentLoopTestHarness(owner)
  } }
  const providers = { name: 'native-live-provider', inject: ['llm'], apply(owner: Context) { owner.llm.registerAdapter(['native-provider'], external) } }
  const modules = new Map<string, unknown>(compositionPackages.map(([name]) => [name, graph.require(name)]))
  modules.set('@fixture/native-live-bootstrap', bootstrap); modules.set('@fixture/native-live-provider', providers); modules.set(WORKER, graph.owner)
  const rows = [
    { name: '@fixture/native-live-bootstrap' },
    { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'native-provider', model: 'native-model' } },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(root, 'sessions') } },
    { name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(root, 'domain') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-workspace' },
    { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: root } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: path.join(root, 'fixture-credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-client-connection' }, { name: '@deepseek-ai/dsh-commands' }, { name: '@deepseek-ai/dsh-client-file-upload' },
    { name: '@deepseek-ai/dsh-typert-registry' }, { name: '@deepseek-ai/dsh-api-remote-access' }, { name: '@deepseek-ai/dsh-api-gateway' },
    { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: path.join(root, 'query.sqlite'), openAt: 'never' } },
    { name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only' } },
    { name: '@fixture/native-live-provider' }, { name: WORKER, config: { nativeOpen: false } },
  ]
  const configPath = path.join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(rows, null, 2) + '\n')
  await ctx.plugin(loader.default)
  ctx.loader.builtins.include = include.default; ctx.loader.internal = moduleLoader(modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.get('webServer')).toBeUndefined()
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('Worker Loader did not publish its Controller')
  const original: object = Reflect.get(controller, graph.cordis.symbols.original)
  expect(Object.getPrototypeOf(original)).toBe(graph.owner.SessionController.prototype)
  expect(graph.owner.ownsSourceFollowHelper(original)).toBe(true)
  expect(graph.owner.ownsSourceMutationHelpers(original)).toBe(true); expect(graph.owner.ownsSourceCatalogHelper(original)).toBe(true)
  const own = Object.getOwnPropertyDescriptor(original, 'sourceFollow'), staticCheck = Object.getOwnPropertyDescriptor(graph.owner.SessionController, 'ownsSourceFollowHelper')
  if (own === undefined || staticCheck === undefined) throw new Error('missing private native follow identity')
  const getter = vi.fn(() => { throw new Error('private getter must not run') })
  try {
    Object.defineProperty(original, 'sourceFollow', { configurable: true, get: getter })
    expect(graph.owner.ownsSourceFollowHelper(original)).toBe(false); expect(getter).not.toHaveBeenCalled()
  } finally { Object.defineProperty(original, 'sourceFollow', own) }
  try {
    Object.defineProperty(graph.owner.SessionController, 'ownsSourceFollowHelper', { ...staticCheck, value: () => true })
    expect(graph.owner.ownsSourceFollowHelper(original)).toBe(false)
  } finally { Object.defineProperty(graph.owner.SessionController, 'ownsSourceFollowHelper', staticCheck) }
  expect(graph.owner.ownsSourceFollowHelper(Object.create(graph.owner.SessionController.prototype))).toBe(false)
  const oldWrapper = await readFile(new URL('../../plugin-native/worker-stage2-0.1.2/packages/worker-session-controller/lib/index.js', import.meta.url), 'utf8')
  expect((await readFile(new URL('lib/index.js', workerPackage), 'utf8')).startsWith(oldWrapper)).toBe(true)
  for (const relative of ['lib/client.js', 'lib/typert.base.js', 'lib/typert.host.js', 'lib/typert.remote-client.js']) {
    expect(await readFile(new URL(relative, workerPackage))).toEqual(await readFile(new URL(`../../plugin-native/worker-stage2-0.1.2/packages/worker-session-controller/${relative}`, import.meta.url)))
  }
  const backend = await createNativeAdapter({ ctx, settings: { projects: {} }, native: { cordis: graph.cordis, llm, session, sandbox, controllerOwner: graph.owner } })
  backends.push(backend)
  const follow = backend.followNative, compact = backend.nativeCreateCompactor, expand = backend.nativeExpand, blocks = backend.nativeLiveAssistantBlocks
  if (!follow || !compact || !expand || !blocks) throw new Error('verified Worker live face did not publish')
  const cold = session.SessionId('native-live-cold'), coldHeader = ctx.sessions.prepare(cold, { meta: { cwd: root } }).header
  const events: SessionEvent[] = [
    { type: 'model/selection', seq: session.SessionSeq(0), time: 1, data: { provider: 'native-provider', model: 'native-model' } },
    { type: 'agent/inbox/spliced', seq: session.SessionSeq(1), time: 2, data: { target: 'next-turn', start: 0, inserted: [llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'queued but never resumed' }] })] } },
  ]
  const writer = await ctx.sessionPersistence.create(coldHeader)
  try { await writer.append(events) } finally { await writer.close() }
  const coldFrames = follow({ sessionId: cold }, {}, new AbortController().signal)[Symbol.asyncIterator]()
  expect(await coldFrames.next()).toMatchObject({ value: { type: 'snapshot', header: coldHeader, cursor: 1, assistantStream: { revision: 0 } } })
  await coldFrames.return?.()
  expect(ctx.sessions.get(cold)).toBeUndefined(); expect(ctx.agents.get(cold)).toBeUndefined(); expect(requests).toEqual([])
  const huge = session.SessionId('native-live-oversized'), hugeHeader = ctx.sessions.prepare(huge, { meta: { cwd: root } }).header
  const hugeWriter = await ctx.sessionPersistence.create(hugeHeader)
  try { await hugeWriter.append([{ type: 'user/message', seq: session.SessionSeq(0), time: 1, surfaceOp: 'append',
    data: llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE'.padEnd(1024 * 1024, 'X') }] }) }]) } finally { await hugeWriter.close() }
  const refused = follow({ sessionId: huge }, {}, new AbortController().signal)[Symbol.asyncIterator]()
  await expect(refused.next()).rejects.toMatchObject({ code: 'source-unavailable', message: 'native follow owner is unavailable' })
  await refused.return?.()
  expect(requests).toEqual([])
  const created = await controller.create({ sessionId: session.SessionId('native-live-active'), cwd: path.join(root, 'live-project') })
  const liveAgent = ctx.agents.get(created.sessionId)
  if (liveAgent === undefined) throw new Error('native Controller creation did not publish its Agent')
  const liveSession = liveAgent.session
  expect(ctx.sessions.get(liveSession.id)).toBe(liveSession)
  expect(requests).toEqual([])
  const live = follow({ sessionId: liveSession.id }, {}, new AbortController().signal)[Symbol.asyncIterator]()
  expect(await live.next()).toMatchObject({ value: { type: 'snapshot', assistantStream: { revision: 0 } } })
  const received: SessionFollowFrame[] = []
  const collected = (async () => {
    for (;;) {
      const step = await live.next()
      if (step.done) throw new Error('native follow ended before the native Assistant terminal')
      received.push(step.value)
      if (step.value.type === 'assistant-stream' && step.value.frame.type === 'end') return step.value.frame
    }
  })()
  readers.push(collected)
  void collected.catch((_error: unknown) => { /* The explicit assertion or teardown owns this reader failure. */ })
  await controller.prompt({ requestId: 'native-live-owner-request' as SessionRequestId, sessionId: liveSession.id, mode: 'queue', content: [{ type: 'text', text: 'start one explicit native request' }] }, new AbortController().signal)
  await enteredStream.promise
  await vi.waitFor(() => { expect(received.some(frame => frame.type === 'assistant-stream' && frame.frame.type === 'chunk')).toBe(true) })
  streamRelease.resolve()
  const terminal = await collected
  expect(terminal.outcome.kind).toBe('committed')
  expect(received.some(frame => frame.type === 'event' && frame.event.type === 'assistant/message')).toBe(true)
  expect(JSON.stringify(received)).toContain('Native live text'); expect(requests).toHaveLength(1)
  await live.return?.()
  const accumulator = compact(); accumulator.push({ time: 1, chunk: { type: 'text-delta', index: 0, text: 'Native live text' } })
  const stream = accumulator.snapshot()
  expect(expand(stream)).toEqual(llm.expandAssistantStream(stream))
  expect(blocks(stream, false)).toEqual(llm.assembleAssistantStream(stream).blocks())
  const observe = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery), enteredRead = Promise.withResolvers<AbortSignal | undefined>()
  vi.spyOn(ctx.sessionQuery, 'observeSession').mockImplementation(async (...args) => { enteredRead.resolve(args[1]?.signal); await readRelease.promise; return observe(...args) })
  const held = follow({ sessionId: cold }, {}, new AbortController().signal)[Symbol.asyncIterator]()
  const rejected = expect(held.next()).rejects.toMatchObject({ code: 'source-unavailable' })
  const ownedSignal = await enteredRead.promise
  let joined = false
  const closing = Promise.resolve(backend.close()).then(() => { joined = true })
  expect(ownedSignal?.aborted).toBe(true); expect(joined).toBe(false)
  readRelease.resolve()
  await Promise.all([rejected, closing]); expect(joined).toBe(true)
  expect(() => accumulator.snapshot()).toThrow('unavailable')
  expect(graph.owner.ownsSourceMutationHelpers(original)).toBe(true); expect(graph.owner.ownsSourceCatalogHelper(original)).toBe(true)
}, 60_000)
