// Read-only profile composition audit. Emits hashes only, never settings values.
import { loadProfileDirectory, readProfilePatches, readBundlePatches, composeEntries } from '@deepseek-ai/dsh-app-boot';
import { load } from 'js-yaml';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.DSH_TEAM_TEST_RUNTIME;
const profileDir = process.env.DSH_PROFILE_DIR;
const home = process.env.DSH_HOME;
for (const p of [runtime, profileDir, home]) assert.ok(p && path.isAbsolute(p), 'Runtime, profile and home must be explicit absolute paths');
const installAnchor = path.join(runtime, 'package.json');
const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
assert.equal(profile.skippedBundles.length, 0, 'Do not deploy over unreadable or incompatible bundles');
const context = { dir: profileDir, installAnchor, home, patchPath: profile.patchPath, overlays: [] };
const bundled = readBundlePatches('dsh', context, profile);
const all = readProfilePatches('dsh', context, profile);
const warnings = [];
const existing = composeEntries([all], message => warnings.push(message));
// Preserve existing unrelated warnings; never "repair" unrelated profile rows.
const existingWarnings = [...warnings];
warnings.length = 0;
const customIds = ['agent-team-model-selection', 'tool-agent-team-model-selection'];
function rows(entries) {
  return entries.flatMap(row => [row, ...(row.group && Array.isArray(row.config) ? rows(row.config) : [])]);
}
function hash(value) { return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex'); }
function snapshot(entries) {
  return Object.fromEntries(rows(entries).map(row => [row.id, { name: row.name, disabled: row.disabled === true, hash: hash(row), configHash: hash(row.config) }]));
}
const baselinePath = path.join(root, 'verification', 'composition-baseline.json');
let baseline;
let proposed;
if (process.argv.includes('--after')) {
  const saved = JSON.parse(readFileSync(baselinePath, 'utf8'));
  baseline = saved.rows;
  assert.deepEqual(existingWarnings, saved.warnings, 'Deployment introduced new skipped patches');
  proposed = snapshot(existing);
} else {
  assert.ok(!rows(existing).some(row => customIds.includes(row.id)), 'Extension already present; use --after');
  baseline = snapshot(existing);
  const patch = load(readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'));
  proposed = snapshot(composeEntries([bundled, patch, all.slice(bundled.length)], message => warnings.push(message)));
  assert.deepEqual(warnings, existingWarnings, 'Replacement must not introduce new skipped patches');
}
assert.equal(Object.keys(proposed).length, Object.keys(baseline).length + 2, 'Exactly two new Host rows');
for (const [id, prior] of Object.entries(baseline)) {
  const next = proposed[id];
  assert.ok(next, `Missing existing row ${id}`);
  if (id === 'agent-team' || id === 'tool-agent-team') {
    assert.equal(next.name, prior.name);
    assert.equal(next.configHash, prior.configHash);
    assert.equal(next.disabled, true);
  } else assert.deepEqual(next, prior, `Unrelated row changed: ${id}`);
}
for (const [id, original] of [[customIds[0], 'agent-team'], [customIds[1], 'tool-agent-team']]) {
  assert.equal(proposed[id].disabled, false);
  assert.equal(proposed[id].configHash, baseline[original].configHash, `Must preserve ${original} configuration`);
}
if (!process.argv.includes('--after')) {
  mkdirSync(path.dirname(baselinePath), { recursive: true });
  const safeBaseline = { rows: baseline, warnings: existingWarnings };
  if (existsSync(baselinePath)) assert.deepEqual(JSON.parse(readFileSync(baselinePath, 'utf8')), safeBaseline, 'Baseline has changed');
  else writeFileSync(baselinePath, JSON.stringify(safeBaseline, null, 2) + '\n', { flag: 'wx' });
}
console.log(JSON.stringify({ phase: process.argv.includes('--after') ? 'installed' : 'preflight', unchangedExistingRows: Object.keys(baseline).length - 2, disabledStockTeamRows: 2, insertedTeamHostRows: 2, teamConfigurationPreserved: true, unrelatedRowsUnchanged: true, preExistingWarnings: existingWarnings, newWarnings: 0 }));
