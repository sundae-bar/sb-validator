#!/usr/bin/env python3
"""
Variant sampler for SBC9.

Reads a dataset.jsonl containing the full 20 SBC9 scenario variants (A1-A5,
B1-B5, C1-C5, D1-D5) and writes back a sampled subset: 2 random variants per
scenario type = 8 total. Seeded by the task ID so the same task gets the
same variants on re-run (deterministic replay), but different tasks see
different variant pairs (leaderboard variance protection).

Usage:
    python3 sample_variants.py <dataset_path> <task_id>

The sampled subset overwrites <dataset_path> in place.

Expected dataset format: one JSON object per line, each with at least:
    - "id": variant ID like "A1", "B3", "C4", "D5"
    - "ground_truth": JSON string with metadata.scenario_type = "A"/"B"/"C"/"D"

If the dataset does not look like an SBC9 dataset (no scenario_type metadata,
or already smaller than 9 rows), the script writes the input unchanged and
exits 0 — safe no-op for non-SBC9 suites.
"""

import hashlib
import json
import random
import sys
from pathlib import Path
from typing import Dict, List


VARIANTS_PER_TYPE_PER_TASK = 2
EXPECTED_TYPES = ("A", "B", "C", "D")


def _seed_from_task_id(task_id: str) -> int:
    """Convert a task ID string into a stable integer seed."""
    h = hashlib.sha256(task_id.encode("utf-8")).digest()
    return int.from_bytes(h[:8], "big")


def _scenario_type(record: dict) -> str:
    """Extract scenario_type from a record's ground_truth metadata."""
    gt = record.get("ground_truth")
    if isinstance(gt, str):
        try:
            gt = json.loads(gt)
        except json.JSONDecodeError:
            return ""
    if not isinstance(gt, dict):
        return ""
    meta = gt.get("metadata", {})
    if not isinstance(meta, dict):
        return ""
    return meta.get("scenario_type", "")


def sample_variants(records: List[dict], task_id: str) -> List[dict]:
    """
    Group records by scenario_type and pick N per type, seeded by task_id.
    Returns the sampled subset in stable order: A picks, then B, then C, then D.
    """
    by_type: Dict[str, List[dict]] = {t: [] for t in EXPECTED_TYPES}
    for r in records:
        t = _scenario_type(r)
        if t in by_type:
            by_type[t].append(r)

    # Validate SBC9 shape before sampling
    if not all(len(by_type[t]) >= VARIANTS_PER_TYPE_PER_TASK for t in EXPECTED_TYPES):
        # Not an SBC9 dataset — return unchanged
        return records

    rng = random.Random(_seed_from_task_id(task_id))
    picked: List[dict] = []
    for t in EXPECTED_TYPES:
        # Sort by id for stable input ordering before sampling
        pool = sorted(by_type[t], key=lambda r: r.get("id", ""))
        picked.extend(rng.sample(pool, VARIANTS_PER_TYPE_PER_TASK))
    return picked


def main():
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <dataset_path> <task_id>", file=sys.stderr)
        sys.exit(1)

    dataset_path = Path(sys.argv[1])
    task_id = sys.argv[2]

    if not dataset_path.exists():
        print(f"Dataset not found: {dataset_path}", file=sys.stderr)
        sys.exit(1)

    # Read
    records: List[dict] = []
    with open(dataset_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError as e:
                print(f"Warning: skipping malformed line: {e}", file=sys.stderr)

    original_count = len(records)
    sampled = sample_variants(records, task_id)

    if len(sampled) == original_count:
        # No sampling happened (not SBC9 or too few variants)
        print(
            f"sample_variants: no sampling applied (kept {original_count} records)",
            file=sys.stderr,
        )
        return

    # Write back
    with open(dataset_path, "w") as f:
        for r in sampled:
            f.write(json.dumps(r) + "\n")

    picked_ids = [r.get("id", "?") for r in sampled]
    print(
        f"sample_variants: task_id={task_id} -> sampled {len(sampled)} of "
        f"{original_count} variants: {picked_ids}",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
