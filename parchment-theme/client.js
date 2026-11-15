window.__ModuleLoader__.load({
  id: '@local/parchment-theme',
  factory() {
    const PLUGIN_ID = '@local/parchment-theme';

    /** A token whose value is identical in both color schemes. */
    const both = (value) => ({ light: value, dark: value });

    /**
     * Warm stone ramp replacing the product's neutral-bluish scale. The scale is
     * global (both palettes reference the same steps), so one warm ramp restyles
     * every surface, label, icon, and illustration that derives from it.
     */
    const STONE = {
      '00': '#fffdf8',
      50: '#faf7f0',
      55: '#f7f3eb',
      60: '#f5f1e8',
      75: '#f1ece2',
      90: '#ece6d9',
      100: '#e8e1d3',
      150: '#e4dccd',
      200: '#dad1bf',
      300: '#c9bea9',
      310: '#c5baa4',
      400: '#a99e89',
      500: '#928773',
      600: '#7b7161',
      700: '#5f5748',
      750: '#464034',
      800: '#383229',
      850: '#2e2921',
      875: '#26221c',
      900: '#1f1c17',
      950: '#181512',
      1000: '#110f0c',
    };

    /** Warm gray ramp for scrollbars, code chrome, and neutral details. */
    const GRAY = {
      '00': '#fffdf8',
      50: '#faf6ee',
      100: '#f4efe3',
      150: '#ede7d9',
      200: '#e5ddcc',
      250: '#ddd4c1',
      300: '#d3c9b4',
      400: '#a89d87',
      500: '#867c68',
      550: '#6d6454',
      600: '#5b5343',
      700: '#433c2f',
      800: '#2f2a21',
      850: '#27231b',
      900: '#181512',
      1000: '#110f0c',
    };

    /** Clay accent ramp replacing the blue brand scale (links, focus, activity). */
    const CLAY = {
      50: '#fbf1e9',
      100: '#f6e1d3',
      200: '#efcdb9',
      300: '#e5b49a',
      400: '#de9272',
      450: '#d07e5c',
      500: '#ac5330',
      600: '#8f4224',
      '700-delete': '#6f351d',
      800: '#4b2415',
      900: '#33180d',
    };

    const tokens = {};
    for (const [step, value] of Object.entries(STONE)) {
      tokens[`--dsw-static-neutral-bluish-${step}`] = both(value);
    }
    for (const [step, value] of Object.entries(GRAY)) {
      tokens[`--dsw-static-neutral-${step}`] = both(value);
    }
    for (const [step, value] of Object.entries(CLAY)) {
      tokens[`--dsw-static-deepseek-${step}`] = both(value);
    }

    /**
     * Scheme-specific tokens: alpha surfaces, material fills, and the few accent
     * aliases whose default values are literals rather than static-scale reads.
     * Every entry is [light, dark].
     */
    const SCHEMES = {
      // Core surfaces, restated explicitly so the headline tokens never depend on
      // how the stock stylesheet happens to derive them from the static scale.
      '--dsw-alias-bg-base': ['#fffdf8', '#181512'],
      '--dsw-alias-bg-layer-1': ['#fffdf8', '#26221c'],
      '--dsw-alias-bg-layer-2': ['#fffdf8', '#2e2921'],
      '--dsw-alias-bg-layer-3': ['#fffdf8', '#383229'],
      '--dsw-alias-bg-overlay': ['#e4dccd', '#5f5748'],
      '--dsw-alias-bg-document-preview': ['#e8e1d3', '#181512'],
      '--dsw-alias-brand-primary': ['#110f0c', '#faf7f0'],
      '--dsw-alias-label-primary': ['#110f0c', '#faf7f0'],
      '--dsw-alias-label-secondary': ['#5f5748', '#c9bea9'],
      '--dsw-specific-sidebar-fill': ['#faf7f0', '#1f1c17'],
      '--dsw-alias-state-idle-primary': ['#d3c9b4', '#5b5343'],

      // Borders read on warm paper instead of pure white.
      '--dsw-alias-border-l1': ['rgba(70, 54, 34, 0.05)', 'rgba(255, 240, 218, 0.07)'],
      '--dsw-alias-border-l2': ['rgba(70, 54, 34, 0.10)', 'rgba(255, 240, 218, 0.13)'],
      '--dsw-alias-border-l3': ['rgba(70, 54, 34, 0.14)', 'rgba(255, 240, 218, 0.17)'],
      '--dsw-alias-border-l4': ['rgba(70, 54, 34, 0.18)', 'rgba(255, 240, 218, 0.22)'],
      '--dsw-alias-border-l2-darkmode-thin': ['rgba(70, 54, 34, 0.08)', 'rgba(255, 240, 218, 0.08)'],
      '--dsw-alias-border-inverted': ['transparent', 'rgba(255, 240, 218, 0.06)'],
      '--dsw-alias-border-inverted2': ['transparent', 'rgba(255, 240, 218, 0.08)'],

      // Hover, press, and selection washes.
      '--dsw-alias-interactive-bg-hover': ['rgba(70, 54, 34, 0.055)', 'rgba(255, 240, 218, 0.07)'],
      '--dsw-alias-interactive-bg-active': ['rgba(70, 54, 34, 0.09)', 'rgba(255, 240, 218, 0.10)'],
      '--dsw-alias-interactive-bg-hover-accent': ['rgba(172, 83, 48, 0.12)', 'rgba(222, 146, 114, 0.16)'],
      '--dsw-alias-interactive-bg-hover-danger': ['rgba(190, 64, 48, 0.08)', 'rgba(242, 90, 90, 0.14)'],
      '--dsw-alias-bg-skeleton': ['rgba(70, 54, 34, 0.05)', 'rgba(255, 240, 218, 0.06)'],
      '--dsw-alias-label-shimmer': [
        'color-mix(in srgb, #110f0c 28%, transparent)',
        'color-mix(in srgb, #fffdf8 42%, transparent)',
      ],
      '--dsw-alias-bg-document-selection': [
        'color-mix(in srgb, #ac5330 26%, transparent)',
        'color-mix(in srgb, #de9272 30%, transparent)',
      ],

      // Modal and image masks.
      '--dsw-alias-bg-mask-1': ['rgba(26, 21, 15, 0.28)', 'rgba(0, 0, 0, 0.55)'],
      '--dsw-alias-bg-mask-2': ['rgba(26, 21, 15, 0.14)', 'rgba(0, 0, 0, 0.22)'],
      '--dsw-alias-bg-mask-3': ['rgba(26, 21, 15, 0.50)', 'rgba(0, 0, 0, 0.55)'],
      '--dsw-alias-bg-mask-drop': ['rgba(255, 253, 248, 0.70)', 'rgba(38, 33, 25, 0.70)'],
      '--dsw-alias-bg-mask-photo': ['rgba(0, 0, 0, 0.88)', 'rgba(0, 0, 0, 0.88)'],

      // Translucent menu material.
      '--dsw-menu-surface-fill': ['rgba(252, 249, 242, 0.84)', 'rgba(38, 34, 28, 0.78)'],
      '--dsw-alias-menu-group-header-fill': ['rgba(251, 247, 239, 0.94)', 'rgba(46, 41, 33, 0.94)'],
      '--dsw-menu-backdrop-filter': ['blur(28px) saturate(125%)', 'blur(28px) saturate(125%)'],

      // Message bubbles: warm sand in light mode, espresso in dark mode.
      '--dsw-specific-bubble': ['#f4ecde', '#2c2721'],
      '--dsw-specific-bubble-highlight': ['#eaddc7', '#3a3226'],

      // Code and markdown surfaces.
      '--dsw-alias-markdown-code-block': ['#f5efe2', '#211e18'],
      '--dsw-alias-markdown-code-block-banner': ['#eee6d6', '#29251e'],
      '--dsw-alias-markdown-inline-code': ['#f3ede0', '#2a251f'],
      '--dsw-alias-markdown-code-segment-selected': ['#fffdf8', '#322c23'],
      '--dsw-alias-markdown-code-segment-unselected': ['#f5efe2', '#211e18'],
      '--dsw-alias-markdown-placeholder': ['#f1eadb', '#29251e'],
      '--dsw-alias-markdown-tag': ['#efe7d7', '#2f2921'],
      '--dsw-alias-markdown-citation': ['#e8e0d0', '#2f2921'],

      // Clay identity for accent text and feature marks.
      '--dsw-alias-label-primary-bluish': ['#8a4527', '#e9b69c'],
      '--dsw-alias-label-deep-diving': ['#9c4a2b', '#e2a286'],
      '--dsw-alias-label-deep-diving-shimmer': ['#c97a57', '#f0c4ae'],
      '--dsw-alias-brand-primary-new-colorprimary-new-color': ['#ac5330', '#de9272'],
      '--dsw-alias-onboarding-accent': ['#ac5330', '#de9272'],
      '--dsw-alias-onboarding-secondary-fill': ['#fffdf8', '#3a342b'],

      // Diffusion panels above and below thinking content.
      '--dsw-linear-gradient-think': [
        'linear-gradient(180deg, #fffdf8 20.19%, rgba(255, 253, 248, 0) 100%)',
        'linear-gradient(180deg, #181512 20.19%, rgba(24, 21, 18, 0) 100%)',
      ],
      '--dsw-linear-think-select': [
        'linear-gradient(180deg, #f4eee2 20.19%, rgba(244, 238, 226, 0) 100%)',
        'linear-gradient(180deg, #23201a 20.19%, rgba(35, 32, 26, 0) 100%)',
      ],

      // File comparison fills, warmed without losing the red/green signal.
      '--dsw-alias-file-diff-added-bg': ['#e9f2e2', '#22301f'],
      '--dsw-alias-file-diff-added-gutter': ['#f1f7ec', '#1a2418'],
      '--dsw-alias-file-diff-added-marker': ['#4c8b52', '#71bc7f'],
      '--dsw-alias-file-diff-deleted-bg': ['#f8e5de', '#392420'],
      '--dsw-alias-file-diff-deleted-gutter': ['#fbede7', '#291815'],
      '--dsw-alias-file-diff-deleted-marker': ['#b44b34', '#e07e64'],

      // Softer, warmer elevation.
      '--dsw-shadow-lv1': [
        '0 1px 2px rgba(58, 43, 26, 0.05), 0 2px 6px rgba(58, 43, 26, 0.04)',
        '0 1px 2px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.25)',
      ],
      '--dsw-shadow-lv1-blur': [
        '0 4px 14px rgba(58, 43, 26, 0.05)',
        '0 6px 18px rgba(0, 0, 0, 0.32)',
      ],
      '--dsw-shadow-lv2': [
        '0 2px 6px rgba(58, 43, 26, 0.05), 0 8px 22px rgba(58, 43, 26, 0.06)',
        '0 2px 8px rgba(0, 0, 0, 0.34), 0 10px 26px rgba(0, 0, 0, 0.28)',
      ],
      '--dsw-shadow-lv3': [
        '0 0 0 1px rgba(58, 43, 26, 0.05), 0 6px 18px rgba(58, 43, 26, 0.06), 0 20px 44px rgba(58, 43, 26, 0.10)',
        '0 0 0 1px rgba(0, 0, 0, 0.45), 0 8px 24px rgba(0, 0, 0, 0.40), 0 24px 56px rgba(0, 0, 0, 0.34)',
      ],

      // Slightly rounder corners, between ChatGPT's soft cards and Claude's compact chrome.
      '--dsw-radius-xs': ['4px', '4px'],
      '--dsw-radius-sm': ['9px', '9px'],
      '--dsw-radius-md': ['13px', '13px'],
      '--dsw-radius-lg': ['17px', '17px'],
      '--dsw-radius-xl': ['21px', '21px'],
    };

    for (const [name, [light, dark]] of Object.entries(SCHEMES)) {
      tokens[name] = { light, dark };
    }

    const PALETTE = Object.freeze(tokens);

    return {
      inject: ['theme'],
      apply(ctx) {
        ctx.effect(
          () => ctx.theme.overrideTokens(PLUGIN_ID, PALETTE),
          'parchment-theme: palette overrides',
        );
      },
    };
  },
});
