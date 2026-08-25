import {
  BOARD_KEYS,
  CAPTURE_BUCKET_MS,
  REFRESH_INTERVAL_MS,
  computeSnapshotSignature,
  diffBoardRows,
  estimatePullsFromSpend,
  estimateLegendProbability,
  normalizeSnapshotBundle,
  pairLeaderboardRows
} from './rankings-core.js';
import {
  DAY_BOUNDARY_OFFSET_MS,
  DAY_MS,
  dayStartAtForCapturedAt
} from './rankings-daily.js';

const DEFAULT_SEASON_START_AT = Date.parse('2026-08-02T04:00:00+08:00');
const BOARD_GROUPS = new Set(['users', 'epic', 'spend', 'sets', 'luck']);
const PERIODS = new Set(['today', 'week', 'month', 'total']);
const MAX_LIMIT = 1000;
const MAX_EVENT_ROWS = 200;

export async function handleRankingsRequest(request, env) {
  const url = new URL(request.url);
  if (!env || !env.RANKINGS_DB) {
    return jsonResponse({
      ok: false,
      error: 'database_unavailable',
      message: '榜单数据库暂时不可用，请稍后重试',
      endpoint: url.pathname,
      retryable: true
    }, 503);
  }

  try {
    if (url.pathname === '/api/rankings/latest' && request.method === 'GET') {
      return await getLatest(env);
    }
    if (url.pathname === '/api/rankings/leaderboard' && request.method === 'GET') {
      return await getLeaderboard(url, env);
    }
    if (url.pathname === '/api/rankings/history' && request.method === 'GET') {
      return await getHistory(url, env);
    }
    if (url.pathname === '/api/rankings/users' && request.method === 'GET') {
      return await getUsers(url, env);
    }
    if (url.pathname === '/api/rankings/events' && request.method === 'GET') {
      return await getEvents(url, env);
    }
    if (url.pathname === '/api/rankings/snapshots' && request.method === 'POST') {
      return await postSnapshot(request, env);
    }
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  } catch (error) {
    const readRequest = request.method === 'GET' && url.pathname.startsWith('/api/rankings/');
    if (readRequest) {
      console.error('rankings_read_failed', {
        path: url.pathname,
        message: String(error && error.message || error).slice(0, 240)
      });
    }
    return jsonResponse({
      ok: false,
      error: readRequest ? 'rankings_read_unavailable' : 'database_error',
      message: readRequest ? '榜单读取暂时繁忙，请稍后重试' : String(error && error.message || error).slice(0, 240),
      endpoint: url.pathname,
      retryable: readRequest
    }, readRequest ? 503 : 500);
  }
}

async function getLatest(env) {
  const row = await latestSnapshot(env);
  if (!row) {
    return jsonResponse({ ok: true, snapshot: null, stale: true, boards: [] });
  }
  const boards = await distinctBoards(env, row.id);
  return jsonResponse({
    ok: true,
    snapshot: serializeSnapshot(row),
    stale: Date.now() - Number(row.captured_at) >= REFRESH_INTERVAL_MS,
    boards
  });
}

async function postSnapshot(request, env) {
  const rateLimitResponse = await limitSnapshotWrites(request, env);
  if (rateLimitResponse) return rateLimitResponse;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const now = Date.now();
  const bundle = normalizeSnapshotBundle(body, now);
  if (!bundle.snapshots.length) {
    return jsonResponse({
      ok: false,
      error: 'invalid_snapshot',
      reason: bundle.errors[0] && bundle.errors[0].reason || 'invalid_snapshot'
    }, 400);
  }

  const source = String(body && body.source || 'card-dashboard-userscript').slice(0, 64);
  const stored = [];
  const errors = bundle.errors.slice();
  let duplicateSnapshots = 0;
  let staleSnapshots = 0;
  let storedEntries = 0;
  for (const normalized of bundle.snapshots) {
    try {
      const result = await storeNormalizedSnapshot(normalized, source, now, env);
      if (result.duplicate) {
        duplicateSnapshots += 1;
        continue;
      }
      if (result.stale) {
        staleSnapshots += 1;
        continue;
      }
      stored.push(result.snapshot);
      storedEntries += result.storedEntries;
    } catch (error) {
      errors.push({ scope: normalized.scope, reason: String(error && error.message || error) });
    }
  }

  if (!stored.length && !duplicateSnapshots && !staleSnapshots) {
    return jsonResponse({
      ok: false,
      error: 'invalid_snapshot',
      reason: errors[0] && errors[0].reason || 'snapshot_insert_failed',
      errors
    }, 400);
  }

  if (!stored.length && !duplicateSnapshots && staleSnapshots && !errors.length) {
    return jsonResponse({
      ok: true,
      status: 'rejected',
      reason: 'stale_or_existing_data',
      staleSnapshots,
      duplicateSnapshots: 0,
      storedSnapshots: 0,
      storedEntries: 0,
      snapshots: [],
      errors: []
    });
  }

  return jsonResponse({
    ok: true,
    status: errors.length || staleSnapshots
      ? 'partial'
      : duplicateSnapshots && !stored.length ? 'duplicate' : 'accepted',
    snapshot: stored[stored.length - 1] || null,
    snapshots: stored,
    storedSnapshots: stored.length,
    duplicateSnapshots,
    staleSnapshots,
    storedEntries,
    partial: errors.length > 0 || staleSnapshots > 0,
    errors
  });
}

async function limitSnapshotWrites(request, env) {
  const limiter = env.RANKINGS_WRITE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const key = request.headers.get('cf-connecting-ip')
    || request.headers.get('x-forwarded-for')
    || 'anonymous';
  const result = await limiter.limit({ key: String(key).slice(0, 128) });
  if (!result || result.success !== false) return null;
  return jsonResponse({
    ok: false,
    error: 'rate_limited',
    retryable: true
  }, 429, { 'retry-after': '60' });
}

async function storeNormalizedSnapshot(normalized, source, now, env) {
  if (!normalized.entries.length) throw new Error('empty_entries');
  const signature = await computeSnapshotSignature(snapshotSignatureInput(normalized));
  const duplicate = await env.RANKINGS_DB.prepare(`
    SELECT id, season_id, season_name, scope, captured_at, captured_bucket,
      source, signature, created_at
    FROM rank_snapshots
    WHERE season_id = ? AND signature = ?
    LIMIT 1
  `).bind(normalized.seasonId, signature).first();
  if (duplicate) return { duplicate: true };

  const latest = await env.RANKINGS_DB.prepare(`
    SELECT id, captured_at
    FROM rank_snapshots
    WHERE season_id = ? AND scope = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `).bind(normalized.seasonId, normalized.scope).first();
  if (latest && normalized.capturedAt <= Number(latest.captured_at)) return { stale: true };

  const insertResult = await env.RANKINGS_DB.prepare(`
    INSERT INTO rank_snapshots (
      season_id, season_name, scope, captured_at, captured_bucket,
      source, signature, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (season_id, signature) DO NOTHING
  `).bind(
    normalized.seasonId,
    normalized.seasonName,
    normalized.scope,
    normalized.capturedAt,
    normalized.capturedBucket,
    source,
    signature,
    JSON.stringify(normalized.raw),
    now
  ).run();

  if (Number(insertResult.meta && insertResult.meta.changes) === 0) return { duplicate: true };
  const snapshotId = Number(insertResult.meta && insertResult.meta.last_row_id) || 0;
  if (!snapshotId) throw new Error('snapshot_insert_failed');
  for (const chunk of chunks(normalized.entries, 50)) {
    const statements = chunk.map((entry) => env.RANKINGS_DB.prepare(`
      INSERT INTO rank_entries (
        snapshot_id, board_key, user_id, user_name, avatar_url, value, rank,
        is_vip, active_name_decoration, name_display_preference, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId,
      entry.boardKey,
      entry.userId,
      entry.userName,
      entry.avatar,
      entry.value,
      entry.rank,
      entry.isVip ? 1 : 0,
      entry.activeNameDecoration,
      entry.nameDisplayPreference,
      JSON.stringify(entry.raw)
    ));
    await env.RANKINGS_DB.batch(statements);
  }

  await mergeSnapshotMetrics(env, normalized, snapshotId);
  return {
    snapshot: serializeSnapshot({
      id: snapshotId,
      season_id: normalized.seasonId,
      season_name: normalized.seasonName,
      scope: normalized.scope,
      captured_at: normalized.capturedAt,
      captured_bucket: normalized.capturedBucket,
      source,
      signature,
      created_at: now
    }),
    storedEntries: normalized.entries.length
  };
}

function snapshotSignatureInput(normalized) {
  return {
    seasonId: normalized.seasonId,
    seasonName: normalized.seasonName,
    scope: normalized.scope,
    capturedAt: normalized.capturedAt,
    entries: normalized.entries.map((entry) => ({
      boardKey: entry.boardKey,
      userId: entry.userId,
      userName: entry.userName,
      avatar: entry.avatar,
      value: entry.value,
      rank: entry.rank,
      isVip: entry.isVip,
      activeNameDecoration: entry.activeNameDecoration,
      nameDisplayPreference: entry.nameDisplayPreference
    }))
  };
}

const METRIC_VALUE_REPLACEMENT_SQL = `(
  (excluded.board_key LIKE '%_total' AND (
    excluded.value > rank_user_metrics.value
    OR (excluded.value = rank_user_metrics.value
      AND excluded.value_captured_at >= rank_user_metrics.value_captured_at)
  ))
  OR (excluded.board_key NOT LIKE '%_total' AND (
    excluded.value_captured_at > rank_user_metrics.value_captured_at
    OR (excluded.value_captured_at = rank_user_metrics.value_captured_at
      AND excluded.value >= rank_user_metrics.value)
  ))
)`;

const METRIC_SOURCE_SCOPES_SQL = `CASE
  WHEN (
    instr(',' || rank_user_metrics.source_scopes || ',', ',global,') > 0
    OR instr(',' || excluded.source_scopes || ',', ',global,') > 0
  ) AND (
    instr(',' || rank_user_metrics.source_scopes || ',', ',friends,') > 0
    OR instr(',' || excluded.source_scopes || ',', ',friends,') > 0
  ) THEN 'global,friends'
  WHEN rank_user_metrics.source_scopes <> '' THEN rank_user_metrics.source_scopes
  ELSE excluded.source_scopes
END`;

const RANK_USER_METRIC_UPSERT_SQL = `
  INSERT INTO rank_user_metrics (
    season_id, user_id, board_key, user_name, avatar_url, value, rank,
    is_vip, active_name_decoration, name_display_preference,
    value_snapshot_id, value_scope, value_captured_at,
    last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (season_id, user_id, board_key) DO UPDATE SET
    user_name = CASE
      WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at
        AND excluded.user_name <> '' THEN excluded.user_name
      ELSE rank_user_metrics.user_name
    END,
    avatar_url = CASE
      WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at
        AND excluded.avatar_url <> '' THEN excluded.avatar_url
      ELSE rank_user_metrics.avatar_url
    END,
    value = CASE WHEN ${METRIC_VALUE_REPLACEMENT_SQL}
      THEN excluded.value ELSE rank_user_metrics.value END,
    rank = CASE WHEN ${METRIC_VALUE_REPLACEMENT_SQL}
      THEN excluded.rank ELSE rank_user_metrics.rank END,
    is_vip = MAX(rank_user_metrics.is_vip, excluded.is_vip),
    active_name_decoration = CASE
      WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at
        AND excluded.active_name_decoration IS NOT NULL THEN excluded.active_name_decoration
      ELSE rank_user_metrics.active_name_decoration
    END,
    name_display_preference = CASE
      WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at
        AND excluded.name_display_preference IS NOT NULL THEN excluded.name_display_preference
      ELSE rank_user_metrics.name_display_preference
    END,
    value_snapshot_id = CASE WHEN ${METRIC_VALUE_REPLACEMENT_SQL}
      THEN excluded.value_snapshot_id ELSE rank_user_metrics.value_snapshot_id END,
    value_scope = CASE WHEN ${METRIC_VALUE_REPLACEMENT_SQL}
      THEN excluded.value_scope ELSE rank_user_metrics.value_scope END,
    value_captured_at = CASE WHEN ${METRIC_VALUE_REPLACEMENT_SQL}
      THEN excluded.value_captured_at ELSE rank_user_metrics.value_captured_at END,
    last_snapshot_id = CASE
      WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at
        THEN excluded.last_snapshot_id ELSE rank_user_metrics.last_snapshot_id
    END,
    last_scope = CASE
      WHEN excluded.last_captured_at >= rank_user_metrics.last_captured_at
        THEN excluded.last_scope ELSE rank_user_metrics.last_scope
    END,
    last_captured_at = MAX(rank_user_metrics.last_captured_at, excluded.last_captured_at),
    first_captured_at = MIN(rank_user_metrics.first_captured_at, excluded.first_captured_at),
    source_scopes = ${METRIC_SOURCE_SCOPES_SQL}
`;

async function mergeSnapshotMetrics(env, normalized, snapshotId) {
  for (const chunk of chunks(normalized.entries, 50)) {
    const statements = chunk.map((entry) => env.RANKINGS_DB.prepare(RANK_USER_METRIC_UPSERT_SQL).bind(
      normalized.seasonId,
      entry.userId,
      entry.boardKey,
      entry.userName,
      entry.avatar,
      entry.value,
      entry.rank,
      entry.isVip ? 1 : 0,
      entry.activeNameDecoration,
      entry.nameDisplayPreference,
      snapshotId,
      normalized.scope,
      normalized.capturedAt,
      snapshotId,
      normalized.scope,
      normalized.capturedAt,
      normalized.capturedAt,
      normalized.scope
    ));
    await env.RANKINGS_DB.batch(statements);
  }
}

async function getLeaderboard(url, env) {
  const board = String(url.searchParams.get('board') || 'users');
  const period = String(url.searchParams.get('period') || 'total');
  if (!BOARD_GROUPS.has(board) || !PERIODS.has(period)) {
    return jsonResponse({ ok: false, error: 'invalid_board_or_period' }, 400);
  }
  const latest = await latestSnapshot(env);
  if (!latest) return jsonResponse({ ok: true, snapshot: null, rows: [], board, period });

  if (board === 'users') return getUsersLeaderboard(url, env, latest);

  const limit = normalizeLimit(url.searchParams.get('limit'));
  const boardKey = `${board}_${period}`;
  const previous = await previousSnapshot(env, latest);
  const [currentRowsRaw, previousRowsRaw, currentEpicRows, currentSpendRows, previousEpicRows, previousSpendRows] = await Promise.all([
    board === 'luck' ? Promise.resolve([]) : entriesForSnapshot(env, latest.id, boardKey, limit),
    previous && board !== 'luck' ? entriesForSnapshot(env, previous.id, boardKey, MAX_LIMIT) : Promise.resolve([]),
    entriesForSnapshot(env, latest.id, `epic_${period}`, MAX_LIMIT),
    entriesForSnapshot(env, latest.id, `spend_${period}`, MAX_LIMIT),
    previous ? entriesForSnapshot(env, previous.id, `epic_${period}`, MAX_LIMIT) : Promise.resolve([]),
    previous ? entriesForSnapshot(env, previous.id, `spend_${period}`, MAX_LIMIT) : Promise.resolve([])
  ]);

  const currentPairs = pairLeaderboardRows(currentEpicRows, currentSpendRows);
  const previousPairs = pairLeaderboardRows(previousEpicRows, previousSpendRows);
  const currentPairById = new Map(currentPairs.map((pair) => [pair.userId, pair]));
  const previousPairById = new Map(previousPairs.map((pair) => [pair.userId, pair]));
  const currentViews = board === 'luck'
    ? luckViews(currentPairs, limit, latest.captured_at, period).complete
    : currentRowsRaw.map((row) => ({ row, pair: currentPairById.get(row.user_id) || null }));
  const previousViews = board === 'luck'
    ? luckViews(previousPairs, MAX_LIMIT, latest.captured_at, period).complete
    : previousRowsRaw.map((row) => ({ row, pair: previousPairById.get(row.user_id) || null }));
  const previousById = new Map(previousViews.map((view) => [view.row.user_id, view.row]));
  const rows = currentViews.map((view) => {
    const row = buildEnrichedEntry(view.row, view.pair, board, view.rankOverride, latest.captured_at, period);
    const previousRow = previousById.get(row.userId);
    return {
      ...row,
      previousRank: previousRow ? Number(previousRow.rank) : null,
      previousValue: previousRow ? Number(previousRow.value) : null,
      rankDelta: previousRow ? Number(previousRow.rank) - Number(row.rank) : null,
      valueDelta: previousRow ? Number(row.value) - Number(previousRow.value) : null,
      event: previousRow ? (Number(previousRow.rank) === Number(row.rank) ? '' : 'moved') : 'entered'
    };
  });
  const partialRows = board === 'luck'
    ? luckViews(currentPairs, MAX_LIMIT, latest.captured_at, period).partial.map((view) => buildEnrichedEntry(view.row, view.pair, board, null, latest.captured_at, period))
    : rows.filter((row) => row.isPartial);

  return jsonResponse({
    ok: true,
    board,
    period,
    boardKey,
    snapshot: serializeSnapshot(latest),
    previousSnapshot: previous ? serializeSnapshot(previous) : null,
    estimated: true,
    rows,
    partialRows
  });
}

async function getUsersLeaderboard(url, env, latest) {
  const period = String(url.searchParams.get('period') || 'total');
  const sort = normalizeUserSort(url.searchParams.get('sort'));
  const limitValue = url.searchParams.get('limit');
  const limit = limitValue == null || limitValue === '' ? null : normalizeLimit(limitValue);
  const previous = await previousSnapshot(env, latest);
  const currentRowsPromise = period === 'total'
    ? Promise.all([
      metricsForPeriod(env, latest.season_id, period),
      dailyMetricsForPeriod(env, latest.season_id, period, latest.captured_at)
    ]).then(([metricRows, dailyRows]) => ({ metricRows, dailyRows }))
    : dailyMetricsForPeriod(env, latest.season_id, period, latest.captured_at)
      .then((dailyRows) => ({ metricRows: [], dailyRows }));
  const [currentRows, previousEpicRows, previousSpendRows, previousSetsRows] = await Promise.all([
    currentRowsPromise,
    previous ? entriesForSnapshot(env, previous.id, `epic_${period}`, null) : Promise.resolve([]),
    previous ? entriesForSnapshot(env, previous.id, `spend_${period}`, null) : Promise.resolve([]),
    previous ? entriesForSnapshot(env, previous.id, `sets_${period}`, null) : Promise.resolve([])
  ]);
  const currentUsers = period === 'total'
    ? summarizeMetricUsersWithDailyHistory(currentRows.metricRows, currentRows.dailyRows, sort, latest, period)
    : summarizeDailyUsers(currentRows.dailyRows, sort, latest, period);
  const rankedCurrentUsers = currentUsers
    .map((row) => ({ ...row, boardKey: `users_${period}` }));
  const previousUsers = summarizeUsers(previousEpicRows, previousSpendRows, previousSetsRows, sort, latest.captured_at, period)
    .map((row) => ({ ...row, boardKey: `users_${period}` }))
    .map((row, index) => ({ ...row, rank: index + 1 }));
  const previousById = new Map(previousUsers.map((row) => [row.userId, row]));
  const rows = (limit == null ? rankedCurrentUsers : rankedCurrentUsers.slice(0, limit)).map((row, index) => {
    const previousRow = previousById.get(row.userId);
    return {
      ...row,
      rank: index + 1,
      previousRank: previousRow ? previousRow.rank : null,
      rankDelta: previousRow ? previousRow.rank - (index + 1) : null,
      event: previousRow ? (previousRow.rank === index + 1 ? '' : 'moved') : 'entered'
    };
  });
  return jsonResponse({
    ok: true,
    board: 'users',
    period,
    sort,
    boardKey: `users_${period}`,
    snapshot: serializeSnapshot(latest),
    previousSnapshot: previous ? serializeSnapshot(previous) : null,
    estimated: true,
    rows,
    partialRows: []
  });
}

async function metricsForPeriod(env, seasonId, period) {
  const keys = [`epic_${period}`, `spend_${period}`, `sets_${period}`];
  const result = await env.RANKINGS_DB.prepare(`
    SELECT season_id, user_id, board_key, user_name, avatar_url, value, rank,
      is_vip, active_name_decoration, name_display_preference,
      value_snapshot_id AS snapshot_id, value_scope AS scope,
      value_captured_at AS captured_at,
      last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes
    FROM rank_user_metrics
    WHERE season_id = ? AND board_key IN (?, ?, ?)
  `).bind(seasonId, ...keys).all();
  return result.results || [];
}

async function dailyMetricsForPeriod(env, seasonId, period, capturedAt = null) {
  const keys = [`epic_${period}`, `spend_${period}`, `sets_${period}`];
  const rangeStartAt = periodWindowStartAt(capturedAt, period);
  const hasRange = rangeStartAt != null;
  const rangeClause = hasRange ? ' AND s.captured_at >= ? AND s.captured_at <= ?' : '';
  const params = [seasonId, ...keys];
  if (hasRange) params.push(rangeStartAt, Number(capturedAt));
  const result = await env.RANKINGS_DB.prepare(`
    WITH daily_rows AS (
      SELECT e.snapshot_id, e.board_key, e.user_id, e.user_name, e.avatar_url, e.value, e.rank,
        e.is_vip, e.active_name_decoration, e.name_display_preference,
        s.scope, s.captured_at, s.captured_bucket,
        ROW_NUMBER() OVER (
          PARTITION BY e.user_id, e.board_key,
            CAST((s.captured_at - ${DAY_BOUNDARY_OFFSET_MS}) / ${DAY_MS} AS INTEGER)
          ORDER BY s.captured_at DESC, e.value DESC, s.id DESC, e.rank ASC
        ) AS day_order
      FROM rank_entries e
      JOIN rank_snapshots s ON s.id = e.snapshot_id
      WHERE s.season_id = ? AND e.board_key IN (?, ?, ?)${rangeClause}
    )
    SELECT snapshot_id, board_key, user_id, user_name, avatar_url, value, rank,
      is_vip, active_name_decoration, name_display_preference,
      scope, captured_at, captured_bucket
    FROM daily_rows
    WHERE day_order = 1
    ORDER BY captured_at ASC, rank ASC, snapshot_id ASC
  `).bind(...params).all();
  return result.results || [];
}

function periodWindowStartAt(capturedAt, period) {
  if (period === 'total') return null;
  const latestDayStartAt = dayStartAtForCapturedAt(capturedAt);
  if (latestDayStartAt == null) return null;
  const windowDays = period === 'today' ? 1 : period === 'week' ? 7 : 30;
  return latestDayStartAt - (windowDays - 1) * DAY_MS;
}

function summarizeMetricUsersWithDailyHistory(metricRows = [], dailyRows = [], sort = 'legend', latestSnapshot = null, period = 'total') {
  const users = collectDailyUsers(dailyRows);
  for (const rawRow of metricRows) {
    if (!rawRow || typeof rawRow !== 'object') continue;
    const userId = String(rawRow.user_id || rawRow.userId || '').trim();
    if (!userId) continue;
    const current = users.get(userId) || createDailyUser(userId);
    const boardKey = String(rawRow.board_key || '');
    const kind = boardKey.startsWith('epic_')
      ? 'epic'
      : boardKey.startsWith('spend_')
        ? 'spend'
        : boardKey.startsWith('sets_') ? 'sets' : null;
    if (!kind) continue;
    current.metrics[kind] = rawRow;
    current.userName = current.userName || String(rawRow.user_name || rawRow.userName || '').trim();
    current.avatar = current.avatar || String(rawRow.avatar_url || rawRow.avatar || '').trim();
    current.isVip = current.isVip || Boolean(rawRow.is_vip ?? rawRow.isVip);
    users.set(userId, current);
  }

  const latestDayStartAt = dayStartAtForCapturedAt(latestSnapshot && latestSnapshot.captured_at);
  return Array.from(users.values())
    .map((user) => buildMetricUserSummary(user, latestDayStartAt, latestSnapshot && latestSnapshot.captured_at, period))
    .sort((left, right) => compareUserRows(left, right, sort));
}

function createDailyUser(userId) {
  return {
    userId,
    userName: '',
    avatar: '',
    isVip: false,
    daily: { epic: new Map(), spend: new Map(), sets: new Map() },
    metrics: { epic: null, spend: null, sets: null }
  };
}

function collectDailyUsers(rows = []) {
  const users = new Map();
  const merge = (rawRow, kind) => {
    if (!rawRow || typeof rawRow !== 'object') return;
    const userId = String(rawRow.user_id || rawRow.userId || '').trim();
    if (!userId) return;
    const current = users.get(userId) || createDailyUser(userId);
    const capturedAt = Number(rawRow.captured_at);
    const dayStartAt = dayStartAtForCapturedAt(capturedAt);
    if (!Number.isFinite(dayStartAt)) return;
    const byDay = current.daily[kind];
    const existing = byDay.get(dayStartAt);
    if (!existing || shouldReplaceDailyRow(existing, rawRow, capturedAt, kind)) {
      byDay.set(dayStartAt, { ...rawRow, captured_at: capturedAt, dayStartAt });
    }
    current.userName = current.userName || String(rawRow.user_name || rawRow.userName || '').trim();
    current.avatar = current.avatar || String(rawRow.avatar_url || rawRow.avatar || '').trim();
    current.isVip = current.isVip || Boolean(rawRow.is_vip ?? rawRow.isVip);
    users.set(userId, current);
  };

  for (const rawRow of rows) {
    const boardKey = String(rawRow && rawRow.board_key || '');
    const kind = boardKey.startsWith('epic_')
      ? 'epic'
      : boardKey.startsWith('spend_')
        ? 'spend'
        : boardKey.startsWith('sets_') ? 'sets' : null;
    if (kind) merge(rawRow, kind);
  }
  return users;
}

function buildMetricUserSummary(user, latestDayStartAt = null, capturedAt = Date.now(), period = 'total') {
  const epicMetric = user.metrics.epic;
  const spendMetric = user.metrics.spend;
  const setsMetric = user.metrics.sets;
  const latestEpic = latestDailyRow(user.daily.epic);
  const latestSpend = latestDailyRow(user.daily.spend);
  const latestSets = latestDailyRow(user.daily.sets);
  const epicTotal = epicMetric ? Number(epicMetric.value) : latestEpic ? Number(latestEpic.value) : null;
  const spendValue = spendMetric ? Number(spendMetric.value) : latestSpend ? Number(latestSpend.value) : null;
  const exchangeCount = setsMetric ? Number(setsMetric.value) : latestSets ? Number(latestSets.value) : null;
  const hasEpic = epicTotal != null && Number.isFinite(epicTotal);
  const hasSpend = spendValue != null && Number.isFinite(spendValue);
  const commonDays = Array.from(user.daily.epic.keys())
    .filter((dayStartAt) => user.daily.spend.has(dayStartAt))
    .sort((left, right) => right - left);
  const completePair = completeDailyPair(user, commonDays, capturedAt, period);
  const estimateDayStartAt = completePair
    ? completePair.dayStartAt
    : (commonDays.length ? commonDays[0] : null);
  const pairEpic = completePair && completePair.epicRow;
  const pairSpend = completePair && completePair.spendRow;
  const pairEstimate = completePair && completePair.estimate;
  const rawEstimate = estimatePullsFromSpend(spendValue, user.isVip, { capturedAt, period });
  const estimate = pairEstimate || rawEstimate;
  const estimateStatus = !hasEpic && !hasSpend
    ? 'missing_pair'
    : !hasSpend
      ? 'missing_spend'
      : !hasEpic
        ? 'missing_epic'
        : !commonDays.length
          ? 'missing_common_day'
          : completePair
            ? 'complete_days'
            : 'partial_day';
  const displayEpicTotal = pairEpic ? Number(pairEpic.value) : epicTotal;
  const displaySpendValue = pairSpend ? Number(pairSpend.value) : spendValue;
  const probability = completePair
    ? estimateLegendProbability({
      epicTotal: displayEpicTotal,
      spendValue: displaySpendValue,
      isVip: completePair.isVip,
      capturedAt,
      period
    })
    : null;
  const source = epicMetric || spendMetric || setsMetric;
  const estimateUsesHistoricalData = estimateDayStartAt != null
    && latestDayStartAt != null
    && estimateDayStartAt < latestDayStartAt;
  return {
    snapshotId: source ? Number(source.snapshot_id) : null,
    boardKey: 'users',
    userId: user.userId,
    userName: user.userName || String(source && source.user_name || user.userId),
    avatar: user.avatar,
    value: displaySpendValue ?? displayEpicTotal ?? exchangeCount,
    rank: null,
    isVip: user.isVip,
    epicTotal: displayEpicTotal,
    spendValue: displaySpendValue,
    spendTotal: displaySpendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: estimate.estimatedDays,
    paidPulls: estimate.paidPulls,
    freePulls: estimate.freePulls,
    estimatedPulls: estimate.estimatedPulls,
    exchangeCount,
    estimateStatus,
    estimateDayStartAt,
    estimateUsesHistoricalData,
    isPartial: estimateStatus !== 'complete_days' || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    rankDelta: null,
    event: ''
  };
}

function summarizeDailyUsers(rows = [], sort = 'legend', latestSnapshot = null, period = 'total') {
  const users = collectDailyUsers(rows);
  const latestDayStartAt = dayStartAtForCapturedAt(latestSnapshot && latestSnapshot.captured_at);
  return Array.from(users.values())
    .map((user) => buildDailyUserSummary(user, latestDayStartAt, latestSnapshot && latestSnapshot.captured_at, period))
    .sort((left, right) => compareUserRows(left, right, sort));
}

function shouldReplaceDailyRow(existing, incoming, capturedAt, kind) {
  const existingCapturedAt = Number(existing.captured_at);
  if (capturedAt > existingCapturedAt) return true;
  if (capturedAt < existingCapturedAt) return false;
  if (kind === 'epic' || kind === 'spend' || kind === 'sets') {
    return Number(incoming.value) >= Number(existing.value);
  }
  return false;
}

function latestDailyRow(rowsByDay) {
  if (!rowsByDay || !rowsByDay.size) return null;
  return Array.from(rowsByDay.values())
    .sort((left, right) => right.dayStartAt - left.dayStartAt || right.captured_at - left.captured_at)[0] || null;
}

function completeDailyPair(user, commonDays = [], capturedAt = Date.now(), period = 'total') {
  for (const dayStartAt of commonDays) {
    const epicRow = user.daily.epic.get(dayStartAt);
    const spendRow = user.daily.spend.get(dayStartAt);
    if (!epicRow || !spendRow) continue;
    const isVip = Boolean(
      user.isVip
        || (epicRow.is_vip ?? epicRow.isVip)
        || (spendRow.is_vip ?? spendRow.isVip)
    );
    const estimate = estimatePullsFromSpend(Number(spendRow.value), isVip, { capturedAt, period });
    if (estimate.estimateStatus === 'complete_days') {
      return { dayStartAt, epicRow, spendRow, isVip, estimate };
    }
  }
  return null;
}

function buildDailyUserSummary(user, latestDayStartAt = null, capturedAt = Date.now(), period = 'total') {
  const latestEpic = latestDailyRow(user.daily.epic);
  const latestSpend = latestDailyRow(user.daily.spend);
  const latestSets = latestDailyRow(user.daily.sets);
  const source = latestEpic || latestSpend || latestSets;
  const epicTotal = latestEpic ? Number(latestEpic.value) : null;
  const spendValue = latestSpend ? Number(latestSpend.value) : null;
  const exchangeCount = latestSets ? Number(latestSets.value) : null;
  const hasEpic = epicTotal != null && Number.isFinite(epicTotal);
  const hasSpend = spendValue != null && Number.isFinite(spendValue);
  const commonDays = Array.from(user.daily.epic.keys())
    .filter((dayStartAt) => user.daily.spend.has(dayStartAt))
    .sort((left, right) => right - left);
  const completePair = completeDailyPair(user, commonDays, capturedAt, period);
  const estimateDayStartAt = completePair
    ? completePair.dayStartAt
    : (commonDays.length ? commonDays[0] : null);
  const pairEpic = completePair && completePair.epicRow;
  const pairSpend = completePair && completePair.spendRow;
  const pairEstimate = completePair && completePair.estimate;
  const rawEstimate = estimatePullsFromSpend(spendValue, user.isVip, { capturedAt, period });
  const estimate = pairEstimate || rawEstimate;
  const estimateStatus = !hasEpic && !hasSpend
    ? 'missing_pair'
    : !hasSpend
      ? 'missing_spend'
      : !hasEpic
        ? 'missing_epic'
        : !commonDays.length
          ? 'missing_common_day'
          : completePair
            ? 'complete_days'
            : 'partial_day';
  const displayEpicTotal = pairEpic ? Number(pairEpic.value) : epicTotal;
  const displaySpendValue = pairSpend ? Number(pairSpend.value) : spendValue;
  const probability = completePair
    ? estimateLegendProbability({
      epicTotal: displayEpicTotal,
      spendValue: displaySpendValue,
      isVip: completePair.isVip,
      capturedAt,
      period
    })
    : null;
  const estimateUsesHistoricalData = estimateDayStartAt != null
    && latestDayStartAt != null
    && estimateDayStartAt < latestDayStartAt;
  return {
    snapshotId: source ? Number(source.snapshot_id) : null,
    boardKey: 'users',
    userId: user.userId,
    userName: user.userName || String(source && source.user_name || user.userId),
    avatar: user.avatar,
    value: displaySpendValue ?? displayEpicTotal ?? exchangeCount,
    rank: null,
    isVip: user.isVip,
    epicTotal: displayEpicTotal,
    spendValue: displaySpendValue,
    spendTotal: displaySpendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: estimate.estimatedDays,
    paidPulls: estimate.paidPulls,
    freePulls: estimate.freePulls,
    estimatedPulls: estimate.estimatedPulls,
    exchangeCount,
    estimateStatus,
    estimateDayStartAt,
    estimateUsesHistoricalData,
    isPartial: estimateStatus !== 'complete_days' || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    rankDelta: null,
    event: ''
  };
}

function summarizeUsers(epicRows = [], spendRows = [], setsRows = [], sort = 'legend', capturedAt = Date.now(), period = 'total', currentCapturedBucket = null) {
  const users = new Map();
  const merge = (rawRow, kind) => {
    if (!rawRow || typeof rawRow !== 'object') return;
    const userId = String(rawRow.user_id || rawRow.userId || '').trim();
    if (!userId) return;
    const current = users.get(userId) || {
      userId,
      epicRow: null,
      spendRow: null,
      setsRow: null,
      userName: '',
      avatar: '',
      isVip: false
    };
    current[`${kind}Row`] = rawRow;
    current.userName = current.userName || String(rawRow.user_name || rawRow.userName || '').trim();
    current.avatar = current.avatar || String(rawRow.avatar_url || rawRow.avatar || '').trim();
    current.isVip = current.isVip || Boolean(rawRow.is_vip ?? rawRow.isVip);
    users.set(userId, current);
  };
  epicRows.forEach((row) => merge(row, 'epic'));
  spendRows.forEach((row) => merge(row, 'spend'));
  setsRows.forEach((row) => merge(row, 'sets'));
  return Array.from(users.values())
    .map((user) => buildUserSummary(user, currentCapturedBucket, capturedAt, period))
    .sort((left, right) => compareUserRows(left, right, sort));
}

function buildUserSummary(user, currentCapturedBucket = null, capturedAt = Date.now(), period = 'total') {
  const source = user.epicRow || user.spendRow || user.setsRow;
  const epicTotal = user.epicRow ? Number(user.epicRow.value) : null;
  const spendValue = user.spendRow ? Number(user.spendRow.value) : null;
  const exchangeCount = user.setsRow ? Number(user.setsRow.value) : null;
  const isVip = Boolean(user.isVip);
  const hasEpic = epicTotal != null && Number.isFinite(epicTotal);
  const hasSpend = spendValue != null && Number.isFinite(spendValue);
  const currentEpic = hasEpic && metricInCapturedBucket(user.epicRow, currentCapturedBucket);
  const currentSpend = hasSpend && metricInCapturedBucket(user.spendRow, currentCapturedBucket);
  const canDerive = currentEpic && currentSpend;
  const rawEstimate = estimatePullsFromSpend(spendValue, isVip, { capturedAt, period });
  const estimate = rawEstimate;
  const estimateStatus = canDerive
    ? estimate.estimateStatus
    : currentEstimateStatus({
      hasEpic,
      hasSpend,
      currentEpic,
      currentSpend,
      currentCapturedBucket
    });
  const probability = canDerive
    ? estimateLegendProbability({ epicTotal, spendValue, isVip, capturedAt, period })
    : null;
  return {
    snapshotId: source ? Number(source.snapshot_id) : null,
    boardKey: 'users',
    userId: user.userId,
    userName: user.userName || String(source && source.user_name || user.userId),
    avatar: user.avatar,
    value: spendValue ?? epicTotal ?? exchangeCount,
    rank: null,
    isVip,
    epicTotal,
    spendValue,
    spendTotal: spendValue,
    spendUsd: rawEstimate.spendUsd,
    estimatedDays: estimate.estimatedDays,
    paidPulls: estimate.paidPulls,
    freePulls: estimate.freePulls,
    estimatedPulls: estimate.estimatedPulls,
    exchangeCount,
    estimateStatus,
    isPartial: estimateStatus !== 'complete_days' || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    rankDelta: null,
    event: ''
  };
}

function metricInCapturedBucket(row, capturedBucket) {
  if (!row) return false;
  if (capturedBucket == null) return true;
  const capturedAt = Number(row.value_captured_at ?? row.captured_at);
  return Number.isFinite(capturedAt)
    && Math.floor(capturedAt / CAPTURE_BUCKET_MS) === Number(capturedBucket);
}

function currentEstimateStatus({ hasEpic, hasSpend, currentEpic, currentSpend, currentCapturedBucket }) {
  if (currentCapturedBucket != null) {
    if (!currentEpic && !currentSpend) return hasEpic || hasSpend ? 'missing_current_pair' : 'missing_pair';
    if (!currentEpic) return hasEpic ? 'missing_current_epic' : 'missing_epic';
    if (!currentSpend) return hasSpend ? 'missing_current_spend' : 'missing_spend';
  }
  if (!hasEpic && !hasSpend) return 'missing_pair';
  if (!hasEpic) return 'missing_epic';
  if (!hasSpend) return 'missing_spend';
  return 'missing_pair';
}

function emptyEstimate(spendUsd, estimateStatus) {
  return {
    spendUsd,
    estimatedDays: null,
    paidPulls: null,
    freePulls: null,
    estimatedPulls: null,
    estimateStatus
  };
}

function compareUserRows(left, right, sort) {
  if (sort === 'user') return String(left.userName || left.userId).localeCompare(String(right.userName || right.userId)) || left.userId.localeCompare(right.userId);
  const leftValue = userSortValue(left, sort);
  const rightValue = userSortValue(right, sort);
  if (leftValue == null && rightValue == null) return left.userId.localeCompare(right.userId);
  if (leftValue == null) return 1;
  if (rightValue == null) return -1;
  return rightValue - leftValue || left.userId.localeCompare(right.userId);
}

function userSortValue(row, sort) {
  if (sort === 'legend') return row.epicTotal;
  if (sort === 'spend') return row.spendUsd;
  if (sort === 'pulls') return row.estimatedPulls;
  if (sort === 'sets') return row.exchangeCount;
  return row.estimatedLegendProbability;
}

function normalizeUserSort(value) {
  return new Set(['probability', 'legend', 'spend', 'pulls', 'sets', 'user']).has(value)
    ? value
    : 'legend';
}

async function getHistory(url, env) {
  const userId = String(url.searchParams.get('userId') || '').trim();
  if (!userId) return jsonResponse({ ok: false, error: 'user_id_required' }, 400);
  const board = String(url.searchParams.get('board') || '').trim();
  if (board && !BOARD_GROUPS.has(board)) return jsonResponse({ ok: false, error: 'invalid_board' }, 400);
  const latest = await latestSnapshot(env);
  if (!latest) return jsonResponse({ ok: true, userId, rows: [], events: [] });

  const rows = await env.RANKINGS_DB.prepare(`
    SELECT e.*, s.season_id, s.season_name, s.captured_at, s.id AS snapshot_id
    FROM rank_entries e
    JOIN rank_snapshots s ON s.id = e.snapshot_id
    WHERE s.season_id = ? AND e.user_id = ?
    ORDER BY s.captured_at ASC, s.id ASC
  `).bind(latest.season_id, userId).all();
  const filtered = dedupeHistoryRows(
    (rows.results || []).filter((row) => !board || row.board_key.startsWith(`${board}_`))
  );
  const serialized = filtered.map((row) => ({
    ...serializeEntry(row),
    boardKey: row.board_key,
    snapshotId: Number(row.snapshot_id),
    capturedAt: Number(row.captured_at),
    seasonName: String(row.season_name || '')
  }));
  return jsonResponse({
    ok: true,
    userId,
    season: { id: latest.season_id, name: latest.season_name },
    elapsedDays: elapsedSeasonDays(Date.now()),
    rows: serialized,
    events: buildUserEvents(serialized)
  });
}

function dedupeHistoryRows(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const capturedAt = Number(row.captured_at);
    const bucket = Number.isFinite(Number(row.captured_bucket))
      ? Number(row.captured_bucket)
      : Math.floor(capturedAt / CAPTURE_BUCKET_MS);
    const key = `${String(row.board_key || '')}\u0000${bucket}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, row);
      continue;
    }
    const total = String(row.board_key || '').endsWith('_total');
    const currentValue = Number(row.value);
    const existingValue = Number(existing.value);
    const replace = total
      ? currentValue > existingValue
        || (currentValue === existingValue && capturedAt >= Number(existing.captured_at))
      : capturedAt >= Number(existing.captured_at);
    if (replace) grouped.set(key, row);
  }
  return Array.from(grouped.values()).sort((left, right) => {
    return Number(left.captured_at) - Number(right.captured_at)
      || Number(left.snapshot_id) - Number(right.snapshot_id);
  });
}

async function getUsers(url, env) {
  const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
  if (query.length < 1) return jsonResponse({ ok: true, users: [] });
  const latest = await latestSnapshot(env);
  if (!latest) return jsonResponse({ ok: true, users: [] });
  const rows = await env.RANKINGS_DB.prepare(`
    SELECT user_id, user_name, avatar_url, is_vip, MAX(last_captured_at) AS last_seen_at
    FROM rank_user_metrics
    WHERE season_id = ?
    GROUP BY user_id, user_name, avatar_url, is_vip
    ORDER BY last_seen_at DESC
    LIMIT 2000
  `).bind(latest.season_id).all();
  const users = [];
  const seen = new Set();
  for (const row of rows.results || []) {
    const userId = String(row.user_id || '');
    const userName = String(row.user_name || '');
    if (!userId || seen.has(userId)) continue;
    if (!userId.toLowerCase().includes(query) && !userName.toLowerCase().includes(query)) continue;
    seen.add(userId);
    users.push({
      userId,
      userName,
      avatar: String(row.avatar_url || ''),
      isVip: Boolean(row.is_vip),
      lastSeenAt: Number(row.last_seen_at) || 0
    });
    if (users.length >= 20) break;
  }
  return jsonResponse({ ok: true, users });
}

async function getEvents(url, env) {
  const board = String(url.searchParams.get('board') || 'epic');
  if (!BOARD_GROUPS.has(board)) return jsonResponse({ ok: false, error: 'invalid_board' }, 400);
  const latest = await latestSnapshot(env);
  if (!latest) return jsonResponse({ ok: true, board, events: [] });
  const snapshots = await env.RANKINGS_DB.prepare(`
    SELECT id, season_id, season_name, scope, captured_at, captured_bucket, source, signature, created_at
    FROM rank_snapshots
    WHERE season_id = ?
    ORDER BY captured_at ASC, id ASC
  `).bind(latest.season_id).all();
  const list = snapshots.results || [];
  const events = [];
  for (let index = 1; index < list.length; index += 1) {
    const previous = list[index - 1];
    const current = list[index];
    const boardKey = `${board}_total`;
    const [previousRowsRaw, currentRowsRaw] = await Promise.all([
      entriesForSnapshot(env, previous.id, boardKey, MAX_LIMIT),
      entriesForSnapshot(env, current.id, boardKey, MAX_LIMIT)
    ]);
    const previousRows = previousRowsRaw.map(serializeEntry);
    const currentRows = currentRowsRaw.map(serializeEntry);
    for (const change of diffBoardRows(previousRows, currentRows)) {
      if (!change.event && !change.rankDelta && !change.valueDelta) continue;
      events.push({
        board,
        event: change.event || 'changed',
        userId: change.userId,
        userName: change.userName,
        avatar: change.avatar,
        previousRank: change.previousRank,
        currentRank: change.rank,
        previousValue: change.previousValue,
        currentValue: change.value,
        rankDelta: change.rankDelta,
        valueDelta: change.valueDelta,
        capturedAt: Number(current.captured_at)
      });
    }
  }
  return jsonResponse({ ok: true, board, events: events.slice(-MAX_EVENT_ROWS) });
}

async function latestSnapshot(env) {
  return env.RANKINGS_DB.prepare(`
    SELECT id, season_id, season_name, scope, captured_at, captured_bucket, source, signature, created_at
    FROM rank_snapshots
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `).first();
}

async function previousSnapshot(env, latest) {
  return env.RANKINGS_DB.prepare(`
    SELECT id, season_id, season_name, scope, captured_at, captured_bucket, source, signature, created_at
    FROM rank_snapshots
    WHERE season_id = ? AND scope = ? AND captured_at < ?
    ORDER BY captured_at DESC, id DESC
    LIMIT 1
  `).bind(latest.season_id, latest.scope, latest.captured_at).first();
}

async function distinctBoards(env, snapshotId) {
  const result = await env.RANKINGS_DB.prepare(`
    SELECT DISTINCT board_key FROM rank_entries WHERE snapshot_id = ? ORDER BY board_key
  `).bind(snapshotId).all();
  return (result.results || []).map((row) => String(row.board_key)).filter((key) => BOARD_KEYS.includes(key));
}

async function entriesForSnapshot(env, snapshotId, boardKey, limit = MAX_LIMIT) {
  const baseSql = `
    SELECT snapshot_id, board_key, user_id, user_name, avatar_url, value, rank,
      is_vip, active_name_decoration, name_display_preference, raw_json
    FROM rank_entries
    WHERE snapshot_id = ? AND board_key = ?
    ORDER BY rank ASC`;
  const statement = limit == null
    ? env.RANKINGS_DB.prepare(baseSql).bind(snapshotId, boardKey)
    : env.RANKINGS_DB.prepare(`${baseSql} LIMIT ?`).bind(snapshotId, boardKey, normalizeLimit(limit));
  const result = await statement.all();
  return result.results || [];
}

function luckViews(pairs, limit, capturedAt = Date.now(), period = 'total') {
  const complete = [];
  const partial = [];
  for (const pair of pairs) {
    const sourceRow = pair.epicRow || pair.spendRow;
    if (!sourceRow) continue;
    const view = { row: sourceRow, pair, rankOverride: null };
    const isVip = Boolean(pair.epicRow?.is_vip || pair.spendRow?.is_vip);
    const estimate = pair.epicRow && pair.spendRow
      ? estimatePullsFromSpend(Number(pair.spendValue), isVip, { capturedAt, period })
      : null;
    if (estimate && estimate.estimateStatus === 'complete_days') complete.push(view);
    else partial.push(view);
  }

  complete.sort((left, right) => {
    const leftProbability = pairProbability(left.pair, capturedAt, period);
    const rightProbability = pairProbability(right.pair, capturedAt, period);
    if (leftProbability == null && rightProbability == null) return left.pair.userId.localeCompare(right.pair.userId);
    if (leftProbability == null) return 1;
    if (rightProbability == null) return -1;
    return rightProbability - leftProbability
      || Number(right.pair.epicValue || 0) - Number(left.pair.epicValue || 0)
      || left.pair.userId.localeCompare(right.pair.userId);
  });
  const ranked = complete.slice(0, limit).map((view, index) => ({ ...view, rankOverride: index + 1 }));
  return {
    complete: ranked,
    partial: partial.slice(0, MAX_LIMIT)
  };
}

function pairProbability(pair, capturedAt = Date.now(), period = 'total') {
  if (!pair || !pair.epicRow || !pair.spendRow) return null;
  const isVip = Boolean(pair.epicRow.is_vip || pair.spendRow.is_vip);
  return estimateLegendProbability({
    epicTotal: Number(pair.epicValue),
    spendValue: Number(pair.spendValue),
    isVip,
    capturedAt,
    period
  });
}

function buildEnrichedEntry(row, pair, board, rankOverride = undefined, capturedAt = Date.now(), period = 'total') {
  const entry = serializeEntry(row);
  const epicTotal = pair && pair.epicRow
    ? Number(pair.epicValue)
    : board === 'epic' ? Number(row.value) : null;
  const spendValue = pair && pair.spendRow
    ? Number(pair.spendValue)
    : board === 'spend' ? Number(row.value) : null;
  const isVip = Boolean(
    row.is_vip
      || (pair && pair.epicRow && pair.epicRow.is_vip)
      || (pair && pair.spendRow && pair.spendRow.is_vip)
  );
  const rawEstimate = estimatePullsFromSpend(spendValue, isVip, { capturedAt, period });
  const hasPair = epicTotal != null && Number.isFinite(epicTotal)
    && spendValue != null && Number.isFinite(spendValue);
  const estimate = rawEstimate;
  let estimateStatus = !Number.isFinite(spendValue)
    ? 'missing_spend'
    : !Number.isFinite(epicTotal)
      ? 'missing_epic'
      : hasPair ? estimate.estimateStatus : 'missing_pair';
  const probability = estimateStatus !== 'complete_days'
    ? null
    : estimateLegendProbability({ epicTotal, spendValue, isVip, capturedAt, period });
  const isPartial = estimateStatus !== 'complete_days' || probability == null;
  return {
    ...entry,
    rank: rankOverride === undefined ? entry.rank : rankOverride,
    isVip,
    epicTotal,
    spendValue,
    spendTotal: spendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: estimate.estimatedDays,
    paidPulls: estimate.paidPulls,
    freePulls: estimate.freePulls,
    estimatedPulls: estimate.estimatedPulls,
    estimateStatus,
    isPartial,
    estimatedLegendProbability: probability
  };
}

function serializeSnapshot(row) {
  return {
    id: Number(row.id),
    seasonId: String(row.season_id || ''),
    seasonName: String(row.season_name || ''),
    scope: String(row.scope || 'global'),
    capturedAt: Number(row.captured_at),
    capturedBucket: Number(row.captured_bucket),
    source: String(row.source || ''),
    signature: String(row.signature || ''),
    createdAt: Number(row.created_at)
  };
}

function serializeEntry(row) {
  return {
    snapshotId: Number(row.snapshot_id),
    boardKey: String(row.board_key || ''),
    userId: String(row.user_id || ''),
    userName: String(row.user_name || ''),
    avatar: String(row.avatar_url || ''),
    value: Number(row.value),
    rank: Number(row.rank),
    isVip: Boolean(row.is_vip),
    activeNameDecoration: row.active_name_decoration == null ? null : String(row.active_name_decoration),
    nameDisplayPreference: row.name_display_preference == null ? null : String(row.name_display_preference)
  };
}

function buildUserEvents(rows) {
  const byBoard = new Map();
  for (const row of rows) {
    const list = byBoard.get(row.boardKey) || [];
    list.push(row);
    byBoard.set(row.boardKey, list);
  }
  const events = [];
  for (const [boardKey, list] of byBoard) {
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (previous.rank === current.rank && previous.value === current.value) continue;
      events.push({
        boardKey,
        capturedAt: current.capturedAt,
        rankDelta: previous.rank - current.rank,
        valueDelta: current.value - previous.value
      });
    }
  }
  return events;
}

function elapsedSeasonDays(now) {
  return Math.max(1, Math.min(90, Math.floor((Number(now) - DEFAULT_SEASON_START_AT) / DAY_MS) + 1));
}

function estimatedPulls(spendTotal, elapsedDays, isVip) {
  return Number(spendTotal || 0) / 10 + Number(elapsedDays || 0) * (isVip ? 50 : 30);
}

function normalizeLimit(value) {
  if (value == null || value === '') return MAX_LIMIT;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(number))) : MAX_LIMIT;
}

function chunks(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) result.push(array.slice(index, index + size));
  return result;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
