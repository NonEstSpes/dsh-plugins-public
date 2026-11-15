import z from '@deepseek-ai/schemastery';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { FinanceService, AGENT_ACTIONS, FINANCE_VERSION } from './lib/service.js';
import { FinanceError } from './lib/repository.js';
import { trackClientArtifact } from './lib/client-artifact.js';

export const inject = ['webServer', 'connection', 'tools'];
export const Config = z.object({
  dataDirectory: z.string().description('Persistent local finance directory. Separate from plugin code; raw statements are never stored here.'),
  maxUploadMiB: z.natural().min(1).max(20).default(10),
  previewTtlMinutes: z.natural().min(1).max(60).default(15),
  reportHour: z.natural().max(23).default(21),
  backupRetention: z.natural().max(30).default(7),
}).default({}).description(`Настройки финансового плагина. Версия обработчика ${FINANCE_VERSION}. Поддерживается сверка PDF-выписок ВТБ и автоматический выбор месяца с операциями. Редактор открывается под выбранной операцией. Таблица финансовых обязательств имеет отдельную прокрутку. Ошибки и результат сохранения модели дохода видны в форме. Сверка ВТБ учитывает явно указанные отдельные транзакционные комиссии. Компоновка карточек и отступы кнопок адаптируются к ширине финансовой панели. Заголовки операций сортируют всю отфильтрованную выборку до пагинации.`);

const help = {
  state: 'Read a month or explicit date range. args: {month?:YYYY-MM,from?,to?,query?,needsReview?,limit?:1..50,offset?,sortBy?:date|description|amountMinor|category|kind,sortDirection?:desc|asc}. Sorting applies to the full filtered set before pagination; defaults date/desc. Returns accounts, overview and paginated transactions; Tool args.metadataOnly:true returns only meta (server version, served Client artifact status), without ledger rows or rules. Bank data requires user-enabled agent access.',
  'account.save': 'Create or update an account. {id?,name,openingBalanceMinor?,openingDate?:YYYY-MM-DD,openingKnown?:boolean}. Amounts are integer kopecks; opening balance applies before transactions on openingDate.',
  'category.save': 'Create a category or update protection. {id?,name,protected?:boolean}. Existing category names are immutable in MVP.',
  'import.remap': 'Remap an existing temporary UI upload. {previewId,mapping:{date:number,amount?,debit?,credit?,description?,counterparty?,bankId?,currency?,direction?,amountMode:signed|debitCredit|direction|allExpenses|allIncome},openingMinor?,closingMinor?}. Returns preview and row errors. Raw upload is UI-only.',
  'import.commit': 'Commit a reviewed preview atomically. {previewId,includeDuplicateRows?:number[]}. Default skips marked potential duplicate rows; includeDuplicateRows explicitly keeps real repeated purchases. Invalid rows/balance mismatch block commit. Releases temporary server memory, does not delete original Downloads file.',
  'import.discard': 'Discard a temporary preview. {previewId}. No ledger records change.',
  'import.reverse': 'Reverse a committed import and hide its operations, retaining audit. {id}. Refuses if operations participate in income reconciliation.',
  'transaction.update': 'Change classification, not original bank fields. {id,category?,kind?:income|expense|transfer|refund|loan,needsReview?:boolean,note?}. Category name or ID; explicit manual changes are protected from rules.',
  'rule.save': 'Create/update literal category rule. {id?,label,counterparty?,descriptionContains?,minMinor?,maxMinor?,category,kind?,enabled?,applyExisting?:boolean}. Requires a recipient or description; applyExisting is explicit and preserves manual edits.',
  outlook: 'Calculate six completed historical months and 1..12 next full calendar months. args: {modelId?,months?:6}. Returns coverage/unknown periods, net salary and calendar bonuses, savings scenarios, provisional explainable financial-health indicator, and the exact anonymized AI payload. No network request or financial mutation.',
  'advice.generate': 'Explicitly send anonymized numeric outlook aggregates to opencode-go/deepseek-v4.1-flash through the configured subscription and store a local advisory snapshot. args: {modelId?,months?:6}. No raw transactions, names, account numbers or notes; no fallback provider or automatic budget changes. Returns provisional AI score/advice with source hash; stale results must be refreshed.',
  'income.save': 'Save an immutable model version. {id?,name,effectiveFrom:YYYY-MM,salaryMinor,workedRatio?,taxRateBps?:0..10000,deductionsMinor?,payoutDay?:1..31,components:[{id,label,type:fixed|percent_base|percent_running,value,multiplier?,guaranteed?,enabled?,frequency?:monthly|quarterly,payoutMonths?:number[4],minValue?,maxValue?}]}. 13% is 1300 bps; missing tax preserves legacy zero. Tax is rounded from gross before other deductions. Fixed values are kopecks; percentage endpoints use the same percentage base. Quarterly months must be explicit. Saved calculation uses effectiveFrom month; original versions remain unchanged.',
  'income.calculate': 'Calculate without saving. {model,scenario?:conservative|base|optimistic,month?:YYYY-MM,mode?:cash|regular|average}. Defaults cash/current Moscow month. Regular excludes quarterly bonuses; average prorates them but is not monthly available cash. Returns gross/tax/deductions/net and applied components. Not a bank deposit or full progressive-tax-law calculation.',
  'income.reconcile': 'Match selected actual income operations to an accrual period. {modelId,period:YYYY-MM,transactionIds:string[]}. Stores expected/actual/difference and prevents double matching.',
  'income.unmatch': 'Remove an income reconciliation link, leaving actual operations untouched and preserving audit. {id:incomeMatchId}.',
  'goal.save': 'Create/update goal. {id?,name,targetMinor,savedMinor,monthlyMinor,deadline?:YYYY-MM-DD,priority?:1..100}. Already saved funds are reserved, never counted as income.',
  'budget.save': 'Set monthly category budget. {id?,category,limitMinor,protected?:boolean}.',
  'obligation.save': 'Set recurring monthly payment. {id?,name,amountMinor,dayOfMonth:1..31,category,enabled?:boolean}.',
  forecast: 'Read scenario-based monthly projection. {modelId?,monthlyExpenseMinor?,balanceMinor?,months?:1..60}. Requires actual known balance and expenses/budgets/history; reports missing inputs instead of inventing income. Not an exact intramonth cash calendar.',
  'report.generate': 'Generate and store deterministic report snapshot. {period:day|week|month,date?:YYYY-MM-DD}. Returns totals, categories, source evidence and freshness warnings. No external LLM call.',
};
function compact(value, action, args = {}) {
  if (action !== 'state') return value;
  if (args.metadataOnly === true) return { meta: value.meta };
  return { ...value,
    reports: value.reports.slice(0, 10).map(r => ({ id: r.id, period: r.period, fromDate: r.fromDate, toDate: r.toDate, createdAt: r.createdAt, incomeMinor: r.data.incomeMinor, expenseMinor: r.data.expenseMinor, warnings: r.warnings })),
    nextOffset: value.transactions.length ? value.transactions.length : null,
    limits: { reportsShown: 10, transactionPaging: 'Use offset + limit to read additional operations.' },
  };
}
export function makeTool(service) {
  return {
    name: 'finance',
    description: 'Manage local personal finances: verified imported transactions, literal category rules, income formulas/reconciliation, budgets, goals and reports. Use action=help to discover an operation. Explicit advice.generate sends anonymized aggregates to OpenCode Go. Money is integer kopecks (RUB). Raw statements and enabling agent access are user-only in the Finance panel; financial access starts disabled. Tool results may be sent to the model and retained in chat.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['help', ...AGENT_ACTIONS], description: 'Operation name. help returns the operation directory or details for args.action.' }, args: { type: 'object', additionalProperties: true, description: 'Operation parameters; discover exact fields with help. Amounts are integer kopecks, dates YYYY-MM-DD.' } }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 100000,
    isConcurrencySafe: args => ['help', 'state', 'income.calculate', 'forecast', 'outlook'].includes(args?.action),
    async execute(input) {
      if (!input || typeof input !== 'object') throw new FinanceError('INVALID_INPUT', 'Неизвестный запрос.');
      const { action, args = {} } = input;
      if (action === 'help') {
        if (args.action) { if (!help[args.action]) throw new FinanceError('UNKNOWN_ACTION', 'Неизвестное действие.'); return { action: args.action, contract: help[args.action] }; }
        return { money: 'integer kopecks, RUB only', defaultAccess: 'disabled; user-only setting in Finance panel', actions: Object.entries(help).map(([name, contract]) => ({ name, purpose: contract.split('. ')[0] })) };
      }
      const value = await service.execute(action, action === 'state' ? { ...args, limit: Math.min(args.limit ?? 20, 50) } : args, { caller: 'agent' });
      return compact(value, action, args);
    },
  };
}
function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(JSON.stringify(value));
}
async function readBody(req, limit) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new FinanceError('UPLOAD_TOO_LARGE', 'Слишком большой запрос.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new FinanceError('INVALID_JSON', 'Некорректный JSON.'); }
}
export function makeHttpHandler(service, connection, { maxUploadMiB = 10 } = {}) {
  return async (req, res) => {
    try {
      const rejected = connection.requestRejection({ headers: req.headers });
      if (rejected) { send(res, rejected, { ok: false, error: { code: 'AUTH_REQUIRED', message: 'Требуется действующее подключение DSH.' } }); return; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); send(res, 405, { ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Используйте POST.' } }); return; }
      if (req.headers['x-dsh-finance'] !== '1' || !/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || req.headers['sec-fetch-site'] === 'cross-site') {
        send(res, 403, { ok: false, error: { code: 'REQUEST_REJECTED', message: 'Запрос отклонён: требуется интерфейс финансов DSH.' } }); return;
      }
      const request = await readBody(req, Math.ceil(maxUploadMiB * 1024 * 1024 * 4 / 3) + 512 * 1024);
      if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k => !['action','args'].includes(k))) throw new FinanceError('INVALID_INPUT', 'Некорректный запрос.');
      const value = await service.execute(request.action, request.args || {}, { caller: 'ui' }); send(res, 200, { ok: true, value });
    } catch (error) {
      if (res.writableEnded || res.destroyed) return;
      const expected = error instanceof FinanceError || ['FinanceValidationError', 'FinanceMappingError'].includes(error?.name) || error?.name === 'RangeError' || error?.name === 'TypeError';
      const status = error?.code === 'UPLOAD_TOO_LARGE' ? 413 : expected ? 400 : 500;
      send(res, status, { ok: false, error: { code: typeof error?.code === 'string' ? error.code : 'FINANCE_ERROR', message: expected ? String(error.message).slice(0, 800) : 'Операция не выполнена. Данные не изменены; проверьте формат запроса и повторите.' } });
    }
  };
}
export function apply(ctx, config) {
  ctx.effect(() => {
    const dataDirectory = resolve(config.dataDirectory || join(process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || join(homedir(), '.dsh'), 'data', 'finance'));
    const service = new FinanceService(join(dataDirectory, 'finance.sqlite'), config);
    const cleanups = [];
    try {
      const clientArtifact = trackClientArtifact(ctx.get?.('clientModules'));
      service.options.clientUiStatus = clientArtifact.status;
      service.options.llm = ctx.get?.('llm');
      cleanups.push(() => clientArtifact.dispose());
      cleanups.push(ctx.webServer.register({ kind: 'exact', path: '/api/finance', handler: makeHttpHandler(service, ctx.connection, config) }));
      cleanups.push(ctx.tools.register(makeTool(service)));
      const tick = () => { try { service.tick(); } catch (e) { console.error('[dsh-finance] background task failed:', typeof e?.code === 'string' ? e.code : 'TASK_FAILED'); } };
      const timer = setInterval(tick, 60000); timer.unref?.(); tick();
      return () => { clearInterval(timer); for (const dispose of cleanups.reverse()) dispose(); service.close(); };
    } catch (error) { for (const dispose of cleanups.reverse()) dispose(); service.close(); throw error; }
  });
}
