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

import { getPlatformFee } from '../src/weight-policy';

test('platform fee splits the winner share, burn untouched, sums to 1', () => {
  const targets = computeBurnWeights(7, 0.2, { uid: 3, percent: 0.2 });
  const byUid = new Map(targets.map((t) => [t.uid, t.weight]));
  assert.ok(Math.abs((byUid.get(7) ?? 0) - 0.16) < 1e-12);
  assert.ok(Math.abs((byUid.get(3) ?? 0) - 0.04) < 1e-12);
  assert.ok(Math.abs((byUid.get(BURN_UID) ?? 0) - 0.8) < 1e-12);
  assert.ok(Math.abs(sum(targets) - 1) < 1e-12);
});

test('platform fee does nothing with no winner', () => {
  assert.deepEqual(computeBurnWeights(null, 0.2, { uid: 3, percent: 0.2 }), [
    { uid: BURN_UID, weight: 1 },
  ]);
});

test('platform fee on the winner UID or burn UID is a no-op', () => {
  assert.deepEqual(
    computeBurnWeights(7, 0.2, { uid: 7, percent: 0.2 }),
    computeBurnWeights(7, 0.2),
  );
  assert.deepEqual(
    computeBurnWeights(7, 0.2, { uid: BURN_UID, percent: 0.2 }),
    computeBurnWeights(7, 0.2),
  );
});

test('100% platform fee leaves the winner nothing', () => {
  const targets = computeBurnWeights(7, 0.2, { uid: 3, percent: 1 });
  assert.equal(
    targets.find((t) => t.uid === 7),
    undefined,
  );
  assert.ok(Math.abs(sum(targets) - 1) < 1e-12);
});

// Well-known dev address (//Alice), prefix 42.
const FEE_HOTKEY = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';
// Same key, generic prefix 0: must normalize to the prefix-42 form above.
const FEE_HOTKEY_PREFIX_0 = '15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5';

test('getPlatformFee: off by default, needs a hotkey, defaults to 20%', () => {
  assert.equal(getPlatformFee({}), null);
  assert.equal(getPlatformFee({ TAKE_PLATFORM_FEE: 'true' }), null);
  assert.equal(
    getPlatformFee({ TAKE_PLATFORM_FEE: 'false', PLATFORM_FEE_HOTKEY: FEE_HOTKEY }),
    null,
  );
  assert.deepEqual(getPlatformFee({ TAKE_PLATFORM_FEE: 'true', PLATFORM_FEE_HOTKEY: FEE_HOTKEY }), {
    hotkey: FEE_HOTKEY,
    percent: 0.2,
  });
  assert.deepEqual(
    getPlatformFee({
      TAKE_PLATFORM_FEE: 'true',
      PLATFORM_FEE_HOTKEY: FEE_HOTKEY,
      PLATFORM_FEE_PERCENT: '0.1',
    }),
    { hotkey: FEE_HOTKEY, percent: 0.1 },
  );
  assert.equal(
    getPlatformFee({
      TAKE_PLATFORM_FEE: 'true',
      PLATFORM_FEE_HOTKEY: FEE_HOTKEY,
      PLATFORM_FEE_PERCENT: '0',
    }),
    null,
  );
});

test('getPlatformFee: normalizes the hotkey to prefix 42 and rejects malformed ones', () => {
  assert.deepEqual(
    getPlatformFee({ TAKE_PLATFORM_FEE: 'true', PLATFORM_FEE_HOTKEY: FEE_HOTKEY_PREFIX_0 }),
    { hotkey: FEE_HOTKEY, percent: 0.2 },
  );
  // A UID is not a hotkey.
  assert.equal(getPlatformFee({ TAKE_PLATFORM_FEE: 'true', PLATFORM_FEE_HOTKEY: '3' }), null);
  assert.equal(getPlatformFee({ TAKE_PLATFORM_FEE: 'true', PLATFORM_FEE_HOTKEY: 'x' }), null);
  // Wrong checksum.
  assert.equal(
    getPlatformFee({
      TAKE_PLATFORM_FEE: 'true',
      PLATFORM_FEE_HOTKEY: FEE_HOTKEY.slice(0, -1) + (FEE_HOTKEY.endsWith('Y') ? 'X' : 'Y'),
    }),
    null,
  );
});
