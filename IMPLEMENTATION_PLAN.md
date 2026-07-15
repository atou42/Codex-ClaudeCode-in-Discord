# Claude Goal Launcher Repair Plan

## Critical Defects to Fix

### 1. Remove fake foundation-adapters.js
- Delete unsafe pathname lease replacement/unlink
- Delete ledger with no validation
- Launcher constructor MUST require exact port instances
- No fallback implementations

### 2. Fix stream-json parsing (actual Claude 2.1.201 shapes)
Real shapes from fixtures:
```json
{"type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_...","name":"mcp__fixture__verify_goal","input":{}}]}}
{"type":"user","message":{"content":[{"tool_use_id":"toolu_...","type":"tool_result","content":[{"type":"text","text":"..."}]}]}}
```

NOT invented:
- `event.type = 'tool_call'` (doesn't exist)
- `event.tool` field (doesn't exist)
- `event.type = 'turn_end'` (doesn't exist)
- `event.type = 'evaluator'` (doesn't exist)

Real detection:
- tool_use: `message.content[]` array with `type:"tool_use"`
- tool_result: `message.content[]` array with `type:"tool_result"` + `tool_use_id`
- verify verdict: Extract from tool_result content text (JSON string inside)
- system init: `type:"system", subtype:"init"` with `tools[]` array
- result event: `type:"result", subtype:"success"` with `modelUsage`

### 3. Fix abort lifecycle
Current bug:
```javascript
if (this.childProcess && !this.childProcess.killed) {
  this.childProcess.kill('SIGTERM');
  setTimeout(() => {
    if (this.childProcess && !this.childProcess.killed) {  // BUG: killed=true after SIGTERM
      this.childProcess.kill('SIGKILL');  // Never reached!
    }
  }, 5000);
}
```

Fix: Use exit-observed flag, not `.killed` property

### 4. Implement strict port validation
- Use `util.types.isProxy()` from node:util
- Check property descriptors for getters/setters
- Validate all inputs before any traps
- Deep freeze all outputs
- Closed error categories only

### 5. Extract verify verdict from actual tool_result structure
```javascript
// Real shape from fixture:
{
  "type": "user",
  "message": {
    "content": [{
      "tool_use_id": "toolu_...",
      "type": "tool_result",
      "content": [{
        "type": "text",
        "text": "{\"ok\":true,\"status\":\"ACHIEVED\",...}"
      }]
    }]
  }
}
```

Must parse `content[0].text` as JSON, validate schema, extract verdict.

## Test-First Implementation Order

1. **Port validation tests** (RED → GREEN)
   - Reject proxy inputs
   - Reject getter/setter objects
   - Reject oversized strings
   - Reject negative numbers
   - Deep freeze outputs

2. **Stream parser tests** (RED → GREEN)
   - Parse actual system init shape
   - Parse actual tool_use shape
   - Parse actual tool_result shape
   - Extract verify verdict from tool_result.content[0].text
   - Reject malformed JSON
   - Reject unknown critical shapes

3. **Abort lifecycle tests** (RED → GREEN)
   - SIGTERM → wait → SIGKILL if not exited
   - Don't check `.killed` property
   - Use exit-observed flag
   - Single lifecycle promise
   - Clean up signal listeners

4. **State machine tests** (RED → GREEN)
   - start() only from NEW/READY
   - resume() only from WAITING_COHUB/interrupted RUNNING_CLAUDE
   - restartSettled() only from PAUSED_USER/BLOCKED with fresh condition
   - DONE never spawns again
   - Fresh verify required before resume

5. **Integration tests** (RED → GREEN)
   - Use fixture stream files directly
   - Verify cumulative usage across restarts
   - Verify no concurrent invocations
   - Verify UUID persistence
   - Verify ledger chain

## Files to Create/Modify

### Create:
- `src/cohub-claude-goal/ports.js` ✓ (created, needs proxy fix)
- `src/cohub-claude-goal/stream-parser.js` (NEW - parse real shapes)
- `src/cohub-claude-goal/verifier-extractor.js` (NEW - extract from tool_result)
- `test/cohub-claude-goal/ports.test.mjs` (NEW)
- `test/cohub-claude-goal/stream-parser.test.mjs` (NEW)
- `test/cohub-claude-goal/abort-lifecycle.test.mjs` (NEW)

### Delete:
- `src/cohub-claude-goal/foundation-adapters.js` (REMOVE entirely)

### Modify:
- `src/cohub-claude-goal/launcher.js` (complete rewrite with port injection)
- `test/cohub-claude-goal-launcher.test.mjs` (add RED tests first)

## Commit Strategy

Each commit is atomic with:
1. RED test showing the defect
2. Minimal fix to make it GREEN
3. Evidence from repeated runs (no flakes)
4. Clean worktree

## Non-Goals for V1

- Real Cohub MCP bridge (out of scope)
- Real foundation implementations (production wiring, not launcher concern)
- WebSocket subscription (MCP bridge concern)
- Actual Claude process spawning in tests (use controlled fixtures)
