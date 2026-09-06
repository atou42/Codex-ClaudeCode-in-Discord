# WeChat dangerous-mode policy

`WECHAT_ALLOW_DANGEROUS=false` (the default) blocks dangerous runs, not just the
`/mode dangerous` command. A saved dangerous session from an earlier deployment
must not bypass a subsequently disabled environment policy. The bridge and the
runtime receive the same parsed policy at startup.

When such a session is encountered, the runtime refuses before acquiring a
workspace lock or starting the runner. It reports the policy conflict and asks
for `/mode safe` or explicit administrator enablement. It does not silently
rewrite saved state or downgrade the user's requested execution mode.

This is enforcement of the bridge policy before launch, not verification of a
particular native Codex binary's OS sandbox. Environment changes take effect on
startup as before; this change does not hot-reload process environment values.
