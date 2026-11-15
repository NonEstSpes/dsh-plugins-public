import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { FinanceRepository, FinanceError, assert, text, integer, isoDate, monthValue, todayMoscow, monthRange, sumMinor } from './repository.js';
import { parseCsvFile, suggestMapping, buildImport, evaluateIncome, computeReport, projectSavings, FinanceMappingError } from './finance-core.js';
import { extractPdf } from './pdf.js';
import { buildOutlook } from './outlook.js';
import { AI_ROUTE, buildAdvicePayload, adviceHash, generateAdvice } from './advice.js';

export const FINANCE_VERSION = '0.1.14';
const fingerprint = t => createHash('sha256').update(JSON.stringify([t.date, t.postedDate || t.date, t.amountMinor, t.currency, t.description.normalize('NFKC').replace(/\s+/g, ' ').trim(), t.counterparty.normalize('NFKC').replace(/\s+/g, ' ').trim()])).digest('hex');
export const ACTIONS = ['state','account.save','category.save','import.preview','import.remap','import.commit','import.discard','import.reverse','transaction.update','rule.save','income.save','income.calculate','income.reconcile','income.unmatch','goal.save','budget.save','obligation.save','forecast','outlook','advice.generate','report.generate','settings.save','export.csv'];
export const AGENT_ACTIONS = ACTIONS.filter(a => !['import.preview', 'settings.save', 'export.csv'].includes(a));
const transactionCollator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' });
const transactionKindLabels = new Map(Object.entries({ income: 'Доходы', expense: 'Расход', transfer: 'Перевод', refund: 'Возврат', loan: 'Заём' }));
const transactionSortValues = {
  date: t => t.date,
  description: t => t.description,
  amountMinor: t => t.amountMinor,
  category: (t, categories) => categories.get(t.category) || t.category || '—',
  kind: t => transactionKindLabels.get(t.kind) || t.kind,
};

/** One operation layer shared by authenticated UI and agent tools. Raw imports never enter chat logs. */
export class FinanceService {
  constructor(databasePath, options = {}) {
    this.options = { maxUploadMiB: 10, previewTtlMinutes: 15, backupRetention: 7, ...options };
    this.repository = new FinanceRepository(databasePath, options); this.previews = new Map(); this.pendingPdf = 0; this.closed = false; this.abortController = new AbortController();
  }
  expirePreviews() {
    const now = Date.now(); for (const [id, p] of this.previews) if (p.expiresAtMs <= now) this.previews.delete(id);
  }
  async execute(action, args = {}, { caller = 'ui' } = {}) {
    assert(!this.closed, 'CLOSED', 'Плагин отключён.');
    assert(ACTIONS.includes(action), 'UNKNOWN_ACTION', 'Неизвестное действие финансового плагина.');
    assert(args && typeof args === 'object' && !Array.isArray(args), 'INVALID_INPUT', 'Аргументы должны быть объектом.');
    if (caller === 'agent') {
      assert(this.repository.settings().agentAccess === true, 'AGENT_ACCESS_DISABLED', 'Доступ агента к финансовым данным выключен. Пользователь может включить его в разделе «Финансы → Отчёты и настройки».');
      assert(AGENT_ACTIONS.includes(action), 'USER_ONLY', 'Это действие доступно только пользователю в интерфейсе.');
    }
    this.expirePreviews(); const r = this.repository;
    switch (action) {
      case 'state': return this.state(args);
      case 'account.save': return r.saveAccount(args, caller);
      case 'category.save': return r.saveCategory(args, caller);
      case 'import.preview': return this.preview(args);
      case 'import.remap': return this.remap(args);
      case 'import.discard': { this.previews.delete(text(args.previewId, 'Предпросмотр', 80)); return { discarded: true }; }
      case 'import.commit': {
        const p = this.getPreview(args.previewId);
        assert(!p.mappingRequired, 'MAPPING_REQUIRED', 'Выберите обязательные колонки и пересчитайте предпросмотр перед импортом.');
        assert(!p.errors.length && p.transactions.length > 0, 'IMPORT_INVALID', 'Исправьте ошибки строк перед импортом.');
        assert(!p.parsed.statementSummary || p.statementVerification === 'matched', 'STATEMENT_MISMATCH', 'Обороты или остатки не совпали с контрольными данными PDF. Импорт остановлен.');
        assert(p.verification !== 'mismatch', 'BALANCE_MISMATCH', 'Обороты не соответствуют контрольным остаткам. Импорт остановлен.');
        const rows = args.includeDuplicateRows || [];
        assert(Array.isArray(rows) && rows.length <= 20000 && rows.every(n => Number.isSafeInteger(n) && p.transactions.some(t => t.sourceRow === n && t.duplicate && t.duplicateReason === 'fingerprint')), 'INVALID_INPUT', 'Некорректный список повторных операций.');
        const value = r.commitPreview(p, new Set(rows), caller); this.previews.delete(p.previewId); return value;
      }
      case 'import.reverse': return r.reverseImport(args, caller);
      case 'transaction.update': return r.updateTransaction(args, caller);
      case 'rule.save': return r.saveRule(args, caller);
      case 'income.calculate': return evaluateIncome(args.model, args.scenario || 'base', { month: args.month || todayMoscow(r.clock()).slice(0, 7), mode: args.mode || 'cash' });
      case 'income.save': { this.validateIncome(args); const calculation = evaluateIncome(args, 'base', { month: args.effectiveFrom, mode: 'cash' }); return r.saveIncome(args, calculation, caller); }
      case 'income.reconcile': {
        const m = r.get('incomeModels', text(args.modelId, 'Модель', 80)); assert(m, 'NOT_FOUND', 'Модель дохода не найдена.');
        monthValue(args.period); assert(args.period >= m.effectiveFrom, 'INVALID_PERIOD', 'Модель ещё не действовала в выбранном периоде.');
        return r.reconcile(args, evaluateIncome(m, 'base', { month: args.period, mode: 'cash' }).netMinor, caller);
      }
      case 'income.unmatch': return r.unmatchIncome(args, caller);
      case 'goal.save': return r.saveSimple('goals', args, caller);
      case 'budget.save': return r.saveSimple('budgets', args, caller);
      case 'obligation.save': return r.saveSimple('obligations', args, caller);
      case 'settings.save': return r.saveSettings(args, caller);
      case 'forecast': return this.forecast(args);
      case 'outlook': return this.outlook(args);
      case 'advice.generate': return this.generateAdvice(args, caller);
      case 'report.generate': return this.report(args);
      case 'export.csv': return this.exportCsv(args);
      default: throw new FinanceError('UNKNOWN_ACTION', 'Неизвестное действие.');
    }
  }
  validateIncome(model) {
    assert(model && typeof model === 'object', 'INVALID_INPUT', 'Укажите модель дохода.');
    integer(model.salaryMinor, 'Оклад'); integer(model.deductionsMinor ?? 0, 'Удержания');
    assert(Array.isArray(model.components || []) && (model.components || []).length <= 20, 'INVALID_INPUT', 'Не более 20 компонентов дохода.');
    const ids = new Set();
    for (const c of model.components || []) {
      text(c.id, 'Идентификатор компонента', 80); text(c.label, 'Название компонента', 100);
      assert(!ids.has(c.id), 'INVALID_INPUT', 'Идентификаторы компонентов не должны повторяться.'); ids.add(c.id);
      if (c.guaranteed !== undefined) assert(typeof c.guaranteed === 'boolean', 'INVALID_INPUT', 'Гарантированность должна быть логическим значением.');
      if (c.enabled !== undefined) assert(typeof c.enabled === 'boolean', 'INVALID_INPUT', 'Признак включения должен быть логическим значением.');
    }
  }
  decorateReport(data, transactions, { from, to }) {
    const r = this.repository;
    const format = value => { const n = BigInt(value), a = n < 0n ? -n : n; return `${n < 0n ? '−' : ''}${a / 100n},${String(a % 100n).padStart(2, '0')} ₽`; };
    const protectedNames = new Set([...r.list('categories').filter(c => c.protected).map(c => c.name), ...r.list('budgets').filter(b => b.protected).map(b => b.category)]);
    const fullMonth = from && to && from.endsWith('-01') && monthRange(from.slice(0, 7)).to === to;
    if (fullMonth) for (const budget of r.list('budgets')) {
      const amount = data.categories.find(c => c.category === budget.category)?.expenseMinor || 0;
      if (amount <= budget.limitMinor) continue;
      const excess = sumMinor([amount, -budget.limitMinor], 'Превышение бюджета');
      const protect = protectedNames.has(budget.category);
      data.insights.push({ kind: protect ? 'budget' : 'saving',
        text: protect ? `По защищённой категории «${budget.category}» факт выше плана на ${format(excess)}. Проверьте реалистичность бюджета; сокращение необходимых расходов не предлагается.` : `Лимит категории «${budget.category}» превышен на ${format(excess)}. Перед следующей необязательной покупкой проверьте её приоритет; снижение будущих расходов на эту сумму — сценарий возврата к плану, не гарантированная экономия.`,
        evidenceIds: transactions.filter(t => t.category === budget.category).slice(0, 10).map(t => t.id) });
    }
    const subscriptionGroups = new Map();
    for (const t of transactions) if (t.kind === 'expense' && t.category === 'Подписки' && !t.needsReview) {
      const name = t.counterparty || t.description; if (!name) continue;
      const key = name.normalize('NFKC').trim().toLocaleLowerCase('ru-RU'); const group = subscriptionGroups.get(key) || [];
      group.push(t); subscriptionGroups.set(key, group);
    }
    for (const group of subscriptionGroups.values()) {
      if (group.length < 2 || protectedNames.has('Подписки')) continue;
      const amount = sumMinor(group.map(t => -t.amountMinor), 'Повторные подписки');
      data.insights.push({ kind: 'saving', text: `В категории «Подписки» повторяется один получатель: ${group.length} списаний на ${format(amount)}. Проверьте, нужны ли все подписки; отменяйте только после проверки условий. Повтор сам по себе не доказывает ошибку.`, evidenceIds: group.slice(0, 10).map(t => t.id) });
      if (data.insights.length >= 12) break;
    }
    return data;
  }
  state(args) {
    const sortBy = args.sortBy === undefined ? 'date' : args.sortBy, sortDirection = args.sortDirection === undefined ? 'desc' : args.sortDirection;
    assert(typeof sortBy === 'string' && Object.hasOwn(transactionSortValues, sortBy), 'INVALID_SORT', 'Неизвестное поле сортировки операций.');
    assert(sortDirection === 'desc' || sortDirection === 'asc', 'INVALID_SORT', 'Направление сортировки: desc или asc.');
    const r = this.repository, currentMonth = todayMoscow(r.clock()).slice(0, 7), currentRange = monthRange(currentMonth);
    const history = r.db.prepare("SELECT count(*) AS totalCount,min(t.date) AS firstDate,max(t.date) AS latestDate,sum(CASE WHEN t.date>=? AND t.date<=? THEN 1 ELSE 0 END) AS currentCount FROM transactions t JOIN imports i ON i.id=t.import_id WHERE i.status='committed'").get(currentRange.from, currentRange.to);
    const explicitPeriod = Boolean(args.month || args.from || args.to);
    const defaultMonth = history.currentCount ? currentMonth : history.latestDate?.slice(0, 7) || currentMonth;
    const month = args.month ? monthValue(args.month) : explicitPeriod ? currentMonth : defaultMonth;
    const monthSelection = explicitPeriod ? 'explicit' : month === currentMonth ? 'current' : 'latest_available';
    const range = monthRange(month); const from = args.from ? isoDate(args.from) : range.from, to = args.to ? isoDate(args.to) : range.to;
    assert(from <= to, 'INVALID_DATE', 'Начало периода позже окончания.');
    const accounts = r.accounts(), all = r.allTransactions({ from, to });
    let txs = all;
    if (args.needsReview) txs = txs.filter(t => t.needsReview);
    if (args.query) { const q = text(args.query, 'Поиск', 200).toLocaleLowerCase('ru-RU'); txs = txs.filter(t => [t.description, t.counterparty, t.note, t.category].join(' ').toLocaleLowerCase('ru-RU').includes(q)); }
    const categories = r.list('categories'), categoryNames = new Map();
    for (const c of categories) for (const key of [c.id, c.name]) if (!categoryNames.has(key)) categoryNames.set(key, c.name);
    const sortValue = transactionSortValues[sortBy], direction = sortDirection === 'desc' ? -1 : 1;
    // Sort a copy of the entire filtered set; equal keys retain repository date/rowid order.
    txs = [...txs].sort((a, b) => {
      const left = sortValue(a, categoryNames), right = sortValue(b, categoryNames);
      const comparison = sortBy === 'amountMinor' ? left - right : sortBy === 'date' ? (left < right ? -1 : left > right ? 1 : 0) : transactionCollator.compare(left, right);
      return direction * comparison;
    });
    const limit = integer(args.limit ?? 100, 'Размер страницы', { min: 1, max: 200 }), offset = integer(args.offset ?? 0, 'Смещение', { max: 10_000_000 });
    const imports = r.imports(); const activeImports = imports.filter(i => i.status === 'committed');
    const latest = history.latestDate || null;
    const balanceMinor = accounts.length && accounts.every(a => a.balanceMinor !== null) ? sumMinor(accounts.map(a => a.balanceMinor), 'Общий остаток') : null;
    const goals = r.list('goals'), obligations = r.list('obligations'), goalReservedMinor = sumMinor(goals.map(g => g.savedMinor), 'Резервы целей');
    const upcomingObligationsMinor = sumMinor(obligations.filter(o => o.enabled !== false).map(o => o.amountMinor), 'Обязательства');
    const overview = this.decorateReport(computeReport(all, { from, to }), all, { from, to });
    const protectedCategories = new Set([...r.list('categories').filter(c => c.protected), ...r.list('budgets').filter(b => b.protected)].map(c => c.name || c.category));
    overview.insights = (overview.insights || []).filter(i => i.kind !== 'saving' || ![...protectedCategories].some(c => i.text.includes(c)));
    return { accounts, categories, transactions: txs.slice(offset, offset + limit), transactionTotal: txs.length,
      imports, rules: r.list('rules'), incomeModels: r.list('incomeModels'), incomeMatches: r.list('incomeMatches'), goals,
      budgets: r.list('budgets'), obligations, settings: r.settings(),
      overview: { ...overview, totalCount: history.totalCount, firstDate: history.firstDate || null, balanceMinor, latestDate: latest, lastImportAt: activeImports[0]?.createdAt || null, goalReservedMinor, upcomingObligationsMinor,
        safeToSpendMinor: balanceMinor === null ? null : sumMinor([balanceMinor, -goalReservedMinor, -upcomingObligationsMinor], 'Свободный остаток'),
        balanceWarning: 'Остаток вычислен только по загруженным операциям после даты начального остатка. Резерв обязательств — полный месяц, не банковская блокировка.' },
      reports: r.reports(60), meta: { version: FINANCE_VERSION, currency: 'RUB', rawStorage: 'memory-only', dataDirectory: r.path === ':memory:' ? ':memory:' : dirname(r.path), encrypted: false, month, monthSelection, from, to, sortBy, sortDirection, ...(this.options.clientUiStatus ? { clientUi: { ...this.options.clientUiStatus } } : {}), timeZone: 'Europe/Moscow' } };
  }
  async preview(args) {
    this.repository.requireAccount(args.accountId);
    const fileName = text(args.fileName || 'manual.csv', 'Имя файла', 200).replace(/[\\/]/g, '_');
    assert(this.previews.size < 8, 'PREVIEW_LIMIT', 'Слишком много предпросмотров. Отмените лишние или подождите 15 минут.');
    let bytes;
    if (typeof args.csvText === 'string') {
      assert(args.base64 === undefined && args.csvText.length <= this.options.maxUploadMiB * 1024 * 1024, 'UPLOAD_TOO_LARGE', 'CSV слишком большой или передан дважды.'); bytes = Buffer.from(args.csvText, 'utf8');
    } else {
      assert(typeof args.base64 === 'string' && args.base64.length <= Math.ceil(this.options.maxUploadMiB * 1024 * 1024 / 3) * 4 && /^[A-Za-z0-9+/]*={0,2}$/.test(args.base64) && args.base64.length % 4 === 0, 'INVALID_UPLOAD', 'Неверный формат или размер файла.');
      bytes = Buffer.from(args.base64, 'base64');
    }
    assert(bytes.length > 0 && bytes.length <= this.options.maxUploadMiB * 1024 * 1024, 'UPLOAD_TOO_LARGE', `Файл должен быть не больше ${this.options.maxUploadMiB} МиБ.`);
    const fileHash = createHash('sha256').update(bytes).digest('hex'); let parsed, format, extractedText;
    if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
      assert(this.pendingPdf < 2, 'BUSY', 'Уже обрабатывается PDF. Повторите после завершения.'); this.pendingPdf++;
      try { const result = await extractPdf(bytes, { signal: this.abortController.signal }); parsed = result.parsed; extractedText = result.extractedText; } finally { this.pendingPdf--; }
      format = 'PDF';
    } else {
      assert(!/\.pdf$/i.test(fileName), 'INVALID_PDF', 'Содержимое файла не является PDF.');
      assert(/\.(csv|txt|tsv)$/i.test(fileName), 'UNSUPPORTED_FILE', 'Поддерживаются только CSV, TSV и текстовый PDF.');
      parsed = parseCsvFile(bytes, args.options || {}); format = 'CSV';
    }
    const suggested = suggestMapping(parsed.headers);
    const manualControls = args.openingMinor !== undefined || args.closingMinor !== undefined;
    return this.buildPreview({ accountId: args.accountId, fileName, fileHash, parsed, format, extractedText, suggestedWarnings: args.mapping ? [] : suggested.warnings || [], mapping: args.mapping || suggested.mapping,
      openingMinor: manualControls ? args.openingMinor : parsed.statementSummary?.openingMinor, closingMinor: manualControls ? args.closingMinor : parsed.statementSummary?.closingMinor });
  }
  getPreview(id) { const p = this.previews.get(text(id, 'Предпросмотр', 80)); assert(p && p.expiresAtMs > Date.now(), 'PREVIEW_EXPIRED', 'Предпросмотр истёк. Загрузите файл заново; на диск он не сохранялся.'); return p; }
  remap(args) {
    const old = this.getPreview(args.previewId);
    assert(args.mapping && typeof args.mapping === 'object' && !Array.isArray(args.mapping), 'INVALID_MAPPING', 'Укажите сопоставление колонок.');
    const openingMinor = Object.hasOwn(args, 'openingMinor') ? (args.openingMinor ?? undefined) : old.openingMinor;
    const closingMinor = Object.hasOwn(args, 'closingMinor') ? (args.closingMinor ?? undefined) : old.closingMinor;
    const result = this.buildPreview({ ...old, suggestedWarnings: [], mapping: args.mapping, openingMinor, closingMinor }); this.previews.delete(old.previewId); return result;
  }
  buildPreview(source) {
    let result;
    try { result = buildImport(source.parsed, source.mapping); }
    catch (error) {
      // Unknown column captions are recoverable: retain the parsed table so the user can map it.
      // Do not catch malformed tables, bad money, or unrelated parser/programming errors here.
      if (!(error instanceof FinanceMappingError)) throw error;
      result = { transactions: [], errors: [{ scope: 'mapping', field: error.field, code: error.code, sourceRow: null, message: error.message }], warnings: [], totals: null, period: { from: null, to: null } };
    }
    const errors = [...(result.errors || [])]; const seen = new Map(), seenBank = new Map();
    const counts = this.repository.fingerprintCounts(source.accountId), bank = this.repository.bankOperations(source.accountId);
    const transactions = result.transactions.map(t => {
      const normalized = { ...t, description: t.description || '', counterparty: t.counterparty || '', bankId: t.bankId || '', postedDate: t.postedDate || t.date, category: 'Без категории', needsReview: true, kind: t.amountMinor < 0 ? 'expense' : 'income' };
      const key = fingerprint(normalized), occurrence = (seen.get(key) || 0) + 1; seen.set(key, occurrence);
      const priorBank = normalized.bankId ? bank.get(normalized.bankId) || seenBank.get(normalized.bankId) : undefined;
      if (normalized.bankId) seenBank.set(normalized.bankId, normalized);
      if (priorBank && (priorBank.amountMinor !== normalized.amountMinor || priorBank.date !== normalized.date || priorBank.currency !== normalized.currency)) errors.push({ sourceRow: t.sourceRow, message: 'Банковский ID уже встречался с другой датой или суммой.' });
      const duplicate = Boolean(priorBank) || (!normalized.bankId && occurrence <= (counts.get(key) || 0));
      return { ...normalized, fingerprint: key, duplicate, duplicateReason: duplicate ? (priorBank ? 'bank_id' : 'fingerprint') : null };
    });
    let verification = result.totals ? 'not_provided' : 'not_calculated';
    if (source.openingMinor !== undefined || source.closingMinor !== undefined) {
      assert(source.openingMinor !== undefined && source.closingMinor !== undefined, 'BALANCES_REQUIRED', 'Укажите оба контрольных остатка или оставьте оба пустыми.');
      integer(source.openingMinor, 'Начальный контрольный остаток', { min: -100_000_000_000_000 }); integer(source.closingMinor, 'Конечный контрольный остаток', { min: -100_000_000_000_000 });
      if (result.totals) verification = sumMinor([source.openingMinor, result.totals.netMinor], 'Контрольный остаток') === source.closingMinor ? 'balanced' : 'mismatch';
    }
    let statementVerification = 'not_available';
    const summary = source.parsed.statementSummary;
    if (summary) {
      assert(summary.currency === 'RUB' && ['openingMinor','closingMinor','creditMinor','debitMinor'].every(k => Number.isSafeInteger(summary[k])) && summary.creditMinor >= 0 && summary.debitMinor >= 0, 'INVALID_STATEMENT_CONTROLS', 'Контрольные данные PDF некорректны.');
      if (!result.totals || errors.length) { statementVerification = 'not_calculated'; verification = 'not_calculated'; }
      else {
        const matched = result.totals.creditMinor === summary.creditMinor && result.totals.debitMinor === summary.debitMinor
          && BigInt(summary.openingMinor) + BigInt(result.totals.netMinor) === BigInt(summary.closingMinor);
        statementVerification = matched ? 'matched' : 'mismatch';
        if (!matched) verification = 'mismatch';
        else if (verification === 'not_provided') verification = 'balanced';
      }
    }
    const previewId = randomUUID(), expiresAtMs = Date.now() + this.options.previewTtlMinutes * 60000;
    const warnings = [...new Set([...(source.parsed.warnings || []), ...(source.suggestedWarnings || []), ...(result.warnings || []),
      ...(verification === 'not_provided' ? ['Контрольные остатки не заданы: суммы строк прочитаны, но полнота выписки не подтверждена.'] : []),
      ...(source.format === 'PDF' && source.parsed.pdfLayout?.id !== 'vtb-account-v1' ? ['Универсальный разбор PDF по геометрии таблицы. Сверьте количество операций, знаки сумм и контрольные остатки с оригиналом; этот макет не распознан как проверенный банковский шаблон.'] : []),
      ...(statementVerification === 'mismatch' ? ['Восстановленные обороты или остатки не совпали с контрольными данными PDF. Импорт заблокирован.'] : []),
      ...(transactions.some(t => t.duplicate) ? ['Возможные повторы исключаются при подтверждении; одинаковые реальные покупки можно включить явно по строкам.'] : [])])];
    const preview = { ...source, ...result, transactions, errors, warnings, previewId, expiresAtMs, expiresAt: new Date(expiresAtMs).toISOString(), verification, statementVerification, mappingRequired: result.totals === null, duplicateCount: transactions.filter(t => t.duplicate).length, rowCount: source.parsed.rows.length };
    this.previews.set(previewId, preview); return this.publicPreview(preview);
  }
  publicPreview(p) {
    return { previewId: p.previewId, headers: p.parsed.headers, sampleRows: p.parsed.rows.slice(0, 8), mapping: p.mapping, mappingRequired: p.mappingRequired,
      transactions: p.transactions.slice(0, 200).map(({ fingerprint: _, ...t }) => t), errors: p.errors.slice(0, 200), errorCount: p.errors.length, warnings: p.warnings,
      totals: p.totals, period: p.period, rowCount: p.rowCount, transactionCount: p.transactions.length, duplicateCount: p.duplicateCount, verification: p.verification, statementVerification: p.statementVerification, statementSummary: p.parsed.statementSummary || null, pdfLayout: p.parsed.pdfLayout || null, expiresAt: p.expiresAt, format: p.format,
      ...(p.extractedText ? { extractedText: p.extractedText.slice(0, 200000) } : {}) };
  }
  outlook(args = {}) {
    const r = this.repository, now = todayMoscow(r.clock()), currentMonth = now.slice(0, 7);
    const models = r.list('incomeModels').filter(m => m.effectiveFrom <= currentMonth).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt) || b.version - a.version);
    const model = args.modelId ? r.get('incomeModels', text(args.modelId, 'Модель', 80)) : models[0];
    assert(model, 'INCOME_REQUIRED', 'Сначала сохраните действующую модель дохода.');
    assert(model.effectiveFrom <= currentMonth, 'FUTURE_MODEL', 'Выбрана ещё не действующая модель.');
    const count = integer(args.months ?? 6, 'Горизонт прогноза', { min: 1, max: 12 });
    const [year, month] = currentMonth.split('-').map(Number);
    const shift = delta => new Date(Date.UTC(year, month - 1 + delta, 1)).toISOString().slice(0, 7);
    const regular = evaluateIncome(model, 'base', { mode: 'regular' });
    const average = evaluateIncome(model, 'base', { mode: 'average' });
    const incomeMonths = Array.from({ length: count }, (_, i) => {
      const period = shift(i + 1);
      return { month: period, regularNetMinor: regular.netMinor,
        netMinor: evaluateIncome(model, 'base', { month: period, mode: 'cash' }).netMinor,
        conservativeNetMinor: evaluateIncome(model, 'conservative', { month: period, mode: 'cash' }).netMinor,
        optimisticNetMinor: evaluateIncome(model, 'optimistic', { month: period, mode: 'cash' }).netMinor };
    });
    const protectedBudgetCategories = new Set(r.list('budgets').filter(b => b.protected).map(b => b.category));
    const outlookCategories = r.list('categories').map(c => ({ ...c, protected: c.protected === true || protectedBudgetCategories.has(c.id) || protectedBudgetCategories.has(c.name) }));
    const result = buildOutlook({ asOf: now, transactions: r.allTransactions({ from: `${shift(-6)}-01`, to: monthRange(shift(-1)).to }), imports: r.imports(), categories: outlookCategories, obligations: r.list('obligations'), goals: r.list('goals'), accounts: r.accounts(), incomeMonths, currentRegularNetMinor: regular.netMinor });
    result.model = { id: model.id, name: model.name, version: model.version, taxRateBps: model.taxRateBps ?? 0, regularNetMinor: regular.netMinor, averageNetMinor: average.netMinor, averageIsNotAvailableMonthly: true };
    result.warnings = [...new Set([...result.warnings, ...regular.warnings, ...average.warnings, 'Прогноз начинается со следующего полного месяца; текущий неполный месяц в накопления не включён.', 'Ставка НДФЛ — явно заданное допущение модели, не расчёт всех правил прогрессивного налогообложения.', 'Сценарии меняют премии, но используют общую расходную базу: это не гарантированный предел расходов.', 'Историческое среднее включает разовые покупки; повторение каждого платежа не подтверждено.', 'Остаток рассчитан по начальным остаткам и загруженным операциям; более поздние поступления и другие счета могут быть не учтены.'])];
    const payload = buildAdvicePayload(result), payloadHash = adviceHash(payload, r.settings().revision, model.id);
    const latest = r.get('advice', 'latest') || null;
    result.ai = { ...AI_ROUTE, available: !!this.options.llm?.listProviders().some(p => p.id === AI_ROUTE.provider), payload, payloadHash, latest, stale: !!latest && latest.payloadHash !== payloadHash };
    return result;
  }
  async generateAdvice(args, caller) {
    assert(!this.advicePending, 'AI_BUSY', 'Совет уже рассчитывается. Дождитесь результата.');
    const result = this.outlook(args);
    assert(result.ai.available, 'AI_ROUTE_UNAVAILABLE', 'Маршрут OpenCode Go недоступен; другая модель автоматически не используется.');
    this.advicePending = true;
    try {
      const signal = AbortSignal.any([this.abortController.signal, AbortSignal.timeout(90000)]);
      const advice = await generateAdvice(this.options.llm, result.ai.payload, signal);
      const current = this.outlook(args);
      assert(current.ai.payloadHash === result.ai.payloadHash, 'AI_DATA_CHANGED', 'Данные изменились во время расчёта. Получите новый совет.');
      const record = { id: 'latest', ...AI_ROUTE, generatedAt: this.repository.now(), payloadHash: result.ai.payloadHash, groupLabels: result.optimizations.filter(x => !x.protected).slice(0, 8).map((x, i) => ({ key: `group-${i + 1}`, category: x.category })), ...advice };
      this.repository.atomic(() => { this.repository.put('advice', record); this.repository.audit(caller, 'advice.generate', record.id, { provider: record.provider, model: record.model, payloadHash: record.payloadHash }); });
      return record;
    } catch (error) {
      if (error instanceof FinanceError) throw error;
      this.lastAdviceError = error.safeDiagnostics || { stage: 'unknown', code: 'AI_GENERATION_FAILED' };
      throw new FinanceError('AI_GENERATION_FAILED', `Не удалось получить корректный совет DeepSeek V4.1 Flash через OpenCode Go. Другая модель и финансовые изменения не применялись. Диагностика: ${JSON.stringify(this.lastAdviceError)}`);
    } finally { this.advicePending = false; }
  }
  forecast(args) {
    const r = this.repository, warnings = [], now = todayMoscow(r.clock());
    const models = r.list('incomeModels').filter(m => m.effectiveFrom <= now.slice(0, 7)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt) || b.version - a.version);
    const model = args.modelId ? r.get('incomeModels', text(args.modelId, 'Модель дохода', 80)) : models[0];
    assert(model, 'INCOME_REQUIRED', 'Сначала сохраните действующую модель дохода.');
    assert(model.effectiveFrom <= now.slice(0, 7), 'FUTURE_MODEL', 'Модель ещё не действует. Выберите текущую модель.');
    const accounts = r.accounts();
    const balanceMinor = args.balanceMinor === undefined ? (accounts.length && accounts.every(a => a.balanceMinor !== null) ? sumMinor(accounts.map(a => a.balanceMinor), 'Общий остаток') : null) : integer(args.balanceMinor, 'Текущий остаток', { min: -100_000_000_000_000 });
    assert(balanceMinor !== null, 'BALANCE_REQUIRED', 'Укажите начальные остатки всех счетов или текущий остаток для прогноза.');
    let expenseMinor;
    const obligations = r.list('obligations').filter(o => o.enabled !== false), budgets = r.list('budgets');
    const plannedByCategory = new Map(budgets.map(b => [b.category, b.limitMinor]));
    const obligationsByCategory = new Map();
    for (const o of obligations) obligationsByCategory.set(o.category, sumMinor([obligationsByCategory.get(o.category) || 0, o.amountMinor], 'Обязательные платежи категории'));
    for (const [category, amount] of obligationsByCategory) plannedByCategory.set(category, Math.max(plannedByCategory.get(category) || 0, amount));
    const planned = sumMinor([...plannedByCategory.values()], 'План расходов');
    if (args.monthlyExpenseMinor !== undefined) { expenseMinor = integer(args.monthlyExpenseMinor, 'Расходы в месяц'); warnings.push('Ручная оценка расходов должна уже включать обязательные платежи: они не прибавляются повторно.'); }
    else if (budgets.length || obligations.length) { expenseMinor = planned; warnings.push('Расходы взяты из бюджетов и обязательств. По каждой категории взято большее из бюджета и суммы обязательных платежей: известные платежи не теряются и не прибавляются повторно. Проверьте полноту остальных расходов.'); }
    else {
      const historical = r.allTransactions({ to: `${now.slice(0, 7)}-01` }).filter(t => t.date < `${now.slice(0, 7)}-01`);
      const months = [...new Set(historical.map(t => t.date.slice(0, 7)))].sort().slice(-3);
      assert(months.length > 0, 'EXPENSES_REQUIRED', 'Укажите расходы в месяц или создайте бюджеты: полной истории для оценки пока нет.');
      expenseMinor = Math.max(0, Math.round(sumMinor(months.map(m => computeReport(historical.filter(t => t.date.startsWith(m)), monthRange(m)).expenseMinor), 'Исторические расходы') / months.length));
      warnings.push('Расходы оценены по операциям завершённых календарных месяцев. Полнота их выгрузок не доказана; это предварительная оценка, а не установленный бюджет.');
    }
    const months = integer(args.months ?? 12, 'Горизонт', { min: 1, max: 60 });
    const goals = r.list('goals').sort((a, b) => a.priority - b.priority), reservedMinor = sumMinor(goals.map(g => g.savedMinor), 'Резервы целей');
    assert(reservedMinor <= Math.max(0, balanceMinor), 'RESERVES_EXCEED_BALANCE', 'Уже накопленные суммы целей превышают доступный остаток. Уточните счета или распределение целей.');
    const scenarios = {};
    for (const scenario of ['conservative', 'base', 'optimistic']) {
      const calc = evaluateIncome(model, scenario);
      scenarios[scenario] = { ...projectSavings({ balanceMinor, incomeMinor: calc.netMinor, expenseMinor, reservedMinor, goals, months, asOf: now }), monthlyIncomeMinor: calc.netMinor, monthlyExpenseMinor: expenseMinor };
    }
    warnings.push('Прогноз помесячный, без гарантированной доходности и без точного внутри-месячного календаря выплат. Премии не гарантированы; сценарии могут совпадать, если допущения одинаковы.');
    return { scenarios, warnings, modelId: model.id, asOf: now };
  }
  report(args) {
    const r = this.repository, date = isoDate(args.date || todayMoscow(r.clock())); const period = args.period || 'day';
    assert(['day', 'week', 'month'].includes(period), 'INVALID_PERIOD', 'Выберите день, неделю или месяц.');
    let from = date, to = date;
    if (period === 'month') ({ from, to } = monthRange(date.slice(0, 7)));
    if (period === 'week') {
      const d = new Date(`${date}T12:00:00Z`), monday = new Date(d); monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      const sunday = new Date(monday); sunday.setUTCDate(monday.getUTCDate() + 6); from = monday.toISOString().slice(0, 10); to = sunday.toISOString().slice(0, 10);
    }
    const all = r.allTransactions({ from, to }), data = this.decorateReport(computeReport(all, { from, to }), all, { from, to });
    const imports = r.imports().filter(i => i.status === 'committed');
    const latestDate = r.db.prepare("SELECT max(t.date) AS date FROM transactions t JOIN imports i ON i.id=t.import_id WHERE i.status='committed'").get().date || null;
    const warnings = [];
    if (!latestDate || latestDate < to) warnings.push('Данные могут быть неполными: последняя операция раньше окончания отчётного периода. Нулевые расходы не означают, что трат не было.');
    if (data.unknownCount) warnings.push(`Требуют уточнения: ${data.unknownCount}. Итоговые движения денег учтены, распределение по категориям предварительное.`);
    warnings.push('Сверка контрольных остатков подтверждает только оборот отдельной выгрузки. Полнота всего периода по всем счетам не доказана; учитываются только загруженные операции.');
    const value = { id: randomUUID(), period, fromDate: from, toDate: to, createdAt: r.now(), data, freshness: { latestDate, lastImportAt: imports[0]?.createdAt || null }, warnings, revision: r.settings().revision };
    return r.putReport(`${period}:${from}:${to}:${value.revision}`, value);
  }
  exportCsv(args) {
    const list = this.repository.allTransactions({ from: args.from, to: args.to });
    assert(list.length <= 50000, 'EXPORT_TOO_LARGE', 'Выберите более короткий период экспорта (до 50 000 операций).');
    const cell = value => { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
    const rows = [['Дата','Дата проводки','Сумма RUB','Описание','Получатель','Категория','Тип','Проверить','Комментарий'].map(cell).join(';')];
    for (const t of list) rows.push([cell(t.date),cell(t.postedDate),`${t.amountMinor < 0 ? '-' : ''}${(BigInt(t.amountMinor) < 0n ? -BigInt(t.amountMinor) : BigInt(t.amountMinor)) / 100n},${String((BigInt(t.amountMinor) < 0n ? -BigInt(t.amountMinor) : BigInt(t.amountMinor)) % 100n).padStart(2, '0')}`,cell(t.description),cell(t.counterparty),cell(t.category),cell(t.kind),cell(t.needsReview ? 'Да' : 'Нет'),cell(t.note)].join(';'));
    return { fileName: `finance-${todayMoscow(this.repository.clock())}.csv`, content: '\uFEFF' + rows.join('\r\n') };
  }
  tick() {
    if (this.closed) return; this.expirePreviews(); const r = this.repository, s = r.settings(), clock = r.clock();
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', hourCycle: 'h23' }).format(clock));
    if (s.reportsEnabled && hour >= s.reportHour) {
      const now = todayMoscow(clock); this.report({ period: 'day', date: now });
      const d = new Date(`${now}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() || 7)); this.report({ period: 'week', date: d.toISOString().slice(0, 10) });
      const m = new Date(`${now.slice(0, 7)}-01T12:00:00Z`); m.setUTCDate(0); this.report({ period: 'month', date: m.toISOString().slice(0, 10) });
    }
    if (s.revision > 0 && r.path !== ':memory:' && this.options.backupRetention > 0) r.backup(join(dirname(r.path), 'backups'), this.options.backupRetention);
  }
  close() { this.closed = true; this.abortController.abort(); this.previews.clear(); this.repository.close(); }
}
