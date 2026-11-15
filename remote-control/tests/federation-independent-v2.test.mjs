/** Independent task20: no production/old-test edits; real native oracle, not a substitute assembler.
 * Run from remote-control with bundled node --import ../dsh-remote-core/node_modules/tsx/dist/esm/index.mjs --test this file,
 * TSX_TSCONFIG_PATH = absolute ../dsh-remote-core/tsconfig.base.json. No fixtures are generated.
 * Contract tests are intentionally red for observed defects; do not turn them into expected failures.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from '../../dsh-remote-core/packages/core/session/src/index.ts'
import { SessionId } from '../../dsh-remote-core/packages/core/session/src/types.ts'
import { Session as ClientSession } from '../../dsh-remote-core/packages/api/session-controller/src/client/sessions/session.ts'
import { RemoteStream } from '../../dsh-remote-core/packages/api/gateway/src/client/remote-stream.ts'
import { createUserMessage, createAssistantMessage } from '../../dsh-remote-core/packages/llm/llm/src/message.ts'
import { assembleAssistantStream, expandAssistantStream } from '../../dsh-remote-core/packages/llm/llm/src/assistant-stream.ts'
import { assertSessionWireEvent } from '../../dsh-remote-core/packages/api/session-controller/src/client/session-wire-event.ts'
import { buildHistoryPage, projectEvent, parseHistoryPage, createHistorySnapshotFrame } from '../lib/federation/history.mjs'
import { createWireCodec } from '../lib/federation/wire-codec.mjs'
import { evaluateGrant, assertReviewedExportClasses } from '../lib/federation/grants.mjs'
import { buildSourceCatalog, encodeCatalogCursor, decodeCatalogCursor } from '../lib/federation/catalog.mjs'
import { createPeerRouter, authorizePeerAction, resolvePeer } from '../lib/federation/peers.mjs'
import { encodeSessionRef, decodeSessionRef } from '../lib/federation/identity.mjs'
import { encodeExportCursor, decodeExportCursor, jsonByteLength, createCapabilities, createResponse, createFrame, PROTOCOL_LIMITS } from '../lib/federation/protocol.mjs'

const principal = { kind: 'controller', id: 'independent-controller' }
const ref = { machineKey: 'independent-worker', projectId: 'project-a', sessionId: 'session-existing' }
const classes = ['conversation.user', 'conversation.assistant', 'turn']
const text = text => ({ type: 'text', text })
const raw = (time, chunk) => ({ type: 'chunk', time, chunk })
const run = (index, value, type = 'text-chunks') => ({ type, time0: 100, index, dt: [], texts: [value] })
const end = (index, block) => raw(102, { type: 'block-end', index, block })
const nativeAssistantBlocks = (stream, interrupted) => {
  const assembled = assembleAssistantStream(stream)
  return interrupted ? assembled.interruptedBlocks() : assembled.blocks()
}
const projection = event => projectEvent(event, { exportClasses: classes, nativeAssistantBlocks })
const human = (seq, body = 'human text', source = { kind: 'user' }) => ({ type: 'user/message', seq, time: 10 + seq, surfaceOp: 'append', data: createUserMessage({ content: [text(body)], source }) })
const assistant = (stream, interrupted = false) => ({ type: 'assistant/message', seq: 3, time: 103, surfaceOp: 'append', data: {
  turn: 1, step: 1, message: createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: nativeAssistantBlocks(stream, interrupted) }),
  stream, ...(interrupted ? { interrupted: true } : {}),
} })
const log = event => [
  { type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } }, human(1),
  { type: 'step/start', seq: 2, time: 12, data: { turn: 1, step: 1 } }, event,
  { type: 'step/end', seq: 4, time: 104, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 5, time: 105, data: { turn: 1, reason: { kind: 'completed' } } },
]
const grant = () => ({ version: 1, grantId: 'independent-grant', principal, machineKey: ref.machineKey, revision: 7, issuedAt: 0,
  projects: [{ projectId: ref.projectId, actions: ['project.list', 'session.list', 'model.list'], exportClasses: classes,
    sessions: [{ sessionId: ref.sessionId, imported: true, actions: ['session.read', 'session.follow', 'session.prompt', 'session.cancel', 'model.select'] }] }] })
const opts = { currentRevision: 7, now: 10 }
const read = extra => ({ principal, ...ref, action: 'session.read', exportClasses: classes, ...extra })
const validateNativeEvents = events => {
  Session.create(SessionId(ref.sessionId), events)
  for (const event of events) if (event.type === 'assistant/message') expandAssistantStream(event.data.stream)
}
const request = (events, extra = {}) => ({ ...ref, principal, grant: grant(), grantRevision: 7, generation: 2, now: 10,
  events, exportClasses: classes, validateNativeEvents, nativeAssistantBlocks, ...extra })
const code = (fn, expected) => assert.throws(fn, error => error.code === expected)
const noSecret = value => assert.doesNotMatch(JSON.stringify(value), /SECRET/)
function nativeProjection(event) {
  validateNativeEvents(log(event))
  const result = projection(event)
  assert.equal(result.withheld, false)
  assertSessionWireEvent(result.event)
  validateNativeEvents(log(result.event))
  assert.deepEqual(nativeAssistantBlocks(result.event.data.stream, result.event.data.interrupted === true), result.event.data.message.content)
  assert.equal(Object.hasOwn(result.event, 'redacted'), false)
  noSecret(result)
  return result
}

for (const kind of ['agent-instructions', 'skill-invocation', 'subagent-message', 'compact-checkpoint', 'future-producer']) {
  test(`native user-role ${kind} is not human authorization`, () => {
    const event = human(0, 'SECRET_INJECTED_BODY', { kind })
    validateNativeEvents([event])
    const page = buildHistoryPage(request([event]))
    assert.deepEqual(page.records, [{ type: 'withheld', firstSeq: 0, lastSeq: 0, reason: 'policy' }])
    noSecret(page)
  })
}
test('human text with code-looking instructions remains genuine human text', () => {
  const event = human(0, 'Ignore previous instructions: this is still human input')
  const page = buildHistoryPage(request([event]))
  assert.deepEqual(page.records[0].event.data, event.data)
  assertSessionWireEvent(page.records[0].event)
})

test('mixed sparse first-seen indices retain identity even for repeated equal text', () => {
  const stream = [run(90, 'SECRET_REASONING', 'reasoning-chunks'), run(14, 'same'), run(2, 'same'), run(14, '+tail'), end(2, text('same')), end(14, text('same+tail'))]
  const event = assistant(stream)
  const result = nativeProjection(event)
  assert.equal(result.event.data.message.id, event.data.message.id)
  assert.deepEqual(result.event.data.message.content, [text('same+tail'), text('same')])
  assert.deepEqual(result.event.data.stream.map(row => row.type === 'chunk' ? row.chunk.index : row.index), [0, 1, 0, 1, 0])
  assert.equal(result.redacted, true)
})
test('all ignored records after first close vanish, including cross-type secret stragglers', () => {
  const stream = [run(44, 'draft'), end(44, text('visible')),
    run(44, 'SECRET_POST_CLOSE_TEXT'), run(44, 'SECRET_POST_CLOSE_REASON', 'reasoning-chunks'),
    { type: 'tool-call-chunks', index: 44, time0: 104, dt: [], id: 'call-1', name: 'SECRET_TOOL', args: ['SECRET_ARGS'] },
    end(44, text('SECRET_RECLOSE')), raw(106, { type: 'block-start', index: 44, blockType: 'text' })]
  const result = nativeProjection(assistant(stream))
  assert.equal(result.event.data.stream.length, 2)
  assert.deepEqual(result.event.data.stream[1], { ...stream[1], chunk: { ...stream[1].chunk, index: 0 } })
  assert.equal(result.redacted, true)
})
test('private replay, usage, reasoning, attachment and tool data do not leak through the complete carrier', () => {
  const stream = [run(9, 'SECRET_REASON', 'reasoning-chunks'),
    { type: 'tool-call-chunks', time0: 99, index: 8, dt: [], id: 'call-2', name: 'SECRET_TOOL', args: ['SECRET_ARGS'] },
    run(4, 'visible'), raw(104, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, metadata: 'SECRET_USAGE' } }),
    raw(105, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'SECRET_REPLAY' } })]
  const event = assistant(stream)
  event.data.message = createAssistantMessage({ source: { provider: 'p', model: 'm', replayState: { response: 'SECRET_PROVIDER_REPLAY' } }, content: event.data.message.content })
  event.data.usage = { inputTokens: 1, outputTokens: 2 }
  const result = nativeProjection(event)
  assert.deepEqual(result.event.data.message.source, { kind: 'model', provider: 'p', model: 'm' })
  const page = buildHistoryPage(request(log(event)))
  const snapshot = createHistorySnapshotFrame({ page, header: { version: 1, id: ref.sessionId, createdAt: 1, isSeeded: false, cwd: 'SECRET_PATH' }, projections: { asOfSeq: 5, values: {} } })
  noSecret(snapshot)
})
test('native max-token and interrupted pruning do not confuse content offsets', () => {
  const stream = [{ type: 'tool-call-chunks', time0: 100, index: 99, dt: [], id: 'call-3', args: ['SECRET_ARGS'] }, run(3, '  '), run(20, 'kept'), raw(104, { type: 'finish', reason: { kind: 'max-tokens' } })]
  assert.deepEqual(nativeProjection(assistant(stream)).event.data.message.content, [text('  '), text('kept')])
  assert.deepEqual(nativeProjection(assistant(stream, true)).event.data.message.content, [text('kept')])
})
test('inconsistent durable message correspondence is withheld, never string-matched', () => {
  const event = assistant([run(20, 'same'), run(1, 'same')])
  event.data.message = createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [text('same')] })
  assert.equal(projection(event).withheld, true)
})
test('human attachment-only replacement removes old visible text without inventing native blocks', () => {
  const first = human(0, 'old text')
  const replacement = human(1)
  replacement.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 }
  replacement.sourceEventSeqs = [0]
  replacement.data = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'SECRET_IMAGE' } }] })
  validateNativeEvents([first, replacement])
  const result = projection(replacement)
  assert.equal(result.redacted, true)
  assert.deepEqual(result.event.data.content, [])
  assertSessionWireEvent(result.event)
  assert.deepEqual(Session.create(SessionId('projected'), [first, result.event]).surface.nodes, [1])
  noSecret(result)
})
test('policy-hidden replacement refuses the whole cut instead of preserving stale current text', () => {
  const replacement = human(1, 'SECRET_REPLACEMENT', { kind: 'compact-checkpoint' })
  replacement.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 }
  replacement.sourceEventSeqs = [0]
  code(() => buildHistoryPage(request([human(0), replacement])), 'export-policy-unsupported')
})
test('real retained Client Session clears a formerly visible cut on hidden-replacement export failure', { timeout: 5000 }, async () => {
  const first = human(0, 'previously visible text')
  const page = buildHistoryPage(request([first]))
  const frame = createWireCodec({ machineKey: ref.machineKey, scope: 'consumer-test' }).toWire('history-frame', createHistorySnapshotFrame({
    page, header: { version: 1, id: ref.sessionId, createdAt: 1, isSeeded: false }, projections: { asOfSeq: 0, values: {} },
  }))
  const failExport = Promise.withResolvers()
  const rootCalls = []
  const unused = name => { rootCalls.push(name); throw new Error('unexpected root call') }
  const remotes = {
    $stream: options => new RemoteStream({ generation: { getSnapshot: () => undefined, subscribe: () => () => {} } }, options),
    commands: { execute: () => unused('execute') }, session: new Proxy({}, { get: (_object, name) => () => unused(name) }),
    subagents: { prompt: () => unused('subagent'), interruptByParent: () => unused('interrupt') },
  }
  const history = {
    page: () => unused('page'),
    follow: (_request, signal) => (async function* () {
      yield frame
      await failExport.promise
      signal.throwIfAborted()
      const replacement = human(1, 'SECRET_HIDDEN', { kind: 'compact-checkpoint' })
      replacement.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 }
      replacement.sourceEventSeqs = [0]
      // The actual exporter throws its typed refusal; no synthetic malformed frame.
      buildHistoryPage(request([first, replacement]))
    })(),
  }
  const session = new ClientSession(ref.sessionId, remotes, { wireId: ref.sessionId, sourceHistory: history, includeAssistantStream: false })
  let unsubscribe = () => {}
  try {
    await session.open()
    assert.equal(session.eventSource.getSnapshot().entries.length, 1)
    const cleared = Promise.withResolvers()
    unsubscribe = session.eventSource.subscribe(() => {
      if (session.eventSource.getSnapshot().entries.length === 0) cleared.resolve()
    })
    failExport.resolve()
    await cleared.promise
    assert.deepEqual(session.eventSource.getSnapshot().entries, [])
    assert.equal(session.getSnapshot().withheld, undefined)
    assert.deepEqual(rootCalls, [])
  } finally { failExport.resolve(); unsubscribe(); await session.dispose() }
})
test('complete UTF-8 page budget is exact and oversized single native message is explicit failure', () => {
  const events = [human(0, '😀'.repeat(200))]
  const page = buildHistoryPage(request(events))
  assert.deepEqual(buildHistoryPage(request(events, { maxBytes: jsonByteLength(page) })), page)
  code(() => buildHistoryPage(request(events, { maxBytes: jsonByteLength(page) - 1 })), 'page-too-large')
  code(() => buildHistoryPage(request([human(0, '😀'.repeat(10_000))])), 'page-too-large')
})
test('all-withheld backward pages advance coverage without moving follow after-position', () => {
  const events = [human(0), human(1, 'SECRET', { kind: 'skill-invocation' }), human(2, 'SECRET', { kind: 'agent-instructions' })]
  const latest = buildHistoryPage(request(events, { maxMessages: 1 }))
  const older = buildHistoryPage(request(events, { beforeSeq: latest.coveredFromSeq, maxMessages: 1 }))
  assert.equal(latest.coveredFromSeq, 2)
  assert.equal(older.coveredFromSeq, 1)
  assert.equal(older.exportCursor, latest.exportCursor)
  assert.equal(decodeExportCursor(older.exportCursor).beforeSeq, 3)
  assert.deepEqual(parseHistoryPage(older, { ...ref, generation: 2, grantRevision: 7 }), older)
  code(() => parseHistoryPage({ ...older, records: [...older.records, ...older.records] }), 'history-gap')
  code(() => parseHistoryPage({ ...older, generation: 3 }), 'cursor-stale')
})
test('cursor binding rejects changed machine/project/session/generation/revision and alternate JSON spellings', () => {
  const value = { ...ref, generation: 2, grantRevision: 7, throughSeq: 3, beforeSeq: 4 }
  const token = encodeExportCursor(value)
  for (const key of ['machineKey', 'projectId', 'sessionId']) code(() => decodeExportCursor(token, { ...value, [key]: 'other' }), 'cursor-stale')
  for (const key of ['generation', 'grantRevision']) code(() => decodeExportCursor(token, { ...value, [key]: 8 }), 'cursor-stale')
  const body = Buffer.from(token.slice(5), 'base64url').toString('utf8')
  code(() => decodeExportCursor('fec1.' + Buffer.from(body.replaceAll(',', ', ')).toString('base64url')), 'invalid-message')
  const catalog = encodeCatalogCursor({ machineKey: ref.machineKey, generation: 2, grantRevision: 7, offset: 0 })
  code(() => decodeCatalogCursor(catalog, { machineKey: ref.machineKey, generation: 3, grantRevision: 7 }), 'catalog-stale')
})
test('scoped codec canonicality rejects -0, UTF-8 aliases, coerced numeric strings and authority reincarnation', () => {
  const codec = createWireCodec({ machineKey: ref.machineKey, scope: 'registration-1' })
  const token = codec.encodeGeneration(2)
  for (const value of [-0, '2', true, 1.5, Number.MAX_SAFE_INTEGER + 1]) code(() => codec.encodeGeneration(value), 'wire-codec/invalid')
  const encode = text => 'feg1.' + Buffer.from(text).toString('base64url')
  for (const body of [`["${ref.machineKey}","registration-1",-0]`, `["${ref.machineKey}", "registration-1",2]`, `["${ref.machineKey}","registration-1",2e0]`]) code(() => codec.decodeGeneration(encode(body)), 'wire-codec/invalid')
  code(() => codec.decodeGeneration(token.replace('feg1.', 'fgr1.')), 'wire-codec/invalid')
  code(() => createWireCodec({ machineKey: ref.machineKey, scope: 'registration-2' }).decodeGeneration(token), 'wire-codec/invalid')
  code(() => createWireCodec({ machineKey: 'other-worker', scope: 'registration-1' }).decodeGeneration(token), 'wire-codec/invalid')
  const badUtf8 = Buffer.concat([Buffer.from(`[\"${ref.machineKey}\",\"registration-1`), Buffer.from([0xc0, 0xaf]), Buffer.from('\",2]')])
  code(() => codec.decodeGeneration('feg1.' + badUtf8.toString('base64url')), 'wire-codec/invalid')
  code(() => codec.decodeGeneration('feg1.' + 'A'.repeat(2048)), 'wire-codec/invalid')
  assert.equal(codec.decodeGeneration(token), 2)
  const page = buildHistoryPage(request([human(0)]))
  assert.deepEqual(codec.fromWire('history-page', codec.toWire('history-page', page)), page)
  assert.equal(codec.toWire('history-page', page).exportCursor, page.exportCursor)
})
test('compound identity does not alias across projects or machines', () => {
  const refs = [ref, { ...ref, machineKey: 'other-worker' }, { ...ref, projectId: 'project-b' }]
  assert.equal(new Set(refs.map(encodeSessionRef)).size, 3)
  for (const value of refs) assert.deepEqual(decodeSessionRef(encodeSessionRef(value)), value)
})
test('grant isolation denies mismatched principal/project/session/revision before native validator', () => {
  for (const extra of [{ principal: { kind: 'controller', id: 'other-controller' } }, { projectId: 'project-b' }, { sessionId: 'other-session' }, { grantRevision: 8 }]) {
    let calls = 0
    code(() => buildHistoryPage(request([human(0)], { ...extra, validateNativeEvents: () => { calls++ } })), 'not-granted')
    assert.equal(calls, 0)
  }
})
test('old independent assertions are obsolete: serializer overrides and unproved imported:false both refuse', () => {
  code(() => assertReviewedExportClasses(['reasoning'], ['reasoning']), 'grant/invalid-options')
  const document = grant()
  document.projects[0].sessions[0].imported = false
  assert.equal(evaluateGrant(document, read(), opts).allowed, false)
})
test('created session template cannot adopt foreign ownership or override explicit empty rights', () => {
  const document = grant()
  document.projects[0].actions.push('session.create')
  document.projects[0].createdSessionGrant = { actions: ['session.read'], exportClasses: classes }
  document.projects[0].sessions = []
  const owned = { principal, ...ref, createRequestId: 'created-request-1', state: 'committed' }
  assert.equal(evaluateGrant(document, read(), { ...opts, remoteOwnedSessions: [owned] }).allowed, true)
  for (const extra of [{ principal: { kind: 'controller', id: 'other' } }, { projectId: 'project-b' }, { machineKey: 'other-worker' }, { sessionId: 'other-session' }]) {
    assert.equal(evaluateGrant(document, read(), { ...opts, remoteOwnedSessions: [{ ...owned, ...extra }] }).allowed, false)
  }
  document.projects[0].sessions = [{ sessionId: ref.sessionId, imported: false, actions: [], exportClasses: [] }]
  assert.equal(evaluateGrant(document, read(), { ...opts, remoteOwnedSessions: [owned] }).allowed, false)
  document.projects[0].sessions = []
  delete document.projects[0].createdSessionGrant
  assert.equal(evaluateGrant(document, read(), { ...opts, remoteOwnedSessions: [owned] }).allowed, false)
})
test('peer routing never falls back and follow requires both read and follow', () => {
  const router = createPeerRouter([{ machineKey: ref.machineKey, stateDir: 'state-a', protocol: 2, capabilities: createCapabilities({ history: true }) }])
  code(() => resolvePeer(router, 'unknown-worker'), 'source-unavailable')
  const document = grant()
  document.projects[0].sessions[0].actions = ['session.follow']
  code(() => authorizePeerAction({ router, grants: [document], ...read({ action: 'session.follow' }), grantRevision: 7, now: 10 }), 'not-granted')
})

// Explicit contract failures below refer to the observed catalog checkpoint, not final task16 acceptance.
const catalogRequest = document => ({ machineKey: ref.machineKey, generation: 2, grantRevision: 7, principal, grant: document, now: 10,
  projects: [{ projectId: ref.projectId }], sessions: [{ sessionId: ref.sessionId, projectId: ref.projectId, updatedAt: 1, running: true, blank: false }] })
test('B2 catalog does not disclose lifecycle flags without session.status (WIP checkpoint regression)', () => {
  const page = buildSourceCatalog(catalogRequest(grant()))
  assert.equal(page.sessions.length, 1)
  assert.equal(Object.hasOwn(page.sessions[0], 'running'), false)
  assert.equal(Object.hasOwn(page.sessions[0], 'blank'), false)
})
test('B2 canCreate is false when created template lacks all ordinary create/open follow-up rights (WIP checkpoint)', () => {
  const document = grant()
  document.projects[0].actions.push('session.create')
  document.projects[0].createdSessionGrant = { actions: [], exportClasses: [] }
  assert.equal(buildSourceCatalog(catalogRequest(document)).projects[0].canCreate, false)
})
test('near-limit complete page still requires snapshot-frame headroom (known transport gap)', () => {
  // Measure with the same deterministic message id; UUID builders otherwise vary only bytes, not length.
  const event = human(0, '')
  const overhead = jsonByteLength(buildHistoryPage(request([event])))
  event.data = { ...event.data, content: [text('x'.repeat(PROTOCOL_LIMITS.maxPageBytes - overhead - 16))] }
  const page = buildHistoryPage(request([event]))
  assert.ok(jsonByteLength(page) <= PROTOCOL_LIMITS.maxPageBytes)
  const snapshot = createHistorySnapshotFrame({ page, header: { version: 1, id: ref.sessionId, createdAt: 1, isSeeded: false }, projections: { asOfSeq: 0, values: {} } })
  assert.ok(jsonByteLength(snapshot) > PROTOCOL_LIMITS.maxFrameBytes)
  code(() => createFrame({ requestId: 'follow-request', op: 'session.follow', index: 0, frame: snapshot }), 'page-too-large')
})
test('transport explicitly refuses oversized result instead of truncating native message', () => {
  code(() => createResponse({ requestId: 'response-request', op: 'session.read', result: { text: 'x'.repeat(PROTOCOL_LIMITS.maxPayloadBytes) } }), 'page-too-large')
})
