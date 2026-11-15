import { parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { isVtbAccountTable, collectPdfPathBoxes, parseVtbAccountStatement } from './vtb-pdf.js';

// Strictly text/table extraction. No rendering, actions, scripts, attachments or links are evaluated.
try {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const standardFontDataUrl = fileURLToPath(new URL('./standard_fonts/', import.meta.resolve('pdfjs-dist/package.json'))).replaceAll('\\', '/');
  const loading = pdfjs.getDocument({ data: workerData.bytes, standardFontDataUrl, isEvalSupported: false, enableXfa: false, useSystemFonts: false,
    // Auxiliary logo/font failures must not erase the operator list. The VTB parser separately
    // requires full row-grid coverage and the service reconciles all four statement controls.
    disableFontFace: true, useWorkerFetch: false, disableAutoFetch: true, disableStream: true, useWasm: false, stopAtErrors: false, maxImageSize: 1, verbosity: 0 });
  const doc = await loading.promise;
  try {
    if (doc.numPages > 100) throw Object.assign(new Error('PDF содержит больше 100 страниц. Выгрузите меньший период или CSV.'), { code: 'PDF_TOO_LARGE' });
    const lines = [], pages = []; let itemCount = 0, textSize = 0;
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo), content = await page.getTextContent({ disableNormalization: false });
      itemCount += content.items.length; if (itemCount > 150000) throw new Error('Слишком много текста в PDF. Используйте CSV.');
      const items = content.items.filter(i => typeof i.str === 'string' && i.str.trim()).map(i => ({ x: i.transform[4], y: i.transform[5], width: i.width || 0, text: i.str.replace(/\s+/g, ' ').trim() })).sort((a, b) => b.y - a.y || a.x - b.x);
      const grouped = [];
      for (const item of items) { let line = grouped.find(l => Math.abs(l.y - item.y) <= 2); if (!line) { line = { page: pageNo, y: item.y, items: [] }; grouped.push(line); } line.items.push(item); }
      for (const line of grouped) {
        line.items.sort((a, b) => a.x - b.x); line.text = line.items.map(i => i.text).join(' '); textSize += line.text.length;
        if (textSize > 2_000_000) throw new Error('PDF слишком большой для безопасного извлечения. Используйте CSV.'); lines.push(line);
      }
      const boxes = isVtbAccountTable(grouped) ? collectPdfPathBoxes(await page.getOperatorList(), pdfjs.OPS) : [];
      pages.push({ page: pageNo, lines: grouped, boxes });
      page.cleanup();
    }
    const plain = lines.map(l => l.text).join('\n');
    const vtb = parseVtbAccountStatement(pages);
    if (vtb) parentPort.postMessage({ ok: true, value: { parsed: vtb, extractedText: plain.slice(0, 200000) } });
    else {
    const datePattern = /(?:\b\d{2}\.\d{2}\.\d{4}\b|\b\d{4}-\d{2}-\d{2}\b)/;
    const headerCandidates = lines.filter(l => /дата|date/i.test(l.text) && /сумма|списан|зачисл|дебет|кредит|amount|debit|credit/i.test(l.text));
    const rows = []; let headers = null, anchors = null, currentPage = 0, discarded = 0;
    const normalizeHeader = s => s.toLocaleLowerCase('ru-RU').replace(/[^a-zа-яё]/g, '');
    const knownHeader = s => /^(дата|date|описание|назначение|операция|получатель|контрагент|сумма|списан|зачисл|приход|расход|дебет|кредит|валюта|description|amount|debit|credit|currency|получено|перечислено|идентификатор)/.test(normalizeHeader(s));
    for (const line of lines) {
      if (headerCandidates.includes(line)) {
        const cells = [];
        for (const item of line.items) {
          const prev = cells.at(-1);
          if (prev && (!knownHeader(item.text) || item.x - prev.end < 5)) { prev.text += ` ${item.text}`; prev.end = item.x + item.width; }
          else cells.push({ x: item.x, end: item.x + item.width, text: item.text });
        }
        const usable = cells.filter(c => knownHeader(c.text));
        if (usable.length >= 3 && usable.some(c => /дата|date/i.test(c.text)) && usable.some(c => /сумма|списан|зачисл|дебет|кредит|amount|debit|credit/i.test(c.text))) {
          if (!headers) { headers = usable.map(c => c.text); anchors = usable.map(c => c.x); }
          else if (usable.length === headers.length) anchors = usable.map(c => c.x);
          currentPage = line.page;
        }
        continue;
      }
      if (!anchors || line.page !== currentPage || !datePattern.test(line.text)) continue;
      const cells = headers.map(() => '');
      for (const item of line.items) {
        let index = 0;
        for (let j = 1; j < anchors.length; j++) if (item.x >= (anchors[j - 1] + anchors[j]) / 2) index = j;
        cells[index] += (cells[index] ? ' ' : '') + item.text;
      }
      const dateColumn = headers.findIndex(h => /дата|date/i.test(h));
      if (dateColumn < 0 || !datePattern.test(cells[dateColumn])) { discarded++; continue; }
      rows.push(cells);
    }
    if (!rows.length || !headers) throw Object.assign(new Error('Не удалось надёжно выделить таблицу PDF. Поддерживаются текстовые таблицы с заголовками даты и суммы. Используйте CSV; сканы/OCR в MVP не поддерживаются.'), { code: 'PDF_LAYOUT_UNSUPPORTED' });
    if (rows.length > 20000) throw new Error('Больше 20 000 строк. Выгрузите меньший период.');
    const dataDateLines = lines.filter(l => datePattern.test(l.text) && !/период|сформирован|остаток|выдан|выписка|statement|period/i.test(l.text)).length;
    const warnings = ['PDF: автоматическое восстановление границ колонок требует ручной проверки. Многострочные описания могут быть неполными.'];
    if (discarded || dataDateLines > rows.length) warnings.push('В PDF есть строки с датами вне распознанной таблицы. Возможны пропуски: обязательно сверяйте количество операций и обороты, при сомнении используйте CSV.');
    parentPort.postMessage({ ok: true, value: { parsed: { headers, rows, delimiter: ';', encoding: 'pdf-text', warnings }, extractedText: plain.slice(0, 200000) } });
    }
  } finally { await doc.destroy(); }
} catch (e) {
  const password = /password|encrypted/i.test(String(e?.message));
  parentPort.postMessage({ ok: false, code: password ? 'PDF_PASSWORD' : (e.code || 'PDF_PARSE'), message: password ? 'PDF защищён паролем. В MVP используйте CSV или незашифрованную выписку; пароль банка не нужен.' : String(e?.message || 'Не удалось извлечь текст PDF. Используйте CSV.').slice(0, 600) });
}
