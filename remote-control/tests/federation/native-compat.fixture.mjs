// Run from dsh-remote-core: pnpm exec tsx --tsconfig tsconfig.base.json ../remote-control/tests/federation/native-compat.fixture.mjs
import assert from 'node:assert/strict'
import { Session } from '../../../dsh-remote-core/packages/core/session/src/index.ts'
import { SessionId } from '../../../dsh-remote-core/packages/core/session/src/types.ts'
import { createUserMessage, createAssistantMessage } from '../../../dsh-remote-core/packages/llm/llm/src/message.ts'
import { AssistantStreamAccumulator, expandAssistantStream, assembleAssistantStream } from '../../../dsh-remote-core/packages/llm/llm/src/assistant-stream.ts'
import { assertSessionWireEvent } from '../../../dsh-remote-core/packages/api/session-controller/src/client/session-wire-event.ts'
import { ConversationNodeAssembler } from '../../../dsh-remote-core/packages/client/ui-conversation/src/client/conversation/assembler.ts'
import { assistantDefinition } from '../../../dsh-remote-core/packages/client/ui-chat/src/client/conversation-nodes/assistant.ts'
import { messageDefinition } from '../../../dsh-remote-core/packages/client/ui-chat/src/client/conversation-nodes/message.ts'
import { projectEvent, buildHistoryPage } from '../../lib/federation/history.mjs'

const exportClasses = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']
const nativeAssistantBlocks = (stream, interrupted) => { const assembled = assembleAssistantStream(stream); return interrupted ? assembled.interruptedBlocks() : assembled.blocks() }
const accumulator = new AssistantStreamAccumulator()
accumulator.push({ time: 104, chunk: { type: 'text-delta', index: 0, text: 'native answer' } })
const user = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'native question' }] })
const assistant = createAssistantMessage({ source: { provider: 'native-provider', model: 'native-model', replayState: { sentinel: 'SECRET_REPLAY' } }, content: [{ type: 'text', text: 'native answer' }] })
const event = (type, seq, data, surfaceOp) => ({ type, seq, time: 100 + seq, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })
const events = [
  event('turn/start', 0, { turn: 1 }),
  event('user/message', 1, user, 'append'),
  event('step/start', 2, { turn: 1, step: 1 }),
  event('assistant/message', 3, { turn: 1, step: 1, message: assistant, stream: accumulator.snapshot() }, 'append'),
  event('step/end', 4, { turn: 1, step: 1 }),
  event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
]
// Actual core Session seed reader, not a duplicated JSON matcher.
Session.create(SessionId('session-native-input'), events)
const principal = { kind: 'controller', id: 'controller_native' }
const sessionId = 'session-native-input'
const grant = { version: 1, grantId: 'grant_native', principal, machineKey: 'native', revision: 1, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list'], exportClasses, sessions: [{ sessionId, imported: true, actions: ['session.read'] }] }] }
const pageRequest = { machineKey: 'native', projectId: 'demo', sessionId, principal, grant, grantRevision: 1, generation: 1, now: 1, exportClasses, events, nativeAssistantBlocks,
  validateNativeEvents: log => { Session.create(SessionId(sessionId), log); for (const entry of log) { if (entry.type === 'assistant/message') expandAssistantStream(entry.data.stream) } } }
const page = buildHistoryPage(pageRequest)
const permitted = page.records.map(row => { assert.equal(row.type, 'event'); return row.event })
const corruptDenied = structuredClone(events)
corruptDenied[1].data.role = 'system'
corruptDenied[1].data.source = { kind: 'skill-invocation' }
assert.throws(() => buildHistoryPage({ ...pageRequest, events: corruptDenied }), error => error.code === 'invalid-message')
for (const value of permitted) assertSessionWireEvent(value)
Session.create(SessionId('session-native-export'), permitted)
assert.deepEqual(expandAssistantStream(permitted[3].data.stream), expandAssistantStream(events[3].data.stream))
assert.equal(JSON.stringify(permitted).includes('SECRET_REPLAY'), false)
assert.equal(permitted[1].data.id, user.id)
assert.equal(permitted[3].data.message.id, assistant.id)

// Actual ordinary Conversation assembler + ui-chat business definitions.
const definitions = [messageDefinition, assistantDefinition]
const registry = { entries: () => definitions, fallbackEntry: () => undefined }
const view = { target: 'chat', create: () => ({ empty: [], replace: ({ nodes }) => nodes, apply: ({ upserts }) => upserts }) }
const assembler = new ConversationNodeAssembler(registry, { entries: () => [view] })
assembler.activateTarget('chat')
assembler.replaceWindow(permitted.map(value => ({ kind: 'event', event: value })), false)
assembler.flush()
const chat = assembler.snapshot('chat')
const serialized = JSON.stringify(chat)
assert.match(serialized, /native question/)
assert.match(serialized, /native answer/)
assert.equal(serialized.includes('SECRET_REPLAY'), false)
assert.equal(serialized.includes('withheld'), false)

// Native-derived mixed and injected data are valid input but wholly withheld.
const mixed = createAssistantMessage({ source: { provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'allowed but currently withheld' }, { type: 'reasoning', text: 'SECRET_REASONING' }] })
const mixedEvent = event('assistant/message', 3, { turn: 1, step: 1, message: mixed, stream: accumulator.snapshot() }, 'append')
Session.create(SessionId('session-native-mixed'), [...events.slice(0, 3), mixedEvent, ...events.slice(4)])
assert.equal(projectEvent(mixedEvent, { exportClasses, nativeAssistantBlocks }).withheld, true)
const injected = createUserMessage({ source: { kind: 'skill-invocation', name: 'SECRET_SKILL' }, content: [{ type: 'text', text: 'SECRET_INSTRUCTIONS' }] })
const injectedEvent = event('user/message', 1, injected, 'append')
Session.create(SessionId('session-native-injection'), [events[0], injectedEvent, ...events.slice(2)])
assert.equal(projectEvent(injectedEvent, { exportClasses }).withheld, true)
console.log('PASS native builders → core Session reader → assertSessionWireEvent → ordinary Conversation assembler/ui-chat (safe text subset only)')
console.log('NOT full retained SourceEventStream integration or mixed-content/full-visible acceptance')
