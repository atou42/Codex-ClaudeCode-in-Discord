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
import { IntegrityError, LeaseConflictError } from '../../src/cohub-claude-goal/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

function makeGoalDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'goal-lease-adv-'));
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

test('acquireLease rejects lock with unknown extra field', async () => {
  const dir = makeGoalDir();
  const lock = {
    pid: process.pid,
    processStartTime: new Date().toISOString(),
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    nonce: 'a'.repeat(32),
    goalInstance: 'test-goal',
    extraField: 'bad',
  };
  fs.writeFileSync(leasePath(dir), JSON.stringify(lock), { mode: 0o600 });
  await assert.rejects(() => acquireLease(dir, { goalInstance: 'test-goal' }), IntegrityError);
});

test('acquireLease rejects lock with malicious nonce containing path traversal', async () => {
  const dir = makeGoalDir();
  const lock = {
    pid: 99999,
    processStartTime: new Date().toISOString(),
    host: os.hostname(),
    acquiredAt: new Date().toISOString(),
    nonce: '../../etc/passwd',
    goalInstance: 'test-goal',
  };
  fs.writeFileSync(leasePath(dir), JSON.stringify(lock), { mode: 0o600 });
  await assert.rejects(
    () => acquireLease(dir, { goalInstance: 'test-goal', auditDeadOwnerTakeover: async () => {} }),
    IntegrityError,
  );
});

test('acquireLease with foreign host fails closed as LeaseConflictError', async () => {
  const dir = makeGoalDir();
  const lock = {
    pid: 99999,
    processStartTime: new Date().toISOString(),
    host: 'foreign-host.example.com',
    acquiredAt: new Date().toISOString(),
    nonce: 'a'.repeat(32),
    goalInstance: 'test-goal',
  };
  fs.writeFileSync(leasePath(dir), JSON.stringify(lock), { mode: 0o600 });
  await assert.rejects(() => acquireLease(dir, { goalInstance: 'test-goal' }), LeaseConflictError);
});

test('acquireLease with injected processIdentityProvider verifies PID start identity', async () => {
  const dir = makeGoalDir();
  const { child, lease } = await spawnHolder(dir);
  try {
    const calls = [];
    await assert.rejects(
      () =>
        acquireLease(dir, {
          goalInstance: 'test-goal',
          processIdentityProvider: async (pid) => {
            calls.push(pid);
            return { startTime: lease.processStartTime };
          },
        }),
      LeaseConflictError,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0], lease.pid);
  } finally {
    child.kill('SIGKILL');
  }
});

test('acquireLease with PID reuse detected by identity provider treats old owner as dead', async () => {
  const dir = makeGoalDir();
  const { child, lease: oldLease } = await spawnHolder(dir);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const auditCalls = [];
  const { lock: newLease } = await acquireLease(dir, {
    goalInstance: 'test-goal',
    processIdentityProvider: async (pid) => {
      return { startTime: 'different-start-time' };
    },
    auditDeadOwnerTakeover: async (deadLock) => {
      auditCalls.push(deadLock);
    },
  });
  assert.equal(auditCalls.length, 1);
  assert.equal(auditCalls[0].pid, oldLease.pid);
  assert.equal(newLease.pid, process.pid);
});

test('acquireLease with identity unverifiable fails closed as LeaseConflictError', async () => {
  const dir = makeGoalDir();
  const { child, lease } = await spawnHolder(dir);
  try {
    await assert.rejects(
      () =>
        acquireLease(dir, {
          goalInstance: 'test-goal',
          processIdentityProvider: async (pid) => {
            return null;
          },
        }),
      LeaseConflictError,
    );
  } finally {
    child.kill('SIGKILL');
  }
});

test('acquireLease takeover archives exact old lock bytes before creating new lease', async () => {
  const dir = makeGoalDir();
  const { child, lease: oldLease } = await spawnHolder(dir);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  const oldBytes = fs.readFileSync(leasePath(dir));
  await acquireLease(dir, {
    goalInstance: 'test-goal',
    auditDeadOwnerTakeover: async () => {},
  });

  const siblings = fs.readdirSync(dir).filter((n) => n !== LEASE_FILE_NAME && n !== 'holder.mjs');
  assert.equal(siblings.length, 1);
  const archived = siblings[0];
  const archivedBytes = fs.readFileSync(path.join(dir, archived));
  assert.deepEqual(archivedBytes, oldBytes, 'archived bytes must exactly match original lock bytes');
});

test('acquireLease takeover never exposes an absent lease.json window', async () => {
  const dir = makeGoalDir();
  const { child, lease: oldLease } = await spawnHolder(dir);
  child.kill('SIGKILL');
  await new Promise((resolve) => child.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 100));

  let sawAbsent = false;
  const checkInterval = setInterval(() => {
    if (!fs.existsSync(leasePath(dir))) {
      sawAbsent = true;
    }
  }, 1);

  await acquireLease(dir, {
    goalInstance: 'test-goal',
    auditDeadOwnerTakeover: async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    },
  });

  clearInterval(checkInterval);
  assert.equal(sawAbsent, false, 'lease.json must never be absent during takeover');
});

test('releaseLease performs durable directory fsync after unlink', async () => {
  const dir = makeGoalDir();
  const { lock } = await acquireLease(dir, { goalInstance: 'test-goal' });
  let dirFsyncCalled = false;
  const originalOpen = fsPromises.open;
  fsPromises.open = async function (p, flags) {
    const fd = await originalOpen.call(this, p, flags);
    if (p === dir && flags === fs.constants.O_RDONLY) {
      const originalSync = fd.sync;
      fd.sync = async function () {
        dirFsyncCalled = true;
        return originalSync.call(this);
      };
    }
    return fd;
  };
  try {
    await releaseLease(dir, lock);
    assert.ok(dirFsyncCalled, 'directory fsync must be called after lease unlink');
  } finally {
    fsPromises.open = originalOpen;
  }
});
