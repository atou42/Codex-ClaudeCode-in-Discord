import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic, AtomicFileError } from '../../src/cohub-claude-goal/atomic-file.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-file-'));
}

function listTempSiblings(dir, destBaseName) {
  return fs.readdirSync(dir).filter((name) => name !== destBaseName);
}

test('writeFileAtomic writes full content to destination', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await writeFileAtomic(dest, Buffer.from('{"hello":"world"}', 'utf8'));
  const content = fs.readFileSync(dest, 'utf8');
  assert.equal(content, '{"hello":"world"}');
});

test('writeFileAtomic leaves no temp files behind on success', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await writeFileAtomic(dest, Buffer.from('data', 'utf8'));
  const siblings = listTempSiblings(dir, 'record.json');
  assert.deepEqual(siblings, []);
});

test('writeFileAtomic uses a same-directory temp file during the write', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  let sawTempInSameDir = false;
  await writeFileAtomic(dest, Buffer.from('data', 'utf8'), {
    crashHook: (point) => {
      if (point === 'after-write') {
        const siblings = fs.readdirSync(dir);
        sawTempInSameDir = siblings.some((name) => name !== 'record.json' && name.includes(path.basename(dest)));
      }
    },
  });
  assert.ok(sawTempInSameDir, 'expected a temp file colocated in the same directory during write');
});

test('writeFileAtomic refuses to overwrite an existing destination by default', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await writeFileAtomic(dest, Buffer.from('first', 'utf8'));
  await assert.rejects(
    () => writeFileAtomic(dest, Buffer.from('second', 'utf8')),
    AtomicFileError,
  );
  const content = fs.readFileSync(dest, 'utf8');
  assert.equal(content, 'first');
});

test('writeFileAtomic refusal happens before any temp file is created', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await writeFileAtomic(dest, Buffer.from('first', 'utf8'));
  await assert.rejects(() => writeFileAtomic(dest, Buffer.from('second', 'utf8')));
  const siblings = listTempSiblings(dir, 'record.json');
  assert.deepEqual(siblings, []);
});

test('writeFileAtomic allows replacement when allowReplace is true', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'state.json');
  await writeFileAtomic(dest, Buffer.from('first', 'utf8'));
  await writeFileAtomic(dest, Buffer.from('second', 'utf8'), { allowReplace: true });
  const content = fs.readFileSync(dest, 'utf8');
  assert.equal(content, 'second');
});

test('writeFileAtomic calls crashHook in the documented order', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  const order = [];
  await writeFileAtomic(dest, Buffer.from('data', 'utf8'), {
    crashHook: (point) => order.push(point),
  });
  assert.deepEqual(order, [
    'before-open',
    'after-open',
    'after-write',
    'after-fsync-file',
    'after-close',
    'before-rename',
    'after-rename',
    'after-fsync-dir',
  ]);
});

test('crash after-open: temp file exists empty, destination absent, temp bytes preserved', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload', 'utf8'), {
        crashHook: (point) => {
          if (point === 'after-open') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), false);
  const siblings = listTempSiblings(dir, 'record.json');
  assert.equal(siblings.length, 1);
  const tempContent = fs.readFileSync(path.join(dir, siblings[0]), 'utf8');
  assert.equal(tempContent, '');
});

test('crash after-write: temp file has full bytes, destination absent', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload-bytes', 'utf8'), {
        crashHook: (point) => {
          if (point === 'after-write') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), false);
  const siblings = listTempSiblings(dir, 'record.json');
  assert.equal(siblings.length, 1);
  const tempContent = fs.readFileSync(path.join(dir, siblings[0]), 'utf8');
  assert.equal(tempContent, 'payload-bytes');
});

test('crash after-fsync-file: temp file has full bytes, destination absent', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload-bytes', 'utf8'), {
        crashHook: (point) => {
          if (point === 'after-fsync-file') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), false);
  const siblings = listTempSiblings(dir, 'record.json');
  assert.equal(siblings.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, siblings[0]), 'utf8'), 'payload-bytes');
});

test('crash after-close: temp file has full bytes, destination absent, fd already closed', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload-bytes', 'utf8'), {
        crashHook: (point) => {
          if (point === 'after-close') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), false);
  const siblings = listTempSiblings(dir, 'record.json');
  assert.equal(siblings.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, siblings[0]), 'utf8'), 'payload-bytes');
});

test('crash before-rename: temp file has full bytes, destination absent', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload-bytes', 'utf8'), {
        crashHook: (point) => {
          if (point === 'before-rename') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), false);
  const siblings = listTempSiblings(dir, 'record.json');
  assert.equal(siblings.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, siblings[0]), 'utf8'), 'payload-bytes');
});

test('crash after-rename: destination has full bytes, temp file gone (rename already completed)', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload-bytes', 'utf8'), {
        crashHook: (point) => {
          if (point === 'after-rename') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'payload-bytes');
  const siblings = listTempSiblings(dir, 'record.json');
  assert.deepEqual(siblings, []);
});

test('crash after-fsync-dir: full success already happened, no lingering temp', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(
    () =>
      writeFileAtomic(dest, Buffer.from('payload-bytes', 'utf8'), {
        crashHook: (point) => {
          if (point === 'after-fsync-dir') throw new Error('SIMULATED_CRASH');
        },
      }),
    /SIMULATED_CRASH/,
  );
  assert.equal(fs.existsSync(dest), true);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'payload-bytes');
});

test('writeFileAtomic never deletes a crashed temp file itself (caller/recovery owns cleanup)', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await assert.rejects(() =>
    writeFileAtomic(dest, Buffer.from('x', 'utf8'), {
      crashHook: (point) => {
        if (point === 'after-write') throw new Error('SIMULATED_CRASH');
      },
    }),
  );
  const siblingsBefore = listTempSiblings(dir, 'record.json');
  assert.equal(siblingsBefore.length, 1);
  // A second, unrelated write should not touch the crashed temp file.
  await writeFileAtomic(path.join(dir, 'other.json'), Buffer.from('y', 'utf8'));
  const siblingsAfter = fs.readdirSync(dir).filter((n) => n !== 'record.json' && n !== 'other.json');
  assert.deepEqual(siblingsAfter, siblingsBefore);
});

test('writeFileAtomic default file mode is 0600', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'secret.json');
  await writeFileAtomic(dest, Buffer.from('x', 'utf8'));
  const stat = fs.statSync(dest);
  assert.equal(stat.mode & 0o777, 0o600);
});

test('writeFileAtomic respects an explicit mode option', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await writeFileAtomic(dest, Buffer.from('x', 'utf8'), { mode: 0o644 });
  const stat = fs.statSync(dest);
  assert.equal(stat.mode & 0o777, 0o644);
});

test('writeFileAtomic rejects when destination directory does not exist', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'missing-subdir', 'record.json');
  await assert.rejects(() => writeFileAtomic(dest, Buffer.from('x', 'utf8')));
});

test('writeFileAtomic generates unique temp names across concurrent calls', async () => {
  const dir = makeTempDir();
  await Promise.all(
    Array.from({ length: 20 }, (_, i) => writeFileAtomic(path.join(dir, `f-${i}.json`), Buffer.from(String(i), 'utf8'))),
  );
  for (let i = 0; i < 20; i += 1) {
    assert.equal(fs.readFileSync(path.join(dir, `f-${i}.json`), 'utf8'), String(i));
  }
  const leftover = fs.readdirSync(dir).filter((n) => !n.startsWith('f-'));
  assert.deepEqual(leftover, []);
});

test('writeFileAtomic accepts string data as well as Buffer', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  await writeFileAtomic(dest, 'plain-string-payload');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'plain-string-payload');
});

test('writeFileAtomic no-replace commit is race-proof: a destination that appears in the check-to-commit window is never overwritten', async () => {
  // Simulates the TOCTOU window between the initial existsSync check and the
  // final commit by neutralizing existsSync (as if it observed "absent")
  // while a racer has already created the real destination on disk. A truly
  // atomic no-clobber commit (e.g. fs.link, which the kernel enforces
  // EEXIST on) must still refuse to replace it; a check-then-rename commit
  // would silently overwrite it, since Unix rename() always replaces.
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  const racerBytes = 'racer-won-the-toctou-window';
  fs.writeFileSync(dest, racerBytes, { mode: 0o600 });

  const originalExistsSync = fs.existsSync;
  fs.existsSync = (p) => (p === dest ? false : originalExistsSync(p));
  try {
    await assert.rejects(
      () => writeFileAtomic(dest, Buffer.from('attacker-payload', 'utf8')),
      AtomicFileError,
    );
  } finally {
    fs.existsSync = originalExistsSync;
  }

  const content = fs.readFileSync(dest, 'utf8');
  assert.equal(content, racerBytes, 'destination bytes created during the TOCTOU window must never be replaced');
});

test('writeFileAtomic no-replace commit preserves the temp file when the destination wins the race', async () => {
  const dir = makeTempDir();
  const dest = path.join(dir, 'record.json');
  fs.writeFileSync(dest, 'racer-won', { mode: 0o600 });

  const originalExistsSync = fs.existsSync;
  fs.existsSync = (p) => (p === dest ? false : originalExistsSync(p));
  try {
    await assert.rejects(() => writeFileAtomic(dest, Buffer.from('attacker-payload', 'utf8')));
  } finally {
    fs.existsSync = originalExistsSync;
  }

  const siblings = listTempSiblings(dir, 'record.json');
  assert.equal(siblings.length, 1, 'the temp file must be preserved for forensics when the commit is aborted');
  assert.equal(fs.readFileSync(path.join(dir, siblings[0]), 'utf8'), 'attacker-payload');
});
