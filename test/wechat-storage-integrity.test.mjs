import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { readJson, writeJson } from '../src/wechat/storage.js';
import { createWechatSessionStore } from '../src/wechat/session-store.js';

function fixture(t, contents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state.json');
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return { root, file };
}

test('missing optional state retains the documented fallback', (t) => {
  const { file } = fixture(t);
  assert.deepEqual(readJson(file, { users: {} }), { users: {} });
  assert.equal(readJson(null, null), null);
  writeJson(file, { version: 1, users: {} });
  assert.deepEqual(readJson(file), { version: 1, users: {} });
});

test('invalid JSON is not a fresh store, does not expose contents, and remains untouched', (t) => {
  const contents = '{"private":"synthetic-sensitive-value"';
  const { file, root } = fixture(t, contents);
  assert.throws(() => createWechatSessionStore({ dataFile: file, defaultWorkspaceDir: root }), (err) => {
    assert.match(err.message, /JSON|state/i);
    assert.equal(String(err).includes('synthetic-sensitive-value'), false);
    assert.equal(err.cause, undefined);
    return true;
  });
  assert.equal(fs.readFileSync(file, 'utf8'), contents);
});

test('non-ENOENT filesystem errors must not return a normal fallback', (t) => {
  const { file } = fixture(t, '{}');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => {
    if (target === file) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return read(target, ...args);
  });
  assert.throws(() => readJson(file, {}), /EACCES/);
});

for (const contents of ['null', '[]', '{}', '{"users":[]}', '{"users":null}', '{"version":1,"users":{"u":null}}', '{"version":2,"users":{}}']) {
  test(`invalid session structure is rejected without rewriting: ${contents}`, (t) => {
    const { root, file } = fixture(t, contents);
    assert.throws(() => createWechatSessionStore({ dataFile: file, defaultWorkspaceDir: root }), /session.*(state|DB)|version/i);
    assert.equal(fs.readFileSync(file, 'utf8'), contents);
  });
}

test('valid existing session data is preserved and can be reopened', (t) => {
  const { file, root } = fixture(t);
  const options = { dataFile: file, defaultWorkspaceDir: root };
  const original = createWechatSessionStore(options);
  original.update('u', { sessionId: 'session-kept', model: 'test-model', effort: 'high' });
  const disk = fs.readFileSync(file, 'utf8');
  const reopened = createWechatSessionStore(options);
  assert.equal(reopened.get('u').sessionId, 'session-kept');
  assert.equal(reopened.get('u').model, 'test-model');
  assert.equal(fs.readFileSync(file, 'utf8'), disk);
});
