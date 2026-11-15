# Offline native-v2 enrollment stager

**Review-only source tool; not an applier, installer or pairing wizard.** It generates
fresh credentials only when explicitly called. Do not run it for a real machine until
the owner has approved the policy, native workspace ID, staging location and later
application plan. Tests use disposable, owned fixtures only.

## Boundary and consent

- One explicit native Worker workspace ID maps to one explicit federation project ID.
  The ID must come separately from the owner/native Worker registry. It is opaque:
  never invent it from a filesystem path, infer it from a session, read the native DB,
  or adopt an existing SID. The generator cannot prove an ID is real.
- Settings are **version 2**, but the embedded **grant is version 1**, revision 1,
  with exactly one project and `sessions: []`. No existing sessions are imported.
  Future session permissions apply only through that project's `createdSessionGrant`
  and the Worker's verified durable ownership journal after a new authorized create.
- No `project.register`: current grant-v2 `projectRegistration` has **no allowedRoots**.
  That action can register arbitrary accessible non-state paths, so it does not meet
  the one-workspace goal. Do not add invented path-restriction fields.
- **Project scoping is not an OS filesystem sandbox.** The current native adapter's
  create/prompt preparation sets the session sandbox to **danger-full-access** and
  flushes it durably. Native tool/approval policy otherwise remains native-owned.
  Before enabling `session.create` or `session.prompt`, the owner must separately
  review the effective Worker preset, tools, approvals and that sandbox escalation.
  The stager neither chooses a preset nor guarantees path-confined agent execution.
  Do not invent preset/permission fields in the pairing settings or grant.
- No network, SSH, relay calls, native calls, start, install, session/store opening,
  grant installation, profile discovery, config merge, rotation or production edits.
  Nothing here touches an existing channel or repairs a blocked Worker.

## API: filesystem-free producer

```js
import { stageEnrollmentV2 } from './scripts/enroll-v2.mjs'

const staged = stageEnrollmentV2({
  relayUrl,              // HTTPS; supplied by operator
  nativeWorkspaceId,     // REQUIRED real opaque native ID, obtained separately
  projectId,             // REQUIRED explicit federation ID
  projectGrant,          // REQUIRED reviewed policy described below
  // controllerId,       // optional existing logical Controller root ID ONLY
  // label,              // optional human label, never an identity
  // allowLoopback: true // development fixtures only
})
```

`stageEnrollmentV2` reads no filesystem/environment/native state. It validates strict
identity/grant contracts using the current public parsers, checks the same relay URL
boundary as `parseSettingsV2`, and returns:

| Property | Meaning |
| --- | --- |
| `controllerPair` | NEW pair object only; append candidate, **not a whole Controller config** |
| `worker` | NEW standalone worker-v2 document; never overwrite an existing config |
| `relayDevices` | Array of exactly two device **additions**, not replacement relay settings |
| `manifest` | Non-secret generated IDs, key fingerprint, explicit policy and review gates |

It generates a fresh 32-byte shared key, two distinct 32-byte device bearer tokens,
random transport IDs, a new Worker harness root ID and stable Worker machine identity.
Both endpoints use the same key and `pairingGeneration: 1`. The Worker grant principal
is `{ kind: 'controller', id: NEW_CONTROLLER_TRANSPORT_ID }`, **not** the logical
Controller root ID. The optional `controllerId` only supplies that logical root hint;
transport ID/key/state/machine continuity is never reused. Relay entries contain
only `id`, reciprocal `peerId`, and SHA-256 `tokenHash`; never raw bearers/shared keys.

## Explicit policy, no implicit preset or wildcard

The reviewed JSON policy must have exactly `actions`, `exportClasses` and
`createdSessionGrant`; the latter must explicitly contain `actions` and `exportClasses`,
even when both arrays are empty. Actions and export classes are validated by
`parseProjectGrantTemplate`/`parseGrant`; duplicates, unknown fields/actions,
wrong-scope actions and created-session exports outside the project maximum fail.
No `sessions`, paths, native IDs, `allowedRoots`, preset or wildcard fields belong here.

Minimal read-only staging policy (no create, no adopted sessions, so no session data):

```json
{
  "actions": ["project.list", "session.list", "model.list"],
  "exportClasses": [],
  "createdSessionGrant": { "actions": [], "exportClasses": [] }
}
```

An **explicitly mutation-capable** alternative, only after the consent above:

```json
{
  "actions": ["project.list", "session.list", "session.create", "model.list"],
  "exportClasses": ["conversation.user", "conversation.assistant"],
  "createdSessionGrant": {
    "actions": ["session.status", "session.read", "session.follow", "session.prompt", "session.cancel", "model.select"],
    "exportClasses": ["conversation.user", "conversation.assistant"]
  }
}
```

This permits create/list/model catalog for this project and status/read/follow/prompt/
cancel/model selection only for verified newly created sessions. It grants no tool
payloads, files, reasoning, metrics, existing sessions or machine project registration.
Export permission alone does not enable an unsupported serializer or runtime feature.

## CLI: new local staging directory only

`node scripts/enroll-v2.mjs --help` describes the small CLI. There are no permission
presets: a reviewed policy file is required. In the following shell-neutral outline,
substitute explicitly reviewed values; **do not use placeholder IDs as native IDs**:

```text
node scripts/enroll-v2.mjs --out NEW_STAGING_DIRECTORY --policy REVIEWED_POLICY_JSON --relay-url HTTPS_URL --native-workspace-id REAL_NATIVE_ID --project-id EXPLICIT_PROJECT_ID
```

Optional: `--controller-id EXISTING_LOGICAL_ROOT_ID`, `--label LABEL`.
`--allow-loopback` is a development-only opt-in for exact `http://127.0.0.1`,
`http://localhost`, or `http://[::1]` (optional port/path). Non-loopback HTTP,
credentials, query, fragment, whitespace and backslashes in relay URLs are refused.
HTTPS is syntax-checked, not contacted or authenticated. The CLI never prints keys,
bearers, document payloads, policy contents or raw exception details.

Only the explicit reviewed policy file is read. The output parent must already exist;
the final output directory must not exist. No recursive directory creation. Common
reserved `.dsh`, `profile`, `profiles`, `state`, `production-state`, `dsh-runtimes`
path components and the configured `DSH_HOME` path are refused (lexical and canonical
checks); `DSH_HOME` is used only as a path exclusion, never opened. This is not runtime
path discovery: the owner must ensure a custom production/profile location is not
selected. Use a trusted local staging parent without concurrent writers/symlink
changes. No arbitrary custom-profile detection or hostile-filesystem race guarantee.

The CLI requests directory mode `0700`, file mode `0600`, exclusive `wx` creation,
and writes `.gitignore` containing `*` first. Windows mode bits do **not** establish
private ACLs: the owner must verify staging-directory ACLs before real credential use.
Gitignore is defense-in-depth, not authorization to commit/export secret artifacts.

**Output is not transactional.** Any failure can leave a partially written directory
or file. Nothing is overwritten, deleted, moved or rolled back. **Never apply partial
output.** Keep it isolated for owner review; use a different explicitly new directory
for a later attempt. The CLI does not clean up or resume partial runs.

Generated files: `controller-pair.json` and `worker-v2.json` are secret; protect their
transfer separately. `relay-devices.additions.json` contains only hash-based additions.
`manifest.json` is intentionally non-secret (no native workspace ID, label, relay URL,
raw keys or bearer tokens). A manifest is not proof of runtime validation/application.

## Separate operator plan — no applier provided

1. Obtain the real native workspace ID by an independently authorized Worker-only
   action. Review its intended path and effective native preset/tool/approval policy.
   Do not query/adopt existing SIDs. Choose the exact project ID and policy.
2. Review the stager source/tests and staging ACLs. After explicit consent, generate
   a new bundle outside every runtime/profile/state directory; inspect complete outputs.
3. **On the Worker OS/runtime**, validate the candidate whole worker-v2 document with
   `parseSettingsV2`, the actual target filename and a trusted native `resolveWorkspace`
   resolver. It must resolve the exact ID to the intended existing native workspace.
   Validate state/project disjointness there before opening any stores. The generated
   relative stateDirs resolve beside each role's final settings file, NOT beside this
   document or a remote machine's file. Review those final paths explicitly.
4. A Windows parser cannot validate/stat a Linux `/home/...` workspace path as its
   actual Linux directory. Node on Windows may classify a leading slash as absolute
   on the current drive; that is **not** Linux validation. Never fake validation,
   translate paths between roles, or claim the synthetic current-OS test resolver
   verifies a real VPS. Generator validation is not native workspace resolution.
5. With separate Controller-owner consent, prepare a candidate whole Controller
   document preserving every other pair and unrelated configuration **byte-for-byte**.
   Use the existing logical Controller root ID when appropriate; append only the new
   pair. Reparse the **whole** candidate via `parseSettingsV2` at its final filename
   before opening state: reject endpoint/machine collisions, key/token reuse, pair
   limits and overlapping canonical state paths. This stager cannot check an unseen
   existing config and must never be used as a whole-config replacement.
6. With separate relay-owner consent, review and append just the two new device rows;
   reject ID/hash/reciprocal-binding collisions with all existing devices. Preserve
   existing relay devices/configuration unchanged. Do not replace the relay document
   with this additions array. No relay/controller/tunnel restart or apply is supplied.
7. Installation, transport trust, authentication providers, compatibility/runtime
   readiness, consented application, create/prompt and any production verification
   remain separate tasks. This artifact generator proves none of them.

## Focused tests only

```text
node --test tests/enroll-v2.test.mjs
```

Fixtures use OS-owned temporary directories and an explicit current-OS native resolver
stub. Only those test roots are deleted, after absolute/canonical parent/prefix checks.
No native store, real Controller/VPS config, network, install or full suite is involved.
