#!/usr/bin/env node
/** Explicit offline artifact repair through the installed public SDK; never starts a Host. */
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile, mkdir, lstat, realpath, readdir } from 'node:fs/promises'
const VERSION = '0.2.2-rc.1', UI = '@dsh-remote/native-session-bundle', BRIDGE = '@dsh-remote/control-bridge', ROLE = '@dsh-remote/controller-role-config'
const names = [UI, BRIDGE, ROLE], self = fileURLToPath(import.meta.url)
class RepairError extends Error {}
const stop = message => { throw new RepairError(message) }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const key = p => path.resolve(p).toLowerCase()
const inside = (a, b) => { const r = path.relative(key(a), key(b)); return !r || (!path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`)) }
const absolute = p => { if (typeof p !== 'string' || !path.isAbsolute(p) || p.includes('\0')) stop('Explicit absolute path required.'); return path.resolve(p) }
const fileSpec = root => `file:${absolute(root).replaceAll('\\', '/')}`
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype
const json = async p => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''))
const put = async (p, x) => writeFile(p, Buffer.isBuffer(x) || typeof x === 'string' ? x : JSON.stringify(x, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const digest = files => hash(JSON.stringify([...files].map(([p, b]) => [p, hash(b)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
function argsOf(argv) {
  const a = { mode: argv.shift() }, flags = new Set(['app-closed'])
  const allowed = new Set(['stage-dir', 'desktop-exe', 'runtime-dir', 'profile-dir', 'home', 'origin', 'host-pid', 'ui-bundle', 'ui-sha256', 'bridge-bundle', 'bridge-sha256', 'expected-bridge-version', 'expected-role-version', 'phase'])
  if (!['prepare', 'apply', 'rollback', 'verify'].includes(a.mode)) stop('Use prepare, apply, or rollback. See CONTROLLER-REPAIR.md.')
  for (let i = 0; i < argv.length; i++) { const n = argv[i].startsWith('--') ? argv[i].slice(2) : ''; if ((!allowed.has(n) && !flags.has(n)) || Object.hasOwn(a, n)) stop('Unknown or duplicate option.'); if (flags.has(n)) a[n] = true; else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) stop('Missing option value.'); a[n] = argv[++i] } }
  const permitted = new Set(['mode', 'stage-dir', 'desktop-exe', 'runtime-dir', ...(a.mode === 'prepare' ? ['profile-dir', 'home', 'origin', 'host-pid', 'ui-bundle', 'ui-sha256', 'bridge-bundle', 'bridge-sha256', 'expected-bridge-version', 'expected-role-version'] : a.mode === 'verify' ? ['phase'] : ['app-closed'])])
  if (Object.keys(a).some(n => !permitted.has(n)) || (a.mode === 'verify' && !['before', 'after'].includes(a.phase))) stop('Option is invalid for this operation.')
  return a
}
function ps(code, env = {}) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); ${code}`], { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim()
}
function processes() {
  const value = JSON.parse(ps('@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,@{n="Created";e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")} else {""}}}) | ConvertTo-Json -Compress') || '[]')
  return (Array.isArray(value) ? value : [value]).filter(r => r.ProcessId !== process.pid)
}
function owned(rows, exe, home) {
  const roots = [path.join(path.dirname(exe), 'resources', 'runtime'), path.join(home, 'dsh-runtimes', 'dsh-primary-runtime')]
  // Desktop name remains a conservative match when CIM cannot expose its path; unrelated Node processes are not blanket-blocked.
  return rows.filter(r => r.Name?.toLowerCase() === path.basename(exe).toLowerCase() || (r.ExecutablePath && (key(r.ExecutablePath) === key(exe) || (path.basename(r.ExecutablePath).toLowerCase() === 'node.exe' && roots.some(root => inside(root, r.ExecutablePath))))))
}
async function alive(origin) {
  const u = new URL(origin)
  if (!['http:', 'https:'].includes(u.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash) stop('Explicit loopback origin required.')
  try { await fetch(u, { method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(2500) }); return true } catch (e) { if (e.cause?.code === 'ECONNREFUSED') return false; stop('Origin liveness uncertain; no offline mutation.') }
}
async function closed(a, r) {
  if (!a['app-closed']) stop('Gracefully quit Desktop AND Host; acknowledge --app-closed. No process is killed.')
  const rows = processes()
  if (r.processes.some(old => rows.some(now => now.ProcessId === old.ProcessId && (!now.Created || now.Created === old.Created)))) stop('Recorded Desktop/Host lifecycle remains alive or its creation time is unavailable.')
  if (owned(rows, r.exe, r.home).length || await alive(r.origin)) stop('Installed application processes/origin remain alive; no mutation.')
}
async function protect(dir) {
  const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).match(/S-1-[0-9-]+/)?.[0]
  if (!sid) stop('Cannot determine Windows SID.')
  execFileSync('icacls.exe', [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true })
}
async function sdk(a) {
  if (process.platform !== 'win32' || process.env.ELECTRON_RUN_AS_NODE !== '1') stop('Use the installed signed Desktop Node carrier through controller-repair.cmd.')
  const exe = await realpath(absolute(a['desktop-exe'])), runtime = absolute(a['runtime-dir']), anchor = path.join(runtime, 'package.json')
  if (key(process.execPath) !== key(exe) || key(anchor) !== key(path.join(path.dirname(exe), 'resources', 'app.asar', 'dsh', 'package.json'))) stop('Actual installed executable/ASAR required; mirrors and extracted runtimes forbidden.')
  if (ps('(Get-AuthenticodeSignature -LiteralPath $env:REPAIR_EXE).Status.ToString()', { REPAIR_EXE: exe }) !== 'Valid' || (await json(anchor)).version !== VERSION) stop('Wrong signature/runtime version; no exemption supported.')
  const req = createRequire(anchor), load = x => import(pathToFileURL(req.resolve(x)).href)
  const [boot, ops, atomic] = await Promise.all([load('@deepseek-ai/dsh-app-boot'), load('@deepseek-ai/dsh-plugin-manager/operations'), load('@deepseek-ai/dsh-atomic-write')])
  const profile = await realpath(absolute(a['profile-dir'])), home = await realpath(absolute(a.home)), file = path.join(profile, 'package.json')
  if (key(profile) !== key(path.join(home, 'profiles', 'desktop')) || !(await lstat(file)).isFile() || (await lstat(file)).isSymbolicLink()) stop('Existing actual Desktop profile required; never initialize.')
  const pnpm = path.join(path.dirname(exe), 'resources', 'runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  if (!(await lstat(pnpm)).isFile()) stop('Installed pnpm carrier missing.')
  return { exe, runtime, anchor, profile, home, file, pnpm, boot, ops, atomic }
}
/** Same approved manifest.files digest convention as controller-rollout; no node_modules traversal. */
async function payload(root) {
  root = await realpath(absolute(root)); const files = new Map(), manifest = await json(path.join(root, 'package.json'))
  async function visit(rel) { const p = path.resolve(root, rel); if (p === root || !inside(root, p)) stop('Payload path escapes root.'); const st = await lstat(p); if (st.isSymbolicLink()) stop('Payload symlink forbidden.'); if (st.isDirectory()) { for (const n of (await readdir(p)).sort()) await visit(path.join(rel, n)); } else { if (!st.isFile()) stop('Nonregular payload file.'); files.set(path.relative(root, p).split(path.sep).join('/'), await readFile(p)) } }
  if (!Array.isArray(manifest.files)) stop('Explicit manifest.files required.')
  await visit('package.json'); for (const f of manifest.files) { if (typeof f !== 'string' || /[*?]/.test(f)) stop('Explicit payload files only.'); let st; try { st = await lstat(path.resolve(root, f)) } catch (e) { if (e.code !== 'ENOENT') throw e } if (st) await visit(f) }
  return { root, manifest, files, digest: digest(files) }
}
async function capture(p, dest) { await mkdir(dest); for (const [rel, bytes] of p.files) { const f = path.join(dest, rel); await mkdir(path.dirname(f), { recursive: true }); await put(f, bytes) } return payload(dest) }
function check(p, name, version, expected) {
  if (p.manifest.name !== name || p.manifest.version !== version || p.manifest.engines?.dsh !== VERSION || (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || p.digest !== expected))) stop('Unexpected bundle identity/version/approved digest.')
}
function patchBytes(s, p) {
  if (!p.manifest.dsh?.bundle) stop('Bundle patch required.')
  s.boot.assertBundlePlatform(p.manifest.dsh.bundle.platforms, process.platform)
  return s.boot.bundlePatchPaths(p.root, p.manifest.dsh.bundle).map(f => { const b = p.files.get(path.relative(p.root, f).split(path.sep).join('/')); if (!b || /!!?js\b|!<[^>]+>/.test(b.toString())) stop('Captured plain bundle patches required.'); return hash(b) })
}
async function closure(p) {
  const out = {}, queue = [p.root]
  while (queue.length) {
    const dir = queue.shift(), m = await json(path.join(dir, 'package.json'))
    if (out[m.name]) { if (out[m.name].root !== dir) stop('Duplicate artifact name in file closure.'); continue }
    if (Object.keys(m.scripts ?? {}).length) stop('Lifecycle scripts forbidden.')
    out[m.name] = { root: dir, digest: (await payload(dir)).digest, version: m.version }
    for (const [name, spec] of Object.entries({ ...m.peerDependencies, ...m.optionalDependencies, ...m.dependencies })) {
      if (typeof spec !== 'string' || /^(link|workspace|portal):/.test(spec)) stop('Unsupported dependency spec.')
      if (!spec.startsWith('file:')) continue
      const target = path.resolve(dir, spec.slice(5))
      if (!inside(p.root, target) || !p.files.has(path.relative(p.root, path.join(target, 'package.json')).split(path.sep).join('/')) || (await json(path.join(target, 'package.json'))).name !== name) stop('Local dependency must be captured inside its immutable root.')
      queue.push(target)
    }
  }
  return out
}
async function state(s) {
  const manifest = await readFile(s.file), lock = await readFile(path.join(s.profile, 'pnpm-lock.yaml'))
  return { manifest, lock, manifestHash: hash(manifest), lockHash: hash(lock) }
}
async function layers(s) {
  const m = s.boot.readProfileManifest('dsh', s.profile), bundles = m.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || bundles.length !== 14 || new Set(bundles).size !== 14 || names.some(n => !bundles.includes(n))) stop('Expected exactly 14 existing selected bundles including all three repair roots.')
  const result = [], hashes = []
  for (const n of bundles) { const dir = s.boot.resolveBundleDir('dsh', n, s.anchor, s.profile), meta = s.boot.readProfileManifest('dsh', dir), paths = s.boot.bundlePatchPaths(dir, meta.dsh.bundle); result.push({ packageName: n, packageDir: dir, patchPaths: paths, patches: paths.flatMap(f => s.boot.loadOverlayPatches('dsh', f)) }); hashes.push([n, await Promise.all(paths.map(async f => hash(await readFile(f))))]) }
  const patchPath = path.join(s.profile, s.boot.PROFILE_PATCH_FILENAME), patches = s.boot.loadOptionalPatches('dsh', patchPath) ?? []
  let userHash = null; try { userHash = hash(await readFile(patchPath)) } catch (e) { if (e.code !== 'ENOENT') throw e }
  return { profile: { name: 'desktop', dir: s.profile, layers: result, patchPath, patches, skippedBundles: [] }, hashes, userHash, bundles }
}
function context(s) { return { profile: 'desktop', dir: s.profile, home: s.home, installAnchor: s.anchor, cwd: process.cwd() } }
function policy(s) { return { command: process.execPath, args: ['--expose-internals', s.pnpm], env: { ELECTRON_RUN_AS_NODE: '1' }, execution: 'service', outputBytes: 16384, activateNewBundles: false, onOutput: () => {}, lockWaitMs: 120000, lookupTimeoutMs: 120000 } }
const installFlags = ['--ignore-scripts', '--config.auto-install-peers=false', '--prefer-offline']
async function cas(s, expected) { const now = await state(s); if (now.manifestHash !== expected.manifestHash || now.lockHash !== expected.lockHash) stop('Profile changed since recorded expectation; refuse mutation.'); return now }
async function snapshots(r) { for (const collection of [r.old, r.next]) for (const p of collection) if ((await payload(p.root)).digest !== p.digest) stop('Immutable artifact changed; refuse operation.') }
async function compatibleSnapshots(s, r) {
  for (const dir of new Set([...Object.values(r.newClosure).map(p => p.root), ...r.next.map(p => p.root)])) {
    const m = await json(path.join(dir, 'package.json'))
    if (s.boot.evaluatePluginCompatibility(m, {}, VERSION)) stop('Frozen candidate is incompatible; exemptions are forbidden.')
    if (m.dsh?.bundle) s.boot.assertBundlePlatform(m.dsh.bundle.platforms, process.platform)
  }
}
function approvedPost(manifest, before, r) { const text = JSON.stringify(JSON.parse(manifest)); return text === JSON.stringify(JSON.parse(before)) || hash(text) === r.expectedPostManifestHash }
function fresh(a, r, phase) {
  execFileSync(process.execPath, ['--expose-internals', self, 'verify', '--stage-dir', a['stage-dir'], '--desktop-exe', r.exe, '--runtime-dir', r.runtime, '--phase', phase], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true })
}
async function main(a) {
  const stage = absolute(a['stage-dir'])
  if (a.mode === 'prepare') {
    const s = await sdk(a), observed = owned(processes(), s.exe, s.home)
    if (!observed.some(p => p.ProcessId === Number(a['host-pid']) && p.Created) || !await alive(a.origin)) stop('Prepare requires the identified running installed Host and responsive actual origin.')
    const before = await state(s), current = JSON.parse(before.manifest), view = await layers(s), old = []
    for (const n of names) { const spec = current.dependencies?.[n]; if (typeof spec !== 'string' || !spec.startsWith('file:')) stop('All three roots must already be direct frozen file dependencies.'); const p = await payload(absolute(spec.slice(5))); if ((await payload(s.boot.resolveBundleDir('dsh', n, s.anchor, s.profile))).digest !== p.digest) stop('Installed root differs from captured dependency.'); old.push(p) }
    check(old[0], UI, '0.1.1'); check(old[1], BRIDGE, a['expected-bridge-version']); check(old[2], ROLE, a['expected-role-version'])
    const ui = await payload(a['ui-bundle']), bridge = await payload(a['bridge-bundle'])
    if (!a['ui-sha256'] || !a['bridge-sha256']) stop('Both operator-approved payload digests are required.')
    check(ui, UI, '0.1.3', a['ui-sha256']); check(bridge, BRIDGE, '0.1.2', a['bridge-sha256'])
    for (const [i, p] of [ui, bridge].entries()) if (!same(patchBytes(s, old[i]), patchBytes(s, p))) stop('Repair may change artifacts only, not bundle patch bytes/configuration.')
    if (!same(Object.keys(old[2].manifest.dependencies ?? {}).sort(), [UI, BRIDGE].sort())) stop('Unexpected role dependency graph; manual review required.')
    for (const p of old.slice(0, 2)) { const spec = old[2].manifest.dependencies[p.manifest.name]; if (typeof spec !== 'string' || !spec.startsWith('file:') || spec.includes('\0') || key(await realpath(path.resolve(old[2].root, spec.slice(5)))) !== key(p.root)) stop('Role dependency resolves outside the verified old root snapshot.') }
    patchBytes(s, old[2]); if ([...old, ui, bridge].some(p => inside(p.root, stage) || inside(stage, p.root)) || inside(s.home, stage) || inside(stage, s.home)) stop('Stage must be NEW and separate from home/payloads.')
    await mkdir(stage); await protect(stage)
    await put(path.join(stage, 'before.package.json'), before.manifest); await put(path.join(stage, 'before.pnpm-lock.yaml'), before.lock)
    const next = [await capture(ui, path.join(stage, 'ui')), await capture(bridge, path.join(stage, 'bridge'))]
    const roleFiles = new Map(old[2].files), roleManifest = { ...old[2].manifest, version: `${old[2].manifest.version}-repair.1`, dependencies: { [UI]: fileSpec(next[0].root), [BRIDGE]: fileSpec(next[1].root) } }
    roleFiles.set('package.json', Buffer.from(JSON.stringify(roleManifest, null, 2) + '\n')); next.push(await capture({ files: roleFiles }, path.join(stage, 'role')))
    const oldClosure = { ...await closure(old[0]), ...await closure(old[1]) }, newClosure = { ...await closure(next[0]), ...await closure(next[1]) }
    const replacements = Object.fromEntries(next.map(p => [p.manifest.name, fileSpec(p.root)]))
    for (const [n, spec] of Object.entries(current.dependencies ?? {})) if (!names.includes(n) && n.startsWith('@dsh-remote/') && oldClosure[n]) { if (typeof spec !== 'string' || !spec.startsWith('file:') || key(await realpath(absolute(spec.slice(5)))) !== key(oldClosure[n].root) || !newClosure[n]) stop('Direct leaf pin outside reviewed old/new closure.'); replacements[n] = fileSpec(newClosure[n].root) }
    const compact = p => ({ root: p.root, digest: p.digest, name: p.manifest.name })
    const resolution = await s.boot.createRuntimeResolution({ installAnchor: s.anchor, profile: view.profile, home: s.home })
    const installation = resolution.entries.filter(e => e.scope === 'installation').map(e => [e.name, e.packageDir, e.version])
    const expectedPostManifestHash = hash(JSON.stringify({ ...current, dependencies: { ...current.dependencies, ...replacements } }))
    const receipt = { version: 1, expectedPostManifestHash, installation, helperHash: hash(await readFile(self)), exe: s.exe, runtime: s.runtime, profile: s.profile, home: s.home, origin: a.origin, processes: observed, before: { manifestHash: before.manifestHash, lockHash: before.lockHash }, selection: view.bundles, patchHashes: view.hashes, userHash: view.userHash, old: old.map(compact), next: next.map(compact), oldClosure, newClosure, replacements }
    await cas(s, before); await put(path.join(stage, 'receipt.json'), receipt)
    console.log('Prepared protected artifact repair only. No profile mutation. Quit Desktop/Host, then apply.'); return
  }
  const r = await json(path.join(stage, 'receipt.json'))
  if (r.version !== 1 || r.helperHash !== hash(await readFile(self)) || key(a['desktop-exe']) !== key(r.exe) || key(a['runtime-dir']) !== key(r.runtime)) stop('Receipt/helper/carrier mismatch.')
  const s = await sdk({ ...a, 'profile-dir': r.profile, home: r.home }); await snapshots(r)
  if (a.mode === 'verify') {
    const after = a.phase === 'after', backup = await readFile(path.join(stage, 'before.package.json'))
    if (hash(backup) !== r.before.manifestHash) stop('Manifest backup changed.')
    const expected = JSON.parse(backup)
    if (after) expected.dependencies = { ...expected.dependencies, ...r.replacements }
    if (!same(s.boot.readProfileManifest('dsh', s.profile), expected)) stop('Profile manifest differs outside the exact approved replacement specs.')
    const view = await layers(s)
    if (!same(view.bundles, r.selection) || !same(view.hashes, r.patchHashes) || view.userHash !== r.userHash) stop('Bundle order/patch/configuration changed.')
    const resolution = await s.boot.createRuntimeResolution({ installAnchor: s.anchor, profile: view.profile, home: s.home }), map = new Map(resolution.entries.map(e => [e.name, e.packageDir]))
    if (!same(resolution.entries.filter(e => e.scope === 'installation').map(e => [e.name, e.packageDir, e.version]), r.installation)) stop('Installed shared runtime resolution baseline changed.')
    for (const p of after ? r.next : r.old) if ((await payload(s.boot.resolveBundleDir('dsh', p.name, s.anchor, s.profile))).digest !== p.digest) stop('Installed root payload differs from frozen artifact.')
    for (const [n, p] of Object.entries(after ? r.newClosure : r.oldClosure)) { const dir = Object.hasOwn(expected.dependencies ?? {}, n) ? s.boot.resolveBundleDir('dsh', n, s.anchor, s.profile) : map.get(n); if (!dir || (await payload(dir)).digest !== p.digest) stop('Resolved leaf closure is stale or ambiguous.') }
    console.log('Fresh-process public resolver verified exact artifact closure and unchanged configuration.'); return
  }
  await closed(a, r)
  if (a.mode === 'apply') {
    await cas(s, r.before); fresh(a, r, 'before')
    await s.atomic.withFileLock(s.file, async () => {
      await closed(a, r); const before = await cas(s, r.before)
      await snapshots(r); await compatibleSnapshots(s, r)
      await put(path.join(stage, 'apply.started'), 'One-shot apply; interruption requires operator recovery.\n')
      // Public runProfilePnpm requires this caller-held writer lock; never nest runPluginCommand here.
      let exitCode = -1
      try { exitCode = (await s.ops.runProfilePnpm(context(s), ['add', ...Object.values(r.replacements), ...installFlags], policy(s))).exitCode } catch { /* A throwing package operation may have mutated files; classify, never blindly authorize, its observed post-state. */ }
      const post = await state(s), rollbackAllowed = approvedPost(post.manifest, before.manifest, r)
      const actualSpecs = JSON.parse(post.manifest).dependencies ?? {}, normalizedTargetSpecs = Object.entries(r.replacements).every(([n, spec]) => actualSpecs[n] === spec)
      await put(path.join(stage, 'post.json'), { manifestHash: post.manifestHash, lockHash: post.lockHash, expectedPostManifestHash: r.expectedPostManifestHash, normalizedTargetSpecs, rollbackAllowed, exitCode })
      if (!rollbackAllowed) stop('Unapproved post-operation metadata/selection/dependency changes. Automatic rollback is NOT authorized; keep app closed for operator review.')
      if (exitCode !== 0) stop('Package operation failed. Keep app closed; explicit rollback is available only against the classified post-state.')
      if (!normalizedTargetSpecs) stop('Actual pnpm dependency specs differ from planned canonical slash pins; keep app closed.')
    }, { waitMs: 120000 })
    fresh(a, r, 'after'); console.log('Repair verified. Close this console, then open the SAME installed app normally.'); return
  }
  const post = await json(path.join(stage, 'post.json'))
  if (post.rollbackAllowed !== true || post.expectedPostManifestHash !== r.expectedPostManifestHash) stop('Post-state is not approved for automatic restoration; operator review required.')
  await s.atomic.withFileLock(s.file, async () => {
    await closed(a, r); const now = await cas(s, post)
    const manifest = await readFile(path.join(stage, 'before.package.json')), lock = await readFile(path.join(stage, 'before.pnpm-lock.yaml'))
    if (hash(manifest) !== r.before.manifestHash || hash(lock) !== r.before.lockHash) stop('Rollback backup hash mismatch.')
    if (!approvedPost(now.manifest, manifest, r)) stop('Unrelated metadata would be overwritten; rollback refused.')
    await s.atomic.writeFileAtomic(s.file, manifest, { mode: 0o600 }); await s.atomic.writeFileAtomic(path.join(s.profile, 'pnpm-lock.yaml'), lock, { mode: 0o600 })
    const result = await s.ops.runProfilePnpm(context(s), ['install', '--frozen-lockfile', ...installFlags], policy(s))
    if (result.exitCode !== 0) stop('Rollback install failed; keep app closed. Backups/frozen snapshots retained for operator recovery.')
    await cas(s, r.before)
  }, { waitMs: 120000 })
  fresh(a, r, 'before'); console.log('Old immutable dependency closure restored. Selection/settings/journals unchanged; close console before opening app.')
}
Promise.resolve().then(() => main(argsOf(process.argv.slice(2)))).catch(e => { console.error(e instanceof RepairError ? e.message : 'Repair stopped; no raw configuration/error contents printed. Keep app closed after any mutation; inspect protected package-manager diagnostics locally.'); process.exitCode = 1 })
