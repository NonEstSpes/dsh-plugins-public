/** Original 24-unit outline artwork. No third-party icon library or network assets. */
const paths = {
  'new-chat-outline': '<path d="M13 5H6a2 2 0 0 0-2 2v11l4-3h10a2 2 0 0 0 2-2v-2M17 3v6m-3-3h6"/>',
  'search-outline': '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.3 15.3 4.7 4.7"/>',
  'settings-outline': '<path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h9m4 0h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
  'panel-left-outline': '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16m-3-11v6"/>',
  'plus-outline': '<path d="M12 5v14M5 12h14"/>',
  'check-outline': '<path d="m5 12 4 4L19 6"/>',
  'chevron-down-outline': '<path d="m6 9 6 6 6-6"/>',
  'chevron-up-outline': '<path d="m6 15 6-6 6 6"/>',
  'chevron-left-outline': '<path d="m15 6-6 6 6 6"/>',
  'chevron-right-outline': '<path d="m9 6 6 6-6 6"/>',
  'close-outline': '<path d="m6 6 12 12M18 6 6 18"/>',
  'close-fill': '<path d="m6 6 12 12M18 6 6 18"/>',
  'copy-outline': '<rect x="8" y="8" width="12" height="13" rx="3"/><path d="M15 8V5a2 2 0 0 0-2-2H6a3 3 0 0 0-3 3v8a2 2 0 0 0 2 2h3"/>',
  'edit-outline': '<path d="M12 5H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-6M10 14l1-4L18 3l3 3-7 7-4 1Z"/>',
  'save-outline': '<path d="M5 3h12l4 4v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm2 0v6h9V3M7 21v-7h10v7"/>',
  'refresh-outline': '<path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/>',
  'paperclip-outline': '<path d="m8 12 7-7a4 4 0 0 1 6 6l-9 9a6 6 0 0 1-8-8l9-9M7 16a2 2 0 0 0 3 0l8-8"/>',
  'send-outline': '<path d="M12 20V4M6 10l6-6 6 6"/>',
  'paper-plane-outline': '<path d="m3 10 18-7-7 18-3-8-8-3Zm8 3L21 3"/>',
  'stop-fill': '<rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" stroke="none"/>',
  'queue-outline': '<path d="M5 5h14M5 10h10M5 15h7m5-2 4 4-4 4m4-4h-7"/>',
  'api-outline': '<path d="m5 6 6 6-6 6m9 0h6"/>',
  'code-outline': '<path d="m8 6-6 6 6 6m8-12 6 6-6 6M14 4l-4 16"/>',
  'browse-outline': '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h4"/>',
  'folder-close': '<path d="M3 7V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
  'folder-open-outline': '<path d="M3 12V5a2 2 0 0 1 2-2h5l3 4h5a2 2 0 0 1 2 2v2M3 12h18l-3 9H3l-2-6a2 2 0 0 1 2-3Z"/>',
  'project-add-outline': '<path d="M3 11V5a2 2 0 0 1 2-2h5l3 4h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Zm9 0v6m-3-3h6"/>',
  'globe-outline': '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  'clock-outline': '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 3"/>',
  'goal-outline': '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4"/><path d="m12 12 8-8m-4-1h5v5"/>',
  'checklist-outline': '<path d="m3 6 2 2 3-4m-5 13 2 2 3-4M11 6h10M11 17h10"/>',
  'branch-outline': '<circle cx="6" cy="5" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m0-5h6a6 6 0 0 0 6-3"/>',
  'trash-outline': '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  'warning-outline': '<circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>',
  'warning-triangle-outline': '<path d="m12 3 10 18H2L12 3Zm0 6v5m0 4h.01"/>',
  'user-outline': '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a6 6 0 0 1 6-5h4a6 6 0 0 1 6 5v2"/>',
  'light-outline': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>',
  'dark-outline': '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/>',
  'followsystem-outline': '<rect x="3" y="3" width="18" height="14" rx="3"/><path d="M12 17v4m-5 0h10"/>',
  'personalization-outline': '<path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h9m4 0h3"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="15" cy="18" r="2"/>',
};

/** All keys use the product's published symbol-id pattern, in both supported weights. */
export function studioIcons() {
  return Object.fromEntries(Object.entries(paths).flatMap(([glyph, artwork]) =>
    ['regular', 'medium'].map((weight) => [
      `dsw-icon-${glyph}-${weight}`,
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${weight === 'regular' ? 1.65 : 1.95}" stroke-linecap="round" stroke-linejoin="round">${artwork}</svg>`,
    ]),
  ));
}

/** Theme identity, intentionally distinct from any vendor's brand. */
export function studioMark(React, size = 24) {
  const h = React.createElement;
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
    h('path', { d: 'M5 4h12l3 3v10a2 2 0 0 1-2 2H9l-5 3V6a2 2 0 0 1 1-2Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }),
    h('path', { d: 'M8 9h8m-8 4h5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
  );
}
