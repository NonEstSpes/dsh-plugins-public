import test from 'node:test';
import assert from 'node:assert/strict';
import { createTool, projectionSchema, apply, diagnoseClient, AGENT_GUIDANCE } from './index.js';
import { createState, applyEvent } from './state.js';
import { normalizeFields, validateFields, cloneJsonBounded, FIELD_TYPES } from './validation.js';
const exec = (callId = 'c') => ({ agent: { session: { id: 's' } }, callId, signal: new AbortController().signal });
const result = (spec, seq) => ({ type: 'tool/result', seq, data: { turn: spec.turn, message: { role: 'tool', toolCallId: spec.callId, source: { kind: 'tool', callId: spec.callId } }, meta: { interactiveReply: spec } } });
function setup() {
  let state = createState({ id: 's' }), boundary = { openTurnStartSeq: 0, lastTurn: 1 };
  const tool = createTool({ sessionProjections: { stateOf: (_session, key) => key === 'turnBoundary' ? boundary : state } });
  return { tool, commit: spec => { state = applyEvent(state, result(spec, state.items.length + 1)); }, state: () => state, boundary: value => { boundary = value; } };
}
const source = { action: 'show', id: 'form', title: 'Form', template: '<Form/>', script: '', fields: [{ name: 'age', type: 'number', min: 1, max: 100, required: true }] };
test('raw JSON schemas expose stage2 actions without external runtime libraries', () => {
  const { tool } = setup();
  assert.equal(tool.parameters.type, 'object');
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.properties.action.enum, ['describe', 'catalog', 'demo', 'show', 'update', 'replace', 'get', 'diagnostics']);
  assert.equal(tool.parameters.properties.data.type, undefined);
});
test('runtime and deferred catalog never produce executable metadata', async () => {
  const { tool } = setup();
  for (const args of [{ action: 'describe' }, { action: 'describe', component: 'Form' }, { action: 'catalog' }]) {
    const value = await tool.execute(args, exec());
    assert.equal(typeof value.guide, 'string'); assert.deepEqual(tool.output.presentationMeta(args, value), {});
  }
  assert.match((await tool.execute({ action: 'describe' }, exec())).guide, /NOT a sandbox/);
});
test('demo emits complete schema2 snapshot and concise model result', async () => {
  const { tool } = setup(), value = await tool.execute({}, exec());
  assert.equal(value.schemaVersion, 2); assert.equal(value.id, 'c'); assert.equal(value.revision, 1); assert.equal(value.dataVersion, 0); assert.equal(value.anchorTurn, 1);
  assert.equal(tool.output.presentationMeta({}, value).interactiveReply, value); assert.match(tool.output.render({}, value)[0].text, /Await/);
});
test('show rejects duplicate IDs and malformed args', async () => {
  const { tool, commit } = setup(); commit(await tool.execute(source, exec()));
  await assert.rejects(tool.execute(source, exec('d')), /already exists/);
  for (const args of [null, [], { action: 1 }, { action: 'unexpected' }, { action: 'show' }, { action: 'demo', data: {} }, { action: 'show', id: '' }, { action: 'get', script: '' }]) await assert.rejects(tool.execute(args, exec()));
});
test('update preserves structure and anchor; optimistic versions and source isolation enforced', async () => {
  const fixture = setup(), first = await fixture.tool.execute(source, exec()); fixture.commit(first);
  fixture.boundary({ openTurnStartSeq: 5, lastTurn: 2 });
  const value = await fixture.tool.execute({ action: 'update', id: 'form', expectedRevision: 1, expectedDataVersion: 0, data: { rows: [1, 2] } }, exec('update'));
  assert.equal(value.turn, 2); assert.equal(value.anchorTurn, 1); assert.equal(value.revision, 1); assert.equal(value.dataVersion, 1); assert.equal(value.template, first.template); assert.equal(value.createdAt, first.createdAt);
  await assert.rejects(fixture.tool.execute({ action: 'update', id: 'form', script: 'bad' }, exec()), /unsupported/);
  await assert.rejects(fixture.tool.execute({ action: 'update', id: 'form', data: {}, expectedRevision: 2 }, exec()), /Stale/);
  await assert.rejects(fixture.tool.execute({ action: 'update', id: 'form' }, exec()), /requires data/);
});
test('replace requires explicit revision and emits complete new source', async () => {
  const { tool, commit } = setup(); commit(await tool.execute(source, exec()));
  await assert.rejects(tool.execute({ ...source, action: 'replace' }, exec('r')), /expectedRevision/);
  const replaced = await tool.execute({ ...source, action: 'replace', expectedRevision: 1, data: [1] }, exec('r'));
  assert.equal(replaced.revision, 2); assert.equal(replaced.dataVersion, 0); assert.deepEqual(replaced.data, [1]);
});
test('get reads metadata/state only from own session and works after turn closes', async () => {
  const fixture = setup(); fixture.commit(await fixture.tool.execute(source, exec())); fixture.boundary({ openTurnStartSeq: null, lastTurn: 1 });
  const list = await fixture.tool.execute({ action: 'get' }, exec()); assert.equal(list.cards[0].id, 'form'); assert.equal(list.cards[0].script, undefined);
  const card = await fixture.tool.execute({ action: 'get', id: 'form' }, exec()); assert.deepEqual(card.fields, source.fields); assert.equal(card.card.template, undefined);
  await assert.rejects(fixture.tool.execute({ action: 'demo' }, exec()), /open turn/);
});
test('projection parser and registrations use pure parse adapter, identity wire, version2 and owner Fetch', () => {
  const state = createState({ id: 's' }); assert.equal(projectionSchema.parse(state), state); assert.throws(() => projectionSchema.parse({ sessionId: 's', items: [] }));
  const registered = {};
  apply({ connection: { fetch: { register: value => { registered.route = value; } } }, sessionProjections: { register: value => { registered.projection = value; } }, tools: { register: value => { registered.tool = value; } }, systemPrompt: { section: value => { registered.prompt = value; } } });
  assert.equal(registered.projection.stateVersion, 2); assert.equal(registered.projection.wire.view(state), state); assert.equal(registered.route.path, '/api/interactive-replies/submit'); assert.equal(registered.command, undefined);
});
test('profile-wide registration teaches proactive UI discovery without granting user authority',()=>{
  const sections=[];const registeredTools=[];
  // A plugin root context has no current Agent/Session. Thus this is not session-local guidance.
  apply({connection:{fetch:{register(){}}},sessionProjections:{register(){}},tools:{register:tool=>registeredTools.push(tool)},systemPrompt:{section:section=>sections.push(section)}});
  assert.equal(registeredTools[0].name,'interactive_ui');assert.equal(sections[0].text,AGENT_GUIDANCE);
  assert.match(AGENT_GUIDANCE,/Proactively create/);assert.match(AGENT_GUIDANCE,/do not merely offer/);assert.match(AGENT_GUIDANCE,/Run\/autorun/);assert.match(AGENT_GUIDANCE,/explicit user action/);assert.match(AGENT_GUIDANCE,/without authorization/);
  const before='Use interactive_ui when a persistent interactive card helps the user. Read describe before authoring and catalog for available components. Ordinary replies need no card. A card is not a user response: wait for explicit user submission.';
  console.log('Prompt guidance size (characters, not tokenizer): '+before.length+' -> '+AGENT_GUIDANCE.length+'; Tool schema unchanged.');
  assert.ok(AGENT_GUIDANCE.length<700);
});
test('field schema rejects dangerous duplicates, illegal constraints, initial and options', () => {
  for (const fields of [[{ name: '__proto__', type: 'text' }], [{ name: 'constructor', type: 'text' }], [{ name: 'a', type: 'text' }, { name: 'a', type: 'number' }], [{ name: 'a', type: 'number', min: 5, max: 1 }], [{ name: 'a', type: 'text', min: 1 }], [{ name: 'a', type: 'number', initial: '3' }], [{ name: 'a', type: 'select', options: [1, 1] }], [{ name: 'a', type: 'select', options: [] }]]) assert.throws(() => normalizeFields(fields));
});
test('all supported field types validate typed values with missing optional allowed and unknown rejected', () => {
  assert.equal(FIELD_TYPES.length, 11);
  const fields = normalizeFields([{ name: 'n', type: 'number', min: 1, max: 4, step: 0.5, required: true }, { name: 's', type: 'switch' }, { name: 'choice', type: 'select', options: [{ label: 'One', value: 1 }] }]);
  assert.equal(validateFields(fields, { n: 1.5, s: false, choice: 1 }).ok, true);
  assert.equal(validateFields(fields, { n: 1.5 }).ok, true);
  for (const values of [{ n: '1' }, { n: 1.2 }, { n: 5 }, {}, { n: 2, s: 'false' }, { n: 2, choice: '1' }, { n: 2, rogue: true }]) assert.equal(validateFields(fields, values).ok, false);
});
test('strings, dates, time and multiple choices enforce semantic constraints', () => {
  const field = (type, value, extra = {}) => validateFields([{ name: 'x', type, ...extra }], { x: value }).ok;
  assert.equal(field('text', '', { required: true }), false); assert.equal(field('textarea', 'long', { maxLength: 3 }), false);
  assert.equal(field('date', '2024-02-29'), true); assert.equal(field('date', '2023-02-29'), false); assert.equal(field('time', '23:59'), true); assert.equal(field('time', '24:00'), false);
  assert.equal(field('checks', [1, false], { options: [1, false] }), true); assert.equal(field('checks', [1, 1], { options: [1, false] }), false);
});
test('bounded JSON clone rejects nonJSON, UTF8 overflow and cycles without source evaluation', () => {
  for (const value of [undefined, NaN, new Date(), { x: undefined }, { get x() { throw new Error('must not run'); } }, 'ю'.repeat(33000)]) assert.throws(() => cloneJsonBounded(value));
  const circular = {}; circular.self = circular; assert.throws(() => cloneJsonBounded(circular));
  const reserved = cloneJsonBounded(JSON.parse('{"__proto__":{"polluted":true},"constructor":"data"}')); assert.equal(Object.hasOwn(reserved, '__proto__'), true); assert.equal({}.polluted, undefined);
  const hidden = {}; Object.defineProperty(hidden, 'toJSON', { value: () => { throw new Error('must not execute'); } }); assert.throws(() => cloneJsonBounded(hidden), /enumerable/);
  const value = { a: [true, null, 1] }, clone = cloneJsonBounded(value); assert.deepEqual(clone, value); assert.notEqual(clone, value);
});
test('large numeric values cannot evade step constraints through relative tolerance', () => {
  assert.equal(validateFields([{ name: 'x', type: 'number', step: 1 }], { x: 1000000000.5 }).ok, false);
  assert.equal(validateFields([{ name: 'x', type: 'number', step: 0.1 }], { x: 0.3 }).ok, true);
});
test('read-only diagnostics compare actual served bytes and detect stale pilot paths',async()=>{
  const ctx={systemPrompt:{assemble:async()=>({sections:[{name:'local-interactive-replies',text:AGENT_GUIDANCE}]})},clientModules:{graph:()=>({entries:[{id:'@local/interactive-replies',url:'plugins/??local&rev=1'}]}),clientPath:()=>'/legacy/client.js',fetchBundle:async()=>new Response('// Interactive Replies 1.0.1;\nCURRENT\n//# sourceMappingURL=x')}};
  const good=await diagnoseClient(ctx,async()=> '// Interactive Replies 1.0.1;\nCURRENT');
  assert.equal(good.profileGuidancePresent,true);assert.equal(good.servedMatchesFile,true);assert.equal(good.servedVersion,'1.0.1');assert.equal(good.artifactVersion,'1.0.1');
  const stale=await diagnoseClient(ctx,async()=> '// Interactive replies · pilot');
  assert.equal(stale.artifactVersion,'pilot');assert.equal(stale.servedMatchesFile,false);
  assert.equal(Object.hasOwn(good,'body'),false);
});
test('get preserves scalar JSON null data', async () => {
  const { tool, commit } = setup(); commit(await tool.execute({ ...source, data: null }, exec()));
  assert.equal((await tool.execute({ action: 'get', id: 'form' }, exec())).data, null);
});
