# Retry acceptance

A failed prompt is claimed before awaiting a retry. A successful queue insertion
or running-turn steer consumes that claim; a second retry cannot submit it again.
Slash commands and their owner-bound buttons report whether work was queued or
inserted into the active Codex task. A failed notification does not undo acceptance.

Only a failure before acceptance restores the claim, and only when a newer failure
has not replaced it. This is the existing in-memory retry model, not durable
exactly-once execution or a change to provider rejection/queue fallback policy.
This change depends on the acknowledgement boundary fix in PR #10.
