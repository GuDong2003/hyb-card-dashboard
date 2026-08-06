import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMetric, mergeMetricRows } from '../src/rankings-merge.js';

function metric(overrides = {}) {
  return {
    seasonId: 'season-1',
    userId: 'u-1',
    boardKey: 'epic_total',
    userName: '用户',
    avatar: '',
    value: 10,
    rank: 1,
    isVip: false,
    activeNameDecoration: null,
    nameDisplayPreference: 'auto',
    snapshotId: 1,
    scope: 'global',
    capturedAt: 1000,
    ...overrides
  };
}

test('merges two scopes by user and does not add duplicate values', () => {
  const existing = mergeMetric(null, metric({ value: 10, capturedAt: 1000, scope: 'global' }));
  const merged = mergeMetric(existing, metric({ value: 12, capturedAt: 1000, scope: 'friends' }));
  assert.equal(merged.value, 12);
  assert.equal(merged.sourceScopes, 'global,friends');
  assert.equal(merged.userId, 'u-1');
});

test('keeps the largest value for cumulative total boards', () => {
  const existing = mergeMetric(null, metric({ value: 12, capturedAt: 2000 }));
  const merged = mergeMetric(existing, metric({ value: 8, capturedAt: 3000, scope: 'friends' }));
  assert.equal(merged.value, 12);
  assert.equal(merged.lastCapturedAt, 3000);
  assert.equal(merged.valueCapturedAt, 2000);
});

test('uses the newest observation for period boards', () => {
  const existing = mergeMetric(null, metric({ boardKey: 'epic_today', value: 12, capturedAt: 1000 }));
  const merged = mergeMetric(existing, metric({ boardKey: 'epic_today', value: 8, capturedAt: 2000, scope: 'friends' }));
  assert.equal(merged.value, 8);
  assert.equal(merged.valueCapturedAt, 2000);
});

test('does not overwrite existing users when a later upload is partial', () => {
  const rows = mergeMetricRows([
    metric({ userId: 'u-1', value: 8, capturedAt: 1000 })
  ], [metric({ userId: 'u-2', value: 3, capturedAt: 2000 })]);
  assert.deepEqual(rows.map((row) => row.userId).sort(), ['u-1', 'u-2']);
});

test('keeps VIP true and the latest non-empty profile fields', () => {
  const existing = mergeMetric(null, metric({ userName: '旧名', isVip: false, capturedAt: 1000 }));
  const merged = mergeMetric(existing, metric({ userName: '新名', isVip: true, capturedAt: 2000, scope: 'friends' }));
  assert.equal(merged.isVip, true);
  assert.equal(merged.userName, '新名');
});
