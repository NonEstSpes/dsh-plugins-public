// Shared Host/browser validation. No runtime dependencies or code evaluation.
export const MAX_JSON_BYTES = 65536;
export const MAX_FIELDS = 64;
export const FIELD_TYPES = Object.freeze(['text', 'textarea', 'number', 'slider', 'select', 'radio', 'checks', 'switch', 'date', 'time', 'segmented']);
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const dangerous = key => ['__proto__', 'prototype', 'constructor'].includes(key);
const bytes = text => new TextEncoder().encode(text).length;

/** Strict JSON clone, bounded by UTF-8 bytes, depth and nodes; throws on invalid input. */
export function cloneJsonBounded(value, maxBytes = MAX_JSON_BYTES) {
  const seen = new Set();
  let nodes = 0;
  function visit(current, depth) {
    if (++nodes > 16384 || depth > 32) throw new TypeError('JSON nesting/node limit exceeded');
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number' && Number.isFinite(current)) return;
    if (typeof current !== 'object' || (!Array.isArray(current) && !isRecord(current)) || seen.has(current)) throw new TypeError('Expected finite plain JSON');
    seen.add(current);
    if (Object.getOwnPropertySymbols(current).length || Reflect.ownKeys(current).some(key => !(Array.isArray(current) && key === 'length') && Object.getOwnPropertyDescriptor(current, key)?.enumerable !== true)) throw new TypeError('Expected enumerable JSON keys');
    for (const key of Object.keys(current)) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new TypeError('JSON accessors are not supported');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(current) && (Object.keys(current).length !== current.length || Object.keys(current).some((key, index) => key !== String(index)))) throw new TypeError('Expected dense JSON array');
    seen.delete(current);
  }
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (encoded === undefined || bytes(encoded) > maxBytes) throw new TypeError('JSON byte limit exceeded');
  return JSON.parse(encoded);
}

const optionValue = option => isRecord(option) ? option.value : option;
const scalar = value => typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
const choiceTypes = new Set(['select', 'radio', 'checks', 'segmented']);
const numericTypes = new Set(['number', 'slider']);
const stringTypes = new Set(['text', 'textarea', 'date', 'time']);

/** Canonical detached fields. An empty list means an unstructured JSON reply. */
export function normalizeFields(fields = []) {
  const result = cloneJsonBounded(fields);
  if (!Array.isArray(result) || result.length > MAX_FIELDS) throw new TypeError('fields must contain at most 64 entries');
  const names = new Set();
  const allowed = new Set(['name', 'type', 'label', 'description', 'hint', 'placeholder', 'disabled', 'required', 'options', 'min', 'max', 'step', 'minLength', 'maxLength', 'initial']);
  for (const field of result) {
    if (!isRecord(field) || Object.keys(field).some(key => !allowed.has(key)) || typeof field.name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(field.name) || dangerous(field.name) || names.has(field.name) || !FIELD_TYPES.includes(field.type)) throw new TypeError('Invalid or duplicate field name/type');
    names.add(field.name);
    for (const key of ['label', 'description', 'hint', 'placeholder']) if (Object.hasOwn(field, key) && (typeof field[key] !== 'string' || field[key].length > 2000)) throw new TypeError('Invalid field text');
    for (const key of ['required', 'disabled']) if (Object.hasOwn(field, key) && typeof field[key] !== 'boolean') throw new TypeError('Invalid field flag');
    for (const key of ['min', 'max', 'step']) if (Object.hasOwn(field, key) && (!numericTypes.has(field.type) || typeof field[key] !== 'number' || !Number.isFinite(field[key]) || (key === 'step' && field[key] <= 0))) throw new TypeError('Invalid numeric constraint');
    if (field.min !== undefined && field.max !== undefined && field.min > field.max) throw new TypeError('Invalid numeric range');
    for (const key of ['minLength', 'maxLength']) if (Object.hasOwn(field, key) && (!stringTypes.has(field.type) || !Number.isSafeInteger(field[key]) || field[key] < 0 || field[key] > MAX_JSON_BYTES)) throw new TypeError('Invalid length constraint');
    if (field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength) throw new TypeError('Invalid string range');
    if (choiceTypes.has(field.type)) {
      if (!Array.isArray(field.options) || !field.options.length || field.options.length > 128) throw new TypeError('Choice fields require 1–128 options');
      const choices = new Set();
      for (const option of field.options) {
        const value = optionValue(option);
        if (!scalar(value) || (isRecord(option) && (Object.keys(option).some(key => !['value', 'label'].includes(key)) || typeof option.label !== 'string' || option.label.length > 2000))) throw new TypeError('Invalid choice option');
        const key = JSON.stringify(value);
        if (choices.has(key)) throw new TypeError('Duplicate choice option');
        choices.add(key);
      }
    } else if (Object.hasOwn(field, 'options')) throw new TypeError('Options require a choice field');
    if (Object.hasOwn(field, 'initial') && valueErrors(field, field.initial).length) throw new TypeError('Invalid field initial value');
  }
  return result;
}

function valueErrors(field, value) {
  const errors = [];
  const add = code => errors.push({ name: field.name, code });
  if (value === undefined) { if (field.required) add('required'); return errors; }
  if (stringTypes.has(field.type)) {
    if (typeof value !== 'string') { add('type'); return errors; }
    if (field.required && !value.trim()) add('required');
    if (field.minLength !== undefined && value.length < field.minLength) add('minLength');
    if (field.maxLength !== undefined && value.length > field.maxLength) add('maxLength');
    if (value && field.type === 'date') {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) add('date');
    }
    if (value && field.type === 'time' && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) add('time');
  } else if (numericTypes.has(field.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) { add('type'); return errors; }
    if (field.min !== undefined && value < field.min) add('min');
    if (field.max !== undefined && value > field.max) add('max');
    if (field.step !== undefined) {
      const steps = (value - (field.min ?? 0)) / field.step;
      if (!Number.isFinite(steps) || Math.abs(steps - Math.round(steps)) > Math.min(1e-7, Number.EPSILON * 8 * Math.max(1, Math.abs(steps)))) add('step');
    }
  } else if (field.type === 'switch') {
    if (typeof value !== 'boolean') add('type');
  } else if (choiceTypes.has(field.type)) {
    const options = field.options.map(optionValue);
    if (field.type === 'checks') {
      if (!Array.isArray(value) || value.some(item => !options.some(option => Object.is(option, item))) || new Set(value.map(item => JSON.stringify(item))).size !== value.length) add('option');
      else if (field.required && value.length === 0) add('required');
    } else if (!options.some(option => Object.is(option, value))) add('option');
  }
  return errors;
}

export function validateFields(fields, values) {
  let normalized;
  try { normalized = normalizeFields(fields); cloneJsonBounded(values); } catch { return { ok: false, errors: [{ name: '', code: 'schema' }] }; }
  if (!normalized.length) return { ok: true, errors: [] };
  if (!isRecord(values)) return { ok: false, errors: [{ name: '', code: 'type' }] };
  const known = new Set(normalized.map(field => field.name));
  const errors = Object.keys(values).filter(name => !known.has(name)).map(name => ({ name, code: 'unknown' }));
  for (const field of normalized) errors.push(...valueErrors(field, Object.hasOwn(values, field.name) ? values[field.name] : undefined));
  return { ok: errors.length === 0, errors };
}
