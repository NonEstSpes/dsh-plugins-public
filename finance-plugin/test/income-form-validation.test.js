import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { FinanceValidationError } from '../lib/finance-core.js';
import { FinanceService } from '../lib/service.js';
import { makeTool } from '../index.js';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const singleValueMessage = 'Введите одно число. Диапазоны вроде 100–200 пока не поддерживаются.';
const types = ['fixed', 'percent_base', 'percent_running'];

function clientDictionary() {
  const start = source.indexOf('    const words = {');
  const end = source.indexOf('    const EMPTY = {', start);
  assert.ok(start >= 0 && end > start, 'The self-contained Client vocabulary must be available');
  return runInNewContext(source.slice(start, end) + '\n dictionaries.ru;', {}, { timeout: 1000 });
}
const dictionary = clientDictionary();
const t = key => {
  assert.equal(typeof dictionary[key], 'string', `Missing Russian translation: ${key}`);
  return dictionary[key];
};

function clientHelpers() {
  const start = source.indexOf('    function decimal(');
  const end = source.indexOf('    function rubleInput(', start);
  assert.ok(start >= 0 && end > start, 'The pure numeric helper slice must be available');
  // Only pure functions: never load the Client module, React, DOM, or a mock renderer.
  const helpers = runInNewContext(`(() => {\n${source.slice(start, end)}\nreturn { incomeComponentValue, incomeComponentError };\n})()`, {}, { timeout: 1000 });
  assert.equal(typeof helpers.incomeComponentValue, 'function');
  assert.equal(typeof helpers.incomeComponentError, 'function');
  return helpers;
}

test('income component validation explains in Russian that ranges are not supported', () => {
  assert.equal(t('incomeSingleValue'), singleValueMessage);
});

test('income percent components accept scalar 30, 100, 200 and comma 100,5 without an error', () => {
  const { incomeComponentValue, incomeComponentError } = clientHelpers();
  for (const type of ['percent_base', 'percent_running']) {
    for (const [value, expected] of [['30', 30], ['100', 100], ['200', 200], ['100,5', 100.5]]) {
      assert.equal(incomeComponentValue(value, type, t), expected, `${type}: ${value}`);
      assert.equal(incomeComponentError(value, type, t), '', `${type}: ${value}`);
    }
  }
});

test('income fixed component converts 1 000,25 rubles to integer kopecks without an error', () => {
  const { incomeComponentValue, incomeComponentError } = clientHelpers();
  assert.equal(incomeComponentValue('1 000,25', 'fixed', t), 100_025);
  assert.equal(incomeComponentError('1 000,25', 'fixed', t), '');
});

test('income components reject ranges, text and empty values instead of silently choosing an endpoint', () => {
  const { incomeComponentValue, incomeComponentError } = clientHelpers();
  for (const type of types) {
    const expected = `${singleValueMessage} ${t(type === 'fixed' ? 'moneyInvalid' : 'numberInvalid')}`;
    for (const value of ['100-200', '100–200', '100 — 200', 'abc', '', '   ']) {
      // A throw is required: neither NaN nor 100/200 (nor zero for empty input) is a valid result.
      // VM errors belong to another realm, so check the error name/message rather than instanceof.
      assert.throws(() => incomeComponentValue(value, type, t), error => {
        assert.equal(error.name, 'Error');
        assert.equal(error.message, expected, `${type}: ${JSON.stringify(value)}`);
        return true;
      }, `${type}: ${JSON.stringify(value)} must throw, not coerce`);
      assert.equal(incomeComponentError(value, type, t), expected, `${type}: ${JSON.stringify(value)}`);
    }
  }
});

test('synthetic in-memory finance tool rejects a range, then saves and calculates 100000 RUB + 30% guaranteed + 100% optional', async () => {
  // No profile, installed finance tool, user database, files, or real financial data is used.
  const service = new FinanceService(':memory:', {
    clock: () => new Date('2026-11-09T12:00:00+03:00'),
    backupRetention: 0,
  });
  try {
    assert.equal(service.state({}).settings.agentAccess, false);
    const tool = makeTool(service);
    await assert.rejects(tool.execute({ action: 'state' }), /выключен/);
    await service.execute('settings.save', { agentAccess: true }, { caller: 'ui' });

    const model = {
      name: 'Полностью синтетическая модель для теста',
      effectiveFrom: '2026-11',
      salaryMinor: 10_000_000,
      workedRatio: 1,
      deductionsMinor: 0,
      payoutDay: 10,
      components: [
        { id: 'synthetic-guaranteed', label: 'Тестовые гарантированные 30%', type: 'percent_base', value: 30, multiplier: 1, guaranteed: true, enabled: true },
        { id: 'synthetic-optional', label: 'Тестовые негарантированные 100%', type: 'percent_base', value: 100, multiplier: 1, guaranteed: false, enabled: true },
      ],
    };
    assert.equal((await tool.execute({ action: 'state' })).incomeModels.length, 0);
    for (const type of types) {
      const invalid = { ...model, components: [{ ...model.components[0], type, value: '100-200' }] };
      await assert.rejects(tool.execute({ action: 'income.save', args: invalid }), error => {
        assert.ok(error instanceof FinanceValidationError);
        assert.match(error.message, type === 'fixed' ? /Фиксированное начисление/ : /Процент начисления/);
        return true;
      });
      assert.equal((await tool.execute({ action: 'state' })).incomeModels.length, 0, `${type}: rejected save must leave no model`);
    }

    const saved = await tool.execute({ action: 'income.save', args: model });
    assert.ok(saved.model?.id, 'income.save returns the saved model');
    assert.ok(saved.calculation, 'income.save returns the calculation');
    assert.equal(saved.model.salaryMinor, 10_000_000);
    assert.deepEqual(saved.model.components, model.components);
    assert.equal(saved.calculation.grossMinor, 23_000_000);
    assert.equal(saved.calculation.netMinor, 23_000_000);

    const state = await tool.execute({ action: 'state' });
    assert.equal(state.incomeModels.length, 1);
    assert.equal(state.incomeModels[0].id, saved.model.id);
    assert.equal(state.accounts.length, 0);
    assert.equal(state.transactionTotal, 0);
    for (const [scenario, expected] of [['base', 23_000_000], ['conservative', 13_000_000]]) {
      const calculation = await tool.execute({ action: 'income.calculate', args: { model: saved.model, scenario } });
      assert.equal(calculation.grossMinor, expected, `${scenario}: gross kopecks`);
      assert.equal(calculation.netMinor, expected, `${scenario}: net kopecks`);
    }
    assert.equal((await tool.execute({ action: 'state' })).incomeModels.length, 1, 'Calculating does not save another version');
  } finally {
    service.close();
  }
});
