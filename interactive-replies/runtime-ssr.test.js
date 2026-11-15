// Real installed Vue SSR integration: no browser/DOM emulation or visual claim.
import test from 'node:test';
import assert from 'node:assert/strict';
// Explicit pinned paths avoid Windows pnpm-junction resolution in this checkout.
import * as Vue from './node_modules/.pnpm/vue@3.5.22/node_modules/vue/index.mjs';
import { renderToString } from './node_modules/.pnpm/@vue+server-renderer@3.5.22_vue@3.5.22/node_modules/@vue/server-renderer/index.js';
import { prepareComponent, createRuntimeErrorReporter } from './runtime.js';
async function render(spec, draft = {}) {
  const errors=[];
  const bridge={isReadonly:()=>false,getSubmission:()=>null,getData:()=>spec.data,loadDraft:()=>draft,subscribe:()=>()=>{},saveDraft(){},reply:async()=>{throw Error('No fabricated user submission');},t:key=>key};
  const app=Vue.createSSRApp(prepareComponent(Vue,spec,bridge));
  app.config.errorHandler=createRuntimeErrorReporter(message=>errors.push(message));
  app.config.warnHandler=()=>{};
  return {html:await renderToString(app),errors};
}
test('real Vue setup and render expose readonly data.status',async()=>{
  const result=await render({template:'<p>{{data.status}}</p>',script:'return {};',data:{status:'ready'}});
  assert.equal(result.html,'<p>ready</p>');assert.deepEqual(result.errors,[]);
});
test('real Vue catalog, tabs, fields, computed and saved useDraft render together',async()=>{
  const result=await render({template:'<Tabs id="test"><Tab name="main" label="Main"><Card title="Stage 2"><Chips :items="[data.status]"/><p>{{count}}:{{doubled}}</p></Card></Tab><Tab name="form" label="Form"><Form/></Tab></Tabs>',script:"const count=useDraft('count',2);const doubled=computed(()=>count.value*2);return {count,doubled};",data:{status:'ready'},fields:[{name:'name',type:'text',label:'Name',placeholder:'Your name',required:true},{name:'mode',type:'select',options:[0,false,'full'],initial:false}]},{custom:{count:7}});
  assert.match(result.html,/ready/);assert.match(result.html,/7:14/);assert.match(result.html,/Your name/);assert.deepEqual(result.errors,[]);
});
test('real Vue setup failure remains primary instead of secondary undefined data.status',async()=>{
  const result=await render({template:'<p>{{data.status}}</p>',script:'throw new Error("PRIMARY_SETUP_FAILURE");',data:{status:'ready'}});
  assert.deepEqual(result.errors,['PRIMARY_SETUP_FAILURE']);
});
test('explicit JSON null survives actual Vue setup/render',async()=>{
  const result=await render({template:'<p>{{data === null}}</p>',script:'return {};',data:null});
  assert.equal(result.html,'<p>true</p>');assert.deepEqual(result.errors,[]);
});
