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

import { decodeAddress, encodeAddress } from '@polkadot/util-crypto';

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

/** Default share of the winner's payout kept as the platform fee. */
export const DEFAULT_PLATFORM_FEE_PERCENT = 0.2;

/** The platform fee as configured: a hotkey, resolved to a UID every cycle. */
export interface PlatformFeeConfig {
  /** SS58 (prefix 42) hotkey that receives the fee. */
  readonly hotkey: string;
  /** Fraction of the miner's share, in (0, 1]. */
  readonly percent: number;
}

/** The platform fee as applied to one weight vector, after UID resolution. */
export interface PlatformFee {
  /** UID that receives the fee this cycle. */
  readonly uid: number;
  /** Fraction of the miner's share, in (0, 1]. */
  readonly percent: number;
}

const normalizeSs58 = (address: string): string | null => {
  try {
    return encodeAddress(decodeAddress(address), 42);
  } catch {
    return null;
  }
};

/**
 * Resolve the platform fee from the environment.
 *
 * - `TAKE_PLATFORM_FEE=true` turns it on (default off).
 * - `PLATFORM_FEE_PERCENT` is the fraction of the winning miner's share that
 *   goes to the platform (default 0.2 = 20%), clamped to [0, 1].
 * - `PLATFORM_FEE_HOTKEY` is the hotkey that receives it. It is resolved to a
 *   UID from the metagraph on every cycle, like the winner, because UIDs are
 *   recycled when a neuron deregisters. Without a hotkey that decodes, the fee
 *   is skipped rather than guessed: sending weight to the wrong neuron is
 *   worse than not taking the fee.
 *
 * Returns null when the fee is off or incomplete.
 */
export const getPlatformFee = (env: NodeJS.ProcessEnv = process.env): PlatformFeeConfig | null => {
  if (env.TAKE_PLATFORM_FEE?.trim().toLowerCase() !== 'true') {
    return null;
  }

  const rawHotkey = env.PLATFORM_FEE_HOTKEY?.trim() ?? '';
  const hotkey = rawHotkey === '' ? null : normalizeSs58(rawHotkey);
  if (hotkey === null) {
    return null;
  }

  const rawPercent = env.PLATFORM_FEE_PERCENT?.trim() ?? '';
  const parsed = rawPercent === '' ? DEFAULT_PLATFORM_FEE_PERCENT : Number(rawPercent);
  const percent = Number.isFinite(parsed)
    ? Math.min(1, Math.max(0, parsed))
    : DEFAULT_PLATFORM_FEE_PERCENT;
  if (percent <= 0) {
    return null;
  }

  return { hotkey, percent };
};

/**
 * Build the weight vector for a given winner.
 *
 * - Winner present (and not the burn UID): `[{winnerUid: p}, {BURN_UID: 1 - p}]`.
 * - With a platform fee `f` on UID `x`: the winner's `p` splits into
 *   `p * (1 - f)` for the winner and `p * f` for `x`. The burn share is
 *   untouched. The fee only applies when there is a winner to take it from.
 * - No winner (null), or the winner resolves to the burn UID itself: burn 100%
 *   (`[{BURN_UID: 1}]`).
 *
 * The returned weights always sum to 1.0 by construction, so downstream u16
 * conversion (SCALE_FACTOR=10000) needs no re-normalization.
 */
export const computeBurnWeights = (
  winnerUid: number | null | undefined,
  emissionsPercent: number = getEmissionsPercent(),
  platformFee: PlatformFee | null = null,
): BittensorWeightTarget[] => {
  const p = Math.min(1, Math.max(0, emissionsPercent));

  // No eligible winner, the winner IS the burn UID, or a zero emissions share:
  // burn everything (don't emit a pointless zero-weight winner entry).
  if (winnerUid === null || winnerUid === undefined || winnerUid === BURN_UID || p <= 0) {
    return [{ uid: BURN_UID, weight: 1 }];
  }

  // The fee needs a distinct, non-burn UID to land on; otherwise it is a no-op.
  const feeApplies =
    platformFee !== null &&
    platformFee.percent > 0 &&
    platformFee.uid !== BURN_UID &&
    platformFee.uid !== winnerUid;
  const fee = feeApplies ? Math.min(1, platformFee.percent) : 0;
  const platformWeight = p * fee;
  // Subtract from the winner's share so the vector still sums to exactly p.
  const winnerWeight = p - platformWeight;

  const targets: BittensorWeightTarget[] = [];
  if (winnerWeight > 0) {
    targets.push({ uid: winnerUid, weight: winnerWeight });
  }
  if (platformWeight > 0 && platformFee) {
    targets.push({ uid: platformFee.uid, weight: platformWeight });
  }
  // Degenerate but valid: 100% emissions leaves nothing to burn.
  if (p < 1) {
    targets.push({ uid: BURN_UID, weight: 1 - p });
  }
  return targets;
};
