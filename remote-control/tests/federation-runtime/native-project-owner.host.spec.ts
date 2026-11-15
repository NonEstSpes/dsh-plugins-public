/** Real Loader/immutable Worker0.1.5 project helpers and durable enrollment on one canonical Node SDK graph. */
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash, randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { expect, it, onTestFinished, vi } from 'vitest'
import { openProjectJournal, type ProjectJournal } from '../../lib/federation/project-journal.mjs'
import { evaluateGrant, type FederationGrantV2 } from '../../lib/federation/grants.mjs'
import { createProjectRegistrar } from '../../lib/federation/project-registration.mjs'
import { createNativeAdapter, type NativeAdapter } from '../../lib/federation/native-adapter.mjs'
import { createRelay } from '../../relay/server.mjs'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'
import { createHostProvider } from '../../lib/federation/host-provider.mjs'

const WORKER = '@dsh-remote/worker-session-controller', PREFIX = 'dsh-native-project-owner-'
const workerPackage = new URL('../../plugin-native/worker-stage4-0.1.5/packages/worker-session-controller/', import.meta.url)
const sourceRequire = createRequire(new URL('../../../dsh-remote-core/packages/api/session-controller/package.json', import.meta.url))
interface Manifest { readonly name: string; readonly version: string; readonly dependencies?: Record<string, string>; readonly peerDependencies?: Record<string, string> }
interface WorkerOwner {
  readonly SessionController: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  readonly default: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  ownsSourceMutationHelpers(value: unknown): boolean
  ownsSourceCatalogHelper(value: unknown): boolean
  ownsSourceFollowHelper(value: unknown): boolean
  ownsSourceProjectHelpers(value: unknown): boolean
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
    if (parent === directory) throw new Error(`native package not found: ${name}`)
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
    if (!ownedPath(root, target)) throw new Error('project fixture cleanup escaped its root')
    const info = await lstat(target)
    if (info.isSymbolicLink()) await unlink(target)
    else if (info.isDirectory()) await unlinkFixtureLinks(target, root)
  }
}
async function nativeGraph(root: string) {
  const manifest = await manifestAt(new URL('package.json', workerPackage))
  expect(manifest.name).toBe(WORKER); expect(manifest.version).toBe('0.1.5')
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
  await writeFile(path.join(root, 'package.json'), '{"name":"native-project-loader-fixture","private":true,"type":"module"}\n')
  const require = createRequire(path.join(root, 'package.json'))
  const cordis: typeof import('@deepseek-ai/cordis') = require('@deepseek-ai/cordis')
  const owner: WorkerOwner = require(WORKER)
  expect(owner.default).toBe(owner.SessionController)
  return { require, cordis, owner }
}
function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  const unexpected = (): never => { throw new Error('fixture does not perform Node HMR') }
  return { version: 'v2', loadCache: new Map(), register: unexpected, getOrCreateModuleJob: unexpected, resolveSync: unexpected, load: unexpected,
    async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected Loader import ${specifier}`); return modules.get(specifier) } }
}

it('registers a native directory through the actual Loader owner without adopting existing Sessions', async () => {
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent, PREFIX)))
  let context: Context | undefined, journal: ProjectJournal | undefined, backend: NativeAdapter | undefined
  const transports: { close(): void | Promise<void> }[] = []
  onTestFinished(async () => {
    for (const transport of transports.reverse()) await transport.close()
    await backend?.close(); await journal?.close(); vi.restoreAllMocks(); await context?.fiber.dispose()
    expect(await realpath(root)).toBe(root); expect(path.dirname(root)).toBe(parent); expect(path.basename(root).startsWith(PREFIX)).toBe(true)
    expect((await lstat(root)).isSymbolicLink()).toBe(false)
    await unlinkFixtureLinks(root, root); await rm(root, { recursive: true, force: true })
  })
  const graph = await nativeGraph(root)
  const loader: typeof import('@deepseek-ai/cordis-plugin-loader') = graph.require('@deepseek-ai/cordis-plugin-loader')
  const include: typeof import('@deepseek-ai/cordis-plugin-include') = graph.require('@deepseek-ai/cordis-plugin-include')
  const fsLocal: typeof import('@deepseek-ai/dsh-fs-local') = graph.require('@deepseek-ai/dsh-fs-local')
  const testkit: typeof import('@deepseek-ai/dsh-agent-loop-testkit') = graph.require('@deepseek-ai/dsh-agent-loop-testkit')
  const session: typeof import('@deepseek-ai/dsh-session') = graph.require('@deepseek-ai/dsh-session')
  const llm: typeof import('@deepseek-ai/dsh-llm') = graph.require('@deepseek-ai/dsh-llm')
  const ctx = new graph.cordis.Context(); context = ctx; ctx.baseUrl = `${pathToFileURL(root).href}/`
  const bootstrap = { name: 'native-project-bootstrap', async apply(owner: Context) {
    await owner.plugin(fsLocal.default, { cwd: root })
    await testkit.mountAgentLoopTestDependencies(owner, { workingDirectory: true }); await testkit.mountAgentLoopTestHarness(owner)
  } }
  const modules = new Map<string, unknown>(compositionPackages.map(([name]) => [name, graph.require(name)]))
  modules.set('@fixture/native-project-bootstrap', bootstrap); modules.set(WORKER, graph.owner)
  const rows = [
    { name: '@fixture/native-project-bootstrap' },
    { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'unused-native-provider', model: 'unused-native-model' } },
    { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(root, 'sessions') } },
    { name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(root, 'domain') } },
    { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-workspace' },
    { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: root } },
    { name: '@deepseek-ai/dsh-credentials-local', config: { path: path.join(root, 'fixture-credentials.yaml'), watch: false } },
    { name: '@deepseek-ai/dsh-client-connection' }, { name: '@deepseek-ai/dsh-commands' }, { name: '@deepseek-ai/dsh-client-file-upload' },
    { name: '@deepseek-ai/dsh-typert-registry' }, { name: '@deepseek-ai/dsh-api-remote-access' }, { name: '@deepseek-ai/dsh-api-gateway' },
    { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: path.join(root, 'query.sqlite'), openAt: 'never' } },
    { name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only' } }, { name: WORKER, config: { nativeOpen: false } },
  ]
  const configPath = path.join(root, 'cordis.yml'); await writeFile(configPath, JSON.stringify(rows, null, 2) + '\n')
  await ctx.plugin(loader.default); ctx.loader.builtins.include = include.default; ctx.loader.internal = moduleLoader(modules)
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
  expect(ctx.get('webServer')).toBeUndefined()
  const controller = ctx.get('sessionController')
  if (controller === undefined) throw new Error('Worker Loader did not publish its project helper owner')
  const original: object = Reflect.get(controller, graph.cordis.symbols.original)
  expect(graph.owner.ownsSourceProjectHelpers(original)).toBe(true)
  expect(graph.owner.ownsSourceFollowHelper(original)).toBe(true)
  expect(graph.owner.ownsSourceCatalogHelper(original)).toBe(true); expect(graph.owner.ownsSourceMutationHelpers(original)).toBe(true)
  expect(graph.owner.ownsSourceProjectHelpers(Object.create(Object.getPrototypeOf(original)))).toBe(false)
  const own = Object.getOwnPropertyDescriptor(original, 'sourceRegisterProject')
  if (own === undefined) throw new Error('missing constructor-owned project registration data property')
  const getter = vi.fn(() => { throw new Error('private helper getter must not run') })
  try {
    Object.defineProperty(original, 'sourceRegisterProject', { configurable: true, get: getter })
    expect(graph.owner.ownsSourceProjectHelpers(original)).toBe(false); expect(getter).not.toHaveBeenCalled()
  } finally { Object.defineProperty(original, 'sourceRegisterProject', own) }

  const directory = path.join(root, 'Worker existing Ж directory'), alias = path.join(root, 'requested alias')
  await mkdir(directory); await symlink(directory, alias, 'junction')
  const coldId = session.SessionId('preexisting-private-native-session')
  const cold = ctx.sessions.create(coldId, { meta: { cwd: directory } })
  cold.append('user/message', llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Private native Session' }] }), { surfaceOp: 'append' })
  const writer = await ctx.sessionPersistence.create(cold.header)
  try { await writer.append(cold.snapshotEvents()); await writer.flush() } finally { await writer.close() }
  const nativeWorkspace = await ctx.workspaceRegistry.create(directory)
  await nativeWorkspace.attachSession(coldId)
  expect(nativeWorkspace.sessionIds).toEqual([coldId])
  const readMembership = vi.fn(() => { throw new Error('registration must never read native Session membership') })
  Object.defineProperty(nativeWorkspace, 'sessionIds', { configurable: true, get: readMembership })
  const before = ctx.workspaceRegistry.list().length
  const prepared = await controller.sourcePrepareProject({ path: alias }, new AbortController().signal)
  expect(prepared.existingWorkspaceId).toBe(nativeWorkspace.id)
  expect(ctx.workspaceRegistry.list()).toHaveLength(before)
  const native = await controller.sourceRegisterProject({ canonicalPath: prepared.canonicalPath }, new AbortController().signal)
  expect(native.workspaceId).toBe(nativeWorkspace.id); expect(native.canonicalPath).toBe(prepared.canonicalPath)
  expect(readMembership).not.toHaveBeenCalled(); expect(ctx.agents.get(coldId)).toBeUndefined(); expect(ctx.sessions.get(coldId)).toBe(cold)
  const grant: FederationGrantV2 = { version: 2, grantId: 'native-project-grant', principal: { kind: 'controller', id: 'project-controller' }, machineKey: 'project-worker',
    revision: 1, issuedAt: 0, projects: [], projectRegistration: { actions: ['project.register'], projectGrant: { actions: ['project.list', 'session.list'], exportClasses: ['conversation.user'] } } }
  journal = await openProjectJournal({ role: 'worker', id: 'project-worker', peerId: 'project-controller', machineKey: 'project-worker', pairingGeneration: 1,
    keyFingerprint: 'f'.repeat(64), stateDir: path.join(root, 'pair') })
  const request = { requestId: 'native_project_001', body: { path: alias }, authority: { generation: 2, grantRevision: 1 } }
  const ledger = journal
  const sandbox: typeof import('@deepseek-ai/dsh-sandbox-policy') = graph.require('@deepseek-ai/dsh-sandbox-policy')
  backend = await createNativeAdapter({ ctx, settings: { projects: {} }, native: { cordis: graph.cordis, llm, session, sandbox, controllerOwner: graph.owner } })
  const prepareProject = backend.prepareProject, registerProject = backend.registerProject
  if (!prepareProject || !registerProject) throw new Error('verified actual Worker project face was not published')
  let nativeRegistrations = 0
  const registrar = createProjectRegistrar({ journal: ledger,
    context: () => ({ principal: grant.principal, machineKey: grant.machineKey, generation: 2, grantRevision: 1, grant, now: Date.now(), remoteOwnedProjects: ledger.ownedProjects() }),
    native: { prepare: prepareProject,
      register: async (input, signal) => { nativeRegistrations++; return registerProject(input, signal) } },
    checkCanonicalPath: canonical => { if (!ownedPath(root, canonical) || canonical === path.join(root, 'pair') || ownedPath(path.join(root, 'pair'), canonical)) throw new Error('private Worker path rejected') },
  })
  const result = await registrar.register(request, new AbortController().signal)
  const committed = ledger.row(request.requestId)
  if (committed === undefined) throw new Error('actual native project registration omitted its journal receipt')
  expect(committed.state).toBe('committed'); expect(committed.result).toEqual(result); expect(nativeRegistrations).toBe(1)
  expect(await registrar.register(request, new AbortController().signal)).toEqual(result); expect(nativeRegistrations).toBe(1)
  const newDirectory = path.join(root, 'Another existing native directory'); await mkdir(newDirectory)
  const second = await registrar.register({ ...request, requestId: 'native_project_002', body: { path: newDirectory } }, new AbortController().signal)
  expect(second.ref.projectId).not.toBe(result.ref.projectId); expect(nativeRegistrations).toBe(2)
  expect(ctx.workspaceRegistry.list()).toHaveLength(before + 1)
  const decision = evaluateGrant(grant, { principal: grant.principal, machineKey: grant.machineKey, projectId: committed.result!.ref.projectId,
    sessionId: coldId, action: 'session.read', exportClasses: ['conversation.user'] }, { currentRevision: 1, now: Date.now(), remoteOwnedProjects: journal.ownedProjects() })
  expect(decision.allowed).toBe(false)
  expect(JSON.stringify(journal.ownedProjects())).not.toContain(coldId)
  expect(JSON.stringify(journal.state(request.requestId))).not.toContain(prepared.canonicalPath)
  expect(JSON.stringify(journal.state(request.requestId))).not.toContain(native.workspaceId)
  expect(ctx.agents.get(coldId)).toBeUndefined(); expect(readMembership).not.toHaveBeenCalled()
  const saved = journal.state(request.requestId); await journal.close()
  journal = await openProjectJournal({ role: 'worker', id: 'project-worker', peerId: 'project-controller', machineKey: 'project-worker', pairingGeneration: 1,
    keyFingerprint: 'f'.repeat(64), stateDir: path.join(root, 'pair') })
  expect(journal.state(request.requestId)).toEqual(saved)

  // The same real SDK owner now serves the user operation through authenticated HTTP/JWE.
  const controllerId = 'http-controller', workerId = 'http-worker', machineKey = 'http-project-machine'
  const controllerToken = randomBytes(32).toString('base64url'), workerToken = randomBytes(32).toString('base64url')
  const relay = createRelay({ directory: path.join(root, 'http-relay'), pollMs: 20, devices: [
    { id: controllerId, peerId: workerId, tokenHash: createHash('sha256').update(controllerToken).digest('hex') },
    { id: workerId, peerId: controllerId, tokenHash: createHash('sha256').update(workerToken).digest('hex') },
  ] })
  transports.push(relay)
  await new Promise<void>((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve) })
  const address = relay.server.address()
  if (!address || typeof address === 'string') throw new Error('native project relay did not acquire its owned port')
  const common = { machineKey, protocol: 2, pairingGeneration: 1, relayUrl: `http://127.0.0.1:${address.port}`,
    sharedKey: randomBytes(32).toString('base64url'), allowLoopback: true, requestTimeoutMs: 2000 }
  const httpGrant: FederationGrantV2 = { ...grant, grantId: 'native-project-http-grant', principal: { kind: 'controller', id: controllerId }, machineKey }
  const workerSettings = await parseSettingsV2({ version: 2, role: 'worker', id: 'logical-http-worker', machineKey, projects: {},
    pairs: [{ ...common, id: workerId, peerId: controllerId, relayToken: workerToken, stateDir: './http-worker-state', grant: httpGrant }] }, path.join(root, 'worker-settings.json'))
  const workerRuntime = await openFederationRuntime(workerSettings, { backend }); transports.push(workerRuntime); workerRuntime.start()
  const controllerSettings = await parseSettingsV2({ version: 2, role: 'controller', id: 'logical-http-controller',
    pairs: [{ ...common, id: controllerId, peerId: workerId, relayToken: controllerToken, stateDir: './http-controller-state' }] }, path.join(root, 'controller-settings.json'))
  const controllerRuntime = await openFederationRuntime(controllerSettings); transports.push(controllerRuntime); controllerRuntime.start()
  const pair = controllerSettings.pairs[0]
  if (!pair) throw new Error('native project Controller pairing was not retained')
  const typert: typeof import('@deepseek-ai/dsh-typert-protocol') = graph.require('@deepseek-ai/dsh-typert-protocol')
  const provider = await createHostProvider({ runtime: controllerRuntime, pair, RemoteError: typert.RemoteError })
  const registration = provider.projectRegistration
  if (!registration) throw new Error('Controller provider did not publish explicit project registration')
  const signal = new AbortController().signal, ready = await registration.state(signal)
  expect(ready.canRegister).toBe(true)
  const httpDirectory = path.join(root, 'Path sent through HTTP Ж'); await mkdir(httpDirectory)
  const httpRequest = { requestId: 'native_project_http_001' as SessionRequestId, path: httpDirectory, expected: ready.expected }
  const remoteProject = await registration.register(httpRequest, signal)
  expect(remoteProject.machineKey).toBe(machineKey)
  const page = await provider.catalog(undefined, signal)
  expect(page.projects.map(project => project.ref)).toContainEqual(remoteProject)
  expect(page.sessions).toEqual([])
  expect(JSON.stringify(page)).not.toContain(coldId)
  expect(JSON.stringify(page)).not.toContain(httpDirectory)
  const registeredWorkspace = await ctx.workspaceRegistry.resolveByPath(httpDirectory)
  expect(registeredWorkspace).toBeDefined()
  expect(ctx.agents.get(coldId)).toBeUndefined()
  const beforeReplay = ctx.workspaceRegistry.list().length
  expect(await registration.register(httpRequest, signal)).toEqual(remoteProject)
  expect(ctx.workspaceRegistry.list()).toHaveLength(beforeReplay)
}, 30_000)
