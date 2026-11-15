/** Read-only verification shared by the immutable Controller publisher and its later audit. */
import { readFile, readdir, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
export const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '../../dsh-remote-core')
export const version = '0.1.8', baseName = 'bundle-stage1-0.1.6', outputName = 'bundle-release-0.1.8', reportName = 'controller-release-report.json'
export const targets = [
  ['session-controller', 'api/session-controller'], ['session-source-controller', 'api/session-source-controller'],
  ...['ui-model-selection', 'ui-workspace', 'ui-tool', 'ui-chat', 'ui-conversation', 'ui-file-actions', 'ui-session', 'file-upload'].map(id => [id, `client/${id}`]),
].map(([id, source]) => ({ id, source, name: `@dsh-remote/${id}` }))
const require = createRequire(path.join(root, 'package.json')), ts = require('typescript')
const { PLATFORM_MODULES } = await import(pathToFileURL(path.join(root, 'packages/client/web/src/platform.ts')).href)
export const hash = value => createHash('sha256').update(value).digest('hex')
export const treeHash = files => hash(Object.keys(files).sort().map(name => `${name}\0${files[name]}\n`).join(''))
export async function snapshot(directory, prefix = '') {
  const files = {}
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + entry.name, filename = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Unexpected publication link ${name}`)
    if (entry.isDirectory()) Object.assign(files, await snapshot(filename, name + '/'))
    else if (entry.isFile()) files[name] = hash(await readFile(filename))
    else throw new Error(`Unexpected publication entry ${name}`)
  }
  return files
}
export function allowed(name) {
  if (['package.json', 'cordis.patch.yml', 'icon.svg', 'locale/en.json', 'locale/ru.json', reportName].includes(name)) return true
  return targets.some(({ id }) => name === `packages/${id}/package.json` || name.startsWith(`packages/${id}/locale/`)
    || new RegExp(`^packages/${id}/lib/(?:client(?:\\.[A-Za-z0-9_-]+)*\\.js(?:\\.map)?|assets/.+)$`).test(name)
    || ((id === 'session-source-controller' || id === 'file-upload') && new RegExp(`^packages/${id}/lib/(?:index\\.js(?:\\.map)?|typert\\.(?:base|host|remote-client)\\.js)$`).test(name)))
}
/** @param directory Checked staging or final publication. @returns The exact checked tree; no installation, source writes or activation. */
export async function verifyController(directory = path.join(here, outputName)) {
  const base = await snapshot(path.join(here, baseName)), actual = await snapshot(directory), report = JSON.parse(await readFile(path.join(directory, reportName), 'utf8'))
  if (report.version !== version || report.base !== baseName || report.baseTreeHash !== treeHash(base)) throw new Error('Controller predecessor/report mismatch')
  const payload = { ...actual }; delete payload[reportName]
  if (treeHash(payload) !== report.treeHashExcludingThisReport || report.installed !== false || report.workerActivated !== false) throw new Error('Controller publication hash/status mismatch')
  const changed = Object.keys({ ...base, ...actual }).filter(name => base[name] !== actual[name] && name !== reportName)
  if (changed.some(name => !allowed(name) || !Object.hasOwn(actual, name)) || JSON.stringify(changed.sort()) !== JSON.stringify(report.changed.map(item => item.file).sort())) throw new Error('Unexpected Controller publication changes')
  for (const item of report.changed) if ((base[item.file] ?? null) !== item.before || actual[item.file] !== item.after) throw new Error('Controller changed-file receipt mismatch')
  const outer = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
  if (outer.name !== '@dsh-remote/native-session-bundle' || outer.version !== version) throw new Error('Controller package identity mismatch')
  if (outer.exports['./icon'] !== './icon.svg' || outer.exports['./locale/*.json'] !== './locale/*.json' || !['icon.svg', 'locale', reportName].every(name => outer.files.includes(name))) throw new Error('Controller display exports are missing')
  if (actual['icon.svg'] !== hash(await readFile(path.resolve(here, '../icon.svg')))) throw new Error('Approved original Controller icon changed')
  for (const [language, title] of [['en', 'Remote native sessions'], ['ru', 'Удалённые native-сессии']]) {
    const locale = JSON.parse(await readFile(path.join(directory, 'locale', language + '.json'), 'utf8'))
    if (locale.meta?.title !== title || typeof locale.meta.description !== 'string' || !locale.meta.description.trim()) throw new Error(`Controller display locale mismatch ${language}`)
  }
  const patch = JSON.parse(await readFile(path.join(directory, 'cordis.patch.yml'), 'utf8')), inserted = patch.flatMap(row => row.insert ?? [])
  if (inserted.some(row => /worker-session-controller/.test(row.name)) || new Set(inserted.map(row => row.id)).size !== inserted.length) throw new Error('Controller enables a Worker or duplicate row')
  if (!patch.some(row => row.id === 'file-upload' && row.name === '@deepseek-ai/dsh-client-file-upload' && row.disabled === true)
    || !inserted.some(row => row.id === 'remote-native-file-upload' && row.name === '@dsh-remote/file-upload')) throw new Error('File upload replacement row mismatch')
  for (const { id, name } of targets) {
    const prefix = `packages/${id}/`, manifest = JSON.parse(await readFile(path.join(directory, prefix, 'package.json'), 'utf8'))
    if (manifest.name !== name || manifest.version !== version) throw new Error(`Private provider identity mismatch ${id}`)
    if (id === 'file-upload' && manifest.peerDependencies['@deepseek-ai/dsh-client-file-upload'] !== '0.2.2-rc.1') throw new Error('File upload must share the original serving SDK Host')
    for (const target of Object.values(manifest.exports)) if (typeof target === 'string' && !target.includes('*') && !(await stat(path.join(directory, prefix, target))).isFile()) throw new Error(`Missing export ${id}`)
    const text = await readFile(path.join(directory, prefix, 'lib/client.js'), 'utf8'), factoryAst = ts.createSourceFile(id, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    let factoryIdentity = false
    const findFactory = node => {
      if (ts.isPropertyAssignment(node) && node.name.getText(factoryAst).replace(/['"]/g, '') === 'id' && ts.isStringLiteral(node.initializer) && node.initializer.text === name) factoryIdentity = true
      ts.forEachChild(node, findFactory)
    }; findFactory(factoryAst)
    if (!factoryIdentity) throw new Error(`Missing exact compiled Client factory ${id}`)
    const browser = new Set([...PLATFORM_MODULES, ...(manifest.dsh.client.external ?? [])]), peers = new Set(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
    for (const relative of Object.keys(actual).filter(file => file.startsWith(prefix) && /\.js$/.test(file) && (changed.includes(file) || /\/client(?:\.[^/]+)?\.js$/.test(file)))) {
      const source = await readFile(path.join(directory, relative), 'utf8'), ast = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
      if (ast.parseDiagnostics.length) throw new Error(`Invalid publication JavaScript ${relative}`)
      const client = /\/client(?:\.[^/]+)?\.js$/.test(relative)
      const check = specifier => {
        if (specifier.startsWith('.')) {
          const target = path.relative(directory, path.resolve(directory, path.dirname(relative), specifier)).split(path.sep).join('/')
          if (!target.startsWith(prefix) || !Object.hasOwn(actual, target)) throw new Error(`Unpublished relative import ${relative}`)
        } else if (client ? !browser.has(specifier) : !isBuiltin(specifier) && !peers.has(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0])) throw new Error(`Undeclared runtime import ${relative}: ${specifier}`)
      }
      const visit = node => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) check(node.moduleSpecifier.text)
        if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require') || (ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(ast) === 'require' && node.expression.name.text === 'async'))) check(node.arguments[0].text)
        ts.forEachChild(node, visit)
      }; visit(ast)
    }
  }
  for (const name of Object.keys(actual).filter(name => /\/locale\/[^/]+\.json$/.test(name))) JSON.parse(await readFile(path.join(directory, name), 'utf8'))
  for (const token of ['fileUploadStart', 'fileUploadChunk', 'fileUploadFinish', 'fileUploadCancel', 'fileRead', 'fileAttachment', 'fileImage', 'getProjectRegistrationState', 'getCreateState', 'registerProject', 'bindLive', 'historyFollow']) if (!(await readFile(path.join(directory, 'packages/session-source-controller/lib/typert.base.js'), 'utf8')).includes(token)) throw new Error(`Missing current Source RPC ${token}`)
  console.log(`VERIFIED ${outputName}; ${changed.length} approved changes; SHA256 ${report.treeHashExcludingThisReport}; not installed; Worker disabled`)
  return actual
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await verifyController(process.argv[2] ? path.resolve(process.argv[2]) : undefined)
