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
}

/**
 * Deterministically select the current #1 miner.
 *
 * Ranking: highest `best_score` wins. Ties are broken by earliest
 * `submitted_at` (first to reach the score leads), then by `miner_hotkey`
 * lexicographic order as a final deterministic fallback.
 *
 * Returns null when there is no competition or no scored entries — the caller
 * burns 100% in that case.
 */
export const selectCurrentLeader = (
    comp: ActiveCompetition | null | undefined
): LeaderboardEntry | null => {
    if (!comp || !Array.isArray(comp.entries) || comp.entries.length === 0) {
        return null;
    }

    const eligible = comp.entries.filter(
        (e) => e && typeof e.best_score === 'number' && Number.isFinite(e.best_score)
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
