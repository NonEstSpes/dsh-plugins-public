/** Read-only verification of the immutable staged Worker and its preserved public faces; no profile or pairing access. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), base = path.join(here, 'worker-stage2-0.1.2'), output = path.join(here, 'worker-stage3-0.1.4')
const hash = value => createHash('sha256').update(value).digest('hex')
async function snapshot(directory, prefix = '') {
  const result = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const filename = path.join(directory, entry.name), relative = prefix + entry.name
    assert.ok(!entry.isSymbolicLink(), `Unexpected artifact link ${relative}`)
    if (entry.isDirectory()) Object.assign(result, await snapshot(filename, relative + '/'))
    else { assert.ok(entry.isFile()); result[relative] = hash(await readFile(filename)) }
  }
  return result
}
const before = await snapshot(base), after = await snapshot(output)
const allowed = new Set(['package.json', 'README.md', 'packages/worker-session-controller/package.json',
  'packages/worker-session-controller/lib/index.js', 'packages/worker-session-controller/lib/controller-impl.js',
  'packages/worker-session-controller/lib/controller-impl.js.map'])
const changes = []
for (const relative of new Set([...Object.keys(before), ...Object.keys(after)])) {
  assert.ok(!/(?:^|\/)(?:node_modules|\.private|\.git|tests)(?:\/|$)/.test(relative), `Private/development payload ${relative}`)
  if (Object.hasOwn(before, relative)) assert.ok(Object.hasOwn(after, relative), `Removed immutable baseline file ${relative}`)
  if (before[relative] !== after[relative] && relative !== 'worker-stage3-report.json') {
    assert.ok(allowed.has(relative), `Unreviewed artifact change ${relative}`)
    changes.push({ file: relative, before: before[relative] ?? null, after: after[relative] ?? null })
  }
}
const outer = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'))
const oldOuter = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8'))
const inner = JSON.parse(await readFile(path.join(output, 'packages/worker-session-controller/package.json'), 'utf8'))
const oldInner = JSON.parse(await readFile(path.join(base, 'packages/worker-session-controller/package.json'), 'utf8'))
assert.equal(outer.name, '@dsh-remote/worker-extension'); assert.equal(outer.version, '0.1.4')
assert.equal(inner.name, '@dsh-remote/worker-session-controller'); assert.equal(inner.version, '0.1.4')
assert.deepEqual({ ...inner, version: oldInner.version }, oldInner)
assert.deepEqual({ ...outer, version: oldOuter.version, files: oldOuter.files }, oldOuter)
assert.deepEqual(outer.files, [...new Set([...oldOuter.files, 'worker-stage3-report.json'])])
assert.equal(outer.engines.dsh, '0.2.2-rc.1'); assert.equal(inner.engines.dsh, '0.2.2-rc.1')
for (const relative of ['cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/ru.json', 'worker-stage2-report.json']) assert.equal(after[relative], before[relative])
const prefix = 'packages/worker-session-controller/lib/'
for (const filename of ['client.js', 'typert.base.js', 'typert.host.js', 'typert.remote-client.js', 'controller-impl.mjs']) {
  assert.equal(after[prefix + filename], before[prefix + filename], `Changed frozen public or unreachable predecessor face ${filename}`)
}
const oldWrapper = await readFile(path.join(base, prefix, 'index.js'), 'utf8')
const wrapper = await readFile(path.join(output, prefix, 'index.js'), 'utf8')
assert.ok(wrapper.startsWith(oldWrapper), 'Stage2 mutation and catalog attestations must be preserved byte-for-byte')
const follow = wrapper.slice(oldWrapper.length)
for (const token of ["Object.getOwnPropertyDescriptor(SessionController, 'ownsSourceFollowHelper')?.value", 'export function ownsSourceFollowHelper(value)',
  "Object.getOwnPropertyDescriptor(value, 'sourceFollow')", 'Object.getPrototypeOf(value) !== prototype',
  "Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value !== SessionController", 'sourceFollowCheck(value) === true']) assert.ok(follow.includes(token), `Missing exact follow attestation ${token}`)
assert.ok(!follow.includes('ownsSourceMutationHelpers') && !follow.includes('ownsSourceCatalogHelper') && !follow.includes('WeakMap'))
const implementation = await readFile(path.join(output, prefix, 'controller-impl.js'), 'utf8')
for (const token of ['sourceModelCatalog', 'sourceFollow', 'ownsSourceFollowHelper']) assert.ok(implementation.includes(token))
for (const relative of Object.keys(after).filter(name => /\.(?:mjs|js)$/.test(name))) {
  const text = await readFile(path.join(output, relative), 'utf8')
  for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(path.join(output, relative)), match[1]), key = path.relative(output, target).split(path.sep).join('/')
    assert.ok(!match[1].endsWith('controller-impl.mjs'), `Reachable stale predecessor ${relative}`)
    assert.ok(target.startsWith(output + path.sep) && Object.hasOwn(after, key), `Unpublished relative import ${relative}`)
  }
}
const report = JSON.parse(await readFile(path.join(output, 'worker-stage3-report.json'), 'utf8'))
assert.equal(report.version, '0.1.4'); assert.equal(report.base, 'worker-stage2-0.1.2'); assert.equal(report.baseVersion, '0.1.2')
assert.equal(report.sourceFace, 'src/index.ts'); assert.equal(report.localWorkerActivation, false)
for (const key of ['sourceFence', 'frozenBaseUnchanged', 'publicRemoteClientLocaleUnchanged', 'mutationAndCatalogAttestationsPreserved', 'independentPrivateFollowAttestation', 'syntaxCheckedBeforePublication']) assert.equal(report[key], true)
assert.deepEqual([...report.changed].sort((a, b) => a.file.localeCompare(b.file)), changes.sort((a, b) => a.file.localeCompare(b.file)))
const names = Object.keys(after).filter(name => name !== 'worker-stage3-report.json').sort()
assert.equal(report.treeHashExcludingThisReport, hash(names.map(name => `${name}\0${after[name]}\n`).join('')))
console.log(`VERIFIED Worker0.1.4: ${names.length + 1} files, exact Stage2 prefix and public faces preserved; SHA256 ${report.treeHashExcludingThisReport}`)
