import { registerComponents } from './components.js';
import { cloneReply } from './submission.js';
import { validateFields } from './validation.js';

// User-authorized profile default. Explicit saved per-Session choices take precedence.
export const AUTO_RUN_NEW_DEFAULT = true;
export function readExecutionPreference(storage, sessionId) {
  try {
    const saved = storage.getItem('local.interactive-replies.execution:' + sessionId);
    return saved === null ? AUTO_RUN_NEW_DEFAULT : saved === 'auto';
  } catch { return false; }
}
export function shouldAutoRun(spec, { sessionId, submission, startedAt, enabled }) {
  return enabled === true && spec.sessionId === sessionId && submission === null
    && (spec.revision ?? 1) === 1 && spec.createdAt >= startedAt;
}

// Trusted page-context browser code, deliberately NOT a security sandbox.
export function compileSetup(Vue, script) {
  if (typeof script !== 'string' || script.length > 65536) throw new Error('Invalid script size');
  return new Function('Vue', 'reply', 'onCleanup', 'readonly', 'submitted', 'data', 'draft', 'fields', 'useDraft', 'signal',
    '"use strict";\nconst {ref,reactive,computed,watch,watchEffect,onMounted,onUnmounted,nextTick}=Vue;\n' + script);
}

export function createDraftBinding(Vue, draft, key, initial = null) {
  if (typeof key !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('Invalid draft key');
  if (!Object.hasOwn(draft.custom, key)) draft.custom[key] = cloneReply(initial);
  return Vue.computed({ get: () => draft.custom[key], set: value => { draft.custom[key] = value; } });
}

export function createRuntimeErrorReporter(report) {
  let first = null;
  return error => {
    if (first !== null) return;
    first = String(error?.message ?? error);
    report(first);
  };
}

export function prepareComponent(Vue, spec, bridge) {
  const setupCode = compileSetup(Vue, spec.script);
  // Incomplete/invalid source is never executed. Compilation precedes setup.
  const render = Vue.compile(spec.template);
  return {
    name: 'TrustedInteractiveReply', render,
    setup() {
      const locked = Vue.ref(bridge.isReadonly());
      const submitted = Vue.ref(bridge.getSubmission());
      const data = Vue.shallowRef(bridge.getData ? bridge.getData() : Object.hasOwn(spec, 'data') ? spec.data : {});
      const fields = Vue.shallowRef(spec.fields ?? []);
      const draft = Vue.reactive(bridge.loadDraft?.() ?? {});
      if (!draft.custom || typeof draft.custom !== 'object' || Array.isArray(draft.custom)) draft.custom = {};
      const controller = new AbortController();
      const reply = (values, summary = '') => bridge.reply(values, summary);
      const context = {
        t: key => bridge.t?.(key) ?? key,
        readonly: Vue.readonly(locked), submitted: Vue.readonly(submitted),
        data: Vue.readonly(data), fields: Vue.readonly(fields), draft, reply, validateFields,
      };
      registerComponents(Vue.getCurrentInstance().appContext.app, Vue, context);
      const release = bridge.subscribe(() => {
        locked.value = bridge.isReadonly();
        submitted.value = bridge.getSubmission();
        data.value = bridge.getData ? bridge.getData() : Object.hasOwn(spec, 'data') ? spec.data : {};
      });
      Vue.onUnmounted(() => { controller.abort(); release(); });
      const stopSave = Vue.watch(draft, () => bridge.saveDraft?.(Vue.toRaw(draft)), { deep: true, flush: 'post' });
      Vue.onBeforeUnmount(() => {
        stopSave();
        bridge.saveDraft?.(Vue.toRaw(draft));
        bridge.flushDraft?.();
      });
      const onCleanup = fn => {
        if (typeof fn !== 'function') throw new TypeError('onCleanup expects a function');
        Vue.onUnmounted(fn);
      };
      const useDraft = (key, initial = null) => createDraftBinding(Vue, draft, key, initial);
      const bindings = setupCode(Vue, reply, onCleanup, context.readonly, context.submitted, context.data, draft, context.fields, useDraft, controller.signal);
      if (!bindings || typeof bindings !== 'object' || typeof bindings.then === 'function' || Array.isArray(bindings)) throw new TypeError('Script must synchronously return a setup bindings object');
      return {
        ...bindings, reply, draft, data: context.data, fields: context.fields,
        readonly: context.readonly, submitted: context.submitted,
      };
    },
  };
}
