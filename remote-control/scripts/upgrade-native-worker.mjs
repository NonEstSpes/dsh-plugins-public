#!/usr/bin/env node
/** User-run, local v1 -> staged v2 migration. Never activates a profile, overwrites v1, discovers Sessions, or runs a remote task. */
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, realpath, lstat, readdir, chmod } from 'node:fs/promises'
import { parseSettingsV2, canonicalStateDirectory } from '../lib/federation/settings.mjs'
import { parseGrant } from '../lib/federation/grants.mjs'

class UpgradeError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
const fail = (code, message) => { throw new UpgradeError(code, message) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
const hash = value => createHash('sha256').update(value).digest('hex')
const keyPath = value => process.platform === 'win32' ? value.toLowerCase() : value
function inside(a, b) { const relative = path.relative(keyPath(a), keyPath(b)); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) }
const overlap = (a, b) => inside(a, b) || inside(b, a)
function exact(value, required, optional = []) {
  if (!plain(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => ![...required, ...optional].includes(key))) fail('INPUT_FIELDS', 'Неверные поля входного документа. Используйте документированный формат.')
}
function argumentsOf(argv) {
  const value = {}
  const flags = new Set(['help', 'stage-install', 'app-closed'])
  const names = new Set(['legacy-settings', 'legacy-state-dir', 'project-map', 'state-dir', 'out', 'bridge-row-id', 'runtime-dir', 'pnpm-entry', 'home', 'profile', 'bundle', 'bundle-sha256', 'bridge-package', 'bridge-sha256', 'lock-wait-ms', 'lookup-timeout-ms'])
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].startsWith('--') ? argv[i].slice(2) : ''
    if ((!flags.has(name) && !names.has(name)) || Object.hasOwn(value, name)) fail('ARGUMENTS', 'Неизвестный или повторный параметр.')
    if (flags.has(name)) value[name] = true
    else { if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('ARGUMENTS', 'Отсутствует значение параметра.'); value[name] = argv[++i] }
  }
  return value
}
function absolute(value) { if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0')) fail('PATH', 'Все пути должны быть явными абсолютными путями.'); return path.resolve(value) }
async function existingDirectory(value) { try { const result = await realpath(absolute(value)); if (!(await lstat(result)).isDirectory()) fail('PATH', 'Ожидается существующий каталог.'); return result } catch (error) { if (error instanceof UpgradeError) throw error; fail('PATH', 'Не удалось проверить каталог.') } }
async function jsonInput(filename) {
  try { const bytes = await readFile(filename); if (bytes.length > 131072) fail('INPUT_SIZE', 'Входной документ превышает допустимый размер.'); return { bytes, value: JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')) } }
  catch (error) { if (error instanceof UpgradeError) throw error; fail('INPUT_JSON', 'Не удалось прочитать или разобрать входной JSON. Значения конфигурации не выводятся.') }
}
async function absent(filename) { try { await lstat(filename) } catch (error) { if (error.code === 'ENOENT') return; fail('PATH', 'Не удалось проверить новый путь.') } fail('EXISTS', 'Новый выходной каталог и v2 state-dir не должны существовать. Старые данные не перезаписываются.') }
async function protectNewDirectory(directory) {
  if (process.platform !== 'win32') { await chmod(directory, 0o700); return }
  if (!process.env.USERNAME || !process.env.USERDOMAIN) fail('ACL', 'Не удалось определить текущего пользователя для защиты новых файлов.')
  const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject); child.once('exit', resolve)
  }).catch(() => { fail('ACL', 'Не удалось защитить новый каталог. Секретные файлы не записаны.') })
  if (exitCode !== 0) fail('ACL', 'Не удалось защитить новый каталог. Секретные файлы не записаны.')
}
async function exclusive(filename, value) { await writeFile(filename, value, { flag: 'wx', mode: 0o600 }) }
function integer(value, fallback) { if (value === undefined) return fallback; if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('ARGUMENTS', 'Ожидается положительное целое значение таймаута.'); return Number(value) }

/** Hash an explicit local payload without following symlinks or including undeclared parent files. */
async function bundlePayload(directory, expected) {
  const root = await existingDirectory(directory)
  const manifest = (await jsonInput(path.join(root, 'package.json'))).value
  if (!plain(manifest) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string' || !Array.isArray(manifest.files) || !plain(manifest.dsh?.bundle) || typeof manifest.dsh.bundle.patch !== 'string') fail('BUNDLE', 'Ожидается локальный готовый DSH bundle с явным списком files.')
  const entries = new Map(), files = new Map()
  async function visit(relative) {
    const filename = path.resolve(root, relative)
    if (!inside(root, filename) || filename === root) fail('BUNDLE', 'Неверный путь в bundle payload.')
    const stat = await lstat(filename)
    if (stat.isSymbolicLink()) fail('BUNDLE', 'Ссылки в устанавливаемом payload запрещены.')
    if (stat.isDirectory()) { for (const child of (await readdir(filename)).sort()) await visit(path.join(relative, child)); return }
    if (!stat.isFile()) fail('BUNDLE', 'Неподдерживаемый файл bundle payload.')
    const relativeName = path.relative(root, filename).split(path.sep).join('/')
    const bytes = await readFile(filename)
    entries.set(relativeName, hash(bytes)); files.set(relativeName, bytes)
  }
  await visit('package.json')
  for (const file of manifest.files) { if (typeof file !== 'string' || /[*?]/.test(file)) fail('BUNDLE', 'Bundle files должны быть явными путями без glob.'); await visit(file) }
  const digest = hash(JSON.stringify([...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || digest !== expected) fail('BUNDLE_HASH', 'SHA256 payload не совпадает с опубликованным доверенным значением. Установка отменена.')
  const capturedManifest = JSON.parse(files.get('package.json').toString('utf8'))
  for (const [filename, bytes] of files) {
    if (path.basename(filename) !== 'package.json') continue
    const item = JSON.parse(bytes.toString('utf8'))
    for (const group of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) for (const spec of Object.values(item[group] ?? {})) {
      if (typeof spec !== 'string') fail('BUNDLE', 'Неверный dependency spec в payload.')
      if (/^(?:link|workspace|portal):/.test(spec) || (spec.startsWith('file:') && !inside(root, path.resolve(root, path.dirname(filename), spec.slice(5))))) fail('BUNDLE', 'Локальные зависимости должны полностью находиться внутри проверенного payload.')
    }
  }
  return { root, manifest: capturedManifest, digest, files }
}

/** Install from protected captured bytes, not a directory that can change after checksum validation. */
async function materialize(payload, directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const [relative, bytes] of payload.files) {
    const filename = path.resolve(directory, relative)
    if (!inside(directory, filename)) fail('BUNDLE', 'Неверный путь snapshot payload.')
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 })
    await exclusive(filename, bytes)
  }
  await bundlePayload(directory, payload.digest)
  return directory
}

async function roleConfigBundle(out, settingsFile, rowId, nativeVersion, nativeAPIConfig, dependencies = {}) {
  const directory = path.join(out, 'worker-role-config')
  await mkdir(directory, { mode: 0o700 })
  const manifest = { name: '@dsh-remote/worker-role-config', version: '0.1.0', private: true, type: 'module', engines: { dsh: nativeVersion }, exports: { '.': './index.js' }, files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } }, ...(Object.keys(dependencies).length ? { dependencies } : { peerDependencies: { '@dsh-remote/control-bridge': '0.1.0', '@dsh-remote/worker-extension': '0.1.0' } }) }
  await exclusive(path.join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await exclusive(path.join(directory, 'index.js'), "export const name = 'remote-worker-role-config';\nexport function apply() {}\n")
  await exclusive(path.join(directory, 'cordis.patch.yml'), `${JSON.stringify([{ id: 'remote-worker-session-controller', config: nativeAPIConfig }, { id: rowId, config: { settingsFile } }], null, 2)}\n`)
  const pairs = []
  for (const file of ['package.json', 'index.js', 'cordis.patch.yml']) pairs.push([file, hash(await readFile(path.join(directory, file)))])
  pairs.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return { directory, manifest, sha256: hash(JSON.stringify(pairs)), patchSha256: hash(await readFile(path.join(directory, 'cordis.patch.yml'))) }
}

async function main(argv) {
  const args = argumentsOf(argv)
  if (args.help) {
    console.log('Только локальная подготовка: --legacy-settings ABS --project-map ABS --state-dir NEW_ABS --out NEW_ABS --bridge-row-id ID\nНеобязательная неактивная установка: --stage-install --app-closed --runtime-dir ABS --pnpm-entry ABS --home ABS --profile desktop --bundle ABS --bundle-sha256 HEX\nОбновлённый bridge при отдельной поставке: --bridge-package ABS --bridge-sha256 HEX. Старый v1, профильная композиция и state не перезаписываются. Полный формат: инструкции Worker upgrade.')
    return
  }
  for (const name of ['legacy-settings', 'project-map', 'state-dir', 'out', 'bridge-row-id']) if (!args[name]) fail('ARGUMENTS', 'Не заданы обязательные параметры. Используйте --help.')
  if (args['bridge-row-id'] !== 'remote-native-control-bridge') fail('ARGUMENTS', 'Для нового host-only bridge требуется id remote-native-control-bridge; старая строка не подменяется.')
  const legacySelected = absolute(args['legacy-settings'])
  const legacyFile = await realpath(legacySelected)
  const legacy = await jsonInput(legacyFile)
  if (!plain(legacy.value) || legacy.value.role !== 'worker' || (legacy.value.version !== undefined && legacy.value.version !== 1)) fail('LEGACY', 'Исходный документ должен быть конфигурацией Worker v1. Ремонт или перезапись v2 не поддерживаются.')
  const old = legacy.value
  const input = (await jsonInput(absolute(args['project-map']))).value
  exact(input, ['version', 'machineKey', 'pairingGeneration', 'workspaces', 'grant', 'nativeAPIConfig'], ['label'])
  if (input.version !== 1 || !plain(input.workspaces) || !Number.isSafeInteger(input.pairingGeneration) || input.pairingGeneration < 1) fail('INPUT', 'Неверный формат явной карты Worker.')
  exact(input.nativeAPIConfig, [], ['nativeOpen', 'listWorkSliceMs'])
  if ((Object.hasOwn(input.nativeAPIConfig, 'nativeOpen') && typeof input.nativeAPIConfig.nativeOpen !== 'boolean') || (Object.hasOwn(input.nativeAPIConfig, 'listWorkSliceMs') && (typeof input.nativeAPIConfig.listWorkSliceMs !== 'number' || !Number.isFinite(input.nativeAPIConfig.listWorkSliceMs)))) fail('API_CONFIG', 'Native API config требует явно проверенные literal boolean/number; неизвестные поля и выражения не копируются.')
  let grant
  try { grant = parseGrant(input.grant) } catch (error) { fail('GRANT', 'Grant не прошёл строгую проверку. Исправьте явные права, principal, классы и revision.') }
  if (grant.machineKey !== input.machineKey || grant.principal.id !== old.peerId) fail('PAIR', 'Grant должен явно называть выбранную машину и аутентифицированного Controller из v1.')
  if (Object.keys(input.workspaces).length !== grant.projects.length || grant.projects.some(project => !Object.hasOwn(input.workspaces, project.projectId))) fail('WORKSPACES', 'Карта workspace должна точно соответствовать проектам grant.')
  const projects = {}, workspaces = new Map(), roots = [], sessionIds = new Set()
  for (const project of grant.projects) {
    const item = input.workspaces[project.projectId]
    exact(item, ['workspaceId', 'workspacePath'], ['title'])
    const root = await existingDirectory(item.workspacePath)
    if (typeof item.workspaceId !== 'string' || !item.workspaceId || workspaces.has(item.workspaceId)) fail('WORKSPACES', 'Требуются явные уникальные native workspaceId. Они не выводятся из cwd.')
    workspaces.set(item.workspaceId, { path: root }); roots.push(root)
    projects[project.projectId] = { workspaceId: item.workspaceId, ...(item.title === undefined ? {} : { title: item.title }) }
    for (const session of project.sessions) {
      if (session.imported !== true || sessionIds.has(session.sessionId)) fail('SESSIONS', 'Только явно перечисленные уникальные существующие sessionId с imported:true; автоматического импорта нет.')
      sessionIds.add(session.sessionId)
    }
  }
  const outRequested = absolute(args.out), parent = await existingDirectory(path.dirname(outRequested))
  const out = path.join(parent, path.basename(outRequested))
  await absent(out)
  const stateDir = await canonicalStateDirectory(absolute(args['state-dir']))
  await absent(stateDir)
  const legacyStateInput = args['legacy-state-dir'] ?? old.stateDir
  if (typeof legacyStateInput !== 'string' || !legacyStateInput) fail('LEGACY_STATE', 'Если v1 не содержит stateDir, явно задайте --legacy-state-dir. Значение не угадывается.')
  const legacyState = await canonicalStateDirectory(args['legacy-state-dir'] ? absolute(args['legacy-state-dir']) : path.resolve(path.dirname(legacySelected), legacyStateInput))
  if (overlap(stateDir, legacyState) || overlap(out, legacyState) || overlap(stateDir, out) || roots.some(root => overlap(root, out) || overlap(root, stateDir))) fail('PATH_SCOPE', 'Новые settings/state должны быть вне рабочих проектов, вне v1 state и раздельно друг от друга.')
  const settingsFile = path.join(out, 'worker-v2.settings.json')
  const settings = { version: 2, role: 'worker', id: old.id, machineKey: input.machineKey, ...(input.label === undefined ? {} : { label: input.label }), projects, pairs: [{ id: old.id, peerId: old.peerId, machineKey: input.machineKey, protocol: 2, pairingGeneration: input.pairingGeneration, relayUrl: old.relayUrl, relayToken: old.relayToken, sharedKey: old.sharedKey, stateDir, ...(old.allowLoopback === undefined ? {} : { allowLoopback: old.allowLoopback }), grant }] }
  try { await parseSettingsV2(settings, settingsFile, { resolveWorkspace: id => workspaces.get(id) }) } catch (error) { fail('V2_SETTINGS', 'Настройки v2 не прошли проверку. Значения pairing и секреты не выводятся.') }
  let installation
  const installOnly = ['app-closed', 'runtime-dir', 'pnpm-entry', 'home', 'profile', 'bundle', 'bundle-sha256', 'bridge-package', 'bridge-sha256', 'lock-wait-ms', 'lookup-timeout-ms']
  if (!args['stage-install'] && installOnly.some(name => args[name] !== undefined)) fail('ARGUMENTS', 'Параметры установки требуют stage-install. Для подготовки только конфигурации они не применяются.')
  if ((args['bridge-package'] === undefined) !== (args['bridge-sha256'] === undefined)) fail('ARGUMENTS', 'Отдельный bridge требует одновременно bridge-package и bridge-sha256.')
  if (args['stage-install']) {
    if (!args['app-closed']) fail('APP_RUNNING', 'Перед установкой закройте Worker app и подтвердите --app-closed. Автоматического завершения процессов нет.')
    for (const name of ['runtime-dir', 'pnpm-entry', 'home', 'profile', 'bundle', 'bundle-sha256']) if (!args[name]) fail('ARGUMENTS', 'Для stage-install требуются явные runtime, pnpm, home, profile и проверенный bundle.')
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(args.profile)) fail('PROFILE', 'Неверный явный профиль.')
    const home = await existingDirectory(args.home)
    const profileDir = await existingDirectory(path.join(home, 'profiles', args.profile))
    if (keyPath(profileDir) !== keyPath(path.join(home, 'profiles', args.profile))) fail('PROFILE', 'Перенаправленный каталог профиля требует отдельной ручной проверки.')
    const profileFile = path.join(profileDir, 'package.json')
    const profileStat = await lstat(profileFile)
    if (!profileStat.isFile() || profileStat.isSymbolicLink()) fail('PROFILE', 'Требуется существующий обычный profile/package.json; ссылки и инициализация профиля запрещены.')
    const profile = await jsonInput(profileFile) // MUST exist BEFORE public installer; never initializes a profile.
    if (!plain(profile.value)) fail('PROFILE', 'Профиль должен иметь существующий package.json.')
    const runtime = await existingDirectory(args['runtime-dir'])
    const pnpmEntry = await realpath(absolute(args['pnpm-entry']))
    if (!(await lstat(pnpmEntry)).isFile()) fail('PNPM', 'Неверный явный pnpm entry.')
    const bundle = await bundlePayload(args.bundle, args['bundle-sha256'])
    if (bundle.manifest.name !== '@dsh-remote/worker-extension' || bundle.manifest.version !== '0.1.0') fail('WORKER_ROLE', 'Требуется отдельный Worker-only extension 0.1.0, не Controller/UI bundle.')
    if (!args['bridge-package']) fail('BRIDGE_REQUIRED', 'Для полной подготовки требуется отдельный host-only control bridge.')
    const payloads = [bundle, await bundlePayload(args['bridge-package'], args['bridge-sha256'])]
    if (payloads[1].manifest.name !== '@dsh-remote/control-bridge' || payloads[1].manifest.version !== '0.1.0') fail('BRIDGE_REQUIRED', 'Требуется host-only @dsh-remote/control-bridge 0.1.0 без legacy client dock.')
    if (new Set(payloads.map(payload => payload.manifest.name)).size !== payloads.length) fail('BUNDLE', 'Native bundle и отдельный bridge должны быть разными пакетами.')
    if (payloads.some(payload => overlap(out, payload.root)) || overlap(out, profileDir) || overlap(out, runtime)) fail('PATH_SCOPE', 'Секретный staging каталог не должен находиться в payload, SDK или каталоге профиля.')
    if (profile.value.dependencies?.[bundle.manifest.name] !== undefined || profile.value.devDependencies?.[bundle.manifest.name] !== undefined) fail('ALREADY_INSTALLED', 'Native bundle уже записан в профиле. Для повторного обновления используйте проверку менеджера; либо уберите stage-install для подготовки только конфигурации.')
    const require = createRequire(path.join(runtime, 'package.json'))
    let operations, installAnchor, nativeVersion
    try { operations = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-plugin-manager/operations')).href); installAnchor = require.resolve('@deepseek-ai/dsh/package.json'); nativeVersion = (await jsonInput(installAnchor)).value.version } catch (error) { fail('SDK', 'Не найден подтверждённый публичный SDK установленного runtime. PATH dsh не используется.') }
    if (typeof operations.runPluginCommand !== 'function' || payloads.some(payload => payload.manifest.engines?.dsh !== nativeVersion)) fail('SDK_VERSION', 'Версия runtime должна точно соответствовать engines.dsh выбранных bundle. Обход проверки версий запрещён.')
    try { const api = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-api-session-controller')).href); api.default.Config(input.nativeAPIConfig) } catch (error) { fail('API_CONFIG', 'Явные API параметры не прошли реальную SDK schema. Значения не заменяются defaults; требуется локальная проверка.') }
    installation = { operations, installAnchor, home, profileDir, profileFile, profile, pnpmEntry, payloads, nativeVersion }
  }
  await mkdir(out, { mode: 0o700 }) // no recursive creation, no existing-directory overwrite
  if (keyPath(await realpath(out)) !== keyPath(out)) fail('PATH_SCOPE', 'Каталог staging изменил разрешённый путь.')
  await protectNewDirectory(out) // BEFORE any credential copy
  await exclusive(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
  await exclusive(path.join(out, 'legacy-worker-settings.backup.json'), legacy.bytes)
  await exclusive(path.join(out, 'worker-settings-pointer.patch.json'), `${JSON.stringify([{ id: args['bridge-row-id'], config: { settingsFile } }], null, 2)}\n`)
  const receipt = { version: 1, stagedAt: new Date().toISOString(), activated: false, settingsFile, machineKey: input.machineKey, localEndpointId: old.id, peerEndpointId: old.peerId, pairingGeneration: input.pairingGeneration, grantRevision: grant.revision, projectCount: grant.projects.length, explicitImportedSessionCount: sessionIds.size, legacySettingsSha256: hash(legacy.bytes), settingsSha256: hash(await readFile(settingsFile)), nativeAPIConfig: input.nativeAPIConfig, legacyUnchanged: true, stateDirCreated: false, workspaceBinding: 'operator-declared paths only; exact native workspaceId bindings must be checked by Worker startup before journal writes', installation: null }
  if (installation) {
    await exclusive(path.join(out, 'profile-package.before.json'), installation.profile.bytes)
    const snapshots = []
    for (const [index, payload] of installation.payloads.entries()) snapshots.push(await materialize(payload, path.join(out, 'install-payloads', `package-${index}`)))
    const roleDependencies = Object.fromEntries(installation.payloads.map((payload, index) => [payload.manifest.name, `file:${snapshots[index]}`]))
    const role = await roleConfigBundle(out, settingsFile, args['bridge-row-id'], installation.nativeVersion, input.nativeAPIConfig, roleDependencies)
    receipt.roleConfig = { name: role.manifest.name, version: role.manifest.version, directory: role.directory, sha256: role.sha256, patchSha256: role.patchSha256, credentialsIncluded: false }
    snapshots.push(role.directory)
    console.log('Локальная неактивная установка через публичный менеджер. Секреты и вывод дочернего установщика скрыты.')
    let result
    try {
      result = await installation.operations.runPluginCommand({ profile: args.profile, dir: installation.profileDir, home: installation.home, installAnchor: installation.installAnchor, cwd: out }, ['add', ...snapshots.map(directory => `file:${directory}`), '--ignore-scripts', '--config.auto-install-peers=false', '--prefer-offline'], { command: process.execPath, args: [...(process.env.ELECTRON_RUN_AS_NODE === '1' ? ['--expose-internals'] : []), installation.pnpmEntry], execution: 'cli', outputBytes: 16384, lockWaitMs: integer(args['lock-wait-ms'], 120000), lookupTimeoutMs: integer(args['lookup-timeout-ms'], 120000), activateNewBundles: false, onOutput: () => {} })
    } catch (error) { result = { exitCode: null } }
    receipt.installation = { exitCode: result.exitCode ?? null, nativeVersion: installation.nativeVersion, autoActivationRequested: false, scriptsAllowed: false, payloads: installation.payloads.map(payload => ({ name: payload.manifest.name, version: payload.manifest.version, sha256: payload.digest })) }
    receipt.legacyUnchanged = hash(await readFile(legacyFile)) === receipt.legacySettingsSha256
    await exclusive(path.join(out, 'worker-upgrade.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
    if (result.exitCode !== 0 || !receipt.legacyUnchanged) fail('INSTALL_INCOMPLETE', 'Установка не подтверждена. Не активируйте v2; проверьте приватный receipt и менеджер. Старые settings не восстанавливаются и не перезаписываются автоматически.')
  } else {
    const role = await roleConfigBundle(out, settingsFile, args['bridge-row-id'], '0.2.2-rc.1', input.nativeAPIConfig)
    receipt.roleConfig = { name: role.manifest.name, version: role.manifest.version, directory: role.directory, sha256: role.sha256, patchSha256: role.patchSha256, credentialsIncluded: false }
    await exclusive(path.join(out, 'worker-upgrade.receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  }
  await exclusive(path.join(out, 'NEXT-STEPS.txt'), 'Это staging, не подтверждение готового соединения.\n1. Старый v1 settings/state сохранён и не заменён.\n2. Активируйте ТОЛЬКО согласованный Worker-вариант bundle публичным менеджером при закрытом приложении. Сохраните прежние настройки API (nativeOpen и другие); не подменяйте их фиксированными значениями.\n3. Обновлённый v2 bridge также должен быть установлен. Примените worker-settings-pointer.patch.json только после проверки его id строки и Worker-role patch. Не правьте внутреннюю БД менеджера.\n4. При старте Worker проверит реальные workspaceId; перед подтверждением этой проверки не считайте созданные файлы доказательством native mapping.\n5. Controller должен отдельно настроить ту же machineKey/pairingGeneration и собственный relayToken. Нельзя использовать Worker token в Controller.\n6. Только свежий аутентифицированный ответ и точный NEW Worker API owner включат mutation readiness. Не форсируйте флаги.\n7. Перезапустите Worker только ПРЕЖНИМ shortcut/proxy-launcher. DPAPI/proxy/trusted CA не менять. При fetch/proxy/cache ошибке остановитесь, без обхода TLS/CA; используется prefer-offline.\n')
  console.log(`Подготовлено: проектов ${grant.projects.length}, явно импортируемых сессий ${sessionIds.size}. V1 не перезаписан; v2 state не создан; профиль не активирован. См. приватный receipt и NEXT-STEPS в выбранном staging каталоге.`)
}

main(process.argv.slice(2)).catch(error => {
  if (error instanceof UpgradeError) console.error(`${error.code}: ${error.message}`)
  else console.error('UPGRADE_FAILED: Подготовка не завершена. Значения конфигурации и секреты не выводятся; проверьте права и выбранные файлы локально. Частичный staging не удаляется автоматически.')
  process.exitCode = 1
})
