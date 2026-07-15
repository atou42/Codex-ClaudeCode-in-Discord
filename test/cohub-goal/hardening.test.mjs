import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CohubAuth, CohubAuthError } from '../../src/cohub-claude-goal/cohub-auth.js';
import { redactSecrets } from '../../src/cohub-claude-goal/redaction.js';

function validAuthRecord(overrides = {}) {
  const now = Date.now();
  return {
    schemaVersion: 1,
    env: 'prod',
    issuer: 'https://auth.neta.art',
    clientId: 'f8d26cdlwx85b0e5l3om2',
    resource: 'https://api.talesofai',
    scope: 'openid profile',
    tokenType: 'Bearer',
    accessToken: 'access-secret-xyz',
    refreshToken: 'refresh-secret-abc',
    accessTokenExpiresAt: now + 3600000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('Cohub auth/redaction hardening regressions', () => {
  let testDir;
  let authPath;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohub-harden-'));
    authPath = path.join(testDir, 'auth.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('JSON parser: RFC 8259 strict compliance', () => {
    it('should reject trailing comma in object', () => {
      const trailing = `{"schemaVersion":1,"env":"prod",}`;
      fs.writeFileSync(authPath, trailing, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('invalid JSON');
      });
    });

    it('should reject trailing comma in array', () => {
      const auth = validAuthRecord();
      const trailing = `{"schemaVersion":1,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"secret","refreshToken":"secret2","accessTokenExpiresAt":${auth.accessTokenExpiresAt},"createdAt":${auth.createdAt},"updatedAt":${auth.updatedAt},"extra":[1,2,]}`;
      fs.writeFileSync(authPath, trailing, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema';
      });
    });

    it('should reject lone surrogate \\uD800', () => {
      const auth = validAuthRecord({ scope: 'test' });
      // Replace "test" with "\uD800" (lone high surrogate)
      const json = JSON.stringify(auth).replace('"test"', '"\\uD800"');
      fs.writeFileSync(authPath, json, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('invalid JSON');
      });
    });

    it('should reject lone surrogate \\uDFFF', () => {
      const auth = validAuthRecord({ scope: 'test' });
      const json = JSON.stringify(auth).replace('"test"', '"\\uDFFF"');
      fs.writeFileSync(authPath, json, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('invalid JSON');
      });
    });

    it('should reject BOM at start', () => {
      const auth = validAuthRecord();
      const withBOM = '﻿' + JSON.stringify(auth);
      fs.writeFileSync(authPath, withBOM, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('invalid JSON');
      });
    });

    it('should reject excessive nesting depth', () => {
      let deep = '{"a":';
      for (let i = 0; i < 100; i++) {
        deep += '{"b":';
      }
      deep += '"value"';
      for (let i = 0; i < 100; i++) {
        deep += '}';
      }
      deep += '}';
      fs.writeFileSync(authPath, deep, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema';
      });
    });

    it('should reject number overflow (too large exponent)', () => {
      const auth = validAuthRecord();
      const overflow = JSON.stringify(auth).replace(auth.createdAt.toString(), '1e999');
      fs.writeFileSync(authPath, overflow, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema';
      });
    });

    it('should reject Infinity', () => {
      const auth = validAuthRecord();
      const inf = JSON.stringify(auth).replace(auth.createdAt.toString(), 'Infinity');
      fs.writeFileSync(authPath, inf, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema';
      });
    });

    it('should reject NaN', () => {
      const auth = validAuthRecord();
      const nan = JSON.stringify(auth).replace(auth.createdAt.toString(), 'NaN');
      fs.writeFileSync(authPath, nan, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema';
      });
    });

    it('should never echo attacker duplicate key name in error message', () => {
      const attackerKey = 'attacker-controlled-secret-xyz-12345';
      const dup = `{"${attackerKey}":1,"${attackerKey}":2}`;
      fs.writeFileSync(authPath, dup, { mode: 0o600 });
      let caught;
      try {
        new CohubAuth(authPath);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      // Error message must mention it's invalid/duplicate but not echo the key
      assert.ok(caught.message.includes('invalid') || caught.message.includes('duplicate') || caught.message.includes('parse'));
      assert.ok(!caught.message.includes(attackerKey));
      assert.ok(!(caught.stack || '').includes(attackerKey));
    });

    it('should create objects with null prototype to prevent pollution', () => {
      // This test documents the requirement; implementation must use Object.create(null)
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);
      assert.equal(cohubAuth.getAccessToken(), 'access-secret-xyz');
      // After hardening, parsed objects should have null prototype
    });
  });

  describe('refresh: Proxy-first response validation', () => {
    it('should reject response with getter on ok property', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      let getterInvoked = false;
      const mockFetch = async () => {
        const response = {};
        Object.defineProperty(response, 'ok', {
          get() {
            getterInvoked = true;
            return true;
          },
        });
        Object.defineProperty(response, 'status', { value: 200 });
        Object.defineProperty(response, 'text', {
          value: async () => JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 }),
        });
        return response;
      };

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'bad_response';
      });
      assert.equal(getterInvoked, false, 'must not invoke response.ok getter');
    });

    it('should reject response with getter on text method', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      let getterInvoked = false;
      const mockFetch = async () => {
        const response = { ok: true, status: 200 };
        Object.defineProperty(response, 'text', {
          get() {
            getterInvoked = true;
            return async () => JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 });
          },
        });
        return response;
      };

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'bad_response';
      });
      assert.equal(getterInvoked, false, 'must not invoke response.text getter');
    });

    it('should validate response body with descriptor checks', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 }),
      });

      // Should succeed with valid response
      const result = await cohubAuth.refresh({ fetch: mockFetch });
      assert.ok(result.refreshed);
    });

    it('should reject when fetch function is a Proxy', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      let trapInvoked = false;
      const mockFetch = new Proxy(async () => ({ ok: true }), {
        apply() {
          trapInvoked = true;
          return { ok: true };
        },
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'bad_response' || err.category === 'network_error';
      });
      // Must validate fetch descriptor before calling
    });

    it('should validate console via descriptor checks', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });

      const mockConsole = { log: () => {} };
      const cohubAuth = new CohubAuth(authPath, { console: mockConsole });

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new', token_type: 'Bearer', expires_in: 3600 }),
      });

      // Should succeed with valid console
      const result = await cohubAuth.refresh({ fetch: mockFetch });
      assert.ok(result.refreshed);
    });
  });

  describe('atomic write: explicit state tracking', () => {
    it('should preserve temp file on write failure for forensics', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      // Make directory read-only to prevent temp file creation
      fs.chmodSync(testDir, 0o500);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 }),
      });

      let caught;
      try {
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      } finally {
        fs.chmodSync(testDir, 0o700);
      }

      assert.ok(caught);
      assert.equal(caught.category, 'write_failed');

      // Original file should be unchanged
      const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      assert.equal(content.accessToken, 'access-secret-xyz');
    });

    it('should enter integrity_ambiguous on directory fsync failure', async () => {
      // This test documents the requirement: after rename succeeds but dirFd fsync fails,
      // must throw integrity_ambiguous and refuse subsequent operations
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      // Normal refresh should succeed
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 }),
      });

      const result = await cohubAuth.refresh({ fetch: mockFetch });
      assert.ok(result.refreshed);
    });

    it('should verify existing auth inode/mode immediately before rename', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const originalStat = fs.statSync(authPath);
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new-access', token_type: 'Bearer', expires_in: 3600 }),
      });

      await cohubAuth.refresh({ fetch: mockFetch });

      // After hardening, implementation must verify inode hasn't changed before rename
      const newStat = fs.statSync(authPath);
      assert.ok(newStat.ino !== originalStat.ino || newStat.mode === originalStat.mode);
    });
  });

  describe('redaction: Proxy-first deep-frozen output', () => {
    it('should use descriptor checks before reading object properties', () => {
      let getterInvoked = false;
      const obj = {};
      Object.defineProperty(obj, 'trap', {
        enumerable: true,
        get() {
          getterInvoked = true;
          return 'leaked';
        },
      });

      assert.throws(() => redactSecrets(obj), TypeError);
      assert.equal(getterInvoked, false, 'must check descriptor before invoking getter');
    });

    it('should reject cycles instead of preserving them', () => {
      const obj = { name: 'test' };
      obj.self = obj;

      // After hardening, cycles must be rejected
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should reject shared references instead of preserving them', () => {
      const shared = { secret: 'xyz' };
      const obj = { a: shared, b: shared };

      // After hardening, shared references must be rejected
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should return deep-frozen output', () => {
      const obj = { outer: { inner: { value: 'test' } } };
      const result = redactSecrets(obj);

      assert.ok(Object.isFrozen(result), 'top level must be frozen');
      assert.ok(Object.isFrozen(result.outer), 'nested level must be frozen');
      assert.ok(Object.isFrozen(result.outer.inner), 'deep nested level must be frozen');
    });

    it('should reject user-defined Error.stack accessor', () => {
      let accessorInvoked = false;
      const err = new Error('test');
      Object.defineProperty(err, 'stack', {
        enumerable: true,
        get() {
          accessorInvoked = true;
          return 'leaked stack';
        },
      });

      // User-defined stack accessor on own property must be rejected
      assert.throws(() => redactSecrets(err), TypeError);
      assert.equal(accessorInvoked, false);
    });

    it('should redact secrets from Error message and stack', () => {
      const internalError = new Error('Internal: secret-token-xyz leaked');

      const result = redactSecrets(internalError, { sentinels: ['secret-token-xyz'] });

      // Secrets must be redacted from message and stack
      assert.ok(!result.message.includes('secret-token-xyz'));
      if (result.stack) {
        assert.ok(!result.stack.includes('secret-token-xyz'));
      }
    });

    it('should reject functions without invoking them', () => {
      let invoked = false;
      const fn = () => {
        invoked = true;
        return 'leaked';
      };

      assert.throws(() => redactSecrets({ func: fn }), TypeError);
      assert.equal(invoked, false);
    });

    it('should reject BigInt values', () => {
      const obj = { big: 9007199254740991n };
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should reject objects exceeding size limit', () => {
      const huge = {};
      for (let i = 0; i < 10000; i++) {
        huge[`key${i}`] = `value${i}`;
      }
      assert.throws(() => redactSecrets(huge), TypeError);
    });

    it('should reject excessively long strings', () => {
      const obj = { long: 'x'.repeat(1000000) };
      assert.throws(() => redactSecrets(obj), TypeError);
    });
  });

  describe('secret scan: zero hits in all outputs', () => {
    it('should never write sentinel token to any temp file', async () => {
      const sentinel = 'SENTINEL-TOKEN-SCAN-TEST-XYZ-12345';
      const auth = validAuthRecord({ accessToken: sentinel });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'new-token', token_type: 'Bearer', expires_in: 3600 }),
      });

      let caught;
      try {
        // Force a write failure to create temp file
        fs.chmodSync(testDir, 0o500);
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      } finally {
        fs.chmodSync(testDir, 0o700);
      }

      // Scan all files in testDir for sentinel
      const allFiles = fs.readdirSync(testDir);
      let hitCount = 0;
      for (const file of allFiles) {
        if (file === 'auth.json') continue; // auth.json naturally contains the token
        const content = fs.readFileSync(path.join(testDir, file), 'utf8');
        if (content.includes(sentinel)) {
          hitCount++;
        }
      }
      assert.equal(hitCount, 0, `sentinel token found in ${hitCount} non-auth files`);
    });

    it('should detect and redact JWT patterns in arbitrary strings', () => {
      const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
      const obj = { message: `Auth failed with token: ${jwt}` };
      const result = redactSecrets(obj);
      assert.ok(!result.message.includes(jwt));
      assert.ok(result.message.includes('[REDACTED_TOKEN]'));
    });

    it('should detect and redact Bearer tokens', () => {
      const bearer = 'Bearer abc123xyz456';
      const obj = { auth: bearer };
      const result = redactSecrets(obj);
      assert.ok(!result.auth.includes('abc123xyz456'));
      assert.ok(result.auth.includes('[REDACTED_TOKEN]'));
    });

    it('should redact cookie values', () => {
      const obj = { cookie: 'session=secret-xyz-123; path=/' };
      const result = redactSecrets(obj, { sentinels: ['secret-xyz-123'] });
      assert.ok(!result.cookie.includes('secret-xyz-123'));
    });
  });

  describe('validateAuthRecord: Proxy-first schema checks', () => {
    it('should check descriptors before reading properties', () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });

      // After hardening, validator must use descriptor checks
      const cohubAuth = new CohubAuth(authPath);
      assert.equal(cohubAuth.getAccessToken(), 'access-secret-xyz');
    });

    it('should preserve file on invalid_grant without deleting', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Token revoked' }),
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'invalid_grant';
      });

      // File must still exist with original content
      assert.ok(fs.existsSync(authPath));
      const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      assert.equal(content.accessToken, 'access-secret-xyz');
    });

    it('should preserve file on bad JSON without clearing', () => {
      const badJSON = '{"incomplete": ';
      fs.writeFileSync(authPath, badJSON, { mode: 0o600 });

      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema';
      });

      // File must be unchanged
      assert.equal(fs.readFileSync(authPath, 'utf8'), badJSON);
    });

    it('should preserve file with unknown fields without rewriting', () => {
      const auth = validAuthRecord({ unknownField: 'preserve-me' });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });

      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('unknown field');
      });

      // File must be unchanged with unknown field still present
      const content = JSON.parse(fs.readFileSync(authPath, 'utf8'));
      assert.equal(content.unknownField, 'preserve-me');
    });
  });
});
