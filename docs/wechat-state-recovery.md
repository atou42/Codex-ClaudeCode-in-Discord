# WeChat state read failures

Missing JSON files may initialize new state. Existing JSON files that cannot be
read or parsed must instead stop the operation. Parser errors are reported
without quoting file contents, since this reader also loads credentials.

The session store rejects invalid root/user-map/user-record shapes and unknown
schema versions. It does not replace them with an empty database. Preserve the
original file, inspect a separate copy, and restore a known-good backup or
repair the specific corruption before restarting. Do not delete the file to
silence the error. There is no automatic migration or recovery in this change.

This is a read-integrity check, not complete validation of every provider field
or a multi-process transactional store. A missing optional path still disables
that optional persistence as before.
