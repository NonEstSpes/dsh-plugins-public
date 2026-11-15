#!/usr/bin/env node
/** User-run Controller administration. Uses the installed public SDK, never a running app server or its state database. */
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, lstat, realpath, readdir } from 'node:fs/promises'
import { parseSettingsV2, canonicalStateDirectory } from '../lib/federation/settings.mjs'

const VERSION = '0.2.2-rc.1'
const UI = '@dsh-remote/native-session-bundle'
const BRIDGE = '@dsh-remote/control-bridge'
const ROLE = '@dsh-remote/controller-role-config'
class RolloutError extends Error {}
const die = (message) => { throw new RolloutError(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const key = value => path.resolve(value).toLowerCase()
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const inside = (a, b) => { const r = path.relative(key(a), key(b)); return r === '' || (!r.startsWith(`..${path.sep}`) && r !== '..' && !path.isAbsolute(r)) }
const overlap = (a, b) => inside(a, b) || inside(b, a)
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const absolute = value => { if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) die('An explicit absolute path is required.'); return path.resolve(value) }
async function json(filename) { return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')) }
async function exists(filename) { try { await lstat(filename); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function absent(filename) { if (await exists(filename)) die('A NEW destination is required; no existing files are overwritten.') }
async function directory(filename) { const resolved = await realpath(absolute(filename)); if (!(await lstat(resolved)).isDirectory()) die('Existing directory required.'); return resolved }
async function exclusive(filename, value) { await writeFile(filename, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
function options(argv) {
  const mode = argv.shift()
  if (!['inspect', 'stage', 'activate', 'rollback'].includes(mode)) die('Mode: inspect | stage | activate | rollback. See CONTROLLER-ROLLOUT.md.')
  const flags = new Set(['app-closed', 'worker-v2-confirmed'])
  const names = new Set(['desktop-exe', 'runtime-dir', 'pnpm-entry', 'profile-dir', 'home', 'origin', 'host-pid', 'stage-dir', 'legacy-settings', 'legacy-state-dir', 'state-dir', 'machine-key', 'pairing-generation', 'ui-bundle', 'ui-sha256', 'bridge-bundle', 'bridge-sha256', 'selection'])
  const args = { mode }
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : ''
    if ((!flags.has(name) && !names.has(name)) || Object.hasOwn(args, name)) die('Unknown or duplicate argument.')
    if (flags.has(name)) args[name] = true
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) die('Missing argument value.'); args[name] = argv[++i] }
  }
  return args
}
function powershell(script, env = {}) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $OutputEncoding = [Console]::OutputEncoding; ${script}`], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function processes() {
  const value = powershell("@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,@{n='Created';e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString('o')} else {''}}}) | ConvertTo-Json -Compress")
  const rows = JSON.parse(value || '[]')
  return Array.isArray(rows) ? rows : [rows]
}
function installedProcess(row, exe) {
  if (!row.ExecutablePath) return row.Name?.toLowerCase() === path.basename(exe).toLowerCase()
  return row.Name?.toLowerCase() === path.basename(exe).toLowerCase() || key(row.ExecutablePath) === key(exe) || (path.basename(row.ExecutablePath).toLowerCase() === 'node.exe' && inside(path.join(path.dirname(exe), 'resources', 'runtime'), row.ExecutablePath))
}
function installedProcesses(rows, exe) {
  return rows.filter(row => row.ProcessId !== process.pid && installedProcess(row, exe))
}
async function originAlive(origin) {
  const url = new URL(origin)
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) die('Origin must be an explicit loopback HTTP(S) origin.')
  try { await fetch(url, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(2500) }); return true }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return false; die('Origin liveness is uncertain; refuse offline mutation.') }
}
async function closed(args, receipt, exe) {
  if (args['app-closed'] !== true) die('Quit Desktop and Host gracefully, then acknowledge --app-closed. Processes are never killed by this helper.')
  const rows = processes()
  if (installedProcesses(rows, exe).length) die('Other installed Desktop/Host processes remain. Quit them gracefully.')
  for (const recorded of receipt.processes) if (rows.some(row => row.ProcessId === recorded.ProcessId && row.Created === recorded.Created)) die('A recorded Desktop/Host lifecycle is still alive.')
  if (await originAlive(receipt.origin)) die('The recorded Host origin is still responding.')
}
async function protect(directory) {
  const output = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
  const sid = output.match(/S-1-[0-9-]+/)?.[0]
  if (!sid) die('Cannot determine current Windows SID; no credentials have been copied.')
  execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true })
}
async function sdk(args) {
  if (process.platform !== 'win32' || process.env.ELECTRON_RUN_AS_NODE !== '1') die('Run through controller-rollout.cmd using the installed signed Desktop executable.')
  const exe = await realpath(absolute(args['desktop-exe']))
  if (key(process.execPath) !== key(exe)) die('The administrator must use the SAME installed Desktop executable as its Node carrier.')
  const signature = powershell('(Get-AuthenticodeSignature -LiteralPath $env:ROLLOUT_EXE).Status.ToString()', { ROLLOUT_EXE: exe })
  if (signature !== 'Valid') die('Installed Desktop signature is not valid.')
  const runtime = absolute(args['runtime-dir'])
  const anchor = path.join(runtime, 'package.json')
  const expected = path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'package.json')
  if (key(anchor) !== key(expected)) die('Runtime must be the ACTUAL installed ASAR/dsh, not a source tree, extracted SDK, or mirror.')
  const require = createRequire(anchor)
  const load = specifier => import(pathToFileURL(require.resolve(specifier)).href)
  const [boot, ops, atomic] = await Promise.all([load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-plugin-manager/operations'), load('@deepseek-ai/dsh-atomic-write')])
  const manifest = await json(anchor)
  if (manifest.version !== VERSION) die('Unsupported installed version; no version exemption is allowed.')
  const profile = await directory(args['profile-dir']), home = await directory(args.home)
  const profileFile = path.join(profile, 'package.json')
  const stat = await lstat(profileFile)
  if (!stat.isFile() || stat.isSymbolicLink()) die('An existing regular approved profile manifest is required; never initialize a new profile.')
  const read = () => boot.readProfileManifest('dsh', profile)
  const context = { name: 'desktop', dir: profile, home, installAnchor: anchor, patchPath: path.join(profile, boot.PROFILE_PATCH_FILENAME), cwd: process.cwd(), startedBundles: [], overlays: [], telemetryDisabledEnv: process.env.DSH_TELEMETRY_DISABLED }
  const pnpm = absolute(args['pnpm-entry'] ?? path.join(path.dirname(exe), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs'))
  if (!inside(path.join(path.dirname(exe), 'resources', 'runtime'), pnpm) || !(await lstat(pnpm)).isFile()) die('pnpm must be the installed bundled pnpm.mjs.')
  return { exe, runtime, anchor, boot, ops, atomic, profile, profileFile, home, read, context, pnpm }
}
const selection = manifest => manifest.dsh?.profile?.bundles ?? []
function noCode(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) die('Non-finite data requires operator review before JSON patch materialization.')
  if (value === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof value)) return
  if (Array.isArray(value)) { value.forEach(noCode); return }
  if (!plain(value)) die('JavaScript-valued patches are not allowed in NEW rollout bundles.')
  Object.values(value).forEach(noCode)
}
async function bundlePatches(s, name, newBundle = false) {
  const manifest = s.ops.bundleManifest(name, s.profile, s.anchor)
  if (!manifest) die('Selected package does not declare a public bundle manifest.')
  s.boot.assertBundlePlatform(manifest.dsh.bundle.platforms, process.platform)
  if (newBundle && manifest.engines?.dsh !== VERSION) die('New bundles must require the exact supported DSH version.')
  const dir = s.boot.resolveBundleDir('dsh', name, s.anchor, s.profile)
  const patches = []
  for (const filename of s.boot.bundlePatchPaths(dir, manifest.dsh.bundle)) {
    if (newBundle && /!!?js\b|!<[^>]+>/.test(await readFile(filename, 'utf8'))) die('JavaScript tags in NEW bundle patches are forbidden.')
    const parsed = s.boot.loadOverlayPatches('dsh', filename)
    if (newBundle) noCode(parsed)
    patches.push(...parsed)
  }
  return { packageName: name, patches }
}
async function composed(s, names) {
  const layers = []
  for (const name of names) layers.push(await bundlePatches(s, name, [UI, BRIDGE, ROLE].includes(name)))
  return composeLayers(s, layers)
}
function composeLayers(s, layers) {
  const initial = { layers, patches: s.boot.loadOptionalPatches('dsh', s.context.patchPath) ?? [] }
  return s.boot.composeEntries([s.boot.readProfilePatches('dsh', s.context, initial)])
}
async function capturedLayer(s, dir) {
  const manifest = await json(path.join(dir, 'package.json'))
  const patches = s.boot.bundlePatchPaths(dir, manifest.dsh.bundle).flatMap(file => s.boot.loadOverlayPatches('dsh', file))
  noCode(patches)
  return { packageName: manifest.name, patches }
}
function flatten(entries) { return entries.flatMap(row => [row, ...(Array.isArray(row.config) ? flatten(row.config) : [])]) }
function closureMetadata(entries, inherited = 'enabled-literal') {
  const suffixes = ['ui-action-cards', 'ui-agent-team', 'ui-claude-code-mods', 'ui-cot-translation', 'ui-forge', 'ui-plugin-recommendations', 'ui-stats', 'liveshare', 'session-inspector']
  return entries.flatMap(row => {
    const state = inherited === 'disabled' || row.disabled === true ? 'disabled'
      : inherited === 'needs-operator-review' || (row.disabled !== undefined && typeof row.disabled !== 'boolean') ? 'needs-operator-review' : 'enabled-literal'
    const matched = typeof row.name === 'string' && /^@[^/]+\/[^/]+$/.test(row.name) && suffixes.some(suffix => row.name.endsWith(suffix))
    return [...(matched && state !== 'disabled' ? [{ id: row.id, module: row.name, state }] : []), ...(Array.isArray(row.config) ? closureMetadata(row.config, state) : [])]
  })
}
async function apiConfig(s, names) {
  const rows = flatten(await composed(s, names)).filter(row => row.id === 'session-controller')
  if (rows.length !== 1 || (rows[0].config !== undefined && !plain(rows[0].config))) die('Old session-controller config requires operator review; never evaluate JavaScript.')
  const config = rows[0].config ?? {}, copied = {}
  if (Object.hasOwn(config, 'nativeOpen')) {
    if (typeof config.nativeOpen !== 'boolean') die('Present nativeOpen must be a literal boolean; operator review required.')
    copied.nativeOpen = config.nativeOpen
  }
  if (Object.hasOwn(config, 'listWorkSliceMs')) {
    if (typeof config.listWorkSliceMs !== 'number' || !Number.isFinite(config.listWorkSliceMs)) die('Present listWorkSliceMs must be a literal finite number; operator review required.')
    copied.listWorkSliceMs = config.listWorkSliceMs
  }
  return copied
}
/** Capture manifest.files and nested local dependency payloads before invoking pnpm. */
async function payload(s, input, expected, name) {
  const root = await directory(input), files = new Map(), manifests = []
  async function visit(relative) {
    const filename = path.resolve(root, relative)
    if (!inside(root, filename) || filename === root) die('Payload escapes its root.')
    const stat = await lstat(filename)
    if (stat.isSymbolicLink()) die('Payload symlinks are forbidden.')
    if (stat.isDirectory()) { for (const item of (await readdir(filename)).sort()) await visit(path.join(relative, item)); return }
    if (!stat.isFile()) die('Unsupported payload file.')
    const rel = path.relative(root, filename).split(path.sep).join('/')
    files.set(rel, await readFile(filename))
  }
  const manifest = await json(path.join(root, 'package.json'))
  if (manifest.name !== name || manifest.engines?.dsh !== VERSION || !Array.isArray(manifest.files)) die('Wrong bundle identity/version/files.')
  await visit('package.json')
  for (const item of manifest.files) { if (typeof item !== 'string' || /[*?]/.test(item)) die('Payload files must be explicit paths.'); await visit(item) }
  const digest = hash(JSON.stringify([...files].map(([rel, bytes]) => [rel, hash(bytes)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
  if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || digest !== expected)) die('Approved payload SHA256 mismatch.')
  for (const [rel, bytes] of files) {
    if (path.basename(rel) !== 'package.json') continue
    const item = JSON.parse(bytes)
    manifests.push(item)
    for (const specs of [item.dependencies, item.optionalDependencies, item.peerDependencies]) for (const spec of Object.values(specs ?? {})) {
      if (/^(?:link|workspace|portal):/.test(spec) || (spec.startsWith('file:') && !inside(root, path.resolve(root, path.dirname(rel), spec.slice(5))))) die('Local dependencies must stay inside the captured bundle.')
    }
    if (Object.keys(item.scripts ?? {}).length) die('Rollout payloads with lifecycle scripts require separate review; scripts are never approved here.')
    if (item.dsh?.bundle) {
      s.boot.assertBundlePlatform(item.dsh.bundle.platforms, process.platform)
      for (const file of s.boot.bundlePatchPaths(path.dirname(path.join(root, rel)), item.dsh.bundle)) {
        const relative = path.relative(root, file).split(path.sep).join('/')
        if (!files.has(relative) || /!!?js\b|!<[^>]+>/.test(files.get(relative).toString('utf8'))) die('NEW bundle patch must be captured and contain no JavaScript tags.')
        noCode(s.boot.loadOverlayPatches('dsh', file))
      }
    }
  }
  return { root, files, manifests, manifest, digest, name, version: manifest.version }
}
function entryLocations(entries, parent = null, inherited = 'enabled-literal') {
  return entries.flatMap(row => {
    const state = inherited === 'disabled' || row.disabled === true ? 'disabled'
      : inherited === 'needs-operator-review' || (row.disabled !== undefined && typeof row.disabled !== 'boolean') ? 'needs-operator-review' : 'enabled-literal'
    return [{ row, parent, state }, ...(row.group === true && Array.isArray(row.config) ? entryLocations(row.config, row.id, state) : [])]
  })
}
/** Materialize only existing enabled consumers; approved payload hashes identify the reviewed guard factory. */
function optionalConsumers(ui, entries) {
  if (ui.version !== '0.1.1') die('Controller stage requires approved UI revision 0.1.1 with conditional consumer metadata.')
  const metadata = ui.files.get('optional-features.json')
  if (!metadata) die('Captured UI optional consumer manifest is missing.')
  const document = JSON.parse(metadata.toString('utf8'))
  if (document.version !== 1 || !Array.isArray(document.features)) die('Unsupported optional consumer manifest.')
  noCode(document)
  const locations = entryLocations(entries), patches = [], records = [], keys = new Set(), targets = new Set()
  for (const feature of document.features) {
    if (!plain(feature) || typeof feature.key !== 'string' || typeof feature.originalPackage !== 'string' || typeof feature.replacementPackage !== 'string' || typeof feature.replacementRowId !== 'string' || keys.has(feature.key) || targets.has(feature.originalPackage)) die('Optional feature identities must be explicit and unique.')
    keys.add(feature.key); targets.add(feature.originalPackage)
    const matches = locations.filter(item => item.row.name === feature.originalPackage)
    if (matches.length > 1) die('Multiple original consumer instances require explicit operator review.')
    if (matches.length === 0 || matches[0].state === 'disabled') {
      records.push({ key: feature.key, originalPackage: feature.originalPackage, state: matches.length ? 'skipped-disabled' : 'skipped-absent' }); continue
    }
    if (matches[0].state !== 'enabled-literal') die('Conditional original consumer activation requires operator review; JavaScript is not evaluated.')
    if (feature.artifactStatus !== 'built') die('An active original consumer has no built approved guard artifact; do not activate the old consumer.')
    const { row, parent } = matches[0]
    if (row.group === true || typeof row.id !== 'string' || !row.id || (parent !== null && typeof parent !== 'string')) die('Only explicit existing leaf/group identities can be replaced.')
    if (locations.some(item => item.row.id === feature.replacementRowId) || records.some(item => item.newId === feature.replacementRowId || item.oldId === row.id)) die('Duplicate original or replacement consumer target.')
    noCode(row)
    const spec = ui.manifest.dependencies?.[feature.replacementPackage]
    if (typeof spec !== 'string' || !spec.startsWith('file:')) die('Active guard must be a captured NEW local dependency.')
    const relative = path.relative(ui.root, path.resolve(ui.root, spec.slice(5))).split(path.sep).join('/')
    const childBytes = ui.files.get(`${relative}/package.json`)
    if (!childBytes) die('Active guard package is not captured in approved payload.')
    const child = JSON.parse(childBytes.toString('utf8'))
    if (child.name !== feature.replacementPackage || !Array.isArray(child.dsh?.client?.inject) || !child.dsh.client.inject.includes('@dsh-remote/session-controller') || feature.clientApiOwner !== '@dsh-remote/session-controller') die('Active guard factory must declare the NEW Client API owner.')
    const entry = child.exports?.['./client']
    if (typeof entry !== 'string' || !entry.startsWith('./')) die('Guard Client entry must be explicit.')
    const factoryRelative = path.posix.normalize(`${relative}/${entry.slice(2)}`)
    const factory = ui.files.get(factoryRelative)
    if (!factory || !/^[a-f0-9]{64}$/.test(feature.factorySha256 ?? '') || hash(factory) !== feature.factorySha256) die('Reviewed guard factory SHA256 does not match captured bytes.')
    if (!plain(feature.sourceFileHashes) || Object.keys(feature.sourceFileHashes).length === 0 || Object.values(feature.sourceFileHashes).some(value => typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))) die('Reviewed guard source-file hashes must be pinned in consumer metadata.')
    const templateBytes = ui.files.get(feature.patch)
    if (!templateBytes) die('Active guard plain patch template is not captured.')
    const template = JSON.parse(templateBytes.toString('utf8')); noCode(template)
    if (!Array.isArray(template) || template.length !== 2 || template[0].name !== feature.originalPackage || template[0].disabled !== true || template[1].insert?.length !== 1 || template[1].insert[0].name !== feature.replacementPackage || template[1].insert[0].id !== feature.replacementRowId) die('Unexpected active guard patch template.')
    const replacement = { ...structuredClone(row), id: feature.replacementRowId, name: feature.replacementPackage }
    patches.push({ id: row.id, name: feature.originalPackage, disabled: true }, { ...(parent === null ? {} : { id: parent }), insert: [replacement] })
    records.push({ key: feature.key, originalPackage: feature.originalPackage, state: 'replaced', oldId: row.id, newId: feature.replacementRowId, replacementPackage: feature.replacementPackage, parent, expectedRow: replacement, factorySha256: feature.factorySha256 })
  }
  for (const item of closureMetadata(entries)) if (!document.features.some(feature => feature.originalPackage === item.module)) die('An active source-changed consumer is outside the reviewed guard closure.')
  return { patches, records }
}
function verifyOptional(entries, records) {
  const locations = entryLocations(entries)
  for (const record of records) {
    if (record.state !== 'replaced') {
      if (locations.some(item => item.row.name === record.originalPackage && item.state !== 'disabled')) die('A previously absent/disabled optional consumer became active; review and re-stage.')
      continue
    }
    const old = locations.filter(item => item.row.id === record.oldId)
    const replacement = locations.filter(item => item.row.id === record.newId)
    if (old.length !== 1 || old[0].row.name !== record.originalPackage || old[0].row.disabled !== true || old[0].parent !== record.parent || replacement.length !== 1 || replacement[0].state !== 'enabled-literal' || replacement[0].parent !== record.parent || !same(replacement[0].row, record.expectedRow) || locations.some(item => item.row.name === record.originalPackage && item.state !== 'disabled') || locations.filter(item => item.row.name === record.replacementPackage && item.state !== 'disabled').length !== 1) die('Final optional consumer must have exactly one exclusive NEW guard owner in the original scope/configuration.')
  }
}
function verifyConnect(entries, expectedApi, settingsFile) {
  const locations = entryLocations(entries)
  const unique = id => { const found = locations.filter(item => item.row.id === id); if (found.length !== 1) die('Final connection requires unique old/new API and bridge row identities.'); return found[0] }
  const oldApi = unique('session-controller'), api = unique('remote-native-session-controller')
  const oldBridge = unique('remote-control'), bridge = unique('remote-native-control-bridge')
  if (oldApi.row.disabled !== true || oldBridge.row.disabled !== true || api.state !== 'enabled-literal' || bridge.state !== 'enabled-literal') die('Final composition must disable BOTH old API and old remote-control while enabling only the NEW owners; higher-priority overrides require review.')
  if (!same({ nativeOpen: api.row.config?.nativeOpen, listWorkSliceMs: api.row.config?.listWorkSliceMs }, expectedApi) || bridge.row.config?.settingsFile !== settingsFile) die('Final connection does not preserve API fields or exact role settings pointer.')
}
async function capture(payload, destination) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const [rel, bytes] of payload.files) { const file = path.join(destination, rel); await mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await exclusive(file, bytes) }
  return destination
}
async function roleDigests(directory) {
  return Object.fromEntries(await Promise.all(['package.json', 'index.js', 'cordis.patch.yml'].map(async name => [name, hash(await readFile(path.join(directory, name)))])))
}
async function verifyInstalled(s, receipt) {
  for (const item of receipt.payloads) await payload(s, s.boot.resolveBundleDir('dsh', item.name, s.anchor, s.profile), item.digest, item.name)
  const roleDir = s.boot.resolveBundleDir('dsh', ROLE, s.anchor, s.profile)
  if (!same(await roleDigests(roleDir), receipt.roleDigests) || hash(await readFile(receipt.settingsFile)) !== receipt.settingsSha256) die('Installed role/payload/settings changed since approved staging.')
}
function bindReceipt(s, receipt) {
  if (receipt.version !== 1 || receipt.runtimeVersion !== VERSION || key(receipt.exe) !== key(s.exe) || key(receipt.anchor) !== key(s.anchor) || key(receipt.profile) !== key(s.profile) || key(receipt.home) !== key(s.home)) die('Receipt does not belong to this exact installed runtime/profile.')
}
async function main() {
  const args = options(process.argv.slice(2)), s = await sdk(args)
  const current = s.read(), before = selection(current)
  if (!Array.isArray(before) || before.some(item => typeof item !== 'string') || new Set(before).size !== before.length) die('Invalid or duplicate existing bundle selection.')
  if (args.mode === 'inspect') {
    const report = { runtimeVersion: VERSION, profileExists: true, selectedBundleCount: before.length, installedProcesses: installedProcesses(processes(), s.exe).map(({ ProcessId, Created }) => ({ pid: ProcessId, created: Created })), sourceChangedOwnerRows: closureMetadata(await composed(s, before)) }
    try { report.apiConfig = await apiConfig(s, before) } catch (error) { report.apiConfig = 'Present nonliteral API fields require operator review; absent fields stay absent.' }
    for (const [flag, name] of [['ui-bundle', UI], ['bridge-bundle', BRIDGE]]) if (args[flag]) {
      const captured = await payload(s, args[flag], undefined, name)
      report[flag] = { name, sha256: captured.digest }
      if (name === UI && captured.version === '0.1.1') {
        const optional = optionalConsumers(captured, await composed(s, before))
        const basePath = captured.manifest.dsh.bundle.patch.replace(/^\.\//, '')
        const base = JSON.parse(captured.files.get(basePath).toString('utf8')); noCode(base)
        const layers = []
        for (const selected of before) layers.push(await bundlePatches(s, selected))
        verifyOptional(composeLayers(s, [...layers, { patches: base }, { patches: optional.patches }]), optional.records)
        report[flag].optionalConsumers = optional.records.map(({ key, state, oldId, newId, parent, replacementPackage, factorySha256 }) => ({ key, state, oldId, newId, parent, replacementPackage, factorySha256 }))
      }
    }
    console.log(JSON.stringify(report, null, 2)); return
  }
  const requestedStage = absolute(args['stage-dir'])
  const stage = args.mode === 'stage' ? path.join(await directory(path.dirname(requestedStage)), path.basename(requestedStage)) : await directory(requestedStage)
  if (overlap(stage, s.profile) || overlap(stage, path.dirname(s.exe)) || overlap(stage, s.home)) die('Stage must be outside profile, home and installation.')
  if (args.mode === 'stage') {
    await absent(stage); await directory(path.dirname(stage))
    for (const flag of ['legacy-settings', 'state-dir', 'machine-key', 'pairing-generation', 'ui-bundle', 'ui-sha256', 'bridge-bundle', 'bridge-sha256', 'origin', 'host-pid']) if (!args[flag]) die(`Required: --${flag}`)
    const oldFile = await realpath(absolute(args['legacy-settings'])), oldBytes = await readFile(oldFile), old = JSON.parse(oldBytes.toString('utf8').replace(/^\uFEFF/, ''))
    if (!plain(old) || old.role !== 'controller' || (old.version !== undefined && old.version !== 1)) die('Explicit legacy file must be Controller v1, not a Worker or v2 configuration.')
    const state = await canonicalStateDirectory(absolute(args['state-dir']))
    await absent(state)
    const oldStateInput = args['legacy-state-dir'] ?? old.stateDir
    if (typeof oldStateInput !== 'string' || !oldStateInput) die('Explicit legacy-state-dir required when absent from v1 settings.')
    const oldState = await canonicalStateDirectory(args['legacy-state-dir'] ? absolute(oldStateInput) : path.resolve(path.dirname(oldFile), oldStateInput))
    if ([oldState, stage, s.home, s.profile, path.dirname(s.exe)].some(dir => overlap(state, dir)) || overlap(stage, oldState) || inside(stage, oldFile)) die('New v2 state/staging must be separate from old state, settings, profile, home and installation.')
    const generation = Number(args['pairing-generation'])
    if (!/^[1-9][0-9]*$/.test(args['pairing-generation']) || !Number.isSafeInteger(generation)) die('Pairing generation must be explicit positive integer matching Worker kit.')
    const settingsFile = path.join(stage, 'controller-v2.settings.json')
    const settings = { version: 2, role: 'controller', id: old.id, pairs: [{ id: old.id, peerId: old.peerId, machineKey: args['machine-key'], pairingGeneration: generation, protocol: 2, relayUrl: old.relayUrl, relayToken: old.relayToken, sharedKey: old.sharedKey, stateDir: state, ...(old.allowLoopback === undefined ? {} : { allowLoopback: old.allowLoopback }) }] }
    await parseSettingsV2(settings, settingsFile)
    const api = await apiConfig(s, before)
    const packages = [await payload(s, args['ui-bundle'], args['ui-sha256'], UI), await payload(s, args['bridge-bundle'], args['bridge-sha256'], BRIDGE)]
    const optional = optionalConsumers(packages[0], await composed(s, before))
    for (const item of [...packages.flatMap(p => p.manifests), { name: ROLE }]) {
      if (Object.hasOwn(current.dependencies ?? {}, item.name) || Object.hasOwn(current.devDependencies ?? {}, item.name) || Object.hasOwn(current.optionalDependencies ?? {}, item.name)) die('Rollout packages must be genuinely NEW; existing dependency cannot be updated.')
      try { s.boot.resolveBundleDir('dsh', item.name, s.anchor, s.profile) } catch (error) { continue }
      die('Rollout package already resolves from installed/profile packages; no overwrite permitted.')
    }
    if (packages.some(p => overlap(stage, p.root))) die('Stage cannot overlap input bundles.')
    const rows = processes(), host = rows.find(row => row.ProcessId === Number(args['host-pid']))
    if (!host?.ExecutablePath || !installedProcess(host, s.exe) || !host.Created || host.ProcessId === process.pid) die('host-pid must identify the actual other installed Host lifecycle.')
    if (!await originAlive(args.origin)) die('Stage requires the explicit current Host origin to respond; offline activation happens later.')
    await mkdir(stage, { mode: 0o700 }); await protect(stage)
    await exclusive(settingsFile, settings)
    await mkdir(path.join(stage, 'metadata-before'), { mode: 0o700 })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'compatibility.json']) {
      const file = path.join(s.profile, name)
      if (await exists(file)) await exclusive(path.join(stage, 'metadata-before', name), await readFile(file))
    }
    const captured = []
    for (const [index, item] of packages.entries()) captured.push(await capture(item, path.join(stage, 'payloads', `bundle-${index}`)))
    const roleDir = path.join(stage, 'controller-role-config'); await mkdir(roleDir, { mode: 0o700 })
    await exclusive(path.join(roleDir, 'package.json'), { name: ROLE, version: '0.1.0', private: true, type: 'module', engines: { dsh: VERSION }, exports: { '.': './index.js' }, files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: Object.fromEntries(packages.map((p, i) => [p.name, `file:${captured[i]}`])) })
    await exclusive(path.join(roleDir, 'index.js'), "export const name = 'controller-role-config';\nexport function apply() {}\n")
    await exclusive(path.join(roleDir, 'cordis.patch.yml'), [...optional.patches, { id: 'remote-native-session-controller', config: api }, { id: 'remote-native-control-bridge', config: { settingsFile } }])
    const candidateLayers = []
    for (const name of before) candidateLayers.push(await bundlePatches(s, name))
    for (const dir of [...captured, roleDir]) candidateLayers.push(await capturedLayer(s, dir))
    const candidateEntries = composeLayers(s, candidateLayers)
    const receipt = { version: 1, runtimeVersion: VERSION, exe: s.exe, anchor: s.anchor, profile: s.profile, home: s.home, origin: args.origin, processes: installedProcesses(rows, s.exe), host: { pid: host.ProcessId, created: host.Created }, before, api, settingsFile, legacyFile: oldFile, legacySha256: hash(oldBytes), stateDir: state, payloads: packages.map(p => ({ name: p.name, version: p.version, digest: p.digest })), staged: false }
    receipt.optionalConsumers = optional.records
    receipt.settingsSha256 = hash(await readFile(settingsFile))
    receipt.roleDigests = await roleDigests(roleDir)
    await exclusive(path.join(stage, 'receipt.json'), receipt)
    verifyOptional(candidateEntries, optional.records)
    verifyConnect(candidateEntries, api, settingsFile)
    const result = await s.ops.runPluginCommand({ profile: 'desktop', dir: s.profile, home: s.home, installAnchor: s.anchor, cwd: stage }, ['add', ...[...captured, roleDir].map(dir => `file:${dir}`), '--ignore-scripts', '--config.auto-install-peers=false'], { command: process.execPath, args: ['--expose-internals', s.pnpm], env: { ELECTRON_RUN_AS_NODE: '1' }, execution: 'service', outputBytes: 16384, activateNewBundles: false, onOutput: () => {}, lockWaitMs: 120000, lookupTimeoutMs: 120000 })
    const after = s.read()
    if (result.exitCode !== 0 || !same(selection(after), before) || Object.entries(current.dependencies ?? {}).some(([name, spec]) => after.dependencies?.[name] !== spec) || hash(await readFile(oldFile)) !== receipt.legacySha256) die('Inactive install incomplete or invariants changed. Leave rollout inactive; private receipt/metadata retained. No automatic restore or delete.')
    for (const name of [UI, BRIDGE, ROLE]) await bundlePatches(s, name, true)
    await verifyInstalled(s, receipt)
    receipt.staged = true
    receipt.stagedManifestSha256 = hash(await readFile(s.profileFile))
    await s.atomic.writeFileAtomic(path.join(stage, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 })
    console.log('Inactive staging complete. No composition activation, remote connection, state DB backup, or state directory creation. Quit Desktop/Host before activation.'); return
  }
  const receipt = await json(path.join(stage, 'receipt.json')); bindReceipt(s, receipt)
  if (!receipt.staged) die('Only a successfully staged receipt may be activated or rolled back.')
  await closed(args, receipt, s.exe)
  await s.atomic.withFileLock(s.profileFile, async () => {
    await closed(args, receipt, s.exe)
    const manifest = s.read(), actual = selection(manifest)
    if (args.mode === 'activate') {
      if (args.selection !== 'connect-v2') die('Only explicit --selection connect-v2 is supported; UI-only activation is not implemented.')
      if (args['worker-v2-confirmed'] !== true) die('connect-v2 requires --worker-v2-confirmed after matching Worker machineKey/pairingGeneration. Never connect to an old v1 Worker.')
      if (!same(actual, receipt.before) || hash(await readFile(s.profileFile)) !== receipt.stagedManifestSha256) die('Profile changed after staging; review/re-stage rather than overwriting it.')
      if (await exists(path.join(stage, 'activation.json'))) die('Activation already recorded; use rollback, not another selection edit.')
      if (hash(await readFile(receipt.legacyFile)) !== receipt.legacySha256) die('Legacy settings changed since staging; explicit operator review required.')
      await verifyInstalled(s, receipt)
      if (!same(await apiConfig(s, receipt.before), receipt.api)) die('Old composed literal API configuration changed after staging; review rather than using stale values.')
      await parseSettingsV2(await json(receipt.settingsFile), receipt.settingsFile)
      const delta = [UI, BRIDGE, ROLE]
      for (const name of delta) await bundlePatches(s, name, true)
      const after = [...actual, ...delta]
      const finalEntries = await composed(s, after)
      verifyOptional(finalEntries, receipt.optionalConsumers)
      verifyConnect(finalEntries, receipt.api, receipt.settingsFile)
      const activation = { version: 1, before: actual, after, delta, selection: args.selection, activatedAt: new Date().toISOString() }
      await exclusive(path.join(stage, 'activation.json'), activation) // written first: recovery is selection-CAS, never blind restore
      await s.ops.saveManifest(s.profile, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: after } } })
      console.log('Offline selection saved. Reopen installed Desktop normally; runtime auth/readiness are not asserted by this helper.')
    } else {
      const activation = await json(path.join(stage, 'activation.json'))
      if (!same(actual, activation.after) || !same(activation.before, receipt.before) || !same(activation.after, [...activation.before, ...activation.delta]) || activation.delta.some(name => ![UI, BRIDGE, ROLE].includes(name))) die('Rollback requires exact recorded post-selection. Concurrent edits are not overwritten.')
      await s.ops.saveManifest(s.profile, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: activation.before } } })
      console.log('Only rollout selection delta removed. All dependencies, settings, messages, journals and user data retained. Reopen Desktop normally.')
    }
  })
}
main().catch(error => { console.error(error instanceof RolloutError ? error.message : 'Controller rollout refused or incomplete. Native diagnostics and private input values are suppressed.'); console.error('No automatic restore, process termination, lock deletion or state deletion. Review the guide/private receipt before continuing.'); process.exitCode = 1 })
