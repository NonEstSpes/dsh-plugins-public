/** Publish the next private Worker helper from maintained Host compilation; never install or activate it. */
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../dsh-remote-core')
const images = process.argv.includes('--images')
const version = images ? '0.1.7' : '0.1.6', baseVersion = images ? '0.1.6' : '0.1.5'
const baseName = images ? 'worker-stage5-0.1.6' : 'worker-stage4-0.1.5', outputName = `worker-stage5-${version}`
const reportName = images ? 'worker-images-report.json' : 'worker-stage5-report.json'
const base = path.join(here, baseName), output = path.join(here, outputName), source = path.join(root, 'packages/api/session-controller')
const scratch = path.join(root, '.dsh-build/plugin-native', `worker-stage5-${randomUUID()}`), staged = path.join(scratch, 'payload')
const require = createRequire(path.join(root, 'package.json'))
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href)
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href)
const { standardDecoratorPlugin } = await import(pathToFileURL(path.join(root, 'vitest.shared.ts')).href)
const decorators = standardDecoratorPlugin(), json = value => JSON.stringify(value, null, 2) + '\n'
const hash = value => createHash('sha256').update(value).digest('hex')
const exists = async filename => { try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const allowed = new Set(['package.json', 'README.md', 'packages/worker-session-controller/package.json',
  'packages/worker-session-controller/lib/index.js', 'packages/worker-session-controller/lib/controller-impl.js', 'packages/worker-session-controller/lib/controller-impl.js.map'])
async function snapshot(directory, prefix = '') {
  const files = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name), relative = prefix + entry.name
    if (entry.isSymbolicLink()) throw new Error(`Unexpected artifact link ${relative}`)
    if (entry.isDirectory()) Object.assign(files, await snapshot(filename, relative + '/'))
    else if (entry.isFile()) files[relative] = hash(await readFile(filename))
    else throw new Error(`Unexpected artifact entry ${relative}`)
  }
  return files
}
async function checkJavaScript(directory, files) {
  for (const relative of Object.keys(files).filter(name => /\.(?:mjs|js)$/.test(name))) {
    const filename = path.join(directory, relative), text = await readFile(filename, 'utf8')
    for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(filename), match[1]), key = path.relative(directory, target).split(path.sep).join('/')
      if (match[1].endsWith('controller-impl.mjs') || !target.startsWith(directory + path.sep) || !Object.hasOwn(files, key)) throw new Error(`Unpublished relative import ${relative}`)
    }
    if (spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' }).status !== 0) throw new Error(`Worker syntax failed ${relative}`)
  }
}
if (path.dirname(output) !== here || path.basename(output) !== outputName || await exists(output)) throw new Error('Refusing an existing or unexpected Worker publication path')
const before = await snapshot(base), inputs = await snapshot(path.join(source, 'src'))
const sourceManifest = await readFile(path.join(source, 'package.json')), original = JSON.parse(sourceManifest)
const innerBaseline = JSON.parse(await readFile(path.join(base, 'packages/worker-session-controller/package.json'), 'utf8'))
if (innerBaseline.name !== '@dsh-remote/worker-session-controller' || innerBaseline.version !== baseVersion) throw new Error('Unexpected immutable Worker base')
// Shared SDK dependency identities remain those of the serving Host, never copies bundled from the fork.
const manifest = { ...innerBaseline, version }
await mkdir(scratch, { recursive: true })
await cp(path.join(source, 'src'), path.join(scratch, 'src'), { recursive: true, force: false, errorOnExist: true })
await writeFile(path.join(scratch, 'package.json'), json(manifest), { flag: 'wx' })
await mkdir(path.join(scratch, 'node_modules'), { recursive: true })
for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
  const from = path.join(source, 'node_modules', ...name.split('/'))
  if (!await exists(from)) continue
  const target = path.join(scratch, 'node_modules', ...name.split('/'))
  await mkdir(path.dirname(target), { recursive: true }); await symlink(await realpath(from), target, 'junction')
}
const preset = clientBundle(scratch, ['src/index.ts'], { hostPhase: true, lib: {
  entry: { 'controller-impl': 'src/index.ts' }, target: 'node24', sourcemap: true,
  deps: { neverBundle: specifier => !specifier.startsWith('.') && !path.isAbsolute(specifier) }, outputOptions: { entryFileNames: 'controller-impl.js' },
} })
const config = preset({ env: { DSH_BUILD_FACE: 'host' } }).find(item => item.name === manifest.name)
if (!config) throw new Error('Missing maintained Worker Host face')
await build({ ...config, cwd: scratch, config: false, tsconfig: false, logLevel: 'warn',
  inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) { if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message); handler(level, diagnostic) } },
  plugins: [{ name: decorators.name, transform: { order: 'pre', handler: decorators.transform } }, config.plugins,
    { name: 'worker-stage5-output-only', generateBundle(_options, emitted) {
      for (const filename of Object.keys(emitted)) if (!['controller-impl.js', 'controller-impl.js.map'].includes(filename)) throw new Error(`Unexpected Host output ${filename}`)
    } }],
})
const implementation = await readFile(path.join(scratch, 'lib/controller-impl.js'), 'utf8')
for (const token of ['sourceFollow', 'ownsSourceFollowHelper', 'sourceModelCatalog', 'sourcePrepareProject', 'sourceRegisterProject', 'ownsSourceProjectHelpers', 'sourceFiles', 'ownsSourceFilesHelper', ...(images ? ['imagesAvailable', 'uploadImageStream', 'readImage'] : [])]) {
  if (!implementation.includes(token)) throw new Error(`Missing compiled Worker helper ${token}`)
}
await cp(base, staged, { recursive: true, force: false, errorOnExist: true })
const inner = path.join(staged, 'packages/worker-session-controller')
for (const name of ['controller-impl.js', 'controller-impl.js.map']) await cp(path.join(scratch, 'lib', name), path.join(inner, 'lib', name), { force: true })
const prefix = await readFile(path.join(base, 'packages/worker-session-controller/lib/index.js'), 'utf8')
if (!prefix.includes('export function ownsSourceProjectHelpers(value)') || (images && !prefix.includes('export function ownsSourceFilesHelper(value)'))) throw new Error('Unexpected predecessor wrapper')
const wrapper = images ? prefix : prefix + `\n/** Native file capability remains separately constructor-owned. */
const sourceFilesCheck = Object.getOwnPropertyDescriptor(SessionController, 'ownsSourceFilesHelper')?.value;
export function ownsSourceFilesHelper(value) {
  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== prototype || Object.hasOwn(value, 'constructor') || Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value !== SessionController) return false;
  const own = Object.getOwnPropertyDescriptor(value, 'sourceFiles');
  return typeof sourceFilesCheck === 'function' && own !== undefined && 'value' in own
    && Object.getOwnPropertyDescriptor(SessionController, 'ownsSourceFilesHelper')?.value === sourceFilesCheck
    && sourceFilesCheck(value) === true;
}
`
await writeFile(path.join(inner, 'lib/index.js'), wrapper)
await writeFile(path.join(inner, 'package.json'), json(manifest))
const outer = JSON.parse(await readFile(path.join(staged, 'package.json'), 'utf8'))
outer.version = version; outer.files = [...new Set([...outer.files, reportName])]
await writeFile(path.join(staged, 'package.json'), json(outer))
await writeFile(path.join(staged, 'README.md'), `# Private native Worker helper\n\nWorker${version} preserves the predecessor public Remote/Client/locale faces and every prior attestation prefix. Its constructor-owned file capability uses the serving Host SDK and keeps legacy guarded prompts text-only.${images ? ' The separately negotiated native image extension uses SDK normalization, image admission and verified image bytes.' : ''} The federation caller must enforce pair, Session, policy and transfer ownership before every operation. This artifact alone does not enable a files permission, install a Bridge, stage private credentials or activate a Worker.\n\nUse the serving Host canonical SDK module graph; never replace signed files or overwrite an immutable predecessor. Native attachment admission and source publication are distinct: a stored object does not imply an accepted prompt.\n`)
const after = await snapshot(staged), changed = []
for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[name] === after[name]) continue
  if (!allowed.has(name) || !Object.hasOwn(after, name)) throw new Error(`Unreviewed Worker change ${name}`)
  changed.push({ file: name, before: before[name] ?? null, after: after[name] ?? null })
}
await checkJavaScript(staged, after)
if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Frozen Stage4 base changed before publication')
if (JSON.stringify(inputs) !== JSON.stringify(await snapshot(path.join(source, 'src'))) || hash(sourceManifest) !== hash(await readFile(path.join(source, 'package.json')))) throw new Error('Worker source changed before publication')
const treeHash = hash(Object.keys(after).sort().map(name => `${name}\0${after[name]}\n`).join(''))
await writeFile(path.join(staged, reportName), json({ version, builtAt: new Date().toISOString(), base: baseName, baseVersion, sourceFace: 'src/index.ts',
  sourceHashes: inputs, sourceManifestHash: hash(sourceManifest), changed, sourceFence: true, frozenBaseUnchanged: true, publicRemoteClientLocaleUnchanged: true,
  priorAttestationsPreserved: true, independentPrivateFilesAttestation: true, nativeImages: images, syntaxCheckedBeforePublication: true, localWorkerActivation: false, treeHashExcludingThisReport: treeHash,
}), { flag: 'wx' })
const checked = await snapshot(staged)
await mkdir(output)
for (const entry of await readdir(staged, { withFileTypes: true })) await cp(path.join(staged, entry.name), path.join(output, entry.name), { recursive: true, force: false, errorOnExist: true })
if (JSON.stringify(checked) !== JSON.stringify(await snapshot(output))) throw new Error('Published Worker differs from checked staging')
console.log(`READY ${outputName}; ${changed.length} approved changes; SHA256 ${treeHash}; no installation or activation`)
