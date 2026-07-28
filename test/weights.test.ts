import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { classifySubmitError, resolveWsEndpoints, withDeadline } from '../src/weights';

const DEFAULT_ENDPOINT = 'wss://entrypoint-finney.opentensor.ai:443';

const savedEnv = process.env.BITTENSOR_WS_ENDPOINTS;
beforeEach(() => {
  delete process.env.BITTENSOR_WS_ENDPOINTS;
});
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.BITTENSOR_WS_ENDPOINTS;
  } else {
    process.env.BITTENSOR_WS_ENDPOINTS = savedEnv;
  }
});

test('classifySubmitError: chain rate-limit rejection is rate-limited', () => {
  const err = new Error('1010: Invalid Transaction: Custom error: 6');
  assert.equal(classifySubmitError(err), 'rate-limited');
});

test('classifySubmitError: txpool ban is temporarily-banned', () => {
  const err = new Error('1012: Transaction is temporarily banned');
  assert.equal(classifySubmitError(err), 'temporarily-banned');
});

test('classifySubmitError: anything else is other', () => {
  assert.equal(classifySubmitError(new Error('connection reset')), 'other');
  assert.equal(classifySubmitError('not an Error instance'), 'other');
});

test('resolveWsEndpoints: default when neither env nor override is set', () => {
  assert.deepEqual(resolveWsEndpoints(), [DEFAULT_ENDPOINT]);
});

test('resolveWsEndpoints: parses and trims the env list', () => {
  process.env.BITTENSOR_WS_ENDPOINTS = ' wss://a:443 , wss://b:443 ,, ';
  assert.deepEqual(resolveWsEndpoints(), ['wss://a:443', 'wss://b:443']);
});

test('resolveWsEndpoints: explicit override beats the env list', () => {
  process.env.BITTENSOR_WS_ENDPOINTS = 'wss://env:443';
  assert.deepEqual(resolveWsEndpoints('wss://one:443,wss://two:443'), [
    'wss://one:443',
    'wss://two:443',
  ]);
});

test('resolveWsEndpoints: blank env falls back to the default', () => {
  process.env.BITTENSOR_WS_ENDPOINTS = '  ,  ';
  assert.deepEqual(resolveWsEndpoints(), [DEFAULT_ENDPOINT]);
});

test('withDeadline: passes through a fast resolution', async () => {
  assert.equal(await withDeadline(Promise.resolve('ok'), 1_000, 'fast resolve'), 'ok');
});

test('withDeadline: passes through a fast rejection', async () => {
  await assert.rejects(
    withDeadline(Promise.reject(new Error('boom')), 1_000, 'fast reject'),
    /boom/,
  );
});

test('withDeadline: rejects with the label once the deadline passes', async () => {
  const never = new Promise<never>(() => undefined);
  await assert.rejects(withDeadline(never, 20, 'stuck call'), /timed out after 20ms: stuck call/);
});

test('withDeadline: a rejection arriving after the deadline is swallowed', async () => {
  let rejectLate: ((error: Error) => void) | undefined;
  const late = new Promise<never>((_, reject) => {
    rejectLate = reject;
  });
  await assert.rejects(withDeadline(late, 10, 'late reject'), /timed out/);
  // If this rejection were unhandled it would crash the test process.
  rejectLate?.(new Error('late failure'));
  await new Promise((resolve) => setTimeout(resolve, 20));
});
