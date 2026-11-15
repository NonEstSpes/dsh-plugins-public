const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Execute only the pure flow helper; no React, DOM, browser, network or real RPC.
const source = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const helper = source.split('// BEGIN RESET FLOW:')[1]?.split('// END RESET FLOW')[0];
assert.ok(helper);
const createResetFlow = vm.runInNewContext('(function(){\n//' + helper + '\nreturn createResetFlow;})()');
const key = 'dsh-openai-codex-auth.pending-reset';
const uuid = '12345678-1234-4123-8123-123456789abc';
const card = { id:'card_1', expiresAt:Date.now() + 86400000 };
function fixture(redeem) {
  const values = new Map();
  const calls = [];
  const storage = { getItem:k => values.get(k) ?? null, setItem:(k,v) => values.set(k,v), removeItem:k => values.delete(k) };
  const flow = createResetFlow({ storage, uuid:() => uuid, redeem:async input => { calls.push(input); return redeem ? redeem(input) : { resetResult:'reset', loggedIn:true }; } });
  return { flow, values, calls, storage };
}
test('reading and unconfirmed submission never spend a reset', async () => {
  const {flow,calls,values} = fixture();
  assert.equal(flow.read(), null);
  assert.equal((await flow.submit(card, false)).code, 'unconfirmed');
  assert.equal(calls.length, 0); assert.equal(values.size, 0);
});
test('confirmed request is persisted before RPC; terminal success clears it', async () => {
  let f;
  f = fixture(input => {
    const saved = JSON.parse(f.values.get(key));
    assert.equal(saved.idempotencyKey, input.idempotencyKey);
    assert.equal(saved.creditId, card.id);
    assert.equal(input.confirmed, true);
    return { resetResult:'reset', loggedIn:true };
  });
  assert.equal((await f.flow.submit(card, true)).code, 'reset');
  assert.equal(f.calls.length, 1); assert.equal(f.flow.read(), null);
});
test('uncertain retry retains both UUID and card across flow recreation', async () => {
  const f = fixture(() => { throw Error('lost response'); });
  assert.equal((await f.flow.submit(card, true)).code, 'unknown');
  const reloaded = createResetFlow({ storage:f.storage, uuid:() => { throw Error('must not allocate'); }, redeem:async input => {
    assert.equal(input.idempotencyKey, uuid); assert.equal(input.creditId, card.id);
    return { resetResult:'already_redeemed' };
  } });
  assert.equal((await reloaded.submit(card, true)).code, 'already_redeemed');
  assert.equal(reloaded.read(), null);
});
test('cannot switch cards while an uncertain request is saved', async () => {
  const f = fixture(() => ({ resetResult:'unknown' }));
  await f.flow.submit(card, true);
  assert.equal((await f.flow.submit({...card,id:'card_2'}, true)).code, 'pending_other');
  assert.equal(f.calls.length, 1);
});
test('double submit cannot create a second concurrent call', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish=resolve; }));
  const first = f.flow.submit(card, true);
  assert.equal((await f.flow.submit(card, true)).code, 'pending');
  assert.equal(f.calls.length, 1);
  finish({resetResult:'reset'}); await first;
});
test('unwritable storage fails closed before RPC', async () => {
  let called = false;
  const flow = createResetFlow({ storage:{getItem:() => null,setItem:() => {throw Error('denied');}}, uuid:() => uuid, redeem:async () => {called=true;} });
  assert.equal((await flow.submit(card,true)).code, 'storage'); assert.equal(called,false);
});
test('unreadable or invalid shared attempts block redemption', async () => {
  for (const raw of ['invalid JSON', '{}', JSON.stringify({creditId:undefined,idempotencyKey:uuid})]) {
    const f = fixture(); f.values.set(key,raw);
    assert.equal(f.flow.read().legacy,true);
    assert.equal((await f.flow.submit(card,true)).code,'storage'); assert.equal(f.calls.length,0);
  }
});
test('expired new card is rejected; expired uncertain retry is allowed', async () => {
  const f = fixture(); const expired = {...card,expiresAt:1};
  assert.equal((await f.flow.submit(expired,true)).code,'no_credit'); assert.equal(f.calls.length,0);
  f.values.set(key,JSON.stringify({creditId:card.id,idempotencyKey:uuid,expiresAt:1}));
  assert.equal((await f.flow.submit(expired,true)).code,'reset');
});
test('unknown, pending, account_changed and invalid responses retain saved request', async () => {
  for (const code of ['unknown','pending','account_changed','unexpected']) {
    const f=fixture(() => ({resetResult:code}));
    assert.equal((await f.flow.submit(card,true)).code,code==='unexpected'?'unknown':code);
    assert.equal(f.flow.read().idempotencyKey,uuid);
  }
});
test('all terminal provider codes release the saved request', async () => {
  for (const code of ['reset','already_redeemed','no_credit','nothing_to_reset','unavailable']) {
    const f=fixture(() => ({resetResult:code}));
    assert.equal((await f.flow.submit(card,true)).code,code); assert.equal(f.flow.read(),null);
  }
});
test('request started in Settings reuses provider shared storage contract', async () => {
  const f=fixture(); f.values.set(key,JSON.stringify({creditId:card.id,idempotencyKey:uuid,expiresAt:card.expiresAt}));
  await f.flow.submit(card,true); assert.equal(f.calls[0].idempotencyKey,uuid);
});
test('private journal preserves original UUID if Settings overwrites the shared attempt', async () => {
  const f=fixture(() => ({resetResult:'unknown'}));
  await f.flow.submit(card,true);
  f.values.set(key,JSON.stringify({creditId:'card_2',idempotencyKey:'23456789-1234-4123-8123-123456789abc'}));
  const reloaded=createResetFlow({storage:f.storage,uuid:() => {throw Error('must reuse original');},redeem:async input => {
    assert.equal(input.creditId,card.id); assert.equal(input.idempotencyKey,uuid); return {resetResult:'reset'};
  }});
  assert.equal(reloaded.read().creditId,card.id);
  assert.equal((await reloaded.submit(card,true)).code,'reset');
  assert.equal(reloaded.read(),null);
});
test('terminal response does not erase a newer attempt written elsewhere', async () => {
  let f; f=fixture(() => {f.values.set(key,JSON.stringify({creditId:'card_2',idempotencyKey:'23456789-1234-4123-8123-123456789abc'}));return {resetResult:'reset'};});
  await f.flow.submit(card,true); assert.equal(f.flow.read().creditId,'card_2');
});
