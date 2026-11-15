#!/usr/bin/env node
/** Read-only comparison of staged repair metadata; never prints patch/config values or opens journal locks. */
import path from 'node:path'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const sha = x => createHash('sha256').update(x).digest('hex')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const stage = path.resolve(process.argv[2])
const receipt = JSON.parse(await readFile(path.join(stage, 'receipt.json'), 'utf8'))
if (process.env.ELECTRON_RUN_AS_NODE !== '1' || (await realpath(process.execPath)).toLowerCase() !== receipt.exe.toLowerCase()) throw new Error('Use the actual installed signed Desktop Node carrier')
const anchor = path.join(path.dirname(receipt.exe), 'resources', 'app.asar', 'dsh', 'package.json')
const req = createRequire(anchor)
const boot = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-app-boot')).href)
const manifest = boot.readProfileManifest('dsh', receipt.profile)
const bundles = manifest.dsh.profile.bundles
const bundlePatches = []
for (const name of bundles) {
  const dir = boot.resolveBundleDir('dsh', name, anchor, receipt.profile)
  const meta = boot.readProfileManifest('dsh', dir)
  const files = boot.bundlePatchPaths(dir, meta.dsh.bundle)
  const hashes = await Promise.all(files.map(async f => sha(await readFile(f))))
  const expected = receipt.patchHashes.find(([n]) => n === name)?.[1]
  bundlePatches.push({ name, matches: same(hashes, expected), patchCount: hashes.length, expectedCount: expected?.length })
}
const patchPath = path.join(receipt.profile, boot.PROFILE_PATCH_FILENAME)
let userPatch = { file: boot.PROFILE_PATCH_FILENAME, exists: false, matches: receipt.userHash === null }
try {
  const bytes = await readFile(patchPath)
  const stat = await lstat(patchPath)
  const patches = boot.loadOptionalPatches('dsh', patchPath) ?? []
  userPatch = { file: boot.PROFILE_PATCH_FILENAME, exists: true, matches: sha(bytes) === receipt.userHash, size: bytes.length, modifiedAt: stat.mtime.toISOString(), topLevelPatchKeys: patches.map(p => Object.keys(p).sort()) }
} catch (error) { if (error.code !== 'ENOENT') throw error }
console.log(JSON.stringify({ selectionMatches: same(bundles, receipt.selection), bundlePatches, userPatch }, null, 2))
