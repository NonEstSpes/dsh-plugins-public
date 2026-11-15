/** Extend a copied frozen bundle with seven conditionally selected Client guard providers. */
import { cp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const base = path.join(here, 'bundle');
const output = path.join(here, 'bundle-v2');
const scratch = path.join(root, '.dsh-build/plugin-native/optional-closure');
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href);
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href);
const ts = require('typescript');
const { PLATFORM_MODULES } = await import(pathToFileURL(path.join(root, 'packages/client/web/src/platform.ts')).href);
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const write = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function hashes(dir, prefix = '') {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name), key = prefix + entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Unexpected package link ${key}`);
    if (entry.isDirectory()) Object.assign(result, await hashes(file, key + '/'));
    else result[key] = await hash(file);
  }
  return result;
}
const features = [
  ['ui-action-cards', 'client-ui-action-cards', 'client-ui-action-cards'],
  ['ui-agent-team', 'client-ui-agent-team', 'ui-agent-team'],
  ['ui-claude-code-mods', 'client-ui-claude-code-mods', 'client-ui-claude-code-mods'],
  ['ui-cot-translation', 'client-ui-cot-translation', 'cot-translation'],
  ['ui-forge', 'client-ui-forge', 'forge-panel'],
  ['ui-plugin-recommendations', 'client-ui-plugin-recommendations', 'client-ui-plugin-recommendations'],
  ['liveshare', 'liveshare', 'liveshare-share-host'],
].map(([key, folder, row]) => ({ key, folder, row, name: `@deepseek-ai/dsh-experimental-remote-${key}` })).sort((a, b) => Number(b.key === 'ui-agent-team') - Number(a.key === 'ui-agent-team'));
const originalReport = JSON.parse(await readFile(path.join(base, 'build-report.json'), 'utf8'));
const remap = new Map(originalReport.providers.filter(item => item.kind !== 'worker').map(item => [item.original, item.name]));
for (const feature of features) {
  feature.source = path.join(root, 'packages/experimental', feature.folder);
  feature.original = JSON.parse(await readFile(path.join(feature.source, 'package.json'), 'utf8'));
  remap.set(feature.original.name, feature.name);
}
const before = await hashes(base);
if (await exists(path.join(output, 'optional-build-report.json'))) throw new Error('bundle-v2 is frozen: do not overwrite a completed revision');
await cp(base, output, { recursive: true, force: true });
const records = [];
for (const feature of features) {
  if (feature.key !== 'ui-agent-team') {
    const patch = `optional/${feature.key}.patch.yml`;
    await write(path.join(output, patch), json([
      { id: feature.row, name: feature.original.name, disabled: true },
      { ...(feature.key === 'ui-forge' ? { id: 'optional-forge-panel' } : {}), insert: [{ id: `remote-guard-${feature.key}`, name: feature.name }] },
    ]));
    records.push({ key: feature.key, originalPackage: feature.original.name, preferredOriginalRowId: feature.row,
      replacementPackage: feature.name, replacementRowId: `remote-guard-${feature.key}`, patch,
      artifactStatus: 'deferred-inactive', clientApiOwner: '@dsh-remote/session-controller',
      preserveOriginalConfiguration: true, preserveOriginalDisabledAndScope: true, applyOnlyIfOriginalPresent: true,
    });
    continue;
  }
  const stage = path.join(scratch, feature.key), final = path.join(output, 'packages', feature.key);
  await mkdir(stage, { recursive: true });
  for (const folder of ['src', 'lib/types', 'locale']) {
    const source = path.join(feature.source, folder);
    if (await exists(source)) await cp(source, path.join(stage, folder), { recursive: true, force: true });
  }
  await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  for (const name of Object.keys({ ...feature.original.dependencies, ...feature.original.peerDependencies, ...feature.original.devDependencies })) {
    const source = path.join(feature.source, 'node_modules', ...name.split('/'));
    if (!await exists(source)) continue;
    const target = path.join(stage, 'node_modules', ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    if (!await exists(target)) await symlink(await realpath(source), target, 'junction');
  }
  const exports = { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' };
  if (feature.original.exports['./locale/*.json']) exports['./locale/*.json'] = './locale/*.json';
  if (feature.original.exports['./assets/*']) exports['./assets/*'] = './lib/assets/*';
  if (feature.original.exports['./typert']) exports['./typert'] = './lib/typert.host.js';
  const client = { ...feature.original.dsh.client,
    inject: [...new Set([...(feature.original.dsh.client.inject ?? []).map(name => remap.get(name) ?? name), '@dsh-remote/session-controller'])],
  };
  const manifest = { name: feature.name, version: '0.1.0', private: true, type: 'module',
    engines: { dsh: '0.2.2-rc.1', node: '>=24.9' }, exports, files: ['lib', 'locale'],
    peerDependencies: { [feature.original.name]: feature.original.version }, dsh: { client },
  };
  await write(path.join(stage, 'package.json'), json(manifest));
  // Source face intentionally compiles the current native-ID guards, not a potentially stale emitted leaf.
  await write(path.join(stage, 'tsconfig.json'), json({ extends: path.join(root, 'tsconfig.base.client.json') }));
  const config = clientBundle(stage, ['lib/types/index.js'])({ env: {} }).find(item => item.name === feature.name + '/client');
  console.log(`BUILD NEW ${feature.name}`);
  await build({ ...config, cwd: stage, config: false, tsconfig: path.join(stage, 'tsconfig.json'), logLevel: 'warn',
    inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) {
      if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message);
      handler(level, diagnostic);
    } },
  });
  await write(path.join(stage, 'lib/index.js'), `import * as stock from ${JSON.stringify(feature.original.name)};\nexport * from ${JSON.stringify(feature.original.name)};\nconst provider = stock.default ?? stock;\nexport const inject = provider.inject ?? [];\nexport const Config = provider.Config;\nexport function apply(ctx, config) { ctx.plugin(provider, config); }\n`);
  if (exports['./typert']) await write(path.join(stage, 'lib/typert.host.js'), `import { TYPERT as base } from ${JSON.stringify(feature.original.name + '/typert')};\nexport const TYPERT = { ...base, package: ${JSON.stringify(feature.name)}, invocations: base.invocations.map(descriptor => ({ ...descriptor, id: ${JSON.stringify(feature.name)} + '#' + descriptor.namespace + '/' + descriptor.method })) };\n`);
  await mkdir(final, { recursive: true });
  for (const folder of ['lib', 'locale']) if (await exists(path.join(stage, folder))) await cp(path.join(stage, folder), path.join(final, folder), { recursive: true });
  await write(path.join(final, 'package.json'), json(manifest));
  const requests = new Set();
  for (const file of (await readdir(path.join(final, 'lib'))).filter(name => /^client(?:\..*)?\.js$/.test(name))) {
    const ast = ts.createSourceFile(file, await readFile(path.join(final, 'lib', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) requests.add(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  const allowed = new Set([...PLATFORM_MODULES, ...(client.external ?? [])]);
  for (const request of requests) if (!allowed.has(request) && !request.startsWith('./')) throw new Error(`Unprovided browser request ${feature.key}: ${request}`);
  const replacementRowId = `remote-guard-${feature.key}`;
  const patch = `optional/${feature.key}.patch.yml`;
  await write(path.join(output, patch), json([
    { id: feature.row, name: feature.original.name, disabled: true },
    { insert: [{ id: replacementRowId, name: feature.name }] },
  ]));
  records.push({ key: feature.key, originalPackage: feature.original.name, preferredOriginalRowId: feature.row,
    replacementPackage: feature.name, replacementRowId, patch, preserveOriginalConfiguration: true,
    preserveOriginalDisabledAndScope: true, applyOnlyIfOriginalPresent: true, browserRequests: [...requests].sort(),
    artifactStatus: 'built', factorySha256: await hash(path.join(final, 'lib/client.js')),
    clientApiOwner: '@dsh-remote/session-controller', sourceFileHashes: await hashes(path.join(feature.source, 'src/client')),
  });
}
const rootManifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
rootManifest.version = '0.1.1';
for (const feature of features.filter(item => item.key === 'ui-agent-team')) rootManifest.dependencies[feature.name] = `file:./packages/${feature.key}`;
rootManifest.files.push('optional', 'optional-features.json', 'optional-build-report.json', 'client-refresh-report.json');
await write(path.join(output, 'package.json'), json(rootManifest));
await cp(path.join(here, 'client-refresh-report.json'), path.join(output, 'client-refresh-report.json'));
await write(path.join(output, 'optional-features.json'), json({ version: 1,
  selectionRule: 'Match originalPackage in actual composed rows; absent means skip; copy config/disabled/scope and insert in same parent group. Templates assume an active root-level standard row and must be materialized for actual row metadata.',
  unconditionalBasePatch: './cordis.patch.yml', features: records,
}));
const afterBase = await hashes(base);
if (JSON.stringify(before) !== JSON.stringify(afterBase)) throw new Error('Original frozen bundle changed');
let preserved = 0;
for (const [file, digest] of Object.entries(before)) {
  if (file === 'package.json') continue;
  if (await hash(path.join(output, file)) !== digest) throw new Error(`Base artifact changed in revision: ${file}`);
  preserved++;
}
await write(path.join(output, 'optional-build-report.json'), json({ builtAt: new Date().toISOString(),
  newFactories: records.filter(item => item.artifactStatus === 'built').length, originalFrozenBundleUnchanged: true, baseFilesPreserved: preserved,
  workerProviderUnchanged: true, rootVersion: '0.1.1', features: records,
}));
console.log(`READY bundle-v2: ONE current active AgentTeam factory, six deferred-inactive records, ${preserved} base files identical, optional overlays not auto-activated`);
