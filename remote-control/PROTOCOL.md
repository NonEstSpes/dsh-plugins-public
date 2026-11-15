# Remote Control MVP protocol (v1)

Scope: native DSH only. Controller and worker both make outbound HTTPS long-poll calls to a loopback-bound relay published through Tuna. No SSH, native DSH owner cookies, approval forwarding, file transfer, or deployment/publish operations.

## Relay contract (opaque mailbox)

Node.js ESM, no framework dependencies. Export `createRelay({ directory, devices, pollMs = 10000, maxPending = 256 })` from `relay/server.mjs`. Returns `{ server, close }`; caller uses `server.listen(port, '127.0.0.1')`. `devices` is an array `{ id, tokenHash, peerId }`, where tokenHash is lowercase SHA256 hex of a high-entropy bearer token. Exact one peer per device. IDs use `/^[a-zA-Z0-9_-]{1,80}$/`.

All endpoints except GET /health require Authorization: Bearer <device-token>; timing-safe hash comparison. Requests/responses JSON, no cookies, no request body/token logging, no CORS. HTTP loopback behind HTTPS Tuna; clients refuse non-HTTPS except explicit loopback development mode. Total body maximum 100 KiB. Ciphertext maximum 80 KiB. All responses Cache-Control: no-store.

- GET /health -> { protocol: 1, service: 'dsh-remote-relay' }
- POST /v1/send { id, to, ciphertext } -> { accepted: true }. Receiver must be configured peer. Relay stores before ACK, derives `from` from authenticated device. Stored packet `{ id, from, to, ciphertext, receivedAt }`. Same id and exact original packet is idempotent even after recipient ACK; different payload with same id rejected. Tombstones retained with bounded TTL (at least 24h). Pending mailbox capacity enforced. Default expiry 24h, no silent drop before expiry. Invalid/expired messages must not execute at recipient.
- POST /v1/poll {} -> { items: [packet, ...] } with at most 16 items; wait at most pollMs when empty, return promptly on send. Poll is non-destructive. At most one active poll per device (409 for another). Durable recovery on relay restart. Bound total response bytes (100 KiB; allow one max-size packet).
- POST /v1/ack { ids: [id, ...] } -> { acknowledged: true }. Only authenticated recipient mailbox. ACK is idempotent. No removing an unsent item on another device. Keep dedup tombstone for sender retry. Validate IDs before filesystem operations. Atomic writes and serialized mutation. Close aborts waiting polls and releases sockets; no leaked timers.

No endpoint serves arbitrary files or opens a DSH API. A compromised relay can deny service/observe routing but cannot decrypt payloads.

## End-to-end envelope

Use maintained `jose` library, compact JWE `alg=dir`, `enc=A256GCM`, fresh random 32-byte shared key per controller/worker pair. Relay bearer tokens are DIFFERENT from this key; relay config must NEVER contain the JWE key. Key established by one-time manual transfer of endpoint config over an already trusted channel. No new custom cryptographic algorithm.

Encrypted plaintext `{ version:1, id, from, to, createdAt, expiresAt, kind:'command'|'response'|'report', body }`. Sender/receiver/id must match authenticated outer routing. Enforce expiry and clock-skew bounds; strict size/type checks. Identifiers never become paths without validation. Endpoint stores original outgoing ciphertext durably before send, retains received IDs across restart, and ACKs only after durable handling. Repeat same operation ID with a different body hash is an error. Unknown outcome is visible, never blindly replay mutating side effects.

## Endpoint private persistence (revision 2)

The owned mutable endpoint store now writes revision 2; this is not a wire-envelope or Session-format change. Pending outbox rows retain their exact original JWE, id, body digest, creation/expiry times and retry metadata. After durable relay acceptance, or terminal expiry, the same atomic store commit replaces ciphertext with a compact authenticated receipt. The receipt covers the complete endpoint binding, persistence revision and every retained terminal-row field, including replay retention and retry state. It uses Node.js HKDF-SHA256 with the fixed `dsh-remote:endpoint:outbox-terminal:v2` domain, then HMAC-SHA256; verification uses a constant-time 32-byte comparison. The derived key is endpoint-owned and cleared with the JWE key on close or opening failure. No relay key, network cryptography, replay capacity, ACK rule or scheduler priority changes.

Revision 1 is accepted only as explicit migration input. Before the atomic upgrade and before publishing the endpoint, the reader validates the entire legacy document, decrypts and correlates every legacy outbox envelope and pending inbox envelope, and preserves original ids, body digests, creation/expiry times and terminal states. Pending ciphertext is unchanged; only verified completed payloads become receipts. Invalid legacy or revision-2 state fails closed without repair. Older endpoints cannot read revision 2; see [UPGRADE.md](UPGRADE.md). Terminal identity remains retained for the existing replay window; business-side deduplication and unknown-outcome recovery are still required.

## Native DSH operations

Command body: `{ operationId, action:'create'|'prompt'|'status'|'cancel', sessionId?, projectId?, text? }`. Controller allocates UUID sessionId before create. Worker accepts only configured project IDs; resolves cwd locally; never accepts remote paths, model selection, credentials, configuration, approvals, or arbitrary shell commands. Can access only sessions durably created by this paired controller. Maximum text 16000 UTF-8 bytes. Serial operations; one outstanding prompt per owned session in MVP.

Backend facade (implemented by parent): `ensureSession({sessionId,projectId})`, `prompt({sessionId,operationId,text})`, `status({sessionId})`, `cancel({sessionId})`. Native prompt requestId equals operationId for native dedup. Create must reconcile preallocated session ID rather than re-create after unknown result. Worker enforces ownership before every backend call.

Final report body: `{ sessionId, operationId, reportId, status, text, truncated, finishedAt }`; only bounded assistant text (not reasoning/tool output/source files) automatically exported. Controller accepts only reports correlated to a locally issued operation. Reports stored before chat publication; publication uses a separate deterministic ID and native DSH prompt requestId, labelled as untrusted remote-agent data. No report text is interpreted as permission or dispatched as another command. Chat wake requires explicit per-task user choice; default notification/context mode.

## Initial limits

No remote permission approval: worker-native prompts remain subject to local sandbox/approval settings and may wait for a local human. No automatic publication, patch application, or Git sync. No claim that a worktree is a security sandbox. Worker sessions must be restricted to the configured safe project/preset. TLS, JWE, and a hidden UI are not substitutes for native tool policy/OS sandbox.
