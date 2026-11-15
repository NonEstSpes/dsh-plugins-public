/** Real compiled Worker file provider on a canonical SDK graph; only the external model is supplied by the test. */
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { ModuleLoaderV2 } from '@deepseek-ai/cordis-plugin-loader'
import type { LlmAdapter } from '@deepseek-ai/dsh-llm'

interface Manifest { readonly name: string; readonly version: string; readonly dependencies?: Record<string, string>; readonly peerDependencies?: Record<string, string> }
export interface NativeFilesOwner {
  readonly SessionController: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  readonly default: typeof import('@deepseek-ai/dsh-api-session-controller').SessionController
  ownsSourceMutationHelpers(value: unknown): boolean
  ownsSourceCatalogHelper(value: unknown): boolean
  ownsSourceFollowHelper(value: unknown): boolean
  ownsSourceProjectHelpers(value: unknown): boolean
  ownsSourceFilesHelper(value: unknown): boolean
}
const WORKER = '@dsh-remote/worker-session-controller', PREFIX = 'dsh-native-files-owner-'
const sourceRequire = createRequire(new URL('../../../../dsh-remote-core/packages/api/session-controller/package.json', import.meta.url))
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
  ['@deepseek-ai/dsh-api-workspace-files', 'packages/api/workspace-files'],
  ['@deepseek-ai/dsh-session-query-sqlite', 'packages/session-query/session-query-sqlite'], ['@deepseek-ai/dsh-sandbox-policy', 'packages/sandbox/sandbox-policy'],
] as const
async function manifestAt(filename: URL | string): Promise<Manifest> { return JSON.parse(await readFile(filename, 'utf8')) as Manifest }
async function packageRoot(name: string): Promise<string> {
  let directory = path.dirname(sourceRequire.resolve(name))
  for (;;) {
    try { if ((await manifestAt(path.join(directory, 'package.json'))).name === name) return realpath(directory) }
    catch (error: unknown) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`native fixture package not found: ${name}`)
    directory = parent
  }
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
async function removeLinks(directory: string, root: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.resolve(directory, entry.name)
    if (!inside(root, target)) throw new Error('native file fixture cleanup escaped its root')
    const info = await lstat(target)
    if (info.isSymbolicLink()) await unlink(target)
    else if (info.isDirectory()) await removeLinks(target, root)
  }
}
function moduleLoader(modules: ReadonlyMap<string, unknown>): ModuleLoaderV2 {
  const unexpected = (): never => { throw new Error('native fixture does not perform Node HMR') }
  return { version: 'v2', loadCache: new Map(), register: unexpected, getOrCreateModuleJob: unexpected, resolveSync: unexpected, load: unexpected,
    async import(specifier: string) { if (!modules.has(specifier)) throw new Error(`unexpected native file Loader import ${specifier}`); return modules.get(specifier) } }
}
/**
 * Start the actual immutable Worker through a Loader composition, without a Web server or private profile state.
 * @param makeModel Scripted external model; native storage, uploads, admission and AgentLoop remain real.
 * @param version Exact immutable Worker revision; the existing file proof keeps its 0.1.6 predecessor.
 * @returns Owned native realm and an idempotent teardown for every acquired path and plugin fiber.
 */
export async function openNativeFilesWorker(makeModel: (llm: typeof import('@deepseek-ai/dsh-llm')) => LlmAdapter, version: '0.1.6' | '0.1.7' = '0.1.6') {
  const packageUrl = new URL(`../../../plugin-native/worker-stage5-${version}/packages/worker-session-controller/`, import.meta.url)
  const parent = await realpath(tmpdir()), root = await realpath(await mkdtemp(path.join(parent, PREFIX)))
  let context: Context | undefined, closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closing = (async () => {
      await context?.fiber.dispose()
      if (await realpath(root) !== root || path.dirname(root) !== parent || !path.basename(root).startsWith(PREFIX) || (await lstat(root)).isSymbolicLink()) throw new Error('invalid native file fixture cleanup')
      await removeLinks(root, root); await rm(root, { recursive: true, force: true })
    })()
    return closing
  }
  try {
    const manifest = await manifestAt(new URL('package.json', packageUrl))
    if (manifest.name !== WORKER || manifest.version !== version) throw new Error('unexpected native file Worker artifact')
    const packages = new Map<string, string>()
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) packages.set(name, await packageRoot(name))
    for (const [name, folder] of compositionPackages) {
      const directory = await realpath(fileURLToPath(new URL(`../../../../dsh-remote-core/${folder}/`, import.meta.url)))
      if ((await manifestAt(path.join(directory, 'package.json'))).name !== name || (packages.has(name) && packages.get(name) !== directory)) throw new Error('native file fixture module identity mismatch')
      packages.set(name, directory)
    }
    const canonical = path.join(root, 'payloads/canonical-worker')
    await mkdir(path.join(canonical, 'lib'), { recursive: true })
    for (const relative of ['package.json', 'lib/index.js', 'lib/controller-impl.js']) await copyFile(new URL(relative, packageUrl), path.join(canonical, relative))
    packages.set(WORKER, canonical)
    for (const [name, directory] of packages) {
      const target = path.join(root, 'node_modules', ...name.split('/'))
      await mkdir(path.dirname(target), { recursive: true }); await symlink(directory, target, 'junction')
    }
    await writeFile(path.join(root, 'package.json'), '{"name":"native-file-loader-fixture","private":true,"type":"module"}\n')
    const require = createRequire(path.join(root, 'package.json'))
    const cordis: typeof import('@deepseek-ai/cordis') = require('@deepseek-ai/cordis')
    const llm: typeof import('@deepseek-ai/dsh-llm') = require('@deepseek-ai/dsh-llm')
    const session: typeof import('@deepseek-ai/dsh-session') = require('@deepseek-ai/dsh-session')
    const sandbox: typeof import('@deepseek-ai/dsh-sandbox-policy') = require('@deepseek-ai/dsh-sandbox-policy')
    const protocol: typeof import('@deepseek-ai/dsh-typert-protocol') = require('@deepseek-ai/dsh-typert-protocol')
    const owner: NativeFilesOwner = require(WORKER)
    if (owner.default !== owner.SessionController) throw new Error('native file fixture has another controller constructor')
    const loader: typeof import('@deepseek-ai/cordis-plugin-loader') = require('@deepseek-ai/cordis-plugin-loader')
    const include: typeof import('@deepseek-ai/cordis-plugin-include') = require('@deepseek-ai/cordis-plugin-include')
    const fsLocal: typeof import('@deepseek-ai/dsh-fs-local') = require('@deepseek-ai/dsh-fs-local')
    const testkit: typeof import('@deepseek-ai/dsh-agent-loop-testkit') = require('@deepseek-ai/dsh-agent-loop-testkit')
    const ctx = new cordis.Context(); context = ctx; ctx.baseUrl = `${pathToFileURL(root).href}/`
    const external = makeModel(llm)
    const bootstrap = { name: 'native-files-bootstrap', async apply(host: Context) {
      await host.plugin(fsLocal.default, { cwd: root })
      await testkit.mountAgentLoopTestDependencies(host, { workingDirectory: true }); await testkit.mountAgentLoopTestHarness(host)
    } }
    const model = { name: 'native-files-model', inject: ['llm'], apply(host: Context) { host.llm.registerAdapter(['native-files-provider'], external) } }
    const modules = new Map<string, unknown>(compositionPackages.map(([name]) => [name, require(name)]))
    modules.set('@fixture/native-files-bootstrap', bootstrap); modules.set('@fixture/native-files-model', model); modules.set(WORKER, owner)
    const rows = [
      { name: '@fixture/native-files-bootstrap' }, { name: '@fixture/native-files-model' },
      { name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'native-files-provider', model: 'native-files-model' } },
      { name: '@deepseek-ai/dsh-session-persistence-jsonl', config: { root: path.join(root, 'sessions') } },
      { name: '@deepseek-ai/dsh-storage' }, { name: '@deepseek-ai/dsh-storage-json', config: { root: path.join(root, 'domain') } },
      { name: '@deepseek-ai/dsh-storage-domain', config: { backend: 'json' } }, { name: '@deepseek-ai/dsh-workspace' },
      { name: '@deepseek-ai/dsh-attachment-local', config: { dshHome: root } },
      { name: '@deepseek-ai/dsh-credentials-local', config: { path: path.join(root, 'fixture-credentials.yaml'), watch: false } },
      { name: '@deepseek-ai/dsh-client-connection' }, { name: '@deepseek-ai/dsh-commands' }, { name: '@deepseek-ai/dsh-client-file-upload' },
      { name: '@deepseek-ai/dsh-typert-registry' }, { name: '@deepseek-ai/dsh-api-remote-access' }, { name: '@deepseek-ai/dsh-api-gateway' },
      { name: '@deepseek-ai/dsh-api-workspace-files' },
      { name: '@deepseek-ai/dsh-session-query-sqlite', config: { path: path.join(root, 'query.sqlite'), openAt: 'never' } },
      { name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: 'read-only' } }, { name: WORKER, config: { nativeOpen: false } },
    ]
    const configPath = path.join(root, 'cordis.yml'); await writeFile(configPath, JSON.stringify(rows, null, 2) + '\n')
    await ctx.plugin(loader.default); ctx.loader.builtins.include = include.default; ctx.loader.internal = moduleLoader(modules)
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } }); await ctx.loader.await()
    if ([...ctx.loader.entries()].some(entry => entry.fiber === undefined && !entry.disabled) || ctx.get('webServer') !== undefined) throw new Error('native file fixture composition is incomplete')
    const controller = ctx.get('sessionController')
    if (!controller) throw new Error('native file Worker did not publish its controller')
    const original: object = Reflect.get(controller, cordis.symbols.original)
    if (Object.getPrototypeOf(original) !== owner.SessionController.prototype || !owner.ownsSourceFilesHelper(original)) throw new Error('native file helper owner was not verified')
    return { root, ctx, cordis, llm, session, sandbox, protocol, owner, controller, original, close }
  } catch (error) {
    await close(); throw error
  }
}
