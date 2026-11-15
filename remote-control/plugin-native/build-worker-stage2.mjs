/** Build only the private Worker Host from maintained TypeScript source; never installs or rewrites old payloads. */
import { cp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../dsh-remote-core')
const base = path.join(here, 'worker-bundle'), output = path.join(here, 'worker-stage2-0.1.2'), version = '0.1.2'
const source = path.join(root, 'packages/api/session-controller'), scratch = path.join(root, '.dsh-build/plugin-native', `worker-stage2-${randomUUID()}`)
const require = createRequire(path.join(root, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href)
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href)
const { standardDecoratorPlugin } = await import(pathToFileURL(path.join(root, 'vitest.shared.ts')).href)
const decorators = standardDecoratorPlugin()
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const exists = async file => { try { await stat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function snapshot(directory, prefix = '') {
  const files = {}
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(directory, item.name), relative = prefix + item.name
    if (item.isSymbolicLink()) throw new Error(`Unexpected artifact link ${relative}`)
    if (item.isDirectory()) Object.assign(files, await snapshot(absolute, relative + '/'))
    else if (item.isFile()) files[relative] = hash(await readFile(absolute))
    else throw new Error(`Unexpected artifact entry ${relative}`)
  }
  return files
}
if (await exists(output)) throw new Error(`Refusing to overwrite immutable ${output}`)
const before = await snapshot(base), inputs = await snapshot(path.join(source, 'src'))
const original = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'))
const manifest = JSON.parse(await readFile(path.join(base, 'packages/worker-session-controller/package.json'), 'utf8'))
manifest.version = version
await mkdir(scratch, { recursive: true })
await cp(path.join(source, 'src'), path.join(scratch, 'src'), { recursive: true })
await writeFile(path.join(scratch, 'package.json'), json(manifest), { flag: 'wx' })
await mkdir(path.join(scratch, 'node_modules'), { recursive: true })
for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
  const from = path.join(source, 'node_modules', ...name.split('/'))
  if (!await exists(from)) continue
  const to = path.join(scratch, 'node_modules', ...name.split('/'))
  await mkdir(path.dirname(to), { recursive: true }); await symlink(await realpath(from), to, 'junction')
}
const preset = clientBundle(scratch, ['src/index.ts'], { hostPhase: true, lib: {
  entry: { 'controller-impl': 'src/index.ts' }, target: 'node24', sourcemap: true,
  deps: { neverBundle: specifier => !specifier.startsWith('.') && !path.isAbsolute(specifier) },
  outputOptions: { entryFileNames: 'controller-impl.js' },
} })
const config = preset({ env: { DSH_BUILD_FACE: 'host' } }).find(item => item.name === manifest.name)
if (!config) throw new Error('Missing maintained Worker Host face')
console.log(`BUILD ${manifest.name} Host from src/index.ts`)
await build({ ...config, cwd: scratch, config: false, tsconfig: false, logLevel: 'warn',
  inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) {
    if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message)
    handler(level, diagnostic)
  } },
  plugins: [{ name: decorators.name, transform: { order: 'pre', handler: decorators.transform } }, config.plugins, { name: 'worker-stage2-output-only', generateBundle(_options, emitted) {
    for (const file of Object.keys(emitted)) if (!['controller-impl.js', 'controller-impl.js.map'].includes(file)) throw new Error(`Unexpected Host output ${file}`)
  } }],
})
if (JSON.stringify(inputs) !== JSON.stringify(await snapshot(path.join(source, 'src')))) throw new Error('Worker sources changed while building')
const implementation = await readFile(path.join(scratch, 'lib/controller-impl.js'), 'utf8')
if (!implementation.includes('sourceModelCatalog')) throw new Error('Source Worker catalog helper was not compiled')
if (spawnSync(process.execPath, ['--check', path.join(scratch, 'lib/controller-impl.js')], { stdio: 'inherit' }).status !== 0) throw new Error('Worker Host syntax failed before publication')
if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Frozen Worker base changed')
const oldWrapper = await readFile(path.join(base, 'packages/worker-session-controller/lib/index.js'), 'utf8')
if (!oldWrapper.includes("from './controller-impl.js'")) throw new Error('Worker wrapper import changed; explicit review required')
const wrapper = oldWrapper + `\n/** Exact read-owner verification, independent of mutable helpers and sandbox policy. */\nconst catalogMethod = Object.getOwnPropertyDescriptor(prototype, 'sourceModelCatalog')?.value;\nexport function ownsSourceCatalogHelper(value) {\n  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== prototype || Object.hasOwn(value, 'constructor') || Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value !== SessionController) return false;\n  return typeof catalogMethod === 'function' && !Object.hasOwn(value, 'sourceModelCatalog')\n    && Object.getOwnPropertyDescriptor(prototype, 'sourceModelCatalog')?.value === catalogMethod;\n}\n`
await cp(base, output, { recursive: true, force: false, errorOnExist: true })
const inner = path.join(output, 'packages/worker-session-controller')
for (const file of ['controller-impl.js', 'controller-impl.js.map']) await cp(path.join(scratch, 'lib', file), path.join(inner, 'lib', file), { force: true })
await writeFile(path.join(inner, 'lib/index.js'), wrapper)
await writeFile(path.join(inner, 'package.json'), json(manifest))
const outer = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'))
outer.version = version
outer.exports = { ...outer.exports, './icon': './icon.svg', './locale/*.json': './locale/*.json' }
outer.files = [...outer.files, 'icon.svg', 'locale', 'README.md', 'worker-stage2-report.json']
await writeFile(path.join(output, 'package.json'), json(outer))
await cp(path.join(here, '../icon.svg'), path.join(output, 'icon.svg'), { force: false })
await mkdir(path.join(output, 'locale'), { recursive: true })
for (const [language, meta] of Object.entries({
  en: { title: 'Native Worker session helper', description: 'Verified native session ownership and bounded provider metadata reads for an explicitly configured Worker.' },
  ru: { title: 'Native helper Worker', description: 'Проверяемое владение native-сеансами и ограниченное чтение моделей для явно настроенного Worker.' },
})) await writeFile(path.join(output, 'locale', language + '.json'), json({ meta }), { flag: 'wx' })
await writeFile(path.join(output, 'README.md'), '# Private native Worker helper\n\nWorker-only extension for DSH 0.2.2-rc.1. The public Remote descriptors, Worker Client, locale and original eight-method mutation attestation are preserved. The additional non-Remote sourceModelCatalog helper has independent exact-owner verification. A bounded catalog budget is optional explicit LOCAL Worker Bridge configuration; no Controller request sets it. No hidden deadline default and no forced readiness exist. Registry changes and owner teardown invalidate reads while uncancellable provider work remains quarantined until native settlement.\n\nUse the public plugin manager in an agreed maintenance window, resolving the Bridge and Worker extension to this exact same helper package instance. Never enable this Worker extension on a Controller-only profile, replace signed DSH files or copy pairing/state files into the bundle. The original project icon and EN/RU display metadata are included. The legacy duplicate controller-impl.mjs is retained only as frozen, unreachable baseline data; index.js loads the freshly source-built controller-impl.js.\n', { flag: 'wx' })
const after = await snapshot(output), changed = []
const allowed = new Set(['package.json', 'README.md', 'icon.svg', 'locale/en.json', 'locale/ru.json',
  'packages/worker-session-controller/package.json', 'packages/worker-session-controller/lib/index.js',
  'packages/worker-session-controller/lib/controller-impl.js', 'packages/worker-session-controller/lib/controller-impl.js.map'])
for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[file] === after[file]) continue
  if (!allowed.has(file)) throw new Error(`Unexpected changed Worker artifact ${file}`)
  changed.push({ file, before: before[file] ?? null, after: after[file] ?? null })
}
if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Frozen Worker base changed before publication')
if (JSON.stringify(inputs) !== JSON.stringify(await snapshot(path.join(source, 'src')))) throw new Error('Worker source changed before publication')
const treeHash = hash(Object.keys(after).sort().map(file => `${file}\0${after[file]}\n`).join(''))
await writeFile(path.join(output, 'worker-stage2-report.json'), json({ version, builtAt: new Date().toISOString(),
  base: 'worker-bundle', baseVersion: '0.1.0', sourceFace: 'src/index.ts', sourceHashes: inputs, changed,
  sourceFence: true, frozenBaseUnchanged: true, publicRemoteAndClientUnchanged: true, mutationAttestationPreserved: true,
  localWorkerActivation: false, treeHashExcludingThisReport: treeHash,
}), { flag: 'wx' })
console.log(`READY ${output}; ${changed.length} approved changes; SHA256 ${treeHash}`)
