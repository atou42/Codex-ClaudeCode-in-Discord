import test from 'node:test';
import assert from 'node:assert/strict';
import { types } from 'node:util';

import { createFakeCohubServer, createFakeCohubPort } from '../helpers/fake-cohub-port.mjs';
import { createSubscriptionSession, createDedupeStore } from '../../src/cohub-claude-goal/subscription.js';

const SPACE = 'f0000000-0000-0000-0000-000000000001';
const SESSION = 's0000000-0000-0000-0000-000000000001';

function baseSetup() {
  const server = createFakeCohubServer();
  server.ensureSession(SPACE, SESSION);
  const { port } = createFakeCohubPort(server);
  const reconcile = async (p) => {
    const idx = await p.getSessionIndex(SPACE, SESSION);
    return { snapshotHash: idx.sequence.toString(16).padStart(64, '0') };
  };
  const dedupeStore = createDedupeStore();
  return { server, port, reconcile, dedupeStore };
}

test('SEC-PROXY-01: top-level Proxy spaceIds array rejected before Array.isArray', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const proxySpaceIds = new Proxy([SPACE], {});

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: proxySpaceIds,
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
    }),
    /proxy|untrusted/i,
    'must reject Proxy array before using Array.isArray'
  );
});

test('SEC-PROXY-02: nested Proxy inside spaceIds array rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const proxySpace = new Proxy({ value: SPACE }, {});

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [proxySpace],
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
    }),
    /proxy|untrusted/i,
    'must reject nested Proxy values in array'
  );
});

test('SEC-PROXY-03: Proxy watchSet array rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const proxyWatchSet = new Proxy([{ spaceId: SPACE, sessionId: SESSION }], {});

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: proxyWatchSet,
      reconcile,
      dedupeStore,
    }),
    /proxy|untrusted/i,
    'must reject Proxy watchSet array'
  );
});

test('SEC-PROXY-04: Proxy watch entry object rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const proxyWatch = new Proxy({ spaceId: SPACE, sessionId: SESSION }, {});

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [proxyWatch],
      reconcile,
      dedupeStore,
    }),
    /proxy|untrusted/i,
    'must reject Proxy watch entry'
  );
});

test('SEC-PROXY-05: revoked Proxy rejected with clear error', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const { proxy, revoke } = Proxy.revocable([SPACE], {});
  revoke();

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: proxy,
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
    }),
    /proxy|revoked|untrusted/i,
    'must detect and reject revoked Proxy'
  );
});

test('SEC-PROXY-06: Proxy dedupeStore rejected', () => {
  const { port, reconcile } = baseSetup();
  const realStore = createDedupeStore();
  const proxyStore = new Proxy(realStore, {});

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore: proxyStore,
    }),
    /proxy|untrusted/i,
    'must reject Proxy dedupeStore'
  );
});

test('SEC-PROXY-07: Proxy hooks object rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const proxyHooks = new Proxy({}, {});

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
      hooks: proxyHooks,
    }),
    /proxy|untrusted/i,
    'must reject Proxy hooks'
  );
});

test('SEC-PROXY-08: Proxy reconcile result rejected', async () => {
  const { server, port, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const reconcile = async () => {
    return new Proxy({ snapshotHash: '0'.repeat(64) }, {});
  };

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  await assert.rejects(
    () => session.run('f'.repeat(64)),
    /proxy|untrusted/i,
    'must reject Proxy reconcile result'
  );
  await session.close();
});

test('SEC-ARRAY-01: sparse array in spaceIds rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const sparse = [SPACE];
  sparse[5] = 'another-space';

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: sparse,
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
    }),
    /sparse|holes|dense/i,
    'must reject sparse arrays'
  );
});

test('SEC-SYMBOL-01: symbol properties in watch entry rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const watch = { spaceId: SPACE, sessionId: SESSION };
  watch[Symbol('hidden')] = 'attack';

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [watch],
      reconcile,
      dedupeStore,
    }),
    /symbol|unexpected.*propert/i,
    'must reject objects with symbol properties'
  );
});

test('SEC-PROTO-01: watch entry with custom prototype rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const customProto = { malicious: true };
  const watch = Object.create(customProto);
  watch.spaceId = SPACE;
  watch.sessionId = SESSION;

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [watch],
      reconcile,
      dedupeStore,
    }),
    /prototype/i,
    'must reject objects with non-Object.prototype'
  );
});

test('SEC-MUTATION-01: mutating spaceIds after construction does not affect validation', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const spaceIds = [SPACE];
  const session = createSubscriptionSession({
    port,
    spaceIds,
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  // Attacker mutates the array after construction
  spaceIds.push('attacker-space');
  spaceIds[0] = 'replaced';

  // Session must use detached immutable copy
  const result = await session.run('0'.repeat(64));
  assert.equal(result.status, 'changed');
  await session.close();
});

test('SEC-MUTATION-02: mutating watchSet after construction does not affect validation', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const watchSet = [{ spaceId: SPACE, sessionId: SESSION }];
  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet,
    reconcile,
    dedupeStore,
  });

  // Attacker mutates after construction
  watchSet.push({ spaceId: 'evil', sessionId: 'evil' });
  watchSet[0].sessionId = 'replaced';

  const result = await session.run('0'.repeat(64));
  assert.equal(result.status, 'changed');
  await session.close();
});

test('SEC-EXCESSIVE-01: excessively large spaceIds array rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const huge = Array(10001).fill(SPACE);

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: huge,
      watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
      reconcile,
      dedupeStore,
    }),
    /excessive|size|too many/i,
    'must reject arrays exceeding reasonable size limits'
  );
});

test('SEC-EXCESSIVE-02: excessively large watchSet array rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const huge = Array(10001).fill(null).map(() => ({ spaceId: SPACE, sessionId: SESSION }));

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: huge,
      reconcile,
      dedupeStore,
    }),
    /excessive|size|too many/i,
    'must reject watch sets exceeding reasonable size limits'
  );
});

test('SEC-CYCLE-01: circular reference in config rejected', () => {
  const { port, reconcile, dedupeStore } = baseSetup();
  const watch = { spaceId: SPACE, sessionId: SESSION };
  watch.cycle = watch;

  assert.throws(
    () => createSubscriptionSession({
      port,
      spaceIds: [SPACE],
      watchSet: [watch],
      reconcile,
      dedupeStore,
    }),
    /cyclic|circular/i,
    'must reject circular references'
  );
});

test('SEC-IMMUTABLE-01: returned snapshot is deeply frozen', async () => {
  const { server, port, reconcile, dedupeStore } = baseSetup();
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
  });

  const result = await session.run('0'.repeat(64));
  assert.equal(result.status, 'changed');

  // Attempt mutation
  assert.throws(() => {
    result.snapshot.snapshotHash = 'mutated';
  }, 'snapshot must be frozen');

  assert.throws(() => {
    result.snapshot.newProp = 'attack';
  }, 'snapshot must prevent new properties');

  await session.close();
});

test('SEC-SENTINEL-01: known error messages never include attacker input values', async () => {
  const { port, dedupeStore } = baseSetup();
  const attackString = '<script>alert("XSS")</script>';

  try {
    createSubscriptionSession({
      port,
      spaceIds: [attackString],
      watchSet: [],
      reconcile: async () => ({ snapshotHash: '0'.repeat(64) }),
      dedupeStore,
    });
    assert.fail('should have thrown');
  } catch (err) {
    // Error message must not echo the attacker string
    assert.ok(!err.message.includes(attackString),
      'error message must not include attacker input');
  }
});

test('SEC-GENERATION-01: malformed event bumps generation even when rejected', async () => {
  const server = createFakeCohubServer();
  server.ensureSession(SPACE, SESSION);
  const { port, control } = createFakeCohubPort(server);
  server.createTurn(SPACE, SESSION, { status: 'running' });

  const reconcile = async (p) => {
    const idx = await p.getSessionIndex(SPACE, SESSION);
    return { snapshotHash: idx.sequence.toString(16).padStart(64, '0') };
  };
  const dedupeStore = createDedupeStore();

  const session = createSubscriptionSession({
    port,
    spaceIds: [SPACE],
    watchSet: [{ spaceId: SPACE, sessionId: SESSION }],
    reconcile,
    dedupeStore,
    hardTimeoutMs: 10,
  });

  const initial = await session.run('0'.repeat(64));
  const runPromise = session.run(initial.snapshot.snapshotHash);

  // Inject malformed events - they must bump generation but not apply
  control.emitRaw({ kind: 'turn', spaceId: SPACE }); // missing fields
  control.emitRaw({ kind: 'unknown' }); // wrong kind

  const result = await runPromise;

  // Generation was bumped, causing immediate reconcile loop and timeout
  assert.equal(result.status, 'timeout');
  assert.equal(session.getMetrics().rejectedMalformedEventCount, 2);
  assert.equal(session.getMetrics().logicalApplicationCount, 0);

  await session.close();
});
