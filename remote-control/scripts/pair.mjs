import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, lstat, open } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';

function validateUrl(input, allowLoopback) {
  if (typeof input !== 'string' || !input || /[\s\\?#]/.test(input)) throw new Error('Invalid relay URL (no credentials, query, or fragment)');
  let url;
  try { url = new URL(input); } catch { throw new Error('Invalid relay URL'); }
  const authority = input.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/]+)/)?.[1];
  if (!authority || authority.includes('@') || url.username || url.password || !url.hostname) throw new Error('Invalid relay URL');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopback && /^(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?$/i.test(authority))) {
    throw new Error('HTTPS required; --allow-loopback permits only literal local development hosts');
  }
  return url.href;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

/** Create a new pairing; never overwrite any existing pairing/ignore file. */
export async function pair({ url, out = '.private', allowLoopback = false } = {}) {
  if (typeof allowLoopback !== 'boolean' || typeof out !== 'string' || !out || out.includes('\0')) throw new Error('Invalid pairing options');
  const relayUrl = validateUrl(url, allowLoopback);
  const directory = path.resolve(out);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Output must be a real directory, not a symbolic link');
  const names = ['.gitignore', 'controller.json', 'worker.json', 'relay.json'];
  for (const name of names) {
    try {
      await lstat(path.join(directory, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error('Cannot inspect pairing output');
    }
    throw new Error('Pairing output already exists; refusing to overwrite');
  }
  // Reserve all files exclusively before writing any secret. A partial failure is not
  // silently rolled back: explicit operator inspection is safer than deleting files.
  const handles = [];
  try {
    for (const name of names) handles.push(await open(path.join(directory, name), 'wx', 0o600));
    const sharedKey = randomBytes(32).toString('base64url');
    const controllerToken = randomBytes(32).toString('base64url');
    const workerToken = randomBytes(32).toString('base64url');
    const controllerId = `controller_${randomBytes(12).toString('base64url')}`;
    const workerId = `worker_${randomBytes(12).toString('base64url')}`;
    const common = { relayUrl, sharedKey, allowLoopback };
    const controller = { ...common, role: 'controller', id: controllerId, peerId: workerId, relayToken: controllerToken, stateDir: './controller-state', delivery: 'notify' };
    const worker = { ...common, role: 'worker', id: workerId, peerId: controllerId, relayToken: workerToken, stateDir: './worker-state', projects: {} };
    const relay = {
      directory: './relay-state', host: '127.0.0.1', port: 8787,
      devices: [
        { id: controllerId, peerId: workerId, tokenHash: createHash('sha256').update(controllerToken).digest('hex') },
        { id: workerId, peerId: controllerId, tokenHash: createHash('sha256').update(workerToken).digest('hex') },
      ],
    };
    // Ignore the entire directory, including future state/lock/temp files. No secrets
    // or generated tokens are ever printed or embedded in an ignore rule.
    const contents = ['*\n!.gitignore\n', `${JSON.stringify(controller, null, 2)}\n`, `${JSON.stringify(worker, null, 2)}\n`, `${JSON.stringify(relay, null, 2)}\n`];
    await handles[0].writeFile(contents[0], 'utf8');
    await handles[0].sync();
    for (let index = 1; index < handles.length; index++) {
      await handles[index].writeFile(contents[index], 'utf8');
      await handles[index].sync();
    }
    await syncDirectory(directory);
    return { directory, files: names.slice(1).map(name => path.join(directory, name)) };
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Pairing output already exists; refusing to overwrite (inspect partial output before retrying)');
    // Do not print raw filesystem/network errors, which can carry user-provided URLs.
    throw new Error('Pairing failed; inspect the output directory before retrying');
  } finally {
    await Promise.all(handles.map(handle => handle.close()));
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--allow-loopback') {
      if (options.allowLoopback) throw new Error('Duplicate --allow-loopback');
      options.allowLoopback = true;
    } else if (flag === '--url' || flag === '--out') {
      const key = flag === '--url' ? 'url' : 'out';
      if (options[key] !== undefined || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Invalid pairing arguments');
      options[key] = argv[++index];
    } else if (flag === '--help') {
      console.log('Usage: node scripts/pair.mjs --url https://relay.example [--out .private] [--allow-loopback]');
      return;
    } else throw new Error('Unknown pairing option');
  }
  if (!options.url) throw new Error('--url is required');
  await pair(options);
  console.log('Pairing created; no secrets printed. Transfer endpoint configs only over a trusted channel.');
  console.log('Worker projects allowlist is empty: configure it locally before use.');
  if (options.allowLoopback) console.log('Development-only loopback HTTP permission enabled.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    console.error('Pairing failed. Check arguments/output files; existing files are never overwritten.');
    process.exitCode = 1;
  });
}
