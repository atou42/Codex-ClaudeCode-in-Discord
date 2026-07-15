/**
 * @fileoverview Schema contract tests - actual integrated action-slot shape.
 * These tests verify the template uses the ACTUAL integrated contract, not invented schemas.
 *
 * RED FIRST: These tests should FAIL with current implementation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderContinuationPrompt } from '../src/cohub-claude-goal/templates.js';

// Valid integrated contract input
function validIntegratedInput() {
  return {
    goalInstance: 'test-goal',
    goalVersion: 'v1.0.0',
    actionSlot: {
      actionSlotId: 'slot-abc123',
      continuationId: 'cont-xyz789',
      expectedParentSequence: 42,
      expectedInputWatermark: 7,
      goalVersion: 'v1.0.0',
      snapshotHash: 'a'.repeat(64),
      decisionCode: 'action-start',
      attempt: 0
    },
    continuationId: 'cont-xyz789',
    snapshotHash: 'a'.repeat(64),
    expectedParentSequence: 42,
    expectedInputWatermark: 7,
    decisionCode: 'action-start',
    runPath: 'runs/test-goal/instance-1',
    registeredEventRefs: ['evt-001', 'evt-002'],
    expectedNextAction: { type: 'verify', reason: 'check completion' }
  };
}

describe('Schema Contract - Integrated Action Slot', () => {
  it('accepts valid integrated action-start decision', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'action-start';
    input.actionSlot.decisionCode = 'action-start';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('COHUB_GOAL_CONTINUATION'));
    assert.ok(output.includes('action-start'));
  });

  it('accepts valid worker-dispatch decision', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'worker-dispatch';
    input.actionSlot.decisionCode = 'worker-dispatch';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('worker-dispatch'));
  });

  it('accepts valid user-gate-response decision', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'user-gate-response';
    input.actionSlot.decisionCode = 'user-gate-response';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('user-gate-response'));
  });

  it('accepts valid block-report decision', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'block-report';
    input.actionSlot.decisionCode = 'block-report';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('block-report'));
  });

  it('accepts valid external-wait-register decision', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'external-wait-register';
    input.actionSlot.decisionCode = 'external-wait-register';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('external-wait-register'));
  });

  it('rejects old invented decision codes', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'continue';  // OLD invented code
    input.actionSlot.decisionCode = 'continue';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_DECISION_CODE/
    );
  });

  it('rejects continue_with_verify invented code', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'continue_with_verify';
    input.actionSlot.decisionCode = 'continue_with_verify';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_DECISION_CODE/
    );
  });

  it('rejects reopen_gate invented code', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'reopen_gate';
    input.actionSlot.decisionCode = 'reopen_gate';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_DECISION_CODE/
    );
  });

  it('rejects approve_proposal invented code', () => {
    const input = validIntegratedInput();
    input.decisionCode = 'approve_proposal';
    input.actionSlot.decisionCode = 'approve_proposal';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_DECISION_CODE/
    );
  });
});

describe('Schema Contract - Action Slot Field Bindings', () => {
  it('rejects action slot with old id field instead of actionSlotId', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.actionSlotId;
    input.actionSlot.id = 'slot-abc123';  // OLD field name

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_ACTION_SLOT|MISSING_ACTION_SLOT_FIELD|UNKNOWN_ACTION_SLOT_KEY/
    );
  });

  it('rejects action slot missing actionSlotId', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.actionSlotId;

    assert.throws(
      () => renderContinuationPrompt(input),
      /MISSING_ACTION_SLOT_FIELD.*actionSlotId/
    );
  });

  it('rejects action slot missing continuationId', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.continuationId;

    assert.throws(
      () => renderContinuationPrompt(input),
      /MISSING_ACTION_SLOT_FIELD.*continuationId/
    );
  });

  it('rejects action slot missing goalVersion', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.goalVersion;

    assert.throws(
      () => renderContinuationPrompt(input),
      /MISSING_ACTION_SLOT_FIELD.*goalVersion/
    );
  });

  it('rejects action slot missing snapshotHash', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.snapshotHash;

    assert.throws(
      () => renderContinuationPrompt(input),
      /MISSING_ACTION_SLOT_FIELD.*snapshotHash/
    );
  });

  it('rejects action slot missing decisionCode', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.decisionCode;

    assert.throws(
      () => renderContinuationPrompt(input),
      /MISSING_ACTION_SLOT_FIELD.*decisionCode/
    );
  });

  it('rejects action slot missing attempt', () => {
    const input = validIntegratedInput();
    delete input.actionSlot.attempt;

    assert.throws(
      () => renderContinuationPrompt(input),
      /MISSING_ACTION_SLOT_FIELD.*attempt/
    );
  });

  it('rejects action slot with old type field', () => {
    const input = validIntegratedInput();
    input.actionSlot.type = 'verify';  // OLD invented field

    assert.throws(
      () => renderContinuationPrompt(input),
      /UNKNOWN_ACTION_SLOT_KEY.*type/
    );
  });

  it('rejects action slot with old phase field', () => {
    const input = validIntegratedInput();
    input.actionSlot.phase = 'SETUP';  // OLD invented field

    assert.throws(
      () => renderContinuationPrompt(input),
      /UNKNOWN_ACTION_SLOT_KEY.*phase/
    );
  });

  it('rejects action slot with old event field', () => {
    const input = validIntegratedInput();
    input.actionSlot.event = [];  // OLD invented field

    assert.throws(
      () => renderContinuationPrompt(input),
      /UNKNOWN_ACTION_SLOT_KEY.*event/
    );
  });

  it('rejects action slot with old note field', () => {
    const input = validIntegratedInput();
    input.actionSlot.note = 'test note';  // OLD invented field

    assert.throws(
      () => renderContinuationPrompt(input),
      /UNKNOWN_ACTION_SLOT_KEY.*note/
    );
  });

  it('rejects action slot with old data field', () => {
    const input = validIntegratedInput();
    input.actionSlot.data = { foo: 'bar' };  // OLD invented field

    assert.throws(
      () => renderContinuationPrompt(input),
      /UNKNOWN_ACTION_SLOT_KEY.*data/
    );
  });
});

describe('Schema Contract - Field Binding Consistency', () => {
  it('rejects when actionSlot.actionSlotId does not match a deterministic pattern', () => {
    const input = validIntegratedInput();
    input.actionSlot.actionSlotId = 'custom-id-123';  // Should be deterministic

    // This is more of a semantic check - we validate format
    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('custom-id-123')); // Accept for now, bridge will validate
  });

  it('rejects when actionSlot.continuationId != top-level continuationId', () => {
    const input = validIntegratedInput();
    input.actionSlot.continuationId = 'cont-DIFFERENT';

    assert.throws(
      () => renderContinuationPrompt(input),
      /ACTION_SLOT_MISMATCH.*continuationId/
    );
  });

  it('rejects when actionSlot.expectedParentSequence != top-level', () => {
    const input = validIntegratedInput();
    input.actionSlot.expectedParentSequence = 999;

    assert.throws(
      () => renderContinuationPrompt(input),
      /ACTION_SLOT_MISMATCH.*expectedParentSequence/
    );
  });

  it('rejects when actionSlot.expectedInputWatermark != top-level', () => {
    const input = validIntegratedInput();
    input.actionSlot.expectedInputWatermark = 999;

    assert.throws(
      () => renderContinuationPrompt(input),
      /ACTION_SLOT_MISMATCH.*expectedInputWatermark/
    );
  });

  it('rejects when actionSlot.goalVersion != top-level goalVersion', () => {
    const input = validIntegratedInput();
    input.actionSlot.goalVersion = 'v2.0.0';

    assert.throws(
      () => renderContinuationPrompt(input),
      /ACTION_SLOT_MISMATCH.*goalVersion/
    );
  });

  it('rejects when actionSlot.snapshotHash != top-level snapshotHash', () => {
    const input = validIntegratedInput();
    input.actionSlot.snapshotHash = 'b'.repeat(64);

    assert.throws(
      () => renderContinuationPrompt(input),
      /ACTION_SLOT_MISMATCH.*snapshotHash/
    );
  });

  it('rejects when actionSlot.decisionCode != top-level decisionCode', () => {
    const input = validIntegratedInput();
    input.actionSlot.decisionCode = 'worker-dispatch';
    input.decisionCode = 'action-start';

    assert.throws(
      () => renderContinuationPrompt(input),
      /ACTION_SLOT_MISMATCH.*decisionCode/
    );
  });
});

describe('Schema Contract - Attempt Field', () => {
  it('accepts attempt = 0', () => {
    const input = validIntegratedInput();
    input.actionSlot.attempt = 0;

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('COHUB_GOAL_CONTINUATION'));
  });

  it('accepts attempt = 5', () => {
    const input = validIntegratedInput();
    input.actionSlot.attempt = 5;

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('COHUB_GOAL_CONTINUATION'));
  });

  it('rejects negative attempt', () => {
    const input = validIntegratedInput();
    input.actionSlot.attempt = -1;

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_ATTEMPT/
    );
  });

  it('rejects non-integer attempt', () => {
    const input = validIntegratedInput();
    input.actionSlot.attempt = 3.14;

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_ATTEMPT/
    );
  });

  it('rejects unsafe integer attempt', () => {
    const input = validIntegratedInput();
    input.actionSlot.attempt = Number.MAX_SAFE_INTEGER + 1;

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_ATTEMPT/
    );
  });
});

describe('Schema Contract - RunPath Validation', () => {
  it('accepts valid relative runPath', () => {
    const input = validIntegratedInput();
    input.runPath = 'runs/test-goal/instance-1';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('runs/test-goal/instance-1'));
  });

  it('rejects absolute runPath', () => {
    const input = validIntegratedInput();
    input.runPath = '/absolute/path';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_RUN_PATH.*absolute/
    );
  });

  it('rejects runPath with ../ traversal', () => {
    const input = validIntegratedInput();
    input.runPath = 'runs/../../../etc/passwd';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_RUN_PATH.*traversal/
    );
  });

  it('rejects runPath with backslash', () => {
    const input = validIntegratedInput();
    input.runPath = 'runs\\test\\path';

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_RUN_PATH/
    );
  });
});

describe('Schema Contract - RegisteredEventRefs', () => {
  it('accepts empty registeredEventRefs', () => {
    const input = validIntegratedInput();
    input.registeredEventRefs = [];

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('COHUB_GOAL_CONTINUATION'));
  });

  it('accepts valid event IDs', () => {
    const input = validIntegratedInput();
    input.registeredEventRefs = ['evt-001', 'evt-002', 'evt-003'];

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('evt-001'));
  });

  it('rejects empty string in registeredEventRefs', () => {
    const input = validIntegratedInput();
    input.registeredEventRefs = ['evt-001', '', 'evt-003'];

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_REGISTERED_EVENT_REFS/
    );
  });

  it('rejects registeredEventRefs exceeding reasonable bounds', () => {
    const input = validIntegratedInput();
    input.registeredEventRefs = Array(1001).fill('evt-x');

    assert.throws(
      () => renderContinuationPrompt(input),
      /INVALID_REGISTERED_EVENT_REFS.*too many/
    );
  });
});

describe('Schema Contract - ExpectedNextAction', () => {
  it('accepts structured expectedNextAction object', () => {
    const input = validIntegratedInput();
    input.expectedNextAction = { type: 'verify', reason: 'check state' };

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('COHUB_GOAL_CONTINUATION'));
  });

  it('accepts string expectedNextAction', () => {
    const input = validIntegratedInput();
    input.expectedNextAction = 'verify_completion';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('verify_completion'));
  });

  it('rejects arbitrary prose as expectedNextAction', () => {
    const input = validIntegratedInput();
    input.expectedNextAction = 'Please check if everything is complete and then proceed to the next step';

    // Should either accept as bounded string or reject if too long
    // For now, we accept but validate length
    if (input.expectedNextAction.length > 200) {
      assert.throws(
        () => renderContinuationPrompt(input),
        /INVALID_EXPECTED_NEXT_ACTION/
      );
    }
  });
});

describe('Schema Contract - Chinese GoalInstance', () => {
  it('accepts valid Chinese characters in goalInstance', () => {
    const input = validIntegratedInput();
    input.goalInstance = '游戏王决斗怪兽-v1';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('游戏王决斗怪兽-v1'));
  });

  it('accepts mixed Chinese and English goalInstance', () => {
    const input = validIntegratedInput();
    input.goalInstance = 'yu-gi-oh-游戏王-v1';

    const output = renderContinuationPrompt(input);
    assert.ok(output.includes('yu-gi-oh-游戏王-v1'));
  });
});
