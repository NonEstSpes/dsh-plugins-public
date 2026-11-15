import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { FinanceValidationError, moneyToMinor, parseCsvFile, buildImport, suggestMapping, evaluateIncome, computeReport, projectSavings } from '../lib/finance-core.js';

const bytes = (text) => new TextEncoder().encode(text);
const utf16 = (text, bom = true) => {
  const result = new Uint8Array(text.length * 2 + (bom ? 2 : 0));
  if (bom) result.set([0xff, 0xfe]);
  for (let index = 0; index < text.length; index++) {
    const value = text.charCodeAt(index);
    result[(bom ? 2 : 0) + index * 2] = value & 255;
    result[(bom ? 2 : 0) + index * 2 + 1] = value >> 8;
  }
  return result;
};
const win1251 = (text) => Uint8Array.from([...text].map((char) => {
  const code = char.charCodeAt(0);
  if (code < 128) return code;
  if (char === 'Ё') return 0xa8;
  if (char === 'ё') return 0xb8;
  if (code >= 0x410 && code <= 0x44f) return code - 0x410 + 0xc0;
  throw new Error('Неподдерживаемый символ тестовой фикстуры.');
}));
const csv = 'Дата операции;Сумма операции;Описание операции\n01.02.2024;-10,05;Оплата';
const importRows = (rows, mapping = {}) => buildImport({ headers: ['Дата', 'Сумма', 'Описание'], rows, warnings: [] }, { date: 0, amount: 1, description: 2, ...mapping });
const model = (overrides = {}) => ({ salaryMinor: 10_000_000, components: [], ...overrides });
const transaction = (id, amountMinor, kind, category = 'Покупки', date = '2024-02-01', needsReview = false) => ({ id, date, amountMinor, currency: 'RUB', kind, category, needsReview });
const savings = (overrides = {}) => ({ balanceMinor: 10_000, incomeMinor: 20_000, expenseMinor: 10_000, goals: [], months: 3, ...overrides });
const goal = (overrides = {}) => ({ id: 'цель', targetMinor: 30_000, savedMinor: 0, monthlyMinor: 5_000, ...overrides });

// Тесты не читают и не записывают файлы; все фикстуры находятся в памяти.
describe('Строгий разбор рублей в копейки', () => {
  test('Ошибки валидации имеют стабильный класс для HTTP 400', () => {
    assert.throws(() => moneyToMinor('формула'), (error) => error instanceof FinanceValidationError && error.name === 'FinanceValidationError');
    assert.throws(() => parseCsvFile(''), FinanceValidationError);
    assert.throws(() => evaluateIncome(model({ salaryMinor: -1 })), FinanceValidationError);
    assert.throws(() => projectSavings(savings({ months: -1 })), FinanceValidationError);
  });
  test('Пробелы, NBSP, узкий NBSP, валюты и знаки', () => {
    const values = [
      ['1 234,56 ₽', 123456], ['1\u00a0234,50 RUB', 123450], ['1\u202f234.5', 123450],
      ['RUB +12.3', 1230], ['-1 234.50 RUB', -123450], ['(1 234,50 ₽)', -123450],
      ['₽ (12)', -1200], ['(RUB 0,01)', -1], ['+0,01', 1], ['руб. 10', 1000],
      [0, 0], [-0, 0], [10.1, 1010], [-0.01, -1], ['00012,30', 1230],
    ];
    for (const [value, expected] of values) assert.equal(moneyToMinor(value), expected, String(value));
    assert.equal(Object.is(moneyToMinor('(0,00)'), -0), false);
  });
  test('Граница safe integer вычисляется без плавающей точки', () => {
    assert.equal(moneyToMinor('90071992547409.91'), Number.MAX_SAFE_INTEGER);
    assert.equal(moneyToMinor('-90071992547409,91'), -Number.MAX_SAFE_INTEGER);
    assert.throws(() => moneyToMinor('90071992547409.92'), /переполнение/);
    assert.throws(() => moneyToMinor('-90071992547409.92'), /переполнение/);
  });
  test('Неоднозначные, дробные и опасные форматы отклоняются', () => {
    for (const value of ['', ' ', '1.234', '1,234', '1,234.56', '1.234,56', '1 23', '1234 567', '.5', '1.', '1,', '1e3', 'NaN', '++1', '-(1)', '(-1)', 'RUB 1 ₽', '12 USD', '1,2 3', '1\n2', '(1', '1)', '1+1', '=100*2', null, undefined, {}, [], Infinity, NaN, 0.001]) {
      assert.throws(() => moneyToMinor(value), undefined, String(value));
    }
  });
});

describe('Безопасный CSV без внешних библиотек', () => {
  test('Автоматически определяет точку с запятой, сохраняет заголовки и копейки', () => {
    const parsed = parseCsvFile(csv);
    assert.equal(parsed.delimiter, ';');
    assert.equal(parsed.encoding, 'utf-8');
    assert.deepEqual(parsed.headers, ['Дата операции', 'Сумма операции', 'Описание операции']);
    assert.deepEqual(parsed.rows, [['01.02.2024', '-10,05', 'Оплата']]);
    assert.deepEqual(Object.keys(parsed), ['headers', 'rows', 'delimiter', 'encoding', 'warnings']);
  });
  test('Кавычки, экранирование, разделители внутри поля и переносы строк', () => {
    const parsed = parseCsvFile('Дата;Сумма;Описание\r\n01.02.2024;"1,01";"Текст; с ""кавычками""\r\nи переносом"\r\n02.02.2024;2;Следующая\r\n');
    assert.equal(parsed.rows[0][2], 'Текст; с "кавычками"\r\nи переносом');
    assert.deepEqual(parsed.sourceRows, [2, 4]);
    assert.equal(buildImport(parsed, { date: 0, amount: 1 }).transactions[1].sourceRow, 4);
  });
  test('Запятая и табуляция определяются автоматически', () => {
    const comma = parseCsvFile('date,amount,description\n2024-02-01,"12,34","a,b"');
    assert.equal(comma.delimiter, ',');
    assert.equal(comma.rows[0][1], '12,34');
    const tab = parseCsvFile('Дата\tСумма\n01.02.2024\t-1,23');
    assert.equal(tab.delimiter, '\t');
    assert.equal(tab.rows[0][1], '-1,23');
  });
  test('UTF-8 с BOM и без, строка и срез массива байтов', () => {
    for (const input of [csv, '\uFEFF' + csv, bytes(csv), bytes('\uFEFF' + csv), bytes('x' + csv + 'y').subarray(1, bytes('x' + csv).length)]) {
      const parsed = parseCsvFile(input);
      assert.equal(parsed.headers[0], 'Дата операции');
      assert.equal(parsed.rows[0][2], 'Оплата');
    }
    assert.equal(parseCsvFile(bytes(csv).buffer).encoding, 'utf-8');
  });
  test('UTF-16LE с BOM, явная и автоматическая без BOM', () => {
    for (const input of [utf16(csv), utf16(csv, false)]) {
      const parsed = parseCsvFile(input);
      assert.equal(parsed.encoding, 'utf-16le');
      assert.equal(parsed.rows[0][2], 'Оплата');
    }
    assert.equal(parseCsvFile(utf16(csv, false), { encoding: 'utf16le' }).headers[0], 'Дата операции');
  });
  test('Windows-1251: явный выбор и fallback после проверки UTF-8', () => {
    const fixture = win1251(csv + ' ёЁ');
    for (const encoding of ['auto', 'windows-1251', 'cp1251']) {
      const parsed = parseCsvFile(fixture, { encoding });
      assert.equal(parsed.encoding, 'windows-1251');
      assert.equal(parsed.rows[0][2], 'Оплата ёЁ');
    }
    assert.ok(parseCsvFile(fixture).warnings.length);
  });
  test('Повреждённые кодировки и неизвестные параметры не принимаются', () => {
    assert.throws(() => parseCsvFile(new Uint8Array([255]), { encoding: 'utf8' }), /кодировке/);
    assert.throws(() => parseCsvFile(new Uint8Array([255, 254, 10])), /нечётное/);
    assert.throws(() => parseCsvFile(new Uint8Array([254, 255, 0, 65])), /UTF-16BE/);
    assert.throws(() => parseCsvFile(csv, { encoding: 'base64' }), /кодировка/);
    assert.throws(() => parseCsvFile(csv, { delimiter: '|' }), /Разделитель/);
    assert.throws(() => parseCsvFile(csv, { headerRow: -1 }), /Строка заголовка/);
    assert.throws(() => parseCsvFile(csv, null), /Параметры/);
  });
  test('Служебные строки до заголовка и ограничение поиска в 30 строк', () => {
    const parsed = parseCsvFile('Выписка по счёту\nПериод: февраль\n' + csv);
    assert.equal(parsed.headers[0], 'Дата операции');
    assert.equal(parsed.sourceRows[0], 4);
    assert.match(parsed.warnings.join(' '), /служебных строк.*2/);
    const last = parseCsvFile(Array(29).fill('Служебная строка').join('\n') + '\n' + csv, { headerRow: 'auto' });
    assert.equal(last.sourceRows[0], 31);
    const later = Array(30).fill('Служебная строка').join('\n') + '\n' + csv;
    assert.throws(() => parseCsvFile(later), /число столбцов/);
    assert.equal(parseCsvFile(later, { headerRow: 30 }).sourceRows[0], 32);
    assert.throws(() => parseCsvFile('Преамбула\n' + csv, { headerRow: 0 }), /число столбцов/);
  });
  test('Дубликаты и пробелы заголовков не переименовываются', () => {
    const parsed = parseCsvFile(' Дата ;Сумма;Сумма;\n01.02.2024;1;2;');
    assert.deepEqual(parsed.headers, [' Дата ', 'Сумма', 'Сумма', '']);
    assert.ok(parsed.warnings.some((warning) => warning.includes('одинаковые')));
    assert.ok(parsed.warnings.some((warning) => warning.includes('пустые')));
  });
  test('Последние пустые строки разрешены; внутренние строки не исчезают', () => {
    const parsed = parseCsvFile(csv + '\n; ;\n\n');
    assert.equal(parsed.rows.length, 1);
    const internal = parseCsvFile('Дата;Сумма\n01.02.2024;1\n;\n02.02.2024;2');
    assert.equal(internal.rows.length, 3);
    const result = buildImport(internal, { date: 0, amount: 1 });
    assert.equal(result.transactions.length, 2);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].sourceRow, 3);
  });
  test('Незакрытые и неверно расположенные кавычки, ширина строк', () => {
    for (const input of ['Дата;Сумма\n1;"2', 'Дата;Сумма\n1;а"б', 'Дата;Сумма\n1;"2"х', 'Дата;Сумма\n1;2;3', 'Дата;Сумма\n1']) {
      assert.throws(() => parseCsvFile(input), undefined, input);
    }
    assert.throws(() => parseCsvFile(' \n'), /пуст/);
  });
  test('Ограничения: 128 столбцов, 20000 строк с заголовком, 16 МиБ', () => {
    assert.equal(parseCsvFile(Array(128).fill('Столбец').join(';'), { headerRow: 0 }).headers.length, 128);
    assert.throws(() => parseCsvFile(Array(129).fill('Столбец').join(';'), { headerRow: 0 }), /128 столбцов/);
    const allowed = 'Дата;Сумма\n' + Array(19_999).fill('01.02.2024;1').join('\n');
    assert.equal(parseCsvFile(allowed).rows.length, 19_999);
    assert.throws(() => parseCsvFile(allowed + '\n01.02.2024;1'), /20000 строк/);
    assert.throws(() => parseCsvFile('x'.repeat(16 * 1024 * 1024 + 1)), /16 МиБ/);
  });
});

describe('Сопоставление и импорт без скрытых изменений', () => {
  test('Русские банковские названия сопоставляются без обещания конкретного шаблона', () => {
    const headers = ['Дата операции', 'Дата проводки', 'Сумма операции', 'Описание операции', 'Получатель/Плательщик', 'Номер операции', 'Валюта операции'];
    const suggestion = suggestMapping(headers);
    assert.equal(suggestion.mapping.date, 0);
    assert.equal(suggestion.mapping.postedDate, 1);
    assert.equal(suggestion.mapping.counterparty, 4);
    assert.equal(suggestion.mapping.bankId, 5);
    assert.equal(suggestion.mapping.currency, 6);
    assert.equal(suggestion.mapping.amountMode, 'signed');
    assert.equal(suggestion.confidence.date, 1);
    assert.ok(suggestion.warnings.some((warning) => warning.includes('положительные')));
  });
  test('Подсказки не скрывают неоднозначность и пропущенные обязательные поля', () => {
    const duplicate = suggestMapping(['Дата', 'Дата операции', 'Сумма']);
    assert.equal(duplicate.confidence.date, 0.5);
    assert.ok(duplicate.warnings.length);
    const unknown = suggestMapping(['Ничего']);
    assert.equal(unknown.confidence.date, 0);
    assert.ok(unknown.warnings.some((warning) => warning.includes('даты')));
    assert.equal(suggestMapping(['Дата', 'Дебет', 'Кредит']).mapping.amountMode, 'debitCredit');
    assert.equal(suggestMapping(['Дата', 'Сумма', 'Направление']).mapping.amountMode, 'direction');
  });
  test('Signed: положительная покупка остаётся доходом, копейки сохраняются', () => {
    const result = importRows([['01.02.2024', '1,01', 'Покупка'], ['02.02.2024', '-0,02', 'Расход']]);
    assert.equal(result.transactions[0].amountMinor, 101);
    assert.equal(result.transactions[0].kind, 'income');
    assert.deepEqual(result.totals, { creditMinor: 101, debitMinor: 2, netMinor: 99 });
    assert.deepEqual(result.period, { from: '2024-02-01', to: '2024-02-02' });
    assert.equal(result.transactions[0].postedDate, '2024-02-01');
    assert.equal(result.transactions[0].currency, 'RUB');
  });
  test('Одинаковые настоящие операции и одинаковые bankId не удаляются', () => {
    const parsed = parseCsvFile('Дата;Сумма;Номер операции\n01.02.2024;-1,23;A-1\n01.02.2024;-1,23;A-1');
    const result = buildImport(parsed, { date: 0, amount: 1, bankId: 2 });
    assert.equal(result.transactions.length, 2);
    assert.equal(result.transactions[0].bankId, 'A-1');
    assert.equal(result.transactions[1].bankId, 'A-1');
    assert.equal(result.totals.debitMinor, 246);
    assert.deepEqual(result.transactions.map((row) => row.sourceRow), [2, 3]);
  });
  test('Уникальность заголовков проверяется; индекс сохраняет точное положение', () => {
    const parsed = parseCsvFile('Дата;Сумма;Сумма\n01.02.2024;1;2');
    assert.throws(() => buildImport(parsed, { date: 'Дата', amount: 'Сумма' }), /неоднозначен/);
    assert.equal(buildImport(parsed, { date: 'Дата', amount: 2 }).totals.creditMinor, 200);
    assert.throws(() => buildImport(parsed, { date: 0, amount: 'Нет' }), /отсутствует/);
    assert.throws(() => buildImport(parsed, { date: 0, amount: 3 }), /Столбец/);
  });
  test('Режим дебет/кредит, пустая сторона и конфликты', () => {
    const parsed = parseCsvFile('Дата;Дебет;Кредит\n01.02.2024;10,02;\n02.02.2024;;20,03\n03.02.2024;1;2\n04.02.2024;-1;\n05.02.2024;;');
    const result = buildImport(parsed, { date: 0, debit: 1, credit: 2, amountMode: 'debitCredit' });
    assert.deepEqual(result.transactions.map((row) => row.amountMinor), [-1002, 2003]);
    assert.equal(result.errors.length, 3);
    assert.equal(result.totals.netMinor, 1001);
    assert.throws(() => buildImport(parsed, { date: 0, debit: 1, credit: 1, amountMode: 'debitCredit' }), /разными/);
  });
  test('Направления RU/EN, конфликт знака и неизвестное значение дают явные ошибки', () => {
    const values = [['Приход', '1', 100], ['income', '1', 100], ['credit', '1', 100], ['+', '1', 100], ['Расход', '1', -100], ['debit', '-1', -100], ['outgoing', '1', -100], ['-', '1', -100]];
    const parsed = { headers: ['Дата', 'Сумма', 'Направление'], rows: values.map(([direction, amount]) => ['01.02.2024', amount, direction]) };
    const result = buildImport(parsed, { date: 0, amount: 1, direction: 2, amountMode: 'direction' });
    assert.deepEqual(result.transactions.map((row) => row.amountMinor), values.map((value) => value[2]));
    const invalid = buildImport({ ...parsed, rows: [['01.02.2024', '-1', 'income'], ['01.02.2024', '1', 'перевод']] }, { date: 0, amount: 1, direction: 2, amountMode: 'direction' });
    assert.equal(invalid.errors.length, 2);
    assert.throws(() => buildImport(parsed, { date: 0, amount: 1, amountMode: 'direction' }), /направления/);
  });
  test('Явный allExpenses разрешён, allIncome не переворачивает отрицательные суммы', () => {
    const expenses = importRows([['01.02.2024', '1', ''], ['01.02.2024', '-2', '']], { amountMode: 'allExpenses' });
    assert.deepEqual(expenses.transactions.map((row) => row.amountMinor), [-100, -200]);
    assert.ok(expenses.warnings.length);
    const income = importRows([['01.02.2024', '-1', ''], ['01.02.2024', '2', '']], { amountMode: 'allIncome' });
    assert.equal(income.errors.length, 1);
    assert.equal(income.transactions[0].amountMinor, 200);
  });
  test('Даты RU, ISO, високосные и будущие даты, дата проводки', () => {
    const result = importRows([['29.02.2024', '1', ''], ['2099-01-01', '1', ''], ['13/02/2024', '1', ''], ['01.02.2024 23:59:59', '1', '']]);
    assert.equal(result.errors.length, 0);
    assert.deepEqual(result.transactions.map((row) => row.date), ['2024-02-29', '2099-01-01', '2024-02-13', '2024-02-01']);
    const posted = buildImport({ headers: ['Дата', 'Дата проводки', 'Сумма'], rows: [['01.02.2024', '2024-02-03', '1']] }, { date: 0, postedDate: 1, amount: 2 });
    assert.equal(posted.transactions[0].postedDate, '2024-02-03');
  });
  test('Неоднозначные/несуществующие даты и двухзначные годы не пропускаются молча', () => {
    const dates = ['03/04/2024', '03-04-2024', '29.02.2023', '31.04.2024', '00.01.2024', '01.13.2024', '01.01.24', '', '2024-02-01T24:00', '0000-01-01'];
    const result = importRows(dates.map((date) => [date, '1', '']));
    assert.equal(result.transactions.length, 0);
    assert.equal(result.errors.length, dates.length);
    assert.deepEqual(result.errors.map((error) => error.sourceRow), dates.map((_, index) => index + 2));
    assert.deepEqual(result.period, { from: null, to: null });
  });
  test('Не-RUB — ошибка строки, пробелы и обозначения RUB нормализуются', () => {
    const parsed = { headers: ['Дата', 'Сумма', 'Валюта'], rows: ['USD', 'EUR', 'RUB', '₽', '643', ''].map((currency) => ['01.02.2024', '1', currency]) };
    const result = buildImport(parsed, { date: 0, amount: 1, currency: 2 });
    assert.equal(result.errors.length, 2);
    assert.equal(result.transactions.length, 4);
    assert.ok(result.transactions.every((row) => row.currency === 'RUB'));
    assert.throws(() => buildImport(parsed, { date: 0, amount: 1, defaultCurrency: 'USD' }), /рублях/);
  });
  test('Неверные суммы, ширина строк и переполнение итогов имеют sourceRow', () => {
    const result = importRows([['01.02.2024', '90071992547409.91', ''], ['02.02.2024', '0,01', ''], ['03.02.2024', '0,001', ''], ['04.02.2024', '1']]);
    assert.equal(result.transactions.length, 1);
    assert.equal(result.errors.length, 3);
    assert.deepEqual(result.errors.map((row) => row.sourceRow), [3, 4, 5]);
    assert.match(result.errors[0].message, /переполнение/);
    assert.throws(() => importRows([], { amountMode: 'формула' }), /режим/);
    assert.throws(() => buildImport({ headers: ['Дата'], rows: [] }, { date: 0 }), /суммы/);
  });
  test('Входные массивы и сопоставления не мутируют', () => {
    const parsed = parseCsvFile(csv);
    const mapping = { date: 0, amount: 1 };
    const before = JSON.stringify({ parsed, mapping });
    buildImport(parsed, mapping);
    assert.equal(JSON.stringify({ parsed, mapping }), before);
  });
});

describe('Доход, рациональные проценты и сценарии', () => {
  test('Зависимые премии: 10000000 + 20% + 10% = 13200000 копеек', () => {
    const result = evaluateIncome(model({ components: [
      { id: 'премия', label: 'Премия', type: 'percent_base', value: 20 },
      { id: 'надбавка', label: 'Надбавка', type: 'percent_running', value: 10 },
    ] }));
    assert.equal(result.grossMinor, 13_200_000);
    assert.equal(result.netMinor, 13_200_000);
    assert.deepEqual(result.components.map((item) => item.amountMinor), [10_000_000, 2_000_000, 1_200_000]);
  });
  test('Доли, множители и округление каждой выплаты до копейки', () => {
    const result = evaluateIncome(model({ salaryMinor: 5, workedRatio: 1, components: [
      { id: 'процент', label: 'Процент', type: 'percent_base', value: 10 },
      { id: 'фикс', label: 'Фиксированная', type: 'fixed', value: 2, multiplier: 0.25 },
    ] }));
    assert.equal(result.grossMinor, 7);
    assert.deepEqual(result.components.map((component) => component.amountMinor), [5, 1, 1]);
    assert.equal(evaluateIncome(model({ salaryMinor: 10_000, workedRatio: 1 / 3 })).grossMinor, 3333);
    assert.equal(evaluateIncome(model({ salaryMinor: 1_000_000, components: [{ id: 'малая', label: 'Малая', type: 'percent_base', value: 0.01 }] })).grossMinor, 1_000_100);
  });
  test('Фиксированное начисление не считается процентом и не меняется скрыто при неполном месяце', () => {
    const result = evaluateIncome(model({ workedRatio: 0.5, components: [{ id: 'фикс', label: 'Доплата', type: 'fixed', value: 100_001, multiplier: 2 }] }));
    assert.equal(result.grossMinor, 5_200_002);
    assert.equal(evaluateIncome(model({ workedRatio: 0 })).grossMinor, 0);
  });
  test('Консервативный исключает негарантированные; disabled исключается в обоих', () => {
    const input = model({ components: [
      { id: 'да', label: 'Гарантированная', type: 'fixed', value: 100, guaranteed: true },
      { id: 'нет', label: 'Не гарантированная', type: 'fixed', value: 200, guaranteed: false },
      { id: 'неизв', label: 'Не указано', type: 'fixed', value: 300 },
      { id: 'выкл', label: 'Отключённая', type: 'fixed', value: 400, enabled: false, guaranteed: true },
    ] });
    assert.equal(evaluateIncome(input).grossMinor, 10_000_600);
    assert.equal(evaluateIncome(input, 'conservative').grossMinor, 10_000_100);
  });
  test('Оптимистичный сценарий явно совпадает с базовым без выдуманных допущений', () => {
    const input = model({ components: [{ id: 'бонус', label: 'Бонус', type: 'percent_base', value: 20 }] });
    const base = evaluateIncome(input);
    const optimistic = evaluateIncome(input, 'optimistic');
    assert.equal(optimistic.grossMinor, base.grossMinor);
    assert.equal(optimistic.netMinor, base.netMinor);
    assert.deepEqual(optimistic.components, base.components);
    assert.ok(optimistic.warnings.includes('Дополнительные допущения оптимистичного сценария не заданы; он совпадает с базовым.'));
  });
  test('Нет автоматических 13%: только явно заданные удержания', () => {
    const result = evaluateIncome(model({ salaryMinor: 100_000, deductionsMinor: 5_001, payoutDay: 31 }));
    assert.equal(result.grossMinor, 100_000);
    assert.equal(result.netMinor, 94_999);
    assert.ok(result.warnings.some((warning) => warning.includes('Налоги не рассчитываются')));
    assert.ok(result.warnings.some((warning) => warning.includes('коротких месяцах')));
    assert.throws(() => evaluateIncome(model({ deductionsMinor: 20_000_000 })), /превышают/);
  });
  test('Формулы, бесконечности, отрицательные значения и неизвестные типы отклоняются', () => {
    const valid = { id: 'премия', label: 'Премия', type: 'percent_base', value: 20 };
    for (const patch of [{ value: '20' }, { value: '=salary*0.2' }, { value: NaN }, { value: Infinity }, { value: -1 }, { value: 10_001 }, { type: 'formula' }, { multiplier: Infinity }, { multiplier: -1 }, { multiplier: 1001 }, { enabled: 'да' }, { guaranteed: 1 }, { id: '' }, { label: '' }]) {
      assert.throws(() => evaluateIncome(model({ components: [{ ...valid, ...patch }] })), undefined, JSON.stringify(patch));
    }
    assert.throws(() => evaluateIncome(model({ components: [{ ...valid, type: 'fixed', value: 1.5 }] })), /целое/);
    assert.throws(() => evaluateIncome(model({ workedRatio: 1.01 })), /доля/);
    assert.throws(() => evaluateIncome(model({ payoutDay: 0 })), /День/);
    assert.throws(() => evaluateIncome(model(), 'unknown'), /Сценарий/);
  });
  test('Лимит 20, уникальные ID, safe integer и неизменность модели', () => {
    const components = Array.from({ length: 20 }, (_, index) => ({ id: String(index), label: 'Доплата', type: 'fixed', value: 1 }));
    const input = model({ components });
    const before = JSON.stringify(input);
    assert.equal(evaluateIncome(input).grossMinor, 10_000_020);
    assert.equal(JSON.stringify(input), before);
    assert.throws(() => evaluateIncome(model({ components: [...components, { id: '21', label: 'Доплата', type: 'fixed', value: 1 }] })), /20 начислений/);
    assert.throws(() => evaluateIncome(model({ components: [components[0], components[0]] })), /уникальны/);
    assert.throws(() => evaluateIncome(model({ salaryMinor: Number.MAX_SAFE_INTEGER, components: [components[0]] })), /переполнение/);
  });
});

describe('Отчёт: возвраты, переводы и доказательные наблюдения', () => {
  test('Общая история больше лимита одного CSV поддерживается, предел расчёта — миллион', () => {
    const input = Array.from({ length: 20_001 }, (_, index) => transaction(String(index), -1, 'expense'));
    const result = computeReport(input, { from: '2024-02-01', to: '2024-02-29' });
    assert.equal(result.count, 20_001);
    assert.equal(result.expenseMinor, 20_001);
    assert.equal(result.netMinor, -20_001);
    assert.equal(result.categories[0].count, 20_001);
    assert.deepEqual(result.daily, [{ date: '2024-02-01', incomeMinor: 0, expenseMinor: 20_001 }]);
    assert.throws(() => computeReport(new Array(1_000_001)), (error) => error instanceof FinanceValidationError && /1 000 000/.test(error.message));
  });
  test('Переводы и полученные займы не доход; возврат уменьшает расходы', () => {
    const input = [
      transaction('зарплата', 100_000, 'income'),
      transaction('покупка', -20_000, 'expense'),
      transaction('возврат', 5_000, 'refund'),
      transaction('перевод-вход', 50_000, 'transfer'),
      transaction('перевод-выход', -50_000, 'transfer'),
      transaction('заем', 30_000, 'loan'),
      transaction('погашение', -3_000, 'loan', 'Кредиты'),
    ];
    const result = computeReport(input, { from: '2024-02-01', to: '2024-02-29' });
    assert.equal(result.incomeMinor, 100_000);
    assert.equal(result.expenseMinor, 18_000);
    assert.equal(result.netMinor, 82_000);
    assert.equal(result.count, 7);
    assert.equal(result.unknownCount, 0);
    assert.deepEqual(result.categories, [{ category: 'Покупки', expenseMinor: 15_000, count: 2 }, { category: 'Кредиты', expenseMinor: 3000, count: 1 }]);
    assert.deepEqual(result.daily, [{ date: '2024-02-01', incomeMinor: 100_000, expenseMinor: 18_000 }]);
  });
  test('Возврат без покупки остаётся отрицательным расходом, а не доходом', () => {
    const result = computeReport([transaction('возврат', 101, 'refund')]);
    assert.equal(result.incomeMinor, 0);
    assert.equal(result.expenseMinor, -101);
    assert.equal(result.netMinor, 101);
    assert.equal(result.categories[0].count, 1);
  });
  test('Границы периода включительны, дни сортируются, операции вне периода не считаются', () => {
    const result = computeReport([
      transaction('после', 900, 'income', '', '2024-03-01'),
      transaction('конец', 300, 'income', '', '2024-02-29'),
      transaction('начало', -100, 'expense', 'Покупки', '2024-02-01'),
      transaction('до', -900, 'expense', '', '2024-01-31'),
    ], { from: '2024-02-01', to: '2024-02-29' });
    assert.equal(result.count, 2);
    assert.deepEqual(result.daily.map((day) => day.date), ['2024-02-01', '2024-02-29']);
    assert.equal(result.netMinor, 200);
  });
  test('Неизвестные категории и needsReview считаются один раз и имеют правильные evidenceIds', () => {
    const input = [transaction('известная', -1, 'expense'), transaction('неизвестная', -2, 'expense', 'Без категории'), transaction('проверить', 3, 'income', '', '2024-02-01', true)];
    const result = computeReport(input);
    assert.equal(result.unknownCount, 2);
    assert.deepEqual(result.insights.find((insight) => insight.kind === 'review').evidenceIds, ['неизвестная', 'проверить']);
    const ids = new Set(input.map((item) => item.id));
    assert.ok(result.insights.every((insight) => insight.evidenceIds.every((id) => ids.has(id))));
  });
  test('Здоровье и образование не становятся мишенями экономии', () => {
    const result = computeReport([
      transaction('врач', -100_000, 'expense', 'Здоровье'),
      transaction('учеба', -90_000, 'expense', 'Образование'),
      transaction('кафе', -1000, 'expense', 'Кафе'),
    ]);
    assert.equal(result.categories[0].category, 'Здоровье');
    const categoryInsight = result.insights.find((insight) => insight.kind === 'category');
    assert.deepEqual(categoryInsight.evidenceIds, ['кафе']);
    assert.ok(result.insights.every((insight) => !/сократите|откажитесь|лишние|ненужные|стыд/i.test(insight.text)));
    const protectedOnly = computeReport([transaction('врач', -100, 'expense', 'Медицина')]);
    assert.equal(protectedOnly.insights.filter((insight) => insight.kind === 'category').length, 0);
  });
  test('Пустой отчёт, ошибочные данные, переполнение и отсутствие мутаций', () => {
    assert.deepEqual(computeReport([]), { incomeMinor: 0, expenseMinor: 0, netMinor: 0, unknownCount: 0, categories: [], daily: [], insights: [], count: 0 });
    const input = [transaction('1', -101, 'expense')];
    const before = JSON.stringify(input);
    computeReport(input);
    assert.equal(JSON.stringify(input), before);
    assert.throws(() => computeReport(input, { from: '2024-03-01', to: '2024-02-01' }), /Начало/);
    assert.throws(() => computeReport([{ ...input[0], date: '01.02.2024' }]), /ГГГГ/);
    assert.throws(() => computeReport([{ ...input[0], amountMinor: 1.1 }]), /целое/);
    assert.throws(() => computeReport([{ ...input[0], kind: 'неизвестно' }]), /вид/);
    assert.throws(() => computeReport([transaction('1', -1, 'income')]), /противоречит/);
    assert.throws(() => computeReport([transaction('1', Number.MAX_SAFE_INTEGER, 'income'), transaction('2', 1, 'income')]), /переполнение/);
  });
});

describe('Детерминированные цели накопления без выдуманного дохода', () => {
  test('Резерв вычитается из начального остатка один раз, взносы уменьшают путь', () => {
    const result = projectSavings(savings({ reservedMinor: 3000, goals: [goal({ targetMinor: 10_000, savedMinor: 3000, monthlyMinor: 5000 })] }));
    assert.equal(result.monthlyFreeMinor, 10_000);
    assert.equal(result.overallocated, false);
    assert.deepEqual(result.path, [
      { month: 0, balanceMinor: 7000 }, { month: 1, balanceMinor: 12_000 },
      { month: 2, balanceMinor: 20_000 }, { month: 3, balanceMinor: 30_000 },
    ]);
    assert.deepEqual(result.goals[0], { id: 'цель', remainingMinor: 7000, monthsToGoal: 2, feasible: true });
  });
  test('Без прогресса цель недостижима: null, не Infinity и не ложный срок', () => {
    const result = projectSavings(savings({ incomeMinor: 0, expenseMinor: 0, goals: [goal({ monthlyMinor: 0 })] }));
    assert.equal(result.goals[0].monthsToGoal, null);
    assert.equal(result.goals[0].feasible, false);
    assert.deepEqual(result.path.map((point) => point.balanceMinor), [10_000, 10_000, 10_000, 10_000]);
  });
  test('Заполненные цели не получают новые взносы', () => {
    const result = projectSavings(savings({ goals: [goal({ savedMinor: 30_001, monthlyMinor: 50_000 })] }));
    assert.equal(result.goals[0].remainingMinor, 0);
    assert.equal(result.goals[0].monthsToGoal, 0);
    assert.equal(result.goals[0].feasible, true);
    assert.equal(result.overallocated, false);
    assert.equal(result.path[1].balanceMinor, 20_000);
  });
  test('Перераспределение не выполняется: перерасход явно показан и путь может уйти ниже нуля', () => {
    const result = projectSavings(savings({ balanceMinor: 0, goals: [goal({ monthlyMinor: 15_000 })] }));
    assert.equal(result.overallocated, true);
    assert.equal(result.goals[0].monthsToGoal, 2);
    assert.equal(result.goals[0].feasible, false);
    assert.equal(result.path[1].balanceMinor, -5000);
    assert.ok(result.warnings.some((warning) => warning.includes('не изменено автоматически')));
  });
  test('Срок в месяцах и календарный срок с явной базовой датой', () => {
    const numeric = projectSavings(savings({ goals: [goal({ deadline: 3 })] }));
    assert.equal(numeric.goals[0].monthlyNeededMinor, 10_000);
    assert.equal(numeric.goals[0].feasible, false);
    const dated = projectSavings(savings({ asOf: '2024-01-31', goals: [goal({ targetMinor: 10_001, deadline: '2024-03-31' })] }));
    assert.equal(dated.goals[0].monthlyNeededMinor, 5001);
    assert.equal(dated.goals[0].monthsToGoal, 3);
    assert.equal(dated.goals[0].feasible, false);
    const shortMonth = projectSavings(savings({ asOf: '2024-01-31', goals: [goal({ targetMinor: 5000, deadline: '2024-02-29' })] }));
    assert.equal(shortMonth.goals[0].monthlyNeededMinor, 5000);
    assert.equal(shortMonth.goals[0].feasible, true);
  });
  test('Без asOf календарная достижимость не выдумывается; прошедший срок недостижим', () => {
    const noBase = projectSavings(savings({ goals: [goal({ deadline: '2030-01-01' })] }));
    assert.equal(own(noBase.goals[0], 'monthlyNeededMinor'), false);
    assert.equal(noBase.goals[0].feasible, false);
    assert.ok(noBase.warnings.some((warning) => warning.includes('базовая дата')));
    const past = projectSavings(savings({ asOf: '2024-02-01', goals: [goal({ deadline: '2024-01-01' })] }));
    assert.equal(past.goals[0].feasible, false);
    assert.equal(own(past.goals[0], 'monthlyNeededMinor'), false);
  });
  test('Нет скрытого роста, процентов, дохода или мутации', () => {
    const input = savings({ incomeMinor: 0, expenseMinor: 0, goals: [goal({ monthlyMinor: 0 })], months: 12 });
    const before = JSON.stringify(input);
    const result = projectSavings(input);
    assert.ok(result.path.every((point) => point.balanceMinor === 10_000));
    assert.equal(JSON.stringify(input), before);
    assert.deepEqual(projectSavings(input), result);
  });
  test('Дефицит дохода, отрицательный баланс и нулевой горизонт остаются явными', () => {
    const result = projectSavings(savings({ balanceMinor: -100, incomeMinor: 0, expenseMinor: 100, months: 1 }));
    assert.equal(result.monthlyFreeMinor, -100);
    assert.equal(result.overallocated, true);
    assert.deepEqual(result.path, [{ month: 0, balanceMinor: -100 }, { month: 1, balanceMinor: -200 }]);
    assert.equal(projectSavings(savings({ months: 0 })).path.length, 1);
  });
  test('Неверный резерв, копейки, сроки, дубли и переполнение отклоняются', () => {
    for (const patch of [{ reservedMinor: 10_001 }, { reservedMinor: -1 }, { incomeMinor: Infinity }, { expenseMinor: -1 }, { balanceMinor: 0.5 }, { months: 1201 }]) assert.throws(() => projectSavings(savings(patch)));
    for (const patch of [{ deadline: '31.02.2024' }, { monthlyMinor: -1 }, { targetMinor: 1.1 }, { deadline: 0 }]) assert.throws(() => projectSavings(savings({ goals: [goal(patch)] })));
    assert.throws(() => projectSavings(savings({ goals: [goal(), goal()] })), /уникальные/);
    assert.throws(() => projectSavings(savings({ balanceMinor: Number.MAX_SAFE_INTEGER, months: 1 })), /переполнение/);
  });
});

function own(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
