import assert from 'node:assert/strict'
import test from 'node:test'

import { sourceDiagnostic } from '../../lib/federation/diagnostics.mjs'

const STAGES = [
  'hello', 'catalog', 'session.bind', 'session.create', 'session.prompt', 'session.cancel',
  'model.state', 'session.read', 'session.follow', 'session.status', 'model.catalog',
  'model.catalog.page', 'model.select',
]
const CASES = [
  ['outcome-unknown', 'session/outcome-unknown', 'outcome-unknown'],
  ['session/outcome-unknown', 'session/outcome-unknown', 'outcome-unknown'],
  ['selection-conflict', 'session/selection-conflict', 'selection-conflict'],
  ['session/selection-conflict', 'session/selection-conflict', 'selection-conflict'],
  ['action-unsupported', 'session-source/action-unsupported', 'action-unsupported'],
  ['session-source/action-unsupported', 'session-source/action-unsupported', 'action-unsupported'],
  ['grant-changed', 'session-source/grant-changed', 'grant-changed'],
  ['session-source/grant-changed', 'session-source/grant-changed', 'grant-changed'],
  ['source-unavailable', 'session-source/source-unavailable', 'source-unavailable'],
  ['session-source/source-unavailable', 'session-source/source-unavailable', 'source-unavailable'],
  ['OUTBOX_CAPACITY', 'session-source/source-unavailable', 'local-outbox-full'],
  ['INBOX_CAPACITY', 'session-source/source-unavailable', 'local-inbox-full'],
  ['request-timeout', 'session-source/source-unavailable', 'request-timeout'],
  ['not-granted', 'session-source/source-unavailable', 'not-granted'],
  ['page-too-large', 'session-source/source-unavailable', 'page-too-large'],
  ['invalid-message', 'session-source/source-unavailable', 'invalid-message'],
  ['pairing-mismatch', 'session-source/source-unavailable', 'pairing-mismatch'],
  ['cursor-stale', 'session-source/grant-changed', 'cursor-stale'],
  ['catalog-stale', 'session-source/grant-changed', 'catalog-stale'],
  ['history-gap', 'session-source/source-unavailable', 'history-gap'],
  ['export-policy-unsupported', 'session-source/source-unavailable', 'export-policy-unsupported'],
]
const SECRET = 'Bearer pairing-secret-123 C:\\Users\\Private\\keys.json https://relay.invalid/?token=secret 👁️'

for (const [code, endpointCode, reason] of CASES) {
  test(`diagnostic ${code} preserves its endpoint class and static reason`, () => {
    const error = Object.assign(new Error(SECRET), { code, details: { token: SECRET }, path: SECRET })
    const result = sourceDiagnostic(error, 'model.catalog.page')
    assert.equal(result.endpointCode, endpointCode)
    assert.ok(result.message.startsWith(`model.catalog.page: ${reason}. `))
    assert.deepEqual(Object.keys(result).sort(), ['endpointCode', 'message'])
    assert.ok(!JSON.stringify(result).includes(SECRET))
  })
}

test('read deadline, denial, size, malformed protocol, stale authority and unavailable stay distinguishable', () => {
  const codes = ['request-timeout', 'not-granted', 'page-too-large', 'invalid-message', 'grant-changed', 'cursor-stale', 'catalog-stale', 'action-unsupported', 'source-unavailable']
  const messages = codes.map(code => sourceDiagnostic({ code }, 'model.catalog').message)
  assert.equal(new Set(messages).size, codes.length)
  assert.match(messages[0], /read request exceeded its deadline/)
  assert.match(messages[1], /not authorized/)
  assert.match(messages[2], /transfer size/)
  assert.match(messages[3], /supported protocol/)
})

test('capacity diagnostics name only the local transport queue, never remote payloads', () => {
  for (const [code, queue] of [['OUTBOX_CAPACITY', 'outbox'], ['INBOX_CAPACITY', 'inbox']]) {
    const inspected = [], error = { code }
    for (const field of ['message', 'details', 'cause', 'path', 'key']) {
      Object.defineProperty(error, field, { get() { inspected.push(field); throw new Error(SECRET) } })
    }
    assert.deepEqual(sourceDiagnostic(error, 'session.bind.details'), {
      endpointCode: 'session-source/source-unavailable',
      message: `session.bind.details: local-${queue}-full. The local transport ${queue} is full.`,
    })
    assert.deepEqual(inspected, [])
  }
  const fallback = sourceDiagnostic(undefined, 'session.bind')
  for (const error of [new Error('OUTBOX_CAPACITY'), { message: 'OUTBOX_CAPACITY' },
    { code: 'outbox_capacity' }, { code: 'OUTBOX_CAPACITY ' }, { code: 'INBOX_CAPACITY\n' },
    { code: 'source-unavailable', details: { code: 'OUTBOX_CAPACITY' } }]) {
    assert.deepEqual(sourceDiagnostic(error, 'session.bind'), fallback)
  }
})

test('unknown mutation outcomes keep the session prefix despite cancellation or timeout details', () => {
  for (const stage of ['session.create', 'session.prompt', 'session.cancel', 'model.select']) {
    for (const code of ['outcome-unknown', 'session/outcome-unknown']) {
      const result = sourceDiagnostic({ code, name: 'AbortError', message: 'request-timeout', cause: { code: 'request-timeout' } }, stage)
      assert.equal(result.endpointCode, 'session/outcome-unknown')
      assert.ok(result.message.startsWith(`${stage}: outcome-unknown. `))
      assert.match(result.message, /same request ID/)
      assert.ok(!result.message.includes('cancelled'))
      assert.ok(!result.message.includes('request-timeout'))
    }
  }
})

test('selection conflicts keep their lock before a misleading cancellation name', () => {
  for (const code of ['selection-conflict', 'session/selection-conflict']) {
    const result = sourceDiagnostic({ code, name: 'AbortError', details: { code: 'request-timeout' } }, 'model.select')
    assert.equal(result.endpointCode, 'session/selection-conflict')
    assert.ok(result.message.startsWith('model.select: selection-conflict. '))
    assert.ok(!result.message.includes('cancelled'))
  }
})

test('AbortError is cancellation, not an invented source outage', () => {
  for (const code of [undefined, 'ABORT_ERR', 'source-unavailable', 'request-timeout', 'OUTBOX_CAPACITY', 'INBOX_CAPACITY', SECRET]) {
    const result = sourceDiagnostic({ name: 'AbortError', code, message: SECRET }, 'session.read')
    assert.equal(result.endpointCode, 'session-source/source-unavailable')
    assert.equal(result.message, 'session.read: cancelled. The request was cancelled.')
    assert.ok(!result.message.includes('unavailable'))
    assert.ok(!result.message.includes('offline'))
  }
  assert.equal(sourceDiagnostic(new DOMException(SECRET, 'AbortError'), 'session.follow').message,
    'session.follow: cancelled. The request was cancelled.')
})

test('only exact known operations are accepted, including model.catalog.page', () => {
  for (const stage of STAGES) {
    assert.ok(sourceDiagnostic({ code: 'invalid-message' }, stage).message.startsWith(`${stage}: invalid-message. `))
  }
  const hostile = { toString() { throw new Error('must not coerce stage') } }
  for (const stage of [undefined, null, 0, false, {}, [], hostile, new String('model.catalog'),
    SECRET, 'model.catalog.page.extra', 'model.catalog\n' + SECRET, 'session.read:' + SECRET, '__proto__', 'constructor']) {
    const result = sourceDiagnostic({ code: 'page-too-large' }, stage)
    assert.ok(result.message.startsWith('remote: page-too-large. '))
    assert.ok(!result.message.includes(SECRET))
  }
})

test('unknown, malformed and prefix-like codes never become diagnostics or endpoint names', () => {
  const fallback = sourceDiagnostic(undefined, 'model.catalog')
  const hostile = { toString() { throw new Error('must not coerce code') } }
  for (const code of [undefined, null, 42, {}, [], hostile, new String('request-timeout'),
    SECRET, 'session/outcome-unknown:' + SECRET, 'untrusted/outcome-unknown', 'outcome-unknown\n' + SECRET,
    'REQUEST_TIMEOUT', 'request-timeout ', '__proto__', 'constructor', 'toString']) {
    assert.deepEqual(sourceDiagnostic({ code, message: SECRET }, 'model.catalog'), fallback)
  }
  for (const error of [undefined, null, false, 5, SECRET, Symbol('secret'), [], () => SECRET]) {
    assert.deepEqual(sourceDiagnostic(error, 'model.catalog'), fallback)
  }
  for (const name of [{ toString() { throw new Error('must not coerce name') } }, ['AbortError'], new String('AbortError'), SECRET]) {
    assert.deepEqual(sourceDiagnostic({ name, code: SECRET }, 'model.catalog'), fallback)
  }
})

test('remote messages, nested details and paths are never inspected or stringified', () => {
  const inspected = []
  const error = { code: 'not-granted' }
  for (const field of ['message', 'details', 'cause', 'stack', 'path', 'token', 'toString', 'toJSON']) {
    Object.defineProperty(error, field, { get() { inspected.push(field); throw new Error(SECRET) } })
  }
  const result = sourceDiagnostic(error, 'session.status')
  assert.equal(result.endpointCode, 'session-source/source-unavailable')
  assert.ok(result.message.startsWith('session.status: not-granted. '))
  assert.deepEqual(inspected, [])
})

test('unreadable discriminator properties cannot throw or export their failure text', () => {
  const error = new Proxy({}, { get() { throw new Error(SECRET) } })
  assert.deepEqual(sourceDiagnostic(error, 'catalog'), sourceDiagnostic(undefined, 'catalog'))
  const lock = { code: 'outcome-unknown' }
  Object.defineProperty(lock, 'name', { get() { throw new Error('lock must be classified before cancellation') } })
  assert.equal(sourceDiagnostic(lock, 'session.prompt').endpointCode, 'session/outcome-unknown')
})

test('all emitted messages stay below 200 UTF-8 bytes, even with multibyte hostile input', () => {
  const huge = SECRET.repeat(2000)
  const errors = [...CASES.map(([code]) => ({ code, message: huge, details: { huge } })),
    { name: 'AbortError', message: huge }, { code: huge, message: huge }, huge]
  const endpoints = new Set(['session/outcome-unknown', 'session/selection-conflict',
    'session-source/action-unsupported', 'session-source/grant-changed', 'session-source/source-unavailable'])
  for (const stage of [...STAGES, huge]) {
    for (const error of errors) {
      const result = sourceDiagnostic(error, stage)
      assert.ok(endpoints.has(result.endpointCode))
      assert.ok(Buffer.byteLength(result.message, 'utf8') < 200)
      assert.ok(!result.message.includes(SECRET))
      assert.ok(!/[\r\n\u0000]/.test(result.message))
    }
  }
})

test('results do not expose mutable references to a shared diagnostic', () => {
  const first = sourceDiagnostic({ code: 'outcome-unknown' }, 'session.prompt')
  first.endpointCode = 'changed'
  first.message = SECRET
  const second = sourceDiagnostic({ code: 'outcome-unknown' }, 'session.prompt')
  assert.equal(second.endpointCode, 'session/outcome-unknown')
  assert.ok(second.message.startsWith('session.prompt: outcome-unknown. '))
  assert.ok(!second.message.includes(SECRET))
})
