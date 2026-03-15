import test from 'node:test';
import assert from 'node:assert/strict';

import { createPromptResultRenderer } from '../src/prompt-result-renderer.js';

function createRenderer(overrides = {}) {
  return createPromptResultRenderer({
    showReasoning: true,
    truncate: (text, max) => (String(text || '').length <= max ? String(text || '') : `${String(text).slice(0, max - 3)}...`),
    composeFinalAnswerText: ({ finalAnswerMessages }) => finalAnswerMessages.join('\n\n'),
    getProviderShortName: (provider) => provider === 'codex' ? 'Codex' : provider,
    formatProviderSessionTerm: (provider) => {
      if (provider === 'claude') return 'project session';
      if (provider === 'gemini') return 'chat session';
      return 'rollout session';
    },
    getSessionProvider: (session) => session.provider || 'codex',
    getSessionId: (session) => session.runnerSessionId || session.codexThreadId || null,
    ...overrides,
  });
}

test('createPromptResultRenderer renders reasoning answer notes and session label', () => {
  const renderer = createRenderer();
  const session = {
    provider: 'codex',
    runnerSessionId: 'sess-1',
    codexThreadId: 'sess-1',
    name: 'demo',
  };

  const text = renderer.composeResultText({
    reasonings: ['step one', 'step two'],
    messages: ['fallback'],
    finalAnswerMessages: ['final answer'],
    notes: ['auto reset'],
    threadId: 'sess-9',
  }, session);

  assert.match(text, /🧠 Reasoning/);
  assert.match(text, /final answer/);
  assert.match(text, /• auto reset/);
  assert.match(text, /• rollout session: \*\*demo\*\* \(`sess-9`\)/);
});

test('createPromptResultRenderer falls back when provider returns no visible answer', () => {
  const renderer = createRenderer({
    showReasoning: false,
    composeFinalAnswerText: () => '',
  });
  const session = {
    provider: 'codex',
    runnerSessionId: null,
    codexThreadId: null,
    name: '',
  };

  const text = renderer.composeResultText({
    reasonings: [],
    messages: [],
    finalAnswerMessages: [],
    notes: [],
    threadId: null,
  }, session);

  assert.equal(text, '（Codex 没有返回可见文本）');
});
