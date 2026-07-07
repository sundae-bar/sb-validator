import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, computeIntegrityHash, type ScoringIntegrityInput } from '../src/integrity';

test('canonicalize is key-order independent', () => {
  assert.equal(
    canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } }),
    canonicalize({ a: 2, c: { y: 2, z: 1 }, b: 1 }),
  );
});

test('canonicalize preserves array order', () => {
  assert.notEqual(canonicalize([1, 2, 3]), canonicalize([3, 2, 1]));
});

test('canonicalize rejects undefined and non-finite numbers', () => {
  assert.throws(() => canonicalize({ a: undefined }));
  assert.throws(() => canonicalize({ a: NaN }));
  assert.throws(() => canonicalize({ a: Infinity }));
});

const baseInput: ScoringIntegrityInput = {
  taskId: 'task-1',
  competition_id: 'comp-1',
  miner_hotkey: '5Fabc',
  validator_hotkey: '5Gxyz',
  score: 0.87,
  verdict: 'passed',
  timestamp: '2026-07-06T00:00:00.000Z',
};

test('computeIntegrityHash is stable and sha256-prefixed', () => {
  const h1 = computeIntegrityHash(baseInput);
  const h2 = computeIntegrityHash({ ...baseInput });
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});

test('computeIntegrityHash changes when any field changes', () => {
  const base = computeIntegrityHash(baseInput);
  assert.notEqual(base, computeIntegrityHash({ ...baseInput, score: 0.88 }));
  assert.notEqual(base, computeIntegrityHash({ ...baseInput, verdict: 'failed' }));
  assert.notEqual(base, computeIntegrityHash({ ...baseInput, miner_hotkey: '5Fother' }));
  assert.notEqual(base, computeIntegrityHash({ ...baseInput, timestamp: '2026-07-06T00:00:01.000Z' }));
});
