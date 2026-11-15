import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compileSetup, createDraftBinding, readExecutionPreference, shouldAutoRun, AUTO_RUN_NEW_DEFAULT } from './runtime.js';
// Exercise the exact self-contained browser compiler shipped in the plugin.
// No window/document, DOM shim, mount, React mock, or visual assertion is used.
import { wrapVueESM } from './build-vue.mjs';
const vueSource = await readFile(new URL('./node_modules/vue/dist/vue.esm-browser.prod.js', import.meta.url), 'utf8');
const Vue = new Function(wrapVueESM(vueSource) + '\nreturn Vue;')();
import { DEMO as demo } from './index.js';
function runSetup(script, reply, locked = false, submission = null, saved = {}) {
  const draft = Vue.reactive({ custom: saved });
  return compileSetup(Vue, script)(Vue, reply, () => {}, Vue.ref(locked), Vue.ref(submission), Vue.ref({}), draft, Vue.ref([]), (key, initial) => createDraftBinding(Vue, draft, key, initial), new AbortController().signal);
}
test('new Session defaults to autorun without overwriting saved per-Session choices',()=>{
  assert.equal(AUTO_RUN_NEW_DEFAULT,true);
  const saved=new Map([['local.interactive-replies.execution:paused','paused'],['local.interactive-replies.execution:auto','auto'],['local.interactive-replies.execution:invalid','other']]);
  const storage={getItem:key=>saved.get(key)??null,setItem(){throw new Error('Must not write preferences while reading');}};
  assert.equal(readExecutionPreference(storage,'new'),true);assert.equal(readExecutionPreference(storage,'paused'),false);assert.equal(readExecutionPreference(storage,'auto'),true);assert.equal(readExecutionPreference(storage,'invalid'),false);assert.equal(saved.size,3);
  assert.equal(readExecutionPreference({getItem(){throw Error('Storage denied');}},'new'),false);
});
test('autorun still excludes history, structural replacements, inherited and submitted cards',()=>{
  const spec={sessionId:'s',createdAt:101,revision:1},options={sessionId:'s',submission:null,startedAt:100,enabled:true};
  assert.equal(shouldAutoRun(spec,options),true);
  for(const changed of [{createdAt:99},{revision:2},{sessionId:'parent'}])assert.equal(shouldAutoRun({...spec,...changed},options),false);
  assert.equal(shouldAutoRun(spec,{...options,enabled:false}),false);assert.equal(shouldAutoRun(spec,{...options,submission:{values:{}}}),false);
});
test('actual Vue compiler accepts the shipped pilot template', () => { const render = Vue.compile(demo.template); assert.equal(typeof render, 'function'); });
test('actual Vue refs/computed drive demo values and reply', async () => {
  let result;
  const bindings = runSetup(demo.script, async (values, summary) => { result = {values,summary}; return true; });
  assert.equal(bindings.doubled.value, 0);
  bindings.count.value = 3; bindings.name.value = 'Пример';
  assert.equal(bindings.doubled.value, 6);
  await bindings.send();
  assert.deepEqual(result.values, {count:3,name:'Пример',doubled:6});
  assert.match(result.summary, /Пример/);
});
test('submitted demo reconstructs saved values and readonly prevents reply',async()=>{
  let calls=0;
  const bindings=runSetup(demo.script,async()=>calls++,true,{values:{count:7,name:'Пример'}});
  assert.equal(bindings.count.value,7);assert.equal(bindings.doubled.value,14);
  await bindings.send();assert.equal(calls,0);
});
test('JavaScript setup syntax errors are surfaced',()=>{assert.throws(()=>compileSetup(Vue,'const = broken'),SyntaxError);});
test('useDraft persists explicit state in a real Vue writable computed',()=>{
  const draft=Vue.reactive({custom:{count:7}});
  const count=createDraftBinding(Vue,draft,'count',0);
  assert.equal(count.value,7);count.value=9;assert.equal(draft.custom.count,9);
  assert.equal(createDraftBinding(Vue,draft,'count',1).value,9);
  for(const key of ['__proto__','constructor','prototype','bad key',''])assert.throws(()=>createDraftBinding(Vue,draft,key,0));
});
test('extended setup contract exposes shared readonly data, fields and AbortSignal',()=>{
  const source='const total=computed(()=>data.value.points.length); return {total,fields,signal};';
  const data=Vue.ref({points:[1,2]});const controller=new AbortController();
  const bindings=compileSetup(Vue,source)(Vue,()=>{},()=>{},Vue.ref(false),Vue.ref(null),Vue.readonly(data),Vue.reactive({}),Vue.ref([]),()=>{},controller.signal);
  assert.equal(bindings.total.value,2);data.value={points:[1,2,3]};assert.equal(bindings.total.value,3);
  controller.abort();assert.equal(bindings.signal.aborted,true);
});
test('legacy and versioned Client entries contain the identical current runtime',async()=>{
  const manifest=JSON.parse(await readFile(new URL('package.json',import.meta.url),'utf8'));
  const legacy=await readFile(new URL('client.js',import.meta.url),'utf8');
  const current=await readFile(new URL(manifest.exports['./client'],import.meta.url),'utf8');
  assert.equal(legacy,current);assert.ok(current.startsWith('// Interactive Replies '+manifest.version+';'));
  assert.match(current,/function createDraftBinding/);assert.match(current,/function createRuntimeErrorReporter/);assert.match(current,/getData\(\)/);
});
test('Client and catalog use only inspected DSH theme tokens', async()=>{
  const allowed=new Set(['--dsw-alias-bg-base','--dsw-alias-bg-layer-1','--dsw-alias-bg-layer-2','--dsw-alias-bg-overlay','--dsw-alias-border-l1','--dsw-alias-border-l2','--dsw-alias-brand-primary','--dsw-alias-label-primary','--dsw-alias-label-secondary','--dsw-alias-state-error-primary','--dsw-alias-state-idle-primary','--dsw-alias-state-success-primary','--dsw-alias-state-warn-primary','--dsw-specific-sidebar-fill']);
  for(const file of ['client-core.js','components.js']){const source=await readFile(new URL(file,import.meta.url),'utf8');for(const match of source.matchAll(/var\((--dsw-[\w-]+)/g))assert.ok(allowed.has(match[1]),match[1]);}
});
test('localized Client/catalog literal labels and validation codes exist in both dictionaries',async()=>{
  const sources=await Promise.all(['client-core.js','components.js'].map(file=>readFile(new URL(file,import.meta.url),'utf8')));
  const keys=new Set(sources.flatMap(source=>[...source.matchAll(/\b(?:t|text)\(['"]([^'"]+)['"]\s*\)/g)].map(match=>match[1])));
  for(const code of ['required','type','min','max','step','minLength','maxLength','date','time','option','unknown','schema'])keys.add('validation.'+code);
  for(const language of ['ru','en']){const dict=JSON.parse(await readFile(new URL('locale/'+language+'.json',import.meta.url),'utf8'));for(const key of keys)assert.equal(typeof dict[key],'string',language+': '+key);}
});
test('custom JavaScript and named Vue helpers are not restricted to catalog components',()=>{
  const script=compileSetup(Vue,'const amount=ref(4); const squared=computed(()=>amount.value ** 2); return {amount,squared,custom:Math.max(8,9)};');
  const bindings=script(Vue,()=>{},()=>{},Vue.ref(false),Vue.ref(null));
  assert.equal(bindings.squared.value,16);bindings.amount.value=5;assert.equal(bindings.squared.value,25);assert.equal(bindings.custom,9);
});
