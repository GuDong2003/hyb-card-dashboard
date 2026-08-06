import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_KEYS,
  normalizeLeaderboardSnapshot,
  normalizeSnapshotBundle,
  computeSnapshotSignature,
  estimatePullsFromSpend,
  estimateLegendProbability,
  diffBoardRows,
  parseCapturedAt
} from '../src/rankings-core.js';

const row = (overrides = {}) => ({
  userId: 'u-1', userName: '猪猪', avatar: '', value: 10,
  rank: 1, isVip: true, activeNameDecoration: null,
  nameDisplayPreference: 'auto', ...overrides
});

test('accepts all server leaderboard keys and keeps dynamic row counts', () => {
  const leaderboards = Object.fromEntries(BOARD_KEYS.map((key) => [key, [row()]]));
  leaderboards.epic_total = Array.from({ length: 101 }, (_, index) => row({ userId: `u-${index}`, rank: index + 1 }));
  const result = normalizeLeaderboardSnapshot({
    season: { id: 'season-1', name: '第四赛季-周年庆' },
    scope: 'global', leaderboards, capturedAt: 1785922892568
  }, 1785922892568);
  assert.equal(result.ok, true);
  assert.deepEqual(result.boardKeys, BOARD_KEYS);
  assert.equal(result.entries.length, 112);
});

test('accepts friends scope while preserving the source scope', () => {
  const result = normalizeLeaderboardSnapshot({
    season: { id: 'season-friends', name: '好友榜测试' },
    scope: 'friends',
    leaderboards: { epic_total: [row()] },
    capturedAt: 1785922892568
  }, 1785922892568);
  assert.equal(result.ok, true);
  assert.equal(result.scope, 'friends');
});

test('normalizes a legacy snapshot and a multi-source snapshot bundle', () => {
  const global = {
    season: { id: 'season-bundle', name: 'Bundle 测试' },
    scope: 'global', leaderboards: { epic_total: [row()] }, capturedAt: 1785922892568
  };
  const friends = {
    season: { id: 'season-bundle', name: 'Bundle 测试' },
    scope: 'friends', leaderboards: { epic_total: [row({ userId: 'u-2' })] }, capturedAt: 1785922892568
  };
  assert.equal(normalizeSnapshotBundle(global, 1785922892568).snapshots.length, 1);
  const bundle = normalizeSnapshotBundle({ snapshots: [global, friends] }, 1785922892568);
  assert.equal(bundle.ok, true);
  assert.deepEqual(bundle.snapshots.map((snapshot) => snapshot.scope), ['global', 'friends']);
});

test('rejects unknown boards and future captures', () => {
  const base = {
    season: { id: 'season-1', name: '测试赛季' }, scope: 'global',
    leaderboards: { epic_total: [row()] }, capturedAt: 700001
  };
  assert.equal(normalizeLeaderboardSnapshot({ ...base, capturedAt: 1000, leaderboards: { bad: [] } }, 1000).reason, 'unknown_board');
  assert.equal(normalizeLeaderboardSnapshot(base, 1000).reason, 'future_captured_at');
});

test('parses numeric and ISO capture timestamps while rejecting invalid values', () => {
  const iso = '2026-08-05T09:40:17.863Z';
  assert.equal(parseCapturedAt(1785922892568), 1785922892568);
  assert.equal(parseCapturedAt(iso), Date.parse(iso));
  assert.equal(parseCapturedAt('not-a-date'), null);
});

test('signature is stable when object key order changes', async () => {
  const left = { b: 2, a: 1 };
  const right = { a: 1, b: 2 };
  assert.equal(await computeSnapshotSignature(left), await computeSnapshotSignature(right));
});

test('estimates pull count from raw spend with VIP and ordinary quotas', () => {
  const vip = estimatePullsFromSpend(12_000_000_000, true);
  assert.equal(vip.spendUsd, 24_000);
  assert.equal(vip.estimatedDays, 4);
  assert.equal(vip.estimatedPulls, 2_600);
  assert.equal(vip.estimateStatus, 'complete_days');

  const ordinary = estimatePullsFromSpend(2_000_000_000, false);
  assert.equal(ordinary.spendUsd, 4_000);
  assert.equal(ordinary.estimatedDays, 1);
  assert.equal(ordinary.estimatedPulls, 430);
  assert.equal(ordinary.estimateStatus, 'complete_days');

  const missing = estimatePullsFromSpend(null, true);
  assert.equal(missing.spendUsd, null);
  assert.equal(missing.estimatedPulls, null);
  assert.equal(missing.estimateStatus, 'missing_spend');
});

test('computes probability from same-period raw spend', () => {
  assert.equal(
    estimateLegendProbability({ epicTotal: 36, spendValue: 12_000_000_000, isVip: true }),
    36 / 2_600
  );
});

test('diffs rank movement and enter/leave events', () => {
  const previous = [row({ userId: 'u-1', rank: 4, value: 9 }), row({ userId: 'u-2', rank: 2, value: 5 })];
  const current = [row({ userId: 'u-1', rank: 1, value: 10 }), row({ userId: 'u-3', rank: 2, value: 7 })];
  const result = diffBoardRows(previous, current);
  assert.equal(result.find((item) => item.userId === 'u-1').rankDelta, 3);
  assert.equal(result.find((item) => item.userId === 'u-3').event, 'entered');
  assert.equal(result.find((item) => item.userId === 'u-2').event, 'left');
});
