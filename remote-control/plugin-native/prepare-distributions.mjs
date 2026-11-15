/** Assemble a separate Worker selection and validate internal local dependencies before ZIP packaging. */
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const controller = path.join(here, 'bundle');
const worker = path.join(here, 'worker-bundle');
const json = value => JSON.stringify(value, null, 2) + '\n';
const hashFile = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const refreshed = JSON.parse(await readFile(path.join(here, 'client-refresh-report.json'), 'utf8'));
for (const item of refreshed.changes) {
  if (await hashFile(path.join(controller, item.file)) !== item.after) throw new Error(`Frozen Client hash mismatch: ${item.file}`);
}
await mkdir(path.join(worker, 'packages'), { recursive: true });
await cp(path.join(controller, 'packages/worker-session-controller'), path.join(worker, 'packages/worker-session-controller'), { recursive: true, force: true });
await writeFile(path.join(worker, 'index.js'), 'export function apply() {}\n');
await writeFile(path.join(worker, 'package.json'), json({
  name: '@dsh-remote/worker-extension', version: '0.1.0', private: true, type: 'module',
  description: 'Worker-only native Session Controller provider for unchanged DSH; deployment configuration is explicit',
  engines: { dsh: '0.2.2-rc.1' }, exports: { '.': './index.js' },
  files: ['index.js', 'cordis.patch.yml', 'packages'],
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  dependencies: { '@dsh-remote/worker-session-controller': 'file:./packages/worker-session-controller' },
}));
await writeFile(path.join(worker, 'cordis.patch.yml'), json([
  { id: 'session-controller', name: '@deepseek-ai/dsh-api-session-controller', disabled: true },
  { insert: [{ id: 'remote-worker-session-controller', name: '@dsh-remote/worker-session-controller' }] },
]));
async function checkPackage(dir, boundary, seen = new Set()) {
  if (seen.has(dir)) return;
  seen.add(dir);
  const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  for (const [name, spec] of Object.entries(manifest.dependencies ?? {})) {
    if (!spec.startsWith('file:')) throw new Error(`${manifest.name}: non-local install dependency ${name}`);
    const target = path.resolve(dir, spec.slice(5));
    if (!target.startsWith(boundary + path.sep)) throw new Error(`${manifest.name}: escaping dependency ${name}`);
    const child = JSON.parse(await readFile(path.join(target, 'package.json'), 'utf8'));
    if (child.name !== name) throw new Error(`${manifest.name}: dependency identity mismatch ${name}`);
    await checkPackage(target, boundary, seen);
  }
}
async function inventory(dir, prefix = '') {
  const files = [];
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error(`Archive input contains a link: ${relative}`);
    if (item.name === 'node_modules') throw new Error(`Archive must not contain installed runtime dependencies: ${relative}`);
    if (item.isDirectory()) files.push(...await inventory(path.join(dir, item.name), relative + '/'));
    else files.push({ path: relative, bytes: (await stat(path.join(dir, item.name))).size });
  }
  return files;
}
await checkPackage(controller, controller);
await checkPackage(worker, worker);
const workerPatch = JSON.parse(await readFile(path.join(worker, 'cordis.patch.yml'), 'utf8'));
if (workerPatch.some(row => row.id === 'remote-native-session-controller' || row.config !== undefined)) throw new Error('Worker selection must not depend on Controller B or set deployment policy');
const inventories = {};
for (const [name, directory] of [['controller', controller], ['worker', worker]]) {
  const files = await inventory(directory);
  inventories[name] = { directory, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0), inventory: files };
}
await mkdir(path.join(here, 'dist'), { recursive: true });
await writeFile(path.join(here, 'dist/input-inventory.json'), json({ checkedAt: new Date().toISOString(), frozenClientsMatched: true, internalFileDependenciesOnly: true, ...inventories }));
console.log(`CLOSED INPUTS: Controller ${inventories.controller.files} files; Worker ${inventories.worker.files} files; all local dependencies internal; no node_modules/links`);
