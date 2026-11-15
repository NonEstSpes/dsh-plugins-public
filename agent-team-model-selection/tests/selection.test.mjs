import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { prepareTeammateModel, listTeammateModels, modelSelectionPolicyProjection as policy } from '../model-selection.js';
import { TeamService, TeamRoster, TeamTaskBoard, teamProjectionDefinition as projection } from '../team.js?team-test-internals';
import { apply as installTools } from '../tools.js';
import { resolveChildAgentOptions, snapshotSubagentDescriptor, foldSubagentDescriptor } from '@deepseek-ai/dsh-subagent';
import { subagentModelSelectionProjectionDefinition as stockPolicy } from 'runtime:@deepseek-ai/dsh-tool-subagent';

const routes = [{ provider: 'parent', model: 'big' }, { provider: 'remote', model: 'cheap' }, { provider: 'remote', model: 'plain' }];
function fixture(allowed = routes) {
  const calls = []; const starts = []; const events = []; const descriptors = new Map(); const agents = new Map();
  const controller = new AbortController();
  let current = { provider: 'parent', model: 'big', reasoningEffort: 'high' };
  const root = { id: 'lead-session', options: { provider: 'stale', model: 'old', reasoningEffort: 'bad-old-effort', maxTokens: 100 }, session: {
    header: { id: 'lead-session', origin: 'user' }, requestHeader: () => ({ config: current }), snapshotEvents: () => [],
  } };
  agents.set(root.id, root);
  let backend = { capabilities: { agentOptions: true } };
  let resolveOverride;
  const llm = {
    listProviders: () => [{ id: 'parent', name: 'Parent' }, { id: 'remote', name: 'Remote' }, { id: 'secret', name: 'Secret' }],
    resolveModelInfo: async (provider, model) => {
      if (!routes.some(route => route.provider === provider && route.model === model)) throw new Error('Unknown model');
      return { id: model, name: model, ...(model === 'plain' ? {} : { reasoning: { defaultEffort: model === 'cheap' ? 'low' : 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } }) };
    },
    resolveCallConfig: async (config, signal) => {
      calls.push({ ...config });
      if (resolveOverride) await resolveOverride(config, signal);
      signal.throwIfAborted();
      const info = await llm.resolveModelInfo(config.provider, config.model);
      if (config.reasoningEffort !== undefined && !info.reasoning?.efforts.some(e => e.id === config.reasoningEffort)) throw new Error('Unsupported effort');
      return { ...config, reasoningEffort: config.reasoningEffort ?? info.reasoning?.defaultEffort };
    },
  };
  const ctx = { get: name => name === 'llm' ? llm : undefined, agents: { get: id => agents.get(id) }, subagents: {
    getProvider: () => backend,
    startActivation: async spec => {
      starts.push(spec);
      const options = resolveChildAgentOptions(root, spec.request.agentOptions, 1);
      const descriptor = snapshotSubagentDescriptor({ mode: 'continuable', provider: spec.provider, label: spec.label,
        agentProvider: options.provider, agentModel: options.model,
        ...(options.reasoningEffort === undefined ? {} : { agentReasoningEffort: options.reasoningEffort }),
      });
      descriptors.set(spec.childId, descriptor);
      agents.set(spec.childId, { id: spec.childId, options, session: { header: { parentSession: root.id }, requestHeader: () => undefined, snapshotEvents: () => [] } });
      return { childId: spec.childId, messageId: 'initial' };
    }, drainChildren: async () => {},
  } };
  let state = projection.init(root.session.header);
  let tail = Promise.resolve();
  const journal = {
    state: () => state,
    transact: (_id, operation) => { const run = tail.then(operation); tail = run.catch(() => {}); return run; },
    appendAndFlush: async (_root, type, data) => {
      const event = { type, data, seq: events.length, time: Date.now() }; events.push(event);
      state = projection.apply(state, event);
      assert.equal(state.failure, undefined, 'existing strict Team event schema must still accept events');
    },
  };
  const lifecycle = { signal: controller.signal, disposed: false, track: promise => promise, withTimeout: promise => promise };
  const roster = new TeamRoster(ctx, journal, lifecycle, 8);
  // Model selection tests fake native admission only; checkpoint/recovery is not a browser or physical-worker test.
  roster.checkpointInitialPrompt = async () => {};
  const handle = { stateOf: () => allowed };
  const service = { ctx, lifecycle, roster, modelSelectionPolicyHandle: handle };
  service.spawnTeammate = (...args) => TeamService.prototype.spawnTeammate.apply(service, args);
  service.listModels = (...args) => TeamService.prototype.listModels.apply(service, args);
  const request = (selection, name = 'worker', context = 'fresh') => ({ name, description: 'test member', prompt: [{ type: 'text', text: 'test' }], context, provider: context === 'fork' ? 'fork' : 'spawn', signal: controller.signal,
    ...(selection === undefined ? {} : { modelSelection: selection }),
  });
  return { root, ctx, llm, calls, starts, events, descriptors, agents, journal, lifecycle, roster, handle, service, request, controller,
    state: () => state, setCurrent: value => { current = value; }, setBackend: value => { backend = value; }, setResolve: value => { resolveOverride = value; },
  };
}

for (const context of ['fresh', 'fork']) {
  test(`${context}: omission preserves backend, native inheritance and Team wire shape`, async () => {
    const f = fixture([]); // Omission must not consult policy, LLM or backend capability.
    f.setBackend(undefined);
    const result = await f.service.spawnTeammate(f.root, f.request(undefined, 'worker', context));
    assert.equal(f.calls.length, 0);
    assert.equal(f.starts[0].provider, context === 'fork' ? 'fork' : 'spawn');
    assert.equal(Object.hasOwn(f.starts[0].request, 'agentOptions'), false);
    assert.equal(result.member.model, 'big');
    assert.equal(result.member.reasoningEffort, 'high');
    assert.deepEqual(Object.keys(f.events[0].data.member).sort(), ['context', 'description', 'id', 'name', 'phase', 'provider']);
    assert.equal(projection.stateVersion, 4);
  });
  test(`${context}: explicit selection reaches native descriptor and cold reconstruction`, async () => {
    const f = fixture();
    const result = await f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap', reasoningEffort: 'low' }, 'designer', context));
    assert.equal(f.starts[0].provider, context === 'fork' ? 'fork' : 'spawn');
    assert.deepEqual(f.starts[0].request.agentOptions, { provider: 'remote', model: 'cheap', reasoningEffort: 'low' });
    assert.equal(result.member.llmProvider, 'remote');
    assert.equal(result.member.reasoningEffort, 'low');
    const [childId, descriptor] = [...f.descriptors][0];
    const recovered = foldSubagentDescriptor([{ type: 'subagent/descriptor', data: descriptor }]);
    assert.equal(recovered.agentProvider, 'remote'); assert.equal(recovered.agentModel, 'cheap'); assert.equal(recovered.agentReasoningEffort, 'low');
    f.agents.delete(childId); f.setCurrent({ provider: 'parent', model: 'big', reasoningEffort: 'high' });
    const cold = f.roster.list({ root: f.root }).find(row => row.id === childId);
    assert.equal(Object.hasOwn(cold, 'model'), false, 'do not invent the Lead model for a cold child');
    assert.equal(f.descriptors.get(childId).agentModel, 'cheap');
  });
}

for (const selection of [
  { provider: 'remote' }, { model: 'cheap' }, { provider: '', model: 'cheap' }, { provider: 'remote', model: '' },
  { reasoningEffort: '' }, { reasoningEffort: ' high' }, { provider: 2, model: 'cheap' }, { maxTokens: 999 }, null,
  { provider: 'secret', model: 'secret' }, { provider: 'remote', model: 'unknown' }, { provider: 'remote', model: 'cheap', reasoningEffort: 'max' },
  { provider: 'remote', model: 'plain', reasoningEffort: 'low' },
]) {
  test(`invalid selection fails before any provisioning: ${JSON.stringify(selection)}`, async () => {
    const f = fixture();
    await assert.rejects(f.service.spawnTeammate(f.root, f.request(selection)));
    assert.equal(f.events.length, 0); assert.equal(f.starts.length, 0);
    // The same name remains available after rejection.
    await f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' }));
  });
}

test('no policy: exact current parent route / effort allowed, different route rejected', async () => {
  const f = fixture(null);
  await f.service.spawnTeammate(f.root, f.request({ reasoningEffort: 'low' }, 'a'));
  await f.service.spawnTeammate(f.root, f.request({ provider: 'parent', model: 'big' }, 'b'));
  await assert.rejects(f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' }, 'c')), /not allowed/);
  assert.deepEqual(f.calls, [
    { provider: 'parent', model: 'big', reasoningEffort: 'low' },
    { provider: 'parent', model: 'big', reasoningEffort: 'high' },
  ]);
});
test('recorded policy excludes even parent route / effort-only, never inheritance', async () => {
  const f = fixture([{ provider: 'remote', model: 'cheap' }]);
  await assert.rejects(f.service.spawnTeammate(f.root, f.request({ reasoningEffort: 'low' })), /not allowed/);
  await assert.rejects(f.service.spawnTeammate(f.root, f.request({ provider: 'parent', model: 'big' })), /not allowed/);
  await f.service.spawnTeammate(f.root, f.request(undefined));
});
for (const invalid of [[], {}, [{ provider: 'remote', model: 'cheap' }, { provider: 'remote', model: 'cheap' }], [{ provider: 'remote' }]]) {
  test(`corrupt recorded policy fails closed: ${JSON.stringify(invalid)}`, async () => {
    const f = fixture(invalid);
    await assert.rejects(f.service.spawnTeammate(f.root, f.request({ reasoningEffort: 'low' })));
    assert.equal(f.starts.length, 0); assert.equal(f.events.length, 0);
  });
}

test('route change drops parent effort, same route inherits; no default is materialized', async () => {
  const f = fixture();
  await f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' }, 'a'));
  assert.equal(Object.hasOwn(f.calls[0], 'reasoningEffort'), false);
  assert.equal(f.starts[0].request.agentOptions.reasoningEffort, undefined);
  assert.equal([...f.descriptors.values()][0].agentReasoningEffort, undefined);
  await f.service.spawnTeammate(f.root, f.request({ provider: 'parent', model: 'big' }, 'b'));
  assert.equal(f.starts[1].request.agentOptions.reasoningEffort, 'high');
});
test('validated route and inherited effort are pinned across async parent changes', async () => {
  const f = fixture();
  f.setResolve(() => f.setCurrent({ provider: 'remote', model: 'cheap', reasoningEffort: 'low' }));
  await f.service.spawnTeammate(f.root, f.request({ reasoningEffort: 'high' }));
  assert.deepEqual(f.starts[0].request.agentOptions, { provider: 'parent', model: 'big', reasoningEffort: 'high' });
  const g = fixture();
  g.setResolve(() => g.setCurrent({ provider: 'remote', model: 'cheap', reasoningEffort: 'high' }));
  await g.service.spawnTeammate(g.root, g.request({ provider: 'remote', model: 'cheap' }));
  assert.equal([...g.descriptors.values()][0].agentReasoningEffort, undefined);
});

test('cancelled preflight, backend replacement and missing capability start nothing', async () => {
  for (const mutate of [
    f => f.setResolve(() => f.controller.abort(new Error('cancelled'))),
    f => f.setResolve(() => f.setBackend({ capabilities: { agentOptions: true } })),
    f => f.setBackend({ capabilities: { agentOptions: false } }),
    f => { f.lifecycle.disposed = true; },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' })));
    assert.equal(f.events.length, 0); assert.equal(f.starts.length, 0);
  }
});
test('exact-live Lead checks and raw agentOptions cannot be bypassed', async () => {
  const f = fixture();
  await assert.rejects(f.service.spawnTeammate({ ...f.root }, f.request(undefined)), /not a member/);
  await f.service.spawnTeammate(f.root, { ...f.request(undefined), agentOptions: { provider: 'secret', model: 'secret' } });
  assert.equal(Object.hasOwn(f.starts[0].request, 'agentOptions'), false);
  const child = f.agents.get(f.starts[0].childId);
  await assert.rejects(f.service.spawnTeammate(child, f.request({ provider: 'remote', model: 'cheap' }, 'other')), /Lead/);
});
test('preflight participates in disposal tracking; Lead replacement/disposal while awaiting rejects', async () => {
  for (const stale of [true, false]) {
    const f = fixture(); let tracked = 0;
    f.lifecycle.track = promise => { tracked++; return promise; };
    f.setResolve(() => {
      assert.equal(tracked, 1, 'the async validation promise must already be tracked');
      if (stale) f.agents.set(f.root.id, { ...f.root });
      else { f.lifecycle.disposed = true; f.controller.abort(new Error('disposed')); }
    });
    // Start the async adapter work after returning its Promise to track().
    const current = f.llm.resolveCallConfig;
    f.llm.resolveCallConfig = async (...args) => { await Promise.resolve(); return current(...args); };
    await assert.rejects(f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' })));
    assert.equal(f.events.length, 0); assert.equal(f.starts.length, 0);
  }
});
test('backend replacement in the Promise handoff cannot be pinned as validated', async () => {
  const f = fixture();
  const getBackend = f.ctx.subagents.getProvider;
  let reads = 0;
  f.ctx.subagents.getProvider = () => {
    const backend = getBackend();
    if (++reads === 2) queueMicrotask(() => f.setBackend({ capabilities: { agentOptions: true } }));
    return backend;
  };
  await assert.rejects(f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' })), /backend changed/);
  assert.equal(f.starts.length, 0);
});
test('backend replacement during durable provisioning cannot start an unvalidated backend', async () => {
  const f = fixture();
  const append = f.journal.appendAndFlush;
  f.journal.appendAndFlush = async (...args) => {
    await append(...args);
    if (args[2].member?.phase === 'provisioning') f.setBackend({ capabilities: { agentOptions: true } });
  };
  await assert.rejects(f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap' })), /backend changed/);
  assert.equal(f.starts.length, 0);
  assert.equal(f.state().members[0].phase, 'failed', 'post-reservation failures retain the original durable recovery semantics');
});
test('roster reporting uses the latest native request, never stale creation options', async () => {
  const f = fixture();
  await f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap', reasoningEffort: 'low' }));
  const child = f.agents.get(f.starts[0].childId);
  child.session.requestHeader = () => ({ config: { provider: 'parent', model: 'big', reasoningEffort: 'high' } });
  const row = f.roster.list({ root: f.root }).find(row => row.id === child.id);
  assert.equal(row.llmProvider, 'parent'); assert.equal(row.model, 'big'); assert.equal(row.reasoningEffort, 'high');
  const lead = f.roster.list({ root: f.root })[0];
  assert.equal(lead.model, 'big'); assert.equal(lead.llmProvider, 'parent');
});
test('parallel choices are isolated; duplicate-name and Team limits are unchanged', async () => {
  const f = fixture();
  await Promise.all([
    f.service.spawnTeammate(f.root, f.request({ provider: 'parent', model: 'big', reasoningEffort: 'high' }, 'a')),
    f.service.spawnTeammate(f.root, f.request({ provider: 'remote', model: 'cheap', reasoningEffort: 'low' }, 'b')),
  ]);
  assert.deepEqual(f.starts.map(s => [s.label, s.request.agentOptions.model, s.request.agentOptions.reasoningEffort]), [['test member', 'big', 'high'], ['test member', 'cheap', 'low']]);
  await assert.rejects(f.service.spawnTeammate(f.root, f.request(undefined, 'a')), /already used/);
  f.roster.maxMembers = 2;
  await assert.rejects(f.service.spawnTeammate(f.root, f.request(undefined, 'c')), /limit/);
});

test('discovery filters providers, models and model-specific efforts using the same policy', async () => {
  const f = fixture();
  assert.match(await f.service.listModels(f.root, {}, f.controller.signal), /remote — Remote/);
  assert.doesNotMatch(await f.service.listModels(f.root, {}, f.controller.signal), /secret/);
  assert.match(await f.service.listModels(f.root, { provider: 'remote' }, f.controller.signal), /remote\/cheap/);
  assert.match(await f.service.listModels(f.root, { provider: 'remote', model: 'cheap' }, f.controller.signal), /low \(default\)/);
  await assert.rejects(f.service.listModels(f.root, { provider: 'secret' }, f.controller.signal), /not allowed/);
  await assert.rejects(f.service.listModels(f.root, { model: 'cheap' }, f.controller.signal), /requires/);
  assert.doesNotMatch(await listTeammateModels(f.ctx, { stateOf: () => null }, f.root, {}, f.controller.signal), /remote/);
});

test('shared policy definition has exact upstream schema and fold semantics', () => {
  assert.equal(policy.key, stockPolicy.key); assert.equal(policy.stateVersion, stockPolicy.stateVersion);
  assert.deepEqual(z.toJSONSchema(policy.stateSchema), z.toJSONSchema(stockPolicy.stateSchema));
  const event = { type: 'subagent/model-selection-policy', data: { allowedModels: routes } };
  assert.deepEqual(policy.apply(null, event), stockPolicy.apply(null, event));
  assert.deepEqual(policy.apply(routes, { ...event, data: { allowedModels: [] } }), routes);
  assert.throws(() => policy.apply(null, { ...event, data: { allowedModels: [] } }));
});

test('real Team tool schema/execute keeps backend separate from LLM and adds only scoped discovery', async () => {
  const definitions = new Map(); const observed = [];
  const agent = { id: 'lead', ctx: {
    tools: { register: tool => { definitions.set(tool.name, tool); return () => definitions.delete(tool.name); } },
    systemPrompt: { section: () => () => {}, context: () => () => {}, getSectionOrder: () => 1, getContextOrder: () => 1 },
  } };
  let cleanup;
  const ctx = { agents: { list: () => [agent] }, on: () => () => {}, effect: factory => { cleanup = factory(); }, agentTeams: {
    tryMembership: () => ({ role: 'lead' }), membership: () => ({ role: 'lead', name: 'lead' }),
    spawnTeammate: async (_agent, request) => { observed.push(request); return { member: { id: 'child', name: request.name, role: 'teammate', status: 'inactive', diagnostics: [] } }; },
    listModels: async () => 'allowed catalog',
  } };
  installTools(ctx);
  const spawn = definitions.get('spawn_teammate');
  for (const key of ['provider', 'model', 'reasoning_effort']) assert.equal(spawn.parameters.properties[key].type, 'string');
  await spawn.execute({ name: 'a', description: 'a', prompt: 'a', context: 'fork', provider: 'remote', model: 'cheap', reasoning_effort: 'low' }, { agent, signal: new AbortController().signal });
  assert.equal(observed[0].provider, 'fork');
  assert.deepEqual(observed[0].modelSelection, { provider: 'remote', model: 'cheap', reasoningEffort: 'low' });
  await spawn.execute({ name: 'b', description: 'b', prompt: 'b' }, { agent, signal: new AbortController().signal });
  assert.equal(Object.hasOwn(observed[1], 'modelSelection'), false);
  assert.equal(await definitions.get('list_team_models').execute({}, { agent, signal: new AbortController().signal }), 'allowed catalog');
  assert.equal(definitions.has('subagent'), false);
  cleanup(); assert.equal(definitions.size, 0);
});

test('existing task DAG lifecycle still works with the unchanged strict Team projection', async () => {
  const f = fixture(); const board = new TeamTaskBoard(f.journal, 256); const membership = { root: f.root, role: 'lead' };
  const created = await board.create(membership, { subject: 'a', description: 'b' });
  const claimed = await board.update(f.root, membership, { taskId: created.id, expectedRevision: 1, action: 'claim' });
  const completed = await board.update(f.root, membership, { taskId: created.id, expectedRevision: claimed.revision, action: 'complete' });
  assert.equal(completed.status, 'completed'); assert.equal(completed.revision, 3);
});
