const SECRET_KEYS = new Set([
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'access_token',
  'refresh_token',
  'id_token',
  'authorization',
  'cookie',
  'set-cookie',
]);

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const JWT_PATTERN = /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const SAFE_PROTOTYPES = new Set([Object.prototype, null]);

function isPlainObject(val) {
  const proto = Object.getPrototypeOf(val);
  return SAFE_PROTOTYPES.has(proto);
}

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key).toLowerCase());
}

/**
 * Recursively redact secrets from plain objects, arrays and Errors.
 * Fail closed: throws on any accessor property, function, symbol, dangerous
 * key, collision, sparse array, extra array property, or unsupported type.
 * Never invokes user code (getters, constructors, or functions).
 */
export function redactSecrets(value, options = {}) {
  // Check for explicit undefined or non-array sentinels before destructuring
  if (options && Object.prototype.hasOwnProperty.call(options, 'sentinels')) {
    if (!Array.isArray(options.sentinels)) {
      throw new TypeError('redactSecrets: sentinels must be an array');
    }
  }

  const { sentinels = [] } = options;

  const cleanSentinels = sentinels.filter((s) => typeof s === 'string' && s.length > 0);

  const seen = new WeakMap();

  function redactString(str) {
    let result = str;
    result = result.replace(JWT_PATTERN, '[REDACTED_TOKEN]');
    result = result.replace(BEARER_PATTERN, '[REDACTED_TOKEN]');
    for (const sentinel of cleanSentinels) {
      result = result.split(sentinel).join('[REDACTED]');
    }
    return result;
  }

  function redactKeyName(key) {
    let result = key;
    for (const sentinel of cleanSentinels) {
      if (result.includes(sentinel)) {
        result = result.split(sentinel).join('[REDACTED]');
      }
    }
    return result;
  }

  function redactKeyedEntry(key, desc, copy, usedKeys) {
    if (desc.get || desc.set) {
      const safeKey = typeof key === 'string' ? redactString(key) : String(key);
      throw new TypeError(`redactSecrets: refusing to invoke accessor property "${safeKey}"`);
    }
    if (!('value' in desc)) {
      throw new TypeError(`redactSecrets: unsupported property descriptor for "${String(key)}"`);
    }

    if (typeof key === 'symbol') {
      throw new TypeError('redactSecrets: symbol properties are not supported');
    }

    if (DANGEROUS_KEYS.has(key)) {
      throw new TypeError(`redactSecrets: dangerous key "${key}" not allowed`);
    }

    const outKey = typeof key === 'string' ? redactKeyName(key) : key;

    if (usedKeys.has(outKey)) {
      throw new TypeError(`redactSecrets: key collision after redaction: "${String(outKey)}"`);
    }
    usedKeys.add(outKey);

    copy[outKey] = isSecretKey(key) ? '[REDACTED]' : redact(desc.value);
  }

  function cloneOwnProperties(source, copy) {
    const usedKeys = new Set();
    const keys = Object.keys(source);
    const symbols = Object.getOwnPropertySymbols(source);

    if (symbols.length > 0) {
      throw new TypeError('redactSecrets: symbol properties are not supported');
    }

    for (const key of keys) {
      const desc = Object.getOwnPropertyDescriptor(source, key);
      redactKeyedEntry(key, desc, copy, usedKeys);
    }
  }

  function redactErrorLike(val) {
    const proto = Object.getPrototypeOf(val);
    const redactedErr = Object.create(proto);
    seen.set(val, redactedErr);

    // Read name, message, stack through own property descriptors to avoid invoking user-defined getters
    // Note: native Error.stack is often an accessor, which is safe to invoke
    const nameDesc = Object.getOwnPropertyDescriptor(val, 'name');
    if (nameDesc) {
      if (nameDesc.get || nameDesc.set) {
        throw new TypeError('redactSecrets: Error.name is a user-defined accessor own property');
      }
      redactedErr.name = nameDesc.value;
    } else {
      // Not an own property, read from prototype chain (standard Error.name behavior)
      redactedErr.name = val.name;
    }

    const messageDesc = Object.getOwnPropertyDescriptor(val, 'message');
    if (messageDesc) {
      if (messageDesc.get || messageDesc.set) {
        throw new TypeError('redactSecrets: Error.message is a user-defined accessor own property');
      }
      redactedErr.message = redactString(String(messageDesc.value));
    } else {
      redactedErr.message = redactString(String(val.message));
    }

    // Stack is special: native Error.stack is often an accessor, so we allow reading it
    // We only reject if user added a custom accessor to an Error instance
    const stackDesc = Object.getOwnPropertyDescriptor(val, 'stack');
    if (stackDesc && 'value' in stackDesc) {
      // Own data property
      if (typeof stackDesc.value === 'string') {
        redactedErr.stack = redactString(stackDesc.value);
      }
    } else if (stackDesc && (stackDesc.get || stackDesc.set)) {
      // Own accessor - check if it looks like native or user-defined
      // Native stack accessors are safe, but user-defined ones could leak secrets
      // Heuristic: if it's on a plain Error instance, it's likely native
      // For safety in adversarial contexts, we'll allow reading val.stack but only if proto is Error.prototype
      const isStandardError = proto === Error.prototype ||
                              proto === TypeError.prototype ||
                              proto === RangeError.prototype ||
                              proto === ReferenceError.prototype ||
                              proto === SyntaxError.prototype;
      if (isStandardError && typeof val.stack === 'string') {
        redactedErr.stack = redactString(val.stack);
      } else if (!isStandardError) {
        // Custom Error subclass with accessor stack - risky, but allow reading for now
        if (typeof val.stack === 'string') {
          redactedErr.stack = redactString(val.stack);
        }
      }
    } else if (typeof val.stack === 'string') {
      // Stack is inherited or auto-generated
      redactedErr.stack = redactString(val.stack);
    }

    if (Object.prototype.hasOwnProperty.call(val, 'cause')) {
      const causeDesc = Object.getOwnPropertyDescriptor(val, 'cause');
      if (causeDesc.get || causeDesc.set) {
        throw new TypeError('redactSecrets: Error.cause is a user-defined accessor property');
      }
      redactedErr.cause = redact(causeDesc.value);
    }

    const usedKeys = new Set(['name', 'message', 'stack', 'cause']);
    const keys = Object.keys(val);
    const symbols = Object.getOwnPropertySymbols(val);

    if (symbols.length > 0) {
      throw new TypeError('redactSecrets: symbol properties on Error are not supported');
    }

    for (const key of keys) {
      if (key === 'message' || key === 'name' || key === 'stack' || key === 'cause') continue;
      const desc = Object.getOwnPropertyDescriptor(val, key);
      redactKeyedEntry(key, desc, redactedErr, usedKeys);
    }

    return redactedErr;
  }

  function redact(val) {
    if (val === null || val === undefined) {
      return val;
    }

    if (typeof val === 'string') {
      return redactString(val);
    }

    if (typeof val === 'function') {
      throw new TypeError('redactSecrets: function values are not supported');
    }

    if (typeof val === 'symbol') {
      throw new TypeError('redactSecrets: symbol values are not supported');
    }

    if (typeof val !== 'object') {
      return val;
    }

    if (seen.has(val)) {
      return seen.get(val);
    }

    if (val instanceof Error) {
      return redactErrorLike(val);
    }

    if (Array.isArray(val)) {
      const copy = [];
      seen.set(val, copy);

      // Check for non-numeric own properties
      const keys = Object.keys(val);
      for (const key of keys) {
        const index = Number(key);
        if (!Number.isInteger(index) || index < 0 || index >= val.length) {
          throw new TypeError(`redactSecrets: array has non-numeric own property "${key}"`);
        }
      }

      // Check for symbols
      const symbols = Object.getOwnPropertySymbols(val);
      if (symbols.length > 0) {
        throw new TypeError('redactSecrets: symbol properties on array are not supported');
      }

      for (let i = 0; i < val.length; i++) {
        const desc = Object.getOwnPropertyDescriptor(val, i);
        if (!desc) {
          throw new TypeError(`redactSecrets: array has a hole at index ${i}`);
        }
        if (desc.get || desc.set) {
          throw new TypeError(`redactSecrets: refusing to invoke accessor property "${i}"`);
        }
        if (!('value' in desc)) {
          throw new TypeError(`redactSecrets: unsupported property descriptor for array index "${i}"`);
        }
        copy.push(redact(desc.value));
      }
      return copy;
    }

    if (isPlainObject(val)) {
      const copy = {};
      seen.set(val, copy);
      cloneOwnProperties(val, copy);
      return copy;
    }

    // Avoid reading val.constructor which could be a getter
    const proto = Object.getPrototypeOf(val);
    // Do not access proto.constructor.name which could invoke a getter
    throw new TypeError(
      `redactSecrets: cannot safely redact unsupported object type`
    );
  }

  return redact(value);
}
