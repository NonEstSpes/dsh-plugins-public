const ownId = '@local/dsh-finance';

/** Publish and inspect only this plugin's advertised public Client artifact. */
export function trackClientArtifact(clientModules) {
  const status = { state: clientModules ? 'waiting' : 'unavailable' };
  if (!clientModules) return { status, dispose() {} };

  const controller = new AbortController();
  let disposed = false, inFlight = false, graphChanged = false, reviewedRev;
  let unsubscribe = () => {};
  const update = value => {
    if (disposed) return;
    for (const key of Object.keys(status)) delete status[key];
    Object.assign(status, value);
  };
  const entry = () => clientModules.graph().entries.find(value => value.id === ownId);
  async function inspect(value) {
    if (typeof value.url !== 'string') throw new Error('Invalid artifact URL');
    const url = new URL(value.url, 'http://127.0.0.1');
    if (!['http:', 'https:'].includes(url.protocol) || !url.pathname.startsWith('/plugins/') || url.username || url.password) throw new Error('Invalid artifact URL');
    const response = await clientModules.fetchBundle(new Request(url, { signal: controller.signal }));
    if (!response.ok) throw new Error('Artifact unavailable');
    const body = await response.text();
    return {
      version: body.match(/['"]data-finance-ui['"]\s*:\s*['"](0\.1\.\d+)['"]/)?.[1] || null,
      hasSortControls: body.includes('function nextTransactionSort(') && body.includes('finance-sort-button'),
    };
  }
  async function review() {
    if (disposed) return;
    if (inFlight) { graphChanged = true; return; }
    inFlight = true;
    let completed = false;
    try {
      const previous = entry();
      if (!previous) { reviewedRev = undefined; update({ state: 'waiting' }); return; }
      if (previous.rev === reviewedRev) return;
      update({ state: 'checking' });
      const before = await inspect(previous);
      if (disposed) return;
      clientModules.rebuilt(ownId);
      if (disposed) return;
      const current = entry();
      if (!current) { reviewedRev = undefined; update({ state: 'waiting' }); return; }
      const after = await inspect(current);
      if (disposed) return;
      reviewedRev = current.rev;
      update({ state: 'ready', previousVersion: before.version, version: after.version,
        previousRev: previous.rev, rev: current.rev, hasSortControls: after.hasSortControls,
        changedRev: previous.rev !== current.rev });
      completed = true;
    } catch {
      reviewedRev = undefined;
      update({ state: 'error' });
    } finally {
      inFlight = false;
      const rerun = graphChanged;
      graphChanged = false;
      // Our own rebuilt event is already reviewed; an actually newer graph still gets checked.
      if (completed && rerun && !disposed) void review();
    }
  }
  try {
    unsubscribe = clientModules.onGraphChanged(() => { void review(); });
    void review();
  } catch {
    update({ state: 'error' });
  }
  return { status, dispose() {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unsubscribe();
  } };
}
