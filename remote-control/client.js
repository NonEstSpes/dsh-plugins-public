window.__ModuleLoader__.load({
  id: '@local/dsh-remote-control',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const CLIENT_VERSION = '0.1.5';
    const dictionaries = {
      en: { title: 'Remote Control', refresh: 'Refresh', reload: 'Reload configuration', setup: 'Pairing is not configured. Generate endpoint configs and set settingsFile in this plugin’s configuration. No remote connection is opened yet.', project: 'Allowed project', session: 'Remote session', task: 'Task or follow-up', create: 'Create session + task', send: 'Send follow-up', cancel: 'Request cancellation', empty: 'No remote sessions linked to this chat', reports: 'Reports', open: 'Read report', safe: 'Preview: no publishing, file transfer or remote approval. Worker tools default to none.', pending: 'Saved locally, not yet proof of remote execution', transport: 'Transport', busy: 'Working…', noRemote: 'The DSH command channel is unavailable', notification: 'New reports are stored on this device. Chat processing requires delivery=wake in the manually approved controller configuration.' },
      ru: { title: 'Удалённые сессии', refresh: 'Обновить', reload: 'Перечитать конфигурацию', setup: 'Сопряжение не настроено. Создайте конфигурации устройств и задайте settingsFile в настройках плагина. Удалённое соединение пока не открывается.', project: 'Разрешённый проект', session: 'Удалённая сессия', task: 'Задача или уточнение', create: 'Создать сессию и задачу', send: 'Отправить уточнение', cancel: 'Запросить отмену', empty: 'К этому чату ещё не привязаны удалённые сессии', reports: 'Отчёты', open: 'Прочитать отчёт', safe: 'Первый этап: без публикации кода, передачи файлов и удалённых подтверждений. По умолчанию инструменты Worker отключены.', pending: 'Сохранено локально; это ещё не подтверждение удалённого выполнения', transport: 'Транспорт', busy: 'Выполняется…', noRemote: 'Канал команд DSH недоступен', notification: 'Новые отчёты сохраняются на этом устройстве. Обработка в чате включается через delivery=wake в конфигурации Controller, согласованной вручную.' },
    };
    function decodeCommandResult(rpc) {
      if (rpc?.ok !== true) throw new Error(rpc?.error?.message || 'DSH RPC failed');
      const result = rpc.value?.result;
      if (!result || result.kind !== 'success') throw new Error(result?.text || 'Command failed');
      if (typeof result.text !== 'string') throw new Error('Command returned no JSON text');
      return JSON.parse(result.text);
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply(ctx) {
        // Resolve the full traced namespace before mounting UI, not on the first click.
        const commandRemote = ctx.remote.commands;
        if (typeof commandRemote.execute !== 'function') throw new Error('DSH command RPC is unavailable');
        for (const [language, dict] of Object.entries(dictionaries)) ctx.effect(() => ctx.locale.register('remote-control', language, dict));
        const t = ctx.locale.bind('remote-control');
        function RemotePanel(props) {
          React.useSyncExternalStore(ctx.locale.subscribe.bind(ctx.locale), ctx.locale.getSnapshot.bind(ctx.locale));
          const [state, setState] = React.useState(null);
          const [result, setResult] = React.useState(null);
          const [problem, setProblem] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const [project, setProject] = React.useState('');
          const [session, setSession] = React.useState('');
          const [task, setTask] = React.useState('');
          const [wake, setWake] = React.useState(false);
          const pending = React.useRef(null);
          React.useEffect(() => () => pending.current?.abort(), []);
          React.useEffect(() => { pending.current?.abort(); setState(null); setResult(null); setSession(''); setProblem(''); setWake(false); setBusy(false); }, [props.sessionId]);
          const box = { padding: '12px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', fontSize: '13px', lineHeight: 1.5 };
          const control = { boxSizing: 'border-box', padding: '7px 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: '7px', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' };
          async function command(input, reload = false) {
            pending.current?.abort();
            const abort = new AbortController(); pending.current = abort;
            setBusy(true); setProblem('');
            try {
              const rpc = await commandRemote.execute(props.sessionId, reload ? '/remote-reload' : `/remote-control ${JSON.stringify(input)}`, [], abort.signal);
              if (abort.signal.aborted) return;
              const value = decodeCommandResult(rpc);
              if (reload || (input.action === 'status' && !input.sessionId)) {
                setState(value);
                if (!project && value.projects?.length) setProject(value.projects[0]);
              } else {
                setResult(value);
                if (value.sessionId) setSession(value.sessionId);
              }
            } catch (error) { if (!abort.signal.aborted) setProblem(error.message); }
            finally { if (!abort.signal.aborted) setBusy(false); }
          }
          const button = (label, action) => h('button', { type: 'button', style: { ...control, cursor: busy ? 'wait' : 'pointer', opacity: busy ? 0.6 : 1 }, disabled: busy, onClick: action }, label);
          const row = (...children) => h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', marginTop: '8px' } }, ...children);
          return h('details', { style: { width: '100%', marginTop: '8px' } },
            h('summary', { style: { cursor: 'pointer', color: 'var(--dsw-alias-label-secondary)', padding: '6px 0' } }, `${t('title')} · ${CLIENT_VERSION}`),
            h('section', { style: box, 'aria-label': t('title'), 'aria-busy': busy },
              h('p', { style: { margin: '0 0 8px', color: 'var(--dsw-alias-label-secondary)' } }, t('safe')),
              row(button(t('refresh'), () => command({ action: 'status' })), button(t('reload'), () => command({}, true)), busy && h('span', { role: 'status' }, t('busy'))),
              problem && h('p', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', overflowWrap: 'anywhere' } }, problem),
              state && !state.configured && h('p', null, t('setup')),
              state?.error && h('p', { role: 'status' }, state.error),
              state?.configured && h(React.Fragment, null,
                h('p', null, `${state.node} → ${state.peer} · ${state.role}`),
                h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, `${t('transport')}: ${JSON.stringify(state.transport || {})}`),
                state.role === 'controller' && h(React.Fragment, null,
                  h('label', null, t('project'), h('select', { value: project, disabled: busy, onChange: event => setProject(event.target.value), style: { ...control, display: 'block', width: '100%', marginTop: '4px' } }, h('option', { value: '' }, '—'), ...(state.projects || []).map(id => h('option', { key: id, value: id }, id)))),
                  h('label', { style: { display: 'block', marginTop: '8px' } }, t('session'), h('select', { value: session, disabled: busy, onChange: event => setSession(event.target.value), style: { ...control, display: 'block', width: '100%', marginTop: '4px' } }, h('option', { value: '' }, '—'), ...(state.sessions || []).map(item => h('option', { key: item.sessionId, value: item.sessionId }, `${item.projectId} · ${item.status} · ${item.sessionId}`)))),
                  !(state.sessions || []).length && h('p', null, t('empty')),
                  h('label', { style: { display: 'block', marginTop: '8px' } }, t('task'), h('textarea', { value: task, disabled: busy, maxLength: 16000, rows: 4, onChange: event => setTask(event.target.value), style: { ...control, width: '100%', resize: 'vertical', marginTop: '4px' } })),
                  state.deliveryAllowed && h('label', { style: { display: 'block', marginTop: '8px' } }, h('input', { type: 'checkbox', checked: wake, disabled: busy, onChange: event => setWake(event.target.checked) }), ' ', ctx.locale.getLocale().active.startsWith('ru') ? 'Доставить отчёт по этой задаче в чат (запустит локальную модель)' : 'Deliver this task’s report to this chat (runs the local model)'),
                  row(button(t('create'), () => command({ action: 'create', projectId: project, text: task, wakeOnReport: wake })), button(t('send'), () => command({ action: 'prompt', sessionId: session, text: task, wakeOnReport: wake })), button(t('cancel'), () => command({ action: 'cancel', sessionId: session }))),
                  h('p', { style: { color: 'var(--dsw-alias-label-secondary)' } }, t('notification')),
                  h('h4', { style: { marginBottom: '4px' } }, t('reports')),
                  ...(state.reports || []).map(report => row(h('span', { key: report.reportId }, `${report.status} · ${report.reportId}`), button(t('open'), () => command({ action: 'report', reportId: report.reportId })))),
                ),
              ),
              result && h('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '320px', overflow: 'auto', padding: '10px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '7px' } }, JSON.stringify(result, null, 2)),
            ),
          );
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({ name: 'conversation.composer.dock', id: 'remote-control', order: 30, label: () => t('title') }, RemotePanel));
      },
    };
  },
});
