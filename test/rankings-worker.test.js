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
      const [snapshotId] = params;
      return { results: this.entries.filter((row) => row.snapshot_id === snapshotId && ['epic_total', 'spend_total'].includes(row.board_key)) };
    }
    if (normalized.includes('where snapshot_id = ? and board_key = ?')) {
      const [snapshotId, boardKey, limit] = params;
      return { results: this.entries.filter((row) => row.snapshot_id === snapshotId && row.board_key === boardKey).sort((a, b) => a.rank - b.rank).slice(0, limit) };
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
