/**
 * Integrity hashing for scoring results.
 *
 * When the validator pushes a score back to the coordinator, it embeds a
 * content hash over the canonical scoring inputs+output. The web app (and any
 * miner) can recompute the same hash from the same fields to verify that the
 * displayed leaderboard matches what the validator actually scored. The push
 * is also sr25519-signed (signRequest signs the whole payload), so the hash is
 * a portable, signature-independent digest anyone can reproduce.
 */

import { createHash } from 'crypto';

/** The exact fields covered by the integrity hash. Keep this stable — the web
 *  app recomputes the hash from these same fields. */
export interface ScoringIntegrityInput {
    taskId: string;
    competition_id: string;
    /** SS58, normalized. */
    miner_hotkey: string;
    /** SS58, normalized. */
    validator_hotkey: string;
    score: number;
    verdict: 'passed' | 'failed';
    /** ISO timestamp. */
    timestamp: string;
}

/**
 * Serialize a value to canonical JSON: object keys are sorted recursively so
 * key ordering never affects the hash. Arrays keep their order. `undefined`
 * and functions are rejected (they must not silently drop from the digest).
 */
export const canonicalize = (value: unknown): string => {
    const encode = (v: unknown): string => {
        if (v === null) return 'null';

        const t = typeof v;
        if (t === 'number') {
            if (!Number.isFinite(v as number)) {
                throw new Error('canonicalize: non-finite number');
            }
            return JSON.stringify(v);
        }
        if (t === 'string' || t === 'boolean') {
            return JSON.stringify(v);
        }
        if (t === 'undefined' || t === 'function') {
            throw new Error(`canonicalize: unsupported value of type ${t}`);
        }

        if (Array.isArray(v)) {
            return `[${v.map(encode).join(',')}]`;
        }

        if (t === 'object') {
            const obj = v as Record<string, unknown>;
            const keys = Object.keys(obj).sort();
            const parts = keys.map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`);
            return `{${parts.join(',')}}`;
        }

        throw new Error(`canonicalize: unsupported value of type ${t}`);
    };

    return encode(value);
};

/**
 * Compute the integrity hash for a scoring result: `sha256:<hex>` over the
 * canonical JSON of the input fields.
 */
export const computeIntegrityHash = (input: ScoringIntegrityInput): string => {
    const canonical = canonicalize({
        taskId: input.taskId,
        competition_id: input.competition_id,
        miner_hotkey: input.miner_hotkey,
        validator_hotkey: input.validator_hotkey,
        score: input.score,
        verdict: input.verdict,
        timestamp: input.timestamp,
    });
    const hex = createHash('sha256').update(canonical, 'utf8').digest('hex');
    return `sha256:${hex}`;
};
