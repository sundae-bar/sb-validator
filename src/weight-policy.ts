/**
 * Deterministic weight policy for SN121.
 *
 * The validator decides weights locally (no central "which weights?" call):
 * the single miner currently ranked #1 by score in the active competition
 * receives EMISSIONS_PERCENT of the weight; everything else is burned by
 * assigning it to UID 0. Over a competition's lifetime, whoever holds #1
 * longest collects the most emissions — "time at top takes all" emerges from
 * paying the current leader on every cycle.
 *
 * This module is pure and framework-free so the formula can be unit-tested and
 * replayed by anyone (miners, auditors) to reproduce identical weights.
 */

import type { BittensorWeightTarget } from './weights';

/** Burn address. Weight assigned here is not emitted to any miner. */
export const BURN_UID = 0;

/** Default share of weight paid to the current #1 miner (rest is burned). */
export const DEFAULT_EMISSIONS_PERCENT = 0.2;

/**
 * Resolve the emissions percentage from the environment, clamped to [0, 1].
 *
 * `EMISSIONS_PERCENT=0.2` means 20% of weight goes to the current #1 miner and
 * 80% is burned. Invalid / unset values fall back to the default.
 */
export const getEmissionsPercent = (): number => {
  const raw = process.env.EMISSIONS_PERCENT;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_EMISSIONS_PERCENT;
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_EMISSIONS_PERCENT;
  }

  return Math.min(1, Math.max(0, parsed));
};

/**
 * Build the weight vector for a given winner.
 *
 * - Winner present (and not the burn UID): `[{winnerUid: p}, {BURN_UID: 1 - p}]`.
 * - No winner (null), or the winner resolves to the burn UID itself: burn 100%
 *   (`[{BURN_UID: 1}]`).
 *
 * The returned weights always sum to 1.0 by construction, so downstream u16
 * conversion (SCALE_FACTOR=10000) needs no re-normalization.
 */
export const computeBurnWeights = (
  winnerUid: number | null | undefined,
  emissionsPercent: number = getEmissionsPercent(),
): BittensorWeightTarget[] => {
  const p = Math.min(1, Math.max(0, emissionsPercent));

  // No eligible winner, the winner IS the burn UID, or a zero emissions share:
  // burn everything (don't emit a pointless zero-weight winner entry).
  if (winnerUid === null || winnerUid === undefined || winnerUid === BURN_UID || p <= 0) {
    return [{ uid: BURN_UID, weight: 1 }];
  }

  // Degenerate but valid: 100% emissions leaves nothing to burn.
  if (p >= 1) {
    return [{ uid: winnerUid, weight: 1 }];
  }

  return [
    { uid: winnerUid, weight: p },
    { uid: BURN_UID, weight: 1 - p },
  ];
};
