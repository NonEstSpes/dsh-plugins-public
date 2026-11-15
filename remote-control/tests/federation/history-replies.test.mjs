import test from 'node:test'
import assert from 'node:assert/strict'
import { parseHistoryReplyPage, parseHistoryReplyFrame } from '../../lib/federation/history-replies.mjs'
import { encodeExportCursor, NATIVE_HISTORY_FORMATS as F } from '../../lib/federation/protocol.mjs'

const ref = { machineKey: 'worker', projectId: 'project', sessionId: 'native-session' }
const cursor = (format, throughSeq = 0, target = ref) => encodeExportCursor({ ...target, generation: 1, grantRevision: 2,
  throughSeq, beforeSeq: throughSeq + 1, ...(format === F.DETAILS ? { format } : {}),
})
const event = (type = 'user/message', data = { role: 'user', content: [{ type: 'text', text: 'hello' }] }) => ({
  type: 'event', event: { type, seq: 0, time: 0, surfaceOp: 'append', data },
})
const page = (format, records = [event()]) => ({ generation: 1, grantRevision: 2, exportCursor: cursor(format), throughSeq: 0,
  coveredFromSeq: 0, coveredThroughSeq: 0, records, hasMore: false,
})
const snapshot = format => ({ type: 'snapshot', page: page(format),
  header: { version: 1, id: ref.sessionId, createdAt: 0, isSeeded: false }, projections: { asOfSeq: 0, values: {} },
})
const records = format => ({ type: 'records', generation: 1, grantRevision: 2, exportCursor: cursor(format), records: [event()] })
const invalid = run => assert.throws(run, error => typeof error.code === 'string')

test('native cursor format is verified from the local binding, never selected by Worker payload', () => {
  for (const format of [F.LEGACY, F.DETAILS]) {
    assert.equal(parseHistoryReplyPage(page(format), ref, format).throughSeq, 0)
    assert.equal(parseHistoryReplyFrame(snapshot(format), ref, format).type, 'snapshot')
    assert.equal(parseHistoryReplyFrame(records(format), ref, format).type, 'records')
    const other = format === F.LEGACY ? F.DETAILS : F.LEGACY
    invalid(() => parseHistoryReplyPage(page(other), ref, format))
    invalid(() => parseHistoryReplyFrame(snapshot(other), ref, format))
    invalid(() => parseHistoryReplyFrame(records(other), ref, format))
  }
})

test('foreign cursor scope, mismatched native header identity, and unknown wrapper fields are refused', () => {
  const input = snapshot(F.DETAILS)
  input.page.exportCursor = cursor(F.DETAILS, 0, { ...ref, projectId: 'other' })
  invalid(() => parseHistoryReplyFrame(input, ref, F.DETAILS))
  const wrongHeader = snapshot(F.DETAILS); wrongHeader.header.id = 'other-session'
  invalid(() => parseHistoryReplyFrame(wrongHeader, ref, F.DETAILS))
  invalid(() => parseHistoryReplyFrame({ ...snapshot(F.DETAILS), checkpoint: {} }, ref, F.DETAILS))
})

test('legacy refuses both durable Tool events even when a nonconforming Worker sends a fec1 cursor', () => {
  for (const type of ['tool/call', 'tool/result']) {
    invalid(() => parseHistoryReplyPage(page(F.LEGACY, [event(type, {})]), ref, F.LEGACY))
    assert.equal(parseHistoryReplyPage(page(F.DETAILS, [event(type, {})]), ref, F.DETAILS).records.length, 1)
  }
})

test('legacy refuses Tool entry routes in assistant content and compact runs, without inspecting strings', () => {
  for (const embedded of [{ type: 'tool-call', name: 'cordis_run' }, { type: 'tool-call-chunks' },
    { type: 'chunk', chunk: { type: 'tool-call-delta' } }, { type: 'chunk', chunk: { type: 'block-start', blockType: 'tool-call' } }]) {
    invalid(() => parseHistoryReplyPage(page(F.LEGACY, [event('assistant/message', { stream: [embedded] })]), ref, F.LEGACY))
  }
  const input = page(F.LEGACY, [event('assistant/message', { message: { content: [{ type: 'text', text: '{"type":"tool-call"}' }] } })])
  assert.equal(parseHistoryReplyPage(input, ref, F.LEGACY).records.length, 1)
})

test('records require their exact delivery cut and full contiguous coverage; no empty metrics are accepted', () => {
  const stale = records(F.DETAILS); stale.exportCursor = cursor(F.DETAILS, 1)
  invalid(() => parseHistoryReplyFrame(stale, ref, F.DETAILS))
  const gap = records(F.DETAILS); gap.records.unshift({ type: 'withheld', firstSeq: 0, lastSeq: 1, reason: 'policy' })
  invalid(() => parseHistoryReplyFrame(gap, ref, F.DETAILS))
  const empty = records(F.DETAILS); empty.records = []; empty.projections = { asOfSeq: 0, values: {} }
  invalid(() => parseHistoryReplyFrame(empty, ref, F.DETAILS))
})

test('numeric baselines remain native-detail-only, numeric-only and exactly cursor-pinned', () => {
  const input = records(F.DETAILS)
  input.projections = { asOfSeq: 0, values: { contextBreakdown: { systemTokens: 0, toolsTokens: 2, messageTokens: 3 } } }
  const parsed = parseHistoryReplyFrame(input, ref, F.DETAILS)
  assert.deepEqual(parsed.projections, input.projections)
  assert.equal(Object.isFrozen(parsed.projections), true)
  input.projections.asOfSeq = 1
  invalid(() => parseHistoryReplyFrame(input, ref, F.DETAILS))
  input.projections.asOfSeq = 0; input.projections.values.contextBreakdown.raw = 'private'
  invalid(() => parseHistoryReplyFrame(input, ref, F.DETAILS))
  const old = snapshot(F.LEGACY); old.projections = parsed.projections
  invalid(() => parseHistoryReplyFrame(old, ref, F.LEGACY))
})
