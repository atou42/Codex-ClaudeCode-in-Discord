import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { canonicalStringify, canonicalHash } from '../../src/cohub-claude-goal/canonical.js';

function sha256hex(utf8string) {
  return crypto.createHash('sha256').update(utf8string, 'utf8').digest('hex');
}

test('canonicalStringify sorts object keys recursively', () => {
  const a = canonicalStringify({ b: 1, a: 2, c: { z: 1, y: 2 } });
  const b = canonicalStringify({ a: 2, c: { y: 2, z: 1 }, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1,"c":{"y":2,"z":1}}');
});

test('canonicalStringify preserves array order (stable arrays)', () => {
  const s = canonicalStringify({ arr: [3, 1, 2] });
  assert.equal(s, '{"arr":[3,1,2]}');
});

test('canonicalStringify is not affected by object key insertion order', () => {
  const obj1 = {};
  obj1.x = 1;
  obj1.y = 2;
  const obj2 = {};
  obj2.y = 2;
  obj2.x = 1;
  assert.equal(canonicalStringify(obj1), canonicalStringify(obj2));
});

test('canonicalStringify handles nested arrays of objects with sorted keys', () => {
  const s = canonicalStringify({ list: [{ b: 1, a: 2 }, { d: 3, c: 4 }] });
  assert.equal(s, '{"list":[{"a":2,"b":1},{"c":4,"d":3}]}');
});

test('canonicalStringify handles primitives at top level', () => {
  assert.equal(canonicalStringify('hello'), '"hello"');
  assert.equal(canonicalStringify(42), '42');
  assert.equal(canonicalStringify(true), 'true');
  assert.equal(canonicalStringify(false), 'false');
  assert.equal(canonicalStringify(null), 'null');
});

test('canonicalStringify rejects cyclic objects', () => {
  const obj = { a: 1 };
  obj.self = obj;
  assert.throws(() => canonicalStringify(obj), /cycle|circular/i);
});

test('canonicalStringify rejects cyclic arrays', () => {
  const arr = [1, 2];
  arr.push(arr);
  assert.throws(() => canonicalStringify(arr), /cycle|circular/i);
});

test('canonicalStringify rejects undefined at top level', () => {
  assert.throws(() => canonicalStringify(undefined), /undefined/i);
});

test('canonicalStringify rejects undefined nested in object value', () => {
  assert.throws(() => canonicalStringify({ a: undefined }), /undefined/i);
});

test('canonicalStringify rejects undefined nested in array element', () => {
  assert.throws(() => canonicalStringify([1, undefined, 3]), /undefined/i);
});

test('canonicalStringify rejects bigint', () => {
  assert.throws(() => canonicalStringify({ a: 10n }), /bigint/i);
  assert.throws(() => canonicalStringify(10n), /bigint/i);
});

test('canonicalStringify rejects functions', () => {
  assert.throws(() => canonicalStringify({ a: () => {} }), /function/i);
  assert.throws(() => canonicalStringify(function foo() {}), /function/i);
});

test('canonicalStringify rejects symbols as values', () => {
  assert.throws(() => canonicalStringify({ a: Symbol('x') }), /symbol/i);
  assert.throws(() => canonicalStringify(Symbol('top')), /symbol/i);
});

test('canonicalStringify rejects symbol keys', () => {
  const obj = { a: 1 };
  obj[Symbol('k')] = 2;
  assert.throws(() => canonicalStringify(obj), /symbol/i);
});

test('canonicalStringify rejects NaN', () => {
  assert.throws(() => canonicalStringify({ a: NaN }), /finite|nan/i);
});

test('canonicalStringify rejects Infinity and -Infinity', () => {
  assert.throws(() => canonicalStringify({ a: Infinity }), /finite/i);
  assert.throws(() => canonicalStringify({ a: -Infinity }), /finite/i);
});

test('canonicalStringify rejects sparse arrays (holes)', () => {
  const arr = [1, , 3]; // eslint-disable-line no-sparse-arrays
  assert.throws(() => canonicalStringify(arr), /sparse|hole/i);
});

test('canonicalStringify rejects Date objects', () => {
  assert.throws(() => canonicalStringify({ a: new Date() }), /plain object|non-plain/i);
});

test('canonicalStringify rejects Map objects', () => {
  assert.throws(() => canonicalStringify({ a: new Map() }), /plain object|non-plain/i);
});

test('canonicalStringify rejects Set objects', () => {
  assert.throws(() => canonicalStringify({ a: new Set() }), /plain object|non-plain/i);
});

test('canonicalStringify rejects RegExp objects', () => {
  assert.throws(() => canonicalStringify({ a: /x/ }), /plain object|non-plain/i);
});

test('canonicalStringify rejects class instances (non-plain objects)', () => {
  class Foo {
    constructor() {
      this.x = 1;
    }
  }
  assert.throws(() => canonicalStringify(new Foo()), /plain object|non-plain/i);
});

test('canonicalStringify accepts objects with null prototype', () => {
  const obj = Object.create(null);
  obj.a = 1;
  assert.equal(canonicalStringify(obj), '{"a":1}');
});

test('canonicalStringify rejects __proto__ as an own enumerable key', () => {
  const obj = JSON.parse('{"__proto__":{"polluted":true},"a":1}');
  assert.throws(() => canonicalStringify(obj), /proto|pollut/i);
});

test('canonicalStringify rejects constructor as an own enumerable key', () => {
  const obj = Object.defineProperty({}, 'constructor', {
    value: 1,
    enumerable: true,
  });
  assert.throws(() => canonicalStringify(obj), /proto|pollut|constructor/i);
});

test('canonicalStringify rejects prototype as an own enumerable key', () => {
  const obj = { prototype: 1, a: 2 };
  assert.throws(() => canonicalStringify(obj), /proto|pollut/i);
});

test('canonicalStringify does not coerce numbers lossily', () => {
  assert.equal(canonicalStringify({ a: 0 }), '{"a":0}');
  assert.equal(canonicalStringify({ a: -0 }), '{"a":0}');
  assert.equal(canonicalStringify({ a: 1.5 }), '{"a":1.5}');
  assert.equal(canonicalStringify({ a: -1 }), '{"a":-1}');
});

test('canonicalStringify handles unicode strings without normalization mangling', () => {
  const s = canonicalStringify({ a: 'héllo 世界 🎉' });
  assert.equal(s, JSON.stringify({ a: 'héllo 世界 🎉' }));
});

test('canonicalHash returns sha256 hex of canonical UTF-8 JSON', () => {
  const value = { b: 1, a: 2 };
  const expectedString = canonicalStringify(value);
  const expectedHash = sha256hex(expectedString);
  assert.equal(canonicalHash(value), expectedHash);
  assert.match(canonicalHash(value), /^[0-9a-f]{64}$/);
});

test('canonicalHash is order-independent for object keys', () => {
  const h1 = canonicalHash({ a: 1, b: 2 });
  const h2 = canonicalHash({ b: 2, a: 1 });
  assert.equal(h1, h2);
});

test('canonicalHash differs for different array order', () => {
  const h1 = canonicalHash({ arr: [1, 2] });
  const h2 = canonicalHash({ arr: [2, 1] });
  assert.notEqual(h1, h2);
});

test('canonicalHash is not affected by irrelevant whitespace-equivalent structures', () => {
  const h1 = canonicalHash({ a: 1 });
  const h2 = canonicalHash({ a: 1 });
  assert.equal(h1, h2);
});

test('canonicalStringify rejects null prototype object with pollution key', () => {
  const obj = Object.create(null);
  obj.__proto__ = { polluted: true };
  Object.defineProperty(obj, '__proto__', { value: 1, enumerable: true });
  assert.throws(() => canonicalStringify(obj), /proto|pollut/i);
});

test('canonicalStringify deep nested cycle detection does not false-positive on repeated equal values', () => {
  const shared = { x: 1 };
  const obj = { a: shared, b: shared };
  assert.doesNotThrow(() => canonicalStringify(obj));
  assert.equal(canonicalStringify(obj), '{"a":{"x":1},"b":{"x":1}}');
});
