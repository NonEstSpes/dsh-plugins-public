/** Check stage2b Host-only publication and Config; no installation or pairing reads. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), source = path.resolve(here, '..')
const base = path.join(here, 'bundle-stage2-0.1.3'), output = path.join(here, 'bundle-stage2-0.1.4')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function snapshot(directory, prefix = '') {
  const files = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name, absolute = path.join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), `Unexpected artifact link ${relative}`)
    if (entry.isDirectory()) Object.assign(files, await snapshot(absolute, relative + '/'))
    else { assert.ok(entry.isFile()); files[relative] = hash(await readFile(absolute)) }
  }
  return files
}
const before = await snapshot(base), after = await snapshot(output)
const allowed = new Set(['package.json', 'index.js', 'README.md', 'FEDERATION-V2.md', 'build-report.json', 'lib/federation/native-adapter.mjs'])
for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
  assert.ok(Object.hasOwn(after, file), `Removed artifact ${file}`)
  if (before[file] !== after[file]) assert.ok(allowed.has(file), `Unapproved stage2b change ${file}`)
  assert.ok(!/(?:^|\/)(?:node_modules|\.private|\.git|tests)(?:\/|$)/.test(file))
}
const manifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@dsh-remote/control-bridge'); assert.equal(manifest.version, '0.1.4')
assert.equal(manifest.engines.dsh, '0.2.2-rc.1')
assert.equal(manifest.peerDependencies['@dsh-remote/worker-session-controller'], '0.1.2')
assert.equal(manifest.peerDependenciesMeta['@dsh-remote/worker-session-controller'].optional, true)
assert.equal(manifest.exports['./client'], undefined); assert.equal(manifest.dsh.client, undefined)
assert.equal(manifest.exports['./icon'], './icon.svg'); assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
assert.equal(manifest.scripts, undefined)
for (const language of ['en', 'ru']) {
  const locale = JSON.parse(await readFile(path.join(output, 'locale', language + '.json'), 'utf8'))
  assert.ok(locale.meta.title && locale.meta.description)
}
assert.equal(after['icon.svg'], hash(await readFile(path.join(source, 'icon.svg'))))
const patch = JSON.parse(await readFile(path.join(output, 'cordis.patch.yml'), 'utf8'))
assert.deepEqual(patch, [{ id: 'remote-control', name: '@local/dsh-remote-control', disabled: true },
  { insert: [{ id: 'remote-native-control-bridge', name: '@dsh-remote/control-bridge', config: { settingsFile: '' } }] }])
const index = await readFile(path.join(output, 'index.js'), 'utf8')
assert.ok(!index.includes('DEFAULT_SETTINGS'))
assert.ok(index.includes('modelCatalogProviderTimeoutMs: this.config.modelCatalogProviderTimeoutMs'))
assert.ok(index.includes("settings.role !== 'worker' && this.config.modelCatalogProviderTimeoutMs !== undefined"))
assert.ok(index.includes('this.config.modelCatalogProviderTimeoutMs !== undefined && document?.version !== 2'))
const report = JSON.parse(await readFile(path.join(output, 'build-report.json'), 'utf8'))
assert.equal(report.packageVersion, '0.1.4'); assert.equal(report.hostOnly, true)
assert.equal(report.sourceIndexSha256, hash(await readFile(path.join(source, 'index.js'))))
const audited = new Set()
for (const record of report.files) { assert.ok(!audited.has(record.file)); audited.add(record.file); assert.equal(after[record.file], record.sha256) }
assert.deepEqual([...audited].sort(), Object.keys(after).filter(file => file !== 'build-report.json').sort())
for (const file of report.allowlist) assert.equal(after[file], hash(await readFile(path.join(source, file))), `Current source mismatch ${file}`)
for (const file of Object.keys(after).filter(file => /\.(?:mjs|js)$/.test(file))) {
  const text = await readFile(path.join(output, file), 'utf8')
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(path.join(output, file)), match[1])
    assert.ok(target.startsWith(output + path.sep)); assert.ok((await stat(target)).isFile())
  }
}
// Loading Config defines no service and opens no configured endpoint.
const { Config } = await import(pathToFileURL(path.join(output, 'index.js')).href)
const settingsFile = path.join(source, 'explicit-test-only.json')
assert.equal(Config({ settingsFile }).modelCatalogProviderTimeoutMs, undefined)
for (const budget of [1, 250, 60000]) assert.equal(Config({ settingsFile, modelCatalogProviderTimeoutMs: budget }).modelCatalogProviderTimeoutMs, budget)
for (const budget of [0, -1, 1.5, 60001]) assert.throws(() => Config({ settingsFile, modelCatalogProviderTimeoutMs: budget }), `Config must reject budget ${budget}`)
// Schemastery retains optional null; the Worker factory rejects it before SDK/native work.
const nullPolicy = Config({ settingsFile, modelCatalogProviderTimeoutMs: null }).modelCatalogProviderTimeoutMs
assert.equal(nullPolicy, null)
const { createNativeAdapter } = await import(pathToFileURL(path.join(output, 'lib/federation/native-adapter.mjs')).href)
await assert.rejects(createNativeAdapter({ ctx: {}, settings: {}, modelCatalogProviderTimeoutMs: nullPolicy }), { code: 'invalid-message' })
assert.throws(() => Config({ modelCatalogProviderTimeoutMs: 250 }))
const treeHash = hash(Object.keys(after).sort().map(file => `${file}\0${after[file]}\n`).join(''))
console.log(`VERIFIED Bridge0.1.4: ${Object.keys(after).length} files, explicit optional Worker Config, no Worker activation; SHA256 ${treeHash}`)
