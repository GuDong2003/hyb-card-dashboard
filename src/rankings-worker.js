import {
  BOARD_KEYS,
  REFRESH_INTERVAL_MS,
  computeSnapshotSignature,
  diffBoardRows,
  estimateLegendProbability,
  normalizeLeaderboardSnapshot
} from './rankings-core.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SEASON_START_AT = Date.parse('2026-08-02T04:00:00+08:00');
const BOARD_GROUPS = new Set(['epic', 'spend', 'sets']);
const PERIODS = new Set(['today', 'week', 'month', 'total']);
const MAX_LIMIT = 100;
const MAX_EVENT_ROWS = 200;

export async function handleRankingsRequest(request, env) {
  if (!env || !env.RANKINGS_DB) {
    return jsonResponse({ ok: false, error: 'database_unavailable' }, 503);
  }

  const url = new URL(request.url);
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
    return jsonResponse({
      ok: false,
      error: 'database_error',
      message: String(error && error.message || error).slice(0, 240)
    }, 500);
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
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const now = Date.now();
  const normalized = normalizeLeaderboardSnapshot(body && body.snapshot ? body.snapshot : body, now);
  if (!normalized.ok) return jsonResponse({ ok: false, error: 'invalid_snapshot', reason: normalized.reason }, 400);
  if (!normalized.entries.length) return jsonResponse({ ok: false, error: 'invalid_snapshot', reason: 'empty_entries' }, 400);

  const signatureInput = {
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
  const signature = await computeSnapshotSignature(signatureInput);
  const existing = await env.RANKINGS_DB.prepare(`
    SELECT id, season_id, season_name, scope, captured_at, captured_bucket, source, signature, created_at
    FROM rank_snapshots
    WHERE season_id = ? AND scope = ? AND captured_bucket = ?
    LIMIT 1
  `).bind(normalized.seasonId, normalized.scope, normalized.capturedBucket).first();
  if (existing) {
    return jsonResponse({ ok: true, status: 'duplicate', snapshot: serializeSnapshot(existing) });
  }

  const source = String(body && body.source || 'card-dashboard-userscript').slice(0, 64);
  const insertResult = await env.RANKINGS_DB.prepare(`
    INSERT INTO rank_snapshots (
      season_id, season_name, scope, captured_at, captured_bucket,
      source, signature, raw_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  return jsonResponse({
    ok: true,
    status: 'accepted',
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
  });
}

async function getLeaderboard(url, env) {
  const board = String(url.searchParams.get('board') || 'epic');
  const period = String(url.searchParams.get('period') || 'total');
  if (!BOARD_GROUPS.has(board) || !PERIODS.has(period)) {
    return jsonResponse({ ok: false, error: 'invalid_board_or_period' }, 400);
  }
  const latest = await latestSnapshot(env);
  if (!latest) return jsonResponse({ ok: true, snapshot: null, rows: [], board, period });

  const limit = normalizeLimit(url.searchParams.get('limit'));
  const boardKey = `${board}_${period}`;
  const previous = await previousSnapshot(env, latest);
  const [currentRows, previousRows, totals] = await Promise.all([
    entriesForSnapshot(env, latest.id, boardKey, limit),
    previous ? entriesForSnapshot(env, previous.id, boardKey, MAX_LIMIT) : Promise.resolve([]),
    totalEntries(env, latest.id)
  ]);
  const previousById = new Map(previousRows.map((row) => [row.user_id, row]));
  const totalById = totalsByUser(totals);
  const elapsedDays = elapsedSeasonDays(Date.now());
  const rows = currentRows.map((row) => {
    const previousRow = previousById.get(row.user_id);
    const epicTotal = totalById.get(row.user_id)?.epicTotal ?? (boardKey === 'epic_total' ? row.value : null);
    const spendTotal = totalById.get(row.user_id)?.spendTotal ?? (boardKey === 'spend_total' ? row.value : null);
    const probability = epicTotal == null && spendTotal == null
      ? null
      : estimateLegendProbability({ epicTotal, spendTotal, elapsedDays, isVip: Boolean(row.is_vip) });
    return {
      ...serializeEntry(row),
      previousRank: previousRow ? Number(previousRow.rank) : null,
      previousValue: previousRow ? Number(previousRow.value) : null,
      rankDelta: previousRow ? Number(previousRow.rank) - Number(row.rank) : null,
      valueDelta: previousRow ? Number(row.value) - Number(previousRow.value) : null,
      event: previousRow ? (Number(previousRow.rank) === Number(row.rank) ? '' : 'moved') : 'entered',
      epicTotal,
      spendTotal,
      estimatedPulls: probability == null ? null : estimatedPulls(spendTotal, elapsedDays, Boolean(row.is_vip)),
      estimatedLegendProbability: probability
    };
  });

  return jsonResponse({
    ok: true,
    board,
    period,
    boardKey,
    snapshot: serializeSnapshot(latest),
    previousSnapshot: previous ? serializeSnapshot(previous) : null,
    elapsedDays,
    estimated: true,
    rows
  });
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
  const filtered = (rows.results || []).filter((row) => !board || row.board_key.startsWith(`${board}_`));
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

async function getUsers(url, env) {
  const query = String(url.searchParams.get('query') || '').trim().toLowerCase();
  if (query.length < 1) return jsonResponse({ ok: true, users: [] });
  const latest = await latestSnapshot(env);
  if (!latest) return jsonResponse({ ok: true, users: [] });
  const rows = await env.RANKINGS_DB.prepare(`
    SELECT e.user_id, e.user_name, e.avatar_url, e.is_vip, MAX(s.captured_at) AS last_seen_at
    FROM rank_entries e
    JOIN rank_snapshots s ON s.id = e.snapshot_id
    WHERE s.season_id = ?
    GROUP BY e.user_id, e.user_name, e.avatar_url, e.is_vip
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
  const result = await env.RANKINGS_DB.prepare(`
    SELECT snapshot_id, board_key, user_id, user_name, avatar_url, value, rank,
      is_vip, active_name_decoration, name_display_preference, raw_json
    FROM rank_entries
    WHERE snapshot_id = ? AND board_key = ?
    ORDER BY rank ASC
    LIMIT ?
  `).bind(snapshotId, boardKey, normalizeLimit(limit)).all();
  return result.results || [];
}

async function totalEntries(env, snapshotId) {
  const result = await env.RANKINGS_DB.prepare(`
    SELECT board_key, user_id, value, is_vip
    FROM rank_entries
    WHERE snapshot_id = ? AND board_key IN ('epic_total', 'spend_total')
  `).bind(snapshotId).all();
  return result.results || [];
}

function totalsByUser(rows) {
  const map = new Map();
  for (const row of rows) {
    const value = map.get(row.user_id) || {};
    if (row.board_key === 'epic_total') value.epicTotal = Number(row.value);
    if (row.board_key === 'spend_total') value.spendTotal = Number(row.value);
    map.set(row.user_id, value);
  }
  return map;
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
