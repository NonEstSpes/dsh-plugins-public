#!/usr/bin/env node
/** Explicit local owner maintenance only. Plan is read-only; apply changes one journal disposition, never native work or original outcome. */
import path from 'node:path'
import { readFile, lstat, realpath } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { planUnknownCreateAcknowledgement, acknowledgeUnknownCreate } from '../lib/federation/journal.mjs'
const key = value => path.resolve(value).toLowerCase()
function stop() { throw new Error('Owner acknowledgement refused') }
function ps(script) { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); " + script], { encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }).trim() }
function processes() { const rows = JSON.parse(ps('@(Get-CimInstance Win32_Process | Select-Object ProcessId,Name,ExecutablePath,@{n="Created";e={if ($_.CreationDate) {$_.CreationDate.ToUniversalTime().ToString("o")} else {""}}}) | ConvertTo-Json -Compress') || '[]'); return (Array.isArray(rows) ? rows : [rows]).filter(row => row.ProcessId !== process.pid) }
function owned(rows, exe, home) { const roots = [path.join(path.dirname(exe), 'resources', 'runtime'), path.join(home, 'dsh-runtimes')].map(root => key(root) + path.sep); return rows.filter(row => String(row.Name).toLowerCase() === path.basename(exe).toLowerCase() || (row.ExecutablePath && (key(row.ExecutablePath) === key(exe) || (path.basename(row.ExecutablePath).toLowerCase() === 'node.exe' && roots.some(root => key(row.ExecutablePath).startsWith(root)))))) }
function origin(value) { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.pathname !== '/' || url.username || url.password || url.search || url.hash) stop(); return url }
async function closed(plan) {
  const rows = processes()
  if (owned(rows, plan.exe, plan.home).length || plan.processes.some(old => rows.some(row => row.ProcessId === old.ProcessId && (!row.Created || row.Created === old.Created)))) stop()
  try { await fetch(origin(plan.origin), { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2500) }); stop() } catch (error) { if (error.cause?.code !== 'ECONNREFUSED') stop() }
}
async function readJson(filename) { if (!path.isAbsolute(filename)) stop(); const info = await lstat(filename); if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) stop(); return JSON.parse((await readFile(filename, 'utf8')).replace(/^\uFEFF/, '')) }
async function main(argv) {
  const mode = argv.shift(), args = {}, flags = new Set(['app-closed'])
  for (let i = 0; i < argv.length; i++) { const name = argv[i].slice(2); if (!argv[i].startsWith('--') || Object.hasOwn(args, name) || !['journal', 'request-id', 'machine', 'project', 'origin', 'home', 'desktop-exe', 'plan-file', 'app-closed', 'confirm-request-id'].includes(name)) stop(); if (flags.has(name)) args[name] = true; else { if (!argv[i + 1]) stop(); args[name] = argv[++i] } }
  if (!['plan', 'apply'].includes(mode) || process.platform !== 'win32' || process.env.ELECTRON_RUN_AS_NODE !== '1') stop()
  const exe = await realpath(args['desktop-exe'])
  if (key(exe) !== key(process.execPath) || ps(`(Get-AuthenticodeSignature -LiteralPath '${exe.replaceAll("'", "''")}').Status.ToString()`) !== 'Valid') stop()
  if (mode === 'plan') {
    if (args['app-closed'] || args['confirm-request-id'] || args['plan-file'] || !path.isAbsolute(args.home || '')) stop()
    origin(args.origin)
    const filename = await realpath(args.journal)
    const expected = planUnknownCreateAcknowledgement(await readJson(filename), { requestId: args['request-id'], machineKey: args.machine, projectId: args.project })
    console.log(JSON.stringify({ version: 1, journalFile: filename, expected, exe, home: await realpath(args.home), origin: args.origin, processes: owned(processes(), exe, args.home), meaning: 'Owner abandons only future replay of THIS create; original outcome remains unknown. Native identity, proof and ownership are NOT adopted. BOTH Controller and Worker need separate local acknowledgement before a separate explicit fresh create.' }, null, 2))
    return
  }
  if (!args['app-closed'] || !args['plan-file'] || args.journal || args['request-id'] || args.machine || args.project || args.origin || args.home) stop()
  const plan = await readJson(args['plan-file'])
  if (plan.version !== 1 || key(plan.exe) !== key(exe) || plan.expected?.version !== 1 || !Array.isArray(plan.processes) || args['confirm-request-id'] !== plan.expected.requestId) stop()
  await closed(plan)
  await acknowledgeUnknownCreate(plan.journalFile, plan.expected, Date.now(), async () => closed(plan))
  console.log('OWNER_ACK_RECORDED: only ownerDisposition added; original create remains UNKNOWN and old ID is permanently non-replayable. No native operation, adoption, ownership, journal reset or new ID was performed. Acknowledge the OTHER endpoint locally too before a separately approved fresh create.')
}
main(process.argv.slice(2)).catch(() => { console.error('OWNER_ACK_STOPPED: if apply began, the write outcome may be UNKNOWN after a durability/close error. Inspect the exact local ownerDisposition before any retry; never clear locks or retry blindly. Check plan/CAS, proof/result/ownership absence and actual offline gates. Plan itself is read-only; no raw payload/error is printed.'); process.exitCode = 1 })
