import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { parseSettingsV2 } from '../lib/federation/settings.mjs'
import { evaluateGrant } from '../lib/federation/grants.mjs'

const script = fileURLToPath(new URL('../scripts/enroll-v2.mjs', import.meta.url))
const loadProducer = async () => (await import('../scripts/enroll-v2.mjs')).stageEnrollmentV2
const sha256 = value => createHash('sha256').update(value).digest('hex')
const runCli = (args, env) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000, ...(env ? { env } : {}) })
const cliArgs = (out, policyFile) => ['--out', out, '--policy', policyFile, '--relay-url', 'https://relay.invalid', '--native-workspace-id', 'owned-native-workspace-fixture', '--project-id', 'fixture-project']

const policy = () => ({
  actions: ['project.list', 'session.list', 'session.create'],
  exportClasses: ['conversation.user', 'conversation.assistant'],
  createdSessionGrant: {
    actions: ['session.status', 'session.read', 'session.prompt', 'session.cancel'],
    exportClasses: ['conversation.user', 'conversation.assistant'],
  },
})
const options = () => ({ relayUrl: 'https://relay.invalid', nativeWorkspaceId: 'owned-native-workspace-fixture', projectId: 'fixture-project', projectGrant: policy() })

async function fixture(t) {
  const parent = await realpath(os.tmpdir())
  const root = await realpath(await mkdtemp(path.join(parent, 'dsh-enroll-v2-test-')))
  t.after(async () => {
    const target = await realpath(root)
    assert.ok(path.isAbsolute(target))
    assert.equal(target, root)
    assert.equal(path.dirname(target), parent)
    assert.ok(path.basename(target).startsWith('dsh-enroll-v2-test-'))
    await rm(target, { recursive: true, force: true })
  })
  return root
}

test('stageEnrollmentV2 produces a pair fragment and Worker document accepted by current v2 settings', async t => {
  const { stageEnrollmentV2 } = await import('../scripts/enroll-v2.mjs')
  const root = await fixture(t), workspace = path.join(root, 'workspace')
  await mkdir(workspace)
  const result = stageEnrollmentV2(options())
  const controller = await parseSettingsV2({ version: 2, role: 'controller', id: result.manifest.controllerId, pairs: [result.controllerPair] }, path.join(root, 'controller.json'))
  const worker = await parseSettingsV2(result.worker, path.join(root, 'worker.json'), {
    resolveWorkspace: id => id === options().nativeWorkspaceId ? { path: workspace } : undefined,
  })
  assert.equal(controller.pairs[0].peerId, worker.pairs[0].id)
  assert.equal(worker.projects['fixture-project'].workspaceId, options().nativeWorkspaceId)
  assert.equal(worker.pairs[0].grant.version, 1)
  assert.deepEqual(worker.pairs[0].grant.projects[0].sessions, [])
})

test('keys, device hashes and exact grant binding are isolated from safe outputs', async () => {
  const stage = await loadProducer()
  const result = stage({ ...options(), controllerId: 'existing_root_fixture', label: 'Fixture Worker' })
  const cp = result.controllerPair, wp = result.worker.pairs[0], grant = wp.grant
  assert.equal(Buffer.from(cp.sharedKey, 'base64url').length, 32)
  assert.equal(cp.sharedKey, wp.sharedKey)
  assert.equal(cp.peerId, wp.id); assert.equal(wp.peerId, cp.id)
  assert.notEqual(cp.relayToken, wp.relayToken)
  assert.equal(Buffer.from(cp.relayToken, 'base64url').length, 32)
  assert.equal(Buffer.from(wp.relayToken, 'base64url').length, 32)
  assert.equal(result.manifest.keyFingerprint, sha256(Buffer.from(cp.sharedKey, 'base64url')))
  assert.equal(result.manifest.controllerId, 'existing_root_fixture')
  assert.notEqual(cp.id, result.manifest.controllerId)
  assert.equal(new Set([cp.id, wp.id, result.worker.id, result.worker.machineKey, result.manifest.controllerId]).size, 5)
  assert.equal(cp.machineKey, result.worker.machineKey); assert.equal(wp.machineKey, result.worker.machineKey)
  assert.equal(cp.pairingGeneration, 1); assert.equal(wp.pairingGeneration, 1)
  assert.deepEqual(grant.principal, { kind: 'controller', id: cp.id })
  assert.equal(grant.machineKey, cp.machineKey); assert.equal(grant.version, 1); assert.equal(grant.revision, 1)
  assert.equal(grant.projects.length, 1); assert.deepEqual(grant.projects[0], { projectId: 'fixture-project', ...policy(), sessions: [] })
  assert.equal(Object.hasOwn(grant, 'projectRegistration'), false)
  assert.equal(Object.hasOwn(cp, 'grant'), false)
  assert.equal(Object.hasOwn(result, 'controller'), false, 'never return a replacement Controller document')
  assert.deepEqual(Object.keys(result.worker.projects), ['fixture-project'])
  for (const [entry, pair] of [[result.relayDevices[0], cp], [result.relayDevices[1], wp]]) {
    assert.deepEqual(Object.keys(entry).sort(), ['id', 'peerId', 'tokenHash'])
    assert.equal(entry.id, pair.id); assert.equal(entry.peerId, pair.peerId)
    assert.equal(entry.tokenHash, sha256(pair.relayToken))
    assert.match(entry.tokenHash, /^[a-f0-9]{64}$/)
    assert.equal(path.isAbsolute(pair.stateDir), false)
  }
  assert.notEqual(result.relayDevices[0].tokenHash, result.relayDevices[1].tokenHash)
  const safe = JSON.stringify([result.relayDevices, result.manifest])
  for (const secret of [cp.sharedKey, cp.relayToken, wp.relayToken, options().nativeWorkspaceId, 'Fixture Worker', options().relayUrl]) assert.equal(safe.includes(secret), false)
})

test('independent stages remain distinct under one root and never admit existing sessions or another machine', async t => {
  const stage = await loadProducer(), root = await fixture(t)
  const a = stage({ ...options(), controllerId: 'same_root_fixture' }), b = stage({ ...options(), controllerId: 'same_root_fixture' })
  for (const field of ['id', 'peerId', 'machineKey', 'sharedKey', 'relayToken', 'stateDir']) assert.notEqual(a.controllerPair[field], b.controllerPair[field])
  assert.notEqual(a.worker.id, b.worker.id)
  assert.notEqual(a.worker.pairs[0].relayToken, b.worker.pairs[0].relayToken)
  const parsed = await parseSettingsV2({ version: 2, role: 'controller', id: 'same_root_fixture', pairs: [a.controllerPair, b.controllerPair] }, path.join(root, 'candidate-controller.json'))
  assert.equal(parsed.pairs.length, 2)
  const grant = a.worker.pairs[0].grant, evaluation = { currentRevision: 1, now: grant.issuedAt }
  const base = { principal: grant.principal, machineKey: grant.machineKey, projectId: 'fixture-project' }
  assert.equal(evaluateGrant(grant, { ...base, action: 'project.list' }, evaluation).allowed, true)
  assert.equal(evaluateGrant(grant, { ...base, action: 'project.list', machineKey: b.worker.machineKey }, evaluation).allowed, false)
  assert.equal(evaluateGrant(grant, { ...base, action: 'project.list', principal: b.worker.pairs[0].grant.principal }, evaluation).allowed, false)
  assert.equal(evaluateGrant(grant, { ...base, action: 'project.list', projectId: 'not-this-project' }, evaluation).allowed, false)
  assert.equal(evaluateGrant(grant, { principal: grant.principal, machineKey: grant.machineKey, action: 'project.register' }, evaluation).allowed, false)
  const request = { ...base, action: 'session.prompt', sessionId: 'owned-new-session-fixture' }
  assert.equal(evaluateGrant(grant, request, evaluation).allowed, false, 'an existing SID is not adopted')
  const remoteOwnedSessions = [{ ...base, sessionId: request.sessionId, createRequestId: 'fixture_create_001', state: 'committed' }]
  assert.equal(evaluateGrant(grant, request, { ...evaluation, remoteOwnedSessions }).allowed, true, 'only verified ownership enables the explicit new-session template')
})

test('native workspace ID is explicit and opaque; foreign OS paths are not runtime validation', async t => {
  const stage = await loadProducer(), root = await fixture(t)
  for (const nativeWorkspaceId of [undefined, null, '', '   ', 'x'.repeat(257)]) assert.throws(() => stage({ ...options(), nativeWorkspaceId }), /native-workspace-id-required/)
  assert.throws(() => stage({ ...options(), workspacePath: '/not-an-id' }), /invalid-options/)
  const opaqueId = 'opaque/native:workspace fixture'
  const result = stage({ ...options(), nativeWorkspaceId: opaqueId })
  assert.equal(result.worker.projects['fixture-project'].workspaceId, opaqueId)
  const foreign = process.platform === 'win32' ? '/home/fixture/workspace' : 'C:\\fixture\\workspace'
  assert.notEqual(path.resolve(foreign), foreign, 'host path interpretation is not foreign native resolution')
  // Windows accepts slash-root paths as current-drive absolute. Do not stat that unowned path.
  assert.equal(path.isAbsolute(foreign), process.platform === 'win32')
  const workspace = path.join(root, 'owned-native-workspace')
  await mkdir(workspace)
  const parsed = await parseSettingsV2(result.worker, path.join(root, 'worker.json'), { resolveWorkspace: id => { assert.equal(id, opaqueId); return { path: workspace } } })
  assert.equal(parsed.projects['fixture-project'].root, await realpath(workspace))
  await assert.rejects(parseSettingsV2(result.worker, path.join(root, 'worker.json')), /projects must resolve exact native Worker workspaces/)
})

test('policy is required, exact, explicitly bounded and never mutated or silently widened', async () => {
  const stage = await loadProducer(), input = options(), before = structuredClone(input)
  const output = stage(input)
  assert.deepEqual(input, before)
  assert.notEqual(output.manifest.projectGrant, input.projectGrant)
  assert.throws(() => stage({ ...options(), projectGrant: undefined }), /explicit-project-policy-required/)
  const noTemplate = policy(); delete noTemplate.createdSessionGrant
  assert.throws(() => stage({ ...options(), projectGrant: noTemplate }), /explicit-project-policy-required/)
  for (const projectGrant of [
    { ...policy(), actions: ['project.register'] },
    { ...policy(), actions: ['project.list', 'project.list'] },
    { ...policy(), exportClasses: ['*'] },
    { ...policy(), allowedRoots: ['/fixture'] },
    { ...policy(), sessions: [{ sessionId: 'old-fixture', imported: true, actions: [] }] },
    { ...policy(), createdSessionGrant: { actions: ['session.prompt'], exportClasses: ['tool.result'] } },
    { ...policy(), createdSessionGrant: { actions: ['session.create'], exportClasses: [] } },
  ]) assert.throws(() => stage({ ...options(), projectGrant }), /invalid-project-policy/)
  for (const extra of [{ sharedKey: 'existing-key' }, { machineKey: 'old-machine' }, { sessionId: 'old-session' }, { stateDir: './existing-state' }]) assert.throws(() => stage({ ...options(), ...extra }), /invalid-options/)
  const readonly = { actions: ['project.list', 'session.list', 'model.list'], exportClasses: [], createdSessionGrant: { actions: [], exportClasses: [] } }
  assert.deepEqual(stage({ ...options(), projectGrant: readonly }).worker.pairs[0].grant.projects[0], { projectId: 'fixture-project', ...readonly, sessions: [] })
})

test('relay URL boundary rejects unsafe URLs and only opts in exact development loopback', async t => {
  const stage = await loadProducer(), root = await fixture(t)
  for (const relayUrl of ['http://relay.invalid', 'http://127.0.0.1.evil.invalid', 'http://2130706433', 'http://127.1', 'http://localhost.evil.invalid', 'http://LOCALHOST', 'https://user:password@relay.invalid', 'https://relay.invalid?token=fixture', 'https://relay.invalid#fixture', 'file:///fixture']) {
    assert.throws(() => stage({ ...options(), relayUrl, allowLoopback: true }), /invalid-relay/)
  }
  for (const relayUrl of ['https://relay.invalid/with space', 'https://relay.invalid\\fixture', '', undefined]) assert.throws(() => stage({ ...options(), relayUrl }), /invalid-relay/)
  for (const relayUrl of ['http://127.0.0.1:12345/path', 'http://localhost', 'http://[::1]:12345/']) {
    assert.throws(() => stage({ ...options(), relayUrl }), /invalid-relay/)
    const result = stage({ ...options(), relayUrl, allowLoopback: true })
    assert.equal(result.controllerPair.allowLoopback, true)
    await parseSettingsV2({ version: 2, role: 'controller', id: result.manifest.controllerId, pairs: [result.controllerPair] }, path.join(root, 'controller.json'))
  }
  assert.throws(() => stage({ ...options(), allowLoopback: 'true' }), /invalid-relay/)
  assert.equal(Object.hasOwn(stage(options()).controllerPair, 'allowLoopback'), false)
})

test('CLI writes only a private new bundle and never emits secrets or policy payloads', async t => {
  const root = await fixture(t), policyFile = path.join(root, 'reviewed-policy.json'), out = path.join(root, 'new-bundle')
  const policyText = `${JSON.stringify(policy(), null, 2)}\n`
  await writeFile(policyFile, policyText, { flag: 'wx' })
  const result = runCli(cliArgs(out, policyFile))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.match(result.stdout, /Staged five files/)
  assert.deepEqual((await readdir(out)).sort(), ['.gitignore', 'controller-pair.json', 'manifest.json', 'relay-devices.additions.json', 'worker-v2.json'].sort())
  assert.equal(await readFile(path.join(out, '.gitignore'), 'utf8'), '*\n')
  const cp = JSON.parse(await readFile(path.join(out, 'controller-pair.json'), 'utf8'))
  const worker = JSON.parse(await readFile(path.join(out, 'worker-v2.json'), 'utf8'))
  const relay = await readFile(path.join(out, 'relay-devices.additions.json'), 'utf8')
  const manifest = await readFile(path.join(out, 'manifest.json'), 'utf8')
  for (const secret of [cp.sharedKey, cp.relayToken, worker.pairs[0].relayToken]) {
    assert.equal(result.stdout.includes(secret), false); assert.equal(result.stderr.includes(secret), false)
    assert.equal(relay.includes(secret), false); assert.equal(manifest.includes(secret), false)
  }
  assert.equal(result.stdout.includes('session.prompt'), false)
  assert.equal(await readFile(policyFile, 'utf8'), policyText)
  if (process.platform !== 'win32') {
    assert.equal((await stat(out)).mode & 0o777, 0o700)
    for (const name of await readdir(out)) assert.equal((await stat(path.join(out, name))).mode & 0o777, 0o600)
  }
})

test('CLI refuses existing output directories/files and missing parents without changing input/output', async t => {
  const root = await fixture(t), policyFile = path.join(root, 'policy.json'), out = path.join(root, 'existing')
  const text = JSON.stringify(policy())
  await writeFile(policyFile, text, { flag: 'wx' }); await mkdir(out)
  const sentinel = path.join(out, 'retained.txt')
  await writeFile(sentinel, 'owned sentinel', { flag: 'wx' })
  const existingFile = path.join(root, 'existing-file')
  await writeFile(existingFile, 'owned existing file', { flag: 'wx' })
  for (const target of [out, existingFile, path.join(root, 'missing-parent', 'bundle')]) {
    const result = runCli(cliArgs(target, policyFile))
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.match(result.stderr, /partial output is retained/)
  }
  assert.deepEqual(await readdir(out), ['retained.txt'])
  assert.equal(await readFile(sentinel, 'utf8'), 'owned sentinel')
  assert.equal(await readFile(existingFile, 'utf8'), 'owned existing file')
  assert.equal(await readFile(policyFile, 'utf8'), text)
  await assert.rejects(stat(path.join(root, 'missing-parent')), { code: 'ENOENT' })
})

test('CLI requires reviewed policy and explicit flags; invalid input never leaks raw values or creates output', async t => {
  const root = await fixture(t), input = path.join(root, 'bad-policy.json'), out = path.join(root, 'not-created')
  const marker = 'PRIVATE_TEST_PAYLOAD_NOT_FOR_STDOUT'
  await writeFile(input, JSON.stringify({ ...policy(), [marker]: marker }), { flag: 'wx' })
  const validArgs = cliArgs(out, input)
  for (const args of [[], validArgs.slice(0, 2), [...validArgs, '--unknown', marker], [...validArgs, '--project-id', marker], validArgs]) {
    const result = runCli(args)
    assert.equal(result.status, 1); assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes(marker), false)
    assert.equal(result.stderr.includes('Error:'), false)
    await assert.rejects(stat(out), { code: 'ENOENT' })
  }
  assert.equal(JSON.parse(await readFile(input, 'utf8'))[marker], marker)
})

test('CLI help is bounded and protected staging paths are refused before reads/writes', async t => {
  const help = runCli(['--help'])
  assert.equal(help.status, 0); assert.equal(help.stderr, '')
  assert.match(help.stdout, /NOTHING is applied/); assert.ok(help.stdout.length < 1600)
  const root = await fixture(t), input = path.join(root, 'policy.json')
  await writeFile(input, JSON.stringify(policy()), { flag: 'wx' })
  const reserved = path.join(root, 'state')
  await mkdir(reserved)
  const result = runCli(cliArgs(path.join(reserved, 'bundle'), input))
  assert.equal(result.status, 1); assert.deepEqual(await readdir(reserved), [])
  const envExcluded = runCli(cliArgs(path.join(root, 'excluded-bundle'), input), { ...process.env, DSH_HOME: root })
  assert.equal(envExcluded.status, 1)
  await assert.rejects(stat(path.join(root, 'excluded-bundle')), { code: 'ENOENT' })
})
