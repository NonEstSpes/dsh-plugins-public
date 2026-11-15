import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function jsonClone(value) {
  const seen = new Set();
  function check(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || seen.has(item)) throw new TypeError('Store values must be acyclic JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError('Store values must be plain JSON');
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (let index = 0; index < item.length; index++) {
        if (!Object.hasOwn(item, index)) throw new TypeError('Sparse arrays are not JSON snapshots');
        check(item[index]);
      }
    } else {
      for (const key of Reflect.ownKeys(item)) {
        if (typeof key !== 'string') throw new TypeError('Store values must be JSON');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new TypeError('Store values cannot contain accessors');
        check(descriptor.value);
      }
    }
    seen.delete(item);
  }
  check(value);
  return JSON.parse(JSON.stringify(value));
}

async function syncDirectory(directory) {
  // Directory handles/fsync are unavailable on some Windows/filesystem combinations.
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    if (!['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally {
    await handle?.close();
  }
}

async function rejectNonFile(file) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Store path must be a regular non-symlink file');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

/** One exclusive writer. An orphaned .lock requires deliberate operator recovery. */
export async function openJsonStore(file, initial, { existingOnly = false } = {}) {
  if (typeof file !== 'string' || !file || file.includes('\0')) throw new TypeError('A store filename is required');
  const resolved = path.resolve(file);
  const name = path.basename(resolved);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name) || name.endsWith('.') || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
    throw new TypeError('Unsafe store filename');
  }
  const directory = path.dirname(resolved);
  if (existingOnly) { const info = await lstat(resolved); if (!info.isFile() || info.isSymbolicLink()) throw new TypeError('Existing regular store required'); }
  else await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockFile = `${resolved}.lock`;
  let lock;
  try {
    lock = await open(lockFile, 'wx', 0o600);
  } catch (error) {
    if (error.code === 'EEXIST') {
      const locked = new Error('Store is locked; stale locks are never automatically stolen');
      locked.code = 'STORE_LOCKED';
      throw locked;
    }
    throw error;
  }
  let snapshot;
  let tail = Promise.resolve();
  let closed = false;
  let closePromise;
  let poisoned;

  async function commit(next) {
    const temporary = path.join(directory, `${name}.${randomUUID()}.tmp`);
    let handle;
    let exists = false;
    try {
      await rejectNonFile(resolved);
      if (existingOnly) await lstat(resolved);
      handle = await open(temporary, 'wx', 0o600);
      exists = true;
      await handle.writeFile(`${JSON.stringify(next)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, resolved);
      exists = false;
      await syncDirectory(directory);
    } finally {
      await handle?.close();
      if (exists) await unlink(temporary).catch(() => {});
    }
  }

  async function release() {
    await lock.close();
    await unlink(lockFile);
    await syncDirectory(directory);
  }

  try {
    await lock.writeFile(JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() }), 'utf8');
    await lock.sync();
    await rejectNonFile(resolved);
    let contents;
    try {
      contents = await readFile(resolved, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (contents === undefined) {
      if (existingOnly) { const missing = new Error('Existing store disappeared; refusing initialization'); missing.code = 'ENOENT'; throw missing; }
      snapshot = jsonClone(initial);
      await commit(snapshot);
    } else {
      try {
        snapshot = jsonClone(JSON.parse(contents));
      } catch {
        const error = new Error('Corrupt JSON store; refusing to overwrite');
        error.code = 'STORE_CORRUPT';
        throw error;
      }
    }
  } catch (error) {
    await release().catch(() => {});
    throw error;
  }

  return {
    get() {
      if (closed) throw new Error('Store is closed');
      if (poisoned) throw poisoned;
      return jsonClone(snapshot);
    },
    update(mutator) {
      if (closed) return Promise.reject(new Error('Store is closed'));
      if (typeof mutator !== 'function') return Promise.reject(new TypeError('A mutator is required'));
      const operation = tail.then(async () => {
        if (poisoned) throw poisoned;
        const draft = jsonClone(snapshot);
        const result = await mutator(draft);
        const next = jsonClone(result === undefined ? draft : result);
        try {
          await commit(next);
        } catch (error) {
          // A failed fsync/rename can have an unknown outcome. Do not keep writing.
          poisoned = error;
          throw error;
        }
        snapshot = next;
        return jsonClone(snapshot);
      });
      tail = operation.catch(() => {});
      return operation;
    },
    close() {
      if (!closePromise) {
        closed = true;
        closePromise = tail.then(release);
      }
      return closePromise;
    },
  };
}
