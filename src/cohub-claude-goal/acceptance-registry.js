/**
 * @fileoverview Acceptance gate catalog and evidence manifest validator.
 * Immutable registry of 42 acceptance gates. Evidence requirements are
 * enforced per category; all validation errors are structured frozen
 * objects ({ code, gateId, field, message }).
 */

const REQUIRED_EVIDENCE_BY_CATEGORY = {
  deterministic: ['fixture', 'trace', 'report'],
  real_claude: ['stream', 'transcript', 'server_log', 'report'],
  real_cohub: ['server_trace', 'exact_read', 'report'],
  soak: ['stream', 'metrics', 'report'],
  production_pilot: ['ledger', 'server_trace', 'report']
};

const CATEGORY_BY_GATE = {
  'CLI-01': 'deterministic',
  'EVT-01': 'deterministic',
  'EVT-02': 'deterministic',
  'EVT-03': 'deterministic',
  'EVT-04': 'deterministic',
  'EVT-05': 'deterministic',
  'EVT-06': 'deterministic',
  'WAIT-01': 'deterministic',
  'GOAL-01': 'deterministic',
  'SEND-01': 'deterministic',
  'SEND-02': 'deterministic',
  'SEND-03': 'deterministic',
  'SEND-04': 'deterministic',
  'SEND-05': 'deterministic',
  'CON-01': 'deterministic',
  'CON-02': 'deterministic',
  'STATE-01': 'deterministic',
  'STATE-02': 'deterministic',
  'STATE-03': 'deterministic',
  'MIG-01': 'deterministic',
  'REPLACE-01': 'deterministic',
  'PROGRESS-01': 'deterministic',
  'DONE-01': 'deterministic',
  'AUDIT-01': 'deterministic',
  'AUDIT-02': 'deterministic',
  'REG-67-01': 'deterministic',
  'CAP-GOAL-01': 'real_claude',
  'CAP-GOAL-02': 'real_claude',
  'CAP-WAIT-01': 'real_claude',
  'CAP-VERIFY-01': 'real_claude',
  'GOAL-02': 'real_claude',
  'CAP-WS-01': 'real_cohub',
  'CAP-SEND-01': 'real_cohub',
  'CAP-AUTHORITY-01': 'real_cohub',
  'WAIT-02': 'real_cohub',
  'GATE-01': 'real_cohub',
  'CANARY-01': 'real_cohub',
  'WAIT-03': 'soak',
  'GATE-02': 'production_pilot',
  'DONE-02': 'production_pilot',
  'NOCODEX-01': 'production_pilot',
  'PILOT-01': 'production_pilot'
};

export const ACCEPTANCE_GATES = Object.freeze(
  Object.fromEntries(
    Object.entries(CATEGORY_BY_GATE).map(([id, category]) => [
      id,
      Object.freeze({
        category,
        requiredEvidence: Object.freeze([...REQUIRED_EVIDENCE_BY_CATEGORY[category]])
      })
    ])
  )
);

const SHA256_REGEX = /^[a-f0-9]{64}$/;
const ISO8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function parseISOComponents(isoString) {
  const match = isoString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return null;

  const [, year, month, day, hour, minute, second, fraction] = match;
  return {
    year: parseInt(year, 10),
    month: parseInt(month, 10),
    day: parseInt(day, 10),
    hour: parseInt(hour, 10),
    minute: parseInt(minute, 10),
    second: parseInt(second, 10),
    fraction: fraction || ''
  };
}
const VALID_VERDICTS = new Set(['PASS', 'PARTIAL', 'FAIL']);
const FORBIDDEN_NON_DETERMINISTIC_SOURCES = new Set(['fake', 'test_double']);
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const FUTURE_SKEW_MS = 5 * 60 * 1000;

function makeError(code, gateId, field, message) {
  return Object.freeze({ code, gateId, field, message });
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasDangerousKeys(obj) {
  for (const key of Object.keys(obj)) {
    if (DANGEROUS_KEYS.has(key)) return true;
  }
  return false;
}

function isValidISO8601(str) {
  if (typeof str !== 'string' || !ISO8601_REGEX.test(str)) return false;

  const components = parseISOComponents(str);
  if (!components) return false;

  const date = new Date(str);
  if (Number.isNaN(date.getTime())) return false;

  // Build canonical form with same fraction length as input
  const { year, month, day, hour, minute, second, fraction } = components;
  const paddedFraction = fraction ? `.${fraction.padEnd(3, '0')}` : '.000';
  const canonical = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}${paddedFraction}Z`;

  // Parse canonical and verify calendar components match
  const canonicalDate = new Date(canonical);
  if (canonicalDate.getUTCFullYear() !== year) return false;
  if (canonicalDate.getUTCMonth() + 1 !== month) return false;
  if (canonicalDate.getUTCDate() !== day) return false;
  if (canonicalDate.getUTCHours() !== hour) return false;
  if (canonicalDate.getUTCMinutes() !== minute) return false;
  if (canonicalDate.getUTCSeconds() !== second) return false;

  return true;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function isForbiddenSource(source, category) {
  if (category === 'deterministic') return false;
  const normalized = String(source).trim().toLowerCase();
  return FORBIDDEN_NON_DETERMINISTIC_SOURCES.has(normalized);
}

function validateEvidence(gateId, evidence, gateSpec) {
  const errors = [];
  const { category, requiredEvidence } = gateSpec;
  const allowedKinds = new Set(requiredEvidence);

  if (!Array.isArray(evidence)) {
    errors.push(makeError('EVIDENCE_NOT_ARRAY', gateId, 'evidence', 'evidence must be an array'));
    return errors;
  }

  const presentKinds = new Set();

  evidence.forEach((item, index) => {
    const field = `evidence[${index}]`;

    if (!isPlainObject(item)) {
      errors.push(makeError('EVIDENCE_ITEM_NOT_OBJECT', gateId, field, 'evidence item must be an object'));
      return;
    }

    if (hasDangerousKeys(item)) {
      errors.push(makeError(
        'EVIDENCE_ITEM_DANGEROUS_KEYS', gateId, field,
        'evidence item must not contain dangerous keys (__proto__, constructor, prototype)'
      ));
    }

    if (!allowedKinds.has(item.kind)) {
      errors.push(makeError(
        'EVIDENCE_KIND_NOT_ALLOWED', gateId, `${field}.kind`,
        `kind ${String(item.kind)} not allowed for ${category} gate; allowed: ${requiredEvidence.join(', ')}`
      ));
    } else {
      presentKinds.add(item.kind);
    }

    if (!isNonEmptyString(item.ref)) {
      errors.push(makeError('EVIDENCE_REF_INVALID', gateId, `${field}.ref`, 'ref must be a non-empty string'));
    }

    if (typeof item.sha256 !== 'string' || !SHA256_REGEX.test(item.sha256)) {
      errors.push(makeError(
        'EVIDENCE_SHA256_INVALID', gateId, `${field}.sha256`,
        'sha256 must be a lowercase 64-character hex string'
      ));
    }

    if (!isNonEmptyString(item.source)) {
      errors.push(makeError('EVIDENCE_SOURCE_INVALID', gateId, `${field}.source`, 'source must be a non-empty string'));
    } else if (isForbiddenSource(item.source, category)) {
      errors.push(makeError(
        'EVIDENCE_SOURCE_FORBIDDEN', gateId, `${field}.source`,
        `source ${item.source.trim().toLowerCase()} not allowed for ${category} gate`
      ));
    }
  });

  for (const kind of requiredEvidence) {
    if (!presentKinds.has(kind)) {
      errors.push(makeError(
        'EVIDENCE_KIND_MISSING', gateId, 'evidence',
        `required evidence kind ${kind} missing for ${category} gate`
      ));
    }
  }

  return errors;
}

function validateOptions(options) {
  const { now = new Date(), expectedVersions = {}, maxAgeMs = Infinity } = options;

  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new TypeError('options.now must be a valid Date');
  }
  if (typeof maxAgeMs !== 'number' || Number.isNaN(maxAgeMs) || maxAgeMs < 0
    || (!Number.isFinite(maxAgeMs) && maxAgeMs !== Infinity)) {
    throw new TypeError('options.maxAgeMs must be a finite nonnegative number or Infinity');
  }
  if (!isPlainObject(expectedVersions)) {
    throw new TypeError('options.expectedVersions must be a plain object');
  }
  if (hasDangerousKeys(expectedVersions)) {
    throw new TypeError('options.expectedVersions must not contain dangerous keys (__proto__, constructor, prototype)');
  }

  for (const [key, value] of Object.entries(expectedVersions)) {
    if (!isNonEmptyString(key)) {
      throw new TypeError('options.expectedVersions keys must be non-empty strings');
    }
    if (!isNonEmptyString(value)) {
      throw new TypeError('options.expectedVersions values must be non-empty strings');
    }
  }

  return { now, expectedVersions, maxAgeMs };
}

export function validateEvidenceManifest(manifest, options = {}) {
  const { now, expectedVersions, maxAgeMs } = validateOptions(options);
  const integrityErrors = [];
  const gateResults = [];

  if (!isPlainObject(manifest) && !Array.isArray(manifest)) {
    return {
      verdict: 'FAIL',
      integrityErrors: [makeError('MANIFEST_NOT_OBJECT', null, 'manifest', 'manifest must be a plain object or array')],
      gateResults: []
    };
  }

  let records;

  if (Array.isArray(manifest)) {
    records = [];
    for (let i = 0; i < manifest.length; i++) {
      const entry = manifest[i];
      if (!isPlainObject(entry)) {
        integrityErrors.push(makeError(
          'ARRAY_ENTRY_NOT_OBJECT', null, `manifest[${i}]`,
          `array entry at index ${i} must be a plain object`
        ));
        continue;
      }
      const id = entry.id;
      if (id === undefined) {
        integrityErrors.push(makeError(
          'ARRAY_ENTRY_MISSING_ID', null, `manifest[${i}].id`,
          `array entry at index ${i} missing id field`
        ));
        continue;
      }
      if (typeof id !== 'string') {
        integrityErrors.push(makeError(
          'ARRAY_ENTRY_ID_NOT_STRING', null, `manifest[${i}].id`,
          `array entry at index ${i} has non-string id: ${typeof id}`
        ));
        continue;
      }
      if (id.trim() === '') {
        integrityErrors.push(makeError(
          'ARRAY_ENTRY_ID_EMPTY', null, `manifest[${i}].id`,
          `array entry at index ${i} has empty id`
        ));
        continue;
      }
      records.push(entry);
    }
  } else {
    records = [];
    for (const [key, data] of Object.entries(manifest)) {
      if (!isPlainObject(data)) {
        integrityErrors.push(makeError(
          'OBJECT_VALUE_NOT_OBJECT', key, `manifest.${key}`,
          `manifest value for key ${key} must be a plain object`
        ));
        continue;
      }
      if (data.id !== undefined && data.id !== key) {
        integrityErrors.push(makeError(
          'OBJECT_ID_MISMATCH', key, `manifest.${key}.id`,
          `embedded id ${data.id} does not match object key ${key}`
        ));
        continue;
      }
      records.push({ id: key, ...data });
    }
  }

  if (integrityErrors.length > 0) {
    return { verdict: 'FAIL', integrityErrors, gateResults: [] };
  }

  const seenIds = new Set();
  const knownIds = new Set(Object.keys(ACCEPTANCE_GATES));

  for (const record of records) {
    const id = record.id;
    if (seenIds.has(id)) {
      integrityErrors.push(makeError('DUPLICATE_GATE_ID', id, 'id', `duplicate gate ID: ${id}`));
    }
    seenIds.add(id);
    if (!knownIds.has(id)) {
      integrityErrors.push(makeError('UNKNOWN_GATE_ID', id, 'id', `unknown gate ID: ${id}`));
    }
  }

  if (integrityErrors.length > 0) {
    return { verdict: 'FAIL', integrityErrors, gateResults: [] };
  }

  const recordMap = new Map(records.map((r) => [r.id, r]));

  for (const [gateId, gateSpec] of Object.entries(ACCEPTANCE_GATES)) {
    const record = recordMap.get(gateId);

    if (!record) {
      gateResults.push({
        id: gateId,
        verdict: 'PARTIAL',
        stale: false,
        errors: [makeError('GATE_RECORD_MISSING', gateId, 'record', 'missing gate record')]
      });
      continue;
    }

    const errors = [];
    let stale = false;

    if (hasDangerousKeys(record)) {
      errors.push(makeError(
        'RECORD_DANGEROUS_KEYS', gateId, 'record',
        'record must not contain dangerous keys (__proto__, constructor, prototype)'
      ));
    }

    if (!VALID_VERDICTS.has(record.verdict)) {
      errors.push(makeError(
        'VERDICT_INVALID', gateId, 'verdict',
        `verdict must be exactly PASS, PARTIAL, or FAIL; got ${String(record.verdict)}`
      ));
    }

    if (!isValidISO8601(record.timestamp)) {
      errors.push(makeError('TIMESTAMP_INVALID', gateId, 'timestamp', 'timestamp must be a valid canonical ISO-8601 UTC string'));
    } else {
      const recordTime = new Date(record.timestamp).getTime();
      const ageMs = now.getTime() - recordTime;
      if (ageMs < -FUTURE_SKEW_MS) {
        errors.push(makeError(
          'TIMESTAMP_FUTURE', gateId, 'timestamp',
          'timestamp is more than 5 minutes in the future'
        ));
      } else if (ageMs > maxAgeMs) {
        stale = true;
      }
    }

    const expectedKeys = Object.keys(expectedVersions);
    if (expectedKeys.length > 0 || record.environment !== undefined) {
      const environment = record.environment;
      if (!isPlainObject(environment)) {
        errors.push(makeError('ENVIRONMENT_MISSING', gateId, 'environment', 'record.environment must be a plain object'));
      } else if (hasDangerousKeys(environment)) {
        errors.push(makeError('ENVIRONMENT_DANGEROUS_KEYS', gateId, 'environment', 'record.environment must not contain dangerous keys (__proto__, constructor, prototype)'));
      } else if (expectedKeys.length > 0) {
        for (const key of expectedKeys) {
          if (!Object.hasOwn(environment, key)) {
            errors.push(makeError(
              'VERSION_KEY_MISSING', gateId, `environment.${key}`,
              `expected version key ${key} missing from record.environment`
            ));
          } else if (environment[key] !== expectedVersions[key]) {
            errors.push(makeError(
              'VERSION_MISMATCH', gateId, `environment.${key}`,
              `version mismatch for ${key}: expected ${String(expectedVersions[key])}, got ${String(environment[key])}`
            ));
          }
        }
      }
    }

    errors.push(...validateEvidence(gateId, record.evidence, gateSpec));

    let verdict;
    if (errors.length > 0) {
      verdict = 'FAIL';
    } else if (record.verdict !== 'PASS') {
      verdict = record.verdict;
    } else if (stale) {
      verdict = 'PARTIAL';
    } else {
      verdict = 'PASS';
    }

    gateResults.push({
      id: gateId,
      verdict,
      stale,
      errors: errors.length > 0 ? errors : undefined
    });
  }

  let overallVerdict = 'PASS';
  if (gateResults.some((g) => g.verdict === 'FAIL')) {
    overallVerdict = 'FAIL';
  } else if (gateResults.some((g) => g.verdict === 'PARTIAL')) {
    overallVerdict = 'PARTIAL';
  }

  return { verdict: overallVerdict, integrityErrors, gateResults };
}
