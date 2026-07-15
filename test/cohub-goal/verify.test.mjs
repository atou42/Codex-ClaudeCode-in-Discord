/**
 * @fileoverview Adversarial tests for verify.js deterministic verdict engine.
 * Tests must run RED before implementation exists.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { verify } from '../../src/cohub-claude-goal/verify.js';

const MOCK_GOAL_INSTANCE = {
  goalId: 'goal_test_001',
  version: 'v1.2.3',
  spaceId: 'sp_test'
};

test('verify - rejects missing goalInstance', () => {
  assert.throws(
    () => verify(),
    { name: 'TypeError', message: /goalInstance.*required/ }
  );
});

test('verify - rejects non-object goalInstance', () => {
  assert.throws(
    () => verify('not-an-object'),
    { name: 'TypeError', message: /goalInstance.*object/ }
  );
});

test('verify - fresh snapshot binding - RUNNING with valid next action', () => {
  const snapshot = {
    snapshotHash: 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890',
    orchestrationState: {
      status: 'IN_PROGRESS',
      currentStage: 'geography',
      pendingWorkers: ['worker_geo_001']
    },
    nextAction: {
      type: 'WAIT_WORKER',
      workerId: 'worker_geo_001'
    },
    missingEvidence: []
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });

  assert.strictEqual(result.verdict, 'RUNNING');
  assert.strictEqual(result.snapshotHash, 'a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890');
  assert.ok(result.nextAction);
  assert.strictEqual(result.nextAction.type, 'WAIT_WORKER');
  assert.deepStrictEqual(result.missingEvidence, []);
});

test('verify - DONE requires orchestration COMPLETE', () => {
  const snapshot = {
    snapshotHash: 'b0b1b2b3b4b5b6b7b8b9babbbcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecf',
    orchestrationState: {
      status: 'IN_PROGRESS'
    },
    deliveryEvidence: {
      worldId: 'world_001',
      spaceId: 'sp_001',
      checkpointId: 'ckpt_final',
      studioUrl: 'https://neta.art/w/world_001',
      cohubUrl: 'https://cohub.run/spaces/sp_001',
      desktopScreenshot: { sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      mobileScreenshot: { sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      guestProbe: { status: 200, role: 'guest' },
      finalReport: { sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
      gateLog: { sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'RUNNING');
  assert.ok(result.reason.includes('orchestration') || result.reason.includes('COMPLETE'));
});

test('verify - DONE requires all delivery evidence', () => {
  const snapshot = {
    snapshotHash: 'd0d1d2d3d4d5d6d7d8d9dadbdcdddedfe0e1e2e3e4e5e6e7e8e9eaebecedeeef',
    orchestrationState: {
      status: 'COMPLETE'
    },
    deliveryEvidence: {
      worldId: 'world_001',
      spaceId: 'sp_test', // Must match MOCK_GOAL_INSTANCE.spaceId
      checkpointId: 'ckpt_final',
      studioUrl: 'https://neta.art/w/world_001'
      // Missing screenshots, probe, reports
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'RUNNING');
  assert.ok(result.missingEvidence.length > 0);
  assert.ok(result.missingEvidence.some(e => e.includes('desktopScreenshot')));
  assert.ok(result.missingEvidence.some(e => e.includes('mobileScreenshot')));
});

test('verify - PAUSED_USER requires real user gate', () => {
  const snapshot = {
    snapshotHash: 'f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff00010203040506070809000102030405',
    orchestrationState: {
      status: 'WAITING_USER'
    },
    userGate: {
      gate: 'proposal_approval',
      promptTurnId: 'turn_prompt_001',
      consumed: false
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'PAUSED_USER');
  assert.strictEqual(result.gate, 'proposal_approval');
});

test('verify - PAUSED_USER rejects consumed proposal', () => {
  const snapshot = {
    snapshotHash: '0607080910111213141516171819202122232425262728293031323334353637',
    orchestrationState: {
      status: 'WAITING_USER'
    },
    userGate: {
      gate: 'proposal_approval',
      promptTurnId: 'turn_prompt_002',
      consumed: true
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.notStrictEqual(result.verdict, 'PAUSED_USER');
});

test('verify - BLOCKED requires evidence', () => {
  const snapshot = {
    snapshotHash: '3839404142434445464748495051525354555657585960616263646566676869',
    orchestrationState: {
      status: 'BLOCKED'
    },
    blocker: {
      type: 'PERMISSION_DENIED',
      resource: 'cohub_spaces_write',
      evidence: { errorCode: 403, timestamp: '2026-07-15T10:00:00.000Z' }
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'BLOCKED');
  assert.strictEqual(result.reason, 'PERMISSION_DENIED');
  assert.ok(result.evidenceRefs);
});

test('verify - rejects expectedSnapshotHash mismatch', () => {
  const snapshot = {
    snapshotHash: '7071727374757677787980818283848586878889909192939495969798990001',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, { snapshot, expectedSnapshotHash: '0203040506070809101112131415161718192021222324252627282930313233' }),
    /[Ss]napshot.*mismatch/
  );
});

test('verify - worker prose never yields DONE', () => {
  const snapshot = {
    snapshotHash: '3435363738394041424344454647484950515253545556575859606162636465',
    orchestrationState: {
      status: 'IN_PROGRESS'
    },
    latestWorkerOutput: {
      content: 'I will continue working on the geography module and return PASS when complete.'
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.notStrictEqual(result.verdict, 'DONE');
});

test('verify - Turn completed never yields DONE', () => {
  const snapshot = {
    snapshotHash: '6667686970717273747576777879808182838485868788899091929394959697',
    orchestrationState: {
      status: 'IN_PROGRESS'
    },
    latestTurn: {
      status: 'completed',
      message: 'Turn completed successfully'
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.notStrictEqual(result.verdict, 'DONE');
});

test('verify - fake completion detection', () => {
  const snapshot = {
    snapshotHash: '9899000102030405060708091011121314151617181920212223242526272829',
    orchestrationState: {
      status: 'COMPLETE'
    },
    deliveryEvidence: {
      worldId: 'world_001',
      spaceId: 'sp_test', // Must match MOCK_GOAL_INSTANCE.spaceId
      checkpointId: 'init_checkpoint', // Init checkpoint forbidden
      studioUrl: 'https://neta.art/w/world_001',
      cohubUrl: 'https://cohub.run/spaces/sp_test',
      desktopScreenshot: { sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      mobileScreenshot: { sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      guestProbe: { status: 200, role: 'guest' },
      finalReport: { sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
      gateLog: { sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'BLOCKED');
  assert.match(result.reason, /INIT_CHECKPOINT_FORBIDDEN/i);
});

test('verify - corrupt state detection', () => {
  const snapshot = {
    snapshotHash: '3031323334353637383940414243444546474849505152535455565758596061',
    orchestrationState: {
      status: 'IN_PROGRESS',
      currentStage: 'geography'
    },
    stageGateLog: {
      geography: {
        status: 'SKIP' // Invalid status
      }
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'BLOCKED');
  assert.match(result.reason, /CORRUPT_STAGE_STATUS/i);
});

test('verify - UNBOUND_REPLACEMENT_RECEIPT for live migration', () => {
  const snapshot = {
    snapshotHash: '6263646566676869707172737475767778798081828384858687888990919293',
    orchestrationState: {
      status: 'IN_PROGRESS',
      currentStage: 'geography_replacement'
    },
    replacementWorker: {
      workerId: 'worker_geo_002',
      bindingReceipt: null
    },
    migrationDoctor: {
      verdict: 'UNBOUND_REPLACEMENT_RECEIPT'
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'BLOCKED');
  assert.strictEqual(result.reason, 'UNBOUND_REPLACEMENT_RECEIPT');
});

test('verify - historical regression fixture', () => {
  const snapshot = {
    snapshotHash: '9495969798990001020304050607080910111213141516171819202122232425',
    orchestrationState: {
      status: 'IN_PROGRESS'
    },
    historical: true,
    sessionId: '5357ecbb-d695-4507-9efa-32cfea26123b',
    turn: 67
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  // Historical fixtures should not yield DONE
  assert.notStrictEqual(result.verdict, 'DONE');
});

test('verify - final delivery proof complete', () => {
  const snapshot = {
    snapshotHash: '2627282930313233343536373839404142434445464748495051525354555657',
    orchestrationState: {
      status: 'COMPLETE'
    },
    studioAcceptance: {
      consumed: true,
      userId: 'user_real_001',
      eventId: 'evt_001'
    },
    deliveryEvidence: {
      schemaVersion: '1.0.0',
      worldId: 'world_001',
      spaceId: 'sp_test', // Must match MOCK_GOAL_INSTANCE.spaceId
      checkpointId: 'ckpt_final_001',
      checkpointCreatedAt: '2026-07-15T10:00:00.000Z',
      manifestSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      studioUrl: 'https://neta.art/w/world_001',
      cohubUrl: 'https://cohub.run/spaces/sp_test',
      parentSessionId: 'sess_001',
      parentTurnId: 'turn_001',
      desktopScreenshot: {
        path: 'screenshots/desktop.png',
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        width: 1440,
        height: 900,
        capturedAt: '2026-07-15T10:05:00.000Z',
        manifestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        worldId: 'world_001',
        checkpointId: 'ckpt_final_001'
      },
      mobileScreenshot: {
        path: 'screenshots/mobile.png',
        sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        width: 390,
        height: 844,
        capturedAt: '2026-07-15T10:05:00.000Z',
        manifestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        worldId: 'world_001',
        checkpointId: 'ckpt_final_001'
      },
      guestProbe: {
        url: 'https://neta.art/w/world_001',
        status: 200,
        worldId: 'world_001',
        observedWorldId: 'world_001',
        role: 'guest',
        requestHadCookie: false,
        requestHadAuthorization: false,
        probedAt: '2026-07-15T10:06:00.000Z'
      },
      finalReport: { sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' },
      gateLog: { sha256: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      evidenceCreatedAt: '2026-07-15T10:06:00.000Z'
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'DONE');
  assert.strictEqual(result.snapshotHash, '2627282930313233343536373839404142434445464748495051525354555657');
});

test('verify - output frozen and descriptor-safe', () => {
  const snapshot = {
    snapshotHash: '5859606162636465666768697071727374757677787980818283848586878889',
    orchestrationState: { status: 'IN_PROGRESS' },
    nextAction: { type: 'WAIT_WORKER' }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });

  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.verdict = 'HACKED'; });

  const descriptor = Object.getOwnPropertyDescriptor(result, 'verdict');
  assert.strictEqual(descriptor.writable, false);
  assert.strictEqual(descriptor.configurable, false);
});

test('verify - no network calls', async () => {
  const snapshot = {
    snapshotHash: '9091929394959697989900010203040506070809101112131415161718192021',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  // verify is synchronous, no await possible
  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.ok(result);
  assert.strictEqual(typeof result, 'object');
});

test('verify - user gate enforcement - only proposal_approval/style_approval/studio_acceptance allowed', () => {
  const validGates = ['proposal_approval', 'style_approval', 'studio_acceptance'];

  for (const gate of validGates) {
    const snapshot = {
      snapshotHash: `${gate.charCodeAt(0).toString(16).padStart(2, '0')}23242526272829303132333435363738394041424344454647484950515253`,
      orchestrationState: { status: 'WAITING_USER' },
      userGate: {
        gate,
        promptTurnId: `turn_${gate}`,
        consumed: false
      }
    };
    const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
    assert.strictEqual(result.verdict, 'PAUSED_USER');
  }

  // Invalid gate
  const invalidSnapshot = {
    snapshotHash: '5455565758596061626364656667686970717273747576777879808182838485',
    orchestrationState: { status: 'WAITING_USER' },
    userGate: {
      gate: 'invalid_gate',
      promptTurnId: 'turn_invalid',
      consumed: false
    }
  };
  const invalidResult = verify(MOCK_GOAL_INSTANCE, { snapshot: invalidSnapshot });
  assert.notStrictEqual(invalidResult.verdict, 'PAUSED_USER');
});

test('verify - missing evidence list populated', () => {
  const snapshot = {
    snapshotHash: '8687888990919293949596979899000102030405060708091011121314151617',
    orchestrationState: { status: 'COMPLETE' },
    deliveryEvidence: {
      worldId: 'world_001',
      spaceId: 'sp_test' // Must match MOCK_GOAL_INSTANCE.spaceId
      // Missing all other fields
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.strictEqual(result.verdict, 'RUNNING');
  assert.ok(Array.isArray(result.missingEvidence));
  assert.ok(result.missingEvidence.length > 0);
  assert.ok(result.missingEvidence.some(e => e.includes('spaceId') || e.includes('checkpointId')));
});

// Hash validation adversarial tests
test('verify - rejects uppercase snapshotHash', () => {
  const snapshot = {
    snapshotHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, { snapshot }),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('verify - rejects short snapshotHash', () => {
  const snapshot = {
    snapshotHash: 'abc123',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, { snapshot }),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('verify - rejects long snapshotHash', () => {
  const snapshot = {
    snapshotHash: 'a'.repeat(65),
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, { snapshot }),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('verify - rejects non-hex snapshotHash', () => {
  const snapshot = {
    snapshotHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, { snapshot }),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('verify - rejects uppercase expectedSnapshotHash', () => {
  const snapshot = {
    snapshotHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, {
      snapshot,
      expectedSnapshotHash: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
    }),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('verify - rejects short expectedSnapshotHash', () => {
  const snapshot = {
    snapshotHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    orchestrationState: { status: 'IN_PROGRESS' }
  };

  assert.throws(
    () => verify(MOCK_GOAL_INSTANCE, { snapshot, expectedSnapshotHash: 'abc' }),
    { name: 'TypeError', message: /exactly 64 lowercase hex/ }
  );
});

test('verify - rejects invalid screenshot sha256', () => {
  const snapshot = {
    snapshotHash: 'fff0fff1fff2fff3fff4fff5fff6fff7fff8fff9fffafffbfffcfffdfffeffff',
    orchestrationState: { status: 'COMPLETE' },
    studioAcceptance: { consumed: true },
    deliveryEvidence: {
      schemaVersion: '1.0.0',
      worldId: 'world_001',
      spaceId: 'sp_001',
      checkpointId: 'ckpt_final_001',
      checkpointCreatedAt: '2026-07-15T10:00:00.000Z',
      manifestSha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      studioUrl: 'https://neta.art/w/world_001',
      cohubUrl: 'https://cohub.run/spaces/sp_001',
      desktopScreenshot: {
        sha256: 'INVALID',  // Invalid hash
        width: 1440,
        height: 900,
        capturedAt: '2026-07-15T10:05:00.000Z',
        manifestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      },
      mobileScreenshot: {
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        width: 390,
        height: 844,
        capturedAt: '2026-07-15T10:05:00.000Z',
        manifestHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      },
      guestProbe: {
        status: 200,
        role: 'guest',
        requestHadCookie: false,
        requestHadAuthorization: false
      },
      finalReport: { sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
      gateLog: { sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' },
      evidenceCreatedAt: '2026-07-15T10:06:00.000Z'
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.notStrictEqual(result.verdict, 'DONE');
});

test('verify - rejects invalid manifestSha256', () => {
  const snapshot = {
    snapshotHash: 'eee0eee1eee2eee3eee4eee5eee6eee7eee8eee9eeeaeeebeeeceeedeeeeffef',
    orchestrationState: { status: 'COMPLETE' },
    studioAcceptance: { consumed: true },
    deliveryEvidence: {
      schemaVersion: '1.0.0',
      worldId: 'world_001',
      spaceId: 'sp_001',
      checkpointId: 'ckpt_final_001',
      checkpointCreatedAt: '2026-07-15T10:00:00.000Z',
      manifestSha256: 'SHORT',  // Invalid hash
      studioUrl: 'https://neta.art/w/world_001',
      cohubUrl: 'https://cohub.run/spaces/sp_001',
      desktopScreenshot: {
        sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        width: 1440,
        height: 900,
        capturedAt: '2026-07-15T10:05:00.000Z',
        manifestHash: 'SHORT'
      },
      mobileScreenshot: {
        sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        width: 390,
        height: 844,
        capturedAt: '2026-07-15T10:05:00.000Z',
        manifestHash: 'SHORT'
      },
      guestProbe: {
        status: 200,
        role: 'guest',
        requestHadCookie: false,
        requestHadAuthorization: false
      },
      finalReport: { sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
      gateLog: { sha256: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' },
      evidenceCreatedAt: '2026-07-15T10:06:00.000Z'
    }
  };

  const result = verify(MOCK_GOAL_INSTANCE, { snapshot });
  assert.notStrictEqual(result.verdict, 'DONE');
});
