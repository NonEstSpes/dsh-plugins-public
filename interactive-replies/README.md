# Interactive replies — stage 2

Persistent DSH bundle `@local/interactive-replies` version 1.0.3. Stage 1 provides the UI → human submission → agent roundtrip. Stage 2 adds the catalog, validation, live data updates, explicit structural revisions and local drafts. The 1.0.1 Client-path fix addresses artifact loading; browser interaction and appearance require verification in the target installation.

## Placement and limits of integration

**Fallback A remains:** cards are under the completed assistant turn, using the public `conversation.chat.turnTail` slot. This is **not** between Markdown paragraphs (B). In DSH 0.2.1-rc.5, `AssistantMarkdown` directly invokes private `MarkdownText`; there is no verified public answer-body/fenced-block renderer hook. Native B needs a narrow upstream hook. The plugin does not replace the whole assistant renderer, patch foreign DOM, edit the installed ASAR, use private UI imports, or start another server.

Complete committed tool results are executable units. Incomplete streamed arguments/templates never execute. An existing card's committed `data` updates reach the mounted Vue instance reactively, without remounting it or resetting input focus. This is incremental data updating, **not token-by-token execution or native Markdown block streaming**. New cards still wait for the owning turn's tail slot to appear.

## Features

- Locally bundled full Vue 3.5.22 compiler/runtime in a React-owned mount; arbitrary browser JavaScript, not JSON-only controls.
- Optional components: `Card`, `Row`, `Columns`, `Tabs`, `Tab`, `Stat`, `Chips`, `Progress`, `Steps`, `Table`, `Bars`, `Line`, `Donut`, `Field`, `Form`, `Button`.
- Responsive layouts; accessible keyboard tabs and forms; local table search/sort/selection; SVG charts with captions and expandable data tables. Built-in charts use the theme palette and do not currently expose `colors`/`palette` props; custom Vue/SVG may use categorical fill/stroke colors while retaining theme-aware controls and legible labels. Table: first 500 rows; charts: first 200 points. Colors use DSH theme tokens; UI labels use Russian/English dictionaries.
- Declarative typed fields with required/options/ranges/step/text/date/time validation. Client validation provides immediate errors; an authenticated owner-only Host endpoint validates again immediately before synchronous durable queue admission.
- Stable card identity, data-only updates, optimistic versions, and explicit code replacement. Data updates preserve draft/focus/submission. Structural changes stay paused until **Apply new revision**, then **Run interface**.
- Explicit JSON drafts persisted in this browser, scoped by session/card/structural revision. `Form` persists fields; `Tabs` persists selection. Arbitrary setup refs are **not** implicitly serialized. Custom state uses `useDraft` or `draft`.
- Durable accepted values, summaries and up to 16 previous submitted revision snapshots, reconstructed from standard Session events. Fork-inherited cards cannot submit to the child. Submitted history displays saved values without replaying code; read-only code preview is an explicit action.
- Per-card stop/run/source/error UI; per-session auto-run for **new** interfaces. Auto-run defaults on for Sessions without a saved preference. Existing saved `auto`/`paused` choices remain unchanged; unavailable storage fails closed. Historical cards, submitted cards, inherited cards and structural replacements do not automatically replay. Disabling auto-run does not stop already running code: use the card's stop button.

## Agent discovery and authoring

`interactive_ui` exposes `describe`, `catalog`, `show`, `demo`, `get`, `update`, `replace`, `diagnostics` (bounded, read-only served Client/version check). It never exposes an operation to fabricate a human submission. A short profile-global prompt section proactively recommends useful forms, calculators, charts and filterable comparisons, without waiting for the user to name the plugin or asking whether a local presentation card may be created. User Run/autorun controls and explicit submission/operation authority remain unchanged. New standard sessions in this profile inherit the section and tool; specialized presets can restrict tools or override complete prompts. Component contracts remain deferred via `describe(component)`. `diagnostics` verifies the profile-global section against an actual unscoped prompt assembly without creating a session or sending a model request.

Example tool arguments (a complete custom card):

```js
{
  action: 'show', id: 'preferences', title: 'Preferences',
  fields: [
    { name: 'name', type: 'text', label: 'Name', required: true },
    { name: 'amount', type: 'number', label: 'Amount', initial: 2, min: 1, max: 10, step: 1 }
  ],
  data: { points: [{ label: 'A', value: 3 }, { label: 'B', value: 7 }] },
  template: '<Columns><Form/><Bars title="Example" :data="data.points"/></Columns>',
  script: 'return {};'
}
```

Setup is a synchronous function body ending in `return { ...bindings }`. It receives:

- `Vue` and named `ref`, `reactive`, `computed`, `watch`, `watchEffect`, `onMounted`, `onUnmounted`, `nextTick`.
- Readonly refs `readonly`, `submitted`, `data`, `fields`: use `.value` in scripts; templates auto-unwrap. Honor `readonly` on editable custom controls. Built-in components enforce it on edits/sends; view-only tabs/search/sort remain usable.
- `reply(values, summary)`: explicit click/submit only, never setup/mount. Returns acceptance, not completion of the agent response.
- `draft`: explicit persisted reactive plain JSON object; `useDraft('count', 0)` returns a writable computed ref backed by `draft.custom.count`.
- `onCleanup(fn)` and `signal` (aborted on unmount). Register cleanup for every timer/listener/resource. Watchers created in setup are Vue-owned.

`update` accepts existing `id` plus `data` and/or `title`, optionally `expectedRevision` and `expectedDataVersion`. It changes `dataVersion`, not structural `revision`. `replace` needs `id`, `expectedRevision` and complete new source; it increments structural revision, preserves prior accepted summaries/values and starts a separate draft. `get` returns bounded metadata/current data/fields/submission; prior values are omitted from the model-facing history summary.

Field types: text, textarea, number, slider, select, radio, checks, switch, date, time, segmented. Fields have safe unique names and optional label/hint/description/placeholder/required/disabled/initial/options/min/max/step/minLength/maxLength. Choices are primitives or `{value,label}`; use object choices for standalone custom `Field`. One shared `draft.form` per card; do not nest Forms. Fields passed to a custom Form do not override the authoritative Host schema. Missing optional answers are allowed; explicit invalid typed values are not. `disabled` affects editing, not validation.

## Submission, drafts and lifecycle

New cards use `/api/interactive-replies/submit`, an exact Connection Fetch route. The installed DSH dispatcher authenticates it, enforces Host/Origin trust and rejects non-owner peers before entering the plugin. The handler resolves the session, checks accepted request receipts before stale-version checks, validates current fields, then synchronously calls the documented Agent `followup` API with a real identified human message. There is no await between validation and the durable inbox splice. The Host never compiles or executes generated JavaScript. The operation has no model tool.

The authoritative accepted record is standard `agent/inbox/spliced`, later consumed into `user/message`. No custom Session event types are written. Legacy v1 cards remain readable and retain their standard Session prompt path; their schema is not upgraded in place.

Submission journals persist immutable values/summary/request UUID before network I/O and hold a same-origin Web Lock across the transaction. Unknown outcomes preserve the same identity/payload across retries/reload. Nothing resends automatically. Only a definitive pre-admission refusal clears the pending journal so values can be corrected. A distinct request for the same already-admitted revision is rejected. Canceling an accepted queued input **does not reopen that revision**; use `replace` for a new answer. Queue editing is a separate explicit user action, not a plugin form submission.

Local draft writes are debounced, flushed on normal unmount and serialized with Web Locks; conflicting tab writes stop autosave rather than overwrite another draft. Corrupt drafts are not silently erased. **Clear draft** discards only that card/revision's draft, never submission journals. Drafts do not sync to other browsers/devices and are not inherited by a fork. Closing/crashing the browser before the debounce flush can lose the last fraction of a second of unsent edits. Storage quota/availability errors are visible.

## Trust — NOT A SANDBOX

Vue templates and scripts run through the full compiler and `new Function` in the browser page context by explicit design. Browser globals and same-origin APIs are available. Component restrictions, disabled inputs and soft `navigator.userActivation` checks are UX guards, not security boundaries. No Node/shell bridge is supplied. Do not run untrusted imported/external code, handle secrets, or perform external/network/file operations without explicit authorization.

Stopping/unmounting runs registered cleanup and aborts the supplied signal. It cannot undo arbitrary global side effects or interrupt a blocking synchronous script. There is no isolated iframe/worker timeout. LocalStorage contains draft/submitted data and is not credential storage.

## Bounds

64 visible cards, at most 8 per original placement turn; older standard log records remain durable. 16 previous accepted revision snapshots per visible card. Template/script: 32768 characters each; title 200. Explicit draft/reply values: 32 KiB Client cap, depth32, 10000 nodes; summary2000 characters. Host data/validation: 64 KiB UTF-8, depth32, 16384 nodes; up to64 fields, each choice up to128 options. Host request body capped64 KiB. Modern browser Web Locks required for submission and draft persistence; no insecure cross-tab fallback.

## Build and verify

Use bundled Node/pnpm, development install without lifecycle scripts; run `build.mjs`, all eight test files with `node --test --test-isolation=none`, and `verify-resources.py`. The manifest exports versioned `dist/1.0.2/host.js` and `dist/1.0.2/client.js`; this avoids accidentally reusing cached pilot Host modules. Host modules have no external runtime imports; diagnostics uses Node's built-in filesystem reader. The legacy root Client entry is built byte-identically too, because DSH can cache the pilot's earlier export path until Host restart. The card heading and slot registration expose the actual Client version; diagnostics verifies the served response against the selected file. The first setup error is preserved rather than masked by secondary render failures. No separate dev server is required or started.

Tests use pure projection/validation/journal/draft helpers and the real bundled Vue compiler/reactivity/registration. They do not simulate a browser DOM or claim mounted visual verification.

Manual check in the actual DSH page:
1. Open the advanced card, inspect source, click **Run interface**.
2. Switch tabs; search/sort table; inspect charts and accessible data tables.
3. Edit the form, stop/run or reload; unsent values restore locally.
4. Submit with required input blank: inline errors, no user message. Fill valid values and submit once: Host validation, one queued human reply, card locks.
5. Reload: accepted values remain; code is paused. A read-only preview requires explicit run.
6. Verify data-only `update` while editing preserves values/focus; `replace` shows an apply notice without running new code.
7. Fork: inherited cards cannot send. Open a second tab: submissions serialize and conflicting drafts show a warning.

The icon is original. Projector inspired the trusted Vue approach; no Projector source is redistributed. Vue's MIT license is retained in the third-party notice.
