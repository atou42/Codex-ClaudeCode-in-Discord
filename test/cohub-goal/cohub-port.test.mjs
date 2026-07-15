import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COHUB_PORT_METHODS,
  CohubPortContractError,
  CohubPortNotImplementedError,
  assertCohubPort,
  createUnimplementedCohubPort,
} from '../../src/cohub-claude-goal/cohub-port.js';

function fullValidImpl() {
  const calls = [];
  const impl = {};
  for (const name of COHUB_PORT_METHODS) {
    impl[name] = (...args) => {
      calls.push({ name, args });
      return { name, args };
    };
  }
  return { impl, calls };
}

test('COHUB_PORT_METHODS lists exactly the stable contract surface', () => {
  assert.deepEqual(
    [...COHUB_PORT_METHODS].sort(),
    [
      'close',
      'connect',
      'findTurnByClientMessageId',
      'getSessionIndex',
      'getTrustedExecutionContext',
      'getTurn',
      'onEvent',
      'readRunFile',
      'sendPrompt',
      'subscribe',
      'waitForSubscribeAck',
    ].sort(),
  );
  assert.equal(Object.isFrozen(COHUB_PORT_METHODS), true);
});

test('assertCohubPort throws CohubPortContractError listing every missing method', () => {
  try {
    assertCohubPort({});
    assert.fail('expected assertCohubPort to throw');
  } catch (err) {
    assert.ok(err instanceof CohubPortContractError);
    for (const name of COHUB_PORT_METHODS) {
      assert.ok(err.missing.includes(name), `expected missing list to include ${name}`);
    }
    assert.match(err.message, /connect/);
  }
});

test('assertCohubPort throws when a contract key exists but is not a function', () => {
  const { impl } = fullValidImpl();
  impl.connect = 'not-a-function';
  try {
    assertCohubPort(impl);
    assert.fail('expected assertCohubPort to throw');
  } catch (err) {
    assert.ok(err instanceof CohubPortContractError);
    assert.deepEqual(err.missing, ['connect']);
  }
});

test('assertCohubPort throws listing only the methods that are actually missing', () => {
  const { impl } = fullValidImpl();
  delete impl.subscribe;
  delete impl.close;
  try {
    assertCohubPort(impl);
    assert.fail('expected assertCohubPort to throw');
  } catch (err) {
    assert.ok(err instanceof CohubPortContractError);
    assert.deepEqual([...err.missing].sort(), ['close', 'subscribe']);
  }
});

test('assertCohubPort accepts a fully valid implementation and exposes exactly the contract surface', () => {
  const { impl } = fullValidImpl();
  impl.somePrivateHelper = () => 'leaked';
  const port = assertCohubPort(impl);

  assert.deepEqual([...Object.keys(port)].sort(), [...COHUB_PORT_METHODS].sort());
  assert.equal(port.somePrivateHelper, undefined);
});

test('assertCohubPort wrapped port forwards arguments and return values to the underlying implementation', () => {
  const { impl, calls } = fullValidImpl();
  const port = assertCohubPort(impl);

  const result = port.getTurn('space-1', 'turn-1');
  assert.deepEqual(result, { name: 'getTurn', args: ['space-1', 'turn-1'] });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { name: 'getTurn', args: ['space-1', 'turn-1'] });
});

test('assertCohubPort wrapped port forwards thrown errors from the underlying implementation unchanged', () => {
  const { impl } = fullValidImpl();
  const boom = new Error('boom');
  impl.sendPrompt = () => {
    throw boom;
  };
  const port = assertCohubPort(impl);

  assert.throws(() => port.sendPrompt({}), (err) => err === boom);
});

test('assertCohubPort wrapped port forwards rejected promises from async implementations unchanged', async () => {
  const { impl } = fullValidImpl();
  const boom = new Error('async boom');
  impl.connect = async () => {
    throw boom;
  };
  const port = assertCohubPort(impl);

  await assert.rejects(() => port.connect(), (err) => err === boom);
});

test('createUnimplementedCohubPort satisfies the contract shape', () => {
  const port = createUnimplementedCohubPort();
  assertCohubPort(port);
  assert.deepEqual([...Object.keys(port)].sort(), [...COHUB_PORT_METHODS].sort());
});

test('createUnimplementedCohubPort throws CohubPortNotImplementedError for every method instead of faking success', () => {
  const port = createUnimplementedCohubPort();
  for (const name of COHUB_PORT_METHODS) {
    assert.throws(
      () => port[name]('any', 'args', 'at', 'all'),
      (err) => {
        assert.ok(err instanceof CohubPortNotImplementedError, `${name} should throw CohubPortNotImplementedError`);
        assert.equal(err.method, name);
        return true;
      },
    );
  }
});

test('createUnimplementedCohubPort never returns a resolved value for any method call', () => {
  const port = createUnimplementedCohubPort();
  for (const name of COHUB_PORT_METHODS) {
    let threw = false;
    let returned;
    try {
      returned = port[name]();
    } catch {
      threw = true;
    }
    assert.equal(threw, true, `${name} must throw synchronously, not resolve to a fake value`);
    assert.equal(returned, undefined);
  }
});
