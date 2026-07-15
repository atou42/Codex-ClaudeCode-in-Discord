/**
 * Red tests for confirmed defects from acceptance rejection
 *
 * Each test documents a specific defect and will fail until repaired.
 * Tests must be deterministic with no network/production access.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

describe('cohub-claude-goal confirmed defects', { timeout: 5000 }, () => {
  let Launcher, State, Verdict;
  let launcher;
  let mockGoalDir;

  beforeEach(async () => {
    const module = await import('../src/cohub-claude-goal/launcher.js');
    Launcher = module.Launcher;
    State = module.State;
    Verdict = module.Verdict;

    mockGoalDir = path.join(tmpdir(), 'test-defects-' + Math.random().toString(36).slice(2));
    await mkdir(mockGoalDir, { recursive: true });

    const goalConfig = {
      schemaVersion: 1,
      goalInstance: 'test-goal-v1',
      goalVersion: 1,
      mode: 'supervisor',
      spaceId: 'test-space-id',
      parentSessionId: 'test-parent-session',
      historicalParentSessionIds: [],
      runPath: 'test/run/path',
      statePath: 'test/run/path/state.json',
      gateLogPath: 'test/run/path/gate.json',
      manifestPath: 'test/run/path/manifest.json',
      legalHumanGates: [],
      consumedHumanGates: [],
      continuationAuthority: 'external_event_bridge',
      claudeCodeVersion: '2.1.201',
      cohubCliVersion: '2.3.2',
      cohubSdkVersion: '2.11.1'
    };

    await writeFile(
      path.join(mockGoalDir, 'goal.json'),
      JSON.stringify(goalConfig, null, 2)
    );
  });

  afterEach(async () => {
    if (launcher?.childProcess && !launcher.childProcess.killed) {
      launcher.childProcess.kill('SIGKILL');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (mockGoalDir) {
      // Give time for file handles to close
      await new Promise(resolve => setTimeout(resolve, 100));
      await rm(mockGoalDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('DEFECT: _getLastCondition always returns null', () => {
    it('should persist and retrieve last settled condition', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'PAUSED_USER' } });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();

      // First run settles with PAUSED_USER
      await launcher.start();

      // The condition should be persisted
      const launcher2 = new Launcher({ goalDir: mockGoalDir });
      await launcher2._loadState();

      const lastCondition = launcher2._getLastCondition();
      assert.ok(lastCondition !== null, 'lastCondition should not be null after settle');
      assert.ok(typeof lastCondition === 'string', 'lastCondition should be a string');
      assert.ok(lastCondition.includes('goalInstance=test-goal-v1'), 'Should contain goal instance');
    });

    it('should reject restart with unchanged condition', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'PAUSED_USER' } });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();
      await launcher.start();

      // Wait for state to settle
      await new Promise(resolve => setTimeout(resolve, 50));

      // Should have settled to PAUSED_USER
      assert.strictEqual(launcher.state, State.PAUSED_USER);

      const lastCondition = launcher._getLastCondition();
      assert.ok(lastCondition, 'Should have last condition');

      // Create a fresh launcher to test restart
      const launcher2 = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'DONE' } });
          inst._handleProcessExit(0, null);
        }
      });

      await assert.rejects(
        async () => await launcher2.restartSettled({ condition: lastCondition }),
        /unchanged condition/,
        'Should reject unchanged condition'
      );
    });
  });

  describe('DEFECT: cumulative token/seconds budget is TODO', () => {
    it('should track cumulative turns across restarts', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          // Simulate usage events
          inst._processStreamEvent({
            type: 'usage',
            tokens: { input: 1000, output: 500 },
            turns: 1,
            seconds: 10
          });
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'PAUSED_USER' } });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();
      await launcher.start();

      assert.strictEqual(launcher.cumulativeBudget.turns, 1, 'Should track turns');
      assert.strictEqual(launcher.cumulativeBudget.tokens, 1500, 'Should track tokens');
      assert.strictEqual(launcher.cumulativeBudget.seconds, 10, 'Should track seconds');

      // Resume should preserve cumulative budget
      launcher.state = State.WAITING_COHUB;
      launcher.lastVerdict = Verdict.RUNNING;
      await launcher._updateState();

      const launcher2 = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({
            type: 'usage',
            tokens: { input: 500, output: 300 },
            turns: 1,
            seconds: 5
          });
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'DONE' } });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher2.resume();

      assert.strictEqual(launcher2.cumulativeBudget.turns, 2, 'Should accumulate turns');
      assert.strictEqual(launcher2.cumulativeBudget.tokens, 2300, 'Should accumulate tokens');
      assert.strictEqual(launcher2.cumulativeBudget.seconds, 15, 'Should accumulate seconds');
    });

    it('should block when budget exceeded', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          // Simulate exceeding budget
          inst._processStreamEvent({
            type: 'usage',
            tokens: { input: 50000, output: 50000 },
            turns: 1,
            seconds: 100
          });
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();

      // Set a low budget limit
      launcher.budgetLimits = { tokens: 10000, turns: 10, seconds: 60 };

      await launcher.start();

      // Should have blocked due to budget exceeded
      assert.strictEqual(launcher.state, State.BLOCKED, 'Should block on budget exceeded');
    });
  });

  describe('DEFECT: lastVerdict is not invocation-fresh', () => {
    it('should clear stale lastVerdict on new invocation', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();

      // Set a stale verdict from a previous run
      launcher.lastVerdict = Verdict.DONE;
      launcher.lastVerdictInvocationId = 'old-invocation';
      await launcher._updateState();

      // New invocation should not trust stale verdict
      const launcher2 = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          // No verify event in this invocation
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._handleProcessExit(0, null);
        }
      });

      launcher2.state = State.WAITING_COHUB;
      await launcher2._updateState();

      // Resume should fail - no fresh verify in current invocation
      await assert.rejects(
        async () => await launcher2.resume(),
        /no.*fresh.*verify/i,
        'Should reject resume with stale verdict'
      );
    });

    it('should bind verdict to current invocation ID', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'RUNNING' } });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();
      launcher.state = State.WAITING_COHUB;
      await launcher.start();

      // Verdict should have an invocation ID
      assert.ok(launcher.lastVerdictInvocationId, 'Should have invocation ID');
      assert.notStrictEqual(launcher.lastVerdictInvocationId, 'old-invocation');
    });
  });

  describe('DEFECT: malformed stream-json lines silently skipped', () => {
    it('should reject malformed JSON lines', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      const malformed = '{"type": "bootstrap", "truncated';

      // Should not throw, but should not update state
      launcher._handleStreamChunk(malformed + '\n');

      assert.strictEqual(launcher.bootstrapComplete, false, 'Should not process malformed JSON');
    });

    it('should validate event schema before processing', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      // Events with unexpected types
      const events = [
        { type: Symbol('bad') },
        { type: null },
        { tool: { nested: 'bad' } },
        { __proto__: { type: 'bootstrap' } }
      ];

      for (const event of events) {
        launcher._processStreamEvent(event);
        assert.strictEqual(launcher.bootstrapComplete, false, 'Should not process invalid schema');
      }
    });

    it('should bound stream buffer size', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      // Send a huge line without newline
      const hugeChunk = 'x'.repeat(10 * 1024 * 1024); // 10MB

      launcher._handleStreamChunk(hugeChunk);

      // Buffer should be bounded (streamValidator bounds to 1MB by default)
      assert.ok(launcher.streamBuffer.length <= 1024 * 1024, 'Buffer should be bounded to prevent DoS');
    });
  });

  describe('DEFECT: arbitrary stderr/raw errors logged risking token leakage', () => {
    it('should redact secrets from error logs', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      const logs = [];
      const originalConsoleError = console.error;
      console.error = (...args) => logs.push(args.join(' '));

      try {
        // Simulate stderr with sensitive data
        const sensitiveError = 'Auth failed: Bearer sk-ant-secret123456789';
        launcher._handleProcessExit(1, null);

        // Check no token in logs
        const allLogs = logs.join(' ');
        assert.ok(!allLogs.includes('sk-ant-'), 'Should not log API keys');
        assert.ok(!allLogs.includes('secret123'), 'Should not log secrets');
      } finally {
        console.error = originalConsoleError;
      }
    });
  });

  describe('DEFECT: condition/goalInstance validation not proven against Claude 2.1.201', () => {
    it('should validate argv against actual Claude 2.1.201 flags', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.goalConfig = { goalInstance: 'test', goalVersion: 1 };
      launcher.claudeSessionId = 'test-uuid';

      const argv = launcher._constructStartArgv();

      // Flags that exist in 2.1.201
      assert.ok(argv.includes('--session-id'), 'Should use --session-id');
      assert.ok(argv.includes('--output-format') || argv.includes('stream-json'), 'Should use correct output flag');
      assert.ok(argv.includes('--permission-mode') || argv.includes('dontAsk'), 'Should use correct permission flag');

      // Should NOT use flags that don't exist
      assert.ok(!argv.includes('--goal-mode'), 'Should not use nonexistent flags');
      assert.ok(!argv.includes('--cohub-bridge'), 'Should not use nonexistent flags');
    });
  });

  describe('DEFECT: DONE accepted without proving fresh verify snapshot', () => {
    it('should reject DONE without deterministic verifier evidence', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          // Claude says DONE but no verify tool call
          inst._processStreamEvent({ type: 'text', content: 'The workflow is DONE!' });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();
      await launcher.start();

      assert.notStrictEqual(launcher.state, State.DONE, 'Should not accept DONE from text');
    });

    it('should require verify tool result for DONE verdict', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          // Only accept DONE from verify tool
          inst._processStreamEvent({
            type: 'tool_call',
            tool: 'verify',
            result: { verdict: 'DONE', workflowStatus: 'COMPLETE', evidence: { complete: true } }
          });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();
      await launcher.start();

      assert.strictEqual(launcher.state, State.DONE, 'Should accept DONE from verify tool');
    });
  });

  describe('DEFECT: wait-refusal treats any action as progress', () => {
    it('should only reset wait refusal on actual wait call', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.RUNNING_CLAUDE;
      launcher.lastVerdict = Verdict.RUNNING;
      launcher.waitRefusalCount = 1;

      // Turn with inspect/submit but no wait - should NOT reset counter
      launcher.currentTurn = { actions: [{ tool: 'inspect' }, { tool: 'submit' }] };
      launcher._checkTurnProgress();

      assert.strictEqual(launcher.waitRefusalCount, 2, 'Should increment without wait call');
      assert.strictEqual(launcher.state, State.BLOCKED, 'Should block on second refusal');
    });

    it('should bind wait refusal to required action from verify', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.RUNNING_CLAUDE;

      // Verify says submit is allowed, not wait
      launcher.lastVerdict = Verdict.RUNNING;
      launcher.lastVerifyAction = 'submit';

      // Turn with submit - should NOT count as refusal
      launcher.currentTurn = { actions: [{ tool: 'submit' }] };
      launcher._checkTurnProgress();

      assert.strictEqual(launcher.waitRefusalCount, 0, 'Should not increment when submit was required');
    });
  });

  describe('DEFECT: start from NEW impossible after _loadState if state file absent', () => {
    it('should handle NEW state after _loadState with missing file', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      // _loadState with no file should leave state as NEW
      await launcher._loadState();
      assert.strictEqual(launcher.state, State.NEW);

      // start() should auto-init from NEW
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'DONE' } });
          inst._handleProcessExit(0, null);
        }
      });

      const result = await launcher.start();
      assert.ok(result, 'Should successfully start from NEW after _loadState');
    });
  });

  describe('DEFECT: getState returns mutable internal references', () => {
    it('should return deep frozen state', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();

      const state = await launcher.getState();

      // Should not be able to mutate returned state
      assert.throws(() => {
        state.cumulativeBudget.turns = 9999;
      }, /Cannot|read-only|frozen/i, 'Should return frozen budget');

      // Verify original not mutated
      const state2 = await launcher.getState();
      assert.notStrictEqual(state2.cumulativeBudget.turns, 9999);
    });
  });

  describe('DEFECT: signal listeners accumulate', () => {
    it('should remove signal listeners after process exit', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, inst) => {
          inst._processStreamEvent({ type: 'bootstrap' });
          inst._processStreamEvent({ tool: 'verify', result: { verdict: 'DONE' } });
          inst._handleProcessExit(0, null);
        }
      });

      await launcher.init();

      const beforeCount = process.listenerCount('SIGTERM');

      await launcher.start();

      const afterCount = process.listenerCount('SIGTERM');

      assert.strictEqual(afterCount, beforeCount, 'Should clean up signal listeners');
    });
  });

  describe('DEFECT: spawn failure handling not transactional', () => {
    it('should rollback RUNNING state on spawn failure', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        claudeCommand: '/nonexistent/claude' // Will fail to spawn
      });

      await launcher.init();

      try {
        await launcher.start();
        assert.fail('Should throw on spawn failure');
      } catch (err) {
        // State should rollback, not stay RUNNING_CLAUDE
        const launcher2 = new Launcher({ goalDir: mockGoalDir });
        await launcher2._loadState();
        assert.notStrictEqual(launcher2.state, State.RUNNING_CLAUDE, 'Should not leave RUNNING state on failure');
      }
    });
  });
});
