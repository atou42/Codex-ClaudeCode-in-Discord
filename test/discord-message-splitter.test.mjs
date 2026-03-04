import test from 'node:test';
import assert from 'node:assert/strict';

import { splitForDiscord } from '../src/discord-message-splitter.js';

function hasUnclosedFence(text) {
  const lines = String(text || '').split('\n');
  let fence = null;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([`~]{3,})(.*)$/);
    if (!match) continue;
    const marker = match[1];
    const markerChar = marker[0];
    const isUniform = markerChar === '`' ? /^`+$/.test(marker) : /^~+$/.test(marker);
    if (!isUniform) continue;

    if (!fence) {
      fence = { markerChar, markerLength: marker.length };
      continue;
    }

    const closingLike = !match[2].trim();
    if (closingLike && markerChar === fence.markerChar && marker.length >= fence.markerLength) {
      fence = null;
    }
  }

  return Boolean(fence);
}

test('splitForDiscord keeps plain text unchanged when under limit', () => {
  const text = '第一行\n第二行\n第三行';
  const parts = splitForDiscord(text, 1900);
  assert.deepEqual(parts, [text]);
});

test('splitForDiscord keeps chunks under limit for long plain text', () => {
  const text = Array.from({ length: 120 }, (_, i) => `line-${i + 1} ${'x'.repeat(25)}`).join('\n');
  const parts = splitForDiscord(text, 180);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.length <= 180);
  }
});

test('splitForDiscord keeps fenced code blocks balanced across chunks', () => {
  const codeLines = Array.from(
    { length: 24 },
    (_, i) => `line ${String(i + 1).padStart(2, '0')} ${'x'.repeat(18)}`,
  );
  const text = [
    '结论：',
    '```txt',
    ...codeLines,
    '```',
    '补充说明。',
  ].join('\n');

  const parts = splitForDiscord(text, 140);
  assert.ok(parts.length > 2);

  for (const part of parts) {
    assert.ok(part.length <= 140);
    assert.equal(hasUnclosedFence(part), false);
  }

  assert.ok(parts[0].includes('```txt'));
  assert.ok(parts[1].startsWith('```txt\n'));

  const seenCodeLines = parts
    .flatMap((part) => part.split('\n'))
    .filter((line) => line.startsWith('line '));
  assert.deepEqual(seenCodeLines, codeLines);
});

test('splitForDiscord auto-closes unclosed fence in final chunk', () => {
  const text = '```js\nconst a = 1;\nconst b = 2;';
  const parts = splitForDiscord(text, 1900);
  assert.equal(parts.length, 1);
  assert.equal(hasUnclosedFence(parts[0]), false);
  assert.ok(parts[0].endsWith('```'));
});
