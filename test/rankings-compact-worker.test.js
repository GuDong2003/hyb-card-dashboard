import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handleRankingsRequest } from '../src/rankings-worker.js';
import {
  COMPACT_BOARD_KEYS,
  USER_CURRENT_COLUMNS,
  USER_DAY_COLUMNS
} from '../src/rankings-user-store.js';

const SCHEMA = await readFile(new URL('../migrations-v2/0001_compact_rankings.sql', import.meta.url), 'utf8');

class CompactStatement {
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

class CompactD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec(SCHEMA);
    this.queries = [];
  }

  prepare(sql) {
    return new CompactStatement(this, sql);
  }

  async batch(statements) {
    for (const statement of statements) statement.run();
    return { success: true };
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
    return {
      success: true,
      meta: {
        changes: Number(result.changes || 0),
        last_row_id: Number(result.lastInsertRowid || 0)
      }
    };
  }

  record(sql, params) {
    this.queries.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: [...params] });
  }

  get userDays() {
    return this.sqlite.prepare('SELECT * FROM rank_user_days ORDER BY season_id, day_start_at, user_id').all();
  }

  get currentUsers() {
    return this.sqlite.prepare('SELECT * FROM rank_user_current ORDER BY season_id, user_id').all();
  }
}

function compactEnv() {
  return { RANKINGS_DB: new CompactD1() };
}

function seedSeason(environment, capturedAt = 100_000) {
  environment.RANKINGS_DB.run(
    `INSERT INTO rank_seasons (season_id, season_name, last_observed_at, last_day_start_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['season-1', 'Season 1', capturedAt, capturedAt - 1_000, capturedAt]
  );
}

function seedCurrentUser(environment, userId, index = 0) {
  const row = {
    season_id: 'season-1',
    user_id: userId,
    user_name: `User ${String(index).padStart(3, '0')}`,
    avatar_url: '',
    is_vip: 0,
    active_name_decoration: null,
    name_display_preference: null,
    first_observed_at: 100_000,
    last_observed_at: 100_000,
    source_scopes: 'global',
    sets_total_value: index,
    sets_total_rank: index + 1,
    sets_total_observed_at: 100_000,
    epic_total_value: index,
    epic_total_rank: index + 1,
    epic_total_observed_at: 100_000,
    spend_total_value: index * 500_000,
    spend_total_rank: index + 1,
    spend_total_observed_at: 100_000,
    sort_legend_value: index,
    sort_spend_usd: index,
    sort_estimated_pulls: index,
    sort_exchange_count: index,
    sort_probability: index
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

function seedHistory(environment, days = 90) {
  const rows = [];
  for (let index = 0; index < days; index += 1) {
    const dayStartAt = 1_000_000 + index * 86_400_000;
    const row = {
      season_id: 'season-1',
      day_start_at: dayStartAt,
      user_id: 'u-1',
      user_name: 'Alice',
      avatar_url: '',
      is_vip: 0,
      active_name_decoration: null,
      name_display_preference: null,
      observed_at: dayStartAt + 1_000,
      source_scopes: 'global'
    };
    for (const key of COMPACT_BOARD_KEYS) {
      row[`${key}_value`] = null;
      row[`${key}_rank`] = null;
      row[`${key}_observed_at`] = null;
    }
    for (const key of ['epic_total', 'epic_month', 'epic_week', 'epic_today']) {
      row[`${key}_value`] = index + 1;
      row[`${key}_rank`] = index + 1;
      row[`${key}_observed_at`] = dayStartAt + 1_000;
    }
    rows.push(row);
  }
  const sql = `INSERT INTO rank_user_days (${USER_DAY_COLUMNS.join(', ')}) VALUES (${USER_DAY_COLUMNS.map(() => '?').join(', ')})`;
  for (const row of rows) {
    environment.RANKINGS_DB.run(sql, USER_DAY_COLUMNS.map((column) => row[column] ?? null));
  }
  environment.RANKINGS_DB.run(
    `INSERT INTO rank_seasons (season_id, season_name, last_observed_at, last_day_start_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
    ['season-1', 'Season 1', rows.at(-1).observed_at, rows.at(-1).day_start_at, rows.at(-1).observed_at]
  );
}

function snapshotAt(capturedAt, values = {}) {
  const epic = values.epic ?? 10;
  const spend = values.spend ?? 500_000;
  return {
    season: { id: 'season-1', name: 'Season 1' },
    scope: 'global',
    capturedAt,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: 'Alice', value: epic, rank: 2, isVip: false }],
      spend_total: [{ userId: 'u-1', userName: 'Alice', value: spend, rank: 3, isVip: false }]
    }
  };
}

async function postSnapshot(environment, snapshot) {
  return handleRankingsRequest(new Request('https://card.test/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ snapshots: [snapshot] })
  }), environment);
}

test('stores one user-day row without snapshots, entries, raw_json, or fingerprint', async () => {
  const environment = compactEnv();
  const first = await postSnapshot(environment, snapshotAt(10_000));
  const second = await postSnapshot(environment, snapshotAt(10_000));
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(environment.RANKINGS_DB.userDays.length, 1);
  assert.equal(environment.RANKINGS_DB.currentUsers.length, 1);
  assert.equal(environment.RANKINGS_DB.userDays[0].raw_json, undefined);
  assert.equal(environment.RANKINGS_DB.userDays[0].fingerprint, undefined);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /rank_snapshots|rank_entries|raw_json|fingerprint/i.test(sql)), false);
});

test('updates only changed fields and preserves a single row on a new capture', async () => {
  const environment = compactEnv();
  await postSnapshot(environment, snapshotAt(10_000, { epic: 10, spend: 500_000 }));
  await postSnapshot(environment, snapshotAt(11_000, { epic: 12, spend: 500_000 }));
  assert.equal(environment.RANKINGS_DB.userDays.length, 1);
  assert.equal(environment.RANKINGS_DB.userDays[0].epic_total_value, 12);
  assert.equal(environment.RANKINGS_DB.userDays[0].spend_total_value, 500_000);
  assert.equal(environment.RANKINGS_DB.userDays[0].spend_total_observed_at, 10_000);
});

test('creates a second daily row only after the Beijing 04:00 boundary', async () => {
  const environment = compactEnv();
  await postSnapshot(environment, snapshotAt(Date.parse('2026-08-25T03:59:00+08:00')));
  await postSnapshot(environment, snapshotAt(Date.parse('2026-08-25T04:01:00+08:00')));
  assert.equal(environment.RANKINGS_DB.userDays.length, 2);
});

test('latest reads only rank_seasons', async () => {
  const environment = compactEnv();
  seedSeason(environment);
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/latest'), environment);
  assert.equal(response.status, 200);
  assert.equal(environment.RANKINGS_DB.queries.some(({ sql }) => /rank_user_days|rank_user_current/i.test(sql)), false);
  assert.ok(environment.RANKINGS_DB.queries.some(({ sql }) => /from rank_seasons/i.test(sql)));
});

test('empty leaderboard exposes a zero total user count', async () => {
  const environment = compactEnv();
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?board=users&period=total&limit=50'), environment);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.rows.length, 0);
  assert.deepEqual(body.pinnedRows, []);
  assert.equal(body.totalRows, 0);
  assert.equal(body.hasMore, false);
});

test('leaderboard returns one page and an opaque cursor', async () => {
  const environment = compactEnv();
  seedSeason(environment);
  for (let index = 0; index < 120; index += 1) seedCurrentUser(environment, `u-${index}`, index);

  const first = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?board=users&period=total&sort=user&limit=50'), environment);
  const firstBody = await first.json();
  assert.equal(first.status, 200);
  assert.equal(firstBody.rows.length, 50);
  assert.equal(firstBody.totalRows, 120);
  assert.equal(firstBody.hasMore, true);
  assert.ok(firstBody.nextCursor);
  assert.match(environment.RANKINGS_DB.queries.at(-1).sql, /limit \?/i);

  const second = await handleRankingsRequest(new Request(`https://card.test/api/rankings/leaderboard?board=users&period=total&sort=user&limit=50&cursor=${encodeURIComponent(firstBody.nextCursor)}`), environment);
  const secondBody = await second.json();
  assert.equal(secondBody.rows[0].userId, 'u-50');
  assert.equal(secondBody.totalRows, 120);
});

test('leaderboard returns pinned rows with their global ranks in the same response', async () => {
  const environment = compactEnv();
  seedSeason(environment);
  for (let index = 0; index < 120; index += 1) seedCurrentUser(environment, `u-${index}`, index);

  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/leaderboard?board=users&period=total&sort=legend&direction=desc&limit=50&pinned=u-100,u-110,u-69'), environment);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.rows.length, 50);
  assert.deepEqual(body.pinnedRows.map((row) => ({ userId: row.userId, rank: row.rank })), [
    { userId: 'u-100', rank: 20 },
    { userId: 'u-110', rank: 10 },
    { userId: 'u-69', rank: 51 }
  ]);
  assert.equal(body.totalRows, 120);
  assert.equal(environment.RANKINGS_DB.queries.filter(({ sql }) => /WITH ranked/i.test(sql)).length, 1);
});

test('history reads only one user day row per requested day', async () => {
  const environment = compactEnv();
  seedHistory(environment);
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/history?userId=u-1&board=epic&since=1&until=9999999999999&limit=30'), environment);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.rows.length, 30 * 4);
  assert.equal(body.hasMore, true);
  assert.ok(body.nextCursor);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => /from rank_user_days/i.test(sql));
  assert.match(query.sql, /user_id = \?/i);
  assert.doesNotMatch(environment.RANKINGS_DB.queries.at(-1).sql, /rank_snapshots|rank_entries|raw_json/i);
});

test('history default range aligns to Beijing day boundaries', async () => {
  const environment = compactEnv();
  seedHistory(environment, 1);
  const latest = Date.parse('2026-08-25T03:30:00+08:00');
  environment.RANKINGS_DB.run(
    `UPDATE rank_seasons SET last_observed_at = ?, updated_at = ? WHERE season_id = 'season-1'`,
    [latest, latest]
  );
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/history?userId=u-1&limit=1'), environment);
  assert.equal(response.status, 200);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => /from rank_user_days/i.test(sql));
  assert.equal(query.params[2], Date.parse('2026-07-26T04:00:00+08:00'));
  assert.equal(query.params[3], Date.parse('2026-08-24T04:00:00+08:00'));
});

test('history rejects the removed snapshot mode', async () => {
  const environment = compactEnv();
  seedHistory(environment, 1);
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/history?userId=u-1&mode=snapshot'), environment);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_history_mode');
});

test('events reject the users overview board instead of querying a missing column', async () => {
  const environment = compactEnv();
  seedHistory(environment, 1);
  const response = await handleRankingsRequest(new Request('https://card.test/api/rankings/events?board=users'), environment);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, 'invalid_event_board');
});
