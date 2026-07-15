import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitAction, recoverSubmit } from '../../src/cohub-claude-goal/submit.js';
import { PHASES } from '../../src/cohub-claude-goal/action-slot.js';

// Action reconciliation with exact Turn matches: all five fields required, exactly one match confirms.

function makeCtx() {
  const ctx = {
    ledger: [],
    parentTurns: [],
    writePhase: async (phase, data) => {
      ctx.ledger.push({ phase, ...data });
    },
  };
  return ctx;
}

const SNAPSHOT = {
  snapshotHash: 'a'.repeat(64),
  parentSequence: 5,
  inputWatermark: 2,
  actionSlot: {
    actionSlotId: 'slot-123',
    continuationId: 'cont-123',
    expectedParentSequence: 5,
    expectedInputWatermark: 2,
  },
};

const FRESH = async () => ({
  snapshotHash: 'a'.repeat(64),
  parentSequence: 5,
  inputWatermark: 2,
  unconsumedEvents: [],
});

describe('action reconciliation with exact Turn matches', () => {
  it('RECON-01: reconciliation must return exact own plain object with matches array', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;

    // Null result
    const nullResult = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => null,
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(nullResult.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(nullResult.reason.includes('invalid'));
    assert.strictEqual(sendCalls, 0);

    // Array result (instead of object with matches)
    ctx.ledger = ctx.ledger.filter(e => e.phase !== PHASES.AMBIGUOUS);
    const arrayResult = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => [{ turnId: 'turn-1' }],
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(arrayResult.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.strictEqual(sendCalls, 0);

    // Object without matches array
    ctx.ledger = ctx.ledger.filter(e => e.phase !== PHASES.AMBIGUOUS);
    const noMatchesResult = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({ found: true, turnId: 'turn-1' }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(noMatchesResult.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(noMatchesResult.reason.includes('matches'));
  });

  it('RECON-02: reconciliation with accessor properties → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    const objWithGetter = {};
    Object.defineProperty(objWithGetter, 'matches', { get: () => [] });

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => objWithGetter,
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('invalid'));
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(ctx.ledger.filter(e => e.phase === PHASES.AMBIGUOUS).length, 1);
  });

  it('RECON-03: reconciliation with inherited properties → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    class ReconcileResult {
      constructor() {
        this.matches = [];
      }
    }

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => new ReconcileResult(),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-04: zero candidate matches → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({ matches: [] }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('uncertain'));
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(ctx.ledger.filter(e => e.phase === PHASES.AMBIGUOUS).length, 1);
  });

  it('RECON-05: multiple candidate matches → AMBIGUOUS blocker, zero sends', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: 'turn-1',
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
          {
            turnId: 'turn-2',
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('Multiple matches'));
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(ctx.ledger.filter(e => e.phase === PHASES.AMBIGUOUS).length, 1);
  });

  it('RECON-06: exactly one valid match → bind once, zero sends', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: 'turn-existing',
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-parent',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-existing');
    assert.strictEqual(result.reconciled, true);
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(ctx.ledger.at(-1).phase, PHASES.CONFIRMED);
    assert.strictEqual(ctx.ledger.at(-1).parentSessionId, 'sess-parent');
  });

  it('RECON-07: repeated recovery must not duplicate AMBIGUOUS blockers', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const reconcile = async () => ({ matches: [] });
    const send = async () => { sendCalls++; throw new Error('must not send'); };

    const result1 = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: reconcile,
      cohubSend: send,
    });

    assert.strictEqual(result1.error, 'BLOCKED_AMBIGUOUS_SEND');
    const ambiguousCount1 = ctx.ledger.filter(e => e.phase === PHASES.AMBIGUOUS).length;
    assert.strictEqual(ambiguousCount1, 1);

    const result2 = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: reconcile,
      cohubSend: send,
    });

    assert.strictEqual(result2.error, 'BLOCKED_AMBIGUOUS_SEND');
    const ambiguousCount2 = ctx.ledger.filter(e => e.phase === PHASES.AMBIGUOUS).length;
    assert.strictEqual(ambiguousCount2, 1, 'repeated recovery must not duplicate AMBIGUOUS');
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-08: match missing required field → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;

    // Missing turnId
    const noTurnId = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(noTurnId.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(noTurnId.reason.includes('turnId'));

    // Empty string field
    ctx.ledger = ctx.ledger.filter(e => e.phase !== PHASES.AMBIGUOUS);
    const emptyField = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: '',
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(emptyField.error, 'BLOCKED_AMBIGUOUS_SEND');

    // Non-string field
    ctx.ledger = ctx.ledger.filter(e => e.phase !== PHASES.AMBIGUOUS);
    const numericField = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: 123,
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(numericField.error, 'BLOCKED_AMBIGUOUS_SEND');

    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-09: match actionSlotId mismatch → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: 'turn-1',
            actionSlotId: 'slot-wrong',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('actionSlotId'));
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-10: match continuationId mismatch → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: 'turn-1',
            actionSlotId: 'slot-123',
            continuationId: 'cont-wrong',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('continuationId'));
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-11: match clientMessageId ≠ continuationId → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({
        matches: [
          {
            turnId: 'turn-1',
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-different',
            parentSessionId: 'sess-A',
          },
        ],
      }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('clientMessageId'));
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-12: accessor bypass prevention via copied data', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let mutationAttempted = false;
    let sendCalls = 0;

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => {
        const matches = [
          {
            turnId: 'turn-valid',
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
            clientMessageId: 'cont-123',
            parentSessionId: 'sess-A',
          },
        ];
        // Attempt to mutate after returning
        setTimeout(() => {
          mutationAttempted = true;
          matches[0].turnId = 'turn-hacked';
        }, 0);
        return { matches };
      },
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-valid');
    assert.strictEqual(sendCalls, 0);

    // Verify CONFIRMED has the original turnId
    const confirmed = ctx.ledger.find(e => e.phase === PHASES.CONFIRMED);
    assert.strictEqual(confirmed.turnId, 'turn-valid');
  });
});
