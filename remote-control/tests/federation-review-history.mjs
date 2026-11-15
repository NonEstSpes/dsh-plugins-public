// Independent regression checks derived from native owners; not author fixtures or browser evidence.
import assert from 'node:assert/strict'
import test from 'node:test'
import { projectEvent } from '../lib/federation/history.mjs'

const classes = ['conversation.user', 'conversation.assistant']
const project = event => projectEvent(event, { exportClasses: classes })
const user = (kind, text = 'PRIVATE_CONTEXT') => ({
  type: 'user/message', seq: 0, time: 100, surfaceOp: 'append',
  data: { id: 'human-or-context', role: 'user', source: { kind }, content: [{ type: 'text', text }] },
})
const assistant = content => ({
  type: 'assistant/message', seq: 1, time: 101, surfaceOp: 'append',
  data: { turn: 1, step: 1, stream: [], message: {
    id: 'assistant-1', role: 'assistant',
    source: { kind: 'model', provider: 'worker-provider', model: 'worker-model', replayState: { secret: 'PRIVATE_REPLAY' } },
    content,
  } },
})

for (const kind of ['agent-instructions', 'skill-invocation', 'skill-catalog', 'unreviewed-extension']) {
  test(`human-only grant withholds user-role producer ${kind}`, () => {
    const result = project(user(kind))
    assert.equal(result.withheld, true)
    assert.equal(JSON.stringify(result).includes('PRIVATE_CONTEXT'), false)
  })
}
test('reviewed human text remains visible', () => {
  const result = project(user('user', 'hello'))
  assert.equal(result.withheld, false)
  assert.equal(result.event.data.content[0].text, 'hello')
})
test('visible assistant preserves native required model source, not private replay state', () => {
  const result = project(assistant([{ type: 'text', text: 'answer' }]))
  assert.equal(result.withheld, false)
  assert.deepEqual(result.event.data.message.source, { kind: 'model', provider: 'worker-provider', model: 'worker-model' })
  assert.equal(JSON.stringify(result).includes('PRIVATE_REPLAY'), false)
})
test('visible assistant retains required native settlement stream array', () => {
  const result = project(assistant([{ type: 'text', text: 'answer' }]))
  assert.equal(result.withheld, false)
  assert.ok(Array.isArray(result.event.data.stream))
})
test('mixed projection never inserts transport policy markers into native event or content', () => {
  const result = project(assistant([{ type: 'text', text: 'answer' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }]))
  assert.equal(JSON.stringify(result).includes('PRIVATE_REASONING'), false)
  if (result.withheld) return
  const event = result.event
  const allowedEnvelope = new Set(['type', 'seq', 'time', 'data', 'ignorable', 'surfaceOp', 'sourceEventSeqs'])
  assert.deepEqual(Object.keys(event).filter(key => !allowedEnvelope.has(key)), [])
  assert.equal(event.data.message.content.some(block => block.type === 'withheld'), false)
  assert.equal(Object.hasOwn(event.data, 'streamWithheld'), false)
})
