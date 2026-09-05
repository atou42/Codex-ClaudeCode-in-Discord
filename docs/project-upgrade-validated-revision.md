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
