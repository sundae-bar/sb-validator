import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveLeader,
  selectCurrentLeader,
  type ActiveCompetition,
} from '../src/leaderboard';

const comp = (entries: ActiveCompetition['entries']): ActiveCompetition => ({
  competition_id: 'c1',
  window_start: '2026-07-01T00:00:00.000Z',
  window_end: '2026-08-01T00:00:00.000Z',
  entries,
});

test('null / empty competition has no leader', () => {
  assert.equal(selectCurrentLeader(null), null);
  assert.equal(selectCurrentLeader(comp([])), null);
});

test('highest score wins', () => {
  const leader = selectCurrentLeader(
    comp([
      {
        miner_hotkey: 'a',
        best_score: 0.4,
        submitted_at: '2026-07-02T00:00:00.000Z',
      },
      {
        miner_hotkey: 'b',
        best_score: 0.9,
        submitted_at: '2026-07-03T00:00:00.000Z',
      },
      {
        miner_hotkey: 'c',
        best_score: 0.7,
        submitted_at: '2026-07-04T00:00:00.000Z',
      },
    ]),
  );
  assert.equal(leader?.miner_hotkey, 'b');
});

test('score tie broken by earliest submission', () => {
  const leader = selectCurrentLeader(
    comp([
      {
        miner_hotkey: 'late',
        best_score: 0.9,
        submitted_at: '2026-07-05T00:00:00.000Z',
      },
      {
        miner_hotkey: 'early',
        best_score: 0.9,
        submitted_at: '2026-07-02T00:00:00.000Z',
      },
    ]),
  );
  assert.equal(leader?.miner_hotkey, 'early');
});

test('full tie broken lexicographically by hotkey', () => {
  const leader = selectCurrentLeader(
    comp([
      {
        miner_hotkey: 'zzz',
        best_score: 0.5,
        submitted_at: '2026-07-02T00:00:00.000Z',
      },
      {
        miner_hotkey: 'aaa',
        best_score: 0.5,
        submitted_at: '2026-07-02T00:00:00.000Z',
      },
    ]),
  );
  assert.equal(leader?.miner_hotkey, 'aaa');
});

test('ignores entries with non-numeric scores', () => {
  const leader = selectCurrentLeader(
    comp([
      {
        miner_hotkey: 'bad',
        // @ts-expect-error deliberately malformed entry
        best_score: null,
        submitted_at: '2026-07-02T00:00:00.000Z',
      },
      {
        miner_hotkey: 'good',
        best_score: 0.1,
        submitted_at: '2026-07-03T00:00:00.000Z',
      },
    ]),
  );
  assert.equal(leader?.miner_hotkey, 'good');
});

// --- resolveLeader (coordinator-resolved leader, trust-but-verify) ---

const entry = (miner_hotkey: string, best_score: number, submitted_at = '2026-07-02T00:00:00.000Z') => ({
  miner_hotkey,
  best_score,
  submitted_at,
});

test('resolveLeader falls back to local election when fields are absent', () => {
  const c = comp([entry('hk-a', 0.8), entry('hk-b', 0.7)]);
  assert.equal(resolveLeader(c)?.miner_hotkey, 'hk-a');
});

test('resolveLeader follows a verified coordinator leader within the margin', () => {
  const c: ActiveCompetition = {
    ...comp([entry('hk-a', 0.805), entry('hk-b', 0.8)]),
    // hk-b holds the position; hk-a is ahead but inside the margin.
    current_leader: { miner_hotkey: 'hk-b', best_score: 0.8 },
    leadership_margin: 0.01,
  };
  assert.equal(resolveLeader(c)?.miner_hotkey, 'hk-b');
});

test('resolveLeader rejects an announced leader that an entry clearly beats', () => {
  const c: ActiveCompetition = {
    ...comp([entry('hk-a', 0.82), entry('hk-b', 0.8)]),
    current_leader: { miner_hotkey: 'hk-b', best_score: 0.8 },
    leadership_margin: 0.01,
  };
  // hk-a exceeds hk-b by >= margin — verification fails, local election wins.
  assert.equal(resolveLeader(c)?.miner_hotkey, 'hk-a');
});

test('resolveLeader rejects an announced leader missing from entries', () => {
  const c: ActiveCompetition = {
    ...comp([entry('hk-a', 0.8)]),
    current_leader: { miner_hotkey: 'hk-ghost', best_score: 0.9 },
    leadership_margin: 0.01,
  };
  assert.equal(resolveLeader(c)?.miner_hotkey, 'hk-a');
});

test('resolveLeader treats a challenger at exactly the margin as clearly ahead', () => {
  const c: ActiveCompetition = {
    ...comp([entry('hk-a', 0.81), entry('hk-b', 0.8)]),
    current_leader: { miner_hotkey: 'hk-b', best_score: 0.8 },
    leadership_margin: 0.01,
  };
  assert.equal(resolveLeader(c)?.miner_hotkey, 'hk-a');
});

test('resolveLeader ignores a malformed margin', () => {
  const c: ActiveCompetition = {
    ...comp([entry('hk-a', 0.805), entry('hk-b', 0.8)]),
    current_leader: { miner_hotkey: 'hk-b', best_score: 0.8 },
    leadership_margin: -1,
  };
  assert.equal(resolveLeader(c)?.miner_hotkey, 'hk-a');
});
