#!/usr/bin/env node
/**
 * Adversarial regression tests for verify() boundary violations.
 * Tests must FAIL on 09efe7d and PASS after fix.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

const MOCK_GOAL = { goalId: 'test', version: '1.0', spaceId: 'sp_test' };
const VALID_HASH = 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890';

// Track trap calls
let trapCallCount = 0;

function createProxyTrap() {
  trapCallCount = 0;
  const handler = {
    get(target, prop, receiver) {
      trapCallCount++;
      if (prop === 'status') return 'IN_PROGRESS';
      if (prop === 'type') return 'WAIT_WORKER';
      return undefined;
    },
    has() { trapCallCount++; return true; },
    ownKeys() { trapCallCount++; return []; },
    getOwnPropertyDescriptor() { trapCallCount++; return undefined; }
  };
  return { handler, proxy: new Proxy({}, handler) };
}

test('verify: rejects Proxy before ANY object operation', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const { proxy } = createProxyTrap();
  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: proxy
  };

  trapCallCount = 0;
  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /proxy.*not allowed/i,
    'Must reject proxy before any trap fires'
  );

  assert.strictEqual(trapCallCount, 0, 'Zero trap calls - types.isProxy must be first check');
});

test('verify: rejects nested Proxy', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const { proxy } = createProxyTrap();
  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: {
      status: 'IN_PROGRESS',
      nested: proxy
    }
  };

  trapCallCount = 0;
  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /proxy.*not allowed/i,
    'Must reject nested proxy'
  );

  assert.strictEqual(trapCallCount, 0, 'Zero nested trap calls');
});

test('verify: rejects accessor property', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const orchestrationState = {};
  Object.defineProperty(orchestrationState, 'status', {
    get() { throw new Error('Getter executed!'); },
    enumerable: true
  });

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /accessor/i,
    'Must reject accessor before executing getter'
  );
});

test('verify: rejects Symbol property', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const sym = Symbol('evil');
  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    [sym]: 'secret'
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /symbol.*not allowed/i,
    'Must reject Symbol keys'
  );
});

test('verify: rejects circular reference', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const orchestrationState = { status: 'IN_PROGRESS' };
  orchestrationState.self = orchestrationState;

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /circular.*not allowed/i,
    'Must reject cycles'
  );
});

test('verify: rejects sparse array', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const arr = [];
  arr[0] = 'a';
  arr[5] = 'b'; // sparse

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    workers: arr
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /sparse.*not allowed/i,
    'Must reject sparse arrays'
  );
});

test('verify: rejects custom prototype', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  class CustomState {
    constructor() {
      this.status = 'IN_PROGRESS';
    }
  }

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: new CustomState()
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /custom prototype.*not allowed/i,
    'Must reject custom prototypes'
  );
});

test('verify: wrong workflow state WAITING_USER_INPUT', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'WAITING_USER_INPUT' }, // wrong, should be WAITING_USER
    userGate: {
      gate: 'proposal_approval',
      consumed: false,
      promptTurnId: 't1'
    }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  // Must NOT return PAUSED_USER for wrong workflow state
  assert.notStrictEqual(result.verdict, 'PAUSED_USER',
    'Must reject WAITING_USER_INPUT, only WAITING_USER is valid');
});

test('verify: rejects wrong gate name "proposal" instead of "proposal_approval"', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'WAITING_USER' },
    userGate: {
      gate: 'proposal', // wrong, should be proposal_approval
      consumed: false,
      promptTurnId: 't1'
    }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.notStrictEqual(result.verdict, 'PAUSED_USER',
    'Must reject wrong gate name "proposal"');
});

test('verify: RUNNING must have exact next action or watchSet, never UNKNOWN', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'UNKNOWN' }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.strictEqual(result.verdict, 'BLOCKED', 'Must return BLOCKED for UNKNOWN nextAction');
  assert.match(result.reason, /UNKNOWN/i, 'Reason must mention UNKNOWN');
});

test('verify: fake DONE with init checkpoint', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'COMPLETE' },
    deliveryEvidence: {
      schemaVersion: '1.0',
      worldId: 'w1',
      spaceId: 'sp1',
      checkpointId: 'init_checkpoint', // fake!
      checkpointCreatedAt: '2026-07-15T10:00:00Z',
      manifestSha256: VALID_HASH,
      studioUrl: 'https://neta.art/w1',
      cohubUrl: 'https://cohub.run/sp1',
      desktopScreenshot: {
        sha256: VALID_HASH,
        width: 1440,
        height: 900,
        capturedAt: '2026-07-15T10:01:00Z',
        manifestHash: VALID_HASH
      },
      mobileScreenshot: {
        sha256: VALID_HASH,
        width: 390,
        height: 844,
        capturedAt: '2026-07-15T10:01:00Z',
        manifestHash: VALID_HASH
      },
      guestProbe: {
        status: 200,
        role: 'guest',
        requestHadCookie: false,
        requestHadAuthorization: false
      },
      finalReport: VALID_HASH,
      gateLog: VALID_HASH,
      evidenceCreatedAt: '2026-07-15T10:02:00Z'
    },
    studioAcceptance: { consumed: true }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.strictEqual(result.verdict, 'BLOCKED',
    'Must BLOCK fake completion with init checkpoint');
  assert.match(result.reason, /init checkpoint.*forbidden/i);
});

test('verify: DONE requires all exact evidence fields', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'COMPLETE' },
    deliveryEvidence: {
      schemaVersion: '1.0',
      worldId: 'w1',
      spaceId: 'sp1',
      checkpointId: 'final_cp_123',
      // missing checkpointCreatedAt
      manifestSha256: VALID_HASH,
      studioUrl: 'https://neta.art/w1',
      cohubUrl: 'https://cohub.run/sp1',
      desktopScreenshot: {
        sha256: VALID_HASH,
        width: 1440,
        height: 900,
        capturedAt: '2026-07-15T10:01:00Z',
        manifestHash: VALID_HASH
      },
      mobileScreenshot: {
        sha256: VALID_HASH,
        width: 390,
        height: 844,
        capturedAt: '2026-07-15T10:01:00Z',
        manifestHash: VALID_HASH
      },
      guestProbe: {
        status: 200,
        role: 'guest',
        requestHadCookie: false,
        requestHadAuthorization: false
      },
      finalReport: VALID_HASH,
      gateLog: VALID_HASH,
      evidenceCreatedAt: '2026-07-15T10:02:00Z'
    },
    studioAcceptance: { consumed: true }
  };

  const result = verify(MOCK_GOAL, { snapshot });

  assert.notStrictEqual(result.verdict, 'DONE',
    'Must NOT return DONE with missing checkpointCreatedAt');
  assert.ok(result.missingEvidence || result.verdict === 'RUNNING');
});

test('computeProgressFingerprint: must preserve nested keys', async () => {
  const { computeProgressFingerprint } = await import('../../src/cohub-claude-goal/no-progress.js');

  const snapshot1 = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    userGate: { gate: 'proposal_approval', consumed: false, promptTurnId: 't1' }
  };

  const snapshot2 = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    userGate: { gate: 'style_approval', consumed: false, promptTurnId: 't1' }
  };

  const fp1 = computeProgressFingerprint(snapshot1);
  const fp2 = computeProgressFingerprint(snapshot2);

  assert.notStrictEqual(fp1, fp2,
    'Different nested values must produce different fingerprints');
});

test('computeProgressFingerprint: must be invariant to prose changes', async () => {
  const { computeProgressFingerprint } = await import('../../src/cohub-claude-goal/no-progress.js');

  const snapshot1 = {
    orchestrationState: { status: 'IN_PROGRESS' },
    workerMessage: 'Making progress...'
  };

  const snapshot2 = {
    orchestrationState: { status: 'IN_PROGRESS' },
    workerMessage: 'Still working on it'
  };

  const fp1 = computeProgressFingerprint(snapshot1);
  const fp2 = computeProgressFingerprint(snapshot2);

  assert.strictEqual(fp1, fp2,
    'Prose changes must not affect fingerprint');
});

test('no-progress: irrelevant tool action does not count as progress', async () => {
  const { detectNoProgress } = await import('../../src/cohub-claude-goal/no-progress.js');

  const history = [];
  const currentTurn = {
    hadToolAction: true,
    toolActionWasRelevant: false // e.g., just text generation
  };

  // Current implementation incorrectly treats ANY tool action as progress
  const result = detectNoProgress(VALID_HASH, history, currentTurn);

  // Should be no-progress because tool was irrelevant
  assert.strictEqual(result.isNoProgress, true,
    'Irrelevant tool actions must not reset no-progress');
});

test('sanitize: rejects excessive depth', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  // Build deeply nested structure
  let deep = { value: 'bottom' };
  for (let i = 0; i < 100; i++) {
    deep = { nested: deep };
  }

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    deepData: deep
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /depth.*exceeded/i,
    'Must reject excessive nesting depth'
  );
});

test('sanitize: rejects non-finite numbers', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    metric: Infinity
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /non-finite.*not allowed/i,
    'Must reject Infinity'
  );
});

test('sanitize: rejects NaN', async () => {
  const { verify } = await import('../../src/cohub-claude-goal/verify.js');

  const snapshot = {
    snapshotHash: VALID_HASH,
    orchestrationState: { status: 'IN_PROGRESS' },
    metric: NaN
  };

  assert.throws(
    () => verify(MOCK_GOAL, { snapshot }),
    /NaN.*not allowed/i,
    'Must reject NaN'
  );
});
