/**
 * Competition leaderboard types and deterministic winner selection.
 *
 * The validator pulls the active competition + its leaderboard from the
 * coordinator as read-only DATA (see ApiClient.fetchActiveCompetition), then
 * decides the winner itself. Winner selection is pure and deterministic so any
 * validator running this code picks the same #1 from identical data.
 */

/** One miner's standing in a competition. */
export interface LeaderboardEntry {
  /** Miner hotkey as reported by the coordinator (hex or SS58; normalized before UID lookup). */
  miner_hotkey: string;
  /** The miner's best score in this competition. */
  best_score: number;
  /** ISO timestamp of the submission that produced best_score. */
  submitted_at: string;
}

/** The currently active competition and its leaderboard. */
export interface ActiveCompetition {
  competition_id: string;
  window_start: string;
  window_end: string;
  entries: LeaderboardEntry[];
  /**
   * The coordinator's resolved leader under the published leadership-margin
   * rule (leadership only changes hands on a clear score margin, so all
   * validators and the public leaderboard agree on one leader during
   * statistical ties). Optional: absent on older coordinator versions.
   */
  current_leader?: { miner_hotkey: string; best_score: number } | null;
  /** Margin used by the rule above; needed to verify current_leader. */
  leadership_margin?: number;
}

/**
 * Deterministically select the current #1 miner.
 *
 * Only entries with a positive `best_score` are eligible. Ranking: highest
 * `best_score` wins. Ties are broken by earliest `submitted_at` (first to
 * reach the score leads), then by `miner_hotkey` lexicographic order as a
 * final deterministic fallback.
 *
 * Returns null when there is no competition or no positively-scored entries —
 * the caller burns 100% in that case.
 */
export const selectCurrentLeader = (
  comp: ActiveCompetition | null | undefined,
): LeaderboardEntry | null => {
  if (!comp || !Array.isArray(comp.entries) || comp.entries.length === 0) {
    return null;
  }

  const eligible = comp.entries.filter(
    (e) =>
      e &&
      typeof e.best_score === 'number' &&
      Number.isFinite(e.best_score) &&
      e.best_score > 0,
  );
  if (eligible.length === 0) {
    return null;
  }

  return eligible.reduce((best, cur) => {
    if (cur.best_score !== best.best_score) {
      return cur.best_score > best.best_score ? cur : best;
    }
    // Tie on score: earlier submission leads.
    const curTime = Date.parse(cur.submitted_at);
    const bestTime = Date.parse(best.submitted_at);
    if (Number.isFinite(curTime) && Number.isFinite(bestTime) && curTime !== bestTime) {
      return curTime < bestTime ? cur : best;
    }
    // Final deterministic tie-break: lexicographic hotkey.
    return cur.miner_hotkey < best.miner_hotkey ? cur : best;
  });
};

/**
 * Resolve the leader to weight, preferring the coordinator's resolved
 * `current_leader` — but only after verifying it against the entries in the
 * same response ("trust but verify"):
 *
 *   1. `current_leader` must match an entry in `entries`, and
 *   2. no entry may exceed it by `leadership_margin` or more.
 *
 * Within those bounds the field can only designate a leader among entries
 * that are statistically tied — it can never crown an entry that is clearly
 * behind, nor suppress one that is clearly ahead. If verification fails or
 * the fields are absent, fall back to the local deterministic election
 * (`selectCurrentLeader`), preserving pre-existing behavior.
 *
 * Why prefer the coordinator's resolution at all: the margin rule is
 * hysteretic (the leader depends on the order scores arrived, not just the
 * current snapshot), so independent stateless elections can disagree during
 * statistical ties. Following one verified resolution keeps every validator
 * weighting the same miner.
 */
export const resolveLeader = (
  comp: ActiveCompetition | null | undefined,
): LeaderboardEntry | null => {
  const local = selectCurrentLeader(comp);
  if (!comp || !comp.current_leader) {
    return local;
  }
  const margin = comp.leadership_margin;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin < 0) {
    return local;
  }
  const entries = Array.isArray(comp.entries) ? comp.entries : [];
  const announced = entries.find(
    (e) =>
      e &&
      e.miner_hotkey === comp.current_leader?.miner_hotkey &&
      typeof e.best_score === 'number' &&
      Number.isFinite(e.best_score),
  );
  if (!announced) {
    return local;
  }
  // Epsilon absorbs float noise at exactly the margin boundary.
  const clearlyAhead = entries.some(
    (e) =>
      e &&
      typeof e.best_score === 'number' &&
      Number.isFinite(e.best_score) &&
      e.best_score - announced.best_score >= margin - 1e-9,
  );
  if (clearlyAhead) {
    return local;
  }
  return announced;
};
