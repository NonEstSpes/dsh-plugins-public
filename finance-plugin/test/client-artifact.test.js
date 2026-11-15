import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { trackClientArtifact } from '../lib/client-artifact.js';

const ownId = '@local/dsh-finance';
const source = (version, sortable = false) => `const marker = { 'data-finance-ui': '${version}' };\n${sortable ? 'function nextTransactionSort() {} const css = "finance-sort-button";' : ''}`;
const ownEntry = rev => ({ id: ownId, rev, url: `/plugins/finance/${rev}.js?rev=${rev}` });

// Only the documented Host Service surface and real Request/Response objects are mocked.
function modules({ missing = false, unchanged = false } = {}) {
  let current = missing ? undefined : ownEntry('old-rev');
  let published = unchanged ? current : ownEntry('new-rev');
  const listeners = new Set();
  const bodies = new Map([
    [ownEntry('old-rev').url, source('0.1.10')],
    [ownEntry('new-rev').url, source('0.1.11', true)],
  ]);
  const calls = { rebuilt: [], requests: [], unsubscribed: 0 };
  const emit = () => { for (const listener of [...listeners]) listener(); };
  const service = {
    graph: () => ({ entries: [{ id: '@other/plugin', rev: 'other', url: '/plugins/other.js' }, ...(current ? [current] : [])], batches: [] }),
    rebuilt(id) {
      calls.rebuilt.push(id);
      assert.equal(id, ownId);
      current = published;
      emit(); // Deliberately emit even if unchanged to expose accidental rebuild loops.
      return current?.rev;
    },
    onGraphChanged(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); calls.unsubscribed++; };
    },
    async fetchBundle(request) {
      assert.ok(request instanceof Request);
      assert.equal(request.method, 'GET');
      calls.requests.push(request);
      const url = new URL(request.url);
      const body = bodies.get(url.pathname + url.search);
      return new Response(body ?? 'not found', { status: body === undefined ? 404 : 200 });
    },
  };
  return { service, calls, bodies, emit,
    advertise(value) { current = value; },
    publish(value) { published = value; },
    listenerCount: () => listeners.size,
  };
}

// Yield one event-loop turn for native Response.text() promises, never poll a status or use delays.
test('mount reads old public artifact, publishes own generation, then reports new version and controls in the same status object', async t => {
  const mock = modules();
  const tracker = trackClientArtifact(mock.service);
  t.after(() => tracker.dispose());
  const reference = tracker.status;
  await nextTurn();
  assert.equal(tracker.status, reference);
  assert.deepEqual(reference, { state: 'ready', previousVersion: '0.1.10', version: '0.1.11',
    previousRev: 'old-rev', rev: 'new-rev', hasSortControls: true, changedRev: true });
  assert.deepEqual(mock.calls.rebuilt, [ownId]);
  assert.deepEqual(mock.calls.requests.map(request => new URL(request.url).pathname + new URL(request.url).search), [ownEntry('old-rev').url, ownEntry('new-rev').url]);
  assert.equal(Object.keys(reference).some(key => /path|source|body|stack/i.test(key)), false);
});

test('absent optional clientModules yields unavailable and an idempotent no-op disposal', () => {
  const tracker = trackClientArtifact(undefined);
  const reference = tracker.status;
  assert.deepEqual(reference, { state: 'unavailable' });
  tracker.dispose();
  tracker.dispose();
  assert.equal(tracker.status, reference);
  assert.deepEqual(reference, { state: 'unavailable' });
});

test('missing own entry waits without fallback fetches and retries when the graph advertises it', async t => {
  const mock = modules({ missing: true });
  const tracker = trackClientArtifact(mock.service);
  t.after(() => tracker.dispose());
  assert.deepEqual(tracker.status, { state: 'waiting' });
  assert.equal(mock.calls.requests.length, 0);
  assert.equal(mock.calls.rebuilt.length, 0);
  mock.advertise(ownEntry('old-rev'));
  mock.emit();
  await nextTurn();
  assert.equal(tracker.status.state, 'ready');
  assert.equal(tracker.status.version, '0.1.11');
  assert.equal(mock.calls.requests.length, 2);
  assert.deepEqual(mock.calls.rebuilt, [ownId]);
});

test('own rebuilt and repeated unrelated graph events do not loop; a new own rev is reviewed once', async t => {
  const mock = modules();
  const tracker = trackClientArtifact(mock.service);
  t.after(() => tracker.dispose());
  // Graph changes while the first body is pending cannot start parallel work.
  mock.emit();
  mock.emit();
  await nextTurn();
  assert.equal(mock.calls.requests.length, 2);
  mock.emit();
  mock.emit();
  await nextTurn();
  assert.deepEqual(mock.calls.rebuilt, [ownId]);
  assert.equal(mock.calls.requests.length, 2);
  const later = ownEntry('later-rev');
  mock.bodies.set(later.url, source('0.1.11', true));
  mock.advertise(later);
  mock.publish(later);
  mock.emit();
  await nextTurn();
  assert.equal(mock.calls.requests.length, 4);
  assert.deepEqual(mock.calls.rebuilt, [ownId, ownId]);
  assert.deepEqual(tracker.status, { state: 'ready', previousVersion: '0.1.11', version: '0.1.11',
    previousRev: 'later-rev', rev: 'later-rev', hasSortControls: true, changedRev: false });
});

test('dispose aborts pending before/after reads, unsubscribes once, and ignores subsequent promise completions and events', async () => {
  for (const pendingRead of [1, 2]) {
    const mock = modules();
    const fetchBundle = mock.service.fetchBundle;
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    mock.service.fetchBundle = async request => {
      const response = await fetchBundle(request);
      if (mock.calls.requests.length === pendingRead) return pending;
      return response;
    };
    const tracker = trackClientArtifact(mock.service);
    await nextTurn();
    assert.equal(mock.calls.requests.length, pendingRead);
    const before = structuredClone(tracker.status);
    tracker.dispose();
    tracker.dispose();
    assert.equal(mock.calls.unsubscribed, 1);
    assert.equal(mock.listenerCount(), 0);
    assert.ok(mock.calls.requests.every(request => request.signal.aborted));
    release(new Response(source('0.1.11', true)));
    mock.emit();
    await nextTurn();
    assert.deepEqual(tracker.status, before);
    assert.equal(mock.calls.requests.length, pendingRead);
    assert.equal(mock.calls.rebuilt.length, pendingRead - 1);
  }
});

test('fetch/graph/publication failures and non-public URLs expose only error; unknown marker/control pairs stay honest', async () => {
  for (const failure of ['fetch', 'http', 'graph', 'publish', 'private-url', 'normalized-private-url']) {
    const mock = modules();
    if (failure === 'fetch') mock.service.fetchBundle = async () => { throw new Error('C:\\private\\artifact.js secret source'); };
    if (failure === 'http') mock.service.fetchBundle = async () => new Response('private failure details', { status: 500 });
    if (failure === 'graph') mock.service.graph = () => { throw new Error('private graph path'); };
    if (failure === 'publish') mock.service.rebuilt = () => { throw new Error('private publication path'); };
    if (failure === 'private-url') mock.advertise({ ...ownEntry('old-rev'), url: '/private/artifact.js' });
    if (failure === 'normalized-private-url') mock.advertise({ ...ownEntry('old-rev'), url: '/plugins/../private/artifact.js' });
    const tracker = trackClientArtifact(mock.service);
    await nextTurn();
    assert.deepEqual(tracker.status, { state: 'error' }, failure);
    if (failure.endsWith('url')) assert.equal(mock.calls.requests.length, 0);
    tracker.dispose();
  }
  const mock = modules({ unchanged: true });
  mock.bodies.set(ownEntry('old-rev').url, "'data-finance-ui': '9.9.9'; function nextTransactionSort() {}");
  const tracker = trackClientArtifact(mock.service);
  await nextTurn();
  assert.deepEqual(tracker.status, { state: 'ready', previousVersion: null, version: null,
    previousRev: 'old-rev', rev: 'old-rev', hasSortControls: false, changedRev: false });
  tracker.dispose();
});
