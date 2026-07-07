import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize,
  computeIntegrityHash,
  computeWeightDecisionHash,
  type ScoringIntegrityInput,
  type WeightDecisionInput,
} from '../src/integrity';

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
  assert.notEqual(
    base,
    computeIntegrityHash({
      ...baseInput,
      timestamp: '2026-07-06T00:00:01.000Z',
    }),
  );
});

const baseDecision: WeightDecisionInput = {
  competition_id: 'comp-1',
  leader_hotkey: '5Fleader',
  leader_score: 0.91,
  winner_uid: 42,
  emissions_percent: 0.2,
  targets: [
    { uid: 42, weight: 0.2 },
    { uid: 0, weight: 0.8 },
  ],
};

test('computeWeightDecisionHash is stable and sha256-prefixed', () => {
  const h1 = computeWeightDecisionHash(baseDecision);
  const h2 = computeWeightDecisionHash({
    ...baseDecision,
    targets: [...baseDecision.targets],
  });
  assert.equal(h1, h2);
  assert.match(h1, /^sha256:[0-9a-f]{64}$/);
});

test('computeWeightDecisionHash changes when any field changes', () => {
  const base = computeWeightDecisionHash(baseDecision);
  assert.notEqual(base, computeWeightDecisionHash({ ...baseDecision, winner_uid: 43 }));
  assert.notEqual(base, computeWeightDecisionHash({ ...baseDecision, emissions_percent: 0.3 }));
  assert.notEqual(base, computeWeightDecisionHash({ ...baseDecision, leader_score: 0.92 }));
  assert.notEqual(
    base,
    computeWeightDecisionHash({
      ...baseDecision,
      targets: [
        { uid: 42, weight: 0.3 },
        { uid: 0, weight: 0.7 },
      ],
    }),
  );
});

test('computeWeightDecisionHash handles the burn-only decision', () => {
  const burn = computeWeightDecisionHash({
    competition_id: null,
    leader_hotkey: null,
    leader_score: null,
    winner_uid: null,
    emissions_percent: 0.2,
    targets: [{ uid: 0, weight: 1 }],
  });
  assert.match(burn, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(burn, computeWeightDecisionHash(baseDecision));
});
