import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  mergeUserObservations,
  mergeMetricField,
  hasMeaningfulUserChange,
  shouldSkipSourceCapture,
  storeUserObservations
} from '../src/rankings-user-store.js';

const SCHEMA = await readFile(new URL('../migrations-v2/0001_compact_rankings.sql', import.meta.url), 'utf8');

class SqliteStatement {
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
    return this.db.prepare(this.sql).get(...this.params) || null;
  }

  run() {
    const result = this.db.prepare(this.sql).run(...this.params);
    return { meta: { changes: Number(result.changes || 0) } };
  }
}

class SqliteDb {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(SCHEMA);
  }

  prepare(sql) {
    return new SqliteStatement(this.db, sql);
  }

  async batch(statements) {
    return statements.map((statement) => statement.run());
  }
}

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

test('partial source uploads preserve a non-null observation timestamp for newly added metrics', async () => {
  const db = new SqliteDb();
  await storeUserObservations(db, [normalizedSnapshot('global', 10_000, [
    entry('spend_total', 'u1', 500_000, 3)
  ])], 'test', 10_000);
  await storeUserObservations(db, [normalizedSnapshot('friends', 11_000, [
    entry('epic_total', 'u1', 12, 1)
  ])], 'test', 11_000);

  const row = db.db.prepare(`
    SELECT epic_total_value, epic_total_rank, epic_total_observed_at
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.deepEqual({ ...row }, {
    epic_total_value: 12,
    epic_total_rank: 1,
    epic_total_observed_at: 11_000
  });
});

test('a late older source does not overwrite the latest user profile', async () => {
  const db = new SqliteDb();
  await storeUserObservations(db, [normalizedSnapshot('global', 20_000, [
    entry('spend_total', 'u1', 500_000, 3, { userName: 'Alice' })
  ])], 'test', 20_000);
  await storeUserObservations(db, [normalizedSnapshot('friends', 30_000, [
    entry('epic_total', 'u1', 12, 1, { userName: 'Bob' })
  ])], 'test', 30_000);
  await storeUserObservations(db, [normalizedSnapshot('global', 25_000, [
    entry('sets_total', 'u1', 4, 2, { userName: 'Carol' })
  ])], 'test', 25_000);

  const row = db.db.prepare(`
    SELECT user_name
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.user_name, 'Bob');
});
