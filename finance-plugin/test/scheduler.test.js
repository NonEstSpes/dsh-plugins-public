import test from 'node:test';
import assert from 'node:assert/strict';
import { FinanceService } from '../lib/service.js';

test('Moscow scheduler runs at configured hour, catches latest periods and never duplicates unchanged reports', async () => {
  let now = new Date('2026-11-09T20:59:00+03:00');
  const s = new FinanceService(':memory:', { clock: () => now, backupRetention: 0 });
  try {
    s.tick(); assert.equal(s.repository.reports().length, 0);
    now = new Date('2026-11-09T21:01:00+03:00'); s.tick(); const reports = s.repository.reports(); assert.equal(reports.length, 3);
    assert.ok(reports.some(r => r.period === 'day' && r.fromDate === '2026-11-09'));
    assert.ok(reports.some(r => r.period === 'week' && r.fromDate === '2026-11-02' && r.toDate === '2026-11-08'));
    assert.ok(reports.some(r => r.period === 'month' && r.fromDate === '2026-10-01' && r.toDate === '2026-10-31'));
    s.tick(); assert.equal(s.repository.reports().length, 3);
    await s.execute('settings.save', { reportsEnabled: false }); now = new Date('2026-11-10T22:00:00+03:00'); s.tick(); assert.equal(s.repository.reports().length, 3);
    await s.execute('settings.save', { reportsEnabled: true }); s.tick(); assert.equal(s.repository.reports().length, 4);
    assert.equal(s.repository.reports()[0].fromDate, '2026-11-10');
  } finally { s.close(); }
});
