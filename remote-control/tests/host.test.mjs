import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RemoteControlHost, Config, apply } from '../index.js';
import { RESULT_KEY, initialResult } from '../lib/projection.mjs';

export async function runHostTests() {
  const created = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-host-'));
  const directory = await realpath(created);
  try {
    const project = path.join(directory, 'project');
    await mkdir(project);
    await writeFile(path.join(project, 'safe.txt'), 'fixture');
    await writeFile(path.join(directory, 'outside.txt'), 'outside fixture');
    const sessionId = 'session_owned';
    const data = { sessions: { [sessionId]: { projectId: 'demo', verifiedOwned: true } } };
    const store = { get: () => structuredClone(data) };
    let policy = { mode: 'read-only', workspaceRoot: project };
    const ctx = { sandboxPolicy: { resolve: () => policy } };
    const host = new RemoteControlHost(ctx, {});
    host.store = store;
    host.settings = { role: 'worker', projects: { demo: { cwd: project, allowedTools: ['read', 'glob', 'grep'], exportFinalText: false } } };
    let installed = 0; let disposed = 0;
    const agents = [];
    function makeAgent() {
      const agent = { id: sessionId, session: { id: sessionId }, ctx: { tools: {
        restrict: restriction => { assert.deepEqual(restriction.allow, ['read', 'glob', 'grep']); installed++; return () => { disposed++; }; },
        guard: callback => { agent.guard = callback; return () => {}; },
      } } };
      agents.push(agent);
      return agent;
    }
    const first = makeAgent(); host.constrain(first);
    assert.equal(first.guard({ name: 'read', arguments: { file_path: path.join(project, 'safe.txt') } }), undefined);
    assert.ok(first.guard({ name: 'read', arguments: { file_path: path.join(directory, 'outside.txt') } }));
    assert.ok(first.guard({ name: 'read', arguments: { file_path: path.join(project, 'safe.txt'), sandbox_permissions: 'danger-full-access' } }));
    assert.ok(first.guard({ name: 'glob', arguments: { pattern: '../*' } }));
    assert.ok(first.guard({ name: 'pwsh', arguments: {} }));
    policy = { mode: 'danger-full-access', workspaceRoot: project };
    assert.ok(first.guard({ name: 'read', arguments: { file_path: path.join(project, 'safe.txt') } }));
    const second = makeAgent(); host.constrain(second);
    assert.equal(installed, 2); assert.equal(disposed, 1);
    assert.equal(host.constraints.get(sessionId).agent, second);
    host.constrain(second); assert.equal(installed, 2);

    const projection = { ...initialResult(), text: 'DO_NOT_EXPORT' };
    const live = { session: { id: sessionId } };
    host.ctx = {
      agents: { get: () => live },
      sessionProjections: { stateOf: () => { throw new Error('Deprecated unscoped projection read'); }, snapshot: () => ({ asOfSeq: 7 }) },
    };
    host.resultHandle = { stateOf: () => projection };
    const status = await host.nativeStatus({ sessionId });
    assert.equal(status.seq, 7);
    assert.ok(!JSON.stringify(status).includes('DO_NOT_EXPORT'));
    host.ctx.agents.get = () => undefined;
    host.ctx.sessionQuery = { readSession: async () => ({ session: { id: sessionId, cwd: project }, inheritedEventCount: 0, events: [{ seq: 3 }] }) };
    host.ctx.sessionProjections.restore = (checkpoint, events, base, meta, inherited) => {
      assert.deepEqual(checkpoint, {}); assert.equal(base, 0); assert.equal(meta.id, sessionId); assert.equal(inherited, 0);
      return { checkpoint: { [RESULT_KEY]: { ver: 3, seq: 3, val: projection } } };
    };
    assert.ok(!JSON.stringify(await host.nativeStatus({ sessionId })).includes('DO_NOT_EXPORT'));
    host.ctx.sessionController = {
      list: async () => ({ items: [{ sessionId }] }),
      resolveAgent: async () => ({ agent: second }),
    };
    await host.ensureSession({ sessionId, projectId: 'demo', allowExisting: true });
    await assert.rejects(host.ensureSession({ sessionId, projectId: 'demo', allowExisting: false }), /ambiguous/);
    host.ctx.sessionQuery.readSession = async () => ({ session: { id: sessionId, cwd: directory }, events: [], inheritedEventCount: 0 });
    await assert.rejects(host.ensureSession({ sessionId, projectId: 'demo', allowExisting: true }), /project changed/);
    data.sessions[sessionId].verifiedOwned = false;
    await assert.rejects(host.nativeStatus({ sessionId }), /ownership/);

    assert.deepEqual(Config(), { settingsFile: '' });
    assert.throws(() => Config({ settingsFile: 123 }));
    const commands = []; const tools = []; const effects = [];
    const minimal = {
      effect: callback => { effects.push(callback()); },
      on: () => {},
      sessionProjections: { register: async definition => { assert.equal(definition.key, RESULT_KEY); await Promise.resolve(); return { stateOf: () => initialResult(), dispose: async () => {} }; } },
      commands: { register: definition => { commands.push(definition); } },
      tools: { register: definition => { tools.push(definition); } },
    };
    let finishRegistration;
    minimal.sessionProjections.register = () => new Promise(resolve => { finishRegistration = resolve; });
    const activating = apply(minimal, { settingsFile: path.join(directory, 'intentionally-missing.json') });
    await Promise.resolve();
    assert.equal(commands.length, 0); assert.equal(tools.length, 0, 'Do not publish consumers before projection readiness');
    finishRegistration({ stateOf: () => initialResult(), dispose: async () => {} });
    await activating;
    assert.deepEqual(commands.map(command => command.name), ['remote-control', 'remote-reload']);
    assert.deepEqual(tools.map(tool => tool.name), ['remote_control']);
    assert.equal(tools[0].parameters.additionalProperties, false);
    assert.equal(Object.hasOwn(tools[0].parameters.properties, 'wakeOnReport'), false);
    const result = await tools[0].execute({ action: 'status' }, { agent: { id: 'chat_test' }, signal: new AbortController().signal });
    assert.equal(result.configured, false);
    assert.equal(result.error, null);
    for (const dispose of effects.reverse()) await dispose();
    for (const entry of host.constraints.values()) entry.dispose();
    console.log('host: scoped restrictions, agent replacement, live/cold export redaction, Config and user-only reload passed');
  } finally {
    const target = await realpath(directory);
    assert.equal(path.dirname(target), await realpath(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('dsh-remote-host-'));
    await rm(target, { recursive: true, force: true });
  }
}
