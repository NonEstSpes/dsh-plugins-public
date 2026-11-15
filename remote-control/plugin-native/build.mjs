/** Rebuild new-named providers through the maintained clientBundle API; never modifies stock or source packages. */
import { cp, mkdir, readFile, writeFile, stat, symlink, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const scratch = path.join(root, '.dsh-build/plugin-native');
const output = path.join(here, 'bundle');
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href);
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href);
const version = '0.1.0';
const rows = [
  ['session-controller', 'api/session-controller', 'session-controller', 'controller'],
  ['session-source-controller', 'api/session-source-controller', null, 'source'],
  ['worker-session-controller', 'api/session-controller', null, 'worker'],
  ...['ui-agent-preset','ui-approval','ui-chat','ui-commands','ui-context-menu','ui-conversation',
    'ui-deliverables','ui-file-actions','ui-goal','ui-input-trigger','ui-jobs','ui-message-feedback',
    'ui-model-selection','ui-open-in-app','ui-permission-presets','ui-plan','ui-schedule','ui-session',
    'ui-sidebar-documentpreview','ui-sidebar-files','ui-sidebar-right','ui-sidebar-terminal','ui-skill',
    'ui-subagent','ui-tool','ui-trajectory','ui-user-questions','ui-workflow-run','ui-workspace']
    .map(id => [id, `client/${id}`, id === 'ui-permission-presets' ? 'ui-permission' : id, 'stock-host']),
  ['ui-cordis', 'extensions/ui-cordis', 'ui-cordis', 'stock-host'],
  ['session-log-export', 'session-query/session-log-export', 'session-log-download', 'stock-host'],
].map(([id, source, oldRow, kind]) => ({ id, source, oldRow, kind, name: `@dsh-remote/${id}` }));
const originals = new Map();
for (const row of rows) {
  row.sourceDir = path.join(root, 'packages', row.source);
  row.original = JSON.parse(await readFile(path.join(row.sourceDir, 'package.json'), 'utf8'));
  if (row.kind !== 'worker') originals.set(row.original.name, row.name);
}
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const peerVersion = async (row, name, spec) => {
  if (!spec.startsWith('workspace:')) return spec;
  const file = path.join(row.sourceDir, 'node_modules', ...name.split('/'), 'package.json');
  return JSON.parse(await readFile(file, 'utf8')).version;
};
const copyIfExists = async (from, to) => { if (await exists(from)) await cp(from, to, { recursive: true, force: true }); };
const write = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
const stockHost = row => `/** Keep the installed Host provider; only this Loader row has a Client artifact. */\nimport * as stock from ${JSON.stringify(row.original.name)};\nexport * from ${JSON.stringify(row.original.name)};\nconst provider = stock.default ?? stock;\nexport const name = ${JSON.stringify(row.name)};\nexport const inject = provider.inject ?? [];\nexport const Config = provider.Config;\nexport function apply(ctx, config) { ctx.plugin(provider, config); }\n`;
const workerHelpers = ['createSourceSession','prepareSourceSession','sourceModelState','guardedSourcePrompt',
  'installPromptSelectionGuard','selectSessionModel','cancel','modelCatalog'];
const workerHost = `/** Exact-owner attestation for this private fork, never a configuration readiness flag. */\nimport { SessionController } from './controller-impl.js';\nexport * from './controller-impl.js';\nexport { default } from './controller-impl.js';\nconst prototype = SessionController.prototype;\nconst names = ${json(workerHelpers).trim()};\nconst methods = names.map(name => Object.getOwnPropertyDescriptor(prototype, name)?.value);\nexport function ownsSourceMutationHelpers(value) {\n  if (value === null || typeof value !== 'object' || Object.getPrototypeOf(value) !== prototype || Object.hasOwn(value, 'constructor') || Object.getOwnPropertyDescriptor(prototype, 'constructor')?.value !== SessionController) return false;\n  return names.every((name, index) => typeof methods[index] === 'function'\n    && !Object.hasOwn(value, name) && Object.getOwnPropertyDescriptor(prototype, name)?.value === methods[index]);\n}\n`;
const evidence = [];
await mkdir(scratch, { recursive: true });
await mkdir(output, { recursive: true });
for (const row of rows) {
  const stage = path.join(scratch, 'packages-v2', row.id);
  const final = path.join(output, 'packages', row.id);
  await mkdir(stage, { recursive: true });
  for (const folder of ['src', 'lib/types', 'locale', 'licenses']) await copyIfExists(path.join(row.sourceDir, folder), path.join(stage, folder));
  for (const file of ['typert.host.js', 'typert.remote-client.js']) await copyIfExists(path.join(row.sourceDir, 'lib', file), path.join(stage, 'lib', file));
  // A junction of the whole pnpm node_modules rebases its relative links on Windows.
  // Link each resolved package absolutely instead; never mutate the original dependency tree.
  await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  for (const name of Object.keys({ ...row.original.dependencies, ...row.original.peerDependencies, ...row.original.devDependencies })) {
    const sourceLink = path.join(row.sourceDir, 'node_modules', ...name.split('/'));
    if (!await exists(sourceLink)) continue;
    const link = path.join(stage, 'node_modules', ...name.split('/'));
    await mkdir(path.dirname(link), { recursive: true });
    if (!await exists(link)) await symlink(await realpath(sourceLink), link, 'junction');
  }
  const peers = {};
  if (row.kind === 'stock-host' || row.kind === 'controller') peers[row.original.name] = row.original.version;
  else for (const [name, spec] of Object.entries({ ...row.original.dependencies, ...row.original.peerDependencies })) peers[name] = await peerVersion(row, name, spec);
  const declaration = { ...row.original.dsh.client,
    inject: (row.original.dsh.client.inject ?? []).map(name => originals.get(name) ?? name),
  };
  const exports = { '.': './lib/index.js', './client': './lib/client.js', './package.json': './package.json' };
  if (row.original.exports['./assets/*']) exports['./assets/*'] = './lib/assets/*';
  if (row.original.exports['./locale/*.json']) exports['./locale/*.json'] = './locale/*.json';
  if (row.original.exports['./typert']) exports['./typert'] = './lib/typert.host.js';
  if (exports['./typert']) {
    peers.zod = require('zod/package.json').version;
    peers['@deepseek-ai/dsh-typert-protocol'] = '0.2.2-rc.1';
  }
  const manifest = { name: row.name, version, private: true, type: 'module',
    description: `New-named provider for ${row.original.name}; stock runtime remains unchanged`,
    engines: { node: '>=24.9', dsh: '0.2.2-rc.1' }, exports, files: ['lib', 'locale'],
    dsh: { client: declaration }, peerDependencies: peers,
  };
  await write(path.join(stage, 'package.json'), json(manifest));
  if (row.kind === 'source') {
    const original = await readFile(path.join(row.sourceDir, 'lib/types/client/index.js'), 'utf8');
    await write(path.join(stage, 'lib/types/client/adapter-entry.js'), original);
    await write(path.join(stage, 'lib/types/client/index.js'), `/** Own namespace bootstrap; stock api-remotes is not replaced. */\nimport * as adapter from './adapter-entry.js';\nimport contribution from '../../typert.remote-client.js';\nexport const inject = ['remote'];\nexport async function apply(ctx) {\n  await ctx.remote.$mount({ package: ${JSON.stringify(row.name)},\n    descriptors: contribution.descriptors.map(descriptor => ({ ...descriptor,\n      id: ${JSON.stringify(row.name)} + '#' + descriptor.namespace + '/' + descriptor.method,\n    })),\n  });\n  await ctx.plugin(adapter).await();\n}\n`);
  }
  let preset = clientBundle(stage, ['lib/types/index.js']);
  if (row.id === 'ui-sidebar-documentpreview') {
    const originalConfig = await readFile(path.join(row.sourceDir, 'tsdown.config.ts'), 'utf8');
    const ownerImport = "from '../tsdown.client.ts'";
    if (!originalConfig.includes(ownerImport)) throw new Error('Document preview build configuration changed');
    await write(path.join(stage, 'tsdown.config.ts'), originalConfig.replace(ownerImport,
      `from ${JSON.stringify(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href)}`));
    preset = (await import(pathToFileURL(path.join(stage, 'tsdown.config.ts')).href)).default;
  }
  const configs = preset({ env: { DSH_BUILD_FACE: 'client' } });
  const client = configs.find(config => config.name === `${row.name}/client`);
  if (!client) throw new Error(`No browser config for ${row.name}`);
  console.log(`BUILD ${row.name}`);
  await build({ ...client, cwd: stage, config: false, tsconfig: false, logLevel: 'warn',
    inputOptions: { ...client.inputOptions, onLog(level, diagnostic, handler) {
      if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message);
      handler(level, diagnostic);
    } },
  });
  if (row.kind === 'worker' || row.kind === 'source') {
    await build({ config: false, cwd: stage, entry: { [row.kind === 'worker' ? 'controller-impl' : 'index']: 'lib/types/index.js' },
      outDir: 'lib', clean: false, format: 'esm', fixedExtension: false, platform: 'node', target: 'node24', dts: false,
      tsconfig: false, sourcemap: true, logLevel: 'warn',
      deps: { neverBundle: specifier => !specifier.startsWith('.') && !path.isAbsolute(specifier) },
    });
    if (row.kind === 'worker') await write(path.join(stage, 'lib/index.js'), workerHost);
  } else {
    await write(path.join(stage, 'lib/index.js'), stockHost(row));
  }
  if (exports['./typert']) {
    const privateBase = row.kind === 'worker' || row.kind === 'source';
    if (privateBase) await cp(path.join(row.sourceDir, 'lib/typert.host.js'), path.join(stage, 'lib/typert.base.js'));
    const baseImport = privateBase ? './typert.base.js' : `${row.original.name}/typert`;
    await write(path.join(stage, 'lib/typert.host.js'), `/** Own reflection contribution; nested codecs and generated factories retain their identities. */\nimport { TYPERT as base } from ${JSON.stringify(baseImport)};\nexport const TYPERT = { ...base, package: ${JSON.stringify(row.name)},\n  invocations: base.invocations.map(descriptor => ({ ...descriptor,\n    id: ${JSON.stringify(row.name)} + '#' + descriptor.namespace + '/' + descriptor.method,\n  })),\n};\n`);
  }
  await mkdir(final, { recursive: true });
  for (const folder of ['lib', 'locale']) await copyIfExists(path.join(stage, folder), path.join(final, folder));
  await write(path.join(final, 'package.json'), json(manifest));
  const factory = await readFile(path.join(final, 'lib/client.js'), 'utf8');
  if (!factory.includes(JSON.stringify(row.name)) && !factory.includes(`'${row.name}'`)) throw new Error(`Missing newly compiled factory identity: ${row.name}`);
  evidence.push({ name: row.name, original: row.original.name, row: row.oldRow, kind: row.kind,
    external: declaration.external ?? [], informationalInject: declaration.inject });
}
const main = rows.filter(row => row.kind !== 'worker');
const patch = main.filter(row => row.oldRow).map(row => ({ id: row.oldRow, name: row.original.name, disabled: true }));
patch.push({ insert: main.map(row => ({ id: `remote-native-${row.id}`, name: row.name })) });
// JSON is a YAML 1.2 subset accepted by the ordinary patch loader.
await write(path.join(output, 'cordis.patch.yml'), json(patch));
await write(path.join(output, 'worker.patch.yml'), json([
  { id: 'remote-native-session-controller', name: '@dsh-remote/session-controller', disabled: true },
  { insert: [{ id: 'remote-native-worker-session-controller', name: '@dsh-remote/worker-session-controller' }] },
]));
await write(path.join(output, 'poc.patch.yml'), json([
  { id: 'remote-native-session-controller', name: '@dsh-remote/session-controller', config: { nativeOpen: false } },
]));
await write(path.join(output, 'worker-poc.patch.yml'), json([
  { id: 'remote-native-worker-session-controller', name: '@dsh-remote/worker-session-controller', config: { nativeOpen: false } },
]));
await write(path.join(output, 'index.js'), 'export function apply() {}\n');
await write(path.join(output, 'package.json'), json({ name: '@dsh-remote/native-session-bundle', version,
  private: true, type: 'module', exports: { '.': './index.js' }, engines: { dsh: '0.2.2-rc.1' },
  files: ['index.js', 'cordis.patch.yml', 'worker.patch.yml', 'poc.patch.yml', 'worker-poc.patch.yml', 'packages', 'build-report.json', 'module-audit.json'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: Object.fromEntries(rows.map(row => [row.name, `file:./packages/${row.id}`])),
}));
await write(path.join(output, 'build-report.json'), json({ generatedAt: new Date().toISOString(),
  method: 'clientBundle(new manifest directory), no factory rewrites; stock Host wrappers except separate SourceBFF/optional Worker fork',
  rootApiRemotesReplaced: false, source: root, providers: evidence,
}));
console.log(`READY ${output}`);
