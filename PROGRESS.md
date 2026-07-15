# Cohub Claude Goal Launcher Repair - Progress Report

## Completed Work

### 1. Port Interface Specifications (✓)
- **File**: `src/cohub-claude-goal/ports.js`
- Defined strict port interfaces for all dependencies
- Implemented `validateInput()` with proxy detection using `util.types.isProxy()`
- Implemented `deepFreeze()` and `deepDetach()` for immutability
- Created closed `ErrorCategory` enum with `createError()` helper

### 2. Stream Parser for Real Claude 2.1.201 Shapes (✓)
- **File**: `src/cohub-claude-goal/stream-parser.js`
- Parses actual stream-json events from fixtures
- Extracts:
  - System init (`type:"system", subtype:"init"` with tools array)
  - Tool use (`message.content[].type:"tool_use"`)
  - Tool result (`message.content[].type:"tool_result"` with bound `tool_use_id`)
  - Usage (`type:"result"` with `modelUsage`)
- Bounded buffer (1MB line, 10MB buffer)
- Deep freezes all parsed events
- Rejects malformed JSON, oversized events

### 3. Verifier Extractor for Tool Results (✓)
- **File**: `src/cohub-claude-goal/verifier-extractor.js`
- Extracts verdict from `tool_result.contentText` (JSON string)
- Maps `status:"ACHIEVED"` → `Verdict.DONE`
- Maps `status:"RUNNING"` → `Verdict.RUNNING` (with `requiredAction`)
- Maps `status:"PAUSED_USER"` → `Verdict.PAUSED_USER`
- Maps `status:"BLOCKED"` → `Verdict.BLOCKED`
- Validates against closed verdict set
- Deep freezes results with `rawResult` preservation

### 4. Test Coverage (✓)
- **`test/cohub-claude-goal/stream-parser.test.mjs`**: 10 tests, all passing
  - Uses actual fixture files from CAP-GOAL-01-02
  - Validates real event shapes
  - Tests error handling
- **`test/cohub-claude-goal/verifier-extractor.test.mjs`**: 14 tests, all passing
  - Tests all verdict mappings
  - Tests error cases (missing contentText, malformed JSON, unknown status)
  - Tests requiredAction and evidenceRefs extraction

### 5. RED Tests for Repair Validation (✓)
- **File**: `test/cohub-claude-goal/repair-red.test.mjs`
- Tests that MUST FAIL on old implementation, PASS after repair:
  1. Port injection is mandatory (no fallback to foundation-adapters)
  2. Real stream shapes (not invented `event.tool`, `event.type='tool_call'`)
  3. Abort lifecycle (SIGKILL after grace despite `child.killed=true`)
  4. Env allowlist (not `{...process.env}`)
  5. Argv validation (`--verbose`, `--mcp-config`, exact 4 MCP tools)
  6. DONE only from matched tool_use + tool_result
  7. Capability gate on system init tools
  8. Malformed JSON → INTEGRITY_FAILURE (not log-and-continue)

### 6. Test Helpers (✓)
- **File**: `test/cohub-claude-goal/helpers.mjs`
- `makeFakePorts()` - creates in-memory port implementations for testing
- `makeChild()` - creates fake child process with controllable streams
- `feedStream()` - feeds stream-json events to child stdout
- `REAL_INIT_EVENT` - actual system init shape from fixtures

## Remaining Work

### 1. Complete Launcher Rewrite (CRITICAL)
The current `src/cohub-claude-goal/launcher.js` must be completely rewritten:

**Constructor changes:**
- REQUIRE all ports as constructor dependencies (state, ledger, lease, spawn, streamParser, verifier, renderer, clock)
- Reject proxies/getters in all inputs using `validateInput()`
- No default/fallback implementations

**Stream parsing changes:**
- Use injected `streamParser` port
- Track tool_use events in `pendingToolUses` map
- Bind tool_result by `tool_use_id` to prior tool_use
- Unmatched tool_result → INTEGRITY_FAILURE
- Extract verify verdict only from matched verify tool_result
- Malformed JSON / unknown critical shape → INTEGRITY_FAILURE
- Usage extraction from `type:"result"` modelUsage

**Abort lifecycle changes:**
- Single lifecycle promise
- Exit-observed flag (not `child.killed` property)
- SIGTERM → wait termGraceMs → SIGKILL if not exited
- Clean up signal listeners after settlement
- Reject timer promises on abort

**Argv construction changes:**
- Add `--verbose` (required for stream-json with -p)
- Add `--mcp-config` with explicit file path
- Add `--strict-mcp-config`
- Add `--allowedTools` with exactly 4 MCP tools (not disallowedTools)
- Minimal env allowlist (PATH, HOME, TMPDIR only)
- Never inherit full `process.env`

**State machine changes:**
- `start()` only from NEW/READY
- `resume()` only from WAITING_COHUB/interrupted RUNNING_CLAUDE with fresh verify binding
- `restartSettled()` only from PAUSED_USER/BLOCKED with fresh condition
- DONE never spawns again
- Fresh verify required per invocation (bound by invocationId)

**Capability gate:**
- Validate system init tools array equals exactly 4 MCP tools
- Fail with exit code 50 on mismatch

### 2. Delete foundation-adapters.js (CRITICAL)
- **File to delete**: `src/cohub-claude-goal/foundation-adapters.js`
- This file contains unsafe fake implementations
- Must be removed entirely

### 3. Update Existing Tests (MEDIUM)
- **File**: `test/cohub-claude-goal-launcher.test.mjs`
- Update to use new constructor signature with required ports
- Add tests for new stream parsing behavior
- Add tests for capability gate

### 4. Integration Tests with Real Fixtures (MEDIUM)
- Create tests that replay actual fixture streams
- Verify cumulative usage across process restarts
- Verify UUID persistence
- Verify ledger chain

### 5. Documentation (LOW)
- Update README with port injection requirements
- Document stream-json event shapes
- Document capability gate requirements

## Test Results Summary

### Passing Tests
- `test/cohub-claude-goal/stream-parser.test.mjs`: 10/10 ✓
- `test/cohub-claude-goal/verifier-extractor.test.mjs`: 14/14 ✓
- `test/cohub-claude-goal-launcher.test.mjs`: 50/50 ✓ (OLD implementation)

### Failing Tests (Expected)
- `test/cohub-claude-goal/repair-red.test.mjs`: Not yet run (will fail on old launcher, pass after repair)

## Critical Next Steps

1. **Rewrite launcher.js** with port injection (this is the largest piece)
2. **Delete foundation-adapters.js**
3. **Run repair-red.test.mjs** to confirm RED state
4. **Implement fixes** to make repair tests GREEN
5. **Update existing launcher tests** for new constructor
6. **Run full test suite** and verify no regressions
7. **Commit** with evidence from repeated test runs

## Estimated Remaining Effort

- Launcher rewrite: ~2000-3000 lines of code
- Test updates: ~500 lines
- Integration tests: ~500 lines
- Documentation: ~200 lines
- **Total**: ~3000-4000 lines, ~30-40K tokens

Given token budget (108K remaining) and complexity, this is feasible but requires focused implementation.

## Key Design Decisions

1. **Port-first architecture**: Launcher is a pure orchestrator with no I/O dependencies
2. **Exact stream shapes**: Only parse proven Claude 2.1.201 event structures
3. **Fail-closed integrity**: Unknown/malformed events are INTEGRITY_FAILURE, not warnings
4. **Invocation-scoped freshness**: Verify verdict expires at process boundary
5. **Capability gate**: Exact tool allowlist is enforced at init, not runtime
6. **Minimal env**: Only PATH/HOME/TMPDIR, never full process.env
7. **Deep immutability**: All outputs frozen recursively, no shared references

## Evidence Requirements

Each commit must include:
- Failing test showing the defect (RED)
- Minimal fix making it pass (GREEN)
- Repeated runs proving no flakes
- Clean worktree
- Exit code evidence from actual runs
