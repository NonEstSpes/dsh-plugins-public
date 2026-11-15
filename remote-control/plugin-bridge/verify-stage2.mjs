/** Read-only distribution checks for the stage2a bridge; never installs or opens pairing files. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..')
const base = path.join(here, 'bundle-v3'), output = path.join(here, 'bundle-stage2-0.1.3')
const sha = value => createHash('sha256').update(value).digest('hex')
async function snapshot(directory, prefix = '') {
  const files = {}
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + item.name, absolute = path.join(directory, item.name)
    assert.ok(!item.isSymbolicLink(), `Unexpected distribution link: ${relative}`)
    if (item.isDirectory()) Object.assign(files, await snapshot(absolute, relative + '/'))
    else { assert.ok(item.isFile()); files[relative] = sha(await readFile(absolute)) }
  }
  return files
}
const actual = await snapshot(output), baseline = await snapshot(base)
const changed = new Set(['package.json', 'README.md', 'build-report.json', 'lib/federation/catalog.mjs',
  'lib/federation/protocol.mjs', 'lib/federation/runtime.mjs', 'lib/federation/host-provider.mjs', 'lib/federation/journal.mjs'])
const additions = new Set(['lib/federation/diagnostics.mjs', 'FEDERATION-V2.md', 'locale/en.json', 'locale/ru.json'])
for (const [relative, hash] of Object.entries(baseline)) {
  assert.ok(Object.hasOwn(actual, relative), `Missing baseline file: ${relative}`)
  if (!changed.has(relative)) assert.equal(actual[relative], hash, `Unexpected baseline change: ${relative}`)
}
for (const relative of Object.keys(actual)) {
  assert.ok(Object.hasOwn(baseline, relative) || additions.has(relative), `Unexpected added file: ${relative}`)
  assert.ok(!/(?:^|\/)(?:node_modules|\.private|\.git|tests)(?:\/|$)/.test(relative), `Private or development payload: ${relative}`)
}
for (const relative of additions) assert.ok(Object.hasOwn(actual, relative), `Missing stage2 resource: ${relative}`)
const manifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'))
assert.equal(manifest.name, '@dsh-remote/control-bridge')
assert.equal(manifest.version, '0.1.3')
assert.equal(manifest.engines.dsh, '0.2.2-rc.1')
assert.equal(manifest.exports['./client'], undefined)
assert.equal(manifest.dsh.client, undefined)
assert.equal(manifest.exports['./icon'], './icon.svg')
assert.equal(manifest.exports['./locale/*.json'], './locale/*.json')
assert.ok(manifest.files.includes('locale') && manifest.files.includes('FEDERATION-V2.md'))
assert.equal(manifest.scripts, undefined)
for (const language of ['en', 'ru']) {
  const locale = JSON.parse(await readFile(path.join(output, 'locale', language + '.json'), 'utf8'))
  assert.ok(typeof locale.meta.title === 'string' && locale.meta.title.length > 0)
  assert.ok(typeof locale.meta.description === 'string' && locale.meta.description.length > 0)
}
const icon = await readFile(path.join(output, 'icon.svg'), 'utf8')
assert.equal(sha(icon), sha(await readFile(path.join(root, 'icon.svg'))))
assert.ok(Buffer.byteLength(icon) < 256 * 1024 && icon.startsWith('<svg '))
assert.ok(!/<script|<foreignObject|\bhref\s*=/i.test(icon))
const patch = JSON.parse(await readFile(path.join(output, 'cordis.patch.yml'), 'utf8'))
assert.deepEqual(patch, [
  { id: 'remote-control', name: '@local/dsh-remote-control', disabled: true },
  { insert: [{ id: 'remote-native-control-bridge', name: '@dsh-remote/control-bridge', config: { settingsFile: '' } }] },
])
const index = await readFile(path.join(output, 'index.js'), 'utf8')
assert.ok(!index.includes('DEFAULT_SETTINGS') && !index.includes('./.private/controller.json'))
assert.ok(index.includes('Required absolute path to the explicitly selected role-local configuration'))
const report = JSON.parse(await readFile(path.join(output, 'build-report.json'), 'utf8'))
assert.equal(report.packageVersion, manifest.version)
assert.equal(report.hostOnly, true)
assert.equal(report.sourceIndexSha256, sha(await readFile(path.join(root, 'index.js'))))
const audited = new Set()
for (const entry of report.files) {
  assert.ok(!audited.has(entry.file)); audited.add(entry.file)
  assert.equal(actual[entry.file], entry.sha256, `Audit mismatch: ${entry.file}`)
}
assert.deepEqual([...audited].sort(), Object.keys(actual).filter(file => file !== 'build-report.json').sort())
for (const relative of report.allowlist) assert.equal(actual[relative], sha(await readFile(path.join(root, relative))), `Source mismatch: ${relative}`)
for (const relative of Object.keys(actual).filter(file => /\.(?:mjs|js)$/.test(file))) {
  const text = await readFile(path.join(output, relative), 'utf8')
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(path.join(output, relative)), match[1])
    assert.ok(target.startsWith(output + path.sep), `Import escapes artifact: ${relative}`)
    assert.ok((await stat(target)).isFile(), `Unresolved relative import: ${relative} -> ${match[1]}`)
  }
}
const treeHash = sha(JSON.stringify(Object.entries(actual).sort(([a], [b]) => a.localeCompare(b))))
console.log(`VERIFIED bridge ${manifest.version}: ${Object.keys(actual).length} files; baseline core/SDK/Worker activation unchanged; SHA256 ${treeHash}`)
