import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readdirSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export class FinanceError extends Error {
  constructor(code, message) { super(message); this.name = 'FinanceError'; this.code = code; }
}
export function assert(condition, code, message) { if (!condition) throw new FinanceError(code, message); }
export function text(value, label, max = 500, optional = false) {
  if (optional && (value === undefined || value === null || (typeof value === 'string' && !value.trim()))) return '';
  assert(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_INPUT', `${label}: требуется текст до ${max} символов.`);
  return value.trim();
}
export function integer(value, label, { min = 0, max = 100_000_000_000_000 } = {}) {
  assert(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `${label}: недопустимое целое значение.`); return value;
}
export function isoDate(value, label = 'Дата') {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'INVALID_DATE', `${label}: используйте ГГГГ-ММ-ДД.`);
  const d = new Date(`${value}T12:00:00Z`);
  assert(Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value && value >= '1900-01-01' && value <= '2200-12-31', 'INVALID_DATE', `${label}: некорректная дата.`);
  return value;
}
export function monthValue(value) {
  assert(typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value), 'INVALID_DATE', 'Период: используйте ГГГГ-ММ.'); isoDate(`${value}-01`); return value;
}
export function todayMoscow(clock = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(clock);
  const get = type => parts.find(p => p.type === type).value; return `${get('year')}-${get('month')}-${get('day')}`;
}
export function monthRange(month) {
  monthValue(month); const [y, m] = month.split('-').map(Number);
  return { from: `${month}-01`, to: new Date(Date.UTC(y, m, 0, 12)).toISOString().slice(0, 10) };
}
export function sumMinor(values, label = 'Сумма') {
  const result = values.reduce((sum, value) => { assert(Number.isSafeInteger(value), 'AMOUNT_OVERFLOW', `${label}: неверное число копеек.`); return sum + BigInt(value); }, 0n);
  assert(result >= -BigInt(Number.MAX_SAFE_INTEGER) && result <= BigInt(Number.MAX_SAFE_INTEGER), 'AMOUNT_OVERFLOW', `${label}: переполнение безопасного денежного значения.`);
  return Number(result);
}
export const KINDS = ['income', 'expense', 'transfer', 'refund', 'loan'];
const defaults = [
  ['unknown', 'Без категории', false], ['groceries', 'Продукты', false], ['transport', 'Транспорт', false],
  ['home', 'Дом и коммунальные услуги', true], ['education', 'Образование', true], ['health', 'Здоровье', true],
  ['leisure', 'Досуг', false], ['subscriptions', 'Подписки', false], ['income', 'Доход', false], ['other', 'Прочее', false],
];
const parse = row => row ? JSON.parse(row.data) : undefined;

/** Dedicated financial database. Never resets unknown versions or unrelated files. */
export class FinanceRepository {
  constructor(path, { reportHour = 21, clock = () => new Date() } = {}) {
    this.path = path === ':memory:' ? path : resolve(path); this.clock = clock; this.closed = false;
    if (this.path !== ':memory:') {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      try { closeSync(openSync(this.path, 'wx', 0o600)); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    this.db = new DatabaseSync(this.path);
    try {
      const application = this.db.prepare('PRAGMA application_id').get().application_id;
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      assert(application === 1179209265 || (application === 0 && version === 0 && tables.length === 0), 'WRONG_DATABASE', 'Файл БД принадлежит другому приложению; он не будет изменён.');
      assert(version <= 1, 'NEWER_DATABASE', 'Версия финансовой БД новее плагина. Обновите плагин; данные сохранены.');
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000;');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS entities(collection TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(collection,id));
        CREATE TABLE IF NOT EXISTS imports(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,file_hash TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE UNIQUE INDEX IF NOT EXISTS import_active_hash ON imports(account_id,file_hash) WHERE status='committed';
        CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,import_id TEXT NOT NULL REFERENCES imports(id),date TEXT NOT NULL,amount_minor INTEGER NOT NULL,bank_id TEXT,fingerprint TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS tx_account_date ON transactions(account_id,date);
        CREATE INDEX IF NOT EXISTS tx_bank ON transactions(account_id,bank_id);
        CREATE INDEX IF NOT EXISTS tx_fingerprint ON transactions(account_id,fingerprint);
        CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,report_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,record_id TEXT,data TEXT NOT NULL);
        PRAGMA application_id=1179209265; PRAGMA user_version=1; COMMIT;`);
      this.atomic(() => {
        if (!this.get('settings', 'main')) this.put('settings', { id: 'main', reportHour, timeZone: 'Europe/Moscow', reportsEnabled: true, agentAccess: false, revision: 0 });
        if (!this.list('categories').length) for (const [id, name, protect] of defaults) this.put('categories', { id, name, protected: protect });
      });
    } catch (e) { this.db.close(); throw e; }
  }
  now() { return this.clock().toISOString(); }
  atomic(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const v = fn(); this.db.exec('COMMIT'); return v; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  get(collection, id) { return parse(this.db.prepare('SELECT data FROM entities WHERE collection=? AND id=?').get(collection, id)); }
  list(collection) { return this.db.prepare('SELECT data FROM entities WHERE collection=? ORDER BY updated_at,rowid').all(collection).map(parse); }
  put(collection, value) { this.db.prepare('INSERT INTO entities(collection,id,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(collection, value.id, JSON.stringify(value), this.now()); return value; }
  settings() { return this.get('settings', 'main'); }
  changed() { const s = this.settings(); s.revision++; this.put('settings', s); }
  audit(actor, action, id, value = {}) { this.db.prepare('INSERT INTO audit(created_at,actor,action,record_id,data) VALUES(?,?,?,?,?)').run(this.now(), actor, action, id || null, JSON.stringify(value)); }
  category(value) { const name = text(value, 'Категория', 100); assert(this.list('categories').some(c => c.name === name || c.id === name), 'UNKNOWN_CATEGORY', 'Сначала создайте категорию.'); return this.list('categories').find(c => c.name === name || c.id === name).name; }
  requireAccount(id) { const a = this.get('accounts', text(id, 'Счёт', 80)); assert(a, 'ACCOUNT_NOT_FOUND', 'Счёт не найден.'); return a; }
  allTransactions({ from, to, accountId } = {}) {
    let sql = "SELECT t.data FROM transactions t JOIN imports i ON i.id=t.import_id WHERE i.status='committed'"; const args = [];
    if (from) { sql += ' AND t.date>=?'; args.push(isoDate(from)); } if (to) { sql += ' AND t.date<=?'; args.push(isoDate(to)); }
    if (accountId) { sql += ' AND t.account_id=?'; args.push(accountId); }
    return this.db.prepare(`${sql} ORDER BY t.date DESC,t.rowid DESC`).all(...args).map(parse);
  }
  accounts() {
    return this.list('accounts').map(a => {
      const txs = this.allTransactions({ accountId: a.id }).filter(t => (t.postedDate || t.date) >= a.openingDate);
      const amount = sumMinor([a.openingBalanceMinor, ...txs.map(t => t.amountMinor)], 'Остаток счёта');
      assert(Number.isSafeInteger(amount), 'AMOUNT_OVERFLOW', 'Слишком большой остаток счёта.');
      return { ...a, balanceMinor: a.openingKnown ? amount : null };
    });
  }
  saveAccount(args, actor) {
    const prev = args.id ? this.requireAccount(args.id) : undefined;
    const openingKnown = args.openingKnown === undefined ? Boolean(prev?.openingKnown) : Boolean(args.openingKnown);
    const value = { id: prev?.id || randomUUID(), name: text(args.name, 'Название счёта', 100), currency: 'RUB',
      openingBalanceMinor: integer(args.openingBalanceMinor ?? prev?.openingBalanceMinor ?? 0, 'Начальный остаток', { min: -100_000_000_000_000 }),
      openingDate: isoDate(args.openingDate || prev?.openingDate || '1900-01-01'), openingKnown };
    return this.atomic(() => { this.put('accounts', value); this.changed(); this.audit(actor, 'account.save', value.id, value); return value; });
  }
  saveCategory(args, actor) {
    const prev = args.id ? this.get('categories', text(args.id, 'Категория', 80)) : undefined;
    if (args.id) assert(prev, 'NOT_FOUND', 'Категория не найдена.');
    const name = text(args.name, 'Название категории', 100);
    assert(!this.list('categories').some(c => c.name === name && c.id !== prev?.id), 'CATEGORY_EXISTS', 'Такая категория уже есть.');
    assert(!prev || prev.name === name, 'RENAME_UNSUPPORTED', 'В MVP название существующей категории неизменно; можно изменить её защиту или создать новую.');
    const value = { id: prev?.id || randomUUID(), name, protected: Boolean(args.protected) };
    return this.atomic(() => { this.put('categories', value); this.changed(); this.audit(actor, 'category.save', value.id, value); return value; });
  }
  imports(limit = 100) { return this.db.prepare('SELECT data,status FROM imports ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit).map(r => ({ ...parse(r), status: r.status })); }
  importByHash(accountId, hash) { return parse(this.db.prepare("SELECT data FROM imports WHERE account_id=? AND file_hash=? AND status='committed'").get(accountId, hash)); }
  fingerprintCounts(accountId) {
    return new Map(this.db.prepare("SELECT t.fingerprint,count(*) AS n FROM transactions t JOIN imports i ON i.id=t.import_id WHERE i.status='committed' AND t.account_id=? GROUP BY t.fingerprint").all(accountId).map(r => [r.fingerprint, r.n]));
  }
  bankOperations(accountId) {
    return new Map(this.db.prepare("SELECT t.bank_id,t.data FROM transactions t JOIN imports i ON i.id=t.import_id WHERE i.status='committed' AND t.account_id=? AND t.bank_id IS NOT NULL AND t.bank_id<>''").all(accountId).map(r => [r.bank_id, parse(r)]));
  }
  ruleMatches(rule, transaction) {
    const fold = v => String(v || '').normalize('NFKC').toLocaleLowerCase('ru-RU').replace(/\s+/g, ' ').trim();
    if (rule.kind && rule.kind !== transaction.kind && transaction.id && this.list('incomeMatches').some(m => m.transactionIds.includes(transaction.id))) return false;
    return rule.enabled !== false && (!['income','refund'].includes(rule.kind) || transaction.amountMinor > 0) && (rule.kind !== 'expense' || transaction.amountMinor < 0) && (!rule.counterparty || fold(rule.counterparty) === fold(transaction.counterparty)) &&
      (!rule.descriptionContains || fold(transaction.description).includes(fold(rule.descriptionContains))) &&
      (rule.minMinor === undefined || Math.abs(transaction.amountMinor) >= rule.minMinor) && (rule.maxMinor === undefined || Math.abs(transaction.amountMinor) <= rule.maxMinor);
  }
  applyRules(transaction) {
    if (transaction.manual) return transaction;
    const matches = this.list('rules').filter(r => this.ruleMatches(r, transaction));
    if (matches.length !== 1) return { ...transaction, needsReview: true, ...(matches.length > 1 ? { ruleConflict: true } : {}) };
    const r = matches[0]; return { ...transaction, category: r.category, kind: r.kind || transaction.kind, needsReview: false, classificationSource: r.id };
  }
  commitPreview(preview, included, actor) {
    return this.atomic(() => {
      const duplicateFile = this.importByHash(preview.accountId, preview.fileHash);
      if (duplicateFile) return { importId: duplicateFile.id, insertedCount: 0, skippedCount: preview.transactions.length, alreadyImported: true, rawDeleted: true };
      const counts = this.fingerprintCounts(preview.accountId), bank = this.bankOperations(preview.accountId), seen = new Map(), seenBank = new Map();
      const inserted = []; let skippedCount = 0;
      for (const source of preview.transactions) {
        const occurrence = (seen.get(source.fingerprint) || 0) + 1; seen.set(source.fingerprint, occurrence);
        let skip = false;
        if (source.bankId) {
          const existing = bank.get(source.bankId) || seenBank.get(source.bankId);
          if (existing) {
            assert(existing.amountMinor === source.amountMinor && existing.date === source.date && existing.currency === source.currency, 'BANK_ID_CONFLICT', 'Один банковский идентификатор содержит разные суммы или даты. Импорт остановлен.'); skip = true;
          }
          seenBank.set(source.bankId, source);
        } else if (occurrence <= (counts.get(source.fingerprint) || 0) && !included.has(source.sourceRow)) skip = true;
        if (skip) { skippedCount++; continue; }
        inserted.push(source);
      }
      const id = randomUUID(); const value = { id, accountId: preview.accountId, fileName: preview.fileName, createdAt: this.now(),
        fromDate: preview.period.from, toDate: preview.period.to, count: inserted.length, skippedCount, status: 'committed',
        verification: preview.verification, netMinor: sumMinor(inserted.map(t => t.amountMinor), 'Оборот импорта'), format: preview.format,
        fileHash: preview.fileHash, parserVersion: 1, statementTotals: preview.totals, ...(preview.openingMinor !== undefined ? { openingMinor: preview.openingMinor, closingMinor: preview.closingMinor } : {}) };
      this.db.prepare('INSERT INTO imports(id,account_id,file_hash,status,created_at,data) VALUES(?,?,?,?,?,?)').run(id, preview.accountId, preview.fileHash, 'committed', value.createdAt, JSON.stringify(value));
      const stmt = this.db.prepare('INSERT INTO transactions(id,account_id,import_id,date,amount_minor,bank_id,fingerprint,data) VALUES(?,?,?,?,?,?,?,?)');
      for (const s of inserted) {
        const { duplicate, fingerprint, ...fields } = s;
        const t = this.applyRules({ ...fields, id: randomUUID(), sourceImportId: id, accountId: preview.accountId, note: '', manual: false });
        stmt.run(t.id, t.accountId, id, t.date, t.amountMinor, t.bankId || null, fingerprint, JSON.stringify(t));
      }
      this.changed(); this.audit(actor, 'import.commit', id, { count: value.count, skippedCount, fileHash: preview.fileHash, verification: value.verification });
      return { importId: id, insertedCount: value.count, skippedCount, alreadyImported: false, rawDeleted: true };
    });
  }
  transaction(id) {
    const row = this.db.prepare("SELECT t.data FROM transactions t JOIN imports i ON i.id=t.import_id WHERE t.id=? AND i.status='committed'").get(text(id, 'Операция', 80));
    assert(row, 'NOT_FOUND', 'Операция не найдена или её импорт отменён.'); return parse(row);
  }
  writeTransaction(t) { this.db.prepare('UPDATE transactions SET data=? WHERE id=?').run(JSON.stringify(t), t.id); }
  updateTransaction(args, actor) {
    return this.atomic(() => {
      const before = this.transaction(args.id); const next = { ...before, manual: true, classificationSource: 'manual' };
      if (args.category !== undefined) next.category = this.category(args.category);
      if (args.kind !== undefined) {
        assert(KINDS.includes(args.kind), 'INVALID_KIND', 'Неизвестный тип операции.');
        assert(args.kind === before.kind || !this.list('incomeMatches').some(m => m.transactionIds.includes(before.id)), 'MATCHED_TRANSACTION', 'Выплата участвует в сверке дохода. Сначала отмените сверку, затем измените тип операции.');
        next.kind = args.kind;
      }
      if (next.kind === 'income' || next.kind === 'refund') assert(next.amountMinor > 0, 'INVALID_KIND', 'Доход и возврат должны быть положительными поступлениями.');
      if (next.kind === 'expense') assert(next.amountMinor < 0, 'INVALID_KIND', 'Расход должен быть отрицательным списанием.');
      if (args.needsReview !== undefined) { assert(typeof args.needsReview === 'boolean', 'INVALID_INPUT', 'Статус проверки должен быть логическим.'); next.needsReview = args.needsReview; }
      if (args.note !== undefined) { assert(typeof args.note === 'string' && args.note.length <= 2000, 'INVALID_INPUT', 'Комментарий до 2000 символов.'); next.note = args.note; }
      this.writeTransaction(next); this.changed(); this.audit(actor, 'transaction.update', next.id, { before: { category: before.category, kind: before.kind, needsReview: before.needsReview, note: before.note }, after: { category: next.category, kind: next.kind, needsReview: next.needsReview, note: next.note } }); return next;
    });
  }
  reverseImport(args, actor) {
    return this.atomic(() => {
      const id = text(args.id, 'Импорт', 80); const row = this.db.prepare('SELECT data,status FROM imports WHERE id=?').get(id);
      assert(row, 'NOT_FOUND', 'Импорт не найден.');
      if (row.status === 'reverted') return { reverted: true };
      const txIds = new Set(this.db.prepare('SELECT id FROM transactions WHERE import_id=?').all(id).map(t => t.id));
      assert(!this.list('incomeMatches').some(m => m.transactionIds.some(t => txIds.has(t))), 'MATCHED_IMPORT', 'В импорте есть выплаты, участвующие в сверке дохода. Сначала исправьте сверку.');
      this.db.prepare("UPDATE imports SET status='reverted' WHERE id=?").run(id); this.changed(); this.audit(actor, 'import.reverse', id, {}); return { reverted: true };
    });
  }
  saveRule(args, actor) {
    const prev = args.id ? this.get('rules', text(args.id, 'Правило', 80)) : undefined;
    if (args.id) assert(prev, 'NOT_FOUND', 'Правило не найдено.');
    const rule = { id: prev?.id || randomUUID(), label: text(args.label, 'Название правила', 100), category: this.category(args.category),
      counterparty: text(args.counterparty, 'Получатель', 300, true), descriptionContains: text(args.descriptionContains, 'Текст назначения', 300, true), enabled: args.enabled !== false };
    assert(rule.counterparty || rule.descriptionContains, 'RULE_TOO_BROAD', 'Укажите точного получателя или фрагмент описания. Одной суммы недостаточно.');
    if (args.minMinor !== undefined) rule.minMinor = integer(args.minMinor, 'Минимальная сумма'); if (args.maxMinor !== undefined) rule.maxMinor = integer(args.maxMinor, 'Максимальная сумма');
    assert(rule.minMinor === undefined || rule.maxMinor === undefined || rule.minMinor <= rule.maxMinor, 'INVALID_INPUT', 'Минимальная сумма больше максимальной.');
    if (args.kind) { assert(KINDS.includes(args.kind), 'INVALID_KIND', 'Неизвестный тип.'); rule.kind = args.kind; }
    return this.atomic(() => {
      this.put('rules', rule); let matchedCount = 0, updatedCount = 0;
      for (const t of this.allTransactions()) {
        const matchesCurrent = this.ruleMatches(rule, t), previouslyAssigned = t.classificationSource === rule.id;
        if (matchesCurrent) matchedCount++;
        if (args.applyExisting && !t.manual && (matchesCurrent || previouslyAssigned)) {
          const base = previouslyAssigned ? { ...t, category: 'Без категории', kind: t.amountMinor < 0 ? 'expense' : 'income', needsReview: true, classificationSource: undefined } : t;
          const next = this.applyRules(base); this.writeTransaction(next); updatedCount++;
        }
      }
      this.changed(); this.audit(actor, 'rule.save', rule.id, { rule, applyExisting: Boolean(args.applyExisting), updatedCount }); return { rule, matchedCount, updatedCount };
    });
  }
  saveSimple(collection, args, actor) {
    const existing = args.id ? this.get(collection, text(args.id, 'Запись', 80)) : undefined;
    if (args.id) assert(existing, 'NOT_FOUND', 'Запись не найдена.');
    let value = { id: existing?.id || randomUUID() };
    if (collection === 'goals') {
      value = { ...value, name: text(args.name, 'Название цели', 100), targetMinor: integer(args.targetMinor, 'Стоимость цели', { min: 1 }), savedMinor: integer(args.savedMinor ?? 0, 'Уже накоплено'), monthlyMinor: integer(args.monthlyMinor ?? 0, 'Ежемесячный взнос'), priority: integer(args.priority ?? 1, 'Приоритет', { min: 1, max: 100 }) };
      assert(value.savedMinor <= value.targetMinor, 'INVALID_INPUT', 'Накопленная сумма не должна превышать стоимость цели.'); if (args.deadline) value.deadline = isoDate(args.deadline);
    } else if (collection === 'budgets') {
      value = { ...value, category: this.category(args.category), limitMinor: integer(args.limitMinor, 'Лимит'), protected: Boolean(args.protected) };
      const same = this.list('budgets').find(b => b.category === value.category); if (same && !args.id) value.id = same.id;
    } else if (collection === 'obligations') {
      value = { ...value, name: text(args.name, 'Название платежа', 100), amountMinor: integer(args.amountMinor, 'Сумма'), dayOfMonth: integer(args.dayOfMonth, 'День платежа', { min: 1, max: 31 }), category: this.category(args.category), enabled: args.enabled !== false };
    } else throw new FinanceError('INVALID_ACTION', 'Неизвестный тип записи.');
    return this.atomic(() => { this.put(collection, value); this.changed(); this.audit(actor, `${collection}.save`, value.id, value); return value; });
  }
  saveIncome(args, calculation, actor) {
    const prev = args.id ? this.get('incomeModels', text(args.id, 'Модель', 80)) : undefined;
    if (args.id) assert(prev, 'NOT_FOUND', 'Модель дохода не найдена.');
    const model = { id: randomUUID(), name: text(args.name, 'Название дохода', 100), effectiveFrom: monthValue(args.effectiveFrom), salaryMinor: args.salaryMinor,
      workedRatio: args.workedRatio ?? 1, deductionsMinor: args.deductionsMinor ?? 0, payoutDay: integer(args.payoutDay ?? 10, 'День выплаты', { min: 1, max: 31 }),
      ...(args.taxRateBps === undefined ? {} : { taxRateBps: integer(args.taxRateBps, 'Ставка налога', { min: 0, max: 10_000 }) }),
      components: args.components || [], version: (prev?.version || 0) + 1, parentId: prev?.id || null, createdAt: this.now() };
    return this.atomic(() => { this.put('incomeModels', model); this.changed(); this.audit(actor, 'income.save', model.id, { name: model.name, version: model.version, parentId: model.parentId }); return { model, calculation }; });
  }
  reconcile(args, expectedMinor, actor) {
    const period = monthValue(args.period), model = this.get('incomeModels', text(args.modelId, 'Модель', 80)); assert(model, 'NOT_FOUND', 'Модель не найдена.');
    assert(Array.isArray(args.transactionIds) && args.transactionIds.length > 0 && args.transactionIds.length <= 100 && new Set(args.transactionIds).size === args.transactionIds.length, 'INVALID_INPUT', 'Выберите от 1 до 100 уникальных выплат.');
    return this.atomic(() => {
      const same = this.list('incomeMatches').find(m => m.modelId === model.id && m.period === period);
      const existing = this.list('incomeMatches').filter(m => m.id !== same?.id);
      const actualMinor = sumMinor(args.transactionIds.map(id => {
        assert(!existing.some(m => m.transactionIds.includes(id)), 'ALREADY_MATCHED', 'Выплата уже связана с другим начислением.');
        const t = this.transaction(id); assert(t.amountMinor > 0 && t.kind === 'income', 'NOT_INCOME', 'Для сверки выбирайте положительные операции типа «Доход».'); return t.amountMinor;
      }), 'Сумма выплат');
      assert(Number.isSafeInteger(actualMinor), 'AMOUNT_OVERFLOW', 'Сумма выплат слишком велика.');
      const value = { id: same?.id || randomUUID(), modelId: model.id, period, expectedMinor, actualMinor, differenceMinor: actualMinor - expectedMinor, transactionIds: [...args.transactionIds], createdAt: this.now() };
      this.put('incomeMatches', value); this.changed(); this.audit(actor, 'income.reconcile', value.id, value); return value;
    });
  }
  unmatchIncome(args, actor) {
    return this.atomic(() => {
      const id = text(args.id, 'Сверка', 80), prior = this.get('incomeMatches', id);
      assert(prior, 'NOT_FOUND', 'Сверка не найдена.');
      this.db.prepare("DELETE FROM entities WHERE collection='incomeMatches' AND id=?").run(id);
      this.changed(); this.audit(actor, 'income.unmatch', id, prior); return { removed: true };
    });
  }
  saveSettings(args, actor) {
    return this.atomic(() => {
      const next = { ...this.settings() };
      if (args.reportHour !== undefined) next.reportHour = integer(args.reportHour, 'Час отчёта', { min: 0, max: 23 });
      if (args.reportsEnabled !== undefined) { assert(typeof args.reportsEnabled === 'boolean', 'INVALID_INPUT', 'Некорректный флаг отчётов.'); next.reportsEnabled = args.reportsEnabled; }
      if (args.agentAccess !== undefined) { assert(actor === 'ui', 'USER_ONLY', 'Доступ агента может включить только пользователь в интерфейсе.'); assert(typeof args.agentAccess === 'boolean', 'INVALID_INPUT', 'Некорректный флаг доступа.'); next.agentAccess = args.agentAccess; }
      this.put('settings', next); this.audit(actor, 'settings.save', 'main', { reportHour: next.reportHour, reportsEnabled: next.reportsEnabled, agentAccess: next.agentAccess }); return next;
    });
  }
  reports(limit = 100) { return this.db.prepare('SELECT data FROM reports ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit).map(parse); }
  putReport(key, value) {
    const prior = parse(this.db.prepare('SELECT data FROM reports WHERE report_key=?').get(key)); if (prior) return prior;
    this.db.prepare('INSERT INTO reports(id,report_key,created_at,data) VALUES(?,?,?,?)').run(value.id, key, value.createdAt, JSON.stringify(value));
    this.db.exec('DELETE FROM reports WHERE id IN (SELECT id FROM reports ORDER BY created_at DESC,rowid DESC LIMIT -1 OFFSET 400)'); return value;
  }
  backup(directory, retention = 7) {
    if (this.path === ':memory:') return;
    const root = resolve(directory); mkdirSync(root, { recursive: true, mode: 0o700 });
    const name = `finance-${todayMoscow(this.clock()).replaceAll('-', '')}.sqlite`;
    const target = resolve(root, name); assert(dirname(target) === root, 'UNSAFE_PATH', 'Недопустимый путь резервной копии.');
    if (!readdirSync(root).includes(name)) { this.db.prepare('VACUUM INTO ?').run(target); this.audit('scheduler', 'backup.created', name, {}); }
    const owned = readdirSync(root).filter(n => /^finance-\d{8}\.sqlite$/.test(n)).sort().reverse();
    for (const old of owned.slice(retention)) { const absolute = resolve(root, old); assert(dirname(absolute) === root && /^finance-\d{8}\.sqlite$/.test(old), 'UNSAFE_PATH', 'Очистка резервной копии остановлена.'); const info = lstatSync(absolute); if (info.isFile() && !info.isSymbolicLink()) unlinkSync(absolute); }
  }
  close() { if (!this.closed) { this.closed = true; this.db.close(); } }
}
