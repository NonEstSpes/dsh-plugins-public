// Import-free catalog for the trusted Vue reply runtime. Registration has no global effects.
export function catalogClone(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item) || ['undefined', 'function', 'symbol', 'bigint'].includes(typeof item)) throw new TypeError('Expected JSON values');
    return item;
  }));
}
export function catalogOptions(options) {
  return (Array.isArray(options) ? options : []).map(option => option !== null && typeof option === 'object'
    ? { value: option.value, label: option.label }
    : { value: option, label: String(option) });
}
export function catalogInitialValues(fields, saved = {}) {
  const values = Object.create(null);
  for (const field of fields || []) {
    if (!field || typeof field.name !== 'string') continue;
    const value = Object.hasOwn(saved, field.name) ? saved[field.name] : field.initial !== undefined ? field.initial : field.type === 'checks' ? [] : field.type === 'switch' ? false : ['number', 'slider'].includes(field.type) ? null : '';
    Object.defineProperty(values, field.name, { value: catalogClone(value), enumerable: true, writable: true, configurable: true });
  }
  return values;
}
export function catalogTableRows(rows, columns, search = '', sortKey = '', direction = 1) {
  const source = (Array.isArray(rows) ? rows : []).slice(0, 500);
  const needle = String(search).toLocaleLowerCase();
  const result = source.map((row, index) => ({ row, index })).filter(({ row }) => !needle || columns.some(column => String(row?.[column.key] ?? '').toLocaleLowerCase().includes(needle)));
  if (sortKey) result.sort((a, b) => {
    const x = a.row?.[sortKey], y = b.row?.[sortKey];
    const comparison = x == null ? (y == null ? 0 : -1) : y == null ? 1 : typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return direction * comparison || a.index - b.index;
  });
  return result;
}
export function catalogChartData(data) {
  return (Array.isArray(data) ? data : []).slice(0, 200).map((item, index) => ({ label: String(item?.label ?? index + 1), value: typeof item?.value === 'number' && Number.isFinite(item.value) ? item.value : 0 }));
}
export function catalogLinePoints(data) {
  const items = catalogChartData(data), values = items.map(item => item.value);
  const scale = Math.max(1, ...values.map(Math.abs));
  const min = Math.min(0, ...values.map(value => value / scale)), max = Math.max(0, ...values.map(value => value / scale)), span = max - min || 1;
  return items.map((item, index) => [10 + index * 280 / Math.max(1, items.length - 1), 90 - (item.value / scale - min) * 80 / span]);
}
export function catalogSummary(fields, values) {
  return fields.filter(field => Object.hasOwn(values, field.name)).map(field => {
    const raw = values[field.name];
    const label = value => catalogOptions(field.options).find(option => Object.is(option.value, value))?.label ?? String(value ?? '');
    return `${field.label || field.name}: ${Array.isArray(raw) ? raw.map(label).join(', ') : label(raw)}`;
  }).join('; ').slice(0, 2000);
}
export function catalogSubmission(fields, values, validateFields, summary = '') {
  const snapshot = catalogClone(values);
  // Only optional UI unset sentinels are omitted. Keep actual invalid values,
  // unknown keys and every required value for authoritative error reporting.
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) for (const field of fields) {
    if (field.required || !Object.hasOwn(snapshot, field.name)) continue;
    const value = snapshot[field.name];
    const unsetNumber = ['number', 'slider'].includes(field.type) && value === null;
    const unsetChoice = ['select', 'radio', 'segmented'].includes(field.type) && value === '' && !catalogOptions(field.options).some(option => Object.is(option.value, ''));
    const unsetText = ['text', 'textarea', 'date', 'time'].includes(field.type) && value === '' && field.minLength > 0;
    if (unsetNumber || unsetChoice || unsetText) delete snapshot[field.name];
  }
  const result = validateFields(fields, snapshot);
  return { ok: result.ok, errors: result.errors || [], values: snapshot, summary: String(summary || catalogSummary(fields, snapshot && typeof snapshot === 'object' ? snapshot : {})).slice(0, 2000) };
}
export const COMPONENT_CSS = `
.ir-widget-card{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:14px;min-width:0}.ir-widget-title{font-weight:600;margin:0 0 8px}.ir-widget-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ir-widget-columns{display:grid;grid-template-columns:repeat(var(--ir-columns),minmax(0,1fr));gap:12px}.ir-widget-stack{display:flex;flex-direction:column;gap:12px;min-width:0}.ir-widget-muted{color:var(--dsw-alias-label-secondary);font-size:.9em}.ir-widget-stat{font-size:1.8em;font-variant-numeric:tabular-nums}.ir-widget-chips{list-style:none;padding:0;margin:0;display:flex;gap:6px;flex-wrap:wrap}.ir-widget-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:20px;padding:2px 9px}.ir-widget-tabs{display:flex;gap:6px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}.ir-widget-tab[aria-selected=true]{border-color:var(--dsw-alias-brand-primary);font-weight:600}.ir-widget-panel{padding-top:12px}.ir-widget-progress{width:100%;accent-color:var(--dsw-alias-brand-primary)}.ir-widget-steps{display:flex;gap:16px;flex-wrap:wrap;padding-inline-start:24px}.ir-widget-step[aria-current=step]{font-weight:600;color:var(--dsw-alias-brand-primary)}.ir-widget-scroll{max-width:100%;overflow:auto}.ir-widget-table{border-collapse:collapse;width:100%;text-align:start}.ir-widget-table th,.ir-widget-table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:start;overflow-wrap:anywhere}.ir-widget-table caption{text-align:start;padding:6px}.ir-widget-input{box-sizing:border-box;width:100%;min-width:0;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;font:inherit}.ir-widget-button{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:7px 12px;cursor:pointer}.ir-widget-button:disabled,.ir-widget-input:disabled{opacity:.55;cursor:default}.ir-widget-button:hover:enabled{background:var(--dsw-alias-bg-layer-2)}.ir-widget-button:focus-visible,.ir-widget-input:focus-visible,.ir-widget-tab:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}.ir-widget-field{display:flex;flex-direction:column;gap:5px;min-width:0;border:0;margin:0;padding:0}.ir-widget-stack>fieldset{border:0;margin:0;padding:0;min-width:0}.ir-widget-options{display:flex;flex-wrap:wrap;gap:10px}.ir-widget-option{display:inline-flex;align-items:center;gap:5px}.ir-widget-error{color:var(--dsw-alias-label-primary);border-inline-start:3px solid var(--dsw-alias-brand-primary);padding-inline-start:8px}.ir-widget-chart{margin:0;min-width:0}.ir-widget-svg{width:100%;height:auto;max-height:240px;display:block;color:var(--dsw-alias-brand-primary)}.ir-widget-chart details{margin-top:8px}.ir-widget-track{fill:var(--dsw-alias-bg-layer-2)}.ir-widget-bar{fill:var(--dsw-alias-brand-primary)}.ir-widget-line{stroke:var(--dsw-alias-brand-primary);fill:none;stroke-width:2}.ir-widget-dot{fill:var(--dsw-alias-brand-primary)}.ir-widget-slice{fill:none;stroke-width:16}.ir-widget-slice:nth-of-type(3n+1){stroke:var(--dsw-alias-brand-primary)}.ir-widget-slice:nth-of-type(3n+2){stroke:var(--dsw-alias-label-secondary)}.ir-widget-slice:nth-of-type(3n){stroke:var(--dsw-alias-label-primary)}
@media(max-width:600px){.ir-widget-columns{grid-template-columns:minmax(0,1fr)}.ir-widget-table th,.ir-widget-table td{padding:6px}.ir-widget-row{align-items:stretch}}
`;

export function registerComponents(app, Vue, context) {
  const { h, ref, computed, watch, provide, inject, useId, Fragment } = Vue;
  const formKey = Symbol('interactive-reply-form');
  const text = key => context.t(key);
  const locked = () => !!context.readonly.value || !!context.submitted.value;
  const button = (label, attrs = {}) => h('button', { type: 'button', class: 'ir-widget-button', ...attrs }, label);
  const note = value => value ? h('div', { class: 'ir-widget-muted' }, String(value)) : null;
  const components = {};
  const simple = (name, tag, css, props, render) => ({ name, props, setup(p, { slots }) { return () => h(tag, { class: css }, render ? render(p, slots) : slots.default?.()); } });
  components.Card = simple('Card', 'section', 'ir-widget-card', { title: String }, (p, s) => [p.title ? h('h3', { class: 'ir-widget-title' }, p.title) : null, s.default?.()]);
  components.Row = simple('Row', 'div', 'ir-widget-row');
  components.Columns = { name: 'Columns', props: { count: { type: Number, default: 2 } }, setup(p, { slots }) { return () => h('div', { class: 'ir-widget-columns', style: { '--ir-columns': Math.max(1, Math.min(6, Math.floor(p.count) || 2)) } }, slots.default?.()); } };
  components.Stat = simple('Stat', 'div', 'ir-widget-card', { label: String, value: [String, Number], hint: String }, p => [note(p.label), h('div', { class: 'ir-widget-stat' }, String(p.value ?? '')), note(p.hint)]);
  components.Chips = simple('Chips', 'ul', 'ir-widget-chips', { items: { type: Array, default: () => [] } }, p => p.items.map((item, index) => h('li', { class: 'ir-widget-chip', key: index }, String(item?.label ?? item))));
  components.Progress = simple('Progress', 'div', 'ir-widget-field', { value: { type: Number, default: 0 }, max: { type: Number, default: 100 }, label: String }, p => [note(p.label), h('progress', { class: 'ir-widget-progress', value: Math.max(0, p.value), max: Math.max(1, p.max), 'aria-label': p.label || text('progress') }, `${p.value}/${p.max}`)]);
  components.Steps = simple('Steps', 'ol', 'ir-widget-steps', { items: { type: Array, default: () => [] }, current: { type: Number, default: 0 } }, p => p.items.map((item, index) => h('li', { class: 'ir-widget-step', key: index, 'aria-current': index === p.current ? 'step' : undefined }, String(item?.label ?? item))));
  components.Tab = simple('Tab', 'div', 'ir-widget-panel', { name: String, label: String, disabled: Boolean });
  components.Tabs = {
    name: 'Tabs', props: { id: String, label: String },
    setup(p, { slots }) {
      const autoId = useId(), local = ref('');
      const key = () => p.id || autoId;
      if (!context.draft.tabs || typeof context.draft.tabs !== 'object' || Array.isArray(context.draft.tabs)) context.draft.tabs = Object.create(null);
      else if (Object.getPrototypeOf(context.draft.tabs) !== null) context.draft.tabs = Object.assign(Object.create(null), context.draft.tabs);
      const flatten = nodes => (nodes || []).flatMap(node => node.type === Fragment ? flatten(node.children) : node.type === components.Tab || node.type?.name === 'Tab' ? [node] : []);
      const disabled = tab => tab.props?.disabled === '' || !!tab.props?.disabled;
      return () => {
        const tabs = flatten(slots.default?.()), active = context.draft.tabs[key()] ?? local.value;
        let selected = tabs.findIndex((tab, i) => (tab.props?.name ?? String(i)) === active && !disabled(tab));
        if (selected < 0) selected = tabs.findIndex(tab => !disabled(tab));
        const choose = index => { const value = tabs[index].props?.name ?? String(index); local.value = value; context.draft.tabs[key()] = value; };
        const tabId = index => `ir-tabs-${autoId}-${index}`;
        return h('div', { class: 'ir-widget-stack' }, [
          h('div', { class: 'ir-widget-tabs', role: 'tablist', 'aria-label': p.label || text('tabs') }, tabs.map((tab, index) => button(tab.props?.label || tab.props?.name || String(index + 1), {
            id: tabId(index), class: 'ir-widget-button ir-widget-tab', role: 'tab', disabled: disabled(tab),
            'aria-selected': index === selected, 'aria-controls': `${tabId(index)}-panel`, tabindex: index === selected ? 0 : -1,
            onClick: () => choose(index), onKeydown: event => {
              if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault(); const enabled = tabs.map((node, i) => disabled(node) ? -1 : i).filter(i => i >= 0);
              const position = enabled.indexOf(index), next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(position + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) + enabled.length) % enabled.length];
              if (next !== undefined) { choose(next); const nodes = event.currentTarget.parentElement?.querySelectorAll('[role="tab"]'); nodes?.[next]?.focus(); }
            },
          }))),
          ...tabs.map((tab, index) => h('div', { id: `${tabId(index)}-panel`, class: 'ir-widget-panel', role: 'tabpanel', 'aria-labelledby': tabId(index), tabindex: 0, hidden: index !== selected }, tab.children?.default?.())),
        ]);
      };
    },
  };

  components.Field = {
    name: 'Field', props: { name: String, type: { type: String, default: 'text' }, label: String, hint: String, description: String, placeholder: String, modelValue: null, required: Boolean, disabled: Boolean, options: { type: Array, default: () => [] }, min: Number, max: Number, step: [Number, String], minLength: Number, maxLength: Number }, emits: ['update:modelValue'],
    setup(p, { emit }) {
      const form = inject(formKey, null), id = `ir-field-${useId()}`;
      const value = () => form && p.name ? form.values.value[p.name] : p.modelValue;
      const set = next => { if (locked() || p.disabled || form?.pending.value) return; if (form && p.name) { if (!Object.hasOwn(form.values.value, p.name)) return; form.values.value[p.name] = next; form.errors.value = form.errors.value.filter(error => error.name !== p.name); } emit('update:modelValue', next); };
      return () => {
        const error = form?.errors.value.find(item => item.name === p.name), disabled = p.disabled || locked() || !!form?.pending.value;
        const options = catalogOptions(p.options), hint = p.hint || p.description;
        const group = ['radio', 'checks', 'segmented'].includes(p.type);
        const attrs = { id, name: p.name, disabled, required: p.required, 'aria-invalid': error ? 'true' : undefined, 'aria-describedby': [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined };
        const numeric = ['number', 'slider'].includes(p.type);
        let control;
        if (group) control = h('div', { class: 'ir-widget-options' }, options.map((option, index) => h('label', { class: 'ir-widget-option', key: index }, [h('input', {
          ...attrs, id: `${id}-${index}`, type: p.type === 'checks' ? 'checkbox' : 'radio', required: p.type !== 'checks' && p.required,
          checked: p.type === 'checks' ? Array.isArray(value()) && value().some(item => Object.is(item, option.value)) : Object.is(value(), option.value),
          onChange: event => { if (p.type !== 'checks') set(option.value); else { const selected = Array.isArray(value()) ? value() : []; set(event.target.checked ? [...selected.filter(item => !Object.is(item, option.value)), option.value] : selected.filter(item => !Object.is(item, option.value))); } },
        }), String(option.label)])));
        else if (p.type === 'select') control = h('select', { ...attrs, class: 'ir-widget-input', value: String(options.findIndex(option => Object.is(option.value, value()))), onChange: event => set(options[Number(event.target.value)]?.value ?? '') }, [h('option', { value: '-1', disabled: p.required }, p.placeholder || text('choose')), ...options.map((option, index) => h('option', { value: String(index), key: index }, String(option.label)))]);
        else if (p.type === 'switch') control = h('input', { ...attrs, type: 'checkbox', role: 'switch', checked: !!value(), onChange: event => set(event.target.checked) });
        else control = h(p.type === 'textarea' ? 'textarea' : 'input', { ...attrs, class: 'ir-widget-input', type: p.type === 'textarea' ? undefined : p.type === 'slider' ? 'range' : ['number', 'date', 'time'].includes(p.type) ? p.type : 'text', value: value() ?? '', placeholder: p.placeholder, min: p.min, max: p.max, step: p.step, minlength: p.minLength, maxlength: p.maxLength, onInput: event => set(numeric ? event.target.value === '' ? null : Number(event.target.value) : event.target.value) });
        return h(group ? 'fieldset' : 'div', { class: 'ir-widget-field', disabled: group ? disabled : undefined }, [
          h(group ? 'legend' : 'label', group ? {} : { for: id }, (p.label || p.name || '') + (p.required ? ' *' : '')), control,
          p.type === 'slider' ? h('output', { for: id }, String(value() ?? '')) : null,
          hint ? h('div', { id: `${id}-hint`, class: 'ir-widget-muted' }, hint) : null,
          error ? h('div', { id: `${id}-error`, class: 'ir-widget-error', role: 'alert' }, text(`validation.${error.code}`)) : null,
        ]);
      };
    },
  };

  components.Form = {
    name: 'Form', props: { fields: Array, preset: Object, summary: String, actions: { type: Boolean, default: true }, submitLabel: String, resetLabel: String, presetLabel: String },
    setup(p, { slots }) {
      const schema = computed(() => p.fields ?? context.fields.value ?? []), errors = ref([]), pending = ref(false), failure = ref('');
      if (!context.draft.form || typeof context.draft.form !== 'object' || Array.isArray(context.draft.form)) context.draft.form = catalogInitialValues(schema.value);
      const values = computed(() => context.draft.form);
      const restore = saved => { context.draft.form = catalogInitialValues(schema.value, saved); errors.value = []; failure.value = ''; };
      watch(schema, fields => {
        const saved = context.submitted.value?.values ?? values.value;
        context.draft.form = catalogInitialValues(fields, saved);
      }, { immediate: true });
      watch(() => context.submitted.value, submission => { if (submission) restore(submission.values || {}); });
      provide(formKey, { values, errors, pending });
      const submit = async () => {
        if (locked() || pending.value) return false;
        failure.value = '';
        try {
          const result = catalogSubmission(schema.value, values.value, context.validateFields, p.summary);
          errors.value = result.errors;
          if (!result.ok) return false;
          pending.value = true;
          return await context.reply(result.values, result.summary);
        } catch (error) { failure.value = text('formError'); return false; }
        finally { pending.value = false; }
      };
      const reset = () => { if (!locked() && !pending.value) restore({}); };
      return () => h('form', { class: 'ir-widget-stack', novalidate: true, onSubmit: event => { event.preventDefault(); void submit(); }, onReset: event => { event.preventDefault(); reset(); } }, [
        h('fieldset', { disabled: locked() || pending.value, class: 'ir-widget-stack' }, [
          slots.default ? slots.default({ values: values.value, errors: errors.value, submit, reset }) : schema.value.map(({ initial, ...field }) => h(components.Field, { ...field, key: field.name })),
          p.actions ? h('div', { class: 'ir-widget-row' }, [button(p.submitLabel || text('submit'), { type: 'submit' }), button(p.resetLabel || text('reset'), { type: 'reset' }), p.preset ? button(p.presetLabel || text('preset'), { onClick: () => { if (!locked() && !pending.value) restore(p.preset); } }) : null]) : null,
        ]), errors.value.length ? h('div', { class: 'ir-widget-error', role: 'alert' }, text('checkFields')) : null,
        failure.value ? h('div', { class: 'ir-widget-error', role: 'alert' }, failure.value) : null,
      ]);
    },
  };
  components.Button = {
    name: 'Button', props: { type: { type: String, default: 'button' }, send: Boolean, value: null, summary: String, disabled: Boolean }, emits: ['click'],
    setup(p, { slots, emit }) {
      const pending = ref(false), failure = ref('');
      return () => h('span', { class: 'ir-widget-field' }, [button(slots.default?.() || text('send'), {
        type: ['submit', 'reset'].includes(p.type) ? p.type : 'button', disabled: p.disabled || locked() || pending.value,
        onClick: async event => {
          if (locked() || pending.value || p.disabled) return;
          emit('click', event); if (!p.send || event.defaultPrevented) return;
          event.preventDefault(); pending.value = true; failure.value = '';
          try { await context.reply(catalogClone(p.value ?? {}), (p.summary || '').slice(0, 2000)); } catch { failure.value = text('formError'); } finally { pending.value = false; }
        },
      }), failure.value ? h('span', { role: 'alert' }, failure.value) : null]);
    },
  };

  components.Table = {
    name: 'Table', props: { columns: { type: Array, default: () => [] }, rows: { type: Array, default: () => [] }, rowKey: { type: String, default: 'id' }, caption: String, searchable: { type: Boolean, default: true }, selectable: Boolean, modelValue: { type: Array, default: undefined }, sendSelection: Boolean, sendLabel: String }, emits: ['update:modelValue'],
    setup(p, { emit }) {
      const search = ref(''), sortKey = ref(''), direction = ref(1), selected = ref([]), pending = ref(false), failure = ref('');
      const selection = () => p.modelValue ?? selected.value;
      const rowIdentity = (row, index) => row?.[p.rowKey] ?? index;
      const choose = (key, checked) => { if (locked() || pending.value) return; const next = selection().filter(value => !Object.is(value, key)); if (checked) next.push(key); selected.value = next; emit('update:modelValue', next); };
      return () => {
        const rows = catalogTableRows(p.rows, p.columns, search.value, sortKey.value, direction.value);
        return h('div', { class: 'ir-widget-stack' }, [
          p.searchable ? h('label', { class: 'ir-widget-field' }, [text('search'), h('input', { type: 'search', class: 'ir-widget-input', value: search.value, onInput: event => { search.value = event.target.value; } })]) : null,
          h('div', { class: 'ir-widget-scroll' }, [h('table', { class: 'ir-widget-table' }, [
            h('caption', null, p.caption || text('table')),
            h('thead', null, [h('tr', null, [p.selectable ? h('th', { scope: 'col' }, text('select')) : null, ...p.columns.map(column => h('th', { key: column.key, scope: 'col', 'aria-sort': sortKey.value === column.key ? direction.value > 0 ? 'ascending' : 'descending' : 'none' }, [button(column.label || column.key, { onClick: () => { direction.value = sortKey.value === column.key ? -direction.value : 1; sortKey.value = column.key; } })]))])]),
            h('tbody', null, rows.length ? rows.map(({ row, index }) => { const key = rowIdentity(row, index); return h('tr', { key }, [p.selectable ? h('td', null, [h('input', { type: 'checkbox', checked: selection().some(value => Object.is(value, key)), disabled: locked() || pending.value, 'aria-label': `${text('select')} ${key}`, onChange: event => choose(key, event.target.checked) })]) : null, ...p.columns.map(column => h('td', { key: column.key }, String(row?.[column.key] ?? '')))]); }) : [h('tr', null, [h('td', { colspan: p.columns.length + (p.selectable ? 1 : 0) }, text('noData'))])]),
          ])]),
          p.rows.length > 500 ? note(text('rowLimit')) : null,
          p.selectable && p.sendSelection ? button(p.sendLabel || text('sendSelection'), { disabled: locked() || pending.value, onClick: async () => {
            if (locked() || pending.value) return; pending.value = true; failure.value = '';
            try { const keys = catalogClone(selection()); await context.reply({ selection: keys }, `${text('selected')}: ${keys.join(', ')}`.slice(0, 2000)); } catch { failure.value = text('formError'); } finally { pending.value = false; }
          } }) : null, failure.value ? h('div', { role: 'alert' }, failure.value) : null,
        ]);
      };
    },
  };

  const chart = kind => ({
    name: kind, props: { data: { type: Array, default: () => [] }, title: String, description: String },
    setup(p) {
      const id = `ir-chart-${useId()}`;
      return () => {
        const data = catalogChartData(p.data), title = p.title || text('chart'), description = p.description || `${data.length} ${text('dataPoints')}`;
        const shapes = [];
        if (kind === 'Line') {
          const points = catalogLinePoints(data);
          shapes.push(h('polyline', { class: 'ir-widget-line', points: points.map(point => point.join(',')).join(' ') }));
          points.forEach(([cx, cy], index) => shapes.push(h('circle', { key: index, class: 'ir-widget-dot', cx, cy, r: 2 }, [h('title', null, `${data[index].label}: ${data[index].value}`)])));
        } else if (kind === 'Bars') {
          const scale = Math.max(1, ...data.map(item => Math.abs(item.value))), min = Math.min(0, ...data.map(item => item.value / scale)), max = Math.max(0, ...data.map(item => item.value / scale)), span = max - min || 1, zero = 10 + (0 - min) * 280 / span;
          data.forEach((item, index) => { const x = 10 + (item.value / scale - min) * 280 / span; shapes.push(h('rect', { key: index, class: 'ir-widget-bar', x: Math.min(x, zero), y: index * 20 + 5, width: Math.abs(x - zero), height: 14 }, [h('title', null, `${item.label}: ${item.value}`)])); });
        } else {
          const scale = Math.max(1, ...data.map(item => item.value)), total = data.reduce((sum, item) => sum + Math.max(0, item.value) / scale, 0), circumference = 2 * Math.PI * 32;
          shapes.push(h('circle', { class: 'ir-widget-track', cx: 50, cy: 50, r: 40 }));
          let offset = 0;
          data.forEach((item, index) => { const length = total ? (Math.max(0, item.value) / scale) / total * circumference : 0; shapes.push(h('circle', { key: index, class: 'ir-widget-slice', cx: 50, cy: 50, r: 32, 'stroke-dasharray': `${length} ${circumference - length}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 50 50)' }, [h('title', null, `${item.label}: ${item.value}`)])); offset += length; });
        }
        return h('figure', { class: 'ir-widget-chart' }, [
          h('figcaption', { class: 'ir-widget-title' }, title),
          h('svg', { class: 'ir-widget-svg', viewBox: kind === 'Donut' ? '0 0 100 100' : kind === 'Bars' ? `0 0 300 ${Math.max(30, data.length * 20)}` : '0 0 300 100', role: 'img', 'aria-labelledby': `${id}-title ${id}-desc` }, [h('title', { id: `${id}-title` }, title), h('desc', { id: `${id}-desc` }, description), ...shapes]),
          note(description), !data.length ? note(text('noData')) : null,
          p.data.length > 200 ? note(text('chartLimit')) : null,
          h('details', null, [h('summary', null, text('chartData')), h('div', { class: 'ir-widget-scroll' }, [h('table', { class: 'ir-widget-table' }, [h('caption', null, title), h('thead', null, [h('tr', null, [h('th', { scope: 'col' }, text('label')), h('th', { scope: 'col' }, text('value'))])]), h('tbody', null, data.map((item, index) => h('tr', { key: index }, [h('th', { scope: 'row' }, item.label), h('td', null, String(item.value))])))])])]),
        ]);
      };
    },
  });
  components.Bars = chart('Bars'); components.Line = chart('Line'); components.Donut = chart('Donut');
  for (const [name, component] of Object.entries(components)) app.component(name, component);
  return components;
}
