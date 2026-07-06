# PRD — Coordinator (`api.sundaebar.ai`) changes for local weight decisions

**Status:** Draft for implementation on the coordinator repo (separate from `sb-validator`).
**Owner:** SN121 / sundae_bar.
**Related change:** `sb-validator` now decides weights locally instead of fetching them. See
this repo's README → "Bittensor Weights Configuration".

---

## 1. Context & goal

Previously the validator asked the coordinator *which weights to set*
(`POST /api/v2/validators/weights` returned a computed `{uid, weight}` vector). That made the
coordinator the arbiter of emissions — a centralized "owner-set dial".

We are inverting this: **the validator computes weights itself** from public, auditable data.
The coordinator becomes a **data source + display layer**, not the decision-maker:

- It **serves** the active competition + leaderboard (read-only).
- It **attributes** each evaluation task to a miner + competition (so the validator can build a
  verifiable score record).
- It **stores + displays** the validator's pushed-back scores, including an integrity hash the
  web app can recompute to prove the leaderboard matches what the validator scored.
- It **no longer computes or serves** on-chain weights.

The validator's weight rule (implemented in `sb-validator`, documented here for context):
current **#1 miner by score** receives `EMISSIONS_PERCENT` (default **0.2**) of weight; the
remaining ~0.8 is burned to **UID 0**. Whoever holds #1 longest accrues the most emissions over
the competition lifetime ("time at the top takes all").

---

## 2. Scope of coordinator changes

| # | Change | Type |
|---|---|---|
| A | New endpoint `GET /api/v2/validators/competitions/active` | Add |
| B | Include `competition_id` + `miner_hotkey` in each task's `task_payload.metadata` | Modify |
| C | Accept + persist extended `result_data` (`integrity_hash`, `scoring`) on the result submit; expose it for the web app | Modify |
| D | Retire `POST /api/v2/validators/weights` (the weight-compute endpoint) | Remove/deprecate |

All endpoints keep the **existing signed-request convention** (sr25519 `X-Signature` over the
JSON payload; the validator hotkey identifies the caller).

---

## 3. Change A — `GET /api/v2/validators/competitions/active`

Returns the currently active competition and its leaderboard. This is **read-only data**; it
must NOT return weights.

### Request
- Method: `GET`
- Path: `/api/v2/validators/competitions/active`
- Headers: `X-Signature` (sr25519 over `{ "hotkey": "<validator hotkey>" }`), `X-Hotkey: <validator hotkey>`.
- No body.

### Response `200`
```jsonc
{
  "competition_id": "comp_2026_07",
  "window_start": "2026-07-01T00:00:00.000Z",  // ISO 8601 UTC
  "window_end":   "2026-08-01T00:00:00.000Z",  // ISO 8601 UTC
  "entries": [
    {
      "miner_hotkey": "5F...",   // SS58 or 0x hex; validator normalizes to SS58/42
      "best_score":   0.8734,    // number; the miner's best score this competition
      "submitted_at": "2026-07-04T12:30:00.000Z" // ISO 8601 UTC of the submission that set best_score
    }
    // ...one entry per participating miner
  ]
}
```

### Response `204 No Content` (or `200` with empty/absent `competition_id`)
When no competition is currently active. The validator treats this as "no active competition"
and **burns 100% to UID 0**.

### TypeScript contract (must match `src/leaderboard.ts` in `sb-validator`)
```ts
interface LeaderboardEntry {
  miner_hotkey: string;   // SS58 or hex; normalized validator-side
  best_score: number;     // finite number
  submitted_at: string;   // ISO 8601
}
interface ActiveCompetition {
  competition_id: string;
  window_start: string;   // ISO 8601
  window_end: string;     // ISO 8601
  entries: LeaderboardEntry[];
}
```

### Notes / requirements
- `best_score` should be the **same score the validator would compute** for that miner's best
  submission (i.e. it must already honor the `overall_gate_passed` verdict → a failed gate is
  score `0`). The validator only uses these scores to pick the winner; it does not re-derive the
  full leaderboard from raw submissions.
- Entries with a null/non-numeric `best_score` are ignored by the validator (safe to include,
  but prefer to omit).
- One entry per miner (the miner's *best*), not per submission.
- Winner selection is deterministic: highest `best_score`; ties → earliest `submitted_at`; then
  lexicographic `miner_hotkey`. The coordinator does not need to sort, but consistent data helps.

---

## 4. Change B — task attribution metadata

The validator must know which miner + competition a scored task belongs to, in order to build
the integrity hash and attribute the push-back. Today `task_payload` carries no miner identity.

Add to each task's `task_payload.metadata`:
```jsonc
{
  "task_payload": {
    "skill_file_path": "https://.../SKILL.md",
    "metadata": {
      "competition_id": "comp_2026_07",  // string
      "miner_hotkey":   "5F..."          // SS58 or 0x hex
      // ...existing metadata preserved
    }
  }
}
```

### Behavior when missing
The validator degrades gracefully: it still scores and submits the result, but **without** an
integrity hash or weight attribution, and logs a warning. So these fields are strongly
recommended but not hard-required for task processing. They ARE required for the leaderboard to
be verifiable.

---

## 5. Change C — extended result submission (`POST /api/v2/validators/tasks/:id/result`)

The existing endpoint is unchanged in shape; the validator now adds two fields inside
`result_data`. Because the whole payload is already sr25519-signed, the hash is covered by the
signature; it is additionally a portable digest the web app can recompute.

### `result_data` additions
```jsonc
{
  "status": "completed",
  "result_data": {
    "results": [ /* per-sample, unchanged */ ],
    "score": 0.8734,
    "tests_count": 12,
    "duration_seconds": 41.2,
    "total_tokens": 18450,
    "timestamp": "2026-07-06T00:00:00.000Z",

    // NEW:
    "integrity_hash": "sha256:<64 hex chars>",
    "scoring": {
      "taskId": "task_abc",
      "competition_id": "comp_2026_07",
      "miner_hotkey": "5F...",          // SS58, normalized
      "validator_hotkey": "5G...",      // SS58, normalized
      "score": 0.8734,
      "verdict": "passed",              // "passed" | "failed"
      "timestamp": "2026-07-06T00:00:00.000Z"
    }
  }
}
```

### Integrity hash definition (coordinator + web app must reproduce)
`integrity_hash = "sha256:" + hex(sha256(canonicalJSON(scoring)))` where `canonicalJSON`
serializes the `scoring` object with **object keys sorted recursively** (arrays keep order;
`undefined`/non-finite numbers are disallowed). The exact fields hashed are the seven in
`scoring` above, in a key-sorted object. Reference implementation: `src/integrity.ts` in
`sb-validator` (`canonicalize` + `computeIntegrityHash`). To verify: recompute the hash from the
stored `scoring` fields and compare to `integrity_hash`.

### Coordinator requirements
- Persist `integrity_hash` and `scoring` alongside the result.
- Surface them to the web-app leaderboard so it can display the score and show a verified/mismatch
  indicator by recomputing the hash.
- Optionally verify the hash server-side on ingest and reject/flag mismatches.

---

## 6. Change D — retire `POST /api/v2/validators/weights`

The validator no longer calls this endpoint. Options, in order of preference:
1. **Remove** the route and its weight-computation logic.
2. Or **deprecate**: keep returning data for backwards compatibility with old validator builds,
   but mark it deprecated and stop relying on it. New validator builds ignore it entirely.

No new weight-serving endpoint replaces it — weights are never served by the coordinator again.

---

## 7. Auth & conventions (unchanged)

- All validator→coordinator calls are sr25519-signed. The signature is over the JSON payload with
  any `signature`/`signed_payload` fields stripped (see `src/signature.ts`). For the GET
  competition endpoint, the signed payload is `{ hotkey }` and the hotkey is also sent as
  `X-Hotkey` for convenience.
- Hotkeys may be sent as hex or SS58; the validator normalizes to SS58 (format 42) before
  matching against the metagraph. The coordinator should store a consistent representation.

---

## 8. Acceptance criteria

- [ ] `GET /competitions/active` returns the `ActiveCompetition` shape for an active competition
      and `204`/empty when none is active.
- [ ] `best_score` values already reflect the gate verdict (failed → 0) and match validator-side
      scoring.
- [ ] Every skill task's `task_payload.metadata` includes `competition_id` and `miner_hotkey`.
- [ ] Result submissions persist `integrity_hash` + `scoring`; the web app displays the score and
      can recompute the hash to show verification status.
- [ ] `POST /weights` is removed or deprecated; nothing in production depends on it.
- [ ] End-to-end: a validator running the new build with `BITTENSOR_WEIGHTS_DISABLED=true` logs
      target weights `{winnerUid: 0.2, 0: 0.8}` for the current #1 miner, and `{0: 1.0}` when the
      competition endpoint returns empty.
