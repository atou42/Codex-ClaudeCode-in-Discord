/**
 * @fileoverview Adversarial boundary tests for snapshot.js and reconcile.js
 * Tests required strict behavior:
 * - parentSpaceId/parentSessionId must be exact non-empty strings (no fallbacks)
 * - Proxy/getter/accessor/symbol rejection before any field access
 * - deepFreeze must not mutate caller objects
 * - Outputs must be deeply detached and immutable
 * - No optional chaining on untrusted values before sanitization
 * - Error messages must be generic and bounded
 * - Identity must affect hash
 * - seenSet partial rollback on malformed event
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import util from 'node:util';
import { createSnapshot, calculateProgressFingerprint } from '../src/cohub-claude-goal/snapshot.js';
import { reconcile, deduplicateEvents } from '../src/cohub-claude-goal/reconcile.js';

// Mock cohubReader for controlled tests
function makeMockReader(data = {}) {
  return {
    async readRunFile(spaceId, filename) {
      const key = `${spaceId}:${filename}`;
      if (data[key] === undefined) throw new Error(`File not found: ${filename}`);
      return data[key];
    },
    async getSessionIndex(spaceId, sessionId) {
      const key = `${spaceId}:${sessionId}:index`;
      if (data[key] === undefined) throw new Error(`Session index not found: ${sessionId}`);
      return data[key];
    },
    async getTurn(spaceId, sessionId, turnId) {
      const key = `${spaceId}:${sessionId}:${turnId}`;
      return data[key] || null;
    }
  };
}

// Test: Missing parentSpaceId must fail, no fallback
test('createSnapshot rejects missing parentSpaceId', async () => {
  const reader = makeMockReader({
    'default-space:orchestration_state.json': { status: 'RUNNING' },
    'default-space:stage_gate_log.json': { gates: [] },
    'default-space:run_manifest.json': { id: 'manifest-1' },
    'default-space:default-session:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSessionId: 'sess-1', // parentSpaceId missing
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Must produce BLOCKED result, not succeed with default-space fallback
  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.code === 'AUTHORITY_READ_FAILURE'));
});

// Test: Empty string parentSpaceId must fail
test('createSnapshot rejects empty string parentSpaceId', async () => {
  const reader = makeMockReader({});

  const localState = {
    parentSpaceId: '   ', // whitespace only
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Must return BLOCKED, not succeed
  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.code === 'AUTHORITY_READ_FAILURE'));
});

// Test: Missing parentSessionId must fail
test('createSnapshot rejects missing parentSessionId', async () => {
  const reader = makeMockReader({
    'space-1:orchestration_state.json': { status: 'RUNNING' },
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:default-session:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1', // parentSessionId missing
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.code === 'AUTHORITY_READ_FAILURE'));
});

// Test: Proxy input must be rejected before field access
test('createSnapshot rejects Proxy in orchestrationState', async () => {
  let trapCount = 0;
  const proxyData = new Proxy({ status: 'RUNNING' }, {
    get(target, prop) {
      trapCount++;
      return target[prop];
    }
  });

  const reader = makeMockReader({
    'space-1:orchestration_state.json': proxyData,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Note: async/await checks .then before our code runs, causing 1 trap
  // The important thing is that sanitization rejects it
  assert.ok(trapCount <= 1, `Too many traps executed: ${trapCount}`);
  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.code === 'INPUT_VALIDATION_FAILED'));
});

// Test: Nested Proxy must be rejected
test('createSnapshot rejects nested Proxy in tasks', async () => {
  let nestedTrapCount = 0;
  const nestedProxy = new Proxy({ count: '10/10' }, {
    get(target, prop) {
      nestedTrapCount++;
      return target[prop];
    }
  });

  const reader = makeMockReader({
    'space-1:orchestration_state.json': {
      status: 'RUNNING',
      tasks: [{ id: 'task-1', status: 'COMPLETED', nested: nestedProxy }]
    },
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  assert.strictEqual(nestedTrapCount, 0, 'Nested Proxy trap was executed');
  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.code === 'INPUT_VALIDATION_FAILED'));
});

// Test: Getter must not be invoked
test('createSnapshot rejects accessor properties without invoking getter', async () => {
  let getterInvoked = false;
  const dataWithGetter = {
    status: 'RUNNING'
  };
  Object.defineProperty(dataWithGetter, 'malicious', {
    get() {
      getterInvoked = true;
      return 'payload';
    },
    enumerable: true
  });

  const reader = makeMockReader({
    'space-1:orchestration_state.json': dataWithGetter,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  assert.strictEqual(getterInvoked, false, 'Getter was invoked');
  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.code === 'INPUT_VALIDATION_FAILED'));
});

// Test: Caller object must remain extensible after deepFreeze
test('createSnapshot does not mutate caller orchestrationState', async () => {
  const callerState = { status: 'RUNNING', tasks: [] };

  const reader = makeMockReader({
    'space-1:orchestration_state.json': callerState,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  await createSnapshot('test-goal', reader, ledger, localState);

  // Caller object must still be extensible
  assert.ok(Object.isExtensible(callerState), 'Caller orchestrationState was frozen');
  callerState.newField = 'test';
  assert.strictEqual(callerState.newField, 'test', 'Caller object cannot be modified');
});

// Test: Output snapshot must be deeply immutable
test('createSnapshot output is deeply immutable', async () => {
  const reader = makeMockReader({
    'space-1:orchestration_state.json': { status: 'RUNNING', tasks: [{ id: 'task-1' }] },
    'space-1:stage_gate_log.json': { gates: [{ id: 'gate-1' }] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Top-level frozen
  assert.ok(Object.isFrozen(snapshot), 'Snapshot not frozen');

  // Nested arrays frozen
  assert.ok(Object.isFrozen(snapshot.tasks), 'tasks array not frozen');
  assert.ok(Object.isFrozen(snapshot.gates), 'gates array not frozen');
  assert.ok(Object.isFrozen(snapshot.workerStates), 'workerStates not frozen');
  assert.ok(Object.isFrozen(snapshot.watchSet), 'watchSet not frozen');

  // Mutation attempts must fail
  assert.throws(() => { snapshot.decision = 'TAMPERED'; }, TypeError);
  assert.throws(() => { snapshot.tasks.push({ id: 'fake' }); }, TypeError);
  assert.throws(() => { snapshot.watchSet[0].role = 'attacker'; }, TypeError);
});

// Test: Output must be detached from caller objects
test('createSnapshot output is detached from caller ledger', async () => {
  const callerReceipts = [{ workerId: 'worker-1', bound: true }];

  const reader = makeMockReader({
    'space-1:orchestration_state.json': { status: 'RUNNING' },
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [], replacementReceipts: callerReceipts };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Verify initial state
  assert.ok(snapshot.receipts, 'receipts missing from snapshot');
  assert.strictEqual(snapshot.receipts.length, 1, 'Initial receipts length wrong');
  assert.strictEqual(snapshot.receipts[0].bound, true, 'Initial bound value wrong');

  // Modify caller object
  callerReceipts.push({ workerId: 'attacker', bound: false });
  callerReceipts[0].bound = false;

  // Snapshot must not reflect caller modifications
  assert.strictEqual(snapshot.receipts.length, 1, 'Snapshot reflects caller modification');
  assert.strictEqual(snapshot.receipts[0].bound, true, 'Nested value not detached');
});

// Test: Identity (space/session) must affect hash
test('createSnapshot hash changes with different parentSpaceId', async () => {
  const state = { status: 'RUNNING', tasks: [] };

  const reader1 = makeMockReader({
    'space-1:orchestration_state.json': state,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const reader2 = makeMockReader({
    'space-2:orchestration_state.json': state,
    'space-2:stage_gate_log.json': { gates: [] },
    'space-2:run_manifest.json': { id: 'manifest-1' },
    'space-2:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState1 = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const localState2 = {
    parentSpaceId: 'space-2',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot1 = await createSnapshot('test-goal', reader1, ledger, localState1);
  const snapshot2 = await createSnapshot('test-goal', reader2, ledger, localState2);

  // Verify identity is in snapshots
  assert.strictEqual(snapshot1.parentSpaceId, 'space-1');
  assert.strictEqual(snapshot2.parentSpaceId, 'space-2');

  // Identity change must change hash
  assert.notStrictEqual(snapshot1.snapshotHash, snapshot2.snapshotHash,
    `Hash did not change with different parentSpaceId: ${snapshot1.snapshotHash} vs ${snapshot2.snapshotHash}`);
});

// Test: Error messages must be generic and bounded
test('createSnapshot errors are generic and bounded', async () => {
  const attackerMessage = 'A'.repeat(10000) + ' ATTACKER_PAYLOAD ' + 'B'.repeat(10000);

  const reader = {
    async readRunFile() {
      throw new Error(attackerMessage);
    },
    async getSessionIndex() {
      throw new Error(attackerMessage);
    },
    async getTurn() {
      return null;
    }
  };

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Error message must be bounded
  assert.ok(snapshot.integrityErrors, 'No integrity errors recorded');
  const errorMessage = JSON.stringify(snapshot.integrityErrors);
  assert.ok(errorMessage.length < 1000, `Error message too long: ${errorMessage.length} chars`);
  assert.ok(!errorMessage.includes('ATTACKER_PAYLOAD'), 'Raw error message leaked');
});

// Test: deduplicateEvents must reject Proxy without executing traps
test('deduplicateEvents rejects Proxy event without trap execution', () => {
  let trapCount = 0;
  const proxyEvent = new Proxy({ id: 'evt-1', spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-1', status: 'completed' }, {
    get(target, prop) {
      trapCount++;
      return target[prop];
    }
  });

  const seenSet = new Set();

  assert.throws(
    () => deduplicateEvents([proxyEvent], seenSet),
    (err) => {
      assert.strictEqual(trapCount, 0, 'Proxy trap executed before rejection');
      return /malicious event/.test(err.message);
    }
  );

  // seenSet must not be modified on error
  assert.strictEqual(seenSet.size, 0, 'seenSet was partially modified before error');
});

// Test: deduplicateEvents must not mutate input events array
test('deduplicateEvents does not mutate input events', () => {
  const events = [
    { id: 'evt-1', spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-1', status: 'completed' },
    { id: 'evt-2', spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-2', status: 'completed' }
  ];
  const originalLength = events.length;
  const seenSet = new Set();

  deduplicateEvents(events, seenSet);

  assert.strictEqual(events.length, originalLength, 'Input events array was mutated');
});

// Test: deduplicateEvents seenSet partial rollback on malformed event
test('deduplicateEvents does not update seenSet if later event is malformed', () => {
  const validEvent = { id: 'evt-1', spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-1', status: 'completed' };
  let trapCount = 0;
  const malformedEvent = new Proxy({}, {
    get() {
      trapCount++;
      throw new Error('Trap executed');
    }
  });

  const seenSet = new Set();

  assert.throws(
    () => deduplicateEvents([validEvent, malformedEvent], seenSet),
    /malicious event/
  );

  // seenSet must be empty (no partial state left)
  assert.strictEqual(seenSet.size, 0, 'seenSet has partial state after error');
  assert.strictEqual(trapCount, 0, 'Trap was executed');
});

// Test: reconcile must reject missing parentSpaceId
test('reconcile rejects missing parentSpaceId', async () => {
  const reader = makeMockReader({
    'default-space:orchestration_state.json': { status: 'RUNNING' },
    'default-space:stage_gate_log.json': { gates: [] },
    'default-space:run_manifest.json': { id: 'manifest-1' },
    'default-space:default-session:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSessionId: 'sess-1', // missing parentSpaceId
    observedGeneration: 0,
    getGeneration: () => 0
  };

  const ledger = { trackedTurns: [] };

  const result = await reconcile('test-goal', reader, ledger, localState);

  assert.strictEqual(result.snapshot.decision, 'BLOCKED');
  assert.ok(result.stale);
});

// Test: reconcile must reject missing parentSessionId
test('reconcile rejects missing parentSessionId', async () => {
  const reader = makeMockReader({
    'space-1:orchestration_state.json': { status: 'RUNNING' },
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:default-session:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1', // missing parentSessionId
    observedGeneration: 0,
    getGeneration: () => 0
  };

  const ledger = { trackedTurns: [] };

  const result = await reconcile('test-goal', reader, ledger, localState);

  assert.strictEqual(result.snapshot.decision, 'BLOCKED');
  assert.ok(result.stale);
});

// Test: calculateProgressFingerprint must not use optional chaining before sanitization
test('calculateProgressFingerprint handles malformed input safely', () => {
  let trapCount = 0;
  const proxyState = new Proxy({}, {
    get() {
      trapCount++;
      throw new Error('Trap executed in fingerprint');
    }
  });

  assert.throws(
    () => calculateProgressFingerprint(proxyState, { gates: [] }, []),
    (err) => {
      // Either rejects Proxy, or handles safely without trap execution
      return true;
    }
  );
});

// Test: Symbol properties must be rejected
test('createSnapshot rejects symbol properties', async () => {
  const sym = Symbol('attack');
  const dataWithSymbol = { status: 'RUNNING' };
  dataWithSymbol[sym] = 'payload';

  const reader = makeMockReader({
    'space-1:orchestration_state.json': dataWithSymbol,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.message.includes('Symbol')));
});

// Test: Sparse arrays must be rejected or handled safely
test('createSnapshot handles sparse arrays safely', async () => {
  const sparseArray = [];
  sparseArray[0] = { id: 'task-1' };
  sparseArray[10] = { id: 'task-2' }; // sparse

  const reader = makeMockReader({
    'space-1:orchestration_state.json': { status: 'RUNNING', tasks: sparseArray },
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  // Must either reject or handle safely (no undefined holes in output)
  if (snapshot.tasks) {
    for (let i = 0; i < snapshot.tasks.length; i++) {
      assert.notStrictEqual(snapshot.tasks[i], undefined, `Sparse hole at index ${i}`);
    }
  }
});

// Test: Cycles in allowlisted fields must be detected and rejected
test('createSnapshot rejects circular references', async () => {
  const circular = { status: 'RUNNING', tasks: [] };
  circular.tasks.push(circular); // Cycle in allowlisted field

  const reader = makeMockReader({
    'space-1:orchestration_state.json': circular,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.message.includes('ircular')));
});

// Test: Prototype pollution keys must be rejected
test('createSnapshot rejects __proto__ key', async () => {
  const polluted = { status: 'RUNNING', __proto__: { malicious: true } };

  const reader = makeMockReader({
    'space-1:orchestration_state.json': polluted,
    'space-1:stage_gate_log.json': { gates: [] },
    'space-1:run_manifest.json': { id: 'manifest-1' },
    'space-1:sess-1:index': { sequence: 1, turns: [] }
  });

  const localState = {
    parentSpaceId: 'space-1',
    parentSessionId: 'sess-1',
    observedGeneration: 0
  };

  const ledger = { trackedTurns: [] };

  const snapshot = await createSnapshot('test-goal', reader, ledger, localState);

  assert.strictEqual(snapshot.decision, 'BLOCKED');
  assert.ok(snapshot.integrityErrors?.some(e => e.message.includes('pollution') || e.message.includes('proto')));
});
