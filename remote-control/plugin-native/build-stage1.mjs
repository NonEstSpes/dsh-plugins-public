/** Build an immutable Controller-only revision from three checked Client packages. */
import { cp, mkdir, readFile, readdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const version = '0.1.6';
const base = path.join(here, 'bundle-v5');
const output = path.join(here, `bundle-stage1-${version}`);
const scratch = path.join(root, '.dsh-build/plugin-native', `stage1-${randomUUID()}`);
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href);
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href);
const json = value => JSON.stringify(value, null, 2) + '\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const exists = async file => {
  try { await stat(file); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
async function snapshot(directory, prefix = '') {
  const result = {};
  for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, item.name), key = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Unexpected artifact link: ${key}`);
    if (item.isDirectory()) Object.assign(result, await snapshot(file, key + '/'));
    else if (item.isFile()) result[key] = hash(await readFile(file));
    else throw new Error(`Unexpected artifact entry: ${key}`);
  }
  return result;
}
const targets = [
  { id: 'session-controller', source: 'api/session-controller' },
  { id: 'ui-model-selection', source: 'client/ui-model-selection' },
  { id: 'ui-workspace', source: 'client/ui-workspace' },
];
if (await exists(output)) throw new Error(`Refusing to overwrite immutable ${output}`);
const before = await snapshot(base);
await mkdir(scratch, { recursive: true });
const inputs = {};
for (const target of targets) {
  const source = path.join(root, 'packages', target.source);
  const stage = path.join(scratch, target.id);
  const original = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.join(base, 'packages', target.id, 'package.json'), 'utf8'));
  manifest.version = '0.1.2';
  inputs[target.id] = await snapshot(path.join(source, 'src'));
  await mkdir(stage, { recursive: true });
  for (const folder of ['src', 'lib/types', 'locale']) {
    if (await exists(path.join(source, folder))) await cp(path.join(source, folder), path.join(stage, folder), { recursive: true });
  }
  await writeFile(path.join(stage, 'package.json'), json(manifest), { flag: 'wx' });
  await mkdir(path.join(stage, 'node_modules'), { recursive: true });
  for (const name of Object.keys({ ...original.dependencies, ...original.peerDependencies, ...original.devDependencies })) {
    const from = path.join(source, 'node_modules', ...name.split('/'));
    if (!await exists(from)) continue;
    const to = path.join(stage, 'node_modules', ...name.split('/'));
    await mkdir(path.dirname(to), { recursive: true });
    await symlink(await realpath(from), to, 'junction');
  }
  // The maintained source face resolves explicit .ts imports, not stale emitted siblings in src/.
  const config = clientBundle(stage, ['src/index.ts'])({ env: {} })
    .find(item => item.name === `${manifest.name}/client`);
  if (!config) throw new Error(`Missing Client config for ${manifest.name}`);
  console.log(`BUILD ${manifest.name}/client from source`);
  await build({ ...config, cwd: stage, config: false, tsconfig: false, logLevel: 'warn',
    inputOptions: { ...config.inputOptions, onLog(level, diagnostic, handler) {
      if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message);
      handler(level, diagnostic);
    } },
    plugins: [config.plugins, { name: 'stage1-client-output-only', generateBundle(_options, emitted) {
      for (const file of Object.keys(emitted)) {
        if (!['client.js', 'client.js.map'].includes(file)) throw new Error(`Unexpected Client output ${file}`);
      }
    } }],
  });
  if (JSON.stringify(inputs[target.id]) !== JSON.stringify(await snapshot(path.join(source, 'src')))) {
    throw new Error(`Source changed while building ${target.id}`);
  }
}
for (const target of targets) {
  const current = await snapshot(path.join(root, 'packages', target.source, 'src'));
  if (JSON.stringify(inputs[target.id]) !== JSON.stringify(current)) throw new Error(`Source changed before publication: ${target.id}`);
}
if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Frozen base changed during build');
await cp(base, output, { recursive: true, errorOnExist: true, force: false });
const allowed = new Set(['package.json']);
for (const target of targets) {
  const stage = path.join(scratch, target.id), destination = path.join(output, 'packages', target.id);
  for (const file of ['client.js', 'client.js.map']) {
    const relative = `packages/${target.id}/lib/${file}`;
    allowed.add(relative);
    await cp(path.join(stage, 'lib', file), path.join(output, relative), { force: true });
  }
  allowed.add(`packages/${target.id}/package.json`);
  await cp(path.join(stage, 'package.json'), path.join(destination, 'package.json'), { force: true });
}
const manifest = JSON.parse(await readFile(path.join(output, 'package.json'), 'utf8'));
manifest.version = version;
manifest.files.push('stage1-report.json');
await writeFile(path.join(output, 'package.json'), json(manifest));
const after = await snapshot(output), changes = [];
for (const file of new Set([...Object.keys(before), ...Object.keys(after)])) {
  if (before[file] === after[file]) continue;
  if (!allowed.has(file)) throw new Error(`Unapproved changed artifact ${file}`);
  changes.push({ file, before: before[file] ?? null, after: after[file] ?? null });
}
if (JSON.stringify(before) !== JSON.stringify(await snapshot(base))) throw new Error('Frozen base changed before publication');
const treeHash = hash(Object.keys(after).sort().map(file => `${file}\0${after[file]}\n`).join(''));
await writeFile(path.join(output, 'stage1-report.json'), json({
  version, builtAt: new Date().toISOString(), base: 'bundle-v5', baseVersion: '0.1.4',
  sourcePackages: targets, sourceHashes: inputs, changed: changes,
  unchangedBaseFiles: Object.keys(before).length - changes.length,
  frozenBaseUnchanged: true, workerProviderUnchanged: true, hostProvidersUnchanged: true,
  pairingAndGrantsUnchanged: true, treeHashExcludingThisReport: treeHash,
  scope: 'Controller Client model catalog lifecycle, exact-ID selection reconciliation and successful creation labels; no Worker or Bridge activation',
}), { flag: 'wx' });
console.log(`READY ${output}; ${changes.length} approved changed artifacts; tree SHA256 ${treeHash}`);
