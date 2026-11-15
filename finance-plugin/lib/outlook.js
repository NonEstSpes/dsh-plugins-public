/**
 * Pure, deterministic outlook; no storage, network, clocks or income-engine imports.
 * buildOutlook({asOf, transactions=[], imports=[], categories=[], obligations=[],
 *   goals=[], accounts=[], incomeMonths=[], currentRegularNetMinor?}).
 * asOf is a supplied Moscow YYYY-MM-DD; optional currentRegularNetMinor is an explicit
 * safe integer sustainable current income, independent of the projected cash horizon.
 * Transactions: {date,amountMinor,kind,needsReview,category,accountId,sourceImportId}.
 * Only needsReview === false is confirmed. Imports: {id,status,accountId,fromDate,toDate};
 * only committed declared ranges count. Category references accept existing id or name.
 * Income rows: {month,regularNetMinor,netMinor,conservativeNetMinor,optimisticNetMinor};
 * omitted/null monetary income fields mean unknown, never inferred from quarterly cash.
 *
 * Result: {asOf, period:{from,to,months:6}, history:[six chronological rows],
 * coverage:{accountCount,accounts:[{accountId,months:[{month,rangeCoveredDays,
 * rangeCovered}]}],fullRangeMonths,expenseMonths,unknownExpenseMonths,counts,warnings},
 * baseline:{historicalMonthlyExpenseMinor,plannedObligationsMinor,plannedTopUpMinor,
 * monthlyExpenseMinor,categoryFloors:[{category,historicalMonthlyExpenseMinor,
 * plannedMinor,monthlyExpenseMinor,topUpMinor}],
 * basisMonths:[YYYY-MM],basis:'full-range'|'partial-observed'|'unknown',
 * sustainableIncomeMinor,cashBalanceMinor,warnings}, projection:[{month,...incomeFields,
 * monthlyExpenseMinor,realisticSavingsMinor,conservativeSavingsMinor,
 * optimisticSavingsMinor,cumulativeSavingsMinor}],
 * score:{value:number|null,confidence:'low'|'medium',factors:[{key,label,points,
 * maxPoints,reason}],limitations}, optimizations:[category-only aggregates], warnings}.
 * History rows expose month, expenseMinor (null without any expense transactions),
 * confirmedExpenseMinor, unreviewedExpenseMinor, confirmedIncomeMinor, transactionCount,
 * observedDays (distinct transaction dates), rangeCoveredDays (intersection of per-account
 * unions), daysInMonth, rangeCovered, grossExpenseMinor and classification/refund counts.
 * Refunds clamp each category/month to zero; confirmed refunds first offset confirmed
 * expense, then unreviewed expense. No refund crosses a month/category boundary.
 * A missing expense month is UNKNOWN, even with a declared source range. Baseline uses
 * only expense-containing full-range months, otherwise expense-containing observed months;
 * enabled plans are floors PER canonical category, not wholesale additions. Category
 * historical averages use these same months, include unreviewed outflows and apply the
 * same net-refund policy. Unknown unresolved categories retain their net expense amounts
 * in an unnamed floor bucket; their original text is never echoed. Category floors are
 * local explanatory estimates, not matched operations/obligations.
 * plannedTopUpMinor = sum(max(category planned - category rounded average, 0)).
 * monthlyExpenseMinor = max(rounded TOTAL historical average + plannedTopUpMinor,
 * plannedObligationsMinor); this preserves the historical total without category-average
 * rounding drift, while enforcing the complete planned floor. The total-plan bound can
 * add a rounding-only correction, explained in warnings. Without any expense history,
 * historical/baseline/top-up and category historical/expense/top-up amounts stay null.
 * Projection includes supplied months >= asOf's month, sorted, with full-month amounts
 * (not a remaining-days cash forecast). Cumulative savings start at the first supplied
 * projected month, not the partial current month; missing amounts/internal gaps propagate null.
 * Optimizations use confirmed category amounts over the SAME baseline months; targets
 * are illustrative reductions, not achieved savings. Goals never become a spending floor.
 * All money is safe integer kopecks or explicitly null; malformed inputs/overflow throw.
 */
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const DAY = 86_400_000;
const fail = message => { throw new TypeError(`Outlook: ${message}`); };
const record = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
};
const integer = (value, label, nonnegative = false) => {
  if (!Number.isSafeInteger(value) || (nonnegative && value < 0)) fail(`${label} must be safe integer kopecks${nonnegative ? ' >= 0' : ''}`);
  return value;
};
const safe = value => {
  if (value > MAX || value < -MAX) fail('safe integer overflow');
  return Number(value);
};
const sum = values => safe(values.reduce((acc, value) => acc + BigInt(value), 0n));
const subtract = (a, b) => safe(BigInt(a) - BigInt(b));
const average = values => {
  if (!values.length) return null;
  const total = sum(values);
  return safe((BigInt(total) + BigInt(Math.floor(values.length / 2))) / BigInt(values.length));
};
const text = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${label} must be nonempty text`);
  return value;
};
const optionalBoolean = (value, label) => {
  if (value !== undefined && typeof value !== 'boolean') fail(`${label} must be boolean`);
};
function date(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '0001-01-01') fail(`${label} must be YYYY-MM-DD`);
  const result = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(result.valueOf()) || result.toISOString().slice(0, 10) !== value) fail(`${label} is not a calendar date`);
  return result;
}
function month(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}$/.test(value)) fail(`${label} must be YYYY-MM`);
  date(`${value}-01`, label);
  return value;
}
function shiftMonth(value, delta) {
  const result = date(`${value}-01`, 'month');
  result.setUTCMonth(result.getUTCMonth() + delta);
  const shifted = result.toISOString().slice(0, 7);
  month(shifted, 'shifted month');
  return shifted;
}
const dayNumber = value => date(value, 'date').valueOf() / DAY;
function monthInfo(value) {
  const from = `${value}-01`;
  const start = date(from, 'month');
  const end = new Date(start.valueOf());
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  return { month: value, from, to: end.toISOString().slice(0, 10), daysInMonth: end.getUTCDate() };
}
function uniqueIds(rows, label) {
  const seen = new Set();
  for (const row of rows) {
    record(row, label);
    if (row.id === undefined) continue;
    text(row.id, `${label}.id`);
    if (seen.has(row.id)) fail(`${label} duplicate id`);
    seen.add(row.id);
  }
}
const countTemplate = () => ({ confirmedExpenseCount: 0, unreviewedExpenseCount: 0,
  confirmedIncomeCount: 0, unreviewedIncomeCount: 0, confirmedRefundCount: 0,
  unreviewedRefundCount: 0, excludedTransferCount: 0, excludedLoanCount: 0 });
const blankBucket = () => ({ confirmed: 0, unreviewed: 0, refund: 0 });
const netBucket = bucket => {
  const gross = sum([bucket.confirmed, bucket.unreviewed]);
  const total = Math.max(0, subtract(gross, bucket.refund));
  const confirmed = Math.max(0, subtract(bucket.confirmed, bucket.refund));
  return { total, confirmed, unreviewed: subtract(total, confirmed) };
};
const unknownCategory = category => category.unknown === true || category.reviewOnly === true ||
  /^(unknown|uncategorized|review|без категории|неизвестно)$/iu.test(category.id ?? '') ||
  /^(unknown|uncategorized|без категории|неизвестно)$/iu.test(category.name ?? '');

export function buildOutlook(input) {
  record(input, 'input');
  const { asOf } = input;
  date(asOf, 'asOf');
  const lists = {};
  for (const key of ['transactions', 'imports', 'categories', 'obligations', 'goals', 'accounts', 'incomeMonths']) {
    const rows = input[key] === undefined ? [] : input[key];
    if (!Array.isArray(rows)) fail(`${key} must be an array`);
    uniqueIds(rows, key);
    lists[key] = rows;
  }
  const { transactions, imports, categories, obligations, goals, accounts, incomeMonths } = lists;
  const currentMonth = asOf.slice(0, 7);
  const months = Array.from({ length: 6 }, (_, index) => monthInfo(shiftMonth(currentMonth, index - 6)));
  const period = { from: months[0].from, to: months[5].to, months: 6 };
  const warnings = [
    'Заявленные периоды выписок и проверка оборотов не доказывают полноту истории, охват всех банков или всех счетов.',
    'Пустые месяцы и месяцы без расходных операций считаются неизвестными, а не подтверждением отсутствия расходов.',
  ];
  const categoryLookup = new Map();
  categories.forEach(category => {
    if (category.id === undefined && category.name === undefined) fail('category needs id or name');
    optionalBoolean(category.protected, 'category.protected');
    optionalBoolean(category.unknown, 'category.unknown');
    optionalBoolean(category.reviewOnly, 'category.reviewOnly');
    for (const key of [category.id, category.name].filter(value => value !== undefined)) {
      text(key, 'category reference');
      if (categoryLookup.has(key) && categoryLookup.get(key) !== category) fail('ambiguous category reference');
      categoryLookup.set(key, category);
    }
  });
  const resolveCategory = value => value === undefined || value === null || value === '' ? null : categoryLookup.get(text(value, 'transaction.category')) ?? null;
  const importLookup = new Map();
  const accountDays = new Map();
  const ensureAccount = key => {
    if (!accountDays.has(key)) accountDays.set(key, new Set());
    return accountDays.get(key);
  };
  for (const source of imports) {
    text(source.id, 'import.id');
    text(source.status, 'import.status');
    importLookup.set(source.id, source);
    if (source.status !== 'committed') continue;
    text(source.accountId, 'import.accountId');
    date(source.fromDate, 'import.fromDate'); date(source.toDate, 'import.toDate');
    if (source.fromDate > source.toDate) fail('import date range is reversed');
    const from = source.fromDate < period.from ? period.from : source.fromDate;
    const to = source.toDate > period.to ? period.to : source.toDate;
    if (from > to) continue;
    const days = ensureAccount(source.accountId);
    for (let day = dayNumber(from); day <= dayNumber(to); day++) days.add(day);
  }
  const internals = months.map(info => ({ ...info, counts: countTemplate(), buckets: new Map(),
    observed: new Set(), transactionCount: 0, income: 0, gross: 0, refund: 0, ignoredRefund: 0 }));
  let excludedSourceTransactionCount = 0;
  for (const transaction of transactions) {
    date(transaction.date, 'transaction.date');
    integer(transaction.amountMinor, 'transaction.amountMinor');
    if (!['expense', 'income', 'refund', 'transfer', 'loan'].includes(transaction.kind)) fail('invalid transaction.kind');
    optionalBoolean(transaction.needsReview, 'transaction.needsReview');
    if (transaction.kind === 'expense' && transaction.amountMinor >= 0) fail('expense must be negative');
    if (['income', 'refund'].includes(transaction.kind) && transaction.amountMinor <= 0) fail('income/refund must be positive');
    if (transaction.accountId !== undefined) text(transaction.accountId, 'transaction.accountId');
    if (transaction.sourceImportId !== undefined) text(transaction.sourceImportId, 'transaction.sourceImportId');
    const category = resolveCategory(transaction.category);
    const source = importLookup.get(transaction.sourceImportId);
    if (source && source.accountId !== undefined && transaction.accountId !== undefined && source.accountId !== transaction.accountId) fail('transaction/import account mismatch');
    if (transaction.date < period.from || transaction.date > period.to) continue;
    if (source && source.status !== 'committed') { excludedSourceTransactionCount++; continue; }
    ensureAccount(transaction.accountId ?? null);
    const row = internals.find(item => item.month === transaction.date.slice(0, 7));
    row.transactionCount++;
    row.observed.add(transaction.date);
    const confirmed = transaction.needsReview === false;
    if (transaction.kind === 'transfer') { row.counts.excludedTransferCount++; continue; }
    if (transaction.kind === 'loan') { row.counts.excludedLoanCount++; continue; }
    if (transaction.kind === 'income') {
      row.counts[confirmed ? 'confirmedIncomeCount' : 'unreviewedIncomeCount']++;
      if (confirmed) row.income = sum([row.income, transaction.amountMinor]);
      continue;
    }
    // Preserve separate unknown categories, without echoing their raw text in the result.
    const key = category ?? `unknown:${transaction.category ?? ''}`;
    if (!row.buckets.has(key)) row.buckets.set(key, blankBucket());
    const bucket = row.buckets.get(key);
    if (transaction.kind === 'expense') {
      const amount = -transaction.amountMinor;
      bucket[confirmed ? 'confirmed' : 'unreviewed'] = sum([bucket[confirmed ? 'confirmed' : 'unreviewed'], amount]);
      row.gross = sum([row.gross, amount]);
      row.counts[confirmed ? 'confirmedExpenseCount' : 'unreviewedExpenseCount']++;
    } else {
      row.counts[confirmed ? 'confirmedRefundCount' : 'unreviewedRefundCount']++;
      if (confirmed) { bucket.refund = sum([bucket.refund, transaction.amountMinor]); row.refund = sum([row.refund, transaction.amountMinor]); }
      else row.ignoredRefund = sum([row.ignoredRefund, transaction.amountMinor]);
    }
  }
  const relevantAccounts = [...accountDays.keys()].sort((a, b) => String(a).localeCompare(String(b), 'en'));
  const coverageAccounts = relevantAccounts.map(accountId => ({ accountId, months: months.map(info => {
    const days = accountDays.get(accountId);
    let rangeCoveredDays = 0;
    for (let day = dayNumber(info.from); day <= dayNumber(info.to); day++) if (days.has(day)) rangeCoveredDays++;
    return { month: info.month, rangeCoveredDays, rangeCovered: rangeCoveredDays === info.daysInMonth };
  }) }));
  const history = internals.map(row => {
    let rangeCoveredDays = 0;
    for (let day = dayNumber(row.from); day <= dayNumber(row.to); day++) {
      if (relevantAccounts.length && relevantAccounts.every(key => accountDays.get(key).has(day))) rangeCoveredDays++;
    }
    const expenseKnown = row.counts.confirmedExpenseCount + row.counts.unreviewedExpenseCount > 0;
    const amounts = [...row.buckets.values()].map(netBucket);
    return { month: row.month, expenseMinor: expenseKnown ? sum(amounts.map(item => item.total)) : null,
      confirmedExpenseMinor: expenseKnown ? sum(amounts.map(item => item.confirmed)) : null,
      unreviewedExpenseMinor: expenseKnown ? sum(amounts.map(item => item.unreviewed)) : null,
      confirmedIncomeMinor: row.income, transactionCount: row.transactionCount, observedDays: row.observed.size,
      rangeCoveredDays, daysInMonth: row.daysInMonth, rangeCovered: rangeCoveredDays === row.daysInMonth,
      grossExpenseMinor: row.gross, confirmedRefundMinor: row.refund,
      ignoredUnreviewedRefundMinor: row.ignoredRefund, ...row.counts };
  });
  const expenseRows = history.filter(row => row.expenseMinor !== null);
  const fullExpenseRows = expenseRows.filter(row => row.rangeCovered);
  const basisRows = fullExpenseRows.length ? fullExpenseRows : expenseRows;
  const basis = fullExpenseRows.length ? 'full-range' : expenseRows.length ? 'partial-observed' : 'unknown';
  const basisMonths = basisRows.map(row => row.month);
  const historicalMonthlyExpenseMinor = average(basisRows.map(row => row.expenseMinor));
  if (basis === 'partial-observed') warnings.push('Нет месяца с расходами и полным заявленным периодом выписок: расходы за неполные месяцы дают лишь нижнюю оценку, а не полную месячную стоимость жизни.');
  if (basis === 'unknown') warnings.push('История расходов отсутствует: добавьте или импортируйте расходы, чтобы получить оценку затрат, накоплений и финансового здоровья.');
  if (history.some(row => !row.rangeCovered)) warnings.push('За один или несколько месяцев нет полного заявленного периода выписок по каждому счёту, встречающемуся в операциях или импортах.');
  if (history.some(row => row.unreviewedExpenseCount)) warnings.push('Непроверенные расходные списания включены в оценку из предосторожности; проверьте их категории и типы перед использованием прогноза.');
  if (history.some(row => row.unreviewedRefundCount)) warnings.push('Непроверенные возвраты не уменьшают прогнозируемые расходы.');
  // Derive category net averages from exactly the selected total-history basis months.
  // Unresolved raw category names stay private; their independently clamped refund
  // buckets are combined ONLY after netting, into a generic unknown floor category.
  const categoryHistory = new Map();
  for (const [index, value] of basisMonths.entries()) {
    const row = internals.find(item => item.month === value);
    for (const [key, bucket] of row.buckets) {
      const canonical = typeof key === 'string' ? null : key;
      if (!categoryHistory.has(canonical)) categoryHistory.set(canonical, Array(basisMonths.length).fill(0));
      const amounts = categoryHistory.get(canonical);
      amounts[index] = sum([amounts[index], netBucket(bucket).total]);
    }
  }
  const categoryPlans = new Map();
  for (const plan of obligations) {
    integer(plan.amountMinor, 'obligation.amountMinor', true);
    optionalBoolean(plan.enabled, 'obligation.enabled');
    const canonical = resolveCategory(plan.category);
    if (plan.enabled === false) continue;
    categoryPlans.set(canonical, sum([categoryPlans.get(canonical) ?? 0, plan.amountMinor]));
  }
  const plannedObligationsMinor = sum([...categoryPlans.values()]);
  const floorKeys = new Set([...categoryHistory.keys(), ...categoryPlans.keys()]);
  const categoryFloors = [...floorKeys].map(canonical => {
    const historical = historicalMonthlyExpenseMinor === null ? null :
      average(categoryHistory.get(canonical) ?? Array(basisMonths.length).fill(0));
    const plannedMinor = categoryPlans.get(canonical) ?? 0;
    const topUpMinor = historical === null ? null : Math.max(0, subtract(plannedMinor, historical));
    return { category: canonical?.name ?? canonical?.id ?? 'Без категории',
      historicalMonthlyExpenseMinor: historical, plannedMinor,
      monthlyExpenseMinor: historical === null ? null : Math.max(historical, plannedMinor), topUpMinor };
  });
  const plannedTopUpMinor = historicalMonthlyExpenseMinor === null ? null : sum(categoryFloors.map(item => item.topUpMinor));
  const historicalWithTopUps = historicalMonthlyExpenseMinor === null ? null : sum([historicalMonthlyExpenseMinor, plannedTopUpMinor]);
  const monthlyExpenseMinor = historicalWithTopUps === null ? null : Math.max(historicalWithTopUps, plannedObligationsMinor);
  if (historicalWithTopUps !== null && monthlyExpenseMinor > historicalWithTopUps) {
    warnings.push('Из-за округления средних по категориям итоговая база дополнительно ограничена снизу общей суммой включённых обязательств.');
  }
  warnings.push('База расходов сохраняет общее историческое среднее и добавляет только превышение включённых обязательств над историческим средним той же категории. Это оценочный минимум по категориям, а не подтверждённое сопоставление операций с конкретными обязательствами. Денежные выплаты по долгам и неоднозначная классификация могут приводить к пропускам или пересечениям; расходы без категории могут пересекаться с планами, новые долговые выплаты могут отсутствовать.');
  // Goals are not expenditure and saved goal amounts are not additional cash balances.
  for (const goal of goals) for (const key of ['targetMinor', 'savedMinor', 'monthlyMinor']) {
    if (goal[key] !== undefined) integer(goal[key], `goal.${key}`, true);
  }
  const knownAccountIds = new Set(accounts.map(account => account.id).filter(id => id !== undefined));
  const accountBalances = accounts.map(account => {
    if (account.balanceMinor === undefined || account.balanceMinor === null) return null;
    return integer(account.balanceMinor, 'account.balanceMinor');
  });
  const balanceKnown = accounts.length > 0 && accountBalances.every(value => value !== null) &&
    relevantAccounts.every(id => id !== null && knownAccountIds.has(id));
  const cashBalanceMinor = balanceKnown ? sum(accountBalances) : null;
  if (!balanceKnown) warnings.push('Остатки денежных средств неполны или неизвестны; баллы за резерв ликвидности не начисляются.');
  const incomeKeys = ['regularNetMinor', 'netMinor', 'conservativeNetMinor', 'optimisticNetMinor'];
  const seenMonths = new Set();
  const incomes = incomeMonths.map(row => {
    month(row.month, 'incomeMonths.month');
    if (seenMonths.has(row.month)) fail('duplicate income month');
    seenMonths.add(row.month);
    const normalized = { month: row.month };
    for (const key of incomeKeys) normalized[key] = row[key] === undefined || row[key] === null ? null : integer(row[key], `incomeMonths.${key}`);
    return normalized;
  }).filter(row => row.month >= currentMonth).sort((a, b) => a.month < b.month ? -1 : 1);
  // Explicit current income is independent of a future-only projection. Never substitute
  // next month's salary for a missing as-of-month sustainable income.
  const sustainableIncomeMinor = input.currentRegularNetMinor === undefined ?
    incomes.find(row => row.month === currentMonth)?.regularNetMinor ?? null :
    integer(input.currentRegularNetMinor, 'currentRegularNetMinor');
  let cumulative = 0;
  let previousMonth = null;
  const projection = incomes.map(row => {
    const savings = income => monthlyExpenseMinor === null || income === null ? null : subtract(income, monthlyExpenseMinor);
    const realisticSavingsMinor = savings(row.netMinor);
    if (previousMonth !== null && shiftMonth(previousMonth, 1) !== row.month) {
      cumulative = null;
      warnings.push('В прогнозе доходов пропущен календарный месяц; накопленная сумма сбережений после пропуска неизвестна.');
    }
    cumulative = cumulative === null || realisticSavingsMinor === null ? null : sum([cumulative, realisticSavingsMinor]);
    previousMonth = row.month;
    return { ...row, monthlyExpenseMinor, realisticSavingsMinor,
      conservativeSavingsMinor: savings(row.conservativeNetMinor), optimisticSavingsMinor: savings(row.optimisticNetMinor),
      cumulativeSavingsMinor: cumulative };
  });
  const canScore = monthlyExpenseMinor !== null && sustainableIncomeMinor !== null && sustainableIncomeMinor > 0;
  if (!canScore) warnings.push('Для оценки финансового здоровья нужны данные о расходах и положительный регулярный доход после налогов за месяц расчёта.');
  const clamp = value => Math.max(0, Math.min(1, value));
  const savingsPoints = canScore ? Math.round(40 * clamp((1 - monthlyExpenseMinor / sustainableIncomeMinor) / 0.3)) : 0;
  const planPoints = canScore ? Math.round(25 * clamp(1 - plannedObligationsMinor / sustainableIncomeMinor)) : 0;
  const liquidityPoints = canScore && balanceKnown && monthlyExpenseMinor > 0 ?
    Math.round(35 * clamp((cashBalanceMinor / monthlyExpenseMinor) / 3)) : 0;
  const factors = [
    { key: 'savingsCapacity', label: 'Устойчивая способность к накоплению', points: savingsPoints, maxPoints: 40,
      reason: canScore ? 'Учитывается только регулярный доход после налогов; возможность откладывать не менее 30% даёт 40 баллов. Квартальные поступления заранее не учитываются.' : 'Расходы или положительный регулярный доход неизвестны.' },
    { key: 'essentialPlanBurden', label: 'Нагрузка заявленных обязательных платежей', points: planPoints, maxPoints: 25,
      reason: canScore ? '25 × (1 − сумма включённых обязательств / регулярный доход), от 0 до 25 баллов. Учитываются только заявленные платежи, а не все необходимые расходы.' : 'Расходы или положительный регулярный доход неизвестны.' },
    { key: 'liquidityBuffer', label: 'Известный резерв ликвидности', points: liquidityPoints, maxPoints: 35,
      reason: !balanceKnown ? 'Остатки денежных средств неизвестны: 0 баллов, максимальная оценка не предполагается.' : !canScore || monthlyExpenseMinor === 0 ? 'Нет данных о расходах, доходе или положительной сумме месячных расходов для расчёта резерва.' : 'Остатки на указанных счетах в размере трёх месяцев оценочных расходов дают 35 баллов; часть средств может быть зарезервирована на другие цели.' },
  ];
  const score = { value: canScore ? savingsPoints + planPoints + liquidityPoints : null,
    confidence: canScore && fullExpenseRows.length >= 3 && balanceKnown && !history.some(row => row.unreviewedExpenseCount) ? 'medium' : 'low',
    factors, limitations: ['Предварительная эвристическая оценка финансового здоровья, а не кредитоспособность, кредитный рейтинг или решение о выдаче кредита.',
      'Указанные счета, периоды выписок, остатки и обязательства могут быть неполными; история по всем банкам не подтверждена.',
      'Обязательства могут пересекаться с расходами; денежные потоки по долгам, зарезервированные средства, нерегулярные будущие траты и инфляция учтены не полностью.',
      'Даже при расчёте в середине текущего месяца используется база расходов за полный месяц.'] };
  const optimizations = [];
  for (const category of categories) {
    if (category.protected === true || unknownCategory(category) || !basisRows.length) continue;
    const amounts = basisMonths.map(value => netBucket(internals.find(row => row.month === value).buckets.get(category) ?? blankBucket()).confirmed);
    const historicalTotalExpenseMinor = sum(amounts);
    if (historicalTotalExpenseMinor <= 0) continue;
    const actualHistoricalMonthlyExpenseMinor = average(amounts);
    optimizations.push({ categoryId: category.id ?? null, category: category.name ?? category.id,
      historicalTotalExpenseMinor, actualHistoricalMonthlyExpenseMinor, basisMonths: [...basisMonths],
      basis, confirmedOnly: true, illustrative: true,
      targets: [10, 20].map(reductionPercent => {
        const illustrativeMonthlyReductionMinor = safe(BigInt(actualHistoricalMonthlyExpenseMinor) * BigInt(reductionPercent) / 100n);
        return { reductionPercent, targetMonthlyExpenseMinor: subtract(actualHistoricalMonthlyExpenseMinor, illustrativeMonthlyReductionMinor),
          illustrativeMonthlyReductionMinor, realized: false };
      }), warning: 'Примеры сокращения подтверждённых исторических расходов категории на 10% и 20%, а не уже полученная экономия или рекомендация сокращать необходимые расходы.' });
  }
  optimizations.sort((a, b) => b.actualHistoricalMonthlyExpenseMinor - a.actualHistoricalMonthlyExpenseMinor || String(a.categoryId ?? a.category).localeCompare(String(b.categoryId ?? b.category), 'en'));
  const counts = { transactionCount: sum(history.map(row => row.transactionCount)), excludedSourceTransactionCount };
  for (const key of Object.keys(countTemplate())) counts[key] = sum(history.map(row => row[key]));
  const deduplicatedWarnings = [...new Set(warnings)];
  return { asOf, period, history,
    coverage: { accountCount: relevantAccounts.length, accounts: coverageAccounts,
      fullRangeMonths: history.filter(row => row.rangeCovered).map(row => row.month),
      expenseMonths: expenseRows.map(row => row.month), unknownExpenseMonths: history.filter(row => row.expenseMinor === null).map(row => row.month),
      counts, warnings: [...deduplicatedWarnings] },
    baseline: { historicalMonthlyExpenseMinor, plannedObligationsMinor, plannedTopUpMinor, categoryFloors,
      monthlyExpenseMinor, basisMonths, basis,
      sustainableIncomeMinor, cashBalanceMinor, warnings: [...deduplicatedWarnings] },
    projection, score, optimizations, warnings: deduplicatedWarnings };
}
