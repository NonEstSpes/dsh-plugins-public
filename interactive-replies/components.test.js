import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { wrapVueESM } from './build-vue.mjs';
import { registerComponents, COMPONENT_CSS, catalogClone, catalogInitialValues, catalogTableRows, catalogChartData, catalogLinePoints, catalogSummary, catalogSubmission, catalogOptions } from './components.js';
import { COMPONENT_CATALOG, catalogGuide } from './catalog-info.js';
import { validateFields as backendValidateFields } from './validation.js';

// Exact browser runtime/compiler used by build.mjs; no document, simulated DOM,
// fake Vue, manually invoked setup, mount, network, or private client modules.
const source = await readFile(new URL('./node_modules/vue/dist/vue.esm-browser.prod.js', import.meta.url), 'utf8');
const Vue = new Function(wrapVueESM(source) + '\nreturn Vue;')();
const names = ['Card', 'Row', 'Columns', 'Tabs', 'Tab', 'Stat', 'Chips', 'Progress', 'Steps', 'Table', 'Bars', 'Line', 'Donut', 'Field', 'Form', 'Button'];
function context() {
  return { t: key => key, readonly: Vue.readonly(Vue.ref(false)), submitted: Vue.readonly(Vue.ref(null)), fields: Vue.readonly(Vue.ref([])), draft: Vue.reactive({}), reply: async () => true, validateFields: () => ({ ok: true, errors: [] }) };
}

test('registerComponents registers exactly the documented names on a real Vue app', () => {
  const app = Vue.createApp({ render: () => null }), ctx = context();
  const registered = registerComponents(app, Vue, ctx);
  assert.deepEqual(Object.keys(registered).sort(), [...names].sort());
  assert.deepEqual(Object.keys(COMPONENT_CATALOG).sort(), [...names].sort());
  assert.deepEqual(ctx.draft, {}); // Registration alone does not initialize or send anything.
  for (const name of names) {
    assert.equal(app.component(name), registered[name]);
    assert.deepEqual(Object.keys(registered[name].props || {}).sort(), [...COMPONENT_CATALOG[name].props].sort(), name);
    assert.equal(registered[name].name, name);
  }
  const second = Vue.createApp({ render: () => null });
  assert.equal(second.component('Card'), undefined); // No global registration.
});

test('actual Vue compiler accepts every documented example and form/tab compositions', () => {
  for (const entry of Object.values(COMPONENT_CATALOG)) assert.equal(typeof Vue.compile(entry.example), 'function', entry.example);
  const template = `<Card title="Review"><Columns :count="2"><Tabs id="draft"><Tab name="a" label="Edit"><Form :actions="false" v-slot="{values,errors}"><Field name="n" type="number" :min="0"/><Row><Button type="submit">Send</Button><Button type="reset">Reset</Button></Row></Form></Tab><Tab name="b" label="Read" disabled><Table :columns="columns" :rows="rows" v-model="selection" selectable send-selection/></Tab></Tabs><Line title="Values" :data="points"/></Columns></Card>`;
  assert.equal(typeof Vue.compile(template), 'function');
});

test('guide is bounded, deferred, exact-name based and safe for inherited property names', () => {
  assert.ok(catalogGuide().length <= 1800);
  assert.match(catalogGuide(), /only Form submit, Button send, or Table sendSelection/);
  for (const name of names) {
    const guide = catalogGuide(name);
    assert.ok(guide.length <= 4000);
    assert.ok(guide.includes(COMPONENT_CATALOG[name].example));
    assert.match(guide, /Props:/);
  }
  assert.match(catalogGuide('__proto__'), /^Unknown component/);
  assert.match(catalogGuide('toString'), /^Unknown component/);
  assert.ok(catalogGuide('x'.repeat(10000)).length < 500);
});

test('primitive and labeled options normalize without coercing typed values or mutating input', () => {
  const labeled = { label: 'Custom zero', value: 0 }, input = ['0', 0, false, true, '', labeled];
  const options = catalogOptions(input);
  assert.deepEqual(options, [{ label: '0', value: '0' }, { label: '0', value: 0 }, { label: 'false', value: false }, { label: 'true', value: true }, { label: '', value: '' }, { label: 'Custom zero', value: 0 }]);
  assert.notEqual(options.at(-1), labeled);
  options.at(-1).label = 'Changed'; assert.equal(labeled.label, 'Custom zero');
  assert.deepEqual(catalogOptions(undefined), []);
});

test('primitive option types and empty option survive real backend submission and summary lookup', () => {
  const fields = [
    { name: 'select', type: 'select', options: [0, '0', false, ''] },
    { name: 'radio', type: 'radio', options: [true, false] },
    { name: 'segment', type: 'segmented', options: [1, '1'] },
    { name: 'checks', type: 'checks', options: [0, '0', false, { label: 'Named', value: 'named' }] },
  ];
  const values = { select: '', radio: false, segment: 1, checks: [0, '0', false, 'named'] };
  const result = catalogSubmission(fields, values, backendValidateFields);
  assert.equal(result.ok, true); assert.deepEqual(result.values, values);
  assert.equal(result.summary, 'select: ; radio: false; segment: 1; checks: 0, 0, false, Named');
  for (const value of [0, '0', false, '']) assert.equal(catalogSubmission(fields, { ...values, select: value }, backendValidateFields).values.select, value);
});

test('schema defaults and submitted values preserve typed scalar and array data', () => {
  const fields = [
    { name: 'name', type: 'text', initial: 'Ada' },
    { name: 'n', type: 'number', initial: 0 },
    { name: 'range', type: 'slider' },
    { name: 'enabled', type: 'switch' },
    { name: 'selected', type: 'checks', initial: [false, 0, '0'] },
    { name: 'choice', type: 'select', initial: false },
    { name: 'notes', type: 'textarea' },
    { name: 'when', type: 'date', initial: '2026-01-01' },
  ];
  const initial = catalogInitialValues(fields);
  assert.equal(initial.name, 'Ada'); assert.equal(initial.n, 0); assert.equal(initial.range, null);
  assert.equal(initial.enabled, false); assert.equal(initial.choice, false); assert.equal(initial.notes, '');
  assert.deepEqual(initial.selected, [false, 0, '0']);
  initial.selected.push('new'); assert.equal(fields[4].initial.length, 3);
  const restored = catalogInitialValues(fields, { name: '', n: 4, enabled: true, selected: [], choice: 0, unknown: 'discard' });
  assert.equal(restored.name, ''); assert.equal(restored.n, 4); assert.equal(restored.enabled, true); assert.equal(restored.choice, 0);
  assert.deepEqual(restored.selected, []); assert.equal(Object.hasOwn(restored, 'unknown'), false);
  assert.equal(restored.when, '2026-01-01');
});

test('schema names cannot mutate object prototypes and copied arrays are independent', () => {
  const fields = [{ name: '__proto__', initial: 'safe' }, { name: 'constructor', initial: 'value' }, { name: 'checks', type: 'checks' }];
  const values = catalogInitialValues(fields);
  assert.equal(Object.getPrototypeOf(values), null);
  assert.equal(values.__proto__, 'safe'); assert.equal(values.constructor, 'value');
  const clone = catalogClone(values); assert.equal(Object.hasOwn(clone, '__proto__'), true);
  clone.checks.push(1); assert.deepEqual(values.checks, []);
});

test('actual Vue reactivity observes persisted form edits without coercing option types', () => {
  const draft = Vue.reactive({ form: catalogInitialValues([{ name: 'n', initial: 1 }, { name: 'choice', initial: false }]) });
  const doubled = Vue.computed(() => draft.form.n * 2);
  let serialized = '';
  const stop = Vue.watch(draft, value => { serialized = JSON.stringify(value); }, { deep: true, flush: 'sync' });
  assert.equal(doubled.value, 2); draft.form.n = 4; draft.form.choice = 0;
  assert.equal(doubled.value, 8); assert.equal(JSON.parse(serialized).form.choice, 0);
  draft.form = catalogInitialValues([{ name: 'n', initial: 2 }]);
  assert.equal(doubled.value, 4); stop();
});

test('submission preparation validates exact schema against a detached JSON snapshot', () => {
  const fields = [{ name: 'choice', label: 'Choice', type: 'select', options: [{ label: 'No', value: false }, { label: 'Zero', value: 0 }] }, { name: 'tags', label: 'Tags', type: 'checks', options: [{ label: 'One', value: 1 }] }];
  const values = Vue.reactive({ choice: false, tags: [1] });
  let calls = 0;
  const prepared = catalogSubmission(fields, values, (schema, snapshot) => {
    calls++; assert.equal(schema, fields); assert.notEqual(snapshot, values); assert.equal(Vue.isReactive(snapshot), false);
    assert.equal(snapshot.choice, false); return { ok: true, errors: [] };
  });
  assert.equal(calls, 1); assert.equal(prepared.ok, true); assert.equal(prepared.summary, 'Choice: No; Tags: One');
  values.tags.push(2); assert.deepEqual(prepared.values.tags, [1]);
  const rejected = catalogSubmission(fields, {}, () => ({ ok: false, errors: [{ name: 'choice', code: 'required' }] }));
  assert.equal(rejected.ok, false); assert.deepEqual(rejected.errors, [{ name: 'choice', code: 'required' }]);
  assert.equal(catalogSubmission([], {}, () => ({ ok: true }), 'Human summary').summary, 'Human summary');
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => catalogSubmission([], cyclic, () => { throw new Error('must not validate'); }), /circular/i);
  for (const invalid of [NaN, Infinity, undefined, () => {}, Symbol('invalid')]) assert.throws(() => catalogSubmission([{ name: 'n', type: 'number' }], { n: invalid }, backendValidateFields), /Expected JSON/);
});

test('human summary preserves typed option labels and is bounded', () => {
  const fields = [{ name: 'x', label: 'Answer', options: [{ label: 'Boolean', value: false }, { label: 'Number', value: 0 }, { label: 'String', value: '0' }] }];
  assert.equal(catalogSummary(fields, { x: [false, 0, '0'] }), 'Answer: Boolean, Number, String');
  assert.equal(catalogSummary([{ name: 'x' }], { x: 'a'.repeat(9000) }).length, 2000);
  assert.equal(catalogSummary([{ name: 'absent' }], {}), '');
  assert.equal(catalogSubmission([], {}, backendValidateFields, 's'.repeat(3000)).summary.length, 2000);
});

test('actual backend accepts omitted optional UI sentinels while draft and valid scalar values stay intact', () => {
  const fields = [
    { name: 'n', type: 'number' }, { name: 'slider', type: 'slider' },
    { name: 'select', type: 'select', options: [{ label: 'One', value: 1 }] },
    { name: 'radio', type: 'radio', options: [{ label: 'No', value: false }] },
    { name: 'segment', type: 'segmented', options: [{ label: 'Text', value: 'x' }] },
    { name: 'text', type: 'text', minLength: 2 }, { name: 'notes', type: 'textarea', minLength: 3 },
    { name: 'date', type: 'date', minLength: 10 }, { name: 'time', type: 'time', minLength: 5 },
    { name: 'validEmpty', type: 'select', options: [{ label: 'Empty', value: '' }, { label: 'No', value: false }] },
    { name: 'zero', type: 'number', initial: 0 }, { name: 'off', type: 'switch' },
    { name: 'checks', type: 'checks', options: [{ label: 'Zero', value: 0 }] },
    { name: 'blank', type: 'text' },
  ];
  const draft = catalogInitialValues(fields), prepared = catalogSubmission(fields, draft, backendValidateFields);
  assert.equal(backendValidateFields(fields, draft).ok, false);
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.values, { validEmpty: '', zero: 0, off: false, checks: [], blank: '' });
  assert.equal(draft.n, null); assert.equal(draft.select, ''); assert.equal(draft.text, '');
  assert.equal(prepared.summary.includes('select:'), false);
  const typed = catalogSubmission(fields, { radio: false, select: 1, zero: 0, off: false, checks: [0] }, backendValidateFields);
  assert.equal(typed.ok, true); assert.equal(typed.values.radio, false); assert.equal(typed.values.select, 1);
});

test('actual backend still receives required sentinels, invalid nonempty values and unknown names', () => {
  const fields = [
    { name: 'n', type: 'number', required: true },
    { name: 'choice', type: 'select', required: true, options: [{ label: 'Yes', value: true }] },
    { name: 'text', type: 'text', required: true, minLength: 2 },
    { name: 'date', type: 'date' }, { name: 'time', type: 'time' },
  ];
  const values = { ...catalogInitialValues(fields), date: 'not-a-date', time: '25:00', unknown: 0 };
  const result = catalogSubmission(fields, values, backendValidateFields);
  assert.equal(result.ok, false); assert.deepEqual(result.values, values);
  for (const [name, code] of [['n', 'type'], ['choice', 'option'], ['text', 'required'], ['text', 'minLength'], ['date', 'date'], ['time', 'time'], ['unknown', 'unknown']]) assert.ok(result.errors.some(error => error.name === name && error.code === code), `${name}:${code}`);
  const optional = [{ name: 'n', type: 'number' }, { name: 'text', type: 'text', minLength: 3 }];
  const malformed = catalogSubmission(optional, { n: 'bad', text: ' ' }, backendValidateFields);
  assert.equal(malformed.ok, false); assert.equal(malformed.values.n, 'bad'); assert.equal(malformed.values.text, ' ');
  assert.equal(catalogSubmission([], null, backendValidateFields).ok, true); // Unstructured reply contract.
});

test('table search/sort is local, bounded, stable and keeps source-row identity', () => {
  const columns = [{ key: 'name' }, { key: 'score' }];
  const rows = [{ id: 'a', name: 'Beta', score: 10 }, { id: 'b', name: 'Ada', score: 2 }, { id: 'c', name: 'Gamma', score: 2 }];
  assert.deepEqual(catalogTableRows(rows, columns, '', 'score').map(item => item.row.id), ['b', 'c', 'a']);
  assert.deepEqual(catalogTableRows(rows, columns, '', 'score', -1).map(item => item.row.id), ['a', 'b', 'c']);
  const result = catalogTableRows(rows, columns, 'ADA', 'score');
  assert.equal(result.length, 1); assert.equal(result[0].row, rows[1]); assert.equal(result[0].index, 1);
  assert.deepEqual(rows.map(row => row.id), ['a', 'b', 'c']);
  const many = Array.from({ length: 550 }, (_, id) => ({ id, name: String(id) }));
  assert.equal(catalogTableRows(many, columns).length, 500);
  assert.equal(catalogTableRows(many, columns, '549').length, 0);
  assert.deepEqual(catalogTableRows(null, columns), []);
});

test('chart normalization is bounded, finite and does not mutate inputs', () => {
  const input = [{ label: 'Negative', value: -2 }, { label: 'NaN', value: NaN }, { label: 'Infinite', value: Infinity }, { label: 'String', value: '3' }, { label: 'Positive', value: 4 }];
  assert.deepEqual(catalogChartData(input).map(item => item.value), [-2, 0, 0, 0, 4]);
  assert.equal(input[3].value, '3'); assert.equal(catalogChartData(Array(300).fill({ label: 'a', value: 1 })).length, 200);
  assert.deepEqual(catalogChartData(null), []);
  for (const data of [[], [{ value: 0 }], [{ value: -2 }, { value: 4 }], [{ value: -1e308 }, { value: 1e308 }]]) {
    const points = catalogLinePoints(data);
    assert.equal(points.length, data.length);
    assert.ok(points.flat().every(Number.isFinite));
    assert.ok(points.every(([x, y]) => x >= 10 && x <= 290 && y >= 10 && y <= 90));
  }
});

test('catalog source stays import-free and CSS avoids host card selectors and fixed colors', async () => {
  for (const filename of ['components.js', 'catalog-info.js']) {
    const code = await readFile(new URL(filename, import.meta.url), 'utf8');
    assert.doesNotMatch(code, /^import\s/m);
    assert.doesNotThrow(() => new Function(code.replace(/^export /gm, '')));
    assert.doesNotMatch(code, /fetch\(|XMLHttpRequest|localStorage|document\.|window\./);
  }
  assert.doesNotMatch(COMPONENT_CSS, /\.ir-card\b|#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i);
  assert.match(COMPONENT_CSS, /--dsw-alias-brand-primary/);
  assert.match(COMPONENT_CSS, /@media/);
});
