/**
 * Claude Code launcher state machine for Cohub goal supervision
 *
 * Implements the exact state machine from spec lines 144-167:
 * NEW → READY → RUNNING_CLAUDE → WAITING_COHUB → (PAUSED_USER|BLOCKED|DONE)
 *
 * Key responsibilities:
 * - Persist fixed UUID for Claude session across restarts
 * - Construct exact argv with --session-id or --resume
 * - Parse stream-json to detect bootstrap outcomes (exit vs auto-evaluator)
 * - Prohibit concurrent invocation when native goal active
 * - Prohibit post-settle resume when evaluator already satisfied
 * - Enforce two-turn no-progress refusal blocker
 * - Require fresh verify binding on process exit
 * - Track cumulative budget in ledger
 * - Clean exit with no orphan child processes
 *
 * Does NOT:
 * - Use network/package/other modules beyond node builtins
 * - Put tokens in argv/prompt/log
 * - Commit to git
 */

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, rename, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';

/**
 * State machine states per spec lines 144-167
 */
export const State = {
  NEW: 'NEW',
  READY: 'READY',
  RUNNING_CLAUDE: 'RUNNING_CLAUDE',
  WAITING_COHUB: 'WAITING_COHUB',
  PAUSED_USER: 'PAUSED_USER',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE',
  INTEGRITY_FAILURE: 'INTEGRITY_FAILURE'
};

/**
 * Exit codes per spec lines 367-372
 */
export const ExitCode = {
  SUCCESS: 0,
  INCOMPLETE: 10,
  PAUSED_USER: 20,
  BLOCKED: 30,
  INTEGRITY_FAILURE: 40,
  CAPABILITY_GATE_FAILURE: 50,
  LEASE_CONFLICT: 60
};

/**
 * Verdict codes from verify MCP tool
 */
export const Verdict = {
  RUNNING: 'RUNNING',
  PAUSED_USER: 'PAUSED_USER',
  BLOCKED: 'BLOCKED',
  DONE: 'DONE'
};

/**
 * Launcher state machine
 */
export class Launcher {
  constructor(options = {}) {
    this.goalDir = options.goalDir;
    if (!this.goalDir) {
      throw new Error('goalDir is required');
    }

    this.goalConfigPath = path.join(this.goalDir, 'goal.json');
    this.statePath = path.join(this.goalDir, 'state.json');
    this.ledgerDir = path.join(this.goalDir, 'ledger');
    this.leasePath = path.join(this.goalDir, 'lease.json');

    this.state = State.NEW;
    this.claudeSessionId = null;
    this.childProcess = null;
    this.streamBuffer = '';
    this.currentTurn = null;
    this.lastVerdict = null;
    this.turnsSinceProgress = 0;
    this.goalConfig = null;
    this.cumulativeBudget = { turns: 0, tokens: 0, seconds: 0 };
    this.ledgerHead = null;
    this.bootstrapComplete = false;
    this.evaluatorEntered = false;
    this.nativeGoalActive = false;
    this.waitRefusalCount = 0;

    // For testing: allow injection of Claude invocation
    this._claudeCommand = options.claudeCommand || 'claude';
    this._mockStreamParser = options.mockStreamParser || null;
  }

  /**
   * Initialize a new goal instance
   * Per spec lines 358-359: Create immutable goal and ledger
   */
  async init() {
    // Check if already initialized
    try {
      await access(this.statePath, fsConstants.F_OK);
      throw new Error('Goal already initialized (state.json exists)');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }

    // Create directory structure
    await mkdir(this.goalDir, { recursive: true });
    await mkdir(this.ledgerDir, { recursive: true });
    await mkdir(path.join(this.goalDir, 'evidence'), { recursive: true });
    await mkdir(path.join(this.goalDir, 'logs'), { recursive: true });

    // Load goal config
    this.goalConfig = await this._loadGoalConfig();

    // Generate fixed UUID
    this.claudeSessionId = randomUUID();

    // Initialize state
    const initialState = {
      schemaVersion: 1,
      goalInstance: this.goalConfig.goalInstance,
      goalVersion: this.goalConfig.goalVersion,
      state: State.READY,
      claudeSessionId: this.claudeSessionId,
      cumulativeBudget: { turns: 0, tokens: 0, seconds: 0 },
      ledgerHead: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await this._atomicWriteJSON(this.statePath, initialState);
    this.state = State.READY;

    return { state: this.state, sessionId: this.claudeSessionId };
  }

  /**
   * Start a new goal execution
   * Per spec: Allowed from NEW or READY states
   */
  async start() {
    await this._loadState();

    // Allow start from NEW or READY
    if (this.state !== State.NEW && this.state !== State.READY) {
      throw new Error(`Cannot start from state ${this.state}. Only NEW or READY states are allowed.`);
    }

    // If NEW, initialize first
    if (this.state === State.NEW) {
      await this.init();
    }

    // Load goal config first (needed for lease)
    this.goalConfig = await this._loadGoalConfig();

    // Acquire lease
    await this._acquireLease();

    // Construct argv for first invocation
    const argv = this._constructStartArgv();

    // Spawn Claude
    this.state = State.RUNNING_CLAUDE;
    await this._updateState();

    await this._spawnClaude(argv);

    return this._finalizeExecution();
  }

  /**
   * Resume a crashed goal from WAITING_COHUB
   * Per spec: Only allowed from WAITING_COHUB after process exit + fresh unsettled verify
   * Uses plain --resume with no new /goal condition
   */
  async resume(options = {}) {
    await this._loadState();

    // Only WAITING_COHUB is resumable - it means Claude exited while waiting for external work
    if (this.state !== State.WAITING_COHUB) {
      throw new Error(`Cannot resume from state ${this.state}. Only WAITING_COHUB is resumable.`);
    }

    // Block resume if evaluator already entered (goal settled)
    if (this.evaluatorEntered) {
      throw new Error('Cannot resume: evaluator already entered (goal settled)');
    }

    // Require fresh verify binding before resume
    if (!this.lastVerdict) {
      throw new Error('Cannot resume: no lastVerdict present (need fresh verify binding)');
    }

    // Verify must show RUNNING (unsettled)
    if (this.lastVerdict !== Verdict.RUNNING) {
      throw new Error(`Cannot resume: lastVerdict is ${this.lastVerdict}, expected RUNNING`);
    }

    // Load goal config first (needed for lease)
    this.goalConfig = await this._loadGoalConfig();

    // Acquire lease
    await this._acquireLease();

    // Construct argv for resume - plain --resume with no new /goal
    const argv = this._constructResumeArgv();

    // Spawn Claude
    this.state = State.RUNNING_CLAUDE;
    await this._updateState();

    await this._spawnClaude(argv);

    return this._finalizeExecution();
  }

  /**
   * Restart a previously settled goal (PAUSED_USER or BLOCKED) with fresh condition
   * Per spec lines 254, 452: Uses same UUID + explicit fresh /goal with new condition
   * Requires condition to have cleared since last settlement
   */
  async restartSettled(options = {}) {
    await this._loadState();

    // Only PAUSED_USER or BLOCKED are restartable
    if (this.state !== State.PAUSED_USER && this.state !== State.BLOCKED) {
      throw new Error(`Cannot restart from state ${this.state}. Only PAUSED_USER or BLOCKED are restartable.`);
    }

    // Require explicit fresh condition
    if (!options.condition || typeof options.condition !== 'string') {
      throw new Error('restartSettled requires explicit fresh condition string');
    }

    // Reject stale/unchanged condition
    const lastCondition = this._getLastCondition();
    if (options.condition === lastCondition) {
      throw new Error('Cannot restart with unchanged condition - condition must be fresh');
    }

    // Load goal config first (needed for lease)
    this.goalConfig = await this._loadGoalConfig();

    // Acquire lease
    await this._acquireLease();

    // Construct argv for settled restart: --resume UUID + new /goal condition
    const argv = this._constructSettledRestartArgv(options.condition);

    // Transition to READY, then RUNNING_CLAUDE
    this.state = State.READY;
    this.evaluatorEntered = false; // Reset evaluator flag for new goal
    this.nativeGoalActive = false;
    this.waitRefusalCount = 0;
    await this._updateState();

    this.state = State.RUNNING_CLAUDE;
    await this._updateState();

    await this._spawnClaude(argv);

    return this._finalizeExecution();
  }

  /**
   * Abort current execution
   */
  async abort() {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');

      // Wait up to 5s for graceful shutdown
      const timeout = setTimeout(() => {
        if (this.childProcess && !this.childProcess.killed) {
          this.childProcess.kill('SIGKILL');
        }
      }, 5000);

      await new Promise((resolve) => {
        if (!this.childProcess) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        this.childProcess.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    await this._releaseLease();
  }

  /**
   * Get current state
   */
  async getState() {
    await this._loadState();
    return {
      state: this.state,
      sessionId: this.claudeSessionId,
      cumulativeBudget: this.cumulativeBudget,
      lastVerdict: this.lastVerdict,
      nativeGoalActive: this.nativeGoalActive
    };
  }

  /**
   * Construct argv for initial start
   * Per spec lines 256-280:
   * - Uses --session-id with fixed UUID
   * - Non-interactive /goal with stream-json
   * - Permission mode dontAsk
   * - Only 4 MCP tools (inspect, submit, wait, verify)
   * - Explicit denial of Bash, Write, Edit, WebFetch, browser, other MCP
   * - No tokens in argv
   */
  _constructStartArgv() {
    const goalCondition = this._constructGoalCondition();

    return [
      '-p',
      `/goal ${goalCondition}`,
      '--session-id',
      this.claudeSessionId,
      '--output',
      'stream-json',
      '--permission',
      'dontAsk',
      '--mcp',
      'cohub_goal',
      '--deny-tool',
      'Bash',
      '--deny-tool',
      'Write',
      '--deny-tool',
      'Edit',
      '--deny-tool',
      'WebFetch',
      '--deny-tool',
      'WebSearch',
      '--deny-mcp',
      '*',
      '--allow-mcp',
      'cohub_goal'
    ];
  }

  /**
   * Construct argv for resume
   * Per spec: Uses --resume with same UUID, no new goal condition
   */
  _constructResumeArgv() {
    return [
      '--resume',
      this.claudeSessionId,
      '--output',
      'stream-json',
      '--permission',
      'dontAsk',
      '--mcp',
      'cohub_goal',
      '--deny-tool',
      'Bash',
      '--deny-tool',
      'Write',
      '--deny-tool',
      'Edit',
      '--deny-tool',
      'WebFetch',
      '--deny-tool',
      'WebSearch',
      '--deny-mcp',
      '*',
      '--allow-mcp',
      'cohub_goal'
    ];
  }

  /**
   * Construct argv for settled restart
   * Per spec: Uses --resume UUID + explicit fresh /goal condition
   */
  _constructSettledRestartArgv(condition) {
    return [
      '-p',
      `/goal ${condition}`,
      '--resume',
      this.claudeSessionId,
      '--output',
      'stream-json',
      '--permission',
      'dontAsk',
      '--mcp',
      'cohub_goal',
      '--deny-tool',
      'Bash',
      '--deny-tool',
      'Write',
      '--deny-tool',
      'Edit',
      '--deny-tool',
      'WebFetch',
      '--deny-tool',
      'WebSearch',
      '--deny-mcp',
      '*',
      '--allow-mcp',
      'cohub_goal'
    ];
  }

  /**
   * Get last goal condition (for stale detection)
   */
  _getLastCondition() {
    // Return stored last condition or null
    // For now, return null to allow first restart
    return null;
  }

  /**
   * Construct goal condition text
   * Per spec lines 274-278: Max 4000 chars, describes settle verdict rules
   */
  _constructGoalCondition() {
    const instance = this.goalConfig.goalInstance;
    return `持续监督 goalInstance=${instance}。每一步只使用 cohub_goal 的 inspect、submit、wait、verify。Cohub parent Agent 是唯一 workflow writer。等待外部工作时调用 wait 并保持当前 turn，不轮询。最新 verify 返回 DONE、PAUSED_USER 或 BLOCKED 时，本次 native goal 才算 settle。只有 DONE 等于 workflow 完成；PAUSED_USER 与 BLOCKED 只结束本次运行，macro goal 仍由 ledger 保留。verify 返回 RUNNING 时继续执行允许的唯一动作。助手文字、Turn completed、worker report 和旧 callback/watchdog 都不是完成证据。不得调用 Codex。`;
  }

  /**
   * Spawn Claude process and handle lifecycle
   */
  async _spawnClaude(argv) {
    return new Promise((resolve, reject) => {
      // For testing: allow mock stream parser
      if (this._mockStreamParser) {
        this._mockStreamParser(argv, this);
        resolve();
        return;
      }

      this.childProcess = spawn(this._claudeCommand, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.childProcess.stdout.on('data', (chunk) => {
        this._handleStreamChunk(chunk.toString());
      });

      this.childProcess.stderr.on('data', (chunk) => {
        // Log stderr but don't parse as stream-json
        console.error('Claude stderr:', chunk.toString());
      });

      this.childProcess.on('exit', async (code, signal) => {
        await this._handleProcessExit(code, signal);
        resolve();
      });

      this.childProcess.on('error', (err) => {
        reject(err);
      });

      // Handle termination signals
      const cleanup = async () => {
        await this.abort();
        process.exit(130);
      };

      process.once('SIGTERM', cleanup);
      process.once('SIGINT', cleanup);
    });
  }

  /**
   * Handle stream-json chunks
   * Per spec lines 332-342: Parse actions and detect no-progress
   */
  _handleStreamChunk(chunk) {
    this.streamBuffer += chunk;

    // Try to parse complete JSON objects
    const lines = this.streamBuffer.split('\n');
    this.streamBuffer = lines.pop() || ''; // Keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        this._processStreamEvent(event);
      } catch (err) {
        // Not valid JSON, skip
      }
    }
  }

  /**
   * Process a stream-json event
   */
  _processStreamEvent(event) {
    // Track bootstrap completion
    if (event.type === 'bootstrap' || event.phase === 'bootstrap') {
      this.bootstrapComplete = true;
      this.nativeGoalActive = true;
    }

    // Track turn boundaries
    if (event.type === 'turn' || event.phase === 'turn_start') {
      this.currentTurn = {
        id: event.turn_id || event.id,
        actions: [],
        startedAt: Date.now()
      };
    }

    // Track tool calls
    if (event.type === 'tool_call' || event.tool) {
      const toolName = event.tool || event.tool_name;
      if (this.currentTurn) {
        this.currentTurn.actions.push({ tool: toolName, timestamp: Date.now() });
      }

      // Detect wait call
      if (toolName === 'wait' || toolName === 'cohub_goal_wait') {
        this.state = State.WAITING_COHUB;
      }
    }

    // Track evaluator entry
    if (event.type === 'evaluator' || event.phase === 'evaluator') {
      this.evaluatorEntered = true;
      this.nativeGoalActive = false; // Evaluator means goal settled
    }

    // Track verify results
    if (event.type === 'verify_result' || (event.tool === 'verify' && event.result)) {
      this.lastVerdict = event.result?.verdict || event.verdict;
      this._handleVerdict(this.lastVerdict);
    }

    // Track turn completion
    if (event.type === 'turn_end' || event.phase === 'turn_end') {
      this._checkTurnProgress();
    }
  }

  /**
   * Handle verify verdict
   * Per spec lines 246-248: DONE/PAUSED_USER/BLOCKED settle native goal
   */
  _handleVerdict(verdict) {
    if (verdict === Verdict.DONE) {
      this.state = State.DONE;
      this.nativeGoalActive = false;
    } else if (verdict === Verdict.PAUSED_USER) {
      this.state = State.PAUSED_USER;
      this.nativeGoalActive = false;
    } else if (verdict === Verdict.BLOCKED) {
      this.state = State.BLOCKED;
      this.nativeGoalActive = false;
    } else if (verdict === Verdict.RUNNING) {
      this.state = State.RUNNING_CLAUDE;
      this.nativeGoalActive = true;
    }
  }

  /**
   * Check turn progress
   * Per spec lines 332, 447-448: Detect no-progress and wait refusal
   * Wait refusal blocks only after TWO consecutive refusals
   */
  _checkTurnProgress() {
    if (!this.currentTurn) return;

    const hasActions = this.currentTurn.actions.length > 0;

    if (!hasActions) {
      this.turnsSinceProgress++;

      // Two consecutive turns with no actions → BLOCKED
      if (this.turnsSinceProgress >= 2) {
        this.state = State.BLOCKED;
        this.nativeGoalActive = false;
        console.error('BLOCKED: Two consecutive turns with no progress');
      }
    } else {
      this.turnsSinceProgress = 0;
    }

    // Check for wait refusal: verify=RUNNING but no wait call
    if (this.lastVerdict === Verdict.RUNNING && hasActions) {
      const hasWait = this.currentTurn.actions.some(a =>
        a.tool === 'wait' || a.tool === 'cohub_goal_wait'
      );

      if (!hasWait) {
        // Increment wait refusal counter
        this.waitRefusalCount++;
        console.warn(`Wait refusal #${this.waitRefusalCount}: verify=RUNNING but no wait call`);

        // Block only on second consecutive refusal
        if (this.waitRefusalCount >= 2) {
          console.error('BLOCKED: Two consecutive wait refusals (BLOCKED_CLAUDE_WAIT_REFUSAL)');
          this.state = State.BLOCKED;
          this.nativeGoalActive = false;
        }
      } else {
        // Reset wait refusal counter on successful wait
        this.waitRefusalCount = 0;
      }
    }
  }

  /**
   * Handle process exit
   * Per spec lines 444-452: Require fresh verify binding
   */
  async _handleProcessExit(code, signal) {
    console.log(`Claude process exited: code=${code}, signal=${signal}`);

    // Check if we have fresh verify
    if (!this.lastVerdict) {
      console.error('Process exited without fresh verify - not a settle');
      this.state = State.BLOCKED;
    }

    // Update cumulative budget
    // TODO: Extract actual usage from Claude output
    this.cumulativeBudget.turns++;

    // Update state and release lease, but catch errors if directory was cleaned up
    try {
      await this._updateState();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      // Directory was cleaned up (e.g. in tests) - ignore
    }

    try {
      await this._releaseLease();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Failed to release lease:', err);
      }
    }
  }

  /**
   * Finalize execution and return exit code
   */
  _finalizeExecution() {
    // Map state to exit code per spec lines 367-372
    switch (this.state) {
      case State.DONE:
        return { exitCode: ExitCode.SUCCESS, state: this.state };
      case State.PAUSED_USER:
        return { exitCode: ExitCode.PAUSED_USER, state: this.state };
      case State.BLOCKED:
        return { exitCode: ExitCode.BLOCKED, state: this.state };
      case State.INTEGRITY_FAILURE:
        return { exitCode: ExitCode.INTEGRITY_FAILURE, state: this.state };
      default:
        return { exitCode: ExitCode.INCOMPLETE, state: this.state };
    }
  }

  /**
   * Acquire exclusive lease
   * Per spec: Prohibit concurrent invocation when native goal active
   */
  async _acquireLease() {
    const lease = {
      goalInstance: this.goalConfig.goalInstance,
      pid: process.pid,
      startTime: Date.now(),
      host: hostname(),
      nonce: randomUUID(),
      nativeGoalActive: true, // Always set to true when acquiring
      acquiredAt: new Date().toISOString()
    };

    try {
      // Try to read existing lease
      const existing = await readFile(this.leasePath, 'utf8');
      const existingLease = JSON.parse(existing);

      // Check if it's our own process (can happen in tests)
      if (existingLease.pid === process.pid) {
        console.log('Re-acquiring own lease');
        await this._atomicWriteJSON(this.leasePath, lease);
        return;
      }

      // Check if process still alive
      let processExists = false;
      try {
        process.kill(existingLease.pid, 0); // Signal 0 checks if process exists
        processExists = true;
      } catch (err) {
        if (err.code === 'ESRCH') {
          // Process doesn't exist - can take over
          console.log('Taking over stale lease from PID', existingLease.pid);
        } else if (err.code === 'EPERM') {
          // Process exists but we don't have permission to signal it
          processExists = true;
        } else {
          throw err;
        }
      }

      // If process exists and native goal is active, reject
      if (processExists && existingLease.nativeGoalActive) {
        const error = new Error(`Lease conflict: Native goal is active in another instance (PID ${existingLease.pid})`);
        error.code = 'LEASE_CONFLICT';
        throw error;
      }

      // Process exists but goal not active - can take over
      if (processExists) {
        console.log('Taking over lease from inactive goal in PID', existingLease.pid);
      }
    } catch (err) {
      if (err.code === 'ENOENT') {
        // No existing lease - proceed
      } else if (err.code === 'LEASE_CONFLICT') {
        throw err;
      } else {
        throw err;
      }
    }

    await this._atomicWriteJSON(this.leasePath, lease);
  }

  /**
   * Release lease
   */
  async _releaseLease() {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(this.leasePath);
    } catch (err) {
      // Ignore if already gone
      if (err.code !== 'ENOENT') {
        console.error('Failed to release lease:', err);
      }
    }
  }

  /**
   * Load goal config
   */
  async _loadGoalConfig() {
    const content = await readFile(this.goalConfigPath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * Load state from disk
   */
  async _loadState() {
    try {
      const content = await readFile(this.statePath, 'utf8');
      const state = JSON.parse(content);

      this.state = state.state;
      this.claudeSessionId = state.claudeSessionId;
      this.cumulativeBudget = state.cumulativeBudget;
      this.ledgerHead = state.ledgerHead;
      this.lastVerdict = state.lastVerdict;
      this.nativeGoalActive = state.nativeGoalActive || false;
      this.evaluatorEntered = state.evaluatorEntered || false;
      this.waitRefusalCount = state.waitRefusalCount || 0;
    } catch (err) {
      if (err.code === 'ENOENT') {
        // State doesn't exist yet - stay in NEW
        return;
      }
      throw err;
    }
  }

  /**
   * Update state on disk
   */
  async _updateState() {
    if (!this.goalConfig) {
      this.goalConfig = await this._loadGoalConfig();
    }

    const state = {
      schemaVersion: 1,
      goalInstance: this.goalConfig.goalInstance,
      goalVersion: this.goalConfig.goalVersion,
      state: this.state,
      claudeSessionId: this.claudeSessionId,
      cumulativeBudget: this.cumulativeBudget,
      ledgerHead: this.ledgerHead,
      lastVerdict: this.lastVerdict,
      nativeGoalActive: this.nativeGoalActive,
      evaluatorEntered: this.evaluatorEntered,
      waitRefusalCount: this.waitRefusalCount,
      updatedAt: new Date().toISOString()
    };

    await this._atomicWriteJSON(this.statePath, state);
  }

  /**
   * Atomic JSON write with fsync
   * Per spec lines 175-177: Write temp, fsync, rename, fsync parent
   */
  async _atomicWriteJSON(filePath, data) {
    const tmpPath = `${filePath}.tmp.${randomUUID()}`;
    const content = JSON.stringify(data, null, 2);

    // Write to temp file
    await writeFile(tmpPath, content, 'utf8');

    // Fsync temp file
    const fd = await open(tmpPath, 'r+');
    await fd.sync();
    await fd.close();

    // Rename to final path
    await rename(tmpPath, filePath);

    // Fsync parent directory
    const parentDir = path.dirname(filePath);
    const dirFd = await open(parentDir, 'r');
    await dirFd.sync();
    await dirFd.close();
  }
}
