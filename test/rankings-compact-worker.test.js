import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { handleRankingsRequest } from '../src/rankings-worker.js';

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
