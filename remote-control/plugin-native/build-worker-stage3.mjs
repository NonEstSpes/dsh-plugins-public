/** Build a fresh immutable Worker0.1.4 with the maintained Host pipeline; never installs or rewrites a predecessor. */
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../dsh-remote-core')
const version = '0.1.4', baseName = 'worker-stage2-0.1.2', outputName = 'worker-stage3-0.1.4'
const base = path.join(here, baseName), output = path.join(here, outputName)
const source = path.join(root, 'packages/api/session-controller')
const scratch = path.join(root, '.dsh-build/plugin-native', `worker-stage3-${randomUUID()}`), staged = path.join(scratch, 'payload')
const require = createRequire(path.join(root, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href)
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href)
const { standardDecoratorPlugin } = await import(pathToFileURL(path.join(root, 'vitest.shared.ts')).href)
const decorators = standardDecoratorPlugin()
const json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const exists = async filename => { try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const allowed = new Set(['package.json', 'README.md', 'packages/worker-session-controller/package.json',
  'packages/worker-session-controller/lib/index.js', 'packages/worker-session-controller/lib/controller-impl.js',
  'packages/worker-session-controller/lib/controller-impl.js.map'])
async function snapshot(directory, prefix = '') {
  const result = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name), relative = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error(`Unexpected artifact link ${relative}`)
    if (entry.isDirectory()) Object.assign(result, await snapshot(filename, relative + '/'))
    else if (entry.isFile()) result[relative] = hash(await readFile(filename))
    else throw new Error(`Unexpected artifact entry ${relative}`)
  }
  return result
}
async function checkJavaScript(directory, files) {
  for (const relative of Object.keys(files).filter(name => /\.(?:mjs|js)$/.test(name))) {
    const filename = path.join(directory, relative), text = await readFile(filename, 'utf8')
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(filename), match[1]), key = path.relative(directory, target).split(path.sep).join('/')
      if (match[1].endsWith('controller-impl.mjs') || !target.startsWith(directory + path.sep) || !Object.hasOwn(files, key)) {
        throw new Error(`Unpublished or stale relative import ${relative} -> ${match[1]}`)
      }
    }
    if (spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' }).status !== 0) throw new Error(`Worker syntax failed ${relative}`)
  }
}
if (path.dirname(output) !== here || path.basename(output) !== outputName) throw new Error('Unexpected Worker publication path')
if (await exists(output)) throw new Error(`Refusing to overwrite immutable ${outputName}`)
const before = await snapshot(base), inputs = await snapshot(path.join(source, 'src'))
const sourceManifestBytes = await readFile(path.join(source, 'package.json')), original = JSON.parse(sourceManifestBytes)
const innerBaseline = JSON.parse(await readFile(path.join(base, 'packages/worker-session-controller/package.json'), 'utf8'))
if (innerBaseline.name !== '@dsh-remote/worker-session-controller' || innerBaseline.version !== '0.1.2') throw new Error('Unexpected immutable Worker base')
const manifest = { ...innerBaseline, version }
await mkdir(scratch, { recursive: true })
await cp(path.join(source, 'src'), path.join(scratch, 'src'), { recursive: true, force: false, errorOnExist: true })
await writeFile(path.join(scratch, 'package.json'), json(manifest), { flag: 'wx' })
await mkdir(path.join(scratch, 'node_modules'), { recursive: true })
for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
  const from = path.join(source, 'node_modules', ...name.split('/'))
  if (!await exists(from)) continue
  const target = path.join(scratch, 'node_modules', ...name.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await symlink(await realpath(from), target, 'junction')
}
const preset = clientBundle(scratch, ['src/index.ts'], { hostPhase: true, lib: {
  entry: { 'controller-impl': 'src/index.ts' }, target: 'node24', sourcemap: true,
  deps: { neverBundle: specifier => !specifier.startsWith('.') && !path.isAbsolute(specifier) },
  outputOptions: { entryFileNames: 'controller-impl.js' },
} })
const config = preset({ env: { DSH_BUILD_FACE: 'host' } }).find(item => item.name === manifest.name)
if (!config) throw new Error('Missing maintained Worker Host face')
await build({ ...config, cwd: scratch, config: false, tsconfig: false, logLevel: 'warn',
  inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) {
    if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message)
    handler(level, diagnostic)
  } },
  plugins: [{ name: decorators.name, transform: { order: 'pre', handler: decorators.transform } }, config.plugins,
    { name: 'worker-stage3-output-only', generateBundle(_options, emitted) {
      for (const filename of Object.keys(emitted)) if (!['controller-impl.js', 'controller-impl.js.map'].includes(filename)) throw new Error(`Unexpected Host output ${filename}`)
    } }],
})
const implementation = await readFile(path.join(scratch, 'lib/controller-impl.js'), 'utf8')
for (const name of ['sourceModelCatalog', 'sourceFollow', 'ownsSourceFollowHelper']) {
  if (!implementation.includes(name)) throw new Error(`Missing compiled Worker helper ${name}`)
}
await cp(base, staged, { recursive: true, force: false, errorOnExist: true })
const inner = path.join(staged, 'packages/worker-session-controller')
for (const filename of ['controller-impl.js', 'controller-impl.js.map']) await cp(path.join(scratch, 'lib', filename), path.join(inner, 'lib', filename), { force: true })
const oldWrapper = await readFile(path.join(base, 'packages/worker-session-controller/lib/index.js'), 'utf8')
if (!oldWrapper.includes('export function ownsSourceCatalogHelper(value)') || !oldWrapper.includes("from './controller-impl.js'")) throw new Error('Unexpected Stage2 wrapper')
const wrapper = oldWrapper + `\n/** Independent instance-private follow ownership; no prototype or function-name substitutes. */
const sourceFollowCheck = Object.getOwnPropertyDescriptor(SessionController, 'ownsSourceFollowHelper')?.value;
export function ownsSourceFollowHelper(value) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== prototype || Object.hasOwn(value, 'constructor') || Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value !== SessionController) return false;
  const own = Object.getOwnPropertyDescriptor(value, 'sourceFollow');
  return typeof sourceFollowCheck === 'function' && typeof own?.value === 'function'
    && Object.getOwnPropertyDescriptor(SessionController, 'ownsSourceFollowHelper')?.value === sourceFollowCheck
    && sourceFollowCheck(value) === true;
}
`
await writeFile(path.join(inner, 'lib/index.js'), wrapper)
await writeFile(path.join(inner, 'package.json'), json(manifest))
const outer = JSON.parse(await readFile(path.join(staged, 'package.json'), 'utf8'))
outer.version = version
outer.files = [...new Set([...outer.files, 'worker-stage3-report.json'])]
await writeFile(path.join(staged, 'package.json'), json(outer))
await writeFile(path.join(staged, 'README.md'), '# Private native Worker helper\n\nWorker0.1.4 preserves the Stage2 public Remote descriptors, Client, locale, original eight-method mutation attestation and independent model-catalog attestation. Its additional NON-Remote sourceFollow helper is a constructor-owned private-brand function with separately captured static exact-owner verification. The native producer supplies explicit protocol item/byte budgets and never activates an Agent for following. This package does not advertise or install a Bridge feature and does not activate a Worker.\n\nThe native SDK must be the same physical module graph as the serving Host. Do not replace signed files, overwrite a frozen predecessor, or copy pairing/profile state into this payload. The unreachable predecessor controller-impl.mjs remains byte-identical baseline data; index.js loads the maintained source-built controller-impl.js.\n')
const after = await snapshot(staged), changed = []
for (const relative of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[relative] === after[relative]) continue
  if (!allowed.has(relative) || !Object.hasOwn(after, relative)) throw new Error(`Unexpected changed Worker artifact ${relative}`)
  changed.push({ file: relative, before: before[relative] ?? null, after: after[relative] ?? null })
}
await checkJavaScript(staged, after)
if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Frozen Stage2 changed before publication')
if (JSON.stringify(inputs) !== JSON.stringify(await snapshot(path.join(source, 'src')))
  || hash(sourceManifestBytes) !== hash(await readFile(path.join(source, 'package.json')))) throw new Error('Worker source changed before publication')
const treeHash = hash(Object.keys(after).sort().map(filename => `${filename}\0${after[filename]}\n`).join(''))
await writeFile(path.join(staged, 'worker-stage3-report.json'), json({ version, builtAt: new Date().toISOString(), base: baseName, baseVersion: '0.1.2',
  sourceFace: 'src/index.ts', sourceHashes: inputs, sourceManifestHash: hash(sourceManifestBytes), changed,
  sourceFence: true, frozenBaseUnchanged: true, publicRemoteClientLocaleUnchanged: true, mutationAndCatalogAttestationsPreserved: true,
  independentPrivateFollowAttestation: true, syntaxCheckedBeforePublication: true, localWorkerActivation: false,
  treeHashExcludingThisReport: treeHash,
}), { flag: 'wx' })
const stagedFiles = await snapshot(staged)
// Exclusive claim precedes copying only a fully checked candidate; a failed publication is never overwritten on retry.
await mkdir(output)
for (const entry of await readdir(staged, { withFileTypes: true })) {
  await cp(path.join(staged, entry.name), path.join(output, entry.name), { recursive: true, force: false, errorOnExist: true })
}
if (JSON.stringify(stagedFiles) !== JSON.stringify(await snapshot(output))) throw new Error('Published Worker tree differs from its checked staging tree')
console.log(`READY ${outputName}; ${changed.length} approved changes; SHA256 ${treeHash}; no installation or activation`)
