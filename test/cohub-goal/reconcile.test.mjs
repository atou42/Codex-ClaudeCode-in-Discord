import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitAction, recoverSubmit } from '../../src/cohub-claude-goal/submit.js';
import { PHASES } from '../../src/cohub-claude-goal/action-slot.js';

// Reconciliation input validation: exact own descriptor-safe object, matches array binding consistency, zero/multiple/malformed results.

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

describe('reconciliation input validation', () => {
  it('RECON-01: reconciliation must return exact own plain object', async () => {
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

    // Array result
    const arrayResult = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => [{ found: true, turnId: 'turn-1' }],
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(arrayResult.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-02: reconciliation with accessor properties → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    const objWithGetter = {};
    Object.defineProperty(objWithGetter, 'found', { get: () => true });
    Object.defineProperty(objWithGetter, 'turnId', { get: () => 'turn-1' });

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
        this.found = true;
        this.turnId = 'turn-1';
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

  it('RECON-04: zero candidate matches → found=false → BLOCK', async () => {
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
      reconcileByClientMessageId: async () => ({ found: false }),
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

    ctx.parentTurns = [
      { turnId: 'turn-1', clientMessageId: 'cont-123', parentSessionId: 'sess-A', sequence: 6 },
      { turnId: 'turn-2', clientMessageId: 'cont-123', parentSessionId: 'sess-A', sequence: 7 },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async (cid) => {
        const matches = ctx.parentTurns.filter(t => t.clientMessageId === cid);
        if (matches.length === 0) return { found: false };
        if (matches.length > 1) return { found: 'multiple', count: matches.length };
        return { found: true, turnId: matches[0].turnId };
      },
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('malformed') || result.reason.includes('found not true'));
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(ctx.ledger.filter(e => e.phase === PHASES.AMBIGUOUS).length, 1);
  });

  it('RECON-06: found=true with valid turnId → bind once, zero sends', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    ctx.parentTurns = [
      { turnId: 'turn-existing', clientMessageId: 'cont-123', sequence: 6 },
    ];

    let sendCalls = 0;
    const result = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async (cid) => {
        const turn = ctx.parentTurns.find(t => t.clientMessageId === cid);
        return turn ? { found: true, turnId: turn.turnId } : { found: false };
      },
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-existing');
    assert.strictEqual(result.reconciled, true);
    assert.strictEqual(sendCalls, 0);
    assert.strictEqual(ctx.ledger.at(-1).phase, PHASES.CONFIRMED);
  });

  it('RECON-07: repeated recovery must not duplicate AMBIGUOUS blockers', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;
    const reconcile = async () => ({ found: false });
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

  it('RECON-08: unknown reconciliation shape → BLOCK', async () => {
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
      reconcileByClientMessageId: async () => ({ status: 'unknown', data: {} }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('malformed') || result.reason.includes('found not true'));
    assert.strictEqual(sendCalls, 0);
  });

  it('RECON-09: malformed turnId in found=true result → BLOCK', async () => {
    const ctx = makeCtx();
    ctx.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    let sendCalls = 0;

    // Empty string turnId
    const emptyResult = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({ found: true, turnId: '' }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(emptyResult.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(emptyResult.reason.includes('turnId'));

    // Numeric turnId
    const numericResult = await recoverSubmit({
      ctx,
      goalInstance: 'test-goal',
      freshInspect: FRESH,
      reconcileByClientMessageId: async () => ({ found: true, turnId: 123 }),
      cohubSend: async () => { sendCalls++; throw new Error('must not send'); },
    });
    assert.strictEqual(numericResult.error, 'BLOCKED_AMBIGUOUS_SEND');

    assert.strictEqual(sendCalls, 0);
  });
});
