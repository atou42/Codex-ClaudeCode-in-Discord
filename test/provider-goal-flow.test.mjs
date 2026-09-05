import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildProviderGoalCommand,
  parseProviderGoalSlashInput,
  providerSupportsNativeGoalSlash,
} from '../src/provider-goal-flow.js';

test('providerSupportsNativeGoalSlash exposes native goal providers with safe Discord transports', () => {
  assert.equal(providerSupportsNativeGoalSlash('claude'), true);
  assert.equal(providerSupportsNativeGoalSlash('grok'), true);
  assert.equal(providerSupportsNativeGoalSlash('zcode'), true);
  assert.equal(providerSupportsNativeGoalSlash('omp'), true);
});

test('buildProviderGoalCommand maps Claude goal actions to its native command forms', () => {
  assert.equal(buildProviderGoalCommand({
    provider: 'claude',
    objective: 'ship the Discord bridge',
  }), '/goal ship the Discord bridge');
  assert.equal(buildProviderGoalCommand({ provider: 'claude', action: 'status' }), '/goal');
  assert.equal(buildProviderGoalCommand({ provider: 'claude', action: 'clear' }), '/goal clear');
  assert.throws(
    () => buildProviderGoalCommand({ provider: 'claude', action: 'pause' }),
    /does not support action: pause/,
  );
});

test('buildProviderGoalCommand maps OMP actions to its interactive native goal commands', () => {
  assert.equal(buildProviderGoalCommand({
    provider: 'omp',
    objective: 'ship the Discord bridge',
  }), '/goal set ship the Discord bridge');
  assert.equal(buildProviderGoalCommand({ provider: 'omp', action: 'status' }), '/goal show');
  assert.equal(buildProviderGoalCommand({ provider: 'omp', action: 'pause' }), '/goal pause');
  assert.equal(buildProviderGoalCommand({ provider: 'omp', action: 'resume' }), '/goal resume');
  assert.equal(buildProviderGoalCommand({ provider: 'omp', action: 'clear' }), '/goal drop');
});

test('buildProviderGoalCommand maps Grok goal actions without turning them into normal prompts', () => {
  assert.equal(buildProviderGoalCommand({
    provider: 'grok',
    objective: 'ship the Discord bridge',
    tokenBudget: '120000',
  }), '/goal ship the Discord bridge --budget 120000');
  assert.equal(buildProviderGoalCommand({ provider: 'grok', action: 'status' }), '/goal status');
  assert.equal(buildProviderGoalCommand({ provider: 'grok', action: 'clear' }), '/goal clear');
});

test('buildProviderGoalCommand uses ZCode headless replacement and status forms', () => {
  assert.equal(buildProviderGoalCommand({
    provider: 'zcode',
    objective: 'ship the Discord bridge',
  }), '/goal replace ship the Discord bridge');
  assert.equal(buildProviderGoalCommand({ provider: 'zcode', action: 'status' }), '/goal');
  assert.equal(buildProviderGoalCommand({ provider: 'zcode', action: 'pause' }), '/goal pause');
});

test('parseProviderGoalSlashInput rejects missing objectives and unsupported budget fields', () => {
  assert.throws(
    () => parseProviderGoalSlashInput({ provider: 'grok', action: 'set' }),
    /goal objective is required/,
  );
  assert.throws(
    () => parseProviderGoalSlashInput({ provider: 'zcode', action: 'set', objective: 'work', tokenBudget: '10' }),
    /does not support token_budget/,
  );
  assert.throws(
    () => parseProviderGoalSlashInput({ provider: 'grok', action: 'set', objective: 'work', tokenBudget: 'nope' }),
    /positive integer/,
  );
});
