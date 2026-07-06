import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeBurnWeights,
  getEmissionsPercent,
  BURN_UID,
  DEFAULT_EMISSIONS_PERCENT,
} from '../src/weight-policy';

const sum = (targets: { weight: number }[]) => targets.reduce((s, t) => s + t.weight, 0);

test('winner present: 20% to winner, 80% burn, sums to 1', () => {
  const targets = computeBurnWeights(7, 0.2);
  assert.deepEqual(targets, [
    { uid: 7, weight: 0.2 },
    { uid: BURN_UID, weight: 0.8 },
  ]);
  assert.equal(sum(targets), 1);
});

test('no winner (null) burns 100% to UID 0', () => {
  assert.deepEqual(computeBurnWeights(null, 0.2), [{ uid: BURN_UID, weight: 1 }]);
});

test('winner === burn UID burns 100%', () => {
  assert.deepEqual(computeBurnWeights(0, 0.2), [{ uid: BURN_UID, weight: 1 }]);
});

test('undefined winner burns 100%', () => {
  assert.deepEqual(computeBurnWeights(undefined, 0.2), [{ uid: BURN_UID, weight: 1 }]);
});

test('emissionsPercent >= 1 gives winner everything', () => {
  assert.deepEqual(computeBurnWeights(3, 1), [{ uid: 3, weight: 1 }]);
});

test('emissionsPercent is clamped to [0,1]', () => {
  assert.deepEqual(computeBurnWeights(3, -5), [{ uid: BURN_UID, weight: 1 }]);
  assert.deepEqual(computeBurnWeights(3, 5), [{ uid: 3, weight: 1 }]);
});

test('getEmissionsPercent default and overrides', () => {
  const original = process.env.EMISSIONS_PERCENT;
  try {
    delete process.env.EMISSIONS_PERCENT;
    assert.equal(getEmissionsPercent(), DEFAULT_EMISSIONS_PERCENT);

    process.env.EMISSIONS_PERCENT = '0.35';
    assert.equal(getEmissionsPercent(), 0.35);

    process.env.EMISSIONS_PERCENT = '2';
    assert.equal(getEmissionsPercent(), 1);

    process.env.EMISSIONS_PERCENT = 'not-a-number';
    assert.equal(getEmissionsPercent(), DEFAULT_EMISSIONS_PERCENT);
  } finally {
    if (original === undefined) delete process.env.EMISSIONS_PERCENT;
    else process.env.EMISSIONS_PERCENT = original;
  }
});
