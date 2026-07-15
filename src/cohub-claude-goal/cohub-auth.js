import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactSecrets } from './redaction.js';

const PROD_ISSUER = 'https://auth.neta.art';
const PROD_CLIENT_ID = 'f8d26cdlwx85b0e5l3om2';
const PROD_RESOURCE = 'https://api.talesofai';

const REQUIRED_FIELDS = [
  'schemaVersion',
  'env',
  'issuer',
  'clientId',
  'resource',
  'scope',
  'tokenType',
  'accessToken',
  'refreshToken',
  'accessTokenExpiresAt',
  'createdAt',
  'updatedAt',
];

const OPTIONAL_FIELDS = ['idToken'];

const KNOWN_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

const POSITIVE_INT_FIELDS = ['accessTokenExpiresAt', 'createdAt', 'updatedAt'];

const KNOWN_RESPONSE_FIELDS = new Set([
  'access_token',
  'refresh_token',
  'id_token',
  'token_type',
  'expires_in',
  'scope',
  'error',
  'error_description',
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * Parse JSON with duplicate key detection.
 * Standard JSON.parse silently accepts the last value for duplicate keys,
 * which could mask tampering. This parser rejects duplicates.
 */
function parseJSONStrictly(text) {
  const keys = new Set();
  let insideString = false;
  let escapeNext = false;
  let currentKey = null;
  let depth = 0;
  let pos = 0;
  let expectingKey = false; // Track whether next string is a key or value

  // Simple state machine to track keys at depth 1 (top-level object keys)
  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      if (insideString) {
        insideString = false;
        if (depth === 1 && expectingKey && currentKey === null) {
          const rawKey = text.slice(pos, i);
          // Parse the key string to normalize escapes (e.g., e -> e)
          try {
            const normalizedKey = JSON.parse('"' + rawKey + '"');
            if (keys.has(normalizedKey)) {
              throw new Error(`Duplicate key detected in JSON: ${normalizedKey}`);
            }
            currentKey = normalizedKey;
          } catch (e) {
            if (e.message && e.message.includes('Duplicate key')) {
              throw e;
            }
            // If key parsing fails, just use raw key
            currentKey = rawKey;
            if (keys.has(currentKey)) {
              throw new Error(`Duplicate key detected in JSON: ${currentKey}`);
            }
          }
          expectingKey = false;
        }
      } else {
        insideString = true;
        if (depth === 1 && expectingKey) {
          pos = i + 1;
        }
      }
      continue;
    }

    if (insideString) continue;

    if (char === ':' && depth === 1 && currentKey !== null) {
      keys.add(currentKey);
      currentKey = null;
    } else if (char === '{') {
      depth++;
      if (depth === 1) {
        expectingKey = true;
      }
    } else if (char === '}') {
      depth--;
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
    } else if (char === ',' && depth === 1) {
      expectingKey = true;
    }
  }

  return JSON.parse(text);
}

/**
 * Thrown for every failure path in this module. `category` is a small
 * closed vocabulary (never a raw upstream message) so callers/audit logs
 * can branch on failure kind without risking secret leakage.
 */
export class CohubAuthError extends Error {
  constructor(category, message) {
    super(message);
    this.name = 'CohubAuthError';
    this.category = category;
  }
}

function authError(category, message, sentinels = []) {
  const err = new CohubAuthError(category, message);
  return redactSecrets(err, { sentinels });
}

function validateAuthRecord(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new CohubAuthError('invalid_schema', 'auth.json must be a JSON object');
  }

  // Check it's a plain object with Object.prototype, no exotic prototype
  const proto = Object.getPrototypeOf(record);
  if (proto !== Object.prototype) {
    throw new CohubAuthError('invalid_schema', 'auth.json must be a plain object');
  }

  // Use own property checks only
  const ownKeys = Object.keys(record);
  for (const key of ownKeys) {
    if (!KNOWN_FIELDS.has(key)) {
      throw new CohubAuthError('invalid_schema', `auth.json contains unknown field: ${key}`);
    }
  }

  for (const field of REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      throw new CohubAuthError('invalid_schema', `auth.json missing required field: ${field}`);
    }
  }

  if (record.schemaVersion !== 1) {
    throw new CohubAuthError('invalid_schema', 'auth.json schemaVersion must be 1');
  }
  if (record.env !== 'prod') {
    throw new CohubAuthError('invalid_schema', 'auth.json env must be prod');
  }
  if (record.issuer !== PROD_ISSUER) {
    throw new CohubAuthError('invalid_schema', `auth.json issuer must be exactly ${PROD_ISSUER}`);
  }
  if (record.clientId !== PROD_CLIENT_ID) {
    throw new CohubAuthError('invalid_schema', `auth.json clientId must be exactly ${PROD_CLIENT_ID}`);
  }
  if (record.resource !== PROD_RESOURCE) {
    throw new CohubAuthError('invalid_schema', `auth.json resource must be exactly ${PROD_RESOURCE}`);
  }
  if (record.tokenType !== 'Bearer') {
    throw new CohubAuthError('invalid_schema', 'auth.json tokenType must be Bearer');
  }
  if (typeof record.scope !== 'string') {
    throw new CohubAuthError('invalid_schema', 'auth.json scope must be a string (may be empty)');
  }
  if (!isNonEmptyString(record.accessToken)) {
    throw new CohubAuthError('invalid_schema', 'auth.json accessToken must be a non-empty string');
  }
  if (!isNonEmptyString(record.refreshToken)) {
    throw new CohubAuthError('invalid_schema', 'auth.json refreshToken must be a non-empty string');
  }
  if (Object.prototype.hasOwnProperty.call(record, 'idToken') && !isNonEmptyString(record.idToken)) {
    throw new CohubAuthError('invalid_schema', 'auth.json idToken must be a non-empty string when present');
  }

  for (const field of POSITIVE_INT_FIELDS) {
    if (!isPositiveSafeInteger(record[field])) {
      throw new CohubAuthError(
        'invalid_schema',
        `auth.json ${field} must be a positive safe integer timestamp`
      );
    }
  }
}

function parseRefreshResponseText(text) {
  let body;
  try {
    body = parseJSONStrictly(text);
  } catch (err) {
    if (err.message && err.message.includes('Duplicate key')) {
      throw new CohubAuthError('bad_response', 'token refresh response contains duplicate keys');
    }
    throw new CohubAuthError('bad_response', 'token refresh response is not valid JSON');
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new CohubAuthError('bad_response', 'token refresh response must be a JSON object');
  }

  return body;
}

function validateRefreshResponseBody(body) {
  for (const key of Object.keys(body)) {
    if (!KNOWN_RESPONSE_FIELDS.has(key)) {
      throw new CohubAuthError('bad_response', `refresh response contains unknown field: ${key}`);
    }
  }

  if (!isNonEmptyString(body.access_token)) {
    throw new CohubAuthError('bad_response', 'refresh response missing access_token');
  }
  if (body.token_type !== 'Bearer') {
    throw new CohubAuthError('bad_response', 'refresh response token_type must be Bearer');
  }
  if (!Number.isSafeInteger(body.expires_in) || body.expires_in <= 0) {
    throw new CohubAuthError('bad_response', 'refresh response expires_in must be a positive safe integer');
  }
  if ('refresh_token' in body && !isNonEmptyString(body.refresh_token)) {
    throw new CohubAuthError('bad_response', 'refresh response refresh_token must be a non-empty string when present');
  }
  if ('id_token' in body && !isNonEmptyString(body.id_token)) {
    throw new CohubAuthError('bad_response', 'refresh response id_token must be a non-empty string when present');
  }
  if ('scope' in body && typeof body.scope !== 'string') {
    throw new CohubAuthError('bad_response', 'refresh response scope must be a string when present');
  }
}

export class CohubAuth {
  #authPath;
  #record;
  #console;
  #lock = Promise.resolve();

  constructor(authPath, options = {}) {
    this.#authPath = authPath;
    this.#console = options.console ?? console;

    // Open with O_RDONLY | O_NOFOLLOW to prevent TOCTOU symlink-swap race
    let fd;
    try {
      fd = fs.openSync(authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new CohubAuthError('not_found', `auth file not found: ${authPath}`);
      }
      if (err.code === 'ELOOP') {
        throw new CohubAuthError('unsafe_file', `auth file must not be a symlink: ${authPath}`);
      }
      throw new CohubAuthError('unsafe_file', `cannot open auth file: ${authPath}`);
    }

    let stats;
    let raw;
    try {
      // fstat the open fd, not lstat the path (prevents race)
      stats = fs.fstatSync(fd);

      if (!stats.isFile()) {
        throw new CohubAuthError('unsafe_file', `auth file is not a regular file: ${authPath}`);
      }

      if ((stats.mode & 0o777) !== 0o600) {
        throw new CohubAuthError(
          'unsafe_file',
          `auth file must have mode 0600 (found 0${(stats.mode & 0o777).toString(8)}): ${authPath}`
        );
      }

      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }

    let record;
    try {
      record = parseJSONStrictly(raw);
    } catch (err) {
      if (err.message && err.message.includes('Duplicate key')) {
        throw new CohubAuthError('invalid_schema', `auth file contains duplicate keys: ${authPath}`);
      }
      throw new CohubAuthError('invalid_schema', `auth file contains invalid JSON: ${authPath}`);
    }

    validateAuthRecord(record);
    this.#record = record;
  }

  getAccessToken() {
    return this.#record.accessToken;
  }

  getTokenType() {
    return this.#record.tokenType;
  }

  getAccessTokenExpiresAt() {
    return this.#record.accessTokenExpiresAt;
  }

  #secretSentinels(extra = []) {
    const sentinels = [this.#record.accessToken, this.#record.refreshToken, ...extra];
    if (this.#record.idToken) sentinels.push(this.#record.idToken);
    return sentinels;
  }

  /** Public entry point — serializes concurrent calls onto a single queue. */
  async refresh(options = {}) {
    const runNext = this.#lock.then(() => this.#doRefresh(options), () => this.#doRefresh(options));
    this.#lock = runNext.then(() => undefined, () => undefined);
    return runNext;
  }

  async #doRefresh(options) {
    const fetchImpl = options.fetch ?? globalThis.fetch;
    const now = options.now ?? (() => Date.now());
    const sentinels = this.#secretSentinels();

    const tokenUrl = `${this.#record.issuer}/oidc/token`;
    const formBody = new URLSearchParams({
      client_id: this.#record.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.#record.refreshToken,
      scope: this.#record.scope,
      resource: this.#record.resource,
    }).toString();

    let response;
    let responseText;
    let responseBody;
    let newRecord;
    try {
      try {
        response = await fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: formBody,
        });
      } catch (err) {
        throw authError('network_error', 'token refresh network request failed', sentinels);
      }

      try {
        responseText = await response.text();
      } catch (err) {
        throw authError('bad_response', 'token refresh response body could not be read', sentinels);
      }

      responseBody = parseRefreshResponseText(responseText);

      if (!response.ok) {
        // Map upstream error to closed vocabulary category, never reflect raw errorCode
        const errorCode = isNonEmptyString(responseBody?.error) ? responseBody.error : null;
        const category = errorCode === 'invalid_grant' || errorCode === 'invalid_token'
          ? errorCode
          : 'refresh_rejected';
        // Don't include errorCode in message to avoid leaking upstream format
        throw authError(category, `token refresh rejected (status ${response.status})`, [
          ...sentinels,
          ...(isNonEmptyString(responseBody?.access_token) ? [responseBody.access_token] : []),
          ...(isNonEmptyString(responseBody?.refresh_token) ? [responseBody.refresh_token] : []),
        ]);
      }

      validateRefreshResponseBody(responseBody);

      const nowMs = now();
      if (!Number.isSafeInteger(nowMs) || nowMs <= 0) {
        throw new CohubAuthError('invalid_time', 'now() must return a positive safe integer');
      }

      const expiresInMs = responseBody.expires_in * 1000;
      if (!Number.isSafeInteger(expiresInMs)) {
        throw new CohubAuthError('bad_response', 'expires_in * 1000 overflows safe integer');
      }

      const accessTokenExpiresAt = nowMs + expiresInMs;
      if (!Number.isSafeInteger(accessTokenExpiresAt)) {
        throw new CohubAuthError('bad_response', 'computed accessTokenExpiresAt overflows safe integer');
      }

      newRecord = {
        schemaVersion: this.#record.schemaVersion,
        env: this.#record.env,
        issuer: this.#record.issuer,
        clientId: this.#record.clientId,
        resource: this.#record.resource,
        scope: isNonEmptyString(responseBody.scope) || responseBody.scope === ''
          ? responseBody.scope
          : this.#record.scope,
        tokenType: responseBody.token_type,
        accessToken: responseBody.access_token,
        refreshToken: isNonEmptyString(responseBody.refresh_token)
          ? responseBody.refresh_token
          : this.#record.refreshToken,
        ...(isNonEmptyString(responseBody.id_token)
          ? { idToken: responseBody.id_token }
          : this.#record.idToken
            ? { idToken: this.#record.idToken }
            : {}),
        accessTokenExpiresAt,
        createdAt: this.#record.createdAt,
        updatedAt: nowMs,
      };
      validateAuthRecord(newRecord);
    } catch (err) {
      if (err instanceof CohubAuthError) throw err;
      throw authError('unknown_error', 'token refresh failed', [
        ...sentinels,
        ...(isNonEmptyString(responseBody?.access_token) ? [responseBody.access_token] : []),
        ...(isNonEmptyString(responseBody?.refresh_token) ? [responseBody.refresh_token] : []),
      ]);
    }

    try {
      this.#writeRecordAtomically(newRecord);
    } catch (err) {
      // If write failed, disk still has old record, memory attempted new record
      // Re-read from disk to reconcile and keep them consistent
      try {
        const fd = fs.openSync(this.#authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const raw = fs.readFileSync(fd, 'utf8');
          const diskRecord = parseJSONStrictly(raw);
          validateAuthRecord(diskRecord);
          this.#record = diskRecord;
        } finally {
          fs.closeSync(fd);
        }
      } catch {}

      throw authError(
        'write_failed',
        'token refresh succeeded but writing auth.json failed',
        this.#secretSentinels([newRecord.accessToken, newRecord.refreshToken])
      );
    }

    this.#record = newRecord;
    this.#console.log('cohub-auth: token refreshed');
    return { refreshed: true };
  }

  #writeRecordAtomically(record) {
    const dir = path.dirname(this.#authPath);
    const tmpPath = path.join(
      dir,
      `.${path.basename(this.#authPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );

    const fd = fs.openSync(tmpPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      fs.renameSync(tmpPath, this.#authPath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {}
      throw err;
    }

    // Directory fsync after rename
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } catch (dirSyncErr) {
      // Rename succeeded but directory fsync failed
      // Data is on disk but durability is ambiguous
      // Re-read from disk to reconcile memory state
      try {
        const verifyFd = fs.openSync(this.#authPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const raw = fs.readFileSync(verifyFd, 'utf8');
          const diskRecord = parseJSONStrictly(raw);
          validateAuthRecord(diskRecord);
          // Disk has the new record, so the write did commit
          // Memory will be updated by caller after this returns
        } finally {
          fs.closeSync(verifyFd);
        }
      } catch {}
      // Throw to signal ambiguous integrity state
      throw new CohubAuthError('integrity_ambiguous', 'rename succeeded but directory fsync failed');
    } finally {
      fs.closeSync(dirFd);
    }
  }
}
