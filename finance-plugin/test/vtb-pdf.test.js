import test from 'node:test';
import assert from 'node:assert/strict';
import { buildImport, suggestMapping } from '../lib/finance-core.js';
import { isVtbAccountTable, collectPdfPathBoxes, parseVtbAccountStatement } from '../lib/vtb-pdf.js';

// Entirely invented in-memory statements. No PDF files, accounts, services or databases are opened.
const HEADERS = ['Дата операции', 'Дата обработки', 'Сумма операции в валюте операции', 'Приход', 'Расход', 'Описание операции', 'Контрагент'];
const CUTS = [20, 80, 150, 230, 310, 390, 500, 574];
const SUMMARY = { openingMinor: 0, closingMinor: 90_000, creditMinor: 100_000, debitMinor: 10_000, currency: 'RUB' };
const cell = (x, y, width, text) => ({ x, y, width, text });
const rectangle = (left, bottom, right, top) => ({ left, bottom, right, top });
const rule = y => rectangle(19.75, y, 80.25, y);
const compact = text => text.replace(/\s+/gu, ' ').trim();

function line(page, y, items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  return { page, y, items: sorted, text: sorted.map(item => item.text).join(' ') };
}

function headerLines(page = 1, dy = 0) {
  const at = (y, values) => line(page, y + dy, values.map(([x, width, text]) => cell(x, y + dy, width, text)));
  return [
    at(522.1, [[236.92, 146.16, 'Сумма операции в валюте счета/карты'], [509, 55, 'Наименование']]),
    at(516.7, [[25, 49.84, 'Дата и время'], [85.62, 58.76, 'Дата обработки'], [155.24, 69.52, 'Сумма операции в']]),
    at(512.1, [[407.69, 74.6, 'Описание операции'], [514, 45, 'получателя/']]),
    at(507.5, [[32, 35, 'операции'], [101, 27, 'банком'], [157, 65, 'валюте операции']]),
    at(502.9, [[280, 28, 'Приход'], [361, 27, 'Расход'], [512, 49, 'Отправителя']]),
  ];
}

function headerBoxes(dy = 0) {
  return [
    rectangle(CUTS[0], 495 + dy, CUTS[1], 535 + dy),
    rectangle(CUTS[1], 495 + dy, CUTS[2], 535 + dy),
    rectangle(CUTS[2], 495 + dy, CUTS[3], 535 + dy),
    rectangle(CUTS[3], 515 + dy, CUTS[5], 535 + dy),
    rectangle(CUTS[3], 495 + dy, CUTS[4], 515 + dy),
    rectangle(CUTS[4], 495 + dy, CUTS[5], 515 + dy),
    rectangle(CUTS[5], 495 + dy, CUTS[6], 535 + dy),
    rectangle(CUTS[6], 495 + dy, CUTS[7], 535 + dy),
  ];
}

function summaryLines(page = 1) {
  return [
    line(page, 609, [cell(27, 609, 196, 'Баланс на начало периода'), cell(242, 609, 45, '0.00 RUB'), cell(304, 609, 90, 'Поступления'), cell(510, 609, 55, '1000.00 RUB')]),
    line(page, 587, [cell(27, 587, 196, 'Баланс на конец периода'), cell(246, 587, 45, '900.00 RUB'), cell(304, 587, 150, 'Расходные операции'), cell(510, 587, 55, '100.00 RUB')]),
  ];
}

function bodyLines(page = 1, dy = 0) {
  const at = (y, values) => line(page, y + dy, values.map(([x, width, text]) => cell(x, y + dy, width, text)));
  return [
    // This description starts ABOVE the date baseline but belongs to the same ruled cell.
    at(486, [[400, 85, 'Синтетический']]),
    at(460, [[32, 35, '09.11.2026'], [97, 35, '09.11.2026'], [155, 70, '1000.00 USD'], [266, 40, '1000.00 RUB'], [357, 30, '0.00 RUB'], [510, 60, 'Тестовый отправитель']]),
    at(445, [[400, 65, 'платёж FX']]),
    at(415, [[32, 35, '09.11.2026'], [97, 35, '09.11.2026'], [171, 55, '100.00 RUB'], [277, 30, '0.00 RUB'], [357, 31, '100.00 RUB'], [400, 80, 'Тестовая покупка'], [510, 55, 'Тестовый магазин']]),
  ];
}

function statementPage({ page = 1, dy = 0, summary = page === 1 } = {}) {
  return {
    page,
    lines: [...(summary ? summaryLines(page) : []), ...headerLines(page, dy), ...bodyLines(page, dy)].sort((a, b) => b.y - a.y),
    // Deliberately use zero-height stroked rules rather than full body-cell rectangles.
    boxes: [...headerBoxes(dy), ...[495, 430, 400].map(y => rule(y + dy))],
  };
}

function replaceText(page, oldText, newText) {
  return {
    ...page,
    lines: page.lines.map(row => line(row.page, row.y, row.items.map(item => item.text === oldText ? { ...item, text: newText } : item))),
  };
}

function withoutText(page, text) {
  return {
    ...page,
    lines: page.lines.map(row => line(row.page, row.y, row.items.filter(item => item.text !== text))).filter(row => row.items.length),
  };
}

function withSummaryValue(page, label, value) {
  return {
    ...page,
    lines: page.lines.map(row => {
      const index = row.items.findIndex(item => item.text === label);
      return line(row.page, row.y, row.items.map((item, k) => k === index + 1 && index >= 0 ? { ...item, text: value } : item));
    }),
  };
}

function withFeeSummary(page, value = '-5.00 RUB', y = 565) {
  return { ...page, lines: [...page.lines, line(page.page, y, [
    cell(27, y, 300, 'Общая сумма транзакционных комиссий'), cell(510, y, 55, value),
  ])].sort((a, b) => b.y - a.y) };
}

function withFeeRow(page) {
  return { ...page, lines: [...page.lines, line(page.page, 385, [
    cell(32, 385, 35, '09.11.2026'), cell(97, 385, 35, '09.11.2026'), cell(171, 385, 55, '5.00 RUB'),
    cell(277, 385, 30, '0.00 RUB'), cell(357, 385, 31, '5.00 RUB'), cell(400, 385, 80, 'Тестовая комиссия'),
  ])], boxes: [...page.boxes, rule(370)] };
}

function assertLayout(parsed, pages, rows) {
  assert.equal(parsed.pdfLayout.id, 'vtb-account-v1');
  assert.equal(parsed.pdfLayout.pageCount, pages);
  // Check table-page coverage without assuming the unspecified count/list representation.
  if (Array.isArray(parsed.pdfLayout.tablePages)) assert.deepEqual(parsed.pdfLayout.tablePages, Array.from({ length: pages }, (_, index) => index + 1));
  else assert.equal(parsed.pdfLayout.tablePages, pages);
  assert.equal(parsed.pdfLayout.sourceRowCount, rows);
  assert.equal(parsed.pdfLayout.checkedCoverage, true);
}

const hasCode = code => error => error?.code === code;

test('VTB account layout recognizes its complete multi-level native header, not generic tables', () => {
  assert.equal(isVtbAccountTable(headerLines()), true);
  assert.equal(isVtbAccountTable(statementPage().lines), true);
  const unrelated = [line(1, 700, [cell(20, 700, 40, 'Date'), cell(150, 700, 70, 'Description'), cell(310, 700, 30, 'Debit'), cell(400, 700, 30, 'Credit')])];
  assert.equal(isVtbAccountTable(unrelated), false);
  assert.equal(isVtbAccountTable([]), false);
  assert.equal(parseVtbAccountStatement([{ page: 1, lines: unrelated, boxes: [] }]), null);
  assert.equal(parseVtbAccountStatement([]), null);
});

test('VTB ruled rows retain descriptions above the date baseline and keep original FX separate', () => {
  const parsed = parseVtbAccountStatement([statementPage()]);
  assert.ok(parsed);
  assert.deepEqual(parsed.headers, HEADERS);
  assert.equal(parsed.delimiter, ';');
  assert.equal(parsed.encoding, 'pdf-vtb-account-v1');
  assert.ok(parsed.warnings.some(w => w.includes('валюте счёта')));
  assert.equal(parsed.rows.length, 2);
  assert.ok(parsed.rows.every(row => row.length === HEADERS.length && row.every(value => typeof value === 'string')));
  assert.deepEqual(parsed.rows[0].slice(0, 5), ['09.11.2026', '09.11.2026', '1000.00 USD', '1000.00 RUB', '0.00 RUB']);
  assert.equal(compact(parsed.rows[0][5]), 'Синтетический платёж FX');
  assert.equal(parsed.rows[0][6], 'Тестовый отправитель');
  assert.deepEqual(parsed.rows[1].slice(2, 5), ['100.00 RUB', '0.00 RUB', '100.00 RUB']);
  assert.equal(compact(parsed.rows[1][5]), 'Тестовая покупка');
  assert.equal(parsed.rows[1][6], 'Тестовый магазин');
  assert.deepEqual(parsed.statementSummary, SUMMARY);
  assertLayout(parsed, 1, 2);
});

test('VTB suggested mapping imports account RUB credit/debit without interpreting the USD amount', () => {
  const parsed = parseVtbAccountStatement([statementPage()]);
  const { mapping } = suggestMapping(parsed.headers);
  assert.equal(mapping.date, 0);
  assert.equal(mapping.postedDate, 1);
  assert.equal(mapping.credit, 3);
  assert.equal(mapping.debit, 4);
  assert.equal(mapping.description, 5);
  assert.equal(mapping.counterparty, 6);
  assert.equal(mapping.amountMode, 'debitCredit');
  assert.notEqual(mapping.amount, 2);
  const imported = buildImport(parsed, mapping);
  assert.deepEqual(imported.errors, []);
  assert.equal(imported.transactions.length, 2);
  assert.deepEqual(imported.transactions.map(row => row.amountMinor), [100_000, -10_000]);
  assert.ok(imported.transactions.every(row => row.currency === 'RUB' && row.date === '2026-11-09' && row.postedDate === '2026-11-09'));
  assert.equal(compact(imported.transactions[0].description), 'Синтетический платёж FX');
  assert.deepEqual(imported.totals, { creditMinor: 100_000, debitMinor: 10_000, netMinor: 90_000 });
});

test('VTB repeated headers on a vertically shifted second page do not become data or require repeated summary', () => {
  const first = statementPage();
  const second = statementPage({ page: 2, dy: 287, summary: false });
  assert.equal(isVtbAccountTable(second.lines), true);
  const parsed = parseVtbAccountStatement([first, second]);
  assert.equal(parsed.rows.length, 4);
  assert.deepEqual(parsed.rows.slice(2), parsed.rows.slice(0, 2));
  assert.deepEqual(parsed.statementSummary, SUMMARY);
  assert.ok(parsed.warnings.some(w => w.includes('валюте счёта')));
  assertLayout(parsed, 2, 4);
});

test('VTB recognized layout fails closed when the row grid is absent or merges two dated rows', () => {
  const page = statementPage();
  assert.throws(() => parseVtbAccountStatement([{ ...page, boxes: [] }]), hasCode('PDF_LAYOUT_CHANGED'));
  const merged = { ...page, boxes: page.boxes.filter(box => !(box.bottom === 430 && box.top === 430)) };
  assert.throws(() => parseVtbAccountStatement([merged]), hasCode('PDF_LAYOUT_CHANGED'));
});

test('VTB coverage rejects an extra date in the date column outside the established row grid', () => {
  const page = statementPage();
  page.lines.push(line(1, 370, [cell(32, 370, 35, '09.11.2026')]));
  page.lines.sort((a, b) => b.y - a.y);
  assert.throws(() => parseVtbAccountStatement([page]), hasCode('PDF_LAYOUT_CHANGED'));
});

test('VTB summary is mandatory and each of its four bank controls must be present', () => {
  assert.throws(() => parseVtbAccountStatement([statementPage({ summary: false })]), hasCode('PDF_SUMMARY_INVALID'));
  for (const label of ['Баланс на начало периода', 'Баланс на конец периода', 'Поступления', 'Расходные операции']) {
    assert.throws(() => parseVtbAccountStatement([withoutText(statementPage(), label)]), hasCode('PDF_SUMMARY_INVALID'), label);
  }
});

test('VTB parser extracts inconsistent bank controls for later service verification instead of reconciling them', () => {
  const parsed = parseVtbAccountStatement([replaceText(statementPage(), '900.00 RUB', '900.01 RUB')]);
  assert.deepEqual(parsed.statementSummary, { ...SUMMARY, closingMinor: 90_001 });
  assert.equal(parsed.rows.length, 2);
});

test('VTB adds only the declared negative fee that exactly explains bank controls, without changing rows', () => {
  const page = withFeeRow(withSummaryValue(statementPage(), 'Баланс на конец периода', '895.00 RUB'));
  const raw = parseVtbAccountStatement([page]);
  const parsed = parseVtbAccountStatement([withFeeSummary(page)]);
  assert.deepEqual(parsed.statementSummary, {
    ...SUMMARY, closingMinor: 89_500, debitMinor: 10_500,
    reportedDebitMinor: 10_000, transactionFeesMinor: -500, feesAddedToDebit: true,
  });
  assert.deepEqual(parsed.rows, raw.rows);
  assert.equal(parsed.rows.length, 3);
  assertLayout(parsed, 1, 3);
  const imported = buildImport(parsed, suggestMapping(parsed.headers).mapping);
  assert.deepEqual(imported.errors, []);
  assert.deepEqual(imported.transactions.map(row => row.amountMinor), [100_000, -10_000, -500]);
  assert.deepEqual(imported.totals, { creditMinor: 100_000, debitMinor: 10_500, netMinor: 89_500 });
  assert.ok(parsed.warnings.some(w => /расход для сверки.*отдельно указанные транзакционные комиссии/u.test(w) && /суммы и количество строк не изменены/u.test(w)));
});

test('VTB fee already included in bank debit stays informational and is not added twice', () => {
  const page = withSummaryValue(withSummaryValue(statementPage(), 'Баланс на конец периода', '895.00 RUB'), 'Расходные операции', '105.00 RUB');
  const raw = parseVtbAccountStatement([page]);
  const parsed = parseVtbAccountStatement([withFeeSummary(page)]);
  assert.deepEqual(parsed.statementSummary, {
    ...SUMMARY, closingMinor: 89_500, debitMinor: 10_500,
    reportedDebitMinor: 10_500, transactionFeesMinor: -500, feesAddedToDebit: false,
  });
  assert.deepEqual(parsed.rows, raw.rows);
  assert.ok(!parsed.warnings.some(w => w.includes('расход для сверки')));
});

test('VTB explicit zero fee is accepted as informational metadata', () => {
  const parsed = parseVtbAccountStatement([withFeeSummary(statementPage(), '0.00 RUB')]);
  assert.deepEqual(parsed.statementSummary, {
    ...SUMMARY, reportedDebitMinor: 10_000, transactionFeesMinor: 0, feesAddedToDebit: false,
  });
  assert.ok(!parsed.warnings.some(w => w.includes('расход для сверки')));
});

test('VTB missing fee cannot be inferred from bank differences or body fee rows', () => {
  const page = withFeeRow(withSummaryValue(statementPage(), 'Баланс на конец периода', '895.00 RUB'));
  const parsed = parseVtbAccountStatement([page]);
  assert.deepEqual(parsed.statementSummary, { ...SUMMARY, closingMinor: 89_500 });
  assert.equal(parsed.rows.length, 3);
});

test('VTB mismatched declared fee leaves raw inconsistent controls untouched', () => {
  const page = withFeeRow(withSummaryValue(statementPage(), 'Баланс на конец периода', '895.00 RUB'));
  const parsed = parseVtbAccountStatement([withFeeSummary(page, '-4.00 RUB')]);
  assert.deepEqual(parsed.statementSummary, {
    ...SUMMARY, closingMinor: 89_500,
    reportedDebitMinor: 10_000, transactionFeesMinor: -400, feesAddedToDebit: false,
  });
  const summary = parsed.statementSummary;
  assert.notEqual(summary.openingMinor + summary.creditMinor - summary.debitMinor, summary.closingMinor);
  assert.ok(!parsed.warnings.some(w => w.includes('расход для сверки')));
});

test('VTB optional fee never replaces any of the four mandatory bank controls', () => {
  for (const label of ['Баланс на начало периода', 'Баланс на конец периода', 'Поступления', 'Расходные операции']) {
    assert.throws(() => parseVtbAccountStatement([withFeeSummary(withoutText(statementPage(), label))]), hasCode('PDF_SUMMARY_INVALID'), label);
  }
});

test('VTB fee uses the same RUB currency validation as required summary controls', () => {
  for (const value of ['-5.00 USD', '-5.00 EUR', '-5.00']) {
    assert.throws(() => parseVtbAccountStatement([withFeeSummary(statementPage(), value)]), hasCode('PDF_CURRENCY'), value);
  }
  for (const value of ['-5.00 RUR', '-5.00 руб.', '-5.00 ₽']) {
    assert.equal(parseVtbAccountStatement([withFeeSummary(statementPage(), value)]).statementSummary.transactionFeesMinor, -500, value);
  }
});

test('VTB rejects duplicate, missing or ambiguous fee amounts', () => {
  const page = withFeeSummary(statementPage());
  assert.throws(() => parseVtbAccountStatement([withFeeSummary(page, '-5.00 RUB', 550)]), hasCode('PDF_SUMMARY_INVALID'));
  assert.throws(() => parseVtbAccountStatement([withoutText(page, '-5.00 RUB')]), hasCode('PDF_SUMMARY_INVALID'));
  const ambiguous = { ...page, lines: page.lines.map(row => row.y === 565 ? line(1, 565, [...row.items, cell(450, 565, 40, '-1.00 RUB')]) : row) };
  assert.throws(() => parseVtbAccountStatement([ambiguous]), hasCode('PDF_SUMMARY_INVALID'));
  const extraPage = { page: 2, lines: [line(2, 800, [cell(27, 800, 300, 'Общая сумма транзакционных комиссий'), cell(510, 800, 55, '-5.00 RUB')])], boxes: [] };
  assert.throws(() => parseVtbAccountStatement([page, extraPage]), hasCode('PDF_SUMMARY_INVALID'));
});

test('VTB rejects positive nonzero and malformed declared fees', () => {
  for (const value of ['5.00 RUB', '+5.00 RUB', '-5.001 RUB', '-oops RUB']) {
    assert.throws(() => parseVtbAccountStatement([withFeeSummary(statementPage(), value)]), hasCode('PDF_SUMMARY_INVALID'), value);
  }
});

test('VTB rejects unsafe fee values and overflow of debit after adding an exact declared fee', () => {
  assert.throws(() => parseVtbAccountStatement([withFeeSummary(statementPage(), '-90071992547409.92 RUB')]), hasCode('PDF_SUMMARY_INVALID'));
  let page = withSummaryValue(statementPage(), 'Баланс на начало периода', '90071992547409.91 RUB');
  page = withSummaryValue(page, 'Поступления', '0.00 RUB');
  page = withSummaryValue(page, 'Расходные операции', '90071992547409.91 RUB');
  page = withSummaryValue(page, 'Баланс на конец периода', '-0.01 RUB');
  assert.throws(() => parseVtbAccountStatement([withFeeSummary(page, '-0.01 RUB')]), hasCode('PDF_SUMMARY_INVALID'));
});

test('VTB fee reconciliation uses exact BigInt controls across unsafe intermediate balances', () => {
  let page = withSummaryValue(statementPage(), 'Баланс на начало периода', '90071992547409.91 RUB');
  page = withSummaryValue(page, 'Поступления', '1.00 RUB');
  page = withSummaryValue(page, 'Расходные операции', '1.00 RUB');
  page = withSummaryValue(page, 'Баланс на конец периода', '90071992547409.90 RUB');
  const parsed = parseVtbAccountStatement([withFeeSummary(page, '-0.01 RUB')]);
  assert.deepEqual(parsed.statementSummary, {
    openingMinor: Number.MAX_SAFE_INTEGER, closingMinor: Number.MAX_SAFE_INTEGER - 1,
    creditMinor: 100, debitMinor: 101, currency: 'RUB',
    reportedDebitMinor: 100, transactionFeesMinor: -1, feesAddedToDebit: true,
  });
});

// Public PDF.js 5.4 operator numbers; DrawOPS is the encoded path format, NOT OPS.moveTo.
const OPS = { save: 10, restore: 11, transform: 12, stroke: 20, fill: 22, constructPath: 91 };
const encodedRectangle = (left, bottom, right, top) => [0, left, bottom, 1, right, bottom, 1, right, top, 1, left, top, 4];
const modernPath = (encoded, bounds, paint = OPS.stroke) => [paint, [new Float32Array(encoded)], new Float32Array(bounds)];
const sortedBoxes = boxes => [...boxes].sort((a, b) => a.left - b.left || a.bottom - b.bottom || a.right - b.right || a.top - b.top);

test('collectPdfPathBoxes handles modern constructPath, affine composition and nested save/restore', () => {
  const path = () => modernPath(encodedRectangle(1, 2, 4, 6), [1, 2, 4, 6]);
  const opList = {
    fnArray: [OPS.save, OPS.transform, OPS.save, OPS.transform, OPS.constructPath, OPS.restore, OPS.constructPath, OPS.restore, OPS.constructPath],
    argsArray: [[], [0, 2, -3, 0, 10, 20], [], [1, 0, 0, 1, 5, 7], path(), [], path(), [], path()],
  };
  assert.deepEqual(sortedBoxes(collectPdfPathBoxes(opList, OPS)), sortedBoxes([
    rectangle(-29, 32, -17, 38), // Rotation/scaling composed with the inner translation.
    rectangle(-8, 22, 4, 28), // Inner restore retains the outer transform.
    rectangle(1, 2, 4, 6), // Outer restore returns to page coordinates.
  ]));
});

test('collectPdfPathBoxes preserves zero-height rules and separates disconnected subpaths in one paint', () => {
  const encoded = [
    ...encodedRectangle(20, 495, 80, 535),
    0, 19.75, 430, 1, 80.25, 430, 4,
  ];
  const opList = { fnArray: [OPS.constructPath], argsArray: [modernPath(encoded, [19.75, 430, 80.25, 535])] };
  assert.deepEqual(sortedBoxes(collectPdfPathBoxes(opList, OPS)), sortedBoxes([
    rectangle(20, 495, 80, 535), rule(430),
  ]));
});
