/**
 * Packaged Worker 0.1.2 ownership and synthetic Node resolver proof.
 * This explicitly consumes frozen built artifacts with native createRequire, not source aliases.
 * It does not install a profile, run pnpm/plugin_manager, activate Worker, or prove live profile resolution.
 */
import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import SourceSessionController from '../../../dsh-remote-core/packages/api/session-controller/src/index.ts'

const WORKER = '@dsh-remote/worker-session-controller'
const PREFIX = 'dsh-worker-owner-proof-'
const ARTIFACT = fileURLToPath(new URL('../../plugin-native/worker-stage2-0.1.2/', import.meta.url))
const API_ARTIFACT = path.join(ARTIFACT, 'packages/worker-session-controller')
const SOURCE_API = fileURLToPath(new URL('../../../dsh-remote-core/packages/api/session-controller/package.json', import.meta.url))
const MUTATION_METHODS = [
  'createSourceSession', 'prepareSourceSession', 'sourceModelState', 'guardedSourcePrompt',
  'installPromptSelectionGuard', 'selectSessionModel', 'cancel', 'modelCatalog',
] as const

interface WorkerOwner {
  readonly SessionController: typeof SourceSessionController
  ownsSourceMutationHelpers(value: unknown): boolean
  ownsSourceCatalogHelper(value: unknown): boolean
}

interface PackageManifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
}

const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')
const ownsPath = (root: string, target: string): boolean => {
  const relative = path.relative(root, path.resolve(target))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function packageRoot(require: ReturnType<typeof createRequire>, name: string): Promise<string> {
  let directory = path.dirname(require.resolve(name))
  for (;;) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as PackageManifest
      if (manifest.name === name) return realpath(directory)
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`Native test SDK package could not be located: ${name}`)
    directory = parent
  }
}

/** Unlink test-created junctions before recursive removal; no linked SDK/artifact directory is traversed. */
async function unlinkFixtureLinks(directory: string, root: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.resolve(directory, entry.name)
    if (!ownsPath(root, target)) throw new Error('Resolver fixture cleanup escaped its owned root')
    const info = await lstat(target)
    if (info.isSymbolicLink()) await unlink(target)
    else if (info.isDirectory()) await unlinkFixtureLinks(target, root)
  }
}

async function fixture() {
  const parent = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(path.join(parent, PREFIX)))
  expect(path.dirname(root)).toBe(parent)
  expect(path.basename(root).startsWith(PREFIX)).toBe(true)
  onTestFinished(async () => {
    const target = await realpath(root)
    expect(target).toBe(root)
    expect(path.dirname(target)).toBe(parent)
    expect(path.basename(target).startsWith(PREFIX)).toBe(true)
    expect((await lstat(target)).isSymbolicLink()).toBe(false)
    await unlinkFixtureLinks(target, root)
    await rm(target, { recursive: true, force: true })
  })
  const apiManifest = JSON.parse(await readFile(path.join(API_ARTIFACT, 'package.json'), 'utf8')) as PackageManifest
  const extensionManifest = JSON.parse(await readFile(path.join(ARTIFACT, 'package.json'), 'utf8')) as PackageManifest
  expect(apiManifest.name).toBe(WORKER)
  expect(apiManifest.version).toBe('0.1.2')
  expect(extensionManifest.version).toBe('0.1.2')
  const sourceRequire = createRequire(SOURCE_API)
  const sdkRoots = new Map<string, string>()
  const sdkNames = new Set([...Object.keys({ ...apiManifest.dependencies, ...apiManifest.peerDependencies }), '@deepseek-ai/dsh-api-session-controller'])
  for (const name of sdkNames) {
    const canonical = await packageRoot(sourceRequire, name)
    const destination = path.join(root, 'node_modules', ...name.split('/'))
    await mkdir(path.dirname(destination), { recursive: true })
    await symlink(canonical, destination, 'junction')
    sdkRoots.set(name, canonical)
  }
  const copyOwner = async (name: string) => {
    const directory = path.join(root, 'payloads', name)
    await mkdir(path.join(directory, 'lib'), { recursive: true })
    await writeFile(path.join(directory, 'package.json'), await readFile(path.join(API_ARTIFACT, 'package.json')), { flag: 'wx' })
    for (const file of ['index.js', 'controller-impl.js']) {
      await cp(path.join(API_ARTIFACT, 'lib', file), path.join(directory, 'lib', file), { force: false, errorOnExist: true })
      expect(sha256(await readFile(path.join(directory, 'lib', file)))).toBe(sha256(await readFile(path.join(API_ARTIFACT, 'lib', file))))
    }
    const require = createRequire(path.join(directory, 'package.json'))
    const module = require(WORKER) as WorkerOwner
    return { directory, require, module }
  }
  const canonical = await copyOwner('canonical-worker-api')
  const workerDirectory = path.join(root, 'payloads/worker-extension')
  const bridgeDirectory = path.join(root, 'payloads/bridge')
  await mkdir(path.join(workerDirectory, 'packages'), { recursive: true })
  await mkdir(bridgeDirectory, { recursive: true })
  await writeFile(path.join(workerDirectory, 'package.json'), await readFile(path.join(ARTIFACT, 'package.json')), { flag: 'wx' })
  // Synthetic same-origin local dependency: Node and a role-owned canonical provider have one physical target.
  await symlink(canonical.directory, path.join(workerDirectory, 'packages/worker-session-controller'), 'junction')
  const bridgeManifest = {
    name: '@dsh-remote/control-bridge', version: '0.1.4', private: true, type: 'module',
    peerDependencies: { [WORKER]: '0.1.2' }, peerDependenciesMeta: { [WORKER]: { optional: true } },
  }
  await writeFile(path.join(bridgeDirectory, 'package.json'), JSON.stringify(bridgeManifest), { flag: 'wx' })
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: '@fixture/worker-role-resolver-proof', private: true, type: 'module',
    dependencies: {
      [WORKER]: 'file:./payloads/canonical-worker-api',
      '@dsh-remote/worker-extension': 'file:./payloads/worker-extension',
      '@dsh-remote/control-bridge': 'file:./payloads/bridge',
    },
  }), { flag: 'wx' })
  const linkPackage = async (name: string, directory: string, parentDirectory = root): Promise<void> => {
    const target = path.join(parentDirectory, 'node_modules', ...name.split('/'))
    await mkdir(path.dirname(target), { recursive: true })
    await symlink(directory, target, 'junction')
  }
  await linkPackage(WORKER, canonical.directory)
  await linkPackage('@dsh-remote/worker-extension', workerDirectory)
  await linkPackage('@dsh-remote/control-bridge', bridgeDirectory)
  const workerRequire = createRequire(path.join(workerDirectory, 'package.json'))
  const bridgeRequire = createRequire(path.join(bridgeDirectory, 'package.json'))
  const nativeCordis = canonical.require('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')
  const nativeTypert = canonical.require('@deepseek-ai/dsh-typert-protocol') as typeof import('@deepseek-ai/dsh-typert-protocol')
  // Constructor services must share the same SDK class identity, not just matching package names or versions.
  expect(Object.getPrototypeOf(nativeTypert.TypertRemoteService.prototype)).toBe(nativeCordis.Service.prototype)
  const construct = (Constructor = canonical.module.SessionController) => {
    const ctx = new nativeCordis.Context()
    onTestFinished(() => ctx.fiber.dispose())
    ctx.provide('llm', { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => { throw new Error('empty provider catalog resolved metadata') } } as never)
    const defaultSelection = { provider: 'fixture-worker', model: 'fixture-model' }
    ctx.provide('agentDefaultModel', { currentSelection: () => defaultSelection } as never)
    // No Service.init, Agent, sandbox, network, or filesystem business services are activated.
    const instance = new Constructor(ctx, { nativeOpen: false })
    return { instance, ctx, defaultSelection }
  }
  return { root, apiManifest, extensionManifest, bridgeManifest, canonical, copyOwner, linkPackage,
    workerDirectory, bridgeDirectory, workerRequire, bridgeRequire, sdkRoots, nativeCordis, construct }
}

describe.sequential('packaged Worker0.1.2 exact ownership (built artifact, native SDK graph)', () => {
  it('accepts its real instance and executes the constructor-owned passive source helper', async () => {
    const b = await fixture(), { module } = b.canonical
    const { instance, ctx, defaultSelection } = b.construct()
    expect(module.ownsSourceMutationHelpers(instance)).toBe(true)
    expect(module.ownsSourceCatalogHelper(instance)).toBe(true)
    expect(Object.hasOwn(instance, 'sourceModelCatalog')).toBe(false)
    const traced = ctx.get('sessionController')!
    expect(Reflect.get(traced, b.nativeCordis.symbols.original)).toBe(instance)
    expect(module.ownsSourceCatalogHelper(Reflect.get(traced, b.nativeCordis.symbols.original))).toBe(true)
    const result = await instance.sourceModelCatalog({ providerTimeoutMs: 25 }, new AbortController().signal)
    expect(result).toEqual({ default: defaultSelection, routableProviders: [], groups: [], failures: [] })
  })

  it('rejects stock/source classes and a subclass even when method names match', async () => {
    const b = await fixture(), { module } = b.canonical
    const stock = b.canonical.require('@deepseek-ai/dsh-api-session-controller') as { SessionController: typeof SourceSessionController }
    class Child extends module.SessionController {}
    const candidates = [Object.create(SourceSessionController.prototype), Object.create(stock.SessionController.prototype), b.construct(Child).instance]
    for (const candidate of candidates) {
      expect(module.ownsSourceCatalogHelper(candidate)).toBe(false)
      expect(module.ownsSourceMutationHelpers(candidate)).toBe(false)
    }
  })

  it('rejects a physically separate same-version helper while both copies retain identical SDK dependencies', async () => {
    const b = await fixture(), copied = await b.copyOwner('same-version-other-origin')
    expect(JSON.parse(await readFile(path.join(copied.directory, 'package.json'), 'utf8'))).toEqual(b.apiManifest)
    expect(await realpath(copied.require.resolve(WORKER))).not.toBe(await realpath(b.canonical.require.resolve(WORKER)))
    expect(copied.module.SessionController).not.toBe(b.canonical.module.SessionController)
    for (const name of b.sdkRoots.keys()) expect(await realpath(copied.require.resolve(name))).toBe(await realpath(b.canonical.require.resolve(name)))
    expect((copied.require('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')).Context).toBe(b.nativeCordis.Context)
    const foreign = b.construct(copied.module.SessionController).instance
    expect(copied.module.ownsSourceCatalogHelper(foreign)).toBe(true)
    expect(copied.module.ownsSourceMutationHelpers(foreign)).toBe(true)
    expect(b.canonical.module.ownsSourceCatalogHelper(foreign)).toBe(false)
    expect(b.canonical.module.ownsSourceMutationHelpers(foreign)).toBe(false)
  })

  it('rejects an own source-method shadow even if it points at the captured method', async () => {
    const b = await fixture(), { instance } = b.construct(), { module } = b.canonical
    const original = Object.getOwnPropertyDescriptor(instance, 'sourceModelCatalog')
    try {
      Object.defineProperty(instance, 'sourceModelCatalog', { configurable: true, value: module.SessionController.prototype.sourceModelCatalog })
      expect(module.ownsSourceCatalogHelper(instance)).toBe(false)
      expect(module.ownsSourceMutationHelpers(instance)).toBe(true)
    } finally {
      if (original) Object.defineProperty(instance, 'sourceModelCatalog', original)
      else Reflect.deleteProperty(instance, 'sourceModelCatalog')
    }
    expect(module.ownsSourceCatalogHelper(instance)).toBe(true)
  })

  it('rejects replacement of the captured prototype read method without withdrawing mutation ownership', async () => {
    const b = await fixture(), { instance } = b.construct(), { module } = b.canonical
    const prototype = module.SessionController.prototype
    const original = Object.getOwnPropertyDescriptor(prototype, 'sourceModelCatalog')!
    try {
      Object.defineProperty(prototype, 'sourceModelCatalog', { ...original, value() { throw new Error('replacement must not execute') } })
      expect(module.ownsSourceCatalogHelper(instance)).toBe(false)
      expect(module.ownsSourceMutationHelpers(instance)).toBe(true)
    } finally { Object.defineProperty(prototype, 'sourceModelCatalog', original) }
    expect(module.ownsSourceCatalogHelper(instance)).toBe(true)
  })

  it.each(MUTATION_METHODS)('keeps read ownership independent when mutable helper %s is replaced', async name => {
    const b = await fixture(), { instance } = b.construct(), { module } = b.canonical
    const prototype = module.SessionController.prototype
    const original = Object.getOwnPropertyDescriptor(prototype, name)!
    try {
      Object.defineProperty(prototype, name, { ...original, value() { throw new Error('replacement must not execute') } })
      expect(module.ownsSourceMutationHelpers(instance)).toBe(false)
      expect(module.ownsSourceCatalogHelper(instance)).toBe(true)
    } finally { Object.defineProperty(prototype, name, original) }
    expect(module.ownsSourceMutationHelpers(instance)).toBe(true)
  })

  it('rejects own and prototype constructor shadows and a replaced instance prototype', async () => {
    const b = await fixture(), { instance } = b.construct(), { module } = b.canonical
    const prototype = module.SessionController.prototype
    try {
      Object.defineProperty(instance, 'constructor', { value: module.SessionController, configurable: true })
      expect(module.ownsSourceCatalogHelper(instance)).toBe(false)
      expect(module.ownsSourceMutationHelpers(instance)).toBe(false)
    } finally { Reflect.deleteProperty(instance, 'constructor') }
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor')!
    try {
      Object.defineProperty(prototype, 'constructor', { ...constructor, value: function DifferentConstructor() {} })
      expect(module.ownsSourceCatalogHelper(instance)).toBe(false)
      expect(module.ownsSourceMutationHelpers(instance)).toBe(false)
    } finally { Object.defineProperty(prototype, 'constructor', constructor) }
    try {
      Object.setPrototypeOf(instance, Object.create(prototype))
      expect(module.ownsSourceCatalogHelper(instance)).toBe(false)
      expect(module.ownsSourceMutationHelpers(instance)).toBe(false)
    } finally { Object.setPrototypeOf(instance, prototype) }
    expect(module.ownsSourceCatalogHelper(instance)).toBe(true)
    expect(module.ownsSourceMutationHelpers(instance)).toBe(true)
  })
})

describe.sequential('synthetic role-owned Node resolver proof (not a public-manager/profile installation)', () => {
  it('resolves Bridge and Worker extension to one canonical Worker API and exact constructor instance', async () => {
    const b = await fixture()
    expect(b.extensionManifest.dependencies?.[WORKER]).toBe('file:./packages/worker-session-controller')
    expect(b.bridgeManifest.peerDependencies[WORKER]).toBe('0.1.2')
    const workerEntry = await realpath(b.workerRequire.resolve(WORKER))
    const bridgeEntry = await realpath(b.bridgeRequire.resolve(WORKER))
    expect(workerEntry).toBe(bridgeEntry)
    expect(workerEntry).toBe(await realpath(b.canonical.require.resolve(WORKER)))
    const worker = b.workerRequire(WORKER) as WorkerOwner, bridge = b.bridgeRequire(WORKER) as WorkerOwner
    expect(worker).toBe(bridge)
    expect(worker.SessionController).toBe(bridge.SessionController)
    const { instance } = b.construct(worker.SessionController)
    expect(bridge.ownsSourceCatalogHelper(instance)).toBe(true)
    expect(bridge.ownsSourceMutationHelpers(instance)).toBe(true)
  })

  it('detects a second same-version file origin despite identical bytes and shared SDK instances', async () => {
    const b = await fixture(), copied = await b.copyOwner('duplicate-file-origin')
    await b.linkPackage(WORKER, copied.directory, b.bridgeDirectory)
    const worker = b.workerRequire(WORKER) as WorkerOwner, bridge = b.bridgeRequire(WORKER) as WorkerOwner
    expect(await realpath(b.workerRequire.resolve(WORKER))).not.toBe(await realpath(b.bridgeRequire.resolve(WORKER)))
    expect(worker.SessionController).not.toBe(bridge.SessionController)
    expect(await realpath(b.workerRequire.resolve('@deepseek-ai/cordis'))).toBe(await realpath(b.bridgeRequire.resolve('@deepseek-ai/cordis')))
    expect((copied.require('@deepseek-ai/cordis') as typeof import('@deepseek-ai/cordis')).Context).toBe(b.nativeCordis.Context)
    const { instance } = b.construct(worker.SessionController)
    expect(worker.ownsSourceCatalogHelper(instance)).toBe(true)
    expect(bridge.ownsSourceCatalogHelper(instance)).toBe(false)
    expect(bridge.ownsSourceMutationHelpers(instance)).toBe(false)
  })
})
