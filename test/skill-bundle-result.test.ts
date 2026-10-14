import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractReferencesRead, extractSkillBundle } from '../src/skill-bundle-result';

test('a single-file result carries no bundle fields', () => {
  assert.equal(extractSkillBundle({ summary: { metrics: {} }, results: [] }), null);
  assert.equal(extractSkillBundle(null), null);
  assert.equal(extractSkillBundle({}), null);
  assert.equal(extractReferencesRead({ total_tokens: 10 }), null);
  assert.equal(extractReferencesRead(undefined), null);
});

test('forwards the evaluator bundle summary, files nobody read included', () => {
  const summary = {
    reference_files: 3,
    reference_chars: 4200,
    reference_reads: { 'a.md': 2, 'cases/b.md': 0, 'c.md': 6 },
  };
  assert.deepEqual(extractSkillBundle({ summary: { skill_bundle: summary } }), summary);
});

test('copies only the documented, well-typed fields', () => {
  const out = extractSkillBundle({
    summary: {
      skill_bundle: {
        reference_files: 1,
        reference_chars: 10,
        reference_reads: { 'a.md': 1, 'bad.md': 'many', 'nan.md': NaN },
        extra: 'dropped',
      },
    },
  });
  assert.deepEqual(out, { reference_files: 1, reference_chars: 10, reference_reads: { 'a.md': 1 } });
});

test('rejects a malformed bundle block rather than forwarding it', () => {
  assert.equal(extractSkillBundle({ summary: { skill_bundle: 'yes' } }), null);
  assert.equal(extractSkillBundle({ summary: { skill_bundle: [] } }), null);
  assert.equal(extractSkillBundle({ summary: { skill_bundle: { reference_files: '3' } } }), null);
});

test('forwards per-sample reference reads, dropping malformed entries', () => {
  assert.deepEqual(
    extractReferencesRead({
      total_tokens: 1,
      references_read: [{ path: 'a.md', chars: 5 }, { path: 7 }, null, { path: 'b.md', chars: 9, x: 1 }],
    }),
    [
      { path: 'a.md', chars: 5 },
      { path: 'b.md', chars: 9 },
    ],
  );
  assert.deepEqual(extractReferencesRead({ references_read: [] }), []);
});
