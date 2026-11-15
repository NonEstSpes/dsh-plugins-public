// Isolated adapter tests with in-memory fakes; never invoke a live Host business API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { admitOwnerReply, createSubmitRoute, SUBMIT_PATH } from './admission.js';
import { createState, applyEvent } from './state.js';
const signal = () => new AbortController().signal;
const envelope = (extra = {}) => ({ kind: 'interactive-ui-reply', version: 2, sessionId: 's', id: 'form', revision: 1, callId: 'c', values: { age: 25 }, summary: 'Age 25', ...extra });
const request = (extra = {}) => ({ requestId: 'request-1', envelope: envelope(), ...extra });
function setup() {
  const events = [];
  const spec = { schemaVersion: 2, sessionId: 's', id: 'form', revision: 1, dataVersion: 0, turn: 1, anchorTurn: 1, callId: 'c', createdAt: 100, title: 'Form', template: '<Form/>', script: '', data: {}, fields: [{ name: 'age', type: 'number', min: 18, required: true }] };
  let state = applyEvent(createState({ id: 's' }), { type: 'tool/result', seq: 0, data: { turn: 1, message: { role: 'tool', toolCallId: 'c', source: { kind: 'tool', callId: 'c' } }, meta: { interactiveReply: spec } } });
  const agent = { session: { id: 's', snapshotEvents: () => events }, inbox: { nextTurn: [], nextStep: [] }, followup(message) { const event = { type: 'agent/inbox/spliced', seq: events.length + 1, data: { inserted: [message] } }; events.push(event); agent.inbox.nextTurn.push(message); state = applyEvent(state, event); } };
  const ctx = { sessionController: { resolveAgent: async id => id === 's' ? { agent } : { error: { code: 'session/not-found' } } }, sessionProjections: { stateOf: () => state } };
  return { ctx, agent, events, state: () => state, setState: value => { state = value; } };
}
test('owner adapter queues exactly one frozen identified user message after Host validation', async () => {
  const { ctx, agent, state } = setup();
  assert.deepEqual(await admitOwnerReply(ctx, request({ clientTimeZone: 'Europe/Moscow' }), signal()), { accepted: true });
  const message = agent.inbox.nextTurn[0];
  assert.equal(message.role, 'user'); assert.equal(message.source.kind, 'user'); assert.equal(message.source.rpcId, 'request-1'); assert.equal(message.source.clientTimeZone, 'Europe/Moscow'); assert.equal(typeof message.id, 'string'); assert.equal(Object.isFrozen(message.content[0]), true);
  assert.equal(state().items[0].submission.values.age, 25);
});
test('invalid field values, revision, session and unknown fields cannot reach the inbox', async () => {
  for (const extra of [{ values: { age: 10 } }, { values: { age: '25' } }, { values: { age: 25, other: 1 } }, { revision: 2 }, { sessionId: 'other' }]) {
    const { ctx, agent } = setup(), value = await admitOwnerReply(ctx, request({ envelope: envelope(extra) }), signal());
    assert.equal(value.accepted, false); assert.equal(value.definitive, true); assert.equal(agent.inbox.nextTurn.length, 0);
  }
});
test('same request retries accepted before stale revision validation, including claimed/canceled durable input', async () => {
  const fixture = setup();
  await admitOwnerReply(fixture.ctx, request(), signal()); fixture.agent.inbox.nextTurn = [];
  fixture.setState({ ...fixture.state(), items: [] });
  const value = await admitOwnerReply(fixture.ctx, request({ envelope: envelope({ revision: 99 }), clientTimeZone: 'invalid' }), signal());
  assert.deepEqual(value, { accepted: true }); assert.equal(fixture.events.length, 1);
});
test('distinct request IDs cannot enqueue a second answer to one revision', async () => {
  const { ctx, agent } = setup(); await admitOwnerReply(ctx, request(), signal());
  const value = await admitOwnerReply(ctx, request({ requestId: 'request-2' }), signal());
  assert.equal(value.accepted, false); assert.equal(value.definitive, true); assert.equal(agent.inbox.nextTurn.length, 1);
});
test('resolving Agent precedes live-state validation so asynchronous changes are checked', async () => {
  const fixture = setup(), resolve = fixture.ctx.sessionController.resolveAgent;
  fixture.ctx.sessionController.resolveAgent = async id => { fixture.setState({ ...fixture.state(), items: [] }); return resolve(id); };
  const value = await admitOwnerReply(fixture.ctx, request(), signal());
  assert.equal(value.code, 'missing-card'); assert.equal(fixture.events.length, 0);
});
test('a wake failure after durable inbox commit is still acknowledged as accepted', async () => {
  const { ctx, agent } = setup(), original = agent.followup;
  agent.followup = message => { original(message); throw new Error('wake failure after commit'); };
  assert.deepEqual(await admitOwnerReply(ctx, request(), signal()), { accepted: true });
});
test('cancellation and precommit failures never report definitive rejection with uncertain outcome', async () => {
  const { ctx, agent } = setup(); agent.followup = () => { throw new Error('storage failure'); };
  await assert.rejects(admitOwnerReply(ctx, request(), signal()), /storage failure/);
  const controller = new AbortController(); controller.abort(); await assert.rejects(admitOwnerReply(ctx, request(), controller.signal));
});
test('route uses exact owner-only Connection route, caps bytes, accepts JSON, marks unexpected failures unknown', async () => {
  const fixture = setup(), route = createSubmitRoute(fixture.ctx);
  assert.equal(route.path, SUBMIT_PATH); assert.deepEqual(route.methods, ['POST']); assert.equal(route.requestBody, 'buffered');
  const post = body => new Request('http://localhost' + route.path, { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  assert.deepEqual(await (await route.fetch(post(JSON.stringify(request())))).json(), { accepted: true });
  const wrongType = await route.fetch(new Request('http://localhost' + route.path, { method: 'POST', body: '{}' }));
  assert.equal(wrongType.status, 415); assert.equal((await wrongType.json()).code, 'invalid-content-type');
  assert.equal((await route.fetch(post('['))).status, 400);
  assert.equal((await route.fetch(post('ю'.repeat(33000)))).status, 413);
  fixture.ctx.sessionController.resolveAgent = async () => { throw new Error('transport failure'); };
  const response = await route.fetch(post(JSON.stringify(request()))), value = await response.json();
  assert.equal(response.status, 500); assert.equal(value.code, 'admission-unknown'); assert.equal(value.definitive, undefined);
});
test('malformed bounded request and time zone errors are definite before admission', async () => {
  const { ctx, agent } = setup();
  for (const input of [{}, request({ requestId: '' }), request({ extra: true }), request({ clientTimeZone: 'Not/AZone' })]) {
    const value = await admitOwnerReply(ctx, input, signal()); assert.equal(value.accepted, false); assert.equal(value.definitive, true);
  }
  assert.equal(agent.inbox.nextTurn.length, 0);
});
