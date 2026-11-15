import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceService } from '../lib/service.js';

// Original synthetic PDF bytes only: no fixture files, real statements or persistent databases.
// A Type0 font with a small identity ToUnicode CMap makes both Cyrillic and ASCII text extractable.
const utf16beHex = text => Buffer.from(text, 'utf16le').swap16().toString('hex');
const drawText = (x, y, text) => `BT /F1 8 Tf 1 0 0 1 ${x} ${y} Tm <${utf16beHex(text)}> Tj ET`;
const stream = (content, extra = '') => `<< /Length ${Buffer.byteLength(content, 'ascii')} ${extra}>>\nstream\n${content}\nendstream`;
const compact = text => text.replace(/\s+/gu, ' ').trim();
const SUMMARY = { openingMinor: 0, closingMinor: 90_000, creditMinor: 100_000, debitMinor: 10_000, currency: 'RUB' };

function syntheticVtbAccountPdf({ statedCredit = '1000.00 RUB', statedClosing = '900.00 RUB', statedDebit = '100.00 RUB', transactionFees, feeRow = false } = {}) {
  const rectangles = [
    [20, 495, 60, 40], [80, 495, 70, 40], [150, 495, 80, 40],
    [230, 515, 160, 20], [230, 495, 80, 20], [310, 495, 80, 20],
    [390, 495, 110, 40], [500, 495, 74, 40],
  ];
  const operations = [
    // Four pixels exceed the worker's intentional maxImageSize:1 limit. Ignoring a logo must not lose the later grid.
    'q 12 0 0 12 20 760 cm /Logo Do Q',
    '0.95 g', ...rectangles.map(rect => `${rect.join(' ')} re f`), '0 g',
    '0 G 0.5 w', ...[495, 430, 400, ...(feeRow ? [370] : [])].map(y => `19.75 ${y} m 80.25 ${y} l S`),
    drawText(27, 609, 'Баланс на начало периода'), drawText(242, 609, '0.00 RUB'),
    drawText(304, 609, 'Поступления'), drawText(510, 609, statedCredit),
    drawText(27, 587, 'Баланс на конец периода'), drawText(246, 587, statedClosing),
    drawText(304, 587, 'Расходные операции'), drawText(510, 587, statedDebit),
    ...(transactionFees !== undefined ? [drawText(27, 565, 'Общая сумма транзакционных комиссий'), drawText(510, 565, transactionFees)] : []),
    drawText(236.92, 522.1, 'Сумма операции в валюте счета/карты'), drawText(509, 522.1, 'Наименование'),
    drawText(25, 516.7, 'Дата и время'), drawText(85.62, 516.7, 'Дата обработки'), drawText(155.24, 516.7, 'Сумма операции в'),
    drawText(407.69, 512.1, 'Описание операции'), drawText(514, 512.1, 'получателя/'),
    drawText(32, 507.5, 'операции'), drawText(101, 507.5, 'банком'), drawText(157, 507.5, 'валюте операции'),
    drawText(280, 502.9, 'Приход'), drawText(361, 502.9, 'Расход'), drawText(512, 502.9, 'Отправителя'),
    // The first description begins above the operation date and continues below it, inside one ruled row.
    drawText(400, 486, 'Синтетический'),
    drawText(33, 460, '09.11.2026'), drawText(97, 460, '09.11.2026'), drawText(155, 460, '1000.00 USD'),
    drawText(240, 460, '1000.00 RUB'), drawText(320, 460, '0.00 RUB'), drawText(510, 460, 'Тестовый отправитель'),
    drawText(400, 445, 'платёж FX'),
    drawText(33, 415, '09.11.2026'), drawText(97, 415, '09.11.2026'), drawText(155, 415, '100.00 RUB'),
    drawText(240, 415, '0.00 RUB'), drawText(320, 415, '-100.00 RUB'),
    drawText(400, 415, 'Тестовая покупка'), drawText(510, 415, 'Тестовый магазин'),
    ...(feeRow ? [
      drawText(33, 385, '09.11.2026'), drawText(97, 385, '09.11.2026'), drawText(155, 385, '5.00 RUB'),
      drawText(240, 385, '0.00 RUB'), drawText(320, 385, '-5.00 RUB'), drawText(400, 385, 'Тестовая комиссия'),
    ] : []),
  ].join('\n');
  const cmap = [
    '/CIDInit /ProcSet findresource begin', '12 dict begin', 'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /SyntheticIdentityUnicode def', '/CMapType 2 def',
    '1 begincodespacerange', '<0000> <FFFF>', 'endcodespacerange',
    '2 beginbfrange', '<0020> <007E> <0020>', '<0400> <04FF> <0400>', 'endbfrange',
    'endcmap', 'CMapName currentdict /CMap defineresource pop', 'end', 'end',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> /XObject << /Logo 9 0 R >> >> /Contents 8 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /SyntheticVTB /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 7 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /SyntheticVTB /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 6 0 R /DW 400 /CIDToGIDMap /Identity >>',
    '<< /Type /FontDescriptor /FontName /SyntheticVTB /Flags 4 /FontBBox [0 -200 400 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /MissingWidth 400 >>',
    stream(cmap), stream(operations),
    stream('ff000000ff000000ffffffff>', '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode '),
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'ascii');
}

const createService = () => new FinanceService(':memory:', { backupRetention: 0, clock: () => new Date('2026-11-09T18:30:00+03:00') });
async function preview(service, bytes) {
  const account = await service.execute('account.save', { name: 'Синтетический счёт PDF' });
  // No manually supplied controls: the worker/parser must extract all four controls from PDF text.
  return service.execute('import.preview', { accountId: account.id, fileName: 'synthetic-vtb-account.pdf', base64: bytes.toString('base64') });
}

test('synthetic Unicode VTB PDF survives a logo, verifies its own controls and commits only explicitly', async () => {
  const service = createService();
  try {
    const parsed = await preview(service, syntheticVtbAccountPdf());
    assert.equal(parsed.format, 'PDF');
    assert.equal(parsed.mappingRequired, false);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rowCount, 2);
    assert.equal(parsed.transactionCount, 2);
    assert.equal(parsed.verification, 'balanced');
    assert.equal(parsed.statementVerification, 'matched');
    assert.deepEqual(parsed.statementSummary, SUMMARY);
    assert.deepEqual(parsed.totals, { creditMinor: 100_000, debitMinor: 10_000, netMinor: 90_000 });
    assert.equal(parsed.sampleRows[0][2], '1000.00 USD');
    assert.equal(compact(parsed.transactions[0].description), 'Синтетический платёж FX');
    assert.equal(parsed.transactions[0].counterparty, 'Тестовый отправитель');
    assert.deepEqual(parsed.transactions.map(row => row.amountMinor), [100_000, -10_000]);
    assert.ok(parsed.transactions.every(row => row.currency === 'RUB'));
    assert.ok(parsed.warnings.some(warning => /расход/iu.test(warning) && /отриц|знак|модул/iu.test(warning)), 'Signed debit normalization must be disclosed.');
    assert.equal(service.state({}).transactionTotal, 0);
    assert.equal(service.previews.size, 1);

    const committed = await service.execute('import.commit', { previewId: parsed.previewId });
    assert.equal(committed.insertedCount, 2);
    assert.equal(service.previews.size, 0);
    const state = service.state({});
    assert.equal(state.transactionTotal, 2);
    assert.ok(state.transactions.some(row => compact(row.description) === 'Синтетический платёж FX' && row.amountMinor === 100_000));
    assert.ok(state.transactions.some(row => row.description === 'Тестовая покупка' && row.amountMinor === -10_000));
  } finally { service.close(); }
});

test('synthetic VTB PDF with a wrong stated credit turnover cannot commit despite matching row balance', async () => {
  const service = createService();
  try {
    const parsed = await preview(service, syntheticVtbAccountPdf({ statedCredit: '1001.00 RUB' }));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.transactionCount, 2);
    assert.deepEqual(parsed.totals, { creditMinor: 100_000, debitMinor: 10_000, netMinor: 90_000 });
    assert.deepEqual(parsed.statementSummary, { ...SUMMARY, creditMinor: 100_100 });
    assert.equal(parsed.statementVerification, 'mismatch');
    assert.equal(service.state({}).transactionTotal, 0);
    await assert.rejects(service.execute('import.commit', { previewId: parsed.previewId }), error => /MISMATCH/u.test(error?.code || ''));
    assert.equal(service.state({}).transactionTotal, 0);
    assert.equal(service.previews.size, 1);
  } finally { service.close(); }
});

test('synthetic VTB PDF normalizes explicitly excluded fees and verifies all original rows', async () => {
  const service = createService();
  try {
    const parsed = await preview(service, syntheticVtbAccountPdf({ statedClosing: '895.00 RUB', transactionFees: '-5.00 RUB', feeRow: true }));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rowCount, 3);
    assert.equal(parsed.transactionCount, 3);
    assert.equal(parsed.verification, 'balanced');
    assert.equal(parsed.statementVerification, 'matched');
    assert.deepEqual(parsed.statementSummary, {
      ...SUMMARY, closingMinor: 89_500, debitMinor: 10_500,
      reportedDebitMinor: 10_000, transactionFeesMinor: -500, feesAddedToDebit: true,
    });
    assert.deepEqual(parsed.totals, { creditMinor: 100_000, debitMinor: 10_500, netMinor: 89_500 });
    assert.deepEqual(parsed.transactions.map(row => row.amountMinor), [100_000, -10_000, -500]);
    assert.equal(parsed.sampleRows[2][4], '5.00 RUB');
    assert.ok(parsed.warnings.some(w => w.includes('расход для сверки') && w.includes('суммы и количество строк не изменены')));
    assert.equal(service.state({}).transactionTotal, 0);
    const committed = await service.execute('import.commit', { previewId: parsed.previewId });
    assert.equal(committed.insertedCount, 3);
    assert.equal(service.state({}).transactionTotal, 3);
  } finally { service.close(); }
});

test('synthetic VTB PDF with already included fee keeps informational metadata and matched verification', async () => {
  const service = createService();
  try {
    const parsed = await preview(service, syntheticVtbAccountPdf({ statedClosing: '895.00 RUB', statedDebit: '105.00 RUB', transactionFees: '-5.00 RUB', feeRow: true }));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rowCount, 3);
    assert.equal(parsed.statementVerification, 'matched');
    assert.equal(parsed.verification, 'balanced');
    assert.deepEqual(parsed.statementSummary, {
      ...SUMMARY, closingMinor: 89_500, debitMinor: 10_500,
      reportedDebitMinor: 10_500, transactionFeesMinor: -500, feesAddedToDebit: false,
    });
    assert.ok(!parsed.warnings.some(w => w.includes('расход для сверки')));
    assert.equal(service.state({}).transactionTotal, 0);
  } finally { service.close(); }
});

test('synthetic VTB PDF with zero fee remains matched without debit normalization', async () => {
  const service = createService();
  try {
    const parsed = await preview(service, syntheticVtbAccountPdf({ transactionFees: '0.00 RUB' }));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rowCount, 2);
    assert.equal(parsed.statementVerification, 'matched');
    assert.deepEqual(parsed.statementSummary, {
      ...SUMMARY, reportedDebitMinor: 10_000, transactionFeesMinor: 0, feesAddedToDebit: false,
    });
    assert.equal(service.state({}).transactionTotal, 0);
  } finally { service.close(); }
});

for (const transactionFees of [undefined, '-4.00 RUB']) {
  test(`synthetic VTB PDF with ${transactionFees === undefined ? 'missing' : 'mismatched'} fee preserves raw debit and cannot commit`, async () => {
    const service = createService();
    try {
      const parsed = await preview(service, syntheticVtbAccountPdf({ statedClosing: '895.00 RUB', transactionFees, feeRow: true }));
      assert.deepEqual(parsed.errors, []);
      assert.equal(parsed.rowCount, 3);
      assert.equal(parsed.verification, 'mismatch');
      assert.equal(parsed.statementVerification, 'mismatch');
      assert.deepEqual(parsed.totals, { creditMinor: 100_000, debitMinor: 10_500, netMinor: 89_500 });
      assert.deepEqual(parsed.statementSummary, {
        ...SUMMARY, closingMinor: 89_500,
        ...(transactionFees === undefined ? {} : { reportedDebitMinor: 10_000, transactionFeesMinor: -400, feesAddedToDebit: false }),
      });
      assert.ok(!parsed.warnings.some(w => w.includes('расход для сверки')));
      await assert.rejects(service.execute('import.commit', { previewId: parsed.previewId }), error => /MISMATCH/u.test(error?.code || ''));
      assert.equal(service.state({}).transactionTotal, 0);
      assert.equal(service.previews.size, 1);
    } finally { service.close(); }
  });
}

test('synthetic VTB PDF declared fee cannot manufacture a missing body row or bypass service verification', async () => {
  const service = createService();
  try {
    const parsed = await preview(service, syntheticVtbAccountPdf({ statedClosing: '895.00 RUB', transactionFees: '-5.00 RUB' }));
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rowCount, 2);
    assert.equal(parsed.transactionCount, 2);
    assert.deepEqual(parsed.transactions.map(row => row.amountMinor), [100_000, -10_000]);
    assert.deepEqual(parsed.totals, { creditMinor: 100_000, debitMinor: 10_000, netMinor: 90_000 });
    assert.equal(parsed.statementSummary.debitMinor, 10_500);
    assert.equal(parsed.statementSummary.feesAddedToDebit, true);
    assert.equal(parsed.statementVerification, 'mismatch');
    await assert.rejects(service.execute('import.commit', { previewId: parsed.previewId }), error => /MISMATCH/u.test(error?.code || ''));
    assert.equal(service.state({}).transactionTotal, 0);
  } finally { service.close(); }
});
