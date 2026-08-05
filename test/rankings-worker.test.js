import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRankingsRequest } from '../src/rankings-worker.js';

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
    if (normalized.includes('where season_id = ?') && normalized.includes('captured_bucket = ?')) {
      const [seasonId, scope, capturedBucket] = params;
      return this.snapshots.find((row) => row.season_id === seasonId && row.scope === scope && row.captured_bucket === capturedBucket) || null;
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

test('rejects an invalid snapshot and deduplicates the same hourly bucket', async () => {
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
  assert.equal(complete.estimatedPulls, 2600);
  assert.equal(complete.estimatedLegendProbability, 36 / 2600);
  assert.equal(complete.estimateStatus, 'complete_days');
  assert.equal(missing.estimatedLegendProbability, null);
  assert.equal(missing.estimateStatus, 'missing_spend');
  assert.equal(missing.isPartial, true);
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

  const todayResponse = await handleRankingsRequest(request('/api/rankings/leaderboard?period=today'), environment);
  const todayPayload = await todayResponse.json();
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
    { userId: 'a', userName: 'A', epic: 10, spend: 12_000_000_000 },
    { userId: 'b', userName: 'B', epic: 30, spend: 12_000_000_000 }
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
