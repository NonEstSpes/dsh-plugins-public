// Owned, read-only-production diagnostic: real installed Vue SSR. No DOM/mocks.
import assert from 'node:assert/strict';
import * as Vue from './node_modules/.pnpm/vue@3.5.22/node_modules/vue/index.mjs';
import { renderToString } from './node_modules/.pnpm/@vue+server-renderer@3.5.22_vue@3.5.22/node_modules/@vue/server-renderer/index.js';
import { prepareComponent } from './runtime.js';

console.log('IMPORT_OK', JSON.stringify({ vue: Vue.version, renderToString: typeof renderToString, compile: typeof Vue.compile }));
function bridge(data, saved = {}) {
  return { isReadonly: () => false, getSubmission: () => null, getData: () => data,
    loadDraft: () => saved, subscribe: () => () => {}, saveDraft() {}, reply: async () => true };
}
async function run(name, spec, liveBridge) {
  const errors = [], warnings = [];
  const app = Vue.createSSRApp(prepareComponent(Vue, spec, liveBridge));
  app.config.errorHandler = (error, instance, info) => errors.push({ message: error.message, info });
  app.config.warnHandler = message => warnings.push(message);
  let html, thrown;
  try { html = await renderToString(app); } catch (error) { thrown = error.message; }
  console.log(name, JSON.stringify({html, errors, warnings, thrown}));
  return { html, errors, warnings, thrown };
}
const simple = { template: '<p>{{data.status}}</p>', script: 'return {}', data: {status: 'ready'} };
const a = await run('baseline', simple, bridge(simple.data));
assert.equal(a.html, '<p>ready</p>'); assert.deepEqual(a.errors, []); assert.equal(a.thrown, undefined);
const b = await run('draft-and-catalog', {
  template: '<Card title="Stage 2"><p>{{data.status}}:{{count}}</p></Card>',
  script: "const count = useDraft('count', 2); return {count}", data: {status:'ready'}
}, bridge({status:'ready'}, {custom:{count:7}}));
assert.match(b.html, /ready:7/); assert.deepEqual(b.errors, []); assert.equal(b.thrown, undefined);
const c = await run('setup-error-overwrite', {...simple, script: 'throw new Error("PRIMARY_SETUP_FAILURE")'}, bridge(simple.data));
assert.equal(c.errors[0]?.message, 'PRIMARY_SETUP_FAILURE');
assert.match(c.thrown ?? c.errors.at(-1)?.message ?? '', /status/);
console.log('ALL_ASSERTIONS_PASSED');
