import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRankingsRequest } from '../src/rankings-worker.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const RESET_HOUR_MS = 4 * 60 * 60 * 1000;

class FakeStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() {
    return this.db.first(this.sql, this.params);
  }

  all() {
    return this.db.all(this.sql, this.params);
  }

  run() {
    return this.db.run(this.sql, this.params);
  }
}

class FakeD1 {
  constructor() {
    this.snapshots = [];
    this.entries = [];
    this.metrics = [];
    this.nextSnapshotId = 1;
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return { success: true };
  }

  async first(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('from rank_snapshots') && normalized.includes('where season_id = ? and signature = ?')) {
      const [seasonId, signature] = params;
      return this.snapshots.find((row) => row.season_id === seasonId && row.signature === signature) || null;
    }
    if (normalized.includes('where season_id = ? and scope = ? and captured_at < ?')) {
      const [seasonId, scope, capturedAt] = params;
      return this.snapshots
        .filter((row) => row.season_id === seasonId && row.scope === scope && row.captured_at < capturedAt)
        .sort((a, b) => b.captured_at - a.captured_at || b.id - a.id)[0] || null;
    }
    if (normalized.includes('from rank_snapshots') && normalized.includes('order by captured_at desc')) {
      return this.snapshots.slice().sort((a, b) => b.captured_at - a.captured_at || b.id - a.id)[0] || null;
    }
    return null;
  }

  async all(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.includes('from rank_entries e') && normalized.includes('join rank_snapshots s') && normalized.includes('board_key in')) {
      const [seasonId, ...keys] = params;
      const snapshotsById = new Map(this.snapshots.map((row) => [row.id, row]));
      return {
        results: this.entries
          .filter((entry) => {
            const snapshot = snapshotsById.get(entry.snapshot_id);
            return snapshot
              && snapshot.season_id === seasonId
              && keys.includes(entry.board_key);
          })
          .map((entry) => {
            const snapshot = snapshotsById.get(entry.snapshot_id);
            return {
              ...entry,
              scope: snapshot.scope,
              captured_at: snapshot.captured_at,
              captured_bucket: snapshot.captured_bucket,
              snapshot_id: snapshot.id
            };
          })
          .sort((left, right) => left.captured_at - right.captured_at || left.rank - right.rank)
      };
    }
    if (normalized.includes('from rank_entries e') && normalized.includes('join rank_snapshots s')) {
      const [seasonId, userId] = params;
      const snapshotsById = new Map(this.snapshots.map((row) => [row.id, row]));
      return {
        results: this.entries
          .filter((entry) => {
            const snapshot = snapshotsById.get(entry.snapshot_id);
            return snapshot && snapshot.season_id === seasonId && entry.user_id === userId;
          })
          .map((entry) => {
            const snapshot = snapshotsById.get(entry.snapshot_id);
            return {
              ...entry,
              season_id: snapshot.season_id,
              season_name: snapshot.season_name,
              captured_at: snapshot.captured_at,
              captured_bucket: snapshot.captured_bucket,
              scope: snapshot.scope,
              snapshot_id: snapshot.id
            }
          })
          .sort((left, right) => left.captured_at - right.captured_at || left.snapshot_id - right.snapshot_id)
      };
    }
    if (normalized.includes('from rank_user_metrics') && normalized.includes('board_key in')) {
      const [seasonId, ...keys] = params;
      return { results: this.metrics.filter((row) => row.season_id === seasonId && keys.includes(row.board_key)) };
    }
    if (normalized.includes('from rank_user_metrics') && normalized.includes('where season_id = ?')) {
      const [seasonId] = params;
      return { results: this.metrics.filter((row) => row.season_id === seasonId) };
    }
    if (normalized.includes('select distinct board_key')) {
      const [snapshotId] = params;
      return { results: Array.from(new Set(this.entries.filter((row) => row.snapshot_id === snapshotId).map((row) => row.board_key))).map((board_key) => ({ board_key })) };
    }
    if (normalized.includes('board_key in')) {
      const [snapshotId, ...keys] = params;
      const boardKeys = keys.length ? keys : ['epic_total', 'spend_total'];
      return { results: this.entries.filter((row) => row.snapshot_id === snapshotId && boardKeys.includes(row.board_key)) };
    }
    if (normalized.includes('where snapshot_id = ? and board_key = ?')) {
      const [snapshotId, boardKey, limit] = params;
      const rows = this.entries.filter((row) => row.snapshot_id === snapshotId && row.board_key === boardKey).sort((a, b) => a.rank - b.rank);
      return { results: limit == null ? rows : rows.slice(0, limit) };
    }
    if (normalized.includes('from rank_snapshots') && normalized.includes('where season_id = ?')) {
      const [seasonId] = params;
      return { results: this.snapshots.filter((row) => row.season_id === seasonId).sort((a, b) => a.captured_at - b.captured_at) };
    }
    return { results: [] };
  }

  async run(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('insert into rank_snapshots')) {
      const [season_id, season_name, scope, captured_at, captured_bucket, source, signature, raw_json, created_at] = params;
      const row = { id: this.nextSnapshotId++, season_id, season_name, scope, captured_at, captured_bucket, source, signature, raw_json, created_at };
      this.snapshots.push(row);
      return { success: true, meta: { last_row_id: row.id } };
    }
    if (normalized.startsWith('insert into rank_entries')) {
      const [snapshot_id, board_key, user_id, user_name, avatar_url, value, rank, is_vip, active_name_decoration, name_display_preference, raw_json] = params;
      this.entries.push({ snapshot_id, board_key, user_id, user_name, avatar_url, value, rank, is_vip, active_name_decoration, name_display_preference, raw_json });
      return { success: true, meta: { last_row_id: this.entries.length } };
    }
    if (normalized.startsWith('insert into rank_user_metrics')) {
      const [season_id, user_id, board_key, user_name, avatar_url, value, rank,
        is_vip, active_name_decoration, name_display_preference,
        value_snapshot_id, value_scope, value_captured_at,
        last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes] = params;
      const row = {
        season_id, user_id, board_key, user_name, avatar_url, value, rank,
        is_vip, active_name_decoration, name_display_preference,
        value_snapshot_id, value_scope, value_captured_at,
        last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes
      };
      const index = this.metrics.findIndex((item) => item.season_id === season_id && item.user_id === user_id && item.board_key === board_key);
      if (index >= 0) this.metrics[index] = row;
      else this.metrics.push(row);
      return { success: true, meta: { last_row_id: this.metrics.length } };
    }
    return { success: true, meta: {} };
  }
}

function env() {
  return { RANKINGS_DB: new FakeD1() };
}

function request(path, init) {
  return new Request(`https://card.gudong226.com${path}`, init);
}

test('returns 503 when the D1 binding is missing', async () => {
  const response = await handleRankingsRequest(request('/api/rankings/latest'), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'database_unavailable');
});

test('returns 404 for an unknown rankings endpoint', async () => {
  const response = await handleRankingsRequest(request('/api/rankings/nope'), env());
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, 'not_found');
});

test('returns an empty latest response before the first snapshot', async () => {
  const response = await handleRankingsRequest(request('/api/rankings/latest'), env());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    snapshot: null,
    stale: true,
    boards: []
  });
});

test('rejects invalid snapshots and accepts multiple captures in the same hour', async () => {
  const environment = env();
  const invalidResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      season: { id: 'season-1', name: '测试赛季' },
      scope: 'global', capturedAt: Date.now(), leaderboards: { bad: [] }
    })
  }), environment);
  assert.equal(invalidResponse.status, 400);

  const capturedAt = Date.now() - 1000;
  const snapshot = {
    season: { id: 'season-1', name: '测试赛季' },
    scope: 'global', capturedAt,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '猪猪', value: 2, rank: 1, isVip: true }]
    }
  };
  const firstResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  const secondResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
  assert.equal((await firstResponse.json()).status, 'accepted');
  assert.equal(secondResponse.status, 200);
  assert.equal((await secondResponse.json()).status, 'duplicate');
  assert.equal(environment.RANKINGS_DB.snapshots.length, 1);

  const leaderboardResponse = await handleRankingsRequest(request('/api/rankings/leaderboard?board=epic&period=total'), environment);
  assert.equal(leaderboardResponse.status, 200);
  const leaderboard = await leaderboardResponse.json();
  assert.equal(leaderboard.rows[0].userId, 'u-1');
  assert.equal(leaderboard.rows[0].event, 'entered');
});

test('pairs same-period epic and spend rows and marks partial or missing estimates', async () => {
  const environment = env();
  const capturedAt = Date.now() - 1000;
  const snapshot = {
    season: { id: 'season-pair', name: '配对测试赛季' },
    scope: 'global', capturedAt,
    leaderboards: {
      epic_today: [
        { userId: 'vip-1', userName: 'VIP玩家', value: 36, rank: 1, isVip: true },
        { userId: 'missing-spend', userName: '缺消费榜', value: 20, rank: 2, isVip: true }
      ],
      spend_today: [
        { userId: 'vip-1', userName: 'VIP玩家', value: 12000000000, rank: 1, isVip: true }
      ]
    }
  };
  const postResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  assert.equal(postResponse.status, 200, await postResponse.clone().text());

  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?board=epic&period=today'), environment);
  const payload = await response.json();
  const complete = payload.rows.find((row) => row.userId === 'vip-1');
  const missing = payload.rows.find((row) => row.userId === 'missing-spend');
  assert.equal(complete.paidPulls, 2_400);
  assert.equal(complete.freePulls, 200);
  assert.equal(complete.estimatedPulls, 2600);
  assert.equal(complete.estimatedLegendProbability, 36 / 2600);
  assert.equal(complete.estimateStatus, 'complete_days');
  assert.equal(missing.estimatedLegendProbability, null);
  assert.equal(missing.estimateStatus, 'missing_spend');
  assert.equal(missing.isPartial, true);
});

test('keeps historical raw values but does not pair metrics across different days', async () => {
  const environment = env();
  const oldCapturedAt = Date.now() - DAY_MS - 1000;
  const currentCapturedAt = Date.now() - 1000;
  const post = (snapshot) => handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);

  await post({
    season: { id: 'season-current-batch', name: '当前批次配对测试' },
    scope: 'global', capturedAt: oldCapturedAt,
    leaderboards: {
      spend_total: [{ userId: 'u-1', userName: '历史消费', value: 12_000_000_000, rank: 1, isVip: true }]
    }
  });
  await post({
    season: { id: 'season-current-batch', name: '当前批次配对测试' },
    scope: 'global', capturedAt: currentCapturedAt,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '当前出卡', value: 36, rank: 1, isVip: true }]
    }
  });

  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total'), environment);
  const payload = await response.json();
  const row = payload.rows.find((item) => item.userId === 'u-1');
  assert.equal(row.epicTotal, 36);
  assert.equal(row.spendUsd, 24_000);
  assert.equal(row.paidPulls, null);
  assert.equal(row.freePulls, null);
  assert.equal(row.estimatedPulls, null);
  assert.equal(row.estimatedLegendProbability, null);
  assert.equal(row.estimateStatus, 'missing_common_day');
  assert.equal(row.isPartial, true);
});

test('pairs the latest available rows within a day instead of requiring the same hour', async () => {
  const environment = env();
  const base = Math.floor((Date.now() - (2 * DAY_MS) - RESET_HOUR_MS) / DAY_MS) * DAY_MS
    + RESET_HOUR_MS;
  const firstCapture = base + 60 * 60 * 1000;
  const laterSameDayCapture = base + 6 * 60 * 60 * 1000;
  const nextDayCapture = base + DAY_MS + 60 * 60 * 1000;
  const post = (snapshot) => handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);

  await post({
    season: { id: 'season-daily-pair', name: '按日配对测试' },
    scope: 'global', capturedAt: firstCapture,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '日内用户', value: 30, rank: 1, isVip: true }],
      spend_total: [{ userId: 'u-1', userName: '日内用户', value: 12_000_000_000, rank: 1, isVip: true }]
    }
  });
  await post({
    season: { id: 'season-daily-pair', name: '按日配对测试' },
    scope: 'global', capturedAt: laterSameDayCapture,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '日内用户', value: 31, rank: 1, isVip: true }]
    }
  });
  await post({
    season: { id: 'season-daily-pair', name: '按日配对测试' },
    scope: 'global', capturedAt: nextDayCapture,
    leaderboards: {
      sets_total: [{ userId: 'u-1', userName: '日内用户', value: 2, rank: 1, isVip: true }]
    }
  });

  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total'), environment);
  const payload = await response.json();
  const row = payload.rows.find((item) => item.userId === 'u-1');
  assert.equal(row.epicTotal, 31);
  assert.equal(row.spendUsd, 24_000);
  assert.equal(row.paidPulls, 2_400);
  assert.equal(row.freePulls, 200);
  assert.equal(row.estimatedPulls, 2_600);
  assert.equal(row.estimatedLegendProbability, 31 / 2_600);
  assert.equal(row.estimateDayStartAt, base);
  assert.equal(row.estimateUsesHistoricalData, true);
  assert.equal(row.estimateStatus, 'complete_days');
});

test('converts spend values to USD and exposes a probability-ranked luck board', async () => {
  const environment = env();
  const capturedAt = Date.now() - 1000;
  const snapshot = {
    season: { id: 'season-luck', name: '运气榜测试赛季' },
    scope: 'global', capturedAt,
    leaderboards: {
      epic_today: [
        { userId: 'lucky', userName: '欧皇', value: 10, rank: 1, isVip: true },
        { userId: 'steady', userName: '稳健', value: 20, rank: 2, isVip: true },
        { userId: 'epic-only', userName: '缺消费', value: 99, rank: 3, isVip: true }
      ],
      spend_today: [
        { userId: 'lucky', userName: '欧皇', value: 3_000_000_000, rank: 1, isVip: true },
        { userId: 'steady', userName: '稳健', value: 12_000_000_000, rank: 2, isVip: true },
        { userId: 'spend-only', userName: '缺欧皇', value: 12_000_000_000, rank: 3, isVip: true }
      ]
    }
  };
  const postResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  assert.equal(postResponse.status, 200, await postResponse.clone().text());

  const spendResponse = await handleRankingsRequest(request('/api/rankings/leaderboard?board=spend&period=today'), environment);
  const spendPayload = await spendResponse.json();
  assert.equal(spendPayload.rows.find((row) => row.userId === 'lucky').spendUsd, 6_000);

  const luckResponse = await handleRankingsRequest(request('/api/rankings/leaderboard?board=luck&period=today'), environment);
  const luckPayload = await luckResponse.json();
  assert.deepEqual(luckPayload.rows.map((row) => row.userId), ['lucky', 'steady']);
  assert.equal(luckPayload.rows[0].rank, 1);
  assert.equal(luckPayload.partialRows.some((row) => row.userId === 'epic-only'), true);
  assert.equal(luckPayload.partialRows.some((row) => row.userId === 'spend-only'), true);
});

test('returns one dynamic user row with spend, pulls, exchanges and blank missing fields', async () => {
  const environment = env();
  const capturedAt = Date.now() - 1000;
  const snapshot = {
    season: { id: 'season-users', name: '用户总览赛季' },
    scope: 'global', capturedAt,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '完整用户', value: 13, rank: 1, isVip: true }],
      spend_total: [{ userId: 'u-1', userName: '完整用户', value: 12_000_000_000, rank: 1, isVip: true }],
      sets_total: [
        { userId: 'u-1', userName: '完整用户', value: 4, rank: 1, isVip: true },
        { userId: 'sets-only', userName: '只有兑换', value: 2, rank: 2, isVip: false }
      ],
      epic_today: [{ userId: 'u-2', userName: '只有出卡', value: 2, rank: 1, isVip: false }]
    }
  };
  await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total&sort=probability'), environment);
  const payload = await response.json();
  assert.deepEqual(payload.rows.map((row) => row.userId), ['u-1', 'sets-only']);
  assert.equal(payload.rows[0].spendUsd, 24_000);
  assert.equal(payload.rows[0].estimatedPulls, 2_600);
  assert.equal(payload.rows[0].exchangeCount, 4);
  assert.equal(payload.rows[1].spendUsd, null);
  assert.equal(payload.rows[1].exchangeCount, 2);

  const legendResponse = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total&sort=legend'), environment);
  const legendPayload = await legendResponse.json();
  assert.equal(legendPayload.sort, 'legend');
  assert.deepEqual(legendPayload.rows.map((row) => row.userId), ['u-1', 'sets-only']);

  const todayResponse = await handleRankingsRequest(request('/api/rankings/leaderboard?period=today'), environment);
  const todayPayload = await todayResponse.json();
  assert.equal(todayPayload.sort, 'legend');
  assert.equal(todayPayload.rows[0].userId, 'u-2');
  assert.equal(todayPayload.rows[0].spendUsd, null);
  assert.equal(todayPayload.rows[0].estimatedPulls, null);
  assert.equal(todayPayload.rows[0].exchangeCount, null);
  assert.equal(todayPayload.rows[0].estimatedLegendProbability, null);
});

test('recomputes user ranks against the previous snapshot in the selected period', async () => {
  const environment = env();
  const first = Date.now() - 3_600_000;
  const makeSnapshot = (capturedAt, rows) => ({
    season: { id: 'season-rank-delta', name: '排名变化赛季' },
    scope: 'global', capturedAt,
    leaderboards: {
      epic_total: rows.map((row, index) => ({ userId: row.userId, userName: row.userName, value: row.epic, rank: index + 1, isVip: true })),
      spend_total: rows.map((row, index) => ({ userId: row.userId, userName: row.userName, value: row.spend, rank: index + 1, isVip: true }))
    }
  });
  const firstRows = [
    { userId: 'a', userName: 'A', epic: 30, spend: 12_000_000_000 },
    { userId: 'b', userName: 'B', epic: 10, spend: 12_000_000_000 }
  ];
  const secondRows = [
    { userId: 'a', userName: 'A', epic: 40, spend: 12_000_000_000 },
    { userId: 'b', userName: 'B', epic: 50, spend: 12_000_000_000 }
  ];
  for (const snapshot of [makeSnapshot(first, firstRows), makeSnapshot(Date.now() - 1000, secondRows)]) {
    const response = await handleRankingsRequest(request('/api/rankings/snapshots', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
    }), environment);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total'), environment);
  const payload = await response.json();
  assert.equal(payload.rows[0].userId, 'b');
  assert.equal(payload.rows[0].rank, 1);
  assert.equal(payload.rows[0].previousRank, 2);
  assert.equal(payload.rows[0].rankDelta, 1);
});

test('merges global and friends uploads into one user overview while retaining both snapshots', async () => {
  const environment = env();
  const baseTime = Date.now() - 2000;
  const globalSnapshot = {
    season: { id: 'season-merge', name: '多来源合并赛季' },
    scope: 'global',
    capturedAt: baseTime,
    leaderboards: {
      epic_total: [
        { userId: 'u-1', userName: '用户一', value: 10, rank: 1, isVip: true },
        { userId: 'u-2', userName: '用户二', value: 4, rank: 2, isVip: false }
      ],
      spend_total: [
        { userId: 'u-1', userName: '用户一', value: 12_000_000_000, rank: 1, isVip: true }
      ]
    }
  };
  const friendsSnapshot = {
    season: { id: 'season-merge', name: '多来源合并赛季' },
    scope: 'friends',
    capturedAt: baseTime + 1000,
    leaderboards: {
      epic_total: [
        { userId: 'u-1', userName: '用户一', value: 12, rank: 1, isVip: true },
        { userId: 'u-3', userName: '用户三', value: 2, rank: 2, isVip: false }
      ],
      spend_total: [
        { userId: 'u-1', userName: '用户一', value: 12_000_000_000, rank: 1, isVip: true }
      ]
    }
  };

  for (const body of [
    { snapshots: [globalSnapshot] },
    { snapshots: [friendsSnapshot] }
  ]) {
    const response = await handleRankingsRequest(request('/api/rankings/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }), environment);
    assert.equal(response.status, 200, await response.clone().text());
  }

  assert.equal(environment.RANKINGS_DB.snapshots.length, 2);
  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?board=users&period=total'), environment);
  const payload = await response.json();
  assert.deepEqual(payload.rows.map((row) => row.userId).sort(), ['u-1', 'u-2', 'u-3']);
  assert.equal(payload.rows.find((row) => row.userId === 'u-1').epicTotal, 12);
  assert.equal(payload.rows.find((row) => row.userId === 'u-2').epicTotal, 4);

  const duplicateResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshots: [friendsSnapshot] })
  }), environment);
  const duplicatePayload = await duplicateResponse.json();
  assert.equal(duplicatePayload.duplicateSnapshots, 1);
  assert.equal(environment.RANKINGS_DB.snapshots.length, 2);
});

test('deduplicates raw history rows from global and friends in the same capture bucket', async () => {
  const environment = env();
  const capturedAt = Date.now() - 5000;
  for (const [scope, value] of [['global', 10], ['friends', 12]]) {
    const response = await handleRankingsRequest(request('/api/rankings/snapshots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        season: { id: 'season-history-merge', name: '历史合并测试' },
        scope,
        capturedAt,
        leaderboards: {
          epic_total: [{ userId: 'u-1', userName: '用户一', value, rank: 1, isVip: true }]
        }
      })
    }), environment);
    assert.equal(response.status, 200, await response.clone().text());
  }
  const response = await handleRankingsRequest(request('/api/rankings/history?userId=u-1'), environment);
  const payload = await response.json();
  const epicRows = payload.rows.filter((row) => row.boardKey === 'epic_total');
  assert.equal(epicRows.length, 1);
  assert.equal(epicRows[0].value, 12);
});
