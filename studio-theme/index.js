import Schema from '@deepseek-ai/schemastery';

/** Presentation preference only. Enabling the plugin never selects Studio. */
export const Config = Schema.object({
  design: Schema.union(['default', 'studio']).default('default').volatile(),
});

/** Use the General appearance row, not a duplicate generated settings page. */
export function apply(ctx) {
  ctx.inject(['settings'], (scope) => {
    scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber));
  });
}
