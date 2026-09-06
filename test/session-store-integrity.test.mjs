import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createSessionStore } from '../src/session-store.js';

function fixture(t, contents = '{"threads":{},"workspaceFavorites":{}}') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-session-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataFile = path.join(root, 'sessions.json');
  if (contents !== null) fs.writeFileSync(dataFile, contents);
  return { root, dataFile, options: { dataFile, normalizeProvider: (value) => value || 'codex' } };
}

for (const contents of ['null', '[]', '{}', '{"threads":[]}', '{"threads":null}', '{"threads":{"a":null}}', '{"threads":{},"workspaceFavorites":[]}']) {
  test(`invalid DB shape must not replace the original snapshot: ${contents}`, (t) => {
    const f = fixture(t, contents);
    assert.throws(() => createSessionStore(f.options), /session DB/i);
    assert.equal(fs.readFileSync(f.dataFile, 'utf8'), contents);
  });
}

test('a failed partial write preserves the previous snapshot and removes its temporary file', (t) => {
  const f = fixture(t);
  const store = createSessionStore(f.options);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (target) => {
    write(target, '{"partial":', 'utf8');
    throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
  });
  assert.throws(() => store.saveDb(), /disk full/);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.root), ['sessions.json']);
});

test('failed atomic replacement preserves the previous snapshot and reports the failure', (t) => {
  const f = fixture(t);
  const store = createSessionStore(f.options);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  t.mock.method(fs, 'renameSync', () => { throw new Error('rename denied'); });
  assert.throws(() => store.saveDb(), /rename denied/);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.root), ['sessions.json']);
});

test('missing DB initializes and existing legacy thread maps remain valid', (t) => {
  const f = fixture(t, null);
  const store = createSessionStore(f.options);
  store.saveDb();
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).threads, {});
  fs.writeFileSync(f.dataFile, '{"threads":{"legacy":{"provider":"codex","runnerSessionId":"kept"}}}');
  createSessionStore(f.options).saveDb();
  assert.equal(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).threads.legacy.runnerSessionId, 'kept');
  assert.deepEqual(fs.readdirSync(f.root), ['sessions.json']);
});

test('an abrupt writer exit leaves the previous snapshot readable', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  const script = `
    import fs from 'node:fs';
    import { createSessionStore } from ${JSON.stringify(new URL('../src/session-store.js', import.meta.url).href)};
    const store = createSessionStore({ dataFile: ${JSON.stringify(f.dataFile)} });
    const write = fs.writeFileSync;
    fs.writeFileSync = (target) => { write(target, '{"partial":'); process.exit(86); };
    store.saveDb();
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 86, result.stderr);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.doesNotThrow(() => createSessionStore(f.options));
});

test('temporary-name collisions do not overwrite or delete the existing file', (t) => {
  const f = fixture(t);
  const store = createSessionStore(f.options);
  const open = fs.openSync;
  const write = fs.writeFileSync;
  let collision = null;
  t.mock.method(fs, 'openSync', (file, flags, ...args) => {
    if (flags === 'wx') {
      collision = file;
      write(file, 'existing temporary evidence');
      throw Object.assign(new Error('temporary collision'), { code: 'EEXIST' });
    }
    return open(file, flags, ...args);
  });
  assert.throws(() => store.saveDb(), /temporary collision/);
  assert.equal(fs.readFileSync(collision, 'utf8'), 'existing temporary evidence');
  assert.deepEqual(JSON.parse(fs.readFileSync(f.dataFile, 'utf8')).threads, {});
});

test('a flush failure is reported before replacing the last valid snapshot', (t) => {
  const f = fixture(t);
  const store = createSessionStore(f.options);
  const before = fs.readFileSync(f.dataFile, 'utf8');
  t.mock.method(fs, 'fsyncSync', () => { throw new Error('flush failed'); });
  assert.throws(() => store.saveDb(), /flush failed/);
  assert.equal(fs.readFileSync(f.dataFile, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.root), ['sessions.json']);
});
