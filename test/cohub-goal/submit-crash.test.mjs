import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitAction, recoverSubmit } from '../../src/cohub-claude-goal/submit.js';
import { PHASES } from '../../src/cohub-claude-goal/action-slot.js';

// Crash injection tests: before-send / during-send / after-send with exact recovery behavior.

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

function submitParams(ctx, overrides = {}) {
  return {
    ctx,
    goalInstance: 'test-goal',
    expectedSnapshotHash: 'a'.repeat(64),
    actionSlotId: 'slot-123',
    continuationId: 'cont-123',
    decisionCode: 'action-start',
    evidenceRefs: [],
    currentSnapshot: SNAPSHOT,
    freshInspect: FRESH,
    ...overrides,
  };
}

describe('submit crash injection', () => {
  it('SEND-01: crash after PREPARED, before network → recovery sends exactly once', async () => {
    const ctx = makeCtx();
    let networkCalls = 0;

    await assert.rejects(
      submitAction(submitParams(ctx, {
        injectCrash: { at: 'before-send' },
        cohubSend: async () => {
          networkCalls += 1;
          return { turnId: 'turn-1', sequence: 6 };
        },
      })),
      /INJECTED_CRASH/,
    );

    assert.deepStrictEqual(ctx.ledger.map(e => e.phase), [PHASES.OBSERVED, PHASES.PREPARED]);
    assert.strictEqual(networkCalls, 0);

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async (cid) => {
        const turn = ctx.parentTurns.find(t => t.clientMessageId === cid);
        return turn ? { found: true, turnId: turn.turnId } : { found: false };
      },
      cohubSend: async (params) => {
        networkCalls += 1;
        ctx.parentTurns.push({ turnId: 'turn-1', clientMessageId: params.clientMessageId, sequence: 6 });
        return { turnId: 'turn-1', sequence: 6 };
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(networkCalls, 1);
    assert.strictEqual(ctx.parentTurns.length, 1);
    assert.deepStrictEqual(ctx.ledger.map(e => e.phase), [PHASES.OBSERVED, PHASES.PREPARED, PHASES.REQUEST_STARTED, PHASES.CONFIRMED]);
  });

  it('SEND-02: crash during send (server got it) → recovery finds Turn by clientMessageId, no resend', async () => {
    const ctx = makeCtx();
    let networkCalls = 0;

    await assert.rejects(
      submitAction(submitParams(ctx, {
        injectCrash: { at: 'during-send' },
        cohubSend: async (params) => {
          networkCalls += 1;
          ctx.parentTurns.push({ turnId: 'turn-srv', clientMessageId: params.clientMessageId, sequence: 6 });
          return { turnId: 'turn-srv', sequence: 6 };
        },
      })),
      /INJECTED_CRASH/,
    );

    assert.deepStrictEqual(ctx.ledger.map(e => e.phase), [PHASES.OBSERVED, PHASES.PREPARED, PHASES.REQUEST_STARTED]);
    assert.strictEqual(ctx.parentTurns.length, 1);

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async (cid) => {
        const turn = ctx.parentTurns.find(t => t.clientMessageId === cid);
        return turn ? { found: true, turnId: turn.turnId } : { found: false };
      },
      cohubSend: async () => {
        networkCalls += 1;
        throw new Error('must not resend');
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-srv');
    assert.strictEqual(result.reconciled, true);
    assert.strictEqual(networkCalls, 1);
    assert.strictEqual(ctx.parentTurns.length, 1);
    assert.strictEqual(ctx.ledger.at(-1).phase, PHASES.CONFIRMED);
  });

  it('SEND-02b: crash during send, server did NOT get it → BLOCKED_AMBIGUOUS_SEND', async () => {
    const ctx = makeCtx();

    await assert.rejects(
      submitAction(submitParams(ctx, {
        injectCrash: { at: 'during-send' },
        cohubSend: async () => {
          return { turnId: 'never', sequence: 0 };
        },
      })),
      /INJECTED_CRASH/,
    );

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({ found: false }),
      cohubSend: async () => {
        throw new Error('must not resend on ambiguity');
      },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.strictEqual(ctx.parentTurns.length, 0);
    assert.strictEqual(ctx.ledger.at(-1).phase, PHASES.AMBIGUOUS);
  });

  it('SEND-03: crash after response, before CONFIRMED → recovery binds existing Turn', async () => {
    const ctx = makeCtx();
    let networkCalls = 0;

    await assert.rejects(
      submitAction(submitParams(ctx, {
        injectCrash: { at: 'after-send' },
        cohubSend: async (params) => {
          networkCalls += 1;
          ctx.parentTurns.push({ turnId: 'turn-done', clientMessageId: params.clientMessageId, sequence: 6 });
          return { turnId: 'turn-done', sequence: 6 };
        },
      })),
      /INJECTED_CRASH/,
    );

    assert.deepStrictEqual(ctx.ledger.map(e => e.phase), [PHASES.OBSERVED, PHASES.PREPARED, PHASES.REQUEST_STARTED]);

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async (cid) => {
        const turn = ctx.parentTurns.find(t => t.clientMessageId === cid);
        return turn ? { found: true, turnId: turn.turnId } : { found: false };
      },
      cohubSend: async () => {
        networkCalls += 1;
        throw new Error('must not resend');
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-done');
    assert.strictEqual(networkCalls, 1);
    assert.strictEqual(ctx.parentTurns.length, 1);
    assert.strictEqual(ctx.ledger.at(-1).phase, PHASES.CONFIRMED);
  });

  it('SEND-04: stale snapshot during PREPARED → persist CANCELLED_STALE_BEFORE_SEND', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
    ];

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: async () => ({
        snapshotHash: 'b'.repeat(64),
        parentSequence: 6,
        inputWatermark: 2,
        unconsumedEvents: [],
      }),
      reconcileByClientMessageId: async () => ({ found: false }),
      cohubSend: async () => {
        throw new Error('must not send on stale snapshot');
      },
    });

    assert.strictEqual(result.error, 'CANCELLED_STALE_BEFORE_SEND');
    assert.strictEqual(ctx.ledger.at(-1).phase, PHASES.CANCELLED_STALE_BEFORE_SEND);
    assert.ok(ctx.ledger.at(-1).evidence);
  });

  it('SEND-05: reconciliation returns multiple Turns (malformed) → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({ found: 'maybe' }), // malformed
      cohubSend: async () => {
        throw new Error('must not send');
      },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('malformed'));
  });

  it('SEND-06: reconciliation found=true but missing turnId → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    const result = await submitAction(submitParams(ctx, {
      reconcileByClientMessageId: async () => ({ found: true }), // missing turnId
    }));

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('turnId is missing'));
  });
});
