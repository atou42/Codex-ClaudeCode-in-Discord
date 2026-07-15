import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { submitAction, buildContinuationTemplate } from '../../src/cohub-claude-goal/submit.js';
import { PHASES } from '../../src/cohub-claude-goal/action-slot.js';

describe('submit', () => {
  function makeMockContext() {
    const ctx = {
      ledger: [],
      parentTurns: [],
      cohubSend: async () => ({ turnId: 'turn-123', sequence: 6 }),
      writePhase: async (phase, data) => {
        ctx.ledger.push({ phase, ...data, timestamp: Date.now() });
      },
    };
    return ctx;
  }

  it('should reject invalid action slot ID', async () => {
    const mockContext = makeMockContext();
    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'wrong-slot',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'correct-slot',
          continuationId: 'cont-123',
        },
      },
    });

    assert.strictEqual(result.error, 'INVALID_ACTION_SLOT');
    assert.ok(result.reason.includes('mismatch'));
  });

  it('should reject stale snapshot hash from fresh inspect', async () => {
    const mockContext = makeMockContext();
    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'b'.repeat(64),
        parentSequence: 6,
        inputWatermark: 3,
      }),
    });

    assert.strictEqual(result.error, 'STALE_SNAPSHOT');
    assert.ok(result.reason.includes('changed'));
  });

  it('should reject stale parent sequence', async () => {
    const mockContext = makeMockContext();
    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
          expectedParentSequence: 5,
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'a'.repeat(64),
        parentSequence: 6,
        inputWatermark: 2,
      }),
    });

    assert.strictEqual(result.error, 'STALE_SNAPSHOT');
    assert.ok(result.reason.includes('Parent sequence'));
  });

  it('should reject changed input watermark', async () => {
    const mockContext = makeMockContext();
    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
          expectedInputWatermark: 2,
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'a'.repeat(64),
        parentSequence: 5,
        inputWatermark: 3,
      }),
    });

    assert.strictEqual(result.error, 'UNCONSUMED_EXTERNAL_INPUT');
    assert.ok(result.reason.includes('watermark'));
  });

  it('should reject unconsumed external input', async () => {
    const mockContext = makeMockContext();
    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'a'.repeat(64),
        parentSequence: 5,
        inputWatermark: 2,
        unconsumedEvents: [{ eventId: 'evt-user-1', type: 'user_message' }],
      }),
    });

    assert.strictEqual(result.error, 'UNCONSUMED_EXTERNAL_INPUT');
    assert.ok(result.unconsumedEvents);
  });

  it('should write OBSERVED → PREPARED → REQUEST_STARTED → CONFIRMED sequence', async () => {
    const mockContext = makeMockContext();
    let sendCalled = false;

    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: ['ref-1', 'ref-2'],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        parentSequence: 5,
        inputWatermark: 2,
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
          expectedParentSequence: 5,
          expectedInputWatermark: 2,
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'a'.repeat(64),
        parentSequence: 5,
        inputWatermark: 2,
        unconsumedEvents: [],
      }),
      cohubSend: async (params) => {
        sendCalled = true;
        assert.strictEqual(params.clientMessageId, 'cont-123');
        assert.ok(params.prompt.includes('COHUB_GOAL_CONTINUATION'));
        assert.ok(params.prompt.includes('action-start'));
        return { turnId: 'turn-new-123', sequence: 6 };
      },
    });

    assert.ok(sendCalled);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-new-123');

    const phases = mockContext.ledger.map(e => e.phase);
    assert.deepStrictEqual(phases, [PHASES.OBSERVED, PHASES.PREPARED, PHASES.REQUEST_STARTED, PHASES.CONFIRMED]);
  });

  it('should use fixed continuation renderer only', () => {
    const template = buildContinuationTemplate({
      goalInstance: 'goal-1',
      goalVersion: 'v1',
      actionSlotId: 'slot-abc',
      continuationId: 'cont-abc',
      snapshotHash: 'a'.repeat(64),
      expectedParentSequence: 5,
      expectedInputWatermark: 2,
      decisionCode: 'action-start',
      runPath: '/run/path',
      eventRefs: ['evt-1', 'evt-2'],
    });

    assert.ok(template.includes('COHUB_GOAL_CONTINUATION'));
    assert.ok(template.includes('goalInstance: goal-1'));
    assert.ok(template.includes('actionSlot: slot-abc'));
    assert.ok(template.includes('continuationId: cont-abc'));
    assert.ok(template.includes('decisionCode: action-start'));
    assert.ok(template.includes('registeredEventRefs: ["evt-1","evt-2"]'));
  });

  it('should validate response schema before CONFIRMED', async () => {
    const mockContext = makeMockContext();

    await assert.rejects(
      submitAction({
        ctx: mockContext,
        goalInstance: 'test-goal',
        expectedSnapshotHash: 'a'.repeat(64),
        actionSlotId: 'slot-123',
        continuationId: 'cont-123',
        decisionCode: 'action-start',
        evidenceRefs: [],
        currentSnapshot: {
          snapshotHash: 'a'.repeat(64),
          actionSlot: {
            actionSlotId: 'slot-123',
            continuationId: 'cont-123',
          },
        },
        freshInspect: async () => ({
          snapshotHash: 'a'.repeat(64),
          parentSequence: 5,
          inputWatermark: 2,
          unconsumedEvents: [],
        }),
        cohubSend: async () => {
          return { turnId: '', sequence: 'bad' };
        },
      }),
      /turnId|sequence/,
    );

    const phases = mockContext.ledger.map(e => e.phase);
    assert.ok(!phases.includes(PHASES.CONFIRMED));
  });

  it('should reconcile REQUEST_STARTED by clientMessageId', async () => {
    const mockContext = makeMockContext();
    mockContext.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    mockContext.parentTurns = [
      { turnId: 'turn-existing', clientMessageId: 'cont-123', sequence: 6 },
    ];

    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'a'.repeat(64),
        parentSequence: 5,
        inputWatermark: 2,
        unconsumedEvents: [],
      }),
      reconcileByClientMessageId: async (continuationId) => {
        const turn = mockContext.parentTurns.find(t => t.clientMessageId === continuationId);
        return turn ? { found: true, turnId: turn.turnId } : { found: false };
      },
      cohubSend: async () => {
        throw new Error('Should not send when already REQUEST_STARTED');
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-existing');
    assert.strictEqual(result.reconciled, true);
  });

  it('should block on AMBIGUOUS when cannot reconcile', async () => {
    const mockContext = makeMockContext();
    mockContext.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
    ];

    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
        },
      },
      freshInspect: async () => ({
        snapshotHash: 'a'.repeat(64),
        parentSequence: 5,
        inputWatermark: 2,
        unconsumedEvents: [],
      }),
      reconcileByClientMessageId: async () => ({ found: false }),
      cohubSend: async () => {
        throw new Error('Should not send when ambiguous');
      },
    });

    assert.strictEqual(result.error, 'BLOCKED_AMBIGUOUS_SEND');
    assert.ok(result.reason.includes('uncertain'));
  });

  it('should return alreadyConfirmed when slot already CONFIRMED', async () => {
    const mockContext = makeMockContext();
    mockContext.ledger = [
      { phase: PHASES.OBSERVED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.PREPARED, actionSlotId: 'slot-123', continuationId: 'cont-123', expectedSnapshotHash: 'a'.repeat(64), expectedParentSequence: 5, expectedInputWatermark: 2 },
      { phase: PHASES.REQUEST_STARTED, actionSlotId: 'slot-123', continuationId: 'cont-123' },
      { phase: PHASES.CONFIRMED, actionSlotId: 'slot-123', continuationId: 'cont-123', turnId: 'turn-already' },
    ];

    const result = await submitAction({
      ctx: mockContext,
      goalInstance: 'test-goal',
      expectedSnapshotHash: 'a'.repeat(64),
      actionSlotId: 'slot-123',
      continuationId: 'cont-123',
      decisionCode: 'action-start',
      evidenceRefs: [],
      currentSnapshot: {
        snapshotHash: 'a'.repeat(64),
        actionSlot: {
          actionSlotId: 'slot-123',
          continuationId: 'cont-123',
        },
      },
      cohubSend: async () => {
        throw new Error('Should not send when already CONFIRMED');
      },
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.turnId, 'turn-already');
    assert.strictEqual(result.alreadyConfirmed, true);
  });
});
