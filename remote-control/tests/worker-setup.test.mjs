import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairWorkerConfig, validateWorkerConfig, runWorkerSetup } from '../scripts/worker-setup.mjs';

export async function runWorkerSetupTests() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-worker-setup-test-'));
  const configPath = path.join(root, 'worker.json');
  const secret = Buffer.alloc(32, 7).toString('base64url');
  const token = 'local-test-token-never-print';
  const base = () => ({ role: 'worker', id: 'worker', peerId: 'controller', relayUrl: 'https://relay.invalid/base', sharedKey: secret, relayToken: token, stateDir: './state-keep', projects: { demo: { cwd: root } } });
  const rawPath = String.raw`C:\repair-fixture`;
  const withRaw = (config = base()) => JSON.stringify(config).replace(JSON.stringify(config.projects.demo.cwd), `"${rawPath}"`);
  const output = [];
  const opts = { log: s => output.push(s), interactive: false, diagnoseRelay: async () => { throw Error('must not hit relay'); } };
  const run = (...args) => runWorkerSetup(['--config', configPath, '--no-network', ...args], opts);
  try {
    const repaired = repairWorkerConfig(withRaw());
    assert.equal(repaired.config.projects.demo.cwd, 'C:/repair-fixture');
    assert.equal(repaired.config.sharedKey, secret);
    assert.equal(repaired.config.relayToken, token);
    assert.equal(repaired.config.stateDir, './state-keep');
    assert.equal(repairWorkerConfig(withRaw().replace(rawPath, String.raw`C:\unknown\work`)).config.projects.demo.cwd, 'C:/unknown/work');
    const clean = base(); clean.projects.demo.cwd = String.raw`C:\repair-fixture`; clean.extra = String.raw`text "cwd":"C:\raw"`;
    const valid = JSON.stringify(clean);
    assert.equal(repairWorkerConfig(valid).text, valid);
    const bom = repairWorkerConfig('\uFEFF' + valid);
    assert.equal(bom.text, valid); assert.deepEqual(bom.config, JSON.parse(valid));
    const unicodePath = JSON.stringify(base()).replace(JSON.stringify(root), String.raw`"C:\u005ctmp"`);
    assert.equal(repairWorkerConfig(unicodePath).text, unicodePath, 'Valid Unicode-escaped absolute paths are not reinterpreted');
    clean.projects.demo.cwd = String.raw`\\server\share\folder`;
    assert.equal(repairWorkerConfig(JSON.stringify(clean)).text, JSON.stringify(clean));
    const state = JSON.stringify(base()).replace('"./state-keep"', String.raw`"C:\state\journal"`);
    assert.equal(repairWorkerConfig(state).config.stateDir, 'C:/state/journal');
    assert.throws(() => repairWorkerConfig(withRaw().slice(0, -1)), /INVALID_JSON/);
    assert.throws(() => repairWorkerConfig(withRaw().replace(rawPath, String.raw`C:\raw\\mixed`)), /AMBIGUOUS_PATH/);
    const secretMalformed = JSON.stringify(base()).replace(token, String.raw`C:\unknown\secret`);
    assert.throws(() => repairWorkerConfig(secretMalformed), /INVALID_JSON/);
    assert.throws(() => repairWorkerConfig('{"role":"worker","role":"controller"}'), /DUPLICATE_JSON_KEY/);
    const validation = validateWorkerConfig(base(), configPath);
    assert.equal(validation.ok, true);
    assert.equal(validation.stateDir, path.join(root, 'state-keep'));
    assert.match(validation.warnings.join(' '), /export is disabled/);
    assert.equal(base().projects.demo.allowedTools, undefined);
    assert.equal(base().projects.demo.exportFinalText, undefined);
    for (const patch of [ { role: 'controller' }, { relayUrl: 'http://relay.invalid' }, { relayUrl: 'https://user:pass@relay.invalid' }, { relayUrl: 'https://relay.invalid?token=x' }, { sharedKey: 'x' }, { relayToken: 'short' }, { projects: {} } ]) assert.equal(validateWorkerConfig({ ...base(), ...patch }, configPath).ok, false);
    const denied = base(); denied.projects.demo.allowedTools = ['write'];
    assert.equal(validateWorkerConfig(denied, configPath).ok, false);
    denied.projects.demo.allowedTools = null;
    assert.equal(validateWorkerConfig(denied, configPath).ok, false);

    // Dry-run cannot create directories, backups, or alter config/profile files.
    await fs.writeFile(configPath, withRaw());
    const profile = path.join(root, 'cordis.yml'); await fs.writeFile(profile, 'untouched-profile');
    const before = await fs.readdir(root);
    const checked = await run('--check', '--create-project');
    assert.equal(checked.ok, false);
    assert.equal(await fs.readFile(configPath, 'utf8'), withRaw());
    assert.deepEqual(await fs.readdir(root), before);

    // Use a real existing cwd while repairing only stateDir, to avoid creating C: paths.
    await fs.writeFile(configPath, state);
    const fixed = await run();
    assert.equal(fixed.ok, true);
    assert.ok(fixed.backup);
    assert.equal(await fs.readFile(fixed.backup, 'utf8'), state);
    const result = JSON.parse(await fs.readFile(configPath, 'utf8'));
    assert.equal(result.stateDir, 'C:/state/journal');
    assert.equal(result.projects.demo.allowedTools, undefined);
    assert.equal(result.projects.demo.exportFinalText, undefined);
    assert.equal(result.sharedKey, secret);
    assert.equal(result.relayToken, token);
    assert.equal(await fs.readFile(profile, 'utf8'), 'untouched-profile');
    // Force backup collision: it must fail before touching the original or the backup.
    const backupStat = await fs.stat(fixed.backup); assert.ok(backupStat.isFile());
    const RealDate = globalThis.Date;
    const fixedTime = '2026-01-02T03:04:05.000Z';
    const collision = `${configPath}.backup-${fixedTime.replace(/[:.]/g, '-')}`;
    await fs.writeFile(collision, 'existing-private-backup');
    await fs.writeFile(configPath, state);
    try {
      globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [fixedTime])); } };
      assert.equal((await run()).ok, false);
      assert.equal(await fs.readFile(configPath, 'utf8'), state);
      assert.equal(await fs.readFile(collision, 'utf8'), 'existing-private-backup');
    } finally { globalThis.Date = RealDate; }

    const relative = JSON.stringify(base()); await fs.writeFile(configPath, relative);
    assert.equal((await run()).ok, true);
    assert.equal(await fs.readFile(configPath, 'utf8'), relative);
    assert.equal((await fs.readdir(root)).filter(x => x.includes('.backup-')).length, 2);
    const wrong = withRaw({ ...base(), role: 'controller' }); await fs.writeFile(configPath, wrong);
    assert.equal((await run()).ok, false);
    assert.equal(await fs.readFile(configPath, 'utf8'), wrong);
    const corrupt = `${withRaw()} secret malformed ${token}`; await fs.writeFile(configPath, corrupt);
    assert.equal((await run()).ok, false);
    assert.equal(await fs.readFile(configPath, 'utf8'), corrupt);
    const noPermissions = base(); noPermissions.projects.demo.exportFinalText = false; noPermissions.projects.demo.allowedTools = ['read'];
    await fs.writeFile(configPath, JSON.stringify(noPermissions)); await run();
    assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), noPermissions);
    let call;
    const net = await runWorkerSetup([configPath], { ...opts, diagnoseRelay: async input => { call = input; return { ok: true, unsafe: token }; } });
    assert.equal(net.ok, true); assert.equal(call.poll, false); assert.equal(call.allowLoopback, false);
    await runWorkerSetup([configPath], { ...opts, diagnoseRelay: async () => { throw Error(token); } });
    assert.ok(!output.join('\n').includes(secret)); assert.ok(!output.join('\n').includes(token));
    assert.ok(!output.join('\n').includes('"role"'));
    // Explicit creation only; check mode above cannot create anything.
    const missing = base(); missing.projects.demo.cwd = path.join(root, 'new-project');
    await fs.writeFile(configPath, JSON.stringify(missing)); assert.equal((await run()).ok, false);
    await assert.rejects(fs.stat(missing.projects.demo.cwd), { code: 'ENOENT' });
    assert.equal((await run('--create-project')).ok, true);
    assert.ok((await fs.stat(missing.projects.demo.cwd)).isDirectory());
    // Symlink/junction must never be followed by a repair.
    const link = path.join(root, 'linked.json');
    try {
      await fs.symlink(configPath, link);
      const refused = await runWorkerSetup([link, '--no-network'], opts); assert.equal(refused.ok, false); assert.deepEqual(refused.errors, ['UNSAFE_LINK_PATH']);
    } catch (e) { if (!['EPERM', 'EACCES'].includes(e.code)) throw e; }
    return { passed: true };
  } finally {
    // root is the exact uniquely-created, owned temporary directory; never use a user path.
    assert.ok(path.isAbsolute(root));
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-worker-setup-test-'));
    await fs.rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runWorkerSetupTests(); console.log('worker-setup tests passed');
}
