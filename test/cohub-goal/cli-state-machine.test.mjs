/**
 * @fileoverview CLI state machine tests (CLI-01 spec lines 370-374).
 * Tests all commands (init/doctor/dry-run/start/resume/status/verify/pause),
 * legal/illegal/corrupt/arg error states, stable exit codes, zero remote
 * mutation for read-only commands, blocking reason behavior.
 * RED phase: all tests must fail initially.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Exit codes from spec lines 367-368
const EXIT_CODES = {
  SUCCESS: 0,
  INCOMPLETE: 10,
  WAITING_USER: 20,
  BLOCKED: 30,
  INTEGRITY_FAILURE: 40,
  CAPABILITY_FAILURE: 50,
  LEASE_CONFLICT: 60
};

const createMockConfig = (overrides = {}) => ({
  schemaVersion: 1,
  goalInstance: 'test-goal-v1',
  goalVersion: 1,
  mode: 'supervisor',
  spaceId: 'test-space-id',
  parentSessionId: 'test-parent-session',
  historicalParentSessionIds: [],
  runPath: 'workflow/runs/test',
  statePath: 'workflow/runs/test/orchestration_state.json',
  gateLogPath: 'workflow/runs/test/stage_gate_log.json',
  manifestPath: 'workflow/runs/test/run_manifest.json',
  legalHumanGates: ['proposal_approval'],
  consumedHumanGates: [],
  continuationAuthority: 'external_event_bridge',
  claudeCodeVersion: '2.1.201',
  cohubCliVersion: '2.3.2',
  cohubSdkVersion: '2.11.1',
  ...overrides
});

test('CLI - init command', async (t) => {
  await t.test('init succeeds with valid config in NEW state', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');
      const config = createMockConfig();

      const result = await runCommand('init', {
        goalPath: join(tmpDir, 'goal.json'),
        config
      });

      assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
      assert.equal(result.mutatedRemote, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('init fails when directory is not empty', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      await mkdir(join(tmpDir, '.cohub-goals', 'test-goal-v1'), { recursive: true });
      await writeFile(join(tmpDir, '.cohub-goals', 'test-goal-v1', 'existing.txt'), 'data');

      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');
      const config = createMockConfig();

      const result = await runCommand('init', {
        goalPath: join(tmpDir, 'goal.json'),
        config
      });

      assert.equal(result.exitCode > 0, true);
      assert.match(result.stderr, /not empty/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('init fails with missing required config fields', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');
      const config = { goalInstance: 'test' }; // Missing required fields

      const result = await runCommand('init', {
        goalPath: join(tmpDir, 'goal.json'),
        config
      });

      assert.equal(result.exitCode > 0, true);
      assert.match(result.stderr, /required/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - doctor command', async (t) => {
  await t.test('doctor performs zero remote mutations', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      let remoteMutations = 0;
      const mockDeps = {
        checkClaudeGoal: async () => ({ available: true }),
        checkMCPServer: async () => ({ available: true }),
        checkCohubREST: async () => ({ available: true }),
        checkWebSocket: async () => ({ available: true }),
        onRemoteMutation: () => { remoteMutations++; }
      };

      const result = await runCommand('doctor', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(remoteMutations, 0, 'doctor must not mutate remote state');
      assert.equal(result.mutatedRemote, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('doctor checks all required capabilities', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const checks = {
        claudeGoal: false,
        mcpServer: false,
        cohubREST: false,
        webSocket: false
      };

      const mockDeps = {
        checkClaudeGoal: async () => { checks.claudeGoal = true; return { available: true }; },
        checkMCPServer: async () => { checks.mcpServer = true; return { available: true }; },
        checkCohubREST: async () => { checks.cohubREST = true; return { available: true }; },
        checkWebSocket: async () => { checks.webSocket = true; return { available: true }; }
      };

      await runCommand('doctor', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(checks.claudeGoal, true);
      assert.equal(checks.mcpServer, true);
      assert.equal(checks.cohubREST, true);
      assert.equal(checks.webSocket, true);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - dry-run command', async (t) => {
  await t.test('dry-run performs zero remote mutations', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      let remoteMutations = 0;
      const mockDeps = {
        inspect: async () => ({ snapshotHash: 'abc', localState: 'READY' }),
        verify: async () => ({ verdict: 'RUNNING' }),
        onRemoteMutation: () => { remoteMutations++; }
      };

      const result = await runCommand('dry-run', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(remoteMutations, 0, 'dry-run must not mutate remote state');
      assert.equal(result.mutatedRemote, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('dry-run outputs decision and snapshot hash', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        inspect: async () => ({
          snapshotHash: 'abc123hash',
          localState: 'READY',
          allowedDecisions: ['CONTINUE', 'WAIT']
        }),
        verify: async () => ({ verdict: 'RUNNING' })
      };

      const result = await runCommand('dry-run', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.match(result.stdout, /abc123hash/);
      assert.match(result.stdout, /decision/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - start command', async (t) => {
  await t.test('start only allowed in NEW or READY state', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLocalState: async () => 'RUNNING_CLAUDE'
      };

      const result = await runCommand('start', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(result.exitCode > 0, true);
      assert.match(result.stderr, /illegal state.*start/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('start succeeds in READY state', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLocalState: async () => 'READY',
        startClaude: async () => ({ exitCode: 0 })
      };

      const result = await runCommand('start', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - resume command', async (t) => {
  await t.test('resume only allowed in recoverable states', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLocalState: async () => 'NEW'
      };

      const result = await runCommand('resume', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(result.exitCode > 0, true);
      assert.match(result.stderr, /cannot resume.*NEW/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('resume succeeds in PAUSED_USER state', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLocalState: async () => 'PAUSED_USER',
        reconcileUserInput: async () => ({ resolved: true }),
        resumeClaude: async () => ({ exitCode: 0 })
      };

      const result = await runCommand('resume', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('resume fails if blocking reason still exists', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLocalState: async () => 'BLOCKED',
        checkBlockingReason: async () => ({ stillBlocked: true, reason: 'quota exceeded' })
      };

      const result = await runCommand('resume', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(result.exitCode, EXIT_CODES.BLOCKED);
      assert.match(result.stderr, /quota exceeded/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - status command', async (t) => {
  await t.test('status performs zero remote mutations', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      let remoteMutations = 0;
      const mockDeps = {
        getLocalState: async () => 'READY',
        getLedger: async () => ({ entries: [] }),
        onRemoteMutation: () => { remoteMutations++; }
      };

      const result = await runCommand('status', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(remoteMutations, 0, 'status must not mutate remote state');
      assert.equal(result.mutatedRemote, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('status displays local state and last action', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLocalState: async () => 'WAITING_COHUB',
        getLedger: async () => ({
          entries: [
            { type: 'ACTION', actionId: 'act-123', timestamp: '2026-07-15T10:00:00.000Z' }
          ]
        })
      };

      const result = await runCommand('status', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.match(result.stdout, /WAITING_COHUB/);
      assert.match(result.stdout, /act-123/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - verify command', async (t) => {
  await t.test('verify performs zero remote mutations', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      let remoteMutations = 0;
      const mockDeps = {
        verify: async () => ({ verdict: 'RUNNING' }),
        onRemoteMutation: () => { remoteMutations++; }
      };

      const result = await runCommand('verify', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(remoteMutations, 0, 'verify must not mutate remote state');
      assert.equal(result.mutatedRemote, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('verify outputs verdict and evidence', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        verify: async () => ({
          verdict: 'DONE',
          snapshotHash: 'final-hash',
          evidenceRefs: ['evidence-1', 'evidence-2']
        })
      };

      const result = await runCommand('verify', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.match(result.stdout, /DONE/);
      assert.match(result.stdout, /evidence-1/);
      assert.match(result.stdout, /evidence-2/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - pause command', async (t) => {
  await t.test('pause only affects local state', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      let remoteMutations = 0;
      const mockDeps = {
        getLocalState: async () => 'RUNNING_CLAUDE',
        pauseLocal: async () => {},
        onRemoteMutation: () => { remoteMutations++; }
      };

      const result = await runCommand('pause', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(remoteMutations, 0, 'pause must not mutate remote state');
      assert.equal(result.mutatedRemote, false);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - corrupt state handling', async (t) => {
  await t.test('detects corrupt ledger and enters INTEGRITY_FAILURE', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const ledgerDir = join(tmpDir, '.cohub-goals', 'test-goal', 'ledger');
      await mkdir(ledgerDir, { recursive: true });
      await writeFile(join(ledgerDir, '00000001-abc.json'), '{ invalid json');

      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const result = await runCommand('status', {
        goalPath: join(tmpDir, 'goal.json')
      });

      assert.equal(result.exitCode, EXIT_CODES.INTEGRITY_FAILURE);
      assert.match(result.stderr, /integrity/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('detects hash chain break', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const ledgerDir = join(tmpDir, '.cohub-goals', 'test-goal', 'ledger');
      await mkdir(ledgerDir, { recursive: true });

      await writeFile(join(ledgerDir, '00000001-abc.json'), JSON.stringify({
        seq: 1,
        entryHash: 'abc',
        previousEntryHash: null
      }));

      await writeFile(join(ledgerDir, '00000002-def.json'), JSON.stringify({
        seq: 2,
        entryHash: 'def',
        previousEntryHash: 'wrong-hash' // Should be 'abc'
      }));

      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const result = await runCommand('status', {
        goalPath: join(tmpDir, 'goal.json')
      });

      assert.equal(result.exitCode, EXIT_CODES.INTEGRITY_FAILURE);
      assert.match(result.stderr, /hash chain/i);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

test('CLI - exit code stability', async (t) => {
  await t.test('returns SUCCESS (0) for completed goal', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const mockDeps = {
      verify: async () => ({ verdict: 'DONE' })
    };

    const result = await runCommand('verify', {
      goalPath: '/tmp/test',
      deps: mockDeps
    });

    assert.equal(result.exitCode, EXIT_CODES.SUCCESS);
  });

  await t.test('returns WAITING_USER (20) for paused state', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const mockDeps = {
      verify: async () => ({ verdict: 'PAUSED_USER' })
    };

    const result = await runCommand('verify', {
      goalPath: '/tmp/test',
      deps: mockDeps
    });

    assert.equal(result.exitCode, EXIT_CODES.WAITING_USER);
  });

  await t.test('returns BLOCKED (30) for blocked state', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const mockDeps = {
      verify: async () => ({ verdict: 'BLOCKED' })
    };

    const result = await runCommand('verify', {
      goalPath: '/tmp/test',
      deps: mockDeps
    });

    assert.equal(result.exitCode, EXIT_CODES.BLOCKED);
  });

  await t.test('returns INTEGRITY_FAILURE (40) for corrupt data', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), 'cohub-goal-test-'));
    try {
      const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

      const mockDeps = {
        getLedger: async () => {
          throw new Error('INTEGRITY_FAILURE: corrupt ledger');
        }
      };

      const result = await runCommand('status', {
        goalPath: join(tmpDir, 'goal.json'),
        deps: mockDeps
      });

      assert.equal(result.exitCode, EXIT_CODES.INTEGRITY_FAILURE);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('returns LEASE_CONFLICT (60) for concurrent access', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const mockDeps = {
      getLocalState: async () => 'READY',
      acquireLease: async () => {
        throw new Error('LEASE_CONFLICT: another instance is running');
      }
    };

    const result = await runCommand('start', {
      goalPath: '/tmp/test',
      deps: mockDeps
    });

    assert.equal(result.exitCode, EXIT_CODES.LEASE_CONFLICT);
  });
});

test('CLI - argument validation', async (t) => {
  await t.test('rejects missing goal path', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const result = await runCommand('status', {});

    assert.equal(result.exitCode > 0, true);
    assert.match(result.stderr, /goal.*path.*required/i);
  });

  await t.test('rejects invalid command', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const result = await runCommand('invalid-command', {
      goalPath: '/tmp/test'
    });

    assert.equal(result.exitCode > 0, true);
    assert.match(result.stderr, /unknown command/i);
  });
});

test('CLI - stdout/stderr capture without secrets', async (t) => {
  await t.test('captures stdout without leaking tokens', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const mockDeps = {
      verify: async () => ({
        verdict: 'RUNNING',
        _accessToken: 'secret-token-should-not-appear'
      })
    };

    const result = await runCommand('verify', {
      goalPath: '/tmp/test',
      deps: mockDeps
    });

    assert.equal(result.stdout.includes('secret-token'), false);
  });

  await t.test('captures stderr without leaking credentials', async () => {
    const { runCommand } = await import('../../src/cohub-claude-goal/cli.js');

    const mockDeps = {
      verify: async () => {
        const err = new Error('Auth failed');
        err.token = 'secret-refresh-token';
        throw err;
      }
    };

    const result = await runCommand('verify', {
      goalPath: '/tmp/test',
      deps: mockDeps
    });

    assert.equal(result.stderr.includes('secret-refresh'), false);
    assert.match(result.stderr, /auth failed/i);
  });
});
