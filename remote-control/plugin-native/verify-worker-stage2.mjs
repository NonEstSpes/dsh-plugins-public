/** Read-only Worker payload and publication checks; no profile or pairing access. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), base = path.join(here, 'worker-bundle'), output = path.join(here, 'worker-stage2-0.1.2')
const hash = value => createHash('sha256').update(value).digest('hex')
async function snapshot(directory, prefix = '') {
  const files = {}
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, item.name), relative = prefix + item.name
    assert.ok(!item.isSymbolicLink(), `Unexpected link ${relative}`)
    if (item.isDirectory()) Object.assign(files, await snapshot(absolute, relative + '/'))
    else { assert.ok(item.isFile()); files[relative] = hash(await readFile(absolute)) }
  }
  return files
}
const before = await snapshot(base), after = await snapshot(output)
const allowed = new Set(['package.json', 'README.md', 'icon.svg', 'locale/en.json', 'locale/ru.json',
  'packages/worker-session-controller/package.json', 'packages/worker-session-controller/lib/index.js',
  'packages/worker-session-controller/lib/controller-impl.js', 'packages/worker-session-controller/lib/controller-impl.js.map'])
for (const relative of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[relative] !== after[relative]) assert.ok(allowed.has(relative) || relative === 'worker-stage2-report.json', `Unapproved change ${relative}`)
  assert.ok(!/(?:^|\/)(?:node_modules|\.private|\.git|tests)(?:\/|$)/.test(relative), `Private/development payload ${relative}`)
  if (Object.hasOwn(before, relative)) assert.ok(Object.hasOwn(after, relative), `Removed baseline file ${relative}`)
}
const outer = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'))
const innerDir = path.join(output, 'packages/worker-session-controller')
const inner = JSON.parse(await readFile(path.join(innerDir, 'package.json'), 'utf8'))
assert.equal(outer.name, '@dsh-remote/worker-extension'); assert.equal(outer.version, '0.1.2')
assert.equal(inner.name, '@dsh-remote/worker-session-controller'); assert.equal(inner.version, '0.1.2')
assert.equal(outer.engines.dsh, '0.2.2-rc.1'); assert.equal(inner.engines.dsh, '0.2.2-rc.1')
assert.deepEqual(outer.dependencies, { '@dsh-remote/worker-session-controller': 'file:./packages/worker-session-controller' })
assert.equal(outer.exports['./icon'], './icon.svg'); assert.equal(outer.exports['./locale/*.json'], './locale/*.json')
for (const language of ['en', 'ru']) {
  const locale = JSON.parse(await readFile(path.join(output, 'locale', language + '.json'), 'utf8'))
  assert.ok(locale.meta.title.length > 0 && locale.meta.description.length > 0)
}
assert.equal(after['icon.svg'], hash(await readFile(path.join(here, '../icon.svg'))))
const originalInner = JSON.parse(await readFile(path.join(base, 'packages/worker-session-controller/package.json'), 'utf8'))
assert.deepEqual(inner.exports, originalInner.exports)
assert.deepEqual(inner.peerDependencies, originalInner.peerDependencies)
assert.deepEqual(inner.dsh, originalInner.dsh)
assert.equal(inner.exports['.'], './lib/index.js')
assert.equal(after['cordis.patch.yml'], before['cordis.patch.yml'])
const prefix = 'packages/worker-session-controller/lib/'
for (const file of ['client.js', 'typert.base.js', 'typert.host.js', 'typert.remote-client.js']) assert.equal(after[prefix + file], before[prefix + file], `Changed public/Client descriptor ${file}`)
const oldWrapper = await readFile(path.join(base, prefix, 'index.js'), 'utf8')
const wrapper = await readFile(path.join(innerDir, 'lib/index.js'), 'utf8')
assert.ok(wrapper.startsWith(oldWrapper), 'Original eight-method mutation attestation must stay verbatim')
assert.ok(wrapper.includes("from './controller-impl.js'"))
const readAttestation = wrapper.slice(oldWrapper.length)
assert.ok(readAttestation.includes('export function ownsSourceCatalogHelper(value)'))
assert.ok(!readAttestation.includes('ownsSourceMutationHelpers'))
assert.ok(readAttestation.includes("Object.hasOwn(value, 'sourceModelCatalog')"))
assert.ok(readAttestation.includes("Object.getOwnPropertyDescriptor(prototype, 'sourceModelCatalog')?.value === catalogMethod"))
const implementation = await readFile(path.join(innerDir, 'lib/controller-impl.js'), 'utf8')
assert.ok(implementation.includes('sourceModelCatalog') && implementation.includes('updateTimeout'))
assert.ok(implementation.includes('source model catalogue owner'))
for (const relative of Object.keys(after).filter(file => /\.(?:mjs|js)$/.test(file))) {
  const text = await readFile(path.join(output, relative), 'utf8')
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    assert.ok(!match[1].endsWith('controller-impl.mjs'), `Stale duplicate is reachable from ${relative}`)
    const target = path.resolve(path.dirname(path.join(output, relative)), match[1])
    assert.ok(target.startsWith(output + path.sep), `Import escapes payload ${relative}`)
    const key = path.relative(output, target).split(path.sep).join('/')
    assert.ok(Object.hasOwn(after, key), `Unpublished relative import ${relative} -> ${key}`)
  }
}
const report = JSON.parse(await readFile(path.join(output, 'worker-stage2-report.json'), 'utf8'))
assert.equal(report.version, '0.1.2'); assert.equal(report.sourceFace, 'src/index.ts')
assert.equal(report.sourceFence, true); assert.equal(report.localWorkerActivation, false)
for (const change of report.changed) {
  assert.ok(allowed.has(change.file)); assert.equal(change.before, before[change.file] ?? null); assert.equal(change.after, after[change.file] ?? null)
}
const names = Object.keys(after).filter(file => file !== 'worker-stage2-report.json').sort()
assert.equal(report.treeHashExcludingThisReport, hash(names.map(file => `${file}\0${after[file]}\n`).join('')))
console.log(`VERIFIED Worker0.1.2: ${Object.keys(after).length} files, frozen public descriptors/Client and mutation attestation; SHA256 ${report.treeHashExcludingThisReport}`)
