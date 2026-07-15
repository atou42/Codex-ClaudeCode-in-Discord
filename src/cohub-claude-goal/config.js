import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalStringify } from './canonical.js';
import { writeFileAtomic } from './atomic-file.js';
import { IntegrityError } from './errors.js';

export class ConfigValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export const CONFIRMED_CLAUDE_CODE_VERSION = '2.1.201';
export const CONFIRMED_COHUB_CLI_VERSION = '2.3.2';
export const CONFIRMED_COHUB_SDK_VERSION = '2.11.1';

const ALLOWED_LEGAL_HUMAN_GATES = new Set(['proposal_approval', 'style_approval', 'studio_acceptance']);
const ALLOWED_MODES = new Set(['supervisor']);
const ALLOWED_CONTINUATION_AUTHORITY = new Set(['external_event_bridge']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GOAL_INSTANCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const REQUIRED_FIELDS = [
  'schemaVersion',
  'goalInstance',
  'goalVersion',
  'mode',
  'spaceId',
  'parentSessionId',
  'historicalParentSessionIds',
  'runPath',
  'statePath',
  'gateLogPath',
  'manifestPath',
  'legalHumanGates',
  'consumedHumanGates',
  'continuationAuthority',
  'claudeCodeVersion',
  'cohubCliVersion',
  'cohubSdkVersion',
];

const ALLOWED_FIELDS = new Set(REQUIRED_FIELDS);

function fail(message) {
  throw new ConfigValidationError(`goal config: ${message}`);
}

function assertUuid(value, fieldName) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    fail(`${fieldName} must be a valid UUID string, got ${JSON.stringify(value)}`);
  }
}

/**
 * A normalized run-subpath must be relative, forward-slash separated, use no
 * ".." segments, and (for paths other than runPath itself) resolve to a
 * location inside runPath. This guards against absolute paths, backslashes,
 * and traversal that could otherwise escape the sandboxed run directory.
 */
function assertNormalizedSubpath(value, fieldName, { withinRunPath } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${fieldName} must be a nonempty string`);
  }
  if (value.includes('\\')) {
    fail(`${fieldName} must use forward slashes only, got ${JSON.stringify(value)}`);
  }
  if (path.isAbsolute(value)) {
    fail(`${fieldName} must be a relative path, got ${JSON.stringify(value)}`);
  }
  const segments = value.split('/');
  if (segments.some((seg) => seg === '..' || seg === '.')) {
    fail(`${fieldName} must not contain "." or ".." segments, got ${JSON.stringify(value)}`);
  }
  if (segments.some((seg) => seg.length === 0)) {
    fail(`${fieldName} must not contain empty segments, got ${JSON.stringify(value)}`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value) {
    fail(`${fieldName} must already be normalized, got ${JSON.stringify(value)}`);
  }
  if (withinRunPath) {
    const rel = path.posix.relative(withinRunPath, value);
    if (rel.startsWith('..') || rel === '') {
      fail(`${fieldName} must be located inside runPath (${withinRunPath}), got ${JSON.stringify(value)}`);
    }
  }
}

const FORBIDDEN_FIELD_NAME_PATTERNS = [/token/i, /secret/i, /password/i, /credential/i, /command/i, /\bcmd\b/i, /shell/i, /exec/i];

export function validateGoalConfig(config) {
  if (!isPlainObject(config)) {
    fail('config must be a genuine plain object (no class instance or custom prototype)');
  }

  const actualKeys = Object.keys(config);
  for (const key of actualKeys) {
    if (POLLUTION_KEYS.has(key)) {
      fail(`field "${key}" is a dangerous prototype-pollution key and is never allowed`);
    }
    if (!ALLOWED_FIELDS.has(key)) {
      fail(`unknown field "${key}" is not in the fixed allowlist`);
    }
    if (FORBIDDEN_FIELD_NAME_PATTERNS.some((re) => re.test(key))) {
      fail(`field "${key}" looks like a token/secret/command field, which is never allowed in goal config`);
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(config, key)) {
      fail(`missing required field "${key}"`);
    }
  }

  if (config.schemaVersion !== 1) {
    fail(`schemaVersion must be exactly 1, got ${JSON.stringify(config.schemaVersion)}`);
  }

  if (typeof config.goalInstance !== 'string' || !GOAL_INSTANCE_RE.test(config.goalInstance)) {
    fail(`goalInstance must match ${GOAL_INSTANCE_RE}, got ${JSON.stringify(config.goalInstance)}`);
  }

  if (!Number.isInteger(config.goalVersion) || config.goalVersion < 1) {
    fail(`goalVersion must be an integer >= 1, got ${JSON.stringify(config.goalVersion)}`);
  }

  if (!ALLOWED_MODES.has(config.mode)) {
    fail(`mode must be one of ${[...ALLOWED_MODES].join(', ')}, got ${JSON.stringify(config.mode)}`);
  }

  assertUuid(config.spaceId, 'spaceId');
  assertUuid(config.parentSessionId, 'parentSessionId');

  if (!Array.isArray(config.historicalParentSessionIds)) {
    fail('historicalParentSessionIds must be an array');
  }
  config.historicalParentSessionIds.forEach((id, i) => assertUuid(id, `historicalParentSessionIds[${i}]`));

  assertNormalizedSubpath(config.runPath, 'runPath');
  assertNormalizedSubpath(config.statePath, 'statePath', { withinRunPath: config.runPath });
  assertNormalizedSubpath(config.gateLogPath, 'gateLogPath', { withinRunPath: config.runPath });
  assertNormalizedSubpath(config.manifestPath, 'manifestPath', { withinRunPath: config.runPath });

  if (!Array.isArray(config.legalHumanGates) || config.legalHumanGates.length === 0) {
    fail('legalHumanGates must be a nonempty array');
  }
  const seenLegal = new Set();
  for (const gate of config.legalHumanGates) {
    if (!ALLOWED_LEGAL_HUMAN_GATES.has(gate)) {
      fail(`legalHumanGates contains unknown gate ${JSON.stringify(gate)}`);
    }
    if (seenLegal.has(gate)) {
      fail(`legalHumanGates contains duplicate gate ${JSON.stringify(gate)}`);
    }
    seenLegal.add(gate);
  }

  if (!Array.isArray(config.consumedHumanGates)) {
    fail('consumedHumanGates must be an array');
  }
  const seenConsumed = new Set();
  for (const gate of config.consumedHumanGates) {
    if (!seenLegal.has(gate)) {
      fail(`consumedHumanGates contains gate ${JSON.stringify(gate)} not present in legalHumanGates`);
    }
    if (seenConsumed.has(gate)) {
      fail(`consumedHumanGates contains duplicate gate ${JSON.stringify(gate)}`);
    }
    seenConsumed.add(gate);
  }

  if (!ALLOWED_CONTINUATION_AUTHORITY.has(config.continuationAuthority)) {
    fail(
      `continuationAuthority must be one of ${[...ALLOWED_CONTINUATION_AUTHORITY].join(', ')}, got ${JSON.stringify(
        config.continuationAuthority,
      )}`,
    );
  }

  if (config.claudeCodeVersion !== CONFIRMED_CLAUDE_CODE_VERSION) {
    fail(`claudeCodeVersion must be exactly ${CONFIRMED_CLAUDE_CODE_VERSION}, got ${JSON.stringify(config.claudeCodeVersion)}`);
  }
  if (config.cohubCliVersion !== CONFIRMED_COHUB_CLI_VERSION) {
    fail(`cohubCliVersion must be exactly ${CONFIRMED_COHUB_CLI_VERSION}, got ${JSON.stringify(config.cohubCliVersion)}`);
  }
  if (config.cohubSdkVersion !== CONFIRMED_COHUB_SDK_VERSION) {
    fail(`cohubSdkVersion must be exactly ${CONFIRMED_COHUB_SDK_VERSION}, got ${JSON.stringify(config.cohubSdkVersion)}`);
  }
}

const GOAL_FILE_NAME = 'goal.json';
const HASH_SIDECAR_NAME = 'goal.json.sha256';

function sha256OfBytes(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function createGoalConfig(dir, config) {
  validateGoalConfig(config);

  let dirEntries;
  try {
    dirEntries = await fsPromises.readdir(dir);
  } catch (err) {
    throw new ConfigValidationError(`goal config: target directory does not exist or is not readable: ${dir} (${err.message})`);
  }
  if (dirEntries.length > 0) {
    throw new ConfigValidationError(`goal config: target directory must be empty, found: ${dirEntries.join(', ')}`);
  }

  const goalPath = path.join(dir, GOAL_FILE_NAME);
  const sidecarPath = path.join(dir, HASH_SIDECAR_NAME);

  const canonicalBody = canonicalStringify(config);
  const prettyBody = JSON.stringify(config, null, 2);
  const goalBytes = Buffer.from(prettyBody, 'utf8');
  const hash = sha256OfBytes(goalBytes);

  await writeFileAtomic(goalPath, goalBytes, { mode: 0o600 });
  await writeFileAtomic(sidecarPath, `${hash}\n`, { mode: 0o600 });

  const rereadBytes = await fsPromises.readFile(goalPath);
  if (!rereadBytes.equals(goalBytes)) {
    throw new IntegrityError(
      `goal config: reread bytes mismatch immediately after create for ${goalPath} (expected exact byte identity with what was written)`,
    );
  }
  const rereadSidecarBytes = await fsPromises.readFile(sidecarPath);
  if (!rereadSidecarBytes.equals(Buffer.from(`${hash}\n`, 'utf8'))) {
    throw new IntegrityError(
      `goal config: reread sidecar bytes mismatch immediately after create for ${sidecarPath}`,
    );
  }

  return { hash, path: goalPath, sidecarPath, canonicalBody };
}

async function assertRegularFileWithMode(filePath, expectedMode) {
  let st;
  try {
    st = await fsPromises.lstat(filePath);
  } catch (err) {
    throw new IntegrityError(`goal config: unable to lstat ${filePath}: ${err.message}`);
  }
  if (!st.isFile()) {
    throw new IntegrityError(`goal config: ${filePath} must be a regular file (not a symlink/directory/special file)`);
  }
  if ((st.mode & 0o777) !== expectedMode) {
    throw new IntegrityError(
      `goal config: ${filePath} has mode ${(st.mode & 0o777).toString(8)}, expected ${expectedMode.toString(8)}`,
    );
  }
}

/**
 * Detects duplicate keys within any single JSON object literal in the raw
 * text. JSON.parse silently applies "last value wins" for duplicate keys,
 * so a byte mutation that inserts a duplicate key with the same resulting
 * value would otherwise be invisible to hash-of-parsed-value checks. This
 * walks the token stream directly against the raw bytes instead.
 */
function assertNoDuplicateJsonKeys(text) {
  let i = 0;
  const n = text.length;

  function skipWs() {
    while (i < n && /\s/.test(text[i])) i += 1;
  }

  function parseString() {
    if (text[i] !== '"') throw new IntegrityError('goal config: expected string while scanning JSON for duplicate keys');
    i += 1;
    while (i < n) {
      const ch = text[i];
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '"') {
        i += 1;
        return;
      }
      i += 1;
    }
    throw new IntegrityError('goal config: unterminated string while scanning JSON for duplicate keys');
  }

  function parseValue() {
    skipWs();
    const ch = text[i];
    if (ch === '{') {
      parseObject();
    } else if (ch === '[') {
      parseArray();
    } else if (ch === '"') {
      parseString();
    } else {
      // number, true, false, null: scan until a structural/whitespace char
      const start = i;
      while (i < n && !/[\s,}\]]/.test(text[i])) i += 1;
      if (i === start) {
        throw new IntegrityError('goal config: unexpected character while scanning JSON for duplicate keys');
      }
    }
  }

  function parseObject() {
    i += 1; // {
    const seenKeys = new Set();
    skipWs();
    if (text[i] === '}') {
      i += 1;
      return;
    }
    for (;;) {
      skipWs();
      const keyStart = i;
      parseString();
      const key = JSON.parse(text.slice(keyStart, i));
      if (seenKeys.has(key)) {
        throw new IntegrityError(`goal config: duplicate JSON key "${key}" detected in object literal`);
      }
      seenKeys.add(key);
      skipWs();
      if (text[i] !== ':') throw new IntegrityError('goal config: expected ":" while scanning JSON for duplicate keys');
      i += 1;
      parseValue();
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === '}') {
        i += 1;
        return;
      }
      throw new IntegrityError('goal config: expected "," or "}" while scanning JSON for duplicate keys');
    }
  }

  function parseArray() {
    i += 1; // [
    skipWs();
    if (text[i] === ']') {
      i += 1;
      return;
    }
    for (;;) {
      parseValue();
      skipWs();
      if (text[i] === ',') {
        i += 1;
        continue;
      }
      if (text[i] === ']') {
        i += 1;
        return;
      }
      throw new IntegrityError('goal config: expected "," or "]" while scanning JSON for duplicate keys');
    }
  }

  parseValue();
}

export async function loadGoalConfig(dir) {
  const goalPath = path.join(dir, GOAL_FILE_NAME);
  const sidecarPath = path.join(dir, HASH_SIDECAR_NAME);

  await assertRegularFileWithMode(goalPath, 0o600);
  await assertRegularFileWithMode(sidecarPath, 0o600);

  let rawBytes;
  try {
    rawBytes = await fsPromises.readFile(goalPath);
  } catch (err) {
    throw new Error(`goal config: unable to read ${goalPath}: ${err.message}`);
  }

  let sidecarBytes;
  try {
    sidecarBytes = await fsPromises.readFile(sidecarPath);
  } catch (err) {
    throw new IntegrityError(`goal config: missing or unreadable hash sidecar ${sidecarPath}: ${err.message}`);
  }
  if (sidecarBytes.length !== 65) {
    throw new IntegrityError(`goal config: hash sidecar ${sidecarPath} must be exactly 65 bytes (64 hex + newline), got ${sidecarBytes.length}`);
  }
  const expectedHash = sidecarBytes.slice(0, 64).toString('utf8');
  if (!/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new IntegrityError(`goal config: hash sidecar ${sidecarPath} does not contain a valid sha256 hex hash`);
  }
  if (sidecarBytes[64] !== 0x0a) {
    throw new IntegrityError(`goal config: hash sidecar ${sidecarPath} byte 65 must be newline (0x0a)`);
  }

  const actualHash = sha256OfBytes(rawBytes);
  if (actualHash !== expectedHash) {
    throw new IntegrityError(
      `goal config: hash mismatch for ${goalPath}: sidecar says ${expectedHash}, recomputed ${actualHash} from exact on-disk bytes (config was mutated after creation)`,
    );
  }

  const rawText = rawBytes.toString('utf8');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new IntegrityError(`goal config: malformed JSON in ${goalPath}: ${err.message}`);
  }

  assertNoDuplicateJsonKeys(rawText);

  const reserializedPretty = JSON.stringify(parsed, null, 2);
  if (reserializedPretty !== rawText) {
    throw new IntegrityError(
      `goal config: on-disk bytes for ${goalPath} are not exactly the canonical serialization of their own parsed value (byte-level mutation, e.g. whitespace change, detected)`,
    );
  }

  try {
    validateGoalConfig(parsed);
  } catch (err) {
    throw new IntegrityError(`goal config: on-disk config failed schema validation for ${goalPath}: ${err.message}`);
  }

  return { config: parsed, hash: actualHash, path: goalPath };
}
