import test from 'node:test';
import assert from 'node:assert/strict';

import { stageGrokPromptFile } from '../src/grok-prompt-file.js';

test('stageGrokPromptFile keeps large prompts and image references out of argv', async () => {
  const writes = [];
  const removals = [];
  const prompt = 'x'.repeat(19_448);

  const staged = await stageGrokPromptFile({
    prompt,
    inputImages: ['/tmp/input.png'],
    tmpdir: '/tmp',
    mkdtempFn: async () => '/tmp/grok-prompt-test',
    writeFileFn: async (...args) => writes.push(args),
    rmFn: async (...args) => removals.push(args),
  });

  assert.equal(staged.path, '/tmp/grok-prompt-test/prompt.txt');
  assert.deepEqual(writes, [[
    '/tmp/grok-prompt-test/prompt.txt',
    `${prompt}\n@/tmp/input.png`,
    { encoding: 'utf8', mode: 0o600 },
  ]]);

  await staged.cleanup();
  assert.deepEqual(removals, [[
    '/tmp/grok-prompt-test',
    { recursive: true, force: true },
  ]]);
});

test('stageGrokPromptFile removes its temporary directory when writing fails', async () => {
  const removals = [];
  const writeError = new Error('disk full');

  await assert.rejects(
    stageGrokPromptFile({
      prompt: 'hello',
      tmpdir: '/tmp',
      mkdtempFn: async () => '/tmp/grok-prompt-test',
      writeFileFn: async () => { throw writeError; },
      rmFn: async (...args) => removals.push(args),
    }),
    writeError,
  );
  assert.deepEqual(removals, [[
    '/tmp/grok-prompt-test',
    { recursive: true, force: true },
  ]]);
});
