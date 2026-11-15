import { moneyToMinor } from './finance-core.js';

const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
const lineText = l => l.items.map(i => i.text).join(' ');
const fail = (code, message) => { throw Object.assign(new Error(message), { name: 'PdfLayoutError', code }); };
const changed = message => fail('PDF_LAYOUT_CHANGED', `ВТБ: ${message} Импорт остановлен; проверьте формат выписки.`);
const unique = values => values.sort((a,b) => a-b).filter((v,i,a) => !i || Math.abs(v-a[i-1]) > 0.6);
const datePattern = /\b\d{2}\.\d{2}\.\d{4}\b/g;
const center = i => i.x + i.width / 2;
const headerLine = lines => lines.find(l => norm(lineText(l)).includes('дата и время') && norm(lineText(l)).includes('дата обработки'));

export function isVtbAccountTable(lines) {
  const head = headerLine(lines); if (!head) return false;
  const text = norm(lines.filter(l => l.y >= head.y-25 && l.y <= head.y+15).map(lineText).join(' '));
  return ['сумма операции в валюте счета', 'описание операции', 'приход', 'расход'].every(s => text.includes(s));
}

/** PDF.js 5.4 constructPath bounds are before the graphics-state transform. No PDF actions execute. */
export function collectPdfPathBoxes(list, OPS) {
  let m = [1,0,0,1,0,0]; const stack = [], boxes = [];
  for (let k=0; k<list.fnArray.length; k++) {
    const op = list.fnArray[k], args = list.argsArray[k];
    if (op === OPS.save) stack.push([...m]);
    else if (op === OPS.restore) m = stack.pop() || [1,0,0,1,0,0];
    else if (op === OPS.transform && args?.length === 6) {
      const [a,b,c,d,e,f] = m, [g,h,i,j,x,y] = args;
      m = [a*g+c*h,b*g+d*h,a*i+c*j,b*i+d*j,a*x+c*y+e,b*x+d*y+f];
    } else if (op === OPS.constructPath) {
      // A single paint can contain disconnected row rules. Keep each subpath's bounds,
      // not only PDF.js's aggregate bounding box (which would merge neighbouring rows).
      for (const path of args?.[1] || []) {
        if (!Array.isArray(path) && !ArrayBuffer.isView(path)) continue;
        let points=[], curved=false;
        const flush=()=>{
          if (!curved && points.length>=2) {
            const xs=points.map(([x,y])=>m[0]*x+m[2]*y+m[4]), ys=points.map(([x,y])=>m[1]*x+m[3]*y+m[5]);
            if ([...xs,...ys].every(Number.isFinite)) boxes.push({left:Math.min(...xs),right:Math.max(...xs),bottom:Math.min(...ys),top:Math.max(...ys)});
          }
          points=[]; curved=false;
        };
        for (let j=0;j<path.length;) {
          const command=path[j++];
          if (command===0) { flush(); points.push([path[j++],path[j++]]); }
          else if (command===1) points.push([path[j++],path[j++]]);
          else if (command===2) { curved=true; j+=6; }
          else if (command===3) { curved=true; j+=4; }
          else if (command===4) flush();
          else { curved=true; break; }
        }
        flush();
      }
    }
  }
  return boxes;
}

const summaryLabels = {
  openingMinor: 'баланс на начало периода', closingMinor: 'баланс на конец периода',
  creditMinor: 'поступления', debitMinor: 'расходные операции',
  transactionFeesMinor: 'общая сумма транзакционных комиссий',
};
const requiredSummaryFields = ['openingMinor', 'closingMinor', 'creditMinor', 'debitMinor'];
function statementSummary(pages) {
  const summaries=[];
  for (const page of pages) {
    const fields = {};
    const head = headerLine(page.lines);
    for (const line of page.lines.filter(l => !head || l.y > head.y+15)) {
      const items=[...line.items].sort((a,b)=>a.x-b.x);
      for (let k=0; k<items.length; k++) {
        const field = Object.keys(summaryLabels).find(f => norm(items[k].text) === summaryLabels[f]); if (!field) continue;
        const nextLabel = items.slice(k+1).find(i => Object.values(summaryLabels).includes(norm(i.text)));
        const values=items.slice(k+1).filter(i => (!nextLabel || i.x<nextLabel.x) && /^[-+\d(]/.test(i.text.trim()));
        if (values.length !== 1 || fields[field] !== undefined) fail('PDF_SUMMARY_INVALID', 'ВТБ: контрольные итоги выписки отсутствуют или неоднозначны.');
        const value=values[0].text.trim();
        if (!/(?:\s(?:RUB|RUR|руб\.?)|₽)$/iu.test(value)) fail('PDF_CURRENCY', 'ВТБ: поддерживаются только выписки рублёвого счёта.');
        try { fields[field]=moneyToMinor(value.replace(/RUR$/iu,'RUB')); }
        catch { fail('PDF_SUMMARY_INVALID', 'ВТБ: не удалось прочитать контрольные итоги выписки.'); }
      }
    }
    if (Object.keys(fields).length) {
      if (!requiredSummaryFields.every(field => fields[field] !== undefined) || fields.creditMinor<0 || fields.debitMinor<0) fail('PDF_SUMMARY_INVALID', 'ВТБ: нужны оба остатка и оба оборота из выписки.');
      if (fields.transactionFeesMinor > 0) fail('PDF_SUMMARY_INVALID', 'ВТБ: положительная сумма транзакционных комиссий не поддерживается.');
      summaries.push(fields);
    }
  }
  if (summaries.length !== 1) fail('PDF_SUMMARY_INVALID', 'ВТБ: не найден единственный полный блок контрольных итогов выписки.');
  const summary = { ...summaries[0], currency:'RUB' };
  if (summary.transactionFeesMinor !== undefined) {
    summary.reportedDebitMinor = summary.debitMinor;
    summary.feesAddedToDebit = false;
    // Only an explicitly declared debit fee may explain otherwise inconsistent bank controls.
    // Use exact integers even when the intermediate balance exceeds the safe Number range.
    const fee = BigInt(summary.transactionFeesMinor);
    const rawBalance = BigInt(summary.openingMinor) + BigInt(summary.creditMinor) - BigInt(summary.reportedDebitMinor);
    const closing = BigInt(summary.closingMinor);
    if (fee < 0n && rawBalance !== closing && rawBalance + fee === closing) {
      const debit = BigInt(summary.reportedDebitMinor) - fee;
      if (debit > BigInt(Number.MAX_SAFE_INTEGER)) fail('PDF_SUMMARY_INVALID', 'ВТБ: расход с транзакционными комиссиями превышает безопасный диапазон сумм.');
      summary.debitMinor = Number(debit);
      summary.feesAddedToDebit = true;
    }
  }
  return summary;
}

/** Specific seven-column VTB account statement. Never infer a sign from the original FX amount. */
export function parseVtbAccountStatement(pages) {
  const tablePages=pages.filter(p=>isVtbAccountTable(p.lines)); if (!tablePages.length) return null;
  const summary=statementSummary(pages), rows=[]; let firstCuts, normalizedOutflows=0;
  for (const page of pages) {
    if (!isVtbAccountTable(page.lines)) {
      if (firstCuts && page.lines.some(l=>l.items.some(i=>center(i)>firstCuts[0] && center(i)<firstCuts[1] && /^\d{2}\.\d{2}\.\d{4}$/.test(i.text.trim())))) changed('обнаружены даты операций на странице без заголовка таблицы.');
      continue;
    }
    const head=headerLine(page.lines), dateHead=head.items.find(i=>norm(i.text).startsWith('дата'));
    const candidates=(page.boxes || []).filter(b=>b.right-b.left>=dateHead.width-1 && b.right-b.left<=180 && b.top-b.bottom>=10 && b.top-b.bottom<=90 && center(dateHead)>b.left && center(dateHead)<b.right && head.y>b.bottom && head.y<b.top).sort((a,b)=>(a.right-a.left)*(a.top-a.bottom)-(b.right-b.left)*(b.top-b.bottom));
    const rect=candidates[0]; if (!rect) changed(`не найдены границы ячеек заголовка (страница ${page.page}).`);
    const headerRects=page.boxes.filter(b=>b.top-b.bottom>=9 && b.right-b.left>=30 && b.bottom>=rect.bottom-0.6 && b.top<=rect.top+0.6 && b.left>=rect.left-0.6);
    const cuts=unique(headerRects.flatMap(b=>[b.left,b.right])); if (cuts.length!==8) changed('ожидалось семь отдельных колонок.');
    firstCuts ||= cuts;
    const band=page.lines.filter(l=>l.y>rect.bottom && l.y<rect.top).flatMap(l=>l.items);
    const names=cuts.slice(0,-1).map((x,j)=>norm(band.filter(i=>i.x>=x-0.6 && i.x+i.width<=cuts[j+1]+0.6).sort((a,b)=>b.y-a.y || a.x-b.x).map(i=>i.text).join(' ')));
    if (![/дата/,/дата.*обработ/,/сумма.*валюте.*операци/,/приход/,/расход/,/описание операции/,/наименование.*получателя.*отправителя/].every((re,j)=>re.test(names[j]))) changed('назначение колонок не совпало с банковским шаблоном.');
    const bounds=unique([rect.bottom,...page.boxes.filter(b=>Math.abs(b.left-cuts[0])<=0.6 && Math.abs(b.right-cuts[1])<=0.6 && b.top<=rect.bottom+0.6).flatMap(b=>[b.bottom,b.top])]).sort((a,b)=>b-a);
    if (bounds.length>20002) changed('слишком много границ строк.');
    const items=page.lines.flatMap(l=>l.items);
    const datedItems=items.filter(i=>i.y<rect.bottom-0.1 && center(i)>cuts[0] && center(i)<cuts[1] && (i.text.match(datePattern)||[]).length);
    let count=0;
    for (let k=0;k<bounds.length-1;k++) {
      const top=bounds[k], bottom=bounds[k+1]; if (top-bottom<1) continue;
      const cells=Array.from({length:7},()=>[]);
      for (const i of items.filter(i=>i.y<top-0.1 && i.y>bottom+0.1 && center(i)>=cuts[0]-0.6 && center(i)<=cuts[7]+0.6)) {
        let col=cuts.findIndex((x,j)=>j<7 && center(i)>=x && center(i)<cuts[j+1]); if (col<0) changed('текст оказался за границей колонки.');
        if (i.x<cuts[col]-1.5 || i.x+i.width>cuts[col+1]+1.5) changed('текст пересекает границу соседней колонки.');
        cells[col].push(i);
      }
      const values=cells.map(c=>c.sort((a,b)=>b.y-a.y || a.x-b.x).map(i=>i.text).join(' ').replace(/\s+/g,' ').trim());
      if (values.every(v=>!v)) continue;
      if ((values[0].match(datePattern)||[]).length!==1) changed('в строке таблицы нет единственной даты операции.');
      values[3]=values[3].replace(/RUR$/iu,'RUB'); values[4]=values[4].replace(/RUR$/iu,'RUB');
      // VTB labels this side as an expense and prints a negative signed amount. Core debitCredit
      // accepts magnitudes; do not apply this transformation to income or the original FX column.
      try { const debit=moneyToMinor(values[4]); if (debit<0) { const n=-BigInt(debit); values[4]=`${n/100n}.${String(n%100n).padStart(2,'0')} RUB`; normalizedOutflows++; } }
      catch { /* Keep the original invalid cell: buildImport reports it and blocks committing. */ }
      rows.push(values); count++; if (rows.length>20000) fail('PDF_TOO_LARGE', 'ВТБ: больше 20 000 операций. Выгрузите меньший период.');
    }
    if (count!==datedItems.length) changed('есть операции вне восстановленных границ строк.');
  }
  return {
    headers:['Дата операции','Дата обработки','Сумма операции в валюте операции','Приход','Расход','Описание операции','Контрагент'], rows,
    delimiter:';', encoding:'pdf-vtb-account-v1', warnings:['ВТБ: суммы взяты из колонок «Приход / Расход» в валюте счёта, а не из суммы в валюте операции. Проверьте переводы между своими счетами и категории перед подтверждением.', ...(normalizedOutflows ? ['ВТБ: отрицательные значения в колонке «Расход» представлены величинами списаний. Итоговые операции расходов сохраняют отрицательный знак.'] : []), ...(summary.feesAddedToDebit ? ['ВТБ: расход для сверки включает отдельно указанные транзакционные комиссии; суммы и количество строк не изменены.'] : [])],
    statementSummary:summary, pdfLayout:{id:'vtb-account-v1',pageCount:pages.length,tablePages:tablePages.length,sourceRowCount:rows.length,checkedCoverage:true},
  };
}
