# WeChat workspace boundaries

`WECHAT_WORKSPACE_ROOTS` is an allowlist of existing directories. The bridge
resolves configured roots and selected workspaces to their real filesystem
paths, so a symlink inside an allowed root cannot grant access outside that
root. A configured root may itself be a symlink to an approved directory.

`/dir`, `/resume <thread-id>`, and numbered `/resume` selections are checked
before changing the current binding. A rejected selection leaves the session
and its saved workspace unchanged. Recent-session lists exclude targets that
are outside the allowlist. The stored and displayed workspace is canonical.

This is a bridge-level directory boundary, not a replacement for Codex's own
sandbox. It does not guarantee protection against a local process concurrently
replacing filesystem directories after validation.
