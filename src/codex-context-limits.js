import fs from 'node:fs';
import path from 'node:path';

function readPositiveInteger(env, key) {
  const raw = env?.[key];
  if (raw === null || raw === undefined || String(raw).trim() === '') return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`invalid Codex context window: ${key}=${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid Codex context window: ${key}=${text}`);
  }
  return value;
}

function readModelLimitMap(env, keys, label) {
  for (const key of keys) {
    const raw = env?.[key];
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch (err) {
      throw new Error(`invalid Codex ${label} map: ${key}=${String(raw).trim()}`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`invalid Codex ${label} map: ${key} must be a JSON object`);
    }
    const result = {};
    for (const [model, value] of Object.entries(parsed)) {
      const normalizedModel = String(model || '').trim();
      if (!normalizedModel) throw new Error(`invalid Codex ${label} map: empty model name`);
      const mapKey = `${key}.${normalizedModel}`;
      const text = String(value).trim();
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0) {
        throw new Error(`invalid Codex ${label} map: ${mapKey}=${text}`);
      }
      const tokens = Number(text);
      result[normalizedModel] = tokens;
    }
    return result;
  }
  return {};
}

export function resolveCodexContextLimits({
  env = process.env,
  compactThreshold = null,
  appliedProviderScope = null,
  appliedScopedKeys = [],
  defaultModel = null,
} = {}) {
  const prefixed = readPositiveInteger(env, 'CODEX__MODEL_CONTEXT_WINDOW');
  const suffixed = readPositiveInteger(env, 'MODEL_CONTEXT_WINDOW_CODEX');
  const globalWasOverwrittenByAnotherProvider = appliedProviderScope
    && appliedProviderScope !== 'codex'
    && new Set(appliedScopedKeys).has('MODEL_CONTEXT_WINDOW');
  const globalValue = globalWasOverwrittenByAnotherProvider
    ? null
    : readPositiveInteger(env, 'MODEL_CONTEXT_WINDOW');
  const modelContextWindow = prefixed ?? suffixed ?? globalValue;
  const configuredModel = String(
    env.CODEX__MODEL_CONTEXT_MODEL
      || env.MODEL_CONTEXT_MODEL_CODEX
      || env.MODEL_CONTEXT_MODEL
      || defaultModel
      || '',
  ).trim() || null;
  const source = prefixed !== null || suffixed !== null
    ? 'provider env'
    : globalValue !== null
      ? 'env default'
      : 'provider catalog';

  if (modelContextWindow !== null && compactThreshold !== null) {
    if (!Number.isSafeInteger(compactThreshold) || compactThreshold <= 0) {
      throw new Error(`invalid Codex compact threshold: ${compactThreshold}`);
    }
    if (compactThreshold >= modelContextWindow) {
      throw new Error(
        `invalid Codex context limits: compact threshold ${compactThreshold} must be below context window ${modelContextWindow}`,
      );
    }
  }

  return { modelContextWindow, model: configuredModel, source };
}

export function resolveCodexModelLimits({
  env = process.env,
  compactThreshold = null,
  appliedProviderScope = null,
  appliedScopedKeys = [],
  defaultModel = null,
} = {}) {
  const scalar = resolveCodexContextLimits({
    env,
    compactThreshold,
    appliedProviderScope,
    appliedScopedKeys,
    defaultModel,
  });
  const contextWindows = readModelLimitMap(
    env,
    ['CODEX__MODEL_CONTEXT_WINDOWS', 'MODEL_CONTEXT_WINDOWS_CODEX', 'MODEL_CONTEXT_WINDOWS'],
    'context window',
  );
  const compactTokenLimits = readModelLimitMap(
    env,
    ['CODEX__MODEL_AUTO_COMPACT_TOKEN_LIMITS', 'MODEL_AUTO_COMPACT_TOKEN_LIMITS_CODEX', 'MODEL_AUTO_COMPACT_TOKEN_LIMITS'],
    'compact limit',
  );
  if (!Object.keys(contextWindows).length && scalar.modelContextWindow !== null && scalar.model) {
    contextWindows[scalar.model] = scalar.modelContextWindow;
  }
  if (!Object.keys(compactTokenLimits).length && compactThreshold !== null && scalar.model) {
    compactTokenLimits[scalar.model] = compactThreshold;
  }
  for (const [model, tokens] of Object.entries(compactTokenLimits)) {
    const context = contextWindows[model];
    if (context !== undefined && tokens >= context) {
      throw new Error(`invalid Codex context limits for ${model}: compact threshold ${tokens} must be below context window ${context}`);
    }
  }
  return { contextWindows, compactTokenLimits };
}

export function prepareCodexModelCatalog({
  sourcePath,
  outputPath,
  targetModel,
  contextWindow,
  modelContextWindows = null,
} = {}) {
  const source = path.resolve(String(sourcePath || ''));
  const output = path.resolve(String(outputPath || ''));
  const target = String(targetModel || '').trim().toLowerCase();
  const requestedWindows = modelContextWindows && typeof modelContextWindows === 'object'
    ? modelContextWindows
    : target && contextWindow !== null && contextWindow !== undefined
      ? { [targetModel]: contextWindow }
      : {};
  if (!source || !output || !Object.keys(requestedWindows).length) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(source, 'utf8'));
  } catch (err) {
    throw new Error(`unable to read Codex model catalog ${source}: ${err.message}`);
  }
  if (!parsed || !Array.isArray(parsed.models)) {
    throw new Error(`Codex model catalog ${source} must contain a models array`);
  }
  const models = parsed.models.map((model) => ({ ...model }));
  for (const [modelName, requestedWindow] of Object.entries(requestedWindows)) {
    const modelKey = String(modelName || '').trim().toLowerCase();
    const targetEntry = models.find((model) => String(model?.slug || '').trim().toLowerCase() === modelKey);
    if (!targetEntry) throw new Error(`Codex model catalog ${source} does not contain ${modelName}`);
    targetEntry.context_window = requestedWindow;
    targetEntry.max_context_window = requestedWindow;
    targetEntry.effective_context_window_percent = 100;
  }

  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (fs.existsSync(output)) {
    try {
      const existing = JSON.parse(fs.readFileSync(output, 'utf8'));
      if (!existing || !Array.isArray(existing.models)) {
        throw new Error('existing generated catalog is malformed');
      }
    } catch (err) {
      throw new Error(`refusing to replace malformed generated Codex model catalog ${output}: ${err.message}`);
    }
  }
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ ...parsed, models }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, output);
  return output;
}
