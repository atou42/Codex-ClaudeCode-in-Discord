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
  isProcessAlive,
  LEASE_FILE_NAME,
} from '../../src/cohub-claude-goal/lease.js';
import { IntegrityError, LeaseConflictError } from '../../src/cohub-claude-goal/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function makeGoalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-lease-'));
}

function leasePath(dir) {
  return path.join(dir, LEASE_FILE_NAME);
}

function holderScriptSource(dir) {
  return `
import { acquireLease } from ${JSON.stringify(path.join(repoRoot, 'src/cohub-claude-goal/lease.js'))};
const { lock } = await acquireLease(${JSON.stringify(dir)}, { goalInstance: 'test-goal' });
process.stdout.write('ACQUIRED:' + JSON.stringify(lock) + '\\n');
await new Promise((resolve) => {
  process.on('message', () => resolve());
  setTimeout(resolve, 60000);
});
`;
}

async function spawnHolder(dir) {
  const scriptPath = path.join(dir, 'holder.mjs');
  await fsPromises.writeFile(scriptPath, holderScriptSource(dir));
  const child = spawn(process.execPath, [scriptPath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const acquired = await new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.includes('ACQUIRED:')) {
        child.stdout.off('data', onData);
        const line = buf.split('\n').find((l) => l.startsWith('ACQUIRED:'));
        resolve(JSON.parse(line.slice('ACQUIRED:'.length)));
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!buf.includes('ACQUIRED:')) reject(new Error(`holder exited early with code ${code}`));
    });
    setTimeout(() => reject(new Error('holder did not report ACQUIRED in time')), 8000);
  });
  return { child, lease: acquired };
}

test('lease.js never imports child_process or shells out', async () => {
  const source = await fsPromises.readFile(path.join(repoRoot, 'src/cohub-claude-goal/lease.js'), 'utf8');
  assert.doesNotMatch(source, /child_process/);
  assert.doesNotMatch(source, /\bexec\(/);
  assert.doesNotMatch(source, /\bspawn\(/);
});

test('acquireLease creates lease.json with all required fields and mode 0600', async () => {
  const dir = makeGoalDir();
  const { lock } = await acquireLease(dir, { goalInstance: 'yu-gi-oh-duel-monsters-v1' });
  for (const key of ['pid', 'processStartTime', 'host', 'acquiredAt', 'nonce', 'goalInstance']) {
    assert.ok(Object.prototype.hasOwnProperty.call(lock, key), `missing ${key}`);
  }
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.goalInstance, 'yu-gi-oh-duel-monsters-v1');
  const stat = fs.statSync(leasePath(dir));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('acquireLease rejects a second acquisition in-process while the first is alive (self pid)', async () => {
  const dir = makeGoalDir();
  await acquireLease(dir, { goalInstance: 'g' });
  await assert.rejects(() => acquireLease(dir, { goalInstance: 'g' }), LeaseConflictError);
});

test('acquireLease against a real live second process fails within two seconds', async () => {
  const dir = makeGoalDir();
  const { child, lease } = await spawnHolder(dir);
  try {
    const start = Date.now();
    await assert.rejects(() => acquireLease(dir, { goalInstance: 'test-goal' }), LeaseConflictError);
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2000, `expected conflict detection under 2s, took ${elapsed}ms`);
    assert.notEqual(lease.pid, process.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('acquireLease with corrupt lock JSON throws IntegrityError and preserves bytes', async () => {
  const dir = makeGoalDir();
  fs.writeFileSync(leasePath(dir), '{not valid json', { mode: 0o600 });
  const before = fs.readFileSync(leasePath(dir));
  await assert.rejects(() => acquireLease(dir, { goalInstance: 'g' }), IntegrityError);
  const after = fs.readFileSync(leasePath(dir));
  assert.deepEqual(before, after);
});

test('acquireLease with a lock file missing a required field throws IntegrityError and preserves bytes', async () => {
  const dir = makeGoalDir();
  const incomplete = { pid: 123, host: 'x', acquiredAt: new Date().toISOString(), nonce: 'abc', goalInstance: 'g' };
  fs.writeFileSync(leasePath(dir), JSON.stringify(incomplete), { mode: 0o600 });
  const before = fs.readFileSync(leasePath(dir));
  await assert.rejects(() => acquireLease(dir, { goalInstance: 'g' }), IntegrityError);
  const after = fs.readFileSync(leasePath(dir));
  assert.deepEqual(before, after);
});

test('acquireLease on a dead owner without an audit callback refuses takeover and preserves the old lock', async () => {
  const dir = makeGoalDir();
  const { child, lease } = await spawnHolder(dir);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const before = fs.readFileSync(leasePath(dir), 'utf8');
  await assert.rejects(() => acquireLease(dir, { goalInstance: 'test-goal' }));
  const after = fs.readFileSync(leasePath(dir), 'utf8');
  assert.equal(before, after);
  assert.equal(JSON.parse(after).pid, lease.pid);
});

test('acquireLease on a dead owner takes over only after the audit callback resolves, then archives the old lock atomically', async () => {
  const dir = makeGoalDir();
  const { child, lease: oldLease } = await spawnHolder(dir);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const auditCalls = [];
  const { lock: newLease } = await acquireLease(dir, {
    goalInstance: 'test-goal',
    auditDeadOwnerTakeover: async (deadLock) => {
      auditCalls.push(deadLock);
    },
  });

  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].pid, oldLease.pid);
  assert.equal(newLease.pid, process.pid);
  assert.notEqual(newLease.nonce, oldLease.nonce);

  const finalContent = JSON.parse(fs.readFileSync(leasePath(dir), 'utf8'));
  assert.equal(finalContent.pid, process.pid);

  const siblings = fs.readdirSync(dir);
  const archived = siblings.filter((n) => n !== LEASE_FILE_NAME && n !== 'holder.mjs');
  assert.equal(archived.length, 1);
  const archivedContent = JSON.parse(fs.readFileSync(path.join(dir, archived[0]), 'utf8'));
  assert.equal(archivedContent.pid, oldLease.pid);
  assert.equal(archivedContent.nonce, oldLease.nonce);
});

test('acquireLease on a dead owner propagates audit callback failure and does not touch the old lock', async () => {
  const dir = makeGoalDir();
  const { child, lease: oldLease } = await spawnHolder(dir);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const before = fs.readFileSync(leasePath(dir), 'utf8');
  await assert.rejects(
    () =>
      acquireLease(dir, {
        goalInstance: 'test-goal',
        auditDeadOwnerTakeover: async () => {
          throw new Error('audit ledger write failed');
        },
      }),
    /audit ledger write failed/,
  );
  const after = fs.readFileSync(leasePath(dir), 'utf8');
  assert.equal(before, after);
  assert.equal(JSON.parse(after).pid, oldLease.pid);
});

test('isProcessAlive returns true for the current process', () => {
  assert.equal(isProcessAlive(process.pid), true);
});

test('isProcessAlive returns false for a pid that has genuinely exited', async () => {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
  const pid = child.pid;
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(isProcessAlive(pid), false);
});

test('releaseLease removes the lock only when the caller owns the exact lock (matching nonce)', async () => {
  const dir = makeGoalDir();
  const { lock } = await acquireLease(dir, { goalInstance: 'g' });
  await releaseLease(dir, lock);
  assert.equal(fs.existsSync(leasePath(dir)), false);
});

test('releaseLease is a no-op (does not throw, does not delete) when the on-disk lock has a different nonce', async () => {
  const dir = makeGoalDir();
  const { lock } = await acquireLease(dir, { goalInstance: 'g' });
  const foreignLock = { ...lock, nonce: 'different-nonce' };
  await releaseLease(dir, foreignLock);
  assert.equal(fs.existsSync(leasePath(dir)), true);
});

test('after releaseLease, acquireLease can succeed again for a new owner', async () => {
  const dir = makeGoalDir();
  const { lock } = await acquireLease(dir, { goalInstance: 'g' });
  await releaseLease(dir, lock);
  const { lock: lock2 } = await acquireLease(dir, { goalInstance: 'g' });
  assert.notEqual(lock2.nonce, lock.nonce);
});
