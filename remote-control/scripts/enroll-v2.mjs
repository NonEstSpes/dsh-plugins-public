#!/usr/bin/env node
/** Offline producer only: never opens native stores, existing settings, or the network. */
import { createHash, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseMachineKey, parseProjectId } from '../lib/federation/identity.mjs'
import { parseGrant, parseProjectGrantTemplate } from '../lib/federation/grants.mjs'

const fail = code => { throw Object.assign(new Error(code), { code }) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const hash = value => createHash('sha256').update(value).digest('hex')
const opaque = prefix => `${prefix}_${randomBytes(18).toString('base64url')}`
const FILES = ['.gitignore', 'controller-pair.json', 'worker-v2.json', 'relay-devices.additions.json', 'manifest.json']

function relayOptions(relayUrl, allowLoopback) {
  if (allowLoopback !== undefined && typeof allowLoopback !== 'boolean') fail('invalid-relay')
  let relay
  try { relay = new URL(relayUrl) } catch { fail('invalid-relay') }
  // Same URL boundary as parseSettingsV2; no DNS lookup or transport is attempted.
  if (typeof relayUrl !== 'string' || /[\s\\?#]/.test(relayUrl) || relay.username || relay.password
    || (relay.protocol !== 'https:' && !(allowLoopback === true && relay.protocol === 'http:'
      && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(relayUrl)))) fail('invalid-relay')
  return { relayUrl, ...(allowLoopback === true ? { allowLoopback: true } : {}) }
}

/**
 * Produce NEW sensitive artifacts in memory; no filesystem, environment or native API access.
 * projectGrant must explicitly provide actions, exportClasses and createdSessionGrant
 * (itself actions + exportClasses). No permissions, native IDs or existing sessions are inferred.
 * controllerId optionally names an existing logical root, NEVER a transport endpoint.
 * Native workspace existence and all state-path checks remain Worker-runtime obligations.
 */
export function stageEnrollmentV2(options) {
  const allowed = ['relayUrl', 'nativeWorkspaceId', 'projectId', 'projectGrant', 'controllerId', 'label', 'allowLoopback']
  if (!record(options) || Object.keys(options).some(key => !allowed.includes(key))) fail('invalid-options')
  const { nativeWorkspaceId, projectId, projectGrant, label } = options
  if (typeof nativeWorkspaceId !== 'string' || !nativeWorkspaceId.trim() || nativeWorkspaceId.length > 256) fail('native-workspace-id-required')
  let controllerId, policy
  try {
    parseProjectId(projectId)
    controllerId = options.controllerId === undefined ? opaque('controller') : parseMachineKey(options.controllerId)
  } catch { fail('invalid-identity') }
  if (label !== undefined && (typeof label !== 'string' || !label || label.length > 128 || /[\u0000-\u001f\u007f]/.test(label))) fail('invalid-label')
  if (!record(projectGrant) || !Object.hasOwn(projectGrant, 'createdSessionGrant')) fail('explicit-project-policy-required')
  try { policy = parseProjectGrantTemplate(projectGrant) } catch { fail('invalid-project-policy') }
  const relay = relayOptions(options.relayUrl, options.allowLoopback)
  const controllerTransportId = opaque('controller_transport'), workerTransportId = opaque('worker_transport')
  const workerId = opaque('worker'), machineKey = opaque('machine')
  const sharedKey = randomBytes(32).toString('base64url')
  const controllerToken = randomBytes(32).toString('base64url')
  let workerToken
  do { workerToken = randomBytes(32).toString('base64url') } while (workerToken === controllerToken)
  const grant = parseGrant({
    version: 1, grantId: opaque('grant'), principal: { kind: 'controller', id: controllerTransportId },
    machineKey, revision: 1, issuedAt: Date.now(),
    projects: [{ projectId, ...policy, sessions: [] }],
  })
  const common = { machineKey, protocol: 2, ...relay, sharedKey, pairingGeneration: 1 }
  const controllerPair = {
    id: controllerTransportId, peerId: workerTransportId, ...common, relayToken: controllerToken,
    stateDir: `./enrollment-v2-state/${controllerTransportId}`, ...(label === undefined ? {} : { label }),
  }
  const worker = {
    version: 2, role: 'worker', id: workerId, machineKey, ...(label === undefined ? {} : { label }),
    projects: { [projectId]: { workspaceId: nativeWorkspaceId } },
    pairs: [{
      id: workerTransportId, peerId: controllerTransportId, ...common, relayToken: workerToken,
      stateDir: `./enrollment-v2-state/${workerTransportId}`, grant,
    }],
  }
  const relayDevices = [
    { id: controllerTransportId, peerId: workerTransportId, tokenHash: hash(controllerToken) },
    { id: workerTransportId, peerId: controllerTransportId, tokenHash: hash(workerToken) },
  ]
  const manifest = {
    format: 'dsh-enrollment-v2-stage', version: 1, controllerId, controllerTransportId, workerId,
    workerTransportId, machineKey, projectId, pairingGeneration: 1,
    keyFingerprint: hash(Buffer.from(sharedKey, 'base64url')),
    projectGrant: JSON.parse(JSON.stringify(policy)), files: [...FILES],
    nativeWorkspaceValidation: 'required-on-worker', controllerApplication: 'whole-config-reparse-required',
    relayApplication: 'additions-only', nativeMutationSandbox: 'current-adapter-uses-danger-full-access', applied: false,
  }
  return { controllerPair, worker, relayDevices, manifest }
}

const HELP = `Offline native-v2 enrollment stager. Sensitive artifacts; NOTHING is applied.
Usage: node scripts/enroll-v2.mjs --out NEW_DIRECTORY --policy REVIEWED_POLICY_JSON
       --relay-url HTTPS_URL --native-workspace-id REAL_NATIVE_ID --project-id PROJECT_ID
       [--controller-id EXISTING_LOGICAL_ROOT_ID] [--label LABEL] [--allow-loopback]

All values are explicit. --policy contains actions, exportClasses, createdSessionGrant.
No session imports or project.register. --allow-loopback permits ONLY exact HTTP loopback
for development. Output parent must already exist, outside all runtime/profile/state paths.
Never prints credentials/payloads. Existing outputs are refused; partial failures are retained.
Read ENROLLMENT-V2.md before running. Applying artifacts requires separate operator consent.
`

function parseCli(argv) {
  if (argv.length === 1 && argv[0] === '--help') return null
  const names = new Map([
    ['--out', 'out'], ['--policy', 'policy'], ['--relay-url', 'relayUrl'],
    ['--native-workspace-id', 'nativeWorkspaceId'], ['--project-id', 'projectId'],
    ['--controller-id', 'controllerId'], ['--label', 'label'], ['--allow-loopback', 'allowLoopback'],
  ])
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const key = names.get(argv[i])
    if (!key || Object.hasOwn(args, key)) fail('invalid-cli-arguments')
    if (key === 'allowLoopback') args[key] = true
    else {
      const value = argv[++i]
      if (!value || value.startsWith('--')) fail('invalid-cli-arguments')
      args[key] = value
    }
  }
  for (const key of ['out', 'policy', 'relayUrl', 'nativeWorkspaceId', 'projectId']) if (!Object.hasOwn(args, key)) fail('missing-cli-arguments')
  return args
}

function inside(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
function assertStagingPath(target) {
  // Path-only guard; no profile/config discovery. The environment value is never opened.
  if (/[\u0000-\u001f\u007f]/.test(target) || target.split(/[\\/]/).some(part => /^(?:\.dsh|profiles?|state|production-state|dsh-runtimes)$/i.test(part))) fail('unsafe-staging-path')
  if (process.env.DSH_HOME && inside(path.resolve(process.env.DSH_HOME), target)) fail('unsafe-staging-path')
}

async function runCli(argv) {
  const args = parseCli(argv)
  if (args === null) { process.stdout.write(HELP); return }
  const { out, policy: policyFile, ...options } = args
  const requested = path.resolve(out), policyPath = path.resolve(policyFile)
  assertStagingPath(requested); assertStagingPath(policyPath)
  // Resolve ONLY operator-specified staging/input paths, never native workspace paths.
  const parent = await realpath(path.dirname(requested))
  const output = path.join(parent, path.basename(requested))
  assertStagingPath(output)
  const input = await realpath(policyPath)
  assertStagingPath(input)
  const inputInfo = await lstat(input)
  if (!inputInfo.isFile() || inputInfo.size > 65536) fail('invalid-policy-file')
  const projectGrant = JSON.parse(await readFile(input, 'utf8'))
  const artifacts = stageEnrollmentV2({ ...options, projectGrant })
  // No recursive mkdir, overwrite, rollback, cleanup, install or application step.
  await mkdir(output, { mode: 0o700 })
  const documents = {
    '.gitignore': '*\n',
    'controller-pair.json': artifacts.controllerPair,
    'worker-v2.json': artifacts.worker,
    'relay-devices.additions.json': artifacts.relayDevices,
    'manifest.json': artifacts.manifest,
  }
  for (const filename of FILES) {
    const value = documents[filename]
    await writeFile(path.join(output, filename), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  process.stdout.write(`Staged five files in ${JSON.stringify(output)}. Nothing applied; operator review required.\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runCli(process.argv.slice(2)) }
  catch {
    // Never echo parser/OS errors, argument values, policy text, keys, or tokens.
    process.stderr.write('Enrollment not completed. Check arguments, reviewed policy, safe paths and NEW output directory. Any partial output is retained; DO NOT apply it. See ENROLLMENT-V2.md.\n')
    process.exitCode = 1
  }
}
