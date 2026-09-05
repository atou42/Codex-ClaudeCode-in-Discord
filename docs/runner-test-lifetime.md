# Fake runner lifetime in tests

The regular Codex blocker regression uses an EventEmitter instead of a real
ChildProcess. Unlike a real process handle, that emitter does not keep Node's
event loop alive while the production grace timer is unref'ed. The test could
therefore be cancelled, along with the remaining tests, before its assertions.

The fixture now holds a referenced handle until close (also cleaned up after
the test) and has a bounded test deadline. No production grace period, timeout,
assertion, provider behavior, or skip policy is changed. This tests the existing
completion path rather than weakening it or installing a replacement provider.
