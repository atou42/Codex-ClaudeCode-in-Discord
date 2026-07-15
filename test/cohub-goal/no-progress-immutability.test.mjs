/**
 * @fileoverview Deep immutability adversarial tests for no-progress.js
 * These tests MUST pass to ensure detection results cannot be mutated after return.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { detectNoProgress } from '../../src/cohub-claude-goal/no-progress.js';

const VALID_FP = 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890';

test('detectNoProgress - result object is deeply frozen', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.ok(Object.isFrozen(result), 'Result must be frozen');
  assert.throws(() => { result.isNoProgress = false; }, 'Cannot mutate isNoProgress');
  assert.throws(() => { result.count = 999; }, 'Cannot mutate count');
  assert.throws(() => { result.shouldBlock = true; }, 'Cannot mutate shouldBlock');
  assert.throws(() => { result.newField = 'evil'; }, 'Cannot add new fields');
});

test('detectNoProgress - result with repairAction is deeply frozen', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.strictEqual(result.allowRepair, true);
  assert.strictEqual(result.repairAction, 'REPAIR_NO_PROGRESS');

  assert.throws(() => { result.repairAction = 'HACKED'; }, 'repairAction must be immutable');
  assert.throws(() => { result.allowRepair = false; }, 'allowRepair must be immutable');
});

test('detectNoProgress - result with blockReason is deeply frozen', () => {
  const history = [{ fingerprint: VALID_FP, hadToolAction: false }];
  const result = detectNoProgress(VALID_FP, history, { hadToolAction: false });

  assert.strictEqual(result.shouldBlock, true);
  assert.strictEqual(result.blockReason, 'BLOCKED_REPEATED_NO_PROGRESS');

  assert.throws(() => { result.blockReason = 'HACKED'; }, 'blockReason must be immutable');
  assert.throws(() => { result.shouldBlock = false; }, 'shouldBlock must be immutable');
});

test('detectNoProgress - Claude wait refusal result is deeply frozen', () => {
  const turn1 = {
    fingerprint: VALID_FP,
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };

  const turn2 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };

  const result = detectNoProgress(VALID_FP, [turn1], turn2);

  assert.strictEqual(result.isClaudeWaitRefusal, true);
  assert.strictEqual(result.blockReason, 'BLOCKED_CLAUDE_WAIT_REFUSAL');

  assert.throws(() => { result.isClaudeWaitRefusal = false; }, 'isClaudeWaitRefusal must be immutable');
  assert.throws(() => { result.blockReason = 'HACKED'; }, 'blockReason must be immutable');
});

test('detectNoProgress - input mutation does not affect output', () => {
  const currentTurn = { hadToolAction: false };
  const result = detectNoProgress(VALID_FP, [], currentTurn);

  // Mutate input after return
  currentTurn.hadToolAction = true;
  currentTurn.evilField = 'injected';

  // Output must be unaffected
  assert.strictEqual(result.isNoProgress, true, 'Output detached from input');
  assert.strictEqual(result.evilField, undefined, 'Evil fields must not appear');
});

test('detectNoProgress - no writable descriptors on output', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  for (const key of Object.keys(result)) {
    const desc = Object.getOwnPropertyDescriptor(result, key);
    assert.strictEqual(desc.writable, false, `${key} must be non-writable`);
    assert.strictEqual(desc.configurable, false, `${key} must be non-configurable`);
    assert.strictEqual(desc.enumerable, true, `${key} must be enumerable`);
  }
});

test('detectNoProgress - Object.preventExtensions on output', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.ok(!Object.isExtensible(result), 'Result must not be extensible');

  assert.throws(() => {
    result.hackedField = 'attempt';
  }, 'Cannot add new properties to frozen object');
});

test('detectNoProgress - descriptor attack on frozen result', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.throws(() => {
    Object.defineProperty(result, 'count', { value: 999 });
  }, 'Cannot redefine property on frozen object');

  assert.throws(() => {
    Object.defineProperty(result, 'newProp', { value: 'evil' });
  }, 'Cannot add property to frozen object');
});

test('detectNoProgress - no setter descriptors on output', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  for (const key of Object.keys(result)) {
    const desc = Object.getOwnPropertyDescriptor(result, key);
    assert.strictEqual(desc.get, undefined, `${key} must not have getter`);
    assert.strictEqual(desc.set, undefined, `${key} must not have setter`);
  }
});

test('detectNoProgress - frozen result rejects Object.assign', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.throws(() => {
    Object.assign(result, { count: 999, evil: true });
  }, 'Object.assign must fail on frozen object');

  assert.strictEqual(result.count, 1, 'Original count unchanged');
  assert.strictEqual(result.evil, undefined, 'Evil field not added');
});

test('detectNoProgress - frozen result rejects delete', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.throws(() => {
    delete result.count;
  }, 'Cannot delete property from frozen object');

  assert.ok(result.hasOwnProperty('count'), 'Property still exists');
});

test('detectNoProgress - no proxy can mutate frozen output', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  const handler = {
    set: () => true,
    defineProperty: () => true
  };

  const proxied = new Proxy(result, handler);

  assert.throws(() => {
    proxied.count = 999;
  }, 'Proxy cannot override frozen object');

  assert.strictEqual(result.count, 1, 'Original unchanged');
});

test('detectNoProgress - unknown fields in currentTurn not leaked', () => {
  const currentTurn = {
    hadToolAction: false,
    unknownField: 'should not appear',
    evilPayload: { hack: 'attempt' }
  };

  const result = detectNoProgress(VALID_FP, [], currentTurn);

  assert.strictEqual(result.unknownField, undefined, 'Unknown fields must not leak');
  assert.strictEqual(result.evilPayload, undefined, 'Evil payloads must not leak');

  const allowedKeys = [
    'isNoProgress',
    'isClaudeWaitRefusal',
    'isClaudeSubmitRefusal',
    'count',
    'shouldBlock',
    'allowRepair',
    'blockReason',
    'repairAction'
  ];

  for (const key of Object.keys(result)) {
    assert.ok(allowedKeys.includes(key), `Unexpected key: ${key}`);
  }
});

test('detectNoProgress - symbol keys are rejected', () => {
  const sym = Symbol('evil');
  const currentTurn = { hadToolAction: false };
  currentTurn[sym] = 'hidden';

  // Stricter implementation now rejects symbol keys rather than silently dropping
  assert.throws(
    () => detectNoProgress(VALID_FP, [], currentTurn),
    /Symbol keys are not allowed/i,
    'Symbol keys must be rejected'
  );
});

test('detectNoProgress - all output variants are frozen', () => {
  // Test no-progress (first occurrence)
  const result1 = detectNoProgress(VALID_FP, [], { hadToolAction: false });
  assert.ok(Object.isFrozen(result1), 'First no-progress frozen');

  // Test blocked (second occurrence)
  const history2 = [{ fingerprint: VALID_FP, hadToolAction: false }];
  const result2 = detectNoProgress(VALID_FP, history2, { hadToolAction: false });
  assert.ok(Object.isFrozen(result2), 'Blocked result frozen');

  // Test tool action reset
  const result3 = detectNoProgress(VALID_FP, history2, { hadToolAction: true });
  assert.ok(Object.isFrozen(result3), 'Reset result frozen');

  // Test fingerprint change
  const result4 = detectNoProgress('b'.repeat(64), history2, { hadToolAction: false });
  assert.ok(Object.isFrozen(result4), 'Fingerprint change result frozen');

  // Test Claude wait refusal
  const turn1 = {
    fingerprint: VALID_FP,
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };
  const turn2 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };
  const result5 = detectNoProgress(VALID_FP, [turn1], turn2);
  assert.ok(Object.isFrozen(result5), 'Wait refusal result frozen');
});

test('detectNoProgress - result is not extensible', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  assert.strictEqual(Object.isExtensible(result), false);
  assert.strictEqual(Object.isSealed(result), true);
  assert.strictEqual(Object.isFrozen(result), true);
});

test('detectNoProgress - Object.keys cannot be manipulated', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  const keys = Object.keys(result);
  const originalLength = keys.length;

  // Modifying the returned keys array should not affect the object
  keys.push('evil');
  keys[0] = 'hacked';

  const keysAgain = Object.keys(result);
  assert.strictEqual(keysAgain.length, originalLength, 'Keys unchanged');
  assert.deepStrictEqual(keysAgain, Object.keys(result), 'Keys stable');
});

test('detectNoProgress - Object.values returns frozen primitives only', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  const values = Object.values(result);

  // All values should be primitives (boolean, number, string) or undefined
  for (const val of values) {
    const type = typeof val;
    assert.ok(
      type === 'boolean' || type === 'number' || type === 'string' || val === undefined,
      `Value must be primitive, got ${type}: ${val}`
    );
  }
});

test('detectNoProgress - getOwnPropertyNames matches Object.keys', () => {
  const result = detectNoProgress(VALID_FP, [], { hadToolAction: false });

  const keys = Object.keys(result);
  const propNames = Object.getOwnPropertyNames(result);

  assert.deepStrictEqual(keys.sort(), propNames.sort(), 'All properties are enumerable');
});
