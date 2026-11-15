/** New immutable revision: three Client entries plus the owned Source BFF Host/metadata only. */
import { cp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const revision = process.argv[2] ?? 'v3';
if (!['v3', 'v4'].includes(revision)) throw new Error('Only approved revisions v3/v4 are supported');
const priorRevision = revision === 'v4' ? 'v3' : 'v2';
const version = revision === 'v4' ? '0.1.3' : '0.1.2';
const reportName = revision === 'v4' ? 'owner-history-report.json' : 'create-recovery-report.json';
const base = path.join(here, `bundle-${priorRevision}`), output = path.join(here, `bundle-${revision}`);
const scratch = path.join(root, `.dsh-build/plugin-native/create-recovery-${revision}`);
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href);
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href);
const json = value => JSON.stringify(value, null, 2) + '\n';
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
async function snapshot(dir, prefix = '') {
  const result = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name), relative = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Unexpected link ${relative}`);
    if (item.isDirectory()) Object.assign(result, await snapshot(file, relative + '/'));
    else result[relative] = await hash(file);
  }
  return result;
}
const before = await snapshot(base);
if (await exists(path.join(output, reportName))) throw new Error(`${revision} already frozen`);
await cp(base, output, { recursive: true, force: true });
const targets = [
  { id: 'session-controller', source: 'api/session-controller' },
  { id: 'session-source-controller', source: 'api/session-source-controller' },
  { id: 'ui-workspace', source: 'client/ui-workspace' },
];
const allowed = new Set(['package.json']);
for (const target of targets) {
  const source = path.join(root, 'packages', target.source), stage = path.join(scratch, target.id);
  const original = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(base, 'packages', target.id, 'package.json'), 'utf8'));
  await mkdir(stage, { recursive: true });
  for (const folder of ['src', 'lib/types', 'locale']) if (await exists(path.join(source, folder))) await cp(path.join(source, folder), path.join(stage, folder), { recursive: true, force: true });
  await writeFile(path.join(stage, 'package.json'), json(manifest));
  await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
    const from = path.join(source, 'node_modules', ...name.split('/')), to = path.join(stage, 'node_modules', ...name.split('/'));
    if (!await exists(from)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    if (!await exists(to)) await symlink(await realpath(from), to, 'junction');
  }
  if (target.id === 'session-source-controller') {
    await cp(path.join(source, 'lib/typert.remote-client.js'), path.join(stage, 'lib/typert.remote-client.js'));
    await cp(path.join(source, 'lib/types/client/index.js'), path.join(stage, 'lib/types/client/adapter-entry.js'));
    await writeFile(path.join(stage, 'lib/types/client/index.js'), `import * as adapter from './adapter-entry.js';\nimport contribution from '../../typert.remote-client.js';\nexport const inject = ['remote'];\nexport async function apply(ctx) {\n  await ctx.remote.$mount({ package: ${JSON.stringify(manifest.name)}, descriptors: contribution.descriptors.map(descriptor => ({ ...descriptor, id: ${JSON.stringify(manifest.name)} + '#' + descriptor.namespace + '/' + descriptor.method })) });\n  await ctx.plugin(adapter).await();\n}\n`);
  }
  const config = clientBundle(stage, ['lib/types/index.js'])({ env: { DSH_BUILD_FACE: 'client' } }).find(item => item.name === manifest.name + '/client');
  console.log(`BUILD ONLY ${manifest.name}/client`);
  await build({ ...config, cwd: stage, config: false, tsconfig: false, logLevel: 'warn',
    inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) {
      if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message);
      handler(level, diagnostic);
    } },
    plugins: [config.plugins, { name: 'only-approved-client-entry', generateBundle(_options, files) {
      for (const file of Object.keys(files)) if (!['client.js', 'client.js.map'].includes(file)) throw new Error(`Unexpected Client output ${file}`);
    } }],
  });
  for (const file of ['client.js', 'client.js.map']) {
    const relative = `packages/${target.id}/lib/${file}`;
    allowed.add(relative);
    await cp(path.join(stage, 'lib', file), path.join(output, relative), { force: true });
  }
  if (target.id === 'session-source-controller') {
    console.log('BUILD ONLY owned SourceBFF Host');
    await build({ cwd: stage, config: false, entry: { index: 'lib/types/index.js' }, outDir: 'host-output', clean: false,
      format: 'esm', fixedExtension: false, platform: 'node', target: 'node24', dts: false, tsconfig: false,
      sourcemap: true, logLevel: 'warn', deps: { neverBundle: specifier => !specifier.startsWith('.') && !path.isAbsolute(specifier) },
    });
    for (const file of ['index.js', 'index.js.map']) {
      const relative = `packages/${target.id}/lib/${file}`;
      allowed.add(relative);
      await cp(path.join(stage, 'host-output', file), path.join(output, relative), { force: true });
    }
    for (const [from, file] of [['typert.host.js', 'typert.base.js'], ['typert.remote-client.js', 'typert.remote-client.js']]) {
      const relative = `packages/${target.id}/lib/${file}`;
      allowed.add(relative);
      await cp(path.join(source, 'lib', from), path.join(output, relative), { force: true });
    }
    // The existing exported wrapper stays byte-identical and points at the refreshed owned base.
  }
}
const rootManifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
rootManifest.version = version;
rootManifest.files.push(reportName);
await writeFile(path.join(output, 'package.json'), json(rootManifest));
const afterBase = await snapshot(base);
if (JSON.stringify(before) !== JSON.stringify(afterBase)) throw new Error(`Frozen ${priorRevision} changed`);
const after = await snapshot(output);
const changed = [];
let unchanged = 0;
for (const [file, digest] of Object.entries(before)) {
  if (after[file] === digest) { unchanged++; continue; }
  if (!allowed.has(file)) throw new Error(`Unapproved changed base file ${file}`);
  changed.push({ file, before: digest, after: after[file] });
}
await writeFile(path.join(output, reportName), json({ builtAt: new Date().toISOString(), rootVersion: version,
  targets: targets.map(item => item.id), frozenBaseUnchanged: true, baseRevision: priorRevision, unchangedBaseFiles: unchanged, changed,
  agentTeamFactoryAndOptionalManifestUnchanged: true, workerProviderUnchanged: true,
  behavior: 'Passive durable creation inquiry; explicit exact-ID reconciliation/Open; no automatic create/replay or browser-origin persistence; static catalog status',
}));
console.log(`READY FROZEN bundle-${revision} ${version}: ${changed.length} approved changed files; ${unchanged} other base files identical`);
