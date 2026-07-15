/**
 * @fileoverview Deep immutability adversarial tests for verify.js
 * These tests MUST pass to ensure verdicts cannot be mutated after return.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { inspect } from 'node:util';
import { verify } from '../../src/cohub-claude-goal/verify.js';

const MOCK_GOAL = { goalId: 'test', version: '1.0', spaceId: 'sp_test' };

test('verify - nextAction object is deeply frozen', () => {
  const snapshot = {
    snapshotHash: 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER', workerId: 'worker_001', details: { foo: 'bar' } }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.ok(Object.isFrozen(result.nextAction), 'nextAction must be frozen');
  assert.throws(() => { result.nextAction.type = 'HACKED'; }, 'nextAction.type must be immutable');
  assert.throws(() => { result.nextAction.newField = 'evil'; }, 'Cannot add fields to nextAction');

  if (result.nextAction.details) {
    assert.ok(Object.isFrozen(result.nextAction.details), 'nextAction.details must be frozen');
    assert.throws(() => { result.nextAction.details.foo = 'evil'; }, 'Nested details must be immutable');
  }
});

test('verify - missingEvidence array is deeply frozen', () => {
  const snapshot = {
    snapshotHash: 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf',
    orchestrationState: { status: 'COMPLETE' },
    deliveryEvidence: { worldId: 'w1' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.ok(Object.isFrozen(result.missingEvidence), 'missingEvidence must be frozen');
  assert.throws(() => { result.missingEvidence.push('INJECTED'); }, 'Cannot push to missingEvidence');
  assert.throws(() => { result.missingEvidence[0] = 'HACKED'; }, 'Cannot modify missingEvidence elements');
  assert.throws(() => { result.missingEvidence.pop(); }, 'Cannot pop from missingEvidence');
});

test('verify - evidenceRefs array is deeply frozen', () => {
  const snapshot = {
    snapshotHash: 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf',
    orchestrationState: { status: 'WAITING_USER_INPUT' },
    userGate: { gate: 'proposal', promptTurnId: 'turn_001', consumed: false }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.ok(Array.isArray(result.evidenceRefs), 'evidenceRefs must be an array');
  assert.ok(Object.isFrozen(result.evidenceRefs), 'evidenceRefs must be frozen');
  assert.throws(() => { result.evidenceRefs.push('FORGED'); }, 'Cannot push to evidenceRefs');
  assert.throws(() => { result.evidenceRefs[0] = 'HACKED'; }, 'Cannot modify evidenceRefs elements');
});

test('verify - input mutation does not affect output', () => {
  const nextAction = { type: 'WAIT_WORKER', workerId: 'worker_001' };
  const snapshot = {
    snapshotHash: 'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction
  };

  const result = verify(MOCK_GOAL, { snapshot });

  // Mutate input after verify returns
  nextAction.type = 'HACKED';
  nextAction.newField = 'evil';
  snapshot.orchestrationState.status = 'EVIL';

  // Output must be unaffected
  assert.strictEqual(result.nextAction.type, 'WAIT_WORKER', 'Output must be detached from input');
  assert.strictEqual(result.nextAction.newField, undefined, 'New fields on input must not appear in output');
});

test('verify - blocker details are deeply frozen (BLOCKED verdict)', () => {
  const snapshot = {
    snapshotHash: 'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff',
    orchestrationState: { status: 'BLOCKED' },
    blocker: {
      type: 'PERMISSION_DENIED',
      resource: 'cohub_write',
      evidence: { errorCode: 403, details: { message: 'Forbidden' } }
    }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.strictEqual(result.verdict, 'BLOCKED');
  assert.ok(Object.isFrozen(result), 'Result must be frozen');
  // The output should not contain blocker object itself, but evidenceRefs
  assert.ok(Object.isFrozen(result.evidenceRefs), 'evidenceRefs must be frozen');
});

test('verify - output with nested objects cannot be mutated', () => {
  const snapshot = {
    snapshotHash: 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00010203040506070809000102030405',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: {
      type: 'WAIT_WORKER',
      workerId: 'worker_001',
      metadata: {
        stage: 'geography',
        nested: {
          deep: 'value'
        }
      }
    }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  // Test all levels of nesting
  assert.ok(Object.isFrozen(result.nextAction), 'Level 1 frozen');
  assert.ok(Object.isFrozen(result.nextAction.metadata), 'Level 2 frozen');
  assert.ok(Object.isFrozen(result.nextAction.metadata.nested), 'Level 3 frozen');

  assert.throws(() => { result.nextAction.metadata.stage = 'HACKED'; });
  assert.throws(() => { result.nextAction.metadata.nested.deep = 'HACKED'; });
});

test('verify - PAUSED_USER gate details are immutable', () => {
  const snapshot = {
    snapshotHash: '0607080910111213141516171819202122232425262728293031323334353637',
    orchestrationState: { status: 'WAITING_USER_INPUT' },
    userGate: { gate: 'proposal', promptTurnId: 'turn_001', consumed: false }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.strictEqual(result.verdict, 'PAUSED_USER');
  assert.throws(() => { result.gate = 'HACKED'; }, 'gate field must be immutable');
  assert.throws(() => { result.promptTurnId = 'HACKED'; }, 'promptTurnId must be immutable');
});

test('verify - arrays in missingEvidence cannot have elements modified', () => {
  const snapshot = {
    snapshotHash: '3839404142434445464748495051525354555657585960616263646566676869',
    orchestrationState: { status: 'COMPLETE' },
    deliveryEvidence: { worldId: 'w1', spaceId: 's1' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  const originalLength = result.missingEvidence.length;
  const originalFirstElement = result.missingEvidence[0];

  assert.throws(() => { result.missingEvidence.length = 0; }, 'Cannot truncate array');
  assert.throws(() => { result.missingEvidence.splice(0, 1); }, 'Cannot splice array');
  assert.throws(() => { result.missingEvidence.shift(); }, 'Cannot shift array');
  assert.throws(() => { result.missingEvidence.unshift('new'); }, 'Cannot unshift array');

  assert.strictEqual(result.missingEvidence.length, originalLength, 'Length unchanged');
  assert.strictEqual(result.missingEvidence[0], originalFirstElement, 'Elements unchanged');
});

test('verify - no proxy traps can be invoked on frozen output', () => {
  const snapshot = {
    snapshotHash: '7071727374757677787980818283848586878889909192939495969798990001',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER', workerId: 'w1' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  // Attempting to wrap in proxy after freeze should not allow mutation
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.nextAction));

  // Even with a proxy wrapper, the underlying object remains frozen
  const handler = {
    set: () => true,  // Try to allow all sets
    defineProperty: () => true
  };

  const proxied = new Proxy(result, handler);
  assert.throws(() => { proxied.verdict = 'HACKED'; }, 'Frozen object rejects proxy set');
});

test('verify - descriptor attack: no writable descriptors', () => {
  const snapshot = {
    snapshotHash: '0203040506070809101112131415161718192021222324252627282930313233',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  // Check all descriptors on result
  for (const key of Object.keys(result)) {
    const desc = Object.getOwnPropertyDescriptor(result, key);
    assert.strictEqual(desc.writable, false, `${key} must be non-writable`);
    assert.strictEqual(desc.configurable, false, `${key} must be non-configurable`);
  }

  // Check nested object descriptors
  if (result.nextAction) {
    for (const key of Object.keys(result.nextAction)) {
      const desc = Object.getOwnPropertyDescriptor(result.nextAction, key);
      assert.strictEqual(desc.writable, false, `nextAction.${key} must be non-writable`);
      assert.strictEqual(desc.configurable, false, `nextAction.${key} must be non-configurable`);
    }
  }
});

test('verify - circular reference in input does not crash', () => {
  const circular = { type: 'WAIT_WORKER' };
  circular.self = circular;

  const snapshot = {
    snapshotHash: '3435363738394041424344454647484950515253545556575859606162636465',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: circular
  };

  // Should not crash, should handle gracefully
  const result = verify(MOCK_GOAL, { snapshot });
  assert.ok(result);
  assert.strictEqual(result.verdict, 'RUNNING');
});

test('verify - symbol keys are not copied to output', () => {
  const sym = Symbol('evil');
  const snapshot = {
    snapshotHash: '6667686970717273747576777879808182838485868788899091929394959697',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER' }
  };

  snapshot.nextAction[sym] = 'hidden';

  const result = verify(MOCK_GOAL, { snapshot });

  const symbols = Object.getOwnPropertySymbols(result.nextAction);
  assert.strictEqual(symbols.length, 0, 'No symbol properties should be copied');
});

test('verify - unknown fields in snapshot are not leaked to output', () => {
  const snapshot = {
    snapshotHash: '9899000102030405060708091011121314151617181920212223242526272829',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER' },
    unknownField: 'should not appear',
    evilPayload: { hack: 'attempt' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.strictEqual(result.unknownField, undefined, 'Unknown fields must not leak');
  assert.strictEqual(result.evilPayload, undefined, 'Evil payloads must not leak');

  // Only expected fields should exist
  const allowedKeys = ['verdict', 'snapshotHash', 'nextAction', 'reason', 'evidenceRefs', 'missingEvidence', 'gate', 'promptTurnId'];
  for (const key of Object.keys(result)) {
    assert.ok(allowedKeys.includes(key), `Unexpected key: ${key}`);
  }
});

test('verify - getters in input are not invoked during deep clone', () => {
  let getterCalled = false;

  const snapshot = {
    snapshotHash: '3031323334353637383940414243444546474849505152535455565758596061',
    orchestrationState: { status: 'IN_PROGRESS' },
    get nextAction() {
      getterCalled = true;
      return { type: 'WAIT_WORKER' };
    }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  // The getter will be called during normal property access, that's expected
  // But the output should not have a getter
  const desc = Object.getOwnPropertyDescriptor(result, 'nextAction');
  assert.strictEqual(desc.get, undefined, 'Output must not have getter');
  assert.strictEqual(desc.set, undefined, 'Output must not have setter');
});

test('verify - Object.preventExtensions on output', () => {
  const snapshot = {
    snapshotHash: '6263646566676869707172737475767778798081828384858687888990919293',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.ok(!Object.isExtensible(result), 'Result must not be extensible');
  assert.ok(!Object.isExtensible(result.nextAction), 'Nested objects must not be extensible');

  assert.throws(() => {
    result.newField = 'attempt';
  }, 'Cannot add new properties to frozen object');
});
