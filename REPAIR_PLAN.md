# Cohub Claude Goal Launcher Repair Plan

## Acceptance Rejection Summary

Commit `fcaaa8b` rejected due to 15+ confirmed defects in launcher implementation.

## Critical Defects (Must Fix)

### 1. **_getLastCondition always returns null**
- **Impact**: Settled condition freshness not enforced
- **Fix**: Persist last condition in state, compare on restart

### 2. **Cumulative budget is TODO**
- **Impact**: Token/time budgets reset on native resume
- **Fix**: Parse usage events from stream-json, persist in ledger

### 3. **lastVerdict not invocation-fresh**
- **Impact**: Stale verdicts can authorize resume/settle
- **Fix**: Bind verdict to invocation ID, clear on new spawn

### 4. **Malformed stream-json silently skipped**
- **Impact**: Lost events, untrusted shapes accessed directly
- **Fix**: Strict schema validation, bounded buffer, reject invalid

### 5. **Arbitrary stderr logged**
- **Impact**: Token leakage risk
- **Fix**: Redact secrets, log only categories

### 6. **Argv not proven against Claude 2.1.201**
- **Impact**: Conceptual flags, may not work
- **Fix**: Use exact flags from local `claude --help`

### 7. **wait-refusal logic incorrect**
- **Impact**: Any action counts as progress
- **Fix**: Bind to verify's required action (wait vs submit)

### 8. **getState returns mutable references**
- **Impact**: Caller can mutate internal state
- **Fix**: Deep freeze return values

### 9. **Signal listeners accumulate**
- **Impact**: Memory leak, double-settlement
- **Fix**: Remove listeners in finally block

### 10. **Spawn failure not transactional**
- **Impact**: State written RUNNING before spawn, not rolled back
- **Fix**: Write RUNNING only after spawn succeeds

## Architecture Changes Required

### Dependency Injection
Current implementation has no DI, making tests non-deterministic. Required injections:

```javascript
{
  clock: { now: () => Date },
  spawn: (cmd, args) => ChildProcess,
  ledger: { append, read },
  lease: { acquire, release },
  verifier: { verify },
  reconciler: { reconcile },
  usageExtractor: { extract }
}
```

### Foundation Modules (Adapters)
Spec requires using foundation lease/ledger contracts, not duplicating them:

- **src/cohub-claude-goal/foundation-adapter.js**: Adapter to future foundation modules
- For now: inline minimal implementations that match foundation interface
- When foundation lands: swap to real imports

### State Machine Fixes
- One persisted state with exact legal transitions
- Deep strict schema parsing
- Corrupt/missing state fails closed

### Stream Processing
- Strict event schema validation
- Bounded buffer (max 1MB)
- Reject proxy/getter/symbol/dangerous keys
- Detached/frozen outputs

### Ledger
- Append-only with fsync
- Track: turns, tokens, seconds, invocation ID, condition, verdict
- No stub TODOs

## Implementation Order

1. **Create foundation adapter stubs** (lease, ledger)
2. **Fix critical data flow**:
   - lastCondition persistence
   - Usage event parsing
   - Invocation-fresh verdict
3. **Harden stream processing**:
   - Schema validation
   - Buffer bounds
   - Secret redaction
4. **Fix control flow**:
   - wait-refusal logic
   - Spawn transaction
   - Signal cleanup
5. **Freeze outputs**: Deep freeze getState
6. **Validate argv**: Snapshot test against local Claude
7. **Run all tests**: Confirm red → green

## Test Strategy

- All tests under 2s timeout
- No network/production access
- Deterministic with injected deps
- Red tests exist, confirm they fail
- Implement fixes, confirm they pass
- Run original acceptance suite

## Acceptance Criteria

- All 10 defect tests pass
- Original 50 tests still pass
- No TODO/stub/fallback in critical paths
- Git status clean
- Commit with evidence

## Non-Goals (Out of Scope)

- Full Cohub integration (MCP bridge)
- Workflow external mode
- Real Claude 2.1.201 integration tests
- Production deployment

This repair focuses on **launcher state machine only**, with proper architecture for future integration.
