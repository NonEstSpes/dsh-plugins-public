/** Isolated UI-only revision: one Workspace Client entry, its map, and the root version. */
import { cp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const base = path.join(here, 'bundle-v4'), output = path.join(here, 'bundle-v5');
const source = path.join(root, 'packages/client/ui-workspace');
const stage = path.join(root, '.dsh-build/plugin-native/history-banner-v5');
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href);
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href);
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const exists = async file => { try { await stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function snapshot(dir, prefix = '') {
  const result = {};
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name), key = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Unexpected link ${key}`);
    if (item.isDirectory()) Object.assign(result, await snapshot(file, key + '/'));
    else result[key] = await hash(file);
  }
  return result;
}
if (await exists(output)) throw new Error('Refusing to overwrite bundle-v5');
const before = await snapshot(base);
await cp(base, output, { recursive: true });
await mkdir(stage, { recursive: true });
for (const folder of ['src', 'lib/types', 'locale']) if (await exists(path.join(source, folder))) await cp(path.join(source, folder), path.join(stage, folder), { recursive: true });
const manifest = JSON.parse(await readFile(path.join(base, 'packages/ui-workspace/package.json'), 'utf8'));
const original = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
await writeFile(path.join(stage, 'package.json'), json(manifest));
await mkdir(path.join(stage, 'node_modules'), { recursive: true });
for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
  const from = path.join(source, 'node_modules', ...name.split('/')), to = path.join(stage, 'node_modules', ...name.split('/'));
  if (!await exists(from)) continue;
  await mkdir(path.dirname(to), { recursive: true });
  if (!await exists(to)) await symlink(await realpath(from), to, 'junction');
}
const config = clientBundle(stage, ['lib/types/index.js'])({ env: { DSH_BUILD_FACE: 'client' } }).find(item => item.name === manifest.name + '/client');
await build({ ...config, cwd: stage, config: false, tsconfig: false, logLevel: 'warn',
  inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) {
    if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message);
    handler(level, diagnostic);
  } },
  plugins: [config.plugins, { name: 'workspace-entry-only', generateBundle(_options, emitted) {
    for (const file of Object.keys(emitted)) if (!['client.js', 'client.js.map'].includes(file)) throw new Error(`Unexpected output ${file}`);
  } }],
});
for (const file of ['client.js', 'client.js.map']) await cp(path.join(stage, 'lib', file), path.join(output, 'packages/ui-workspace/lib', file));
const rootManifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
rootManifest.version = '0.1.4';
rootManifest.files.push('history-banner-report.json');
await writeFile(path.join(output, 'package.json'), json(rootManifest));
const after = await snapshot(output), baseAfter = await snapshot(base);
if (JSON.stringify(before) !== JSON.stringify(baseAfter)) throw new Error('Frozen v4 changed');
const allowed = new Set(['package.json', 'packages/ui-workspace/lib/client.js', 'packages/ui-workspace/lib/client.js.map']);
const changed = [];
let unchanged = 0;
for (const [file, digest] of Object.entries(before)) {
  if (after[file] === digest) { unchanged++; continue; }
  if (!allowed.has(file)) throw new Error(`Unexpected changed file ${file}`);
  changed.push({ file, before: digest, after: after[file] });
}
const treeHash = createHash('sha256').update(Object.keys(after).sort().map(file => `${file}\0${after[file]}\n`).join('')).digest('hex');
const report = { version: '0.1.4', builtAt: new Date().toISOString(), frozenV4Unchanged: true,
  unchangedBaseFiles: unchanged, changed, treeHashExcludingThisReport: treeHash,
  treeHashAlgorithm: 'sha256(sorted relativePath + NUL + file SHA256 + LF), excludes history-banner-report.json; not the SDK payload hash',
  scope: 'Hide history notice only for Client creation state created; journal, API/BFF, pending/unknown/reconciliation and all other providers unchanged',
};
await writeFile(path.join(output, 'history-banner-report.json'), json(report));
console.log(`READY FROZEN bundle-v5 0.1.4: ${changed.length} approved changed files, ${unchanged} base files identical; tree SHA256 ${treeHash}`);
console.log(`Workspace Client SHA256 ${after['packages/ui-workspace/lib/client.js']}`);
