# Discord session snapshot integrity

A genuinely absent session database may initialize a new store. An existing
file with invalid JSON, root/thread-map/thread-record shapes or favorites-map
shape must be preserved and reported as an error, not reset to an empty store.
Valid legacy thread records and a missing optional favorites map remain valid.

Saving serializes to an exclusively created, private, same-directory temporary
file, flushes and closes that file, then atomically renames it over the snapshot.
Write/flush/rename failures propagate to the caller; the previous snapshot stays
intact. A temporary file created by the failed call is cleaned up when possible.
A process exit may leave an orphan temporary file, which is not treated as a
replacement database. Preserve such evidence for manual diagnosis.

This protects the on-disk snapshot from partial writes; it is not a database
transaction across mutable session objects or concurrent bot processes. It does
not guarantee durability across every filesystem or sudden power loss (the
parent directory is not fsynced). Do not use an in-memory state after a failed
save as evidence that a setting was persisted. Diagnose the storage failure and
restart from a verified snapshot before resuming normal operations.
