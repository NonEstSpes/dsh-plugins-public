// One-shot source-only layout refactor; does not access financial data.
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const path = new URL('../client.js', import.meta.url);
let source = await readFile(path, 'utf8');
function card(block, title) {
  const start = block.indexOf(`h(Card, { title: t('${title}') }`);
  assert.ok(start >= 0, `Missing card ${title}`);
  let depth = 0, quote = '';
  for (let i = start; i < block.length; i++) {
    const ch = block[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    if (ch === ')' && --depth === 0) return block.slice(start, i + 1);
  }
  throw new Error(`Unbalanced card ${title}`);
}
const goalsStart = source.indexOf('        function Goals(');
const goalsEnd = source.indexOf('        function Reports(', goalsStart);
const goals = source.slice(goalsStart, goalsEnd);
const headEnd = goals.indexOf("          return h(React.Fragment, null, h('div', { className: 'finance-grid' },");
assert.ok(headEnd > 0);
const cards = ['goalTitle', 'budgetTitle', 'obligationTitle', 'forecastTitle'].map(title => card(goals, title).replaceAll("h('td', null, money(", "h('td', { className: 'finance-numeric' }, money("));
const names = ['goalCard', 'budgetCard', 'obligationCard', 'forecastCard'];
const updatedGoals = goals.slice(0, headEnd) + cards.map((value, i) => `          const ${names[i]} = ${value};`).join('\n') + `
          return h('div', { className: 'finance-grid finance-goals-layout' },
            h('div', { className: 'finance-stack finance-goals-primary' }, goalCard, forecastCard),
            h('div', { className: 'finance-stack finance-goals-secondary' }, budgetCard, obligationCard));
        }
`;
assert.equal([...goals.matchAll(/api\('/g)].length, 4);
assert.equal([...updatedGoals.matchAll(/api\('/g)].length, 4);
source = source.slice(0, goalsStart) + updatedGoals + source.slice(goalsEnd);
const overviewStart = source.indexOf('        function Overview(');
const overviewEnd = source.indexOf('        function ImportView(', overviewStart);
const overview = source.slice(overviewStart, overviewEnd);
const start = overview.indexOf("h('div', { className: 'finance-analytics' },");
const end = overview.indexOf('o.balanceWarning', start);
assert.ok(start >= 0 && end > start);
const [spending, goalsPreview, accounts, coverage] = ['spending', 'goalPreview', 'accounts', 'coverage'].map(title => card(overview, title));
const updatedOverview = overview.slice(0, start) + `h('div', { className: 'finance-analytics' },
              h('div', { className: 'finance-stack' }, ${spending}, ${accounts}),
              h('div', { className: 'finance-stack' }, ${goalsPreview}, ${coverage})),
` + overview.slice(end);
source = source.slice(0, overviewStart) + updatedOverview + source.slice(overviewEnd);
assert.ok(source.includes("'data-finance-ui': '0.1.8'"));
source = source.replace("'data-finance-ui': '0.1.8'", "'data-finance-ui': '0.1.9'");
await writeFile(path, source, 'utf8');
console.log('Reflowed Goals and Overview into independent stacks; preserved all four Goals API handlers.');
