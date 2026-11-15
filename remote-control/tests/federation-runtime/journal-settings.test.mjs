import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, realpath, stat, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomBytes } from 'node:crypto'
import { parseSettingsV2 } from '../../lib/federation/settings.mjs'
import { openFederationJournal } from '../../lib/federation/journal.mjs'
import { evaluateGrant, effectiveSessionEntries } from '../../lib/federation/grants.mjs'

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dsh-fed-journal-')))
  t.after(async () => { const target = await realpath(root); assert.equal(path.dirname(target), await realpath(os.tmpdir())); assert.ok(path.basename(target).startsWith('dsh-fed-journal-')); await rm(target, { recursive: true, force: true }) })
  return root
}
const principal = { kind: 'controller', id: 'controller-endpoint' }
const classes = ['conversation.user', 'conversation.assistant', 'turn']
const grant = (revision = 3) => ({ version: 1, grantId: 'grant_fixture', principal, machineKey: 'stable-worker', revision, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list', 'session.list', 'session.create', 'model.list'], exportClasses: classes, createdSessionGrant: { actions: ['session.status', 'session.read', 'session.follow', 'session.prompt'], exportClasses: classes }, sessions: [{ sessionId: 'session-1', imported: true, actions: ['session.read'], exportClasses: classes }] }] })
const pair = root => ({ role: 'worker', id: 'worker-endpoint', peerId: principal.id, machineKey: 'stable-worker', pairingGeneration: 1, keyFingerprint: 'a'.repeat(64), stateDir: path.join(root, 'state') })
const mutation = (id = 'request_fixture', action = 'session.prompt', target = { machineKey: 'stable-worker', projectId: 'demo', sessionId: 'session-1' }) => ({ principal: principal.id, machineKey: 'stable-worker', requestId: id, action, target, body: { text: 'fixture', expected: { generation: 1, frontierSeq: 0, selection: { provider: 'p', model: 'A' } } }, ...(action === 'session.prompt' ? { guard: { selection: { provider: 'p', model: 'A' } } } : {}) })

test('a refusal during reconciliation cannot disprove the original unknown effect or unlock a new ID', async t => {
  const root = await fixture(t), controllerPair = { ...pair(root), role: 'controller', id: principal.id, peerId: 'worker-endpoint' }
  let journal = await openFederationJournal(controllerPair), dispatches = 0
  const operation = mutation('retained_original_operation')
  try {
    await assert.rejects(journal.execute(operation, async tx => { await tx.dispatch(); dispatches++; throw new Error('original acknowledgement lost') }), { code: 'outcome-unknown' })
    for (const code of ['not-granted', 'grant-changed', 'action-unsupported']) {
      const refusal = Object.assign(new Error('must not export remote payload'), { code, remoteRefusal: true })
      await assert.rejects(journal.execute(operation, () => { throw new Error('must not redispatch') }, async () => { throw refusal }), { code: 'outcome-unknown' })
      assert.equal(Object.values(journal.snapshot().operations)[0].state, 'unknown')
      await assert.rejects(journal.execute({ ...operation, requestId: 'replacement_operation' }, async () => { dispatches++; return {} }), { code: 'outcome-unknown' })
    }
    await journal.close(); journal = await openFederationJournal(controllerPair)
    assert.equal(Object.values(journal.snapshot().operations)[0].state, 'unknown')
    const settled = await journal.execute(operation, () => { throw new Error('must not redispatch') }, async () => ({ accepted: true }))
    assert.deepEqual(settled, { accepted: true })
    assert.equal(Object.values(journal.snapshot().operations)[0].state, 'committed')
    assert.equal(dispatches, 1)
  } finally { await journal.close() }
})

for (const role of ['worker', 'controller']) {
  test(`${role} result serialization after dispatch remains unknown and blocks a new operation ID`, async t => {
    const root = await fixture(t), workerPair = pair(root)
    const selectedPair = role === 'worker' ? workerPair : { ...workerPair, role, id: principal.id, peerId: 'worker-endpoint' }
    const journal = await openFederationJournal(selectedPair), operation = mutation('invalid_receipt_operation')
    let effects = 0
    try {
      await assert.rejects(journal.execute(operation, async tx => { await tx.dispatch(); effects++; return { invalid: 1n } }), { code: 'outcome-unknown' })
      assert.equal(Object.values(journal.snapshot().operations)[0].state, 'unknown')
      await assert.rejects(journal.execute({ ...operation, requestId: 'new_id_after_invalid_receipt' }, async () => { effects++; return {} }), { code: 'outcome-unknown' })
      assert.equal(effects, 1)
    } finally { await journal.close() }
  })
}

test('Controller create state reads only its exact project and never dispatches or replays', async t => {
  const root = await fixture(t)
  const controllerPair = { ...pair(root), role: 'controller', id: principal.id, peerId: 'worker-endpoint' }
  let journal = await openFederationJournal(controllerPair)
  const target = { machineKey: controllerPair.machineKey, projectId: 'demo' }
  const operation = { principal: principal.id, machineKey: target.machineKey, requestId: 'create_state_exact', action: 'session.create', target, body: {} }
  let entered, release, calls = 0
  const started = new Promise(resolve => { entered = resolve }), gate = new Promise(resolve => { release = resolve })
  try {
    assert.deepEqual(journal.getCreateState(target), { state: 'idle' })
    const active = journal.execute(operation, async tx => { calls++; await tx.dispatch(); entered(); await gate; return { ...target, sessionId: 'native-created' } })
    await started
    assert.deepEqual(journal.getCreateState(target), { state: 'pending', requestId: operation.requestId })
    assert.deepEqual(journal.getCreateState({ ...target, projectId: 'other' }), { state: 'idle' })
    assert.throws(() => journal.getCreateState({ ...target, machineKey: 'wrong-machine' }), { code: 'source-unavailable' })
    release(); await active
    assert.deepEqual(journal.getCreateState(target), { state: 'committed', requestId: operation.requestId, ref: { ...target, sessionId: 'native-created' } })
    assert.notEqual(journal.snapshot().operations[Object.keys(journal.snapshot().operations)[0]].reservedSessionId, 'native-created', 'never return the Controller-only reserved ID')
    const latest = { ...operation, requestId: 'create_state_latest' }
    await journal.execute(latest, async tx => { calls++; await tx.dispatch(); return { ...target, sessionId: 'native-created-latest' } })
    await journal.close(); journal = await openFederationJournal(controllerPair)
    assert.deepEqual(journal.getCreateState(target), { state: 'committed', requestId: latest.requestId, ref: { ...target, sessionId: 'native-created-latest' } })
    const unknown = { ...operation, requestId: 'create_state_unknown' }
    await assert.rejects(journal.execute(unknown, async tx => { calls++; await tx.dispatch(); throw new Error('native outcome uncertain') }), { code: 'outcome-unknown' })
    await journal.close(); journal = await openFederationJournal(controllerPair)
    assert.deepEqual(journal.getCreateState(target), { state: 'unknown', requestId: unknown.requestId })
    assert.deepEqual(journal.getCreateState(target), { state: 'unknown', requestId: unknown.requestId })
    const invalidTarget = { ...target, projectId: 'invalid-result' }
    await journal.execute({ ...operation, requestId: 'create_invalid_result', target: invalidTarget }, async tx => { await tx.dispatch(); return { ...target, sessionId: 'wrong-project-native' } })
    assert.throws(() => journal.getCreateState(invalidTarget), { code: 'outcome-unknown' }, 'do not expose a committed native ref from another project')
    assert.equal(calls, 3, 'read/restart must not invoke executors')
  } finally { release?.(); await journal.close() }
})

test('v2 settings resolves native workspaces without policy overrides and validates every path before writing', async t => {
  const root = await fixture(t), projectRoot = path.join(root, 'project')
  await mkdir(projectRoot)
  const endpoint = { id: 'worker-endpoint', peerId: principal.id, machineKey: 'stable-worker', protocol: 2, pairingGeneration: 1, relayUrl: 'https://relay.invalid', relayToken: 'worker_token_fixture_0123456789', sharedKey: randomBytes(32).toString('base64url'), stateDir: './state', grant: grant() }
  const config = { version: 2, role: 'worker', id: 'logical-worker', machineKey: 'stable-worker', projects: { demo: { workspaceId: 'actual-native-workspace' } }, pairs: [endpoint] }
  const resolveWorkspace = id => id === 'actual-native-workspace' ? { path: projectRoot } : undefined
  const parsed = await parseSettingsV2(config, path.join(root, 'settings.json'), { resolveWorkspace })
  assert.equal(parsed.pairs[0].id, 'worker-endpoint')
  assert.equal(parsed.machineKey, 'stable-worker')
  assert.equal(parsed.projects.demo.workspaceId, 'actual-native-workspace')
  assert.equal(Object.hasOwn(parsed.projects.demo, 'allowedTools'), false)
  await assert.rejects(stat(path.join(root, 'state')), { code: 'ENOENT' })
  await assert.rejects(parseSettingsV2({ ...config, projects: { demo: { workspaceId: 'actual-native-workspace', allowedTools: [] } } }, path.join(root, 'settings.json'), { resolveWorkspace }))
  await assert.rejects(parseSettingsV2({ ...config, pairs: [{ ...endpoint, stateDir: path.join(projectRoot, 'secret-state') }] }, path.join(root, 'settings.json'), { resolveWorkspace }))
  await assert.rejects(stat(path.join(projectRoot, 'secret-state')), { code: 'ENOENT' })
  await assert.rejects(parseSettingsV2({ ...config, pairs: [{ ...endpoint, grant: { ...grant(), principal: { kind: 'controller', id: 'wrong-endpoint' } } }] }, path.join(root, 'settings.json'), { resolveWorkspace }))
})

test('Controller pairs reject reused credentials, endpoint IDs, machines and overlapping canonical state roots', async t => {
  const root = await fixture(t)
  const first = { id: 'controller-a', peerId: 'worker-a', machineKey: 'machine-a', protocol: 2, pairingGeneration: 1, relayUrl: 'https://relay.invalid', relayToken: 'controller_a_token_0123456789', sharedKey: randomBytes(32).toString('base64url'), stateDir: './a' }
  const second = { ...first, id: 'controller-b', peerId: 'worker-b', machineKey: 'machine-b', relayToken: 'controller_b_token_0123456789', sharedKey: randomBytes(32).toString('base64url'), stateDir: './b' }
  const rootConfig = pairs => ({ version: 2, role: 'controller', id: 'logical-controller', pairs })
  assert.equal((await parseSettingsV2(rootConfig([first, second]), path.join(root, 'settings.json'))).pairs.length, 2)
  for (const altered of [{ ...second, id: first.id }, { ...second, peerId: first.peerId }, { ...second, machineKey: first.machineKey }, { ...second, sharedKey: first.sharedKey }, { ...second, relayToken: first.relayToken }, { ...second, stateDir: './a/child' }, { ...second, stateDir: './b/../a' }]) {
    await assert.rejects(parseSettingsV2(rootConfig([first, altered]), path.join(root, 'settings.json')))
  }
  await assert.rejects(stat(path.join(root, 'a')), { code: 'ENOENT' })
})

test('durable numeric grant authority rejects rollback, same-revision changes and withdrawn revision reuse', async t => {
  const root = await fixture(t)
  let journal = await openFederationJournal(pair(root))
  try {
    await journal.installGrant(grant())
    const generation = journal.snapshot().generation
    await journal.installGrant(grant())
    assert.equal(journal.snapshot().generation, generation)
    const changed = grant(); changed.projects[0].actions = ['project.list']
    await assert.rejects(journal.installGrant(changed), { code: 'grant-changed' })
    await assert.rejects(journal.installGrant(grant(2)), { code: 'grant-changed' })
    await journal.installGrant(null)
    await assert.rejects(journal.installGrant(grant()), { code: 'grant-changed' })
    await journal.close()
    journal = await openFederationJournal(pair(root))
    assert.equal(journal.snapshot().lastGrantRevision, 3)
    assert.equal(journal.snapshot().grant, null)
    await assert.rejects(journal.installGrant(grant()), { code: 'grant-changed' })
    await journal.installGrant(grant(4))
  } finally { await journal.close() }
  await assert.rejects(openFederationJournal({ ...pair(root), pairingGeneration: 2 }), { code: 'pairing-mismatch' })
})

test('body digest commits before native dispatch and same-ID replay never reexecutes', async t => {
  const root = await fixture(t), journal = await openFederationJournal(pair(root))
  try {
    let effects = 0
    const op = mutation()
    const result = await journal.execute(op, async transaction => {
      const intent = Object.values(journal.snapshot().operations)[0]
      assert.equal(intent.state, 'intent')
      assert.match(intent.digest, /^[a-f0-9]{64}$/)
      await transaction.dispatch(); effects++
      return { accepted: true }
    })
    assert.deepEqual(result, { accepted: true })
    assert.deepEqual(await journal.execute(op, () => { effects++; }), result)
    assert.equal(effects, 1)
    await assert.rejects(journal.execute({ ...op, body: { ...op.body, text: 'different' } }, () => { effects++; }), { code: 'request-conflict' })
    assert.equal(effects, 1)
    const nativeRequestId = Object.values(journal.snapshot().operations)[0].nativeRequestId
    assert.match(nativeRequestId, /^frpc_[a-f0-9]{64}$/)
    assert.deepEqual(journal.guardsFor('session-1'), [{ requestId: op.requestId, nativeRequestId, expected: { provider: 'p', model: 'A' }, projectId: 'demo' }])
  } finally { await journal.close() }
})

test('dispatch failure remains unknown across restart and locks new IDs for the same target', async t => {
  const root = await fixture(t)
  let journal = await openFederationJournal(pair(root)), effects = 0
  const op = mutation('request_unknown')
  try {
    await assert.rejects(journal.execute(op, async transaction => { await transaction.dispatch(); effects++; throw new Error('SECRET_NATIVE_FAILURE') }), { code: 'outcome-unknown' })
    await journal.close(); journal = await openFederationJournal(pair(root))
    await assert.rejects(journal.execute(op, () => { effects++; }), { code: 'outcome-unknown' })
    await assert.rejects(journal.execute(mutation('request_new_id'), () => { effects++; }), { code: 'outcome-unknown' })
    assert.equal(effects, 1)
    assert.equal(journal.guardsFor('session-1').length, 1)
  } finally { await journal.close() }
})

test('created enrollment/result/proof commits atomically and current template cannot broaden explicit denial', async t => {
  const root = await fixture(t), journal = await openFederationJournal(pair(root))
  try {
    await journal.installGrant(grant())
    const op = mutation('create_fixture', 'session.create', { machineKey: 'stable-worker', projectId: 'demo' })
    const ref = await journal.execute(op, async transaction => { await transaction.dispatch(); return { ...op.target, sessionId: transaction.reservedSessionId } })
    const state = journal.snapshot(), proof = Object.values(state.remoteOwnedSessions)
    assert.equal(proof.length, 1)
    assert.equal(proof[0].sessionId, ref.sessionId)
    const options = { currentRevision: 3, now: 1, remoteOwnedSessions: proof }
    const request = { principal, machineKey: 'stable-worker', projectId: 'demo', sessionId: ref.sessionId, action: 'session.read', exportClasses: classes }
    assert.equal(evaluateGrant(grant(), request, options).allowed, true)
    const denied = grant(); denied.projects[0].sessions.push({ sessionId: ref.sessionId, imported: false, actions: [] })
    assert.equal(evaluateGrant(denied, request, options).allowed, false)
    denied.projects[0].sessions.at(-1).imported = true
    assert.equal(evaluateGrant(denied, request, options).allowed, false)
    const removed = grant(); delete removed.projects[0].createdSessionGrant
    assert.equal(evaluateGrant(removed, request, options).allowed, false)
    assert.equal(effectiveSessionEntries(grant(), 'demo', { ...options, remoteOwnedSessions: [] }).length, 1)
  } finally { await journal.close() }
})
