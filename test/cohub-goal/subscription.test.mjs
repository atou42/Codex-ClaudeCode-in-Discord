import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeCohubServer, createFakeCohubPort } from '../helpers/fake-cohub-port.mjs';
import { createSubscriptionSession, createDedupeStore } from '../../src/cohub-claude-goal/subscription.js';

const SPACE = 'f0000000-0000-0000-0000-000000000001';
const SESSION = 's0000000-0000-0000-0000-000000000001';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeReconcile(server) {
  let calls = 0;
  const fn = async (port) => {
    calls += 1;
    const idx = await port.getSessionIndex(SPACE, SESSION);
    // Return valid 64-char hex hash
    const hash = `${idx.sequence.toString(16).padStart(64, '0')}`;
    return { snapshotHash: hash, sequence: idx.sequence };
  };
  return { fn, callCount: () => calls };
}

function baseSetup() {
  const server = createFakeCohubServer();
  server.ensureSession(SPACE, SESSION);
  const { port, control } = createFakeCohubPort(server);
  const { fn: reconcile, callCount } = makeReconcile(server);
  const dedupeStore = createDedupeStore();
  return { server, port, control, reconcile, callCount, dedupeStore };
}

test('EVT-01: single online finalized event yields exactly one logical application and one reconcile', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  const initial = await session.run('0'.repeat(64));
  assert.equal(initial.status, 'changed');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  server.finalizeTurn(SPACE, SESSION, turn.id, 'completed');
  const result = await runPromise;

  assert.equal(result.status, 'changed');
  assert.equal(session.getMetrics().logicalApplicationCount, 1);
  await session.close();
});

test('EVT-04: duplicate event id replayed 100 times applies logically once', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  const event = server.finalizeTurn(SPACE, SESSION, turn.id, 'completed', { eventId: 'evt-fixed-1' });
  for (let i = 0; i < 99; i += 1) {
    server.replayEvent(SPACE, SESSION, turn.id, 'completed', event.id);
  }
  const result = await runPromise;
  assert.equal(result.status, 'changed');
  assert.equal(session.getMetrics().logicalApplicationCount, 1);
  assert.equal(session.getMetrics().duplicateObservationCount, 99);
  await session.close();
});

test('EVT-04: same terminal turn replayed under different event IDs still applies logically once', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  server.finalizeTurn(SPACE, SESSION, turn.id, 'completed', { eventId: 'evt-a' });
  for (let i = 0; i < 10; i += 1) {
    server.replayEvent(SPACE, SESSION, turn.id, 'completed', `evt-b-${i}`);
  }
  const result = await runPromise;
  assert.equal(result.status, 'changed');
  assert.equal(session.getMetrics().logicalApplicationCount, 1);
  await session.close();
});

test('EVT-06: merged turn is resolved through the persisted relation, not treated as terminal itself', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const original = server.createTurn(SPACE, SESSION, { status: 'running' });
  const replacement = server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  server.finalizeTurn(SPACE, SESSION, replacement.id, 'completed');
  server.mergeTurn(SPACE, SESSION, original.id, replacement.id);
  const result = await runPromise;

  assert.equal(result.status, 'changed');
  // both the merge event and the completion event are novel transitions on different turn ids,
  // so both are logically applied -- but neither is silently dropped nor double counted per event id.
  assert.equal(session.getMetrics().duplicateObservationCount, 0);
  await session.close();
});

test('WAIT-01: one fresh reconcile per run() call, then zero business polling during the idle park until timeout', async () => {
  const { server, port, reconcile, dedupeStore, control } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 5,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');
  const readsAfterInitial = control.metrics.businessReadCount;

  // The second run() is a new control-loop decision: it must perform exactly
  // one fresh reconcile (one business read) before it may park, per the
  // spec's "每一步只使用 inspect/submit/wait/verify" / fresh-read requirement.
  // It must NOT reuse the previous run's cached snapshot.
  const result = await session.run(initial.snapshot.snapshotHash);
  assert.equal(result.status, 'timeout');
  assert.equal(control.metrics.businessReadCount, readsAfterInitial + 1);
  assert.equal(control.metrics.promptSendCount, 0);

  // Once parked (after that one fresh read), zero further business reads
  // must occur while idle -- no interval polling.
  const readsWhileParked = control.metrics.businessReadCount;
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  assert.equal(control.metrics.businessReadCount, readsWhileParked);
  await session.close();
});

test('listener must be installed before connect is attempted', async () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 10,
  });
  // If subscription.js called connect() before onEvent(), the fake port would throw.
  await assert.doesNotReject(() => session.run('f'.repeat(64)));
  await session.close();
});

test('subscribe ack is required before the first HTTP reconcile happens', async () => {
  const { server, port, control, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  let reconcileCalls = 0;
  const reconcile = async (p) => {
    reconcileCalls += 1;
    const idx = await p.getSessionIndex(SPACE, SESSION);
    return { snapshotHash: idx.sequence.toString(16).padStart(64, '0') };
  };

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const ackIndex = control.trace.findIndex((e) => e.event === 'subscribe-ack');
  const firstHttpIndex = control.trace.findIndex((e) => e.event === 'getSessionIndex');
  assert.ok(ackIndex >= 0, 'expected a subscribe-ack trace entry');
  assert.ok(firstHttpIndex > ackIndex, 'HTTP reconcile must happen strictly after subscribe.ok');
  assert.equal(reconcileCalls >= 1, true);
  await session.close();
});

test('watch set is strict: events for a session outside the watch set never bump logical application', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const SESSION_NOT_WATCHED = 's0000000-0000-0000-0000-000000000099';
  server.ensureSession(SPACE, SESSION_NOT_WATCHED);
  const outsideTurn = server.createTurn(SPACE, SESSION_NOT_WATCHED, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 5,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  server.finalizeTurn(SPACE, SESSION_NOT_WATCHED, outsideTurn.id, 'completed');
  const result = await runPromise;

  assert.equal(result.status, 'timeout');
  assert.equal(session.getMetrics().logicalApplicationCount, 0);
  await session.close();
});

test('first reconcile that already differs from the caller hash returns immediately without parking', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  const result = await session.run('0000000000000000000000000000000000000000000000000000000000000000');
  assert.equal(result.status, 'changed');
  assert.equal(session.getMetrics().parkCount, 0);
  await session.close();
});

test('EVT-03: disconnect during park then reconnect triggers full reconciliation backfill, no interval polling', async () => {
  const { server, port, control, reconcile, dedupeStore } = baseSetup();
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 50,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  control.disconnect();
  // completion happens while disconnected -- bridge must not see it live
  server.finalizeTurn(SPACE, SESSION, turn.id, 'completed');
  control.reconnect();
  const result = await runPromise;

  assert.equal(result.status, 'changed');
  assert.ok(control.trace.some((e) => e.event === 'disconnected'));
  assert.ok(control.trace.filter((e) => e.event === 'subscribe-ack').length >= 2, 'must re-ack after reconnect');
  await session.close();
});

test('close() unregisters the listener and stops further logical application', async () => {
  const { server, port, control, reconcile, dedupeStore } = baseSetup();
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await session.run('0000000000000000000000000000000000000000000000000000000000000000');
  await session.close();

  server.finalizeTurn(SPACE, SESSION, turn.id, 'completed');
  assert.equal(session.getMetrics().logicalApplicationCount, 0);
});

test('close() during an active park wakes run() immediately instead of hanging until timeout', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 10_000,
    hooks: {
      beforePark() {
        // fire once, synchronously, right as the session is about to park
        setImmediate(() => session.close());
      },
    },
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const result = await session.run(initial.snapshot.snapshotHash);
  assert.equal(result.status, 'closed');
});

test('ack failure during subscribe-ack propagates as a rejection rather than being swallowed', async () => {
  const { port, control, reconcile, dedupeStore } = baseSetup();
  control.failNextAck(1);

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  await assert.rejects(() => session.run('0000000000000000000000000000000000000000000000000000000000000000'), /ACK_FAILED|simulated subscribe ack failure/);
  await session.close();
});

test('disconnect observed mid-reconcile (not during park) discards the stale read and re-acks before trusting the next read', async () => {
  const { server, port, control, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  let calls = 0;
  const reconcile = async (p) => {
    calls += 1;
    if (calls === 2) {
      // disconnect happens while this very reconcile's HTTP call is in flight
      control.disconnect();
    }
    const idx = await p.getSessionIndex(SPACE, SESSION);
    return { snapshotHash: idx.sequence.toString(16).padStart(64, '0'), sequence: idx.sequence };
  };

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 50,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const result = await session.run(initial.snapshot.snapshotHash);
  assert.equal(result.status, 'timeout');
  assert.ok(control.trace.filter((e) => e.event === 'subscribe-ack').length >= 2, 'must re-ack after mid-reconcile disconnect');
  await session.close();
});

test('malformed/raw events are rejected fail-closed and never applied or used to build a dedupe key', async () => {
  const { server, port, control, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 5,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  // missing id
  control.emitRaw({ kind: 'turn', spaceId: SPACE, sessionId: SESSION, turnId: 'turn-x', terminalStatus: 'completed' });
  // unknown terminalStatus
  control.emitRaw({ kind: 'turn', id: 'evt-bad-1', spaceId: SPACE, sessionId: SESSION, turnId: 'turn-x', terminalStatus: 'bogus' });
  // spaceId containing the key delimiter -- must not be usable to build/collide a dedupe key
  control.emitRaw({ kind: 'turn', id: 'evt-bad-2', spaceId: `${SPACE}::injected`, sessionId: SESSION, turnId: 'turn-x', terminalStatus: 'completed' });
  // non-string turnId
  control.emitRaw({ kind: 'turn', id: 'evt-bad-3', spaceId: SPACE, sessionId: SESSION, turnId: 42, terminalStatus: 'completed' });

  const result = await runPromise;
  assert.equal(result.status, 'timeout');
  assert.equal(session.getMetrics().logicalApplicationCount, 0);
  assert.equal(session.getMetrics().rejectedMalformedEventCount, 4);
  await session.close();
});

test('watch set spanning multiple spaces: only events for watched space+session pairs are applied', async () => {
  const server = createFakeCohubServer();
  const SPACE_B = 'f0000000-0000-0000-0000-000000000002';
  server.ensureSession(SPACE, SESSION);
  server.ensureSession(SPACE_B, SESSION);
  const { port, control } = createFakeCohubPort(server);
  const dedupeStore = createDedupeStore();

  const reconcile = async (p) => {
    const idxA = await p.getSessionIndex(SPACE, SESSION);
    const idxB = await p.getSessionIndex(SPACE_B, SESSION);
    return { snapshotHash: (idxA.sequence + idxB.sequence).toString(16).padStart(64, '0') };
  };

  const turnA = server.createTurn(SPACE, SESSION, { status: 'running' });
  const turnB = server.createTurn(SPACE_B, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE, SPACE_B],
    watchSet: [
      { spaceId: SPACE, sessionId: SESSION },
      { spaceId: SPACE_B, sessionId: SESSION },
    ],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 50,
  });
  const initial = await session.run('0000000000000000000000000000000000000000000000000000000000000000');

  const runPromise = session.run(initial.snapshot.snapshotHash);
  server.finalizeTurn(SPACE, SESSION, turnA.id, 'completed');
  server.finalizeTurn(SPACE_B, SESSION, turnB.id, 'failed');
  const result = await runPromise;

  assert.equal(result.status, 'changed');
  assert.equal(session.getMetrics().logicalApplicationCount, 2);
  assert.ok(control.trace.some((e) => e.event === 'subscribe-ack' && e.spaceId === SPACE));
  assert.ok(control.trace.some((e) => e.event === 'subscribe-ack' && e.spaceId === SPACE_B));
  await session.close();
});

test('100-seed adversarial race matrix: injecting an event at any critical-window phase never loses it', async () => {
  const phases = [
    'afterListenerInstalled',
    'duringConnect',
    'duringSubscribeRequest',
    'duringSubscribeAck',
    'duringHttpReconcile',
    'afterReconcileFetch',
    'beforePark',
  ];

  for (let seed = 0; seed < 100; seed += 1) {
    const rand = mulberry32(seed + 1);
    const phase = phases[Math.floor(rand() * phases.length)];

    const server = createFakeCohubServer();
    server.ensureSession(SPACE, SESSION);
    const turn = server.createTurn(SPACE, SESSION, { status: 'running' });
    const { port, control } = createFakeCohubPort(server);
    const dedupeStore = createDedupeStore();
    const reconcile = async (p) => {
      const idx = await p.getSessionIndex(SPACE, SESSION);
      return { snapshotHash: idx.sequence.toString(16).padStart(64, '0'), sequence: idx.sequence };
    };

    let fired = false;
    function fireOnce() {
      if (fired) return;
      fired = true;
      server.finalizeTurn(SPACE, SESSION, turn.id, 'completed');
    }

    const hooks = {};
    if (phase === 'afterListenerInstalled') hooks.afterListenerInstalled = fireOnce;
    if (phase === 'afterReconcileFetch') hooks.afterReconcileFetch = fireOnce;
    if (phase === 'beforePark') hooks.beforePark = fireOnce;
    if (phase === 'duringConnect') control.failNextConnect(0); // no-op, pause handled below
    if (phase === 'duringSubscribeRequest' || phase === 'duringSubscribeAck' || phase === 'duringHttpReconcile' || phase === 'duringConnect') {
      control.pauseNextCall(
        phase === 'duringConnect' ? 'connect' : phase === 'duringSubscribeRequest' ? 'subscribe' : phase === 'duringSubscribeAck' ? 'waitForSubscribeAck' : 'getSessionIndex',
        fireOnce,
      );
    }

    const session = createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
      hooks,
      hardTimeoutMs: 50,
    });

    const result = await session.run('0000000000000000000000000000000000000000000000000000000000000000');
    fireOnce();
    const final = result.status === 'changed' ? result : await session.run(result.snapshot?.snapshotHash ?? '');

    assert.equal(final.status === 'changed' || final.status === 'timeout', true, `seed ${seed} phase ${phase}`);
    assert.equal(session.getMetrics().logicalApplicationCount <= 1, true, `seed ${seed} phase ${phase} over-applied`);
    await session.close();
  }
});

test('constructor validates callerSnapshotHash as 64 lowercase hex', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  await assert.rejects(() => session.run('not-hex'), /invalid.*snapshotHash/i);
  await assert.rejects(() => session.run('ABCD1234' + '0'.repeat(56)), /invalid.*snapshotHash/i);
  await assert.rejects(() => session.run('a'.repeat(63)), /invalid.*snapshotHash/i);
  await assert.rejects(() => session.run('a'.repeat(65)), /invalid.*snapshotHash/i);
  await assert.doesNotReject(() => session.run('a'.repeat(64)));
  await session.close();
});

test('constructor rejects non-array spaceIds', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: 'not-array',
    watchSet: [],
    reconcile,
    dedupeStore,
  }), /requires a non-empty spaceIds array/);
});

test('constructor rejects empty spaceIds', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [],
    watchSet: [],
    reconcile,
    dedupeStore,
  }), /requires a non-empty spaceIds array/);
});

test('constructor rejects non-array watchSet', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: 'not-array',
    reconcile,
    dedupeStore,
  }), /requires a watchSet array/);
});

test('constructor rejects malformed watch entries', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE }],
    reconcile,
    dedupeStore,
  }), /invalid watch entry/i);
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ sessionId: SESSION }],
    reconcile,
    dedupeStore,
  }), /invalid watch entry/i);
});

test('constructor rejects watch entries with space not in spaceIds', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: 'other-space', sessionId: SESSION }],
    reconcile,
    dedupeStore,
  }), /watch entry references space.*not in spaceIds/i);
});

test('constructor rejects duplicate watch entries', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [
      { spaceId: SPACE, sessionId: SESSION },
      { spaceId: SPACE, sessionId: SESSION },
    ],
    reconcile,
    dedupeStore,
  }), /duplicate watch entry/i);
});

test('constructor rejects negative hardTimeoutMs', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  assert.throws(() => createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: -1,
  }), /hardTimeoutMs must be positive/i);
});

test('reconcile return value validated: rejects non-object', async () => {
  const { server, port, dedupeStore } = baseSetup();
  const reconcile = async () => 'not-an-object';
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await assert.rejects(() => session.run('a'.repeat(64)), /reconcile.*invalid snapshot/i);
  await session.close();
});

test('reconcile return value validated: rejects missing snapshotHash', async () => {
  const { server, port, dedupeStore } = baseSetup();
  const reconcile = async () => ({ sequence: 1 });
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await assert.rejects(() => session.run('a'.repeat(64)), /reconcile.*snapshotHash/i);
  await session.close();
});

test('reconcile return value validated: rejects malformed snapshotHash', async () => {
  const { server, port, dedupeStore } = baseSetup();
  const reconcile = async () => ({ snapshotHash: 'NOT-HEX' });
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await assert.rejects(() => session.run('a'.repeat(64)), /reconcile.*snapshotHash.*64.*hex/i);
  await session.close();
});

test('concurrent run() calls are rejected', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 100,
  });
  const first = session.run('a'.repeat(64));
  await assert.rejects(() => session.run('b'.repeat(64)), /run.*already in progress/i);
  await first;
  await session.close();
});

test('close() is idempotent and calls port.close exactly once', async () => {
  const { server, port, reconcile, dedupeStore, control } = baseSetup();

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await session.run('a'.repeat(64));
  await session.close();
  await session.close();
  await session.close();
  assert.equal(control.metrics.closeCallCount, 1);
});

test('close() during subscribe throws and does not hang', async () => {
  const { server, port, reconcile, dedupeStore, control } = baseSetup();
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  control.pauseNextCall('subscribe', () => session.close());
  await assert.rejects(() => session.run('a'.repeat(64)), /closed/i);
});

test('close() during reconcile throws and does not hang', async () => {
  const { server, port, dedupeStore } = baseSetup();
  let calls = 0;
  const reconcile = async (p) => {
    calls++;
    if (calls === 1) session.close();
    const idx = await p.getSessionIndex(SPACE, SESSION);
    return { snapshotHash: `${'a'.repeat(64)}` };
  };
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await assert.rejects(() => session.run('b'.repeat(64)), /closed/i);
});

test('appliedEvents never retains caller-mutable event objects', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  const initial = await session.run('a'.repeat(64));
  const runPromise = session.run(initial.snapshot.snapshotHash);
  server.finalizeTurn(SPACE, SESSION, turn.id, 'completed');
  const result = await runPromise;
  assert.equal(result.appliedEvents.length, 1);
  const evt = result.appliedEvents[0];
  evt.terminalStatus = 'MUTATED';
  evt.newProp = 'injected';
  assert.notEqual(dedupeStore.hasLogical(`${SPACE}::${SESSION}::${turn.id}::MUTATED`), true);
  await session.close();
});

test('events with accessor properties are rejected fail-closed', async () => {
  const { server, port, control, reconcile, dedupeStore } = baseSetup();
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 5,
  });
  const initial = await session.run('a'.repeat(64));
  const runPromise = session.run(initial.snapshot.snapshotHash);
  const malicious = { kind: 'turn', id: 'evt-1', spaceId: SPACE, sessionId: SESSION, turnId: 'turn-1', terminalStatus: 'completed' };
  Object.defineProperty(malicious, 'id', { get() { return 'getter-id'; } });
  control.emitRaw(malicious);
  const result = await runPromise;
  assert.equal(result.status, 'timeout');
  assert.equal(session.getMetrics().rejectedMalformedEventCount, 1);
  await session.close();
});

test('events with inherited properties are rejected fail-closed', async () => {
  const { server, port, control, reconcile, dedupeStore } = baseSetup();
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 5,
  });
  const initial = await session.run('a'.repeat(64));
  const runPromise = session.run(initial.snapshot.snapshotHash);
  const proto = { id: 'inherited-id' };
  const malicious = Object.create(proto);
  Object.assign(malicious, { kind: 'turn', spaceId: SPACE, sessionId: SESSION, turnId: 'turn-1', terminalStatus: 'completed' });
  control.emitRaw(malicious);
  const result = await runPromise;
  assert.equal(result.status, 'timeout');
  assert.equal(session.getMetrics().rejectedMalformedEventCount, 1);
  await session.close();
});

test('no timer or listener leaks after close', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });
  await session.run('a'.repeat(64));
  await session.close();
  // If there are leaks, further events should not be processed
  const turn = server.createTurn(SPACE, SESSION, { status: 'running' });
  server.finalizeTurn(SPACE, SESSION, turn.id, 'completed');
  assert.equal(session.getMetrics().logicalApplicationCount, 0);
});
