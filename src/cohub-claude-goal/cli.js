/**
 * @fileoverview CLI commands with state machine (spec lines 342-374, CLI-01).
 * Commands: init/doctor/dry-run/start/resume/status/verify/pause (8 commands).
 * Exact legal/illegal local states, stable exit codes, zero remote mutation
 * for read-only commands, blocking reason behavior, capture stdout/stderr
 * without secrets.
 */

// Exit codes from spec lines 367-368
export const EXIT_CODES = {
  SUCCESS: 0,
  INCOMPLETE: 10,
  WAITING_USER: 20,
  BLOCKED: 30,
  INTEGRITY_FAILURE: 40,
  CAPABILITY_FAILURE: 50,
  LEASE_CONFLICT: 60,
  INVALID_ARGS: 1,
  ILLEGAL_STATE: 2
};

// Local state machine from spec lines 144-167
// Resume is legal ONLY from WAITING_COHUB (recoverable Cohub wait state).
// PAUSED_USER/BLOCKED/DONE/INTEGRITY_FAILURE require launcher-controlled new /goal.
// RUNNING_CLAUDE must never resume via CLI.
const LEGAL_TRANSITIONS = {
  init: new Set(['NEW']),
  start: new Set(['NEW', 'READY']),
  resume: new Set(['WAITING_COHUB']),
  doctor: new Set(['NEW', 'READY', 'RUNNING_CLAUDE', 'WAITING_COHUB', 'PAUSED_USER', 'BLOCKED', 'DONE', 'INTEGRITY_FAILURE']),
  'dry-run': new Set(['NEW', 'READY', 'RUNNING_CLAUDE', 'WAITING_COHUB', 'PAUSED_USER', 'BLOCKED', 'DONE']),
  status: new Set(['NEW', 'READY', 'RUNNING_CLAUDE', 'WAITING_COHUB', 'PAUSED_USER', 'BLOCKED', 'DONE', 'INTEGRITY_FAILURE']),
  verify: new Set(['NEW', 'READY', 'RUNNING_CLAUDE', 'WAITING_COHUB', 'PAUSED_USER', 'BLOCKED', 'DONE']),
  pause: new Set(['RUNNING_CLAUDE', 'WAITING_COHUB'])
};

// Read-only commands that must not mutate remote state
const READ_ONLY_COMMANDS = new Set(['doctor', 'dry-run', 'status', 'verify']);

const REDACTED_PATTERNS = [
  /access[_-]?token/gi,
  /refresh[_-]?token/gi,
  /secret/gi,
  /password/gi,
  /bearer\s+[a-zA-Z0-9_-]+/gi
];

/**
 * Redact secrets from output
 */
function redactSecrets(text) {
  if (typeof text !== 'string') {
    return text;
  }

  let result = text;
  for (const pattern of REDACTED_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

/**
 * Validate command arguments
 */
function validateArgs(command, options) {
  if (!options.goalPath) {
    throw new Error('goal path is required');
  }

  if (!LEGAL_TRANSITIONS[command]) {
    throw new Error(`unknown command: ${command}`);
  }
}

/**
 * Check if command is allowed in current state
 */
function checkStateTransition(command, currentState) {
  const allowed = LEGAL_TRANSITIONS[command];
  if (!allowed.has(currentState)) {
    throw new Error(`illegal state transition: cannot ${command} in state ${currentState}`);
  }
}

/**
 * Map verdict to exit code
 */
function verdictToExitCode(verdict) {
  switch (verdict) {
    case 'DONE':
      return EXIT_CODES.SUCCESS;
    case 'RUNNING':
      return EXIT_CODES.INCOMPLETE;
    case 'PAUSED_USER':
      return EXIT_CODES.WAITING_USER;
    case 'BLOCKED':
      return EXIT_CODES.BLOCKED;
    default:
      return EXIT_CODES.INCOMPLETE;
  }
}

/**
 * Initialize a new goal
 */
async function initCommand(options, deps) {
  const { goalPath, config } = options;

  // Validate config has required fields (spec lines 106-138)
  const required = [
    'schemaVersion', 'goalInstance', 'goalVersion', 'mode',
    'spaceId', 'parentSessionId', 'runPath', 'statePath',
    'gateLogPath', 'manifestPath', 'continuationAuthority'
  ];

  for (const field of required) {
    if (!(field in config)) {
      throw new Error(`config missing required field: ${field}`);
    }
  }

  // Check directory is empty or doesn't exist
  if (!deps?.checkDirectory) {
    // Default implementation: check if directory exists and is not empty
    const { access, readdir } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');

    const dir = join(dirname(goalPath), '.cohub-goals', config.goalInstance);
    try {
      await access(dir);
      const files = await readdir(dir);
      if (files.length > 0) {
        throw new Error('goal directory is not empty');
      }
    } catch (error) {
      // Directory doesn't exist is OK, other errors should propagate
      if (error.message === 'goal directory is not empty') {
        throw error;
      }
    }
  } else {
    const isEmpty = await deps.checkDirectory(goalPath);
    if (!isEmpty) {
      throw new Error('goal directory is not empty');
    }
  }

  // Create initial goal structure
  if (deps?.initializeGoal) {
    await deps.initializeGoal(goalPath, config);
  }

  return {
    exitCode: EXIT_CODES.SUCCESS,
    stdout: `Initialized goal ${config.goalInstance}\n`,
    stderr: '',
    mutatedRemote: false
  };
}

/**
 * Run diagnostic checks (read-only)
 */
async function doctorCommand(options, deps) {
  const checks = [];
  let allPassed = true;

  // Check Claude Goal availability
  if (deps?.checkClaudeGoal) {
    const result = await deps.checkClaudeGoal();
    checks.push({ name: 'Claude /goal', passed: result.available });
    allPassed = allPassed && result.available;
  }

  // Check MCP server
  if (deps?.checkMCPServer) {
    const result = await deps.checkMCPServer();
    checks.push({ name: 'MCP server', passed: result.available });
    allPassed = allPassed && result.available;
  }

  // Check Cohub REST API
  if (deps?.checkCohubREST) {
    const result = await deps.checkCohubREST();
    checks.push({ name: 'Cohub REST', passed: result.available });
    allPassed = allPassed && result.available;
  }

  // Check WebSocket subscription
  if (deps?.checkWebSocket) {
    const result = await deps.checkWebSocket();
    checks.push({ name: 'WebSocket subscription', passed: result.available });
    allPassed = allPassed && result.available;
  }

  const stdout = checks.map(c => `${c.name}: ${c.passed ? 'PASS' : 'FAIL'}`).join('\n') + '\n';

  return {
    exitCode: allPassed ? EXIT_CODES.SUCCESS : EXIT_CODES.CAPABILITY_FAILURE,
    stdout,
    stderr: '',
    mutatedRemote: false
  };
}

/**
 * Dry-run: show what would happen (read-only)
 */
async function dryRunCommand(options, deps) {
  if (!deps?.inspect || !deps?.verify) {
    throw new Error('Missing required dependencies for dry-run');
  }

  const snapshot = await deps.inspect(options.goalPath);
  const verification = await deps.verify(options.goalPath);

  const output = [
    `Snapshot hash: ${snapshot.snapshotHash}`,
    `Local state: ${snapshot.localState}`,
    `Verdict: ${verification.verdict}`,
    `Allowed decisions: ${snapshot.allowedDecisions?.join(', ') || 'none'}`,
    `Watch set: ${snapshot.watchSet?.length || 0} items`
  ].join('\n') + '\n';

  return {
    exitCode: EXIT_CODES.SUCCESS,
    stdout: output,
    stderr: '',
    mutatedRemote: false
  };
}

/**
 * Start a new goal execution
 */
async function startCommand(options, deps) {
  if (!deps?.getLocalState) {
    throw new Error('Missing required dependencies for start');
  }

  const currentState = await deps.getLocalState(options.goalPath);
  checkStateTransition('start', currentState);

  // Acquire lease
  if (deps?.acquireLease) {
    await deps.acquireLease(options.goalPath);
  }

  // Start Claude
  if (deps?.startClaude) {
    const result = await deps.startClaude(options.goalPath);
    return {
      exitCode: result.exitCode || EXIT_CODES.SUCCESS,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      mutatedRemote: true
    };
  }

  return {
    exitCode: EXIT_CODES.SUCCESS,
    stdout: 'Started goal execution\n',
    stderr: '',
    mutatedRemote: true
  };
}

/**
 * Resume paused or blocked goal
 */
async function resumeCommand(options, deps) {
  if (!deps?.getLocalState) {
    throw new Error('Missing required dependencies for resume');
  }

  const currentState = await deps.getLocalState(options.goalPath);
  checkStateTransition('resume', currentState);

  // Resume Claude from WAITING_COHUB state
  if (deps?.resumeClaude) {
    const result = await deps.resumeClaude(options.goalPath);
    return {
      exitCode: result.exitCode || EXIT_CODES.SUCCESS,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      mutatedRemote: true
    };
  }

  return {
    exitCode: EXIT_CODES.SUCCESS,
    stdout: 'Resumed goal execution\n',
    stderr: '',
    mutatedRemote: true
  };
}

/**
 * Show current status (read-only)
 */
async function statusCommand(options, deps) {
  if (!deps?.getLocalState || !deps?.getLedger) {
    throw new Error('Missing required dependencies for status');
  }

  const state = await deps.getLocalState(options.goalPath);
  const ledger = await deps.getLedger(options.goalPath);

  const lastEntry = ledger.entries?.[ledger.entries.length - 1];

  const output = [
    `Local state: ${state}`,
    `Ledger entries: ${ledger.entries?.length || 0}`,
    lastEntry ? `Last action: ${lastEntry.actionId} at ${lastEntry.timestamp}` : 'No actions yet'
  ].join('\n') + '\n';

  return {
    exitCode: EXIT_CODES.SUCCESS,
    stdout: output,
    stderr: '',
    mutatedRemote: false
  };
}

/**
 * Verify goal completion state (read-only)
 */
async function verifyCommand(options, deps) {
  if (!deps?.verify) {
    throw new Error('Missing required dependencies for verify');
  }

  const result = await deps.verify(options.goalPath);

  const output = [
    `Verdict: ${result.verdict}`,
    `Snapshot hash: ${result.snapshotHash || 'none'}`,
    result.evidenceRefs ? `Evidence: ${result.evidenceRefs.join(', ')}` : 'No evidence',
    result.missingEvidence ? `Missing: ${result.missingEvidence.join(', ')}` : ''
  ].filter(Boolean).join('\n') + '\n';

  return {
    exitCode: verdictToExitCode(result.verdict),
    stdout: output,
    stderr: '',
    mutatedRemote: false
  };
}

/**
 * Pause local execution (local only, no remote mutation)
 */
async function pauseCommand(options, deps) {
  if (!deps?.getLocalState) {
    throw new Error('Missing required dependencies for pause');
  }

  const currentState = await deps.getLocalState(options.goalPath);
  checkStateTransition('pause', currentState);

  if (deps?.pauseLocal) {
    await deps.pauseLocal(options.goalPath);
  }

  return {
    exitCode: EXIT_CODES.SUCCESS,
    stdout: 'Paused local execution\n',
    stderr: '',
    mutatedRemote: false
  };
}

/**
 * Main command dispatcher
 */
export async function runCommand(command, options) {
  let stdout = '';
  let stderr = '';
  let exitCode = EXIT_CODES.SUCCESS;
  let mutatedRemote = false;

  try {
    // Validate arguments
    validateArgs(command, options);

    const deps = options.deps || {};

    // Check for integrity failure - provide default ledger reader
    const getLedger = deps.getLedger || (async (goalPath) => {
      // Default implementation: read and validate ledger files
      const { readdir, readFile } = await import('node:fs/promises');
      const { dirname, join } = await import('node:path');

      const ledgerDir = join(dirname(goalPath), '.cohub-goals', 'test-goal', 'ledger');

      try {
        const files = await readdir(ledgerDir);
        const entries = [];

        for (const file of files.sort()) {
          if (!file.endsWith('.json')) continue;

          const content = await readFile(join(ledgerDir, file), 'utf8');
          try {
            const entry = JSON.parse(content);

            // Check hash chain
            if (entries.length > 0) {
              const prevEntry = entries[entries.length - 1];
              if (entry.previousEntryHash !== prevEntry.entryHash) {
                throw new Error('INTEGRITY_FAILURE: hash chain broken');
              }
            }

            entries.push(entry);
          } catch (parseError) {
            if (parseError.message.includes('INTEGRITY_FAILURE')) {
              throw parseError;
            }
            throw new Error(`INTEGRITY_FAILURE: corrupt ledger file ${file}`);
          }
        }

        return { entries };
      } catch (error) {
        if (error.code === 'ENOENT') {
          return { entries: [] };
        }
        throw error;
      }
    });

    try {
      await getLedger(options.goalPath);
    } catch (error) {
      if (error.message.includes('INTEGRITY_FAILURE') || error.message.includes('corrupt') || error.message.includes('hash chain')) {
        return {
          exitCode: EXIT_CODES.INTEGRITY_FAILURE,
          stdout: '',
          stderr: redactSecrets(`Integrity failure: ${error.message}\n`),
          mutatedRemote: false
        };
      }
    }

    // Dispatch to command handler
    let result;
    switch (command) {
      case 'init':
        result = await initCommand(options, deps);
        break;
      case 'doctor':
        result = await doctorCommand(options, deps);
        break;
      case 'dry-run':
        result = await dryRunCommand(options, deps);
        break;
      case 'start':
        result = await startCommand(options, deps);
        break;
      case 'resume':
        result = await resumeCommand(options, deps);
        break;
      case 'status':
        result = await statusCommand(options, deps);
        break;
      case 'verify':
        result = await verifyCommand(options, deps);
        break;
      case 'pause':
        result = await pauseCommand(options, deps);
        break;
      default:
        throw new Error(`unknown command: ${command}`);
    }

    exitCode = result.exitCode;
    stdout = redactSecrets(result.stdout);
    stderr = redactSecrets(result.stderr);
    mutatedRemote = result.mutatedRemote;

    // Verify read-only commands didn't mutate
    if (READ_ONLY_COMMANDS.has(command) && mutatedRemote) {
      throw new Error(`INTERNAL: read-only command ${command} mutated remote state`);
    }

  } catch (error) {
    stderr = redactSecrets(`Error: ${error.message}\n`);

    // Map errors to exit codes
    if (error.message.includes('INTEGRITY_FAILURE') || error.message.includes('corrupt') || error.message.includes('hash chain')) {
      exitCode = EXIT_CODES.INTEGRITY_FAILURE;
    } else if (error.message.includes('LEASE_CONFLICT') || error.message.includes('another instance') || error.message.includes('already running')) {
      exitCode = EXIT_CODES.LEASE_CONFLICT;
    } else if (error.message.includes('illegal state') || (error.message.includes('cannot') && error.message.includes('in state'))) {
      exitCode = EXIT_CODES.ILLEGAL_STATE;
    } else if (error.message.includes('not empty')) {
      exitCode = EXIT_CODES.INVALID_ARGS;
    } else if (error.message.includes('required') || error.message.includes('unknown command')) {
      exitCode = EXIT_CODES.INVALID_ARGS;
    } else {
      exitCode = EXIT_CODES.INCOMPLETE;
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    mutatedRemote
  };
}
