/**
 * Repair tests for commit 810a870 independent rejection findings.
 * These tests MUST fail on current commit, then pass after repair.
 *
 * Findings:
 * - CRITICAL: Secret heuristic false-positives reject checkpointId, authorityMode, tokenBudget
 * - HIGH: Missing JSON Schema type validation allows type confusion
 * - MEDIUM: CLI resume restricted to WAITING_COHUB only, spec requires multi-state
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/cohub-claude-goal/server.js';

describe('CRITICAL: Secret heuristic must not reject legitimate fields', () => {
  it('inspect returns checkpointId without INTERNAL_ERROR', async () => {
    const inspectStub = async () => ({
      goalInstance: 'test-goal',
      snapshotHash: '0'.repeat(64),
      localState: 'READY',
      checkpointId: 'ckpt_abc123',  // Legitimate field, not a secret
      actionSlot: {
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        expectedParentSequence: 1,
        expectedInputWatermark: 0
      },
      allowedDecisions: ['action-start']
    });

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test-goal' }
      }
    });

    assert.ok(!result.isError, `Expected success, got error: ${JSON.stringify(result)}`);
    assert.ok(result.content?.[0]?.text, 'Expected text response');
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.checkpointId, 'ckpt_abc123', 'checkpointId must be preserved');
  });

  it('inspect returns authorityMode without INTERNAL_ERROR', async () => {
    const inspectStub = async () => ({
      goalInstance: 'test-goal',
      snapshotHash: '0'.repeat(64),
      localState: 'READY',
      continuationAuthority: 'external_event_bridge',  // Legitimate field
      authorityMode: 'supervisor',  // Legitimate field
      actionSlot: {
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        expectedParentSequence: 1,
        expectedInputWatermark: 0
      },
      allowedDecisions: ['action-start']
    });

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test-goal' }
      }
    });

    assert.ok(!result.isError, `Expected success, got error: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.continuationAuthority, 'external_event_bridge');
    assert.equal(parsed.authorityMode, 'supervisor');
  });

  it('inspect returns tokenBudget without INTERNAL_ERROR', async () => {
    const inspectStub = async () => ({
      goalInstance: 'test-goal',
      snapshotHash: '0'.repeat(64),
      localState: 'READY',
      tokenBudget: { total: 500000, spent: 12000, remaining: 488000 },  // Legitimate field
      actionSlot: {
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        expectedParentSequence: 1,
        expectedInputWatermark: 0
      },
      allowedDecisions: ['action-start']
    });

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test-goal' }
      }
    });

    assert.ok(!result.isError, `Expected success, got error: ${JSON.stringify(result)}`);
    const parsed = JSON.parse(result.content[0].text);
    assert.deepEqual(parsed.tokenBudget, { total: 500000, spent: 12000, remaining: 488000 });
  });

  it('inspect returns keylessHash without INTERNAL_ERROR', async () => {
    const inspectStub = async () => ({
      goalInstance: 'test-goal',
      snapshotHash: '0'.repeat(64),
      localState: 'READY',
      keylessHash: 'abc123def456',  // Legitimate field (not API key)
      actionSlot: {
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        expectedParentSequence: 1,
        expectedInputWatermark: 0
      },
      allowedDecisions: ['action-start']
    });

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test-goal' }
      }
    });

    assert.ok(!result.isError);
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.keylessHash, 'abc123def456');
  });

  it('MUST reject actual secret fields: accessToken', async () => {
    const inspectStub = async () => ({
      goalInstance: 'test-goal',
      snapshotHash: '0'.repeat(64),
      localState: 'READY',
      accessToken: 'secret-token-12345',  // Real secret
      actionSlot: {
        actionSlotId: 'slot-1',
        continuationId: 'cont-1',
        expectedParentSequence: 1,
        expectedInputWatermark: 0
      },
      allowedDecisions: ['action-start']
    });

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test-goal' }
      }
    });

    assert.ok(result.isError, 'accessToken must cause INTERNAL_ERROR');
    assert.match(result.content[0].text, /internal/i);
  });

  it('MUST reject actual secret fields: refreshToken', async () => {
    const inspectStub = async () => ({
      goalInstance: 'test-goal',
      refreshToken: 'refresh-secret',  // Real secret
      snapshotHash: '0'.repeat(64),
      localState: 'READY',
      actionSlot: { actionSlotId: 'slot-1', continuationId: 'cont-1', expectedParentSequence: 1, expectedInputWatermark: 0 },
      allowedDecisions: ['action-start']
    });

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 'test-goal' }
      }
    });

    assert.ok(result.isError, 'refreshToken must cause INTERNAL_ERROR');
    assert.match(result.content[0].text, /internal/i);
  });
});

describe('HIGH: JSON Schema type validation before calling dependencies', () => {
  it('rejects goalInstance with number type', async () => {
    const inspectStub = async (args) => {
      // If this is reached, type validation failed
      throw new Error(`inspect received type ${typeof args.goalInstance}, expected string`);
    };

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: 123 }  // number instead of string
      }
    });

    assert.ok(result.isError, 'number goalInstance must be rejected before calling inspect');
    assert.match(result.content[0].text, /type|string|invalid/i, 'Error should mention type mismatch');
  });

  it('rejects goalInstance with object type', async () => {
    const inspectStub = async (args) => {
      throw new Error(`inspect received type ${typeof args.goalInstance}, expected string`);
    };

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: { evil: 'object' } }  // object instead of string
      }
    });

    assert.ok(result.isError, 'object goalInstance must be rejected before calling inspect');
  });

  it('rejects expectedSnapshotHash not matching hash pattern', async () => {
    const waitStub = async (args) => {
      throw new Error('wait should not be called with invalid hash');
    };

    const server = createServer({
      inspect: async () => ({}),
      submit: async () => ({}),
      wait: waitStub,
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_wait',
        arguments: {
          goalInstance: 'test-goal',
          expectedSnapshotHash: 'not-a-valid-hash',  // doesn't match ^[0-9a-f]{64}$
          watchSet: [{ role: 'parent', spaceId: 'space-1', sessionId: 'sess-1', turnId: 'turn-1' }]
        }
      }
    });

    assert.ok(result.isError, 'invalid hash pattern must be rejected');
  });

  it('rejects decisionCode not in exact allowlist', async () => {
    const submitStub = async (args) => {
      throw new Error('submit should not be called with invalid decision');
    };

    const server = createServer({
      inspect: async () => ({}),
      submit: submitStub,
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: ['test-goal'],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_submit',
        arguments: {
          goalInstance: 'test-goal',
          expectedSnapshotHash: '0'.repeat(64),
          actionSlotId: 'slot-1',
          continuationId: 'cont-1',
          decisionCode: 'CONTINUE',  // Not in allowlist
          evidenceRefs: []
        }
      }
    });

    assert.ok(result.isError, 'CONTINUE not in allowlist, must be rejected');
  });

  it('accepts exact allowlist decision codes from action-slot.js', async () => {
    const validDecisions = [
      'action-start',
      'worker-dispatch',
      'user-gate-response',
      'block-report',
      'external-wait-register'
    ];

    for (const decision of validDecisions) {
      const submitStub = async (args) => ({
        parentSessionId: 'sess-1',
        parentTurnId: 'turn-1',
        continuationId: args.continuationId
      });

      const server = createServer({
        inspect: async () => ({}),
        submit: submitStub,
        wait: async () => ({}),
        verify: async () => ({})
      }, {
        allowedGoals: ['test-goal'],
        allowedSpaces: ['space-1']
      });

      const result = await server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'cohub_goal_submit',
          arguments: {
            goalInstance: 'test-goal',
            expectedSnapshotHash: '0'.repeat(64),
            actionSlotId: 'slot-1',
            continuationId: 'cont-1',
            decisionCode: decision,
            evidenceRefs: []
          }
        }
      });

      assert.ok(!result.isError, `${decision} from action-slot.js allowlist must be accepted, got: ${JSON.stringify(result)}`);
    }
  });

  it('rejects minLength violation on goalInstance', async () => {
    const inspectStub = async () => {
      throw new Error('inspect should not be called with empty goalInstance');
    };

    const server = createServer({
      inspect: inspectStub,
      submit: async () => ({}),
      wait: async () => ({}),
      verify: async () => ({})
    }, {
      allowedGoals: [''],
      allowedSpaces: ['space-1']
    });

    const result = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'cohub_goal_inspect',
        arguments: { goalInstance: '' }  // violates minLength: 1
      }
    });

    assert.ok(result.isError, 'empty goalInstance must be rejected');
  });
});

describe('MEDIUM: CLI resume legal states per spec lines 364-365', () => {
  // Note: CLI tests require the actual CLI module with state validation
  // These are contract tests documenting the expected behavior

  it('CLI LEGAL_TRANSITIONS.resume must include WAITING_COHUB', async () => {
    const { LEGAL_TRANSITIONS } = await import('../../src/cohub-claude-goal/cli.js');
    assert.ok(LEGAL_TRANSITIONS.resume.has('WAITING_COHUB'),
      'resume must allow WAITING_COHUB per spec line 364');
  });

  it('CLI LEGAL_TRANSITIONS.resume must include PAUSED_USER', async () => {
    const { LEGAL_TRANSITIONS } = await import('../../src/cohub-claude-goal/cli.js');
    assert.ok(LEGAL_TRANSITIONS.resume.has('PAUSED_USER'),
      'resume must allow PAUSED_USER per spec lines 364-365');
  });

  it('CLI LEGAL_TRANSITIONS.resume must include BLOCKED', async () => {
    const { LEGAL_TRANSITIONS } = await import('../../src/cohub-claude-goal/cli.js');
    assert.ok(LEGAL_TRANSITIONS.resume.has('BLOCKED'),
      'resume must allow BLOCKED per spec lines 364-365');
  });

  it('CLI LEGAL_TRANSITIONS.resume must include interrupted RUNNING_CLAUDE', async () => {
    const { LEGAL_TRANSITIONS } = await import('../../src/cohub-claude-goal/cli.js');
    assert.ok(LEGAL_TRANSITIONS.resume.has('RUNNING_CLAUDE'),
      'resume must allow interrupted RUNNING_CLAUDE per spec lines 364-365');
  });

  it('CLI LEGAL_TRANSITIONS.resume must NOT include DONE', async () => {
    const { LEGAL_TRANSITIONS } = await import('../../src/cohub-claude-goal/cli.js');
    assert.ok(!LEGAL_TRANSITIONS.resume.has('DONE'),
      'resume must NOT allow DONE (terminal state)');
  });

  it('CLI LEGAL_TRANSITIONS.resume must NOT include INTEGRITY_FAILURE', async () => {
    const { LEGAL_TRANSITIONS } = await import('../../src/cohub-claude-goal/cli.js');
    assert.ok(!LEGAL_TRANSITIONS.resume.has('INTEGRITY_FAILURE'),
      'resume must NOT allow INTEGRITY_FAILURE (terminal state)');
  });
});
