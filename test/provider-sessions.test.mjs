import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClaudeSessionRescueSummary,
  findLatestZCodeRolloutFile,
  listRecentSessions,
  readClaudeSessionMetaBySessionId,
  readCodexSessionMetaBySessionId,
  readCursorSessionMetaBySessionId,
  readGrokSessionMetaBySessionId,
  readPiFamilySessionMetaBySessionId,
  readAntigravitySessionState,
  resolveAntigravityProjectRootBySessionId,
} from '../src/provider-sessions.js';

test('provider-sessions lists and resolves Cursor workspace chats', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-cursor-'));
  const workspaceDir = path.join(root, 'workspace');
  const otherWorkspaceDir = path.join(root, 'other-workspace');
  const oldDir = path.join(root, '.cursor', 'chats', 'workspace-hash', 'cursor-old');
  const newDir = path.join(root, '.cursor', 'chats', 'workspace-hash', 'cursor-new');
  const otherDir = path.join(root, '.cursor', 'chats', 'other-hash', 'cursor-other');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.mkdirSync(newDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'meta.json'), JSON.stringify({ cwd: workspaceDir, updatedAtMs: 1000 }));
  fs.writeFileSync(path.join(newDir, 'meta.json'), JSON.stringify({ cwd: workspaceDir, updatedAtMs: 2000 }));
  fs.writeFileSync(path.join(otherDir, 'meta.json'), JSON.stringify({ cwd: otherWorkspaceDir, updatedAtMs: 3000 }));

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.deepEqual(listRecentSessions({ provider: 'cursor', workspaceDir, limit: 2 }), [
      { id: 'cursor-new', mtime: 2000 },
      { id: 'cursor-old', mtime: 1000 },
    ]);
    assert.equal(readCursorSessionMetaBySessionId('cursor-new')?.cwd, path.resolve(workspaceDir));
    assert.equal(readCursorSessionMetaBySessionId('missing'), null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('provider-sessions lists and resolves Grok workspace sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-grok-'));
  const workspaceDir = path.join(root, 'workspace');
  const encodedCwd = encodeURIComponent(workspaceDir);
  const olderDir = path.join(root, '.grok', 'sessions', encodedCwd, 'grok-old');
  const newerDir = path.join(root, '.grok', 'sessions', encodedCwd, 'grok-new');
  fs.mkdirSync(olderDir, { recursive: true });
  fs.mkdirSync(newerDir, { recursive: true });
  const older = path.join(olderDir, 'summary.json');
  const newer = path.join(newerDir, 'summary.json');
  fs.writeFileSync(older, JSON.stringify({ sessionId: 'grok-old' }));
  fs.writeFileSync(newer, JSON.stringify({ info: { id: 'grok-new', cwd: workspaceDir } }));
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.deepEqual(listRecentSessions({ provider: 'grok', workspaceDir, limit: 2 }), [
      { id: 'grok-new', mtime: 2000 },
      { id: 'grok-old', mtime: 1000 },
    ]);
    assert.equal(readGrokSessionMetaBySessionId('grok-new')?.cwd, workspaceDir);
    assert.equal(readGrokSessionMetaBySessionId('missing'), null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('provider-sessions reads Antigravity conversation id from workspace cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-antigravity-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(path.join(root, '.gemini', 'antigravity-cli', 'cache'), { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const conversationId = 'b349594e-8cc8-4604-9443-cfbe6479fe51';
    fs.writeFileSync(path.join(root, '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json'), JSON.stringify({
      [path.resolve(workspaceDir)]: conversationId,
    }, null, 2));

    const recent = listRecentSessions({ provider: 'antigravity', workspaceDir, limit: 5 });
    const sessionState = readAntigravitySessionState({ workspaceDir });
    const staleSessionState = readAntigravitySessionState({ workspaceDir, notOlderThanMs: Date.now() + 60_000 });
    const resolved = resolveAntigravityProjectRootBySessionId(conversationId, workspaceDir);

    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, conversationId);
    assert.equal(sessionState.sessionId, conversationId);
    assert.equal(staleSessionState, null);
    assert.equal(sessionState.finalAnswer, '');
    assert.equal(resolved, path.resolve(workspaceDir));
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions lists recent ZCode rollout sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-zcode-'));
  const rolloutDir = path.join(root, '.zcode', 'cli', 'rollout');
  fs.mkdirSync(rolloutDir, { recursive: true });
  const older = path.join(rolloutDir, 'model-io-sess_zcode_old.jsonl');
  const newer = path.join(rolloutDir, 'model-io-sess_zcode_new.jsonl');
  fs.writeFileSync(older, '{}\n');
  fs.writeFileSync(newer, '{}\n');
  fs.utimesSync(older, new Date(1000), new Date(1000));
  fs.utimesSync(newer, new Date(2000), new Date(2000));

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.deepEqual(listRecentSessions({ provider: 'zcode', limit: 2 }), [
      { id: 'sess_zcode_new', mtime: 2000 },
      { id: 'sess_zcode_old', mtime: 1000 },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('provider-sessions resolves the active ZCode rollout by session or workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-zcode-active-'));
  const rolloutDir = path.join(root, '.zcode', 'cli', 'rollout');
  const workspaceDir = path.join(root, 'workspace');
  const otherWorkspaceDir = path.join(root, 'other-workspace');
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(otherWorkspaceDir, { recursive: true });

  const createRow = (sessionId, cwd) => JSON.stringify({
    type: 'model_io',
    sessionId,
    request: {
      body: {
        system: [{ text: `# Environment\n- Primary working directory: ${cwd}\n- Platform: darwin` }],
      },
    },
  });
  const target = path.join(rolloutDir, 'model-io-sess_zcode_target.jsonl');
  const other = path.join(rolloutDir, 'model-io-sess_zcode_other.jsonl');
  fs.writeFileSync(target, `${createRow('sess_zcode_target', workspaceDir)}\n`);
  fs.writeFileSync(other, `${createRow('sess_zcode_other', otherWorkspaceDir)}\n`);
  fs.utimesSync(target, new Date(2000), new Date(2000));
  fs.utimesSync(other, new Date(3000), new Date(3000));

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(findLatestZCodeRolloutFile({ sessionId: 'sess_zcode_target' })?.file, target);
    assert.equal(findLatestZCodeRolloutFile({ workspaceDir })?.file, target);
    assert.equal(findLatestZCodeRolloutFile({ workspaceDir: path.join(root, 'missing') }), null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('provider-sessions lists Pi and OMP session journals from separate roots', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-pi-family-'));
  const piDir = path.join(root, '.pi', 'agent', 'sessions', '-tmp-workspace');
  const ompDir = path.join(root, '.omp', 'agent', 'sessions', '-tmp-workspace');
  fs.mkdirSync(piDir, { recursive: true });
  fs.mkdirSync(ompDir, { recursive: true });

  const piFile = path.join(piDir, '2026-07-25T00-00-00-000Z_019-pi.jsonl');
  const ompFile = path.join(ompDir, '2026-07-25T00-00-00-000Z_019-omp.jsonl');
  fs.writeFileSync(piFile, `${JSON.stringify({ type: 'session', id: '019-pi', cwd: '/tmp/workspace' })}\n`);
  fs.writeFileSync(ompFile, [
    JSON.stringify({ type: 'title', title: '' }),
    JSON.stringify({ type: 'session', id: '019-omp', cwd: '/tmp/workspace' }),
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(ompDir, 'broken.jsonl'), '{not-json}\n');
  fs.utimesSync(piFile, new Date(1000), new Date(1000));
  fs.utimesSync(ompFile, new Date(2000), new Date(2000));

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.deepEqual(listRecentSessions({ provider: 'pi', workspaceDir: '/tmp/workspace' }), [
      { id: '019-pi', mtime: 1000 },
    ]);
    assert.deepEqual(listRecentSessions({ provider: 'omp', workspaceDir: '/tmp/workspace' }), [
      { id: '019-omp', mtime: 2000 },
    ]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('provider-sessions resolves Pi-family session workspace from its own journal root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-pi-family-meta-'));
  const piDir = path.join(root, '.pi', 'agent', 'sessions', '-tmp-pi-workspace');
  const ompDir = path.join(root, '.omp', 'agent', 'sessions', '-tmp-omp-workspace');
  fs.mkdirSync(piDir, { recursive: true });
  fs.mkdirSync(ompDir, { recursive: true });
  fs.writeFileSync(
    path.join(piDir, 'pi-session.jsonl'),
    `${JSON.stringify({ type: 'session', id: 'pi-session', cwd: '/tmp/pi-workspace' })}\n`,
  );
  fs.writeFileSync(
    path.join(ompDir, 'omp-session.jsonl'),
    `${JSON.stringify({ type: 'title', title: '' })}\n${JSON.stringify({ type: 'session', id: 'omp-session', cwd: '/tmp/omp-workspace' })}\n`,
  );

  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    assert.equal(readPiFamilySessionMetaBySessionId('pi', 'pi-session')?.cwd, '/tmp/pi-workspace');
    assert.equal(readPiFamilySessionMetaBySessionId('omp', 'omp-session')?.cwd, '/tmp/omp-workspace');
    assert.equal(readPiFamilySessionMetaBySessionId('pi', 'omp-session'), null);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test('provider-sessions builds a local Claude rescue summary when the session is over context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-claude-rescue-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const projectDir = path.join(
      root,
      '.claude',
      'projects',
      path.resolve(workspaceDir).replace(/[\\/]/g, '-'),
    );
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = 'b4e0977d-2fdd-49cb-93ea-3f8164cdb1a3';
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'last-prompt',
        lastPrompt: '继续批量生成报告',
        sessionId,
      }),
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: '<task-notification><task-id>task-1</task-id><status>completed</status><summary>Generate report 1001 completed</summary><output-file>/tmp/out</output-file><result>报告已生成并验证 75/75 通过。</result></task-notification>',
        },
        cwd: workspaceDir,
        sessionId,
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: '1001 通过。' }],
        },
        sessionId,
      }),
      JSON.stringify({
        type: 'assistant',
        isApiErrorMessage: true,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'API Error: The model has reached its context window limit.' }],
        },
        sessionId,
      }),
      '',
    ].join('\n'));

    const result = buildClaudeSessionRescueSummary({ sessionId, workspaceDir });

    assert.equal(result.ok, true);
    assert.equal(result.sourceFile, sessionFile);
    assert.match(result.summary, /继续批量生成报告/);
    assert.match(result.summary, /Generate report 1001 completed/);
    assert.match(result.summary, /context window limit/);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions reads codex session meta cwd from rollout file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-codex-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const sessionsDir = path.join(root, '.codex', 'sessions', '2026', '03', '22');
    fs.mkdirSync(sessionsDir, { recursive: true });

    const sessionId = '019d157d-a96a-7542-bf9c-987c885f603e';
    const rollout = path.join(sessionsDir, `rollout-2026-03-22T20-20-50-${sessionId}.jsonl`);
    fs.writeFileSync(rollout, `${JSON.stringify({
      timestamp: '2026-03-22T12:20:50.295Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        cwd: workspaceDir,
      },
    })}\n`);

    const meta = readCodexSessionMetaBySessionId(sessionId);
    assert.equal(meta.cwd, path.resolve(workspaceDir));
    assert.equal(meta.file, rollout);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test('provider-sessions reads claude session meta cwd from project session file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-in-discord-claude-'));
  const workspaceDir = path.join(root, 'workspace');
  fs.mkdirSync(workspaceDir, { recursive: true });

  const previousHome = process.env.HOME;
  process.env.HOME = root;

  try {
    const projectDir = path.join(
      root,
      '.claude',
      'projects',
      path.resolve(workspaceDir).replace(/[\\/]/g, '-'),
    );
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = '43e6f310-5d27-4019-a664-b5dfaea09eaa';
    const sessionFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(sessionFile, [
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        sessionId,
      }),
      JSON.stringify({
        type: 'user',
        cwd: workspaceDir,
        sessionId,
      }),
      '',
    ].join('\n'));

    const meta = readClaudeSessionMetaBySessionId(sessionId);
    assert.equal(meta.cwd, path.resolve(workspaceDir));
    assert.equal(meta.file, sessionFile);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});
