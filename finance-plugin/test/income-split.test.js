import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Pure arithmetic and source contracts only: no React/DOM, service or real finance data.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui.css', import.meta.url), 'utf8');
const start = source.indexOf('    function cents(');
const end = source.indexOf('    function incomeComponentValue(', start);
assert.ok(start > 0 && end > start);
const { splitIncome, incomeSplitPreview } = runInNewContext(source.slice(start, end) + '\n({ splitIncome, incomeSplitPreview });', {}, { timeout: 1000 });
const vocabulary = source.slice(source.indexOf('    const words = {'), source.indexOf('    const EMPTY = {'));
const dictionary = runInNewContext(vocabulary + '\ndictionaries.ru;', {}, { timeout: 1000 });
const sheet = source.slice(source.indexOf('        function IncomeCheatSheet('), source.indexOf('        function Income('));
const plain = value => JSON.parse(JSON.stringify(value));
const amounts = n => plain(splitIncome(n)).map(part => part.amountMinor);
const t = key => dictionary[key] || key;

test('the four shares match the source and split take-home income in displayed order', () => {
  assert.deepEqual(plain(splitIncome(10_000_000)), [
    { percent: 25, amountMinor: 2_500_000 },
    { percent: 15, amountMinor: 1_500_000 },
    { percent: 50, amountMinor: 5_000_000 },
    { percent: 10, amountMinor: 1_000_000 },
  ]);
  assert.deepEqual(amounts(0), [0, 0, 0, 0]);
  assert.equal(dictionary.splitGrowth, 'Инвестиции и рост');
  assert.equal(dictionary.splitStability, 'Финансовая подушка');
  assert.equal(dictionary.splitEssentials, 'Необходимые расходы');
  assert.equal(dictionary.splitRewards, 'Удовольствия');
  assert.match(dictionary.splitReserveHelp, /расходы в месяц × 5/);
});

test('largest remainders keep kopeck totals exact, with deterministic ties', () => {
  assert.deepEqual(amounts(1), [0, 0, 1, 0]);
  assert.deepEqual(amounts(2), [1, 0, 1, 0]);
  assert.deepEqual(amounts(10), [3, 1, 5, 1]);
  const samples = [...Array.from({ length: 1001 }, (_, n) => n), 123456789, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER];
  for (const n of samples) {
    const parts = splitIncome(n);
    assert.equal(parts.reduce((sum, part) => sum + part.amountMinor, 0), n);
    for (const part of parts) {
      assert.ok(Number.isSafeInteger(part.amountMinor) && part.amountMinor >= 0);
      const difference = BigInt(part.amountMinor) * 100n - BigInt(n) * BigInt(part.percent);
      assert.ok(difference > -100n && difference < 100n, 'Every share stays within one kopeck of its exact value');
    }
  }
});

test('invalid arithmetic input cannot be silently allocated', () => {
  for (const n of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '100', null, undefined]) assert.throws(() => splitIncome(n));
});

test('preview distinguishes empty, zero, localized money and invalid values without stale results', () => {
  for (const value of ['', '  ']) assert.deepEqual(plain(incomeSplitPreview(value, t)), { parts: null, error: '' });
  assert.deepEqual(plain(incomeSplitPreview('0', t)).parts.map(part => part.amountMinor), [0, 0, 0, 0]);
  for (const value of ['100 000,25', '100\u00a0000.25']) {
    const result = incomeSplitPreview(value, t);
    assert.equal(result.error, '');
    assert.equal(result.parts.reduce((sum, part) => sum + part.amountMinor, 0), 10_000_025);
  }
  for (const value of ['-100', '100-200', '1e5', 'NaN', '<script>', '100,001', '100,', '90071992547410']) {
    const result = incomeSplitPreview(value, t);
    assert.equal(result.parts, null);
    assert.equal(result.error, dictionary.moneyInvalid);
  }
});

test('the sheet precedes the income form and uses local view state only', () => {
  const income = source.slice(source.indexOf('        function Income('), source.indexOf('        function Outlook('));
  assert.ok(income.indexOf('h(IncomeCheatSheet, { t, money })') < income.indexOf("h(Card, { title: t('incomeTitle')"));
  assert.ok(sheet.includes("const [value, setValue] = useState('')"));
  assert.ok(sheet.includes('incomeSplitPreview(value, t)'));
  assert.doesNotMatch(sheet, /\b(?:api|fetch|run|execute)\s*\(|localStorage|sessionStorage|state\.|calculation\.|<iframe|dangerouslySetInnerHTML/);
  assert.match(dictionary.splitCaution, /не сохраняется и не отправляется на сервер/);
  assert.match(dictionary.splitInputHint, /после налогов и удержаний/);
  assert.match(dictionary.splitInputHint, /Переводы между своими счетами и займы — не доход/);
});

test('sources, localized guidance, accessible validation and responsive theme styles are present', () => {
  assert.ok(sheet.includes('https://www.youtube.com/watch?v=QThz1B8SHmc&t=746s'));
  assert.ok(sheet.includes('https://www.threads.com/@marktilbury/post/DJwW8fQhNdo'));
  assert.equal([...sheet.matchAll(/rel: 'noopener noreferrer'/g)].length, 2);
  assert.ok(sheet.includes("'aria-invalid': !!error, 'aria-describedby': hintId"));
  assert.ok(sheet.includes("hint: error || t('splitInputHint')"));
  assert.ok(sheet.includes("'aria-live': 'polite'"));
  assert.ok(sheet.includes("h('details', null, h('summary', null, t('splitReserve'))"));
  for (const key of ['splitTitle', 'splitIntro', 'splitIncome', 'splitGrowthHelp', 'splitStabilityHelp', 'splitEssentialsHelp', 'splitRewardsHelp', 'splitCaution', 'splitVideo', 'splitAuthor']) assert.ok(dictionary[key]);
  assert.match(css, /\.finance-split-grid\s*\{[^}]*repeat\(auto-fit, minmax\(min\(100%, 200px\), 1fr\)\)/);
  const styles = css.slice(css.indexOf('.finance-split-bar'), css.indexOf('.finance-component'));
  assert.doesNotMatch(styles, /#[\da-f]{3,8}\b|rgba?\s*\(|hsla?\s*\(/i);
  assert.ok(styles.includes('var(--finance-blue)'));
  assert.ok(styles.includes('a:focus-visible'));
});
