import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceService } from '../lib/service.js';
import { makeTool } from '../index.js';
async function fixture(t) {
  const captures = [];
  const llm = { listProviders: () => [{ id: 'opencode-go' }], async prepareCall(config) { return { config, async *stream(options) { captures.push(options); yield { type: 'text-delta', text: JSON.stringify({ summary: 'Синтетический совет.', savingsAdvice: 'Сначала резерв.', aiScore: { value: 65, reason: 'Предварительная оценка.' }, optimizations: [], warnings: ['Не кредитный рейтинг.'] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; } }; } };
  const s = new FinanceService(':memory:', { clock: () => new Date('2026-11-10T09:00:00Z'), backupRetention: 0, llm }); t.after(() => s.close());
  const account = await s.execute('account.save', { name: 'PRIVATE ACCOUNT', openingKnown: true, openingBalanceMinor: 10000000, openingDate: '2026-01-01' });
  const rows = Array.from({ length: 6 }, (_, i) => { const m = String(i + 5).padStart(2, '0'), last = new Date(Date.UTC(2026, i + 5, 0)).getUTCDate(); return [`01.${m}.2026;60000,00;PRIVATE SALARY ${m}`, `${last}.${m}.2026;-30000,00;PRIVATE PURCHASE ${m}`]; }).flat();
  const p = await s.execute('import.preview', { accountId: account.id, fileName: 'synthetic.csv', csvText: 'Дата;Сумма;Описание\n' + rows.join('\n') });
  assert.deepEqual(p.errors, []); await s.execute('import.commit', { previewId: p.previewId });
  for (const tx of s.repository.allTransactions()) await s.execute('transaction.update', { id: tx.id, category: tx.amountMinor < 0 ? 'Продукты' : 'Доход', kind: tx.amountMinor < 0 ? 'expense' : 'income', needsReview: false });
  const saved = await s.execute('income.save', { name: 'PRIVATE EMPLOYER', effectiveFrom: '2026-01', salaryMinor: 4800000, taxRateBps: 1300, components: [{ id: 'monthly', label: 'Месячная', type: 'percent_base', value: 25, frequency: 'monthly', guaranteed: true }, { id: 'quarterly', label: 'Квартальная', type: 'percent_base', value: 130, minValue: 100, maxValue: 200, frequency: 'quarterly', payoutMonths: [1, 4, 7, 10], guaranteed: true }] });
  return { s, saved, captures };
}
test('outlook combines actual six completed months and next full months with tax/calendar/range, without data mutations', async t => {
  const { s, saved } = await fixture(t), revision = s.repository.settings().revision;
  assert.equal(saved.model.taxRateBps, 1300);
  const o = await s.execute('outlook', { months: 6 });
  assert.equal(o.period.from, '2026-05-01'); assert.equal(o.period.to, '2026-10-31');
  assert.equal(o.history.length, 6); assert.deepEqual(o.baseline.basisMonths, ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(o.baseline.monthlyExpenseMinor, 3000000); assert.equal(o.model.regularNetMinor, 5220000); assert.equal(o.model.averageNetMinor, 7029600);
  assert.deepEqual(o.projection.map(x => x.month), ['2026-12', '2027-01', '2027-02', '2027-03', '2027-04', '2027-05']);
  assert.equal(o.projection[0].realisticSavingsMinor, 2220000); assert.equal(o.projection[1].netMinor, 10648800);
  assert.equal(o.projection[1].conservativeNetMinor, 9396000); assert.equal(o.projection[1].optimisticNetMinor, 13572000);
  assert.equal(o.baseline.sustainableIncomeMinor, 5220000); assert.ok(o.score.value !== null);
  assert.equal(s.repository.settings().revision, revision); assert.doesNotMatch(JSON.stringify(o.ai.payload), /PRIVATE/);
});
test('both new operations respect user-enabled agent access; tool and UI use the same calculations', async t => {
  const { s } = await fixture(t); await assert.rejects(s.execute('outlook', {}, { caller: 'agent' }), /выключен/); await assert.rejects(s.execute('advice.generate', {}, { caller: 'agent' }), /выключен/);
  await s.execute('settings.save', { agentAccess: true }, { caller: 'ui' });
  const tool = makeTool(s); const metadata = await tool.execute({ action: 'state', args: { metadataOnly: true } }); assert.deepEqual(Object.keys(metadata), ['meta']); assert.equal(metadata.meta.version, '0.1.14'); assert.ok((await tool.execute({ action: 'help' })).actions.some(x => x.name === 'outlook'));
  const value = await tool.execute({ action: 'outlook', args: { months: 3 } }); assert.equal(value.projection.length, 3); assert.equal(value.model.regularNetMinor, 5220000);
});
test('explicit AI operation uses exact route, stores a local cache, detects later financial edits, and never changes plans', async t => {
  const { s, captures } = await fixture(t); const revision = s.repository.settings().revision, beforePlans = s.repository.list('obligations');
  const advice = await s.execute('advice.generate', { months: 6 });
  assert.equal(advice.provider, 'opencode-go'); assert.equal(advice.model, 'deepseek-v4.1-flash'); assert.equal(captures.length, 1); assert.doesNotMatch(captures[0].messages.find(m => m.role === 'user').content[0].text, /PRIVATE/);
  assert.equal(s.repository.settings().revision, revision); assert.deepEqual(s.repository.list('obligations'), beforePlans);
  assert.equal((await s.execute('outlook', { months: 6 })).ai.stale, false);
  const tx = s.repository.allTransactions()[0]; await s.execute('transaction.update', { id: tx.id, note: 'Changed locally' });
  assert.equal((await s.execute('outlook', { months: 6 })).ai.stale, true);
});
test('reconciliation uses the selected calendar month rather than booking a quarterly premium every month', async t => {
  const { s, saved } = await fixture(t); const result = await s.execute('income.calculate', { model: saved.model, month: '2026-11', scenario: 'base' }); assert.equal(result.netMinor, 5220000);
  const jan = await s.execute('income.calculate', { model: saved.model, month: '2027-01', scenario: 'base' }); assert.equal(jan.netMinor, 10648800); assert.equal(jan.taxMinor, 1591200);
});
