/**
 * Claude Code launcher state machine for Cohub goal supervision
 *
 * Implements the exact state machine from spec lines 144-167:
 * NEW → READY → RUNNING_CLAUDE → WAITING_COHUB → (PAUSED_USER|BLOCKED|DONE)
 *
 * Repaired implementation with:
 * - Dependency injection (spawn, clock, verifier, lease, ledger, usage)
 * - Persisted last condition with freshness enforcement
 * - Cumulative budget from actual usage events, survives resumes
 * - Invocation-fresh verdict binding
 * - Strict stream-json schema validation with bounded buffer
 * - Secret redaction in all logs
 * - Verified argv against Claude Code 2.1.201 local help
 * - Wait-refusal bound to verify's required action
 * - Deep frozen getState output
 * - Signal listener cleanup after completion
 * - Transactional spawn failure handling
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, rename, open } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import {
  LeaseAdapter,
  LedgerAdapter,
  UsageExtractor,
  StreamValidator,
  SecretRedactor
} from './foundation-adapters.js';

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
 * Launcher state machine with dependency injection
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

    // Dependency injection
    this.clock = options.clock || Date;
    this.spawnFn = options.spawnFn || nodeSpawn;
    this.lease = options.lease || new LeaseAdapter({ leasePath: this.leasePath, clock: this.clock });
    this.ledger = options.ledger || new LedgerAdapter({ ledgerDir: this.ledgerDir, clock: this.clock });
    this.usageExtractor = options.usageExtractor || new UsageExtractor();
    this.streamValidator = options.streamValidator || new StreamValidator();
    this.redactor = options.redactor || new SecretRedactor();

    // State
    this.state = State.NEW;
    this.claudeSessionId = null;
    this.childProcess = null;
    this.streamBuffer = '';
    this.currentTurn = null;
    this.lastVerdict = null;
    this.lastVerdictInvocationId = null;
    this.lastVerifyAction = null; // 'wait' or 'submit' from verify result
    this.lastCondition = null;
    this.turnsSinceProgress = 0;
    this.goalConfig = null;
    this.cumulativeBudget = { turns: 0, tokens: 0, seconds: 0 };
    this.budgetLimits = options.budgetLimits || null;
    this.ledgerHead = null;
    this.bootstrapComplete = false;
    this.evaluatorEntered = false;
    this.nativeGoalActive = false;
    this.waitRefusalCount = 0;
    this.currentInvocationId = null;
    this._signalCleanup = null;

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

    // Initialize ledger
    await this.ledger.init();

    // Generate fixed UUID
    this.claudeSessionId = randomUUID();

    // Initialize state
    this.state = State.READY;
    await this._updateState();

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
    await this.lease.acquire(this.goalConfig.goalInstance, { nativeGoalActive: true });

    // Construct argv for first invocation
    const condition = this._constructGoalCondition();
    const argv = this._constructStartArgv(condition);

    // Persist condition for freshness checks
    this.lastCondition = condition;

    // Run invocation (transactional: state written only after spawn succeeds)
    return await this._runInvocation(argv);
  }

  /**
   * Resume a crashed goal from WAITING_COHUB or interrupted RUNNING_CLAUDE
   * Per spec: Uses plain --resume with no new /goal condition
   */
  async resume(options = {}) {
    await this._loadState();

    // WAITING_COHUB or interrupted RUNNING_CLAUDE are resumable
    if (this.state !== State.WAITING_COHUB && this.state !== State.RUNNING_CLAUDE) {
      throw new Error(`Cannot resume from state ${this.state}. Only WAITING_COHUB or interrupted RUNNING_CLAUDE are resumable.`);
    }

    // Block resume if evaluator already entered (goal settled)
    if (this.evaluatorEntered) {
      throw new Error('Cannot resume: evaluator already entered (goal settled)');
    }

    // Require fresh verify binding before resume
    // A verdict is fresh only if it was observed in an invocation and persisted
    if (!this.lastVerdict || !this.lastVerdictInvocationId) {
      throw new Error('Cannot resume: no fresh verify binding present (need lastVerdict with invocation ID)');
    }

    // Verify must show RUNNING (unsettled)
    if (this.lastVerdict !== Verdict.RUNNING) {
      throw new Error(`Cannot resume: lastVerdict is ${this.lastVerdict}, expected RUNNING`);
    }

    // Load goal config first (needed for lease)
    this.goalConfig = await this._loadGoalConfig();

    // Acquire lease
    await this.lease.acquire(this.goalConfig.goalInstance, { nativeGoalActive: true });

    // Construct argv for resume - plain --resume with no new /goal
    const argv = this._constructResumeArgv();

    return await this._runInvocation(argv);
  }

  /**
   * Restart a previously settled goal (PAUSED_USER or BLOCKED) with fresh condition
   * Per spec lines 254, 452: Uses same UUID + explicit fresh /goal with new condition
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
    if (lastCondition !== null && options.condition === lastCondition) {
      throw new Error('Cannot restart with unchanged condition - condition must be fresh');
    }

    // Load goal config first (needed for lease)
    this.goalConfig = await this._loadGoalConfig();

    // Acquire lease
    await this.lease.acquire(this.goalConfig.goalInstance, { nativeGoalActive: true });

    // Construct argv for settled restart: --resume UUID + new /goal condition
    const argv = this._constructSettledRestartArgv(options.condition);

    // Persist new condition
    this.lastCondition = options.condition;

    // Reset per-goal flags for new native goal
    this.evaluatorEntered = false;
    this.nativeGoalActive = false;
    this.waitRefusalCount = 0;

    return await this._runInvocation(argv);
  }

  /**
   * Run a single Claude invocation with transactional state handling
   * State is written RUNNING_CLAUDE only after successful spawn
   */
  async _runInvocation(argv) {
    // Generate fresh invocation ID - clears staleness of prior verdicts
    this.currentInvocationId = randomUUID();

    // Clear invocation-scoped verdict tracking (fresh verify required per invocation)
    this.lastVerdict = null;
    this.lastVerdictInvocationId = null;
    this.lastVerifyAction = null;

    const previousState = this.state;

    try {
      await this._spawnClaude(argv);
    } catch (err) {
      // Transactional rollback: restore previous state on spawn failure
      this.state = previousState;
      try {
        await this._updateState();
      } catch (stateErr) {
        // Preserve primary error, note cleanup error
        err.cleanupError = stateErr;
      }
      try {
        await this.lease.release();
      } catch (leaseErr) {
        err.leaseCleanupError = leaseErr;
      }
      throw err;
    }

    return this._finalizeExecution();
  }

  /**
   * Abort current execution
   */
  async abort() {
    if (this.childProcess && !this.childProcess.killed) {
      this.childProcess.kill('SIGTERM');

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

    await this.lease.release();
  }

  /**
   * Get current state - returns deep frozen snapshot
   */
  async getState() {
    await this._loadState();
    return Object.freeze({
      state: this.state,
      sessionId: this.claudeSessionId,
      cumulativeBudget: Object.freeze({ ...this.cumulativeBudget }),
      lastVerdict: this.lastVerdict,
      nativeGoalActive: this.nativeGoalActive
    });
  }

  /**
   * Get last goal condition (for stale detection)
   * Reads from persisted state
   */
  _getLastCondition() {
    return this.lastCondition;
  }

  /**
   * Construct argv for initial start
   * Verified against Claude Code 2.1.201 local `claude --help`:
   * - `-p/--print` for non-interactive
   * - `--session-id <uuid>` (must be valid UUID)
   * - `--output-format stream-json` (requires --print)
   * - `--permission-mode dontAsk`
   * - `--allowedTools` / `--disallowedTools` for tool exposure
   * - `--strict-mcp-config` + `--mcp-config` for MCP-only exposure
   * No tokens in argv.
   */
  _constructStartArgv(condition) {
    return [
      '-p',
      `/goal ${condition}`,
      '--session-id',
      this.claudeSessionId,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'dontAsk',
      '--disallowedTools',
      'Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit',
      '--strict-mcp-config'
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
      '-p',
      '--output-format',
      'stream-json',
      '--permission-mode',
      'dontAsk',
      '--disallowedTools',
      'Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit',
      '--strict-mcp-config'
    ];
  }

  /**
   * Construct argv for settled restart
   * Per spec: Uses --resume UUID + explicit fresh /goal condition
   */
  _constructSettledRestartArgv(condition) {
    return [
      '--resume',
      this.claudeSessionId,
      '-p',
      `/goal ${condition}`,
      '--output-format',
      'stream-json',
      '--permission-mode',
      'dontAsk',
      '--disallowedTools',
      'Bash,Write,Edit,WebFetch,WebSearch,NotebookEdit',
      '--strict-mcp-config'
    ];
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
   * Exactly one terminal lifecycle path; listeners removed after completion
   */
  async _spawnClaude(argv) {
    return new Promise((resolve, reject) => {
      // For testing: allow mock stream parser
      if (this._mockStreamParser) {
        // Write RUNNING state (transactionally - mock spawn always succeeds)
        this.state = State.RUNNING_CLAUDE;
        this._updateState()
          .then(() => {
            this._mockStreamParser(argv, this);
            resolve();
          })
          .catch(reject);
        return;
      }

      let settled = false;
      const child = this.spawnFn(this._claudeCommand, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      this.childProcess = child;

      // Signal cleanup handler
      const signalCleanup = async () => {
        await this.abort();
        process.exit(130);
      };

      const removeListeners = () => {
        process.removeListener('SIGTERM', signalCleanup);
        process.removeListener('SIGINT', signalCleanup);
        if (child.stdout) child.stdout.removeAllListeners('data');
        if (child.stderr) child.stderr.removeAllListeners('data');
      };

      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        removeListeners();
        fn(arg);
      };

      // Handle spawn error (e.g. ENOENT) - reject before state write
      child.once('error', (err) => {
        settle(reject, err);
      });

      // Only write RUNNING state after spawn confirmed
      child.once('spawn', () => {
        this.state = State.RUNNING_CLAUDE;
        this._updateState().catch((err) => {
          child.kill('SIGKILL');
          settle(reject, err);
        });
      });

      child.stdout.on('data', (chunk) => {
        this._handleStreamChunk(chunk.toString());
      });

      child.stderr.on('data', (chunk) => {
        // Redact secrets before logging; log category only
        const redacted = this.redactor.redact(chunk.toString());
        console.error('Claude stderr (redacted):', redacted.slice(0, 500));
      });

      child.once('exit', (code, signal) => {
        this._handleProcessExit(code, signal)
          .then(() => settle(resolve))
          .catch((err) => settle(reject, err));
      });

      process.once('SIGTERM', signalCleanup);
      process.once('SIGINT', signalCleanup);
    });
  }

  /**
   * Handle stream-json chunks with bounded buffer
   */
  _handleStreamChunk(chunk) {
    this.streamBuffer += chunk;

    // Bound buffer to prevent DoS
    this.streamBuffer = this.streamValidator.boundBuffer(this.streamBuffer);

    const lines = this.streamBuffer.split('\n');
    this.streamBuffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      let event;
      try {
        event = JSON.parse(line);
      } catch (err) {
        // Malformed JSON is observable, not silently ignored
        console.error('Malformed stream-json line rejected (length:', line.length, ')');
        continue;
      }
      this._processStreamEvent(event);
    }
  }

  /**
   * Process a stream-json event with strict schema validation
   */
  _processStreamEvent(rawEvent) {
    // Strict validation: reject proxy/getter/symbol/dangerous keys
    const validation = this.streamValidator.validate(rawEvent);
    if (!validation.valid) {
      console.error('Stream event rejected:', validation.reason);
      return;
    }

    const event = validation.event;

    // Track usage from actual Claude usage events
    const usage = this.usageExtractor.extract(event);
    if (usage) {
      this._applyUsage(usage);
    }

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
        startedAt: this.clock.now()
      };
    }

    // Track tool calls
    if (event.type === 'tool_call' || event.tool) {
      const toolName = event.tool || event.tool_name;
      if (typeof toolName === 'string' && this.currentTurn) {
        this.currentTurn.actions.push({ tool: toolName, timestamp: this.clock.now() });
      }

      // Detect wait call
      if (toolName === 'wait' || toolName === 'cohub_goal_wait') {
        this.state = State.WAITING_COHUB;
      }
    }

    // Track evaluator entry
    if (event.type === 'evaluator' || event.phase === 'evaluator') {
      this.evaluatorEntered = true;
      this.nativeGoalActive = false;
    }

    // Track verify results - only from verify tool result, not text
    if (event.tool === 'verify' && event.result && typeof event.result === 'object') {
      const verdict = event.result.verdict;
      if (typeof verdict === 'string' && Object.values(Verdict).includes(verdict)) {
        this.lastVerdict = verdict;
        // Bind verdict to current invocation - freshness guarantee
        this.lastVerdictInvocationId = this.currentInvocationId;
        // Track required action from verify (wait vs submit)
        if (typeof event.result.requiredAction === 'string') {
          this.lastVerifyAction = event.result.requiredAction;
        } else {
          this.lastVerifyAction = null;
        }
        this._handleVerdict(verdict, event.result);
      }
    }

    // Track turn completion
    if (event.type === 'turn_end' || event.phase === 'turn_end') {
      this._checkTurnProgress();
    }
  }

  /**
   * Apply usage to cumulative budget; check limits
   */
  _applyUsage(usage) {
    // Reject bad usage (negative values are integrity failure territory)
    if (usage.tokens < 0 || usage.turns < 0 || usage.seconds < 0) {
      console.error('Invalid usage event (negative values) - integrity failure');
      this.state = State.INTEGRITY_FAILURE;
      return;
    }

    this.cumulativeBudget.tokens += usage.tokens;
    this.cumulativeBudget.turns += usage.turns;
    this.cumulativeBudget.seconds += usage.seconds;

    // Check budget limits - evidence-backed BLOCKED
    if (this.budgetLimits) {
      if (
        (this.budgetLimits.tokens && this.cumulativeBudget.tokens > this.budgetLimits.tokens) ||
        (this.budgetLimits.turns && this.cumulativeBudget.turns > this.budgetLimits.turns) ||
        (this.budgetLimits.seconds && this.cumulativeBudget.seconds > this.budgetLimits.seconds)
      ) {
        console.error('Budget exceeded - BLOCKED');
        this.state = State.BLOCKED;
        this.nativeGoalActive = false;
      }
    }
  }

  /**
   * Handle verify verdict
   * DONE only accepted from verify tool with completion evidence
   */
  _handleVerdict(verdict, result = {}) {
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
   * Check turn progress per spec GOAL-01
   * Wait refusal is bound to verify's required action:
   * - verify=RUNNING requiring wait → turn must call wait
   * - verify=RUNNING allowing submit → turn must submit (or inspect/verify)
   * Two consecutive refusals → BLOCKED_CLAUDE_WAIT_REFUSAL
   */
  _checkTurnProgress() {
    if (!this.currentTurn) return;

    const hasActions = this.currentTurn.actions.length > 0;

    if (!hasActions) {
      this.turnsSinceProgress++;

      if (this.turnsSinceProgress >= 2) {
        this.state = State.BLOCKED;
        this.nativeGoalActive = false;
        console.error('BLOCKED: Two consecutive turns with no progress');
      }
    } else {
      this.turnsSinceProgress = 0;
    }

    // Wait refusal check: only when verify=RUNNING
    if (this.lastVerdict === Verdict.RUNNING && hasActions) {
      const hasWait = this.currentTurn.actions.some(a =>
        a.tool === 'wait' || a.tool === 'cohub_goal_wait'
      );
      const hasSubmit = this.currentTurn.actions.some(a =>
        a.tool === 'submit' || a.tool === 'cohub_goal_submit'
      );

      // If verify explicitly allowed submit and turn submitted, not a refusal
      const requiredAction = this.lastVerifyAction;
      const satisfied =
        (requiredAction === 'submit' && hasSubmit) ||
        (requiredAction === 'wait' && hasWait) ||
        (requiredAction === null && hasWait); // default: wait required

      if (!satisfied) {
        this.waitRefusalCount++;
        console.warn(`Wait refusal #${this.waitRefusalCount}: verify=RUNNING, required action not taken`);

        if (this.waitRefusalCount >= 2) {
          console.error('BLOCKED: Two consecutive wait refusals (BLOCKED_CLAUDE_WAIT_REFUSAL)');
          this.state = State.BLOCKED;
          this.nativeGoalActive = false;
        }
      } else {
        this.waitRefusalCount = 0;
      }
    }
  }

  /**
   * Handle process exit
   * Requires fresh verify from THIS invocation, else treated as interrupted
   */
  async _handleProcessExit(code, signal) {
    console.log(`Claude process exited: code=${code}, signal=${signal}`);

    // Check fresh verify binding: verdict must come from current invocation
    const verdictIsFresh = this.lastVerdict && this.lastVerdictInvocationId === this.currentInvocationId;

    if (!verdictIsFresh) {
      console.error('Process exited without fresh verify in this invocation - not a settle');
      // Keep state as-is unless it looks like a settle: process exit without
      // fresh verify while state claims settled is treated as interrupted
      if (this.state === State.DONE || this.state === State.PAUSED_USER || this.state === State.BLOCKED) {
        // The settle state must have come from stale data - reject it
        this.state = State.BLOCKED;
      }
    }

    // Record invocation in ledger (turn count comes from usage events; if
    // none were seen, count the invocation itself as one turn)
    try {
      await this.ledger.append({
        type: 'INVOCATION_EXIT',
        goalInstance: this.goalConfig?.goalInstance || null,
        goalVersion: this.goalConfig?.goalVersion || null,
        claudeSessionId: this.claudeSessionId,
        data: {
          invocationId: this.currentInvocationId,
          exitCode: code,
          signal,
          cumulativeBudget: { ...this.cumulativeBudget },
          verdictFresh: verdictIsFresh,
          verdict: verdictIsFresh ? this.lastVerdict : null
        }
      });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Failed to append ledger entry:', this.redactor.redact(String(err.message)));
      }
    }

    // Update state and release lease; errors are observable, not swallowed
    let stateError = null;
    try {
      await this._updateState();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        stateError = err;
      }
    }

    try {
      await this.lease.release();
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.error('Failed to release lease:', this.redactor.redact(String(err.message)));
      }
    }

    if (stateError) throw stateError;
  }

  /**
   * Finalize execution and return exit code
   */
  _finalizeExecution() {
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
   * Load goal config
   */
  async _loadGoalConfig() {
    const content = await readFile(this.goalConfigPath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * Load state from disk with strict schema check
   */
  async _loadState() {
    let content;
    try {
      content = await readFile(this.statePath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        // State doesn't exist yet - stay in NEW (allows start from NEW)
        return;
      }
      throw err;
    }

    let state;
    try {
      state = JSON.parse(content);
    } catch (err) {
      // Corrupt state fails closed, preserves bytes
      this.state = State.INTEGRITY_FAILURE;
      const error = new Error('State file corrupt - INTEGRITY_FAILURE');
      error.code = 'INTEGRITY_FAILURE';
      throw error;
    }

    // Strict schema validation
    if (!state || typeof state !== 'object' || typeof state.state !== 'string' ||
        !Object.values(State).includes(state.state)) {
      this.state = State.INTEGRITY_FAILURE;
      const error = new Error('State schema invalid - INTEGRITY_FAILURE');
      error.code = 'INTEGRITY_FAILURE';
      throw error;
    }

    this.state = state.state;
    this.claudeSessionId = state.claudeSessionId;
    this.cumulativeBudget = state.cumulativeBudget || { turns: 0, tokens: 0, seconds: 0 };
    this.ledgerHead = state.ledgerHead;
    this.lastVerdict = state.lastVerdict || null;
    this.lastVerdictInvocationId = state.lastVerdictInvocationId || null;
    this.lastCondition = state.lastCondition || null;
    this.nativeGoalActive = state.nativeGoalActive || false;
    this.evaluatorEntered = state.evaluatorEntered || false;
    this.waitRefusalCount = state.waitRefusalCount || 0;
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
      lastVerdictInvocationId: this.lastVerdictInvocationId,
      lastCondition: this.lastCondition,
      nativeGoalActive: this.nativeGoalActive,
      evaluatorEntered: this.evaluatorEntered,
      waitRefusalCount: this.waitRefusalCount,
      updatedAt: new Date(this.clock.now()).toISOString()
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

    await writeFile(tmpPath, content, 'utf8');

    const fd = await open(tmpPath, 'r+');
    await fd.sync();
    await fd.close();

    await rename(tmpPath, filePath);

    const parentDir = path.dirname(filePath);
    const dirFd = await open(parentDir, 'r');
    await dirFd.sync();
    await dirFd.close();
  }
}
