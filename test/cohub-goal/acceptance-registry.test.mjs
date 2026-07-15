import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcPath = join(__dirname, '../../src/cohub-claude-goal/acceptance-registry.js');

const mod = await import(srcPath);
const { ACCEPTANCE_GATES, validateEvidenceManifest } = mod;

// Exact category mapping (authoritative).
const CATEGORY_MAP = {
  deterministic: [
    'CLI-01', 'EVT-01', 'EVT-02', 'EVT-03', 'EVT-04', 'EVT-05', 'EVT-06',
    'WAIT-01', 'GOAL-01', 'SEND-01', 'SEND-02', 'SEND-03', 'SEND-04', 'SEND-05',
    'CON-01', 'CON-02', 'STATE-01', 'STATE-02', 'STATE-03', 'MIG-01',
    'REPLACE-01', 'PROGRESS-01', 'DONE-01', 'AUDIT-01', 'AUDIT-02', 'REG-67-01'
  ],
  real_claude: ['CAP-GOAL-01', 'CAP-GOAL-02', 'CAP-WAIT-01', 'CAP-VERIFY-01', 'GOAL-02'],
  real_cohub: ['CAP-WS-01', 'CAP-SEND-01', 'CAP-AUTHORITY-01', 'WAIT-02', 'GATE-01', 'CANARY-01'],
  soak: ['WAIT-03'],
  production_pilot: ['GATE-02', 'DONE-02', 'NOCODEX-01', 'PILOT-01']
};

// Exact required evidence kinds per category (authoritative).
const REQUIRED_EVIDENCE = {
  deterministic: ['fixture', 'trace', 'report'],
  real_claude: ['stream', 'transcript', 'server_log', 'report'],
  real_cohub: ['server_trace', 'exact_read', 'report'],
  soak: ['stream', 'metrics', 'report'],
  production_pilot: ['ledger', 'server_trace', 'report']
};

const ALL_IDS = Object.values(CATEGORY_MAP).flat();

function validEvidence(id, overrides = {}) {
  const spec = ACCEPTANCE_GATES[id];
  return spec.requiredEvidence.map((kind) => ({
    kind,
    ref: `artifacts/${id}/${kind}.log`,
    sha256: 'a'.repeat(64),
    source: spec.category === 'deterministic' ? 'fixture_run' : 'real',
    ...overrides
  }));
}

function validRecord(id, now, overrides = {}) {
  return {
    verdict: 'PASS',
    evidence: validEvidence(id),
    timestamp: now.toISOString(),
    environment: {},
    ...overrides
  };
}

function fullManifest(now, mutate = {}) {
  const manifest = {};
  for (const id of ALL_IDS) manifest[id] = validRecord(id, now);
  for (const [id, record] of Object.entries(mutate)) manifest[id] = record;
  return manifest;
}

function gateResult(result, id) {
  return result.gateResults.find((g) => g.id === id);
}

function assertStructuredErrors(errors) {
  assert.ok(Array.isArray(errors), 'errors must be an array');
  assert.ok(errors.length > 0, 'errors must be nonempty');
  for (const e of errors) {
    assert.strictEqual(typeof e, 'object', 'error must be an object, not a string');
    assert.notStrictEqual(e, null);
    assert.strictEqual(typeof e.code, 'string', 'error.code must be a string');
    assert.ok('gateId' in e, 'error must carry gateId (or null)');
    assert.ok(e.gateId === null || typeof e.gateId === 'string');
    assert.strictEqual(typeof e.field, 'string', 'error.field must be a string');
    assert.strictEqual(typeof e.message, 'string', 'error.message must be a string');
    assert.ok(Object.isFrozen(e), 'error object must be frozen');
  }
}

describe('acceptance-registry catalog', () => {
  it('contains exactly 42 gate IDs, no more no less', () => {
    const ids = Object.keys(ACCEPTANCE_GATES).sort();
    assert.deepStrictEqual(ids, [...ALL_IDS].sort());
  });

  it('classifies every gate with the exact authoritative category', () => {
    for (const [category, ids] of Object.entries(CATEGORY_MAP)) {
      for (const id of ids) {
        assert.strictEqual(
          ACCEPTANCE_GATES[id]?.category, category,
          `${id} must be ${category}, got ${ACCEPTANCE_GATES[id]?.category}`
        );
      }
    }
  });

  it('specifies the exact required evidence kinds per category', () => {
    for (const [id, spec] of Object.entries(ACCEPTANCE_GATES)) {
      assert.deepStrictEqual(
        [...spec.requiredEvidence], REQUIRED_EVIDENCE[spec.category],
        `${id} requiredEvidence must be exactly ${REQUIRED_EVIDENCE[spec.category]}`
      );
    }
  });

  it('is deep-frozen: catalog, gate specs, and requiredEvidence arrays', () => {
    assert.ok(Object.isFrozen(ACCEPTANCE_GATES));
    assert.throws(() => { ACCEPTANCE_GATES['NEW-01'] = {}; });
    for (const [id, spec] of Object.entries(ACCEPTANCE_GATES)) {
      assert.ok(Object.isFrozen(spec), `${id} spec must be frozen`);
      assert.ok(Object.isFrozen(spec.requiredEvidence), `${id} requiredEvidence must be frozen`);
      assert.throws(() => { spec.category = 'tampered'; }, undefined, `${id} category must not be writable`);
      assert.throws(() => { spec.requiredEvidence.push('tampered'); }, undefined, `${id} requiredEvidence must not be extensible`);
    }
  });
});

describe('validateEvidenceManifest options validation', () => {
  it('throws TypeError on invalid now', () => {
    const manifest = fullManifest(new Date());
    assert.throws(() => validateEvidenceManifest(manifest, { now: 'today' }), TypeError);
    assert.throws(() => validateEvidenceManifest(manifest, { now: new Date('garbage') }), TypeError);
    assert.throws(() => validateEvidenceManifest(manifest, { now: 12345 }), TypeError);
  });

  it('throws TypeError on invalid maxAgeMs', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    assert.throws(() => validateEvidenceManifest(manifest, { now, maxAgeMs: -1 }), TypeError);
    assert.throws(() => validateEvidenceManifest(manifest, { now, maxAgeMs: NaN }), TypeError);
    assert.throws(() => validateEvidenceManifest(manifest, { now, maxAgeMs: '1000' }), TypeError);
  });

  it('accepts maxAgeMs Infinity and finite nonnegative values', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    assert.strictEqual(validateEvidenceManifest(manifest, { now, maxAgeMs: Infinity }).verdict, 'PASS');
    assert.strictEqual(validateEvidenceManifest(manifest, { now, maxAgeMs: 0 }).verdict, 'PASS');
  });
});

describe('validateEvidenceManifest integrity', () => {
  it('fails on non-object manifest with structured errors', () => {
    for (const bad of [null, undefined, 'manifest', 42]) {
      const result = validateEvidenceManifest(bad, { now: new Date() });
      assert.strictEqual(result.verdict, 'FAIL');
      assertStructuredErrors(result.integrityErrors);
    }
  });

  it('fails on unknown gate ID with structured error carrying gateId', () => {
    const now = new Date();
    const manifest = fullManifest(now, { 'UNKNOWN-99': validRecord('CLI-01', now) });
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
    assert.ok(result.integrityErrors.some((e) => e.gateId === 'UNKNOWN-99'));
  });

  it('fails on duplicate gate IDs (array form) with structured error', () => {
    const now = new Date();
    const records = ALL_IDS.map((id) => ({ id, ...validRecord(id, now) }));
    records.push({ id: 'CLI-01', ...validRecord('CLI-01', now) });
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
    assert.ok(result.integrityErrors.some((e) => e.gateId === 'CLI-01'));
  });

  it('integrity FAIL takes precedence over everything', () => {
    const now = new Date();
    const manifest = { 'UNKNOWN-99': validRecord('CLI-01', now) };
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'FAIL');
  });
});

describe('validateEvidenceManifest record shape', () => {
  it('fails a gate whose record is not an object', () => {
    const now = new Date();
    for (const bad of [null, 'record', 42, ['x']]) {
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': bad }), { now });
      assert.strictEqual(result.verdict, 'FAIL', `record ${JSON.stringify(bad)} must FAIL`);
      assertStructuredErrors(result.integrityErrors);
      const err = result.integrityErrors.find((e) => e.code === 'OBJECT_VALUE_NOT_OBJECT');
      assert.ok(err, `record ${JSON.stringify(bad)} must produce OBJECT_VALUE_NOT_OBJECT integrity error`);
      assert.ok(Object.isFrozen(err), 'OBJECT_VALUE_NOT_OBJECT error must be frozen');
    }
  });

  it('fails a gate whose verdict is not exactly PASS/PARTIAL/FAIL', () => {
    const now = new Date();
    for (const bad of ['pass', 'OK', 'PASSED', '', undefined, null, true]) {
      const record = validRecord('CLI-01', now, { verdict: bad });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      const g = gateResult(result, 'CLI-01');
      assert.strictEqual(g.verdict, 'FAIL', `verdict ${JSON.stringify(bad)} must FAIL`);
      assertStructuredErrors(g.errors);
    }
  });

  it('reports missing gate record as PARTIAL with structured error', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    delete manifest['CLI-01'];
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'PARTIAL');
    const g = gateResult(result, 'CLI-01');
    assert.strictEqual(g.verdict, 'PARTIAL');
    assertStructuredErrors(g.errors);
  });
});

describe('validateEvidenceManifest evidence rules', () => {
  it('FAILs a PASS record missing any required kind (per category)', () => {
    const now = new Date();
    const samples = {
      deterministic: 'CLI-01',
      real_claude: 'CAP-GOAL-01',
      real_cohub: 'CAP-WS-01',
      soak: 'WAIT-03',
      production_pilot: 'PILOT-01'
    };
    for (const [category, id] of Object.entries(samples)) {
      for (const dropped of REQUIRED_EVIDENCE[category]) {
        const record = validRecord(id, now);
        record.evidence = record.evidence.filter((e) => e.kind !== dropped);
        const result = validateEvidenceManifest(fullManifest(now, { [id]: record }), { now });
        const g = gateResult(result, id);
        assert.strictEqual(g.verdict, 'FAIL', `${id} PASS without ${dropped} must FAIL`);
        assertStructuredErrors(g.errors);
      }
    }
  });

  it('FAILs evidence items that are not objects', () => {
    const now = new Date();
    const record = validRecord('CLI-01', now);
    record.evidence.push('transcript.txt');
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
    assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL');
  });

  it('FAILs evidence with a kind not allowed for the gate', () => {
    const now = new Date();
    const record = validRecord('CLI-01', now);
    record.evidence.push({ kind: 'screenshot', ref: 'x.png', sha256: 'b'.repeat(64), source: 'fixture_run' });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
    const g = gateResult(result, 'CLI-01');
    assert.strictEqual(g.verdict, 'FAIL');
    assertStructuredErrors(g.errors);
  });

  it('FAILs evidence with missing or empty ref', () => {
    const now = new Date();
    for (const bad of [undefined, '', '   ', 42]) {
      const record = validRecord('CLI-01', now);
      record.evidence[0] = { ...record.evidence[0], ref: bad };
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `ref ${JSON.stringify(bad)} must FAIL`);
    }
  });

  it('FAILs evidence with missing, uppercase, short, or non-hex sha256', () => {
    const now = new Date();
    for (const bad of [undefined, 'A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), 'deadbeef']) {
      const record = validRecord('CLI-01', now);
      record.evidence[0] = { ...record.evidence[0], sha256: bad };
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `sha256 ${JSON.stringify(bad)} must FAIL`);
    }
  });

  it('FAILs evidence with missing or empty source', () => {
    const now = new Date();
    for (const bad of [undefined, '', '  ']) {
      const record = validRecord('CLI-01', now);
      record.evidence[0] = { ...record.evidence[0], source: bad };
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `source ${JSON.stringify(bad)} must FAIL`);
    }
  });

  it('rejects source fake/test_double on every non-deterministic gate', () => {
    const now = new Date();
    const nonDeterministic = ALL_IDS.filter((id) => ACCEPTANCE_GATES[id].category !== 'deterministic');
    for (const id of nonDeterministic) {
      for (const source of ['fake', 'test_double']) {
        const record = validRecord(id, now);
        record.evidence[0] = { ...record.evidence[0], source };
        const result = validateEvidenceManifest(fullManifest(now, { [id]: record }), { now });
        const g = gateResult(result, id);
        assert.strictEqual(g.verdict, 'FAIL', `${id} with source=${source} must FAIL`);
        assertStructuredErrors(g.errors);
      }
    }
  });

  it('allows source fake/test_double on deterministic gates', () => {
    const now = new Date();
    for (const source of ['fake', 'test_double']) {
      const record = validRecord('CLI-01', now, { evidence: validEvidence('CLI-01', { source }) });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'PASS', `deterministic source=${source} must be allowed`);
    }
  });
});

describe('validateEvidenceManifest timestamps and versions', () => {
  it('FAILs on malformed ISO timestamp', () => {
    const now = new Date();
    const record = validRecord('CLI-01', now, { timestamp: 'not-iso' });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
    assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL');
  });

  it('FAILs on timestamp more than 5 minutes in the future', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const future = new Date(now.getTime() + 5 * 60 * 1000 + 1000);
    const record = validRecord('CLI-01', now, { timestamp: future.toISOString() });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
    const g = gateResult(result, 'CLI-01');
    assert.strictEqual(g.verdict, 'FAIL');
    assertStructuredErrors(g.errors);
  });

  it('tolerates timestamps within 5 minutes of clock skew', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const nearFuture = new Date(now.getTime() + 4 * 60 * 1000);
    const record = validRecord('CLI-01', now, { timestamp: nearFuture.toISOString() });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
    assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'PASS');
  });

  it('treats expectedVersions as a global map matched against record.environment', () => {
    const now = new Date();
    const expectedVersions = { node: '22.1.0', registry: '2' };
    const manifest = {};
    for (const id of ALL_IDS) {
      manifest[id] = validRecord(id, now, { environment: { node: '22.1.0', registry: '2' } });
    }
    const ok = validateEvidenceManifest(manifest, { now, expectedVersions });
    assert.strictEqual(ok.verdict, 'PASS');

    // Mismatch on one key of one record → that gate FAILs.
    manifest['EVT-01'] = validRecord('EVT-01', now, { environment: { node: '20.0.0', registry: '2' } });
    const mismatch = validateEvidenceManifest(manifest, { now, expectedVersions });
    const g = gateResult(mismatch, 'EVT-01');
    assert.strictEqual(g.verdict, 'FAIL');
    assertStructuredErrors(g.errors);

    // Missing environment key entirely → FAIL.
    manifest['EVT-01'] = validRecord('EVT-01', now, { environment: { node: '22.1.0' } });
    const missingKey = validateEvidenceManifest(manifest, { now, expectedVersions });
    assert.strictEqual(gateResult(missingKey, 'EVT-01').verdict, 'FAIL');

    // Missing environment object entirely → FAIL.
    const bare = validRecord('EVT-01', now);
    delete bare.environment;
    manifest['EVT-01'] = bare;
    const missingEnv = validateEvidenceManifest(manifest, { now, expectedVersions });
    assert.strictEqual(gateResult(missingEnv, 'EVT-01').verdict, 'FAIL');
  });

  it('marks stale but otherwise valid evidence as PARTIAL, not FAIL', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const old = new Date(now.getTime() - 100000);
    const record = validRecord('CLI-01', now, { timestamp: old.toISOString() });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now, maxAgeMs: 50000 });
    const g = gateResult(result, 'CLI-01');
    assert.strictEqual(g.stale, true);
    assert.strictEqual(g.verdict, 'PARTIAL');
    assert.strictEqual(result.verdict, 'PARTIAL');
  });
});

describe('validateEvidenceManifest verdict aggregation', () => {
  it('returns PASS when all 42 gates carry complete category-correct evidence', () => {
    const now = new Date();
    const result = validateEvidenceManifest(fullManifest(now), { now });
    assert.strictEqual(result.verdict, 'PASS');
    assert.strictEqual(result.integrityErrors.length, 0);
    assert.strictEqual(result.gateResults.length, 42);
    assert.ok(result.gateResults.every((g) => g.verdict === 'PASS'));
  });

  it('FAIL precedence over PARTIAL', () => {
    const now = new Date();
    const manifest = fullManifest(now, {
      'CLI-01': validRecord('CLI-01', now, { verdict: 'FAIL' }),
      'EVT-01': validRecord('EVT-01', now, { verdict: 'PARTIAL' })
    });
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'FAIL');
  });

  it('returns PARTIAL when any gate is PARTIAL', () => {
    const now = new Date();
    const manifest = fullManifest(now, {
      'CLI-01': validRecord('CLI-01', now, { verdict: 'PARTIAL' })
    });
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'PARTIAL');
  });
});

describe('adversarial round 2: isPlainObject bypass', () => {
  it('rejects Date, Map, Set, class instances as manifest', () => {
    const now = new Date();
    class Custom {}
    for (const bad of [new Date(), new Map(), new Set(), new Custom()]) {
      const result = validateEvidenceManifest(bad, { now });
      assert.strictEqual(result.verdict, 'FAIL', `${bad.constructor.name} must FAIL`);
      assertStructuredErrors(result.integrityErrors);
    }
  });

  it('rejects Date as expectedVersions, not silently skip version checks', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    assert.throws(() => validateEvidenceManifest(manifest, { now, expectedVersions: new Date() }), TypeError);
  });

  it('rejects expectedVersions with custom/inherited prototype', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    class VersionMap {}
    VersionMap.prototype.node = '20.0.0';
    const inherited = new VersionMap();
    assert.throws(() => validateEvidenceManifest(manifest, { now, expectedVersions: inherited }), TypeError);
  });

  it('rejects expectedVersions with dangerous keys __proto__, constructor, prototype', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const dangerous = { [key]: 'v1' };
      assert.throws(
        () => validateEvidenceManifest(manifest, { now, expectedVersions: dangerous }),
        TypeError,
        `expectedVersions key ${key} must be rejected`
      );
    }
  });

  it('rejects expectedVersions with empty-string keys or values', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    assert.throws(() => validateEvidenceManifest(manifest, { now, expectedVersions: { '': 'v1' } }), TypeError);
    assert.throws(() => validateEvidenceManifest(manifest, { now, expectedVersions: { node: '' } }), TypeError);
    assert.throws(() => validateEvidenceManifest(manifest, { now, expectedVersions: { node: '  ' } }), TypeError);
  });

  it('rejects expectedVersions with non-string values', () => {
    const now = new Date();
    const manifest = fullManifest(now);
    for (const bad of [undefined, null, 42, { nested: 'obj' }, ['array']]) {
      assert.throws(
        () => validateEvidenceManifest(manifest, { now, expectedVersions: { node: bad } }),
        TypeError,
        `expectedVersions value ${JSON.stringify(bad)} must be rejected`
      );
    }
  });

  it('rejects record.environment with custom prototype or dangerous keys', () => {
    const now = new Date();
    class Env {}
    const record = validRecord('CLI-01', now, { environment: new Env() });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now, expectedVersions: { node: '22' } });
    assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL');

    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const env = { node: '22' };
      Object.defineProperty(env, key, {
        value: 'v1', enumerable: true, configurable: true, writable: true
      });
      const dangerous = validRecord('CLI-01', now, { environment: env });
      const res = validateEvidenceManifest(fullManifest(now, { 'CLI-01': dangerous }), { now, expectedVersions: { node: '22' } });
      assert.strictEqual(gateResult(res, 'CLI-01').verdict, 'FAIL', `environment key ${key} must be rejected`);
    }
  });
});

describe('adversarial round 2: array manifest corruption bypass', () => {
  it('rejects array manifest with null entries', () => {
    const now = new Date();
    const records = ALL_IDS.slice(0, 3).map((id) => ({ id, ...validRecord(id, now) }));
    records.push(null);
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
    assert.ok(result.integrityErrors.some((e) => e.gateId === null && e.code.includes('ARRAY')));
  });

  it('rejects array manifest with scalar entries', () => {
    const now = new Date();
    const records = ALL_IDS.slice(0, 3).map((id) => ({ id, ...validRecord(id, now) }));
    records.push('CLI-01');
    records.push(42);
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
  });

  it('rejects array manifest with nested array entries', () => {
    const now = new Date();
    const records = ALL_IDS.slice(0, 3).map((id) => ({ id, ...validRecord(id, now) }));
    records.push(['CLI-01', 'PASS']);
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
  });

  it('rejects array entries missing id field', () => {
    const now = new Date();
    const records = ALL_IDS.slice(0, 3).map((id) => ({ id, ...validRecord(id, now) }));
    records.push({ verdict: 'PASS', evidence: [], timestamp: now.toISOString() });
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
  });

  it('rejects array entries with non-string id', () => {
    const now = new Date();
    const records = ALL_IDS.slice(0, 3).map((id) => ({ id, ...validRecord(id, now) }));
    records.push({ id: 42, ...validRecord('CLI-01', now) });
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
  });

  it('rejects array entries with empty-string id', () => {
    const now = new Date();
    const records = ALL_IDS.slice(0, 3).map((id) => ({ id, ...validRecord(id, now) }));
    records.push({ id: '', ...validRecord('CLI-01', now) });
    records.push({ id: '   ', ...validRecord('CLI-01', now) });
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
  });
});

describe('adversarial round 2: object manifest identity redirection', () => {
  it('rejects object manifest where embedded id differs from key', () => {
    const now = new Date();
    const manifest = {
      'CLI-01': { id: 'EVT-01', ...validRecord('EVT-01', now) }
    };
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
    assert.ok(result.integrityErrors.some((e) => e.gateId === 'CLI-01' && e.code.includes('ID_MISMATCH')));
  });

  it('accepts object manifest where embedded id matches key exactly', () => {
    const now = new Date();
    const manifest = {
      'CLI-01': { id: 'CLI-01', ...validRecord('CLI-01', now) }
    };
    ALL_IDS.slice(1).forEach((id) => { manifest[id] = validRecord(id, now); });
    const result = validateEvidenceManifest(manifest, { now });
    assert.strictEqual(result.verdict, 'PASS');
  });

  it('accepts object manifest with no embedded id (default behavior)', () => {
    const now = new Date();
    const result = validateEvidenceManifest(fullManifest(now), { now });
    assert.strictEqual(result.verdict, 'PASS');
  });
});

describe('adversarial round 2: ISO date calendar validation', () => {
  it('rejects impossible calendar dates that Date normalizes', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const impossible = [
      '2026-02-30T12:00:00.000Z',  // Feb 30
      '2026-13-01T12:00:00.000Z',  // Month 13
      '2026-00-15T12:00:00.000Z',  // Month 0
      '2026-07-32T12:00:00.000Z',  // Day 32
      '2026-07-00T12:00:00.000Z',  // Day 0
    ];
    for (const ts of impossible) {
      const record = validRecord('CLI-01', now, { timestamp: ts });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      const g = gateResult(result, 'CLI-01');
      assert.strictEqual(g.verdict, 'FAIL', `${ts} must be rejected as invalid calendar date`);
      assertStructuredErrors(g.errors);
    }
  });

  it('accepts canonical UTC ISO with no fraction or 1-3 fractional digits', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const valid = [
      '2026-07-15T12:00:00Z',
      '2026-07-15T12:00:00.0Z',
      '2026-07-15T12:00:00.12Z',
      '2026-07-15T12:00:00.123Z',
      '2026-02-28T23:59:59.999Z',  // Valid leap boundary
      '2024-02-29T12:00:00.000Z',  // Leap year
    ];
    for (const ts of valid) {
      const record = validRecord('CLI-01', now, { timestamp: ts });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now, maxAgeMs: Infinity });
      const g = gateResult(result, 'CLI-01');
      assert.strictEqual(g.verdict, 'PASS', `${ts} must be accepted, got ${g.verdict} with errors: ${g.errors ? JSON.stringify(g.errors) : 'none'}`);
    }
  });

  it('rejects ISO timestamps with 4+ fractional digits or non-UTC timezone', () => {
    const now = new Date('2026-07-15T12:00:00.000Z');
    const invalid = [
      '2026-07-15T12:00:00.1234Z',  // 4 digits
      '2026-07-15T12:00:00+00:00',  // Timezone offset
      '2026-07-15T12:00:00-05:00',
    ];
    for (const ts of invalid) {
      const record = validRecord('CLI-01', now, { timestamp: ts });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `${ts} must be rejected`);
    }
  });
});

describe('adversarial round 2: evidence source case/whitespace bypass', () => {
  it('rejects case variants of fake and test_double on non-deterministic gates', () => {
    const now = new Date();
    const variants = ['Fake', 'FAKE', 'FaKe', 'Test_Double', 'TEST_DOUBLE', 'test_DOUBLE'];
    for (const source of variants) {
      const record = validRecord('CAP-GOAL-01', now);
      record.evidence[0] = { ...record.evidence[0], source };
      const result = validateEvidenceManifest(fullManifest(now, { 'CAP-GOAL-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CAP-GOAL-01').verdict, 'FAIL', `source ${source} must be rejected`);
    }
  });

  it('rejects whitespace-padded forbidden sources', () => {
    const now = new Date();
    const variants = [' fake', 'fake ', ' fake ', '  test_double  ', '\tfake\n'];
    for (const source of variants) {
      const record = validRecord('CAP-GOAL-01', now);
      record.evidence[0] = { ...record.evidence[0], source };
      const result = validateEvidenceManifest(fullManifest(now, { 'CAP-GOAL-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CAP-GOAL-01').verdict, 'FAIL', `source "${source}" must be rejected`);
    }
  });
});

describe('adversarial round 3: new requirements', () => {
  it('rejects non-plain environment even when expectedVersions is empty', () => {
    const now = new Date();
    class Env {}
    const record = validRecord('CLI-01', now, { environment: new Env() });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now, expectedVersions: {} });
    assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL');
    assertStructuredErrors(gateResult(result, 'CLI-01').errors);
  });

  it('rejects environment with dangerous keys even when expectedVersions is empty', () => {
    const now = new Date();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const record = validRecord('CLI-01', now, { environment: { node: '22', [key]: 'bad' } });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now, expectedVersions: {} });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `environment key ${key} must be rejected even with empty expectedVersions`);
      assertStructuredErrors(gateResult(result, 'CLI-01').errors);
    }
  });

  it('rejects records with own __proto__, constructor, or prototype keys', () => {
    const now = new Date();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const record = validRecord('CLI-01', now);
      Object.defineProperty(record, key, {
        value: 'malicious', enumerable: true, configurable: true, writable: true
      });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `record with own ${key} key must be rejected`);
      assertStructuredErrors(gateResult(result, 'CLI-01').errors);
    }
  });

  it('rejects evidence items with own __proto__, constructor, or prototype keys', () => {
    const now = new Date();
    for (const key of ['__proto__', 'constructor', 'prototype']) {
      const record = validRecord('CLI-01', now);
      Object.defineProperty(record.evidence[0], key, {
        value: 'malicious', enumerable: true, configurable: true, writable: true
      });
      const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now });
      assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL', `evidence item with own ${key} key must be rejected`);
      assertStructuredErrors(gateResult(result, 'CLI-01').errors);
    }
  });

  it('uses Object.hasOwn for environment version key lookup', () => {
    const now = new Date();
    const expectedVersions = { node: '22', toString: 'v1' };

    // Environment with inherited toString should fail version check
    const env = Object.create({ node: '22' });
    env.toString = 'v1';
    const record = validRecord('CLI-01', now, { environment: env });
    const result = validateEvidenceManifest(fullManifest(now, { 'CLI-01': record }), { now, expectedVersions });

    // Should fail because node is inherited, not own property
    assert.strictEqual(gateResult(result, 'CLI-01').verdict, 'FAIL');
    assertStructuredErrors(gateResult(result, 'CLI-01').errors);
  });

  it('validates environment even when expectedVersions has no keys', () => {
    const now = new Date();

    // Non-plain environment
    class Env {}
    const badRecord = validRecord('CLI-01', now, { environment: new Env() });
    const badResult = validateEvidenceManifest(fullManifest(now, { 'CLI-01': badRecord }), { now, expectedVersions: {} });
    assert.strictEqual(gateResult(badResult, 'CLI-01').verdict, 'FAIL');

    // Valid plain environment
    const goodRecord = validRecord('CLI-01', now, { environment: { node: '22' } });
    const goodResult = validateEvidenceManifest(fullManifest(now, { 'CLI-01': goodRecord }), { now, expectedVersions: {} });
    assert.strictEqual(gateResult(goodResult, 'CLI-01').verdict, 'PASS');
  });

  it('integrity FAIL for non-object manifest values in object mode', () => {
    const now = new Date();
    for (const bad of [null, 'record', 42, ['x'], true]) {
      const manifest = fullManifest(now);
      manifest['CLI-01'] = bad;
      const result = validateEvidenceManifest(manifest, { now });
      assert.strictEqual(result.verdict, 'FAIL', `non-object value ${JSON.stringify(bad)} must be integrity FAIL`);
      assertStructuredErrors(result.integrityErrors);
      assert.ok(result.integrityErrors.some((e) => e.code === 'OBJECT_VALUE_NOT_OBJECT' && e.gateId === 'CLI-01'));
    }
  });

  it('ARRAY_ENTRY_ID_NOT_STRING uses gateId null', () => {
    const now = new Date();
    const records = [{ id: 42, ...validRecord('CLI-01', now) }];
    const result = validateEvidenceManifest(records, { now });
    assert.strictEqual(result.verdict, 'FAIL');
    assertStructuredErrors(result.integrityErrors);
    const err = result.integrityErrors.find((e) => e.code === 'ARRAY_ENTRY_ID_NOT_STRING');
    assert.ok(err, 'ARRAY_ENTRY_ID_NOT_STRING error must be present');
    assert.strictEqual(err.gateId, null, 'ARRAY_ENTRY_ID_NOT_STRING must have gateId null');
  });
});
