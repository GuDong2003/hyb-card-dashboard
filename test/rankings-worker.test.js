import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRankingsRequest } from '../src/rankings-worker.js';
import { mergeMetric } from '../src/rankings-merge.js';
import { dayStartAtForCapturedAt } from '../src/rankings-daily.js';

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
    this.daily = [];
    this.nextSnapshotId = 1;
    this.queries = [];
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
    if (normalized.includes('where season_id = ? and scope = ?')
      && normalized.includes('order by captured_at desc, id desc')
      && !normalized.includes('captured_at < ?')) {
      const [seasonId, scope] = params;
      return this.snapshots
        .filter((row) => row.season_id === seasonId && row.scope === scope)
        .sort((a, b) => b.captured_at - a.captured_at || b.id - a.id)[0] || null;
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
    this.queries.push({ sql: normalized, params: [...params] });
    if (normalized.includes('from rank_daily_metrics')) {
      return { results: fakeDailyQueryRows(this, normalized, params) };
    }
    if (normalized.includes('from rank_user_metrics') && normalized.includes('like ?')) {
      const [seasonId, firstPattern] = params;
      const pattern = String(firstPattern || '')
        .replace(/^%|%$/g, '')
        .replaceAll('\\%', '%')
        .replaceAll('\\_', '_')
        .replaceAll('\\\\', '\\')
        .toLowerCase();
      const matched = this.metrics
        .filter((row) => row.season_id === seasonId)
        .filter((row) => String(row.user_id).toLowerCase().includes(pattern)
          || String(row.user_name).toLowerCase().includes(pattern))
        .sort((left, right) => Number(right.last_captured_at) - Number(left.last_captured_at));
      const users = [];
      const seen = new Set();
      for (const row of matched) {
        if (seen.has(row.user_id)) continue;
        seen.add(row.user_id);
        users.push({
          user_id: row.user_id,
          user_name: row.user_name,
          avatar_url: row.avatar_url,
          is_vip: row.is_vip,
          last_seen_at: row.last_captured_at
        });
      }
      return { results: users.slice(0, 20) };
    }
    if (normalized.includes('with current_rows')
      && normalized.includes('from rank_entries e')
      && normalized.includes('board_key in')) {
      return { results: fakeCurrentRows(this, normalized, params) };
    }
    if (normalized.includes('with current_rows')
      && normalized.includes('from rank_entries e')
      && normalized.includes('e.user_id = ?')) {
      return { results: fakeCurrentRows(this, normalized, params) };
    }
    if (normalized.includes('with candidates')
      && normalized.includes('from rank_entries e')
      && normalized.includes('e.user_id = ?')) {
      return { results: fakeSnapshotHistoryRows(this, normalized, params) };
    }
    if (normalized.includes('with daily_rows') && normalized.includes('row_number() over')) {
      const [seasonId, ...rest] = params;
      const keys = rest.slice(0, 3);
      const rangeStartAt = rest.length > 3 ? Number(rest[3]) : null;
      const rangeEndAt = rest.length > 4 ? Number(rest[4]) : null;
      const snapshotsById = new Map(this.snapshots.map((row) => [row.id, row]));
      const selected = new Map();
      for (const entry of this.entries) {
        const snapshot = snapshotsById.get(entry.snapshot_id);
        if (!snapshot || snapshot.season_id !== seasonId || !keys.includes(entry.board_key)) continue;
        if (rangeStartAt != null && (snapshot.captured_at < rangeStartAt || snapshot.captured_at > rangeEndAt)) continue;
        const dayStartAt = Math.floor((snapshot.captured_at - RESET_HOUR_MS) / DAY_MS);
        const key = `${entry.user_id}\u0000${entry.board_key}\u0000${dayStartAt}`;
        const candidate = {
          ...entry,
          scope: snapshot.scope,
          captured_at: snapshot.captured_at,
          captured_bucket: snapshot.captured_bucket,
          snapshot_id: snapshot.id
        };
        const existing = selected.get(key);
        if (!existing
          || candidate.captured_at > existing.captured_at
          || (candidate.captured_at === existing.captured_at && candidate.value > existing.value)
          || (candidate.captured_at === existing.captured_at && candidate.value === existing.value && candidate.snapshot_id > existing.snapshot_id)
          || (candidate.captured_at === existing.captured_at && candidate.value === existing.value && candidate.snapshot_id === existing.snapshot_id && candidate.rank < existing.rank)) {
          selected.set(key, candidate);
        }
      }
      return {
        results: Array.from(selected.values()).sort((left, right) => left.captured_at - right.captured_at || left.rank - right.rank || left.snapshot_id - right.snapshot_id)
      };
    }
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
      const duplicate = this.snapshots.find((row) => row.season_id === season_id && row.signature === signature);
      if (duplicate && normalized.includes('on conflict (season_id, signature) do nothing')) {
        return { success: true, meta: { changes: 0, last_row_id: 0 } };
      }
      const row = { id: this.nextSnapshotId++, season_id, season_name, scope, captured_at, captured_bucket, source, signature, raw_json, created_at };
      this.snapshots.push(row);
      return { success: true, meta: { changes: 1, last_row_id: row.id } };
    }
    if (normalized.startsWith('insert into rank_entries')) {
      const [snapshot_id, board_key, user_id, user_name, avatar_url, value, rank, is_vip, active_name_decoration, name_display_preference, raw_json] = params;
      this.entries.push({ snapshot_id, board_key, user_id, user_name, avatar_url, value, rank, is_vip, active_name_decoration, name_display_preference, raw_json });
      return { success: true, meta: { last_row_id: this.entries.length } };
    }
    if (normalized.startsWith('insert into rank_user_metrics')) {
      this.queries.push({ sql: normalized, params: [...params] });
      const [season_id, user_id, board_key, user_name, avatar_url, value, rank,
        is_vip, active_name_decoration, name_display_preference,
        value_snapshot_id, value_scope, value_captured_at,
        last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes] = params;
      const index = this.metrics.findIndex((item) => item.season_id === season_id && item.user_id === user_id && item.board_key === board_key);
      const incoming = {
        seasonId: season_id,
        userId: user_id,
        boardKey: board_key,
        userName: user_name,
        avatar: avatar_url,
        value,
        rank,
        isVip: Boolean(is_vip),
        activeNameDecoration: active_name_decoration,
        nameDisplayPreference: name_display_preference,
        snapshotId: value_snapshot_id,
        scope: value_scope,
        capturedAt: value_captured_at,
        valueSnapshotId: value_snapshot_id,
        valueScope: value_scope,
        valueCapturedAt: value_captured_at,
        lastSnapshotId: last_snapshot_id,
        lastScope: last_scope,
        lastCapturedAt: last_captured_at,
        firstCapturedAt: first_captured_at,
        sourceScopes: source_scopes
      };
      const existing = index >= 0 ? this.metrics[index] : null;
      const merged = mergeMetric(existing ? {
        seasonId: existing.season_id,
        userId: existing.user_id,
        boardKey: existing.board_key,
        userName: existing.user_name,
        avatar: existing.avatar_url,
        value: existing.value,
        rank: existing.rank,
        isVip: Boolean(existing.is_vip),
        activeNameDecoration: existing.active_name_decoration,
        nameDisplayPreference: existing.name_display_preference,
        valueSnapshotId: existing.value_snapshot_id,
        valueScope: existing.value_scope,
        valueCapturedAt: existing.value_captured_at,
        lastSnapshotId: existing.last_snapshot_id,
        lastScope: existing.last_scope,
        lastCapturedAt: existing.last_captured_at,
        firstCapturedAt: existing.first_captured_at,
        sourceScopes: existing.source_scopes
      } : null, incoming);
      const row = {
        season_id: merged.seasonId,
        user_id: merged.userId,
        board_key: merged.boardKey,
        user_name: merged.userName,
        avatar_url: merged.avatar,
        value: merged.value,
        rank: merged.rank,
        is_vip: merged.isVip ? 1 : 0,
        active_name_decoration: merged.activeNameDecoration,
        name_display_preference: merged.nameDisplayPreference,
        value_snapshot_id: merged.valueSnapshotId,
        value_scope: merged.valueScope,
        value_captured_at: merged.valueCapturedAt,
        last_snapshot_id: merged.lastSnapshotId,
        last_scope: merged.lastScope,
        last_captured_at: merged.lastCapturedAt,
        first_captured_at: merged.firstCapturedAt,
        source_scopes: merged.sourceScopes
      };
      if (index >= 0) this.metrics[index] = row;
      else this.metrics.push(row);
      return { success: true, meta: { changes: 1, last_row_id: this.metrics.length } };
    }
    return { success: true, meta: {} };
  }
}

function fakeBoardMatches(boardKey, pattern) {
  if (!pattern) return true;
  return String(boardKey || '').startsWith(String(pattern).replace(/%$/, ''));
}

function fakeSnapshotRows(db, options = {}) {
  const snapshotsById = new Map(db.snapshots.map((row) => [row.id, row]));
  const rows = [];
  for (const entry of db.entries) {
    const snapshot = snapshotsById.get(entry.snapshot_id);
    if (!snapshot || (options.seasonId != null && snapshot.season_id !== options.seasonId)) continue;
    if (options.userId != null && entry.user_id !== options.userId) continue;
    if (options.boardKeys && !options.boardKeys.includes(entry.board_key)) continue;
    if (!fakeBoardMatches(entry.board_key, options.boardPattern)) continue;
    if (options.startAt != null && snapshot.captured_at < options.startAt) continue;
    if (options.endAt != null && snapshot.captured_at >= options.endAt) continue;
    if (options.maxAt != null && snapshot.captured_at > options.maxAt) continue;
    rows.push({
      ...entry,
      season_id: snapshot.season_id,
      season_name: snapshot.season_name,
      scope: snapshot.scope,
      captured_at: snapshot.captured_at,
      captured_bucket: snapshot.captured_bucket,
      snapshot_id: snapshot.id
    });
  }
  return rows;
}

function fakeLatestClosedDayStart(db) {
  const latestCapturedAt = db.snapshots.reduce(
    (latest, row) => Math.max(latest, Number(row.captured_at) || 0),
    0
  );
  return dayStartAtForCapturedAt(latestCapturedAt);
}

function fakeDailyCandidateCompare(left, right) {
  return Number(left.captured_at) - Number(right.captured_at)
    || Number(left.value) - Number(right.value)
    || Number(left.snapshot_id) - Number(right.snapshot_id)
    || Number(right.rank) - Number(left.rank);
}

function fakeMaterializedDailyRows(db, seasonId, startAt = null, endAt = null) {
  const selected = new Map();
  const closedBefore = fakeLatestClosedDayStart(db);
  for (const row of fakeSnapshotRows(db, { seasonId })) {
    const dayStartAt = dayStartAtForCapturedAt(row.captured_at);
    if (dayStartAt == null || (closedBefore != null && dayStartAt >= closedBefore)) continue;
    if (startAt != null && dayStartAt < startAt) continue;
    if (endAt != null && dayStartAt >= endAt) continue;
    const candidate = { ...row, day_start_at: dayStartAt };
    const key = `${row.season_id}\u0000${dayStartAt}\u0000${row.user_id}\u0000${row.board_key}`;
    const existing = selected.get(key);
    if (!existing || fakeDailyCandidateCompare(candidate, existing) > 0) selected.set(key, candidate);
  }
  for (const row of db.daily) {
    if (row.season_id !== seasonId) continue;
    if (startAt != null && row.day_start_at < startAt) continue;
    if (endAt != null && row.day_start_at >= endAt) continue;
    const key = `${row.season_id}\u0000${row.day_start_at}\u0000${row.user_id}\u0000${row.board_key}`;
    const existing = selected.get(key);
    if (!existing || fakeDailyCandidateCompare(row, existing) > 0) {
      selected.set(key, { ...row });
    }
  }
  return Array.from(selected.values());
}

function fakeDailyQueryRows(db, normalized, params) {
  if (normalized.includes('user_id = ?')) {
    let index = 0;
    const seasonId = params[index++];
    const userId = params[index++];
    const boardPattern = normalized.includes('board_key like ?') ? params[index++] : null;
    const since = Number(params[index++]);
    const until = Number(params[index++]);
    const rows = fakeMaterializedDailyRows(db, seasonId)
      .filter((row) => row.user_id === userId)
      .filter((row) => fakeBoardMatches(row.board_key, boardPattern))
      .filter((row) => row.captured_at >= since && row.captured_at <= until);
    if (normalized.includes('day_start_at > ?')) {
      const cursorStart = params.length - 1 - 10;
      const cursor = {
        dayStartAt: Number(params[cursorStart]),
        capturedAt: Number(params[cursorStart + 2]),
        snapshotId: Number(params[cursorStart + 5]),
        boardKey: String(params[cursorStart + 9])
      };
      rows.splice(0, rows.length, ...rows.filter((row) => fakeTupleAfter([
        Number(row.day_start_at), Number(row.captured_at), Number(row.snapshot_id), String(row.board_key)
      ], [cursor.dayStartAt, cursor.capturedAt, cursor.snapshotId, cursor.boardKey])));
    }
    rows.sort((left, right) => Number(left.day_start_at) - Number(right.day_start_at)
      || Number(left.captured_at) - Number(right.captured_at)
      || Number(left.snapshot_id) - Number(right.snapshot_id)
      || String(left.board_key).localeCompare(String(right.board_key)));
    const limit = Number(params[params.length - 1]);
    return rows.slice(0, limit);
  }

  if (normalized.includes('board_key = ?')) {
    const [seasonId, boardKey, since, until] = params;
    return fakeMaterializedDailyRows(db, seasonId)
      .filter((row) => row.board_key === boardKey
        && row.day_start_at >= Number(since)
        && row.day_start_at <= Number(until))
      .sort((left, right) => Number(left.day_start_at) - Number(right.day_start_at)
        || Number(left.rank) - Number(right.rank)
        || String(left.user_id).localeCompare(String(right.user_id)));
  }

  const seasonId = params[0];
  const keys = params.slice(1, 4);
  const hasLowerBound = normalized.includes('day_start_at >= ?');
  const startAt = hasLowerBound ? Number(params[4]) : null;
  const endAt = hasLowerBound ? Number(params[5]) : Number(params[4]);
  return fakeMaterializedDailyRows(db, seasonId, startAt, endAt)
    .filter((row) => keys.includes(row.board_key))
    .sort((left, right) => Number(left.day_start_at) - Number(right.day_start_at)
      || Number(left.captured_at) - Number(right.captured_at)
      || Number(left.rank) - Number(right.rank)
      || Number(left.snapshot_id) - Number(right.snapshot_id));
}

function fakeCurrentRows(db, normalized, params) {
  let index = 0;
  const seasonId = params[index++];
  const boardKeys = normalized.includes('board_key in') ? params.slice(index, index + 3) : null;
  if (boardKeys) index += 3;
  const userId = normalized.includes('e.user_id = ?') ? params[index++] : null;
  const boardPattern = normalized.includes('board_key like ?') ? params[index++] : null;
  const startAt = Number(params[index++]);
  const endAt = Number(params[index++]);
  const maxAt = Number(params[index++]);
  const selected = new Map();
  for (const row of fakeSnapshotRows(db, {
    seasonId,
    userId,
    boardKeys,
    boardPattern,
    startAt,
    endAt,
    maxAt
  })) {
    const key = `${row.user_id}\u0000${row.board_key}`;
    const existing = selected.get(key);
    if (!existing || Number(row.captured_at) > Number(existing.captured_at)
      || (Number(row.captured_at) === Number(existing.captured_at) && Number(row.value) > Number(existing.value))
      || (Number(row.captured_at) === Number(existing.captured_at) && Number(row.value) === Number(existing.value) && Number(row.snapshot_id) > Number(existing.snapshot_id))
      || (Number(row.captured_at) === Number(existing.captured_at) && Number(row.value) === Number(existing.value) && Number(row.snapshot_id) === Number(existing.snapshot_id) && Number(row.rank) < Number(existing.rank))) {
      selected.set(key, row);
    }
  }
  return Array.from(selected.values()).sort((left, right) => Number(left.captured_at) - Number(right.captured_at)
    || Number(left.rank) - Number(right.rank)
    || Number(left.snapshot_id) - Number(right.snapshot_id));
}

function fakeSnapshotHistoryRows(db, normalized, params) {
  let index = 0;
  const seasonId = params[index++];
  const userId = params[index++];
  const since = Number(params[index++]);
  const until = Number(params[index++]);
  const boardPattern = normalized.includes('board_key like ?') ? params[index++] : null;
  const candidates = fakeSnapshotRows(db, {
    seasonId,
    userId,
    boardPattern,
    startAt: since,
    endAt: until + 1
  });
  const selected = new Map();
  for (const row of candidates) {
    const key = `${row.board_key}\u0000${row.captured_bucket}`;
    const existing = selected.get(key);
    const rowIsTotal = String(row.board_key).endsWith('_total');
    const valueCompare = rowIsTotal ? Number(row.value) - Number(existing && existing.value) : 0;
    if (!existing || valueCompare > 0
      || (valueCompare === 0 && Number(row.captured_at) > Number(existing.captured_at))
      || (valueCompare === 0 && Number(row.captured_at) === Number(existing.captured_at) && Number(row.snapshot_id) > Number(existing.snapshot_id))
      || (valueCompare === 0 && Number(row.captured_at) === Number(existing.captured_at) && Number(row.snapshot_id) === Number(existing.snapshot_id) && Number(row.rank) < Number(existing.rank))) {
      selected.set(key, row);
    }
  }
  let rows = Array.from(selected.values()).sort((left, right) => Number(left.captured_at) - Number(right.captured_at)
    || Number(left.snapshot_id) - Number(right.snapshot_id)
    || String(left.board_key).localeCompare(String(right.board_key)));
  if (normalized.includes('captured_at > ?')) {
    const cursorStart = params.length - 1 - 6;
    const cursor = {
      capturedAt: Number(params[cursorStart]),
      snapshotId: Number(params[cursorStart + 2]),
      boardKey: String(params[cursorStart + 5])
    };
    rows = rows.filter((row) => fakeTupleAfter([
      Number(row.captured_at), Number(row.snapshot_id), String(row.board_key)
    ], [cursor.capturedAt, cursor.snapshotId, cursor.boardKey]));
  }
  return rows.slice(0, Number(params[params.length - 1]));
}

function fakeTupleAfter(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] === right[index]) continue;
    return left[index] > right[index];
  }
  return false;
}

function env(overrides = {}) {
  return { RANKINGS_DB: new FakeD1(), ...overrides };
}

function request(path, init) {
  return new Request(`https://card.gudong226.com${path}`, init);
}

function snapshotAt(capturedAt) {
  return {
    season: { id: 'season-write-test', name: '写入测试' },
    scope: 'global',
    capturedAt,
    leaderboards: {
      epic_total: [{ userId: 'u1', userName: '用户一', value: 10, rank: 1, isVip: false }]
    }
  };
}

function postSnapshot(environment, body) {
  return handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }), environment);
}

test('rejects stale snapshots before INSERT and leaves raw tables unchanged', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(10_000));
  const before = environment.RANKINGS_DB.snapshots.length;
  const response = await postSnapshot(environment, snapshotAt(9_000));
  const payload = await response.json();
  assert.equal(payload.status, 'rejected');
  assert.equal(payload.reason, 'stale_or_existing_data');
  assert.equal(environment.RANKINGS_DB.snapshots.length, before);
});

test('does not select the whole rank_user_metrics table during upload', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(10_000));
  assert.equal(
    environment.RANKINGS_DB.queries.some(({ sql }) => /select \* from rank_user_metrics/.test(sql)),
    false
  );
  assert.equal(
    environment.RANKINGS_DB.queries.some(({ sql }) => /insert into rank_user_metrics/.test(sql)),
    true
  );
});

test('returns 429 before parsing or writing when the limiter rejects the source', async () => {
  const environment = env({
    RANKINGS_WRITE_LIMITER: { limit: async () => ({ success: false }) }
  });
  const response = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
    body: '{'
  }), environment);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error, 'rate_limited');
  assert.equal(environment.RANKINGS_DB.snapshots.length, 0);
});

test('returns 503 when the D1 binding is missing', async () => {
  const response = await handleRankingsRequest(request('/api/rankings/latest'), {});
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.error, 'database_unavailable');
  assert.match(payload.message, /暂时不可用/);
  assert.equal(payload.retryable, true);
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
  // Keep this pairing test on the pre-boost schedule; the boost-specific
  // allocation is covered by rankings-core.test.js.
  const capturedAt = Date.parse('2026-08-10T05:00:00+08:00');
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
  assert.equal(row.paidPulls, 2_400);
  assert.equal(row.freePulls, 200);
  assert.equal(row.estimatedPulls, 2_600);
  assert.equal(row.estimatedLegendProbability, null);
  assert.equal(row.estimateStatus, 'missing_common_day');
  assert.equal(row.isPartial, true);
});

test('pairs the latest available rows within a day instead of requiring the same hour', async () => {
  const environment = env();
  const base = dayStartAtForCapturedAt(Date.now() - (2 * DAY_MS));
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

test('uses the latest complete common day when the newest common day is partial', async () => {
  const environment = env();
  const base = dayStartAtForCapturedAt(Date.now() - (3 * DAY_MS));
  const completeCapture = base + 60 * 60 * 1000;
  const partialCapture = base + DAY_MS + 60 * 60 * 1000;
  const post = (snapshot) => handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);

  await post({
    season: { id: 'season-complete-fallback', name: '完整日回退测试' },
    scope: 'global', capturedAt: completeCapture,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '回退用户', value: 30, rank: 1, isVip: true }],
      spend_total: [{ userId: 'u-1', userName: '回退用户', value: 12_000_000_000, rank: 1, isVip: true }]
    }
  });
  await post({
    season: { id: 'season-complete-fallback', name: '完整日回退测试' },
    scope: 'global', capturedAt: partialCapture,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '回退用户', value: 54, rank: 1, isVip: true }],
      spend_total: [{ userId: 'u-1', userName: '回退用户', value: 14_000_000_000, rank: 1, isVip: true }]
    }
  });

  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total'), environment);
  const payload = await response.json();
  const row = payload.rows.find((item) => item.userId === 'u-1');
  assert.equal(row.epicTotal, 30);
  assert.equal(row.spendUsd, 24_000);
  assert.equal(row.paidPulls, 2_400);
  assert.equal(row.freePulls, 200);
  assert.equal(row.estimatedPulls, 2_600);
  assert.equal(row.estimatedLegendProbability, 30 / 2_600);
  assert.equal(row.estimateStatus, 'complete_days');
  assert.equal(row.estimateDayStartAt, base);
  assert.equal(row.estimateUsesHistoricalData, true);
  assert.equal(row.isPartial, false);
});

test('converts spend values to USD and exposes a probability-ranked luck board', async () => {
  const environment = env();
  // Keep the fixture deterministic and avoid classifying a 6,000 USD sample
  // as a low sample under the post-boost 10,000 USD VIP daily cost.
  const capturedAt = Date.parse('2026-08-10T05:00:00+08:00');
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

test('uses the aggregate table for total users and compresses raw history by day', async () => {
  const environment = env();
  const capturedAt = Date.now() - 1000;
  const snapshot = {
    season: { id: 'season-sql-path', name: 'SQL 路径测试赛季' },
    scope: 'global', capturedAt,
    leaderboards: {
      epic_total: [{ userId: 'u-1', userName: '测试用户', value: 13, rank: 1, isVip: true }],
      spend_total: [{ userId: 'u-1', userName: '测试用户', value: 12_000_000_000, rank: 1, isVip: true }]
    }
  };
  const postResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  assert.equal(postResponse.status, 200, await postResponse.clone().text());

  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?board=users&period=total'), environment);
  assert.equal(response.status, 200);
  const totalQuery = environment.RANKINGS_DB.queries.find((query) => query.sql.includes('from rank_user_metrics') && query.sql.includes('board_key in'));
  const dailyQuery = environment.RANKINGS_DB.queries.find((query) => query.sql.includes('from rank_daily_metrics'));
  const currentQuery = environment.RANKINGS_DB.queries.find((query) => query.sql.includes('with current_rows')
    && query.sql.includes('from rank_entries e')
    && query.sql.includes('captured_at >= ?')
    && query.sql.includes('captured_at < ?'));
  assert.ok(totalQuery, 'total users should read rank_user_metrics');
  assert.ok(dailyQuery, 'total users should read the compressed daily history table');
  assert.ok(currentQuery, 'total users should only read the current-day raw tail');
  assert.doesNotMatch(dailyQuery.sql, /raw_json/);
  assert.match(currentQuery.sql, /partition by e\.user_id, e\.board_key/);
});

test('limits today, week and month user history queries to their period windows', async () => {
  const environment = env();
  const currentCapturedAt = Date.now() - 1000;
  const oldCapturedAt = currentCapturedAt - 31 * DAY_MS;
  const post = (capturedAt, userId) => handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      season: { id: 'season-period-window', name: '周期窗口测试赛季' },
      scope: 'global', capturedAt,
      leaderboards: Object.fromEntries(['today', 'week', 'month'].flatMap((period) => [
        [`epic_${period}`, [{ userId, userName: userId, value: 12, rank: 1, isVip: false }]],
        [`spend_${period}`, [{ userId, userName: userId, value: 8_000_000_000, rank: 1, isVip: false }]]
      ]))
    })
  }), environment);
  await post(oldCapturedAt, 'old-user');
  await post(currentCapturedAt, 'current-user');

  for (const period of ['today', 'week', 'month']) {
    const before = environment.RANKINGS_DB.queries.length;
    const response = await handleRankingsRequest(request(`/api/rankings/leaderboard?board=users&period=${period}`), environment);
    assert.equal(response.status, 200);
    const query = environment.RANKINGS_DB.queries.slice(before).find((item) => item.sql.includes('from rank_daily_metrics'));
    const currentQuery = environment.RANKINGS_DB.queries.slice(before).find((item) => item.sql.includes('with current_rows')
      && item.sql.includes('from rank_entries e')
      && item.sql.includes('captured_at >= ?')
      && item.sql.includes('captured_at < ?'));
    assert.ok(query, `${period} should use the compressed daily table`);
    assert.ok(currentQuery, `${period} should use a bounded current-day raw query`);
    assert.equal(query.params.length, 6, `${period} should bind a start and end timestamp`);
    const expectedDays = period === 'today' ? 1 : period === 'week' ? 7 : 30;
    const expectedStart = dayStartAtForCapturedAt(currentCapturedAt) - (expectedDays - 1) * DAY_MS;
    assert.equal(query.params[4], expectedStart);
    assert.equal(query.params[5], dayStartAtForCapturedAt(currentCapturedAt));
    assert.equal(currentQuery.params[4], dayStartAtForCapturedAt(currentCapturedAt));
    assert.equal(currentQuery.params[5], dayStartAtForCapturedAt(currentCapturedAt) + DAY_MS);
    assert.equal(currentQuery.params[6], currentCapturedAt);
    const payload = await response.json();
    assert.deepEqual(payload.rows.map((row) => row.userId), ['current-user']);
  }
});

test('calculates paid and free pulls from spend even when the epic board is missing', async () => {
  const environment = env();
  const capturedAt = Date.now() - 1000;
  const snapshot = {
    season: { id: 'season-spend-only', name: '消费单榜抽数测试' },
    scope: 'global', capturedAt,
    leaderboards: {
      spend_total: [{ userId: 'spend-only', userName: '只有消费', value: 12_000_000_000, rank: 1, isVip: true }]
    }
  };
  const postResponse = await handleRankingsRequest(request('/api/rankings/snapshots', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(snapshot)
  }), environment);
  assert.equal(postResponse.status, 200, await postResponse.clone().text());

  const response = await handleRankingsRequest(request('/api/rankings/leaderboard?period=total'), environment);
  const payload = await response.json();
  const row = payload.rows.find((item) => item.userId === 'spend-only');
  assert.equal(row.spendUsd, 24_000);
  assert.equal(row.paidPulls, 2_400);
  assert.equal(row.freePulls, 200);
  assert.equal(row.estimatedPulls, 2_600);
  assert.equal(row.estimatedLegendProbability, null);
  assert.equal(row.estimateStatus, 'missing_epic');
  assert.equal(row.isPartial, true);
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

test('daily user metrics use the materialized table and only bounded current-day raw rows', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(Date.now() - 1000));
  const response = await handleRankingsRequest(
    request('/api/rankings/leaderboard?board=users&period=total'),
    environment
  );
  assert.equal(response.status, 200);
  const queries = environment.RANKINGS_DB.queries;
  assert.ok(queries.some(({ sql }) => sql.includes('from rank_daily_metrics')));
  assert.equal(queries.some(({ sql }) => sql.includes('with daily_rows')), false);
  assert.ok(queries.some(({ sql }) => sql.includes('from rank_entries e')
    && sql.includes('captured_at >= ?')
    && sql.includes('captured_at < ?')));
});

test('history defaults to 30 days and returns a stable next cursor', async () => {
  const environment = env();
  const base = Date.now() - (3 * DAY_MS);
  for (const [index, capturedAt] of [base, base + DAY_MS, base + (2 * DAY_MS)].entries()) {
    await postSnapshot(environment, {
      ...snapshotAt(capturedAt),
      leaderboards: {
        epic_total: [{ userId: 'u1', userName: '用户一', value: index + 1, rank: 1, isVip: false }]
      }
    });
  }
  const response = await handleRankingsRequest(
    request('/api/rankings/history?userId=u1&limit=1'),
    environment
  );
  const payload = await response.json();
  assert.equal(payload.mode, 'daily');
  assert.equal(payload.limit, 1);
  assert.equal(payload.hasMore, true);
  assert.ok(payload.nextCursor);
});

test('daily history bounds its raw tail to the current Beijing day', async () => {
  const environment = env();
  const currentCapturedAt = Date.now() - 1000;
  await postSnapshot(environment, snapshotAt(currentCapturedAt - 10 * DAY_MS));
  await postSnapshot(environment, snapshotAt(currentCapturedAt));
  const response = await handleRankingsRequest(
    request(`/api/rankings/history?userId=u1&since=1&until=${currentCapturedAt}`),
    environment
  );
  assert.equal(response.status, 200);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => sql.includes('with current_rows')
    && sql.includes('from rank_entries e')
    && sql.includes('e.user_id = ?')
    && sql.includes('captured_at >= ?')
    && sql.includes('captured_at < ?'));
  assert.ok(query, 'daily history should read only a bounded current-day raw tail');
  const currentDayStartAt = dayStartAtForCapturedAt(currentCapturedAt);
  assert.equal(query.params[2], currentDayStartAt);
  assert.equal(query.params[3], currentDayStartAt + DAY_MS);
  assert.equal(query.params[4], currentCapturedAt);
});

test('snapshot history is opt-in and always has a bounded captured_at predicate', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(Date.now() - 1000));
  const response = await handleRankingsRequest(
    request('/api/rankings/history?userId=u1&mode=snapshot&since=1&until=2'),
    environment
  );
  assert.equal(response.status, 200);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => sql.includes('from rank_entries e')
    && sql.includes('captured_at >= ?'));
  assert.ok(query);
  assert.doesNotMatch(query.sql, /select e\.\*,/);
});

test('user search applies the match and result limit in D1', async () => {
  const environment = env();
  await postSnapshot(environment, {
    ...snapshotAt(Date.now() - 1000),
    leaderboards: {
      epic_total: [{ userId: 'alice-1', userName: 'Alice', value: 10, rank: 1, isVip: false }]
    }
  });
  const response = await handleRankingsRequest(
    request('/api/rankings/users?query=alice'),
    environment
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.deepEqual(payload.users.map((row) => row.userId), ['alice-1']);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => sql.includes('from rank_user_metrics') && sql.includes('like ?'));
  assert.ok(query);
  assert.match(query.sql, /collate nocase/);
  assert.match(query.sql, /limit 20/);
  assert.doesNotMatch(query.sql, /limit 2000/);
});

test('events default to a bounded daily aggregate query', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(Date.now() - 1000));
  const response = await handleRankingsRequest(
    request('/api/rankings/events?board=epic'),
    environment
  );
  assert.equal(response.status, 200);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => sql.includes('from rank_daily_metrics')
    && sql.includes('day_start_at >= ?')
    && sql.includes('day_start_at <= ?'));
  assert.ok(query);
  assert.doesNotMatch(query.sql, /from rank_snapshots/);
});

test('raw event mode is explicit and bounded by the requested range', async () => {
  const environment = env();
  await postSnapshot(environment, snapshotAt(Date.now() - 1000));
  const response = await handleRankingsRequest(
    request('/api/rankings/events?board=epic&mode=snapshot&since=1&until=2'),
    environment
  );
  assert.equal(response.status, 200);
  const query = environment.RANKINGS_DB.queries.find(({ sql }) => sql.includes('from rank_snapshots')
    && sql.includes('captured_at >= ?')
    && sql.includes('captured_at <= ?'));
  assert.ok(query);
});
