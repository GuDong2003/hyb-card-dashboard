import {
  estimateLegendProbability,
  estimatePullsFromSpend
} from './rankings-core.js';
import { dayStartAtForCapturedAt } from './rankings-daily.js';

export const COMPACT_BOARD_KEYS = Object.freeze([
  'sets_total', 'sets_month', 'sets_week', 'sets_today',
  'epic_total', 'epic_month', 'epic_week', 'epic_today',
  'spend_total', 'spend_month', 'spend_week', 'spend_today'
]);

const CUMULATIVE_BOARD_KEYS = new Set(
  COMPACT_BOARD_KEYS.filter((boardKey) => boardKey.endsWith('_total'))
);
const SOURCE_ORDER = Object.freeze(['global', 'friends']);
const SOURCE_ORDER_SET = new Set(SOURCE_ORDER);

export const USER_DAY_COLUMNS = Object.freeze([
  'season_id', 'day_start_at', 'user_id', 'user_name', 'avatar_url', 'is_vip',
  'active_name_decoration', 'name_display_preference', 'observed_at', 'source_scopes',
  ...COMPACT_BOARD_KEYS.flatMap((boardKey) => [
    `${boardKey}_value`, `${boardKey}_rank`, `${boardKey}_observed_at`
  ])
]);

export const USER_CURRENT_COLUMNS = Object.freeze([
  'season_id', 'user_id', 'user_name', 'avatar_url', 'is_vip',
  'active_name_decoration', 'name_display_preference', 'first_observed_at',
  'last_observed_at', 'source_scopes',
  ...COMPACT_BOARD_KEYS.flatMap((boardKey) => [
    `${boardKey}_value`, `${boardKey}_rank`, `${boardKey}_observed_at`
  ]),
  'sort_legend_value', 'sort_spend_usd', 'sort_estimated_pulls',
  'sort_exchange_count', 'sort_probability'
]);

export function mergeMetricField(existing, incoming, cumulative = false) {
  const current = normalizeMetricField(existing);
  const next = normalizeMetricField(incoming);
  if (!next) return current;
  if (!current) return next;

  const currentObservedAt = Number(current.observedAt);
  const nextObservedAt = Number(next.observedAt);
  const nextIsNewer = nextObservedAt > currentObservedAt
    || (nextObservedAt === currentObservedAt && isPreferredTie(next, current));

  if (cumulative) {
    return {
      value: Math.max(current.value, next.value),
      rank: nextIsNewer ? next.rank : current.rank,
      observedAt: Math.max(currentObservedAt, nextObservedAt)
    };
  }

  return nextIsNewer ? next : current;
}

export function mergeUserObservations(normalizedSnapshots = []) {
  const users = new Map();

  for (const normalized of normalizedSnapshots) {
    if (!normalized || !normalized.seasonId || !normalized.scope) continue;
    const capturedAt = positiveInteger(normalized.capturedAt);
    const dayStartAt = dayStartAtForCapturedAt(capturedAt);
    if (!capturedAt || dayStartAt == null) continue;

    for (const entry of normalized.entries || []) {
      if (!entry || !entry.userId || !COMPACT_BOARD_KEYS.includes(entry.boardKey)) continue;
      const userId = String(entry.userId).trim();
      if (!userId) continue;
      const key = `${normalized.seasonId}\u0000${dayStartAt}\u0000${userId}`;
      let row = users.get(key);
      if (!row) {
        row = emptyUserRow(normalized.seasonId, normalized.seasonName, dayStartAt, userId);
        users.set(key, row);
      }

      row.observed_at = Math.max(Number(row.observed_at || 0), capturedAt);
      row.source_scopes = mergeSourceScopes(row.source_scopes, normalized.scope);
      mergeProfile(row, entry, capturedAt);

      const boardKey = entry.boardKey;
      const incoming = {
        value: integerOrNull(entry.value),
        rank: positiveInteger(entry.rank),
        observedAt: capturedAt
      };
      const merged = mergeMetricField(
        metricFromRow(row, boardKey),
        incoming,
        CUMULATIVE_BOARD_KEYS.has(boardKey)
      );
      if (merged) writeMetricToRow(row, boardKey, merged);
    }
  }

  return Array.from(users.values())
    .sort((left, right) => left.season_id.localeCompare(right.season_id)
      || Number(left.day_start_at) - Number(right.day_start_at)
      || left.user_id.localeCompare(right.user_id));
}

export function hasMeaningfulUserChange(existing = {}, incoming = {}) {
  if (!existing || !incoming) return true;
  if (String(existing.user_id || '') !== String(incoming.user_id || '')) return true;

  for (const field of ['user_name', 'avatar_url', 'active_name_decoration', 'name_display_preference']) {
    const value = incoming[field];
    if (value != null && value !== '' && String(value) !== String(existing[field] ?? '')) return true;
  }
  if (Number(incoming.is_vip || 0) > Number(existing.is_vip || 0)) return true;

  const incomingScopes = normalizeScopes(incoming.source_scopes);
  if (incomingScopes && incomingScopes !== normalizeScopes(existing.source_scopes)) return true;

  for (const boardKey of COMPACT_BOARD_KEYS) {
    const incomingValue = incoming[`${boardKey}_value`];
    const incomingRank = incoming[`${boardKey}_rank`];
    if (incomingValue != null && Number(incomingValue) !== Number(existing[`${boardKey}_value`])) return true;
    if (incomingRank != null && Number(incomingRank) !== Number(existing[`${boardKey}_rank`])) return true;
  }
  return false;
}

export function shouldSkipSourceCapture(state, capturedAt) {
  const next = positiveInteger(capturedAt);
  const last = state && positiveInteger(state.last_captured_at ?? state.lastCapturedAt);
  return Boolean(next && last && next <= last);
}

export function compactHistoryRows(row = {}, boardKey = '') {
  const selectedKeys = boardKey && boardKey !== 'users'
    ? COMPACT_BOARD_KEYS.filter((key) => key === boardKey || key.startsWith(`${boardKey}_`))
    : COMPACT_BOARD_KEYS;
  const rows = [];
  for (const key of selectedKeys) {
    const value = row[`${key}_value`];
    if (value == null) continue;
    rows.push({
      season_id: row.season_id,
      day_start_at: Number(row.day_start_at),
      user_id: row.user_id,
      board_key: key,
      user_name: row.user_name || '',
      avatar_url: row.avatar_url || '',
      value: Number(value),
      rank: row[`${key}_rank`] == null ? null : Number(row[`${key}_rank`]),
      is_vip: Number(row.is_vip || 0),
      active_name_decoration: row.active_name_decoration ?? null,
      name_display_preference: row.name_display_preference ?? null,
      scope: row.source_scopes || '',
      captured_at: Number(row[`${key}_observed_at`] || row.observed_at || 0),
      snapshot_id: null
    });
  }
  return rows;
}

export function currentSortValues(row = {}, capturedAt = Date.now()) {
  const epicTotal = numericOrNull(row.epic_total_value);
  const spendValue = numericOrNull(row.spend_total_value);
  const exchangeCount = numericOrNull(row.sets_total_value);
  const isVip = Boolean(Number(row.is_vip || 0));
  const estimate = estimatePullsFromSpend(spendValue, isVip, {
    capturedAt,
    period: 'total'
  });
  const probability = estimateLegendProbability({
    epicTotal,
    spendValue,
    isVip,
    capturedAt,
    period: 'total'
  });
  return {
    sort_legend_value: epicTotal,
    sort_spend_usd: estimate.spendUsd,
    sort_estimated_pulls: estimate.estimatedPulls,
    sort_exchange_count: exchangeCount,
    sort_probability: probability
  };
}

export function encodeCurrentCursor(sort, direction, row, context = {}) {
  const rawValue = currentSortValue(row, context.board || 'users', context.period || 'total', sort);
  const payload = {
    seasonId: String(context.seasonId || row.season_id || ''),
    board: String(context.board || 'users'),
    period: String(context.period || 'total'),
    sort: String(sort || 'legend'),
    direction: direction === 'asc' ? 'asc' : 'desc',
    nullRank: rawValue == null ? 1 : 0,
    value: rawValue == null ? null : rawValue,
    userId: String(row.user_id || '')
  };
  return encodeBase64Url(payload);
}

export function decodeCurrentCursor(value, sort, direction, context = {}) {
  if (value == null || value === '') return { cursor: null };
  try {
    const cursor = decodeBase64Url(value);
    if (!cursor
      || cursor.seasonId !== String(context.seasonId || '')
      || cursor.board !== String(context.board || 'users')
      || cursor.period !== String(context.period || 'total')
      || cursor.sort !== String(sort || 'legend')
      || cursor.direction !== (direction === 'asc' ? 'asc' : 'desc')
      || !String(cursor.userId || '')
      || ![0, 1].includes(Number(cursor.nullRank))) {
      return { error: 'invalid_cursor' };
    }
    return { cursor };
  } catch (_) {
    return { error: 'invalid_cursor' };
  }
}

export async function queryCurrentBoard(db, options = {}) {
  const seasonId = String(options.seasonId || '').trim();
  const board = String(options.board || 'users');
  const period = String(options.period || 'total');
  const sort = String(options.sort || 'legend');
  const direction = options.direction === 'asc' ? 'asc' : 'desc';
  const limit = Math.max(1, Math.min(100, Math.floor(Number(options.limit) || 50)));
  const sortColumn = currentSortColumn(board, period, sort);
  const nullRank = `CASE WHEN ${sortColumn} IS NULL THEN 1 ELSE 0 END`;
  const params = [seasonId];
  const where = ['r.season_id = ?'];

  if (Array.isArray(options.ids) && options.ids.length) {
    const ids = options.ids.map((id) => String(id || '').trim()).filter(Boolean).slice(0, 20);
    where.push(`r.user_id IN (${ids.map(() => '?').join(', ')})`);
    params.push(...ids);
  } else if (String(options.q || '').trim()) {
    const pattern = `%${escapeLikePattern(String(options.q).trim())}%`;
    where.push(`(r.user_id COLLATE NOCASE LIKE ? ESCAPE '\\' OR r.user_name COLLATE NOCASE LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }

  if (options.cursor) {
    const cursor = options.cursor;
    const cursorNullRank = Number(cursor.nullRank);
    where.push(`(
      ${nullRank} > ?
      OR (${nullRank} = ? AND (
        ${cursorNullRank === 1
          ? 'r.user_id > ?'
          : `(${sortColumn} ${direction === 'asc' ? '>' : '<'} ?
              OR (${sortColumn} = ? AND r.user_id > ?))`}
      ))
    )`);
    params.push(cursorNullRank, cursorNullRank);
    if (cursorNullRank === 1) params.push(String(cursor.userId));
    else params.push(cursor.value, cursor.value, String(cursor.userId));
  }

  const result = await db.prepare(`
    SELECT ${USER_CURRENT_COLUMNS.map((column) => `r.${column} AS ${column}`).join(', ')}
    FROM rank_user_current r
    WHERE ${where.join(' AND ')}
    ORDER BY ${nullRank} ASC, ${sortColumn} ${direction.toUpperCase()}, r.user_id ASC
    LIMIT ?
  `).bind(...params, limit + 1).all();
  const rows = result.results || [];
  const pageRows = rows.slice(0, limit);
  return {
    rows: pageRows,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit && pageRows.length
      ? encodeCurrentCursor(sort, direction, pageRows[pageRows.length - 1], { seasonId, board, period })
      : null
  };
}

export async function queryPinnedUsers(db, options = {}) {
  return queryCurrentBoard(db, {
    ...options,
    ids: Array.isArray(options.ids) ? options.ids.slice(0, 20) : [],
    limit: Math.min(20, Number(options.limit) || 20),
    cursor: null
  });
}

function currentSortColumn(board, period, sort) {
  if (board === 'users') {
    return sort === 'user'
      ? 'r.user_name COLLATE NOCASE'
      : sort === 'spend'
        ? 'r.sort_spend_usd'
        : sort === 'pulls'
          ? 'r.sort_estimated_pulls'
          : sort === 'sets'
            ? 'r.sort_exchange_count'
            : sort === 'probability'
              ? 'r.sort_probability'
              : 'r.sort_legend_value';
  }
  if (board === 'luck') return 'r.sort_probability';
  if (!['epic', 'spend', 'sets'].includes(board) || !['today', 'week', 'month', 'total'].includes(period)) {
    return 'r.sort_legend_value';
  }
  return `r.${board}_${period}_value`;
}

function currentSortValue(row, board, period, sort) {
  if (board === 'users') {
    if (sort === 'user') return String(row.user_name || '');
    if (sort === 'spend') return row.sort_spend_usd;
    if (sort === 'pulls') return row.sort_estimated_pulls;
    if (sort === 'sets') return row.sort_exchange_count;
    if (sort === 'probability') return row.sort_probability;
    return row.sort_legend_value;
  }
  if (board === 'luck') return row.sort_probability;
  return row[`${board}_${period}_value`];
}

function escapeLikePattern(value) {
  return String(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
}

function encodeBase64Url(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeBase64Url(value) {
  const text = String(value);
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (text.length % 4)) % 4));
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0))));
}

export const USER_DAY_UPSERT_SQL = buildUpsertSql('rank_user_days', USER_DAY_COLUMNS, false);
export const USER_CURRENT_UPSERT_SQL = buildUpsertSql('rank_user_current', USER_CURRENT_COLUMNS, true);

export const SEASON_UPSERT_SQL = `
  INSERT INTO rank_seasons (
    season_id, season_name, last_observed_at, last_day_start_at, updated_at
  ) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (season_id) DO UPDATE SET
    season_name = CASE WHEN excluded.season_name <> '' THEN excluded.season_name ELSE rank_seasons.season_name END,
    last_observed_at = MAX(rank_seasons.last_observed_at, excluded.last_observed_at),
    last_day_start_at = MAX(rank_seasons.last_day_start_at, excluded.last_day_start_at),
    updated_at = MAX(rank_seasons.updated_at, excluded.updated_at)
`;

export const INGEST_STATE_UPSERT_SQL = `
  INSERT INTO rank_ingest_state (
    season_id, scope, last_captured_at, updated_at
  ) VALUES (?, ?, ?, ?)
  ON CONFLICT (season_id, scope) DO UPDATE SET
    last_captured_at = MAX(rank_ingest_state.last_captured_at, excluded.last_captured_at),
    updated_at = MAX(rank_ingest_state.updated_at, excluded.updated_at)
`;

export async function storeUserObservations(db, normalizedSnapshots = [], source = '', now = Date.now()) {
  void source;
  const grouped = new Map();
  for (const normalized of normalizedSnapshots) {
    if (!normalized || !normalized.seasonId || !normalized.scope) continue;
    const key = `${normalized.seasonId}\u0000${normalized.scope}`;
    const group = grouped.get(key) || {
      seasonId: normalized.seasonId,
      seasonName: normalized.seasonName || '',
      scope: normalized.scope,
      snapshots: [],
      capturedAt: 0
    };
    group.snapshots.push(normalized);
    group.seasonName = normalized.seasonName || group.seasonName;
    group.capturedAt = Math.max(group.capturedAt, Number(normalized.capturedAt) || 0);
    grouped.set(key, group);
  }

  const result = {
    users: 0,
    changedUsers: 0,
    changedDays: 0,
    changedFields: 0,
    skippedScopes: []
  };

  for (const group of grouped.values()) {
    const state = await db.prepare(`
      SELECT last_captured_at
      FROM rank_ingest_state
      WHERE season_id = ? AND scope = ?
      LIMIT 1
    `).bind(group.seasonId, group.scope).first();
    if (shouldSkipSourceCapture(state, group.capturedAt)) {
      result.skippedScopes.push({
        seasonId: group.seasonId,
        scope: group.scope,
        capturedAt: group.capturedAt,
        lastCapturedAt: Number(state.last_captured_at)
      });
      continue;
    }

    const rows = mergeUserObservations(group.snapshots);
    if (!rows.length) throw new Error('empty_entries');
    result.users += rows.length;

    for (const chunk of chunks(rows, 50)) {
      const statements = [];
      for (const row of chunk) {
        statements.push(db.prepare(USER_DAY_UPSERT_SQL).bind(...userDayValues(row)));
      }
      for (const row of chunk) {
        statements.push(db.prepare(USER_CURRENT_UPSERT_SQL).bind(...userCurrentValues(row)));
      }
      const batchResults = await db.batch(statements);
      const changes = Array.isArray(batchResults)
        ? batchResults.map((item) => Number(item && item.meta && item.meta.changes || 0))
        : [];
      const dayChanges = changes.slice(0, chunk.length).reduce((sum, value) => sum + value, 0);
      const currentChanges = changes.slice(chunk.length).reduce((sum, value) => sum + value, 0);
      result.changedDays += dayChanges;
      result.changedFields += dayChanges + currentChanges;
      result.changedUsers += chunk.filter((_, index) => changes[index] || changes[chunk.length + index]).length;
    }

    const latestDayStartAt = rows.reduce((max, row) => Math.max(max, Number(row.day_start_at)), 0);
    await db.prepare(SEASON_UPSERT_SQL).bind(
      group.seasonId,
      group.seasonName,
      group.capturedAt,
      latestDayStartAt,
      now
    ).run();
    await db.prepare(INGEST_STATE_UPSERT_SQL).bind(
      group.seasonId,
      group.scope,
      group.capturedAt,
      now
    ).run();
  }

  return result;
}

function buildUpsertSql(tableName, columns, currentTable) {
  const insertColumns = columns.join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const updates = [];
  updates.push('user_name = CASE WHEN excluded.user_name <> \'\' THEN excluded.user_name ELSE ' + tableName + '.user_name END');
  updates.push('avatar_url = CASE WHEN excluded.avatar_url <> \'\' THEN excluded.avatar_url ELSE ' + tableName + '.avatar_url END');
  updates.push('is_vip = MAX(' + tableName + '.is_vip, excluded.is_vip)');
  updates.push('active_name_decoration = COALESCE(excluded.active_name_decoration, ' + tableName + '.active_name_decoration)');
  updates.push('name_display_preference = COALESCE(excluded.name_display_preference, ' + tableName + '.name_display_preference)');
  updates.push('source_scopes = ' + mergedScopesSql(tableName));

  if (currentTable) {
    updates.push(`first_observed_at = MIN(${tableName}.first_observed_at, excluded.first_observed_at)`);
    updates.push(`last_observed_at = MAX(${tableName}.last_observed_at, excluded.last_observed_at)`);
  } else {
    updates.push(`observed_at = MAX(${tableName}.observed_at, excluded.observed_at)`);
  }

  for (const boardKey of COMPACT_BOARD_KEYS) {
    const valueColumn = `${boardKey}_value`;
    const rankColumn = `${boardKey}_rank`;
    const observedColumn = `${boardKey}_observed_at`;
    const cumulative = CUMULATIVE_BOARD_KEYS.has(boardKey);
    const existingObserved = `${tableName}.${observedColumn}`;
    const newer = `(excluded.${observedColumn} IS NOT NULL AND (${existingObserved} IS NULL OR excluded.${observedColumn} > ${existingObserved} OR (excluded.${observedColumn} = ${existingObserved} AND (excluded.${valueColumn} > COALESCE(${tableName}.${valueColumn}, -1) OR (excluded.${valueColumn} = ${tableName}.${valueColumn} AND excluded.${rankColumn} < ${tableName}.${rankColumn})))))`;
    const dataDiff = `(excluded.${valueColumn} IS NOT ${tableName}.${valueColumn} OR excluded.${rankColumn} IS NOT ${tableName}.${rankColumn})`;
    const cumulativeValueChanged = `(excluded.${valueColumn} IS NOT NULL AND (${tableName}.${valueColumn} IS NULL OR excluded.${valueColumn} > ${tableName}.${valueColumn}))`;
    const metricChanged = cumulative
      ? `(${cumulativeValueChanged} OR (${newer} AND excluded.${rankColumn} IS NOT ${tableName}.${rankColumn}))`
      : `(${newer} AND ${dataDiff})`;
    if (cumulative) {
      updates.push(`${valueColumn} = CASE WHEN ${cumulativeValueChanged} THEN excluded.${valueColumn} ELSE ${tableName}.${valueColumn} END`);
      updates.push(`${rankColumn} = CASE WHEN ${newer} THEN excluded.${rankColumn} ELSE ${tableName}.${rankColumn} END`);
      updates.push(`${observedColumn} = CASE WHEN ${metricChanged} THEN MAX(${tableName}.${observedColumn}, excluded.${observedColumn}) ELSE ${tableName}.${observedColumn} END`);
    } else {
      updates.push(`${valueColumn} = CASE WHEN ${newer} THEN excluded.${valueColumn} ELSE ${tableName}.${valueColumn} END`);
      updates.push(`${rankColumn} = CASE WHEN ${newer} THEN excluded.${rankColumn} ELSE ${tableName}.${rankColumn} END`);
      updates.push(`${observedColumn} = CASE WHEN ${metricChanged} THEN excluded.${observedColumn} ELSE ${tableName}.${observedColumn} END`);
    }
  }

  if (currentTable) {
    for (const column of ['sort_legend_value', 'sort_spend_usd', 'sort_estimated_pulls', 'sort_exchange_count', 'sort_probability']) {
      updates.push(`${column} = COALESCE(excluded.${column}, ${tableName}.${column})`);
    }
  }

  return `INSERT INTO ${tableName} (${insertColumns}) VALUES (${placeholders})
ON CONFLICT DO UPDATE SET
  ${updates.join(',\n  ')}
WHERE ${meaningfulChangeSql(tableName, columns, currentTable)}`;
}

function meaningfulChangeSql(tableName, columns, currentTable) {
  const checks = [
    `(excluded.user_name <> '' AND excluded.user_name <> ${tableName}.user_name)`,
    `(excluded.avatar_url <> '' AND excluded.avatar_url <> ${tableName}.avatar_url)`,
    `(excluded.is_vip > ${tableName}.is_vip)`,
    `(excluded.active_name_decoration IS NOT NULL AND excluded.active_name_decoration IS NOT ${tableName}.active_name_decoration)`,
    `(excluded.name_display_preference IS NOT NULL AND excluded.name_display_preference IS NOT ${tableName}.name_display_preference)`,
    `(excluded.source_scopes <> ${tableName}.source_scopes)`
  ];
  for (const boardKey of COMPACT_BOARD_KEYS) {
    const valueColumn = `${boardKey}_value`;
    const rankColumn = `${boardKey}_rank`;
    const observedColumn = `${boardKey}_observed_at`;
    const cumulative = CUMULATIVE_BOARD_KEYS.has(boardKey);
    const existingObserved = `${tableName}.${observedColumn}`;
    checks.push(`(excluded.${valueColumn} IS NOT NULL AND (${tableName}.${valueColumn} IS NULL OR excluded.${valueColumn} > ${tableName}.${valueColumn}${cumulative ? '' : ` OR (${`(${existingObserved} IS NULL OR excluded.${observedColumn} > ${existingObserved} OR (excluded.${observedColumn} = ${existingObserved} AND excluded.${valueColumn} <> ${tableName}.${valueColumn}))`} AND excluded.${valueColumn} <> ${tableName}.${valueColumn})`}))`);
    checks.push(`(excluded.${rankColumn} IS NOT NULL AND excluded.${rankColumn} <> ${tableName}.${rankColumn} AND excluded.${observedColumn} IS NOT NULL AND (${existingObserved} IS NULL OR excluded.${observedColumn} >= ${existingObserved}))`);
  }
  if (currentTable) {
    for (const column of ['sort_legend_value', 'sort_spend_usd', 'sort_estimated_pulls', 'sort_exchange_count', 'sort_probability']) {
      checks.push(`(excluded.${column} IS NOT NULL AND (${tableName}.${column} IS NULL OR excluded.${column} <> ${tableName}.${column}))`);
    }
  }
  return checks.join(' OR\n    ');
}

function mergedScopesSql(tableName) {
  return `CASE
    WHEN instr(',' || ${tableName}.source_scopes || ',', ',global,') > 0
      OR instr(',' || excluded.source_scopes || ',', ',global,') > 0
      THEN CASE
        WHEN instr(',' || ${tableName}.source_scopes || ',', ',friends,') > 0
          OR instr(',' || excluded.source_scopes || ',', ',friends,') > 0
          THEN 'global,friends'
        ELSE 'global'
      END
    WHEN instr(',' || ${tableName}.source_scopes || ',', ',friends,') > 0
      OR instr(',' || excluded.source_scopes || ',', ',friends,') > 0
      THEN 'friends'
    ELSE COALESCE(NULLIF(excluded.source_scopes, ''), ${tableName}.source_scopes)
  END`;
}

function emptyUserRow(seasonId, seasonName, dayStartAt, userId) {
  const row = {
    season_id: seasonId,
    season_name: seasonName || '',
    day_start_at: dayStartAt,
    user_id: userId,
    user_name: '',
    avatar_url: '',
    is_vip: 0,
    active_name_decoration: null,
    name_display_preference: null,
    observed_at: 0,
    source_scopes: ''
  };
  for (const boardKey of COMPACT_BOARD_KEYS) {
    row[`${boardKey}_value`] = null;
    row[`${boardKey}_rank`] = null;
    row[`${boardKey}_observed_at`] = null;
  }
  return row;
}

function mergeProfile(row, entry, capturedAt) {
  const latestProfileAt = Number(row.profile_observed_at || 0);
  if (capturedAt >= latestProfileAt) {
    if (entry.userName) row.user_name = String(entry.userName);
    if (entry.avatar) row.avatar_url = String(entry.avatar);
    if (entry.activeNameDecoration != null) row.active_name_decoration = String(entry.activeNameDecoration);
    if (entry.nameDisplayPreference != null) row.name_display_preference = String(entry.nameDisplayPreference);
    row.profile_observed_at = capturedAt;
  }
  if (entry.isVip) row.is_vip = 1;
}

function metricFromRow(row, boardKey) {
  const value = row[`${boardKey}_value`];
  const rank = row[`${boardKey}_rank`];
  const observedAt = row[`${boardKey}_observed_at`];
  return value == null || rank == null || observedAt == null
    ? null
    : { value, rank, observedAt };
}

function writeMetricToRow(row, boardKey, metric) {
  row[`${boardKey}_value`] = metric.value;
  row[`${boardKey}_rank`] = metric.rank;
  row[`${boardKey}_observed_at`] = metric.observedAt;
}

function normalizeMetricField(value) {
  if (!value || typeof value !== 'object') return null;
  const normalizedValue = integerOrNull(value.value);
  const normalizedRank = positiveInteger(value.rank);
  const observedAt = positiveInteger(value.observedAt ?? value.observed_at);
  if (normalizedValue == null || normalizedRank == null || observedAt == null) return null;
  return { value: normalizedValue, rank: normalizedRank, observedAt };
}

function isPreferredTie(next, current) {
  return Number(next.value) > Number(current.value)
    || (Number(next.value) === Number(current.value) && Number(next.rank) < Number(current.rank));
}

function mergeSourceScopes(existing, incoming) {
  return normalizeScopes([existing, incoming].filter(Boolean).join(','));
}

function normalizeScopes(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',');
  const unique = new Set(values.map((item) => String(item || '').trim()).filter(Boolean));
  return [
    ...SOURCE_ORDER.filter((scope) => unique.has(scope)),
    ...Array.from(unique).filter((scope) => !SOURCE_ORDER_SET.has(scope)).sort()
  ].join(',');
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function userDayValues(row) {
  return USER_DAY_COLUMNS.map((column) => row[column] ?? null);
}

function userCurrentValues(row) {
  const sortValues = currentSortValues(row, row.observed_at);
  const current = {
    season_id: row.season_id,
    user_id: row.user_id,
    user_name: row.user_name,
    avatar_url: row.avatar_url,
    is_vip: row.is_vip,
    active_name_decoration: row.active_name_decoration,
    name_display_preference: row.name_display_preference,
    first_observed_at: row.observed_at,
    last_observed_at: row.observed_at,
    source_scopes: row.source_scopes,
    ...Object.fromEntries(COMPACT_BOARD_KEYS.flatMap((boardKey) => [
      [`${boardKey}_value`, row[`${boardKey}_value`]],
      [`${boardKey}_rank`, row[`${boardKey}_rank`]],
      [`${boardKey}_observed_at`, row[`${boardKey}_observed_at`]]
    ])),
    ...sortValues
  };
  return USER_CURRENT_COLUMNS.map((column) => current[column] ?? null);
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}
