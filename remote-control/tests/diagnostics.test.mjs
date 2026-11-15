import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { diagnoseRelay } from '../scripts/relay-diagnose.mjs';
import { openEndpoint } from '../lib/endpoint.mjs';

async function waitFor(predicate) {
  const until = Date.now() + 5000;
  while (Date.now() < until) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Test state did not settle');
}

export async function runDiagnosticTests() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-remote-diagnostics-'));
  const token = 'diagnostic-fixture-token-secret';
  let mode = 'normal'; let authCalls = 0; let receivedAck;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/health') {
      if (mode === 'redirect') { res.writeHead(302, { location: 'https://must-not-contact.invalid/' }); return res.end(); }
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ protocol: 1, service: 'dsh-remote-relay' }));
    }
    authCalls++;
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"error":"unauthorized"}'); }
    if (req.url === '/v1/ack') {
      receivedAck = JSON.parse(body);
      if (mode === 'timeout') return;
      res.setHeader('content-type', 'application/json'); return res.end('{"acknowledged":true}');
    }
    if (mode === 'gateway') { res.writeHead(502, { 'content-type': 'text/html' }); return res.end(`<html>bad gateway tuna upstream ${token}</html>`); }
    if (mode === 'busy') { res.writeHead(409, { 'content-type': 'application/json' }); return res.end('{"error":"poll_already_active"}'); }
    res.setHeader('content-type', 'application/json'); res.end('{"items":[]}');
  });
  let endpoint;
  const originalFetch = globalThis.fetch;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const settings = { relayUrl: `http://127.0.0.1:${server.address().port}`, relayToken: token, allowLoopback: true, timeoutMs: 500 };
    const good = await diagnoseRelay(settings);
    assert.equal(good.ok, true); assert.deepEqual(receivedAck, { ids: [] });
    assert.equal(good.checks.poll, undefined, 'Default diagnostics never race a plugin poll');
    assert.equal(JSON.stringify(good).includes(token), false);
    const wrong = await diagnoseRelay({ ...settings, relayToken: 'incorrect-fixture-token' });
    assert.equal(wrong.checks.auth.httpStatus, 401); assert.equal(wrong.ok, false);
    mode = 'gateway';
    const bad = await diagnoseRelay({ ...settings, poll: true });
    assert.equal(bad.checks.poll.httpStatus, 502); assert.equal(bad.ok, false);
    assert.ok(bad.checks.poll.gatewayHints.includes('bad gateway'));
    assert.equal(JSON.stringify(bad).includes(token), false, 'Gateway echoes are never returned');
    mode = 'busy'; assert.equal((await diagnoseRelay({ ...settings, poll: true })).checks.poll.relayError, 'poll_already_active');
    mode = 'redirect'; const count = authCalls;
    assert.equal((await diagnoseRelay(settings)).checks.health.code, 'HTTP_REDIRECT');
    assert.equal(authCalls, count, 'No credentials are sent after an unexpected health redirect');
    mode = 'timeout'; assert.equal((await diagnoseRelay({ ...settings, timeoutMs: 100 })).checks.auth.code, 'REQUEST_TIMEOUT');

    let recover = false;
    globalThis.fetch = async () => recover
      ? new Response('{"items":[]}', { headers: { 'content-type': 'application/json' } })
      : new Response('<html>gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } });
    endpoint = await openEndpoint({ role: 'controller', id: 'test_controller', peerId: 'test_worker', relayUrl: 'https://relay.invalid', relayToken: token, sharedKey: Buffer.alloc(32, 3).toString('base64url'), stateDir: path.join(root, 'endpoint') }, { onMessage: async () => {} });
    endpoint.start();
    await waitFor(() => endpoint.status().lastPollError?.httpStatus === 502);
    assert.equal(endpoint.status().lastError.route, 'poll');
    assert.equal(endpoint.status().connection, 'retrying');
    recover = true;
    await waitFor(() => endpoint.status().connection === 'connected');
    assert.equal(endpoint.status().lastPollError, null);
    assert.ok(endpoint.status().lastSuccessfulPollAt);
    assert.equal(endpoint.status().lastError.httpStatus, 502, 'Historical errors stay identifiable as history');
    assert.equal(JSON.stringify(endpoint.status()).includes(token), false);
    console.log('diagnostics: safe auth probe, gateway/status classification, redirects, timeout and live-vs-historical connection state passed');
  } finally {
    await endpoint?.close(); globalThis.fetch = originalFetch;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('dsh-remote-diagnostics-'));
    await rm(root, { recursive: true, force: true });
  }
}
