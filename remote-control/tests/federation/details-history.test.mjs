import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHistoryPage, projectEvent, parseHistoryPage } from '../../lib/federation/history.mjs'
import { decodeExportCursor, jsonByteLength } from '../../lib/federation/protocol.mjs'

const format = 'native-details-v1'
const classes = ['conversation.assistant', 'tool.call', 'tool.result', 'turn']
const principal = { kind: 'controller', id: 'controller_fixture' }
const grant = { version: 1, grantId: 'grant_fixture', principal, machineKey: 'worker', revision: 1, issuedAt: 0,
  projects: [{ projectId: 'demo', actions: ['project.list', 'session.list'], exportClasses: classes,
    sessions: [{ sessionId: 'session-1', imported: true, actions: ['session.read', 'session.follow'] }] }] }
const call = (seq, name = 'read', turn = 1, step = 1) => ({ type: 'tool/call', seq, time: 100 + seq,
  data: { turn, step, callId: 'call-1', name, arguments: '{"path":"worker.txt"}' } })
const result = (seq, turn = 1, step = 1) => ({ type: 'tool/result', seq, time: 100 + seq, surfaceOp: 'append',
  data: { turn, step, message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'file content' }] },
    meta: { path: 'worker.txt', offset: 1, lines: [{ number: 1, text: 'file content' }], totalLines: 1 } } })
const request = (events, extra = {}) => ({ machineKey: 'worker', projectId: 'demo', sessionId: 'session-1', principal, grant,
  generation: 1, grantRevision: 1, now: 1, exportClasses: classes, events, validateNativeEvents: () => {}, format, ...extra })
// Unit oracle only; a separate native SDK case checks the actual assembler's index semantics.
function blocks(stream) {
  const groups = new Map()
  for (const row of stream) {
    const index = row.type === 'chunk' ? row.chunk.index : row.index
    if (!groups.has(index)) groups.set(index, [])
    groups.get(index).push(row)
  }
  return [...groups.values()].flatMap(rows => {
    const end = rows.find(row => row.type === 'chunk' && row.chunk.type === 'block-end')
    if (end) return [end.chunk.block]
    const first = rows[0]
    if (first.type === 'text-chunks' || first.type === 'reasoning-chunks') return [{ type: first.type === 'text-chunks' ? 'text' : 'reasoning', text: rows.flatMap(row => row.texts).join('') }]
    if (first.type === 'tool-call-chunks') return [{ type: 'tool-call', id: first.id, name: first.name, arguments: rows.flatMap(row => row.args).join('') }]
    return []
  })
}
function assistant() {
  const stream = [
    { type: 'text-chunks', time0: 100, index: 9, dt: [], texts: ['answer'] },
    { type: 'reasoning-chunks', time0: 100, index: 2, dt: [], texts: ['PRIVATE_REASONING'] },
    { type: 'tool-call-chunks', time0: 101, index: 6, id: 'call-1', name: 'read', dt: [1], args: ['{"path":', '"worker.txt"}'] },
  ]
  return { type: 'assistant/message', seq: 0, time: 102, surfaceOp: 'append', data: { turn: 1, step: 1,
    message: { id: 'answer-1', role: 'assistant', source: { kind: 'model', provider: 'worker-provider', model: 'worker-model' }, content: blocks(stream) }, stream } }
}

test('rich tool events retain native identities/data only under explicit class and format', () => {
  const events = [call(0), result(1)]
  const page = buildHistoryPage(request(events))
  assert.deepEqual(page.records.map(row => row.event.type), ['tool/call', 'tool/result'])
  assert.deepEqual(page.records.map(row => row.event), events)
  assert.equal(decodeExportCursor(page.exportCursor).format, format)
  assert.deepEqual(parseHistoryPage(page), page)
  const legacy = buildHistoryPage(request(events, { format: 'legacy' }))
  assert.deepEqual(legacy.records, [{ type: 'withheld', firstSeq: 0, lastSeq: 1, reason: 'policy' }])
  assert.equal(decodeExportCursor(legacy.exportCursor).format, undefined)
  const denied = buildHistoryPage(request(events, { exportClasses: ['turn'] }))
  assert.equal(denied.records[0].type, 'withheld')
})

test('result metadata derives only from an earlier exact original-log call, even outside the page', () => {
  const events = [call(0), result(1)]
  const full = buildHistoryPage(request(events))
  const maxBytes = jsonByteLength({ ...full, coveredFromSeq: 1, records: [full.records[1]], hasMore: true })
  const page = buildHistoryPage(request(events, { maxBytes }))
  assert.equal(page.coveredFromSeq, 1)
  assert.deepEqual(page.records[0].event.data.meta, events[1].data.meta)
  for (const earlier of [call(0, 'unreviewed'), call(0, 'read', 2), call(0, 'read', 1, 2)]) {
    const unknown = buildHistoryPage(request([earlier, result(1)]))
    assert.equal(unknown.records[1].redacted, true)
    assert.equal(unknown.records[1].event.data.meta, undefined)
  }
  const future = buildHistoryPage(request([result(0), call(1)]))
  assert.equal(future.records[0].event.data.meta, undefined)
  assert.equal(future.records[0].redacted, true)
})

test('assistant text/tool blocks retain first-seen order and genuine remapped compact records without reasoning', () => {
  const original = assistant()
  const projected = projectEvent(original, { exportClasses: classes, format, nativeAssistantBlocks: blocks })
  assert.equal(projected.withheld, false)
  assert.deepEqual(projected.event.data.message.content, original.data.message.content.filter(block => block.type !== 'reasoning'))
  assert.deepEqual(projected.event.data.stream.map(row => row.index), [0, 1])
  assert.equal(projected.event.data.stream[1].type, 'tool-call-chunks')
  assert.deepEqual(blocks(projected.event.data.stream), projected.event.data.message.content)
  assert.equal(JSON.stringify(projected).includes('PRIVATE_REASONING'), false)
  for (const options of [{ format: 'legacy', exportClasses: classes }, { format, exportClasses: ['conversation.assistant'] }]) {
    const hidden = projectEvent(original, { ...options, nativeAssistantBlocks: blocks })
    assert.deepEqual(hidden.event.data.message.content, [{ type: 'text', text: 'answer' }])
    assert.equal(JSON.stringify(hidden).includes('worker.txt'), false)
  }
  assert.equal(original.data.stream[2].index, 6)
})

test('unproven stream correspondence withholds the whole native assistant event', () => {
  const original = assistant()
  original.data.message.content[2].arguments = 'DIFFERENT'
  assert.equal(projectEvent(original, { exportClasses: classes, format, nativeAssistantBlocks: blocks }).withheld, true)
})

test('complete rich record/page budgets include wrapper and multibyte native arguments without truncation', () => {
  const large = call(0)
  large.data.arguments = '界'.repeat(500)
  const page = buildHistoryPage(request([large]))
  const exact = jsonByteLength(page)
  assert.deepEqual(buildHistoryPage(request([large], { maxBytes: exact })), page)
  assert.throws(() => buildHistoryPage(request([large], { maxBytes: exact - 1 })), error => error.code === 'page-too-large')
  assert.equal(page.records[0].event.data.arguments, large.data.arguments)
  large.data.arguments = '界'.repeat(12000)
  assert.throws(() => buildHistoryPage(request([large])), error => error.code === 'page-too-large')
  assert.throws(() => buildHistoryPage(request([], { format: null })), error => error.code === 'invalid-message')
})
