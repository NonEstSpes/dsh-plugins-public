import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const source=fs.readFileSync(new URL('../scripts/vps-setup.sh',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const js=source.split("<<'DSH_VPS_NODE'\n")[1].split('\nDSH_VPS_NODE')[0];
function api(overrides={}) {
  const module={exports:{}};
  vm.runInNewContext(js,{require,module,process,console,Buffer,URL,AbortSignal,setTimeout,...overrides});
  return module.exports;
}
const a=api();
// Explicit synthetic deployment inputs; these paths and URL are never contacted.
const fixtureInputs=['--url','https://example.invalid','--tuna-bin',path.resolve('/fixture/tuna'),'--tuna-env',path.resolve('/fixture/tuna.env')];
test('explicit stdin entry actually runs render-only instead of silently exiting',t=>{
  const dir=temp(t);
  const childProcess=Object.assign(Object.create(process),{argv:['node','-','--dsh-vps-setup-stdin','--relay-dir',path.resolve('/fixture-relay'),'--relay-user','fixture-user',...fixtureInputs,'--render-only','--output-dir',dir]});
  const log=[];
  api({process:childProcess,console:{log:s=>log.push(s),error:s=>{throw Error(s);}}});
  assert.deepEqual(fs.readdirSync(dir).sort(),['dsh-remote-relay.service','dsh-remote-tuna','dsh-remote-tuna.service']);
  assert.ok(log.some(line=>line.startsWith('Rendered only:')));
  assert.ok(source.includes('- --dsh-vps-setup-stdin "$@"'));
});
function temp(t) { const p=fs.mkdtempSync(path.join(os.tmpdir(),'vps-setup-test-'));t.after(()=>{assert.equal(path.dirname(path.resolve(p)),path.resolve(os.tmpdir()));assert.ok(path.basename(p).startsWith('vps-setup-test-'));fs.rmSync(p,{recursive:true,force:true});});return p; }
const opts=(extra=[])=>a.parse(['--relay-dir',path.resolve('/relay space/quote"%$'),'--relay-user','fixture-user',...fixtureInputs,...extra]);
test('systemd and shell quoting preserve spaces, percent, quotes; reject controls',()=>{
  assert.equal(a.unitQuote('a % " \\ $',true), '"a %% \\" \\\\ $$"');
  assert.equal(a.shellQuote("a 'b"),"'a '\\''b'");
  for(const s of ['a\nb','a\rb','a\0b']) {assert.throws(()=>a.unitQuote(s));assert.throws(()=>a.shellQuote(s));}
  const files=a.render(opts(),'/home/fixture-user');
  assert.match(files['dsh-remote-relay.service'],/WorkingDirectory=".*relay space/);
  assert.match(files['dsh-remote-relay.service'],/Restart=on-failure\nRestartSec=5s/);
  assert.match(files['dsh-remote-relay.service'],/WantedBy=multi-user.target/);
});
test('user selection never silently runs relay as root',()=>{
  assert.equal(a.selectUser(undefined,{SUDO_USER:'fixture-user'}),'fixture-user');
  assert.equal(a.selectUser('alice',{SUDO_USER:'fixture-user'}),'alice');
  for(const u of ['root','bad\nname','bad name']) assert.throws(()=>a.selectUser(u,{}));
  assert.throws(()=>a.selectUser(undefined,{}));
});
test('deployment URL and tunnel paths must be explicitly supplied',()=>{
  const base=['--relay-user','fixture-user'];
  for (const missing of ['--url','--tuna-bin','--tuna-env']) {
    const inputs=fixtureInputs.filter((_,i)=>fixtureInputs[i-(i%2)]!==missing);
    assert.throws(()=>a.parse([...base,...inputs]),new RegExp('Supply '+missing));
  }
});
test('public URL rejects credentials, query, fragments, non-HTTPS and paths',()=>{
  for(const url of ['http://host','https://u:p@host','https://host/?secret=x','https://host/#x','https://host/path','https://host/?']) assert.throws(()=>opts(['--url',url]));
  assert.equal(opts().url,'https://example.invalid');
});
test('root Tuna wrapper sources local env, retains exact flags, contains no secret values',()=>{
  const o=opts();o.tunaEnv="/root/env 'special'";
  const files=a.render(o,'/home/fixture-user','/root');
  const wrapper=files['dsh-remote-tuna'];
  assert.ok(wrapper.includes('set -a\nif ! source '+a.shellQuote(o.tunaEnv)+' >/dev/null 2>&1; then'));
  assert.match(wrapper,/set \+x\nset \+a\nset -u/);
  assert.ok(wrapper.includes('exec '+a.shellQuote(o.tunaBin)+' http 8787 --https-redirect --inspect=false'));
  assert.match(files['dsh-remote-tuna.service'],/User=root\nEnvironment="HOME=\/root"/);
  assert.ok(!Object.values(files).join('').includes('TOKEN='));
});
test('explicit short-poll backs up original and preserves keys, identities and state',t=>{
  const dir=temp(t),p=path.join(dir,'relay.json');
  const original=JSON.stringify({directory:'./state',devices:[{deviceId:'retain',keyHash:'hash-only'}],pollMs:25000,maxPending:3});
  fs.writeFileSync(p,original);a.shortPoll(p);
  const updated=JSON.parse(fs.readFileSync(p));
  assert.equal(updated.pollMs,0);assert.equal(updated.directory,'./state');assert.equal(updated.devices[0].deviceId,'retain');assert.equal(updated.devices[0].keyHash,'hash-only');assert.equal(updated.maxPending,3);
  const backups=fs.readdirSync(dir).filter(n=>n.includes('.backup-'));assert.equal(backups.length,1);assert.equal(fs.readFileSync(path.join(dir,backups[0]),'utf8'),original);
  a.shortPoll(p);assert.equal(fs.readdirSync(dir).length,2);
});
test('foreign files and symlinks refused; own marked files backed up',t=>{
  const dir=temp(t),p=path.join(dir,'unit');fs.writeFileSync(p,'foreign');
  assert.throws(()=>a.managedTarget(p));assert.throws(()=>a.writeManaged(p,'changed',0o600));assert.equal(fs.readFileSync(p,'utf8'),'foreign');
  fs.writeFileSync(p,a.MARKER+'\nold');
  if(process.platform!=='linux'||process.getuid()===0){a.writeManaged(p,a.MARKER+'\nnew',0o600);assert.equal(fs.readdirSync(dir).filter(n=>n.includes('.backup-')).length,1);}
  else assert.throws(()=>a.managedTarget(p));
  const link=path.join(dir,'link');
  try{fs.symlinkSync(p,link);}catch(e){if(e.code==='EPERM'){t.diagnostic('Windows symlinks unavailable; symlink branch statically checked');assert.ok(js.includes('s.isSymbolicLink()'));return;}throw e;}
  assert.throws(()=>a.managedTarget(link));assert.throws(()=>a.safePath(link,'file'));
});
test('render-only writes output only, never reads config/env, calls systemd/network, signals or short-poll',async t=>{
  const dir=temp(t);let touches=0;
  const fakeRequire=id=>{
    if(id==='node:child_process') return {spawnSync(){touches++;throw Error('must not execute');}};
    if(id==='node:net') return {connect(){touches++;throw Error('must not connect');}};
    return require(id);
  };
  const isolated=api({require:fakeRequire,fetch(){touches++;throw Error('must not fetch');}});
  await isolated.main(['--relay-dir',path.resolve('/does-not-exist'),'--relay-user','fixture-user',...fixtureInputs,'--render-only','--output-dir',dir,'--short-poll']);
  assert.equal(touches,0);assert.deepEqual(fs.readdirSync(dir).sort(),['dsh-remote-relay.service','dsh-remote-tuna','dsh-remote-tuna.service']);
});
