import { studioDefinitions } from './palettes.js';
import { studioIcons, studioMark } from './icons.js';
import { createStudioController } from './controller.js';
import { dictionaries } from './copy.js';
import { createAppearance } from './appearance.js';
import { createHeader, HEADER_CSS } from './header.js';

const PACKAGE = '@local/studio-theme';
const NAMESPACE = 'studio-theme';

/** Install several resources transactionally and release them in reverse order. */
function resources(installers) {
  const disposers = [];
  try {
    for (const install of installers) disposers.push(install());
  } catch (failure) {
    for (const dispose of disposers.reverse()) dispose();
    throw failure;
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose(); };
}

window.__ModuleLoader__.load({
  id: PACKAGE,
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const Appearance = createAppearance(React, studioMark);
    const header = createHeader(React);
    function Header(props) {
      return h(React.Fragment, null, h('style', null, HEADER_CSS), h(header.component, props));
    }
    function Mark({ size }) { return studioMark(React, size ?? 24); }
    return {
      inject: ['slots', 'theme', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NAMESPACE, dictionaries));
        const definitions = studioDefinitions(studioIcons());
        ctx.effect(() => resources(definitions.map((definition) => () => ctx.theme.register(definition))));
        const own = ctx.configForms.get('studio-theme');
        const base = ctx.configForms.get('ui-theme');
        const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : undefined;
        const controller = createStudioController({
          theme: ctx.theme,
          readDesign: () => own.getSnapshot().value?.design,
          readPreference: () => base.getSnapshot().value?.preference,
          systemDark: () => media?.matches === true,
          mount: () => resources([
            () => ctx.slots.inject('conversation.header.leading', () => ctx.slots.register({
              name: 'conversation.header.leading', priority: -20, locale: NAMESPACE,
            }, Header)),
            () => ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({
              name: 'sidebar.brand.mark', priority: -20,
            }, Mark)),
            () => ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
              name: 'conversation.hero.brand.mark', priority: -20,
            }, Mark)),
          ]),
          report: (error) => console.error('[studio-theme] Activation failed; original presentation restored.', error),
        });
        ctx.effect(() => {
          let queued = false;
          let disposed = false;
          // Do not re-enter theme/change while native presenters process its snapshot.
          const schedule = () => {
            if (queued || disposed) return;
            queued = true;
            queueMicrotask(() => {
              queued = false;
              if (!disposed) controller.sync();
            });
          };
          const unsubscribe = resources([
            () => own.subscribe(schedule),
            () => base.subscribe(schedule),
            () => ctx.on('theme/change', schedule),
            () => {
              media?.addEventListener('change', schedule);
              return () => media?.removeEventListener('change', schedule);
            },
          ]);
          schedule();
          return () => {
            disposed = true;
            unsubscribe();
            controller.dispose();
          };
        });
        ctx.slots.inject('settings.general.item', () => ctx.slots.register({
          name: 'settings.general.item', id: 'appearance', order: 10, priority: -20,
          locale: NAMESPACE,
          inject: () => ({
            hooks: { studioSettings: own, baseAppearance: base, studioRuntime: controller },
            setDesign: async (design) => {
              const accepted = await own.set('design', design);
              if (accepted && design === 'studio') controller.requestActivation();
              return accepted;
            },
            setScheme: (scheme) => base.set('preference', scheme),
          }),
        }, Appearance));
      },
    };
  },
});
