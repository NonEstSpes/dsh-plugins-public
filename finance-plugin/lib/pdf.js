import { Worker } from 'node:worker_threads';
import { FinanceError } from './repository.js';

/** Local, isolated text extraction; no statement is written to disk. */
export function extractPdf(bytes, { timeoutMs = 30000, signal } = {}) {
  if (signal?.aborted) return Promise.reject(new FinanceError('CANCELLED', 'Обработка PDF отменена.'));
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./pdf-worker.js', import.meta.url), { workerData: { bytes: new Uint8Array(bytes) }, resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 8 } });
    let settled = false;
    const finish = async (error, value) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      try { await worker.terminate(); } catch { /* The worker may already have exited. */ }
      error ? reject(error) : resolve(value);
    };
    const abort = () => { void finish(new FinanceError('CANCELLED', 'Обработка PDF отменена.')); };
    const timer = setTimeout(() => { void finish(new FinanceError('PDF_TIMEOUT', 'PDF обрабатывается слишком долго. Попробуйте CSV или меньший период выписки.')); }, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', message => { void (message.ok ? finish(null, message.value) : finish(new FinanceError(message.code || 'PDF_PARSE', message.message || 'Не удалось прочитать PDF. Используйте CSV.'))); });
    worker.once('error', () => { void finish(new FinanceError('PDF_PARSE', 'Локальный PDF-парсер не смог прочитать документ. Попробуйте CSV; исходник не сохранялся.')); });
    worker.once('exit', code => { if (!settled) void finish(new FinanceError('PDF_PARSE', `PDF-парсер завершился до получения результата (${code}). Используйте CSV.`)); });
  });
}
