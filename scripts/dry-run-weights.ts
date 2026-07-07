/**
 * Dry-run the local weight DECISION without touching the network or the chain.
 *
 * Feeds a mock (or file-provided) ActiveCompetition through the exact pure
 * functions the validator uses — selectCurrentLeader + computeBurnWeights — and
 * prints the winner and the weight targets. This lets you eyeball the decision
 * logic (winner selection, EMISSIONS_PERCENT split, burn-to-UID-0 fallbacks)
 * end-to-end without a coordinator or a validator key.
 *
 * Usage:
 *   npx ts-node scripts/dry-run-weights.ts                 # built-in sample
 *   npx ts-node scripts/dry-run-weights.ts ./comp.json     # your own ActiveCompetition JSON
 *   EMISSIONS_PERCENT=0.3 npx ts-node scripts/dry-run-weights.ts
 *
 * Note: this does NOT resolve real metagraph UIDs (that needs a chain
 * connection). It maps the winning hotkey to a placeholder UID so you can see
 * the shape of the weight vector. For a full on-chain dry run, run the validator
 * with BITTENSOR_WEIGHTS_DISABLED=true.
 */

import * as fs from 'fs';
import { selectCurrentLeader, type ActiveCompetition } from '../src/leaderboard';
import { computeBurnWeights, getEmissionsPercent, BURN_UID } from '../src/weight-policy';

const SAMPLE: ActiveCompetition = {
  competition_id: 'comp_sample',
  window_start: '2026-07-01T00:00:00.000Z',
  window_end: '2026-08-01T00:00:00.000Z',
  entries: [
    {
      miner_hotkey: '5AliceHotkey',
      best_score: 0.71,
      submitted_at: '2026-07-02T09:00:00.000Z',
    },
    {
      miner_hotkey: '5BobHotkey',
      best_score: 0.88,
      submitted_at: '2026-07-03T14:00:00.000Z',
    },
    {
      miner_hotkey: '5CarolHotkey',
      best_score: 0.88,
      submitted_at: '2026-07-03T10:00:00.000Z',
    },
  ],
};

const main = (): void => {
  const path = process.argv[2];
  let comp: ActiveCompetition | null = SAMPLE;

  if (path) {
    const raw = fs.readFileSync(path, 'utf8').trim();
    comp = raw === '' ? null : (JSON.parse(raw) as ActiveCompetition);
  }

  const emissionsPercent = getEmissionsPercent();
  const leader = selectCurrentLeader(comp);

  // Placeholder UID for the winning hotkey (real resolution needs the chain).
  const PLACEHOLDER_WINNER_UID = 42;
  const winnerUid = leader ? PLACEHOLDER_WINNER_UID : null;
  const targets = computeBurnWeights(winnerUid, emissionsPercent);

  console.log(
    JSON.stringify(
      {
        competition_id: comp?.competition_id ?? null,
        emissionsPercent,
        burnUid: BURN_UID,
        leader: leader
          ? {
              miner_hotkey: leader.miner_hotkey,
              best_score: leader.best_score,
              submitted_at: leader.submitted_at,
            }
          : null,
        note: leader
          ? `winner UID is a placeholder (${PLACEHOLDER_WINNER_UID}); real UID is resolved from the metagraph at runtime`
          : 'no eligible winner — burning 100% to UID 0',
        targets,
        weightSum: targets.reduce((s, t) => s + t.weight, 0),
      },
      null,
      2,
    ),
  );
};

main();
