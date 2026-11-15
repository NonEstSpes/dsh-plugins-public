/** Read-only verification of the three rebuilt Controller Client factories and immutable base. */
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const base = path.join(here, 'bundle-v5');
const bundle = path.join(here, 'bundle-stage1-0.1.6');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const { PLATFORM_MODULES } = await import(pathToFileURL(path.join(root, 'packages/client/web/src/platform.ts')).href);
const hash = value => createHash('sha256').update(value).digest('hex');
async function snapshot(directory, prefix = '') {
  const result = {};
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name), key = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Unexpected artifact link ${key}`);
    if (item.isDirectory()) Object.assign(result, await snapshot(file, key + '/'));
    else if (item.isFile()) result[key] = hash(await readFile(file));
    else throw new Error(`Unexpected artifact entry ${key}`);
  }
  return result;
}
const report = JSON.parse(await readFile(path.join(bundle, 'stage1-report.json'), 'utf8'));
if (report.version !== '0.1.6' || report.baseVersion !== '0.1.4') throw new Error('Unexpected stage1 release');
const baseline = await snapshot(base), actual = await snapshot(bundle);
const allowed = new Set(['package.json', 'stage1-report.json']);
for (const { id } of report.sourcePackages) {
  if (!['session-controller', 'ui-model-selection', 'ui-workspace'].includes(id)) throw new Error('Unexpected rebuilt provider');
  for (const file of ['package.json', 'lib/client.js', 'lib/client.js.map']) allowed.add(`packages/${id}/${file}`);
  const directory = path.join(bundle, 'packages', id);
  const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  if (manifest.name !== `@dsh-remote/${id}` || manifest.version !== '0.1.2') throw new Error('Unexpected provider identity');
  for (const [name, target] of Object.entries(manifest.exports)) {
    if (typeof target !== 'string' || target.includes('*')) continue;
    if (!(await stat(path.resolve(directory, target))).isFile()) throw new Error(`Missing export ${name}`);
  }
  const text = await readFile(path.join(directory, 'lib/client.js'), 'utf8');
  const ast = ts.createSourceFile('client.js', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (ast.parseDiagnostics.length) throw new Error(`Invalid emitted JavaScript ${id}`);
  const identities = new Set(), requests = new Set();
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
      && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) requests.add(node.arguments[0].text);
    if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'id' && ts.isStringLiteral(node.initializer)
      && node.initializer.text.startsWith('@dsh-remote/')) identities.add(node.initializer.text);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (!identities.has(manifest.name)) throw new Error(`Missing exact factory ${manifest.name}`);
  const permitted = new Set([...PLATFORM_MODULES, ...(manifest.dsh?.client?.external ?? [])]);
  for (const request of requests) if (!permitted.has(request)) throw new Error(`Unprovided browser request ${id}: ${request}`);
  console.log(`FACTORY OK ${manifest.name}; ${requests.size} shared requests`);
}
for (const file of new Set([...Object.keys(baseline), ...Object.keys(actual)])) {
  if (baseline[file] !== actual[file] && !allowed.has(file)) throw new Error(`Unexpected changed file ${file}`);
}
for (const change of report.changed) {
  if (baseline[change.file] !== change.before || actual[change.file] !== change.after) throw new Error(`Changed-file receipt mismatch ${change.file}`);
}
const tree = Object.keys(actual).filter(file => file !== 'stage1-report.json').sort()
  .map(file => `${file}\0${actual[file]}\n`).join('');
if (hash(tree) !== report.treeHashExcludingThisReport) throw new Error('Artifact tree hash mismatch');
const patch = JSON.parse(await readFile(path.join(bundle, 'cordis.patch.yml'), 'utf8'));
const inserted = patch.flatMap(row => row.insert ?? []);
if (inserted.some(row => row.name === '@dsh-remote/worker-session-controller')) throw new Error('Worker must not be enabled in Controller');
if (new Set(inserted.map(row => row.id)).size !== inserted.length) throw new Error('Duplicate Loader entry');
const workerFiles = Object.keys(baseline).filter(file => file.startsWith('packages/worker-session-controller/'));
if (!workerFiles.includes('packages/worker-session-controller/lib/index.js')) throw new Error('Worker baseline is missing');
for (const file of workerFiles) if (actual[file] !== baseline[file]) throw new Error(`Worker file changed: ${file}`);
console.log(`VERIFIED stage1 ${report.version}: base preserved, ${report.changed.length} approved changed files, no Worker activation`);
