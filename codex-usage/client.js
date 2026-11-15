window.__ModuleLoader__.load({
  id: '@local/codex-usage',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'local.codex-usage';
    const en = {
      title: 'OpenAI Codex', used: 'used', loading: 'Loading usage…',
      unavailable: 'Usage unavailable', stale: 'Data may be out of date',
      resets: 'Available resets', unknown: 'Not reported', next: 'Next limit renewal',
      renewal: 'Renews', waiting: 'Waiting for updated limits', updated: 'Last checked',
      refresh: 'Refresh', close: 'Close', hours: '{n} h', days: '{n} d',
      window: 'Usage window', summary: 'Highest usage across the main Codex windows.',
      note: 'A reset is spent only after you confirm a specific card.',
      more: 'Details', less: 'Hide', resetCard: 'Limit reset', expires: 'Expires',
      applyReset: 'Apply', retryReset: 'Retry same request', cancel: 'Cancel', confirmReset: 'Confirm reset',
      confirmTitle: 'Apply this reset?', confirmHint: 'This may spend one account-wide reset. OpenAI decides which limits are renewed.',
      retryHint: 'Retry the same card and request. Do not start another reset in Settings or another window.',
      cardsLoading: 'Loading reset cards…', cardsUnavailable: 'Reset details unavailable. Refresh to try again.',
      cardsEmpty: 'No available reset cards.', cardsPartial: 'Some reset cards have no details yet.',
      expired: 'Expired', working: 'Applying…', storageBlocked: 'A saved reset request cannot be read safely. Use the original Codex Settings panel; no new request was sent.',
      result_reset: 'Reset applied. Limits and card count have been refreshed.',
      result_already_redeemed: 'This reset was already applied.', result_no_credit: 'This reset is no longer available.',
      result_nothing_to_reset: 'OpenAI reports that there is nothing to reset.',
      result_unknown: 'The result is uncertain. Retry only the same request below; it will keep its request ID.',
      result_unavailable: 'The reset could not be started. Refresh the card list and try again.',
      result_pending: 'Another reset request is pending. Do not start a new reset in another window.',
      result_account_changed: 'The signed-in account changed. The saved request is locked; return to the original account to retry.',
      result_storage: 'Unable to save the request safely. No reset was sent.',
      result_pending_other: 'There is a saved request for another card. Retry that request first.',
      timezone: 'Time zone', details: 'Subscription limits',
    };
    const ru = {
      title: 'OpenAI Codex', used: 'использовано', loading: 'Загрузка лимитов…',
      unavailable: 'Лимиты недоступны', stale: 'Данные могут быть устаревшими',
      resets: 'Доступные сбросы', unknown: 'Нет данных', next: 'Ближайшее обновление лимита',
      renewal: 'Обновление', waiting: 'Ожидаем обновления лимитов', updated: 'Проверено',
      refresh: 'Обновить', close: 'Закрыть', hours: '{n} ч', days: '{n} д',
      window: 'Окно лимита', summary: 'Максимальное использование среди основных окон Codex.',
      note: 'Сброс расходуется только после подтверждения выбранной карточки.',
      more: 'Подробнее', less: 'Скрыть', resetCard: 'Сброс лимитов', expires: 'Действует до',
      applyReset: 'Применить', retryReset: 'Повторить запрос', cancel: 'Отмена', confirmReset: 'Подтвердить сброс',
      confirmTitle: 'Применить этот сброс?', confirmHint: 'Это может израсходовать один сброс для всего аккаунта. Какие лимиты обновятся, определяет OpenAI.',
      retryHint: 'Повторится тот же запрос для той же карточки. Не запускайте другой сброс в настройках или другом окне.',
      cardsLoading: 'Загрузка карточек сброса…', cardsUnavailable: 'Подробности сбросов недоступны. Нажмите «Обновить», чтобы повторить загрузку.',
      cardsEmpty: 'Доступных карточек сброса нет.', cardsPartial: 'Подробности некоторых сбросов пока недоступны.',
      expired: 'Срок истёк', working: 'Применение…', storageBlocked: 'Не удалось безопасно прочитать сохранённый запрос. Используйте исходную панель Codex в настройках; новый запрос не отправлен.',
      result_reset: 'Сброс применён. Лимиты и число карточек обновлены.',
      result_already_redeemed: 'Этот сброс уже был применён.', result_no_credit: 'Этот сброс больше недоступен.',
      result_nothing_to_reset: 'OpenAI сообщает, что сбрасывать пока нечего.',
      result_unknown: 'Результат не определён. Повторите только тот же запрос ниже — его идентификатор сохранён.',
      result_unavailable: 'Не удалось начать сброс. Обновите список карточек и попробуйте снова.',
      result_pending: 'Другой запрос сброса ещё не завершён. Не запускайте новый сброс в другом окне.',
      result_account_changed: 'Аккаунт изменился. Сохранённый запрос заблокирован; для повтора вернитесь в исходный аккаунт.',
      result_storage: 'Не удалось безопасно сохранить запрос. Сброс не отправлен.',
      result_pending_other: 'Есть сохранённый запрос для другой карточки. Сначала повторите его.',
      timezone: 'Часовой пояс', details: 'Лимиты подписки',
    };
    const zh = {
      title: 'OpenAI Codex', used: '已使用', loading: '正在加载用量…',
      unavailable: '用量不可用', stale: '数据可能已过期', resets: '可用重置次数',
      unknown: '未提供', next: '下次限额更新', renewal: '重置时间',
      waiting: '等待限额更新', updated: '检查时间', refresh: '刷新', close: '关闭',
      hours: '{n} 小时', days: '{n} 天', window: '限额周期',
      summary: '显示 Codex 主要周期中的最高使用率。',
      note: '仅在确认所选卡片后才会使用重置。', timezone: '时区', details: '订阅限额',
      more: '详情', less: '收起', resetCard: '限额重置', expires: '有效期至',
      applyReset: '使用', retryReset: '重试同一请求', cancel: '取消', confirmReset: '确认重置',
      confirmTitle: '使用此重置？', confirmHint: '这可能消耗一次账户级重置。由 OpenAI 决定更新哪些限额。',
      retryHint: '重试相同卡片和请求。请勿在设置或其他窗口开始另一次重置。',
      cardsLoading: '正在加载重置卡片…', cardsUnavailable: '重置详情不可用。请刷新重试。',
      cardsEmpty: '没有可用的重置卡片。', cardsPartial: '部分卡片的详情暂不可用。',
      expired: '已过期', working: '正在使用…', storageBlocked: '无法安全读取已保存的请求。请使用 Codex 设置面板；未发送新请求。',
      result_reset: '重置已使用，限额和数量已刷新。', result_already_redeemed: '此重置已被使用。',
      result_no_credit: '此重置已不可用。', result_nothing_to_reset: 'OpenAI 报告无需重置。',
      result_unknown: '结果不确定。请仅重试下方保留原 ID 的相同请求。',
      result_unavailable: '无法开始重置。请刷新卡片列表后重试。',
      result_pending: '另一个重置请求尚未完成。请勿在其他窗口开始新请求。',
      result_account_changed: '登录账户已更改。请求已锁定；请返回原账户后重试。',
      result_storage: '无法安全保存请求。未发送重置。', result_pending_other: '另一张卡片有已保存的请求。请先重试该请求。',
    };
    const css = `
      .cux-root { display:inline-flex; flex:none; align-items:center; }
      .cux-trigger { width:40px; height:40px; padding:2px; display:inline-grid;
        place-items:center; border:0; border-radius:10px; background:transparent;
        color:var(--dsw-alias-label-primary); cursor:pointer; font:inherit; }
      .cux-trigger:hover { background:var(--dsw-alias-bg-layer-2); }
      .cux-trigger:focus-visible, .cux-action:focus-visible {
        outline:2px solid var(--dsw-alias-brand-primary); outline-offset:2px; }
      .cux-pop { position:fixed; inset:auto; margin:0; padding:18px;
        width:min(320px, calc(100vw - 24px)); box-sizing:border-box;
        max-height:calc(100dvh - 32px); overflow:auto;
        border:1px solid var(--dsw-alias-border-l1); border-radius:16px;
        background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary);
        box-shadow:0 8px 24px color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
        font-family:inherit; font-size:13px; line-height:1.45; }
      .cux-header, .cux-line { display:flex; align-items:center; justify-content:space-between; gap:12px; }
      .cux-title { font-size:14px; font-weight:600; margin:0; }
      .cux-subtitle { color:var(--dsw-alias-label-secondary); font-size:12px; }
      .cux-divider { border:0; border-top:1px solid var(--dsw-alias-border-l1); margin:14px 0; }
      .cux-limit { margin:14px 0; }
      .cux-track { height:5px; border-radius:8px; overflow:hidden;
        background:var(--dsw-alias-bg-layer-2); margin:7px 0; }
      .cux-fill { height:100%; border-radius:inherit; }
      .cux-number { font-variant-numeric:tabular-nums; font-weight:600; white-space:nowrap; }
      .cux-action { border:1px solid var(--dsw-alias-border-l2); border-radius:8px;
        padding:5px 10px; background:transparent; color:var(--dsw-alias-label-primary);
        font:inherit; cursor:pointer; }
      .cux-action:hover { background:var(--dsw-alias-bg-layer-2); }
      .cux-action:disabled { opacity:.6; cursor:wait; }
      .cux-notice { color:var(--dsw-alias-state-warn-primary); font-size:12px; margin:10px 0; }
      .cux-foot { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
      .cux-note { margin:10px 0 0; }
      .cux-reset-actions { display:flex; align-items:center; gap:8px; }
      .cux-reset-list { display:grid; gap:10px; margin-top:12px; }
      .cux-reset-card { border:1px solid var(--dsw-alias-border-l1); border-radius:10px; padding:10px; }
      .cux-reset-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .cux-reset-row .cux-action { flex-shrink:0; }
      .cux-confirm { margin-top:10px; padding-top:10px; border-top:1px solid var(--dsw-alias-border-l1); }
      .cux-confirm-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px; margin-top:10px; }
      .cux-confirm .cux-primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }
      .cux-reset-result { margin:10px 0 0; font-size:12px; }
      .cux-reset-ok { color:var(--dsw-alias-state-success-primary); }
    `;
    const validNumber = n => typeof n === 'number' && Number.isFinite(n);
    const clamp = n => Math.min(100, Math.max(0, n));
    const color = n => n == null ? 'var(--dsw-alias-state-idle-primary)'
      : n >= 90 ? 'var(--dsw-alias-state-error-primary)'
      : n >= 70 ? 'var(--dsw-alias-state-warn-primary)'
      : 'var(--dsw-alias-state-success-primary)';
    // BEGIN RESET FLOW: pure, tested without a browser or real provider calls.
    function createResetFlow({ storage, uuid, redeem }) {
      // Share the provider UI's pending-attempt record, but retain a private
      // journal: an already-open Settings panel can overwrite its shared record.
      // The journal preserves our original UUID across that overwrite/reload.
      const key = 'dsh-openai-codex-auth.pending-reset';
      const journal = 'local.codex-usage.pending-reset';
      const idPattern = /^[A-Za-z0-9_-]{1,200}$/;
      const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      let sending = false;
      const readAt = name => {
        try {
          const raw = storage.getItem(name);
          if (!raw) return null;
          const value = JSON.parse(raw);
          if (typeof value?.creditId !== 'string' || !idPattern.test(value.creditId) || typeof value.idempotencyKey !== 'string' || !uuidPattern.test(value.idempotencyKey)) return { legacy:true };
          return { creditId:value.creditId, idempotencyKey:value.idempotencyKey,
            expiresAt:typeof value.expiresAt === 'number' && Number.isFinite(value.expiresAt) && value.expiresAt > 0 ? value.expiresAt : null };
        } catch { return { legacy:true }; }
      };
      const read = () => readAt(journal) ?? readAt(key);
      return {
        read,
        async submit(card, confirmed) {
          if (confirmed !== true) return { code:'unconfirmed' };
          if (sending) return { code:'pending' };
          if (!card || typeof card.id !== 'string' || !idPattern.test(card.id)) return { code:'unavailable' };
          const pending = read();
          if (pending?.legacy) return { code:'storage' };
          if (pending && pending.creditId !== card.id) return { code:'pending_other' };
          if (!pending && card.expiresAt != null && card.expiresAt <= Date.now()) return { code:'no_credit' };
          sending = true;
          let attempt;
          try {
            try {
              attempt = pending ?? { creditId:card.id, idempotencyKey:uuid(), expiresAt:card.expiresAt ?? null };
              if (!uuidPattern.test(attempt.idempotencyKey)) return { code:'storage' };
              storage.setItem(journal, JSON.stringify(attempt));
              storage.setItem(key, JSON.stringify(attempt));
            } catch { return { code:'storage' }; }
            let snapshot;
            try {
              snapshot = await redeem({ creditId:attempt.creditId, idempotencyKey:attempt.idempotencyKey, confirmed:true });
            } catch { return { code:'unknown' }; }
            const code = snapshot?.resetResult;
            if (!['reset','already_redeemed','no_credit','nothing_to_reset','unknown','unavailable','pending','account_changed'].includes(code)) {
              return { code:'unknown' };
            }
            if (!['unknown','pending','account_changed'].includes(code)) {
              // Never erase an attempt that another caller saved in the meantime.
              for (const name of [key, journal]) {
                try { if (readAt(name)?.idempotencyKey === attempt.idempotencyKey) storage.removeItem(name); } catch { /* Retain the lock on storage failure. */ }
              }
            }
            return { code, snapshot };
          } finally { sending = false; }
        },
      };
    }
    // END RESET FLOW
    function Ring({ percent, stale }) {
      const circumference = 2 * Math.PI * 16;
      return h('svg', { width:36, height:36, viewBox:'0 0 40 40', 'aria-hidden':true },
        h('circle', { cx:20, cy:20, r:16, fill:'none', stroke:'var(--dsw-alias-border-l2)', strokeWidth:3 }),
        percent == null ? null : h('circle', {
          cx:20, cy:20, r:16, fill:'none', stroke:stale ? 'var(--dsw-alias-state-idle-primary)' : color(percent),
          strokeWidth:3, strokeLinecap:'round', strokeDasharray:circumference,
          strokeDashoffset:circumference * (1 - percent / 100), transform:'rotate(-90 20 20)',
        }),
        h('text', { x:20, y:20, dy:'.35em', textAnchor:'middle', fill:'currentColor',
          style:{ fontSize:percent === 100 ? 10 : 11, fontWeight:600, fontFamily:'inherit' } },
          percent == null ? '—' : Math.round(percent) + '%'));
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [locale, dictionary] of Object.entries({ en, ru, zh })) {
          ctx.effect(() => ctx.locale.register(NS, locale, dictionary));
        }
        const t = ctx.locale.bind(NS);
        function ResetCards({ snapshot, busy, date, onBusy, onSnapshot, refresh }) {
          const flow = React.useMemo(() => createResetFlow({
            storage: {
              getItem:key => window.sessionStorage.getItem(key),
              setItem:(key,value) => window.sessionStorage.setItem(key,value),
              removeItem:key => window.sessionStorage.removeItem(key),
            },
            uuid:() => crypto.randomUUID(),
            redeem:async input => {
              const remote = ctx.get('remote.openaiCodex');
              if (typeof remote?.consumeReset !== 'function') throw new Error('Reset service unavailable');
              const result = await remote.consumeReset(input);
              if (!result?.ok || typeof result.value?.loggedIn !== 'boolean') throw new Error('Reset request failed');
              return result.value;
            },
          }), []);
          const [pending, setPending] = React.useState(() => flow.read());
          const [expanded, setExpanded] = React.useState(() => Boolean(flow.read()));
          const [selected, setSelected] = React.useState(null);
          const [result, setResult] = React.useState(null);
          const submitting = React.useRef(false);
          const alive = React.useRef(true);
          React.useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
          React.useEffect(() => { setPending(flow.read()); }, [snapshot, flow]);
          const ready = snapshot.resetCardsStatus === 'ready';
          const now = Date.now();
          const cards = ready && Array.isArray(snapshot.resetCards) ? snapshot.resetCards.filter(card =>
            card && typeof card.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(card.id)
            && (card.expiresAt === null || validNumber(card.expiresAt) && card.expiresAt > now))
            .slice().sort((a,b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity)) : [];
          const count = Number.isSafeInteger(snapshot.usageResetCredits) && snapshot.usageResetCredits >= 0
            ? snapshot.usageResetCredits : null;
          const rows = pending?.creditId && !cards.some(card => card.id === pending.creditId)
            ? [...cards, { id:pending.creditId, expiresAt:pending.expiresAt }] : cards;
          const expiry = card => t('expires') + ': ' + date(card.expiresAt, true);
          const choose = card => {
            if (busy || submitting.current) return;
            setPending(flow.read()); setSelected(card); setResult(null);
          };
          const confirm = async () => {
            if (busy || submitting.current || !selected) return;
            submitting.current = true;
            onBusy(true);
            setResult(null);
            try {
              const outcome = await flow.submit(selected, true);
              if (!alive.current) return;
              if (outcome.snapshot) onSnapshot(outcome.snapshot);
              setResult(outcome.code);
              setPending(flow.read());
              setSelected(null);
            } finally {
              submitting.current = false;
              onBusy(false);
            }
          };
          return h('section', { 'aria-label':t('resets') },
            h('div', { className:'cux-line' }, h('span', null, t('resets')),
              h('div', { className:'cux-reset-actions' },
                h('strong', { className:'cux-number' }, count === null ? t('unknown') : count),
                h('button', { type:'button', className:'cux-action', 'aria-expanded':expanded,
                  onClick:() => { setExpanded(!expanded); setSelected(null); setPending(flow.read()); if (!expanded) refresh(); },
                  disabled:busy }, t(expanded ? 'less' : 'more')))),
            expanded ? h('div', { className:'cux-reset-list' },
              pending?.legacy ? h('p', { className:'cux-notice', role:'alert' }, t('storageBlocked')) : null,
              !ready ? h('p', { className:'cux-subtitle' }, t(['idle','loading'].includes(snapshot.resetCardsStatus) ? 'cardsLoading' : 'cardsUnavailable')) : null,
              ready && count === 0 && !rows.length ? h('p', { className:'cux-subtitle' }, t('cardsEmpty')) : null,
              ready && (count > cards.length || count === null && !cards.length) ? h('p', { className:'cux-subtitle' }, t('cardsPartial')) : null,
              ...rows.map(card => {
                const retry = pending?.creditId === card.id;
                const disabled = busy || pending?.legacy || Boolean(pending && !retry)
                  || (!retry && (!ready || !(count > 0) || card.expiresAt !== null && card.expiresAt <= now));
                return h('div', { className:'cux-reset-card', key:card.id },
                  h('div', { className:'cux-reset-row' },
                    h('div', null, h('div', null, t('resetCard')),
                      h('div', { className:'cux-subtitle' }, expiry(card))),
                    h('button', { type:'button', className:'cux-action', disabled,
                      onClick:() => choose(card) }, t(retry ? 'retryReset' : 'applyReset'))),
                  selected?.id === card.id ? h('div', { className:'cux-confirm', role:'group',
                    'aria-label':t('confirmTitle'), onKeyDown:event => {
                      if (event.key === 'Escape' && !submitting.current) { event.stopPropagation(); event.preventDefault(); setSelected(null); }
                    } },
                    h('strong', null, t('confirmTitle')),
                    h('p', { className:'cux-subtitle cux-note' }, t(retry ? 'retryHint' : 'confirmHint')),
                    h('div', { className:'cux-confirm-actions' },
                      h('button', { type:'button', className:'cux-action', autoFocus:true, disabled:busy,
                        onClick:() => setSelected(null) }, t('cancel')),
                      h('button', { type:'button', className:'cux-action cux-primary', disabled,
                        onClick:() => void confirm() }, t(busy ? 'working' : 'confirmReset')))) : null);
              }),
              pending && !pending.legacy && !selected && !result ? h('p', { className:'cux-notice', role:'status' }, t('retryHint')) : null,
              result ? h('p', { className:'cux-reset-result ' + (['reset','already_redeemed'].includes(result) ? 'cux-reset-ok' : 'cux-notice'), role:'status' }, t('result_' + result)) : null) : null);
        }
        function UsageIndicator({ wide }) {
          const locale = React.useSyncExternalStore(
            fn => ctx.locale.subscribe(fn), () => ctx.locale.getSnapshot(), () => ctx.locale.getSnapshot());
          const [snapshot, setSnapshot] = React.useState(null);
          const [failed, setFailed] = React.useState(false);
          const [busy, setBusy] = React.useState(false);
          const [mutating, setMutating] = React.useState(false);
          const mutationRef = React.useRef(false);
          const mutationEpoch = React.useRef(0);
          const [now, setNow] = React.useState(Date.now());
          const triggerRef = React.useRef(null);
          const popRef = React.useRef(null);
          const refreshRef = React.useRef(() => {});
          const popId = React.useId();
          React.useEffect(() => {
            let disposed = false;
            let running = false;
            let retry;
            let lastRead = 0;
            let epoch = 0;
            const refresh = async (attempt = 0) => {
              if (disposed || running || mutationRef.current) return;
              const readEpoch = mutationEpoch.current;
              if (retry) { clearTimeout(retry); retry = undefined; }
              const remote = ctx.get('remote.openaiCodex');
              if (!remote || typeof remote.snapshot !== 'function') {
                setSnapshot(null); setFailed(false); setBusy(false); return;
              }
              running = true;
              setBusy(true);
              try {
                const result = await remote.snapshot();
                if (disposed || readEpoch !== mutationEpoch.current) return;
                if (!result?.ok || !result.value || typeof result.value.loggedIn !== 'boolean') throw new Error('snapshot unavailable');
                const value = result.value;
                setSnapshot(value);
                setFailed(false);
                lastRead = Date.now();
                // The provider starts an asynchronous usage probe on snapshot().
                // Its requests are bounded at 10 s; follow up only while loading.
                if (value.loggedIn && ['idle', 'loading'].includes(value.usageStatus) && attempt < 7) {
                  const generation = ++epoch;
                  retry = setTimeout(() => {
                    if (!disposed && generation === epoch) void refresh(attempt + 1);
                  }, 2000);
                }
              } catch {
                if (!disposed) setFailed(true);
              } finally {
                running = false;
                if (!disposed) { setBusy(false); setNow(Date.now()); }
              }
            };
            refreshRef.current = () => { epoch++; void refresh(); };
            const visibleRefresh = () => {
              setNow(Date.now());
              if (!document.hidden && Date.now() - lastRead > 15000) void refresh();
            };
            const poll = setInterval(() => { if (!document.hidden) void refresh(); }, 60000);
            document.addEventListener('visibilitychange', visibleRefresh);
            window.addEventListener('focus', visibleRefresh);
            void refresh();
            return () => {
              disposed = true; epoch++;
              clearTimeout(retry); clearInterval(poll);
              document.removeEventListener('visibilitychange', visibleRefresh);
              window.removeEventListener('focus', visibleRefresh);
              refreshRef.current = () => {};
            };
          }, []);
          const limits = Array.isArray(snapshot?.usageLimits) ? snapshot.usageLimits.filter(limit =>
            limit && typeof limit.name === 'string' && validNumber(limit.usedPercent)
            && validNumber(limit.resetAt) && validNumber(limit.windowSeconds)) : [];
          const main = limits.filter(limit => limit.name === 'Codex');
          const percent = main.length ? Math.max(...main.map(limit => clamp(limit.usedPercent))) : null;
          const stale = failed || snapshot?.usageStatus === 'error'
            || (snapshot?.usageUpdatedAt > 0 && now - snapshot.usageUpdatedAt > 180000)
            || main.some(limit => limit.resetAt > 0 && limit.resetAt <= now);
          const date = (timestamp, full = false) => {
            if (!(timestamp > 0)) return t('unknown');
            try { return new Intl.DateTimeFormat(locale.active, {
              ...(full ? { year:'numeric' } : {}), day:'numeric', month:'short', hour:'2-digit', minute:'2-digit',
            }).format(new Date(timestamp)); } catch { return new Date(timestamp).toLocaleString(); }
          };
          const windowName = limit => {
            const seconds = limit.windowSeconds;
            const duration = seconds >= 86400 ? t('days', { n:Math.round(seconds / 86400 * 10) / 10 })
              : seconds > 0 ? t('hours', { n:Math.round(seconds / 3600 * 10) / 10 }) : t('window');
            return limit.name === 'Codex' ? duration : limit.name + ' · ' + duration;
          };
          const nextReset = main.map(limit => limit.resetAt).filter(time => time > now).sort((a,b) => a-b)[0];
          const status = percent == null ? (busy || ['idle','loading'].includes(snapshot?.usageStatus)
            ? t('loading') : t('unavailable')) : Math.round(percent) + '% ' + t('used');
          // Do not expose an unrelated always-empty button to signed-out profiles.
          if (!snapshot?.loggedIn) return null;
          const toggle = () => {
            const pop = popRef.current;
            const button = triggerRef.current;
            if (!pop || !button) return;
            if (pop.matches(':popover-open')) { pop.hidePopover(); return; }
            const rect = button.getBoundingClientRect();
            const width = Math.min(320, window.innerWidth - 24);
            pop.style.left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12)) + 'px';
            pop.style.bottom = Math.max(12, window.innerHeight - rect.top + 8) + 'px';
            pop.style.maxHeight = Math.max(80, rect.top - 24) + 'px';
            pop.showPopover();
            refreshRef.current();
          };
          return h('div', { className:'cux-root', 'data-codex-usage':'1.1.0', 'data-wide':wide },
            h('style', null, css),
            h('button', {
              ref:triggerRef, type:'button', className:'cux-trigger', onClick:toggle,
              title:t('title') + ' · ' + status + (stale ? ' · ' + t('stale') : ''),
              'aria-label':t('title') + ': ' + status + '. ' + t('details'),
              'aria-haspopup':'dialog', 'aria-controls':popId,
            }, h(Ring, { percent, stale })),
            h('div', { ref:popRef, id:popId, className:'cux-pop', popover:'auto', role:'dialog',
              'aria-label':t('title') + ' — ' + t('details') },
              h('div', { className:'cux-header' },
                h('div', null, h('h2', { className:'cux-title' }, t('title')),
                  h('div', { className:'cux-subtitle' }, t('details'))),
                h('button', { type:'button', className:'cux-action', 'aria-label':t('close'),
                  onClick:() => popRef.current?.hidePopover() }, '×')),
              h('p', { className:'cux-subtitle cux-note' }, t('summary')),
              stale ? h('p', { className:'cux-notice', role:'status' }, t('stale')) : null,
              !limits.length ? h('p', { className:'cux-subtitle', role:'status' }, status) : null,
              ...limits.map((limit,index) => h('section', { className:'cux-limit', key:limit.name + ':' + index },
                h('div', { className:'cux-line' }, h('span', null, windowName(limit)),
                  h('span', { className:'cux-number' }, Math.round(clamp(limit.usedPercent)) + '% ' + t('used'))),
                h('div', { className:'cux-track', role:'progressbar',
                  'aria-label':limit.name + ' · ' + windowName(limit),
                  'aria-valuemin':0, 'aria-valuemax':100, 'aria-valuenow':clamp(limit.usedPercent) },
                  h('div', { className:'cux-fill', style:{ width:clamp(limit.usedPercent) + '%', background:color(limit.usedPercent) } })),
                h('div', { className:'cux-subtitle' }, limit.resetAt > 0 && limit.resetAt <= now
                  ? t('waiting') : t('renewal') + ': ' + date(limit.resetAt)))),
              h('hr', { className:'cux-divider' }),
              h(ResetCards, { snapshot, busy:busy || mutating, date,
                refresh:() => refreshRef.current(),
                onBusy:value => { mutationRef.current = value; mutationEpoch.current++; setMutating(value); },
                onSnapshot:value => { setSnapshot(value); setFailed(false); setNow(Date.now()); },
              }),
              h('div', { className:'cux-limit' }, h('div', { className:'cux-subtitle' }, t('next')),
                h('div', null, nextReset ? date(nextReset) : main.some(limit => limit.resetAt > 0 && limit.resetAt <= now) ? t('waiting') : t('unknown'))),
              h('p', { className:'cux-subtitle cux-note' }, t('note')),
              h('hr', { className:'cux-divider' }),
              h('div', { className:'cux-foot' },
                h('span', { className:'cux-subtitle' }, t('updated') + ': ' + date(snapshot.usageUpdatedAt)),
                h('button', { type:'button', className:'cux-action', disabled:busy || mutating,
                  onClick:() => refreshRef.current() }, t('refresh'))),
              h('div', { className:'cux-subtitle cux-note' }, t('timezone') + ': ' + Intl.DateTimeFormat().resolvedOptions().timeZone)));
        }
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name:'sidebar.footer.action', id:'codex-usage', order:-10,
          label:() => t('title'),
        }, UsageIndicator));
      },
    };
  },
});
