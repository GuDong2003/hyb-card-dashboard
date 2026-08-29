import {
  estimateLegendProbability,
  estimatePullsFromSpend,
  normalizeSnapshotBundle
} from './rankings-core.js';
import {
  DAY_MS,
  dayStartAtForCapturedAt,
  metricPairObservation
} from './rankings-daily.js';
import {
  COMPACT_BOARD_KEYS,
  compactHistoryRows,
  decodeCurrentCursor,
  queryCurrentBoard,
  queryPinnedUsers,
  storeUserObservations
} from './rankings-user-store.js';

const BOARD_GROUPS = new Set(['users', 'epic', 'spend', 'sets', 'luck']);
const PERIODS = new Set(['today', 'week', 'month', 'total']);
const HISTORY_MODES = new Set(['daily']);
const HISTORY_DEFAULT_WINDOW_MS = 30 * DAY_MS;
const HISTORY_DEFAULT_LIMIT = 30;
const HISTORY_MAX_LIMIT = 90;
const HISTORY_MAX_WINDOW_MS = 90 * DAY_MS;
const EVENTS_DEFAULT_WINDOW_MS = 7 * DAY_MS;
const PAGE_DEFAULT_LIMIT = 50;
const PAGE_MAX_LIMIT = 100;
const MAX_EVENT_ROWS = 200;
const REFRESH_INTERVAL_MS = 3 * 60 * 60 * 1000;
const CACHE_HEADERS = Object.freeze({
  latest: { 'cache-control': 'public, max-age=15, stale-while-revalidate=30' },
  leaderboard: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' },
  history: { 'cache-control': 'public, max-age=60, stale-while-revalidate=120' },
  users: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' },
  events: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' }
});

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
    if (url.pathname === '/api/rankings/latest' && request.method === 'GET') return await getLatest(env);
    if (url.pathname === '/api/rankings/leaderboard' && request.method === 'GET') return await getLeaderboard(url, env);
    if (url.pathname === '/api/rankings/history' && request.method === 'GET') return await getHistory(url, env);
    if (url.pathname === '/api/rankings/users' && request.method === 'GET') return await getUsers(url, env);
    if (url.pathname === '/api/rankings/events' && request.method === 'GET') return await getEvents(url, env);
    if (url.pathname === '/api/rankings/snapshots' && request.method === 'POST') return await postSnapshot(request, env);
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
  const season = await latestSeason(env);
  if (!season) return jsonResponse({ ok: true, snapshot: null, stale: true, boards: [] }, 200, CACHE_HEADERS.latest);
  return jsonResponse({
    ok: true,
    snapshot: serializeSeasonSnapshot(season),
    stale: Date.now() - Number(season.last_observed_at) >= REFRESH_INTERVAL_MS,
    boards: [...COMPACT_BOARD_KEYS]
  }, 200, CACHE_HEADERS.latest);
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
  const mode = body && body.mode === 'manual' ? 'manual' : 'automatic';
  let stored;
  try {
    stored = await storeUserObservations(env.RANKINGS_DB, bundle.snapshots, {
      source,
      mode,
      finalSets: body && body.finalSets === true,
      setsFinalRetry: body && body.setsFinalRetry === true
    }, now);
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: 'database_error',
      reason: String(error && error.message || error).slice(0, 240),
      errors: bundle.errors
    }, 500);
  }

  const errors = bundle.errors.slice();
  const skippedScopes = stored.skippedScopes || [];
  const skippedMetrics = stored.skippedMetrics || [];
  const storedSnapshots = Number.isFinite(Number(stored.storedSnapshots))
    ? Math.max(0, Number(stored.storedSnapshots))
    : Math.max(0, bundle.snapshots.length - skippedScopes.length);
  const storedEntries = Number.isFinite(Number(stored.storedEntries))
    ? Math.max(0, Number(stored.storedEntries))
    : bundle.snapshots
      .filter((normalized) => !skippedScopes.some((item) => item.seasonId === normalized.seasonId && item.scope === normalized.scope))
      .reduce((sum, normalized) => sum + normalized.entries.length, 0);
  const unchangedUsers = Math.max(0, stored.users - stored.changedUsers);
  const latest = bundle.snapshots[bundle.snapshots.length - 1];
  const snapshot = latest ? serializeObservedSnapshot(latest, now) : null;
  return jsonResponse({
    ok: true,
    status: errors.length || skippedScopes.length || skippedMetrics.length
      ? (storedSnapshots ? 'partial' : 'unchanged')
      : 'accepted',
    snapshot,
    snapshots: snapshot ? [snapshot] : [],
    storedSnapshots,
    duplicateSnapshots: 0,
    staleSnapshots: skippedScopes.length,
    storedEntries,
    changedUsers: stored.changedUsers,
    changedFields: stored.changedFields,
    unchangedUsers,
    skippedScopes,
    skippedMetrics,
    partial: errors.length > 0 || skippedScopes.length > 0 || skippedMetrics.length > 0,
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
  return jsonResponse({ ok: false, error: 'rate_limited', retryable: true }, 429, { 'retry-after': '60' });
}

async function getLeaderboard(url, env) {
  const board = String(url.searchParams.get('board') || 'users').trim();
  const period = String(url.searchParams.get('period') || 'total').trim();
  if (!BOARD_GROUPS.has(board) || !PERIODS.has(period)) return jsonResponse({ ok: false, error: 'invalid_board_or_period' }, 400);
  const season = await latestSeason(env);
  if (!season) {
    return jsonResponse({
      ok: true,
      snapshot: null,
      rows: [],
      partialRows: [],
      pinnedRows: [],
      board,
      period,
      totalRows: 0,
      summary: null,
      hasMore: false,
      nextCursor: null
    }, 200, CACHE_HEADERS.leaderboard);
  }

  const limit = parsePageLimit(url.searchParams.get('limit'));
  const sort = board === 'users' ? normalizeUserSort(url.searchParams.get('sort')) : board === 'luck' ? 'probability' : 'legend';
  const direction = normalizeDirection(url.searchParams.get('direction'), sort === 'user' ? 'asc' : 'desc');
  const query = String(url.searchParams.get('q') || '').trim().slice(0, 128);
  const pinnedIds = board === 'users'
    ? String(url.searchParams.get('pinned') || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .slice(0, 20)
    : [];
  const cursorResult = decodeCurrentCursor(url.searchParams.get('cursor'), sort, direction, {
    seasonId: season.season_id,
    board,
    period,
    query
  });
  if (cursorResult.error) return jsonResponse({ ok: false, error: cursorResult.error }, 400);

  const page = await queryCurrentBoard(env.RANKINGS_DB, {
    seasonId: season.season_id,
    board,
    period,
    sort,
    direction,
    limit,
    q: query,
    includeTotal: true,
    pinnedIds,
    cursor: cursorResult.cursor,
    latestDayStartAt: Number(season.last_day_start_at)
  });
  const capturedAt = Number(season.last_observed_at);
  const rows = page.rows.map((row, index) => buildLeaderboardRow(row, board, period, Number(row.current_rank) || index + 1, capturedAt));
  const pinnedRows = (page.pinnedRows || [])
    .map((row, index) => buildLeaderboardRow(row, board, period, Number(row.current_rank) || index + 1, capturedAt));
  return jsonResponse({
    ok: true,
    board,
    period,
    sort,
    boardKey: `${board}_${period}`,
    snapshot: serializeSeasonSnapshot(season),
    previousSnapshot: null,
    estimated: true,
    rows,
    partialRows: rows.filter((row) => row.isPartial),
    pinnedRows,
    totalRows: page.totalRows,
    summary: page.summary || null,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor
  }, 200, CACHE_HEADERS.leaderboard);
}

async function getHistory(url, env) {
  const userId = String(url.searchParams.get('userId') || '').trim();
  if (!userId) return jsonResponse({ ok: false, error: 'user_id_required' }, 400);
  const board = String(url.searchParams.get('board') || '').trim();
  if (board && !BOARD_GROUPS.has(board)) return jsonResponse({ ok: false, error: 'invalid_board' }, 400);
  const requestedMode = String(url.searchParams.get('mode') || 'daily').trim().toLowerCase();
  if (!HISTORY_MODES.has(requestedMode)) return jsonResponse({ ok: false, error: 'invalid_history_mode' }, 400);
  const limitResult = parseHistoryLimit(url.searchParams.get('limit'));
  if (limitResult.error) return jsonResponse({ ok: false, error: limitResult.error }, 400);
  const season = await latestSeason(env);
  if (!season) {
    return jsonResponse({
      ok: true,
      userId,
      mode: 'daily',
      since: 0,
      until: 0,
      limit: limitResult.limit,
      rows: [],
      nextCursor: null,
      hasMore: false,
      events: []
    }, 200, CACHE_HEADERS.history);
  }

  const range = parseBoundedRange(url, Number(season.last_observed_at), HISTORY_DEFAULT_WINDOW_MS);
  if (range.error) return jsonResponse({ ok: false, error: range.error }, 400);
  const cursorResult = decodeHistoryCursor(url.searchParams.get('cursor'), {
    seasonId: season.season_id,
    userId,
    until: range.until
  });
  if (cursorResult.error) return jsonResponse({ ok: false, error: cursorResult.error }, 400);

  const params = [season.season_id, userId, range.since, range.until];
  let cursorClause = '';
  if (cursorResult.cursor) {
    cursorClause = ' AND day_start_at > ?';
    params.push(Number(cursorResult.cursor.dayStartAt));
  }
  params.push(limitResult.limit + 1);
  const result = await env.RANKINGS_DB.prepare(`
    SELECT *
    FROM rank_user_days
    WHERE season_id = ? AND user_id = ?
      AND day_start_at >= ? AND day_start_at <= ?${cursorClause}
    ORDER BY day_start_at ASC
    LIMIT ?
  `).bind(...params).all();
  const dayRows = result.results || [];
  const pageRows = dayRows.slice(0, limitResult.limit);
  const rows = pageRows
    .flatMap((row) => compactHistoryRows(row, board === 'users' ? '' : board))
    .map((row) => serializeHistoryRow(row, season.season_name));
  const nextCursor = dayRows.length > limitResult.limit && pageRows.length
    ? encodeHistoryCursor({
      seasonId: season.season_id,
      userId,
      until: range.until,
      dayStartAt: Number(pageRows[pageRows.length - 1].day_start_at)
    })
    : null;
  return jsonResponse({
    ok: true,
    userId,
    mode: 'daily',
    season: { id: season.season_id, name: season.season_name },
    elapsedDays: elapsedSeasonDays(Date.now(), season.last_observed_at),
    since: range.since,
    until: range.until,
    limit: limitResult.limit,
    rows,
    nextCursor,
    hasMore: Boolean(nextCursor),
    events: buildUserEvents(rows)
  }, 200, CACHE_HEADERS.history);
}

async function getUsers(url, env) {
  const query = String(url.searchParams.get('q') || url.searchParams.get('query') || '').trim();
  const ids = String(url.searchParams.get('ids') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (!query && !ids.length) return jsonResponse({ ok: true, users: [] }, 200, CACHE_HEADERS.users);
  const season = await latestSeason(env);
  if (!season) return jsonResponse({ ok: true, users: [] }, 200, CACHE_HEADERS.users);
  const page = ids.length
    ? await queryPinnedUsers(env.RANKINGS_DB, {
      seasonId: season.season_id,
      board: 'users',
      period: 'total',
      sort: 'user',
      direction: 'asc',
      ids,
      limit: 20,
      latestDayStartAt: Number(season.last_day_start_at)
    })
    : await queryCurrentBoard(env.RANKINGS_DB, {
      seasonId: season.season_id,
      board: 'users',
      period: 'total',
      sort: 'user',
      direction: 'asc',
      q: query,
      limit: 20,
      latestDayStartAt: Number(season.last_day_start_at)
    });
  const period = String(url.searchParams.get('period') || 'total');
  return jsonResponse({
    ok: true,
    users: page.rows.map((row) => ({
      ...buildUserRow(row, PERIODS.has(period) ? period : 'total', null, Number(season.last_observed_at)),
      lastSeenAt: Number(row.last_observed_at || 0)
    }))
  }, 200, CACHE_HEADERS.users);
}

async function getEvents(url, env) {
  const board = String(url.searchParams.get('board') || 'epic').trim();
  if (!BOARD_GROUPS.has(board)) return jsonResponse({ ok: false, error: 'invalid_board' }, 400);
  if (board === 'users') return jsonResponse({ ok: false, error: 'invalid_event_board' }, 400);
  const season = await latestSeason(env);
  if (!season) return jsonResponse({ ok: true, board, mode: 'daily', since: 0, until: 0, events: [] }, 200, CACHE_HEADERS.events);
  const range = parseBoundedRange(url, Number(season.last_observed_at), EVENTS_DEFAULT_WINDOW_MS);
  if (range.error) return jsonResponse({ ok: false, error: range.error }, 400);
  const ids = String(url.searchParams.get('ids') || url.searchParams.get('userId') || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 100);
  const boardKey = board === 'luck' ? 'epic_total' : `${board}_total`;
  const params = [season.season_id, range.since, range.until];
  let userClause = '';
  if (ids.length) {
    userClause = ` AND user_id IN (${ids.map(() => '?').join(', ')})`;
    params.push(...ids);
  }
  params.push(MAX_EVENT_ROWS * 4);
  const result = await env.RANKINGS_DB.prepare(`
    SELECT day_start_at, user_id, user_name, avatar_url,
      ${boardKey}_value AS value, ${boardKey}_rank AS rank
    FROM rank_user_days
    WHERE season_id = ? AND ${boardKey}_value IS NOT NULL
      AND day_start_at >= ? AND day_start_at <= ?${userClause}
    ORDER BY user_id ASC, day_start_at ASC
    LIMIT ?
  `).bind(...params).all();
  const grouped = new Map();
  for (const row of result.results || []) {
    const list = grouped.get(row.user_id) || [];
    list.push(row);
    grouped.set(row.user_id, list);
  }
  const events = [];
  for (const rows of grouped.values()) {
    for (let index = 1; index < rows.length; index += 1) {
      const previous = rows[index - 1];
      const current = rows[index];
      if (Number(previous.value) === Number(current.value) && Number(previous.rank) === Number(current.rank)) continue;
      events.push({
        board,
        event: Number(previous.rank) === Number(current.rank) ? 'changed' : 'moved',
        userId: String(current.user_id),
        userName: String(current.user_name || ''),
        avatar: String(current.avatar_url || ''),
        previousRank: Number(previous.rank),
        currentRank: Number(current.rank),
        previousValue: Number(previous.value),
        currentValue: Number(current.value),
        rankDelta: Number(previous.rank) - Number(current.rank),
        valueDelta: Number(current.value) - Number(previous.value),
        capturedAt: Number(current.day_start_at)
      });
    }
  }
  return jsonResponse({
    ok: true,
    board,
    mode: 'daily',
    since: range.since,
    until: range.until,
    events: events.slice(-MAX_EVENT_ROWS)
  }, 200, CACHE_HEADERS.events);
}

async function latestSeason(env) {
  return env.RANKINGS_DB.prepare(`
    SELECT season_id, season_name, last_observed_at, last_day_start_at, updated_at
    FROM rank_seasons
    ORDER BY last_observed_at DESC, season_id DESC
    LIMIT 1
  `).first();
}

function buildLeaderboardRow(row, board, period, rank, capturedAt) {
  if (board === 'users') return buildUserRow(row, period, rank, capturedAt);
  const metricKey = board === 'luck' ? 'epic_total' : `${board}_${period}`;
  const epicKey = board === 'luck' ? 'epic_total' : `epic_${period}`;
  const spendKey = board === 'luck' ? 'spend_total' : `spend_${period}`;
  const setsKey = board === 'luck' ? 'sets_total' : `sets_${period}`;
  const epicValue = numericOrNull(row[`${epicKey}_value`]);
  const spendValue = numericOrNull(row[`${spendKey}_value`]);
  const setsValue = numericOrNull(row[`${setsKey}_value`]);
  const pair = metricPairObservation(
    epicValue,
    row[`${epicKey}_observed_at`],
    spendValue,
    row[`${spendKey}_observed_at`]
  );
  const estimate = estimatePullsFromSpend(spendValue, Boolean(row.is_vip), { capturedAt, period });
  const complete = pair.paired && estimate.estimateStatus === 'complete_days';
  const probability = complete
    ? estimateLegendProbability({ epicTotal: epicValue, spendValue, isVip: Boolean(row.is_vip), capturedAt, period })
    : null;
  const estimateStatus = pair.paired ? estimate.estimateStatus : pair.status;
  const value = numericOrNull(row[`${metricKey}_value`]);
  return {
    snapshotId: null,
    boardKey: `${board}_${period}`,
    userId: String(row.user_id || ''),
    userName: String(row.user_name || row.user_id || ''),
    avatar: String(row.avatar_url || ''),
    value,
    rank: numericOrNull(row[`${metricKey}_rank`]) ?? rank,
    isVip: Boolean(row.is_vip),
    epicTotal: epicValue,
    spendValue,
    spendTotal: spendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: pair.paired ? estimate.estimatedDays : null,
    paidPulls: pair.paired ? estimate.paidPulls : null,
    freePulls: pair.paired ? estimate.freePulls : null,
    estimatedPulls: pair.paired ? estimate.estimatedPulls : null,
    exchangeCount: setsValue,
    estimateStatus,
    estimateDayStartAt: pair.staleDayStartAt,
    estimateUsesHistoricalData: pair.staleDayStartAt != null,
    isPartial: !complete || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    previousValue: null,
    rankDelta: null,
    valueDelta: null,
    event: ''
  };
}

function buildUserRow(row, period, rank, capturedAt) {
  const epicKey = `epic_${period}`;
  const spendKey = `spend_${period}`;
  const setsKey = `sets_${period}`;
  const epicTotal = numericOrNull(row[`${epicKey}_value`]);
  const spendValue = numericOrNull(row[`${spendKey}_value`]);
  const exchangeCount = numericOrNull(row[`${setsKey}_value`]);
  const isVip = Boolean(row.is_vip);
  const pair = metricPairObservation(
    epicTotal,
    row[`${epicKey}_observed_at`],
    spendValue,
    row[`${spendKey}_observed_at`]
  );
  const estimate = estimatePullsFromSpend(spendValue, isVip, { capturedAt, period });
  const complete = pair.paired && estimate.estimateStatus === 'complete_days';
  const probability = complete
    ? estimateLegendProbability({ epicTotal, spendValue, isVip, capturedAt, period })
    : null;
  const estimateStatus = pair.paired ? estimate.estimateStatus : pair.status;
  const spendObservedAt = Number(row[`${spendKey}_observed_at`] || row.last_observed_at || capturedAt);
  return {
    snapshotId: null,
    boardKey: `users_${period}`,
    userId: String(row.user_id || ''),
    userName: String(row.user_name || row.user_id || ''),
    avatar: String(row.avatar_url || ''),
    value: spendValue ?? epicTotal ?? exchangeCount,
    rank,
    isVip,
    epicTotal,
    spendValue,
    spendTotal: spendValue,
    spendUsd: estimate.spendUsd,
    estimatedDays: pair.paired ? estimate.estimatedDays : null,
    paidPulls: pair.paired ? estimate.paidPulls : null,
    freePulls: pair.paired ? estimate.freePulls : null,
    estimatedPulls: pair.paired ? estimate.estimatedPulls : null,
    exchangeCount,
    estimateStatus,
    estimateDayStartAt: pair.staleDayStartAt ?? dayStartAtForCapturedAt(spendObservedAt),
    estimateUsesHistoricalData: pair.staleDayStartAt != null,
    isPartial: estimateStatus !== 'complete_days' || probability == null,
    estimatedLegendProbability: probability,
    previousRank: null,
    previousValue: null,
    rankDelta: null,
    valueDelta: null,
    event: ''
  };
}

function serializeSeasonSnapshot(row) {
  return {
    id: null,
    seasonId: String(row.season_id || ''),
    seasonName: String(row.season_name || ''),
    scope: 'global,friends',
    capturedAt: Number(row.last_observed_at || 0),
    capturedBucket: null,
    source: 'compact-user-observation',
    signature: '',
    createdAt: Number(row.updated_at || 0)
  };
}

function serializeObservedSnapshot(normalized, createdAt) {
  return {
    id: null,
    seasonId: normalized.seasonId,
    seasonName: normalized.seasonName,
    scope: normalized.scope,
    capturedAt: normalized.capturedAt,
    capturedBucket: normalized.capturedBucket ?? null,
    source: 'compact-user-observation',
    signature: '',
    createdAt
  };
}

function serializeHistoryRow(row, seasonName = '') {
  return {
    snapshotId: null,
    boardKey: String(row.board_key || ''),
    userId: String(row.user_id || ''),
    userName: String(row.user_name || ''),
    avatar: String(row.avatar_url || ''),
    value: numericOrNull(row.value),
    rank: numericOrNull(row.rank),
    isVip: Boolean(row.is_vip),
    activeNameDecoration: row.active_name_decoration == null ? null : String(row.active_name_decoration),
    nameDisplayPreference: row.name_display_preference == null ? null : String(row.name_display_preference),
    capturedAt: Number(row.captured_at || 0),
    dayStartAt: Number(row.day_start_at || 0),
    seasonName
  };
}

function buildUserEvents(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const list = grouped.get(row.boardKey) || [];
    list.push(row);
    grouped.set(row.boardKey, list);
  }
  const events = [];
  for (const [boardKey, list] of grouped) {
    list.sort((left, right) => Number(left.capturedAt) - Number(right.capturedAt));
    for (let index = 1; index < list.length; index += 1) {
      const previous = list[index - 1];
      const current = list[index];
      if (previous.value === current.value && previous.rank === current.rank) continue;
      events.push({
        boardKey,
        capturedAt: current.capturedAt,
        rankDelta: Number(previous.rank) - Number(current.rank),
        valueDelta: Number(current.value) - Number(previous.value)
      });
    }
  }
  return events;
}

function parseBoundedRange(url, latestCapturedAt, defaultWindowMs) {
  const parsedSince = parseTimestamp(url.searchParams.get('since'));
  const parsedUntil = parseTimestamp(url.searchParams.get('until'));
  if (parsedSince.error) return parsedSince;
  if (parsedUntil.error) return parsedUntil;
  const latest = Number(latestCapturedAt);
  const latestDayStartAt = dayStartAtForCapturedAt(latest);
  if (latestDayStartAt == null) return { error: 'invalid_history_range' };
  const rawUntil = Math.min(parsedUntil.value == null ? latestDayStartAt : parsedUntil.value, latest);
  const until = dayStartAtForCapturedAt(rawUntil);
  if (until == null) return { error: 'invalid_history_range' };
  const defaultDays = Math.max(1, Math.round(defaultWindowMs / DAY_MS));
  let since = parsedSince.value == null
    ? until - (defaultDays - 1) * DAY_MS
    : dayStartAtForCapturedAt(parsedSince.value);
  if (since == null) return { error: 'invalid_history_range' };
  if (since > until) return { error: 'invalid_history_range' };
  const maxDays = Math.max(1, Math.round(HISTORY_MAX_WINDOW_MS / DAY_MS));
  if (until - since > (maxDays - 1) * DAY_MS) since = until - (maxDays - 1) * DAY_MS;
  return { since, until };
}

function parseTimestamp(value) {
  if (value == null || value === '') return { value: null };
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return { value: Math.floor(numeric) };
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? { value: parsed } : { error: 'invalid_history_timestamp' };
}

function parseHistoryLimit(value) {
  if (value == null || value === '') return { limit: HISTORY_DEFAULT_LIMIT };
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return { error: 'invalid_history_limit' };
  return { limit: Math.min(HISTORY_MAX_LIMIT, Math.floor(number)) };
}

function parsePageLimit(value) {
  if (value == null || value === '') return PAGE_DEFAULT_LIMIT;
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? Math.min(PAGE_MAX_LIMIT, Math.floor(number)) : PAGE_DEFAULT_LIMIT;
}

function normalizeUserSort(value) {
  return new Set(['probability', 'legend', 'spend', 'pulls', 'sets', 'user']).has(value) ? value : 'legend';
}

function normalizeDirection(value, fallback = 'desc') {
  return value === 'asc' || value === 'desc' ? value : fallback;
}

function encodeHistoryCursor(value) {
  const bytes = new TextEncoder().encode(JSON.stringify({ mode: 'daily', ...value }));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeHistoryCursor(value, context) {
  if (value == null || value === '') return { cursor: null };
  try {
    const text = String(value);
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/')
      + '='.repeat((4 - (text.length % 4)) % 4));
    const cursor = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
    if (!cursor || cursor.mode !== 'daily'
      || cursor.seasonId !== context.seasonId
      || cursor.userId !== context.userId
      || Number(cursor.until) !== Number(context.until)
      || !Number.isFinite(Number(cursor.dayStartAt))) return { error: 'invalid_history_cursor' };
    return { cursor };
  } catch (_) {
    return { error: 'invalid_history_cursor' };
  }
}

function elapsedSeasonDays(now, capturedAt) {
  const start = Date.parse('2026-08-02T04:00:00+08:00');
  return Math.max(1, Math.min(90, Math.floor((Number(now || capturedAt) - start) / DAY_MS) + 1));
}

function numericOrNull(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders
    }
  });
}
