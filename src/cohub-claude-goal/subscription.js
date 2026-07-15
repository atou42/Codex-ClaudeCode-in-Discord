// Event-driven subscription session over a CohubPort.
//
// Fixed order: install listener -> connect -> subscribe every relevant
// Space room -> wait for each room's subscribe.ok -> one HTTP
// reconciliation. Every call to run() is a fresh control-loop decision and
// always performs exactly one fresh reconcile before it may park -- prior
// snapshots are never reused across calls. Only after that reconciliation
// completes may the caller block-park. No interval polling, ever: the only
// things that end a park are a live watched event, a disconnect/reconnect
// backfill, or the hard timeout.
//
// The generation counter is what prevents the park race: it increments
// synchronously on every accepted watched event, every subscribe.ok, and
// every disconnect/reconnect. A reconcile that started before some change
// compares generationBefore/generationAfter and, on mismatch, reconciles
// again rather than trusting a result that is already stale. When about to
// park, the code registers a waiter and re-checks generation in the same
// synchronous critical section (nothing else runs in between on the
// single-threaded event loop), so an event landing in that exact window
// cancels the park instead of being missed until some future wakeup.
//
// A timeout is returned as an explicit { status: 'timeout' } outcome for the
// caller to map to EVENT_WAIT_TIMEOUT / BLOCKED. It is never treated as a
// signal to continue or retried internally.

export function createDedupeStore() {
  const eventIds = new Set();
  const logicalKeys = new Set();
  return {
    hasEvent(eventId) {
      return eventIds.has(eventId);
    },
    hasLogical(key) {
      return logicalKeys.has(key);
    },
    recordEvent(eventId) {
      eventIds.add(eventId);
    },
    recordLogical(key) {
      logicalKeys.add(key);
    },
  };
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'merged']);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isValidHex64(value) {
  return typeof value === 'string' && value.length === 64 && /^[0-9a-f]{64}$/.test(value);
}

function hasOwnDataProperty(obj, key) {
  const desc = Object.getOwnPropertyDescriptor(obj, key);
  return desc !== undefined && desc.value !== undefined && !desc.get && !desc.set;
}

/**
 * Fail-closed shape validation for a live event before any part of it is
 * used to build a delimiter-joined dedupe key or a watch-set lookup.
 * Malformed events (missing/wrong-typed fields, unknown terminalStatus, or
 * any field containing the key delimiter, or events with inherited/accessor
 * properties) are rejected outright rather than silently coerced -- a
 * malformed event must never be able to collide with, or be mistaken for, a
 * different logical key.
 */
function validateTurnEvent(event) {
  if (!event || typeof event !== 'object') return false;

  // Reject events with inherited or accessor properties
  const requiredKeys = ['kind', 'id', 'spaceId', 'sessionId', 'turnId', 'terminalStatus'];
  for (const key of requiredKeys) {
    if (!hasOwnDataProperty(event, key)) return false;
  }

  // Reject if there are any unexpected own properties (fail-closed)
  const ownKeys = Object.getOwnPropertyNames(event);
  for (const key of ownKeys) {
    if (!requiredKeys.includes(key)) return false;
  }

  if (event.kind !== 'turn') return false;
  if (!isNonEmptyString(event.id)) return false;
  if (!isNonEmptyString(event.spaceId)) return false;
  if (!isNonEmptyString(event.sessionId)) return false;
  if (!isNonEmptyString(event.turnId)) return false;
  if (!isNonEmptyString(event.terminalStatus)) return false;
  if (!TERMINAL_STATUSES.has(event.terminalStatus)) return false;
  const fields = [event.id, event.spaceId, event.sessionId, event.turnId, event.terminalStatus];
  if (fields.some((f) => f.includes('::'))) return false;
  return true;
}

function logicalKeyFor(event) {
  return `${event.spaceId}::${event.sessionId}::${event.turnId}::${event.terminalStatus}`;
}

export function createSubscriptionSession({
  port,
  spaceIds,
  watchSet,
  reconcile,
  dedupeStore = createDedupeStore(),
  hooks = {},
  hardTimeoutMs = 40 * 60 * 1000,
}) {
  if (!Array.isArray(spaceIds) || spaceIds.length === 0) {
    throw new Error('createSubscriptionSession requires a non-empty spaceIds array');
  }
  if (!Array.isArray(watchSet)) {
    throw new Error('createSubscriptionSession requires a watchSet array');
  }
  if (typeof hardTimeoutMs !== 'number' || hardTimeoutMs <= 0) {
    throw new Error('hardTimeoutMs must be positive');
  }

  // Validate watch entries: exact own-property plain objects with exactly spaceId+sessionId
  const watchedSpaceIds = new Set(spaceIds);
  const watchKeys = new Set();
  for (const w of watchSet) {
    if (!w || typeof w !== 'object') {
      throw new Error('invalid watch entry: must be an object');
    }
    if (!hasOwnDataProperty(w, 'spaceId') || !hasOwnDataProperty(w, 'sessionId')) {
      throw new Error('invalid watch entry: must have own spaceId and sessionId properties');
    }
    if (!isNonEmptyString(w.spaceId) || !isNonEmptyString(w.sessionId)) {
      throw new Error('invalid watch entry: spaceId and sessionId must be non-empty strings');
    }
    if (!watchedSpaceIds.has(w.spaceId)) {
      throw new Error(`watch entry references space ${w.spaceId} not in spaceIds`);
    }
    const key = `${w.spaceId}::${w.sessionId}`;
    if (watchKeys.has(key)) {
      throw new Error(`duplicate watch entry for ${w.spaceId}::${w.sessionId}`);
    }
    watchKeys.add(key);
  }

  let observedGeneration = 0;
  let queue = [];
  let closed = false;
  let subscribedAndAcked = false;
  let unsubscribeListener = null;
  let disconnectedSinceLastAck = false;
  let runInProgress = false;
  let closeInProgress = false;
  let portCloseCalled = false;

  /** @type {Array<(result: string) => void>} */
  const waiters = [];

  const metrics = {
    logicalApplicationCount: 0,
    duplicateObservationCount: 0,
    rejectedMalformedEventCount: 0,
    parkCount: 0,
    reconcileCount: 0,
    subscribeAckCount: 0,
  };

  function isWatched(event) {
    return watchedSpaceIds.has(event.spaceId) && watchKeys.has(`${event.spaceId}::${event.sessionId}`);
  }

  function bumpGeneration() {
    observedGeneration += 1;
    // Wake every currently-parked waiter synchronously. This is the
    // mechanism that closes the park race: registering a waiter and
    // comparing generation happens in one synchronous critical section, so
    // either the waiter is already registered here (and gets woken) or the
    // park() caller has not yet registered and will see the bumped
    // generation on its own synchronous re-check before it ever awaits.
    const toWake = waiters.splice(0, waiters.length);
    for (const wake of toWake) wake('woken');
  }

  function handleIncomingEvent(event) {
    if (closed) return;
    if (event?.kind === 'disconnected') {
      subscribedAndAcked = false;
      disconnectedSinceLastAck = true;
      bumpGeneration();
      return;
    }
    if (event?.kind === 'reconnected') {
      bumpGeneration();
      return;
    }
    if (event?.kind !== 'turn') return;

    if (!validateTurnEvent(event)) {
      metrics.rejectedMalformedEventCount += 1;
      return;
    }
    if (!isWatched(event)) return;

    if (dedupeStore.hasEvent(event.id)) {
      metrics.duplicateObservationCount += 1;
      return;
    }
    dedupeStore.recordEvent(event.id);

    const logicalKey = logicalKeyFor(event);
    if (dedupeStore.hasLogical(logicalKey)) {
      metrics.duplicateObservationCount += 1;
      return;
    }

    // Clone the event to prevent caller mutation from affecting dedupe state
    queue.push({ ...event });
    bumpGeneration();
  }

  function installListener() {
    if (unsubscribeListener) return;
    unsubscribeListener = port.onEvent(handleIncomingEvent);
  }

  async function ensureSubscribedAndAcked() {
    if (closed) throw new Error('subscription session is closed');
    disconnectedSinceLastAck = false;
    await port.connect();
    if (closed) throw new Error('subscription session is closed');
    await port.subscribe(spaceIds);
    if (closed) throw new Error('subscription session is closed');
    for (const spaceId of spaceIds) {
      await port.waitForSubscribeAck(spaceId);
      if (closed) throw new Error('subscription session is closed');
      metrics.subscribeAckCount += 1;
      bumpGeneration();
    }
    subscribedAndAcked = true;
  }

  function drainQueueAsLogicalApplications() {
    const applied = [];
    for (const event of queue) {
      const logicalKey = logicalKeyFor(event);
      if (dedupeStore.hasLogical(logicalKey)) {
        metrics.duplicateObservationCount += 1;
        continue;
      }
      dedupeStore.recordLogical(logicalKey);
      metrics.logicalApplicationCount += 1;
      // Return a fresh clone to prevent caller mutation
      applied.push({ ...event });
    }
    queue = [];
    return applied;
  }

  async function doReconcile() {
    if (closed) throw new Error('subscription session is closed');
    const generationBefore = observedGeneration;
    const snapshot = await reconcile(port);
    if (closed) throw new Error('subscription session is closed');

    // Validate reconcile return value
    if (!snapshot || typeof snapshot !== 'object') {
      throw new Error('reconcile must return an object (invalid snapshot)');
    }
    if (!hasOwnDataProperty(snapshot, 'snapshotHash')) {
      throw new Error('reconcile snapshot must have own snapshotHash property');
    }
    if (!isValidHex64(snapshot.snapshotHash)) {
      throw new Error('reconcile snapshot.snapshotHash must be 64 lowercase hex characters');
    }

    hooks.afterReconcileFetch?.();
    const generationAfter = observedGeneration;
    metrics.reconcileCount += 1;
    return { snapshot, generationBefore, generationAfter };
  }

  /**
   * Register a waiter and synchronously compare generation in the same
   * critical section. Resolves with 'changed' if generation already moved
   * (never parks on a stale decision), 'timeout' on hardTimeoutMs, 'closed'
   * if the session is closed while parked, or 'woken' once a real
   * event/disconnect/reconnect bumps generation.
   */
  function park(generationAtParkDecision) {
    metrics.parkCount += 1;
    hooks.beforePark?.();

    return new Promise((resolve) => {
      let settled = false;
      let timer = null;

      function settle(result) {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      }

      // Synchronous critical section: register, then re-check. If
      // bumpGeneration already ran between the caller's decision and this
      // line, observedGeneration will already differ and we short-circuit
      // instead of registering a waiter that would never fire.
      waiters.push(settle);
      if (observedGeneration !== generationAtParkDecision) {
        const idx = waiters.indexOf(settle);
        if (idx >= 0) waiters.splice(idx, 1);
        settle('changed');
        return;
      }

      timer = setTimeout(() => {
        const idx = waiters.indexOf(settle);
        if (idx >= 0) waiters.splice(idx, 1);
        settle('timeout');
      }, hardTimeoutMs);
    });
  }

  /**
   * Run one control-loop pass: fresh-reconcile against `callerSnapshotHash`,
   * and if nothing has changed, park until a watched terminal event arrives,
   * the connection drops and needs backfill, or hardTimeoutMs elapses.
   */
  async function run(callerSnapshotHash) {
    if (closed) throw new Error('subscription session is closed');
    if (runInProgress) throw new Error('run() already in progress; concurrent calls are not allowed');
    if (!isValidHex64(callerSnapshotHash)) {
      throw new Error('invalid callerSnapshotHash: must be 64 lowercase hex characters');
    }

    runInProgress = true;
    try {
      installListener();
      hooks.afterListenerInstalled?.();

      if (!subscribedAndAcked) {
        await ensureSubscribedAndAcked();
      }

      for (;;) {
        if (closed) return { status: 'closed' };

        if (disconnectedSinceLastAck) {
          // A disconnect was observed (possibly mid-reconcile, below). Any
          // read in flight across a disconnect cannot be trusted as the
          // reconnect backfill read the protocol requires, so always
          // re-subscribe and re-ack before trusting the next HTTP read.
          await ensureSubscribedAndAcked();
        }

        const preApplied = drainQueueAsLogicalApplications();
        const { snapshot, generationBefore, generationAfter } = await doReconcile();
        // Catch anything that arrived synchronously during the HTTP round
        // trip itself (the EVT-02 critical window) so it is counted as a
        // logical application exactly once instead of being silently dropped.
        const postApplied = drainQueueAsLogicalApplications();
        const applied = [...preApplied, ...postApplied];

        if (disconnectedSinceLastAck) {
          // The disconnect happened during this very reconcile; discard this
          // read and go back through the resubscribe-then-reconcile path.
          continue;
        }

        if (applied.length > 0 || snapshot.snapshotHash !== callerSnapshotHash) {
          return { status: 'changed', snapshot, appliedEvents: applied };
        }

        if (generationAfter !== generationBefore) {
          // Something else happened during the HTTP round-trip itself;
          // reconcile again rather than parking on a result already stale.
          continue;
        }

        const parkResult = await park(generationAfter);
        if (parkResult === 'timeout') {
          return { status: 'timeout', snapshot };
        }
        if (parkResult === 'closed') {
          return { status: 'closed' };
        }
        // 'woken' or 'changed': loop back and reconcile against fresh state.
      }
    } finally {
      runInProgress = false;
    }
  }

  async function close() {
    if (closeInProgress) return;
    closeInProgress = true;
    closed = true;
    // Wake any currently-parked wait immediately instead of leaving it
    // hanging until a hard timeout that would never come from a closed
    // session.
    const toWake = waiters.splice(0, waiters.length);
    for (const wake of toWake) wake('closed');
    if (unsubscribeListener) {
      unsubscribeListener();
      unsubscribeListener = null;
    }
    if (!portCloseCalled) {
      portCloseCalled = true;
      await port.close();
    }
  }

  return {
    run,
    getMetrics: () => ({ ...metrics }),
    close,
  };
}
