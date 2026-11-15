import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { createServer } from 'node:http';
import { FinanceService } from '../lib/service.js';
import { FinanceRepository } from '../lib/repository.js';
import { makeTool, makeHttpHandler, Config } from '../index.js';

const clock = () => new Date('2026-11-09T18:30:00+03:00');
function service() { return new FinanceService(':memory:', { clock, backupRetention: 0 }); }
async function account(s, extra = {}) { return s.execute('account.save', { name: 'Тестовый счёт', openingBalanceMinor: 1000000, openingDate: '2026-11-01', openingKnown: true, ...extra }); }
const csv = rows => 'Дата;Сумма;Описание;Получатель;Идентификатор операции\n' + rows.join('\n');
async function preview(s, a, rows, extra = {}) { return s.execute('import.preview', { accountId: a.id, fileName: 'synthetic.csv', csvText: csv(rows), ...extra }); }
async function imported(s, a, rows, extra = {}) { const p = await preview(s, a, rows, extra); assert.equal(p.errors.length, 0); return s.execute('import.commit', { previewId: p.previewId }); }
function safeRemove(dir) { const full = resolve(dir); assert.equal(dirname(full), resolve(tmpdir())); assert.match(basename(full), /^dsh-finance-test-/); rmSync(full, { recursive: true, force: true }); }

const income = extra => ({ name: 'Расчётный доход', effectiveFrom: '2026-11', salaryMinor: 10000000, deductionsMinor: 0, payoutDay: 10,
  components: [{ id: 'bonus', label: 'Премия', type: 'percent_base', value: 20, guaranteed: false }], ...extra });

test('Config defaults validate and reject oversized uploads', () => { assert.equal(Config({}).maxUploadMiB, 10); assert.throws(() => Config({ maxUploadMiB: 200 })); });

test('empty state is honest about balance, privacy and absence of raw disk storage', () => {
  const s = service(); try { const state = s.state({}); assert.equal(state.accounts.length, 0); assert.equal(state.overview.balanceMinor, null); assert.equal(state.settings.agentAccess, false); assert.equal(state.meta.rawStorage, 'memory-only'); assert.equal(state.meta.encrypted, false); } finally { s.close(); }
});

test('CSV preview never writes operations before explicit commit and commit discards source memory', async () => {
  const s = service(); try {
    const a = await account(s), p = await preview(s, a, ['09.11.2026;-2500,00;Репетитор;Иван;bank-1','09.11.2026;100000,00;Зарплата;Работодатель;bank-2']);
    assert.equal(p.rowCount, 2); assert.equal(s.state({}).transactionTotal, 0); assert.equal(s.previews.size, 1); assert.equal(p.totals.netMinor, 9750000);
    const result = await s.execute('import.commit', { previewId: p.previewId }); assert.equal(result.insertedCount, 2); assert.equal(result.rawDeleted, true); assert.equal(s.previews.size, 0);
    const state = s.state({}); assert.equal(state.transactionTotal, 2); assert.equal(state.overview.balanceMinor, 10750000);
    assert.equal(state.overview.incomeMinor, 10000000); assert.equal(state.overview.expenseMinor, 250000); assert.equal(state.imports[0].verification, 'not_provided');
  } finally { s.close(); }
});

test('row errors and supplied balance mismatch block all-or-nothing import', async () => {
  const s = service(); try {
    const a = await account(s); let p = await preview(s, a, ['31.02.2026;-10;Ошибка;Иван;','09.11.2026;-20;Покупка;Магазин;']);
    assert.equal(p.errors.length, 1); await assert.rejects(s.execute('import.commit', { previewId: p.previewId }), /Исправьте/); assert.equal(s.state({}).transactionTotal, 0);
    p = await preview(s, a, ['09.11.2026;-20;Покупка;Магазин;'], { openingMinor: 10000, closingMinor: 9000 });
    assert.equal(p.verification, 'mismatch'); await assert.rejects(s.execute('import.commit', { previewId: p.previewId }), /остаткам/);
    const fixed = await s.execute('import.remap', { previewId: p.previewId, mapping: p.mapping, openingMinor: 10000, closingMinor: 8000 });
    assert.equal(fixed.verification, 'balanced'); await s.execute('import.commit', { previewId: fixed.previewId }); assert.equal(s.state({}).transactionTotal, 1);
  } finally { s.close(); }
});

test('file identity and overlapping exports do not duplicate data; genuine same-day purchases survive', async () => {
  const s = service(); try {
    const a = await account(s), row = '09.11.2026;-100;Одинаковая покупка;Магазин;';
    await imported(s, a, [row, row]); assert.equal(s.state({}).transactionTotal, 2);
    let p = await preview(s, a, [row, row]); let result = await s.execute('import.commit', { previewId: p.previewId }); assert.equal(result.alreadyImported, true); assert.equal(s.state({}).transactionTotal, 2);
    p = await preview(s, a, [row, row, '08.11.2026;-50;Другая;Магазин;']); assert.equal(p.duplicateCount, 2);
    result = await s.execute('import.commit', { previewId: p.previewId }); assert.equal(result.insertedCount, 1); assert.equal(result.skippedCount, 2); assert.equal(s.state({}).transactionTotal, 3);
    p = await preview(s, a, [row, '07.11.2026;-10;Новая;Магазин;']); assert.equal(p.duplicateCount, 1);
    const duplicateRow = p.transactions.find(t => t.duplicate).sourceRow;
    await s.execute('import.commit', { previewId: p.previewId, includeDuplicateRows: [duplicateRow] }); assert.equal(s.state({}).transactionTotal, 5);
  } finally { s.close(); }
});

test('bank IDs conflicting in one source or across sources block import', async () => {
  const s = service(); try {
    const a = await account(s); let p = await preview(s, a, ['09.11.2026;-10;Покупка;Магазин;bank-id','09.11.2026;-20;Покупка;Магазин;bank-id']);
    assert.ok(p.errors.length); await assert.rejects(s.execute('import.commit', { previewId: p.previewId }));
    await imported(s, a, ['09.11.2026;-10;Покупка;Магазин;bank-id']);
    p = await preview(s, a, ['09.11.2026;-20;Покупка;Магазин;bank-id']); assert.ok(p.errors.length);
    assert.equal(s.state({}).transactionTotal, 1);
  } finally { s.close(); }
});

test('duplicate previews created before either commit are safely rechecked under transaction', async () => {
  const s = service(); try {
    const a = await account(s), p1 = await preview(s, a, ['09.11.2026;-10;Покупка;Магазин;x']), p2 = await preview(s, a, ['09.11.2026;-10;Покупка;Магазин;x']);
    await s.execute('import.commit', { previewId: p1.previewId }); const result = await s.execute('import.commit', { previewId: p2.previewId }); assert.equal(result.alreadyImported, true); assert.equal(s.state({}).transactionTotal, 1);
  } finally { s.close(); }
});

test('literal tutor rule classifies recurring transfers and preserves manual annotations', async () => {
  const s = service(); try {
    const a = await account(s); await imported(s, a, ['09.11.2026;-2500;Перевод;Иван;']);
    const rule = await s.execute('rule.save', { label: 'Репетитор', counterparty: 'Иван', category: 'education', kind: 'expense', applyExisting: true }); assert.equal(rule.updatedCount, 1);
    let t = s.state({}).transactions[0]; assert.equal(t.category, 'Образование'); assert.equal(t.needsReview, false);
    t = await s.execute('transaction.update', { id: t.id, category: 'Прочее', note: 'Личная корректировка', needsReview: false });
    await s.execute('rule.save', { ...rule.rule, category: 'Транспорт', applyExisting: true }); assert.equal(s.state({}).transactions[0].category, 'Прочее');
    await assert.rejects(s.execute('rule.save', { label: 'Слишком широко', category: 'Прочее', minMinor: 10 }), /получателя/);
  } finally { s.close(); }
});

test('immutable bank fields cannot be changed by annotation requests', async () => {
  const s = service(); try {
    const a = await account(s); await imported(s, a, ['09.11.2026;-100;Покупка;Магазин;id']); const t = s.state({}).transactions[0];
    const result = await s.execute('transaction.update', { id: t.id, amountMinor: 999999, date: '2026-01-01', description: 'changed', category: 'Прочее', needsReview: false });
    assert.equal(result.amountMinor, -10000); assert.equal(result.date, '2026-11-09'); assert.equal(result.description, 'Покупка');
    await assert.rejects(s.execute('transaction.update', { id: t.id, kind: 'income' }), /положительными/);
  } finally { s.close(); }
});

test('transfer/refund annotations fix expense reports without modifying bank cash flow', async () => {
  const s = service(); try {
    const a = await account(s); await imported(s, a, ['09.11.2026;-500;Покупка;Магазин;a','09.11.2026;100;Возврат;Магазин;b','09.11.2026;1000;Между счетами;Я;c']);
    const txs = s.state({}).transactions;
    await s.execute('transaction.update', { id: txs.find(t => t.bankId === 'b').id, kind: 'refund', category: 'Прочее', needsReview: false });
    await s.execute('transaction.update', { id: txs.find(t => t.bankId === 'c').id, kind: 'transfer', category: 'Прочее', needsReview: false });
    const state = s.state({}); assert.equal(state.overview.incomeMinor, 0); assert.equal(state.overview.expenseMinor, 40000); assert.equal(state.overview.balanceMinor, 1060000);
  } finally { s.close(); }
});

test('income versions, explicit split payouts and double-match protection', async () => {
  const s = service(); try {
    const a = await account(s); await imported(s, a, ['05.11.2026;40000;Аванс;Работодатель;a','09.11.2026;60000;Зарплата;Работодатель;b']);
    const first = await s.execute('income.save', income()); assert.equal(first.calculation.netMinor, 12000000);
    const second = await s.execute('income.save', income({ id: first.model.id, salaryMinor: 11000000 })); assert.notEqual(first.model.id, second.model.id); assert.equal(s.state({}).incomeModels.length, 2);
    const ids = s.state({}).transactions.map(t => t.id); const match = await s.execute('income.reconcile', { modelId: first.model.id, period: '2026-11', transactionIds: ids });
    assert.equal(match.actualMinor, 10000000); assert.equal(match.expectedMinor, 12000000); assert.equal(match.differenceMinor, -2000000);
    await assert.rejects(s.execute('income.reconcile', { modelId: second.model.id, period: '2026-11', transactionIds: ids }), /уже связана/);
    await assert.rejects(s.execute('import.reverse', { id: s.state({}).imports[0].id }), /сверке/);
  } finally { s.close(); }
});

test('forecast requires real inputs, handles three scenarios, and does not double-count earmarked savings', async () => {
  const s = service(); try {
    await assert.rejects(s.execute('forecast', {}), /модель/); const a = await account(s);
    const model = await s.execute('income.save', income());
    await assert.rejects(s.execute('forecast', { modelId: model.model.id }), /расходы|бюджет/i);
    await s.execute('goal.save', { name: 'Подушка', targetMinor: 500000, savedMinor: 100000, monthlyMinor: 100000, deadline: '2027-03-09' });
    const value = await s.execute('forecast', { modelId: model.model.id, monthlyExpenseMinor: 5000000, months: 6 });
    assert.equal(value.scenarios.conservative.monthlyIncomeMinor, 10000000); assert.equal(value.scenarios.base.monthlyIncomeMinor, 12000000); assert.equal(value.scenarios.optimistic.monthlyIncomeMinor, 12000000);
    assert.equal(value.scenarios.base.path[0].balanceMinor, 900000); assert.equal(value.scenarios.base.goals[0].monthsToGoal, 4);
    assert.equal(s.state({}).accounts.find(x => x.id === a.id).balanceMinor, 1000000);
  } finally { s.close(); }
});

test('unknown account balance is null rather than an invented zero', async () => {
  const s = service(); try { await account(s, { openingKnown: false }); await s.execute('income.save', income()); await assert.rejects(s.execute('forecast', { monthlyExpenseMinor: 0 }), /остат/); assert.equal(s.state({}).overview.balanceMinor, null); } finally { s.close(); }
});

test('reports are idempotent for a revision and disclose stale or incomplete imports', async () => {
  const s = service(); try {
    const a = await account(s); await imported(s, a, ['01.11.2026;-10;Покупка;Магазин;']);
    const first = await s.execute('report.generate', { period: 'month', date: '2026-11-09' }); const again = await s.execute('report.generate', { period: 'month', date: '2026-11-09' });
    assert.equal(first.id, again.id); assert.ok(first.warnings.some(w => /неполными/.test(w))); assert.ok(first.warnings.some(w => /полнота.*не доказана/i.test(w))); assert.equal(first.data.expenseMinor, 1000);
    const week = await s.execute('report.generate', { period: 'week', date: '2026-11-09' }); assert.equal(week.fromDate, '2026-11-09'); assert.equal(week.toDate, '2026-11-15');
    s.tick(); s.tick(); const keys = s.state({}).reports.map(r => `${r.period}:${r.fromDate}:${r.revision}`); assert.equal(new Set(keys).size, keys.length);
  } finally { s.close(); }
});

test('agent access default-off is enforced in the business layer, and agent cannot grant itself access', async () => {
  const s = service(); try {
    await assert.rejects(s.execute('state', {}, { caller: 'agent' }), /выключен/);
    await assert.rejects(s.execute('settings.save', { agentAccess: true }, { caller: 'agent' }));
    const tool = makeTool(s); assert.ok((await tool.execute({ action: 'help' })).actions.length > 10);
    await assert.rejects(tool.execute({ action: 'state' }), /выключен/);
    await s.execute('settings.save', { agentAccess: true }, { caller: 'ui' }); assert.equal((await tool.execute({ action: 'state' })).meta.version, '0.1.14');
    await assert.rejects(s.execute('settings.save', { agentAccess: false }, { caller: 'agent' }), /интерфейсе/);
    await s.execute('settings.save', { agentAccess: false }, { caller: 'ui' }); await assert.rejects(tool.execute({ action: 'state' }));
  } finally { s.close(); }
});

test('reversing an unmatched import restores balance, keeps audit and supports a fresh reimport', async () => {
  const s = service(); try {
    const a = await account(s), result = await imported(s, a, ['09.11.2026;-100;Покупка;Магазин;']);
    await s.execute('import.reverse', { id: result.importId }); assert.equal(s.state({}).transactionTotal, 0); assert.equal(s.state({}).overview.balanceMinor, 1000000);
    assert.equal(s.state({}).imports[0].status, 'reverted'); assert.ok(s.repository.db.prepare("SELECT count(*) n FROM audit WHERE action='import.reverse'").get().n);
    await imported(s, a, ['09.11.2026;-100;Покупка;Магазин;']); assert.equal(s.state({}).transactionTotal, 1);
  } finally { s.close(); }
});

test('export neutralizes spreadsheet formulas while preserving numeric negative money', async () => {
  const s = service(); try { const a = await account(s); await imported(s, a, ['09.11.2026;-100;=1+1;@evil;']); const value = await s.execute('export.csv', {}); assert.ok(value.content.includes("'=1+1")); assert.ok(value.content.includes("'@evil")); assert.ok(value.content.includes('-100,00')); } finally { s.close(); }
});

test('persistent database survives reopen, backup has no raw files, unknown DB is never reset', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-finance-test-')), path = join(root, 'finance.sqlite'); let s;
  try {
    s = new FinanceService(path, { clock, backupRetention: 2 }); const a = await account(s); await imported(s, a, ['09.11.2026;-100;Покупка;Магазин;']); s.tick(); s.close();
    s = new FinanceService(path, { clock, backupRetention: 2 }); assert.equal(s.state({}).transactionTotal, 1); assert.equal(s.repository.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.ok(readdirSync(join(root, 'backups')).some(n => n.endsWith('.sqlite'))); assert.ok(readdirSync(root).every(n => !/\.(csv|pdf)$/i.test(n)));
    s.close(); const r = new FinanceRepository(path); r.db.exec('PRAGMA user_version=99'); r.close(); assert.throws(() => new FinanceRepository(path), /новее/);
  } finally { s?.close(); safeRemove(root); }
});

test('preview expiration, discard and upload size/format checks leave ledger untouched', async () => {
  const s = service(); try { const a = await account(s), p = await preview(s, a, ['09.11.2026;-10;Покупка;Магазин;']);
    s.previews.get(p.previewId).expiresAtMs = 0; await assert.rejects(s.execute('import.commit', { previewId: p.previewId }), /истёк/);
    const p2 = await preview(s, a, ['09.11.2026;-10;Покупка;Магазин;']); await s.execute('import.discard', { previewId: p2.previewId }); assert.equal(s.previews.size, 0);
    await assert.rejects(s.execute('import.preview', { accountId: a.id, fileName: 'x.exe', base64: Buffer.from('data').toString('base64') }), /CSV/);
    await assert.rejects(s.execute('import.preview', { accountId: a.id, fileName: 'x.csv', base64: 'bad!' }), /формат/); assert.equal(s.state({}).transactionTotal, 0);
  } finally { s.close(); }
});

test('HTTP route enforces existing DSH authentication, custom header, JSON and method', async () => {
  const s = service(); const connection = { requestRejection: ({ headers }) => headers.authorization === 'test-owner' ? undefined : 401 };
  const server = createServer(makeHttpHandler(s, connection)); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/finance`;
  const post = (headers = {}, body = { action: 'state', args: {} }) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Finance': '1', ...headers }, body: JSON.stringify(body) });
  try {
    assert.equal((await post()).status, 401); assert.equal((await fetch(url, { headers: { Authorization: 'test-owner' } })).status, 405);
    assert.equal((await post({ Authorization: 'test-owner', 'X-DSH-Finance': '' })).status, 403);
    assert.equal((await post({ Authorization: 'test-owner', 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    const response = await post({ Authorization: 'test-owner' }); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.equal((await response.json()).value.meta.rawStorage, 'memory-only');
    assert.equal((await post({ Authorization: 'test-owner' }, { action: 'state', args: {}, caller: 'agent' })).status, 400);
    assert.equal((await post({ Authorization: 'test-owner' }, { action: 'unknown' })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); s.close(); }
});
