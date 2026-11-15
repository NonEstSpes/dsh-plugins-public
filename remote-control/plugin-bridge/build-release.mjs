/** Publish the current closed Node bridge, preserving SDK identities and all private state outside the artifact. */
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { builtinModules, createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.dirname(here), version = '0.1.5'
const output = path.join(here, `bundle-release-${version}`), scratch = path.join(root, '.build', `bridge-release-${randomUUID()}`), stage = path.join(scratch, 'payload')
const base = path.join(here, 'bundle-stage2-0.1.4'), reportName = 'bridge-release-report.json'
const ts = createRequire(path.resolve(root, '../dsh-remote-core/package.json'))('typescript')
const hash = value => createHash('sha256').update(value).digest('hex'), json = value => JSON.stringify(value, null, 2) + '\n'
const exists = async filename => { try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function snapshot(directory, prefix = '') {
  const result = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) throw new Error('Publication inputs contain a link')
    const filename = path.join(directory, entry.name), relative = prefix + entry.name
    if (entry.isDirectory()) Object.assign(result, await snapshot(filename, relative + '/'))
    else if (entry.isFile()) result[relative] = hash(await readFile(filename))
    else throw new Error('Publication inputs contain a non-file')
  }
  return result
}
const treeHash = files => hash(Object.keys(files).sort().map(name => `${name}\0${files[name]}\n`).join(''))
async function verify(directory) {
  const files = await snapshot(directory), manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  if (manifest.name !== '@dsh-remote/control-bridge' || manifest.version !== version || manifest.engines.dsh !== '0.2.2-rc.1'
    || manifest.engines.node !== '>=24.9' || manifest.peerDependencies['@dsh-remote/worker-session-controller'] !== '0.1.7'
    || manifest.dependencies.ws !== '8.21.3' || manifest.exports['./client'] || manifest.dsh.client) throw new Error('Unexpected bridge publication identity or dependency')
  const declarations = new Set([...Object.keys(manifest.dependencies), ...Object.keys(manifest.peerDependencies)])
  const native = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))
  for (const relative of Object.keys(files)) {
    if (!/^(?:lib\/.+\.mjs|index\.js|icon\.svg|locale\/(?:en|ru)\.json|(?:README|FEDERATION-V2|TRANSPORT|UPGRADE)\.md|(?:package|build-report|bridge-release-report)\.json|cordis\.patch\.yml)$/.test(relative)) throw new Error(`Unexpected bridge file ${relative}`)
    if (!/\.(?:js|mjs)$/.test(relative)) continue
    const filename = path.join(directory, relative), text = await readFile(filename, 'utf8')
    if (spawnSync(process.execPath, ['--check', filename], { stdio: 'inherit' }).status !== 0) throw new Error(`Bridge syntax failed ${relative}`)
    const specifiers = [], ast = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const visit = node => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifiers.push(node.moduleSpecifier.text)
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) specifiers.push(node.arguments[0].text)
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(filename), specifier), key = path.relative(directory, target).split(path.sep).join('/')
        if (!target.startsWith(directory + path.sep) || !Object.hasOwn(files, key)) throw new Error(`Unpublished bridge import ${relative}`)
      } else {
        const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]
        if (!native.has(specifier) && !declarations.has(name)) throw new Error(`Undeclared bridge runtime module ${specifier}`)
      }
    }
  }
  for (const language of ['en', 'ru']) {
    const locale = JSON.parse(await readFile(path.join(directory, 'locale', language + '.json'), 'utf8'))
    if (!locale.meta?.title || !locale.meta.description) throw new Error('Missing localized bridge display metadata')
  }
  if (files['icon.svg'] !== hash(await readFile(path.join(root, 'icon.svg')))) throw new Error('Original bridge icon changed')
  const patch = JSON.parse(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8'))
  if (JSON.stringify(patch).includes('worker-session-controller') || !patch.some(row => row.id === 'remote-control' && row.disabled === true)) throw new Error('Bridge patch changes Worker activation')
  const report = JSON.parse(await readFile(path.join(directory, reportName), 'utf8')), payload = { ...files }; delete payload[reportName]
  if (report.packageVersion !== version || report.treeHashExcludingThisReport !== treeHash(payload) || report.installed !== false || report.workerActivated !== false) throw new Error('Bridge publication report mismatch')
  return files
}
if (process.argv.includes('--verify')) {
  const files = await verify(output)
  console.log(`VERIFIED bridge${version}; ${Object.keys(files).length} closed files; no Worker activation`)
} else {
  if (path.dirname(output) !== here || await exists(output)) throw new Error('Refusing an existing bridge publication')
  const baseFiles = await snapshot(base), sourceFiles = await snapshot(path.join(root, 'lib'))
  const docs = ['FEDERATION-V2.md', 'TRANSPORT.md', 'UPGRADE.md'], inputs = {}
  for (const name of ['index.js', 'package.json', 'icon.svg', ...docs]) inputs[name] = hash(await readFile(path.join(root, name)))
  const generatorHash = hash(await readFile(path.join(here, 'build.mjs')))
  await mkdir(scratch, { recursive: true })
  if (spawnSync(process.execPath, [path.join(here, 'build.mjs'), '--out', stage, '--version', version], { stdio: 'inherit', cwd: root }).status !== 0) throw new Error('Maintained bridge bootstrap builder failed')
  for (const relative of Object.keys(sourceFiles).filter(name => name.endsWith('.mjs'))) {
    const destination = path.join(stage, 'lib', relative); await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, await readFile(path.join(root, 'lib', relative)))
  }
  const manifest = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'))
  manifest.engines.node = '>=24.9'; manifest.peerDependencies['@dsh-remote/worker-session-controller'] = '0.1.7'
  manifest.files = [...new Set([...manifest.files, 'TRANSPORT.md', 'UPGRADE.md', reportName])]
  await writeFile(path.join(stage, 'package.json'), json(manifest))
  await writeFile(path.join(stage, 'locale/en.json'), json({ meta: { title: 'Native remote session bridge', description: 'Encrypted Controller–Worker pairing, native live state, projects, file/image receipts and outbound WSS with HTTPS fallback.' } }))
  await writeFile(path.join(stage, 'locale/ru.json'), json({ meta: { title: 'Шлюз удалённых native-сессий', description: 'Шифрованная связь Controller–Worker, native live-состояние, проекты, файлы и изображения, исходящий WSS с HTTPS fallback.' } }))
  for (const name of docs) await writeFile(path.join(stage, name), await readFile(path.join(root, name)))
  await writeFile(path.join(stage, 'README.md'), '# Native remote session bridge\n\nHost-only Controller/Worker pairing with exact native SDK ownership, live history and statistics, machine-scoped project registration, native file/image receipts and verified attachment reads. This package has no browser factory and does not activate a Worker. The separate Controller Client bundle owns presentation.\n\nSelect an explicit absolute role-local settingsFile; no private path or credential is inferred or included. Controller source registrations are effect-owned and close before replacement. The Worker helper is the separately installed exact0.1.7 SDK provider; all serving Host SDK identities remain shared.\n\nOutbound relayTransport defaults to the existing HTTPS carrier. Explicit auto plus requestTimeoutMs and relaySocketConnectTimeoutMs negotiates same-origin WSS and falls back to HTTPS only before a socket request is published. Published durable envelopes retain their original identities. Terminal endpoint state v2 uses authenticated compact receipts; read [UPGRADE](UPGRADE.md) before downgrading. Native Session data formats are unchanged.\n\nUploads require an already live native Agent; cold activation and draft attachment downloads are not supported. Physical Worker/WAN/TLS/power-loss acceptance is not established by local loopback checks. See [TRANSPORT](TRANSPORT.md) and [federation notes](FEDERATION-V2.md).\n')
  const payload = await snapshot(stage)
  await writeFile(path.join(stage, reportName), json({ packageVersion: version, builtAt: new Date().toISOString(), base: 'bundle-stage2-0.1.4',
    baseTreeHash: treeHash(baseFiles), sourceLibraryHashes: sourceFiles, sourceInputs: inputs, generatorHash,
    runtimeLibraryFiles: Object.keys(sourceFiles).filter(name => name.endsWith('.mjs')), sourceFence: true,
    sdkHelperVersion: '0.1.7', endpointStateVersion: 2, webSocketDependency: '8.21.3', installed: false, workerActivated: false,
    treeHashExcludingThisReport: treeHash(payload) }), { flag: 'wx' })
  const checked = await verify(stage)
  if (JSON.stringify(sourceFiles) !== JSON.stringify(await snapshot(path.join(root, 'lib'))) || JSON.stringify(baseFiles) !== JSON.stringify(await snapshot(base))) throw new Error('Bridge source or immutable base changed')
  for (const [name, digest] of Object.entries(inputs)) if (hash(await readFile(path.join(root, name))) !== digest) throw new Error('Bridge input changed')
  if (hash(await readFile(path.join(here, 'build.mjs'))) !== generatorHash) throw new Error('Bridge bootstrap generator changed')
  await mkdir(output)
  for (const entry of await readdir(stage, { withFileTypes: true })) await cp(path.join(stage, entry.name), path.join(output, entry.name), { recursive: true, force: false, errorOnExist: true })
  if (JSON.stringify(checked) !== JSON.stringify(await snapshot(output))) throw new Error('Published bridge differs from checked staging')
  console.log(`READY bridge${version}; ${Object.keys(checked).length} closed files; SHA256 ${treeHash(payload)}; no install or Worker activation`)
}
