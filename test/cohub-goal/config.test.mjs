import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  validateGoalConfig,
  createGoalConfig,
  loadGoalConfig,
  ConfigValidationError,
  CONFIRMED_CLAUDE_CODE_VERSION,
  CONFIRMED_COHUB_CLI_VERSION,
  CONFIRMED_COHUB_SDK_VERSION,
} from '../../src/cohub-claude-goal/config.js';
import { IntegrityError } from '../../src/cohub-claude-goal/errors.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-config-'));
}

function baseConfig(overrides = {}) {
  return {
    schemaVersion: 1,
    goalInstance: 'yu-gi-oh-duel-monsters-v1',
    goalVersion: 1,
    mode: 'supervisor',
    spaceId: '7d8f6814-b123-410f-861f-67c07717ac68',
    parentSessionId: '0ba32795-ab95-443e-b8c6-c773388bd4b7',
    historicalParentSessionIds: ['5357ecbb-d695-4507-9efa-32cfea26123b'],
    runPath: 'workflow/workflow_space_seed/runs/yu-gi-oh-duel-monsters',
    statePath: 'workflow/workflow_space_seed/runs/yu-gi-oh-duel-monsters/orchestration_state.json',
    gateLogPath: 'workflow/workflow_space_seed/runs/yu-gi-oh-duel-monsters/stage_gate_log.json',
    manifestPath: 'workflow/workflow_space_seed/runs/yu-gi-oh-duel-monsters/run_manifest.json',
    legalHumanGates: ['proposal_approval', 'style_approval', 'studio_acceptance'],
    consumedHumanGates: ['proposal_approval', 'style_approval'],
    continuationAuthority: 'external_event_bridge',
    claudeCodeVersion: CONFIRMED_CLAUDE_CODE_VERSION,
    cohubCliVersion: CONFIRMED_COHUB_CLI_VERSION,
    cohubSdkVersion: CONFIRMED_COHUB_SDK_VERSION,
    ...overrides,
  };
}

test('validateGoalConfig accepts the canonical fixture', () => {
  assert.doesNotThrow(() => validateGoalConfig(baseConfig()));
});

test('validateGoalConfig rejects missing required field', () => {
  const cfg = baseConfig();
  delete cfg.spaceId;
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects unknown extra field', () => {
  const cfg = baseConfig({ extraField: 'nope' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects a token field even if named plausibly', () => {
  const cfg = baseConfig({ cohubAccessToken: 'secret' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects a command field', () => {
  const cfg = baseConfig({ shellCommand: 'rm -rf /' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects malformed spaceId UUID', () => {
  const cfg = baseConfig({ spaceId: 'not-a-uuid' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects malformed parentSessionId UUID', () => {
  const cfg = baseConfig({ parentSessionId: '12345' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects malformed entries in historicalParentSessionIds', () => {
  const cfg = baseConfig({ historicalParentSessionIds: ['not-a-uuid'] });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig accepts empty historicalParentSessionIds array', () => {
  const cfg = baseConfig({ historicalParentSessionIds: [] });
  assert.doesNotThrow(() => validateGoalConfig(cfg));
});

test('validateGoalConfig rejects absolute runPath', () => {
  const cfg = baseConfig({ runPath: '/etc/passwd' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects runPath with parent traversal', () => {
  const cfg = baseConfig({ runPath: '../../etc/passwd' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects statePath outside runPath', () => {
  const cfg = baseConfig({ statePath: 'workflow/other/state.json' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects gateLogPath with traversal even if textually prefixed', () => {
  const cfg = baseConfig({
    gateLogPath: 'workflow/workflow_space_seed/runs/yu-gi-oh-duel-monsters/../../../etc/passwd',
  });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects manifestPath with backslashes', () => {
  const cfg = baseConfig({
    manifestPath: 'workflow\\workflow_space_seed\\runs\\yu-gi-oh-duel-monsters\\run_manifest.json',
  });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects wrong claudeCodeVersion', () => {
  const cfg = baseConfig({ claudeCodeVersion: '9.9.9' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects wrong cohubCliVersion', () => {
  const cfg = baseConfig({ cohubCliVersion: '1.0.0' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects wrong cohubSdkVersion', () => {
  const cfg = baseConfig({ cohubSdkVersion: '1.0.0' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects mode other than supervisor', () => {
  const cfg = baseConfig({ mode: 'dual-conductor' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects continuationAuthority other than external_event_bridge', () => {
  const cfg = baseConfig({ continuationAuthority: 'legacy_prompt_watchdog' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects unknown human gate name', () => {
  const cfg = baseConfig({ legalHumanGates: ['proposal_approval', 'made_up_gate'] });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects duplicate legalHumanGates', () => {
  const cfg = baseConfig({ legalHumanGates: ['proposal_approval', 'proposal_approval', 'style_approval'] });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects consumedHumanGates not a subset of legalHumanGates', () => {
  const cfg = baseConfig({
    legalHumanGates: ['proposal_approval'],
    consumedHumanGates: ['proposal_approval', 'style_approval'],
  });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects duplicate consumedHumanGates', () => {
  const cfg = baseConfig({ consumedHumanGates: ['proposal_approval', 'proposal_approval'] });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects schemaVersion other than 1', () => {
  const cfg = baseConfig({ schemaVersion: 2 });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects non-integer goalVersion', () => {
  const cfg = baseConfig({ goalVersion: 1.5 });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects goalVersion less than 1', () => {
  const cfg = baseConfig({ goalVersion: 0 });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects unsafe goalInstance characters', () => {
  const cfg = baseConfig({ goalInstance: '../../etc/passwd' });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('createGoalConfig writes goal.json with mode 0600 in an empty directory', async () => {
  const dir = makeTempDir();
  const result = await createGoalConfig(dir, baseConfig());
  const goalPath = path.join(dir, 'goal.json');
  const stat = fs.statSync(goalPath);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.ok(result.hash);
  assert.match(result.hash, /^[0-9a-f]{64}$/);
});

test('createGoalConfig writes a hash sidecar file with mode 0600', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  const sidecarPath = path.join(dir, 'goal.json.sha256');
  const stat = fs.statSync(sidecarPath);
  assert.equal(stat.mode & 0o777, 0o600);
  const sidecarContent = fs.readFileSync(sidecarPath, 'utf8').trim();
  assert.match(sidecarContent, /^[0-9a-f]{64}$/);
});

test('createGoalConfig rereads bytes whose exact sha256 matches the returned hash', async () => {
  const dir = makeTempDir();
  const cfg = baseConfig();
  const result = await createGoalConfig(dir, cfg);
  const bytesOnDisk = fs.readFileSync(path.join(dir, 'goal.json'));
  const rereadHash = crypto.createHash('sha256').update(bytesOnDisk).digest('hex');
  assert.equal(rereadHash, result.hash, 'returned hash must be the sha256 of the exact reread on-disk bytes');
  const parsedBack = JSON.parse(bytesOnDisk.toString('utf8'));
  assert.deepEqual(parsedBack, cfg, 'reread bytes must still parse back to the original config value');
});

test('createGoalConfig refuses when goal.json already exists', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  await assert.rejects(() => createGoalConfig(dir, baseConfig()));
});

test('createGoalConfig refuses when target directory is nonempty with unrelated files', async () => {
  const dir = makeTempDir();
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'hi');
  await assert.rejects(() => createGoalConfig(dir, baseConfig()));
  assert.equal(fs.existsSync(path.join(dir, 'goal.json')), false);
});

test('createGoalConfig refuses when directory does not exist', async () => {
  const dir = path.join(makeTempDir(), 'missing');
  await assert.rejects(() => createGoalConfig(dir, baseConfig()));
});

test('createGoalConfig rejects an invalid config before writing anything', async () => {
  const dir = makeTempDir();
  const cfg = baseConfig({ mode: 'dual-conductor' });
  await assert.rejects(() => createGoalConfig(dir, cfg), ConfigValidationError);
  assert.equal(fs.existsSync(path.join(dir, 'goal.json')), false);
});

test('loadGoalConfig round-trips a config created by createGoalConfig', async () => {
  const dir = makeTempDir();
  const cfg = baseConfig();
  const created = await createGoalConfig(dir, cfg);
  const loaded = await loadGoalConfig(dir);
  assert.deepEqual(loaded.config, cfg);
  assert.equal(loaded.hash, created.hash);
});

test('loadGoalConfig throws IntegrityError when goal.json bytes were mutated after creation', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  const goalPath = path.join(dir, 'goal.json');
  const original = fs.readFileSync(goalPath, 'utf8');
  const mutated = original.replace('"goalVersion": 1', '"goalVersion": 2');
  fs.writeFileSync(goalPath, mutated);
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});

test('loadGoalConfig throws IntegrityError when the hash sidecar is missing', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  fs.unlinkSync(path.join(dir, 'goal.json.sha256'));
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});

test('loadGoalConfig throws IntegrityError on malformed JSON', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  fs.writeFileSync(path.join(dir, 'goal.json'), '{not valid json');
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});

test('loadGoalConfig throws when goal.json does not exist', async () => {
  const dir = makeTempDir();
  await assert.rejects(() => loadGoalConfig(dir));
});

test('validateGoalConfig rejects a class instance even though typeof is "object" and it is not an array', () => {
  class FakeConfig {
    constructor(fields) {
      Object.assign(this, fields);
    }
  }
  const cfg = new FakeConfig(baseConfig());
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects an object with a custom (non-Object.prototype) prototype', () => {
  const customProto = { someMethod() {} };
  const cfg = Object.assign(Object.create(customProto), baseConfig());
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('validateGoalConfig rejects a config carrying an own "__proto__" data key', () => {
  const cfg = baseConfig();
  Object.defineProperty(cfg, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
    writable: true,
  });
  assert.throws(() => validateGoalConfig(cfg), ConfigValidationError);
});

test('createGoalConfig writes goal.json bytes that hash to exactly the returned hash, and the sidecar stores that exact byte hash', async () => {
  const dir = makeTempDir();
  const result = await createGoalConfig(dir, baseConfig());
  const rawBytes = fs.readFileSync(path.join(dir, 'goal.json'));
  const rawHash = crypto.createHash('sha256').update(rawBytes).digest('hex');
  assert.equal(rawHash, result.hash, 'returned hash must be the sha256 of the exact on-disk goal.json bytes');
  const sidecarHash = fs.readFileSync(path.join(dir, 'goal.json.sha256'), 'utf8').trim();
  assert.equal(sidecarHash, rawHash);
});

test('loadGoalConfig throws IntegrityError on a whitespace-only (semantically-equivalent) mutation of goal.json', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  const goalPath = path.join(dir, 'goal.json');
  const original = fs.readFileSync(goalPath, 'utf8');
  const parsed = JSON.parse(original);
  const rewrittenSameValue = JSON.stringify(parsed, null, 4); // different indentation, same semantic value
  fs.writeFileSync(goalPath, rewrittenSameValue);
  const before = fs.readFileSync(goalPath);
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
  const after = fs.readFileSync(goalPath);
  assert.deepEqual(before, after, 'corrupt bytes must be preserved, never repaired or deleted');
});

test('loadGoalConfig throws IntegrityError on a duplicate-JSON-key mutation that parses to the same semantic value', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  const goalPath = path.join(dir, 'goal.json');
  const original = fs.readFileSync(goalPath, 'utf8');
  // Insert a duplicate "goalVersion" key with the same value right after the first occurrence.
  // JSON.parse keeps the last value ("last value wins"), so this parses identically,
  // but the raw bytes differ from what was hashed at creation time.
  const mutated = original.replace('"goalVersion": 1,', '"goalVersion": 1,\n  "goalVersion": 1,');
  assert.notEqual(mutated, original, 'test setup sanity: mutation must actually change bytes');
  fs.writeFileSync(goalPath, mutated);
  const before = fs.readFileSync(goalPath);
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
  const after = fs.readFileSync(goalPath);
  assert.deepEqual(before, after);
});

test('loadGoalConfig throws IntegrityError when goal.json is a symlink instead of a regular file', async () => {
  const dir = makeTempDir();
  const realDir = makeTempDir();
  await createGoalConfig(realDir, baseConfig());
  fs.copyFileSync(path.join(realDir, 'goal.json.sha256'), path.join(dir, 'goal.json.sha256'));
  fs.chmodSync(path.join(dir, 'goal.json.sha256'), 0o600);
  fs.symlinkSync(path.join(realDir, 'goal.json'), path.join(dir, 'goal.json'));
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});

test('loadGoalConfig throws IntegrityError when goal.json has the wrong file mode', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  fs.chmodSync(path.join(dir, 'goal.json'), 0o644);
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});

test('loadGoalConfig throws IntegrityError when the hash sidecar is a symlink instead of a regular file', async () => {
  const dir = makeTempDir();
  const realDir = makeTempDir();
  await createGoalConfig(realDir, baseConfig());
  fs.copyFileSync(path.join(realDir, 'goal.json'), path.join(dir, 'goal.json'));
  fs.chmodSync(path.join(dir, 'goal.json'), 0o600);
  fs.symlinkSync(path.join(realDir, 'goal.json.sha256'), path.join(dir, 'goal.json.sha256'));
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});

test('loadGoalConfig throws IntegrityError when the hash sidecar has the wrong file mode', async () => {
  const dir = makeTempDir();
  await createGoalConfig(dir, baseConfig());
  fs.chmodSync(path.join(dir, 'goal.json.sha256'), 0o644);
  await assert.rejects(() => loadGoalConfig(dir), IntegrityError);
});
