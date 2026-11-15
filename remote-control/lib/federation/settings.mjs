/** Explicit opt-in v2 configuration; v1 parsing and files remain owned by the legacy host. */
import path from 'node:path'
import { realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parseGrant } from './grants.mjs'
import { parseMachineKey, parseProjectId, FederationContractError } from './identity.mjs'

const fail = message => { throw new FederationContractError('federation/invalid-settings', message) }
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
function exact(value, required, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('invalid v2 configuration fields')
}
const positive = n => Number.isSafeInteger(n) && n > 0
const json = value => JSON.parse(JSON.stringify(value))

/** Resolve an existing directory or its nearest existing ancestor without any mkdir/write.
 * @param {string} target - absolute target path.
 * @returns {Promise<string>} canonical target, including not-yet-created suffix.
 */
export async function canonicalStateDirectory(target) {
  const suffix = []
  let current = target
  for (;;) {
    try { return path.join(await realpath(current), ...suffix.reverse()) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = path.dirname(current)
      if (parent === current) fail('state directory has no resolvable ancestor')
      suffix.push(path.basename(current)); current = parent
    }
  }
}
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value
const overlaps = (a, b) => {
  const relative = path.relative(keyPath(a), keyPath(b))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Validate all canonical paths and pair credentials before opening any state store.
 * @param {unknown} value - explicit manually paired root version2 document.
 * @param {string} filename - absolute config filename, used only to resolve state paths.
 * @returns {Promise<Readonly<object>>} validated v2 settings; credentials stay private.
 */
export async function parseSettingsV2(value, filename, { resolveWorkspace } = {}) {
  exact(value, ['version', 'role', 'id', 'pairs'], ['machineKey', 'label', 'projects'])
  if (value.version !== 2 || !['controller', 'worker'].includes(value.role)) fail('v2 must be explicitly selected')
  const id = parseMachineKey(value.id)
  const workerMachineKey = value.role === 'worker' ? parseMachineKey(value.machineKey) : undefined
  if (value.role === 'controller' && value.machineKey !== undefined) fail('Controller root cannot declare a Worker machine identity')
  if (value.label !== undefined && (typeof value.label !== 'string' || !value.label || value.label.length > 128 || /[\u0000-\u001f\u007f]/.test(value.label))) fail('invalid machine label')
  if (!Array.isArray(value.pairs) || value.pairs.length < 1 || value.pairs.length > 16 || (value.role === 'worker' && value.pairs.length !== 1)) fail('invalid paired endpoint count')
  const projects = {}
  if (value.projects !== undefined && !record(value.projects)) fail('projects must be explicit entries')
  for (const [projectId, entry] of Object.entries(value.projects ?? {})) {
    parseProjectId(projectId)
    exact(entry, ['workspaceId'], ['title'])
    if (value.role !== 'worker' || typeof entry.workspaceId !== 'string' || !entry.workspaceId || entry.workspaceId.length > 256 || typeof resolveWorkspace !== 'function') fail('projects must resolve exact native Worker workspaces')
    const workspace = await resolveWorkspace(entry.workspaceId)
    if (!workspace || typeof workspace.path !== 'string' || !path.isAbsolute(workspace.path)) fail('native Worker workspace is unavailable')
    if (entry.title !== undefined && (typeof entry.title !== 'string' || entry.title.length > 256)) fail('invalid project title')
    projects[projectId] = { ...entry, root: await realpath(workspace.path) }
  }
  const pairs = []
  const localIds = new Set(), peerIds = new Set(), machines = new Set(), fingerprints = new Set(), tokens = new Set()
  for (const input of value.pairs) {
    exact(input, ['id', 'peerId', 'machineKey', 'protocol', 'relayUrl', 'relayToken', 'sharedKey', 'stateDir', 'pairingGeneration'], ['label', 'allowLoopback', 'grant', 'requestTimeoutMs', 'relayTransport', 'relaySocketConnectTimeoutMs'])
    const localId = parseMachineKey(input.id), peerId = parseMachineKey(input.peerId), machineKey = parseMachineKey(input.machineKey)
    if (input.label !== undefined && (typeof input.label !== 'string' || !input.label || input.label.length > 128 || /[\u0000-\u001f\u007f]/.test(input.label))) fail('invalid locally configured machine label')
    if (localId === peerId || input.protocol !== 2 || !positive(input.pairingGeneration)) fail('invalid explicit v2 pair binding')
    if (value.role === 'worker' && machineKey !== workerMachineKey) fail('pair must name the explicit stable Worker machine identity')
    if (localIds.has(localId) || peerIds.has(peerId) || machines.has(machineKey)) fail('duplicate endpoint or machine identity')
    if (typeof input.sharedKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.sharedKey)) fail('invalid pair key')
    const bytes = Buffer.from(input.sharedKey, 'base64url')
    if (bytes.length !== 32 || bytes.toString('base64url') !== input.sharedKey) fail('invalid pair key')
    const keyFingerprint = createHash('sha256').update(bytes).digest('hex')
    if (fingerprints.has(keyFingerprint)) fail('pair key reuse is forbidden')
    if (typeof input.relayToken !== 'string' || !/^[A-Za-z0-9._~-]{16,512}$/.test(input.relayToken) || tokens.has(input.relayToken)) fail('invalid or reused device token')
    if (input.allowLoopback !== undefined && typeof input.allowLoopback !== 'boolean') fail('invalid relay option')
    if (input.requestTimeoutMs !== undefined && (!positive(input.requestTimeoutMs) || input.requestTimeoutMs > 60000)) fail('invalid request timeout')
    const relayTransport = input.relayTransport === undefined ? 'https' : input.relayTransport
    if (!['https', 'auto'].includes(relayTransport)) fail('invalid relay transport')
    if (relayTransport === 'auto' ? !positive(input.requestTimeoutMs) || !positive(input.relaySocketConnectTimeoutMs)
      || input.relaySocketConnectTimeoutMs > input.requestTimeoutMs : input.relaySocketConnectTimeoutMs !== undefined) fail('invalid explicit socket deadline')
    let relay
    try { relay = new URL(input.relayUrl) } catch (error) { fail('invalid relay URL') }
    if (typeof input.relayUrl !== 'string' || /[\s\\?#]/.test(input.relayUrl) || relay.username || relay.password || (relay.protocol !== 'https:' && !(input.allowLoopback === true && relay.protocol === 'http:' && /^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?(?:\/|$)/.test(input.relayUrl)))) fail('relay requires HTTPS or explicit exact loopback')
    if (typeof input.stateDir !== 'string' || !input.stateDir || input.stateDir.includes('\0')) fail('invalid state directory')
    const stateDir = await canonicalStateDirectory(path.resolve(path.dirname(filename), input.stateDir))
    if (pairs.some(pair => overlaps(pair.stateDir, stateDir) || overlaps(stateDir, pair.stateDir)) || Object.values(projects).some(project => overlaps(project.root, stateDir) || overlaps(stateDir, project.root))) fail('state directories must be disjoint from pairs and approved project roots')
    let grant = null
    if (input.grant !== undefined && input.grant !== null) {
      if (value.role !== 'worker') fail('Worker grant documents cannot be issued by Controller config')
      grant = json(parseGrant(input.grant))
      if (grant.machineKey !== machineKey || grant.principal.id !== peerId) fail('grant must name this exact authenticated pair')
      if (grant.version === 1 && grant.projects.some(project => !Object.hasOwn(projects, project.projectId))) fail('grant names an unconfigured native project')
    }
    localIds.add(localId); peerIds.add(peerId); machines.add(machineKey); fingerprints.add(keyFingerprint); tokens.add(input.relayToken)
    pairs.push({ ...input, relayTransport, role: value.role, id: localId, peerId, machineKey, stateDir, keyFingerprint, grant })
  }
  return Object.freeze({ version: 2, role: value.role, id, ...(workerMachineKey === undefined ? {} : { machineKey: workerMachineKey }), label: value.label ?? id, projects, pairs, settingsFile: path.resolve(filename) })
}
