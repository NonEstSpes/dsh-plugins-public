/** Settings controls use only their own class names and the current host palette. */
export const APPEARANCE_CSS = `
.studio-appearance{display:flex;flex-direction:column;gap:14px;padding:16px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.studio-appearance h3,.studio-appearance p{margin:0}.studio-appearance h3{font:inherit;font-weight:500}.studio-appearance__description{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary);max-width:60ch}
.studio-appearance__label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.studio-appearance__themes{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.studio-appearance__choice{box-sizing:border-box;min-width:0;display:flex;align-items:center;gap:12px;padding:16px;text-align:left;font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;cursor:pointer;transition:background 120ms,border-color 120ms}
.studio-appearance__choice[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-module-platform)}
.studio-appearance__choice svg{flex:none}.studio-appearance__choice strong{display:block;font-size:14px;font-weight:500;line-height:22px}.studio-appearance__choice small{display:block;margin-top:2px;font-size:12px;font-weight:400;line-height:18px;color:var(--dsw-alias-label-secondary)}
.studio-appearance__schemes{display:flex;gap:8px;flex-wrap:wrap}
.studio-appearance__scheme{display:inline-flex;align-items:center;justify-content:center;gap:8px;flex:1 1 100px;min-height:42px;padding:8px 12px;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;cursor:pointer}
.studio-appearance__scheme[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-bg-module-platform)}
.studio-appearance__status{font-size:12px;line-height:19px;color:var(--dsw-alias-label-secondary)}.studio-appearance__error{font-size:12px;line-height:19px;color:var(--dsw-alias-state-error-primary)}
.studio-appearance__details{font-size:12px;color:var(--dsw-alias-state-error-primary)}.studio-appearance__details summary{cursor:pointer}.studio-appearance__details pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0;font-family:var(--ds-font-family-code);font-size:12px;line-height:18px}
.studio-appearance button:disabled{opacity:.55;cursor:default}.studio-appearance button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:3px}
@media(hover:hover){.studio-appearance button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover)}}
@media(max-width:520px){.studio-appearance__themes{grid-template-columns:1fr}.studio-appearance__choice{padding:12px}.studio-appearance__scheme{min-height:44px}}
@media(prefers-reduced-motion:reduce){.studio-appearance *{transition:none}}
`;

/** Native-like buttons with accepted Host values, explicit writes, and visible failures. */
export function createAppearance(React, studioMark) {
  const h = React.createElement;
  function glyph(id) {
    const path = id === 'light' ? 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2'
      : id === 'dark' ? 'M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z'
      : 'M5 3h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm7 14v4m-5 0h10';
    return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
      id === 'light' ? h('circle', { cx: 12, cy: 12, r: 4 }) : null, h('path', { d: path }));
  }
  return function Appearance({ t, useStudioSettings, useBaseAppearance, useStudioRuntime, setDesign, setScheme }) {
    const own = useStudioSettings((s) => s);
    const base = useBaseAppearance((s) => s);
    const runtime = useStudioRuntime((s) => s);
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const available = own.status === 'ready' && own.writable;
    const baseAvailable = base.status === 'ready' && base.writable;
    const selected = own.value?.design ?? 'default';
    const mode = base.value?.preference ?? 'system';
    const commit = async (operation) => {
      if (busy) return;
      setBusy(true);
      setError(false);
      try {
        const accepted = await operation();
        if (mounted.current) setError(accepted !== true);
      } catch (failure) {
        // The form owns recovery; expose failure instead of claiming the choice was saved.
        if (mounted.current) setError(true);
      } finally {
        if (mounted.current) setBusy(false);
      }
    };
    const statusKey = own.status === 'loading' ? 'appearance.loading'
      : own.status !== 'ready' ? 'appearance.unavailable'
      : busy ? 'appearance.saving'
      : selected === 'studio' ? (runtime.active ? 'appearance.on' : 'appearance.inactive') : 'appearance.off';
    return h('section', { className: 'studio-appearance', 'aria-label': t('appearance.title'), 'aria-busy': busy },
      h('style', null, APPEARANCE_CSS),
      h('h3', null, t('appearance.title')),
      h('p', { className: 'studio-appearance__description' }, t('appearance.description')),
      h('div', { className: 'studio-appearance__label' }, t('appearance.design')),
      h('div', { className: 'studio-appearance__themes', role: 'group', 'aria-label': t('appearance.design') },
        ['default', 'studio'].map((id) => h('button', {
          key: id, type: 'button', className: 'studio-appearance__choice', disabled: !available || busy,
          'aria-pressed': selected === id,
          onClick: () => { if (selected !== id || (id === 'studio' && !runtime.active)) void commit(() => setDesign(id)); },
        }, id === 'studio' ? studioMark(React, 30) : h('svg', { width: 30, height: 30, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true }, h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }), h('path', { d: 'M9 4v16' })),
        h('span', null, h('strong', null, t(`design.${id}`)), h('small', null, t(`design.${id}.description`)))))),
      h('div', { className: 'studio-appearance__label' }, t('scheme.title')),
      h('div', { className: 'studio-appearance__schemes', role: 'group', 'aria-label': t('scheme.title') },
        ['light', 'dark', 'system'].map((id) => h('button', {
          key: id, type: 'button', className: 'studio-appearance__scheme', disabled: !baseAvailable || busy,
          'aria-pressed': mode === id,
          onClick: () => { if (mode !== id) void commit(() => setScheme(id)); },
        }, glyph(id), t(`scheme.${id}`)))),
      h('p', { className: 'studio-appearance__status', role: 'status', 'aria-live': 'polite' }, t(statusKey)),
      error || runtime.error ? h('p', { className: 'studio-appearance__error', role: 'alert' }, t(runtime.error ? 'appearance.activationError' : 'appearance.saveError')) : null,
      runtime.error && runtime.details ? h('details', { className: 'studio-appearance__details' },
        h('summary', null, t('appearance.technicalDetails')), h('pre', null, runtime.details)) : null,
    );
  };
}
