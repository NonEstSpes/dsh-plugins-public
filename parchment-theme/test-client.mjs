import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
let entry;
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      entry = value;
    },
  },
};

await import(pathToFileURL(file).href);
if (!entry) throw new Error('module did not register a loader entry');
if (entry.id !== '@local/parchment-theme') throw new Error(`unexpected id ${entry.id}`);

const plugin = entry.factory(() => {
  throw new Error('parchment theme must not require browser modules');
});

const calls = [];
const ctx = {
  effect(callback) {
    const dispose = callback();
    return () => dispose?.();
  },
  theme: {
    overrideTokens(source, tokens) {
      calls.push({ source, tokens });
      return () => {};
    },
  },
};

plugin.apply(ctx);
if (calls.length !== 1) throw new Error(`expected one override layer, got ${calls.length}`);
const [{ source, tokens }] = calls;
if (source !== '@local/parchment-theme') throw new Error(`unexpected source ${source}`);

const names = Object.keys(tokens);
if (names.length < 100) throw new Error(`only ${names.length} tokens`);

const problems = [];
for (const [name, value] of Object.entries(tokens)) {
  if (!name.startsWith('--')) problems.push(`${name}: name must start with --`);
  if (typeof value !== 'object' || value === null) {
    problems.push(`${name}: value must be a pair`);
    continue;
  }
  for (const mode of ['light', 'dark']) {
    if (typeof value[mode] !== 'string' || value[mode].trim() === '') {
      problems.push(`${name}: missing ${mode} string`);
    }
  }
  if (Object.keys(value).length !== 2) problems.push(`${name}: pair has extra keys`);
}

const required = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-state-idle-primary',
  '--dsw-specific-sidebar-fill',
];
for (const name of required) {
  if (!(name in tokens)) problems.push(`${name}: theme alias not overridden`);
}

if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}

const staticCount = names.filter((name) => name.startsWith('--dsw-static-')).length;
const aliasCount = names.length - staticCount;
console.log(`tokens: ${names.length} (static ${staticCount}, alias/style ${aliasCount})`);
console.log('all values are { light, dark } string pairs');
