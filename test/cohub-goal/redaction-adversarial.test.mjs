import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../../src/cohub-claude-goal/redaction.js';

describe('redaction adversarial acceptance', () => {
  describe('malformed sentinels must throw, not filter', () => {
    it('should throw when sentinels is not an array', () => {
      assert.throws(() => redactSecrets('test', { sentinels: 'string' }), TypeError);
    });

    it('should throw when sentinels is null', () => {
      assert.throws(() => redactSecrets('test', { sentinels: null }), TypeError);
    });

    it('should throw when sentinels is explicitly undefined', () => {
      assert.throws(() => redactSecrets('test', { sentinels: undefined }), TypeError);
    });

    it('should throw when sentinels is a number', () => {
      assert.throws(() => redactSecrets('test', { sentinels: 42 }), TypeError);
    });

    it('should throw when sentinels is an object', () => {
      assert.throws(() => redactSecrets('test', { sentinels: {} }), TypeError);
    });
  });

  describe('no function/symbol/accessor/constructor getter execution', () => {
    it('should throw on symbol value without invoking Symbol.prototype.toString', () => {
      let toStringCalled = false;
      const sym = Symbol('test');
      const originalToString = Symbol.prototype.toString;
      Symbol.prototype.toString = function() {
        toStringCalled = true;
        return 'leaked';
      };
      try {
        assert.throws(() => redactSecrets(sym), TypeError);
        assert.equal(toStringCalled, false);
      } finally {
        Symbol.prototype.toString = originalToString;
      }
    });

    it('should throw on accessor property in nested object', () => {
      let invoked = false;
      const nested = {};
      Object.defineProperty(nested, 'trap', {
        enumerable: true,
        get() {
          invoked = true;
          return 'leaked';
        },
      });
      const obj = { nested };
      assert.throws(() => redactSecrets(obj), TypeError);
      assert.equal(invoked, false);
    });

    it('should throw on setter-only property without invoking setter', () => {
      let setterInvoked = false;
      const obj = {};
      Object.defineProperty(obj, 'writeOnly', {
        enumerable: true,
        set(val) {
          setterInvoked = true;
        },
      });
      assert.throws(() => redactSecrets(obj), TypeError);
      assert.equal(setterInvoked, false);
    });

    it('should throw on function value without invoking it', () => {
      let invoked = false;
      const fn = () => {
        invoked = true;
        return 'leaked';
      };
      assert.throws(() => redactSecrets(fn), TypeError);
      assert.equal(invoked, false);
    });

    it('should throw on custom Error prototype without reading constructor.name accessor', () => {
      let constructorNameInvoked = false;
      const proto = {};
      const ctor = {};
      Object.defineProperty(ctor, 'name', {
        get() {
          constructorNameInvoked = true;
          return 'FakeConstructor';
        },
      });
      proto.constructor = ctor;
      const obj = Object.create(proto);
      obj.data = 'test';
      assert.throws(() => redactSecrets(obj), TypeError);
      assert.equal(constructorNameInvoked, false);
    });
  });

  describe('native Error own data allowed, custom prototype or own accessors rejected', () => {
    it('should allow native Error with own data property name', () => {
      const err = new Error('test');
      Object.defineProperty(err, 'name', {
        enumerable: true,
        writable: true,
        configurable: true,
        value: 'CustomName',
      });
      const result = redactSecrets(err);
      assert.equal(result.name, 'CustomName');
    });

    it('should allow native Error with own data property message', () => {
      const err = new Error('original');
      Object.defineProperty(err, 'message', {
        enumerable: true,
        writable: true,
        configurable: true,
        value: 'overridden secret-token-xyz',
      });
      const result = redactSecrets(err, { sentinels: ['secret-token-xyz'] });
      assert.ok(!result.message.includes('secret-token-xyz'));
    });

    it('should allow native Error with own data property stack', () => {
      const err = new Error('test');
      err.stack = 'overridden stack with secret-abc';
      const result = redactSecrets(err, { sentinels: ['secret-abc'] });
      assert.ok(!result.stack.includes('secret-abc'));
    });

    it('should throw when Error has custom prototype (not Error.prototype descendants)', () => {
      const customProto = { custom: true };
      const err = Object.create(customProto);
      err.name = 'CustomError';
      err.message = 'test';
      assert.throws(() => redactSecrets(err), TypeError);
    });

    it('should throw when Error.cause is an accessor own property', () => {
      let causeInvoked = false;
      const err = new Error('wrapper');
      Object.defineProperty(err, 'cause', {
        enumerable: true,
        get() {
          causeInvoked = true;
          return new Error('leaked');
        },
      });
      assert.throws(() => redactSecrets(err), TypeError);
      assert.equal(causeInvoked, false);
    });
  });

  describe('cycles rejected for security', () => {
    it('should reject cycles in plain objects', () => {
      const obj = { name: 'test' };
      obj.self = obj;
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should reject cycles in arrays', () => {
      const arr = [1, 2];
      arr.push(arr);
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should reject cycles in Error graph', () => {
      const err1 = new Error('err1');
      const err2 = new Error('err2');
      err1.cause = err2;
      err2.cause = err1;
      assert.throws(() => redactSecrets(err1), TypeError);
    });

    it('should throw when cycle involves unsupported type (Map)', () => {
      const map = new Map();
      const obj = { map };
      map.set('obj', obj);
      assert.throws(() => redactSecrets(obj), TypeError);
    });
  });

  describe('dangerous keys must throw', () => {
    it('should throw on __proto__ at any nesting level', () => {
      const obj = { safe: { __proto__: { polluted: true } } };
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should throw on constructor at any nesting level', () => {
      const obj = { safe: { constructor: 'bad' } };
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should throw on prototype at any nesting level', () => {
      const obj = { safe: { prototype: 'bad' } };
      assert.throws(() => redactSecrets(obj), TypeError);
    });

    it('should throw when dangerous key appears in Error extra properties', () => {
      const err = new Error('test');
      Object.defineProperty(err, '__proto__', {
        enumerable: true,
        writable: true,
        configurable: true,
        value: { dangerous: true },
      });
      assert.throws(() => redactSecrets(err), TypeError);
    });
  });

  describe('post-redaction key collision must throw', () => {
    it('should throw when two keys produce same output after sentinel redaction', () => {
      const obj = {
        'prefixABCsuffix': 'first',
        'prefixDEFsuffix': 'second',
      };
      assert.throws(() => redactSecrets(obj, { sentinels: ['ABC', 'DEF'] }), TypeError);
    });

    it('should throw when key collision happens in nested object', () => {
      const obj = {
        nested: {
          'keyXXX': 'first',
          'keyYYY': 'second',
        },
      };
      assert.throws(() => redactSecrets(obj, { sentinels: ['XXX', 'YYY'] }), TypeError);
    });

    it('should throw when sentinel redaction creates collision with existing plain key', () => {
      const obj = {
        'test[REDACTED]': 'existing',
        'testSENTINEL': 'will-collide',
      };
      assert.throws(() => redactSecrets(obj, { sentinels: ['SENTINEL'] }), TypeError);
    });
  });

  describe('sparse/extra arrays must throw', () => {
    it('should throw on sparse array with hole at start', () => {
      const arr = [, 2, 3];
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on sparse array with hole in middle', () => {
      const arr = [1, , 3];
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on sparse array with hole at end', () => {
      const arr = [1, 2];
      arr.length = 3;
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on array with string property name', () => {
      const arr = [1, 2, 3];
      arr.extraProp = 'data';
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on array with numeric string property outside bounds', () => {
      const arr = [1, 2];
      arr['5'] = 'sparse-like';
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on array with negative numeric property', () => {
      const arr = [1, 2];
      arr['-1'] = 'negative';
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on array with symbol property', () => {
      const sym = Symbol('extra');
      const arr = [1, 2];
      arr[sym] = 'hidden';
      assert.throws(() => redactSecrets(arr), TypeError);
    });

    it('should throw on array with accessor element', () => {
      let invoked = false;
      const arr = [1, 2, 3];
      Object.defineProperty(arr, 1, {
        enumerable: true,
        get() {
          invoked = true;
          return 99;
        },
      });
      assert.throws(() => redactSecrets(arr), TypeError);
      assert.equal(invoked, false);
    });
  });

  describe('secrets absent from all error/stack/log', () => {
    it('should not include sentinel in TypeError message when throwing on accessor', () => {
      const sentinel = 'ultra-secret-token-xyz';
      const obj = {};
      Object.defineProperty(obj, sentinel, {
        enumerable: true,
        get() {
          return 'leaked';
        },
      });
      try {
        redactSecrets(obj, { sentinels: [sentinel] });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(!err.message.includes(sentinel));
      }
    });

    it('should not include secret token in TypeError stack trace', () => {
      const secret = 'bearer-token-abc123';
      const obj = {};
      Object.defineProperty(obj, secret, {
        enumerable: true,
        get() {
          return 'leaked';
        },
      });
      try {
        redactSecrets(obj, { sentinels: [secret] });
        assert.fail('should have thrown');
      } catch (err) {
        assert.ok(!err.stack.includes(secret));
      }
    });

    it('should not log sentinel values when redacting', () => {
      const logged = [];
      const originalLog = console.log;
      console.log = (...args) => logged.push(args.join(' '));
      try {
        const sentinel = 'log-leak-test-xyz';
        redactSecrets({ key: sentinel }, { sentinels: [sentinel] });
        const allLogs = logged.join(' ');
        assert.ok(!allLogs.includes(sentinel));
      } finally {
        console.log = originalLog;
      }
    });
  });

  describe('integration: end-to-end secret protection', () => {
    it('should protect secret through full error flow: network error -> redacted error', () => {
      const secret = 'integration-test-secret-token';
      const error = new Error(`Network failed: ${secret}`);
      const redacted = redactSecrets(error, { sentinels: [secret] });
      assert.ok(!redacted.message.includes(secret));
      assert.ok(!redacted.stack.includes(secret));
      assert.ok(!JSON.stringify(redacted).includes(secret));
    });

    it('should protect secret through full error flow: bad response with secret in body', () => {
      const secret = 'response-body-secret-xyz';
      const responseBody = { error: `failed: ${secret}` };
      const redacted = redactSecrets(responseBody, { sentinels: [secret] });
      assert.ok(!redacted.error.includes(secret));
    });

    it('should protect multiple secrets from different sources simultaneously', () => {
      const accessToken = 'access-123-abc';
      const refreshToken = 'refresh-456-def';
      const idToken = 'id-789-ghi';
      const error = new Error(`Auth failed: ${accessToken}, ${refreshToken}, ${idToken}`);
      error.tokens = { accessToken, refreshToken, idToken };
      const redacted = redactSecrets(error, { sentinels: [accessToken, refreshToken, idToken] });
      assert.ok(!redacted.message.includes(accessToken));
      assert.ok(!redacted.message.includes(refreshToken));
      assert.ok(!redacted.message.includes(idToken));
      assert.equal(redacted.tokens.accessToken, '[REDACTED]');
      assert.equal(redacted.tokens.refreshToken, '[REDACTED]');
      assert.equal(redacted.tokens.idToken, '[REDACTED]');
    });
  });
});
