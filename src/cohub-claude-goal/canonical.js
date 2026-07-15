import crypto from 'node:crypto';

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

function assertNoSparseHoles(arr) {
  for (let i = 0; i < arr.length; i += 1) {
    if (!Object.prototype.hasOwnProperty.call(arr, i)) {
      throw new TypeError(`canonicalStringify: sparse array hole detected at index ${i}`);
    }
  }
}

function assertNoPollutionKeys(obj) {
  for (const key of Object.keys(obj)) {
    if (POLLUTION_KEYS.has(key)) {
      throw new TypeError(`canonicalStringify: prototype-pollution key "${key}" is not allowed`);
    }
  }
  for (const sym of Object.getOwnPropertySymbols(obj)) {
    throw new TypeError(`canonicalStringify: symbol key "${String(sym)}" is not allowed`);
  }
}

function encodeValue(value, seen) {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`canonicalStringify: non-finite number ${value} is not allowed`);
    }
    if (Object.is(value, -0)) {
      return '0';
    }
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    throw new TypeError('canonicalStringify: undefined is not allowed');
  }
  if (typeof value === 'bigint') {
    throw new TypeError('canonicalStringify: bigint is not allowed');
  }
  if (typeof value === 'function') {
    throw new TypeError('canonicalStringify: function is not allowed');
  }
  if (typeof value === 'symbol') {
    throw new TypeError('canonicalStringify: symbol is not allowed');
  }

  if (typeof value !== 'object') {
    throw new TypeError(`canonicalStringify: unsupported type ${typeof value}`);
  }

  if (seen.has(value)) {
    throw new TypeError('canonicalStringify: circular/cycle reference detected');
  }

  if (Array.isArray(value)) {
    assertNoSparseHoles(value);
    seen.add(value);
    const parts = value.map((item) => encodeValue(item, seen));
    seen.delete(value);
    return `[${parts.join(',')}]`;
  }

  if (!isPlainObject(value)) {
    throw new TypeError('canonicalStringify: non-plain object is not allowed (expected a plain object)');
  }

  assertNoPollutionKeys(value);

  seen.add(value);
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => `${JSON.stringify(key)}:${encodeValue(value[key], seen)}`);
  seen.delete(value);
  return `{${parts.join(',')}}`;
}

export function canonicalStringify(value) {
  return encodeValue(value, new Set());
}

export function canonicalHash(value) {
  const str = canonicalStringify(value);
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
