import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPdf } from '../lib/pdf.js';
import { FinanceService } from '../lib/service.js';

// An original, tiny ASCII PDF generated in memory. Not a user statement or visual preview.
function syntheticPdf({ table = true, dateHeader = 'Date' } = {}) {
  const escapedDateHeader = dateHeader.replace(/([\\()])/g, '\\$1');
  const operations = table ? [
    `BT /F1 10 Tf 40 750 Td (${escapedDateHeader}) Tj ET`, 'BT /F1 10 Tf 180 750 Td (Description) Tj ET',
    'BT /F1 10 Tf 400 750 Td (Debit) Tj ET', 'BT /F1 10 Tf 500 750 Td (Credit) Tj ET',
    'BT /F1 10 Tf 40 720 Td (09.11.2026) Tj ET', 'BT /F1 10 Tf 180 720 Td (Synthetic shop) Tj ET', 'BT /F1 10 Tf 400 720 Td (100.00) Tj ET',
    'BT /F1 10 Tf 40 700 Td (09.11.2026) Tj ET', 'BT /F1 10 Tf 180 700 Td (Synthetic salary) Tj ET', 'BT /F1 10 Tf 500 700 Td (1000.00) Tj ET',
  ].join('\n') : 'BT /F1 10 Tf 40 750 Td (No statement table) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(operations)} >>\nstream\n${operations}\nendstream`,
  ];
  let body = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((obj, i) => { offsets.push(Buffer.byteLength(body)); body += `${i + 1} 0 obj\n${obj}\nendobj\n`; });
  const xref = Buffer.byteLength(body); body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`; return Buffer.from(body);
}

test('isolated PDF worker extracts a recognizable text table without writing a file', async () => {
  const value = await extractPdf(syntheticPdf()); assert.deepEqual(value.parsed.headers, ['Date','Description','Debit','Credit']);
  assert.equal(value.parsed.rows.length, 2); assert.equal(value.parsed.rows[0][2], '100.00'); assert.equal(value.parsed.rows[1][3], '1000.00'); assert.ok(value.parsed.warnings.length);
});

test('PDF follows the same preview, validation and atomic ledger pipeline as CSV', async () => {
  const s = new FinanceService(':memory:');
  try {
    const a = await s.execute('account.save', { name: 'Synthetic PDF account' });
    const p = await s.execute('import.preview', { accountId: a.id, fileName: 'synthetic.pdf', base64: syntheticPdf().toString('base64'), openingMinor: 0, closingMinor: 90000 });
    assert.equal(p.format, 'PDF'); assert.equal(p.errors.length, 0); assert.equal(p.verification, 'balanced'); assert.equal(p.totals.debitMinor, 10000); assert.equal(p.totals.creditMinor, 100000);
    const value = await s.execute('import.commit', { previewId: p.previewId }); assert.equal(value.insertedCount, 2); assert.equal(s.previews.size, 0);
  } finally { s.close(); }
});

test('PDF with a bank-specific date header remains editable until mapped and explicitly committed', async () => {
  const s = new FinanceService(':memory:');
  try {
    const a = await s.execute('account.save', { name: 'Synthetic PDF manual-mapping account' });
    const p = await s.execute('import.preview', { accountId: a.id, fileName: 'synthetic-mapping.pdf', base64: syntheticPdf({ dateHeader: 'Date (bank-specific)' }).toString('base64'), openingMinor: 0, closingMinor: 90000 });
    assert.equal(p.format, 'PDF'); assert.equal(p.mappingRequired, true); assert.equal(p.totals, null); assert.equal(p.verification, 'not_calculated');
    assert.deepEqual(p.headers, ['Date (bank-specific)', 'Description', 'Debit', 'Credit']);
    assert.ok(p.errors.some(e => e.scope === 'mapping' && e.field === 'date'));
    assert.equal(s.state({}).transactionTotal, 0);
    await assert.rejects(s.execute('import.commit', { previewId: p.previewId }), e => e.code === 'MAPPING_REQUIRED');
    assert.equal(s.state({}).transactionTotal, 0);
    const fixed = await s.execute('import.remap', { previewId: p.previewId, mapping: { ...p.mapping, date: 0 }, openingMinor: 0, closingMinor: 90000 });
    assert.equal(fixed.mappingRequired, false); assert.equal(fixed.errors.length, 0); assert.equal(fixed.verification, 'balanced');
    assert.equal(fixed.totals.debitMinor, 10000); assert.equal(fixed.totals.creditMinor, 100000); assert.equal(s.state({}).transactionTotal, 0);
    const result = await s.execute('import.commit', { previewId: fixed.previewId });
    assert.equal(result.insertedCount, 2); assert.equal(s.state({}).transactionTotal, 2); assert.equal(s.previews.size, 0);
  } finally { s.close(); }
});

test('PDF automatically maps the Date / Time header to the date column', async () => {
  const s = new FinanceService(':memory:');
  try {
    const a = await s.execute('account.save', { name: 'Synthetic PDF date-time account' });
    const p = await s.execute('import.preview', { accountId: a.id, fileName: 'synthetic-date-time.pdf', base64: syntheticPdf({ dateHeader: 'Date / Time' }).toString('base64'), openingMinor: 0, closingMinor: 90000 });
    assert.equal(p.mapping.date, 0); assert.equal(p.mappingRequired, false); assert.equal(p.errors.length, 0); assert.equal(p.verification, 'balanced');
  } finally { s.close(); }
});

test('unsupported layout, corrupt PDF, timeout and cancellation fail explicitly', async () => {
  await assert.rejects(extractPdf(syntheticPdf({ table: false })), e => e.code === 'PDF_LAYOUT_UNSUPPORTED');
  await assert.rejects(extractPdf(Buffer.from('%PDF-1.4\nbroken')), e => /^PDF_/.test(e.code));
  await assert.rejects(extractPdf(syntheticPdf(), { timeoutMs: 1 }), e => e.code === 'PDF_TIMEOUT');
  const controller = new AbortController(); controller.abort(); await assert.rejects(extractPdf(syntheticPdf(), { signal: controller.signal }), e => e.code === 'CANCELLED');
});
