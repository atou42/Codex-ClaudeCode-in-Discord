# Steer acceptance and Discord delivery

Once the runner accepts a steer, that input must not also be queued. Failure to
send the Discord acknowledgement does not undo runner acceptance. Such a
failure is logged as a confirmation failure, and `/progress` or `/status` can
be used to inspect the active task. An actual steer rejection still falls back
to the existing queue behavior.

This distinction does not add durable queues or message-level deduplication,
and it does not guarantee exactly-once processing across a bot restart.
