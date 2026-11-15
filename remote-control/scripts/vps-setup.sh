#!/usr/bin/env bash
# Standalone installer. No environment file is sourced by this installer.
set -euo pipefail
node_bin="$(command -v node || true)"
args=("$@")
for ((i=0; i<${#args[@]}; i++)); do
  if [[ "${args[i]}" == --node ]]; then
    (( i+1 < ${#args[@]} )) || { echo 'Missing --node value' >&2; exit 1; }
    node_bin="${args[i+1]}"
  fi
done
[[ -n "$node_bin" && -x "$node_bin" ]] || { echo 'Node.js 22+ is required; use --node /absolute/path.' >&2; exit 1; }
"$node_bin" --input-type=commonjs - --dsh-vps-setup-stdin "$@" <<'DSH_VPS_NODE'
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const MARKER = '# Managed by dsh-remote-vps-setup v1';
const RELAY = 'dsh-remote-relay.service', TUNA = 'dsh-remote-tuna.service';
const WRAPPER = '/usr/local/libexec/dsh-remote-tuna';
function fail(message) { throw new Error(message); }
function clean(s) { if (typeof s !== 'string' || !s || /[\x00-\x1f\x7f]/.test(s)) fail('Invalid value: empty/control characters.'); return s; }
function unitQuote(s, exec=false) { const escaped=clean(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%'); return '"' + (exec ? escaped.replace(/\$/g, ()=>'$$') : escaped) + '"'; }
function shellQuote(s) { return "'" + clean(s).replace(/'/g, "'\\''") + "'"; }
function selectUser(explicit, env = process.env) { const u = explicit || env.SUDO_USER; if (!u || u === 'root' || !/^[a-z_][a-z0-9_-]*[$]?$/i.test(u)) fail('Supply --relay-user with a non-root Linux account (or run via sudo).'); return u; }
function parse(argv, env = process.env) {
  const o = { relayDir: process.cwd(), node: process.execPath };
  const names = {'--relay-dir':'relayDir','--config':'config','--relay-user':'user','--url':'url','--node':'node','--tuna-bin':'tunaBin','--tuna-env':'tunaEnv','--output-dir':'outputDir'};
  for (let i=0; i<argv.length; i++) {
    const a=argv[i];
    if (a==='--render-only') o.renderOnly=true;
    else if (a==='--short-poll') o.shortPoll=true;
    else if (names[a] && argv[i+1] && !argv[i+1].startsWith('--')) o[names[a]]=clean(argv[++i]);
    else fail('Unknown option or missing value. Supported: --relay-dir --config --relay-user --url --node --tuna-bin --tuna-env --short-poll --render-only --output-dir.');
  }
  for (const [key, flag] of [['url','--url'], ['tunaBin','--tuna-bin'], ['tunaEnv','--tuna-env']]) if (!o[key]) fail('Supply '+flag+' explicitly; no deployment defaults are provided.');
  o.user=selectUser(o.user,env);
  for (const k of ['relayDir','node','tunaBin','tunaEnv']) { clean(o[k]); if (!path.isAbsolute(o[k])) fail(k+' must be absolute.'); o[k]=path.resolve(o[k]); }
  o.config=path.resolve(o.config || path.join(o.relayDir,'relay.json')); clean(o.config);
  let u; try { u=new URL(o.url); } catch { fail('Invalid HTTPS public URL.'); }
  if (u.protocol!=='https:' || !u.hostname || u.username || u.password || u.search || u.hash || u.pathname!=='/' || /[?#]/.test(o.url)) fail('Public URL must be an HTTPS origin without credentials, query or fragment.');
  o.url=u.origin;
  if (o.renderOnly && !o.outputDir) fail('--render-only requires --output-dir.');
  return o;
}
function render(o, home, rootHome='/root') {
  const common='After=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nRestart=on-failure\nRestartSec=5s\n';
  const install='\n[Install]\nWantedBy=multi-user.target\n';
  return {
    [RELAY]: `${MARKER}\n[Unit]\nDescription=DSH remote relay\n${common}User=${o.user}\nEnvironment=${unitQuote('HOME='+home)}\nWorkingDirectory=${unitQuote(o.relayDir)}\nExecStart=${unitQuote(o.node,true)} ${unitQuote(path.join(o.relayDir,'relay/cli.mjs'),true)} --config ${unitQuote(o.config,true)}\nUMask=0077\n${install}`,
    [TUNA]: `${MARKER}\n[Unit]\nDescription=DSH remote Tuna tunnel\n${common}User=root\nEnvironment=${unitQuote('HOME='+rootHome)}\nWorkingDirectory=${unitQuote(rootHome)}\nExecStart=${WRAPPER}\nUMask=0077\n${install}`,
    'dsh-remote-tuna': `#!/usr/bin/env bash\n${MARKER}\nset -euo pipefail\nset +u\nset -a\nif ! source ${shellQuote(o.tunaEnv)} >/dev/null 2>&1; then\n  printf '%s\\n' 'Unable to load protected Tuna environment.' >&2\n  exit 1\nfi\nset +x\nset +a\nset -u\nexec ${shellQuote(o.tunaBin)} http 8787 --https-redirect --inspect=false\n`
  };
}
function safePath(p, kind, rootOwned=false) {
  p=path.resolve(p); let current=path.parse(p).root;
  for (const part of p.slice(current.length).split(path.sep).filter(Boolean)) {
    current=path.join(current,part); const s=fs.lstatSync(current);
    if (s.isSymbolicLink()) fail('Refusing symbolic-link path.');
    if (rootOwned && (s.uid!==0 || (s.mode & 0o022))) fail('Root service paths must be root-owned and not group/world writable.');
  }
  const s=fs.lstatSync(p);
  if (kind==='file' && !s.isFile() || kind==='dir' && !s.isDirectory()) fail('Expected regular file/directory.');
  return s;
}
function managedTarget(p) {
  try {
    const s=fs.lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || (process.platform==='linux' && (s.uid!==0 || (s.mode & 0o022))) || !fs.readFileSync(p,'utf8').split('\n').slice(0,2).includes(MARKER)) fail('Refusing foreign, unowned or symlink managed target.');
  } catch(e) { if(e.code!=='ENOENT') throw e; }
}
function backup(p) {
  const b=p+'.backup-'+Date.now()+'-'+require('node:crypto').randomBytes(4).toString('hex');
  fs.copyFileSync(p,b,fs.constants.COPYFILE_EXCL); fs.chmodSync(b,0o600); return b;
}
function writeManaged(p, text, mode) {
  managedTarget(p);
  if (fs.existsSync(p)) backup(p);
  fs.writeFileSync(p,text,{mode,flag:fs.existsSync(p)?'w':'wx'}); fs.chmodSync(p,mode);
}
function shortPoll(p) {
  safePath(p,'file'); const original=fs.readFileSync(p,'utf8'); let cfg;
  try { cfg=JSON.parse(original); } catch { fail('Invalid relay JSON (not printed).'); }
  if (!cfg || Array.isArray(cfg) || typeof cfg!=='object') fail('Invalid relay JSON object.');
  if (cfg.pollMs===0) return;
  backup(p); cfg.pollMs=0; fs.writeFileSync(p,JSON.stringify(cfg,null,2)+'\n');
}
function run(args, capture=false) {
  const r=cp.spawnSync('systemctl',args,{encoding:'utf8',stdio:capture?['ignore','pipe','ignore']:'ignore'});
  if (r.status!==0) fail('systemctl operation failed (exit '+(r.status ?? 'unavailable')+'); no logs printed.');
  return capture?r.stdout.trim():'';
}
function prop(unit,key) {
  const r=cp.spawnSync('systemctl',['show',unit,'--property='+key,'--property=LoadState'],{encoding:'utf8',stdio:['ignore','pipe','ignore']});
  const lines=(r.stdout||'').trim().split('\n');
  if(lines.includes('LoadState=not-found')) return '';
  if(r.status!==0) fail('systemctl preflight failed (no logs printed).');
  return (lines.find(l=>l.startsWith(key+'='))||'').slice(key.length+1);
}
async function listening() { return new Promise(resolve=>{ const s=net.connect({host:'127.0.0.1',port:8787}); s.setTimeout(1000); s.once('connect',()=>{s.destroy();resolve(true);}); s.once('error',()=>resolve(false)); s.once('timeout',()=>{s.destroy();resolve(false);}); }); }
function ownsListener(pid) {
  if (!/^[1-9][0-9]*$/.test(pid)) return false;
  try {
    const sockets=new Set(fs.readdirSync('/proc/'+pid+'/fd').map(f=>{try{return fs.readlinkSync('/proc/'+pid+'/fd/'+f);}catch{return '';}}));
    return ['/proc/net/tcp','/proc/net/tcp6'].some(p=>fs.readFileSync(p,'utf8').split('\n').slice(1).some(l=>{const a=l.trim().split(/\s+/);return a[1]?.endsWith(':2253') && a[3]==='0A' && sockets.has('socket:['+a[9]+']');}));
  } catch { return false; }
}
async function health(url) {
  let code='NETWORK';
  for (let i=0;i<12;i++) {
    try {
      const r=await fetch(url,{signal:AbortSignal.timeout(4000),redirect:'manual'}); code='HTTP '+r.status;
      if (r.status===200 && (r.headers.get('content-type')||'').includes('application/json')) {
        const reader=r.body.getReader(); let text='';
        while(true) { const {done,value}=await reader.read(); if(done) break; text+=Buffer.from(value).toString(); if(text.length>4096){await reader.cancel();break;} }
        if(text.length<=4096) { let j;try{j=JSON.parse(text);}catch{} if(j?.protocol===1 && j?.service==='dsh-remote-relay') return 'HTTP 200 protocol 1'; }
        code='HTTP 200 INVALID_HEALTH';
      } else await r.body?.cancel();
    } catch(e) { code=/^[A-Z0-9_]+$/.test(e.cause?.code||'')?e.cause.code:'NETWORK_OR_TIMEOUT'; }
    if(i<11) await new Promise(r=>setTimeout(r,1500));
  }
  fail('Health failed: '+code+'. Compare Tuna Forwarding URL with the supplied --url. No logs/body printed.');
}
async function main(argv=process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0])<22) fail('Node.js 22+ required.');
  const o=parse(argv);
  if (o.renderOnly) {
    const out=path.resolve(o.outputDir); safePath(out,'dir');
    for(const [name,text] of Object.entries(render(o,'/home/'+o.user))) fs.writeFileSync(path.join(out,name),text,{flag:'wx',mode:0o600});
    console.log('Rendered only: no configuration, services, environment, network or processes touched.'); return;
  }
  if(process.platform!=='linux' || process.getuid()!==0) fail('Installation requires root on Linux; use sudo. Render-only is non-root.');
  safePath('/run/systemd/system','dir');
  safePath(o.relayDir,'dir'); safePath(path.join(o.relayDir,'relay/cli.mjs'),'file'); safePath(o.config,'file');
  o.node=fs.realpathSync(o.node); safePath(o.node,'file'); safePath(o.tunaBin,'file',true); safePath(o.tunaEnv,'file',true);
  const passwd=fs.readFileSync('/etc/passwd','utf8').split('\n').map(l=>l.split(':'));
  const user=passwd.find(a=>a[0]===o.user), root=passwd.find(a=>a[0]==='root');
  if(!user || !root) fail('Account not found in local passwd database.');
  const uid=Number(user[2]), gid=Number(user[3]), home=user[5]; clean(home);
  let cfg;try{cfg=JSON.parse(fs.readFileSync(o.config,'utf8'));}catch{fail('Invalid relay config (not printed).');}
  if(!cfg || typeof cfg.directory!=='string' || (cfg.host??'127.0.0.1')!=='127.0.0.1' || (cfg.port??8787)!==8787) fail('Relay must use 127.0.0.1:8787 and an existing directory setting.');
  const state=path.resolve(path.dirname(o.config),cfg.directory); clean(state);
  if(state===o.relayDir || state==='/' || state===home) fail('State must be a dedicated directory, not home/root/relay directory.');
  // Never take ownership of a broad tree or existing state; require correct ownership.
  if(fs.existsSync(state)) {const s=safePath(state,'dir');if(s.uid!==uid) fail('Existing state directory must already belong to relay user; no ownership changes made.');}
  else safePath(path.dirname(state),'dir');
  safePath('/etc/systemd/system','dir',true); safePath('/usr/local','dir',true);
  if(fs.existsSync('/usr/local/libexec')) safePath('/usr/local/libexec','dir',true);
  for(const unit of [RELAY,TUNA]) {
    const target='/etc/systemd/system/'+unit; managedTarget(target);
    const fragment=prop(unit,'FragmentPath'), drops=prop(unit,'DropInPaths');
    if((fragment && fragment!==target) || drops) fail('Refusing foreign unit location or drop-ins.');
  }
  managedTarget(WRAPPER);
  if(await listening() && !ownsListener(prop(RELAY,'MainPID'))) fail('Port 8787 has a non-managed listener. Ctrl+C the old relay in its original terminal, then rerun; no processes killed.');
  const tunaPid=prop(TUNA,'MainPID');
  for(const pid of fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p))) {
    let exe;try{exe=fs.readlinkSync('/proc/'+pid+'/exe');}catch{continue;}
    if(exe===o.tunaBin && pid!==tunaPid) fail('An unmanaged Tuna process exists. Ctrl+C the old Tuna in its original terminal, then rerun; no takeover attempted.');
  }
  if(!fs.existsSync(state)) {fs.mkdirSync(state,{mode:0o700});fs.chownSync(state,uid,gid);}
  if(o.shortPoll) shortPoll(o.config);
  if(!fs.existsSync('/usr/local/libexec')) fs.mkdirSync('/usr/local/libexec',{mode:0o755});
  const files=render(o,home,root[5]);
  for(const unit of [RELAY,TUNA]) writeManaged('/etc/systemd/system/'+unit,files[unit],0o644);
  writeManaged(WRAPPER,files['dsh-remote-tuna'],0o700);
  run(['daemon-reload']); run(['enable',RELAY,TUNA]); run(['restart',RELAY,TUNA]);
  console.log('Local health: '+await health('http://127.0.0.1:8787/health'));
  console.log('Public health: '+await health(o.url+'/health'));
  for(const unit of [RELAY,TUNA]) run(['is-active','--quiet',unit]);
  console.log('Services enabled for SSH exit/reboot. Authenticated check remains the Work script; VPS has no bearer keys.');
}
module.exports={MARKER,parse,render,unitQuote,shellQuote,selectUser,safePath,managedTarget,writeManaged,shortPoll,main};
const entryArgs=process.argv[2]==='--dsh-vps-setup-stdin'?process.argv.slice(3):require.main===module?process.argv.slice(2):null;
if(entryArgs!==null) main(entryArgs).catch(e=>{console.error(e.code?'Setup failed: filesystem/process preflight error (no sensitive details printed).':e.message);process.exitCode=1;});
DSH_VPS_NODE
