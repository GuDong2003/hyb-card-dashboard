import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOARD_KEYS,
  normalizeLeaderboardSnapshot,
  computeSnapshotSignature,
  estimateLegendProbability,
  diffBoardRows
} from '../src/rankings-core.js';

const row = (overrides = {}) => ({
  userId: 'u-1', userName: '猪猪', avatar: '', value: 10,
  rank: 1, isVip: true, activeNameDecoration: null,
  nameDisplayPreference: 'auto', ...overrides
});

test('accepts all server leaderboard keys and keeps at most 100 rows', () => {
  const leaderboards = Object.fromEntries(BOARD_KEYS.map((key) => [key, [row()]]));
  const result = normalizeLeaderboardSnapshot({
    season: { id: 'season-1', name: '第四赛季-周年庆' },
    scope: 'global', leaderboards, capturedAt: 1785922892568
  }, 1785922892568);
  assert.equal(result.ok, true);
  assert.deepEqual(result.boardKeys, BOARD_KEYS);
  assert.equal(result.entries.length, 12);
});

test('rejects unknown boards and future captures', () => {
  const base = {
    season: { id: 'season-1', name: '测试赛季' }, scope: 'global',
    leaderboards: { epic_total: [row()] }, capturedAt: 700001
  };
  assert.equal(normalizeLeaderboardSnapshot({ ...base, capturedAt: 1000, leaderboards: { bad: [] } }, 1000).reason, 'unknown_board');
  assert.equal(normalizeLeaderboardSnapshot(base, 1000).reason, 'future_captured_at');
});

test('signature is stable when object key order changes', async () => {
  const left = { b: 2, a: 1 };
  const right = { a: 1, b: 2 };
  assert.equal(await computeSnapshotSignature(left), await computeSnapshotSignature(right));
});

test('estimates pull count with VIP free pulls and returns a percentage', () => {
  assert.equal(estimateLegendProbability({ epicTotal: 12, spendTotal: 6000, elapsedDays: 2, isVip: true }), 12 / 700);
});

test('diffs rank movement and enter/leave events', () => {
  const previous = [row({ userId: 'u-1', rank: 4, value: 9 }), row({ userId: 'u-2', rank: 2, value: 5 })];
  const current = [row({ userId: 'u-1', rank: 1, value: 10 }), row({ userId: 'u-3', rank: 2, value: 7 })];
  const result = diffBoardRows(previous, current);
  assert.equal(result.find((item) => item.userId === 'u-1').rankDelta, 3);
  assert.equal(result.find((item) => item.userId === 'u-3').event, 'entered');
  assert.equal(result.find((item) => item.userId === 'u-2').event, 'left');
});
