import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceService } from '../lib/service.js';
import { sumMinor } from '../lib/repository.js';

const make = () => new FinanceService(':memory:', { clock: () => new Date('2026-11-09T12:00:00+03:00'), backupRetention: 0 });
async function setup(s, csvText) {
  const a = await s.execute('account.save', { name: 'Synthetic', openingKnown: true, openingDate: '2026-11-01', openingBalanceMinor: 0 });
  const p = await s.execute('import.preview', { accountId: a.id, fileName: 'synthetic.csv', csvText });
  assert.equal(p.errors.length, 0); const batch = await s.execute('import.commit', { previewId: p.previewId }); return { a, batch };
}
const model = { name: 'Synthetic income', effectiveFrom: '2026-11', salaryMinor: 10000, components: [] };

test('rules cannot produce negative income and disabling a rule explicitly resets its old assignments', async () => {
  const s = make(); try {
    await setup(s, 'Дата;Сумма;Описание;Получатель\n09.11.2026;-100;Перевод;Учитель');
    await s.execute('rule.save', { label: 'Invalid direction', counterparty: 'Учитель', descriptionContains: '', category: 'Образование', kind: 'income', applyExisting: true });
    assert.equal(s.state({}).transactions[0].kind, 'expense');
    const valid = await s.execute('rule.save', { label: 'Tutor', counterparty: 'Учитель', category: 'Образование', kind: 'expense', applyExisting: true });
    assert.equal(s.state({}).transactions[0].needsReview, false);
    await s.execute('rule.save', { ...valid.rule, enabled: false, applyExisting: true });
    assert.equal(s.state({}).transactions[0].needsReview, true); assert.equal(s.state({}).transactions[0].category, 'Без категории');
  } finally { s.close(); }
});

test('matched income cannot change kind through UI or rules until the explicit link is removed', async () => {
  const s = make(); try {
    const { batch } = await setup(s, 'Дата;Сумма;Описание;Получатель\n09.11.2026;100;Зарплата;Работодатель');
    const saved = await s.execute('income.save', model), t = s.state({}).transactions[0];
    const match = await s.execute('income.reconcile', { modelId: saved.model.id, period: '2026-11', transactionIds: [t.id] });
    await assert.rejects(s.execute('transaction.update', { id: t.id, kind: 'transfer' }), /сверк/);
    await s.execute('rule.save', { label: 'Not transfer', counterparty: 'Работодатель', category: 'Доход', kind: 'transfer', applyExisting: true });
    assert.equal(s.state({}).transactions[0].kind, 'income');
    await s.execute('income.unmatch', { id: match.id }); assert.equal(s.state({}).incomeMatches.length, 0);
    await s.execute('import.reverse', { id: batch.importId }); assert.equal(s.state({}).transactionTotal, 0);
  } finally { s.close(); }
});

test('known obligations cannot disappear behind a smaller category budget', async () => {
  const s = make(); try {
    await s.execute('account.save', { name: 'Synthetic', openingKnown: true }); await s.execute('income.save', model);
    await s.execute('budget.save', { category: 'Транспорт', limitMinor: 1000 });
    await s.execute('obligation.save', { name: 'Fixed cost', category: 'Транспорт', amountMinor: 50000, dayOfMonth: 10 });
    const value = await s.execute('forecast', {}); assert.equal(value.scenarios.base.monthlyExpenseMinor, 50000);
  } finally { s.close(); }
});

test('BigInt aggregations preserve cancellation cents and export preserves the largest supported amounts', async () => {
  assert.equal(sumMinor([Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER]), 2);
  const s = make(); try {
    await setup(s, 'Дата;Сумма;Описание\n09.11.2026;90071992547409,90;Boundary');
    const value = await s.execute('export.csv', {}); assert.ok(value.content.includes('90071992547409,90')); assert.ok(!value.content.includes('90071992547409,91'));
  } finally { s.close(); }
});

test('balance respects posting date, while expense report uses operation date', async () => {
  const s = make(); try {
    await setup(s, 'Дата;Дата проводки;Сумма;Описание\n31.10.2026;02.11.2026;-100;Posted later');
    const state = s.state({ month: '2026-11' }); assert.equal(state.overview.balanceMinor, -10000); assert.equal(state.overview.expenseMinor, 0);
  } finally { s.close(); }
});

test('exact bank-ID repeats cannot be opted in as possible fingerprint duplicates', async () => {
  const s = make(); try {
    const { a } = await setup(s, 'Дата;Сумма;Описание;Идентификатор операции\n09.11.2026;-100;Shop;exact-id');
    const p = await s.execute('import.preview', { accountId: a.id, fileName: 'overlap.csv', csvText: 'Дата;Сумма;Описание;Идентификатор операции\n09.11.2026;-100;Shop;exact-id\n08.11.2026;-1;New;new-id' });
    const repeated = p.transactions.find(t => t.duplicate); assert.equal(repeated.duplicateReason, 'bank_id');
    await assert.rejects(s.execute('import.commit', { previewId: p.previewId, includeDuplicateRows: [repeated.sourceRow] }), /список/);
    const value = await s.execute('import.commit', { previewId: p.previewId }); assert.equal(value.insertedCount, 1); assert.equal(value.skippedCount, 1);
  } finally { s.close(); }
});

test('budget recommendations are evidence-backed and respect protected categories', async () => {
  const s = make(); try {
    await setup(s, 'Дата;Сумма;Описание\n09.11.2026;-100;Leisure'); const t = s.state({}).transactions[0];
    await s.execute('transaction.update', { id: t.id, category: 'Досуг', needsReview: false });
    await s.execute('budget.save', { category: 'Досуг', limitMinor: 5000 });
    let report = await s.execute('report.generate', { period: 'month', date: '2026-11-09' }); assert.ok(report.data.insights.some(i => i.kind === 'saving' && i.evidenceIds.includes(t.id)));
    await s.execute('budget.save', { category: 'Досуг', limitMinor: 5000, protected: true });
    report = await s.execute('report.generate', { period: 'month', date: '2026-11-09' }); assert.ok(!report.data.insights.some(i => i.kind === 'saving')); assert.ok(report.data.insights.some(i => i.kind === 'budget'));
  } finally { s.close(); }
});
