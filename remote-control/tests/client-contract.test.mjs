import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// No emulated React/DOM: verify dependency declarations and execute the real pure decoder.
export async function runClientContractTests() {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const literal = source.match(/inject:\s*(\[[^\]]+\])/);
  assert.ok(literal, 'Client must declare its Cordis dependencies');
  const dependencies = JSON.parse(literal[1].replaceAll("'", '"'));
  for (const name of new Set([...source.matchAll(/ctx\.(slots|locale|remote)\b/g)].map(match => match[1]))) {
    assert.ok(dependencies.includes(name), `ctx.${name} requires an explicit inject entry`);
  }
  for (const match of source.matchAll(/ctx\.remote\.([A-Za-z0-9_]+)/g)) {
    assert.ok(dependencies.includes(`remote.${match[1]}`), `RPC namespace remote.${match[1]} is a separate traced Service`);
  }
  assert.ok(dependencies.includes('remote.commands'));
  assert.ok(source.indexOf('const commandRemote = ctx.remote.commands;') < source.indexOf('function RemotePanel'), 'Resolve the namespace in the real apply context before mounting the panel');
  assert.match(source, /commandRemote\.execute\(props\.sessionId/);
  assert.equal(source.match(/const CLIENT_VERSION = '([^']+)'/)[1], manifest.version);

  const declaration = source.match(/function decodeCommandResult\(rpc\) \{[\s\S]*?\n    \}/)?.[0];
  assert.ok(declaration, 'Production command decoder must be independently testable');
  const decode = vm.runInNewContext(`(${declaration})`, { JSON, Error });
  const payload = { configured: true, projects: ['demo'] };
  assert.deepEqual(decode({ ok: true, value: { commandId: 'cmd_fixture', result: { kind: 'success', text: JSON.stringify(payload) } } }), payload);
  assert.throws(() => decode({ ok: false, error: { message: 'RPC denied' } }), /RPC denied/);
  assert.throws(() => decode({ ok: true, value: { result: { kind: 'error', text: 'Business operation refused' } } }), /Business operation refused/);
  assert.throws(() => decode({ result: { kind: 'success', text: '{}' } }), /DSH RPC failed/, 'A raw CommandExecution is not a RemoteResult');
  assert.throws(() => decode({ ok: true, value: undefined }), /Command failed/);
  assert.throws(() => decode({ ok: true, value: { result: { kind: 'success' } } }), /no JSON text/);
  assert.throws(() => decode({ ok: true, value: { result: { kind: 'success', text: 'not-json' } } }));
  console.log('client contract: traced remote.commands injection, activation preflight and RemoteResult/CommandExecution decoding passed (no browser click simulated)');
}
