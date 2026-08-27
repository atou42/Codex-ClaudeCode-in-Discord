import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createOmpInteractiveRunner,
  readOmpSessionJournal,
} from '../src/omp-interactive-runner.js';

function appendRow(file, row) {
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
}

function createFakeRuntime({ acceptInputAfterMs = 0, runnerOptions = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-interactive-runner-'));
  const children = [];
  let nextPid = 100;
  const resumedSessionId = 'resume-session';
  const resumedDir = path.join(root, 'resumed');
  const resumedFile = path.join(resumedDir, `${resumedSessionId}.jsonl`);
  fs.mkdirSync(resumedDir, { recursive: true });
  fs.writeFileSync(resumedFile, [
    JSON.stringify({ type: 'title', title: '' }),
    JSON.stringify({ type: 'session', id: resumedSessionId, cwd: '/tmp/resumed' }),
    '',
  ].join('\n'));

  function spawnFn(_bin, args, options) {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.exitCode = null;
    child.signalCode = null;
    child.killed = false;
    child.spawnedAt = Date.now();
    child.stderr = new EventEmitter();
    child.stdout = new EventEmitter();
    const sessionDirIndex = args.indexOf('--session-dir');
    const sessionDir = args[sessionDirIndex + 1];
    const resumeIndex = args.indexOf('--resume');
    fs.mkdirSync(sessionDir, { recursive: true });
    const id = resumeIndex >= 0 ? args[resumeIndex + 1] : `omp-session-${child.pid}`;
    const file = path.join(sessionDir, `${id}.jsonl`);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, [
        JSON.stringify({ type: 'title', title: '' }),
        JSON.stringify({ type: 'session', id, cwd: options.cwd }),
        '',
      ].join('\n'));
    }
    child.sessionId = id;
    child.file = file;
    child.writes = [];
    child.stdin = {
      write(value, callback) {
        child.writes.push(value);
        const input = String(value)
          .replace(/^\u001b\[200~/, '')
          .replace(/\u001b\[201~\r$/, '');
        if (input && Date.now() - child.spawnedAt < acceptInputAfterMs) {
          child.stdout.emit('data', Buffer.from(input));
          callback?.();
          return true;
        }
        if (input === '/goal show') {
          child.stdout.emit('data', Buffer.from('Objective: ship it\nStatus: active\n'));
          callback?.();
          return true;
        }
        if (input === '/goal pause') {
          appendRow(file, {
            type: 'mode_change',
            mode: 'goal_paused',
            data: { goal: { id: 'goal-1', objective: 'ship it', status: 'paused', tokensUsed: 10, timeUsedSeconds: 2 } },
          });
          callback?.();
          return true;
        }
        if (input === '/goal resume') {
          appendRow(file, {
            type: 'mode_change',
            mode: 'goal',
            data: { goal: { id: 'goal-1', objective: 'ship it', status: 'active', tokensUsed: 10, timeUsedSeconds: 2 } },
          });
          appendRow(file, {
            type: 'message',
            message: { role: 'assistant', content: [{ type: 'text', text: 'resumed work' }], stopReason: 'stop' },
          });
          callback?.();
          return true;
        }
        if (input === '/goal drop') {
          child.awaitingDropConfirmation = true;
          child.stdout.emit('data', Buffer.from('Drop goal?\n'));
          callback?.();
          return true;
        }
        if (input.startsWith('/goal set ')) {
          const objective = input.slice('/goal set '.length);
          appendRow(file, {
            type: 'mode_change',
            mode: 'goal',
            data: { goal: { id: 'goal-1', objective, status: 'active', tokensUsed: 0, timeUsedSeconds: 0 } },
          });
        }
        appendRow(file, {
          type: 'message',
          message: { role: 'user', content: [{ type: 'text', text: input }] },
        });
        appendRow(file, {
          type: 'message',
          message: { role: 'assistant', content: [{ type: 'text', text: `reply:${input}` }], stopReason: 'stop' },
        });
        if (input.includes('two turns')) {
          setTimeout(() => {
            appendRow(file, { type: 'custom_message', customType: 'goal-continuation', content: 'continue' });
            appendRow(file, {
              type: 'message',
              message: { role: 'assistant', content: [{ type: 'text', text: 'second continuation' }], stopReason: 'stop' },
            });
          }, 1);
        }
        callback?.();
        return true;
      },
    };
    const originalWrite = child.stdin.write;
    child.stdin.write = (value, callback) => {
      if (child.awaitingDropConfirmation && value === '\r') {
        child.writes.push(value);
        child.awaitingDropConfirmation = false;
        appendRow(file, { type: 'mode_change', mode: 'none' });
        callback?.();
        return true;
      }
      return originalWrite(value, callback);
    };
    child.kill = (signal = 'SIGTERM') => {
      if (child.exitCode !== null) return false;
      child.killed = true;
      child.signalCode = signal;
      child.exitCode = 0;
      queueMicrotask(() => child.emit('close', 0, signal));
      return true;
    };
    children.push(child);
    return child;
  }

  const runner = createOmpInteractiveRunner({
    spawnFn,
    spawnEnv: { HOME: root },
    getProviderBin: () => '/fake/omp',
    getSessionId: (session) => session.runnerSessionId || null,
    readSessionMeta: (_provider, sessionId) => (
      sessionId === resumedSessionId ? { file: resumedFile } : null
    ),
    resolveSessionDir: ({ key }) => path.join(root, 'sessions', key),
    pollIntervalMs: 2,
    startupSettleMs: 0,
    localCommandSettleMs: 2,
    inputSubmitDelayMs: 0,
    inputClearDelayMs: 0,
    goalQuietMs: 3,
    discoveryTimeoutMs: 200,
    idleMs: 20,
    stopChildProcess: (child) => child.kill('SIGTERM'),
    log: () => {},
    ...runnerOptions,
  });
  return { root, runner, children, resumedSessionId };
}

test('readOmpSessionJournal accepts OMP v18 title rows and preserves native goal state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-journal-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'title', title: '' }),
    JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp/workspace' }),
    JSON.stringify({ type: 'mode_change', mode: 'goal_paused', data: { goal: { objective: 'ship it', status: 'paused' } } }),
    JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } }),
    '',
  ].join('\n'));

  const journal = readOmpSessionJournal(file);
  assert.equal(journal.sessionId, 'session-1');
  assert.equal(journal.goalMode, 'goal_paused');
  assert.equal(journal.goal.objective, 'ship it');
  assert.equal(journal.assistantMessages.at(-1).text, 'done');
});

test('readOmpSessionJournal rejects corrupt rows but tolerates an incomplete trailing write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-journal-corrupt-'));
  const file = path.join(root, 'session.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'session', id: 'session-1', cwd: '/tmp/workspace' }),
    '{"type":"message"',
  ].join('\n'));

  assert.equal(readOmpSessionJournal(file).sessionId, 'session-1');
  fs.appendFileSync(file, '\n');
  assert.throws(() => readOmpSessionJournal(file), /Invalid OMP session journal at line 2/);
});

test('OMP interactive runner reuses one process per Discord thread and isolates other threads', async () => {
  const { runner, children } = createFakeRuntime();
  const sessionA = { mode: 'safe' };
  const sessionB = { mode: 'safe' };

  const first = await runner.runTask({ session: sessionA, sessionKey: 'thread-a', workspaceDir: '/tmp/a', prompt: 'first' });
  sessionA.runnerSessionId = first.threadId;
  const second = await runner.runTask({ session: sessionA, sessionKey: 'thread-a', workspaceDir: '/tmp/a', prompt: 'second' });
  const other = await runner.runTask({ session: sessionB, sessionKey: 'thread-b', workspaceDir: '/tmp/b', prompt: 'other' });

  assert.equal(first.finalAnswerMessages[0], 'reply:first');
  assert.equal(second.finalAnswerMessages[0], 'reply:second');
  assert.equal(other.finalAnswerMessages[0], 'reply:other');
  assert.equal(children.length, 2);
  assert.equal(children[0].writes.length, 2);
  assert.equal(children[1].writes.length, 1);
  runner.closeAll('test complete');
});

test('OMP native goal controls stay in the live process and clear confirms the TUI dialog', async () => {
  const { runner, children } = createFakeRuntime();
  const session = { mode: 'safe' };
  const set = await runner.runTask({ session, sessionKey: 'thread-goal', workspaceDir: '/tmp/goal', prompt: '/goal set ship it' });
  session.runnerSessionId = set.threadId;
  const status = await runner.runTask({ session, sessionKey: 'thread-goal', workspaceDir: '/tmp/goal', prompt: '/goal show' });
  const paused = await runner.runTask({ session, sessionKey: 'thread-goal', workspaceDir: '/tmp/goal', prompt: '/goal pause' });
  const resumed = await runner.runTask({ session, sessionKey: 'thread-goal', workspaceDir: '/tmp/goal', prompt: '/goal resume' });
  const cleared = await runner.runTask({ session, sessionKey: 'thread-goal', workspaceDir: '/tmp/goal', prompt: '/goal drop' });

  assert.equal(set.ok, true);
  assert.match(status.finalAnswerMessages[0], /ship it/);
  assert.match(paused.finalAnswerMessages[0], /已暂停/);
  assert.equal(resumed.finalAnswerMessages[0], 'resumed work');
  assert.match(cleared.finalAnswerMessages[0], /已清除/);
  assert.equal(children.length, 1);
  assert.equal(children[0].writes.at(-2), '\u001b[200~/goal drop\u001b[201~\r');
  assert.equal(children[0].writes.at(-1), '\r');
  runner.closeAll('test complete');
});

test('OMP runner waits for native automatic goal continuation to become quiescent', async () => {
  const { runner } = createFakeRuntime();
  const result = await runner.runTask({
    session: { mode: 'safe' },
    sessionKey: 'thread-continuation',
    workspaceDir: '/tmp/continuation',
    prompt: '/goal set two turns',
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalAnswerMessages[0], 'second continuation');
  assert.deepEqual(result.messages, ['reply:/goal set two turns', 'second continuation']);
  runner.closeAll('test complete');
});

test('OMP runner reports an unexpected live-session loss before rebuilding it', async () => {
  const { runner, children } = createFakeRuntime();
  const session = { mode: 'safe' };
  const set = await runner.runTask({ session, sessionKey: 'thread-crash', workspaceDir: '/tmp/crash', prompt: '/goal set ship it' });
  session.runnerSessionId = set.threadId;
  children[0].exitCode = 1;
  children[0].emit('close', 1, null);

  const lost = await runner.runTask({ session, sessionKey: 'thread-crash', workspaceDir: '/tmp/crash', prompt: '/goal show' });
  assert.equal(lost.ok, false);
  assert.match(lost.error, /lost|丢失|continuity/i);
  assert.equal(children.length, 1);
  runner.closeAll('test complete');
});

test('OMP runner cleans up idle sessions without closing an active native goal', async () => {
  const { runner, children } = createFakeRuntime();
  await runner.runTask({ session: { mode: 'safe' }, sessionKey: 'idle', workspaceDir: '/tmp/idle', prompt: 'hello' });
  await runner.runTask({ session: { mode: 'safe' }, sessionKey: 'active', workspaceDir: '/tmp/active', prompt: '/goal set ship it' });
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(children[0].killed, true);
  assert.equal(children[1].killed, false);
  assert.deepEqual(runner.getSnapshot().map((entry) => entry.key), ['active']);
  runner.closeAll('test complete');
});

test('OMP runner waits longer before submitting the first prompt to a resumed TUI', async () => {
  const { runner, resumedSessionId } = createFakeRuntime({
    acceptInputAfterMs: 20,
    runnerOptions: {
      startupSettleMs: 0,
      resumedStartupSettleMs: 30,
    },
  });
  const result = await runner.runTask({
    session: { mode: 'safe', runnerSessionId: resumedSessionId },
    sessionKey: 'resumed-startup',
    workspaceDir: '/tmp/resumed',
    prompt: 'continue',
  });

  assert.equal(result.ok, true);
  assert.equal(result.finalAnswerMessages[0], 'reply:continue');
  runner.closeAll('test complete');
});

test('OMP runner closes a TUI whose submitted prompt is never accepted', async () => {
  const { runner, children } = createFakeRuntime({
    acceptInputAfterMs: 10_000,
    runnerOptions: {
      inputAcceptanceTimeoutMs: 20,
      resolveTimeoutSetting: () => ({ timeoutMs: 200 }),
    },
  });
  const result = await runner.runTask({
    session: { mode: 'safe' },
    sessionKey: 'dropped-input',
    workspaceDir: '/tmp/dropped-input',
    prompt: 'continue',
  });

  assert.equal(result.ok, false);
  assert.equal(result.timedOut, false);
  assert.match(result.error, /prompt was not accepted/i);
  assert.equal(children[0].killed, true);
  assert.deepEqual(runner.getSnapshot(), []);
});
