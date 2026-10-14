// Skill bundles: a submission may be SKILL.md plus reference files the agent
// reads on demand. A bundle-aware sb-evals reports what it saw:
//   summary.skill_bundle                    — file count, chars, reads per file
//   results[].result.performance.references_read — files read on that sample
//
// The compact result this validator submits used to drop both. They are
// forwarded so the coordinator can (a) tell a bundle-aware evaluator from an
// older image that graded SKILL.md alone, and (b) show which references the
// agent actually opened. Both are absent for a single-file submission, and
// then nothing is added to the result.

export interface ReferenceRead {
  path: string;
  chars: number;
}

export interface SkillBundleSummary {
  reference_files: number;
  reference_chars: number;
  reference_reads: Record<string, number>;
}

// Copies only the documented fields, with types checked — the evaluator's
// output is passed on to the coordinator, so it is not trusted as-is.
export function extractSkillBundle(evaluationResult: unknown): SkillBundleSummary | null {
  const raw = (evaluationResult as { summary?: { skill_bundle?: unknown } } | null | undefined)?.summary
    ?.skill_bundle;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const b = raw as Record<string, unknown>;
  if (typeof b.reference_files !== 'number' || typeof b.reference_chars !== 'number') return null;
  const reads: Record<string, number> = {};
  if (b.reference_reads && typeof b.reference_reads === 'object' && !Array.isArray(b.reference_reads)) {
    for (const [path, count] of Object.entries(b.reference_reads as Record<string, unknown>)) {
      if (typeof count === 'number' && Number.isFinite(count)) reads[path] = count;
    }
  }
  return {
    reference_files: b.reference_files,
    reference_chars: b.reference_chars,
    reference_reads: reads,
  };
}

export function extractReferencesRead(performance: unknown): ReferenceRead[] | null {
  const raw = (performance as { references_read?: unknown } | null | undefined)?.references_read;
  if (!Array.isArray(raw)) return null;
  return raw.flatMap((r) => {
    const o = r as { path?: unknown; chars?: unknown } | null;
    return o && typeof o.path === 'string' && typeof o.chars === 'number'
      ? [{ path: o.path, chars: o.chars }]
      : [];
  });
}
