import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeUserObservations,
  mergeMetricField,
  hasMeaningfulUserChange,
  shouldSkipSourceCapture
} from '../src/rankings-user-store.js';

function entry(boardKey, userId, value, rank, extra = {}) {
  return {
    boardKey,
    userId,
    userName: extra.userName || 'Alice',
    avatar: extra.avatar || 'https://example.test/alice.png',
    value,
    rank,
    isVip: Boolean(extra.isVip),
    activeNameDecoration: extra.activeNameDecoration ?? null,
    nameDisplayPreference: extra.nameDisplayPreference ?? null
  };
}

function normalizedSnapshot(scope, capturedAt, entries, extra = {}) {
  return {
    ok: true,
    seasonId: extra.seasonId || 'season-1',
    seasonName: extra.seasonName || 'Season 1',
    scope,
    capturedAt,
    entries
  };
}

function compactRow(overrides = {}) {
  return {
    user_id: 'u1',
    user_name: 'Alice',
    avatar_url: '',
    is_vip: 0,
    source_scopes: 'global',
    observed_at: 10_000,
    epic_total_value: null,
    epic_total_rank: null,
    epic_total_observed_at: null,
    ...overrides
  };
}

test('merges global and friends observations into one user-day record', () => {
  const rows = mergeUserObservations([
    normalizedSnapshot('global', 10_000, [
      entry('epic_total', 'u1', 10, 2),
      entry('spend_total', 'u1', 500_000, 3)
    ]),
    normalizedSnapshot('friends', 11_000, [
      entry('epic_total', 'u1', 12, 1),
      entry('sets_today', 'u1', 4, 8)
    ])
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'u1');
  assert.equal(rows[0].epic_total_value, 12);
  assert.equal(rows[0].epic_total_rank, 1);
  assert.equal(rows[0].spend_total_value, 500_000);
  assert.equal(rows[0].sets_today_value, 4);
  assert.equal(rows[0].source_scopes, 'global,friends');
  assert.equal(rows[0].epic_total_observed_at, 11_000);
});

test('same-day repeated values are marked unchanged without using captured time alone', () => {
  const existing = compactRow({ epic_total_value: 12, epic_total_rank: 1, epic_total_observed_at: 10_000 });
  const incoming = compactRow({ epic_total_value: 12, epic_total_rank: 1, epic_total_observed_at: 11_000 });
  assert.equal(hasMeaningfulUserChange(existing, incoming), false);
});

test('cumulative value keeps the maximum while rank uses the newer observation', () => {
  const merged = mergeMetricField({ value: 10, rank: 4, observedAt: 10_000 },
    { value: 12, rank: 2, observedAt: 11_000 }, true);
  assert.deepEqual(merged, { value: 12, rank: 2, observedAt: 11_000 });
});

test('period value rejects an older observation', () => {
  const merged = mergeMetricField({ value: 20, rank: 3, observedAt: 12_000 },
    { value: 18, rank: 1, observedAt: 11_000 }, false);
  assert.deepEqual(merged, { value: 20, rank: 3, observedAt: 12_000 });
});

test('server ingest watermark skips an already accepted source capture', () => {
  assert.equal(shouldSkipSourceCapture({ last_captured_at: 12_000 }, 12_000), true);
  assert.equal(shouldSkipSourceCapture({ last_captured_at: 12_000 }, 13_000), false);
});
