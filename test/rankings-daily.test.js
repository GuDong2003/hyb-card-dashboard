import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aggregateRankingsDay,
  dayStartAtForCapturedAt,
  previousBeijingDayStart
} from '../src/rankings-daily.js';
import { scheduled } from '../src/index.js';
import { currentSortValues } from '../src/rankings-user-store.js';

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

  all() {
    return this.db.all(this.sql, this.params);
  }

  run() {
    return this.db.run(this.sql, this.params);
  }
}

class FakeDailyDb {
  constructor(snapshots = [], entries = []) {
    this.snapshots = snapshots;
    this.entries = entries;
    this.daily = [];
    this.queries = [];
  }

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async all(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queries.push({ sql: normalized, params: [...params] });
    const [startAt, endAt] = params;
    const snapshotsById = new Map(this.snapshots.map((row) => [row.id, row]));
    const selected = new Map();
    for (const entry of this.entries) {
      const snapshot = snapshotsById.get(entry.snapshot_id);
      if (!snapshot || snapshot.captured_at < startAt || snapshot.captured_at >= endAt) continue;
      const dayStartAt = dayStartAtForCapturedAt(snapshot.captured_at);
      const candidate = {
        ...entry,
        season_id: snapshot.season_id,
        day_start_at: dayStartAt,
        snapshot_id: snapshot.id,
        scope: snapshot.scope,
        captured_at: snapshot.captured_at
      };
      const key = `${candidate.season_id}\u0000${candidate.day_start_at}\u0000${candidate.user_id}\u0000${candidate.board_key}`;
      const existing = selected.get(key);
      if (!existing
        || candidate.captured_at > existing.captured_at
        || (candidate.captured_at === existing.captured_at && candidate.value > existing.value)
        || (candidate.captured_at === existing.captured_at && candidate.value === existing.value && candidate.snapshot_id > existing.snapshot_id)
        || (candidate.captured_at === existing.captured_at && candidate.value === existing.value && candidate.snapshot_id === existing.snapshot_id && candidate.rank < existing.rank)) {
        selected.set(key, candidate);
      }
    }
    return { results: Array.from(selected.values()) };
  }

  async batch(statements) {
    for (const statement of statements) await statement.run();
    return { success: true };
  }

  async run(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized.startsWith('insert into rank_daily_metrics')) return { success: true, meta: { changes: 0 } };
    const [season_id, day_start_at, user_id, board_key, user_name, avatar_url,
      value, rank, is_vip, active_name_decoration, name_display_preference,
      snapshot_id, scope, captured_at] = params;
    const next = {
      season_id, day_start_at, user_id, board_key, user_name, avatar_url,
      value, rank, is_vip, active_name_decoration, name_display_preference,
      snapshot_id, scope, captured_at
    };
    const index = this.daily.findIndex((row) => row.season_id === season_id
      && row.day_start_at === day_start_at
      && row.user_id === user_id
      && row.board_key === board_key);
    if (index >= 0) this.daily[index] = next;
    else this.daily.push(next);
    return { success: true, meta: { changes: 1 } };
  }
}

class CompactMaintenanceStatement {
  constructor(db, sql) {
    this.db = db;
    this.sql = sql;
    this.params = [];
  }

  bind(...params) {
    this.params = params;
    return this;
  }

  all() {
    return this.db.all(this.sql, this.params);
  }

  run() {
    return this.db.run(this.sql, this.params);
  }
}

class CompactMaintenanceDb {
  constructor(rows = []) {
    this.current = rows.map((row) => ({ ...row }));
    this.seasons = [{
      season_id: 's1',
      last_day_start_at: 0,
      updated_at: 0
    }];
    this.queries = [];
  }

  prepare(sql) {
    return new CompactMaintenanceStatement(this, sql);
  }

  async all(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queries.push({ sql: normalized, params: [...params] });
    if (normalized.includes('from rank_user_current')) return { results: this.current.map((row) => ({ ...row })) };
    return { results: [] };
  }

  async batch(statements) {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }

  async run(sql, params) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    this.queries.push({ sql: normalized, params: [...params] });
    if (normalized.startsWith('update rank_user_current')) {
      const [legend, spend, pulls, sets, probability, seasonId, userId] = params;
      const row = this.current.find((item) => item.season_id === seasonId && item.user_id === userId);
      if (!row) return { success: true, meta: { changes: 0 } };
      Object.assign(row, {
        sort_legend_value: legend,
        sort_spend_usd: spend,
        sort_estimated_pulls: pulls,
        sort_exchange_count: sets,
        sort_probability: probability
      });
      return { success: true, meta: { changes: 1 } };
    }
    if (normalized.startsWith('update rank_seasons')) {
      const [dayStartAt, updatedAt, seasonId] = params;
      const season = this.seasons.find((item) => item.season_id === seasonId);
      if (season) {
        season.last_day_start_at = Math.max(Number(season.last_day_start_at), Number(dayStartAt));
        season.updated_at = Math.max(Number(season.updated_at), Number(updatedAt));
      }
      return { success: true, meta: { changes: season ? 1 : 0 } };
    }
    return { success: true, meta: { changes: 0 } };
  }
}

function snapshot(id, seasonId, capturedAt, scope = 'global') {
  return { id, season_id: seasonId, captured_at: capturedAt, scope };
}

function entry(snapshotId, boardKey, userId, value, rank, userName = userId) {
  return {
    snapshot_id: snapshotId,
    board_key: boardKey,
    user_id: userId,
    user_name: userName,
    avatar_url: '',
    value,
    rank,
    is_vip: 0,
    active_name_decoration: null,
    name_display_preference: null
  };
}

test('maps captures to a Beijing day starting at 04:00', () => {
  assert.equal(
    dayStartAtForCapturedAt(Date.parse('2026-08-25T03:59:59+08:00')),
    Date.parse('2026-08-24T04:00:00+08:00')
  );
  assert.equal(
    dayStartAtForCapturedAt(Date.parse('2026-08-25T04:00:00+08:00')),
    Date.parse('2026-08-25T04:00:00+08:00')
  );
});

test('previous Beijing day closes at 04:00', () => {
  assert.equal(
    previousBeijingDayStart(Date.parse('2026-08-25T05:00:00+08:00')),
    Date.parse('2026-08-24T04:00:00+08:00')
  );
});

test('scheduled maintenance never queries legacy ranking tables', async () => {
  const row = {
    season_id: 's1',
    user_id: 'u1',
    spend_total_value: 500_000,
    epic_total_value: 10,
    sets_total_value: 3,
    is_vip: 0,
    last_observed_at: 10_000,
    sort_legend_value: null,
    sort_spend_usd: null,
    sort_estimated_pulls: null,
    sort_exchange_count: null,
    sort_probability: null
  };
  const db = new CompactMaintenanceDb([row]);
  const result = await scheduled({ scheduledTime: Date.parse('2026-08-25T04:05:00+08:00') }, { RANKINGS_DB: db });
  assert.equal(result.usersScanned, 1);
  assert.ok(db.queries.some(({ sql }) => /from rank_user_current/i.test(sql)));
  assert.equal(db.queries.some(({ sql }) => /rank_snapshots|rank_entries|rank_daily_metrics|raw_json/i.test(sql)), false);
  assert.deepEqual(
    [db.current[0].sort_legend_value, db.current[0].sort_spend_usd, db.current[0].sort_estimated_pulls, db.current[0].sort_exchange_count, db.current[0].sort_probability],
    Object.values(currentSortValues(db.current[0], db.current[0].last_observed_at))
  );
});

test('aggregateRankingsDay writes one representative per season/day/user/board and can repeat', async () => {
  const db = new FakeDailyDb([
    snapshot(1, 's1', Date.parse('2026-08-24T05:00:00+08:00')),
    snapshot(2, 's1', Date.parse('2026-08-24T06:00:00+08:00'))
  ], [
    entry(1, 'epic_total', 'u1', 10, 2),
    entry(2, 'epic_total', 'u1', 12, 1)
  ]);
  const day = Date.parse('2026-08-24T04:00:00+08:00');
  await aggregateRankingsDay(db, day);
  await aggregateRankingsDay(db, day);
  assert.equal(db.daily.length, 1);
  assert.equal(db.daily[0].value, 12);
  assert.equal(db.daily[0].snapshot_id, 2);
});

test('daily aggregation SQL never selects raw_json and is bounded to one day', async () => {
  const db = new FakeDailyDb();
  await aggregateRankingsDay(db, Date.parse('2026-08-24T04:00:00+08:00'));
  assert.doesNotMatch(db.queries[0].sql, /raw_json/);
  assert.match(db.queries[0].sql, /captured_at\s*>=\s*\?/);
  assert.match(db.queries[0].sql, /captured_at\s*<\s*\?/);
  assert.deepEqual(db.queries[0].params, [
    Date.parse('2026-08-24T04:00:00+08:00'),
    Date.parse('2026-08-25T04:00:00+08:00')
  ]);
});
