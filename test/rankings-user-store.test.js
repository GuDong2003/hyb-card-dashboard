import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import {
  mergeUserObservations,
  mergeMetricField,
  hasMeaningfulUserChange,
  shouldSkipSourceCapture,
  storeUserObservations,
  AUTO_SETS_FINAL_CLAIM_SQL
} from '../src/rankings-user-store.js';

const SCHEMA = `${await readFile(new URL('../migrations-v2/0001_compact_rankings.sql', import.meta.url), 'utf8')}
ALTER TABLE rank_metric_ingest_state ADD COLUMN final_window_start_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rank_metric_ingest_state ADD COLUMN final_retry_count INTEGER NOT NULL DEFAULT 0;`;

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

test('automatic ingest uses one shared three-hour source window while manual ingest stays immediate', async () => {
  const db = new SqliteDb();
  const automaticAt = 100_000;
  const first = await storeUserObservations(db, [normalizedSnapshot('global', 10_000, [
    entry('epic_total', 'u1', 10, 2)
  ])], { mode: 'automatic' }, automaticAt);
  assert.equal(first.skippedScopes.length, 0);

  const blocked = await storeUserObservations(db, [normalizedSnapshot('global', 11_000, [
    entry('epic_total', 'u1', 12, 1)
  ])], { mode: 'automatic' }, automaticAt + 1_000);
  assert.equal(blocked.skippedScopes.length, 1);
  assert.equal(blocked.skippedScopes[0].reason, 'automatic_cooldown');
  assert.equal(db.db.prepare(`SELECT epic_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().epic_total_value, 10);

  const manual = await storeUserObservations(db, [normalizedSnapshot('global', 11_000, [
    entry('epic_total', 'u1', 12, 1)
  ])], { mode: 'manual' }, automaticAt + 2_000);
  assert.equal(manual.skippedScopes.length, 0);
  assert.equal(db.db.prepare(`SELECT epic_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().epic_total_value, 12);
  const stateAfterManual = db.db.prepare(`SELECT last_captured_at, updated_at FROM rank_ingest_state WHERE scope = 'global'`).get();
  assert.deepEqual({ ...stateAfterManual }, { last_captured_at: 11_000, updated_at: automaticAt });

  const afterWindow = await storeUserObservations(db, [normalizedSnapshot('global', 12_000, [
    entry('epic_total', 'u1', 13, 1)
  ])], { mode: 'automatic' }, automaticAt + 3 * 60 * 60 * 1_000);
  assert.equal(afterWindow.skippedScopes.length, 0);
  assert.equal(db.db.prepare(`SELECT epic_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().epic_total_value, 13);
});

test('automatic sets data follows the three-hour cadence before 08:00 without blocking epic or spend', async () => {
  const db = new SqliteDb();
  const beforeEight = Date.parse('2026-08-25T07:00:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', beforeEight, [
    entry('sets_total', 'u1', 1, 10),
    entry('epic_total', 'u1', 10, 2),
    entry('spend_total', 'u1', 500_000, 3)
  ])], { mode: 'automatic' }, beforeEight);

  const row = db.db.prepare(`
    SELECT sets_total_value, epic_total_value, spend_total_value
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 1);
  assert.equal(row.epic_total_value, 10);
  assert.equal(row.spend_total_value, 500_000);
});

test('automatic sets data follows three-hour refreshes before 08:00 and a fixed final refresh at 08:00', async () => {
  const db = new SqliteDb();
  const beforeEight = Date.parse('2026-08-25T07:00:00+08:00');
  const afterEight = Date.parse('2026-08-25T08:30:00+08:00');
  const laterSameDay = Date.parse('2026-08-25T12:00:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', beforeEight, [
    entry('sets_total', 'u1', 1, 10),
    entry('epic_total', 'u1', 10, 2),
    entry('spend_total', 'u1', 500_000, 3)
  ])], { mode: 'automatic' }, beforeEight);

  let row = db.db.prepare(`
    SELECT sets_total_value, epic_total_value, spend_total_value
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 1);
  assert.equal(row.epic_total_value, 10);
  assert.equal(row.spend_total_value, 500_000);

  await storeUserObservations(db, [normalizedSnapshot('global', afterEight, [
    entry('sets_total', 'u1', 2, 8),
    entry('epic_total', 'u1', 12, 1),
    entry('spend_total', 'u1', 600_000, 2)
  ])], { mode: 'automatic', finalSets: true }, afterEight);
  row = db.db.prepare(`
    SELECT sets_total_value, epic_total_value, spend_total_value
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 2);
  assert.equal(row.epic_total_value, 10);
  assert.equal(row.spend_total_value, 500_000);

  await storeUserObservations(db, [normalizedSnapshot('global', laterSameDay, [
    entry('sets_total', 'u1', 3, 7),
    entry('epic_total', 'u1', 12, 1),
    entry('spend_total', 'u1', 600_000, 2)
  ])], { mode: 'automatic', finalSets: true }, laterSameDay);
  row = db.db.prepare(`
    SELECT sets_total_value, epic_total_value, spend_total_value
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 2);
  assert.equal(row.epic_total_value, 12);
  assert.equal(row.spend_total_value, 600_000);

  const nextDay = Date.parse('2026-08-26T08:30:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', nextDay, [
    entry('sets_total', 'u1', 4, 6),
    entry('epic_total', 'u1', 14, 1),
    entry('spend_total', 'u1', 700_000, 1)
  ])], { mode: 'automatic', finalSets: true }, nextDay);
  row = db.db.prepare(`
    SELECT sets_total_value, epic_total_value, spend_total_value
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 4);
  assert.equal(row.epic_total_value, 14);
  assert.equal(row.spend_total_value, 700_000);
});

test('manual sets refresh before 08:00 does not close the later automatic window', async () => {
  const db = new SqliteDb();
  const beforeEight = Date.parse('2026-08-25T07:00:00+08:00');
  const manualAt = Date.parse('2026-08-25T07:30:00+08:00');
  const afterEight = Date.parse('2026-08-25T08:30:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', beforeEight, [
    entry('sets_total', 'u1', 1, 10)
  ])], { mode: 'automatic' }, beforeEight);
  await storeUserObservations(db, [normalizedSnapshot('global', manualAt, [
    entry('sets_total', 'u1', 2, 8)
  ])], { mode: 'manual' }, manualAt);
  await storeUserObservations(db, [normalizedSnapshot('global', afterEight, [
    entry('sets_total', 'u1', 3, 7)
  ])], { mode: 'automatic', finalSets: true }, afterEight);

  const row = db.db.prepare(`
    SELECT sets_total_value, sets_total_observed_at
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 3);
  assert.equal(row.sets_total_observed_at, afterEight);
});

test('manual sets refresh after 08:00 does not close the daily automatic final window', async () => {
  const db = new SqliteDb();
  const manualAt = Date.parse('2026-08-25T09:00:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', manualAt, [
    entry('sets_total', 'u1', 3, 7)
  ])], { mode: 'manual' }, manualAt);
  const laterAutomaticAt = Date.parse('2026-08-25T12:00:00+08:00');
  const accepted = await storeUserObservations(db, [normalizedSnapshot('global', laterAutomaticAt, [
    entry('sets_total', 'u1', 4, 6)
  ])], { mode: 'automatic', finalSets: true }, laterAutomaticAt);

  const row = db.db.prepare(`
    SELECT sets_total_value, sets_total_observed_at
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(row.sets_total_value, 4);
  assert.equal(row.sets_total_observed_at, laterAutomaticAt);
  assert.equal(accepted.skippedMetrics.length, 0);
});

test('fixed sets final refresh allows only one retry after a failed write', async () => {
  const db = new SqliteDb();
  const finalAt = Date.parse('2026-08-25T08:00:00+08:00');
  const snapshots = [normalizedSnapshot('global', finalAt, [
    entry('sets_total', 'u1', 2, 8)
  ])];
  const originalBatch = db.batch.bind(db);
  let failBatch = true;
  db.batch = async (statements) => {
    if (failBatch) throw new Error('simulated_final_sets_failure');
    return originalBatch(statements);
  };

  await assert.rejects(
    storeUserObservations(db, snapshots, { mode: 'automatic', finalSets: true }, finalAt),
    /simulated_final_sets_failure/
  );
  let state = db.db.prepare(`
    SELECT window_start_at, final_window_start_at, final_retry_count
    FROM rank_metric_ingest_state
    WHERE season_id = 'season-1' AND scope = 'global' AND metric = 'sets'
  `).get();
  assert.deepEqual({ ...state }, {
    window_start_at: 0,
    final_window_start_at: Date.parse('2026-08-25T08:00:00+08:00'),
    final_retry_count: 0
  });

  failBatch = false;
  const retry = await storeUserObservations(db, snapshots, {
    mode: 'automatic',
    finalSets: true,
    setsFinalRetry: true
  }, finalAt + 60 * 60 * 1000);
  assert.equal(retry.skippedMetrics.length, 0);
  assert.equal(db.db.prepare(`SELECT sets_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().sets_total_value, 2);

  state = db.db.prepare(`
    SELECT window_start_at, final_window_start_at, final_retry_count
    FROM rank_metric_ingest_state
    WHERE season_id = 'season-1' AND scope = 'global' AND metric = 'sets'
  `).get();
  assert.deepEqual({ ...state }, {
    window_start_at: Date.parse('2026-08-25T08:00:00+08:00'),
    final_window_start_at: Date.parse('2026-08-25T08:00:00+08:00'),
    final_retry_count: 1
  });

  const blocked = await storeUserObservations(db, [normalizedSnapshot('global', finalAt + 2 * 60 * 60 * 1000, [
    entry('sets_total', 'u1', 3, 7)
  ])], { mode: 'automatic', finalSets: true, setsFinalRetry: true }, finalAt + 2 * 60 * 60 * 1000);
  assert.equal(blocked.skippedMetrics[0].reason, 'sets_daily_window');
});

test('a temporary first-final claim keeps the completed window recoverable', () => {
  const db = new SqliteDb();
  const finalAt = Date.parse('2026-08-25T08:00:00+08:00');
  const result = db.prepare(AUTO_SETS_FINAL_CLAIM_SQL).bind(
    'season-1',
    'global',
    'sets',
    0,
    finalAt,
    finalAt,
    0,
    finalAt
  ).run();
  assert.equal(result.meta.changes, 1);
  const state = db.db.prepare(`
    SELECT window_start_at, final_window_start_at, final_retry_count
    FROM rank_metric_ingest_state
    WHERE season_id = 'season-1' AND scope = 'global' AND metric = 'sets'
  `).get();
  assert.deepEqual({ ...state }, {
    window_start_at: 0,
    final_window_start_at: finalAt,
    final_retry_count: 0
  });
});

test('automatic sets claim is released when the user write fails', async () => {
  const db = new SqliteDb();
  const automaticAt = Date.parse('2026-08-25T08:30:00+08:00');
  const snapshots = [normalizedSnapshot('global', automaticAt, [
    entry('sets_total', 'u1', 2, 8)
  ])];
  const originalBatch = db.batch.bind(db);
  let failBatch = true;
  db.batch = async (statements) => {
    if (failBatch) throw new Error('simulated_sets_batch_failure');
    return originalBatch(statements);
  };

  await assert.rejects(
    storeUserObservations(db, snapshots, { mode: 'automatic', finalSets: true }, automaticAt),
    /simulated_sets_batch_failure/
  );
  const failedState = db.db.prepare(`
    SELECT window_start_at, last_captured_at, updated_at
    FROM rank_metric_ingest_state
    WHERE season_id = 'season-1' AND scope = 'global' AND metric = 'sets'
  `).get();
  assert.deepEqual({ ...failedState }, { window_start_at: 0, last_captured_at: 0, updated_at: 0 });

  failBatch = false;
  await storeUserObservations(db, snapshots, {
    mode: 'automatic',
    finalSets: true,
    setsFinalRetry: true
  }, automaticAt + 1_000);
  assert.equal(db.db.prepare(`SELECT sets_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().sets_total_value, 2);
});

test('manual ingest still rejects an already accepted season scope capture', async () => {
  const db = new SqliteDb();
  await storeUserObservations(db, [normalizedSnapshot('global', 10_000, [
    entry('epic_total', 'u1', 10, 2)
  ])], { mode: 'manual' }, 100_000);
  const duplicate = await storeUserObservations(db, [normalizedSnapshot('global', 10_000, [
    entry('epic_total', 'u1', 12, 1)
  ])], { mode: 'manual' }, 101_000);
  assert.equal(duplicate.skippedScopes.length, 1);
  assert.equal(duplicate.skippedScopes[0].reason, 'duplicate_capture');
  assert.equal(db.db.prepare(`SELECT epic_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().epic_total_value, 10);
});

test('failed automatic writes do not advance the completed capture watermark', async () => {
  const db = new SqliteDb();
  const originalBatch = db.batch.bind(db);
  let failBatch = true;
  db.batch = async (statements) => {
    if (failBatch) throw new Error('simulated_batch_failure');
    return originalBatch(statements);
  };

  const snapshots = [normalizedSnapshot('global', 10_000, [
    entry('epic_total', 'u1', 10, 2)
  ])];
  await assert.rejects(
    storeUserObservations(db, snapshots, { mode: 'automatic' }, 100_000),
    /simulated_batch_failure/
  );
  const failedState = db.db.prepare(`SELECT last_captured_at, updated_at FROM rank_ingest_state WHERE scope = 'global'`).get();
  assert.equal(Number(failedState && failedState.last_captured_at || 0), 0);

  failBatch = false;
  const retry = await storeUserObservations(db, snapshots, { mode: 'automatic' }, 101_000);
  assert.equal(retry.skippedScopes.length, 0);
  assert.equal(db.db.prepare(`SELECT epic_total_value FROM rank_user_current WHERE user_id = 'u1'`).get().epic_total_value, 10);
});

test('a later scope acquisition failure releases earlier automatic claims', async () => {
  const db = new SqliteDb();
  const originalPrepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const statement = originalPrepare(sql);
    if (!/SELECT last_captured_at, updated_at\s+FROM rank_ingest_state/i.test(sql)) return statement;
    const originalBind = statement.bind.bind(statement);
    statement.bind = (...params) => {
      if (params[1] === 'friends') throw new Error('simulated_scope_read_failure');
      return originalBind(...params);
    };
    return statement;
  };

  await assert.rejects(storeUserObservations(db, [
    normalizedSnapshot('global', 10_000, [entry('epic_total', 'u1', 10, 2)]),
    normalizedSnapshot('friends', 10_000, [entry('epic_total', 'u2', 8, 3)])
  ], { mode: 'automatic' }, 100_000), /simulated_scope_read_failure/);

  const globalState = db.db.prepare(`SELECT last_captured_at, updated_at FROM rank_ingest_state WHERE scope = 'global'`).get();
  assert.deepEqual({ ...globalState }, { last_captured_at: 0, updated_at: 0 });
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

test('a newer unpaired epic observation clears stale pull and probability sort values', async () => {
  const db = new SqliteDb();
  const firstDay = Date.parse('2026-08-13T10:00:00+08:00');
  const laterDay = Date.parse('2026-08-28T10:00:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', firstDay, [
    entry('epic_total', 'u1', 91, 1),
    entry('spend_total', 'u1', 33_000_000_000, 1)
  ])], { mode: 'manual' }, firstDay);

  const complete = db.db.prepare(`
    SELECT sort_estimated_pulls, sort_probability
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.notEqual(complete.sort_estimated_pulls, null);
  assert.notEqual(complete.sort_probability, null);

  await storeUserObservations(db, [normalizedSnapshot('global', laterDay, [
    entry('epic_total', 'u1', 227, 1)
  ])], { mode: 'manual' }, laterDay);

  const incomplete = db.db.prepare(`
    SELECT epic_total_value, spend_total_value,
      epic_total_observed_at, spend_total_observed_at,
      sort_spend_usd, sort_estimated_pulls, sort_probability
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(incomplete.epic_total_value, 227);
  assert.equal(incomplete.spend_total_value, 33_000_000_000);
  assert.equal(incomplete.epic_total_observed_at, laterDay);
  assert.equal(incomplete.spend_total_observed_at, firstDay);
  assert.equal(incomplete.sort_spend_usd, 66_000);
  assert.equal(incomplete.sort_estimated_pulls, null);
  assert.equal(incomplete.sort_probability, null);
});

test('a complete newer pair advances an unchanged epic observation without another write', async () => {
  const db = new SqliteDb();
  const firstDay = Date.parse('2026-08-27T10:00:00+08:00');
  const laterDay = Date.parse('2026-08-28T10:00:00+08:00');
  await storeUserObservations(db, [normalizedSnapshot('global', firstDay, [
    entry('epic_total', 'u1', 227, 1),
    entry('spend_total', 'u1', 33_000_000_000, 1)
  ])], { mode: 'manual' }, firstDay);

  const result = await storeUserObservations(db, [normalizedSnapshot('global', laterDay, [
    entry('epic_total', 'u1', 227, 1),
    entry('spend_total', 'u1', 34_000_000_000, 1)
  ])], { mode: 'manual' }, laterDay);

  const row = db.db.prepare(`
    SELECT epic_total_observed_at, spend_total_observed_at,
      sort_estimated_pulls, sort_probability
    FROM rank_user_current
    WHERE season_id = 'season-1' AND user_id = 'u1'
  `).get();
  assert.equal(result.changedUsers, 1);
  assert.equal(row.epic_total_observed_at, laterDay);
  assert.equal(row.spend_total_observed_at, laterDay);
  assert.notEqual(row.sort_estimated_pulls, null);
  assert.notEqual(row.sort_probability, null);
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
