import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui.css', import.meta.url), 'utf8');
// Evaluate only the self-contained vocabulary data, not the Client/React/DOM.
const start = source.indexOf('    const words = {');
const end = source.indexOf('    const EMPTY = {');
assert.ok(start > 0 && end > start);
const dictionaries = runInNewContext(source.slice(start, end) + '\n dictionaries;', {}, { timeout: 1000 });

test('finance vocabulary stays Russian with an English surrounding shell, without changing global preferences', () => {
  assert.match(source, /register\('finance', 'en', dictionaries\.ru\)/); assert.match(source, /register\('finance', 'ru', dictionaries\.ru\)/);
  assert.ok(!source.includes('ctx.locale.setLocale(')); assert.ok(source.includes("const locale = 'ru-RU'"));
  assert.equal(dictionaries.ru.title, 'Финансы'); assert.equal(dictionaries.ru.heroTitle, 'Финансы под контролем');
  assert.equal(dictionaries.ru.month11, 'Ноябрь'); assert.equal(dictionaries.ru.chooseFile, 'Выбрать выписку');
  for (const [, key] of source.matchAll(/\bt\('([^']+)'\)/g)) assert.ok(dictionaries.ru[key], `Missing Russian UI key: ${key}`);
});

test('history counters and empty periods no longer imply a missing import', () => {
  assert.ok(source.includes("fact(t('totalTransactions'), o.totalCount ?? o.count ?? 0)"));
  assert.ok(source.includes("fact(t('periodTransactions'), o.count ?? 0)"));
  assert.ok(source.includes("o.totalCount > 0 ? t('emptyPeriodStatus') : t('afterImport')"));
  assert.ok(source.includes("t('emptyPeriod')")); assert.ok(source.includes("t('latestPeriod')"));
  assert.equal(dictionaries.ru.coverage, 'История операций');
  assert.match(dictionaries.ru.emptyPeriod, /повторно импортировать.*не нужно/);
});

test('initial load accepts the server period and a successful import focuses its transaction month', () => {
  assert.ok(source.includes("const [filters, setFilters] = useState({ month: '', offset: 0 })"));
  assert.ok(source.includes('setMonthDraft(data.meta.month)'));
  assert.ok(source.includes('onImported(preview.period)'));
  assert.ok(source.includes("chooseMonth(typeof period?.to === 'string' ? period.to.slice(0, 7) : '')"));
  assert.ok(source.includes('const next = { month, offset: 0 }; filtersRef.current = next;'));
  assert.ok(source.includes("state.meta.monthSelection === 'latest_available'"));
});

test('operation editor expands directly under its own row rather than below pagination', () => {
  const ops = source.slice(source.indexOf('        function Operations('), source.indexOf('        function Rules('));
  assert.ok(ops.includes("state.transactions.map(tx => h(React.Fragment, { key: tx.id }"));
  const inlineRow = ops.indexOf("editing?.id === tx.id && h('tr', { className: 'finance-editor-row' }, h('td', { colSpan: 6, className: 'finance-edit-cell' }, editor))");
  assert.ok(inlineRow > 0 && inlineRow < ops.indexOf("t('page')"));
  assert.ok(!ops.includes('editing && h(Card'));
  assert.ok(ops.includes("'aria-expanded': editing?.id === tx.id"));
  assert.ok(ops.includes("'aria-controls': editing?.id === tx.id ? `finance-operation-editor-${tx.id}`"));
  assert.ok(ops.includes('required: true, autoFocus: true'));
  assert.ok(ops.includes("onClick: () => editing?.id === tx.id ? setEditing(null) : open(tx)"));
  assert.equal([...ops.matchAll(/api\('transaction.update'/g)].length, 1);
  assert.match(css, /\.finance-table td\.finance-edit-cell\s*\{\s*max-width: none/);
});

test('only the obligations table has a bounded keyboard-accessible scroll region and sticky headers', () => {
  const goals = source.slice(source.indexOf('        function Goals('), source.indexOf('        function Reports('));
  assert.ok(goals.includes("state.obligations.length > 0 && h(Table, { scrollable: true, label: t('obligationTitle'), headers:"));
  assert.equal([...source.matchAll(/scrollable: true/g)].length, 1, 'Do not constrain unrelated tables or operation editors');
  assert.ok(source.includes("scrollable = false, label"));
  assert.ok(source.includes("...(scrollable ? { role: 'region', 'aria-label': label, tabIndex: 0 } : {})"));
  assert.match(css, /\.finance-table-wrap\.finance-table-scroll\s*\{[^}]*max-height: min\(420px, 50vh\);[^}]*overflow: auto;[^}]*overscroll-behavior-y: contain;[^}]*scrollbar-gutter: stable/);
  assert.match(css, /\.finance-table-scroll th\s*\{[^}]*position: sticky;[^}]*top: 0;[^}]*z-index: 1/);
  assert.match(css, /\.finance-table-scroll:focus-visible\s*\{[^}]*outline: 2px solid var\(--finance-blue\)/);
  assert.ok(goals.includes("await api('obligation.save'"));
  assert.ok(goals.includes('onClick: () => setObligation({ ...o, amount: rubleInput(o.amountMinor), day: String(o.dayOfMonth) })'));
});

test('income save validates component fields and shows local errors and success beside the buttons', () => {
  const field = source.slice(source.indexOf('        function IncomeValueField('), source.indexOf('        function Income('));
  const income = source.slice(source.indexOf('        function Income('), source.indexOf('        function Goals('));
  assert.ok(field.includes('incomeComponentError(component.value, component.type, t)'));
  assert.ok(field.includes("'aria-invalid': !!valueError, 'aria-describedby': hintId"));
  assert.ok(field.includes('input.setCustomValidity(valueError)'));
  assert.ok(income.includes('value: incomeComponentValue(c.value, c.type, t)'));
  assert.ok(income.includes("onInvalid: () => setModelFeedback({ kind: 'error', message: t('incomeInvalid'), scroll: false })"));
  assert.ok(income.includes('e.preventDefault(); submitModel(true)'));
  assert.ok(income.includes('if (!e.currentTarget.form.reportValidity()) return; submitModel(false)'));
  assert.ok(income.includes('setForm(current => ({ ...current, id: result.model.id }))'));
  assert.ok(income.includes("t('incomeSaved')")); assert.ok(income.includes("t('incomeCalculated')"));
  assert.ok(income.includes("message: error.message || t('failed'), scroll: true"));
  assert.ok(income.includes("feedbackRef.current?.scrollIntoView({ block: 'nearest' })"));
  const feedback = income.indexOf("modelFeedback && h('div', { ref: feedbackRef }");
  assert.ok(feedback > income.indexOf("pending ? t('loading') : t('saveVersion')"));
  assert.ok(income.includes('h(ErrorNotice, { message: modelFeedback.message, t })'));
  assert.match(css, /input\[aria-invalid=true\]\s*\{[^}]*var\(--finance-coral\)/);
  assert.match(css, /\.finance-field > \.finance-field-error\s*\{[^}]*var\(--finance-coral\)/);
});

test('UI metadata remains Russian in both host locale resources', async () => {
  for (const lang of ['en', 'ru']) {
    const locale = JSON.parse(await readFile(new URL(`../locale/${lang}.json`, import.meta.url), 'utf8'));
    assert.equal(locale.meta.title, 'Личные финансы'); assert.match(locale.meta.description, /[А-Яа-яЁё]/);
  }
});

test('all new visual colours derive from the inspected light/dark theme tokens', () => {
  const allowed = new Set(['bg-base','bg-layer-1','bg-layer-2','border-l1','border-l2','brand-primary','label-primary','label-secondary','state-error-primary','state-warn-primary','state-success-primary']);
  for (const [, token] of css.matchAll(/var\(--dsw-alias-([\w-]+)\)/g)) assert.ok(allowed.has(token), token);
  assert.doesNotMatch(css, /#[\da-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/i);
  assert.match(css, /prefers-reduced-motion/); assert.match(css, /finance-section\[hidden\]/);
  assert.match(css, /max-width: 740px/); assert.match(css, /finance-kpi\[data-tone=success\]/); assert.match(css, /finance-kpi\[data-tone=expense\]/);
  assert.ok(source.includes(css), 'Embedded stylesheet must match ui.css');
});

test('redesign retains same-origin actions, native file interaction, keyboard navigation and bounded cleanup', () => {
  assert.equal([...source.matchAll(/\bfetch\(/g)].length, 1); assert.ok(source.includes("fetch('/api/finance'"));
  assert.ok(source.includes("'X-DSH-Finance': '1'")); assert.ok(source.includes("type: 'file'"));
  assert.ok(source.includes("'aria-label': t('chooseFile')")); assert.ok(source.includes("e.key === 'ArrowRight'"));
  assert.ok(source.includes('controllers.current.forEach(c => c.abort())')); assert.ok(source.includes('URL.revokeObjectURL(url)'));
  assert.ok(!source.includes('dangerouslySetInnerHTML')); assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage)\s*(?:\.\s*(?:setItem|getItem|removeItem|clear)\s*\(|\[)/); assert.ok(!source.includes("require('@deepseek-ai/"));
});
