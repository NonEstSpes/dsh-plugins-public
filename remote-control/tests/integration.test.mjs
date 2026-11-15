import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRelay } from '../relay/server.mjs';
import { openEndpoint } from '../lib/endpoint.mjs';
import { openJsonStore } from '../lib/store.mjs';
import { RemoteEngine, initialEngineState } from '../lib/engine.mjs';
import { initialResult } from '../lib/projection.mjs';

async function until(predicate, label, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function runIntegrationTests() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-integration-'));
  const devices = [
    { id: 'personal', peerId: 'work', token: randomBytes(32).toString('base64url') },
    { id: 'work', peerId: 'personal', token: randomBytes(32).toString('base64url') },
  ];
  const key = randomBytes(32).toString('base64url');
  const relay = createRelay({ directory: path.join(directory, 'relay'), devices: devices.map(({ token, ...device }) => ({ ...device, tokenHash: createHash('sha256').update(token).digest('hex') })), pollMs: 200 });
  let controllerEndpoint; let workerEndpoint; let controllerStore; let workerStore;
  try {
    await new Promise((resolve, reject) => { relay.server.once('error', reject); relay.server.listen(0, '127.0.0.1', resolve); });
    const relayUrl = `http://127.0.0.1:${relay.server.address().port}`;
    const common = { relayUrl, sharedKey: key, allowLoopback: true };
    const controllerSettings = { ...common, role: 'controller', id: devices[0].id, peerId: devices[0].peerId, relayToken: devices[0].token, stateDir: path.join(directory, 'controller'), projects: { demo: {} }, delivery: 'wake' };
    const workerSettings = { ...common, role: 'worker', id: devices[1].id, peerId: devices[1].peerId, relayToken: devices[1].token, stateDir: path.join(directory, 'worker'), projects: { demo: {} } };
    controllerStore = await openJsonStore(path.join(directory, 'controller', 'engine.json'), initialEngineState());
    workerStore = await openJsonStore(path.join(directory, 'worker', 'engine.json'), initialEngineState());
    let controller; let worker;
    controllerEndpoint = await openEndpoint(controllerSettings, { onMessage: message => controller.receive(message) });
    workerEndpoint = await openEndpoint(workerSettings, { onMessage: message => worker.receive(message) });
    const native = new Map(); const nativeRequests = new Set(); const receivedInChat = [];
    let promptCount = 0;
    const backend = {
      async ensureSession({ sessionId, allowExisting }) {
        if (native.has(sessionId) && !allowExisting) throw new Error('Foreign or ambiguous session');
        if (!native.has(sessionId)) native.set(sessionId, { seq: 0, projection: initialResult() });
      },
      async status({ sessionId }) {
        const value = native.get(sessionId); if (!value) throw new Error('No native session');
        return { seq: value.seq, status: value.projection.status, projection: structuredClone(value.projection) };
      },
      async prompt({ operationId, sessionId }) {
        if (nativeRequests.has(operationId)) return;
        nativeRequests.add(operationId); promptCount++;
        const value = native.get(sessionId); value.seq++; value.projection = { ...value.projection, status: 'running' };
      },
      async cancel() {},
    };
    controller = new RemoteEngine({ settings: controllerSettings, store: controllerStore, backend: {}, send: (...args) => controllerEndpoint.send(...args), publish: async report => { receivedInChat.push(report.reportId); } });
    worker = new RemoteEngine({ settings: workerSettings, store: workerStore, backend, send: (...args) => workerEndpoint.send(...args) });
    controllerEndpoint.start(); workerEndpoint.start();
    const created = await controller.execute({ action: 'create', projectId: 'demo', text: '17 * 19' }, 'chat_test');
    await until(() => controllerStore.get().operations[created.operationId].state === 'accepted', 'native prompt acceptance over actual HTTP + JWE');
    assert.equal(promptCount, 1);
    const projection = { ...initialResult(), status: 'completed', endedSeq: 8, text: '323', finishedAt: new Date().toISOString(), requestIds: [created.operationId] };
    native.get(created.sessionId).seq = 8; native.get(created.sessionId).projection = projection;
    await worker.serial(() => worker.acceptSnapshot(created.sessionId, projection));
    await until(() => receivedInChat.length === 1, 'final report through relay');
    assert.equal(controllerStore.get().reports[`report-${created.operationId}`].text, '323');
    const followup = await controller.execute({ action: 'prompt', sessionId: created.sessionId, text: 'Add 7' }, 'chat_test');
    await until(() => controllerStore.get().operations[followup.operationId].state === 'accepted', 'follow-up on the same session');
    assert.equal(promptCount, 2);
    const second = { ...projection, endedSeq: 12, text: '330', finishedAt: new Date().toISOString(), requestIds: [followup.operationId] };
    native.get(created.sessionId).seq = 12; native.get(created.sessionId).projection = second;
    await worker.serial(() => worker.acceptSnapshot(created.sessionId, second));
    await until(() => receivedInChat.length === 2, 'follow-up report');
    assert.equal(controllerStore.get().reports[`report-${followup.operationId}`].text, '330');
    assert.equal(native.size, 1);
    assert.equal(controller.snapshot('some_other_chat').reports.length, 0);
    const status = controllerEndpoint.status();
    assert.ok(!JSON.stringify(status).includes(key));
    assert.ok(!JSON.stringify(status).includes(devices[0].token));
    console.log('integration: real loopback HTTP relay + JWE + durable journals + create/task/report/follow-up passed (backend is a fake, not a real DSH agent)');
  } finally {
    await Promise.allSettled([controllerEndpoint?.close(), workerEndpoint?.close()]);
    await controllerStore?.close(); await workerStore?.close(); await relay.close();
    const target = path.resolve(directory);
    assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
    assert.ok(path.basename(target).startsWith('dsh-remote-integration-'));
    await rm(target, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runIntegrationTests().catch(error => { console.error(error); process.exitCode = 1; });
}
