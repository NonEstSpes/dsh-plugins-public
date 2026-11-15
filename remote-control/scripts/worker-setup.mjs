import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { diagnoseRelay } from './relay-diagnose.mjs';

const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const id = x => typeof x === 'string' && x.trim() === x && /^[a-zA-Z0-9_-]{1,80}$/.test(x) && !['__proto__', 'prototype', 'constructor'].includes(x);
const absolute = x => /^[A-Za-z]:[\\/]/.test(x) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(x) || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(x) || (process.platform !== 'win32' && path.posix.isAbsolute(x));

// Parse structure before JSON.parse: never search/replace inside arbitrary strings.
// Only raw drive-absolute path values at the two documented schema locations qualify.
export function repairWorkerConfig(raw) {
  if (typeof raw !== 'string' || raw.length > 1024 * 1024) fail('INVALID_JSON');
  let i = 0;
  const edits = [], changes = [];
  if (raw.startsWith('\uFEFF')) { raw = raw.slice(1); changes.push('UTF-8 BOM removed'); }
  const ws = () => { while (/\s/.test(raw[i] || '') && i < raw.length) i++; };
  function string(location, isKey = false) {
    const start = i++;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i] === '"') break;
      if (raw.charCodeAt(i) < 32) fail('INVALID_JSON');
      i++;
    }
    if (i >= raw.length) fail('INVALID_JSON');
    const end = ++i, token = raw.slice(start, end), body = token.slice(1, -1);
    const known = !isKey && ((location.length === 1 && location[0] === 'stateDir') ||
      (location.length === 3 && location[0] === 'projects' && location[2] === 'cwd'));
    if (known && /^[A-Za-z]:\\/.test(body)) {
      try {
        const decoded = JSON.parse(token);
        if (absolute(decoded) && !/[\x00-\x1f]/.test(decoded)) return decoded;
      } catch { /* A raw Windows path may not be legal JSON until repaired. */ }
      const runs = [...body.matchAll(/\\+/g)].map(m => m[0].length);
      // A mixed escaped/raw path is ambiguous; do not reinterpret it.
      if (runs.some(n => n === 1)) {
        if (runs.some(n => n !== 1) || /["\x00-\x1f]/.test(body)) fail('AMBIGUOUS_PATH');
        const repaired = body.replaceAll('\\', '/');
        edits.push({ start, end, text: JSON.stringify(repaired) });
        changes.push(location.length === 1 ? 'stateDir path syntax' : 'project cwd path syntax');
        return repaired;
      }
    }
    try { return JSON.parse(token); } catch { fail('INVALID_JSON'); }
  }
  function value(location, depth = 0) {
    if (depth > 40) fail('INVALID_JSON');
    ws();
    if (raw[i] === '"') return string(location);
    if (raw[i] === '{') {
      i++; ws(); const keys = new Set();
      if (raw[i] === '}') { i++; return; }
      while (true) {
        ws(); if (raw[i] !== '"') fail('INVALID_JSON');
        const key = string([], true);
        if (keys.has(key)) fail('DUPLICATE_JSON_KEY');
        keys.add(key); ws(); if (raw[i++] !== ':') fail('INVALID_JSON');
        value([...location, key], depth + 1); ws();
        const c = raw[i++]; if (c === '}') return; if (c !== ',') fail('INVALID_JSON');
      }
    }
    if (raw[i] === '[') {
      i++; ws(); if (raw[i] === ']') { i++; return; }
      let n = 0;
      while (true) { value([...location, n++], depth + 1); ws(); const c = raw[i++]; if (c === ']') return; if (c !== ',') fail('INVALID_JSON'); }
    }
    const token = raw.slice(i).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/)?.[0];
    if (!token) fail('INVALID_JSON'); i += token.length;
  }
  value([]); ws(); if (i !== raw.length) fail('INVALID_JSON');
  let text = raw;
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  let config; try { config = JSON.parse(text); } catch { fail('INVALID_JSON'); }
  return { text, config, changes };
}

export function validateWorkerConfig(config, configPath) {
  const errors = [], warnings = [];
  if (!record(config)) return { ok: false, errors: ['CONFIG_OBJECT_REQUIRED'], warnings };
  if (config.role !== 'worker') errors.push('WORKER_ROLE_REQUIRED');
  if (!id(config.id) || !id(config.peerId) || config.id === config.peerId) errors.push('INVALID_ENDPOINT_IDS');
  try {
    if (typeof config.relayUrl !== 'string' || /[\s\\?#]/.test(config.relayUrl)) throw 0;
    const u = new URL(config.relayUrl);
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password || u.search || u.hash || !/^https:\/\/[^/]+/i.test(config.relayUrl) || config.relayUrl.match(/^https:\/\/([^/]+)/i)[1].includes('@')) throw 0;
  } catch { errors.push('INVALID_HTTPS_RELAY_URL'); }
  if (typeof config.sharedKey !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(config.sharedKey) || Buffer.from(config.sharedKey, 'base64url').length !== 32 || Buffer.from(config.sharedKey, 'base64url').toString('base64url') !== config.sharedKey) errors.push('INVALID_SHARED_KEY');
  if (typeof config.relayToken !== 'string' || config.relayToken.trim() !== config.relayToken || !/^[A-Za-z0-9._~-]{16,512}$/.test(config.relayToken)) errors.push('INVALID_RELAY_TOKEN');
  if (typeof config.stateDir !== 'string' || !config.stateDir || /[\x00-\x1f]/.test(config.stateDir)) errors.push('INVALID_STATE_DIRECTORY');
  if (!record(config.projects) || !Object.keys(config.projects).length) errors.push('PROJECTS_REQUIRED');
  else for (const [name, project] of Object.entries(config.projects)) {
    if (!id(name) || !record(project)) { errors.push('INVALID_PROJECT'); continue; }
    if (typeof project.cwd !== 'string' || !absolute(project.cwd) || /[\x00-\x1f]/.test(project.cwd)) errors.push('PROJECT_CWD_MUST_BE_ABSOLUTE');
    if (project.allowedTools !== undefined && (!Array.isArray(project.allowedTools) || project.allowedTools.some(x => !['read', 'glob', 'grep'].includes(x)))) errors.push('INVALID_ALLOWED_TOOLS');
    if (project.agentPreset !== undefined && typeof project.agentPreset !== 'string') errors.push('INVALID_AGENT_PRESET');
    if (project.exportFinalText !== undefined && typeof project.exportFinalText !== 'boolean') errors.push('INVALID_EXPORT_FINAL_TEXT');
    if (project.exportFinalText !== true) warnings.push('Final text export is disabled; enable only by your explicit settings edit if desired.');
    if (project.allowedTools === undefined || (Array.isArray(project.allowedTools) && project.allowedTools.length === 0)) warnings.push('No file tools granted; grants were not changed.');
  }
  const stateDir = typeof config.stateDir === 'string' ? (absolute(config.stateDir) ? config.stateDir : path.resolve(path.dirname(configPath), config.stateDir)) : undefined;
  return { ok: errors.length === 0, errors: [...new Set(errors)], warnings: [...new Set(warnings)], stateDir };
}

async function safeFile(filename) {
  const resolved = path.resolve(filename);
  // Reject symlinks/junctions in every existing ancestor, including the file itself.
  let cursor = resolved;
  while (true) {
    const st = await fs.lstat(cursor);
    if (st.isSymbolicLink()) fail('UNSAFE_LINK_PATH');
    if (cursor === resolved && !st.isFile()) fail('CONFIG_NOT_REGULAR_FILE');
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  if (path.normalize(await fs.realpath(resolved)).toLowerCase() !== path.normalize(resolved).toLowerCase()) fail('UNSAFE_LINK_PATH');
  return resolved;
}

export async function runWorkerSetup(argv = process.argv.slice(2), options = {}) {
  const log = options.log || (s => console.log(s));
  let rl;
  const ask = options.ask || (async question => { rl ||= createInterface({ input: process.stdin, output: process.stdout }); return rl.question(question); });
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  let filename, check = false, network = true, createProject = false;
  try {
    if (Number(process.versions.node.split('.')[0]) < 22) fail('NODE_22_REQUIRED');
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--check') check = true;
      else if (a === '--no-network') network = false;
      else if (a === '--create-project') createProject = true;
      else if (a === '--config') { if (!argv[i + 1] || argv[i + 1].startsWith('--') || filename) fail('INVALID_ARGUMENTS'); filename = argv[++i]; }
      else if (a.startsWith('-') || filename) fail('INVALID_ARGUMENTS');
      else filename = a;
    }
    if (!filename) {
      // Only discover a conventional config beside this standalone script; never inspect profiles.
      const candidate = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worker.json');
      try { await fs.lstat(candidate); filename = candidate; } catch (e) { if (e.code !== 'ENOENT') throw e; }
      if (!filename && interactive) filename = (await ask('Worker JSON config path: ')).trim().replace(/^"(.*)"$/, '$1');
      if (!filename) fail('CONFIG_PATH_REQUIRED');
    }
    filename = await safeFile(filename);
    log(`Config: ${filename}`);
    const before = await fs.stat(filename);
    const raw = await fs.readFile(filename, 'utf8');
    const repaired = repairWorkerConfig(raw);
    const validation = validateWorkerConfig(repaired.config, filename);
    if (!validation.ok) { for (const code of validation.errors) log(`Error: ${code}`); return { ok: false, exitCode: 1, errors: validation.errors }; }
    for (const warning of validation.warnings) log(`Notice: ${warning}`);
    // Revalidate prior to writes; never modify stateDir, journals, locks, keys, grants or profile.
    const missing = [];
    for (const project of Object.values(repaired.config.projects)) {
      try { const st = await fs.stat(project.cwd); if (!st.isDirectory()) fail('PROJECT_CWD_NOT_DIRECTORY'); }
      catch (e) { if (e.code === 'ENOENT') missing.push(project.cwd); else throw e; }
    }
    let backup;
    if (repaired.changes.length) {
      log(`${check ? 'Would repair' : 'Repair'}: ${[...new Set(repaired.changes)].join(', ')}`);
      if (!check) {
        await safeFile(filename);
        if ((await fs.readFile(filename, 'utf8')) !== raw) fail('CONFIG_CHANGED_DURING_SETUP');
        backup = `${filename}.backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
        const backupHandle = await fs.open(backup, 'wx', 0o600);
        try { await backupHandle.writeFile(raw, 'utf8'); await backupHandle.sync(); }
        finally { await backupHandle.close(); }
        log('Backup contains secrets. Keep it local and private.');
        const handle = await fs.open(filename, 'r+');
        try {
          const current = await handle.stat();
          if (current.ino !== before.ino || current.dev !== before.dev || await handle.readFile('utf8') !== raw) fail('CONFIG_CHANGED_DURING_SETUP');
          await safeFile(filename);
          const bytes = Buffer.from(repaired.text, 'utf8');
          for (let offset = 0; offset < bytes.length;) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
            if (!bytesWritten) fail('REVALIDATION_FAILED');
            offset += bytesWritten;
          }
          await handle.truncate(bytes.length);
          await handle.sync();
        } finally { await handle.close(); }
        const after = repairWorkerConfig(await fs.readFile(filename, 'utf8'));
        if (!validateWorkerConfig(after.config, filename).ok || after.changes.length) fail('REVALIDATION_FAILED');
      }
    }
    let directoriesOK = true;
    for (const cwd of missing) {
      let approved = createProject;
      if (!approved && !check && interactive) approved = /^(y|yes)$/i.test((await ask(`Create missing project directory ${cwd}? [y/N] `)).trim());
      if (approved && !check) { await fs.mkdir(cwd, { recursive: true }); log('Created missing project directory.'); }
      else { directoriesOK = false; log('Error: PROJECT_DIRECTORY_MISSING (use --create-project or create it yourself)'); }
    }
    let networkOK = true;
    if (network) {
      log('Checking relay health and authentication (up to 24 seconds); no task is sent.');
      const report = await (options.diagnoseRelay || diagnoseRelay)({ relayUrl: repaired.config.relayUrl, relayToken: repaired.config.relayToken, allowLoopback: false, timeoutMs: 12000, poll: false });
      networkOK = report?.ok === true;
      // Never stringify third-party result/error: it may contain credentials or request URLs.
      log(`Network: ${networkOK ? 'OK (TLS and relay authentication)' : 'FAILED (check connectivity, TLS, relay settings and token locally)'}`);
      const codes = new Set(['OK', 'HTTP_REDIRECT', 'RELAY_AUTH_FAILED', 'RELAY_HTTP_ERROR', 'INVALID_RELAY_RESPONSE', 'REQUEST_TIMEOUT', 'NETWORK_FAILURE', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']);
      for (const stage of ['health', 'auth']) {
        const step = report?.checks?.[stage];
        if (!step) continue;
        const status = Number.isInteger(step.httpStatus) && step.httpStatus >= 100 && step.httpStatus <= 599 ? `HTTP ${step.httpStatus}` : 'no HTTP response';
        log(`Relay ${stage}: ${status}; ${codes.has(step.code) ? step.code : 'CHECK_FAILED'}`);
      }
      log('Long-poll and native DSH session execution are not tested by this setup check.');
    } else log('Network: skipped');
    log(`Next: set plugin settingsFile to ${filename}, then /remote-reload. Profile was not edited.`);
    const ok = directoriesOK && networkOK && !(check && repaired.changes.length);
    log(`Validation: ${ok ? 'OK' : 'action required'}`);
    return { ok, exitCode: ok ? 0 : 1, changes: repaired.changes, backup, configPath: filename };
  } catch (e) {
    const safe = new Set(['NODE_22_REQUIRED', 'INVALID_JSON', 'AMBIGUOUS_PATH', 'DUPLICATE_JSON_KEY', 'INVALID_ARGUMENTS', 'CONFIG_PATH_REQUIRED', 'UNSAFE_LINK_PATH', 'CONFIG_NOT_REGULAR_FILE', 'CONFIG_CHANGED_DURING_SETUP', 'PROJECT_CWD_NOT_DIRECTORY', 'REVALIDATION_FAILED']);
    const code = safe.has(e?.code) ? e.code : 'SETUP_FAILED (check file access, paths and network locally)';
    log(`Error: ${code}`); return { ok: false, exitCode: 1, errors: [code] };
  } finally { rl?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runWorkerSetup(); process.exitCode = result.exitCode;
}
