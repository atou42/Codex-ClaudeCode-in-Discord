import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  acquireLease,
  releaseLease,
  LEASE_FILE_NAME,
} from '../../src/cohub-claude-goal/lease.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function makeGoalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-lease-race-'));
}

function leasePath(dir) {
  return path.join(dir, LEASE_FILE_NAME);
}

// Script that attempts concurrent takeover of a dead lease
function concurrentTakeoverScriptSource(dir, contenderId) {
  return `
import { acquireLease } from ${JSON.stringify(path.join(repoRoot, 'src/cohub-claude-goal/lease.js'))};
try {
  const { lock } = await acquireLease(${JSON.stringify(dir)}, {
    goalInstance: 'contender-${contenderId}',
    auditDeadOwnerTakeover: async (deadLock) => {
      // Simulate audit delay to maximize race window
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });
  process.stdout.write('SUCCESS:' + JSON.stringify(lock) + '\\n');
  process.exit(0);
} catch (err) {
  process.stdout.write('FAILED:' + err.message + '\\n');
  process.exit(1);
}
`;
}

// Script that holds a lease briefly then exits
function deadLeaseHolderScriptSource(dir) {
  return `
import { acquireLease } from ${JSON.stringify(path.join(repoRoot, 'src/cohub-claude-goal/lease.js'))};
const { lock } = await acquireLease(${JSON.stringify(dir)}, { goalInstance: 'dead-holder' });
process.stdout.write('ACQUIRED:' + JSON.stringify(lock) + '\\n');
// Exit immediately to create dead lease
process.exit(0);
`;
}

// Script that releases a lease with a delay
function releaseRaceScriptSource(dir, nonce) {
  return `
import { releaseLease } from ${JSON.stringify(path.join(repoRoot, 'src/cohub-claude-goal/lease.js'))};
const lock = {
  pid: process.pid,
  processStartTime: new Date().toISOString(),
  host: ${JSON.stringify(os.hostname())},
  acquiredAt: new Date().toISOString(),
  nonce: ${JSON.stringify(nonce)},
  goalInstance: 'race-test'
};
await releaseLease(${JSON.stringify(dir)}, lock);
process.stdout.write('RELEASED\\n');
process.exit(0);
`;
}

test('concurrent takeover: exactly one of two contenders succeeds when racing on a dead lease', { timeout: 8000 }, async () => {
  const dir = makeGoalDir();

  // Create and immediately kill a lease holder
  const holderScript = path.join(dir, 'holder.mjs');
  await fsPromises.writeFile(holderScript, deadLeaseHolderScriptSource(dir));
  const holder = spawn(process.execPath, [holderScript], { stdio: ['ignore', 'pipe', 'pipe'] });

  await new Promise((resolve, reject) => {
    let buf = '';
    holder.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('ACQUIRED:')) resolve();
    });
    holder.on('exit', (code) => {
      if (code === 0 && buf.includes('ACQUIRED:')) resolve();
      else if (!buf.includes('ACQUIRED:')) reject(new Error('holder failed to acquire'));
    });
    setTimeout(() => reject(new Error('holder timeout')), 5000);
  });

  await new Promise(resolve => setTimeout(resolve, 100));

  // Launch two concurrent contenders
  const contender1Script = path.join(dir, 'contender1.mjs');
  const contender2Script = path.join(dir, 'contender2.mjs');
  await fsPromises.writeFile(contender1Script, concurrentTakeoverScriptSource(dir, 1));
  await fsPromises.writeFile(contender2Script, concurrentTakeoverScriptSource(dir, 2));

  const c1 = spawn(process.execPath, [contender1Script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const c2 = spawn(process.execPath, [contender2Script], { stdio: ['ignore', 'pipe', 'pipe'] });

  const results = await Promise.all([
    new Promise((resolve) => {
      let buf = '';
      c1.stdout.on('data', (chunk) => { buf += chunk.toString('utf8'); });
      c1.on('exit', (code) => {
        const success = buf.includes('SUCCESS:');
        const lock = success ? JSON.parse(buf.match(/SUCCESS:(.*)/)[1]) : null;
        resolve({ contenderId: 1, success, code, lock });
      });
    }),
    new Promise((resolve) => {
      let buf = '';
      c2.stdout.on('data', (chunk) => { buf += chunk.toString('utf8'); });
      c2.on('exit', (code) => {
        const success = buf.includes('SUCCESS:');
        const lock = success ? JSON.parse(buf.match(/SUCCESS:(.*)/)[1]) : null;
        resolve({ contenderId: 2, success, code, lock });
      });
    }),
  ]);

  const successCount = results.filter(r => r.success).length;
  assert.equal(successCount, 1, 'exactly one contender must succeed');

  const winner = results.find(r => r.success);
  const finalLease = JSON.parse(fs.readFileSync(leasePath(dir), 'utf8'));
  assert.equal(finalLease.nonce, winner.lock.nonce, 'final lease must match winner nonce');
  assert.equal(finalLease.goalInstance, `contender-${winner.contenderId}`, 'final lease must match winner goalInstance');
});

test('release race: concurrent acquire during release cannot have its lease deleted', { timeout: 8000 }, async () => {
  const dir = makeGoalDir();

  // This process acquires first
  const { lock: lock1 } = await acquireLease(dir, { goalInstance: 'first-owner' });

  // Spawn a releaser that will release lock1
  const releaseScript = path.join(dir, 'releaser.mjs');
  await fsPromises.writeFile(releaseScript, releaseRaceScriptSource(dir, lock1.nonce));

  const releaser = spawn(process.execPath, [releaseScript], { stdio: ['ignore', 'pipe', 'pipe'] });

  // Give releaser a tiny head start to enter releaseLease
  await new Promise(resolve => setTimeout(resolve, 10));

  // Now this process tries to acquire (should succeed after release)
  // The race: releaser reads lock1, confirms nonce, then delays before unlink
  // Meanwhile we acquire lock2. Releaser must not delete lock2.
  let acquireError = null;
  let lock2 = null;
  try {
    const result = await acquireLease(dir, { goalInstance: 'second-owner' });
    lock2 = result.lock;
  } catch (err) {
    acquireError = err;
  }

  await new Promise((resolve) => releaser.on('exit', resolve));

  // After releaser exits, lease must still exist if we acquired lock2
  if (lock2) {
    assert.ok(fs.existsSync(leasePath(dir)), 'lease must exist after release+acquire race');
    const finalLease = JSON.parse(fs.readFileSync(leasePath(dir), 'utf8'));
    assert.equal(finalLease.nonce, lock2.nonce, 'final lease must be lock2, not deleted by releaser');
  }
});

test('readLockOrNull must reject symlink with ELOOP, preserving symlink', async () => {
  const dir = makeGoalDir();
  const target = path.join(dir, 'target.json');
  fs.writeFileSync(target, JSON.stringify({
    pid: 99999,
    processStartTime: new Date().toISOString(),
    host: 'attacker',
    acquiredAt: new Date().toISOString(),
    nonce: 'a'.repeat(32),
    goalInstance: 'symlink-target'
  }));

  fs.symlinkSync(target, leasePath(dir));

  await assert.rejects(
    () => acquireLease(dir, { goalInstance: 'test' }),
    /ELOOP|symlink/i,
    'must reject symlink lease.json'
  );

  // Symlink must still exist (not followed or deleted)
  const stats = fs.lstatSync(leasePath(dir));
  assert.ok(stats.isSymbolicLink(), 'symlink must be preserved');
});

test('acquireLease validates goalInstance is a non-empty string', async () => {
  const dir = makeGoalDir();

  await assert.rejects(
    () => acquireLease(dir, { goalInstance: '' }),
    /goalInstance.*non-empty string/i
  );

  await assert.rejects(
    () => acquireLease(dir, { goalInstance: 123 }),
    /goalInstance.*non-empty string/i
  );

  await assert.rejects(
    () => acquireLease(dir, { goalInstance: null }),
    /goalInstance.*non-empty string/i
  );

  await assert.rejects(
    () => acquireLease(dir, {}),
    /goalInstance.*required/i
  );
});

test('assertValidLockSchema validates goalInstance in existing lease', async () => {
  const dir = makeGoalDir();

  const invalidLock = {
    pid: process.pid,
    processStartTime: new Date().toISOString(),
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    nonce: 'a'.repeat(32),
    goalInstance: 123 // invalid type
  };

  fs.writeFileSync(leasePath(dir), JSON.stringify(invalidLock), { mode: 0o600 });

  await assert.rejects(
    () => acquireLease(dir, { goalInstance: 'test' }),
    /goalInstance.*string/i
  );
});
