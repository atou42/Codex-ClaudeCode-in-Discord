/**
 * Tests for verifier extractor
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { VerifierExtractor, Verdict } from '../../src/cohub-claude-goal/verifier-extractor.js';

describe('VerifierExtractor', { timeout: 5000 }, () => {
  it('should extract DONE verdict from ACHIEVED status', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        ok: true,
        status: 'ACHIEVED',
        macroGoalHash: 'abc123',
        budgetSpent: 7
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.DONE);
    assert.ok(Object.isFrozen(result), 'Result should be frozen');
  });

  it('should extract RUNNING verdict', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'RUNNING',
        requiredAction: 'wait',
        snapshotHash: 'xyz789'
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.RUNNING);
    assert.strictEqual(result.requiredAction, 'wait');
    assert.strictEqual(result.snapshotHash, 'xyz789');
  });

  it('should extract PAUSED_USER verdict', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'PAUSED_USER',
        reason: 'User gate required'
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.PAUSED_USER);
  });

  it('should extract BLOCKED verdict', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'BLOCKED',
        reason: 'Budget exceeded'
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.BLOCKED);
  });

  it('should reject error tool results', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: 'Error: something went wrong',
      isError: true
    };

    assert.throws(() => {
      extractor.extract(toolResult);
    }, (err) => {
      return err.code === 'VERIFY_MISSING';
    });
  });

  it('should reject missing contentText', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      isError: false
    };

    assert.throws(() => {
      extractor.extract(toolResult);
    }, (err) => {
      return err.code === 'VERIFY_MISSING';
    });
  });

  it('should reject malformed JSON in contentText', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: '{invalid json}',
      isError: false
    };

    assert.throws(() => {
      extractor.extract(toolResult);
    }, (err) => {
      return err.code === 'STREAM_MALFORMED';
    });
  });

  it('should reject unknown status', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'UNKNOWN_STATUS'
      }),
      isError: false
    };

    assert.throws(() => {
      extractor.extract(toolResult);
    }, (err) => {
      return err.code === 'VERIFY_MISSING';
    });
  });

  it('should extract evidence refs if present', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'ACHIEVED',
        evidenceRefs: ['evidence/screenshot.png', 'evidence/report.json']
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.DONE);
    assert.deepStrictEqual(result.evidenceRefs, ['evidence/screenshot.png', 'evidence/report.json']);
  });

  it('should identify settled verdicts', () => {
    const extractor = new VerifierExtractor();
    assert.strictEqual(extractor.isSettled(Verdict.DONE), true);
    assert.strictEqual(extractor.isSettled(Verdict.PAUSED_USER), true);
    assert.strictEqual(extractor.isSettled(Verdict.BLOCKED), true);
    assert.strictEqual(extractor.isSettled(Verdict.RUNNING), false);
  });

  it('should identify terminal verdicts', () => {
    const extractor = new VerifierExtractor();
    assert.strictEqual(extractor.isTerminal(Verdict.DONE), true);
    assert.strictEqual(extractor.isTerminal(Verdict.PAUSED_USER), false);
    assert.strictEqual(extractor.isTerminal(Verdict.BLOCKED), false);
    assert.strictEqual(extractor.isTerminal(Verdict.RUNNING), false);
  });

  it('should preserve raw result', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'ACHIEVED',
        custom: 'field',
        nested: { data: 'value' }
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.deepStrictEqual(result.rawResult, {
      status: 'ACHIEVED',
      custom: 'field',
      nested: { data: 'value' }
    });
    assert.ok(Object.isFrozen(result.rawResult), 'Raw result should be frozen');
  });

  it('should handle requiredAction for RUNNING verdict', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'RUNNING',
        requiredAction: 'submit'
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.RUNNING);
    assert.strictEqual(result.requiredAction, 'submit');
  });

  it('should set requiredAction to null if not present', () => {
    const extractor = new VerifierExtractor();
    const toolResult = {
      toolUseId: 'toolu_123',
      contentText: JSON.stringify({
        status: 'RUNNING'
      }),
      isError: false
    };

    const result = extractor.extract(toolResult);

    assert.strictEqual(result.verdict, Verdict.RUNNING);
    assert.strictEqual(result.requiredAction, null);
  });
});
