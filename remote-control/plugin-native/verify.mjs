/** Verify the emitted module graph without loading any Host provider or touching a profile. */
import { readFile, readdir, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const bundle = path.join(here, 'bundle');
const require = createRequire(path.join(root, 'package.json'));
const ts = require('typescript');
const { PLATFORM_MODULES } = await import(pathToFileURL(path.join(root, 'packages/client/web/src/platform.ts')).href);
const report = JSON.parse(await readFile(path.join(bundle, 'build-report.json'), 'utf8'));
const results = [];
for (const provider of report.providers) {
  const dir = path.join(bundle, 'packages', provider.name.split('/')[1]);
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  for (const [name, target] of Object.entries(manifest.exports)) {
    if (typeof target !== 'string' || target.includes('*')) continue;
    if (!(await stat(path.resolve(dir, target))).isFile()) throw new Error(`${provider.name}: missing export ${name} → ${target}`);
  }
  for (const file of (await readdir(path.join(dir, 'lib'))).filter(name => name.endsWith('.js') && !name.startsWith('client'))) {
    const ast = ts.createSourceFile(file, await readFile(path.join(dir, 'lib', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    for (const statement of ast.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        if (!(await stat(path.resolve(dir, 'lib', specifier))).isFile()) throw new Error(`${provider.name}: missing Host relative import ${specifier}`);
      } else if (!specifier.startsWith('node:') && !Object.keys(manifest.peerDependencies ?? {}).some(peer => specifier === peer || specifier.startsWith(peer + '/'))) {
        throw new Error(`${provider.name}: undeclared Host peer ${specifier}`);
      }
    }
  }
  const requests = new Set();
  const identities = [];
  const dormantNodeRequests = [];
  for (const file of (await readdir(path.join(dir, 'lib'))).filter(name => /^client(?:\..*)?\.js$/u.test(name))) {
    const text = await readFile(path.join(dir, 'lib', file), 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    let nodeCanvasReferences = 0;
    let guardedNodeCanvasSelections = 0;
    let nodeProcessGuard = false;
    const isDormantPdfUrl = node => {
      if (provider.name !== '@dsh-remote/ui-sidebar-documentpreview' || file !== 'client.pdf.js' || node.arguments[0].text !== 'url') return false;
      let method = false;
      let owner = false;
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (ts.isMethodDeclaration(parent) && parent.name.getText(ast) === '_createCanvas') method = true;
        if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.name.text === 'NodeCanvasFactory') owner = true;
      }
      return method && owner;
    };
    const visit = node => {
      if (ts.isIdentifier(node) && node.text === 'NodeCanvasFactory') nodeCanvasReferences++;
      if (ts.isConditionalExpression(node) && node.condition.getText(ast) === 'isNodeJS'
          && node.whenTrue.getText(ast) === 'NodeCanvasFactory' && node.whenFalse.getText(ast) === 'DOMCanvasFactory') guardedNodeCanvasSelections++;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'isNodeJS'
          && node.initializer?.getText(ast).includes('typeof process === "object"')) nodeProcessGuard = true;
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require'
          && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        if (isDormantPdfUrl(node)) dormantNodeRequests.push({ file, request: 'url', owner: 'NodeCanvasFactory._createCanvas' });
        else requests.add(node.arguments[0].text);
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(ast) === 'id' && ts.isStringLiteral(node.initializer)
          && node.initializer.text.startsWith('@dsh-remote/')) identities.push(node.initializer.text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (provider.name === '@dsh-remote/ui-sidebar-documentpreview' && file === 'client.pdf.js'
        && (nodeCanvasReferences !== 2 || guardedNodeCanvasSelections !== 1 || !nodeProcessGuard)) {
      throw new Error('PDF Node-only factory no longer has exactly one browser-excluding process guard/selection');
    }
  }
  if (provider.name === '@dsh-remote/ui-sidebar-documentpreview' && dormantNodeRequests.length !== 1) throw new Error('PDF dormant Node request count changed');
  const allowed = new Set([...PLATFORM_MODULES, ...provider.external]);
  for (const request of requests) if (!allowed.has(request) && !request.startsWith('./')) throw new Error(`${provider.name}: undeclared browser require ${request}`);
  if (!identities.includes(provider.name)) throw new Error(`No rebuilt factory for ${provider.name}`);
  results.push({ name: provider.name, requests: [...requests].sort(), dormantNodeRequests, factory: provider.name });
}
const patch = JSON.parse(await readFile(path.join(bundle, 'cordis.patch.yml'), 'utf8'));
const disabled = patch.filter(row => row.disabled === true);
const inserted = patch.flatMap(row => row.insert ?? []);
if (new Set(inserted.map(row => row.id)).size !== inserted.length) throw new Error('Duplicate inserted Loader IDs');
if (inserted.some(row => row.name === '@deepseek-ai/dsh-api-remotes')) throw new Error('Root api-remotes must remain stock');
if (inserted.some(row => !row.name.startsWith('@dsh-remote/'))) throw new Error('Replacement provider reused a stock package name');
if (inserted.some(row => row.name === '@dsh-remote/worker-session-controller')) throw new Error('Worker fork must be separately selected');
const audit = { providers: results, factoryCount: results.length, disabledStockRows: disabled.length,
  insertedNewRows: inserted.length, rootApiRemotesReplaced: false, baselineShared: [...PLATFORM_MODULES],
  sourceDescriptorIdentity: '@dsh-remote/session-source-controller (owned declarative contribution, mounted once)',
};
await writeFile(path.join(bundle, 'module-audit.json'), JSON.stringify(audit, null, 2) + '\n');
console.log(`VERIFIED ${results.length} new factories, ${disabled.length} disable assertions, ${inserted.length} unique insertions; no unprovided browser requests`);
