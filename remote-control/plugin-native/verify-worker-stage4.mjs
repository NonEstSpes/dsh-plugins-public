/** Read-only exact-tree and public-face verification of the immutable private project provider. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url)), base = path.join(here, 'worker-stage3-0.1.4'), output = path.join(here, 'worker-stage4-0.1.5')
const hash = value => createHash('sha256').update(value).digest('hex')
async function snapshot(directory, prefix = '') {
  const result = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix + entry.name, filename = path.join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), `Artifact link ${relative}`)
    if (entry.isDirectory()) Object.assign(result, await snapshot(filename, relative + '/'))
    else { assert.ok(entry.isFile()); result[relative] = hash(await readFile(filename)) }
  }
  return result
}
const before = await snapshot(base), after = await snapshot(output), changes = []
const allowed = new Set(['package.json', 'README.md', 'packages/worker-session-controller/package.json',
  'packages/worker-session-controller/lib/index.js', 'packages/worker-session-controller/lib/controller-impl.js', 'packages/worker-session-controller/lib/controller-impl.js.map'])
for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
  assert.ok(!/(?:^|\/)(?:node_modules|\.private|\.git|tests)(?:\/|$)/.test(name), `Private/development artifact ${name}`)
  if (Object.hasOwn(before, name)) assert.ok(Object.hasOwn(after, name), `Removed baseline file ${name}`)
  if (before[name] !== after[name] && name !== 'worker-stage4-report.json') {
    assert.ok(allowed.has(name), `Unreviewed artifact change ${name}`)
    changes.push({ file: name, before: before[name] ?? null, after: after[name] ?? null })
  }
}
const outer = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8')), oldOuter = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8'))
const inner = JSON.parse(await readFile(path.join(output, 'packages/worker-session-controller/package.json'), 'utf8')), oldInner = JSON.parse(await readFile(path.join(base, 'packages/worker-session-controller/package.json'), 'utf8'))
assert.equal(outer.name, '@dsh-remote/worker-extension'); assert.equal(outer.version, '0.1.5')
assert.equal(inner.name, '@dsh-remote/worker-session-controller'); assert.equal(inner.version, '0.1.5')
assert.deepEqual({ ...inner, version: oldInner.version }, oldInner)
assert.deepEqual({ ...outer, version: oldOuter.version, files: oldOuter.files }, oldOuter)
assert.deepEqual(outer.files, [...new Set([...oldOuter.files, 'worker-stage4-report.json'])])
assert.equal(inner.engines.dsh, '0.2.2-rc.1'); assert.equal(outer.engines.dsh, '0.2.2-rc.1')
for (const name of ['cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/ru.json', 'worker-stage2-report.json', 'worker-stage3-report.json']) assert.equal(after[name], before[name])
const prefix = 'packages/worker-session-controller/lib/'
for (const name of ['client.js', 'typert.base.js', 'typert.host.js', 'typert.remote-client.js', 'controller-impl.mjs']) assert.equal(after[prefix + name], before[prefix + name], `Public/predecessor face changed ${name}`)
const oldWrapper = await readFile(path.join(base, prefix, 'index.js'), 'utf8'), wrapper = await readFile(path.join(output, prefix, 'index.js'), 'utf8')
assert.ok(wrapper.startsWith(oldWrapper), 'Exact Stage3 attestation prefix changed')
const project = wrapper.slice(oldWrapper.length)
for (const token of ["Object.getOwnPropertyDescriptor(SessionController, 'ownsSourceProjectHelpers')?.value", 'export function ownsSourceProjectHelpers(value)',
  "Object.getOwnPropertyDescriptor(value, 'sourcePrepareProject')", "Object.getOwnPropertyDescriptor(value, 'sourceRegisterProject')", 'Object.getPrototypeOf(value) !== prototype',
  "Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value !== SessionController", 'sourceProjectCheck(value) === true']) assert.ok(project.includes(token), `Missing exact project attestation ${token}`)
for (const token of ['ownsSourceMutationHelpers', 'ownsSourceCatalogHelper', 'ownsSourceFollowHelper', 'WeakMap']) assert.ok(!project.includes(token), `Replaced prior ownership or introduced global state ${token}`)
const implementation = await readFile(path.join(output, prefix, 'controller-impl.js'), 'utf8')
for (const token of ['sourceFollow', 'ownsSourceFollowHelper', 'sourceModelCatalog', 'sourcePrepareProject', 'sourceRegisterProject', 'ownsSourceProjectHelpers']) assert.ok(implementation.includes(token))
for (const name of Object.keys(after).filter(filename => /\.(?:mjs|js)$/.test(filename))) {
  for (const match of (await readFile(path.join(output, name), 'utf8')).matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*)['"](\.[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(path.join(output, name)), match[1]), key = path.relative(output, target).split(path.sep).join('/')
    assert.ok(!match[1].endsWith('controller-impl.mjs') && target.startsWith(output + path.sep) && Object.hasOwn(after, key), `Unpublished/stale relative import ${name}`)
  }
}
const report = JSON.parse(await readFile(path.join(output, 'worker-stage4-report.json'), 'utf8'))
assert.equal(report.version, '0.1.5'); assert.equal(report.base, 'worker-stage3-0.1.4'); assert.equal(report.baseVersion, '0.1.4')
assert.equal(report.sourceFace, 'src/index.ts'); assert.equal(report.localWorkerActivation, false)
for (const name of ['sourceFence', 'frozenBaseUnchanged', 'publicRemoteClientLocaleUnchanged', 'priorAttestationsPreserved', 'independentPrivateProjectAttestation', 'syntaxCheckedBeforePublication']) assert.equal(report[name], true)
assert.deepEqual([...report.changed].sort((a, b) => a.file.localeCompare(b.file)), changes.sort((a, b) => a.file.localeCompare(b.file)))
const names = Object.keys(after).filter(name => name !== 'worker-stage4-report.json').sort()
assert.equal(report.treeHashExcludingThisReport, hash(names.map(name => `${name}\0${after[name]}\n`).join('')))
console.log(`VERIFIED Worker0.1.5: ${names.length + 1} files; exact Stage3 prefix and public faces; SHA256 ${report.treeHashExcludingThisReport}`)
