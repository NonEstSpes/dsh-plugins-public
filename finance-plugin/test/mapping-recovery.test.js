import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FinanceService, FINANCE_VERSION } from '../lib/service.js';
import { FinanceMappingError, FinanceValidationError, buildImport, suggestMapping } from '../lib/finance-core.js';
import { makeHttpHandler, Config } from '../index.js';

const create = async () => { const s = new FinanceService(':memory:', { backupRetention: 0 }); const account = await s.execute('account.save', { name: 'Synthetic mapping account' }); return { s, account }; };
const unknownDateCsv = 'Когда;Сумма;Описание\n09.11.2026;-123,45;Synthetic';

test('missing mandatory mapping has a specific recoverable type; other validation remains strict', () => {
  const parsed = { headers: ['Когда','Сумма'], rows: [['09.11.2026','-1']] };
  assert.throws(() => buildImport(parsed, { amount: 1 }), e => e instanceof FinanceMappingError && e instanceof FinanceValidationError && e.code === 'MAPPING_REQUIRED' && e.field === 'date');
  assert.throws(() => buildImport(parsed, { date: 0 }), e => e instanceof FinanceMappingError && e.field === 'amount');
  assert.throws(() => buildImport(parsed, { date: 0, amountMode: 'debitCredit' }), e => e instanceof FinanceMappingError && e.field === 'debitCredit');
  assert.throws(() => buildImport(parsed, { date: 0, amount: 1, amountMode: 'direction' }), e => e instanceof FinanceMappingError && e.field === 'direction');
  assert.throws(() => buildImport(parsed, { date: 999, amount: 1 }), e => e instanceof FinanceValidationError && !(e instanceof FinanceMappingError));
  assert.throws(() => buildImport({ headers: [], rows: null }, {}), e => !(e instanceof FinanceMappingError));
});

test('known date-time labels are exact aliases, not a guess from any posting-date column', () => {
  for (const date of ['Дата и время', 'Дата / время', 'Дата и время совершения операции', 'Дата проведения операции', 'Date / Time', 'Date and time']) assert.equal(suggestMapping([date,'Сумма']).mapping.date, 0);
  assert.equal(suggestMapping(['Дата обработки','Сумма']).mapping.date, undefined);
  assert.equal(suggestMapping(['Date (bank-specific)','Amount']).mapping.date, undefined);
  assert.match(Config.meta.description, new RegExp(FINANCE_VERSION.replaceAll('.', '\\.')));
});

test('unknown CSV headers retain an editable preview, invalidate old tokens on remap and clear obsolete hints', async () => {
  const { s, account } = await create(); try {
    const p = await s.execute('import.preview', { accountId: account.id, fileName: 'synthetic.csv', csvText: unknownDateCsv });
    assert.equal(p.mappingRequired, true); assert.equal(p.totals, null); assert.equal(p.verification, 'not_calculated'); assert.deepEqual(p.sampleRows, [['09.11.2026','-123,45','Synthetic']]);
    assert.equal(s.state({}).transactionTotal, 0); await assert.rejects(s.execute('import.commit', { previewId: p.previewId }), e => e.code === 'MAPPING_REQUIRED');
    await assert.rejects(s.execute('import.remap', { previewId: p.previewId, mapping: { date: 999, amount: 1 } })); assert.equal(s.previews.has(p.previewId), true);
    const fixed = await s.execute('import.remap', { previewId: p.previewId, mapping: { ...p.mapping, date: 0 } });
    assert.equal(s.previews.has(p.previewId), false); assert.equal(fixed.mappingRequired, false); assert.equal(fixed.totals.debitMinor, 12345);
    assert.ok(!fixed.warnings.some(w => /Не найден столбец даты/.test(w))); assert.equal(s.state({}).transactionTotal, 0);
    await assert.rejects(s.execute('import.commit', { previewId: p.previewId }), e => e.code === 'PREVIEW_EXPIRED');
    await s.execute('import.commit', { previewId: fixed.previewId }); assert.equal(s.state({}).transactionTotal, 1);
  } finally { s.close(); }
});

test('sequential missing fields and balance verification cannot produce fabricated totals or allow premature commit', async () => {
  const { s, account } = await create(); try {
    let p = await s.execute('import.preview', { accountId: account.id, fileName: 'synthetic.csv', csvText: 'Когда;Сколько;Назначение\n09.11.2026;-10;Synthetic', openingMinor: 10000, closingMinor: 9000 });
    assert.equal(p.totals, null); assert.equal(p.verification, 'not_calculated');
    p = await s.execute('import.remap', { previewId: p.previewId, mapping: { date: 0, amountMode: 'signed' } }); assert.equal(p.errors[0].field, 'amount'); assert.equal(p.totals, null);
    p = await s.execute('import.remap', { previewId: p.previewId, mapping: { date: 0, amount: 1, amountMode: 'direction' } }); assert.equal(p.errors[0].field, 'direction');
    p = await s.execute('import.remap', { previewId: p.previewId, mapping: { date: 0, amount: 1, amountMode: 'signed' } }); assert.equal(p.verification, 'balanced'); assert.equal(p.totals.netMinor, -1000);
    assert.equal(s.state({}).transactionTotal, 0); await s.execute('import.discard', { previewId: p.previewId }); assert.equal(s.previews.size, 0);
  } finally { s.close(); }
});

test('authenticated HTTP preview returns 200 with editable mapping instead of an unrecoverable 400', { timeout: 10000 }, async () => {
  const { s, account } = await create(); const server = createServer(makeHttpHandler(s, { requestRejection: () => undefined }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/finance`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DSH-Finance': '1' }, body: JSON.stringify({ action: 'import.preview', args: { accountId: account.id, fileName: 'synthetic.csv', csvText: unknownDateCsv } }), signal: AbortSignal.timeout(5000) });
    assert.equal(response.status, 200); const body = await response.json(); assert.equal(body.ok, true); assert.equal(body.value.mappingRequired, true); assert.equal(body.value.errors[0].field, 'date'); assert.equal(s.state({}).transactionTotal, 0);
  } finally { await new Promise(resolve => server.close(resolve)); s.close(); }
});
