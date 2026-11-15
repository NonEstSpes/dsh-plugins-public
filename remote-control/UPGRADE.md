# Upgrade notes

## Endpoint private store revision 2

The endpoint store upgrades from revision 1 to revision 2 on its next successful open. This affects private transport persistence only: pairing, encrypted wire envelopes, grants, native Session data and business mutation journals do not change. Pending messages keep their original ciphertext and identity. Completed or expired outgoing messages retain authenticated compact receipts instead of ciphertext, reducing retained bytes and subsequent whole-document writes.

Opening a revision-1 store validates it fully and decrypts every retained legacy outgoing envelope and pending incoming envelope before one atomic upgrade. Creation time is recovered from the verified original envelope; ids, body digests, expiry, retention and retry fields are not regenerated. Corrupt input is rejected without repair or publication. Revision-2 terminal receipts are checked before use; pending envelopes are still decrypted and correlated.

Older endpoint implementations reject revision 2. Before upgrading, stop both endpoints cleanly and back up their complete private state directories together with the existing pairing configuration. Do not edit the revision number, delete replay records or remove ciphertext manually to downgrade. Any rollback requires deliberate recovery from a coherent pre-upgrade backup and reconciliation of later operations; an old snapshot does not undo native effects already performed. Keep the newer endpoint when no such recovery has been established.
