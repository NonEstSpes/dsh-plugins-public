import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const targetHost = 'node-proxy-test.invalid';
const target = `http://${targetHost}/health`;

async function runChild() {
  // If env-proxy is unsupported/ignored, fail locally instead of consulting DNS.
  const lookup = dns.lookup;
  dns.lookup = function (hostname, options, callback) {
    if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1') return lookup.call(this, hostname, options, callback);
    const cb = typeof options === 'function' ? options : callback;
    const error = Object.assign(new Error('External DNS disabled for proxy test'), { code: 'ENOTFOUND' });
    queueMicrotask(() => cb(error));
  };
  try {
    const response = await fetch(target, { signal: AbortSignal.timeout(8000) });
    if (response.status !== 200 || await response.text() !== 'local-origin-ok') throw new Error('Unexpected result');
    return 0;
  } catch {
    console.error('Native fetch env-proxy child failed (details suppressed).');
    return 1;
  }
}

export async function runProxyEnvTests({ nodeExecutable = process.execPath } = {}) {
  const sockets = new Set();
  const observe = server => server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  let originHits = 0, authenticated = 0, proxyRequests = 0, proxyConnects = 0, invalidRequests = 0;
  const expectedAuth = `Basic ${Buffer.from('fakeuser:fakepassword').toString('base64')}`;
  const origin = http.createServer((req, res) => {
    if (req.url !== '/health' || req.method !== 'GET' || req.headers['proxy-authorization']) {
      invalidRequests++; res.writeHead(400).end(); return;
    }
    originHits++; res.writeHead(200, { 'content-type': 'text/plain', connection: 'close' }); res.end('local-origin-ok');
  });
  const proxy = http.createServer((req, res) => {
    proxyRequests++;
    if (req.url !== target || req.headers['proxy-authorization'] !== expectedAuth) {
      invalidRequests++; res.writeHead(407).end(); return;
    }
    authenticated++;
    const upstream = http.request({ host: '127.0.0.1', port: origin.address().port, method: 'GET', path: '/health', headers: { host: targetHost } }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.resume(); upstream.end();
  });
  proxy.on('connect', (req, client, head) => {
    proxyConnects++;
    if (req.url !== `${targetHost}:80` || req.headers['proxy-authorization'] !== expectedAuth) {
      invalidRequests++; client.end('HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\n\r\n'); return;
    }
    authenticated++;
    const upstream = net.connect({ host: '127.0.0.1', port: origin.address().port });
    sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    upstream.on('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
  });
  observe(origin); observe(proxy);
  const listen = server => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const close = server => new Promise(resolve => { if (!server.listening) resolve(); else server.close(resolve); });
  try {
    await listen(origin); await listen(proxy);
    // Inherit no proxy variants or NODE_OPTIONS that might secretly alter the proof.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_options)$/i.test(key)));
    const proxyUrl = `http://fakeuser:fakepassword@127.0.0.1:${proxy.address().port}`;
    Object.assign(env, { NODE_USE_ENV_PROXY: '1', HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: 'localhost,127.0.0.1,::1' });
    const exitCode = await new Promise((resolve, reject) => {
      // No piped stdio: compatible with the Windows process sandbox boundary.
      const child = spawn(nodeExecutable, [self, '--proxy-env-child'], { env, stdio: 'inherit', windowsHide: true });
      const timer = setTimeout(() => { child.kill(); }, 12000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('Unable to start native Node proxy test child')); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(exitCode, 0, 'Native fetch must succeed through the local authenticated proxy');
    assert.ok(originHits > 0, 'Local origin must receive the native fetch request');
    assert.ok(authenticated > 0, 'Proxy must verify Basic authentication');
    assert.equal(invalidRequests, 0, 'Only the expected safe request and authentication are allowed');
    assert.ok(proxyRequests + proxyConnects > 0, 'Native fetch must actually use the proxy');
    return { passed: true, parentNodeVersion: process.versions.node, mode: 'NODE_USE_ENV_PROXY=1', proxyRequests, proxyConnects, authenticated, originHits };
  } finally {
    for (const socket of sockets) socket.destroy();
    await Promise.all([close(proxy), close(origin)]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === '--proxy-env-child') process.exitCode = await runChild();
  else {
    try {
      const result = await runProxyEnvTests();
      console.log(`proxy-env tests passed (Node ${result.parentNodeVersion}; env flag only; requests=${result.proxyRequests}, CONNECT=${result.proxyConnects}, Basic auth verified)`);
    } catch {
      console.error('proxy-env tests FAILED (sanitized; no proxy URL or credentials logged)'); process.exitCode = 1;
    }
  }
}
