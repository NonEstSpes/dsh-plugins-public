import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateIncome, FinanceValidationError, moneyToMinor } from '../lib/finance-core.js';

const model = (overrides = {}) => ({ salaryMinor: 4_800_000, components: [], ...overrides });
const component = (overrides = {}) => ({ id: 'bonus', label: 'Bonus', type: 'percent_base', value: 130, guaranteed: true, ...overrides });
const quarter = (overrides = {}) => component({ frequency: 'quarterly', payoutMonths: [1, 4, 7, 10], minValue: 100, maxValue: 200, ...overrides });
const requestedModel = () => model({ taxRateBps: 1300, components: [
  component({ id: 'monthly', label: 'Monthly', value: 25, frequency: 'monthly' }),
  quarter(),
] });
const legacyTaxWarning = 'Налоги не рассчитываются автоматически: укажите фактические удержания отдельно.';
const legacyOptimisticWarning = 'Дополнительные допущения оптимистичного сценария не заданы; он совпадает с базовым.';
const invalid = (input, scenario = 'base', options) => assert.throws(() => evaluateIncome(input, scenario, options), FinanceValidationError);

// Pure, in-memory fixtures only: no storage, tools, clocks or finance service.
describe('Income calendar: requested flat 13% example', () => {
  test('Regular November and non-payout cash exclude quarterly pay', () => {
    const input = requestedModel();
    for (const options of [{ month: '2026-11', mode: 'regular' }, { month: '2026-11' }, {}]) {
      const result = evaluateIncome(input, 'base', options);
      assert.equal(result.grossMinor, 6_000_000);
      assert.equal(result.taxMinor, 780_000);
      assert.equal(result.netMinor, 5_220_000);
      assert.equal(result.deductionsMinor, 0);
      assert.equal(result.taxRateBps, 1300);
      assert.deepEqual(result.components.map(({ id }) => id), ['base-salary', 'monthly']);
      assert.equal(result.mode, options.month && !options.mode ? 'cash' : 'regular');
      assert.equal(result.month, options.month);
      if (result.mode === 'regular') assert.match(result.warnings.join(' '), /Квартальные начисления исключены/);
      assert.ok(!result.warnings.includes(legacyTaxWarning));
      assert.match(result.warnings.join(' '), /не расчёт прогрессивного НДФЛ/);
    }
  });

  test('January uses base, minimum and maximum from the same one-salary base', () => {
    for (const [scenario, grossMinor, netMinor] of [
      ['base', 12_240_000, 10_648_800],
      ['conservative', 10_800_000, 9_396_000],
      ['optimistic', 15_600_000, 13_572_000],
    ]) {
      const result = evaluateIncome(requestedModel(), scenario, { month: '2026-01' });
      assert.equal(result.grossMinor, grossMinor);
      assert.equal(result.netMinor, netMinor);
      assert.equal(result.taxMinor, grossMinor - netMinor);
      assert.equal(result.mode, 'cash');
      assert.equal(result.month, '2026-01');
      assert.deepEqual(result.components.map(({ amountMinor }) => amountMinor), [4_800_000, 1_200_000, grossMinor - 6_000_000]);
      assert.equal(result.components.at(-1).frequency, 'quarterly');
      if (scenario === 'optimistic') assert.ok(!result.warnings.includes(legacyOptimisticWarning));
    }
  });

  test('Quarterly calendar has exactly four payouts, never twelve monthly bonuses', () => {
    for (let month = 1; month <= 12; month++) {
      const result = evaluateIncome(requestedModel(), 'base', { month: `2026-${String(month).padStart(2, '0')}` });
      const payout = [1, 4, 7, 10].includes(month);
      assert.equal(result.netMinor, payout ? 10_648_800 : 5_220_000, `month ${month}`);
      assert.equal(result.components.some(({ id }) => id === 'bonus'), payout);
    }
    assert.equal(evaluateIncome(requestedModel(), 'base', { month: '2027-01' }).netMinor, 10_648_800);
    assert.equal(evaluateIncome(requestedModel(), 'base', { month: '2026-01', mode: 'regular' }).netMinor, 5_220_000);
  });

  test('Average base is 7029600, explicitly NOT monthly available cash', () => {
    for (const options of [{ mode: 'average' }, { mode: 'average', month: '2026-11' }, { mode: 'average', month: '2026-01' }]) {
      const result = evaluateIncome(requestedModel(), 'base', options);
      assert.equal(result.grossMinor, 8_080_000);
      assert.equal(result.taxMinor, 1_050_400);
      assert.equal(result.netMinor, 7_029_600);
      assert.equal(result.components.at(-1).amountMinor, 2_080_000);
      assert.equal(result.mode, 'average');
      assert.match(result.warnings.join(' '), /НЕ доступные деньги каждого месяца/);
      assert.match(result.warnings.join(' '), /разделены на 3/);
      assert.match(result.warnings.join(' '), /Не используйте среднее как ежемесячный доступный денежный поток/);
    }
  });
});

describe('Legacy income compatibility and ordered rounding', () => {
  test('Legacy monthly formulas, shape and exact warnings remain intact', () => {
    const input = model({ salaryMinor: 10_000_000, deductionsMinor: 501, payoutDay: 31, components: [
      component({ id: 'base-percent', value: 20, guaranteed: undefined }),
      component({ id: 'running-percent', type: 'percent_running', value: 10, guaranteed: undefined }),
    ] });
    const base = evaluateIncome(input);
    assert.equal(base.grossMinor, 13_200_000);
    assert.equal(base.netMinor, 13_199_499);
    assert.deepEqual(base.components, [
      { id: 'base-salary', label: 'Оклад', amountMinor: 10_000_000 },
      { id: 'base-percent', label: 'Bonus', amountMinor: 2_000_000 },
      { id: 'running-percent', label: 'Bonus', amountMinor: 1_200_000 },
    ]);
    assert.deepEqual(base.warnings, [legacyTaxWarning, 'В коротких месяцах день выплаты требует отдельного уточнения.']);
    assert.equal(base.taxMinor, 0);
    assert.equal(base.deductionsMinor, 501);
    assert.equal(base.taxRateBps, 0);
    assert.equal(base.mode, 'regular');
    assert.ok(!Object.hasOwn(base, 'month'));
    const optimistic = evaluateIncome(input, 'optimistic');
    assert.equal(optimistic.netMinor, base.netMinor);
    assert.deepEqual(optimistic.components, base.components);
    assert.deepEqual(optimistic.warnings, [...base.warnings, legacyOptimisticWarning]);
    assert.equal(evaluateIncome(input, 'conservative').grossMinor, 10_000_000);
  });

  test('Legacy half-up component rounding, worked ratio and fixed pay remain unchanged', () => {
    const result = evaluateIncome(model({ salaryMinor: 5, components: [
      component({ id: 'percent', value: 10 }),
      component({ id: 'fixed', type: 'fixed', value: 2, multiplier: 0.25 }),
    ] }));
    assert.deepEqual(result.components.map(({ amountMinor }) => amountMinor), [5, 1, 1]);
    assert.equal(result.grossMinor, 7);
    assert.equal(evaluateIncome(model({ salaryMinor: 10_000, workedRatio: 1 / 3 })).grossMinor, 3333);
    assert.equal(evaluateIncome(model({ salaryMinor: 10_000, workedRatio: 0.5, components: [component({ type: 'fixed', value: 101, multiplier: 2 })] })).grossMinor, 5202);
    assert.equal(evaluateIncome(model({ workedRatio: 0 })).grossMinor, 0);
  });

  test('Running percentages use only selected, already rounded/prorated components in order', () => {
    const input = model({ salaryMinor: 100, components: [
      quarter({ type: 'fixed', value: 60, minValue: 30, maxValue: 90 }),
      component({ id: 'running', type: 'percent_running', value: 50 }),
    ] });
    assert.deepEqual(evaluateIncome(input).components.map(({ amountMinor }) => amountMinor), [100, 50]);
    assert.deepEqual(evaluateIncome(input, 'base', { month: '2026-01' }).components.map(({ amountMinor }) => amountMinor), [100, 60, 80]);
    assert.deepEqual(evaluateIncome(input, 'base', { mode: 'average' }).components.map(({ amountMinor }) => amountMinor), [100, 20, 60]);
    assert.deepEqual(evaluateIncome(input, 'conservative', { mode: 'average' }).components.map(({ amountMinor }) => amountMinor), [100, 10, 55]);
    assert.deepEqual(evaluateIncome(input, 'optimistic', { mode: 'average' }).components.map(({ amountMinor }) => amountMinor), [100, 30, 65]);
    input.components.reverse();
    assert.deepEqual(evaluateIncome(input, 'base', { month: '2026-01' }).components.map(({ amountMinor }) => amountMinor), [100, 50, 60]);
  });

  test('Average division is exact and occurs before a single component rounding', () => {
    assert.equal(evaluateIncome(model({ salaryMinor: 0, components: [quarter({ type: 'fixed', value: 1, minValue: 1, maxValue: 1, multiplier: 1.5 })] }), 'base', { mode: 'average' }).components.at(-1).amountMinor, 1);
    assert.equal(evaluateIncome(model({ salaryMinor: 0, components: [quarter({ type: 'fixed', value: 1, minValue: 1, maxValue: 1, multiplier: 1.49 })] }), 'base', { mode: 'average' }).components.at(-1).amountMinor, 0);
    assert.equal(evaluateIncome(model({ salaryMinor: 0, components: [quarter({ type: 'fixed', value: 1, minValue: 1, maxValue: 1, multiplier: 4.49 })] }), 'base', { mode: 'average' }).components.at(-1).amountMinor, 1);
  });

  test('Legacy malformed formulas, scenarios and arithmetic stay rejected', () => {
    for (const patch of [{ value: '=salary*2' }, { value: Infinity }, { value: -1 }, { value: 10_001 }, { multiplier: 1001 }, { multiplier: NaN }, { guaranteed: 1 }, { enabled: 'yes' }, { type: 'formula' }]) invalid(model({ components: [component(patch)] }));
    invalid(model(), 'unknown');
    invalid(model({ salaryMinor: -1 }));
    invalid(model({ salaryMinor: 0.5 }));
    invalid(model({ workedRatio: 1.01 }));
    invalid(model({ deductionsMinor: -1 }));
    invalid(model({ deductionsMinor: 4_800_001 }));
    invalid(model({ payoutDay: 32 }));
    invalid(model({ components: [component(), component()] }));
    invalid(model({ components: [component({ id: 'base-salary' })] }));
    invalid(model({ components: Array.from({ length: 21 }, (_, i) => component({ id: String(i) })) }));
  });
});

describe('Tax, ranges, strict validation and safety', () => {
  test('Flat tax uses BigInt half-up and additional deductions come strictly after tax', () => {
    assert.equal(evaluateIncome(model({ salaryMinor: 5, taxRateBps: 1000 })).taxMinor, 1);
    assert.equal(evaluateIncome(model({ salaryMinor: 1, taxRateBps: 4999 })).taxMinor, 0);
    assert.equal(evaluateIncome(model({ salaryMinor: 1, taxRateBps: 5000 })).taxMinor, 1);
    const result = evaluateIncome(model({ salaryMinor: 101, taxRateBps: 1300, deductionsMinor: 7 }));
    assert.equal(result.taxMinor, 13);
    assert.equal(result.netMinor, 81);
    assert.equal(result.deductionsMinor, 7);
    assert.equal(evaluateIncome(model({ salaryMinor: 100, taxRateBps: 1300, deductionsMinor: 87 })).netMinor, 0);
    invalid(model({ salaryMinor: 100, taxRateBps: 1300, deductionsMinor: 88 }));
    assert.equal(evaluateIncome(model({ salaryMinor: 101, taxRateBps: 10_000 })).netMinor, 0);
    invalid(model({ salaryMinor: 101, taxRateBps: 10_000, deductionsMinor: 1 }));
    assert.equal(evaluateIncome(model({ taxRateBps: 0 })).netMinor, 4_800_000);
    assert.ok(!evaluateIncome(model({ taxRateBps: 0 })).warnings.includes(legacyTaxWarning));
    for (const taxRateBps of [-1, 10001, 1300.5, '1300', null, NaN, Infinity, {}]) invalid(model({ taxRateBps }));
  });

  test('Range endpoints are inclusive, optional and in component units', () => {
    const input = model({ salaryMinor: 100, components: [component({ value: 25, minValue: 10, maxValue: 50 })] });
    assert.equal(evaluateIncome(input).grossMinor, 125);
    assert.equal(evaluateIncome(input, 'conservative').grossMinor, 110);
    assert.equal(evaluateIncome(input, 'optimistic').grossMinor, 150);
    assert.equal(evaluateIncome(model({ salaryMinor: 100, components: [component({ value: 25, minValue: 25, maxValue: 25 })] }), 'conservative').grossMinor, 125);
    for (const type of ['fixed', 'percent_base', 'percent_running']) {
      const one = model({ salaryMinor: 100, components: [component({ type, value: 10, minValue: 0, maxValue: 20 })] });
      assert.equal(evaluateIncome(one, 'conservative').grossMinor, 100);
      assert.equal(evaluateIncome(one, 'optimistic').grossMinor, 120);
    }
    assert.equal(evaluateIncome(model({ salaryMinor: 100, components: [component({ value: 10, maxValue: 20 })] }), 'conservative').grossMinor, 110);
    assert.equal(evaluateIncome(model({ salaryMinor: 100, components: [component({ value: 10, minValue: 5 })] }), 'optimistic').grossMinor, 110);
    assert.equal(evaluateIncome(model({ salaryMinor: 100, components: [component({ minValue: 0, guaranteed: false })] }), 'conservative').grossMinor, 100);
    assert.equal(evaluateIncome(model({ salaryMinor: 100, components: [component({ maxValue: 200, enabled: false })] }), 'optimistic').grossMinor, 100);
    assert.equal(evaluateIncome(model({ salaryMinor: 100, components: [component({ value: 0.25, minValue: 0.1, maxValue: 0.5 })] }), 'optimistic').grossMinor, 101);
  });

  test('Every component is validated even when disabled, unguaranteed or calendar-excluded', () => {
    for (const patch of [
      { minValue: NaN }, { maxValue: Infinity }, { minValue: null }, { maxValue: '200' },
      { minValue: -1 }, { maxValue: 10001 }, { minValue: 131 }, { maxValue: 129 },
      { minValue: 200, maxValue: 100 }, { frequency: 'annual' }, { frequency: null },
      { payoutMonths: [1, 1, 7, 10] }, { payoutMonths: [1, 4, 7] },
      { payoutMonths: [0, 4, 7, 10] }, { payoutMonths: [1, 4, 7, 13] },
      { payoutMonths: [1, 4, 7, 10.5] }, { payoutMonths: ['1', 4, 7, 10] },
      { payoutMonths: null }, { payoutMonths: '1,4,7,10' },
    ]) {
      invalid(model({ components: [quarter({ ...patch, enabled: false })] }));
      invalid(model({ components: [quarter({ ...patch, guaranteed: false })] }), 'conservative', { month: '2026-11' });
      invalid(model({ components: [quarter(patch)] }), 'base', { mode: 'regular' });
      invalid(model({ components: [quarter(patch)] }), 'base', { month: '2026-11' });
    }
    for (const patch of [{ minValue: 0.5 }, { maxValue: 200.5 }, { minValue: -1 }, { maxValue: Number.MAX_SAFE_INTEGER + 1 }]) invalid(model({ components: [component({ ...patch, type: 'fixed', enabled: false })] }));
    invalid(model({ components: [quarter({ payoutMonths: undefined })] }));
    assert.equal(evaluateIncome(model({ components: [quarter({ payoutMonths: undefined, enabled: false })] })).grossMinor, 4_800_000);
    // Explicit but invalid calendars are never accepted, including on monthly components.
    invalid(model({ components: [component({ frequency: 'monthly', payoutMonths: [1, 1, 1, 1] })] }));
    const unsorted = model({ components: [quarter({ payoutMonths: [10, 1, 7, 4] })] });
    assert.equal(evaluateIncome(unsorted, 'base', { month: '2026-01' }).grossMinor, 11_040_000);
  });

  test('Options and calendar syntax are strict and explicit cash needs a month', () => {
    for (const options of [null, [], 'cash', 1, { mode: 'monthly' }, { mode: null }, { mode: 'cash' }]) invalid(model(), 'base', options);
    for (const month of ['', '2026-1', '2026-00', '2026-13', '0000-01', '10000-01', '2026-01-01', ' 2026-01', 202601, null]) invalid(model(), 'base', { month });
    assert.equal(evaluateIncome(model(), 'base', { month: '0001-01' }).month, '0001-01');
    assert.equal(evaluateIncome(model(), 'base', { month: '9999-12' }).month, '9999-12');
    assert.equal(evaluateIncome(model(), 'base', { month: undefined }).mode, 'regular');
  });

  test('Signed-money limits and income overflow remain safe under tax and prorating', () => {
    const max = Number.MAX_SAFE_INTEGER;
    assert.equal(moneyToMinor('90071992547409.91'), max);
    assert.equal(moneyToMinor('-90071992547409.91'), -max);
    assert.equal(moneyToMinor('(90071992547409,91)'), -max);
    for (const value of ['90071992547409.92', '-90071992547409.92', '(90071992547409,92)']) assert.throws(() => moneyToMinor(value), /переполнение/);
    const result = evaluateIncome(model({ salaryMinor: max, taxRateBps: 1300 }));
    const tax = Number((BigInt(max) * 1300n + 5000n) / 10000n);
    assert.equal(result.taxMinor, tax);
    assert.equal(result.netMinor, max - tax);
    assert.equal(evaluateIncome(model({ salaryMinor: max, taxRateBps: 10_000 })).netMinor, 0);
    invalid(model({ salaryMinor: -max }));
    invalid(model({ salaryMinor: max + 1 }));
    invalid(model({ salaryMinor: max, taxRateBps: 10_000, components: [component({ type: 'fixed', value: 1 })] }));
    invalid(model({ salaryMinor: 0, components: [component({ type: 'fixed', value: max, multiplier: 2 })] }));
    invalid(model({ salaryMinor: max, components: [quarter()] }), 'base', { month: '2026-01' });
    invalid(model({ salaryMinor: max, components: [quarter()] }), 'base', { mode: 'average' });
    // Only the prorated result needs to fit; the exact intermediate can exceed MAX_SAFE_INTEGER.
    const averaged = evaluateIncome(model({ salaryMinor: 0, components: [quarter({ type: 'fixed', value: max, minValue: max, maxValue: max, multiplier: 3 })] }), 'base', { mode: 'average' });
    assert.equal(averaged.grossMinor, max);
  });

  test('Frozen input, calendars, endpoints and options are never mutated or aliased', () => {
    const input = requestedModel();
    for (const entry of input.components) {
      if (entry.payoutMonths) Object.freeze(entry.payoutMonths);
      Object.freeze(entry);
    }
    Object.freeze(input.components);
    Object.freeze(input);
    const before = structuredClone(input);
    for (const scenario of ['base', 'conservative', 'optimistic']) {
      for (const mode of ['cash', 'regular', 'average']) {
        const options = Object.freeze({ month: '2026-01', mode });
        const result = evaluateIncome(input, scenario, options);
        assert.deepEqual(input, before);
        assert.deepEqual(options, { month: '2026-01', mode });
        result.components.at(-1).amountMinor = -1;
        result.warnings.push('external mutation');
        assert.deepEqual(input, before);
        assert.notEqual(evaluateIncome(input, scenario, options).components.at(-1).amountMinor, -1);
      }
    }
  });
});
