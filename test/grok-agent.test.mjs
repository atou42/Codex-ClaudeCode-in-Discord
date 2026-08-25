import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createGrokAgentClient, forkGrokSession } from '../src/grok-agent.js';

function createFakeSpawn({ onRequest } = {}) {
  const calls = [];
  const writes = [];
  function spawnFn(bin, args, options) {
    calls.push({ bin, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; return true; };
    child.stdin = {
      write(chunk) {
        writes.push(String(chunk));
        const request = JSON.parse(String(chunk));
        const response = onRequest?.(request) || { jsonrpc: '2.0', id: request.id, result: {} };
        child.stdout.write(`${JSON.stringify(response)}\n`);
      },
      end() {},
    };
    return child;
  }
  return { spawnFn, calls, writes };
}

test('createGrokAgentClient forks a session directly into the requested workspace', async () => {
  const fake = createFakeSpawn({
    onRequest(request) {
      if (request.method === 'initialize') {
        assert.equal(request.params.protocolVersion, 1);
        return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } };
      }
      if (request.method === '_x.ai/session/fork') {
        assert.deepEqual(request.params, {
          sourceSessionId: 'parent-session',
          sourceCwd: '/repo/parent',
          newCwd: '/repo/child',
        });
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            newSessionId: 'child-session',
            parentSessionId: 'parent-session',
            newCwd: '/repo/child',
            chatMessagesCopied: 8,
          },
        };
      }
      throw new Error(`unexpected method ${request.method}`);
    },
  });
  const client = createGrokAgentClient({
    grokBin: 'grok-test',
    env: { HOME: '/tmp/home' },
    spawnFn: fake.spawnFn,
  });

  const result = await client.forkSession({
    sourceSessionId: 'parent-session',
    sourceCwd: '/repo/parent',
    newCwd: '/repo/child',
  });

  assert.deepEqual(result, {
    sessionId: 'child-session',
    parentSessionId: 'parent-session',
    cwd: '/repo/child',
    raw: {
      newSessionId: 'child-session',
      parentSessionId: 'parent-session',
      newCwd: '/repo/child',
      chatMessagesCopied: 8,
    },
  });
  assert.deepEqual(fake.calls.map((call) => [call.bin, call.args, call.options.cwd]), [[
    'grok-test',
    ['agent', '--always-approve', '--no-leader', 'stdio'],
    '/repo/parent',
  ]]);
  assert.deepEqual(fake.writes.map((line) => JSON.parse(line).method), [
    'initialize',
    '_x.ai/session/fork',
  ]);
});

test('forkGrokSession rejects a fork returned in the parent workspace', async () => {
  const fake = createFakeSpawn({
    onRequest(request) {
      if (request.method === 'initialize') {
        return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } };
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          newSessionId: 'child-session',
          parentSessionId: 'parent-session',
          newCwd: '/repo/parent',
        },
      };
    },
  });

  await assert.rejects(
    () => forkGrokSession({
      sourceSessionId: 'parent-session',
      sourceCwd: '/repo/parent',
      newCwd: '/repo/child',
      spawnFn: fake.spawnFn,
    }),
    /wrong workspace/,
  );
});

test('forkGrokSession exposes native JSON-RPC errors', async () => {
  const fake = createFakeSpawn({
    onRequest(request) {
      if (request.method === 'initialize') {
        return { jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1 } };
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32602, message: 'Invalid params', data: 'parent session missing' },
      };
    },
  });

  await assert.rejects(
    () => forkGrokSession({
      sourceSessionId: 'missing-parent',
      sourceCwd: '/repo/parent',
      newCwd: '/repo/child',
      spawnFn: fake.spawnFn,
    }),
    /Invalid params: parent session missing/,
  );
});

test('forkGrokSession refuses to fork back into the parent workspace before spawning', async () => {
  let spawned = false;
  await assert.rejects(
    () => forkGrokSession({
      sourceSessionId: 'parent-session',
      sourceCwd: '/repo/shared',
      newCwd: '/repo/shared',
      spawnFn() { spawned = true; },
    }),
    /distinct child workspace/,
  );
  assert.equal(spawned, false);
});
