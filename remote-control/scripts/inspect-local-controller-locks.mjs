/** Targeted diagnostics; explicit --archive-orphans preserves only proven dead-owner lock files. Never settings, keys, bodies or session logs. */
import { readFile, lstat, realpath, rename } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
const args = process.argv.slice(2)
if (![2, 3].includes(args.length) || args[0] !== '--state-dir' || !path.isAbsolute(args[1] ?? '') || (args.length === 3 && args[2] !== '--archive-orphans')) throw new Error('Usage: inspect-local-controller-locks.mjs --state-dir ABSOLUTE_CONTROLLER_STATE_DIR [--archive-orphans]')
const root = path.resolve(args[1])
const normalized = value => path.resolve(value).toLowerCase()
if (normalized(await realpath(root)) !== normalized(root)) throw new Error('Unexpected state directory')
const alive = pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; return 'uncertain' } }
const locks = []
for (const name of ['federation.json.lock', 'endpoint.json.lock']) {
  const filename = path.join(root, name)
  try {
    const stat = await lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('Unexpected lock metadata file')
    const value = JSON.parse(await readFile(filename, 'utf8'))
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || value.pid <= 0) throw new Error('Invalid lock owner metadata')
    locks.push({ name, pid: value.pid, ownerAlive: alive(value.pid), modifiedUtc: stat.mtime.toISOString() })
  } catch (error) { if (error.code === 'ENOENT') locks.push({ name, missing: true }); else throw error }
}
const file = path.join(root, 'federation.json')
const stat = await lstat(file)
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('Unexpected journal file')
const data = JSON.parse(await readFile(file, 'utf8'))
if (data.version !== 2 || data.binding?.role !== 'controller' || !data.operations || Array.isArray(data.operations)) throw new Error('Unexpected Controller journal')
const creates = Object.values(data.operations).filter(row => row.action === 'session.create')
const metadata = creates.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 3).map(row => ({ requestId: row.requestId, state: row.state, createdAt: row.createdAt, updatedAt: row.updatedAt, hasCommittedResult: row.result !== undefined }))
const recover = args[2] === '--archive-orphans'
console.log(JSON.stringify({ readOnly: !recover, locks, createOperationCount: creates.length, recentCreateOperations: metadata }, null, 2))
if (recover) {
  if (args.length !== 3 || !locks.every(item => item.ownerAlive === false)) throw new Error('Only two proven dead-owner locks may be deliberately archived')
  const digest = value => createHash('sha256').update(value).digest('hex')
  const beforeJournal = digest(await readFile(file))
  for (const item of locks) {
    const source = path.resolve(root, item.name)
    if (path.dirname(source).toLowerCase() !== normalized(root)) throw new Error('Unexpected lock path')
    const currentStat = await lstat(source)
    const current = JSON.parse(await readFile(source, 'utf8'))
    if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.mtime.toISOString() !== item.modifiedUtc || current.pid !== item.pid || alive(current.pid) !== false) throw new Error('Lock ownership changed; refusing recovery')
    const destination = path.resolve(root, `${item.name}.orphan-owner-${item.pid}-${randomUUID()}`)
    if (path.dirname(destination).toLowerCase() !== normalized(root)) throw new Error('Unexpected archive target')
    console.log('Verified archive target: ' + destination)
    await rename(source, destination)
  }
  if (digest(await readFile(file)) !== beforeJournal) throw new Error('Journal changed concurrently; inspect before restarting bridge')
  console.log('Dead-owner locks archived; Controller journal bytes unchanged. No request replay or session creation performed.')
}
