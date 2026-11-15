/** Refresh only the two approved API Client artifacts; every other frozen bundle byte is checked unchanged. */
import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../dsh-remote-core');
const bundle = path.join(here, 'bundle');
const source = path.join(root, 'packages/api/session-controller');
const require = createRequire(path.join(root, 'package.json'));
const { build } = await import(pathToFileURL(require.resolve('tsdown')).href);
const { clientBundle } = await import(pathToFileURL(path.join(root, 'packages/client/tsdown.client.ts')).href);
const ids = ['session-controller', 'worker-session-controller'];
const artifacts = ['client.js', 'client.js.map'];
const allowed = new Set(ids.flatMap(id => artifacts.map(file => `packages/${id}/lib/${file}`)));
const hash = value => createHash('sha256').update(value).digest('hex');
async function snapshot(dir, prefix = '') {
  const result = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const file = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Frozen bundle contains unexpected link: ${relative}`);
    if (entry.isDirectory()) Object.assign(result, await snapshot(file, relative + '/'));
    else result[relative] = hash(await readFile(file));
  }
  return result;
}
const before = await snapshot(bundle);
for (const id of ids) {
  const stage = path.join(root, '.dsh-build/plugin-native/packages-v2', id);
  const manifest = JSON.parse(await readFile(path.join(stage, 'package.json'), 'utf8'));
  if (manifest.name !== `@dsh-remote/${id}`) throw new Error(`Unexpected staged provider: ${manifest.name}`);
  await cp(path.join(source, 'lib/types/client'), path.join(stage, 'lib/types/client'), { recursive: true, force: true });
  await cp(path.join(source, 'src/client'), path.join(stage, 'src/client'), { recursive: true, force: true });
  const client = clientBundle(stage, ['lib/types/index.js'])({ env: { DSH_BUILD_FACE: 'client' } })
    .find(config => config.name === `${manifest.name}/client`);
  if (!client) throw new Error(`Missing maintained Client config: ${id}`);
  console.log(`REFRESH ${manifest.name}/client`);
  await build({ ...client, cwd: stage, config: false, tsconfig: false, logLevel: 'warn',
    inputOptions: { ...client.inputOptions, onLog(level, diagnostic, handler) {
      if (diagnostic.code === 'UNRESOLVED_IMPORT') throw new Error(diagnostic.message);
      handler(level, diagnostic);
    } },
    plugins: [client.plugins, { name: 'approved-client-output-only', generateBundle(_options, emitted) {
      for (const file of Object.keys(emitted)) if (!artifacts.includes(file)) throw new Error(`Unapproved output ${id}/${file}`);
    } }],
  });
}
// Both builds must succeed before changing any frozen delivery file.
for (const id of ids) for (const file of artifacts) {
  const stage = path.join(root, '.dsh-build/plugin-native/packages-v2', id, 'lib', file);
  await cp(stage, path.join(bundle, 'packages', id, 'lib', file), { force: true });
}
const after = await snapshot(bundle);
const all = new Set([...Object.keys(before), ...Object.keys(after)]);
for (const file of all) if (!allowed.has(file) && before[file] !== after[file]) throw new Error(`Unapproved bundle change: ${file}`);
const changes = [...allowed].map(file => ({ file, before: before[file], after: after[file], changed: before[file] !== after[file] }));
const report = { refreshedAt: new Date().toISOString(), scope: 'foreign-only durable ACK pending-echo retirement',
  otherBundleBytesUnchanged: true, unchangedFilesChecked: [...all].filter(file => !allowed.has(file)).length,
  buildReportPreserved: before['build-report.json'] === after['build-report.json'],
  moduleAuditPreserved: before['module-audit.json'] === after['module-audit.json'], changes,
};
await writeFile(path.join(here, 'client-refresh-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`REFROZEN: exactly four approved Client files; ${report.unchangedFilesChecked} other files unchanged`);
