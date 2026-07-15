/**
 * @fileoverview Adversarial tests for no-progress.js fingerprint and detection.
 * Tests must run RED before implementation exists.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { computeProgressFingerprint, detectNoProgress } from '../../src/cohub-claude-goal/no-progress.js';

test('computeProgressFingerprint - requires snapshot', () => {
  assert.throws(
    () => computeProgressFingerprint(),
    { name: 'TypeError', message: /snapshot.*required/ }
  );
});

test('computeProgressFingerprint - stable on prose changes', () => {
  const base = {
    orchestrationState: { status: 'IN_PROGRESS', currentStage: 'geography' },
    pendingWorkers: ['worker_001']
  };

  const withProse1 = {
    ...base,
    latestTurnOutput: 'I will continue working on this task.'
  };

  const withProse2 = {
    ...base,
    latestTurnOutput: 'Processing will resume shortly.'
  };

  const fp1 = computeProgressFingerprint(withProse1);
  const fp2 = computeProgressFingerprint(withProse2);

  assert.strictEqual(fp1, fp2, 'Fingerprint must be stable across prose changes');
});

test('computeProgressFingerprint - changes on real state', () => {
  const state1 = {
    orchestrationState: { status: 'IN_PROGRESS', currentStage: 'geography' },
    pendingWorkers: ['worker_001']
  };

  const state2 = {
    orchestrationState: { status: 'IN_PROGRESS', currentStage: 'geography' },
    pendingWorkers: ['worker_001', 'worker_002']
  };

  const fp1 = computeProgressFingerprint(state1);
  const fp2 = computeProgressFingerprint(state2);

  assert.notStrictEqual(fp1, fp2, 'Fingerprint must change when workers change');
});

test('computeProgressFingerprint - changes on action', () => {
  const beforeAction = {
    orchestrationState: { status: 'IN_PROGRESS' },
    lastActionId: null
  };

  const afterAction = {
    orchestrationState: { status: 'IN_PROGRESS' },
    lastActionId: 'action_submit_001'
  };

  const fp1 = computeProgressFingerprint(beforeAction);
  const fp2 = computeProgressFingerprint(afterAction);

  assert.notStrictEqual(fp1, fp2, 'Fingerprint must change when action executed');
});

test('computeProgressFingerprint - changes on wait', () => {
  const noWait = {
    orchestrationState: { status: 'IN_PROGRESS' },
    externalWait: null
  };

  const withWait = {
    orchestrationState: { status: 'IN_PROGRESS' },
    externalWait: { type: 'WORKER_COMPLETION', workerId: 'worker_001' }
  };

  const fp1 = computeProgressFingerprint(noWait);
  const fp2 = computeProgressFingerprint(withWait);

  assert.notStrictEqual(fp1, fp2, 'Fingerprint must change when wait initiated');
});

test('computeProgressFingerprint - changes on user gate', () => {
  const noGate = {
    orchestrationState: { status: 'IN_PROGRESS' },
    userGate: null
  };

  const withGate = {
    orchestrationState: { status: 'WAITING_USER_INPUT' },
    userGate: { gate: 'proposal', promptTurnId: 'turn_001' }
  };

  const fp1 = computeProgressFingerprint(noGate);
  const fp2 = computeProgressFingerprint(withGate);

  assert.notStrictEqual(fp1, fp2, 'Fingerprint must change when user gate appears');
});

test('computeProgressFingerprint - changes on blocker', () => {
  const noBlocker = {
    orchestrationState: { status: 'IN_PROGRESS' },
    blocker: null
  };

  const withBlocker = {
    orchestrationState: { status: 'BLOCKED' },
    blocker: { type: 'PERMISSION_DENIED', resource: 'cohub_write' }
  };

  const fp1 = computeProgressFingerprint(noBlocker);
  const fp2 = computeProgressFingerprint(withBlocker);

  assert.notStrictEqual(fp1, fp2, 'Fingerprint must change when blocker appears');
});

test('computeProgressFingerprint - descriptor-safe output', () => {
  const snapshot = {
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  const fp = computeProgressFingerprint(snapshot);
  assert.strictEqual(typeof fp, 'string');
  assert.ok(fp.length > 0);
});

test('detectNoProgress - first occurrence allowed', () => {
  const history = [];
  const currentFp = 'a1a2a3a4a5a6a7a8a9aaabacadaeafb0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0';

  const result = detectNoProgress(currentFp, history, { hadToolAction: false });

  assert.strictEqual(result.isNoProgress, true);
  assert.strictEqual(result.count, 1);
  assert.strictEqual(result.shouldBlock, false);
  assert.strictEqual(result.allowRepair, true);
});

test('detectNoProgress - second consecutive blocks', () => {
  const history = [
    { fingerprint: 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf', hadToolAction: false, timestamp: '2026-07-15T10:00:00.000Z' }
  ];
  const currentFp = 'c0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d7d8d9dadbdcdddedf';

  const result = detectNoProgress(currentFp, history, { hadToolAction: false });

  assert.strictEqual(result.isNoProgress, true);
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.shouldBlock, true);
  assert.strictEqual(result.blockReason, 'BLOCKED_REPEATED_NO_PROGRESS');
});

test('detectNoProgress - tool action resets', () => {
  const history = [
    { fingerprint: 'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff', hadToolAction: false, timestamp: '2026-07-15T10:00:00.000Z' }
  ];
  const currentFp = 'e0e1e2e3e4e5e6e7e8e9eaebecedeeeff0f1f2f3f4f5f6f7f8f9fafbfcfdfeff';

  const result = detectNoProgress(currentFp, history, { hadToolAction: true, toolActionWasRelevant: true });

  assert.strictEqual(result.isNoProgress, false);
  assert.strictEqual(result.count, 0);
});

test('detectNoProgress - fingerprint change resets', () => {
  const history = [
    { fingerprint: '00010203040506070809101112131415161718192021222324252627282930a1', hadToolAction: false, timestamp: '2026-07-15T10:00:00.000Z' }
  ];
  const currentFp = '31323334353637383940414243444546474849505152535455565758596061a2';

  const result = detectNoProgress(currentFp, history, { hadToolAction: false });

  assert.strictEqual(result.isNoProgress, false);
  assert.strictEqual(result.count, 0);
});

test('detectNoProgress - prose never resets count', () => {
  const history = [
    { fingerprint: '62636465666768697071727374757677787980818283848586878889909192a3', hadToolAction: false, timestamp: '2026-07-15T10:00:00.000Z' }
  ];
  const currentFp = '62636465666768697071727374757677787980818283848586878889909192a3';

  const result = detectNoProgress(currentFp, history, {
    hadToolAction: false,
    proseContent: 'I will continue shortly.'
  });

  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.shouldBlock, true);
});

test('detectNoProgress - Turn completed never resets', () => {
  const history = [
    { fingerprint: '93949596979899000102030405060708091011121314151617181920212223a4', hadToolAction: false, timestamp: '2026-07-15T10:00:00.000Z' }
  ];
  const currentFp = '93949596979899000102030405060708091011121314151617181920212223a4';

  const result = detectNoProgress(currentFp, history, {
    hadToolAction: false,
    turnCompleted: true
  });

  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.shouldBlock, true);
});

test('detectNoProgress - Claude wait refusal detection', () => {
  const turn1 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };

  const turn2 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };

  const result = detectNoProgress('24252627282930313233343536373839404142434445464748495051525354a5', [turn1], turn2);

  assert.strictEqual(result.isClaudeWaitRefusal, true);
  assert.strictEqual(result.shouldBlock, true);
  assert.strictEqual(result.blockReason, 'BLOCKED_CLAUDE_WAIT_REFUSAL');
});

test('detectNoProgress - Claude wait refusal requires two consecutive', () => {
  const turn1 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: true // First turn DID call wait
  };

  const turn2 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false // Only second turn refused
  };

  const result = detectNoProgress('55565758596061626364656667686970717273747576777879808182838485a6', [turn1], turn2);

  assert.strictEqual(result.isClaudeWaitRefusal, false);
});

test('detectNoProgress - no third turn after wait refusal', () => {
  const history = [
    {
      fingerprint: '86878889909192939495969798990001020304050607080910111213141516a7',
      verifyVerdict: 'RUNNING',
      snapshotRequiresWait: true,
      claudeCalledWait: false
    },
    {
      fingerprint: '86878889909192939495969798990001020304050607080910111213141516a7',
      verifyVerdict: 'RUNNING',
      snapshotRequiresWait: true,
      claudeCalledWait: false
    }
  ];

  const turn3 = {
    verifyVerdict: 'RUNNING',
    snapshotRequiresWait: true,
    claudeCalledWait: false
  };

  // This should never be called in practice because launcher terminates after two
  // But if it is, it must still block
  const result = detectNoProgress('86878889909192939495969798990001020304050607080910111213141516a7', history, turn3);

  assert.strictEqual(result.shouldBlock, true);
});

test('detectNoProgress - submit refusal detection', () => {
  const turn1 = {
    verifyVerdict: 'RUNNING',
    snapshotAllowsSubmit: true,
    claudeCalledSubmit: false,
    hadFreshInspect: false,
    hadFreshVerify: false
  };

  const turn2 = {
    verifyVerdict: 'RUNNING',
    snapshotAllowsSubmit: true,
    claudeCalledSubmit: false,
    hadFreshInspect: false,
    hadFreshVerify: false
  };

  const result = detectNoProgress('17181920212223242526272829303132333435363738394041424344454647a8', [turn1], turn2);

  assert.strictEqual(result.shouldBlock, true);
});

test('detectNoProgress - fresh inspect prevents submit refusal', () => {
  const turn1 = {
    verifyVerdict: 'RUNNING',
    snapshotAllowsSubmit: true,
    claudeCalledSubmit: false,
    hadFreshInspect: false
  };

  const turn2 = {
    verifyVerdict: 'RUNNING',
    snapshotAllowsSubmit: true,
    claudeCalledSubmit: false,
    hadFreshInspect: true
  };

  const result = detectNoProgress('48495051525354555657585960616263646566676869707172737475767778a9', [turn1], turn2);

  assert.strictEqual(result.shouldBlock, false);
});

test('detectNoProgress - output frozen', () => {
  const result = detectNoProgress('79808182838485868788899091929394959697989900010203040506070809aa', [], { hadToolAction: false });

  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.shouldBlock = true; });
});

test('detectNoProgress - historical turn 67 regression', () => {
  // Turn 67: no progress, no tool action, prose only
  const turn67 = {
    fingerprint: '10111213141516171819202122232425262728293031323334353637383940ab',
    hadToolAction: false,
    turnNumber: 67,
    sessionId: '5357ecbb-d695-4507-9efa-32cfea26123b'
  };

  const result = detectNoProgress('10111213141516171819202122232425262728293031323334353637383940ab', [], turn67);

  assert.strictEqual(result.isNoProgress, true);
  assert.strictEqual(result.count, 1);
});

test('detectNoProgress - historical turn 68 regression', () => {
  const turn67 = {
    fingerprint: '41424344454647484950515253545556575859606162636465666768697071ac',
    hadToolAction: false,
    turnNumber: 67,
    sessionId: '5357ecbb-d695-4507-9efa-32cfea26123b'
  };

  const turn68 = {
    fingerprint: '41424344454647484950515253545556575859606162636465666768697071ac', // Same fingerprint
    hadToolAction: false,
    turnNumber: 68,
    sessionId: '5357ecbb-d695-4507-9efa-32cfea26123b'
  };

  const result = detectNoProgress('41424344454647484950515253545556575859606162636465666768697071ac', [turn67], turn68);

  assert.strictEqual(result.isNoProgress, true);
  assert.strictEqual(result.count, 2);
  assert.strictEqual(result.shouldBlock, true);
  assert.strictEqual(result.blockReason, 'BLOCKED_REPEATED_NO_PROGRESS');
});

test('computeProgressFingerprint - excludes prose fields', () => {
  const snapshot = {
    orchestrationState: { status: 'IN_PROGRESS' },
    latestTurnOutput: 'Turn completed',
    workerMessage: 'Working on it',
    assistantProse: 'I will continue',
    pendingWorkers: ['worker_001']
  };

  const withoutProse = {
    orchestrationState: { status: 'IN_PROGRESS' },
    pendingWorkers: ['worker_001']
  };

  const fp1 = computeProgressFingerprint(snapshot);
  const fp2 = computeProgressFingerprint(withoutProse);

  assert.strictEqual(fp1, fp2);
});

test('detectNoProgress - REPAIR_NO_PROGRESS on first', () => {
  const result = detectNoProgress('72737475767778798081828384858687888990919293949596979899000102ad', [], { hadToolAction: false });

  assert.strictEqual(result.isNoProgress, true);
  assert.strictEqual(result.allowRepair, true);
  assert.strictEqual(result.repairAction, 'REPAIR_NO_PROGRESS');
});

test('detectNoProgress - no repair on second', () => {
  const history = [
    { fingerprint: '03040506070809101112131415161718192021222324252627282930313233ae', hadToolAction: false }
  ];

  const result = detectNoProgress('03040506070809101112131415161718192021222324252627282930313233ae', history, { hadToolAction: false });

  assert.strictEqual(result.allowRepair, false);
  assert.strictEqual(result.shouldBlock, true);
});

// Hash validation adversarial tests
test('detectNoProgress - rejects uppercase fingerprint', () => {
  assert.throws(
    () => detectNoProgress('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', [], {}),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('detectNoProgress - rejects short fingerprint', () => {
  assert.throws(
    () => detectNoProgress('abc123', [], {}),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('detectNoProgress - rejects long fingerprint', () => {
  assert.throws(
    () => detectNoProgress('a'.repeat(65), [], {}),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('detectNoProgress - rejects non-hex fingerprint', () => {
  assert.throws(
    () => detectNoProgress('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz', [], {}),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('detectNoProgress - rejects uppercase in history fingerprint', () => {
  const history = [
    { fingerprint: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', hadToolAction: false }
  ];

  assert.throws(
    () => detectNoProgress('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', history, {}),
    { name: 'TypeError', message: /history\[0\]\.fingerprint.*exactly 64 lowercase hex/ }
  );
});

test('detectNoProgress - rejects short history fingerprint', () => {
  const history = [
    { fingerprint: 'short', hadToolAction: false }
  ];

  assert.throws(
    () => detectNoProgress('cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', history, {}),
    { name: 'TypeError', message: /history\[0\]\.fingerprint.*exactly 64 lowercase hex/ }
  );
});

test('detectNoProgress - allows missing fingerprint in history', () => {
  const history = [
    { hadToolAction: true }  // No fingerprint field
  ];

  // Should not throw
  const result = detectNoProgress('dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', history, {});
  assert.ok(result);
});

test('computeProgressFingerprint - returns valid 64 lowercase hex', () => {
  const snapshot = {
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  const fp = computeProgressFingerprint(snapshot);
  assert.ok(/^[a-f0-9]{64}$/.test(fp), 'Fingerprint must be exactly 64 lowercase hex chars');
});
