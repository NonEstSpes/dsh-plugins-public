import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, readFile, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { openJsonStore } from '../../lib/store.mjs'
import { openFederationJournal, planUnknownCreateAcknowledgement, acknowledgeUnknownCreate } from '../../lib/federation/journal.mjs'
async function fixture(t, role = 'controller') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-owner-ack-')))
  t.after(async () => { const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.ok(path.basename(target).startsWith('dsh-owner-ack-')); await rm(target, { recursive: true, force: true }) })
  const pair = { role, id: role === 'controller' ? 'controller-one' : 'worker-one', peerId: role === 'controller' ? 'worker-one' : 'controller-one', machineKey: 'worker-machine', pairingGeneration: 1, keyFingerprint: 'a'.repeat(64), stateDir: root }
  const target = { machineKey: pair.machineKey, projectId: 'project-one' }
  const op = { principal: 'controller-one', machineKey: pair.machineKey, action: 'session.create', target, requestId: 'original_unknown_create', body: {} }
  return { root, pair, target, op, file: path.join(root, 'federation.json') }
}
for (const role of ['controller', 'worker']) test(`owner acknowledgement preserves ${role} unknown history and permits only explicit different create`, async t => {
  const f = await fixture(t, role)
  let journal = await openFederationJournal(f.pair)
  await assert.rejects(journal.execute(f.op, async tx => { await tx.dispatch(); throw new Error('uncertain') }), { code: 'outcome-unknown' })
  const before = journal.snapshot(); await journal.close()
  const plan = planUnknownCreateAcknowledgement(before, { ...f.target, requestId: f.op.requestId })
  let checked = 0
  await acknowledgeUnknownCreate(f.file, plan, 123, async () => { checked++ })
  assert.equal(checked, 1)
  const after = JSON.parse(await readFile(f.file, 'utf8')), marker = after.operations[plan.operationKey].ownerDisposition
  assert.equal(marker.kind, 'owner-abandoned-create')
  assert.equal(after.operations[plan.operationKey].state, 'unknown')
  delete after.operations[plan.operationKey].ownerDisposition
  assert.deepEqual(after, before, 'ONLY one disposition field may change')
  journal = await openFederationJournal(f.pair)
  try {
    let effects = 0, reconciles = 0
    await assert.rejects(journal.execute(f.op, () => { effects++ }, () => { reconciles++; return {} }), { code: 'outcome-unknown' })
    assert.equal(effects, 0); assert.equal(reconciles, 0)
    if (role === 'controller') assert.deepEqual(journal.getCreateState(f.target), { state: 'idle', previousUnknownCreate: { requestId: f.op.requestId, disposition: 'owner-abandoned' } })
    const next = { ...f.op, requestId: 'explicit_fresh_create' }
    await journal.execute(next, async tx => { effects++; await tx.dispatch(); return { ...f.target, sessionId: tx.reservedSessionId } })
    assert.equal(effects, 1)
    assert.equal(journal.snapshot().operations[plan.operationKey].state, 'unknown')
    if (role === 'controller') assert.equal(journal.getCreateState(f.target).previousUnknownCreate.requestId, f.op.requestId)
  } finally { await journal.close() }
})
test('owner acknowledgement CAS failure and existing-only maintenance do not initialize or alter data', async t => {
  const f = await fixture(t), journal = await openFederationJournal(f.pair)
  await assert.rejects(journal.execute(f.op, async tx => { await tx.dispatch(); throw new Error('uncertain') }))
  const plan = planUnknownCreateAcknowledgement(journal.snapshot(), { ...f.target, requestId: f.op.requestId }); await journal.close()
  const before = await readFile(f.file)
  await assert.rejects(acknowledgeUnknownCreate(f.file, plan), { code: 'invalid-message' })
  const baseline = JSON.parse(before.toString('utf8'))
  for (const corrupt of ['wrong-map-key', 'missing-reservation', 'wrong-native-id', 'result-present', 'ownership-present']) {
    const state = structuredClone(baseline), row = state.operations[plan.operationKey]
    if (corrupt === 'wrong-map-key') { delete state.operations[plan.operationKey]; state.operations.wrong = row }
    if (corrupt === 'missing-reservation') delete row.reservedSessionId
    if (corrupt === 'wrong-native-id') row.nativeRequestId = 'frpc_' + 'b'.repeat(64)
    if (corrupt === 'result-present') row.result = null
    if (corrupt === 'ownership-present') state.remoteOwnedSessions[row.reservedSessionId] = { createRequestId: row.requestId, state: 'committed' }
    assert.throws(() => planUnknownCreateAcknowledgement(state, { ...f.target, requestId: f.op.requestId }), { code: 'outcome-unknown' })
  }
  await assert.rejects(acknowledgeUnknownCreate(f.file, { ...plan, rowDigest: 'b'.repeat(64) }, 123, async () => {}), { code: 'request-conflict' })
  await assert.rejects(acknowledgeUnknownCreate(f.file, { ...plan, bindingDigest: 'b'.repeat(64) }, 123, async () => {}), { code: 'request-conflict' })
  assert.deepEqual(await readFile(f.file), before)
  const missing = path.join(f.root, 'not-created', 'federation.json')
  await assert.rejects(openJsonStore(missing, {}, { existingOnly: true }), { code: 'ENOENT' })
  await assert.rejects(stat(path.dirname(missing)), { code: 'ENOENT' })
})
test('native proof and non-create unknown operations cannot receive owner abandonment', async t => {
  const f = await fixture(t, 'worker'), journal = await openFederationJournal(f.pair)
  try {
    await assert.rejects(journal.execute(f.op, async tx => { await tx.dispatch(); await tx.recordNativeCreation({ sessionId: tx.reservedSessionId, createdAt: 1 }); throw new Error('uncertain') }))
    assert.throws(() => planUnknownCreateAcknowledgement(journal.snapshot(), { ...f.target, requestId: f.op.requestId }), { code: 'outcome-unknown' })
    const other = { ...f.op, requestId: 'unknown_prompt_operation', action: 'session.prompt', target: { ...f.target, projectId: 'another-project' } }
    await assert.rejects(journal.execute(other, async tx => { await tx.dispatch(); throw new Error('uncertain') }))
    assert.throws(() => planUnknownCreateAcknowledgement(journal.snapshot(), { ...other.target, requestId: other.requestId }), { code: 'outcome-unknown' })
    await assert.rejects(journal.execute({ ...other, action: 'session.create', requestId: 'different_new_create' }, () => { throw new Error('must not execute') }), { code: 'outcome-unknown' })
  } finally { await journal.close() }
})
