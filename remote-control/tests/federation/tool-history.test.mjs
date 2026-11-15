import assert from 'node:assert/strict'
import test from 'node:test'
import { projectToolEvent, TOOL_HISTORY_REVIEWED_CLASSES } from '../../lib/federation/tool-history.mjs'
import { FederationContractError } from '../../lib/federation/identity.mjs'
import { FAILURE_CODES, PROTOCOL_LIMITS, jsonByteLength } from '../../lib/federation/protocol.mjs'

const MAX = PROTOCOL_LIMITS.maxPageBytes
const SECRET = 'HOST_ONLY_PRIVATE_DIAGNOSTIC_783'
const clone = value => structuredClone(value)
const text = value => ({ type: 'text', text: value })
const call = (argumentsRaw = '{"file_path":"C:\\\\worker\\\\demo.ts"}') => ({
  type: 'tool/call', seq: 7, time: 1700000000000,
  data: { turn: 2, step: 3, callId: 'call-native-1', name: 'read', arguments: argumentsRaw },
})
const result = (content = [text('Native result\nwith complete text')]) => ({
  type: 'tool/result', seq: 8, time: 1700000001000, surfaceOp: 'append', sourceEventSeqs: [7],
  data: { turn: 2, step: 3, message: { id: 'message-native-1', role: 'tool',
    source: { kind: 'tool', callId: 'call-native-1' }, toolCallId: 'call-native-1', isError: false, content } },
})
const withMeta = meta => { const event = result(); event.data.meta = meta; return event }
const rejects = (operation, code) => assert.throws(operation, error => error instanceof FederationContractError && error.code === code && !error.message.includes(SECRET))

const METADATA = [
  ['read', { path: 'C:\\worker\\demo.ts', offset: 3, lines: [{ number: 3, text: 'const x = 1' }, { number: 4, text: '' }], totalLines: 8, lang: 'ts' }],
  ['edit', { path: '/worker/demo.ts', diffs: [{ path: '/worker/demo.ts', oldText: 'old\ncontext', newText: 'new\ncontext' }] }],
  ['write', { path: '/worker/new.ts', operation: 'create', diffs: [] }],
  ['apply_patch', { diffs: [{ path: '/worker/demo.ts', oldText: null, newText: 'created' }], stopped: true }],
  ['grep', { shape: 'matches', files: [{ path: '/worker/demo.ts', matches: [{ lineNumber: 2, line: 'found' }] }], truncated: true, total: 99 }],
  ['glob', { shape: 'paths', paths: ['/worker/a.ts', '/worker/b.ts'], truncated: false, total: 2 }],
  ['web_search', { sources: [{ url: 'https://example.test/a', title: 'Title', snippet: 'Full snippet', publishedAt: '2026-11-14' }, { url: 'https://example.test/b' }], truncated: false, answer: 'Complete answer' }],
  ['web_fetch', { url: 'https://example.test/a', statusCode: 200, truncated: true }],
  ['bash', { cwd: '/worker/session' }],
  ['pwsh', { cwd: 'C:\\worker\\session' }],
]

test('the reviewed constants implement only tool call and result classes, not grants', () => {
  assert.deepEqual(TOOL_HISTORY_REVIEWED_CLASSES, ['tool.call', 'tool.result'])
  assert.equal(Object.isFrozen(TOOL_HISTORY_REVIEWED_CLASSES), true)
})

test('native call data retains exact identity and raw arguments without parsing or normalizing', () => {
  for (const raw of ['', '{malformed JSON', ' \r\n{"x":1,"x":2, "unicode":"界🚀"}\t', '{"script":"never execute this source"}']) {
    const event = call(raw), original = clone(event), projected = projectToolEvent(event)
    assert.deepEqual(projected, { data: event.data, redacted: false })
    assert.equal(projected.data.arguments, raw)
    assert.deepEqual(event, original)
    assert.notEqual(projected.data, event.data)
    assert.deepEqual(Object.keys(projected), ['data', 'redacted'])
    assert.equal(Object.hasOwn(projected, 'seq'), false)
    assert.equal(Object.hasOwn(projected, 'surfaceOp'), false)
    assert.equal(Object.isFrozen(projected), true)
    assert.equal(Object.isFrozen(projected.data), true)
  }
})

test('unknown call data fields are omitted, not serialized as private diagnostics', () => {
  const event = call(); event.data.debug = { secret: SECRET, rawException: { cause: SECRET } }
  const projected = projectToolEvent(event)
  assert.equal(projected.redacted, true)
  assert.deepEqual(projected.data, call().data)
  assert.equal(JSON.stringify(projected).includes(SECRET), false)
})

test('native result message, optional status and IDs remain complete while event roots stay caller-owned', () => {
  const event = result(), original = clone(event), projected = projectToolEvent(event)
  assert.deepEqual(projected, { data: event.data, redacted: false })
  assert.deepEqual(event, original)
  assert.equal(projected.data.message.source.callId, event.data.message.toolCallId)
  assert.equal(projected.data.message.id, event.data.message.id)
  assert.equal(Object.hasOwn(projected, 'sourceEventSeqs'), false)
  assert.equal(Object.hasOwn(projected, 'time'), false)
  delete event.data.message.isError
  const withoutStatus = projectToolEvent(event)
  assert.equal(Object.hasOwn(withoutStatus.data.message, 'isError'), false)
  assert.equal(withoutStatus.redacted, false)
})

test('originally empty content stays empty without inventing text or a new status', () => {
  for (const isError of [false, true]) {
    const event = result([]); event.data.message.isError = isError
    assert.deepEqual(projectToolEvent(event), { data: event.data, redacted: false })
  }
})

for (const [name, code] of [
  ['AutoReviewDeniedError', 'AUTO_REVIEW_DENIED'],
  ['ToolOutcomeUnknownError', 'TOOL_OUTCOME_UNKNOWN'],
  ['ToolNotStartedError', 'TOOL_NOT_STARTED'],
]) {
  test(`only the exact static error identity ${name}/${code} survives`, () => {
    const event = result([text('Exact model-visible error output\nsecond line')])
    event.data.message.isError = true
    event.data.error = { name, code }
    assert.deepEqual(projectToolEvent(event), { data: event.data, redacted: false })
    event.data.error.reason = SECRET.repeat(MAX)
    event.data.error.stack = SECRET
    event.data.error.cause = { message: SECRET }
    const projected = projectToolEvent(event)
    assert.deepEqual(projected.data.error, { name, code })
    assert.deepEqual(projected.data.message.content, event.data.message.content)
    assert.equal(projected.redacted, true)
    assert.equal(JSON.stringify(projected).includes(SECRET), false)
  })
}

test('generic outer errors and mismatched known pairs never export Host diagnostics', () => {
  for (const error of [
    { name: SECRET, code: SECRET, reason: SECRET, detail: SECRET },
    { name: 'ToolOutcomeUnknownError', code: 'TOOL_NOT_STARTED', reason: SECRET },
    { name: 'Error', code: 'INTERNAL', reason: SECRET },
  ]) {
    const event = result([text('Granted model-facing failure stays verbatim')])
    event.data.message.isError = true; event.data.error = error
    const projected = projectToolEvent(event)
    assert.equal(Object.hasOwn(projected.data, 'error'), false)
    assert.equal(projected.data.message.isError, true)
    assert.deepEqual(projected.data.message.content, event.data.message.content)
    assert.equal(projected.redacted, true)
    assert.equal(JSON.stringify(projected).includes(SECRET), false)
  }
})

test('explicit model-visible error text is preserved, not conflated with private outer diagnostics', () => {
  const event = result([text(`Model-visible error: ${SECRET}`)])
  event.data.message.isError = true
  event.data.error = { name: 'HostFailure', code: 'PRIVATE', reason: 'not exported' }
  const projected = projectToolEvent(event)
  assert.equal(projected.data.message.content[0].text, `Model-visible error: ${SECRET}`)
  assert.equal(Object.hasOwn(projected.data, 'error'), false)
})

for (const hidden of [
  { type: 'reasoning', text: SECRET },
  { type: 'image', attachment: { attachmentId: 'a'.repeat(64), mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: SECRET } },
  { type: 'file', attachment: { attachmentId: 'b'.repeat(64), name: SECRET, bytes: 1 } },
  { type: 'tool-call', id: 'nested-private-call', name: 'private_tool', arguments: SECRET },
  { type: 'tool-addition', toolName: SECRET },
  { type: 'tool-removal', toolName: SECRET },
]) {
  test(`known ${hidden.type} content cannot become a fake empty successful result`, () => {
    assert.equal(projectToolEvent(result([hidden])), null)
    const projected = projectToolEvent(result([text('before'), hidden, text('after')]))
    assert.deepEqual(projected.data.message.content, [text('before'), text('after')])
    assert.equal(projected.redacted, true)
    assert.equal(JSON.stringify(projected).includes(SECRET), false)
  })
}

test('unknown content types withhold whole, even after a large otherwise visible block', () => {
  for (const blocks of [
    [{ type: 'plugin-secret', value: SECRET }],
    [text('allowed text'), { type: 'interactive-ui', script: SECRET }],
    [text('x'.repeat(MAX * 4)), { type: 'future-native-content', payload: SECRET }],
  ]) assert.equal(projectToolEvent(result(blocks)), null)
})

test('huge withheld reasoning/image payloads never consume the permitted text byte budget', () => {
  const event = result([
    { type: 'reasoning', text: SECRET.repeat(MAX) },
    { type: 'image', attachment: { attachmentId: 'private-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1, name: SECRET.repeat(MAX) } },
    text('small allowed result'),
  ])
  const projected = projectToolEvent(event)
  assert.deepEqual(projected.data.message.content, [text('small allowed result')])
  assert.equal(projected.redacted, true)
})

test('unknown result/message/source/text fields are dropped with carrier-only redaction', () => {
  const event = result([text('kept')])
  event.data.diagnostic = SECRET
  event.data.message.replayState = { secret: SECRET }
  event.data.message.source.privateRoute = SECRET
  event.data.message.content[0].script = SECRET
  const projected = projectToolEvent(event)
  assert.deepEqual(projected.data, result([text('kept')]).data)
  assert.equal(projected.redacted, true)
  assert.equal(JSON.stringify(projected).includes(SECRET), false)
})

for (const [toolName, meta] of METADATA) {
  test(`the closed ${toolName} metadata is copied completely, not passed through opaquely`, () => {
    const event = withMeta(clone(meta)), original = clone(event)
    const projected = projectToolEvent(event, { toolName })
    assert.deepEqual(projected, { data: event.data, redacted: false })
    assert.notEqual(projected.data.meta, event.data.meta)
    assert.equal(Object.isFrozen(projected.data.meta), true)
    assert.deepEqual(event, original)
  })
}

test('read metadata drops unknown root/line fields, keeping exact window numbers and strings', () => {
  const event = withMeta(clone(METADATA[0][1]))
  event.data.meta.script = SECRET.repeat(MAX)
  event.data.meta.fileReference = { path: SECRET }
  event.data.meta.lines[0].reasoning = SECRET
  const projected = projectToolEvent(event, { toolName: 'read' })
  assert.deepEqual(projected.data.meta, METADATA[0][1])
  assert.equal(projected.redacted, true)
  assert.equal(JSON.stringify(projected).includes(SECRET), false)
})

test('nested diff/search/web metadata fields never smuggle arbitrary JSON or code', () => {
  for (const [toolName, index, mutate] of [
    ['edit', 1, meta => { meta.diffs[0].rawFile = SECRET }],
    ['grep', 4, meta => { meta.files[0].matches[0].error = SECRET }],
    ['web_search', 6, meta => { meta.sources[0].interactiveUI = { script: SECRET } }],
  ]) {
    const expected = clone(METADATA[index][1]), event = withMeta(clone(expected))
    mutate(event.data.meta)
    const projected = projectToolEvent(event, { toolName })
    assert.deepEqual(projected.data.meta, expected)
    assert.equal(projected.redacted, true)
    assert.equal(JSON.stringify(projected).includes(SECRET), false)
  }
})

test('absent name, unknown tool, and name suffix guesses never select a metadata serializer', () => {
  for (const toolName of [undefined, 'interactive_ui', 'custom_read', 'functions.read', 'plugin/read']) {
    const event = withMeta(clone(METADATA[0][1]))
    const projected = projectToolEvent(event, { toolName })
    assert.equal(Object.hasOwn(projected.data, 'meta'), false)
    assert.equal(projected.redacted, true)
    assert.deepEqual(projected.data.message, event.data.message)
  }
})

test('unknown interactive/file/spill metadata is omitted without serializing large private data', () => {
  for (const toolName of [undefined, 'interactive_ui', 'read_image', 'present']) {
    const event = withMeta({ script: SECRET.repeat(MAX), template: '<script>private</script>',
      files: [{ path: SECRET }], spill: { locator: SECRET }, reasoning: SECRET })
    const projected = projectToolEvent(event, { toolName })
    assert.equal(Object.hasOwn(projected.data, 'meta'), false)
    assert.equal(projected.redacted, true)
    assert.equal(JSON.stringify(projected).includes(SECRET), false)
  }
})

test('malformed reviewed metadata falls back to the complete authorized text with redaction', () => {
  const cases = [
    ['read', { path: '/worker/a', offset: 0, lines: [], totalLines: 1 }],
    ['read', { path: '/worker/a', offset: 2, lines: [{ number: 1, text: 'bad' }], totalLines: 4 }],
    ['read', { path: '/worker/a', offset: 1, lines: [{ number: 2, text: 'a' }, { number: 2, text: 'b' }], totalLines: 4 }],
    ['read', { path: '/worker/a', offset: 1, lines: [{ number: 5, text: 'bad' }], totalLines: 4 }],
    ['write', { diffs: [], operation: 'private-operation' }],
    ['edit', { diffs: [{ path: '/worker/a', oldText: [], newText: 'x' }] }],
    ['apply_patch', { diffs: [], stopped: 'yes' }],
    ['grep', { shape: 'matches', files: [{ path: '/worker/a', matches: [{ lineNumber: 0, line: 'bad' }] }], total: 1, truncated: false }],
    ['glob', { shape: 'matches', paths: [], total: 0, truncated: false }],
    ['glob', { shape: 'paths', paths: ['/worker/a'], total: -1, truncated: false }],
    ['web_search', { sources: [{ url: 42 }], truncated: false }],
    ['web_fetch', { url: 'https://example.test', statusCode: 200.5, truncated: false }],
    ['bash', { cwd: null }], ['pwsh', []], ['read', null],
  ]
  for (const [toolName, meta] of cases) {
    const event = withMeta(meta), projected = projectToolEvent(event, { toolName })
    assert.equal(Object.hasOwn(projected.data, 'meta'), false)
    assert.deepEqual(projected.data.message, event.data.message)
    assert.equal(projected.redacted, true)
  }
})

test('metadata is validated before size accounting, so a huge but unsupported payload is omitted', () => {
  const event = withMeta({ path: '/worker/a', offset: 1, totalLines: 2,
    lines: [{ number: 1, text: SECRET.repeat(MAX) }, { number: 0, text: 'malformed final line' }] })
  const projected = projectToolEvent(event, { toolName: 'read' })
  assert.equal(Object.hasOwn(projected.data, 'meta'), false)
  assert.equal(projected.redacted, true)
  assert.deepEqual(projected.data.message, event.data.message)
})

test('empty native read windows, diffs and search lists retain explicit facts', () => {
  for (const [toolName, meta] of [
    ['read', { path: '/worker/empty', offset: 1, lines: [], totalLines: 0, lang: '' }],
    ['edit', { diffs: [] }], ['write', { diffs: [], operation: 'update' }], ['apply_patch', { diffs: [], stopped: false }],
    ['glob', { shape: 'paths', paths: [], truncated: false, total: 0 }],
    ['grep', { shape: 'matches', files: [], truncated: false, total: 0 }],
    ['web_search', { sources: [], truncated: false, answer: '' }],
  ]) assert.deepEqual(projectToolEvent(withMeta(meta), { toolName }), { data: withMeta(meta).data, redacted: false })
})

test('spill notices stay authorized native text only; no reference object or recovery I/O is introduced', () => {
  const notice = '(123 bytes omitted. Full formatted result stored at: /worker/spills/private.txt. Use read to inspect the full output.)'
  const event = result([text(`Preview\n\n${notice}`)])
  event.data.meta = { spill: { locator: '/worker/spills/private.txt', retrievalHint: SECRET } }
  const projected = projectToolEvent(event, { toolName: 'custom_tool' })
  assert.deepEqual(projected.data.message.content, event.data.message.content)
  assert.equal(Object.hasOwn(projected.data, 'meta'), false)
  assert.equal(projected.redacted, true)
  assert.equal(JSON.stringify(projected).includes(SECRET), false)
})

test('all output trees are detached and frozen without freezing or changing caller inputs', () => {
  const event = withMeta(clone(METADATA[0][1])), original = clone(event)
  const projected = projectToolEvent(event, { toolName: 'read' })
  assert.deepEqual(event, original)
  assert.equal(Object.isFrozen(event.data.meta.lines), false)
  assert.equal(Object.isFrozen(projected.data.message.content), true)
  assert.equal(Object.isFrozen(projected.data.message.source), true)
  assert.equal(Object.isFrozen(projected.data.meta.lines[0]), true)
  event.data.meta.lines[0].text = 'changed after projection'
  event.data.message.content[0].text = 'changed after projection'
  assert.equal(projected.data.meta.lines[0].text, original.data.meta.lines[0].text)
  assert.deepEqual(projected.data.message.content, original.data.message.content)
  assert.throws(() => { projected.data.meta.lines[0].text = 'forbidden' }, TypeError)
})

test('complete projected data can fit exactly, while the full native carrier still belongs to caller budgeting', () => {
  const event = call(''), spare = MAX - jsonByteLength(event.data)
  event.data.arguments = 'x'.repeat(spare)
  const projected = projectToolEvent(event)
  assert.equal(jsonByteLength(projected.data), MAX)
  assert.ok(jsonByteLength({ type: 'event', event: { ...event, data: projected.data } }) > MAX)
  event.data.arguments += 'x'
  rejects(() => projectToolEvent(event), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('multibyte and JSON-escaped permitted content has an exact byte bound, never truncation', () => {
  const event = result([text('')]), spare = MAX - jsonByteLength(event.data)
  event.data.message.content[0].text = '界'.repeat(Math.floor(spare / 3)) + 'x'.repeat(spare % 3)
  const projected = projectToolEvent(event)
  assert.equal(jsonByteLength(projected.data), MAX)
  assert.equal(projected.data.message.content[0].text, event.data.message.content[0].text)
  event.data.message.content[0].text += '界'
  rejects(() => projectToolEvent(event), FAILURE_CODES.PAGE_TOO_LARGE)
  rejects(() => projectToolEvent(call('\\'.repeat(MAX))), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('valid kept metadata counts together with text and cannot be silently shortened or dropped to fit', () => {
  const event = withMeta({ cwd: '' }), spare = MAX - jsonByteLength(event.data)
  event.data.meta.cwd = 'x'.repeat(spare)
  const projected = projectToolEvent(event, { toolName: 'bash' })
  assert.equal(jsonByteLength(projected.data), MAX)
  assert.equal(projected.redacted, false)
  event.data.meta.cwd += 'x'
  rejects(() => projectToolEvent(event, { toolName: 'bash' }), FAILURE_CODES.PAGE_TOO_LARGE)
  const huge = withMeta({ path: '/worker/a', offset: 1, totalLines: 2000,
    lines: Array.from({ length: 2000 }, (_, index) => ({ number: index + 1, text: 'kept line' })) })
  rejects(() => projectToolEvent(huge, { toolName: 'read' }), FAILURE_CODES.PAGE_TOO_LARGE)
})

test('malformed reviewed native fields reject statically without exporting their values', () => {
  for (const mutate of [
    event => { event.data.message.source.callId = 'another-call' },
    event => { event.data.message.toolCallId = '' },
    event => { event.data.message.role = 'assistant' },
    event => { event.data.message.source.kind = 'model' },
    event => { event.data.message.isError = 'true' },
    event => { event.data.error = { name: SECRET, code: SECRET } },
    event => { event.data.message.content = [text(42)] },
    event => { event.data.turn = -0 },
  ]) { const event = result(); mutate(event); rejects(() => projectToolEvent(event), FAILURE_CODES.INVALID_MESSAGE) }
  for (const mutate of [
    event => { event.data.name = '' }, event => { event.data.callId = '' },
    event => { event.data.arguments = { private: SECRET } }, event => { event.data.step = -1 },
  ]) { const event = call(); mutate(event); rejects(() => projectToolEvent(event), FAILURE_CODES.INVALID_MESSAGE) }
})

test('non-tool events remain unsupported without copying their data', () => {
  assert.equal(projectToolEvent({ type: 'assistant/message', data: { private: SECRET } }), null)
  assert.equal(projectToolEvent({ type: 'tool/ptc-dispatch', data: { private: SECRET } }), null)
  assert.equal(projectToolEvent({ type: 'plugin:interactive/ui', data: { private: SECRET } }), null)
})
