#!/usr/bin/env node
/** User-only read-only diagnostic of one explicitly selected federation journal; never opens a store/lock, queries an app, or replays an operation. */
import { readFile, lstat } from 'node:fs/promises'
import path from 'node:path'
const states = new Set(['intent', 'dispatched', 'unknown', 'failed', 'committed'])
const codes = new Set(['outcome-unknown', 'selection-conflict', 'action-unsupported', 'source-unavailable', 'grant-changed', 'not-granted', 'invalid-message', 'request-conflict', 'session/source-unavailable', 'session/selection-conflict', 'session/outcome-unknown', 'session/model-unavailable', 'session/model-selection-unavailable'])
const textId = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value) ? value : '[unsupported-id-format]'
const integer = value => Number.isSafeInteger(value) && value >= 0
const timestamp = value => integer(value) ? value : typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined
async function main() {
  const args = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const name = process.argv[i]
    if (!['--journal', '--request-id'].includes(name) || Object.hasOwn(args, name) || !process.argv[i + 1]) throw new Error('Arguments')
    args[name] = process.argv[i + 1]
  }
  if (!args['--journal'] || !path.isAbsolute(args['--journal'])) throw new Error('Explicit file required')
  const stat = await lstat(args['--journal'])
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024) throw new Error('Unsafe or oversized input')
  const state = JSON.parse((await readFile(args['--journal'], 'utf8')).replace(/^\uFEFF/, ''))
  if (state.version !== 2 || !state.operations || typeof state.operations !== 'object' || Array.isArray(state.operations)) throw new Error('Not federation journal')
  const matches = Object.values(state.operations).filter(row => row?.action === 'session.create' && (args['--request-id'] ? row.requestId === args['--request-id'] : row.state !== 'committed'))
  if (matches.length > 32) throw new Error('Select exact request ID')
  const report = matches.map(row => {
    const proof = row.nativeCreatedProof, owned = state.remoteOwnedSessions?.[row.reservedSessionId]
    return {
      requestId: textId(row.requestId), state: states.has(row.state) ? row.state : 'unrecognized',
      timestampsIfRecorded: Object.fromEntries(['createdAt', 'updatedAt', 'dispatchedAt', 'completedAt'].flatMap(name => timestamp(row[name]) === undefined ? [] : [[name, timestamp(row[name])]])),
      failureCode: row.code === undefined ? 'not-recorded' : codes.has(row.code) ? row.code : 'unrecognized-code-not-exported',
      reservedSessionId: row.reservedSessionId === undefined ? 'not-recorded' : textId(row.reservedSessionId),
      nativeCreationProof: { present: proof !== undefined, matchesReservedId: proof !== undefined && proof.sessionId === row.reservedSessionId, validCreatedAt: integer(proof?.createdAt), ...(integer(proof?.createdAt) ? { createdAt: proof.createdAt } : {}), validFrontier: Number.isSafeInteger(proof?.frontierSeq) && proof.frontierSeq >= -1 },
      committedOwnership: { present: owned !== undefined, committed: owned?.state === 'committed', requestMatches: owned !== undefined && owned.createRequestId === row.requestId },
      nativeErrorCode: row.diagnostic?.nativeCode === undefined ? 'not-recorded-by-this-version' : codes.has(row.diagnostic.nativeCode) ? row.diagnostic.nativeCode : 'unrecognized-code-not-exported',
      adapterStage: typeof row.diagnostic?.stage === 'string' && ['native-create-call', 'native-setup-entered', 'initial-route-recorded', 'sandbox-flush-confirmed', 'native-proof-recorded', 'native-helper-returned'].includes(row.diagnostic.stage) ? row.diagnostic.stage : 'not-recorded-by-this-version',
      flushParticipation: proof?.sessionId === row.reservedSessionId ? 'adapter native-create proof callback occurs AFTER its true native sandbox flush; publication/final ownership not implied' : 'not-recorded; absence of proof DOES NOT prove flush failure',
    }
  })
  console.log(JSON.stringify({ format: 'safe-session-create-diagnostic-v1', journalRole: ['controller', 'worker'].includes(state.binding?.role) ? state.binding.role : 'unrecognized', reservedIdMeaning: state.binding?.role === 'worker' ? 'actual Worker reservation' : 'Controller-local bookkeeping only; NOT the native Worker reservation', readOnly: true, matchedOperations: report.length, operations: report, limits: 'No settings, credentials, bodies, grants, model routes, messages, sessions inventory or logs exported. Missing evidence is not inferred. Do NOT create a new request ID or remove a lock.' }, null, 2))
}
main().catch(() => { console.error('DIAGNOSTIC_STOPPED: select an explicit regular federation.json and optional exact request ID. Nothing was written, unlocked, queried or replayed. No input values are printed.'); process.exitCode = 1 })
