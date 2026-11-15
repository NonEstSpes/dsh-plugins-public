import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

// Pure view-state logic and source contracts; no React/DOM execution or live records.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui.css', import.meta.url), 'utf8');
const start = source.indexOf('    function nextTransactionSort(');
const end = source.indexOf('    function Table(', start);
assert.ok(start > 0 && end > start);
const nextSort = runInNewContext(source.slice(start, end) + '\nnextTransactionSort;', {}, { timeout: 1000 });
const plain = value => JSON.parse(JSON.stringify(value));
const operations = source.slice(source.indexOf('        function Operations('), source.indexOf('        function Rules('));

test('first explicit header click is descending, successive clicks alternate, another field restarts descending', () => {
  const first = nextSort({}, 'date');
  assert.equal(first.sortDirection, 'desc');
  const second = nextSort(first, 'date');
  assert.equal(second.sortDirection, 'asc');
  assert.equal(nextSort(second, 'date').sortDirection, 'desc');
  const other = nextSort(first, 'amountMinor');
  assert.equal(other.sortBy, 'amountMinor');
  assert.equal(other.sortDirection, 'desc');
});

test('a sort resets pagination but preserves applied month, search and review filters without mutating them', () => {
  const original = Object.freeze({ month: '2026-11', query: 'Тест', needsReview: true, offset: 100 });
  assert.deepEqual(plain(nextSort(original, 'description')), { month: '2026-11', query: 'Тест', needsReview: true, offset: 0, sortBy: 'description', sortDirection: 'desc' });
  assert.equal(original.offset, 100);
  assert.equal(original.sortBy, undefined);
});

test('five data headers are sortable while the action header remains a normal header', () => {
  assert.ok(operations.includes("fields: ['date', 'description', 'amountMinor', 'category', 'kind', null]"));
  assert.ok(operations.includes("by: state.meta.sortBy || 'date'"));
  assert.ok(operations.includes("direction: state.meta.sortDirection || 'desc'"));
  assert.ok(operations.includes('onChange: sortOperations'));
  assert.ok(operations.includes('await load(next); setFilters(next);'));
  assert.doesNotMatch(operations, /state\.transactions\.(?:sort|toSorted)\(/);
  assert.ok(source.includes("...(next.sortBy ? { sortBy: next.sortBy, sortDirection: next.sortDirection || 'desc' } : {})"));
});

test('native keyboard-operable sort buttons expose direction on their header and hide decorative arrows', () => {
  const table = source.slice(end, source.indexOf('    function txt(', end));
  assert.ok(table.includes("'aria-sort': active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'"));
  assert.ok(table.includes("h('button', { type: 'button', className: 'finance-sort-button', disabled: sort.disabled"));
  assert.ok(table.includes("'aria-label':"));
  assert.ok(table.includes('sort.nextDirection(field)'));
  assert.ok(table.includes("'aria-hidden': true"));
  assert.ok(table.includes("onClick: () => sort.onChange(field)"));
  assert.ok(table.includes("'↑' : '↓'"));
  assert.ok(css.includes('.finance-sort-button:hover:not(:disabled)'));
});

test('a server that ignores sort parameters is rejected before committing the displayed state', () => {
  const load = source.slice(source.indexOf('const load = useCallback'), source.indexOf('const run = useCallback'));
  assert.ok(load.includes("data.meta?.sortBy !== next.sortBy"));
  assert.ok(load.includes("data.meta?.sortDirection !== (next.sortDirection || 'desc')"));
  assert.ok(load.indexOf("translate('sortNotApplied')") < load.indexOf('setState('));
  assert.ok(operations.includes("sortError && h(Notice, { kind: 'error', alert: true }, sortError)"));
  assert.ok(operations.includes("t('uiBuild'), ' 0.1.14 · '"));
});

test('sorting leaves the inline classification editor and read-only bank fields contract intact', () => {
  assert.equal([...operations.matchAll(/api\('transaction.update'/g)].length, 1);
  assert.ok(operations.includes("editing?.id === tx.id && h('tr', { className: 'finance-editor-row' }"));
  const sortAction = operations.slice(operations.indexOf('const sortOperations ='), operations.indexOf('const page ='));
  assert.ok(!sortAction.includes('setEditing('), 'Do not discard unsaved classification edits on header clicks');
  assert.ok(!sortAction.includes("api('transaction.update'"));
});
