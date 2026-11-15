import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistoryPage, projectEvent, parseHistoryPage, createHistorySnapshotFrame } from '../../lib/federation/history.mjs'

const classes = ['conversation.user', 'conversation.assistant', 'turn', 'model.selection', 'title']
const principal = { kind: 'controller', id: 'controller_fixture' }
const sessionId = 'session-1'
const human = (seq, text = 'hello') => ({ type: 'user/message', seq, time: 100 + seq, surfaceOp: 'append', data: { id: `m${seq}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (seq) => ({ type: 'assistant/message', seq, time: 100 + seq, surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: `m${seq}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm', replayState: { secret: 'SECRET' } }, content: [{ type: 'text', text: 'answer' }] }, stream: [{ type: 'text-chunks', time0: 100, index: 0, texts: ['answer'], dt: [] }] } })
const grant = { version: 1, grantId: 'grant_fixture', principal, machineKey: 'worker', revision: 1, issuedAt: 0, projects: [{ projectId: 'demo', actions: ['project.list', 'session.list'], exportClasses: [...classes, 'tool.call'], sessions: [{ sessionId, imported: true, actions: ['session.read', 'session.follow'] }] }] }
// Unit-only oracle stub; actual source assembly is separately exercised by native fixtures.
const nativeAssistantBlocks = stream => stream.filter(row => row.type === 'text-chunks' || row.type === 'reasoning-chunks').map(row => ({ type: row.type === 'text-chunks' ? 'text' : 'reasoning', text: row.texts.join('') }))
const request = (events, extra = {}) => ({ machineKey: 'worker', projectId: 'demo', sessionId, principal, grant, generation: 1, grantRevision: 1, now: 1, exportClasses: [...classes, 'tool.call'], events, validateNativeEvents: () => {}, nativeAssistantBlocks, ...extra })
const project = event => projectEvent(event, { exportClasses: classes, nativeAssistantBlocks })
const rejects = (fn, code) => assert.throws(fn, error => error.code === code)

test('native-compatible text subset retains real identity, provider/model and required stream', () => {
  const event = assistant(1)
  const result = project(event).event
  assert.deepEqual(result.data.stream, event.data.stream)
  assert.deepEqual(result.data.message.source, { kind: 'model', provider: 'p', model: 'm' })
  assert.equal(result.data.message.id, 'm1')
  assert.equal(Object.hasOwn(result, 'redacted'), false)
  assert.equal(Object.hasOwn(result.data, 'streamWithheld'), false)
  assert.equal(JSON.stringify(result).includes('SECRET'), false)
})

test('unprovable assistant correspondence/injected data withholds, known human attachments redact in carrier', () => {
  const a = assistant(1)
  a.data.message.content.push({ type: 'reasoning', text: 'SECRET reasoning' })
  const b = assistant(2)
  b.data.stream.push({ type: 'reasoning-chunks', time0: 100, index: 1, texts: ['SECRET stream'], dt: [] })
  const c = human(3, 'SECRET AGENTS')
  c.data.source = { kind: 'skill-invocation', path: 'SECRET path' }
  const d = human(4)
  d.data.content.push({ type: 'image', attachment: { id: 'SECRET image' } })
  const page = buildHistoryPage(request([human(0), a, b, c, d, { type: 'tool/call', seq: 5, time: 105, data: { arguments: 'SECRET tool' } }]))
  assert.deepEqual(page.records.map(row => row.type), ['event', 'withheld', 'event', 'withheld'])
  assert.deepEqual(page.records[1], { type: 'withheld', firstSeq: 1, lastSeq: 3, reason: 'policy' })
  assert.equal(page.records[2].redacted, true)
  assert.deepEqual(page.records[2].event.data.content, [{ type: 'text', text: 'hello' }])
  assert.equal(Object.hasOwn(page.records[2].event, 'redacted'), false)
  assert.equal(JSON.stringify(page).includes('SECRET'), false)
  assert.equal(JSON.stringify(page).includes('blockType'), false)
})

test('missing native stream/source/surface is corruption, never fabricated defaults', () => {
  const a = assistant(1)
  delete a.data.stream
  rejects(() => project(a), 'invalid-message')
  const b = assistant(1)
  delete b.data.message.source.model
  rejects(() => project(b), 'invalid-message')
  const c = human(0)
  delete c.surfaceOp
  rejects(() => project(c), 'invalid-message')
})

test('unsafe turn reasons withhold rather than emit incomplete union payloads', () => {
  for (const reason of [{ kind: 'error', error: { message: 'SECRET' } }, { kind: 'aborted', reason: { kind: 'hook', reason: 'SECRET' } }]) {
    assert.equal(project({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason } }).withheld, true)
  }
  assert.deepEqual(project({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } }).event.data.reason, { kind: 'completed' })
})

test('hidden surface replacement fails visibly instead of retaining stale current content', () => {
  const hidden = human(1)
  hidden.surfaceOp = { op: 'replace', startSeq: 0, endSeq: 0 }
  hidden.sourceEventSeqs = [0]
  hidden.data.source = { kind: 'compact-checkpoint' }
  rejects(() => buildHistoryPage(request([human(0), hidden])), 'export-policy-unsupported')
})

test('coverage advances on all-withheld pages and empty log declares no coverage', () => {
  const hidden = human(1)
  hidden.data.source = { kind: 'skill-invocation' }
  const page = buildHistoryPage(request([human(0), hidden], { maxMessages: 1 }))
  assert.equal(page.coveredFromSeq, 1)
  assert.equal(page.coveredThroughSeq, 1)
  assert.equal(page.throughSeq, 1)
  assert.equal(page.hasMore, true)
  const older = buildHistoryPage(request([human(0), hidden], { beforeSeq: page.coveredFromSeq }))
  assert.equal(older.coveredThroughSeq, 0)
  const empty = buildHistoryPage(request([]))
  assert.equal(empty.coveredFromSeq, null)
  assert.equal(empty.coveredThroughSeq, null)
  assert.equal(empty.hasMore, false)
  assert.equal(empty.throughSeq, -1)
  assert.deepEqual(parseHistoryPage(page), page)
  rejects(() => parseHistoryPage({ ...page, coveredFromSeq: 0 }), 'history-gap')
  rejects(() => parseHistoryPage({ ...empty, hasMore: true }), 'history-gap')
})

test('complete record byte limit, grant and native gap are enforced', () => {
  rejects(() => buildHistoryPage(request([human(0, 'x'.repeat(1000))], { maxBytes: 64 })), 'page-too-large')
  rejects(() => buildHistoryPage(request([human(1)])), 'history-gap')
  rejects(() => buildHistoryPage(request([human(0)], { exportClasses: ['reasoning'] })), 'not-granted')
})

test('opening snapshot does not tunnel raw header or projection checkpoint', () => {
  const page = buildHistoryPage(request([human(0)]))
  const header = { version: 4, id: sessionId, createdAt: 0, isSeeded: false, cwd: 'SECRET path' }
  const frame = createHistorySnapshotFrame({ page, header, projections: { asOfSeq: 0, values: {} } })
  assert.equal(JSON.stringify(frame).includes('SECRET'), false)
  assert.equal(Object.hasOwn(frame, 'assistantStream'), false)
  rejects(() => createHistorySnapshotFrame({ page, header, projections: { asOfSeq: 0, values: { unknown: 'SECRET' } } }), 'export-policy-unsupported')
})
