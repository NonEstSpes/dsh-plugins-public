// Copy only the two audited Agent Teams Host modules; never modify the ASAR.
// Run with Electron's ELECTRON_RUN_AS_NODE=1 (ordinary Node cannot read ASAR paths).
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const runtime = process.argv[2];
if (!runtime || !path.isAbsolute(runtime)) throw new Error('Pass the absolute installed dsh directory');
const requireRuntime = createRequire(path.join(runtime, 'package.json'));
const root = fileURLToPath(new URL('../', import.meta.url));
const sources = {
  'team.js': '@deepseek-ai/dsh-experimental-agent-team',
  'tools.js': '@deepseek-ai/dsh-experimental-tool-agent-team',
};
mkdirSync(path.join(root, 'upstream'), { recursive: true });
const provenance = {};
for (const [name, specifier] of Object.entries(sources)) {
  const filename = requireRuntime.resolve(specifier);
  const source = readFileSync(filename);
  const baseline = path.join(root, 'upstream', name);
  const destination = path.join(root, name);
  if (existsSync(baseline) || existsSync(destination)) throw new Error(`Refusing to overwrite ${name}`);
  const manifest = JSON.parse(readFileSync(requireRuntime.resolve(`${specifier}/package.json`), 'utf8'));
  if (manifest.version !== '0.2.2-rc.1') throw new Error('Unsupported source version');
  writeFileSync(baseline, source, { flag: 'wx' });
  writeFileSync(destination, source, { flag: 'wx' });
  provenance[name] = { package: specifier, version: manifest.version, sha256: createHash('sha256').update(source).digest('hex') };
}
writeFileSync(path.join(root, 'upstream', 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n', { flag: 'wx' });
console.log('Copied exactly two Agent Teams Host modules; original application unchanged.');
