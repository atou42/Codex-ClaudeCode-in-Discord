import assert from 'node:assert/strict';
import test from 'node:test';

import { createWechatCodexRuntime } from '../src/wechat/codex-runtime.js';

test('wechat Codex runtime persists the real thread id returned by the shared runner', async () => {
  const updates = [];
  const sessionStore = {
    get: () => ({
      sessionId: 'thread-old',
      workspaceDir: '/tmp/project',
      model: null,
      effort: null,
      mode: 'safe',
    }),
    update: (userId, patch) => updates.push({ userId, patch }),
  };
  const lock = {
    released: false,
    release() {
      this.released = true;
    },
  };
  const runtime = createWechatCodexRuntime({
    sessionStore,
    runnerExecutor: {
      async runProviderTask(options) {
        assert.equal(options.session.sessionId, 'thread-old');
        assert.equal(options.sessionKey, 'wechat:dm:user-1');
        return {
          ok: true,
          threadId: 'thread-new',
          finalAnswerMessages: ['done'],
          messages: [],
        };
      },
      closeAllRuntimeSessions() {},
    },
    workspaceRuntime: {
      acquireWorkspace: async () => lock,
      readLock: () => ({ owner: null }),
    },
  });

  const result = await runtime.run('user-1', 'run this');

  assert.equal(result.ok, true);
  assert.equal(result.text, 'done');
  assert.equal(result.sessionId, 'thread-new');
  assert.deepEqual(updates, [{
    userId: 'user-1',
    patch: { sessionId: 'thread-new' },
  }]);
  assert.equal(lock.released, true);
});

for (const { mode, allowDangerous, denied } of [
  { mode: 'dangerous', allowDangerous: false, denied: true },
  { mode: 'dangerous', allowDangerous: undefined, denied: true },
  { mode: 'dangerous', allowDangerous: true, denied: false },
  { mode: 'safe', allowDangerous: false, denied: false },
]) {
  test(`wechat runtime enforces current dangerous policy for saved mode=${mode}, allowed=${allowDangerous}`, async () => {
    const saved = { sessionId: 'existing-session', workspaceDir: '/tmp/synthetic-project', mode };
    let locks = 0;
    let runs = 0;
    let released = 0;
    let updates = 0;
    const runtime = createWechatCodexRuntime({
      allowDangerous,
      sessionStore: { get: () => saved, update: () => { updates += 1; } },
      workspaceRuntime: {
        acquireWorkspace: async () => { locks += 1; return { release: () => { released += 1; } }; },
        readLock: () => null,
      },
      runnerExecutor: {
        runProviderTask: async ({ session }) => {
          runs += 1;
          assert.equal(session.mode, mode);
          return { ok: true, finalAnswerMessages: ['done'], messages: [] };
        },
      },
    });
    if (denied) {
      await assert.rejects(runtime.run('user', 'continue existing task'), /WECHAT_ALLOW_DANGEROUS/);
      assert.deepEqual({ locks, runs, released, updates }, { locks: 0, runs: 0, released: 0, updates: 0 });
      assert.equal(saved.mode, 'dangerous', 'a rejected operation must not silently rewrite the saved policy');
    } else {
      const result = await runtime.run('user', 'continue existing task');
      assert.equal(result.ok, true);
      assert.deepEqual({ locks, runs, released, updates }, { locks: 1, runs: 1, released: 1, updates: 0 });
    }
    assert.equal(runtime.getActive('user'), null);
  });
}
