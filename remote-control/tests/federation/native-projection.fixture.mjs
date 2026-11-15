// Source-plane fixture: bundled Node + tsx/esm + TSX_TSCONFIG_PATH; no build/install or file generation.
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Session } from '../../../dsh-remote-core/packages/core/session/src/index.ts'
import { SessionId } from '../../../dsh-remote-core/packages/core/session/src/types.ts'
import { createUserMessage, createAssistantMessage, freezeMessage } from '../../../dsh-remote-core/packages/llm/llm/src/message.ts'
import { AssistantStreamAccumulator, expandAssistantStream, assembleAssistantStream } from '../../../dsh-remote-core/packages/llm/llm/src/assistant-stream.ts'
import { assertSessionWireEvent } from '../../../dsh-remote-core/packages/api/session-controller/src/client/session-wire-event.ts'
import { ConversationNodeAssembler } from '../../../dsh-remote-core/packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { assistantDefinition } from '../../../dsh-remote-core/packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { messageDefinition } from '../../../dsh-remote-core/packages/client/ui-chat/src/client/conversation-nodes/message.ts'
import { buildHistoryPage, projectEvent, parseHistoryPage } from '../../lib/federation/history.mjs'

const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']
const nativeAssistantBlocks = (stream, interrupted) => { const result = assembleAssistantStream(stream); return interrupted ? result.interruptedBlocks() : result.blocks() }
const options = { exportClasses: classes, nativeAssistantBlocks }
const source = { provider: 'fixture-provider', model: 'fixture-model' }
const image = { type: 'image', attachment: { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: 'SECRET_IMAGE' } }
const text = value => ({ type: 'text', text: value })
const raw = (time, chunk) => ({ type: 'chunk', time, chunk })
const run = (index, value, type = 'text-chunks') => ({ type, time0: 101, index, dt: [], texts: [value] })
const boundary = (type, seq, data) => ({ type, seq, time: 100 + seq, data })
const human = (id, content, messageSource = { kind: 'user' }) => freezeMessage({ ...createUserMessage({ source: messageSource, content }), id })
const message = (stream, interrupted = false, id = 'fixture-assistant', extraSource = {}) => freezeMessage({ ...createAssistantMessage({ source: { ...source, ...extraSource }, content: nativeAssistantBlocks(stream, interrupted) }), id })
const assistantEvent = (stream, interrupted = false, extra = {}) => ({ type: 'assistant/message', seq: 3, time: 110, surfaceOp: 'append', data: { turn: 1, step: 1, message: message(stream, interrupted), stream, ...(interrupted ? { interrupted: true } : {}), ...extra } })
const logFor = assistant => [boundary('turn/start', 0, { turn: 1 }), { type: 'user/message', seq: 1, time: 101, surfaceOp: 'append', data: human('fixture-human', [text('Federated human question')]) }, boundary('step/start', 2, { turn: 1, step: 1 }), assistant, boundary('step/end', 4, { turn: 1, step: 1 }), boundary('turn/end', 5, { turn: 1, reason: { kind: 'completed' } })]

function assertProjection(event, expectedTexts, { redacted = true } = {}) {
  Session.create(SessionId('session-original'), logFor(event))
  expandAssistantStream(event.data.stream)
  const result = projectEvent(event, options)
  assert.equal(result.withheld, false)
  assert.deepEqual(result.event.data.message.content, expectedTexts.map(text))
  assert.equal(result.redacted === true, redacted)
  assertSessionWireEvent(result.event)
  Session.create(SessionId('session-projected'), logFor(result.event))
  expandAssistantStream(result.event.data.stream)
  assert.deepEqual(nativeAssistantBlocks(result.event.data.stream, event.data.interrupted === true), result.event.data.message.content)
  assert.equal(Object.hasOwn(result.event, 'redacted'), false)
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
  return result
}

// Native first-seen ordering, sparse/out-of-order indices, duplicate text values.
const sparse = [run(42, 'SECRET_REASONING', 'reasoning-chunks'), run(9, 'same'), run(1, 'same')]
const sparseResult = assertProjection(assistantEvent(sparse), ['same', 'same'])
assert.deepEqual(sparseResult.event.data.stream.map(row => row.index), [0, 1])
assert.deepEqual(sparseResult.event.data.stream.map(row => row.time0), [101, 101])

// Authoritative block-end can differ from deltas; keep genuine deltas and final close.
const authoritative = [raw(100, { type: 'block-start', index: 8, blockType: 'text' }), run(8, 'draft'), raw(103, { type: 'block-end', index: 8, block: text('final') }), run(8, 'SECRET_IGNORED_DELTA'), raw(104, { type: 'block-end', index: 8, block: text('SECRET_IGNORED_RECLOSE') })]
const authoritativeResult = assertProjection(assistantEvent(authoritative), ['final'])
assert.deepEqual(authoritativeResult.event.data.stream[1].texts, ['draft'])
assert.equal(authoritativeResult.event.data.stream.length, 3)
assert.equal(authoritativeResult.event.data.stream[2].time, 103)
assert.equal(JSON.stringify(authoritativeResult).includes('SECRET_IGNORED'), false)
assert.equal(authoritativeResult.event.data.stream[2].chunk.block.text, 'final')

// Genuine delta-only stream, no fabricated starts/ends, unchanged dense text bytewise.
const dense = [run(0, 'first'), { type: 'text-chunks', index: 1, time0: 104, dt: [2, -1], texts: ['sec', 'on', 'd'] }]
const denseResult = assertProjection(assistantEvent(dense), ['first', 'second'], { redacted: false })
assert.deepEqual(denseResult.event.data.stream, dense)

// Max-token settlement removes unfinished tool calls before final content positions are assigned.
const maxTokens = [{ type: 'tool-call-chunks', time0: 100, index: 9, dt: [], id: 'call-real', name: 'SECRET_TOOL', args: ['SECRET_ARGS'] }, run(2, 'kept max tokens'), raw(110, { type: 'finish', reason: { kind: 'max-tokens' }, replayState: { response: 'SECRET_REPLAY' } })]
assertProjection(assistantEvent(maxTokens), ['kept max tokens'])

// Interrupted native settlement drops whitespace text and tools, not merely non-text positions.
const interrupted = [run(7, '  '), run(9, 'SECRET_REASONING', 'reasoning-chunks'), { type: 'tool-call-chunks', time0: 103, index: 8, dt: [], id: 'call-real', args: ['SECRET_TOOL'] }, run(3, 'kept interrupted')]
const interruptedResult = assertProjection(assistantEvent(interrupted, true), ['kept interrupted'])
assert.equal(interruptedResult.event.data.interrupted, true)
assert.deepEqual(interruptedResult.event.data.stream.map(row => row.index), [0])

// Attachment block and unknown replay/usage data never escape the complete carrier result.
const attachments = [raw(100, { type: 'block-start', index: 5, blockType: 'image' }), raw(101, { type: 'block-end', index: 5, block: image }), run(1, 'kept attachment sibling'), raw(103, { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, hidden: 'SECRET_USAGE' } }), raw(104, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'SECRET_STREAM_REPLAY' } })]
const attachmentEvent = assistantEvent(attachments, false, { usage: { inputTokens: 1, outputTokens: 1 } })
attachmentEvent.data.message = message(attachments, false, 'fixture-assistant', { replayState: { response: 'SECRET_SOURCE_REPLAY' } })
assertProjection(attachmentEvent, ['kept attachment sibling'])

// All permitted content removed: empty genuine filtered subset plus carrier marker.
assertProjection(assistantEvent([run(4, 'SECRET_ONLY_REASONING', 'reasoning-chunks')]), [])
const empty = assistantEvent([])
assertProjection(empty, [], { redacted: false })

// Unknown block/stream or mismatched durable final content is explicitly reduced, never guessed.
const mismatch = assistantEvent([run(0, 'one')])
mismatch.data.message = freezeMessage({ ...mismatch.data.message, content: [text('different')] })
assert.equal(projectEvent(mismatch, options).withheld, true)
const unknown = assistantEvent([raw(101, { type: 'block-end', index: 0, block: { type: 'unknown-future', value: 'SECRET_UNKNOWN' } })])
assert.equal(projectEvent(unknown, options).withheld, true)
assert.throws(() => projectEvent(assistantEvent(dense), { exportClasses: classes }), error => error.code === 'export-policy-unsupported')

// Real compact accumulator builds the canonical shared fixture, with interleaved restricted data.
const accumulator = new AssistantStreamAccumulator()
for (const [time, chunk] of [
  [103, { type: 'reasoning-delta', index: 9, text: 'SECRET_REASONING' }],
  [104, { type: 'block-start', index: 4, blockType: 'text' }],
  [105, { type: 'text-delta', index: 4, text: 'Federated assistant ' }],
  [106, { type: 'text-delta', index: 4, text: 'answer' }],
  [107, { type: 'block-end', index: 4, block: text('Federated assistant answer') }],
  [108, { type: 'usage', usage: { inputTokens: 2, outputTokens: 4 } }],
  [109, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'SECRET_REPLAY' } }],
]) accumulator.push({ time, chunk })
const original = logFor(assistantEvent([...accumulator.snapshot()]))
original[1] = { ...original[1], data: human('fixture-human', [text('Federated human question'), image]) }
original[4].time = 111
original[5].time = 112
original.push({ type: 'user/message', seq: 6, time: 113, surfaceOp: 'append', data: human('fixture-injected', [text('SECRET_INSTRUCTIONS')], { kind: 'skill-invocation', name: 'SECRET_SKILL' }) })
const principal = { kind: 'controller', id: 'fixture-controller' }
const sessionId = 'session-fixture'
const grant = { version: 1, grantId: 'grant_fixture', principal, machineKey: 'fixture-worker', revision: 1, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list'], exportClasses: classes, sessions: [{ sessionId, imported: true, actions: ['session.read', 'session.follow'] }] }] }
const validateNativeEvents = log => { Session.create(SessionId(sessionId), log); for (const entry of log) if (entry.type === 'assistant/message') expandAssistantStream(entry.data.stream) }
const request = { machineKey: 'fixture-worker', projectId: 'demo', sessionId, generation: 1, grantRevision: 1, principal, grant, now: 1, events: original, exportClasses: classes, validateNativeEvents, nativeAssistantBlocks }
const page = buildHistoryPage(request)
const fixture = JSON.parse(await readFile(new URL('./native-projection.json', import.meta.url), 'utf8'))
assert.deepEqual(page, fixture.page)
assert.deepEqual(parseHistoryPage(page), page)
for (const record of page.records) if (record.type === 'event') assertSessionWireEvent(record.event)
assert.equal(JSON.stringify(page).includes('SECRET'), false)
// Later partial-only input and wholly withheld coverage keep their distinct seq accounting.
const appendedOriginal = [...original, { type: 'user/message', seq: 7, time: 114, surfaceOp: 'append', data: human('fixture-followup', [text('Federated appended text'), image]) }, { type: 'user/message', seq: 8, time: 115, surfaceOp: 'append', data: human('fixture-injected-late', [text('SECRET_LATE')], { kind: 'skill-invocation' }) }]
const later = buildHistoryPage({ ...request, events: appendedOriginal, maxMessages: 2 })
assert.deepEqual(later.records, fixture.append.records)
assert.equal(later.exportCursor, fixture.append.exportCursor)

// A genuine replacement removing every old visible block preserves its operation and marker.
const first = { type: 'user/message', seq: 0, time: 1, surfaceOp: 'append', data: human('replace-first', [text('old text')]) }
const replace = { type: 'user/message', seq: 1, time: 2, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 }, sourceEventSeqs: [0], data: human('replace-next', [image]) }
Session.create(SessionId('session-replace-native'), [first, replace])
const projectedReplace = projectEvent(replace, options)
assert.equal(projectedReplace.redacted, true)
assert.deepEqual(projectedReplace.event.data.content, [])
assert.deepEqual(projectedReplace.event.surfaceOp, replace.surfaceOp)
const projectedSession = Session.create(SessionId('session-replace-export'), [first, projectedReplace.event])
assert.deepEqual(projectedSession.surface.nodes, [1])
assert.equal(JSON.stringify(projectedReplace).includes('old text'), false)

// Actual native ordinary chat view receives only permitted events, never carrier metadata.
const definitions = [messageDefinition, assistantDefinition]
const assembler = new ConversationNodeAssembler({ entries: () => definitions, fallbackEntry: () => undefined }, { entries: () => [{ target: 'chat', create: () => ({ empty: [], replace: ({ nodes }) => nodes, apply: ({ upserts }) => upserts }) }] })
assembler.activateTarget('chat')
assembler.replaceWindow(page.records.filter(row => row.type === 'event').map(row => ({ kind: 'event', event: row.event })), false)
assembler.flush()
const rendered = JSON.stringify(assembler.snapshot('chat'))
assert.match(rendered, /Federated human question/)
assert.match(rendered, /Federated assistant answer/)
assert.equal(rendered.includes('SECRET'), false)
console.log('PASS native mixed projection: first-seen/sparse/duplicate/delta-only/end-authority/max-token/interruption/attachments/replay/no-leak/replacement + canonical JSON equality + actual ordinary assembler')
console.log('Retained Client Session/SourceEventStream and policy marker integration require separate core/UI evidence; this fixture alone does not establish them')
