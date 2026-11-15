import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createWireCodec, createWireScope } from '../../lib/federation/wire-codec.mjs'

const machineKey = 'fixture-worker'
const scope = 'fixture-registration-v1'
const codec = createWireCodec({ machineKey, scope })
const source = JSON.parse(await readFile(new URL('./native-projection.json', import.meta.url), 'utf8'))
const wire = {
  ...source,
  page: codec.toWire('history-page', source.page),
  append: codec.toWire('history-frame', source.append),
  wireIdentity: { machineKey, scope },
}
const destination = new URL('./fixtures/native-projection.wire.json', import.meta.url)
if (process.argv.includes('--write-fixture')) {
  await mkdir(new URL('./fixtures/', import.meta.url), { recursive: true })
  await writeFile(destination, JSON.stringify(wire, null, 2) + '\n', 'utf8')
}

test('real mapper exactly reproduces the committed native-source wire fixture', async () => {
  const committed = JSON.parse(await readFile(destination, 'utf8'))
  assert.deepEqual(committed, wire)
  assert.equal(typeof committed.page.generation, 'string')
  assert.equal(typeof committed.page.grantRevision, 'string')
  assert.equal(committed.append.generation, committed.page.generation)
  assert.equal(committed.append.grantRevision, committed.page.grantRevision)
  assert.equal(codec.decodeGeneration(committed.page.generation), source.page.generation)
  assert.deepEqual(codec.fromWire('history-page', committed.page), source.page)
  assert.deepEqual(codec.fromWire('history-frame', committed.append), source.append)
  assert.equal(committed.page.exportCursor, source.page.exportCursor)
  assert.equal(committed.append.exportCursor, source.append.exportCursor)
  assert.deepEqual(committed.page.records, source.page.records)
})

test('codec prefix, canonical tuple and exact current registration are strict', () => {
  const generation = codec.encodeGeneration(1)
  const revision = codec.encodeGrantRevision(1)
  assert.match(generation, /^feg1\.[A-Za-z0-9_-]+$/)
  assert.match(revision, /^fgr1\.[A-Za-z0-9_-]+$/)
  const body = generation.slice(5)
  assert.equal(Buffer.from(body, 'base64url').toString('utf8'), JSON.stringify([machineKey, scope, 1]))
  for (const token of [revision, generation + '=', generation + '/', 'feg1.' + 'A'.repeat(4096)]) assert.throws(() => codec.decodeGeneration(token))
  for (const tuple of [[machineKey, scope, 1, 'extra'], [machineKey, scope, '1'], [machineKey, scope, -1], [machineKey, scope, null]]) {
    assert.throws(() => codec.decodeGeneration('feg1.' + Buffer.from(JSON.stringify(tuple)).toString('base64url')))
  }
  for (const text of [JSON.stringify([machineKey, scope, 1]).replaceAll(',', ', '), `["${machineKey}","${scope}",-0]`, `["${machineKey}","${scope}",1.0]`]) {
    assert.throws(() => codec.decodeGeneration('feg1.' + Buffer.from(text).toString('base64url')))
  }
  assert.throws(() => createWireCodec({ machineKey: 'other-worker', scope }).decodeGeneration(generation))
  assert.throws(() => createWireCodec({ machineKey, scope: 'replacement-registration' }).decodeGeneration(generation))
})

test('domain versions reject coercion, negative zero, fractional and unsafe values', () => {
  for (const value of [-0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, '1', null, false, {}, undefined]) {
    assert.throws(() => codec.encodeGeneration(value))
    assert.throws(() => codec.encodeGrantRevision(value))
  }
  for (const value of [0, 1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(codec.decodeGeneration(codec.encodeGeneration(value)), value)
    assert.equal(codec.decodeGrantRevision(codec.encodeGrantRevision(value)), value)
  }
})

test('all artifact faces use the same real version codec without rewriting native data', () => {
  const ref = { machineKey, projectId: 'demo', sessionId: 'session-fixture' }
  const binding = { ref, grantRevision: 1, generation: 1, capabilities: { history: true } }
  const catalog = { generation: 1, grantRevision: 1, projects: [{ ref: { machineKey, projectId: 'demo' } }], sessions: [{ ref }] }
  const stamp = { generation: 1, frontierSeq: 6, selection: { provider: 'p', model: 'm' } }
  const snapshot = { type: 'snapshot', page: source.page, header: source.header, projections: source.projections }
  for (const [kind, artifact] of [['binding', binding], ['catalog', catalog], ['history-page', source.page], ['history-frame', snapshot], ['history-frame', source.append], ['model-stamp', stamp], ['model-ack', stamp]]) {
    const converted = codec.toWire(kind, artifact)
    assert.deepEqual(codec.fromWire(kind, converted), artifact)
    const versions = kind === 'history-frame' && artifact.type === 'snapshot' ? converted.page : converted
    assert.equal(versions.generation, codec.encodeGeneration(1))
    if (Object.hasOwn(versions, 'grantRevision')) assert.equal(versions.grantRevision, codec.encodeGrantRevision(1))
  }
  const native = structuredClone(source.page)
  native.records[0].event.data.generation = 123
  assert.equal(codec.toWire('history-page', native).records[0].event.data.generation, 123)
  assert.throws(() => codec.toWire('binding', { ...binding, ref: { ...ref, machineKey: 'other-worker' } }))
  assert.throws(() => codec.toWire('catalog', { ...catalog, sessions: [{ ref: { ...ref, machineKey: 'other-worker' } }] }))
  assert.throws(() => codec.toWire('history-page', { ...source.page, generation: 'already-wire' }))
  assert.throws(() => codec.toWire('history-frame', { type: 'assistant-stream', generation: 1, grantRevision: 1 }))
})

test('new registrations mint fresh scopes while reconnects reuse the existing instance', () => {
  const first = createWireCodec({ machineKey })
  const second = createWireCodec({ machineKey })
  assert.notEqual(first.scope, second.scope)
  assert.equal(first.encodeGeneration(1), first.encodeGeneration(1))
  assert.throws(() => second.decodeGeneration(first.encodeGeneration(1)))
  assert.notEqual(createWireScope(), createWireScope())
  assert.throws(() => createWireCodec({ machineKey, scope: '' }))
  assert.throws(() => createWireCodec({ machineKey, scope, invalid: true }))
})
