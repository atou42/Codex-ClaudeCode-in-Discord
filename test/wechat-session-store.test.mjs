import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createWechatSessionStore,
  readCodexSessionPreview,
} from '../src/wechat/session-store.js';

function createFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-session-')));
  const projectA = path.join(root, 'a');
  const projectB = path.join(root, 'b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  const sessions = [
    { id: 'session-a', mtime: 200 },
    { id: 'session-b', mtime: 100 },
  ];
  const meta = {
    'session-a': { cwd: projectA, mtimeMs: 200, file: null },
    'session-b': { cwd: projectB, mtimeMs: 100, file: null },
  };
  const store = createWechatSessionStore({
    dataFile: path.join(root, 'sessions.json'),
    defaultWorkspaceDir: projectA,
    workspaceRoots: [root],
    listRecentSessionsFn: () => sessions,
    readSessionMetaFn: (id) => meta[id] || null,
  });
  return { root, projectA, projectB, store };
}

test('wechat session store lists and binds a real session selection by number', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const items = fixture.store.listRecent('user-1');
  assert.equal(items.length, 2);
  const session = fixture.store.bind('user-1', '2');

  assert.equal(session.sessionId, 'session-b');
  assert.equal(session.workspaceDir, fixture.projectB);
});

test('wechat session store clears the session when workspace changes', (t) => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  fixture.store.bind('user-1', 'session-a');
  const session = fixture.store.setWorkspace('user-1', fixture.projectB);

  assert.equal(session.sessionId, null);
  assert.equal(session.workspaceDir, fixture.projectB);
});

test('wechat session store rejects workspaces outside configured roots', (t) => {
  const fixture = createFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-outside-'));
  t.after(() => {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  assert.throws(
    () => fixture.store.setWorkspace('user-1', outside),
    /WECHAT_WORKSPACE_ROOTS/,
  );
});

test('readCodexSessionPreview uses the first real user message', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-preview-'));
  const file = path.join(root, 'rollout.jsonl');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: '<environment_context>hidden</environment_context>' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: '帮我修复登录流程\n并运行测试' },
    }),
  ].join('\n'));

  assert.equal(readCodexSessionPreview(file), '帮我修复登录流程 并运行测试');
});

test('wechat workspace allowlist rejects symlink escapes for dir, resume and recent sessions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-symlink-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(allowed);
  fs.mkdirSync(outside);
  const escape = path.join(allowed, 'escape');
  fs.symlinkSync(outside, escape, 'dir');
  const dataFile = path.join(root, 'sessions.json');
  const store = createWechatSessionStore({
    dataFile,
    defaultWorkspaceDir: allowed,
    workspaceRoots: [allowed],
    listRecentSessionsFn: () => [{ id: 'outside-session', mtime: 1 }],
    readSessionMetaFn: () => ({ cwd: escape, file: null }),
  });
  const before = { ...store.get('user-1') };
  const diskBefore = fs.readFileSync(dataFile, 'utf8');
  assert.throws(() => store.setWorkspace('user-1', escape), /WECHAT_WORKSPACE_ROOTS/);
  assert.throws(() => store.bind('user-1', 'outside-session'), /WECHAT_WORKSPACE_ROOTS/);
  assert.deepEqual(store.listRecent('user-1'), []);
  assert.deepEqual(store.get('user-1'), before);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), diskBefore);
});

test('wechat workspace allowlist supports symlinked roots and returns canonical targets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-root-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realRoot = path.join(root, 'real');
  const project = path.join(realRoot, 'project');
  fs.mkdirSync(project, { recursive: true });
  const alias = path.join(root, 'alias');
  fs.symlinkSync(realRoot, alias, 'dir');
  const store = createWechatSessionStore({
    dataFile: path.join(root, 'sessions.json'),
    defaultWorkspaceDir: path.join(alias, 'project'),
    workspaceRoots: [alias],
  });
  assert.equal(store.get('user-1').workspaceDir, fs.realpathSync(project));
  assert.equal(store.ensureWorkspaceAllowed(project), fs.realpathSync(project));
});

test('wechat revalidates a numbered resume selection after a directory becomes an outside symlink', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aid-wechat-resume-link-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const allowed = path.join(root, 'allowed');
  const project = path.join(allowed, 'project');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(outside);
  const store = createWechatSessionStore({
    dataFile: path.join(root, 'sessions.json'),
    defaultWorkspaceDir: allowed,
    workspaceRoots: [allowed],
    listRecentSessionsFn: () => [{ id: 'selected-session', mtime: 1 }],
    readSessionMetaFn: () => ({ cwd: project, file: null }),
  });
  const before = { ...store.get('user-1') };
  assert.equal(store.listRecent('user-1').length, 1);
  fs.rmdirSync(project);
  fs.symlinkSync(outside, project, 'dir');
  assert.throws(() => store.bind('user-1', '1'), /WECHAT_WORKSPACE_ROOTS/);
  assert.deepEqual(store.get('user-1'), before);
});
