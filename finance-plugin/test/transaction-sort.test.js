import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceService } from '../lib/service.js';
import { FinanceError } from '../lib/repository.js';

const month = '2026-11';
const ids = rows => rows.map(row => row.id);
const bankIds = rows => rows.map(row => row.bankId);
const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });

// Every fixture is synthetic and lives exclusively in its own in-memory database.
async function fixture(t, rows) {
  const s = new FinanceService(':memory:', { clock: () => new Date('2026-11-10T09:00:00Z'), backupRetention: 0 });
  t.after(() => s.close());
  const account = await s.execute('account.save', { name: 'Синтетический счёт', openingKnown: true, openingBalanceMinor: 1000000, openingDate: `${month}-01` });
  let batch = 0;
  async function add(source) {
    const prefix = `batch-${++batch}`;
    const normalized = source.map((row, i) => ({ date: `${month}-10`, amountMinor: -100, description: `Операция ${i}`, counterparty: 'Синтетический получатель', ...row, bankId: `${prefix}-${i}` }));
    const csvText = 'Дата;Сумма;Описание;Получатель;Идентификатор операции\n' + normalized.map(row => {
      const [year, m, day] = row.date.split('-');
      return [`${day}.${m}.${year}`, (row.amountMinor / 100).toFixed(2).replace('.', ','), row.description, row.counterparty, row.bankId].join(';');
    }).join('\n');
    const preview = await s.execute('import.preview', { accountId: account.id, fileName: `${prefix}.csv`, csvText });
    assert.deepEqual(preview.errors, []);
    const result = await s.execute('import.commit', { previewId: preview.previewId });
    assert.equal(result.insertedCount, normalized.length);
    const transactions = s.repository.allTransactions();
    for (const row of normalized) {
      const annotation = Object.fromEntries(['category', 'kind', 'needsReview', 'note'].filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
      if (Object.keys(annotation).length) await s.execute('transaction.update', { id: transactions.find(tx => tx.bankId === row.bankId).id, ...annotation });
    }
    return result;
  }
  if (rows.length) await add(rows);
  const state = args => s.execute('state', { month, ...args });
  return { s, add, state };
}

async function pages(state, args, total, limit = 50) {
  const combined = [];
  for (let offset = 0; offset < total; offset += limit) {
    const page = await state({ ...args, limit, offset });
    assert.equal(page.transactionTotal, total);
    assert.equal(page.transactions.length, Math.min(limit, total - offset));
    combined.push(...page.transactions);
  }
  assert.equal(new Set(ids(combined)).size, total);
  return combined;
}

test('date defaults are descending, explicit date directions preserve same-date repository ties, and metadata is effective', async t => {
  const { s, state } = await fixture(t, [
    { date: '2026-11-02' }, { date: '2026-11-10' }, { date: '2026-11-02' }, { date: '2026-11-30' }, { date: '2026-11-10' },
  ]);
  const repositoryRows = s.repository.allTransactions();
  assert.deepEqual(bankIds(repositoryRows), ['batch-1-3', 'batch-1-4', 'batch-1-1', 'batch-1-2', 'batch-1-0']);
  const defaults = await state({});
  assert.deepEqual(ids(defaults.transactions), ids(repositoryRows));
  assert.equal(defaults.meta.sortBy, 'date');
  assert.equal(defaults.meta.sortDirection, 'desc');
  assert.deepEqual(ids((await state({ sortBy: 'date', sortDirection: 'desc' })).transactions), ids(repositoryRows));
  const ascending = await state({ sortDirection: 'asc' });
  assert.equal(ascending.meta.sortBy, 'date');
  assert.equal(ascending.meta.sortDirection, 'asc');
  assert.deepEqual(bankIds(ascending.transactions), ['batch-1-2', 'batch-1-0', 'batch-1-4', 'batch-1-1', 'batch-1-3']);
  const partial = await state({ sortBy: 'description' });
  assert.equal(partial.meta.sortBy, 'description');
  assert.equal(partial.meta.sortDirection, 'desc');
});

test('Russian natural description sorting covers all 123 rows before each 50-row page in both directions', async t => {
  const { s, state } = await fixture(t, Array.from({ length: 123 }, (_, i) => ({
    date: `${month}-${String(1 + (i * 7) % 30).padStart(2, '0')}`,
    description: `Платёж ${1 + (i * 37) % 123}`,
  })));
  const all = s.repository.allTransactions();
  for (const sortDirection of ['desc', 'asc']) {
    const direction = sortDirection === 'desc' ? -1 : 1;
    const actual = await pages(state, { sortBy: 'description', sortDirection }, all.length);
    assert.deepEqual(ids(actual), ids([...all].sort((a, b) => direction * collator.compare(a.description, b.description))));
    assert.equal(actual[0].description, sortDirection === 'desc' ? 'Платёж 123' : 'Платёж 1');
    assert.equal(actual.at(-1).description, sortDirection === 'desc' ? 'Платёж 1' : 'Платёж 123');
  }
});

test('signed integer kopecks and ISO dates sort ascending and descending across pages, not by absolute or formatted money', async t => {
  const { s, state } = await fixture(t, Array.from({ length: 81 }, (_, i) => ({
    date: `${month}-${String(1 + (i * 11) % 30).padStart(2, '0')}`,
    amountMinor: (i - 40) * 137,
  })));
  const all = s.repository.allTransactions();
  for (const sortBy of ['amountMinor', 'date']) for (const sortDirection of ['desc', 'asc']) {
    const direction = sortDirection === 'desc' ? -1 : 1;
    const expected = [...all].sort((a, b) => direction * (sortBy === 'amountMinor' ? a.amountMinor - b.amountMinor : a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const actual = await pages(state, { sortBy, sortDirection }, all.length);
    assert.deepEqual(ids(actual), ids(expected));
    if (sortBy === 'amountMinor') {
      assert.equal(actual[0].amountMinor, direction * -5480);
      assert.equal(actual.at(-1).amountMinor, direction * 5480);
      assert.equal(actual[40].amountMinor, 0);
    }
  }
});

test('period, query and review filters run before sorting the complete result and then applying offset/limit', async t => {
  const { s, state } = await fixture(t, Array.from({ length: 126 }, (_, i) => ({
    date: i % 7 === 0 ? '2026-10-31' : `${month}-${String(1 + i % 30).padStart(2, '0')}`,
    amountMinor: (63 - i) * 101 + 1,
    description: i % 3 === 0 ? `Другая ${i}` : `ЦЕЛЬ ${i}`,
    needsReview: i % 4 !== 0,
  })));
  const all = s.repository.allTransactions({ from: `${month}-01`, to: `${month}-30` });
  const expected = all.filter(tx => tx.needsReview && tx.description.toLocaleLowerCase('ru-RU').includes('цель')).sort((a, b) => a.amountMinor - b.amountMinor);
  assert.ok(expected.length > 50);
  const args = { query: 'цЕлЬ', needsReview: true, sortBy: 'amountMinor', sortDirection: 'asc' };
  const result = await state({ ...args, offset: 17, limit: 13 });
  assert.equal(result.transactionTotal, expected.length);
  assert.deepEqual(ids(result.transactions), ids(expected.slice(17, 30)));
  assert.deepEqual(ids(await pages(state, args, expected.length)), ids(expected));
  assert.deepEqual(result.overview, (await state({})).overview);
});

test('reverted imports remain excluded from every sorted page and counts', async t => {
  const { s, add, state } = await fixture(t, Array.from({ length: 61 }, (_, i) => ({ amountMinor: i - 30 })));
  const reverted = await add([{ amountMinor: -999999, description: 'ААА' }, { amountMinor: 999999, description: 'ЯЯЯ' }]);
  const revertedIds = s.repository.allTransactions().filter(tx => tx.sourceImportId === reverted.importId).map(tx => tx.id);
  await s.execute('import.reverse', { id: reverted.importId });
  for (const sortBy of ['date', 'description', 'amountMinor', 'category', 'kind']) for (const sortDirection of ['desc', 'asc']) {
    const result = await pages(state, { sortBy, sortDirection }, 61);
    assert.ok(result.every(tx => !revertedIds.includes(tx.id)));
  }
  const result = await state({});
  assert.equal(result.overview.totalCount, 61);
  assert.equal(result.imports.find(row => row.id === reverted.importId).status, 'reverted');
});

test('unknown, inherited-prototype and SQL-like sort fields/directions reject strictly with FinanceError INVALID_SORT', async t => {
  const { state } = await fixture(t, []);
  const invalidKeys = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty', 'amount', 'date DESC; DROP TABLE transactions;--', '', 'Date', null, 0, {}, ['date']];
  const invalidDirections = ['__proto__', 'constructor', 'descending', 'ASC', 'asc; DELETE FROM transactions', 'desc --', '', null, false, {}, ['asc']];
  const invalidSort = error => error instanceof FinanceError && error.code === 'INVALID_SORT';
  for (const sortBy of invalidKeys) await assert.rejects(state({ sortBy }), invalidSort, `sortBy=${JSON.stringify(sortBy)}`);
  for (const sortDirection of invalidDirections) await assert.rejects(state({ sortBy: 'date', sortDirection }), invalidSort, `sortDirection=${JSON.stringify(sortDirection)}`);
  assert.equal((await state({})).transactionTotal, 0);
});

test('equal numeric/string/display keys retain repository date-desc/rowid-desc order for both directions across pages', async t => {
  const { s, state } = await fixture(t, Array.from({ length: 66 }, (_, i) => ({
    date: `${month}-${i % 2 ? '20' : '10'}`, amountMinor: -123,
    description: i % 2 ? 'ПЛАТЕЖ 2' : 'платеж 2', category: 'Прочее', kind: 'expense', needsReview: false,
  })));
  const expected = ids(s.repository.allTransactions());
  for (const sortBy of ['amountMinor', 'description', 'category', 'kind']) for (const sortDirection of ['desc', 'asc']) {
    assert.deepEqual(ids(await pages(state, { sortBy, sortDirection }, 66)), expected);
  }
});

test('category IDs resolve to Russian display names with natural numbers; kinds sort by Russian labels, not raw enum keys', async t => {
  const { s, state } = await fixture(t, []);
  await s.execute('category.save', { name: 'Категория 10' });
  await s.execute('category.save', { name: 'Категория 2' });
  const rows = [
    { category: 'Транспорт', kind: 'expense', amountMinor: -100 },
    { category: 'Продукты', kind: 'transfer', amountMinor: 100 },
    { category: 'Категория 10', kind: 'refund', amountMinor: 100 },
    { category: 'Дом и коммунальные услуги', kind: 'income', amountMinor: 100 },
    { category: 'Категория 2', kind: 'loan', amountMinor: -100 },
    { category: 'Продукты', kind: 'income', amountMinor: 100 },
  ];
  // Import via the public API, then simulate a supported legacy category-ID representation in memory.
  const account = s.repository.list('accounts')[0];
  const preview = await s.execute('import.preview', { accountId: account.id, fileName: 'labels.csv', csvText: 'Дата;Сумма;Описание;Идентификатор операции\n' + rows.map((row, i) => `10.11.2026;${row.amountMinor / 100};Метка ${i};label-${i}`).join('\n') });
  assert.deepEqual(preview.errors, []);
  await s.execute('import.commit', { previewId: preview.previewId });
  for (const [i, row] of rows.entries()) {
    const tx = s.repository.allTransactions().find(value => value.bankId === `label-${i}`);
    await s.execute('transaction.update', { id: tx.id, ...row, needsReview: false });
  }
  const legacy = s.repository.allTransactions().find(tx => tx.bankId === 'label-1');
  s.repository.writeTransaction({ ...legacy, category: 'groceries' });
  const all = s.repository.allTransactions();
  const categoryName = tx => s.repository.list('categories').find(c => c.id === tx.category || c.name === tx.category)?.name || tx.category || '—';
  const categoryOrder = ['Дом и коммунальные услуги', 'Категория 2', 'Категория 10', 'Продукты', 'Транспорт'];
  const kindOrder = ['refund', 'income', 'loan', 'transfer', 'expense'];
  for (const sortDirection of ['asc', 'desc']) {
    const categories = sortDirection === 'asc' ? categoryOrder : [...categoryOrder].reverse();
    const kinds = sortDirection === 'asc' ? kindOrder : [...kindOrder].reverse();
    assert.deepEqual(ids((await state({ sortBy: 'category', sortDirection })).transactions), ids(categories.flatMap(name => all.filter(tx => categoryName(tx) === name))));
    assert.deepEqual(ids((await state({ sortBy: 'kind', sortDirection })).transactions), ids(kinds.flatMap(kind => all.filter(tx => tx.kind === kind))));
  }
});

test('sorting never mutates repository arrays, database data/revision/audit, balances, counts or overview evidence ordering', async t => {
  const { s, state } = await fixture(t, [
    { date: '2026-11-01', description: 'Подписка', counterparty: 'Сервис', category: 'Подписки', needsReview: false, amountMinor: -12345 },
    { date: '2026-11-02', description: 'Подписка', counterparty: 'Сервис', category: 'Подписки', needsReview: false, amountMinor: -12345 },
    { date: '2026-11-03', description: 'Зарплата', category: 'Доход', needsReview: false, amountMinor: 900000 },
    { date: '2026-11-04', description: 'Покупка', amountMinor: -54321 },
  ]);
  const baseline = await state({});
  assert.ok(baseline.overview.insights.some(insight => insight.evidenceIds?.length === 2));
  const snapshot = () => ({
    tables: ['entities', 'imports', 'transactions', 'audit', 'reports'].map(table => s.repository.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
    changes: s.repository.db.prepare('SELECT total_changes() AS n').get().n,
    revision: s.repository.settings().revision,
  });
  const before = snapshot();
  const allTransactions = s.repository.allTransactions.bind(s.repository);
  s.repository.allTransactions = args => Object.freeze(allTransactions(args).map(tx => Object.freeze(tx)));
  for (const sortBy of ['date', 'description', 'amountMinor', 'category', 'kind']) for (const sortDirection of ['desc', 'asc']) {
    const result = await state({ sortBy, sortDirection, query: 'Подписка', needsReview: false, offset: 1, limit: 1 });
    assert.equal(result.transactionTotal, 2);
    assert.deepEqual(result.overview, baseline.overview);
    assert.deepEqual(result.accounts, baseline.accounts);
    assert.deepEqual(result.settings, baseline.settings);
  }
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(ids((await state({})).transactions), ids(baseline.transactions));
});
