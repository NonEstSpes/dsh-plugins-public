/** Чистое финансовое ядро: без сети, хранилища, часов и сторонних зависимостей. */
const MAX = BigInt(Number.MAX_SAFE_INTEGER);
const MAX_ROWS = 20_000;
const MAX_COLS = 128;
const MAX_FILE = 16 * 1024 * 1024;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
export class FinanceValidationError extends Error {
  constructor(message) { super(message); this.name = 'FinanceValidationError'; }
}
export class FinanceMappingError extends FinanceValidationError {
  constructor(message, field) { super(message); this.name = 'FinanceMappingError'; this.code = 'MAPPING_REQUIRED'; this.field = field; }
}
const fail = (message) => { throw new FinanceValidationError(message); };
const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function safe(value, label = 'Сумма') {
  if (value > MAX || value < -MAX) fail(`${label}: переполнение безопасного целого числа.`);
  return Number(value);
}
function integer(value, label, { min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}: требуется целое число от ${min} до ${max}.`);
  return value;
}
function total(values, label = 'Сумма') {
  return safe(values.reduce((sum, value) => sum + BigInt(value), 0n), label);
}
function numeric(value, label, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label}: требуется конечное число от ${min} до ${max}.`);
  return value;
}

/** Рубли -> целые копейки. Группы тысяч допускаются только через пробелы. */
export function moneyToMinor(value) {
  if (typeof value !== 'string' && typeof value !== 'number') fail('Сумма: требуется строка или число.');
  if (typeof value === 'number' && !Number.isFinite(value)) fail('Сумма должна быть конечным числом.');
  let text = String(value).trim().replace(/[\u00a0\u202f]/g, ' ');
  if (!text) fail('Сумма не заполнена.');
  let negative = false;
  let parentheses = false;
  const unwrap = () => {
    if (text.startsWith('(') && text.endsWith(')')) {
      if (parentheses) fail('Сумма: повторные скобки недопустимы.');
      parentheses = true;
      negative = true;
      text = text.slice(1, -1).trim();
    }
  };
  unwrap();
  const currency = /^(?:RUB|₽|руб\.?)\s*|\s*(?:RUB|₽|руб\.?)$/iu;
  const match = text.match(currency);
  if (match) text = text.replace(currency, '').trim();
  unwrap();
  if (/^[+-]/.test(text)) {
    if (parentheses) fail('Сумма: знак вместе со скобками неоднозначен.');
    negative = text[0] === '-';
    text = text.slice(1).trim();
  }
  if (!/^(?:\d+|\d{1,3}(?: \d{3})+)(?:[.,]\d{1,2})?$/.test(text)) {
    fail('Сумма: неверный формат, неоднозначные разделители или больше двух знаков после запятой.');
  }
  const [whole, fraction = ''] = text.replace(/ /g, '').split(/[.,]/);
  const minor = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0') || '0');
  return safe(negative ? -minor : minor);
}

const ALIASES = {
  date: ['дата', 'дата операции', 'дата совершения операции', 'дата платежа', 'дата транзакции', 'дата проведения операции', 'дата и время', 'дата время', 'дата и время операции', 'дата и время совершения операции', 'operation date', 'transaction date', 'date time', 'date and time', 'date'],
  postedDate: ['дата проводки', 'дата обработки', 'дата отражения по счету', 'дата обработки операции', 'дата списания', 'дата зачисления', 'дата по счету', 'posted date', 'posting date', 'дата валютирования'],
  amount: ['сумма', 'сумма операции', 'сумма в валюте счета', 'сумма операции в валюте счета', 'сумма в рублях', 'сумма платежа', 'amount', 'transaction amount'],
  debit: ['дебет', 'расход', 'списание', 'сумма списания', 'сумма расхода', 'debit', 'expense', 'withdrawal'],
  credit: ['кредит', 'приход', 'зачисление', 'поступление', 'сумма зачисления', 'сумма прихода', 'credit', 'income', 'deposit'],
  description: ['описание', 'назначение платежа', 'детали операции', 'описание операции', 'содержание операции', 'наименование операции', 'description', 'details', 'назначение'],
  counterparty: ['контрагент', 'получатель', 'плательщик', 'получатель плательщик', 'наименование контрагента', 'наименование получателя плательщика', 'counterparty', 'merchant'],
  bankId: ['идентификатор операции', 'номер операции', 'номер документа', 'id операции', 'ид операции', 'transaction id', 'bank id', 'reference', 'идентификатор'],
  currency: ['валюта', 'валюта операции', 'валюта счета', 'код валюты', 'currency'],
  direction: ['направление', 'тип операции', 'вид операции', 'направление операции', 'приход расход', 'дебет кредит', 'direction', 'type', 'credit debit'],
};
const FIELD_LABELS = { date: 'Дата', postedDate: 'Дата проводки', amount: 'Сумма', debit: 'Дебет', credit: 'Кредит', description: 'Описание', counterparty: 'Контрагент', bankId: 'Номер операции', currency: 'Валюта', direction: 'Направление' };
const aliasSets = Object.fromEntries(Object.entries(ALIASES).map(([key, values]) => [key, new Set(values.map(normalize))]));
function headerCandidate(records) {
  for (let index = 0; index < Math.min(30, records.length); index++) {
    const names = records[index].map(normalize);
    if (names.some((name) => aliasSets.date.has(name)) && names.some((name) => ['amount', 'debit', 'credit'].some((key) => aliasSets[key].has(name)))) return index;
  }
  return -1;
}

function decodeFile(input, requested) {
  const encodings = { auto: 'auto', utf8: 'utf-8', 'utf-8': 'utf-8', utf16le: 'utf-16le', 'utf-16le': 'utf-16le', 'windows-1251': 'windows-1251', windows1251: 'windows-1251', cp1251: 'windows-1251' };
  const encoding = encodings[String(requested).toLowerCase()];
  if (!encoding) fail('Неизвестная кодировка. Выберите UTF-8, UTF-16LE или Windows-1251.');
  if (typeof input === 'string') {
    if (input.length > MAX_FILE) fail('Файл превышает ограничение 16 МиБ.');
    return { text: input.replace(/^\uFEFF/, ''), encoding: encoding === 'auto' ? 'utf-8' : encoding, warnings: [] };
  }
  let bytes;
  if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else fail('CSV: требуется текст или массив байтов.');
  if (bytes.length > MAX_FILE) fail('Файл превышает ограничение 16 МиБ.');
  let selected = encoding;
  const warnings = [];
  if (selected === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) selected = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) fail('Кодировка UTF-16BE не поддерживается. Сохраните файл как UTF-8 или UTF-16LE.');
    else {
      let oddZero = 0;
      let pairs = 0;
      for (let index = 0; index + 1 < Math.min(bytes.length, 1024); index += 2) { pairs++; if (bytes[index + 1] === 0) oddZero++; }
      if (pairs > 2 && oddZero / pairs > 0.25) { selected = 'utf-16le'; warnings.push('UTF-16LE определена без метки BOM; проверьте текст.'); }
      else {
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); selected = 'utf-8'; }
        catch { selected = 'windows-1251'; warnings.push('Выбрана Windows-1251: файл не является корректным UTF-8. Проверьте текст.'); }
      }
    }
  }
  if (selected === 'utf-16le' && bytes.length % 2) fail('Повреждённый UTF-16LE: нечётное число байтов.');
  try { return { text: new TextDecoder(selected, { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''), encoding: selected, warnings }; }
  catch { fail('Файл повреждён или не соответствует выбранной кодировке.'); }
}

function readRecords(text, delimiter) {
  const records = [];
  const lines = [];
  let record = [];
  let field = '';
  let state = 'start';
  let physicalLine = 1;
  let recordLine = 1;
  const pushField = () => {
    record.push(field);
    field = '';
    state = 'start';
    if (record.length > MAX_COLS) fail('CSV: допускается не более 128 столбцов.');
  };
  const pushRecord = () => {
    pushField();
    records.push(record);
    lines.push(recordLine);
    record = [];
    if (records.length > MAX_ROWS + 1) fail('CSV: допускается не более 20000 строк.');
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    const newline = char === '\n' || char === '\r';
    if (state === 'quoted') {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index++; }
        else state = 'closed';
      } else {
        field += char;
        if (newline) {
          if (char === '\r' && text[index + 1] === '\n') { field += '\n'; index++; }
          physicalLine++;
        }
      }
      continue;
    }
    if (state === 'closed' && char !== delimiter && !newline) fail(`CSV, строка ${physicalLine}: лишний символ после закрывающей кавычки.`);
    if (char === delimiter) { pushField(); continue; }
    if (newline) {
      pushRecord();
      if (char === '\r' && text[index + 1] === '\n') index++;
      physicalLine++;
      recordLine = physicalLine;
      continue;
    }
    if (char === '"') {
      if (state !== 'start') fail(`CSV, строка ${physicalLine}: кавычка внутри некавыченного поля.`);
      state = 'quoted';
    } else { field += char; state = 'plain'; }
  }
  if (state === 'quoted') fail(`CSV, строка ${recordLine}: незакрытые кавычки.`);
  if (record.length || field || state !== 'start') pushRecord();
  while (records.length && records.at(-1).every((cell) => !cell.trim())) { records.pop(); lines.pop(); }
  if (records.length > MAX_ROWS) fail('CSV: допускается не более 20000 строк, включая заголовок.');
  return { records, lines };
}

/** Индекс headerRow начинается с нуля; отсутствие параметра и 'auto' включают поиск первых 30 строк. */
export function parseCsvFile(bytesOrString, options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Параметры CSV должны быть объектом.');
  const decoded = decodeFile(bytesOrString, options.encoding ?? 'auto');
  if (!decoded.text.trim()) fail('CSV-файл пуст.');
  const delimiterOption = options.delimiter ?? 'auto';
  if (!['auto', ';', ',', '\t'].includes(delimiterOption)) fail('Разделитель CSV должен быть точкой с запятой, запятой или табуляцией.');
  const autoHeader = !own(options, 'headerRow') || options.headerRow === 'auto';
  if (!autoHeader) integer(options.headerRow, 'Строка заголовка', { min: 0, max: MAX_ROWS - 1 });
  const attempts = [];
  const failures = [];
  for (const delimiter of delimiterOption === 'auto' ? [';', '\t', ','] : [delimiterOption]) {
    try {
      const data = readRecords(decoded.text, delimiter);
      const found = headerCandidate(data.records);
      const headerIndex = autoHeader ? Math.max(0, found) : options.headerRow;
      const width = data.records[headerIndex]?.length ?? 0;
      const matching = data.records.slice(headerIndex + 1).filter((row) => row.length === width).length;
      const structureWidth = data.records.reduce((widest, row) => Math.max(widest, row.length), width);
      const score = (found >= 0 ? 100_000 : 0) + (structureWidth > 1 ? 1_000 : 0) + structureWidth + matching / Math.max(1, data.records.length);
      attempts.push({ ...data, delimiter, found, headerIndex, score });
    } catch (error) { failures.push(error); }
  }
  if (!attempts.length) throw failures[0];
  attempts.sort((a, b) => b.score - a.score);
  const selected = attempts[0];
  if (selected.records[selected.headerIndex]?.length === 1) {
    const limitFailure = failures.find((error) => /128 столбцов/.test(error.message));
    if (limitFailure) throw limitFailure;
  }
  const { records, lines, headerIndex, delimiter } = selected;
  const headers = records[headerIndex];
  if (!headers || !headers.length || headers.every((cell) => !cell.trim())) fail('Строка заголовка отсутствует или пуста.');
  const rows = records.slice(headerIndex + 1);
  for (let index = 0; index < rows.length; index++) {
    if (rows[index].length !== headers.length) fail(`CSV, строка ${lines[headerIndex + 1 + index]}: число столбцов ${rows[index].length}, ожидалось ${headers.length}.`);
  }
  const warnings = [...decoded.warnings];
  if (autoHeader && selected.found < 0) warnings.push('Заголовок с датой и суммой не распознан; использована первая строка. Проверьте сопоставление.');
  if (headerIndex > 0) warnings.push(`Пропущено служебных строк до заголовка: ${headerIndex}.`);
  if (new Set(headers).size !== headers.length) warnings.push('Есть одинаковые заголовки. Выбирайте столбцы по индексу.');
  if (headers.some((header) => !header.trim())) warnings.push('Есть пустые заголовки. Выбирайте столбцы по индексу.');
  if (delimiterOption === 'auto' && headers.length === 1) warnings.push('Разделитель не удалось уверенно определить; проверьте структуру CSV.');
  const result = { headers: [...headers], rows, delimiter, encoding: decoded.encoding, warnings };
  // Не меняет сериализуемый контракт, но сохраняет физические строки для предпросмотра.
  Object.defineProperty(result, 'sourceRows', { value: lines.slice(headerIndex + 1), enumerable: false });
  return result;
}

export function suggestMapping(headers) {
  if (!Array.isArray(headers) || headers.length > MAX_COLS || !headers.every((header) => typeof header === 'string')) fail('Заголовки должны быть массивом строк, не более 128.');
  const mapping = { amountMode: 'signed', defaultCurrency: 'RUB' };
  const confidence = {};
  const warnings = [];
  for (const [key, aliases] of Object.entries(aliasSets)) {
    const matches = headers.map((header, index) => aliases.has(normalize(header)) ? index : -1).filter((index) => index >= 0);
    if (matches.length) {
      mapping[key] = matches[0];
      confidence[key] = matches.length === 1 ? 1 : 0.5;
      if (matches.length > 1) warnings.push(`Поле «${FIELD_LABELS[key]}»: несколько подходящих столбцов, выбран первый. Проверьте сопоставление.`);
    } else confidence[key] = 0;
  }
  if (mapping.debit !== undefined || mapping.credit !== undefined) mapping.amountMode = 'debitCredit';
  else if (mapping.direction !== undefined && mapping.amount !== undefined) mapping.amountMode = 'direction';
  confidence.amountMode = mapping.amountMode === 'signed' ? 0.5 : 1;
  if (mapping.date === undefined) warnings.push('Не найден столбец даты. Укажите его вручную.');
  if (mapping.amount === undefined && mapping.debit === undefined && mapping.credit === undefined) warnings.push('Не найден столбец суммы. Укажите его вручную.');
  if (mapping.amountMode === 'signed') warnings.push('Направление не определено по заголовкам: положительные суммы останутся доходами. Проверьте знаки или явно выберите режим.');
  if (mapping.amountMode === 'direction') warnings.push('Проверьте значения направления: неизвестные значения будут ошибками строк.');
  return { mapping, confidence, warnings };
}

function parseDate(value, label = 'Дата') {
  if (typeof value !== 'string') fail(`${label}: требуется текстовая дата.`);
  const text = value.trim();
  const match = text.match(/^(?:(\d{4})-(\d{2})-(\d{2})|(\d{1,2})([./-])(\d{1,2})\5(\d{4}))(?:(?:T|\s+)(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) fail(`${label}: используйте ГГГГ-ММ-ДД или ДД.ММ.ГГГГ с четырёхзначным годом.`);
  const year = Number(match[1] || match[7]);
  const month = Number(match[2] || match[6]);
  const day = Number(match[3] || match[4]);
  if (match[5] && match[5] !== '.' && day <= 12 && month <= 12 && day !== month) fail(`${label}: неоднозначная дата. Используйте ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.`);
  if (match[8] && (Number(match[8]) > 23 || Number(match[9]) > 59 || Number(match[10] ?? 0) > 59)) fail(`${label}: неверное время.`);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > days[month - 1]) fail(`${label}: несуществующая календарная дата.`);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function rubCurrency(value) {
  const text = String(value ?? '').trim();
  if (!/^(?:RUB|RUR|₽|руб\.?|643)$/iu.test(text)) fail('В MVP поддерживаются только операции в рублях (RUB).');
  return 'RUB';
}
function directionSign(value) {
  const raw = String(value).trim();
  if (raw === '+') return 1;
  if (raw === '-') return -1;
  const text = normalize(raw);
  if (['income', 'credit', 'in', 'incoming', 'приход', 'доход', 'зачисление', 'поступление', 'кредит', 'пополнение', 'приходная', 'входящий'].includes(text)) return 1;
  if (['expense', 'debit', 'out', 'outgoing', 'расход', 'списание', 'дебет', 'оплата', 'расходная', 'исходящий'].includes(text)) return -1;
  fail('Неизвестное направление операции. Укажите приход/расход или income/expense.');
}

export function buildImport(parsed, mapping) {
  if (!parsed || !Array.isArray(parsed.headers) || !Array.isArray(parsed.rows) || parsed.rows.length > MAX_ROWS || parsed.headers.length > MAX_COLS || !parsed.headers.every((header) => typeof header === 'string')) fail('Некорректная таблица импорта.');
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) fail('Требуется сопоставление столбцов.');
  const columns = {};
  for (const key of Object.keys(ALIASES)) {
    const requested = mapping[key];
    if (requested === undefined || requested === null || requested === '') continue;
    if (typeof requested === 'number') columns[key] = integer(requested, `Столбец «${FIELD_LABELS[key]}»`, { min: 0, max: parsed.headers.length - 1 });
    else if (typeof requested === 'string') {
      const matches = parsed.headers.map((header, index) => header === requested ? index : -1).filter((index) => index >= 0);
      if (matches.length !== 1) fail(`Столбец «${requested}» отсутствует или неоднозначен. Используйте индекс.`);
      columns[key] = matches[0];
    } else fail(`Столбец «${FIELD_LABELS[key]}»: требуется индекс или заголовок.`);
  }
  const mode = mapping.amountMode ?? 'signed';
  if (!['signed', 'debitCredit', 'direction', 'allExpenses', 'allIncome'].includes(mode)) fail('Неизвестный режим суммы.');
  if (columns.date === undefined) throw new FinanceMappingError('Не выбран столбец даты.', 'date');
  if (mode === 'debitCredit' ? columns.debit === undefined && columns.credit === undefined : columns.amount === undefined) throw new FinanceMappingError('Не выбраны необходимые столбцы суммы.', mode === 'debitCredit' ? 'debitCredit' : 'amount');
  if (mode === 'direction' && columns.direction === undefined) throw new FinanceMappingError('Не выбран столбец направления.', 'direction');
  if (mode === 'debitCredit' && columns.debit !== undefined && columns.debit === columns.credit) fail('Дебет и кредит должны быть разными столбцами.');
  const defaultCurrency = rubCurrency(mapping.defaultCurrency ?? 'RUB');
  const transactions = [];
  const errors = [];
  const warnings = Array.isArray(parsed.warnings) ? [...parsed.warnings] : [];
  if (['allExpenses', 'allIncome'].includes(mode)) warnings.push(mode === 'allExpenses' ? 'Явно выбран режим: все суммы — расходы.' : 'Явно выбран режим: все суммы — доходы.');
  let creditMinor = 0;
  let debitMinor = 0;
  let from = null;
  let to = null;
  for (let index = 0; index < parsed.rows.length; index++) {
    const sourceRow = parsed.sourceRows?.[index] ?? index + 2;
    try {
      const row = parsed.rows[index];
      if (!Array.isArray(row) || row.length !== parsed.headers.length || !row.every((cell) => typeof cell === 'string')) fail('Неверное число или тип ячеек в строке.');
      const cell = (key) => columns[key] === undefined ? '' : row[columns[key]].trim();
      const date = parseDate(cell('date'));
      const postedDate = cell('postedDate') ? parseDate(cell('postedDate'), 'Дата проводки') : date;
      const currency = cell('currency') ? rubCurrency(cell('currency')) : defaultCurrency;
      let amountMinor;
      if (mode === 'debitCredit') {
        const debit = cell('debit') ? moneyToMinor(cell('debit')) : 0;
        const credit = cell('credit') ? moneyToMinor(cell('credit')) : 0;
        if (!cell('debit') && !cell('credit')) fail('Не заполнены ни дебет, ни кредит.');
        if (debit < 0 || credit < 0 || (debit && credit)) fail('Дебет/кредит: суммы должны быть неотрицательны и заполнена только одна сторона.');
        amountMinor = credit - debit;
      } else {
        amountMinor = moneyToMinor(cell('amount'));
        if (mode === 'direction') {
          const sign = directionSign(cell('direction'));
          if (sign > 0 && amountMinor < 0) fail('Отрицательная сумма противоречит направлению «доход».');
          amountMinor = sign * Math.abs(amountMinor);
        } else if (mode === 'allExpenses') amountMinor = -Math.abs(amountMinor);
        else if (mode === 'allIncome' && amountMinor < 0) fail('Отрицательная сумма противоречит режиму «все доходы».');
      }
      if (Object.is(amountMinor, -0)) amountMinor = 0;
      const nextCredit = safe(BigInt(creditMinor) + BigInt(Math.max(0, amountMinor)), 'Итог доходов');
      const nextDebit = safe(BigInt(debitMinor) + BigInt(Math.max(0, -amountMinor)), 'Итог расходов');
      transactions.push({ id: `row-${sourceRow}`, date, postedDate, amountMinor, currency, description: cell('description'), counterparty: cell('counterparty'), bankId: cell('bankId'), sourceRow, kind: amountMinor < 0 ? 'expense' : 'income', category: 'Без категории', needsReview: true });
      creditMinor = nextCredit;
      debitMinor = nextDebit;
      if (from === null || date < from) from = date;
      if (to === null || date > to) to = date;
    } catch (error) { errors.push({ sourceRow, message: error.message }); }
  }
  return { transactions, errors, warnings, totals: { creditMinor, debitMinor, netMinor: safe(BigInt(creditMinor) - BigInt(debitMinor)) }, period: { from, to } };
}

// Number переводится в рациональную дробь через десятичную запись, без умножения денег в IEEE-754.
function rational(value) {
  const [mantissa, exponentText] = String(value).toLowerCase().split('e');
  const exponent = Number(exponentText ?? 0);
  const [whole, fraction = ''] = mantissa.split('.');
  let numerator = BigInt(whole + fraction);
  const scale = fraction.length - exponent;
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  return [numerator, scale > 0 ? 10n ** BigInt(scale) : 1n];
}
function rounded(numerator, denominator) {
  const sign = numerator < 0n ? -1n : 1n;
  const positive = numerator * sign;
  return sign * ((positive + denominator / 2n) / denominator);
}
function multiplied(amount, ...factors) {
  let numerator = BigInt(amount);
  let denominator = 1n;
  for (const factor of factors) { const [n, d] = rational(factor); numerator *= n; denominator *= d; }
  return safe(rounded(numerator, denominator), 'Расчёт выплаты');
}

/** Каждое начисление и явно заданный плоский налог округляются до копейки, половина вверх. */
export function evaluateIncome(model, scenario = 'base', options = {}) {
  if (!model || typeof model !== 'object') fail('Модель дохода должна быть объектом.');
  if (!['base', 'conservative', 'optimistic'].includes(scenario)) fail('Сценарий должен быть базовым, консервативным или оптимистичным.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('Параметры расчёта дохода должны быть объектом.');
  const month = options.month;
  if (month !== undefined) {
    if (typeof month !== 'string' || !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) fail('Месяц расчёта: требуется ГГГГ-ММ.');
    parseDate(`${month}-01`, 'Месяц расчёта');
  }
  const mode = options.mode === undefined ? (month === undefined ? 'regular' : 'cash') : options.mode;
  if (!['cash', 'regular', 'average'].includes(mode)) fail('Режим дохода должен быть cash, regular или average.');
  if (mode === 'cash' && month === undefined) fail('Для режима cash требуется месяц расчёта ГГГГ-ММ.');
  const salary = integer(model.salaryMinor, 'Оклад', { min: 0 });
  const workedRatio = numeric(model.workedRatio ?? 1, 'Отработанная доля', 0, 1);
  const deductions = integer(model.deductionsMinor ?? 0, 'Удержания', { min: 0 });
  const taxRateBps = model.taxRateBps === undefined ? 0 : integer(model.taxRateBps, 'Ставка налога в базисных пунктах', { min: 0, max: 10_000 });
  if (!Array.isArray(model.components) || model.components.length > 20) fail('Допускается массив не более чем из 20 начислений.');
  if (model.payoutDay !== undefined) integer(model.payoutDay, 'День выплаты', { min: 1, max: 31 });
  const ids = new Set(['base-salary']);
  for (const component of model.components) {
    if (!component || typeof component !== 'object' || typeof component.id !== 'string' || !component.id.trim() || typeof component.label !== 'string' || !component.label.trim()) fail('Начисление должно иметь непустые идентификатор и название.');
    if (ids.has(component.id)) fail('Идентификаторы начислений должны быть уникальны; base-salary зарезервирован для оклада.');
    ids.add(component.id);
    if (!['fixed', 'percent_base', 'percent_running'].includes(component.type)) fail('Неизвестный тип начисления. Формулы не выполняются.');
    for (const key of ['value', 'minValue', 'maxValue']) {
      if (key !== 'value' && component[key] === undefined) continue;
      if (component.type === 'fixed') integer(component[key], key === 'value' ? 'Фиксированное начисление' : `Фиксированное начисление (${key})`, { min: 0 });
      else numeric(component[key], key === 'value' ? 'Процент начисления' : `Процент начисления (${key})`, 0, 10_000);
    }
    if ((component.minValue !== undefined && component.minValue > component.value) || (component.maxValue !== undefined && component.value > component.maxValue)) fail('Диапазон начисления должен удовлетворять minValue <= value <= maxValue.');
    numeric(component.multiplier ?? 1, 'Множитель начисления', 0, 1_000);
    for (const key of ['enabled', 'guaranteed']) if (component[key] !== undefined && typeof component[key] !== 'boolean') fail('Признаки включения и гарантированности должны быть логическими.');
    if (component.frequency !== undefined && !['monthly', 'quarterly'].includes(component.frequency)) fail('Частота начисления должна быть monthly или quarterly.');
    if (component.payoutMonths !== undefined || (component.frequency === 'quarterly' && component.enabled !== false)) {
      if (!Array.isArray(component.payoutMonths) || component.payoutMonths.length !== 4 || new Set(component.payoutMonths).size !== 4) fail('Квартальное начисление требует четыре уникальных месяца выплаты (payoutMonths).');
      for (const payoutMonth of component.payoutMonths) integer(payoutMonth, 'Месяц выплаты', { min: 1, max: 12 });
    }
  }
  const base = multiplied(salary, workedRatio);
  let grossMinor = base;
  let optimisticRange = false;
  const components = [{ id: 'base-salary', label: 'Оклад', amountMinor: base }];
  const warnings = model.taxRateBps === undefined
    ? ['Налоги не рассчитываются автоматически: укажите фактические удержания отдельно.']
    : ['Налог рассчитан по явно заданной плоской ставке; это не расчёт прогрессивного НДФЛ.'];
  if (mode === 'regular' && model.components.some((component) => component.frequency === 'quarterly' && component.enabled !== false)) warnings.push('Квартальные начисления исключены из регулярного ежемесячного дохода; они доступны только в месяцы выплаты.');
  if (mode === 'average') warnings.push('ВНИМАНИЕ: это усреднённый доход, НЕ доступные деньги каждого месяца. Квартальные начисления разделены на 3; фактические деньги доступны только в месяцы выплаты. Не используйте среднее как ежемесячный доступный денежный поток.');
  for (const component of model.components) {
    if (component.enabled === false) continue;
    if (scenario === 'conservative' && component.guaranteed !== true) continue;
    const quarterly = component.frequency === 'quarterly';
    if (quarterly && (mode === 'regular' || (mode === 'cash' && !component.payoutMonths.includes(Number(month.slice(5)))))) continue;
    const value = scenario === 'conservative' ? component.minValue ?? component.value
      : scenario === 'optimistic' ? component.maxValue ?? component.value : component.value;
    if (scenario === 'optimistic' && component.maxValue !== undefined) optimisticRange = true;
    const multiplier = component.multiplier ?? 1;
    const amount = component.type === 'fixed' ? value : component.type === 'percent_base' ? base : grossMinor;
    const factors = component.type === 'fixed' ? [multiplier] : [value, multiplier, 0.01];
    let amountMinor;
    if (quarterly && mode === 'average') {
      // Деление на 3 до единственного округления, без неточной дроби Number(1 / 3).
      let numerator = BigInt(amount);
      let denominator = 3n;
      for (const factor of factors) { const [n, d] = rational(factor); numerator *= n; denominator *= d; }
      amountMinor = safe(rounded(numerator, denominator), 'Расчёт выплаты');
    } else amountMinor = multiplied(amount, ...factors);
    grossMinor = safe(BigInt(grossMinor) + BigInt(amountMinor), 'Начисленный доход');
    components.push({ id: component.id, label: component.label, amountMinor, ...(component.frequency === undefined ? {} : { frequency: component.frequency }) });
  }
  const taxMinor = safe(rounded(BigInt(grossMinor) * BigInt(taxRateBps), 10_000n), 'Налог');
  const postTax = safe(BigInt(grossMinor) - BigInt(taxMinor), 'Доход после налога');
  if (deductions > postTax) fail(model.taxRateBps === undefined ? 'Удержания превышают начисленный доход.' : 'Удержания превышают доход после налога.');
  if (model.payoutDay > 28) warnings.push('В коротких месяцах день выплаты требует отдельного уточнения.');
  if (scenario === 'conservative') warnings.push('Консервативный сценарий включает только явно гарантированные начисления.');
  if (scenario === 'optimistic') warnings.push(optimisticRange ? 'Оптимистичный сценарий использует верхние границы начислений, если они заданы.' : 'Дополнительные допущения оптимистичного сценария не заданы; он совпадает с базовым.');
  return { grossMinor, netMinor: safe(BigInt(postTax) - BigInt(deductions), 'Доход после удержаний'), components, warnings, taxMinor, deductionsMinor: deductions, taxRateBps, mode, ...(month === undefined ? {} : { month }) };
}

function reportDate(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`${label}: требуется дата ГГГГ-ММ-ДД.`);
  return parseDate(value, label);
}
const unknownCategory = (category) => !category || ['без категории', 'неизвестно', 'unknown', 'uncategorized'].includes(normalize(category));
const protectedCategory = (category) => /здоров|медицин|лекарств|лечени|образован|обучени|health|education/iu.test(category);
function displayRub(minor) {
  const value = BigInt(minor);
  const absolute = value < 0n ? -value : value;
  return `${value < 0n ? '−' : ''}${absolute / 100n},${String(absolute % 100n).padStart(2, '0')} ₽`;
}

export function computeReport(transactions, options = {}) {
  if (!Array.isArray(transactions) || transactions.length > 1_000_000) fail('Отчёт принимает не более 1 000 000 операций за один расчёт. Выберите более короткий период.');
  const from = options.from === undefined ? null : reportDate(options.from, 'Начало периода');
  const to = options.to === undefined ? null : reportDate(options.to, 'Конец периода');
  if (from && to && from > to) fail('Начало периода позже конца периода.');
  let income = 0n;
  let expense = 0n;
  let count = 0;
  let unknownCount = 0;
  const categoryMap = new Map();
  const dailyMap = new Map();
  const evidence = [];
  const reviewEvidence = [];
  for (let index = 0; index < transactions.length; index++) {
    const transaction = transactions[index];
    if (!transaction || typeof transaction !== 'object') fail('Некорректная операция отчёта.');
    const date = reportDate(transaction.date, 'Дата операции');
    if ((from && date < from) || (to && date > to)) continue;
    const amount = integer(transaction.amountMinor, 'Сумма операции');
    if (transaction.currency !== undefined) rubCurrency(transaction.currency);
    const kind = transaction.kind ?? (amount < 0 ? 'expense' : 'income');
    if (!['income', 'expense', 'transfer', 'refund', 'loan'].includes(kind)) fail('Неизвестный вид операции отчёта.');
    if (transaction.needsReview !== undefined && typeof transaction.needsReview !== 'boolean') fail('Признак проверки должен быть логическим.');
    if (transaction.category !== undefined && typeof transaction.category !== 'string') fail('Категория должна быть строкой.');
    if (kind === 'income' && amount < 0) fail('Отрицательная сумма противоречит виду «доход».');
    const category = transaction.category?.trim() || (kind === 'loan' ? 'Кредиты' : 'Без категории');
    const id = String(transaction.id ?? `row-${transaction.sourceRow ?? index + 1}`);
    const magnitude = BigInt(amount < 0 ? -amount : amount);
    let rowIncome = 0n;
    let rowExpense = 0n;
    if (kind === 'income') rowIncome = magnitude;
    else if (kind === 'expense' || (kind === 'loan' && amount < 0)) rowExpense = magnitude;
    else if (kind === 'refund') rowExpense = -magnitude;
    income += rowIncome;
    expense += rowExpense;
    count++;
    if (transaction.needsReview === true || ((kind === 'expense' || kind === 'refund' || (kind === 'loan' && amount < 0)) && unknownCategory(category))) {
      unknownCount++;
      if (reviewEvidence.length < 10) reviewEvidence.push(id);
    }
    if (evidence.length < 10) evidence.push(id);
    if (!dailyMap.has(date)) dailyMap.set(date, { date, income: 0n, expense: 0n });
    const day = dailyMap.get(date);
    day.income += rowIncome;
    day.expense += rowExpense;
    if (kind === 'expense' || kind === 'refund' || (kind === 'loan' && amount < 0)) {
      if (!categoryMap.has(category)) categoryMap.set(category, { category, expense: 0n, count: 0, ids: [] });
      const bucket = categoryMap.get(category);
      bucket.expense += rowExpense;
      bucket.count++;
      if (bucket.ids.length < 10) bucket.ids.push(id);
    }
  }
  const incomeMinor = safe(income, 'Доходы отчёта');
  const expenseMinor = safe(expense, 'Расходы отчёта');
  const netMinor = safe(income - expense, 'Итог отчёта');
  const sorted = [...categoryMap.values()].sort((a, b) => a.expense > b.expense ? -1 : a.expense < b.expense ? 1 : a.category < b.category ? -1 : a.category > b.category ? 1 : 0);
  const categories = sorted.map((item) => ({ category: item.category, expenseMinor: safe(item.expense, 'Расходы категории'), count: item.count }));
  const daily = [...dailyMap.values()].sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0).map((item) => ({ date: item.date, incomeMinor: safe(item.income, 'Доходы за день'), expenseMinor: safe(item.expense, 'Расходы за день') }));
  const insights = [];
  if (count) insights.push({ kind: 'summary', text: `Доходы: ${displayRub(incomeMinor)}. Расходы с учётом возвратов: ${displayRub(expenseMinor)}. Переводы и полученные займы не включены в доход.`, evidenceIds: evidence });
  const largest = sorted.find((item) => item.expense > 0n && !unknownCategory(item.category) && !protectedCategory(item.category));
  if (largest) insights.push({ kind: 'category', text: `Расходы в категории «${largest.category}»: ${displayRub(safe(largest.expense))}. Это наблюдение, а не рекомендация сокращать необходимые расходы.`, evidenceIds: largest.ids });
  if (unknownCount) insights.push({ kind: 'review', text: `Операций, требующих проверки: ${unknownCount}. Уточните категории и виды операций перед выводами.`, evidenceIds: reviewEvidence });
  return { incomeMinor, expenseMinor, netMinor, unknownCount, categories, daily, insights, count };
}

function ceilDivision(numerator, denominator) { return (numerator + denominator - 1n) / denominator; }
function deadlineMonths(deadline, asOf) {
  if (typeof deadline === 'number') return integer(deadline, 'Срок цели в месяцах', { min: 1, max: 1200 });
  const end = reportDate(deadline, 'Срок цели');
  if (!asOf) return null;
  const [sy, sm, sd] = asOf.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const leap = ey % 4 === 0 && (ey % 100 !== 0 || ey % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return Math.max(0, (ey - sy) * 12 + em - sm - (ed < Math.min(sd, days[em - 1]) ? 1 : 0));
}

/** reservedMinor — уже зарезервированная часть balanceMinor; path — свободные средства после заданных взносов. */
export function projectSavings(input) {
  if (!input || typeof input !== 'object') fail('Для прогноза требуется объект параметров.');
  const balance = integer(input.balanceMinor, 'Начальный остаток');
  const income = integer(input.incomeMinor, 'Ежемесячный доход', { min: 0 });
  const expense = integer(input.expenseMinor, 'Ежемесячные расходы', { min: 0 });
  const reserved = integer(input.reservedMinor ?? 0, 'Уже зарезервировано', { min: 0 });
  if (reserved > 0 && reserved > balance) fail('Зарезервированные средства превышают текущий остаток.');
  const months = integer(input.months ?? 12, 'Горизонт прогноза', { min: 0, max: 1200 });
  const asOf = input.asOf === undefined ? null : reportDate(input.asOf, 'Базовая дата прогноза');
  if (!Array.isArray(input.goals) || input.goals.length > 100) fail('Допускается не более 100 целей.');
  const warnings = [];
  const ids = new Set();
  const plans = input.goals.map((goal) => {
    if (!goal || typeof goal !== 'object' || typeof goal.id !== 'string' || !goal.id.trim() || ids.has(goal.id)) fail('Цели должны иметь уникальные непустые идентификаторы.');
    ids.add(goal.id);
    const target = integer(goal.targetMinor, 'Сумма цели', { min: 0 });
    const saved = integer(goal.savedMinor, 'Уже накоплено', { min: 0 });
    const monthly = integer(goal.monthlyMinor, 'Взнос в цель', { min: 0 });
    const remaining = Math.max(0, target - saved);
    const term = goal.deadline === undefined || goal.deadline === '' ? undefined : deadlineMonths(goal.deadline, asOf);
    if (term === null && remaining) warnings.push(`Цель «${goal.id}»: для календарного срока нужна базовая дата asOf; достижимость к дате не подтверждена.`);
    return { id: goal.id, remaining, monthly, term };
  });
  const monthlyFreeMinor = safe(BigInt(income) - BigInt(expense), 'Свободная сумма в месяц');
  const allocations = total(plans.filter((goal) => goal.remaining > 0).map((goal) => Math.min(goal.remaining, goal.monthly)), 'Взносы в цели');
  const overallocated = allocations > Math.max(0, monthlyFreeMinor) || monthlyFreeMinor < 0;
  const goals = plans.map((goal) => {
    const monthsToGoal = !goal.remaining ? 0 : !goal.monthly ? null : safe(ceilDivision(BigInt(goal.remaining), BigInt(goal.monthly)), 'Срок достижения');
    const result = { id: goal.id, remainingMinor: goal.remaining, monthsToGoal, feasible: !goal.remaining || (monthsToGoal !== null && !overallocated && goal.term !== null && (goal.term === undefined || monthsToGoal <= goal.term)) };
    if (goal.term > 0) result.monthlyNeededMinor = safe(ceilDivision(BigInt(goal.remaining), BigInt(goal.term)), 'Необходимый взнос');
    return result;
  });
  const remaining = plans.map((goal) => BigInt(goal.remaining));
  let cash = BigInt(balance) - BigInt(reserved);
  const path = [{ month: 0, balanceMinor: safe(cash, 'Свободный начальный остаток') }];
  for (let month = 1; month <= months; month++) {
    let contribution = 0n;
    for (let index = 0; index < plans.length; index++) {
      const monthly = BigInt(plans[index].monthly);
      const paid = remaining[index] < monthly ? remaining[index] : monthly;
      contribution += paid;
      remaining[index] -= paid;
    }
    cash += BigInt(monthlyFreeMinor) - contribution;
    path.push({ month, balanceMinor: safe(cash, 'Остаток прогноза') });
  }
  if (overallocated) warnings.push('Заданные взносы превышают свободный денежный поток. Распределение не изменено автоматически.');
  return { goals, monthlyFreeMinor, overallocated, path, warnings };
}
