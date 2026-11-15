/** Repair only explicit metadata peer declarations; does not rebuild or rewrite any factory. */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.resolve(here, '../../dsh-remote-core/package.json'));
const report = JSON.parse(await readFile(path.join(here, 'bundle/build-report.json'), 'utf8'));
for (const provider of report.providers) {
  const file = path.join(here, 'bundle/packages', provider.name.split('/')[1], 'package.json');
  const manifest = JSON.parse(await readFile(file, 'utf8'));
  if (!manifest.exports['./typert']) continue;
  manifest.peerDependencies.zod = require('zod/package.json').version;
  manifest.peerDependencies['@deepseek-ai/dsh-typert-protocol'] = '0.2.2-rc.1';
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
}
console.log('Declared metadata Zod/RemoteInfo peers; build.mjs emits the same declarations on a fresh build');
