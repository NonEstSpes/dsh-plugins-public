import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceService } from '../lib/service.js';

const make = () => new FinanceService(':memory:', { clock: () => new Date('2026-11-09T12:00:00Z'), backupRetention: 0 });
const csv = rows => 'Дата;Сумма;Описание;Получатель;Идентификатор операции\n' + rows.join('\n');
async function importRows(s, account, rows) {
  const preview = await s.execute('import.preview', { accountId: account.id, fileName: 'synthetic-period.csv', csvText: csv(rows) });
  assert.deepEqual(preview.errors, []);
  const batch = await s.execute('import.commit', { previewId: preview.previewId });
  assert.equal(batch.insertedCount, rows.length);
  return batch;
}
async function seed(s) {
  const account = await s.execute('account.save', { name: 'Synthetic period account', openingKnown: true, openingDate: '2026-05-01', openingBalanceMinor: 0 });
  await s.execute('rule.save', { label: 'Synthetic groceries', counterparty: 'Synthetic shop', category: 'groceries', kind: 'expense' });
  const june = await importRows(s, account, [
    '02.06.2026;-40;June groceries;Synthetic shop;june-shop',
    '30.06.2026;-60;June transit;Synthetic transit;june-transit',
  ]);
  const july = await importRows(s, account, [
    '02.07.2026;-120;July groceries;Synthetic shop;july-shop',
    '10.07.2026;-80;July transit;Synthetic transit;july-transit',
    '19.07.2026;1000;July income;Synthetic employer;july-income',
  ]);
  return { account, june, july };
}
function assertGlobal(state, totalCount = 5, firstDate = '2026-06-02', latestDate = '2026-07-19') {
  assert.equal(state.overview.totalCount, totalCount);
  assert.equal(state.overview.firstDate, firstDate);
  assert.equal(state.overview.latestDate, latestDate);
}

test('omitted month selects July operations, not the November import timestamp', async () => {
  const s = make(); try {
    await seed(s);
    const state = s.state({});
    assert.equal(state.meta.month, '2026-07');
    assert.equal(state.meta.monthSelection, 'latest_available');
    assert.equal(state.meta.from, '2026-07-01'); assert.equal(state.meta.to, '2026-07-31');
    assert.equal(state.transactionTotal, 3); assert.equal(state.overview.count, 3);
    assert.equal(state.overview.expenseMinor, 20000);
    assert.ok(state.overview.categories.some(c => c.category === 'Продукты' && c.expenseMinor === 12000));
    assert.ok(state.transactions.every(t => t.date.startsWith('2026-07-')));
    assert.equal(state.overview.lastImportAt, '2026-11-09T12:00:00.000Z');
    assertGlobal(state);
  } finally { s.close(); }
});

test('explicit November remains empty and explicit June remains selected without losing history count', async () => {
  const s = make(); try {
    await seed(s);
    const november = s.state({ month: '2026-11' });
    assert.equal(november.meta.month, '2026-11'); assert.equal(november.meta.monthSelection, 'explicit');
    assert.equal(november.transactionTotal, 0); assert.equal(november.overview.count, 0);
    assert.equal(november.overview.expenseMinor, 0); assert.deepEqual(november.overview.categories, []);
    assertGlobal(november);
    const june = s.state({ month: '2026-06' });
    assert.equal(june.meta.month, '2026-06'); assert.equal(june.meta.monthSelection, 'explicit');
    assert.equal(june.meta.from, '2026-06-01'); assert.equal(june.meta.to, '2026-06-30');
    assert.equal(june.transactionTotal, 2); assert.equal(june.overview.count, 2);
    assert.equal(june.overview.expenseMinor, 10000); assertGlobal(june);
  } finally { s.close(); }
});

test('explicit date ranges and standalone date bounds are not auto-overridden', async () => {
  const s = make(); try {
    await seed(s);
    const range = s.state({ from: '2026-06-10', to: '2026-07-02' });
    assert.equal(range.meta.monthSelection, 'explicit');
    assert.equal(range.meta.from, '2026-06-10'); assert.equal(range.meta.to, '2026-07-02');
    assert.equal(range.transactionTotal, 2); assert.equal(range.overview.count, 2);
    assert.equal(range.overview.expenseMinor, 18000); assertGlobal(range);
    for (const args of [{ from: '2026-11-01' }, { to: '2026-11-30' }]) {
      const bounded = s.state(args);
      assert.equal(bounded.meta.monthSelection, 'explicit');
      assert.equal(bounded.meta.from, '2026-11-01'); assert.equal(bounded.meta.to, '2026-11-30');
      assert.equal(bounded.transactionTotal, 0); assert.equal(bounded.overview.count, 0); assertGlobal(bounded);
    }
  } finally { s.close(); }
});

test('search, review filtering and pagination never change global or period overview counts', async () => {
  const s = make(); try {
    await seed(s);
    const cases = [
      [{ query: 'July groceries' }, 1, 1],
      [{ query: 'no synthetic operation matches this' }, 0, 0],
      [{ needsReview: true }, 2, 2],
      [{ limit: 1, offset: 1 }, 3, 1],
      [{ limit: 1, offset: 99 }, 3, 0],
      [{ query: 'July groceries', needsReview: true, limit: 1, offset: 1 }, 0, 0],
    ];
    for (const [args, filteredCount, pageCount] of cases) {
      const state = s.state(args);
      assert.equal(state.meta.month, '2026-07', JSON.stringify(args));
      assert.equal(state.meta.monthSelection, 'latest_available');
      assert.equal(state.transactionTotal, filteredCount); assert.equal(state.transactions.length, pageCount);
      assert.equal(state.overview.count, 3); assert.equal(state.overview.expenseMinor, 20000);
      assertGlobal(state);
    }
  } finally { s.close(); }
});

test('populated current month takes precedence even when a later month is available', async () => {
  const s = make(); try {
    const { account } = await seed(s);
    await importRows(s, account, ['07.11.2026;-25;November groceries;Synthetic shop;november-shop']);
    await importRows(s, account, ['01.12.2026;-50;Future groceries;Synthetic shop;december-shop']);
    const state = s.state({});
    assert.equal(state.meta.month, '2026-11'); assert.equal(state.meta.monthSelection, 'current');
    assert.equal(state.transactionTotal, 1); assert.equal(state.overview.count, 1);
    assert.equal(state.overview.expenseMinor, 2500);
    assertGlobal(state, 7, '2026-06-02', '2026-12-01');
  } finally { s.close(); }
});

test('empty ledger uses current month and reversed imports are excluded from fallback and global totals', async () => {
  const s = make(); try {
    let state = s.state({});
    assert.equal(state.meta.month, '2026-11'); assert.equal(state.meta.monthSelection, 'current');
    assert.equal(state.transactionTotal, 0); assert.equal(state.overview.count, 0); assertGlobal(state, 0, null, null);
    const { account, june, july } = await seed(s);
    const november = await importRows(s, account, ['08.11.2026;-10;Reversed November;Synthetic shop;reversed-november']);
    await s.execute('import.reverse', { id: november.importId });
    state = s.state({});
    assert.equal(state.meta.month, '2026-07'); assert.equal(state.meta.monthSelection, 'latest_available'); assertGlobal(state);
    await s.execute('import.reverse', { id: july.importId });
    state = s.state({});
    assert.equal(state.meta.month, '2026-06'); assert.equal(state.meta.monthSelection, 'latest_available');
    assert.equal(state.overview.count, 2); assertGlobal(state, 2, '2026-06-02', '2026-06-30');
    await s.execute('import.reverse', { id: june.importId });
    state = s.state({});
    assert.equal(state.meta.month, '2026-11'); assert.equal(state.meta.monthSelection, 'current');
    assert.equal(state.transactionTotal, 0); assert.equal(state.overview.count, 0); assertGlobal(state, 0, null, null);
    assert.ok(state.imports.every(i => i.status === 'reverted'));
  } finally { s.close(); }
});

test('history totals cover several months and accounts independently of the viewed month', async () => {
  const s = make(); try {
    const { account } = await seed(s);
    await importRows(s, account, ['01.05.2026;-10;May groceries;Synthetic shop;may-shop', '31.05.2026;20;May income;Synthetic employer;may-income']);
    const second = await s.execute('account.save', { name: 'Synthetic second account', openingKnown: false });
    await importRows(s, second, ['01.10.2026;-30;October groceries;Synthetic shop;october-shop', '31.10.2026;-40;October transit;Synthetic transit;october-transit']);
    let summedPeriodCounts = 0;
    for (const [month, count, expenseMinor] of [['2026-05', 2, 1000], ['2026-06', 2, 10000], ['2026-07', 3, 20000], ['2026-10', 2, 7000], ['2026-11', 0, 0]]) {
      const state = s.state({ month, limit: 1 });
      assert.equal(state.meta.month, month); assert.equal(state.meta.monthSelection, 'explicit');
      assert.equal(state.overview.count, count); assert.equal(state.transactionTotal, count);
      assert.equal(state.overview.expenseMinor, expenseMinor); assertGlobal(state, 9, '2026-05-01', '2026-10-31');
      summedPeriodCounts += state.overview.count;
    }
    assert.equal(summedPeriodCounts, 9);
    const history = s.state({ from: '2026-05-01', to: '2026-10-31', limit: 1 });
    assert.equal(history.overview.count, 9); assert.equal(history.transactionTotal, 9); assert.equal(history.transactions.length, 1);
    assert.equal(history.overview.expenseMinor, 38000); assertGlobal(history, 9, '2026-05-01', '2026-10-31');
  } finally { s.close(); }
});
