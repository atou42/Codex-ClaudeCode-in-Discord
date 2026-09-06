# Validated project upgrade revisions

An upgrade validates a fixed commit in a temporary worktree and fast-forwards
to that same commit, not to a mutable remote-tracking branch. An independent
fetch that advances `origin/main` during validation must not cause an untested
revision to be installed. A subsequent status check can still report that a
newer remote revision is available; that revision needs its own validation.

This guarantee concerns the selected commit. It does not make dependency
installation reproducible, reserve the main worktree against unrelated local
writers, implement rollback after installation failure, or change dry-run and
restart behavior. Those concerns require separate safeguards.

If A has already passed validation and remains fast-forwardable, a later fetch
of B does not reject A. The final HEAD is A; the apply report and returned status
identify B as still available and requiring validation. Revision tests invoke
real Git only in temporary repositories and inject installation/verification
results; no real dependency install, service command, or notification is run.
