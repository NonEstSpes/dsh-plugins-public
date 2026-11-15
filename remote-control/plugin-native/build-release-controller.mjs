/** Build current Controller sources into a new immutable payload; never install or activate a Worker. */
import { cp, lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { allowed, baseName, hash, here, outputName, reportName, root, snapshot, targets, treeHash, verifyController, version } from './verify-release-controller.mjs'
const require = createRequire(path.join(root, 'package.json')), json = value => JSON.stringify(value, null, 2) + '\n'
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href)
const presetPath = path.join(root, 'packages/client/tsdown.client.ts'), decoratorPath = path.join(root, 'vitest.shared.ts')
const { clientBundle } = await import(pathToFileURL(presetPath).href), { standardDecoratorPlugin } = await import(pathToFileURL(decoratorPath).href)
const decorators = standardDecoratorPlugin(), base = path.join(here, baseName), output = path.join(here, outputName)
const scratch = path.join(root, '.dsh-build/plugin-native', `controller-release-${randomUUID()}`), staged = path.join(scratch, 'payload')
const exists = async filename => { try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
const readJSON = async filename => JSON.parse(await readFile(filename, 'utf8'))
const write = async (filename, data) => { await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, data) }
const sourceInputs = async source => ({ src: await snapshot(path.join(source, 'src')), manifest: hash(await readFile(path.join(source, 'package.json'))),
  locale: await exists(path.join(source, 'locale')) ? await snapshot(path.join(source, 'locale')) : {} })
if (path.dirname(output) !== here || path.basename(output) !== outputName || await exists(output)) throw new Error('Refusing an existing or unexpected Controller publication path')
const before = await snapshot(base), outer = await readJSON(path.join(base, 'package.json'))
if (outer.name !== '@dsh-remote/native-session-bundle' || outer.version !== '0.1.6') throw new Error('Unexpected immutable Controller predecessor')
const evidence = await readJSON(path.join(base, 'build-report.json'))
const aliases = new Map(evidence.providers.filter(row => row.kind !== 'worker').map(row => [row.original, row.name]))
aliases.set('@deepseek-ai/dsh-client-file-upload', '@dsh-remote/file-upload')
const webPatchFile = path.join(root, 'packages/bundle/web-app/cordis.patch.yml'), webPatch = await readFile(webPatchFile, 'utf8')
if (!/id:\s*file-upload\s*\n\s*name:\s*['"]@deepseek-ai\/dsh-client-file-upload['"]/.test(webPatch)) throw new Error('The original file-upload Loader row changed')
const iconFile = path.resolve(here, '../icon.svg'), icon = await readFile(iconFile)
const frameworkInputs = { preset: hash(await readFile(presetPath)), decorators: hash(await readFile(decoratorPath)), webPatch: hash(webPatch), icon: hash(icon) }
const inputs = {}, generated = {}, rebuilt = []
await mkdir(scratch, { recursive: true }); await cp(base, staged, { recursive: true, force: false, errorOnExist: true })
for (const target of targets) {
  const source = path.join(root, 'packages', target.source), stage = path.join(scratch, target.id), destination = path.join(staged, 'packages', target.id)
  const original = await readJSON(path.join(source, 'package.json')), isSource = target.id === 'session-source-controller', isNew = target.id === 'file-upload'
  inputs[target.id] = await sourceInputs(source)
  const manifest = isNew ? { name: target.name, private: true, type: 'module', description: 'Private browser uploads with the original SDK Host provider',
    engines: { node: '>=24.9', dsh: original.version }, exports: { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json', './locale/*.json': './locale/*.json' },
    files: ['lib', 'locale'], peerDependencies: { [original.name]: original.version } } : await readJSON(path.join(base, 'packages', target.id, 'package.json'))
  manifest.version = version
  manifest.dsh = { client: { ...original.dsh.client, inject: (original.dsh.client.inject ?? []).map(name => aliases.get(name) ?? name) } }
  if (isSource) for (const [name, spec] of Object.entries({ ...original.dependencies, ...original.peerDependencies })) {
    manifest.peerDependencies[name] = spec.startsWith('workspace:') ? (await readJSON(path.join(source, 'node_modules', ...name.split('/'), 'package.json'))).version : spec
  }
  await mkdir(stage, { recursive: true }); await cp(path.join(source, 'src'), path.join(stage, 'src'), { recursive: true, force: false, errorOnExist: true })
  if (await exists(path.join(source, 'locale'))) await cp(path.join(source, 'locale'), path.join(stage, 'locale'), { recursive: true })
  await write(path.join(stage, 'package.json'), json(manifest)); await mkdir(path.join(stage, 'node_modules'), { recursive: true })
  for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
    const from = path.join(source, 'node_modules', ...name.split('/'))
    if (!await exists(from)) continue
    const to = path.join(stage, 'node_modules', ...name.split('/')); await mkdir(path.dirname(to), { recursive: true }); await symlink(await realpath(from), to, 'junction')
  }
  if (isSource) {
    generated[target.id] = {}
    for (const file of ['typert.host.js', 'typert.remote-client.js']) {
      const text = await readFile(path.join(source, 'lib', file)); generated[target.id][file] = hash(text)
      await write(path.join(stage, 'lib', file === 'typert.host.js' ? 'typert.base.js' : file), text)
    }
    if (await exists(path.join(stage, 'src/client/adapter-entry.ts'))) throw new Error('Source bootstrap staging name already exists')
    await cp(path.join(stage, 'src/client/index.ts'), path.join(stage, 'src/client/adapter-entry.ts'))
    await write(path.join(stage, 'src/client/index.ts'), `/** Own generated namespace precedes the source adapter. */\nimport * as adapter from './adapter-entry.ts';\nimport contribution from '../../lib/typert.remote-client.js';\nexport const inject = ['remote'];\nexport async function apply(ctx) {\n  await ctx.remote.$mount({ package: ${JSON.stringify(target.name)}, descriptors: contribution.descriptors.map(descriptor => ({ ...descriptor, id: ${JSON.stringify(target.name)} + '#' + descriptor.namespace + '/' + descriptor.method })) });\n  await ctx.plugin(adapter).await();\n}\n`)
  }
  const run = async (config, host = false) => {
    if (!config) throw new Error(`Missing maintained build face ${target.id}`)
    console.log(`BUILD ${target.name}/${host ? 'host' : 'client'} from src/index.ts`)
    await build({ ...config, cwd: stage, config: false, tsconfig: false, logLevel: 'warn',
      inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) { if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message); handler(level, diagnostic) } },
      plugins: [...(host ? [{ name: decorators.name, transform: { order: 'pre', handler: decorators.transform } }] : []), config.plugins] })
  }
  await run(clientBundle(stage, ['src/index.ts'])({ env: {} }).find(config => config.name === `${target.name}/client`))
  if (isSource) {
    await run(clientBundle(stage, ['src/index.ts'], { hostPhase: true, lib: { entry: { index: 'src/index.ts' }, target: 'node24', sourcemap: true,
      deps: { neverBundle: specifier => !specifier.startsWith('.') && !path.isAbsolute(specifier) }, outputOptions: { entryFileNames: 'index.js' } } })({ env: { DSH_BUILD_FACE: 'host' } }).find(config => config.name === target.name), true)
    await write(path.join(stage, 'lib/typert.host.js'), `/** Own reflection ids preserve generated codec and factory identities. */\nimport { TYPERT as base } from './typert.base.js';\nexport const TYPERT = { ...base, package: ${JSON.stringify(target.name)}, invocations: base.invocations.map(descriptor => ({ ...descriptor, id: ${JSON.stringify(target.name)} + '#' + descriptor.namespace + '/' + descriptor.method })) };\n`)
  } else if (isNew) await write(path.join(stage, 'lib/index.js'), `/** Reuse the installed native SDK constructor; only the browser provider is private. */\nimport * as stock from ${JSON.stringify(original.name)};\nexport * from ${JSON.stringify(original.name)};\nconst provider = stock.default ?? stock;\nexport const name = ${JSON.stringify(target.name)};\nexport const inject = provider.inject ?? [];\nexport const Config = provider.Config;\nexport function apply(ctx, config) { ctx.plugin(provider, config); }\n`)
  const emitted = await snapshot(path.join(stage, 'lib'))
  for (const relative of Object.keys(emitted)) {
    const published = `packages/${target.id}/lib/${relative}`
    if (!allowed(published)) throw new Error(`Unexpected compiled output ${published}`)
    await write(path.join(staged, published), await readFile(path.join(stage, 'lib', relative)))
  }
  if (await exists(path.join(stage, 'locale'))) await cp(path.join(stage, 'locale'), path.join(destination, 'locale'), { recursive: true })
  await write(path.join(destination, 'package.json'), json(manifest))
  rebuilt.push({ ...target, original: original.name, sourceFace: 'src/index.ts', clientEntry: 'src/client/index.ts', host: isSource ? 'source/decorators' : 'original SDK provider' })
}
const patch = await readJSON(path.join(base, 'cordis.patch.yml'))
if (patch.some(row => row.id === 'file-upload') || patch.flatMap(row => row.insert ?? []).some(row => row.id === 'remote-native-file-upload')) throw new Error('Predecessor already replaces file-upload')
patch.push({ id: 'file-upload', name: '@deepseek-ai/dsh-client-file-upload', disabled: true }, { insert: [{ id: 'remote-native-file-upload', name: '@dsh-remote/file-upload' }] })
await write(path.join(staged, 'cordis.patch.yml'), json(patch))
outer.version = version; outer.description = 'Remote native sessions with scoped projects, native history, models, files and images'
outer.dependencies['@dsh-remote/file-upload'] = 'file:./packages/file-upload'
outer.exports = { ...outer.exports, './icon': './icon.svg', './locale/*.json': './locale/*.json' }
outer.files = [...new Set([...outer.files, 'icon.svg', 'locale', reportName])]
await write(path.join(staged, 'package.json'), json(outer)); await write(path.join(staged, 'icon.svg'), icon)
await write(path.join(staged, 'locale/en.json'), json({ meta: { title: 'Remote native sessions', description: 'Native remote projects, session history, model selection, files and images in the ordinary session interface.' } }))
await write(path.join(staged, 'locale/ru.json'), json({ meta: { title: 'Удалённые native-сессии', description: 'Удалённые native-проекты, история сессий, выбор модели, файлы и изображения в обычном интерфейсе сессии.' } }))
const after = await snapshot(staged), changed = []
for (const name of Object.keys({ ...before, ...after })) if (before[name] !== after[name]) {
  if (!allowed(name) || !Object.hasOwn(after, name)) throw new Error(`Unapproved changed Controller artifact ${name}`)
  changed.push({ file: name, before: before[name] ?? null, after: after[name] })
}
const fence = async () => {
  if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Immutable Controller predecessor changed')
  for (const target of targets) {
    const source = path.join(root, 'packages', target.source)
    if (JSON.stringify(inputs[target.id]) !== JSON.stringify(await sourceInputs(source))) throw new Error(`Source changed during Controller publication ${target.id}`)
    for (const [name, digest] of Object.entries(generated[target.id] ?? {})) if (hash(await readFile(path.join(source, 'lib', name))) !== digest) throw new Error(`Generated Source RPC changed ${name}`)
  }
  if (hash(await readFile(presetPath)) !== frameworkInputs.preset || hash(await readFile(decoratorPath)) !== frameworkInputs.decorators || hash(await readFile(webPatchFile)) !== frameworkInputs.webPatch || hash(await readFile(iconFile)) !== frameworkInputs.icon) throw new Error('Controller framework/display input changed')
}
await fence()
await writeFile(path.join(staged, reportName), json({ version, builtAt: new Date().toISOString(), base: baseName, baseVersion: '0.1.6', baseTreeHash: treeHash(before),
  sourcePackages: rebuilt, sourceHashes: inputs, generatedHashes: generated, frameworkInputs, node: process.version, sdkVersion: outer.engines.dsh,
  changed, treeHashExcludingThisReport: treeHash(after), sourceFence: true, frozenBaseUnchanged: true, originalHostIdentitiesPreserved: true,
  stockFileUploadRowVerified: true, display: { en: 'Remote native sessions', ru: 'Удалённые native-сессии', iconSource: 'remote-control/icon.svg', originalPrivateArtwork: true },
  workerActivated: false, installed: false }), { flag: 'wx' })
const checked = await verifyController(staged); await fence(); await mkdir(output)
for (const entry of await readdir(staged, { withFileTypes: true })) await cp(path.join(staged, entry.name), path.join(output, entry.name), { recursive: true, force: false, errorOnExist: true })
if (JSON.stringify(checked) !== JSON.stringify(await snapshot(output))) throw new Error('Published Controller differs from checked staging')
console.log(`READY ${outputName}; ${changed.length} approved changed artifacts; SHA256 ${treeHash(after)}; no installation or Worker activation`)
