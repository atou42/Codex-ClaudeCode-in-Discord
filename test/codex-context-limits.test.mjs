import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  prepareCodexModelCatalog,
  resolveCodexContextLimits,
  resolveCodexModelLimits,
} from '../src/codex-context-limits.js';

test('resolveCodexContextLimits prefers provider-scoped context over legacy keys', () => {
  assert.deepEqual(resolveCodexContextLimits({
    env: {
      CODEX__MODEL_CONTEXT_WINDOW: '1050000',
      MODEL_CONTEXT_WINDOW_CODEX: '900000',
      MODEL_CONTEXT_WINDOW: '800000',
    },
    compactThreshold: 400000,
  }), {
    modelContextWindow: 1050000,
    model: null,
    source: 'provider env',
  });
});

test('resolveCodexContextLimits ignores another provider flattened context value', () => {
  assert.deepEqual(resolveCodexContextLimits({
    env: { MODEL_CONTEXT_WINDOW: '700000' },
    compactThreshold: 400000,
    appliedProviderScope: 'grok',
    appliedScopedKeys: ['MODEL_CONTEXT_WINDOW'],
  }), {
    modelContextWindow: null,
    model: null,
    source: 'provider catalog',
  });
});

test('resolveCodexContextLimits keeps an explicit target model', () => {
  assert.deepEqual(resolveCodexContextLimits({
    env: { CODEX__MODEL_CONTEXT_WINDOW: '1050000', CODEX__MODEL_CONTEXT_MODEL: 'gpt-5.6-sol' },
    compactThreshold: 400000,
  }), {
    modelContextWindow: 1050000,
    model: 'gpt-5.6-sol',
    source: 'provider env',
  });
});

test('resolveCodexModelLimits supports per-model context and compact limits', () => {
  assert.deepEqual(resolveCodexModelLimits({
    env: {
      CODEX__MODEL_CONTEXT_WINDOWS: JSON.stringify({ 'gpt-5.6-sol': 1050000, 'gpt-5.6-luna': 1050000 }),
      CODEX__MODEL_AUTO_COMPACT_TOKEN_LIMITS: JSON.stringify({ 'gpt-5.6-sol': 400000, 'gpt-5.6-luna': 40000 }),
    },
    compactThreshold: 400000,
  }), {
    contextWindows: { 'gpt-5.6-sol': 1050000, 'gpt-5.6-luna': 1050000 },
    compactTokenLimits: { 'gpt-5.6-sol': 400000, 'gpt-5.6-luna': 40000 },
  });
});

test('resolveCodexModelLimits rejects malformed model limit maps', () => {
  assert.throws(
    () => resolveCodexModelLimits({
      env: { CODEX__MODEL_AUTO_COMPACT_TOKEN_LIMITS: '{"gpt-5.6-luna":"40k"}' },
    }),
    /invalid Codex compact limit map/,
  );
});

test('resolveCodexContextLimits rejects malformed context values', () => {
  assert.throws(
    () => resolveCodexContextLimits({
      env: { CODEX__MODEL_CONTEXT_WINDOW: '1M' },
      compactThreshold: 400000,
    }),
    /invalid Codex context window.*1M/,
  );
});

test('resolveCodexContextLimits rejects a compact threshold outside the configured context', () => {
  assert.throws(
    () => resolveCodexContextLimits({
      env: { CODEX__MODEL_CONTEXT_WINDOW: '300000' },
      compactThreshold: 400000,
    }),
    /compact threshold 400000 must be below context window 300000/,
  );
});

test('prepareCodexModelCatalog adjusts only the requested model without touching the source cache', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-catalog-'));
  const source = path.join(root, 'source.json');
  const output = path.join(root, 'data', 'catalog.json');
  const original = {
    fetched_at: 'now',
    models: [
      { slug: 'gpt-5.6-sol', context_window: 272000, max_context_window: 872000 },
      { slug: 'gpt-5.6-luna', context_window: 272000, max_context_window: 872000 },
      { slug: 'gpt-5.5', context_window: 272000, max_context_window: 272000 },
    ],
  };
  fs.writeFileSync(source, JSON.stringify(original));
  assert.equal(prepareCodexModelCatalog({
    sourcePath: source,
    outputPath: output,
    modelContextWindows: { 'gpt-5.6-sol': 1050000, 'gpt-5.6-luna': 1050000 },
  }), output);
  assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), original);
  const generated = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(generated.models[0].context_window, 1050000);
  assert.equal(generated.models[0].max_context_window, 1050000);
  assert.equal(generated.models[1].context_window, 1050000);
  assert.equal(generated.models[2].context_window, 272000);
});
