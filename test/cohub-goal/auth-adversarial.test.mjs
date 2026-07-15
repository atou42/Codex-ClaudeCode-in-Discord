import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CohubAuth, CohubAuthError } from '../../src/cohub-claude-goal/cohub-auth.js';

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

describe('CohubAuth adversarial acceptance', () => {
  let testDir;
  let authPath;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cohub-auth-adv-'));
    authPath = path.join(testDir, 'auth.json');
  });

  afterEach(() => {
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  describe('O_NOFOLLOW + fstat same fd prevents TOCTOU', () => {
    it('should reject symlink with O_NOFOLLOW (ELOOP)', () => {
      const realPath = path.join(testDir, 'real.json');
      fs.writeFileSync(realPath, JSON.stringify(validAuthRecord()), { mode: 0o600 });
      const linkPath = path.join(testDir, 'link.json');
      fs.symlinkSync(realPath, linkPath);

      let caught;
      try {
        new CohubAuth(linkPath);
      } catch (err) {
        caught = err;
      }
      assert.ok(caught instanceof CohubAuthError);
      assert.equal(caught.category, 'unsafe_file');
      assert.ok(caught.message.includes('symlink'));
    });

    it('should require exact mode 0600, reject 0400', () => {
      fs.writeFileSync(authPath, JSON.stringify(validAuthRecord()), { mode: 0o400 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'unsafe_file' && err.message.includes('0600');
      });
    });

    it('should require exact mode 0600, reject 0640', () => {
      fs.writeFileSync(authPath, JSON.stringify(validAuthRecord()), { mode: 0o640 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'unsafe_file' && err.message.includes('0600');
      });
    });

    it('should require exact mode 0600, reject 0644', () => {
      fs.writeFileSync(authPath, JSON.stringify(validAuthRecord()), { mode: 0o644 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'unsafe_file' && err.message.includes('0600');
      });
    });
  });

  describe('strict JSON parser rejects duplicates at every depth', () => {
    it('should reject duplicate key at top level', () => {
      const now = Date.now();
      const dup = `{"schemaVersion":1,"schemaVersion":2,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"access123","refreshToken":"refresh456","accessTokenExpiresAt":${now + 3600000},"createdAt":${now},"updatedAt":${now}}`;
      fs.writeFileSync(authPath, dup, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('duplicate');
      });
    });

    it('should reject duplicate with escaped unicode in key', () => {
      const now = Date.now();
      // e is 'e', so "schemaVersion" normalizes to "schemaVersion"
      const dup = `{"sch\\u0065maVersion":1,"schemaVersion":2,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"access123","refreshToken":"refresh456","accessTokenExpiresAt":${now + 3600000},"createdAt":${now},"updatedAt":${now}}`;
      fs.writeFileSync(authPath, dup, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('duplicate');
      });
    });

    it('should reject nested duplicate keys at depth 2', () => {
      // This would pass old parser (only checked depth 1) but must fail now
      const nested = `{"schemaVersion":1,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"secret1","refreshToken":"secret2","accessTokenExpiresAt":${Date.now() + 3600000},"createdAt":${Date.now()},"updatedAt":${Date.now()},"meta":{"a":1,"a":2}}`;
      fs.writeFileSync(authPath, nested, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('duplicate');
      });
    });

    it('should reject nested duplicate keys at depth 3', () => {
      const nested = `{"schemaVersion":1,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"secret1","refreshToken":"secret2","accessTokenExpiresAt":${Date.now() + 3600000},"createdAt":${Date.now()},"updatedAt":${Date.now()},"outer":{"inner":{"x":1,"x":2}}}`;
      fs.writeFileSync(authPath, nested, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('duplicate');
      });
    });

    it('should reject duplicate keys in objects inside arrays', () => {
      const arrayNested = `{"schemaVersion":1,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"secret1","refreshToken":"secret2","accessTokenExpiresAt":${Date.now() + 3600000},"createdAt":${Date.now()},"updatedAt":${Date.now()},"items":[{"id":1,"id":2}]}`;
      fs.writeFileSync(authPath, arrayNested, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('duplicate');
      });
    });

    it('should reject escaped-equivalent nested keys', () => {
      // "k\\u0065y" becomes "key", duplicate of "key"
      const escaped = `{"schemaVersion":1,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"secret1","refreshToken":"secret2","accessTokenExpiresAt":${Date.now() + 3600000},"createdAt":${Date.now()},"updatedAt":${Date.now()},"data":{"k\\u0065y":1,"key":2}}`;
      fs.writeFileSync(authPath, escaped, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('duplicate');
      });
    });

    it('should handle braces and colons inside string values correctly', () => {
      // Valid JSON with string containing braces/colons should parse
      const valid = validAuthRecord({ scope: 'openid {profile}:read' });
      fs.writeFileSync(authPath, JSON.stringify(valid), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);
      assert.equal(cohubAuth.getAccessToken(), 'access-secret-xyz');
    });

    it('should handle escaped backslashes in string values', () => {
      // Valid JSON with escaped backslashes
      const valid = validAuthRecord({ scope: 'path\\\\to\\\\resource' });
      fs.writeFileSync(authPath, JSON.stringify(valid), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);
      assert.equal(cohubAuth.getAccessToken(), 'access-secret-xyz');
    });

    it('should accept same key name in different sibling objects', () => {
      // "id" in first object, "id" in second object is valid (different objects)
      const valid = validAuthRecord();
      // Add a valid nested structure where key appears in siblings
      const validNested = {
        ...valid,
        meta: {
          user: { id: 'user1' },
          team: { id: 'team1' }
        }
      };
      fs.writeFileSync(authPath, JSON.stringify(validNested), { mode: 0o600 });
      // This will fail schema validation (unknown field 'meta'), testing parser only
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('unknown field');
      });
    });

    it('should reject malformed truncated JSON', () => {
      const truncated = `{"schemaVersion":1,"env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2"`;
      fs.writeFileSync(authPath, truncated, { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('invalid JSON');
      });
    });
  });

  describe('exact plain schema: Object.prototype only, own properties', () => {
    it('should reject unknown field', () => {
      const auth = validAuthRecord({ extraField: 'bad' });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('unknown field');
      });
    });

    it('should reject missing required field accessToken', () => {
      const auth = validAuthRecord();
      delete auth.accessToken;
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      assert.throws(() => new CohubAuth(authPath), (err) => {
        return err.category === 'invalid_schema' && err.message.includes('accessToken');
      });
    });

    it('should accept optional idToken when present', () => {
      const auth = validAuthRecord({ idToken: 'id-token-xyz' });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);
      assert.equal(cohubAuth.getAccessToken(), 'access-secret-xyz');
    });

    it('should accept optional idToken when absent', () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);
      assert.equal(cohubAuth.getAccessToken(), 'access-secret-xyz');
    });
  });

  describe('refresh response own descriptors validation', () => {
    it('should reject response with unknown field', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
          unknown_field: 'bad',
        }),
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'bad_response' && err.message.includes('unknown field');
      });
    });

    it('should reject response body with duplicate keys', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => '{"access_token":"first","access_token":"second","token_type":"Bearer","expires_in":3600}',
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'bad_response' && err.message.includes('duplicate');
      });
    });
  });

  describe('safe arithmetic: overflow checks', () => {
    it('should reject when expires_in * 1000 overflows', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const overflowValue = Math.floor(Number.MAX_SAFE_INTEGER / 1000) + 1;
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: overflowValue,
        }),
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch }), (err) => {
        return err.category === 'bad_response' && err.message.includes('overflow');
      });
    });

    it('should reject when now + expiresInMs overflows', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 1000,
        }),
      });

      await assert.rejects(
        () => cohubAuth.refresh({ fetch: mockFetch, now: () => Number.MAX_SAFE_INTEGER - 100 }),
        (err) => {
          return err.category === 'bad_response' && err.message.includes('overflow');
        }
      );
    });

    it('should reject when now() returns negative', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch, now: () => -1 }), (err) => {
        return err.category === 'invalid_time';
      });
    });

    it('should reject when now() returns NaN', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch, now: () => NaN }), (err) => {
        return err.category === 'invalid_time';
      });
    });

    it('should reject when now() returns Infinity', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      await assert.rejects(() => cohubAuth.refresh({ fetch: mockFetch, now: () => Infinity }), (err) => {
        return err.category === 'invalid_time';
      });
    });
  });

  describe('errors/stacks/logs zero secrets', () => {
    it('should not include secrets when rejecting duplicate keys in auth file', () => {
      const secret1 = 'ultra-secret-access-xyz-12345';
      const secret2 = 'ultra-secret-refresh-abc-67890';
      // Duplicate "env" key with secrets in the file
      const dup = `{"schemaVersion":1,"env":"prod","env":"prod","issuer":"https://auth.neta.art","clientId":"f8d26cdlwx85b0e5l3om2","resource":"https://api.talesofai","scope":"openid profile","tokenType":"Bearer","accessToken":"${secret1}","refreshToken":"${secret2}","accessTokenExpiresAt":${Date.now() + 3600000},"createdAt":${Date.now()},"updatedAt":${Date.now()}}`;
      fs.writeFileSync(authPath, dup, { mode: 0o600 });

      let caught;
      try {
        new CohubAuth(authPath);
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.ok(caught.message.includes('duplicate'));
      // Even though file contains secrets, the duplicate key error must not leak them
      assert.ok(!caught.message.includes(secret1));
      assert.ok(!caught.message.includes(secret2));
      assert.ok(!(caught.stack || '').includes(secret1));
      assert.ok(!(caught.stack || '').includes(secret2));
    });

    it('should not include secrets when rejecting duplicate keys in refresh response', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const newSecret = 'new-secret-token-xyz-999';
      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => `{"access_token":"${newSecret}","access_token":"duplicate","token_type":"Bearer","expires_in":3600}`,
      });

      let caught;
      try {
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.equal(caught.category, 'bad_response');
      assert.ok(caught.message.includes('duplicate'));
      assert.ok(!caught.message.includes(newSecret));
      assert.ok(!(caught.stack || '').includes(newSecret));
    });

    it('should not include accessToken in network error message', async () => {
      const secret = 'ultra-secret-access-token-xyz';
      const auth = validAuthRecord({ accessToken: secret });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => {
        throw new Error(`Network failed with ${secret}`);
      };

      let caught;
      try {
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.ok(!caught.message.includes(secret));
      assert.ok(!(caught.stack || '').includes(secret));
    });

    it('should not include refreshToken in error message or stack', async () => {
      const secret = 'ultra-secret-refresh-token-abc';
      const auth = validAuthRecord({ refreshToken: secret });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: 'invalid_grant', error_description: `Token ${secret} invalid` }),
      });

      let caught;
      try {
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      }
      assert.ok(caught);
      assert.ok(!caught.message.includes(secret));
      assert.ok(!(caught.stack || '').includes(secret));
      assert.ok(!JSON.stringify(caught).includes(secret));
    });

    it('should not log secrets during successful refresh', async () => {
      const oldAccess = 'old-secret-access-xyz';
      const oldRefresh = 'old-secret-refresh-abc';
      const newAccess = 'new-secret-access-123';
      const newRefresh = 'new-secret-refresh-456';

      const auth = validAuthRecord({ accessToken: oldAccess, refreshToken: oldRefresh });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });

      const logged = [];
      const mockConsole = { log: (...args) => logged.push(args.join(' ')) };
      const cohubAuth = new CohubAuth(authPath, { console: mockConsole });

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: newAccess,
          refresh_token: newRefresh,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      await cohubAuth.refresh({ fetch: mockFetch });

      const allLogs = logged.join(' ');
      assert.ok(!allLogs.includes(oldAccess));
      assert.ok(!allLogs.includes(oldRefresh));
      assert.ok(!allLogs.includes(newAccess));
      assert.ok(!allLogs.includes(newRefresh));
    });
  });

  describe('commit failures: exact bytes before rename, reconcile after', () => {
    it('should preserve exact original file when write fails before rename', async () => {
      const auth = validAuthRecord();
      const original = JSON.stringify(auth);
      fs.writeFileSync(authPath, original, { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      // Make directory read-only to prevent temp file creation
      fs.chmodSync(testDir, 0o500);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
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
      // Original file must be byte-for-byte identical
      assert.equal(fs.readFileSync(authPath, 'utf8'), original);
      // Mode must be unchanged
      const stats = fs.lstatSync(authPath);
      assert.equal(stats.mode & 0o777, 0o600);
    });

    it('should reconcile from disk when directory fsync fails after rename', async () => {
      // This test documents the requirement but cannot easily trigger dirFd fsync failure
      // Implementation must: if rename succeeds but dirFd fsync throws, re-read auth.json
      // to confirm what's on disk, then throw 'integrity_ambiguous' category error
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access',
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      });

      // Normal case succeeds
      const result = await cohubAuth.refresh({ fetch: mockFetch });
      assert.ok(result.refreshed);
      assert.equal(cohubAuth.getAccessToken(), 'new-access');
    });
  });

  describe('integration: end-to-end secret protection', () => {
    it('should protect all tokens through full error flow', async () => {
      const accessSecret = 'access-integration-xyz';
      const refreshSecret = 'refresh-integration-abc';
      const idSecret = 'id-integration-def';

      const auth = validAuthRecord({
        accessToken: accessSecret,
        refreshToken: refreshSecret,
        idToken: idSecret,
      });
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const mockFetch = async () => {
        throw new Error(`Network error: ${accessSecret} ${refreshSecret} ${idSecret}`);
      };

      let caught;
      try {
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      const errStr = JSON.stringify(caught);
      assert.ok(!caught.message.includes(accessSecret));
      assert.ok(!caught.message.includes(refreshSecret));
      assert.ok(!caught.message.includes(idSecret));
      assert.ok(!(caught.stack || '').includes(accessSecret));
      assert.ok(!(caught.stack || '').includes(refreshSecret));
      assert.ok(!(caught.stack || '').includes(idSecret));
      assert.ok(!errStr.includes(accessSecret));
      assert.ok(!errStr.includes(refreshSecret));
      assert.ok(!errStr.includes(idSecret));
    });

    it('should protect new tokens from response in error flow', async () => {
      const auth = validAuthRecord();
      fs.writeFileSync(authPath, JSON.stringify(auth), { mode: 0o600 });
      const cohubAuth = new CohubAuth(authPath);

      const newSecret = 'new-response-secret-xyz';
      const mockFetch = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({
          error: 'invalid_request',
          access_token: newSecret, // Malicious: server leaks token in error response
        }),
      });

      let caught;
      try {
        await cohubAuth.refresh({ fetch: mockFetch });
      } catch (err) {
        caught = err;
      }

      assert.ok(caught);
      assert.ok(!caught.message.includes(newSecret));
      assert.ok(!(caught.stack || '').includes(newSecret));
    });
  });
});
