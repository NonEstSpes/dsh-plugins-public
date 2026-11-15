import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOutlook } from '../lib/outlook.js';

const category = { id: 'leisure', name: 'Досуг', protected: false };
const fullImport = (overrides = {}) => ({ id: 'source', status: 'committed', accountId: 'a', fromDate: '2026-05-01', toDate: '2026-10-31', ...overrides });
const tx = (overrides = {}) => ({ date: '2026-10-10', amountMinor: -10_000, kind: 'expense', needsReview: false, category: 'Досуг', accountId: 'a', ...overrides });
const income = (overrides = {}) => ({ month: '2026-11', regularNetMinor: 40_000, netMinor: 40_000, conservativeNetMinor: 35_000, optimisticNetMinor: 45_000, ...overrides });
const build = (overrides = {}) => buildOutlook({ asOf: '2026-11-10', transactions: [tx()], imports: [fullImport()], categories: [category], accounts: [{ id: 'a', balanceMinor: 30_000 }], incomeMonths: [income()], ...overrides });
const october = result => result.history.find(row => row.month === '2026-10');

 test('last six COMPLETED calendar months exclude the current month and use transaction date', () => {
  const result = build({ transactions: [tx(), tx({ date: '2026-11-01', amountMinor: -777 }), tx({ date: '2026-04-30', amountMinor: -888 }), tx({ date: '2026-05-01', postedDate: '2026-11-01', amountMinor: -20_000 })] });
  assert.deepEqual(result.period, { from: '2026-05-01', to: '2026-10-31', months: 6 });
  assert.deepEqual(result.history.map(row => row.month), ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
  assert.equal(result.history[0].expenseMinor, 20_000);
  assert.equal(result.coverage.counts.transactionCount, 2);
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 15_000);
  assert.deepEqual(result.baseline.basisMonths, ['2026-05', '2026-10']);
});

test('year boundary and leap-year February use UTC calendar math', () => {
  const january = buildOutlook({ asOf: '2027-01-01' });
  assert.deepEqual(january.period, { from: '2026-07-01', to: '2026-12-31', months: 6 });
  const leap = buildOutlook({ asOf: '2024-03-31' });
  assert.deepEqual(leap.period, { from: '2023-09-01', to: '2024-02-29', months: 6 });
  assert.equal(leap.history.at(-1).daysInMonth, 29);
  assert.equal(buildOutlook({ asOf: '2025-03-01' }).history.at(-1).daysInMonth, 28);
});

test('no-expense months remain unknown even with declared full coverage', () => {
  const result = build();
  assert.equal(result.history[0].rangeCovered, true);
  assert.equal(result.history[0].expenseMinor, null);
  assert.equal(result.history[0].confirmedExpenseMinor, null);
  assert.equal(result.history[0].unreviewedExpenseMinor, null);
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 10_000);
  assert.deepEqual(result.baseline.basisMonths, ['2026-10']);
  assert.equal(result.coverage.unknownExpenseMonths.length, 5);
  assert.match(result.warnings.join(' '), /всех банков или всех счетов/);
});

test('partial expense fallback never divides incomplete spending by six', () => {
  const result = build({ imports: [fullImport({ fromDate: '2026-10-10', toDate: '2026-10-11' })], transactions: [tx(), tx({ date: '2026-10-11', amountMinor: -30_000, needsReview: true })] });
  assert.equal(october(result).observedDays, 2);
  assert.equal(october(result).rangeCoveredDays, 2);
  assert.equal(october(result).rangeCovered, false);
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 40_000);
  assert.equal(result.baseline.basis, 'partial-observed');
  assert.match(result.warnings.join(' '), /лишь нижнюю оценку/);
});

test('prefer full-range expense months over partial months and unknown full-range months', () => {
  const result = build({ imports: [fullImport({ fromDate: '2026-09-01', toDate: '2026-10-10' })], transactions: [tx({ date: '2026-09-10', amountMinor: -50_000 }), tx({ amountMinor: -2_000 })] });
  assert.equal(result.baseline.basis, 'full-range');
  assert.deepEqual(result.baseline.basisMonths, ['2026-09']);
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 50_000);
});

test('import unions handle overlaps, clipping, adjacency and gaps without double counting', () => {
  const result = build({ imports: [
    fullImport({ id: 'one', fromDate: '2026-04-01', toDate: '2026-10-15' }),
    fullImport({ id: 'two', fromDate: '2026-10-10', toDate: '2026-12-31' }),
    fullImport({ id: 'three', fromDate: '2026-10-01', toDate: '2026-10-31' }),
  ] });
  assert.equal(october(result).rangeCoveredDays, 31);
  assert.equal(result.history[0].rangeCoveredDays, 31);
  assert.equal(result.coverage.accounts[0].months.at(-1).rangeCoveredDays, 31);
  const gap = build({ imports: [fullImport({ id: 'one', fromDate: '2026-10-01', toDate: '2026-10-15' }), fullImport({ id: 'two', fromDate: '2026-10-17', toDate: '2026-10-31' })] });
  assert.equal(october(gap).rangeCoveredDays, 30);
  assert.equal(october(gap).rangeCovered, false);
  const adjacent = build({ imports: [fullImport({ id: 'one', fromDate: '2026-10-01', toDate: '2026-10-15' }), fullImport({ id: 'two', fromDate: '2026-10-16', toDate: '2026-10-31' })] });
  assert.equal(october(adjacent).rangeCovered, true);
});

test('reverted/reversed imports contribute neither range coverage nor transactions', () => {
  for (const status of ['reverted', 'reversed', 'preview']) {
    const result = build({ imports: [fullImport({ status })], transactions: [tx({ sourceImportId: 'source' })] });
    assert.equal(october(result).rangeCoveredDays, 0);
    assert.equal(october(result).transactionCount, 0);
    assert.equal(result.coverage.counts.excludedSourceTransactionCount, 1);
    assert.equal(result.baseline.monthlyExpenseMinor, null);
  }
});

test('every observed/import wallet must have a full range, not merely their combined union', () => {
  const result = build({ imports: [fullImport({ fromDate: '2026-10-01', toDate: '2026-10-15' }), fullImport({ id: 'b-source', accountId: 'b', fromDate: '2026-10-16', toDate: '2026-10-31' })], transactions: [tx(), tx({ accountId: 'b' })], accounts: [{ id: 'a', balanceMinor: 100 }, { id: 'b', balanceMinor: 200 }] });
  assert.equal(result.coverage.accountCount, 2);
  assert.equal(october(result).rangeCoveredDays, 0);
  assert.equal(october(result).rangeCovered, false);
  assert.deepEqual(result.coverage.accounts.map(row => row.months.at(-1).rangeCoveredDays), [15, 16]);
  const missing = build({ transactions: [tx(), tx({ accountId: 'b', kind: 'transfer', amountMinor: 10 })] });
  assert.equal(october(missing).rangeCovered, false);
  assert.equal(missing.baseline.cashBalanceMinor, null);
});

test('two-wallet transfers and loan cash flows are neutral to expense and confirmed income', () => {
  const result = build({ imports: [fullImport(), fullImport({ id: 'b-source', accountId: 'b' })], accounts: [{ id: 'a', balanceMinor: 10_000 }, { id: 'b', balanceMinor: 20_000 }], transactions: [tx(), tx({ kind: 'transfer', amountMinor: -50_000 }), tx({ kind: 'transfer', amountMinor: 50_000, accountId: 'b' }), tx({ kind: 'loan', amountMinor: 500_000 }), tx({ kind: 'loan', amountMinor: -5_000 }), tx({ kind: 'income', amountMinor: 40_000 }), tx({ kind: 'income', amountMinor: 400_000, needsReview: true })] });
  const row = october(result);
  assert.equal(row.expenseMinor, 10_000);
  assert.equal(row.confirmedIncomeMinor, 40_000);
  assert.equal(row.transactionCount, 7);
  assert.equal(row.excludedTransferCount, 2);
  assert.equal(row.excludedLoanCount, 2);
  assert.equal(row.unreviewedIncomeCount, 1);
  assert.equal(result.baseline.cashBalanceMinor, 30_000);
  assert.equal(row.rangeCovered, true);
});

test('confirmed refunds reduce expenses by category/month, clamp at zero, unreviewed refunds do not', () => {
  const other = { id: 'other', name: 'Прочее', protected: false };
  const result = build({ categories: [category, other], transactions: [
    tx({ amountMinor: -10_000 }), tx({ amountMinor: -5_000, needsReview: true }),
    tx({ kind: 'refund', amountMinor: 12_000 }), tx({ kind: 'refund', amountMinor: 99_000, needsReview: true }),
    tx({ category: 'other', amountMinor: -2_000 }), tx({ category: 'other', kind: 'refund', amountMinor: 5_000 }),
    tx({ date: '2026-09-02', kind: 'refund', amountMinor: 5_000 }),
  ] });
  const row = october(result);
  assert.equal(row.expenseMinor, 3_000);
  assert.equal(row.confirmedExpenseMinor, 0);
  assert.equal(row.unreviewedExpenseMinor, 3_000);
  assert.equal(row.grossExpenseMinor, 17_000);
  assert.equal(row.confirmedRefundMinor, 17_000);
  assert.equal(row.ignoredUnreviewedRefundMinor, 99_000);
  assert.equal(row.confirmedRefundCount, 2);
  assert.equal(row.unreviewedRefundCount, 1);
  assert.equal(result.history[4].expenseMinor, null);
  assert.equal(result.baseline.monthlyExpenseMinor, 3_000);
  assert.equal(result.optimizations.length, 0);
});

test('category id/name references share one refund bucket; unrelated categories never offset', () => {
  const result = build({ categories: [category, { id: 'other', name: 'Other' }], transactions: [tx(), tx({ category: 'leisure', kind: 'refund', amountMinor: 20_000 }), tx({ category: 'Other', amountMinor: -5_000 })] });
  assert.equal(october(result).expenseMinor, 5_000);
  assert.equal(october(result).confirmedExpenseMinor, 5_000);
});

test('unreviewed outflows forecast conservatively and unspecified review state is not confirmed', () => {
  const result = build({ transactions: [tx({ needsReview: true }), tx({ amountMinor: -20_000, needsReview: undefined }), tx({ kind: 'income', amountMinor: 80_000, needsReview: undefined })] });
  assert.equal(october(result).expenseMinor, 30_000);
  assert.equal(october(result).confirmedExpenseMinor, 0);
  assert.equal(october(result).confirmedIncomeMinor, 0);
  assert.equal(result.projection[0].realisticSavingsMinor, 10_000);
  assert.equal(result.optimizations.length, 0);
  assert.equal(result.score.confidence, 'low');
});

test('enabled obligations floor the SAME category without double counting; budgets/goals are not floors', () => {
  const first = build({ obligations: [{ id: 'rent', category: 'leisure', amountMinor: 7_000, enabled: true }, { category: 'Досуг', amountMinor: 999_000, enabled: false }], budgets: [{ limitMinor: 2_000_000 }], goals: [{ targetMinor: 8_000_000, monthlyMinor: 1_000_000, savedMinor: 1_000 }] });
  assert.equal(first.baseline.plannedObligationsMinor, 7_000);
  assert.equal(first.baseline.plannedTopUpMinor, 0);
  assert.equal(first.baseline.monthlyExpenseMinor, 10_000);
  assert.equal(first.projection[0].realisticSavingsMinor, 30_000);
  const second = build({ obligations: [{ category: 'leisure', amountMinor: 12_000 }, { category: 'Досуг', amountMinor: 3_000 }] });
  assert.equal(second.baseline.monthlyExpenseMinor, 15_000);
  assert.equal(second.baseline.plannedTopUpMinor, 5_000);
  assert.deepEqual(second.baseline.categoryFloors, [{ category: 'Досуг', historicalMonthlyExpenseMinor: 10_000, plannedMinor: 15_000, monthlyExpenseMinor: 15_000, topUpMinor: 5_000 }]);
  assert.match(second.warnings.join(' '), /Денежные выплаты по долгам и неоднозначная классификация/);
  assert.doesNotMatch(JSON.stringify(second), /matchedObligationIds/);
});

test('subscription price increases top up the category despite a higher total historical baseline', () => {
  const subscriptions = { id: 'subscriptions', name: 'Подписки' };
  const fixed = { id: 'fixed', name: 'Обязательные расходы', protected: true };
  const result = build({ categories: [category, subscriptions, fixed], transactions: [
    tx({ category: 'subscriptions', amountMinor: -300_000 }),
    tx({ category: 'fixed', amountMinor: -500_000 }),
    tx({ category: 'leisure', amountMinor: -4_100_000 }),
  ], obligations: [
    { category: 'Подписки', amountMinor: 1_000_000 }, { category: 'subscriptions', amountMinor: 400_000 },
    { category: 'fixed', amountMinor: 500_000 }, { category: 'subscriptions', amountMinor: 999_000, enabled: false },
  ] });
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 4_900_000);
  assert.equal(result.baseline.plannedObligationsMinor, 1_900_000);
  assert.equal(result.baseline.plannedTopUpMinor, 1_100_000);
  assert.equal(result.baseline.monthlyExpenseMinor, 6_000_000);
  const subscriptionFloor = result.baseline.categoryFloors.find(row => row.category === 'Подписки');
  assert.deepEqual(subscriptionFloor, { category: 'Подписки', historicalMonthlyExpenseMinor: 300_000, plannedMinor: 1_400_000, monthlyExpenseMinor: 1_400_000, topUpMinor: 1_100_000 });
  assert.equal(result.baseline.categoryFloors.find(row => row.category === 'Обязательные расходы').topUpMinor, 0);
});

test('category floors use SAME basis months, net confirmed refunds, and include unreviewed outflows', () => {
  const subscriptions = { id: 'subscriptions', name: 'Подписки' };
  const result = build({ categories: [category, subscriptions], imports: [fullImport({ fromDate: '2026-09-01', toDate: '2026-10-10' })], transactions: [
    tx({ date: '2026-09-01', category: 'subscriptions', amountMinor: -10_000 }),
    tx({ date: '2026-09-02', category: 'Подписки', amountMinor: -5_000, needsReview: true }),
    tx({ date: '2026-09-03', category: 'subscriptions', kind: 'refund', amountMinor: 2_000 }),
    tx({ date: '2026-09-04', category: 'subscriptions', kind: 'refund', amountMinor: 50_000, needsReview: true }),
    tx({ date: '2026-09-05', amountMinor: -20_000 }),
    tx({ category: 'subscriptions', amountMinor: -100_000 }),
  ], obligations: [{ category: 'Подписки', amountMinor: 16_000 }] });
  assert.deepEqual(result.baseline.basisMonths, ['2026-09']);
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 33_000);
  assert.equal(result.baseline.plannedTopUpMinor, 3_000);
  assert.equal(result.baseline.monthlyExpenseMinor, 36_000);
  assert.equal(result.baseline.categoryFloors.find(row => row.category === 'Подписки').historicalMonthlyExpenseMinor, 13_000);
});

test('unknown historical expenses remain included, new-category plans top up without raw-category disclosure', () => {
  const result = build({ transactions: [tx(), tx({ category: 'PRIVATE UNKNOWN CATEGORY', amountMinor: -4_000 }), tx({ category: 'OTHER PRIVATE CATEGORY', kind: 'refund', amountMinor: 8_000 })], obligations: [{ category: 'leisure', amountMinor: 8_000 }, { amountMinor: 7_000 }] });
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 14_000);
  assert.equal(result.baseline.plannedTopUpMinor, 3_000);
  assert.equal(result.baseline.monthlyExpenseMinor, 17_000);
  assert.deepEqual(result.baseline.categoryFloors.find(row => row.category === 'Без категории'), { category: 'Без категории', historicalMonthlyExpenseMinor: 4_000, plannedMinor: 7_000, monthlyExpenseMinor: 7_000, topUpMinor: 3_000 });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const newCategory = build({ categories: [category, { id: 'new', name: 'Новый платёж' }], obligations: [{ category: 'new', amountMinor: 2_000 }] });
  assert.equal(newCategory.baseline.monthlyExpenseMinor, 12_000);
});

test('category average rounding cannot drift the rounded TOTAL baseline and total plans remain a floor', () => {
  const extra = { id: 'extra', name: 'Дополнительное' };
  const options = { categories: [category, extra], transactions: [tx({ date: '2026-09-01', amountMinor: -1 }), tx({ category: 'extra', amountMinor: -1 })] };
  const noPlans = build(options);
  assert.equal(noPlans.baseline.historicalMonthlyExpenseMinor, 1);
  assert.equal(noPlans.baseline.monthlyExpenseMinor, 1);
  assert.equal(noPlans.baseline.categoryFloors.reduce((sum, row) => sum + row.historicalMonthlyExpenseMinor, 0), 2);
  const withPlans = build({ ...options, obligations: [{ category: 'leisure', amountMinor: 1 }, { category: 'extra', amountMinor: 1 }] });
  assert.equal(withPlans.baseline.historicalMonthlyExpenseMinor, 1);
  assert.equal(withPlans.baseline.plannedTopUpMinor, 0);
  assert.equal(withPlans.baseline.monthlyExpenseMinor, 2);
  assert.match(withPlans.warnings.join(' '), /Из-за округления средних по категориям/);
});

test('no expenses keeps expense, savings and score null even with income, balance and plans', () => {
  const result = build({ transactions: [tx({ kind: 'income', amountMinor: 100_000 })], obligations: [{ amountMinor: 15_000 }] });
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, null);
  assert.equal(result.baseline.plannedObligationsMinor, 15_000);
  assert.equal(result.baseline.monthlyExpenseMinor, null);
  assert.equal(result.baseline.plannedTopUpMinor, null);
  assert.deepEqual(result.baseline.categoryFloors, [{ category: 'Без категории', historicalMonthlyExpenseMinor: null, plannedMinor: 15_000, monthlyExpenseMinor: null, topUpMinor: null }]);
  assert.equal(result.projection[0].realisticSavingsMinor, null);
  assert.equal(result.projection[0].cumulativeSavingsMinor, null);
  assert.equal(result.score.value, null);
  assert.equal(result.score.confidence, 'low');
});

test('score is provisional, uses regular income rather than quarter cash and retains negative savings', () => {
  const result = build({ transactions: [tx({ amountMinor: -50_000 })], incomeMonths: [income({ regularNetMinor: 40_000, netMinor: 120_000, conservativeNetMinor: 30_000, optimisticNetMinor: 130_000 }), income({ month: '2026-12', regularNetMinor: 40_000, netMinor: 40_000, conservativeNetMinor: 30_000, optimisticNetMinor: 45_000 })] });
  assert.equal(result.baseline.sustainableIncomeMinor, 40_000);
  assert.equal(result.score.factors.find(row => row.key === 'savingsCapacity').points, 0);
  assert.equal(result.projection[0].realisticSavingsMinor, 70_000);
  assert.equal(result.projection[0].conservativeSavingsMinor, -20_000);
  assert.equal(result.projection[1].realisticSavingsMinor, -10_000);
  assert.equal(result.projection[1].optimisticSavingsMinor, -5_000);
  assert.equal(result.projection[1].cumulativeSavingsMinor, 60_000);
  assert.match(result.score.limitations.join(' '), /а не кредитоспособность/);
  assert.equal(result.score.confidence, 'low');
});

test('missing income means null score and unknown savings, never fallback to historical/bonus cash', () => {
  for (const incomeMonths of [[], [income({ regularNetMinor: null })], [income({ regularNetMinor: 0 })], [income({ month: '2026-12' })]]) {
    const result = build({ incomeMonths });
    assert.equal(result.score.value, null);
  }
  const result = build({ incomeMonths: [income({ netMinor: null, conservativeNetMinor: undefined, optimisticNetMinor: null })] });
  assert.equal(result.projection[0].realisticSavingsMinor, null);
  assert.equal(result.projection[0].conservativeSavingsMinor, null);
  assert.equal(result.projection[0].optimisticSavingsMinor, null);
});

test('explicit current regular income supports a future-only horizon without current-month cash', () => {
  const result = build({ currentRegularNetMinor: 40_000, incomeMonths: [income({ month: '2026-12', regularNetMinor: 999_000 }), income({ month: '2027-01', regularNetMinor: 999_000 })] });
  assert.deepEqual(result.projection.map(row => row.month), ['2026-12', '2027-01']);
  assert.equal(result.baseline.sustainableIncomeMinor, 40_000);
  assert.equal(result.score.value, 100);
  assert.equal(result.projection[0].cumulativeSavingsMinor, 30_000);
  assert.equal(result.projection[1].cumulativeSavingsMinor, 60_000);
  assert.equal(build({ currentRegularNetMinor: 0 }).score.value, null);
  assert.equal(build({ currentRegularNetMinor: 20_000 }).baseline.sustainableIncomeMinor, 20_000);
  for (const value of [null, '40000', 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => build({ currentRegularNetMinor: value }), TypeError);
  }
});

test('unknown balance receives zero liquidity points, no normalization to full points', () => {
  for (const accounts of [[], [{ id: 'a' }], [{ id: 'a', balanceMinor: null }], [{ id: 'a', balanceMinor: 30_000 }, { id: 'b', balanceMinor: null }]]) {
    const result = build({ accounts });
    assert.equal(result.baseline.cashBalanceMinor, null);
    assert.equal(result.score.factors.find(row => row.key === 'liquidityBuffer').points, 0);
    assert.equal(result.score.value, 65);
    assert.equal(result.score.confidence, 'low');
  }
  assert.equal(build().score.value, 100);
});

test('medium confidence requires multiple full-range reviewed months and known balances', () => {
  const result = build({ transactions: ['2026-08-01', '2026-09-01', '2026-10-01'].map(date => tx({ date })) });
  assert.equal(result.score.confidence, 'medium');
  assert.match(result.score.limitations[0], /Предварительная эвристическая оценка/);
});

test('protected, unknown and review-only categories are never optimized; targets are illustrative only', () => {
  const categories = [category, { id: 'health', name: 'Здоровье', protected: true }, { id: 'home', name: 'Дом', protected: true }, { id: 'education', name: 'Учеба', protected: true }, { id: 'unknown', name: 'Без категории', protected: false }, { id: 'review', name: 'Review later', reviewOnly: true }, { id: 'pending', name: 'Pending' }];
  const result = build({ categories, transactions: [tx({ counterparty: 'PRIVATE MERCHANT', description: 'PRIVATE DESCRIPTION', note: 'PRIVATE NOTE' }), ...categories.slice(1).map(item => tx({ category: item.id, needsReview: item.id === 'pending' })), tx({ category: 'UNREGISTERED PRIVATE CATEGORY' }), tx({ category: 'leisure', needsReview: true, amountMinor: -30_000 })] });
  assert.equal(result.optimizations.length, 1);
  const optimization = result.optimizations[0];
  assert.equal(optimization.categoryId, 'leisure');
  assert.equal(optimization.actualHistoricalMonthlyExpenseMinor, 10_000);
  assert.equal(optimization.confirmedOnly, true);
  assert.deepEqual(optimization.targets.map(row => row.targetMonthlyExpenseMinor), [9_000, 8_000]);
  assert.deepEqual(optimization.targets.map(row => row.illustrativeMonthlyReductionMinor), [1_000, 2_000]);
  assert.ok(optimization.targets.every(row => row.realized === false));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|UNREGISTERED/);
});

test('projections sort supplied future income months, propagate missing values and calendar gaps', () => {
  const result = build({ incomeMonths: [income({ month: '2027-02' }), income({ month: '2026-10' }), income({ month: '2026-12', netMinor: null }), income()] });
  assert.deepEqual(result.projection.map(row => row.month), ['2026-11', '2026-12', '2027-02']);
  assert.equal(result.projection[0].cumulativeSavingsMinor, 30_000);
  assert.equal(result.projection[1].cumulativeSavingsMinor, null);
  assert.equal(result.projection[2].cumulativeSavingsMinor, null);
  const gap = build({ incomeMonths: [income(), income({ month: '2027-01' })] });
  assert.equal(gap.projection[1].cumulativeSavingsMinor, null);
  assert.match(gap.warnings.join(' '), /пропущен календарный месяц/);
});

test('unknown account/date coverage never creates confidence or free-spending history', () => {
  const result = build({ transactions: [tx({ accountId: undefined })], imports: [] });
  assert.equal(october(result).rangeCovered, false);
  assert.equal(result.coverage.accounts[0].accountId, null);
  assert.equal(result.baseline.cashBalanceMinor, null);
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 10_000);
});

test('zero net expense after full refund is distinct from no observed expenses', () => {
  const result = build({ transactions: [tx(), tx({ kind: 'refund', amountMinor: 10_000 })] });
  assert.equal(october(result).expenseMinor, 0);
  assert.equal(result.baseline.monthlyExpenseMinor, 0);
  assert.equal(result.projection[0].realisticSavingsMinor, 40_000);
  assert.equal(result.score.factors.find(row => row.key === 'liquidityBuffer').points, 0);
});

test('malformed monetary, calendar, boolean, kind and duplicate inputs are rejected', () => {
  const bad = [
    { asOf: '2026-02-30' }, { asOf: '2026-11-10T00:00:00Z' }, { transactions: null },
    { transactions: [tx({ date: '2026-02-30' })] },
    { transactions: [tx({ amountMinor: -1.5 })] }, { transactions: [tx({ amountMinor: -Infinity })] },
    { transactions: [tx({ amountMinor: '-100' })] }, { transactions: [tx({ amountMinor: Number.MIN_SAFE_INTEGER - 1 })] },
    { transactions: [tx({ amountMinor: 1 })] }, { transactions: [tx({ kind: 'refund', amountMinor: -1 })] },
    { transactions: [tx({ kind: 'unknown' })] }, { transactions: [tx({ needsReview: 'false' })] },
    { transactions: [tx({ id: 'same' }), tx({ id: 'same' })] },
    { imports: [fullImport({ fromDate: '2026-10-31', toDate: '2026-10-01' })] },
    { imports: [fullImport({ accountId: '' })] },
    { imports: [fullImport(), fullImport()] },
    { transactions: [tx({ accountId: 'b', sourceImportId: 'source' })] },
    { obligations: [{ amountMinor: -1 }] }, { obligations: [{ amountMinor: 1, enabled: 'yes' }] },
    { accounts: [{ id: 'a', balanceMinor: NaN }] }, { accounts: [{ id: 'a', balanceMinor: '100' }] },
    { incomeMonths: [income({ month: '2026-13' })] }, { incomeMonths: [income(), income()] },
    { incomeMonths: [income({ netMinor: 1.1 })] }, { goals: [{ targetMinor: 0.1 }] },
    { categories: [{ ...category, protected: 'false' }] },
  ];
  for (const overrides of bad) assert.throws(() => build(overrides), TypeError, JSON.stringify(overrides));
});

test('safe integer aggregate, baseline, savings and cumulative overflow are rejected', () => {
  const max = Number.MAX_SAFE_INTEGER;
  assert.throws(() => build({ transactions: [tx({ amountMinor: -max }), tx({ amountMinor: -1 })] }), /overflow/);
  assert.throws(() => build({ obligations: [{ amountMinor: max }, { amountMinor: 1 }] }), /overflow/);
  assert.throws(() => build({ accounts: [{ id: 'a', balanceMinor: max }, { id: 'b', balanceMinor: 1 }] }), /overflow/);
  assert.throws(() => build({ incomeMonths: [income({ netMinor: -max })] }), /overflow/);
  assert.throws(() => build({ transactions: [tx({ amountMinor: -1 })], incomeMonths: [income({ netMinor: max }), income({ month: '2026-12', netMinor: max })] }), /overflow/);
});

test('rounding of historical averages and illustrative targets remains integer kopecks', () => {
  const result = build({ transactions: [tx({ date: '2026-09-01', amountMinor: -1 }), tx({ amountMinor: -2 })] });
  assert.equal(result.baseline.historicalMonthlyExpenseMinor, 2);
  assert.equal(result.optimizations[0].actualHistoricalMonthlyExpenseMinor, 2);
  assert.equal(result.optimizations[0].targets[0].illustrativeMonthlyReductionMinor, 0);
});

test('build is deterministic and does not mutate or consult implicit current time', () => {
  const input = { asOf: '2026-11-10', transactions: [tx()], imports: [fullImport()], categories: [category], accounts: [{ id: 'a', balanceMinor: 30_000 }], obligations: [], goals: [], incomeMonths: [income()] };
  const snapshot = structuredClone(input);
  const freeze = value => {
    if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  };
  freeze(input);
  const first = buildOutlook(input);
  assert.deepEqual(buildOutlook(input), first);
  assert.deepEqual(input, snapshot);
});
