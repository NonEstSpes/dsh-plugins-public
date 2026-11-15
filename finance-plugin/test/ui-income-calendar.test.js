import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { evaluateIncome } from '../lib/finance-core.js';
import { FinanceRepository } from '../lib/repository.js';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const income = source.slice(source.indexOf('        function Income('), source.indexOf('        function Goals('));
const vocabulary = source.slice(source.indexOf('    const words = {'), source.indexOf('    const EMPTY = {'));
const dictionary = runInNewContext(`${vocabulary}\ndictionaries.ru;`, {}, { timeout: 1000 });
const helpers = source.slice(source.indexOf('    function decimal('), source.indexOf('    function localMonth('));
const buildStart = income.indexOf('          const build = ');
const buildEnd = income.indexOf('\n          const submitModel', buildStart);
const loadStart = income.indexOf('setForm(m ?');
const loadEnd = income.indexOf(' : empty());', loadStart) + ' : empty());'.length;
assert.ok(buildStart >= 0 && buildEnd > buildStart && loadStart >= 0 && loadEnd > loadStart);
const t = key => dictionary[key] || key;
const plain = value => JSON.parse(JSON.stringify(value));
const build = form => plain(runInNewContext(`${helpers}\n${income.slice(buildStart, buildEnd)}\nbuild();`, { form, t }, { timeout: 1000 }));
const load = m => plain(runInNewContext(`${helpers}\nlet loaded; const setForm = value => { loaded = value; }; const empty = () => ({});\n${income.slice(loadStart, loadEnd)}\nloaded;`, { m }, { timeout: 1000 }));
const form = (overrides = {}) => ({ name: 'Synthetic income', effectiveFrom: '2026-11', salary: '48000', worked: '100', taxRate: '13', taxRateDefined: true, deductions: '0', payoutDay: '10', components: [], ...overrides });
const component = (overrides = {}) => ({ id: 'bonus', label: 'Synthetic bonus', type: 'percent_base', value: '130', multiplier: '1', guaranteed: true, enabled: true, frequency: 'quarterly', payoutMonths: '1,4,7,10', minValue: '100', maxValue: '200', ...overrides });

// Evaluate only pure form transforms; never mount the Client, connect a service or open a database.
test('Income form serializes explicit flat tax, separate range endpoints and quarterly calendar', () => {
  const input = form({ components: [component({ id: 'monthly', value: '25', frequency: 'monthly', minValue: '', maxValue: '', payoutMonths: '' }), component()] });
  const before = structuredClone(input);
  const model = build(input);
  assert.equal(model.taxRateBps, 1300);
  assert.deepEqual(model.components[1], { id: 'bonus', label: 'Synthetic bonus', type: 'percent_base', value: 130, multiplier: 1, guaranteed: true, enabled: true, frequency: 'quarterly', payoutMonths: [1, 4, 7, 10], minValue: 100, maxValue: 200 });
  assert.ok(!Object.hasOwn(model.components[0], 'minValue'));
  assert.ok(!Object.hasOwn(model.components[0], 'maxValue'));
  assert.ok(!Object.hasOwn(model.components[0], 'payoutMonths'));
  assert.equal(evaluateIncome(model, 'base', { month: '2026-11' }).netMinor, 5_220_000);
  assert.equal(evaluateIncome(model, 'base', { month: '2026-01' }).netMinor, 10_648_800);
  assert.deepEqual(input, before);
  assert.equal(build(form({ taxRate: '0,29' })).taxRateBps, 29, 'decimal percent converts to integer bps without binary multiplication');
});

test('Income form converts fixed ruble endpoints and supports clearing optional bounds', () => {
  const model = build(form({ components: [component({ type: 'fixed', value: '1000,25', minValue: '900,01', maxValue: '2000,50' })] }));
  assert.equal(model.components[0].value, 100025);
  assert.equal(model.components[0].minValue, 90001);
  assert.equal(model.components[0].maxValue, 200050);
  const noBounds = build(form({ components: [component({ minValue: '', maxValue: '  ' })] })).components[0];
  assert.ok(!Object.hasOwn(noBounds, 'minValue'));
  assert.ok(!Object.hasOwn(noBounds, 'maxValue'));
  for (const patch of [{ value: '100-200' }, { minValue: '100-200' }, { maxValue: '100-200' }, { payoutMonths: '1,,7,10' }, { payoutMonths: '1,4,7,13' }]) assert.throws(() => build(form({ components: [component(patch)] })));
});

test('Loaded quarterly, tax and fixed endpoint fields round-trip without mutation', () => {
  const saved = { ...build(form({ components: [component({ type: 'fixed', value: '1000,25', minValue: '900,01', maxValue: '2000,50' })] })), id: 'saved-model', version: 1 };
  const before = structuredClone(saved);
  const loaded = load(saved);
  assert.equal(loaded.taxRate, '13,00');
  assert.equal(loaded.taxRateDefined, true);
  assert.equal(loaded.components[0].frequency, 'quarterly');
  assert.equal(loaded.components[0].payoutMonths, '1,4,7,10');
  assert.equal(loaded.components[0].minValue, '900,01');
  assert.equal(loaded.components[0].maxValue, '2000,50');
  const rebuilt = build(loaded);
  assert.equal(rebuilt.taxRateBps, saved.taxRateBps);
  assert.deepEqual(rebuilt.components, saved.components);
  assert.deepEqual(saved, before);
});

test('New models default explicitly to 13% and new components monthly; old missing tax remains legacy zero', () => {
  const emptyStart = income.indexOf('const empty = ');
  const emptyEnd = income.indexOf('; const [form, setForm]', emptyStart);
  const empty = plain(runInNewContext(`${income.slice(emptyStart, emptyEnd)}; empty();`, { localMonth: () => '2026-11' }, { timeout: 1000 }));
  assert.equal(empty.taxRate, '13');
  assert.equal(empty.taxRateDefined, true);
  assert.match(income, /minValue: '', maxValue: '', frequency: 'monthly', payoutMonths: ''/);
  const legacy = build(form({ components: [component({ frequency: 'monthly', minValue: '', maxValue: '', payoutMonths: '' })] }));
  delete legacy.taxRateBps;
  delete legacy.components[0].frequency;
  const loaded = load(legacy);
  assert.equal(loaded.taxRate, '0,00');
  assert.equal(loaded.taxRateDefined, false);
  assert.equal(loaded.components[0].frequency, 'monthly');
  assert.equal(loaded.components[0].minValue, '');
  assert.equal(loaded.components[0].maxValue, '');
  assert.ok(!Object.hasOwn(build(loaded), 'taxRateBps'));
  assert.equal(evaluateIncome(build(loaded)).taxMinor, 0);
  assert.match(income, /key === 'taxRate' \? \{ taxRateDefined: true \}/);
});

test('Income preview sends calculation month with cash mode and displays tax and other deductions', () => {
  assert.ok(income.includes("api('income.calculate', { model: build(), scenario, month: period, mode: 'cash' })"));
  assert.ok(income.includes("label: t('incomeCalculationMonth')"));
  assert.ok(income.includes("h(MonthPicker, { value: period, required: true, t, onChange: value => { setPeriod(value); setCalculation(null); setModelFeedback(null); } })"));
  assert.ok(income.includes('money(calculation.taxMinor ?? 0)'));
  assert.ok(income.includes('money(calculation.deductionsMinor ?? 0)'));
  assert.ok(income.includes("t('incomeTaxPolicy')"));
  assert.match(dictionary.incomeTaxPolicy, /плоская ставка.*не полный расчёт прогрессивного НДФЛ/);
  assert.match(dictionary.incomeRangeHelp, /Минимум и максимум задайте отдельно/);
  assert.match(dictionary.incomePayoutMonthsHelp, /ровно четыре разных/);
  assert.ok(income.includes("['minValue', 'maxValue'].map(key => { const valueError"));
  assert.ok(income.includes("'aria-invalid': !!valueError"));
  assert.ok(income.includes('input.setCustomValidity(valueError)'));
});

test('Repository saveIncome persists tax only when explicitly supplied, using isolated object storage', () => {
  const rows = new Map();
  const repository = Object.create(FinanceRepository.prototype);
  Object.assign(repository, {
    get: (collection, id) => rows.get(`${collection}:${id}`),
    put: (collection, value) => rows.set(`${collection}:${value.id}`, structuredClone(value)),
    atomic: fn => fn(), changed() {}, audit() {}, now: () => '2026-11-10T12:00:00.000Z',
  });
  const args = build(form({ components: [component()] }));
  const calculation = evaluateIncome(args, 'base', { month: args.effectiveFrom });
  const saved = repository.saveIncome(args, calculation, 'synthetic-test');
  assert.equal(saved.model.taxRateBps, 1300);
  assert.equal(rows.get(`incomeModels:${saved.model.id}`).taxRateBps, 1300);
  assert.deepEqual(saved.model.components, args.components);
  assert.equal(saved.calculation, calculation);
  const legacy = { ...args }; delete legacy.taxRateBps;
  const old = repository.saveIncome(legacy, evaluateIncome(legacy), 'synthetic-test');
  assert.ok(!Object.hasOwn(old.model, 'taxRateBps'));
  assert.ok(!Object.hasOwn(rows.get(`incomeModels:${old.model.id}`), 'taxRateBps'));
  const zero = repository.saveIncome({ ...legacy, taxRateBps: 0 }, calculation, 'synthetic-test');
  assert.equal(zero.model.taxRateBps, 0);
  for (const taxRateBps of [null, -1, 10001, 13.5, '1300']) assert.throws(() => repository.saveIncome({ ...args, taxRateBps }, calculation, 'synthetic-test'));
});
