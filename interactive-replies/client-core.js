    const h = React.createElement;
    const { createSubmissionFlow } = Submission;
    const { createDraftStore } = Drafts;
    const { prepareComponent, createRuntimeErrorReporter, readExecutionPreference, shouldAutoRun } = Runtime;
    const { validateFields } = Validation;
    const { COMPONENT_CSS } = Components;
    const CSS = `
.ir-card{margin:12px 0;min-width:0;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:16px;font:inherit;line-height:1.5}.ir-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:14px}.ir-heading strong{font-size:15px}.ir-caption,.ir-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.ir-stack{display:flex;flex-direction:column;gap:12px;min-width:0}.ir-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.ir-card p{margin:0}.ir-value{font-variant-numeric:tabular-nums;font-size:22px;font-weight:600;min-width:28px;text-align:center}.ir-card button,.ir-button,.ir-input{font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;box-sizing:border-box}.ir-card button,.ir-button{padding:7px 12px;cursor:pointer;min-height:34px}.ir-card button:hover:enabled{background:var(--dsw-alias-bg-layer-2)}.ir-card button:disabled{opacity:.5;cursor:default}.ir-input{padding:8px 10px;width:100%;min-width:0}.ir-card :focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.ir-card fieldset{margin:0;border:0;padding:0;min-width:0}.ir-note{margin-top:12px;font-size:12px;color:var(--dsw-alias-label-secondary)}.ir-error{border-left:3px solid var(--dsw-alias-state-error-primary);padding:8px 12px;overflow-wrap:anywhere}.ir-card details{margin-top:14px;font-size:12px}.ir-card summary{cursor:pointer;color:var(--dsw-alias-label-secondary)}.ir-card pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;font-size:11px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.ir-submission{margin-top:12px}.ir-controls{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:12px}.ir-execution{display:flex;align-items:center;justify-content:flex-end;gap:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.ir-revision{padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin-bottom:12px}.ir-error-list{margin:4px 0;padding-left:20px}
` + COMPONENT_CSS;
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const startedAt = Date.now();
        const locale = ctx.get('locale');
        const disposers = [];
        for (const [language, dict] of Object.entries(dictionaries)) disposers.push(locale.register('local-interactive-replies', language, dict));
        const translate = locale.bind('local-interactive-replies');
        const preferences = new Map();
        const preferenceListeners = new Set();
        function executionPreference(sessionId) {
          if (!preferences.has(sessionId)) {
            preferences.set(sessionId, readExecutionPreference({ getItem: key => window.localStorage.getItem(key) }, sessionId));
          }
          return preferences.get(sessionId);
        }
        function setExecutionPreference(sessionId, enabled) {
          preferences.set(sessionId, enabled);
          try { window.localStorage.setItem('local.interactive-replies.execution:' + sessionId, enabled ? 'auto' : 'paused'); } catch {}
          for (const fn of preferenceListeners) fn();
        }
        function useText() {
          React.useSyncExternalStore(fn => locale.subscribe(fn), () => locale.getSnapshot());
          return translate;
        }
        function Card({ item, sessionId, allowed, autoRunNew }) {
          const t = useText();
          const latest = item.spec;
          const [visible, setVisible] = React.useState(latest);
          React.useEffect(() => {
            setVisible(previous => (previous.revision ?? 1) === (latest.revision ?? 1) ? latest : previous);
          }, [latest]);
          const id = visible.id ?? visible.callId;
          const revision = visible.revision ?? 1;
          const version = visible.schemaVersion === 2 ? 2 : 1;
          const latestRevision = latest.revision ?? 1;
          const stale = latestRevision !== revision;
          const inherited = visible.sessionId !== sessionId;
          const submission = stale ? (item.history ?? []).find(entry => entry.revision === revision) ?? null : item.submission;
          const currentData = version === 2 ? (stale ? visible.data : latest.data) : null;
          const title = stale ? visible.title : latest.title;
          const hostRef = React.useRef(null);
          const runtimeDraftRef = React.useRef(null);
          const mounted = React.useRef(false);
          const listeners = React.useRef(new Set());
          const bridgeState = React.useRef({});
          const [active, setActive] = React.useState(() => shouldAutoRun(visible, { sessionId, submission, startedAt, enabled: autoRunNew }));
          const [generation, setGeneration] = React.useState(0);
          const [error, setError] = React.useState('');
          const [fieldErrors, setFieldErrors] = React.useState([]);
          const [draftError, setDraftError] = React.useState('');
          const [journalState, setJournalState] = React.useState({ status: 'idle', journal: null });
          const [runtimeFailed, setRuntimeFailed] = React.useState(false);
          bridgeState.current = { submission, inherited, stale, allowed, status: journalState.status, data: currentData };
          const storage = React.useMemo(() => ({
            getItem: key => window.localStorage.getItem(key),
            setItem: (key, value) => window.localStorage.setItem(key, value),
            removeItem: key => window.localStorage.removeItem(key),
          }), []);
          const flow = React.useMemo(() => createSubmissionFlow({
            storage, uuid: () => window.crypto.randomUUID(), sessionId, callId: visible.callId, id, revision, version,
            lock: (key, operation) => {
              if (!window.navigator.locks?.request) throw new Error('unavailable');
              return window.navigator.locks.request(key, { ifAvailable: true }, lock => lock ? operation() : { accepted: false, reason: 'sending' });
            },
            canSend: () => {
              const now = bridgeState.current;
              return now.allowed && !now.inherited && now.submission === null;
            },
            send: async request => {
              let clientTimeZone;
              try { clientTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch {}
              if (version === 1) {
                const remote = ctx.get('remote.session');
                if (!remote) throw new Error('unavailable');
                return remote.prompt({ requestId: request.requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: request.text }], ...(clientTimeZone ? { clientTimeZone } : {}) });
              }
              const response = await window.fetch('/api/interactive-replies/submit', {
                method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId: request.requestId, envelope: JSON.parse(request.text), ...(clientTimeZone ? { clientTimeZone } : {}) }),
                signal: AbortSignal.timeout(30000),
              });
              let value;
              try { value = await response.json(); } catch { throw new Error('unavailable'); }
              if (response.ok && value?.accepted === true) return { ok: true, value };
              return {
                ok: false, definitive: response.status < 500 && value?.accepted === false && value?.definitive === true,
                error: { code: value?.code, message: value?.code ?? 'unavailable', errors: value?.errors },
              };
            },
          }), [sessionId, id, revision, version]);
          const currentFlow = React.useRef(flow);
          currentFlow.current = flow;
          const refreshJournal = React.useCallback(() => {
            if (!mounted.current || currentFlow.current !== flow) return;
            try { setJournalState(flow.snapshot()); }
            catch (err) { setError(t(err.message === 'storage' ? 'storage' : 'tooLarge')); }
          }, [flow]);
          React.useEffect(() => {
            mounted.current = true;
            refreshJournal();
            const onStorage = event => { if (event.key === flow.key) refreshJournal(); };
            window.addEventListener('storage', onStorage);
            return () => { mounted.current = false; window.removeEventListener('storage', onStorage); };
          }, [flow, refreshJournal]);
          React.useEffect(() => { for (const listener of listeners.current) listener(); }, [submission, inherited, stale, allowed, journalState.status, currentData]);
          const submit = React.useCallback(async (values, summary, retry = false) => {
            const now = bridgeState.current;
            if (now.inherited || now.submission || !now.allowed || (now.stale && !retry)) { if (mounted.current) setError(t(now.stale ? 'stale' : 'unavailable')); return false; }
            // Projector-style soft user-activation gate, NOT a security boundary.
            if (window.navigator.userActivation?.isActive === false) { if (mounted.current) setError(t('gesture')); return false; }
            const check = validateFields(visible.fields ?? [], values);
            if (!check.ok && !retry) { setFieldErrors(check.errors); setError(t('checkFields')); return false; }
            try {
              setFieldErrors([]);
              setJournalState(previous => ({ ...previous, status: 'sending' }));
              const result = await flow.submit(values, summary);
              if (mounted.current && currentFlow.current === flow) setError(result.reason === 'sending' ? t('otherWindowSending') : '');
              return result.accepted;
            } catch (err) {
              if (mounted.current && currentFlow.current === flow) {
                const key = ['storage', 'tooLarge', 'unavailable', 'stale', 'validation', 'already-submitted', 'invalid', 'invalid-request', 'foreign-session', 'not-found', 'invalid-envelope', 'missing-card', 'stale-revision', 'invalid-values', 'already-admitted', 'projection-unavailable', 'session-unavailable', 'invalid-time-zone', 'invalid-content-type', 'request-too-large', 'invalid-json'].includes(err.code ?? err.message) ? err.code ?? err.message : null;
                setError(key ? t(key) : String(err.message));
                if (Array.isArray(err.errors)) setFieldErrors(err.errors);
              }
              return false;
            } finally { refreshJournal(); }
          }, [flow, refreshJournal, visible.fields]);
          const submitRef = React.useRef(submit);
          submitRef.current = submit;
          React.useEffect(() => {
            if (!active || !hostRef.current) return;
            let app;
            let disposed = false;
            let pendingDraft = null;
            let draftTimer;
            let draftDisabled = false;
            const draftStore = createDraftStore({ storage, sessionId, id, revision });
            const draftControl = { discard() { draftDisabled = true; pendingDraft = null; clearTimeout(draftTimer); } };
            runtimeDraftRef.current = draftControl;
            const reportDraft = err => { if (!disposed && mounted.current) setDraftError(t(['draftStorage', 'draftCorrupt', 'draftConflict'].includes(err.message) ? err.message : 'tooLarge')); };
            const flushDraft = () => {
              clearTimeout(draftTimer);
              if (pendingDraft === null || draftDisabled) return;
              const value = pendingDraft; pendingDraft = null;
              if (!window.navigator.locks?.request) { reportDraft(new Error('draftStorage')); return; }
              window.navigator.locks.request(draftStore.key, () => draftStore.save(value)).catch(err => { draftDisabled = true; reportDraft(err); });
            };
            const bridge = {
              t,
              isReadonly() { const now = bridgeState.current; return now.inherited || now.stale || !now.allowed || now.submission !== null || now.status !== 'idle'; },
              getSubmission() { return bridgeState.current.submission; },
              getData() { return bridgeState.current.data; },
              subscribe(fn) { listeners.current.add(fn); return () => listeners.current.delete(fn); },
              reply: (data, summary) => disposed ? Promise.resolve(false) : submitRef.current(data, summary),
              loadDraft() { try { return draftStore.load(); } catch (err) { draftDisabled = true; reportDraft(err); return {}; } },
              saveDraft(value) {
                if (inherited || bridgeState.current.submission || draftDisabled) return;
                try { pendingDraft = Submission.cloneReply(value); } catch (err) { reportDraft(err); return; }
                clearTimeout(draftTimer); draftTimer = setTimeout(flushDraft, 250);
              },
              flushDraft,
            };
            try {
              app = Vue.createApp(prepareComponent(Vue, visible, bridge));
              app.config.idPrefix = 'ir-' + encodeURIComponent(sessionId + '|' + id + '|' + revision) + '-';
              app.config.errorHandler = createRuntimeErrorReporter(message => {
                if (disposed) return;
                setError(message); setRuntimeFailed(true);
              });
              app.mount(hostRef.current);
            } catch (err) { setError(String(err?.message ?? err)); setRuntimeFailed(true); }
            return () => {
              if (app) { try { app.unmount(); } catch (err) { console.error('[interactive-replies] cleanup', err); } }
              flushDraft(); clearTimeout(draftTimer); disposed = true;
              if (runtimeDraftRef.current === draftControl) runtimeDraftRef.current = null;
            };
          }, [active, generation, sessionId, id, revision]);
          React.useEffect(() => { if (runtimeFailed) setActive(false); }, [runtimeFailed]);
          const blocked = inherited || stale || !allowed || submission !== null || journalState.status !== 'idle';
          const persistedSubmission = submission ?? (journalState.status === 'sent' ? { values: journalState.journal?.envelope.values, summary: journalState.journal?.envelope.summary } : null);
          const start = () => { setRuntimeFailed(false); setError(''); setDraftError(''); setActive(true); setGeneration(value => value + 1); };
          const adoptRevision = () => { setActive(false); setRuntimeFailed(false); setError(''); setFieldErrors([]); setDraftError(''); setVisible(latest); setGeneration(value => value + 1); };
          const clearDraft = () => {
            runtimeDraftRef.current?.discard();
            setActive(false);
            const store = createDraftStore({ storage, sessionId, id, revision });
            window.navigator.locks?.request(store.key, () => store.clear()).then(() => { if (mounted.current && currentFlow.current === flow) { setDraftError(''); setGeneration(value => value + 1); } }).catch(err => { if (mounted.current && currentFlow.current === flow) setDraftError(t('draftStorage')); });
          };
          const fieldLabel = name => (visible.fields ?? []).find(field => field.name === name)?.label ?? name;
          return h('section', { className: 'ir-card', 'data-interactive-reply': id, 'data-ui-revision': revision, 'aria-label': title },
            h('style', null, CSS),
            h('header', { className: 'ir-heading' }, h('strong', null, title), h('span', { className: 'ir-caption' }, t('runtime') + ' · v' + PLUGIN_VERSION + ' · ' + t('revision') + ' ' + revision)),
            stale ? h('div', { className: 'ir-revision ir-stack', role: 'status' },
              h('p', null, t('newRevision') + ' ' + latestRevision + '. ' + t('revisionNotice')),
              h('div', null, h('button', { type: 'button', disabled: journalState.status === 'sending' || (journalState.status === 'pending' && !submission), onClick: adoptRevision }, t('applyRevision')))) : null,
            inherited ? h('p', { className: 'ir-muted' }, t('inherited')) : null,
            !active && !persistedSubmission ? h('div', { className: 'ir-stack' }, h('p', { className: 'ir-muted' }, runtimeFailed ? t('runtimeStopped') : t('history')),
              h('div', null, h('button', { type: 'button', disabled: stale, onClick: start }, t('run')))) : null,
            active ? h(version === 1 ? 'fieldset' : 'div', version === 1 ? { disabled: blocked } : {}, h('div', { ref: hostRef, className: 'ir-runtime' })) : null,
            active && !persistedSubmission ? h('div', { className: 'ir-controls' }, h('button', { type: 'button', onClick: () => setActive(false) }, t('pause'))) : null,
            persistedSubmission ? h('div', { className: 'ir-submission', role: 'status' }, h('strong', null, t('sent')),
              persistedSubmission.summary ? h('p', null, persistedSubmission.summary) : null,
              h('details', null, h('summary', null, 'JSON'), h('pre', null, JSON.stringify(persistedSubmission.values, null, 2))),
              !active ? h('button', { type: 'button', disabled: stale, onClick: start }, t('runReadonly')) : null) : null,
            journalState.status === 'sending' ? h('p', { className: 'ir-note', role: 'status' }, t('sending')) : null,
            journalState.status === 'pending' && !submission ? h('div', { className: 'ir-controls' }, h('span', { className: 'ir-muted' }, t('pending')),
              h('button', { type: 'button', disabled: inherited || !allowed, onClick: () => submit(journalState.journal.envelope.values, journalState.journal.envelope.summary, true) }, t('retry'))) : null,
            error ? h('div', { className: 'ir-error', role: 'alert' }, h('p', null, t('error') + ': ' + error),
              fieldErrors.length ? h('ul', { className: 'ir-error-list' }, fieldErrors.map((err, index) => h('li', { key: index }, fieldLabel(err.name) + ': ' + t('validation.' + err.code)))) : null) : null,
            draftError ? h('p', { className: 'ir-error', role: 'alert' }, draftError) : null,
            !persistedSubmission && !inherited ? h('div', { className: 'ir-controls' }, h('button', { type: 'button', disabled: journalState.status !== 'idle', onClick: clearDraft }, t('clearDraft')), h('span', { className: 'ir-muted' }, t('draftNotice'))) : null,
            item.history?.length ? h('details', null, h('summary', null, t('previousReplies')), item.history.map((entry, index) => h('div', { key: index, className: 'ir-note' }, t('revision') + ' ' + entry.revision + ': ' + entry.summary))) : null,
            h('details', null, h('summary', null, t('source')), h('pre', null, visible.template + '\n\n<script>\n' + visible.script + '\n</script>'), h('pre', null, JSON.stringify({ data: currentData, fields: visible.fields ?? [] }, null, 2))),
            h('footer', { className: 'ir-note' }, t('trusted')),
          );
        }
        function TurnReplies(props) {
          const t = useText();
          const projection = props.useProjection('localInteractiveReplies');
          const allowed = props.useAccess('session/prompt');
          const autoRunNew = React.useSyncExternalStore(fn => { preferenceListeners.add(fn); return () => preferenceListeners.delete(fn); }, () => executionPreference(props.sessionId));
          if (!projection || !Array.isArray(projection.items)) return null;
          const items = projection.items.filter(item => (item.spec.anchorTurn ?? item.spec.turn) === props.turn.turn);
          if (!items.length) return null;
          return h('div', { className: 'ir-stack', 'data-interactive-replies-version': PLUGIN_VERSION },
            h('label', { className: 'ir-execution' }, h('input', { type: 'checkbox', checked: autoRunNew, onChange: event => setExecutionPreference(props.sessionId, event.target.checked) }), t('autoRunNew')),
            items.map(item => h(Card, { key: item.spec.id ?? item.spec.callId, item, sessionId: props.sessionId, allowed, autoRunNew })));
        }
        const disposeSlot = ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'local-interactive-replies@' + PLUGIN_VERSION, order: 10 }, TurnReplies));
        ctx.effect(() => () => { disposeSlot(); for (const dispose of disposers) dispose(); preferenceListeners.clear(); preferences.clear(); });
      },
    };
