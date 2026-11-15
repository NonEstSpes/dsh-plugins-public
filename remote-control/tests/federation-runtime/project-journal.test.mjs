import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { openProjectJournal } from '../../lib/federation/project-journal.mjs'
import { canonicalJson } from '../../lib/federation/journal.mjs'

const template = { actions: ['project.list', 'session.list', 'session.create'], exportClasses: ['conversation.user'],
  createdSessionGrant: { actions: ['session.read'], exportClasses: ['conversation.user'] } }
const request = (requestId = 'register_one', rawPath = '/worker/requested') => ({ requestId, body: { path: rawPath }, authority: { generation: 2, grantRevision: 1 } })
const prepared = (canonicalPath = '/worker/canonical', existingWorkspaceId) => ({ canonicalPath, projectGrant: template,
  ...(existingWorkspaceId === undefined ? {} : { existingWorkspaceId }) })
const proof = (canonicalPath = '/worker/canonical', workspaceId = 'native-workspace-opaque') => ({ canonicalPath, workspaceId, title: 'Native project' })
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex')
async function fixture(t, role = 'worker') {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-project-journal-'))
  const pair = { role, id: role === 'worker' ? 'worker' : 'controller', peerId: role === 'worker' ? 'controller' : 'worker',
    machineKey: 'worker-machine', pairingGeneration: 1, keyFingerprint: 'f'.repeat(64), stateDir: root }
  let journal = await openProjectJournal(pair)
  t.after(async () => {
    await journal.close()
    if (path.dirname(root) !== path.resolve(tmpdir()) || !path.basename(root).startsWith('dsh-project-journal-')) throw new Error('invalid owned journal test cleanup')
    await rm(root, { recursive: true, force: true })
  })
  return { pair, file: path.join(root, 'project-registration.v1.json'), get journal() { return journal },
    async reopen() { await journal.close(); journal = await openProjectJournal(pair); return journal },
    async replace(value) { await journal.close(); await writeFile(path.join(root, 'project-registration.v1.json'), JSON.stringify(value)); journal = await openProjectJournal(pair); return journal } }
}
async function commit(journal, registration = request(), plan = prepared(), native = proof()) {
  await journal.reserve(registration, plan)
  await journal.markDispatched(registration.requestId)
  await journal.recordNativeProof(registration.requestId, native)
  return journal.commitWorker(registration.requestId)
}
const code = expected => error => error?.code === expected

test('Worker enrolls only an exact returned native proof and returns a path-free receipt after restart', async t => {
  const f = await fixture(t), result = await commit(f.journal)
  assert.equal(result.state, 'committed'); assert.match(result.result.ref.projectId, /^fpr_[a-f0-9]{32}$/)
  assert.equal(f.journal.nativeBindings()[0].workspaceId, proof().workspaceId)
  assert.deepEqual(f.journal.ownedProjects(), [{ state: 'committed', principal: { kind: 'controller', id: 'controller' }, machineKey: f.pair.machineKey,
    projectId: result.result.ref.projectId, registerRequestId: 'register_one', projectGrant: template }])
  const state = f.journal.state('register_one')
  for (const value of [request().body.path, prepared().canonicalPath, proof().workspaceId, 'nativeProof', 'projectGrant']) assert.equal(JSON.stringify(state).includes(value), false)
  await f.reopen()
  assert.deepEqual(f.journal.state('register_one'), state)
  assert.deepEqual(await f.journal.commitWorker('register_one'), f.journal.row('register_one'))
})

test('Controller retains raw Worker spelling without local normalization or native ownership', async t => {
  const f = await fixture(t, 'controller'), input = request('register_raw', 'Z:\\remote\\source')
  const reserved = await f.journal.reserve(input)
  input.body.path = '/changed-by-caller'; reserved.body.path = '/changed-return'
  assert.equal(f.journal.row('register_raw').body.path, 'Z:\\remote\\source')
  await f.journal.markDispatched('register_raw'); await f.journal.markUnknown('register_raw')
  const result = { ref: { machineKey: f.pair.machineKey, projectId: `fpr_${'a'.repeat(32)}` }, title: 'Worker title' }
  assert.equal((await f.journal.commitController('register_raw', result)).state, 'committed')
  assert.deepEqual(f.journal.ownedProjects(), []); assert.deepEqual(f.journal.nativeBindings(), [])
  await f.reopen(); assert.deepEqual(f.journal.state('register_raw').result, result)
})

test('same request body and authority reuses its reservation while any identity change conflicts', async t => {
  const f = await fixture(t), row = await f.journal.reserve(request(), prepared())
  assert.deepEqual(await f.journal.reserve(request()), row)
  await assert.rejects(f.journal.reserve(request('register_one', '/another/path'), prepared('/another/path')), code('request-conflict'))
  await assert.rejects(f.journal.reserve({ ...request(), authority: { generation: 3, grantRevision: 2 } }), code('request-conflict'))
  assert.equal(f.journal.row('register_one').reservedProjectId, row.reservedProjectId)
})

test('dispatched registration becomes unknown on restart and never retargets a mutable raw alias', async t => {
  const f = await fixture(t), row = await f.journal.reserve(request(), prepared())
  await f.journal.markDispatched('register_one'); await f.reopen()
  assert.equal(f.journal.row('register_one').state, 'unknown')
  assert.deepEqual(await f.journal.reserve(request(), prepared('/retargeted/alias')), f.journal.row('register_one'))
  assert.equal(f.journal.row('register_one').canonicalPath, row.canonicalPath)
  await assert.rejects(f.journal.markDispatched('register_one'), code('outcome-unknown'))
  await assert.rejects(f.journal.reserve(request('register_new'), prepared()), code('outcome-unknown'))
  await assert.rejects(f.journal.commitWorker('register_one'), code('outcome-unknown'))
  assert.deepEqual(f.journal.ownedProjects(), [])
})

test('restart can settle a retained exact native return without dispatching another registry effect', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), prepared()); await f.journal.markDispatched('register_one')
  await f.journal.recordNativeProof('register_one', proof()); await f.reopen()
  assert.equal(f.journal.row('register_one').state, 'unknown')
  assert.equal((await f.journal.commitWorker('register_one')).state, 'committed')
  assert.equal(f.journal.ownedProjects().length, 1)
})

test('a different canonical return cannot become proof or a known pre-dispatch failure', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), prepared()); await f.journal.markDispatched('register_one')
  await assert.rejects(f.journal.recordNativeProof('register_one', proof('/wrong-target')), code('outcome-unknown'))
  await assert.rejects(f.journal.failBeforeDispatch('register_one', 'source-unavailable'), code('outcome-unknown'))
  await f.journal.markUnknown('register_one'); await f.reopen()
  assert.equal(f.journal.row('register_one').nativeProof, undefined)
})

test('preparation of an existing workspace pins its opaque native identity', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), prepared('/worker/canonical', 'existing-id')); await f.journal.markDispatched('register_one')
  await assert.rejects(f.journal.recordNativeProof('register_one', proof('/worker/canonical', 'replacement-id')), code('outcome-unknown'))
  await f.journal.recordNativeProof('register_one', proof('/worker/canonical', 'existing-id'))
  assert.equal((await f.journal.commitWorker('register_one')).nativeProof.workspaceId, 'existing-id')
})

test('same canonical target reuses its remote project without broadening the captured template', async t => {
  const f = await fixture(t), first = await commit(f.journal)
  const wider = { actions: ['project.list', 'session.create', 'model.list'], exportClasses: ['conversation.user', 'tool.result'] }
  const second = await f.journal.reserve(request('register_two', '/another/alias'), { ...prepared(), existingWorkspaceId: proof().workspaceId, projectGrant: wider })
  assert.equal(second.reservedProjectId, first.reservedProjectId); assert.deepEqual(second.projectGrant, template)
  await f.journal.markDispatched('register_two'); await f.journal.recordNativeProof('register_two', proof())
  assert.equal((await f.journal.commitWorker('register_two')).result.ref.projectId, first.reservedProjectId)
  assert.equal(f.journal.ownedProjects().length, 1)
  await f.reopen(); assert.equal(f.journal.ownedProjects()[0].registerRequestId, 'register_one')
})

test('deleting and recreating a canonical workspace cannot silently replace a remote project identity', async t => {
  const f = await fixture(t); await commit(f.journal)
  await assert.rejects(f.journal.reserve(request('register_two'), prepared('/worker/canonical', 'new-native-id')), code('source-unavailable'))
  assert.equal(f.journal.row('register_two'), undefined)
  assert.equal(f.journal.nativeBindings()[0].workspaceId, proof().workspaceId)
})

test('one native Workspace id cannot be rebound to another canonical project target', async t => {
  const f = await fixture(t); await commit(f.journal)
  await assert.rejects(f.journal.reserve(request('register_two'), prepared('/other/canonical', proof().workspaceId)), code('source-unavailable'))
  await f.journal.reserve(request('register_two'), prepared('/other/canonical')); await f.journal.markDispatched('register_two')
  await assert.rejects(f.journal.recordNativeProof('register_two', proof('/other/canonical')), code('outcome-unknown'))
  assert.equal(f.journal.ownedProjects().length, 1)
  const snapshot = f.journal.snapshot(), original = Object.values(snapshot.projects)[0], id = `fpr_${'b'.repeat(32)}`
  const row = Object.values(snapshot.operations).find(value => value.requestId === 'register_two')
  Object.assign(row, { state: 'committed', reservedProjectId: id, nativeProof: proof('/other/canonical'), result: { ref: { machineKey: f.pair.machineKey, projectId: id }, title: proof().title } })
  snapshot.projects[id] = { ...original, projectId: id, canonicalPath: '/other/canonical', registerRequestId: row.requestId }
  await f.journal.close(); await writeFile(f.file, JSON.stringify(snapshot))
  await assert.rejects(openProjectJournal(f.pair), code('invalid-message'))
})

test('a definite refusal before dispatch permits another explicit request but retains the failed identity', async t => {
  const f = await fixture(t)
  await f.journal.reserve(request(), prepared()); await f.journal.failBeforeDispatch('register_one', 'grant-changed')
  await f.journal.reserve(request('register_two'), prepared())
  await assert.rejects(f.journal.markUnknown('register_one'), code('outcome-unknown'))
  await assert.rejects(f.journal.recordNativeProof('register_one', proof()), code('outcome-unknown'))
  assert.equal(f.journal.state('register_one').errorCode, 'grant-changed')
})

test('concurrent new request ids cannot acquire overlapping registration admissions', async t => {
  const f = await fixture(t)
  const results = await Promise.allSettled([f.journal.reserve(request('register_one'), prepared()), f.journal.reserve(request('register_two'), prepared('/other'))])
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 1)
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'outcome-unknown')
  assert.equal(Object.keys(f.journal.snapshot().operations).length, 1)
})

test('Controller rejects another machine receipt and cannot manufacture Worker enrollment', async t => {
  const f = await fixture(t, 'controller')
  await f.journal.reserve(request()); await f.journal.markDispatched('register_one')
  await assert.rejects(f.journal.commitController('register_one', { ref: { machineKey: 'another-worker', projectId: `fpr_${'a'.repeat(32)}` }, title: 'unsafe' }), code('pairing-mismatch'))
  await assert.rejects(f.journal.commitWorker('register_one'), code('pairing-mismatch'))
  assert.equal(f.journal.state('register_one').state, 'dispatched')
})

test('pair rotation refuses the old project file without overwriting its retained identities', async t => {
  const f = await fixture(t); await commit(f.journal); await f.journal.close()
  const before = await readFile(f.file, 'utf8')
  await assert.rejects(openProjectJournal({ ...f.pair, pairingGeneration: 2 }), code('pairing-mismatch'))
  assert.equal(await readFile(f.file, 'utf8'), before)
})

test('an orphaned or modified native proof is corruption rather than automatic ownership recovery', async t => {
  const f = await fixture(t); await commit(f.journal)
  const snapshot = f.journal.snapshot(), project = Object.values(snapshot.projects)[0]
  project.workspaceId = 'tampered-native-id'
  await f.journal.close(); await writeFile(f.file, JSON.stringify(snapshot))
  await assert.rejects(openProjectJournal(f.pair), code('invalid-message'))
})

test('malformed terminal fields cannot clear an uncertain registration barrier on reopen', async t => {
  for (const invalid of [{ state: 'failed' }, { state: 'dispatched', errorCode: 'not-granted' }]) {
    const f = await fixture(t)
    await f.journal.reserve(request(), prepared()); await f.journal.markDispatched('register_one')
    const snapshot = f.journal.snapshot()
    Object.assign(Object.values(snapshot.operations)[0], invalid)
    await f.journal.close(); await writeFile(f.file, JSON.stringify(snapshot))
    await assert.rejects(openProjectJournal(f.pair), code('invalid-message'))
  }
})

test('different paired principals can register one native directory without sharing project or session ownership', async t => {
  const one = await fixture(t), two = await fixture(t)
  two.pair.peerId = 'other-controller'
  await two.journal.close()
  await writeFile(two.file, JSON.stringify({ version: 1, binding: { role: two.pair.role, id: two.pair.id, peerId: two.pair.peerId,
    machineKey: two.pair.machineKey, pairingGeneration: two.pair.pairingGeneration, keyFingerprint: two.pair.keyFingerprint }, operations: {}, projects: {} }))
  await two.reopen()
  const first = await commit(one.journal), second = await commit(two.journal)
  assert.notEqual(first.reservedProjectId, second.reservedProjectId)
  assert.notEqual(one.journal.ownedProjects()[0].principal.id, two.journal.ownedProjects()[0].principal.id)
  assert.equal(JSON.stringify(one.journal.ownedProjects()).includes('sessionIds'), false)
})

test('operation and enrollment capacities reject new identities instead of evicting replay or ownership history', async t => {
  const f = await fixture(t); await commit(f.journal)
  const original = f.journal.snapshot(), sample = Object.values(original.operations)[0], enrolled = Object.values(original.projects)[0]
  const fullOperations = { ...original, operations: {} }
  for (let index = 0; index < 2048; index++) {
    const id = `failed_register_${index}`, row = { ...sample, requestId: id, state: 'failed', errorCode: 'not-granted' }
    delete row.result; delete row.nativeProof; row.reuse = false
    row.digest = digest({ body: row.body, authority: row.authority })
    fullOperations.operations[digest(['controller', f.pair.machineKey, id])] = row
  }
  fullOperations.projects = {}
  await f.replace(fullOperations)
  await assert.rejects(f.journal.reserve(request('capacity_new'), prepared('/new')), code('page-too-large'))
  const fullProjects = { ...original, operations: {}, projects: {} }
  for (let index = 0; index < 256; index++) {
    const id = `committed_register_${index}`, reservedProjectId = `fpr_${index.toString(16).padStart(32, '0')}`
    const canonicalPath = `/native/unique_${index}`, native = { ...proof(canonicalPath), workspaceId: `workspace_${index}` }
    const row = { ...sample, requestId: id, canonicalPath, reservedProjectId, nativeProof: native,
      result: { ref: { machineKey: f.pair.machineKey, projectId: reservedProjectId }, title: native.title } }
    fullProjects.operations[digest(['controller', f.pair.machineKey, id])] = row
    fullProjects.projects[reservedProjectId] = { ...enrolled, ...native, projectId: reservedProjectId, registerRequestId: id }
  }
  await f.replace(fullProjects)
  await assert.rejects(f.journal.reserve(request('capacity_new'), prepared('/new')), code('page-too-large'))
  assert.equal(f.journal.ownedProjects().length, 256)
})
