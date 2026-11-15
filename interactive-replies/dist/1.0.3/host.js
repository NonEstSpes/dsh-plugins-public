import { PROJECTION_KEY, MAX_CODE_LENGTH, createState, applyEvent, validateSpec, parseState, logicalId, structuralRevision } from './state.js';
import { cloneJsonBounded, isRecord } from './validation.js';
import { catalogGuide } from './catalog-info.js';
import { createSubmitRoute } from './admission.js';
import { readFile } from 'node:fs/promises';

export const VERSION = '1.0.3';
export const AGENT_GUIDANCE = 'Interactive UI is available in this profile via interactive_ui. Proactively create useful forms, calculators, charts and filterable comparisons; do not merely offer a widget or wait for the user to name this plugin. Do not ask whether to use a local, non-destructive card: execution still follows the user\'s Run/autorun controls. Read describe before authoring and catalog for optional components; custom Vue/SVG is also supported. Keep simple answers as text. Submit values only on an explicit user action. Never use card code for external/destructive actions, secrets or untrusted content without authorization.';
export async function diagnoseClient(ctx, readSource = path => readFile(path, 'utf8')) {
  const prompt = ctx.systemPrompt?.assemble ? await ctx.systemPrompt.assemble() : null;
  const profileGuidancePresent = prompt?.sections.some(section => section.name === 'local-interactive-replies' && section.text === AGENT_GUIDANCE) ?? false;
  const modules = ctx.clientModules;
  const entry = modules.graph().entries.find(entry => entry.id === '@local/interactive-replies');
  const path = modules.clientPath('@local/interactive-replies');
  if (!entry || !path) return { hostVersion: VERSION, profileGuidancePresent, clientAvailable: false };
  const file = await readSource(path);
  const response = await modules.fetchBundle(new Request(new URL(entry.url, 'http://dsh.internal/')));
  const body = await response.text();
  const versionOf = source => /Interactive Replies ([0-9.]+);/.exec(source)?.[1] ?? (source.includes('Interactive replies · pilot') ? 'pilot' : 'unknown');
  return { hostVersion: VERSION, profileGuidancePresent, clientAvailable: true, clientPath: path, autoRunNewDefault: /const AUTO_RUN_NEW_DEFAULT = true;/.test(body), artifactVersion: versionOf(file), servedVersion: versionOf(body), servedMatchesFile: body.includes(file), responseStatus: response.status };
}

export const name = 'local-interactive-replies';
export const inject = ['tools', 'sessionProjections', 'systemPrompt', 'connection', 'sessionController', 'clientModules'];
export const projectionSchema = { parse: parseState };
export const RUNTIME_GUIDE = [
  'interactive_ui shows a persistent Vue card at the end of an assistant turn, not between Markdown paragraphs.',
  'show takes title, template and script (synchronous setup function body ending with return {...bindings}). Use theme classes, not CSS. Setup receives Vue/ref/reactive/computed/watch/onMounted/onUnmounted/nextTick and registered catalog components.',
  'For richer color/data visualization, custom Vue/SVG is allowed: fill/stroke attributes may use categorical colors; keep labels legible in light/dark themes and use theme classes for surrounding controls. Built-in Bars/Line/Donut currently accept data/title/description, not palette/colors props. Do not invent unsupported catalog props or use global styles.',
  'data is a reactive readonly ref: data.value in setup, data in templates. submitted and readonly are readonly refs; disable controls when readonly. reply(values,summary) must only run from an explicit user action, never setup/mount; never fabricate a user reply.',
  'update changes data/title only, increments dataVersion and preserves logical id, revision, anchor, draft and submission. replace requires expectedRevision and complete new template/script; creates revision+1, retains previous submitted snapshots and requires explicit Run again. get reads own-Session bounded state. catalog lists components; describe(component) retrieves one component contract.',
  'fields entries: {name,type,label?,description?,placeholder?,required?,initial?,options?,min?,max?,step?,minLength?,maxLength?}. Types: text,textarea,number,slider,select,radio,checks,switch,date,time,segmented. Choices are primitives or {value,label}. Nonempty fields enforce typed values and reject unknown keys; missing optional fields are allowed. Empty fields permit bounded arbitrary JSON replies.',
  'draft is a local reactive object; useDraft(key,initial) returns a writable computed ref stored in draft.custom. Use these for state that should survive reloads and data-only updates; plain ref state resets on rerun. Keys are safe identifiers up to 64 characters. Local drafts are scoped by Session/id/revision, not sent to the model. fields is the readonly declared-schema ref.',
  'signal is an AbortSignal aborted on unmount; pass it to authorized abortable work. onCleanup(fn) registers unmount cleanup. Clean up every timer/watcher/listener/resource. Only explicitly accepted submissions persist in Session history.',
  'Trusted unrestricted browser JavaScript, NOT a sandbox. Do not perform network/file/external operations or handle secrets without explicit user authorization. Host never evaluates source. Historical and replacement cards require explicit Run; inherited/forked cards are readonly.',
  'The user enabled autorun by default for new Sessions in this profile. Saved per-Session auto/paused choices take precedence; storage failures stay paused. Only newly created initial revisions may autorun; historical/replacement cards require Run and inherited cards cannot submit.',
  'Limits: title 200 characters; template/script 32768 characters each; data JSON 64 KiB UTF-8; browser reply/draft values 32 KiB, Host submission request 64 KiB; 64 fields; 64 cards total, 8 per initial placement turn; 16 prior submitted revision snapshots per card.',
].join('\n');

export const DEMO = Object.freeze({
  title: 'Интерактивный ответ',
  template: `<div class="ir-stack"><p class="ir-muted">Счётчик и имя</p><div class="ir-row"><button class="ir-button" :disabled="readonly" @click="count--">−</button><output class="ir-value">{{ count }}</output><button class="ir-button" :disabled="readonly" @click="count++">+</button><span>Удвоенное: {{ doubled }}</span></div><label class="ir-stack">Как вас зовут?<input class="ir-input" v-model="name" :disabled="readonly" placeholder="Ваше имя" /></label><p>Здравствуйте, {{ name.trim() || 'гость' }}!</p><button class="ir-button" :disabled="readonly" @click="send">Отправить ответ</button><p v-if="submitted" class="ir-muted">Ответ сохранён: {{ submitted.summary }}</p></div>`,
  script: `const count = useDraft('count', submitted.value?.values?.count ?? 0);
const name = useDraft('name', submitted.value?.values?.name ?? '');
const doubled = computed(() => count.value * 2);
async function send() {
  if (readonly.value) return;
  await reply({ count: count.value, name: name.value, doubled: doubled.value }, 'Имя: ' + (name.value.trim() || 'гость') + '; счётчик: ' + count.value + '; удвоенное: ' + doubled.value);
}
return { count, name, doubled, send };`,
});

const ACTIONS = ['describe', 'catalog', 'demo', 'show', 'update', 'replace', 'get', 'diagnostics'];
const properties = {
  action: { type: 'string', enum: ACTIONS, description: 'Defaults to demo. Read describe before authoring; catalog discovers components. diagnostics checks the served Client version without running card code.' },
  id: { type: 'string', description: 'Stable card identity in this Session. show defaults to this call ID; required for update, replace and single-card get.' },
  expectedRevision: { type: 'integer', description: 'Optimistic structural revision. Required for replace; optional for update.' },
  expectedDataVersion: { type: 'integer', description: 'Optional optimistic data version for update or replace.' },
  title: { type: 'string', description: 'Nonempty title, at most 200 characters. Required for show/replace; optional for update.' },
  template: { type: 'string', description: `Nonempty Vue template, at most ${MAX_CODE_LENGTH} characters. show/replace only.` },
  script: { type: 'string', description: `Synchronous setup body returning template bindings, at most ${MAX_CODE_LENGTH} characters. show/replace only.` },
  data: { description: 'JSON data up to 64 KiB UTF-8; defaults to {} for show/replace. update replaces the entire data value.' },
  fields: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, label: { type: 'string' }, description: { type: 'string' }, hint: { type: 'string' }, placeholder: { type: 'string' }, disabled: { type: 'boolean' }, required: { type: 'boolean' }, initial: {}, options: { type: 'array', items: {} }, min: { type: 'number' }, max: { type: 'number' }, step: { type: 'number' }, minLength: { type: 'integer' }, maxLength: { type: 'integer' } }, required: ['name', 'type'], additionalProperties: false }, description: 'Up to 64 declarative form fields; defaults to []. Read describe for constraints.' },
  component: { type: 'string', description: 'For describe: exact component name from catalog.' },
};
const allowedByAction = {
  describe: ['component'], catalog: [], diagnostics: [], demo: ['id'], show: ['id', 'title', 'template', 'script', 'data', 'fields'],
  update: ['id', 'expectedRevision', 'expectedDataVersion', 'title', 'data'],
  replace: ['id', 'expectedRevision', 'expectedDataVersion', 'title', 'template', 'script', 'data', 'fields'], get: ['id'],
};

function argumentsFor(args) {
  if (!isRecord(args)) throw new TypeError('Invalid interactive_ui arguments');
  const action = args.action ?? 'demo';
  if (!ACTIONS.includes(action) || Object.keys(args).some(key => key !== 'action' && !allowedByAction[action].includes(key))) throw new TypeError('Unknown action or unsupported action parameters');
  for (const key of ['id', 'title', 'template', 'script', 'component']) if (Object.hasOwn(args, key) && typeof args[key] !== 'string') throw new TypeError(`${key} must be a string`);
  for (const key of ['expectedRevision', 'expectedDataVersion']) if (Object.hasOwn(args, key) && (!Number.isSafeInteger(args[key]) || args[key] < (key === 'expectedRevision' ? 1 : 0))) throw new TypeError(`Invalid ${key}`);
  if (args.id !== undefined && (!args.id.trim() || args.id.length > 512)) throw new TypeError('id must contain 1–512 characters');
  return action;
}
const findItem = (state, sessionId, id) => state.items.find(item => item.spec.sessionId === sessionId && logicalId(item.spec) === id);
const metadata = item => ({ id: logicalId(item.spec), schemaVersion: item.spec.schemaVersion, revision: structuralRevision(item.spec), dataVersion: item.spec.dataVersion ?? 0, title: item.spec.title, turn: item.spec.turn, anchorTurn: item.spec.anchorTurn ?? item.spec.turn, callId: item.spec.callId, resultSeq: item.resultSeq, submitted: item.submission !== null });

export function createTool(ctx) {
  return {
    name: 'interactive_ui',
    description: 'Create and maintain persistent interactive Vue reply cards in this chat. Discover the runtime with describe and components with catalog. Code is trusted browser JavaScript, not sandboxed.',
    parameters: { type: 'object', additionalProperties: false, properties },
    output: {
      schema: {},
      render: (_args, value) => [{ type: 'text', text: 'guide' in value ? value.guide : value.schemaVersion ? `Interactive reply card: ${value.title} (id=${value.id}, revision=${value.revision}, dataVersion=${value.dataVersion}). Await the user’s explicit reply.` : JSON.stringify(value) }],
      presentationMeta: (_args, value) => value.schemaVersion === 2 ? { interactiveReply: value } : {},
    },
    async execute(args, exec) {
      const action = argumentsFor(args);
      if (action === 'describe') return { guide: args.component ? catalogGuide(args.component) : RUNTIME_GUIDE };
      if (action === 'catalog') return { guide: catalogGuide() };
      if (action === 'diagnostics') return diagnoseClient(ctx);
      const session = exec.agent?.session;
      if (!session) throw new Error('interactive_ui requires an agent Session');
      const state = ctx.sessionProjections.stateOf(session, PROJECTION_KEY);
      if (!state || !Array.isArray(state.items)) throw new Error('Interactive reply projection is unavailable');
      if (action === 'get') {
        if (args.id === undefined) return { sessionId: session.id, cards: state.items.filter(item => item.spec.sessionId === session.id).map(metadata) };
        const item = findItem(state, session.id, args.id);
        if (!item) throw new Error('Card not found in this Session');
        return { sessionId: session.id, card: metadata(item), data: cloneJsonBounded(item.spec.schemaVersion === 2 ? item.spec.data : {}), fields: cloneJsonBounded(item.spec.fields ?? []), submission: item.submission === null ? null : { ...item.submission, values: cloneJsonBounded(item.submission.values) }, history: (item.history ?? []).map(({ revision, summary, seq }) => ({ revision, summary, seq })), historyValuesOmitted: (item.history?.length ?? 0) > 0 };
      }
      const boundary = ctx.sessionProjections.stateOf(session, 'turnBoundary');
      if (!boundary || boundary.openTurnStartSeq === null || boundary.openTurnStartSeq === undefined) throw new Error('interactive_ui requires an open turn');
      exec.signal.throwIfAborted();
      const id = args.id ?? exec.callId, existing = findItem(state, session.id, id), changing = action === 'update' || action === 'replace';
      if (changing && !args.id) throw new TypeError(`${action} requires id`);
      if (changing && !existing) throw new Error('Card not found in this Session');
      if (!changing && existing) throw new Error('Card id already exists; use update or explicit replace');
      if (changing && existing.spec.schemaVersion !== 2) throw new Error('Legacy cards are read-only; show a new card');
      if (action === 'replace' && args.expectedRevision === undefined) throw new TypeError('replace requires expectedRevision');
      if (changing && args.expectedRevision !== undefined && args.expectedRevision !== existing.spec.revision) throw new Error('Stale expectedRevision');
      if (changing && args.expectedDataVersion !== undefined && args.expectedDataVersion !== existing.spec.dataVersion) throw new Error('Stale expectedDataVersion');
      let candidate;
      if (action === 'update') {
        if (!Object.hasOwn(args, 'data') && !Object.hasOwn(args, 'title')) throw new TypeError('update requires data or title');
        candidate = { ...existing.spec, turn: boundary.lastTurn, callId: exec.callId, dataVersion: existing.spec.dataVersion + 1, ...(Object.hasOwn(args, 'data') ? { data: args.data } : {}), ...(Object.hasOwn(args, 'title') ? { title: args.title } : {}) };
      } else {
        const source = action === 'demo' ? DEMO : args;
        candidate = { schemaVersion: 2, sessionId: session.id, id, revision: existing ? existing.spec.revision + 1 : 1, dataVersion: 0, turn: boundary.lastTurn, anchorTurn: existing?.spec.anchorTurn ?? boundary.lastTurn, callId: exec.callId, createdAt: existing?.spec.createdAt ?? Date.now(), title: source.title, template: source.template, script: source.script, data: Object.hasOwn(args, 'data') ? args.data : {}, fields: args.fields ?? [] };
      }
      const spec = validateSpec(candidate);
      if (!spec) throw new TypeError('Invalid card source, fields or bounded JSON data; read describe for limits');
      return spec;
    },
  };
}

export function apply(ctx) {
  ctx.connection.fetch.register(createSubmitRoute(ctx));
  ctx.sessionProjections.register({ key: PROJECTION_KEY, stateVersion: 2, stateSchema: projectionSchema, init: createState, apply: applyEvent, wire: { viewSchema: projectionSchema, view: state => state } });
  ctx.tools.register(createTool(ctx));
  ctx.systemPrompt.section({ name: 'local-interactive-replies', order: 4900, interpolate: false, text: AGENT_GUIDANCE });
}
