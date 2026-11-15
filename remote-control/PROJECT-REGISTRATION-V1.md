# Worker-native project registration

## Scope and current status

Stage4 adds an explicit user action to register an **existing** Worker directory as a remote project. It does not create an OS directory, invoke the Controller directory picker, override a sandbox, activate an Agent, or import native sessions. The policy, pair ledger and native helper are connected through the Worker RPC, owner-only BFF, Client data owner and machine-header form. Source-level acceptance covers the actual SDK/Loader and authenticated HTTP/JWE, plus focused Client and UI behavior. Final bundled deployment and physical Worker acceptance remain pending. The local Worker remains disabled and no profile or signed DSH file is changed.

## Permission

Grant version1 retains its previous accepted fields and normalized bytes. Version2 permits an optional `projectRegistration` member with exactly `actions:['project.register']` and a `projectGrant` template. Omitting it denies registration. A machine-only version2 grant may have `projects:[]`; version1 still requires explicit projects. The template contains project actions, export-class maximum and an optional created-session template, never paths, native IDs or session inventories.

Only pair-journal-proven committed projects derive permissions. Explicit project entries always win, including an explicit empty denial. A derived project's actions, exports and nested created-session rights intersect the captured registration template with the current machine template. A later wider template cannot silently broaden an older enrollment. Removing the machine permission withdraws derived projects unless the owner separately names them explicitly. Existing native sessions remain inaccessible; a new Session still requires its own existing committed create proof.

## Native operation

The non-Remote constructor-owned `sourcePrepareProject` helper uses the Worker SDK's realpath normalization, directory stat and `WorkspaceRegistry.resolveByPath` without a write. Its canonical path is persisted before dispatch. `sourceRegisterProject` invokes the actual pinned `WorkspaceRegistry.create` function and returns only native Workspace ID, exact canonical path and title. It never reads `sessionIds`. A changed canonical target or native owner refuses a positive return; a possible native effect is not described as rolled back. Caller cancellation and owner disposal use static diagnostics and join admitted work.

The Controller transmits the user's raw Worker path. It must not resolve or normalize it using the Controller OS. The Worker authoritative filesystem and registry decide whether the path exists and is a directory. Normal filesystem access failures do not export native error messages, causes or arbitrary paths.

## Durable identities

Each exact pairing has a separately locked `project-registration.v1.json`; the existing session-mutation `federation.json` is not migrated or rewritten. The project ledger binds role, principal, machine, trust generation and key fingerprint. A request's raw body and numeric authority determine an immutable digest. The Worker persists a native canonical preparation, captured template and a randomly reserved opaque `fpr_…` ProjectId before admitting native dispatch.

A genuine native return is retained privately as proof. Project enrollment and the public receipt then commit atomically in the same ledger. Public receipts contain only project reference and title; policy ownership views exclude native IDs and paths. Repeating a committed request returns that receipt without another registration effect. A different body or authority under the same request ID conflicts. A same-pair canonical alias may reuse an existing enrolled project only while its native Workspace identity still matches; an old project ID is never retargeted to a replacement Workspace.

## Uncertain effects and recovery

A restarted dispatched operation becomes `unknown`. One unsettled registration blocks a different request ID in that pair. An absent native proof never becomes ownership merely because the directory or Workspace now exists. No recovery path replays a mutable raw symlink target or invokes `Registry.create` to find out what happened. A retained exact native proof can be checked read-only at the captured canonical path and committed only under its original, still current authority. A committed receipt whose response was lost can be read again. WorkspaceRegistry's own pending-record recovery is not a federation request receipt.

The ledger retains at most2048 operations and256 project enrollments and never evicts replay identities to admit a new operation. Complete raw/canonical path strings are bounded, not truncated. All emitted RPCs will retain the existing complete32KiB frame bound; no path or project inventory is added to agent tools.

## Runtime and UI

Runtime negotiates `native-project-registration-v1`, checks current machine permission, excludes private pair-state roots from canonical targets and supplies pair-specific committed native bindings without changing static settings. The Controller keeps its own immutable request journal; a read-only state request can settle a lost committed receipt but cannot replay an unknown native effect. Owner-only `getProjectRegistrationState` and `registerProject` BFF calls capture their provider registration through settlement. The Client data owner keeps one request ID and observed authority; an unsettled request blocks another submit. The machine-header form sends the path verbatim only on an explicit user action and refreshes the catalog after a known receipt. Removing a source prevents late publication or opening a local Session. An advertised refusal never falls back to an older operation.

## Remaining delivery gates

Worker0.1.5 carries the new private helper and preserves every predecessor public face. Final Controller/Bridge/UI bundles, portable Worker archive, affected artifact builds and installed-GUI verification still remain. Physical Worker, tunnel interruption, OS access and real power-loss checks are not established by source-level acceptance. These limits are reported separately; the local Worker is not enabled for testing.
