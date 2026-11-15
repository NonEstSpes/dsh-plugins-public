import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Static layout contracts only: no Client execution, React/DOM mocks, or finance data.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const css = await readFile(new URL('../ui.css', import.meta.url), 'utf8');
const section = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing component boundaries: ${start}`);
  return source.slice(from, to);
};
const goals = section('        function Goals(', '        function Reports(');
const overview = section('        function Overview(', '        function ImportView(');
const importer = section('        function ImportView(', '        function Operations(');
const income = section('        function Income(', '        function Goals(');
const operations = section('        function Operations(', '        function Rules(');

function block(marker, text = css) {
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `Missing CSS block: ${marker}`);
  const open = text.indexOf('{', start + marker.length);
  assert.ok(open >= 0, `Missing opening brace: ${marker}`);
  let depth = 1, end = open + 1;
  while (depth && end < text.length) {
    if (text[end] === '{') depth++;
    else if (text[end] === '}') depth--;
    end++;
  }
  assert.equal(depth, 0, `Unbalanced CSS block: ${marker}`);
  return text.slice(open + 1, end - 1);
}

function positiveGap(declarations) {
  const match = declarations.match(/\bgap:\s*([\d.]+)px\s*;/);
  assert.ok(match && Number(match[1]) >= 8, 'Action/stack spacing must remain explicit and usable');
}

test('planning places forecast below goals independently of the obligation table height', () => {
  for (const [name, title] of [['goalCard', 'goalTitle'], ['budgetCard', 'budgetTitle'], ['obligationCard', 'obligationTitle'], ['forecastCard', 'forecastTitle']]) {
    assert.match(goals, new RegExp(`const ${name} = h\\(Card, \\{ title: t\\('${title}'\\)`));
  }
  assert.match(goals, /className:\s*'finance-grid finance-goals-layout'/);
  assert.match(goals, /className:\s*'finance-stack finance-goals-primary'\s*\},\s*goalCard,\s*forecastCard/);
  assert.match(goals, /className:\s*'finance-stack finance-goals-secondary'\s*\},\s*budgetCard,\s*obligationCard/);
  assert.doesNotMatch(goals, /style:\s*\{\s*height:\s*16\s*\}/, 'Do not restore a spacer after a shared tall grid row');
  for (const action of ['goal.save', 'budget.save', 'obligation.save', 'forecast']) {
    assert.equal(goals.split(`api('${action}'`).length - 1, 1, `${action} must retain one existing action path`);
  }
});

test('overview stacks accounts under spending and coverage under the goal preview', () => {
  const analytics = overview.slice(overview.indexOf("className: 'finance-analytics'"));
  assert.equal([...analytics.matchAll(/className:\s*'finance-stack'/g)].length, 2);
  const spending = analytics.indexOf("title: t('spending')"), accounts = analytics.indexOf("title: t('accounts')");
  const preview = analytics.indexOf("title: t('goalPreview')"), coverage = analytics.indexOf("title: t('coverage')");
  assert.ok(spending >= 0 && spending < accounts && accounts < preview && preview < coverage);
  assert.match(analytics, /className:\s*'finance-stack'\s*\},\s*h\(Card,\s*\{\s*title:\s*t\('spending'\)/);
  assert.match(analytics, /className:\s*'finance-stack'\s*\},\s*h\(Card,\s*\{\s*title:\s*t\('goalPreview'\)/);
});

test('independent columns use intrinsic heights rather than stretching short cards', () => {
  const stack = block('.finance-stack');
  assert.match(stack, /display:\s*flex\s*;/);
  assert.match(stack, /flex-direction:\s*column\s*;/);
  assert.match(stack, /min-width:\s*0\s*;/);
  positiveGap(stack);
  for (const selector of ['.finance-analytics', '.finance-goals-layout']) {
    const declarations = block(selector);
    assert.match(declarations, /align-items:\s*start\s*;/);
    assert.doesNotMatch(declarations, /(?:^|;)\s*(?:height|min-height):/, `${selector} must size to its own contents`);
  }
  const planning = block('.finance-goals-layout');
  assert.match(planning, /display:\s*grid\s*;/);
  assert.match(planning, /grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)\s*;/);
  assert.match(planning, /gap:\s*20px\s*;/);
  assert.doesNotMatch(css, /\.finance-analytics\s*>\s*\.finance-card\s*\{[^}]*\bheight:\s*100%/);
  assert.match(css, /\.finance-stack\s*>\s*\.finance-card\s*\{\s*margin-bottom:\s*0\s*;/);
});

test('responsive breakpoints follow the finance panel width rather than only the viewport', () => {
  const root = block('.finance-page');
  assert.match(root, /container-name:\s*finance\s*;/);
  assert.match(root, /container-type:\s*inline-size\s*;/);
  const planning = block('@container finance (max-width: 1100px)');
  assert.match(planning, /\.finance-goals-layout\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  const compact = block('@container finance (max-width: 740px)');
  assert.match(compact, /\.finance-grid,\s*\.finance-analytics\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.match(compact, /\.finance-toolbar-main,\s*\.finance-toolbar-actions\s*\{\s*width:\s*100%\s*;/);
  const fields = block('@container finance (max-width: 560px)');
  assert.match(fields, /\.finance-fields\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/);
  assert.ok(css.includes('@media (max-width: 740px)'), 'Retain the viewport fallback');
  const lastViewportFallback = [...css.matchAll(/@media\s*\(max-width:/g)].at(-1)?.index ?? -1;
  assert.ok(css.indexOf('@container finance (max-width: 1100px)') > lastViewportFallback,
    'Panel-width rules must not be overridden by a later viewport fallback');
  assert.ok(css.indexOf('@container finance (max-width: 740px)') < css.indexOf('@media (prefers-reduced-motion:'),
    'Keep reduced-motion handling after the responsive layout rules');
});

test('standalone import and reconciliation actions retain spacing without optional notices or selections', () => {
  const actions = block('.finance-actions');
  assert.match(actions, /display:\s*flex\s*;/);
  assert.match(actions, /flex-wrap:\s*wrap\s*;/);
  positiveGap(actions);
  assert.match(actions, /margin-block-start:\s*12px\s*;/);
  positiveGap(block('.finance-row'));
  assert.match(importer, /!preview\s*&&\s*file\s*&&\s*h\('div',\s*\{\s*className:\s*'finance-actions'\s*\},\s*h\(Button,[\s\S]*?t\('discard'\)\)\)/);
  assert.match(income, /h\('div',\s*\{\s*className:\s*'finance-actions'\s*\},\s*h\(Button,[\s\S]*?t\('reconcile'\)\)\)/);
});

test('table edit buttons and forecast money do not split into individual characters', () => {
  const general = block('.finance-button');
  assert.match(general, /overflow-wrap:\s*normal\s*;/);
  assert.match(general, /word-break:\s*normal\s*;/);
  assert.match(general, /flex-shrink:\s*0\s*;/);
  assert.match(general, /max-width:\s*100%\s*;/);
  const buttons = block('.finance-table .finance-button');
  assert.match(buttons, /max-width:\s*none\s*;/);
  assert.match(buttons, /white-space:\s*nowrap\s*;/);
  assert.match(buttons, /overflow-wrap:\s*normal\s*;/);
  assert.match(buttons, /word-break:\s*normal\s*;/);
  for (const field of ['monthlyIncomeMinor', 'monthlyExpenseMinor', 'monthlyFreeMinor']) {
    assert.ok(goals.includes(`h('td', { className: 'finance-numeric' }, money(s.${field}))`));
  }
  assert.match(block('.finance-table-wrap'), /overflow-x:\s*auto\s*;/);
});

test('layout changes preserve the bounded obligations region and synchronized embedded stylesheet', () => {
  assert.match(goals, /h\(Table,\s*\{\s*scrollable:\s*true,\s*label:\s*t\('obligationTitle'\)/);
  assert.equal([...goals.matchAll(/scrollable:\s*true/g)].length, 1);
  const scroll = block('.finance-table-wrap.finance-table-scroll');
  assert.match(scroll, /max-height:\s*min\(420px,\s*50vh\)\s*;/);
  assert.match(scroll, /overflow:\s*auto\s*;/);
  assert.match(block('.finance-table-scroll th'), /position:\s*sticky\s*;/);
  assert.ok(source.includes(css), 'Build the actual client stylesheet before running the suite');
});

test('layout wrappers preserve native import confirmation and inline operation editing guards', () => {
  assert.equal(importer.split("api('import.commit'").length - 1, 1);
  assert.ok(importer.includes("type: 'file'"));
  assert.match(importer, /h\('form',\s*\{\s*onSubmit:\s*e\s*=>\s*\{\s*e\.preventDefault\(\)/);
  assert.ok(importer.includes('disabled: pending || blocked || !confirm'));
  assert.ok(importer.includes("if (!confirm || blocked) throw new Error(t('confirmImport'))"));
  for (const guard of ['preview.mappingRequired', "preview.statementVerification !== 'matched'", 'mappingDirty', '(preview.errors || []).length > 0', "preview.verification === 'mismatch'", '|| expired']) {
    assert.ok(importer.includes(guard), `Missing existing import guard: ${guard}`);
  }
  assert.equal(operations.split("api('transaction.update'").length - 1, 1);
  const editor = operations.indexOf("className: 'finance-editor-row'");
  assert.ok(editor >= 0 && editor < operations.indexOf("t('page')"));
  assert.ok(operations.includes("h('td', { colSpan: 6, className: 'finance-edit-cell' }, editor)"));
  assert.ok(operations.includes("'aria-expanded': editing?.id === tx.id"));
  assert.ok(operations.includes('required: true, autoFocus: true'));
});
