const BUILTIN = new Set(['light', 'dark', 'system']);
export const isStudio = (id) => id === 'studio-light' || id === 'studio-dark';

/** Resolve presentation without writing either settings namespace. */
export function resolveStudio(design, preference, systemDark) {
  if (design !== 'studio') return null;
  return `studio-${preference === 'dark' || (preference === 'system' && systemDark) ? 'dark' : 'light'}`;
}

/**
 * Coordinate an opt-in presentation with the host theme registry.
 * Construction, and every sync while Studio is unselected, leave other themes untouched.
 * The caller owns subscriptions and registers the returned disposer with its context.
 */
export function createStudioController({ theme, readDesign, readPreference, systemDark, mount, report }) {
  let disposed = false;
  let syncing = false;
  let releaseLayout;
  let lastBuiltin = BUILTIN.has(theme.getTheme().preference) ? theme.getTheme().preference : 'system';
  let failedTarget;
  let explicitRequested = false;
  let snapshot = Object.freeze({ active: false, error: false });
  const listeners = new Set();
  const publish = (active, error, details) => {
    if (snapshot.active === active && snapshot.error === error && snapshot.details === details) return;
    snapshot = Object.freeze({ active, error, ...(details === undefined ? {} : { details }) });
    for (const notify of [...listeners]) notify();
  };
  const unmount = () => {
    const off = releaseLayout;
    releaseLayout = undefined;
    off?.();
  };
  const sync = () => {
    if (disposed || syncing) return;
    syncing = true;
    const explicit = explicitRequested;
    explicitRequested = false;
    try {
      const current = theme.getTheme().preference;
      if (BUILTIN.has(current)) lastBuiltin = current;
      const preferred = readPreference();
      const builtin = BUILTIN.has(preferred) ? preferred : lastBuiltin;
      const target = resolveStudio(readDesign(), builtin, systemDark());
      if (target === null) {
        failedTarget = undefined;
        unmount();
        if (isStudio(current)) theme.setTheme(builtin);
        publish(false, false);
        return;
      }
      if (failedTarget === target && !explicit) return;
      // Background synchronization never fights another theme; an explicit Studio click can replace it.
      if (!BUILTIN.has(current) && !isStudio(current) && !explicit) {
        unmount();
        publish(false, false);
        return;
      }
      try {
        if (current !== target) theme.setTheme(target);
        if (releaseLayout === undefined) releaseLayout = mount();
        publish(true, false);
      } catch (error) {
        failedTarget = target;
        unmount();
        if (isStudio(theme.getTheme().preference)) theme.setTheme(builtin);
        const message = typeof error?.message === 'string' ? error.message : String(error);
        publish(false, true, message.slice(0, 1000));
        report(error);
      }
    } finally {
      syncing = false;
    }
  };
  return {
    sync,
    requestActivation() {
      if (disposed) return;
      explicitRequested = true;
      failedTarget = undefined;
      sync();
    },
    getSnapshot: () => snapshot,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    dispose() {
      if (disposed) return;
      disposed = true;
      unmount();
      const current = theme.getTheme().preference;
      const preferred = readPreference();
      if (isStudio(current)) theme.setTheme(BUILTIN.has(preferred) ? preferred : lastBuiltin);
      listeners.clear();
    },
  };
}
