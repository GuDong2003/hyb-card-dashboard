import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handleRankingsRequest } from '../src/rankings-worker.js';
import { COMPACT_BOARD_KEYS, USER_CURRENT_COLUMNS } from '../src/rankings-user-store.js';

const SCHEMA = await readFile(new URL('../migrations-v2/0001_compact_rankings.sql', import.meta.url), 'utf8');

class Statement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  first() { return this.db.first(this.sql, this.params); }
  all() { return this.db.all(this.sql, this.params); }
  run() { return this.db.run(this.sql, this.params); }
}

class CompactDb {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(SCHEMA);
    this.queries = [];
  }

  prepare(sql) { return new Statement(this, sql); }

  async batch(statements) {
    return statements.map((statement) => statement.run());
  }

  first(sql, params) {
    this.record(sql, params);
    return this.sqlite.prepare(sql).get(...params) || null;
  }

  all(sql, params) {
    this.record(sql, params);
    return { results: this.sqlite.prepare(sql).all(...params) };
  }

  run(sql, params) {
    this.record(sql, params);
    const result = this.sqlite.prepare(sql).run(...params);
    return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } };
  }

  record(sql, params) {
    this.queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim().toLowerCase(), params: [...params] });
  }
}

function env() {
  return { RANKINGS_DB: new CompactDb() };
}

function seedSeason(environment, capturedAt = 100_000) {
  environment.RANKINGS_DB.run(
    `INSERT INTO rank_seasons (season_id, season_name, last_observed_at, last_day_start_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ['s1', 'Season 1', capturedAt, capturedAt - 1_000, capturedAt]
  );
}

function seedUser(environment, userId, userName = userId) {
  const row = {
    season_id: 's1',
    user_id: userId,
    user_name: userName,
    avatar_url: '',
    is_vip: 0,
    active_name_decoration: null,
    name_display_preference: null,
    first_observed_at: 100_000,
    last_observed_at: 100_000,
    source_scopes: 'global',
    epic_total_value: 10,
    epic_total_rank: 1,
    epic_total_observed_at: 100_000,
    spend_total_value: 500_000,
    spend_total_rank: 1,
    spend_total_observed_at: 100_000,
    sets_total_value: 2,
    sets_total_rank: 1,
    sets_total_observed_at: 100_000,
    sort_legend_value: 10,
    sort_spend_usd: 1,
    sort_estimated_pulls: 100,
    sort_exchange_count: 2,
    sort_probability: 0.1
  };
  for (const key of COMPACT_BOARD_KEYS) {
    if (row[`${key}_value`] !== undefined) continue;
    row[`${key}_value`] = null;
    row[`${key}_rank`] = null;
    row[`${key}_observed_at`] = null;
  }
  environment.RANKINGS_DB.run(
    `INSERT INTO rank_user_current (${USER_CURRENT_COLUMNS.join(', ')}) VALUES (${USER_CURRENT_COLUMNS.map(() => '?').join(', ')})`,
    USER_CURRENT_COLUMNS.map((column) => row[column] ?? null)
  );
}

test('returns 503 when the compact D1 binding is missing', async () => {
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/latest'), {});
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, 'database_unavailable');
});

test('returns 404 for an unknown rankings endpoint', async () => {
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/unknown'), env());
  assert.equal(response.status, 404);
});

test('returns 429 before parsing or writing when the limiter rejects the source', async () => {
  let parsed = false;
  const environment = {
    RANKINGS_DB: new CompactDb(),
    RANKINGS_WRITE_LIMITER: { limit: async () => ({ success: false }) }
  };
  const request = new Request('https://card.test/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{invalid'
  });
  request.json = async () => {
    parsed = true;
    throw new Error('should_not_parse');
  };
  const response = await handleRankingsRequest(request, environment);
  assert.equal(response.status, 429);
  assert.equal(parsed, false);
  assert.equal(environment.RANKINGS_DB.queries.length, 0);
});

test('user search and targeted ids read only current rows', async () => {
  const environment = env();
  seedSeason(environment);
  seedUser(environment, 'alice-1', 'Alice');
  seedUser(environment, 'bob-1', 'Bob');
  const search = await handleRankingsRequest(new Request('https://card.test/api/rankings/users?q=alice&limit=20'), environment);
  assert.deepEqual((await search.json()).users.map((row) => row.userId), ['alice-1']);
  const targeted = await handleRankingsRequest(new Request('https://card.test/api/rankings/users?ids=bob-1'), environment);
  assert.deepEqual((await targeted.json()).users.map((row) => row.userId), ['bob-1']);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /from rank_user_current/.test(sql)), true);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /COUNT\(\*\)/i.test(sql)), false);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /rank_snapshots|rank_entries|rank_user_metrics|rank_daily_metrics|raw_json|fingerprint/.test(sql)), false);
});

test('leaderboard search filters the requested page before pagination', async () => {
  const environment = env();
  seedSeason(environment);
  seedUser(environment, 'alice-1', 'Alice');
  seedUser(environment, 'bob-1', 'Bob');
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?sort=user&direction=asc&q=alice&limit=20'), environment);
  const payload = await response.json();
  assert.deepEqual(payload.rows.map((row) => row.userId), ['alice-1']);
  assert.equal(payload.totalRows, 1);
});

test('leaderboard page ranks continue across a keyset cursor', async () => {
  const environment = env();
  seedSeason(environment);
  seedUser(environment, 'alice-1', 'Alice');
  seedUser(environment, 'bob-1', 'Bob');
  seedUser(environment, 'charlie-1', 'Charlie');

  let response = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?sort=user&direction=asc&limit=1'), environment);
  let payload = await response.json();
  assert.equal(payload.rows[0].rank, 1);
  assert.ok(payload.nextCursor);

  response = await handleRankingsRequest(new Request(`https://card.test/api/rankings/leaderboard?sort=user&direction=asc&limit=1&cursor=${encodeURIComponent(payload.nextCursor)}`), environment);
  payload = await response.json();
  assert.equal(payload.rows[0].userId, 'bob-1');
  assert.equal(payload.rows[0].rank, 2);
});

test('user leaderboard sorts by the selected period metrics', async () => {
  const environment = env();
  seedSeason(environment);
  seedUser(environment, 'alice-1', 'Alice');
  seedUser(environment, 'bob-1', 'Bob');
  environment.RANKINGS_DB.run(`
    UPDATE rank_user_current
    SET epic_today_value = CASE user_id WHEN 'alice-1' THEN 1 ELSE 20 END,
        epic_today_rank = CASE user_id WHEN 'alice-1' THEN 2 ELSE 1 END
    WHERE season_id = 's1'
  `, []);

  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?period=today&sort=legend&limit=20'), environment);
  assert.deepEqual((await response.json()).rows.map((row) => row.userId), ['bob-1', 'alice-1']);
});

test('invalid cursor is rejected before current page query', async () => {
  const environment = env();
  seedSeason(environment);
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?cursor=bad'), environment);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_cursor');
});

test('invalid cursor rejects a null-rank value mismatch', async () => {
  const environment = env();
  seedSeason(environment);
  const cursor = Buffer.from(JSON.stringify({
    seasonId: 's1',
    board: 'users',
    period: 'total',
    sort: 'legend',
    direction: 'desc',
    query: '',
    rank: 1,
    nullRank: 0,
    value: null,
    userId: 'alice-1'
  })).toString('base64url');
  const response = await handleRankingsRequest(new Request(`https://card.test/api/rankings/leaderboard?cursor=${cursor}`), environment);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_cursor');
});
