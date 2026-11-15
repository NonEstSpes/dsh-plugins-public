/** Assemble only checked published providers into an inert, installable remote Worker bundle. */
import { cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url)), source = path.resolve(here, '..'), output = path.join(here, 'worker-release-0.1.7')
const staged = path.join(here, `.worker-stage-${randomUUID()}`), hash = value => createHash('sha256').update(value).digest('hex'), json = value => JSON.stringify(value, null, 2) + '\n'
const exists = async file => { try { await lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function snapshot(directory, prefix = '') {
  const files = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, file = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Portable input contains a symbolic link')
    if (entry.isDirectory()) Object.assign(files, await snapshot(file, name + '/'))
    else if (entry.isFile()) files[name] = hash(await readFile(file))
    else throw new Error('Portable input contains a non-file entry')
  }
  return files
}
const treeHash = files => hash(Object.keys(files).sort().map(name => `${name}\0${files[name]}\n`).join(''))
async function checkedInput(relative, reportName, expected) {
  const directory = path.join(source, relative), files = await snapshot(directory), report = JSON.parse(await readFile(path.join(directory, reportName), 'utf8'))
  const payload = { ...files }; delete payload[reportName]
  if (treeHash(payload) !== expected || report.treeHashExcludingThisReport !== expected) throw new Error('Immutable portable input failed its exact artifact receipt')
  return { relative, directory, files, expected }
}
if (path.dirname(output) !== here || path.basename(output) !== 'worker-release-0.1.7' || await exists(output)) throw new Error('Refusing existing or unexpected portable publication')
const sdk = await checkedInput('plugin-native/worker-stage5-0.1.7', 'worker-images-report.json', '420c5fb900045ec609d4c7b528980c9c39cd921c5def977fbc50739d8224171a')
const bridge = await checkedInput('plugin-bridge/bundle-release-0.1.5', 'bridge-release-report.json', 'b164522a89f610f64dcf45078c2e057b05fa39617267c33d4d8e5737bbdfc37d')
const sdkPatch = JSON.parse(await readFile(path.join(sdk.directory, 'cordis.patch.yml'), 'utf8'))
if (JSON.stringify(sdkPatch) !== JSON.stringify([{ id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller', disabled: true },
  { insert: [{ id: 'remote-worker-session-controller', name: '@dsh-remote/worker-session-controller' }] }])) throw new Error('Immutable Worker stock replacement row changed')
const textInputs = { 'README.ru.md': await readFile(path.join(here, 'README.ru.md')), 'create-role.mjs': await readFile(path.join(here, 'create-role.mjs')), 'icon.svg': await readFile(path.join(source, 'icon.svg')) }
await mkdir(staged)
const write = async (name, data) => { const file = path.join(staged, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, data, { flag: 'wx' }) }
const copied = {}
for (const [input, suffix, destination, expectedName, expectedVersion] of [
  [sdk, 'packages/worker-session-controller', 'native-sdk', '@dsh-remote/worker-session-controller', '0.1.7'],
  [bridge, '', 'bridge', '@dsh-remote/control-bridge', '0.1.5'],
]) {
  const directory = path.join(input.directory, suffix), manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')), files = await snapshot(directory)
  if (manifest.name !== expectedName || manifest.version !== expectedVersion || manifest.engines.dsh !== '0.2.2-rc.1') throw new Error('Portable provider identity or runtime version changed')
  const entries = manifest.files
  if (!Array.isArray(entries) || entries.some(name => typeof name !== 'string' || !name || name.includes('..') || name.includes('\\') || path.isAbsolute(name) || name.includes('*'))) throw new Error('Portable provider publication must be explicit')
  for (const entry of entries) if (!Object.keys(files).some(name => name === entry || name.startsWith(entry + '/'))) throw new Error('Declared provider publication is missing')
  copied[destination] = {}
  for (const name of Object.keys(files).filter(name => name === 'package.json' || entries.some(entry => name === entry || name.startsWith(entry + '/')))) {
    if (name.split('/').some(part => ['node_modules', '.git', 'private', 'profiles', 'fixtures', 'tests'].includes(part) || part.startsWith('.env')) || /(?:^|\/)(?:controller|worker|endpoint)(?:-settings)?\.json$/.test(name)) throw new Error('Private state cannot enter the portable payload')
    copied[destination][name] = files[name]; await write(`${destination}/${name}`, await readFile(path.join(directory, name)))
  }
}
for (const [name, bytes] of Object.entries(textInputs)) await write(name, bytes)
const patch = [...sdkPatch, { insert: [{ id: 'remote-native-control-bridge', name: '@dsh-remote/control-bridge', disabled: true }] }]
const manifest = { name: '@dsh-remote/portable-worker-bundle', version: '0.1.7', private: true, type: 'module',
  description: 'Explicit remote Worker providers for an already paired version-two installation; Bridge stays disabled', engines: { node: '>=24.9', dsh: '0.2.2-rc.1' },
  exports: { './icon': './icon.svg', './locale/*.json': './locale/*.json' },
  files: ['native-sdk', 'bridge', 'icon.svg', 'locale', 'cordis.patch.yml', 'README.ru.md', 'TRANSPORT.md', 'UPGRADE.md', 'create-role.mjs', 'build-manifest.json', 'SHA256SUMS'],
  dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: { '@dsh-remote/worker-session-controller': 'file:./native-sdk', '@dsh-remote/control-bridge': 'file:./bridge' } }
await write('package.json', json(manifest)); await write('cordis.patch.yml', json(patch))
await write('locale/en.json', json({ meta: { title: 'Remote native Worker', description: 'Native session, file and image providers for an already paired remote Worker. Connection remains disabled until explicit role installation.' } }))
await write('locale/ru.json', json({ meta: { title: 'Удалённый native Worker', description: 'Native-сессии, файлы и изображения на уже спаренном удалённом Worker. Соединение выключено до явной установки роли.' } }))
await write('TRANSPORT.md', '# Transport\n\nSee [the checked Bridge transport](bridge/TRANSPORT.md). HTTPS is the default. Auto WSS needs explicit requestTimeoutMs and relaySocketConnectTimeoutMs on both version-two endpoints. No TLS bypass; no physical WAN/TLS measurement is claimed.\n')
await write('UPGRADE.md', '# Upgrade\n\nSee [the checked private-store upgrade notes](bridge/UPGRADE.md). Back up complete private state after a clean stop. Revision-1 endpoint persistence is verified and atomically upgraded to revision 2; older binaries cannot read it. This is NOT migration of a legacy v1 pairing to federation v2. Do not delete replay data or alter version numbers. Disable older Worker/Bridge/role bundles before installing the replacement remotely.\n')
const files = await snapshot(staged)
for (const [name, digest] of Object.entries(files)) {
  if (name.endsWith('.json')) JSON.parse(await readFile(path.join(staged, name), 'utf8'))
  if (name.endsWith('.map')) {
    const map = JSON.parse(await readFile(path.join(staged, name), 'utf8'))
    if ([map.sourceRoot, ...(map.sources ?? [])].some(value => typeof value === 'string' && (path.isAbsolute(value) || /^[a-z]:[\\/]|^file:/i.test(value)))) throw new Error('Absolute source paths cannot enter portable maps')
  }
  if (!/\.(?:mjs|js)$/.test(name)) continue
  const file = path.join(staged, name), content = await readFile(file, 'utf8')
  if (spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }).status !== 0) throw new Error('Portable JavaScript syntax check failed')
  for (const match of content.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire(?:\.async)?\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const relative = path.relative(staged, path.resolve(path.dirname(file), match[1])).split(path.sep).join('/')
    if (relative.startsWith('../') || !Object.hasOwn(files, relative)) throw new Error('Portable relative runtime import is not published')
  }
  if (digest !== hash(await readFile(file))) throw new Error('Portable syntax checking changed a payload')
}
for (const child of ['native-sdk', 'bridge']) {
  const item = JSON.parse(await readFile(path.join(staged, child, 'package.json'), 'utf8'))
  for (const target of Object.values(item.exports)) if (typeof target === 'string' && !target.includes('*') && !Object.hasOwn(files, `${child}/${target.replace(/^\.\//, '')}`)) throw new Error('Portable provider export is not published')
  if (Object.values(item.dependencies ?? {}).some(value => value.startsWith('file:'))) throw new Error('Unexpected vendored SDK dependency')
}
if (files['icon.svg'] !== hash(textInputs['icon.svg']) || Object.hasOwn(patch.at(-1).insert[0], 'config') || patch.at(-1).insert[0].disabled !== true) throw new Error('Portable display or inert Bridge policy changed')
for (const input of [sdk, bridge]) if (JSON.stringify(input.files) !== JSON.stringify(await snapshot(input.directory))) throw new Error('Immutable portable input changed during assembly')
for (const name of ['README.ru.md', 'create-role.mjs']) if (hash(textInputs[name]) !== hash(await readFile(path.join(here, name)))) throw new Error('Portable instructions changed during assembly')
if (hash(textInputs['icon.svg']) !== hash(await readFile(path.join(source, 'icon.svg')))) throw new Error('Approved portable icon changed during assembly')
await write('build-manifest.json', json({ version: 1, packageVersion: '0.1.7', nativeSdk: { artifact: sdk.relative, sha256: sdk.expected }, bridge: { artifact: bridge.relative, sha256: bridge.expected },
  fileHashes: files, providerFileHashes: copied, payloadTreeHash: treeHash(files), sharedPublicSdk: '0.2.2-rc.1 supplied by DSH; not vendored', settingsIncluded: false, installed: false, localWorkerActivated: false }))
const withManifest = await snapshot(staged); await write('SHA256SUMS', Object.keys(withManifest).sort().map(name => `${withManifest[name]}  ${name}\n`).join(''))
const checked = await snapshot(staged); await mkdir(output)
for (const entry of await readdir(staged, { withFileTypes: true })) await cp(path.join(staged, entry.name), path.join(output, entry.name), { recursive: true, force: false, errorOnExist: true })
if (JSON.stringify(checked) !== JSON.stringify(await snapshot(output))) throw new Error('Published portable Worker differs from checked staging')
console.log(`PORTABLE_WORKER_READY ${Object.keys(checked).length} files; SHA256 ${treeHash(checked)}; not installed or activated`)
