/** A contribution to the existing leading seat; never redeclare native header children. */
export const HEADER_CSS = `
.studio-header-badge{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:26px;margin-inline-end:10px;padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:500;line-height:18px;letter-spacing:.02em;white-space:nowrap;pointer-events:none}
.studio-header-badge svg{display:block;flex:none;color:var(--dsw-alias-state-business-primary)}
@media(max-width:520px){.studio-header-badge{margin-inline-end:4px;padding-inline:5px}.studio-header-badge svg{display:none}}
`;

/** The parent registers this component in conversation.header.leading with its locale. */
export function createHeader(React) {
  const h = React.createElement;
  function StudioHeaderLeading({ t }) {
    return h('span', { className: 'studio-header-badge', 'data-studio-header': '' },
      h('svg', { viewBox: '0 0 24 24', width: 14, height: 14, fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M5 4h12l3 3v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z' }),
        h('path', { d: 'M8 9h8m-8 4h5' })),
      t('header.studioMode'));
  }
  return { component: StudioHeaderLeading };
}
