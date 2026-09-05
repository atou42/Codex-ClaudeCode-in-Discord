# Steering acceptance and notification delivery

Once the runner accepts a running-turn steer, a failed Discord acknowledgement
must not enqueue the same prompt again. The queue returns the accepted steer
with a `notificationError` and logs the delivery failure instead. Only a rejected
or failed steering operation falls back to the normal queue. This does not
provide durable or exactly-once delivery across restarts or ambiguous runner
responses; those require separate recovery design.
