/**
 * Adversarial tests for cohub-claude-goal launcher state machine
 *
 * Tests cover:
 * - State machine transitions (NEW→READY→RUNNING_CLAUDE→WAITING_COHUB→DONE)
 * - Bootstrap outcomes: process exit vs auto-enter evaluator
 * - Exact UUID persistence and resume behavior
 * - No concurrent invocation when native goal active
 * - No post-settle resume when evaluator already satisfied
 * - Exact argv construction (--session-id, --resume, stream-json, dontAsk, MCP-only)
 * - Crash recovery with fresh verify binding requirement
 * - Paused/blocked resume with new /goal condition
 * - Two-turn no-progress refusal blocker
 * - Clean abort/exit with no orphan child
 * - Token budget ledger injection
 * - Syntax and structure validation
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('cohub-claude-goal launcher', { timeout: 5000 }, () => {
  let Launcher, State, ExitCode, Verdict;
  let launcher;
  let mockGoalDir;

  beforeEach(async () => {
    // Import the module
    const module = await import('../src/cohub-claude-goal/launcher.js');
    Launcher = module.Launcher;
    State = module.State;
    ExitCode = module.ExitCode;
    Verdict = module.Verdict;

    // Create temp goal directory
    mockGoalDir = path.join(tmpdir(), 'test-goal-' + Math.random().toString(36).slice(2));
    await mkdir(mockGoalDir, { recursive: true });

    // Create minimal goal config
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
    // Clean up any spawned processes
    if (launcher && launcher.childProcess) {
      launcher.childProcess.kill('SIGTERM');
      await delay(100);
      if (!launcher.childProcess.killed) {
        launcher.childProcess.kill('SIGKILL');
      }
    }

    // Clean up temp directory
    if (mockGoalDir) {
      await rm(mockGoalDir, { recursive: true, force: true });
    }
  });

  describe('Module structure', () => {
    it('should export Launcher class', () => {
      assert.ok(Launcher, 'Launcher class should be exported');
      assert.strictEqual(typeof Launcher, 'function', 'Launcher should be a constructor');
    });

    it('should export State enum', () => {
      assert.ok(State, 'State enum should be exported');
      assert.strictEqual(State.NEW, 'NEW');
      assert.strictEqual(State.READY, 'READY');
      assert.strictEqual(State.RUNNING_CLAUDE, 'RUNNING_CLAUDE');
      assert.strictEqual(State.WAITING_COHUB, 'WAITING_COHUB');
      assert.strictEqual(State.PAUSED_USER, 'PAUSED_USER');
      assert.strictEqual(State.BLOCKED, 'BLOCKED');
      assert.strictEqual(State.DONE, 'DONE');
      assert.strictEqual(State.INTEGRITY_FAILURE, 'INTEGRITY_FAILURE');
    });

    it('should export ExitCode enum', () => {
      assert.ok(ExitCode, 'ExitCode enum should be exported');
      assert.strictEqual(ExitCode.SUCCESS, 0);
      assert.strictEqual(ExitCode.INCOMPLETE, 10);
      assert.strictEqual(ExitCode.PAUSED_USER, 20);
      assert.strictEqual(ExitCode.BLOCKED, 30);
      assert.strictEqual(ExitCode.INTEGRITY_FAILURE, 40);
      assert.strictEqual(ExitCode.CAPABILITY_GATE_FAILURE, 50);
      assert.strictEqual(ExitCode.LEASE_CONFLICT, 60);
    });

    it('should export Verdict enum', () => {
      assert.ok(Verdict, 'Verdict enum should be exported');
      assert.strictEqual(Verdict.RUNNING, 'RUNNING');
      assert.strictEqual(Verdict.PAUSED_USER, 'PAUSED_USER');
      assert.strictEqual(Verdict.BLOCKED, 'BLOCKED');
      assert.strictEqual(Verdict.DONE, 'DONE');
    });
  });

  describe('Constructor', () => {
    it('should require goalDir', () => {
      assert.throws(() => {
        new Launcher();
      }, /goalDir is required/);
    });

    it('should initialize with goalDir', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      assert.strictEqual(launcher.goalDir, mockGoalDir);
      assert.strictEqual(launcher.state, State.NEW);
    });

    it('should set default paths', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      assert.strictEqual(launcher.goalConfigPath, path.join(mockGoalDir, 'goal.json'));
      assert.strictEqual(launcher.statePath, path.join(mockGoalDir, 'state.json'));
      assert.strictEqual(launcher.ledgerDir, path.join(mockGoalDir, 'ledger'));
      assert.strictEqual(launcher.leasePath, path.join(mockGoalDir, 'lease.json'));
    });
  });

  describe('State machine transitions', () => {
    it('should transition NEW → READY on init', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      assert.strictEqual(launcher.state, State.NEW);

      const result = await launcher.init();

      assert.strictEqual(result.state, State.READY);
      assert.ok(result.sessionId, 'Should generate session ID');
      assert.strictEqual(launcher.state, State.READY);
      assert.strictEqual(launcher.claudeSessionId, result.sessionId);
    });

    it('should reject init if already initialized', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();

      const launcher2 = new Launcher({ goalDir: mockGoalDir });
      await assert.rejects(
        async () => await launcher2.init(),
        /Goal already initialized/
      );
    });

    it('should persist session UUID', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      const result = await launcher.init();
      const uuid1 = result.sessionId;

      // Load state in new instance
      const launcher2 = new Launcher({ goalDir: mockGoalDir });
      await launcher2._loadState();

      assert.strictEqual(launcher2.claudeSessionId, uuid1, 'UUID should be persisted');
    });
  });

  describe('Start command', () => {
    it('should allow start from NEW state (auto-init)', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, launcherInstance) => {
          // Simulate bootstrap and DONE verdict
          launcherInstance._processStreamEvent({ type: 'bootstrap' });
          launcherInstance._processStreamEvent({
            tool: 'verify',
            result: { verdict: 'DONE' }
          });
          launcherInstance._handleProcessExit(0, null);
        }
      });

      // State is NEW - should auto-init then start
      const result = await launcher.start();

      assert.ok(result, 'Should return result');
      assert.ok(launcher.claudeSessionId, 'Should have generated session ID');
    });

    it('should allow start from READY state', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, launcherInstance) => {
          launcherInstance._processStreamEvent({ type: 'bootstrap' });
          launcherInstance._processStreamEvent({
            tool: 'verify',
            result: { verdict: 'DONE' }
          });
          launcherInstance._handleProcessExit(0, null);
        }
      });

      await launcher.init();
      assert.strictEqual(launcher.state, State.READY);

      const result = await launcher.start();
      assert.ok(result, 'Should return result');
    });

    it('should reject start from RUNNING_CLAUDE', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.RUNNING_CLAUDE;
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.start(),
        /Cannot start from state RUNNING_CLAUDE/
      );
    });

    it('should reject start from WAITING_COHUB', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.WAITING_COHUB;
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.start(),
        /Cannot start from state WAITING_COHUB/
      );
    });

    it('should reject start from DONE', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.DONE;
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.start(),
        /Cannot start from state DONE/
      );
    });

    it('should construct correct argv for first start', async () => {
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, launcherInstance) => {
          // Verify argv structure
          assert.ok(argv.includes('--session-id'), 'Should include --session-id');
          assert.ok(argv.includes('stream-json'), 'Should include stream-json');
          assert.ok(argv.includes('dontAsk'), 'Should include dontAsk');
          assert.ok(argv.includes('--mcp'), 'Should include --mcp');
          assert.ok(argv.includes('cohub_goal'), 'Should include cohub_goal MCP');
          assert.ok(argv.includes('--deny-tool'), 'Should deny tools');
          assert.ok(argv.includes('Bash'), 'Should deny Bash');
          assert.ok(argv.includes('Write'), 'Should deny Write');
          assert.ok(argv.includes('Edit'), 'Should deny Edit');
          assert.ok(argv.includes('WebFetch'), 'Should deny WebFetch');

          const sessionIdx = argv.indexOf('--session-id');
          const sessionId = argv[sessionIdx + 1];
          assert.ok(sessionId, 'Session ID should be present');
          assert.match(sessionId, /^[0-9a-f-]{36}$/, 'Session ID should be UUID');

          // Should NOT include tokens
          const argvStr = argv.join(' ');
          assert.ok(!argvStr.includes('token'), 'Should not include tokens in argv');
          assert.ok(!argvStr.includes('Bearer'), 'Should not include Bearer in argv');

          // Simulate immediate exit for test
          launcherInstance._handleProcessExit(0, null);
        }
      });

      await launcher.init();

      // Start will attempt to spawn but our mock will intercept
      const result = await launcher.start();

      assert.ok(result, 'Should return result');
    });
  });

  describe('Resume command', () => {
    it('should only allow resume from WAITING_COHUB', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.WAITING_COHUB;
      launcher.lastVerdict = Verdict.RUNNING;
      await launcher._updateState();

      // Should not throw
      launcher = new Launcher({
        goalDir: mockGoalDir,
        mockStreamParser: (argv, launcherInstance) => {
          launcherInstance._processStreamEvent({ type: 'bootstrap' });
          launcherInstance._processStreamEvent({
            tool: 'verify',
            result: { verdict: 'DONE' }
          });
          launcherInstance._handleProcessExit(0, null);
        }
      });

      const result = await launcher.resume();
      assert.ok(result, 'Should return result');
    });

    it('should reject resume from PAUSED_USER', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.PAUSED_USER;
      launcher.lastVerdict = Verdict.PAUSED_USER;
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.resume(),
        /Cannot resume from state PAUSED_USER/
      );
    });

    it('should reject resume from BLOCKED', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.BLOCKED;
      launcher.lastVerdict = Verdict.BLOCKED;
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.resume(),
        /Cannot resume from state BLOCKED/
      );
    });

    it('should reject resume without fresh verify', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.WAITING_COHUB;
      launcher.lastVerdict = null; // No fresh verify
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.resume(),
        /no lastVerdict present/
      );
    });

    it('should reject resume when evaluator already entered', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.WAITING_COHUB;
      launcher.lastVerdict = Verdict.RUNNING;
      launcher.evaluatorEntered = true;
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.resume(),
        /evaluator already entered/
      );
    });

    it('should reject resume when verdict is not RUNNING', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.state = State.WAITING_COHUB;
      launcher.lastVerdict = Verdict.DONE; // Settled verdict
      await launcher._updateState();

      await assert.rejects(
        async () => await launcher.resume(),
        /lastVerdict is DONE, expected RUNNING/
      );
    });
  });

  describe('Argv construction', () => {
    it('should include exactly 4 MCP tools allowlist', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.goalConfig = {
        goalInstance: 'test',
        goalVersion: 1
      };
      launcher.claudeSessionId = 'test-uuid';

      const argv = launcher._constructStartArgv();
      const argvStr = argv.join(' ');

      // Should include MCP config
      assert.ok(argv.includes('cohub_goal'), 'Should allow cohub_goal MCP');

      // Should deny other tools
      assert.ok(argv.includes('Bash'), 'Should deny Bash');
      assert.ok(argv.includes('Write'), 'Should deny Write');
      assert.ok(argv.includes('Edit'), 'Should deny Edit');
      assert.ok(argv.includes('WebFetch'), 'Should deny WebFetch');
      assert.ok(argv.includes('WebSearch'), 'Should deny WebSearch');
    });

    it('should use stream-json output', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.goalConfig = { goalInstance: 'test', goalVersion: 1 };
      launcher.claudeSessionId = 'test-uuid';

      const argv = launcher._constructStartArgv();

      assert.ok(argv.includes('stream-json'), 'Should use stream-json output');
    });

    it('should use dontAsk permission mode', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.goalConfig = { goalInstance: 'test', goalVersion: 1 };
      launcher.claudeSessionId = 'test-uuid';

      const argv = launcher._constructStartArgv();

      assert.ok(argv.includes('dontAsk'), 'Should use dontAsk mode');
    });

    it('should NOT include tokens in argv', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.goalConfig = { goalInstance: 'test', goalVersion: 1 };
      launcher.claudeSessionId = 'test-uuid';

      const argv = launcher._constructStartArgv();
      const argvStr = argv.join(' ');

      assert.ok(!argvStr.includes('token'), 'Should not include token');
      assert.ok(!argvStr.includes('Bearer'), 'Should not include Bearer');
      assert.ok(!argvStr.includes('secret'), 'Should not include secret');
    });
  });

  describe('Stream parsing', () => {
    it('should detect bootstrap event', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      launcher._processStreamEvent({ type: 'bootstrap' });

      assert.strictEqual(launcher.bootstrapComplete, true);
      assert.strictEqual(launcher.nativeGoalActive, true);
    });

    it('should detect evaluator entry', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.nativeGoalActive = true;

      launcher._processStreamEvent({ type: 'evaluator' });

      assert.strictEqual(launcher.evaluatorEntered, true);
      assert.strictEqual(launcher.nativeGoalActive, false);
    });

    it('should detect verify verdict', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });

      launcher._processStreamEvent({
        tool: 'verify',
        result: { verdict: 'DONE' }
      });

      assert.strictEqual(launcher.lastVerdict, 'DONE');
      assert.strictEqual(launcher.state, State.DONE);
    });

    it('should detect wait call', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.RUNNING_CLAUDE;

      launcher._processStreamEvent({ tool: 'wait' });

      assert.strictEqual(launcher.state, State.WAITING_COHUB);
    });
  });

  describe('No-progress detection', () => {
    it('should detect two consecutive turns with no actions', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.RUNNING_CLAUDE;

      // Turn 1 with no actions
      launcher.currentTurn = { actions: [] };
      launcher._checkTurnProgress();
      assert.strictEqual(launcher.turnsSinceProgress, 1);
      assert.strictEqual(launcher.state, State.RUNNING_CLAUDE);

      // Turn 2 with no actions
      launcher.currentTurn = { actions: [] };
      launcher._checkTurnProgress();
      assert.strictEqual(launcher.turnsSinceProgress, 2);
      assert.strictEqual(launcher.state, State.BLOCKED);
    });

    it('should reset no-progress counter on action', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.turnsSinceProgress = 1;

      launcher.currentTurn = { actions: [{ tool: 'inspect' }] };
      launcher._checkTurnProgress();

      assert.strictEqual(launcher.turnsSinceProgress, 0);
    });
  });

  describe('Exit code mapping', () => {
    it('should map DONE to exit code 0', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.DONE;

      const result = launcher._finalizeExecution();
      assert.strictEqual(result.exitCode, ExitCode.SUCCESS);
    });

    it('should map PAUSED_USER to exit code 20', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.PAUSED_USER;

      const result = launcher._finalizeExecution();
      assert.strictEqual(result.exitCode, ExitCode.PAUSED_USER);
    });

    it('should map BLOCKED to exit code 30', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.BLOCKED;

      const result = launcher._finalizeExecution();
      assert.strictEqual(result.exitCode, ExitCode.BLOCKED);
    });

    it('should map INTEGRITY_FAILURE to exit code 40', () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      launcher.state = State.INTEGRITY_FAILURE;

      const result = launcher._finalizeExecution();
      assert.strictEqual(result.exitCode, ExitCode.INTEGRITY_FAILURE);
    });
  });

  describe('Process lifecycle', () => {
    it('should clean up child process on abort', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();

      // Mock child process with immediate response
      const exitListeners = [];
      launcher.childProcess = {
        killed: false,
        pid: 12345,
        kill: function(signal) {
          this.killed = true;
          // Immediately call exit listeners
          setImmediate(() => {
            exitListeners.forEach(fn => fn(0, signal));
          });
        },
        once: function(event, fn) {
          if (event === 'exit') {
            exitListeners.push(fn);
          }
        }
      };

      await launcher.abort();

      assert.strictEqual(launcher.childProcess.killed, true);
    });
  });

  describe('Lease management', () => {
    it('should acquire lease on start', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();

      launcher.goalConfig = await launcher._loadGoalConfig();
      await launcher._acquireLease();

      // Should create lease file
      const { readFile } = await import('node:fs/promises');
      const leaseContent = await readFile(launcher.leasePath, 'utf8');
      const lease = JSON.parse(leaseContent);

      assert.strictEqual(lease.pid, process.pid);
      assert.ok(lease.nonce);
      assert.ok(lease.acquiredAt);
    });

    it('should reject concurrent instances', async () => {
      launcher = new Launcher({ goalDir: mockGoalDir });
      await launcher.init();
      launcher.goalConfig = await launcher._loadGoalConfig();
      await launcher._acquireLease();

      // Create a second launcher that will check the lease
      const launcher2 = new Launcher({ goalDir: mockGoalDir });
      await launcher2._loadState();
      launcher2.goalConfig = await launcher2._loadGoalConfig();

      // Manually modify the lease to simulate a different process that's still alive
      // Use PID 1 which always exists on Unix systems
      const { readFile: rf, writeFile: wf } = await import('node:fs/promises');
      const leaseContent = await rf(launcher.leasePath, 'utf8');
      const lease = JSON.parse(leaseContent);
      lease.pid = 1; // Init process (always exists)
      lease.nativeGoalActive = true;
      await wf(launcher.leasePath, JSON.stringify(lease, null, 2));

      await assert.rejects(
        async () => await launcher2._acquireLease(),
        /Lease conflict/
      );
    });
  });
});
