# Upgrade notes

## Bridge 0.1.6: receipt capacity

Bridge 0.1.6 admits up to 8192 total outgoing records, using the existing transport record budget, while the independent limit of 256 pending messages remains unchanged. Completed authenticated receipts no longer exhaust the old 512-record outbox ceiling. Retention stays at 24 hours; pending ciphertext, ids, receipt authentication, pairing, grants, wire formats and native Session data are unchanged. Existing compatible endpoint stores open without deleting or rewriting their replay history.

**Downgrade warning:** endpoint JSON still uses revision 2, but Bridge 0.1.5 and earlier reject an outbox longer than 512 records. Once 0.1.6 has admitted more than 512 records, an older binary cannot read that state. Do not trim receipts or edit a version to force a downgrade. Keep the newer bridge, or perform deliberate recovery using a coherent compatible pre-upgrade backup and reconcile any later effects. A backup is not permission to silently roll back active operations.

Each endpoint needs its own fix. Updating only the Controller does not raise the capacity of an older Worker. A capacity refusal remains bounded backpressure, not permission to clear state, retry a mutation under a new id, restart a remote machine, or weaken grants. Diagnostic reasons `local-outbox-full` and `local-inbox-full` describe known local transport failures; timeout still does not prove the remote machine stopped. The limit is not unbounded throughput.

If the Worker is the only remote access channel, do not update or stop it without a separately reviewed recovery plan and explicit permission. Use only the supported Plugin Manager or offline CLI for package replacement. This release has no Client half and does not require replacing the Controller UI bundle.

## Endpoint private store revision 2

The endpoint store upgrades from revision 1 to revision 2 on its next successful open. This affects private transport persistence only: pairing, encrypted wire envelopes, grants, native Session data and business mutation journals do not change. Pending messages keep their original ciphertext and identity. Completed or expired outgoing messages retain authenticated compact receipts instead of ciphertext, reducing retained bytes and subsequent whole-document writes.

Opening a revision-1 store validates it fully and decrypts every retained legacy outgoing envelope and pending incoming envelope before one atomic upgrade. Creation time is recovered from the verified original envelope; ids, body digests, expiry, retention and retry fields are not regenerated. Corrupt input is rejected without repair or publication. Revision-2 terminal receipts are checked before use; pending envelopes are still decrypted and correlated.

Older endpoint implementations reject revision 2. Before upgrading, stop both endpoints cleanly and back up their complete private state directories together with the existing pairing configuration. Do not edit the revision number, delete replay records or remove ciphertext manually to downgrade. Any rollback requires deliberate recovery from a coherent pre-upgrade backup and reconciliation of later operations; an old snapshot does not undo native effects already performed. Keep the newer endpoint when no such recovery has been established.
