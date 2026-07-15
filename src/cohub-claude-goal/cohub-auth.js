import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactSecrets } from './redaction.js';
import { parseJSONStrictly } from './strict-json-parser.js';

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
 * Capture exact own data descriptors from an object without invoking getters.
 * Returns a plain object with only data properties (throws on accessors).
 */
function captureOwnDataDescriptors(obj, requiredKeys = [], optionalKeys = []) {
  const result = Object.create(null);
  const allKeys = [...requiredKeys, ...optionalKeys];

  for (const key of allKeys) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (!desc) {
      if (requiredKeys.includes(key)) {
        throw new Error(`Missing required property: ${key}`);
      }
      continue;
    }

    if (desc.get || desc.set) {
      throw new Error(`Property ${key} is an accessor, not a data property`);
    }

    if (!('value' in desc)) {
      throw new Error(`Property ${key} has no value`);
    }

    result[key] = desc.value;
  }

  // Check for unknown keys
  const ownKeys = Object.getOwnPropertyNames(obj);
  for (const key of ownKeys) {
    if (!allKeys.includes(key)) {
      throw new Error(`Unknown property: ${key}`);
    }
  }

  return result;
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

  // Accept both Object.prototype and null prototype (from strict parser)
  const proto = Object.getPrototypeOf(record);
  if (proto !== Object.prototype && proto !== null) {
    throw new CohubAuthError('invalid_schema', 'auth.json must be a plain object');
  }

  // Use own property checks only
  const ownKeys = Object.keys(record);
  const ownNames = Object.getOwnPropertyNames(record);

  // For null-prototype objects, getOwnPropertyNames includes all keys
  const allOwnKeys = proto === null ? ownNames : ownKeys;

  for (const key of allOwnKeys) {
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
    if (err.message && err.message.toLowerCase().includes('duplicate')) {
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

    // Validate console Proxy-first
    let safeConsole = console;
    if (options && options.console !== undefined) {
      const consoleDesc = Object.getOwnPropertyDescriptor(options, 'console');
      if (!consoleDesc || consoleDesc.get || consoleDesc.set) {
        throw new CohubAuthError('invalid_options', 'options.console must be a data property');
      }
      if (typeof consoleDesc.value !== 'object' || consoleDesc.value === null) {
        throw new CohubAuthError('invalid_options', 'options.console must be an object');
      }
      safeConsole = consoleDesc.value;
    }
    this.#console = safeConsole;

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
      if (err.message && err.message.toLowerCase().includes('duplicate')) {
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
    // Validate options Proxy-first
    const safeOptions = this.#validateRefreshOptions(options);
    const fetchImpl = safeOptions.fetch;
    const now = safeOptions.now;
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
    let safeResponse;
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

      // Validate response Proxy-first using descriptors (returns Promise)
      safeResponse = await this.#validateFetchResponse(response, sentinels);

      if (!safeResponse.ok) {
        responseBody = parseRefreshResponseText(safeResponse.text);
        // Map upstream error to closed vocabulary category, never reflect raw errorCode
        const errorCode = isNonEmptyString(responseBody?.error) ? responseBody.error : null;
        const category = errorCode === 'invalid_grant' || errorCode === 'invalid_token'
          ? errorCode
          : 'refresh_rejected';
        // Don't include errorCode in message to avoid leaking upstream format
        throw authError(category, `token refresh rejected (status ${safeResponse.status})`, [
          ...sentinels,
          ...(isNonEmptyString(responseBody?.access_token) ? [responseBody.access_token] : []),
          ...(isNonEmptyString(responseBody?.refresh_token) ? [responseBody.refresh_token] : []),
        ]);
      }

      responseBody = parseRefreshResponseText(safeResponse.text);
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

    // Log using captured safe console
    const consoleLogDesc = Object.getOwnPropertyDescriptor(this.#console, 'log');
    if (consoleLogDesc && 'value' in consoleLogDesc && typeof consoleLogDesc.value === 'function') {
      consoleLogDesc.value.call(this.#console, 'cohub-auth: token refreshed');
    }

    return Object.freeze({ refreshed: true });
  }

  #validateRefreshOptions(options) {
    if (!options || typeof options !== 'object') {
      options = {};
    }

    // Validate fetch Proxy-first
    let fetchImpl = globalThis.fetch;
    if (options.fetch !== undefined) {
      const fetchDesc = Object.getOwnPropertyDescriptor(options, 'fetch');
      if (!fetchDesc || fetchDesc.get || fetchDesc.set) {
        throw new CohubAuthError('bad_response', 'options.fetch must be a data property');
      }
      if (typeof fetchDesc.value !== 'function') {
        throw new CohubAuthError('bad_response', 'options.fetch must be a function');
      }
      fetchImpl = fetchDesc.value;
    }

    // Validate now Proxy-first
    let now = () => Date.now();
    if (options.now !== undefined) {
      const nowDesc = Object.getOwnPropertyDescriptor(options, 'now');
      if (!nowDesc || nowDesc.get || nowDesc.set) {
        throw new CohubAuthError('bad_response', 'options.now must be a data property');
      }
      if (typeof nowDesc.value !== 'function') {
        throw new CohubAuthError('bad_response', 'options.now must be a function');
      }
      now = nowDesc.value;
    }

    return { fetch: fetchImpl, now };
  }

  #validateFetchResponse(response, sentinels) {
    if (!response || typeof response !== 'object') {
      throw authError('bad_response', 'fetch response is not an object', sentinels);
    }

    // Capture exact descriptors without invoking getters
    const okDesc = Object.getOwnPropertyDescriptor(response, 'ok');
    const statusDesc = Object.getOwnPropertyDescriptor(response, 'status');
    const textDesc = Object.getOwnPropertyDescriptor(response, 'text');

    if (!okDesc || okDesc.get || okDesc.set) {
      throw authError('bad_response', 'response.ok must be a data property', sentinels);
    }
    if (!statusDesc || statusDesc.get || statusDesc.set) {
      throw authError('bad_response', 'response.status must be a data property', sentinels);
    }
    if (!textDesc || textDesc.get || textDesc.set) {
      throw authError('bad_response', 'response.text must be a data property', sentinels);
    }

    const ok = okDesc.value;
    const status = statusDesc.value;
    const textFn = textDesc.value;

    if (typeof ok !== 'boolean') {
      throw authError('bad_response', 'response.ok must be boolean', sentinels);
    }
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw authError('bad_response', 'response.status must be valid HTTP status', sentinels);
    }
    if (typeof textFn !== 'function') {
      throw authError('bad_response', 'response.text must be a function', sentinels);
    }

    // Call text() and await it
    let textPromise;
    try {
      textPromise = textFn.call(response);
    } catch (err) {
      throw authError('bad_response', 'response.text() threw', sentinels);
    }

    if (!textPromise || typeof textPromise.then !== 'function') {
      throw authError('bad_response', 'response.text() must return a Promise', sentinels);
    }

    // Return a promise that resolves to safe response data
    return textPromise.then((text) => {
      if (typeof text !== 'string') {
        throw authError('bad_response', 'response.text() must resolve to string', sentinels);
      }
      // Bound text size
      if (text.length > 1024 * 1024) {
        throw authError('bad_response', 'response body exceeds 1MB', sentinels);
      }
      return { ok, status, text };
    }, (err) => {
      throw authError('bad_response', 'response.text() rejected', sentinels);
    });
  }

  #writeRecordAtomically(record) {
    const dir = path.dirname(this.#authPath);
    const tmpPath = path.join(
      dir,
      `.${path.basename(this.#authPath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`
    );

    let tmpFd;
    let tmpWritten = false;
    let renamed = false;

    try {
      // Create temp file with mode 0600
      tmpFd = fs.openSync(tmpPath, 'wx', 0o600);
      const content = JSON.stringify(record, null, 2) + '\n';
      fs.writeFileSync(tmpFd, content);
      fs.fsyncSync(tmpFd);
      fs.closeSync(tmpFd);
      tmpFd = null;
      tmpWritten = true;

      // Validate exact bytes from temp file before rename
      const verifyFd = fs.openSync(tmpPath, 'r');
      try {
        const written = fs.readFileSync(verifyFd, 'utf8');
        if (written !== content) {
          throw new Error('temp file content mismatch');
        }
      } finally {
        fs.closeSync(verifyFd);
      }

      // Rename to commit
      fs.renameSync(tmpPath, this.#authPath);
      renamed = true;

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
        } catch (verifyErr) {
          // Could not verify disk state - ambiguous
        }
        throw new CohubAuthError('integrity_ambiguous', 'rename succeeded but directory fsync failed');
      } finally {
        fs.closeSync(dirFd);
      }
    } catch (err) {
      // Clean up temp file only if it exists and rename hasn't happened yet
      if (tmpFd !== null) {
        try {
          fs.closeSync(tmpFd);
        } catch {}
      }

      if (tmpWritten && !renamed) {
        // Preserve temp file for forensics on failure before rename
        // Only try to delete if it's provably safe (e.g., write failed before fsync)
        // Otherwise leave it for investigation
      }

      throw err;
    }
  }
}
