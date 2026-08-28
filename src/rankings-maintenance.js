import {
  currentSortValues
} from './rankings-user-store.js';
import {
  previousBeijingDayStart
} from './rankings-daily.js';

export const COMPACT_CURRENT_SELECT_SQL = `
  SELECT season_id, user_id, is_vip, last_observed_at,
    epic_total_value, epic_total_observed_at,
    spend_total_value, spend_total_observed_at, sets_total_value,
    epic_today_value, epic_today_observed_at,
    spend_today_value, spend_today_observed_at,
    epic_week_value, epic_week_observed_at,
    spend_week_value, spend_week_observed_at,
    epic_month_value, epic_month_observed_at,
    spend_month_value, spend_month_observed_at,
    sort_legend_value, sort_spend_usd, sort_estimated_pulls,
    sort_exchange_count, sort_probability,
    sort_today_estimated_pulls, sort_today_probability,
    sort_week_estimated_pulls, sort_week_probability,
    sort_month_estimated_pulls, sort_month_probability
  FROM rank_user_current
  ORDER BY season_id ASC, user_id ASC
`;

export const COMPACT_SORT_UPDATE_SQL = `
  UPDATE rank_user_current
  SET sort_legend_value = ?,
      sort_spend_usd = ?,
      sort_estimated_pulls = ?,
      sort_exchange_count = ?,
      sort_probability = ?,
      sort_today_estimated_pulls = ?,
      sort_today_probability = ?,
      sort_week_estimated_pulls = ?,
      sort_week_probability = ?,
      sort_month_estimated_pulls = ?,
      sort_month_probability = ?
  WHERE season_id = ? AND user_id = ?
`;

export const COMPACT_SEASON_UPDATE_SQL = `
  UPDATE rank_seasons
  SET last_day_start_at = MAX(last_day_start_at, ?),
      updated_at = MAX(updated_at, ?)
  WHERE season_id = ?
`;

export async function refreshCompactRankings(db, now = Date.now()) {
  if (!db || typeof db.prepare !== 'function') throw new Error('rankings_database_unavailable');
  const capturedAt = Number(now);
  if (!Number.isFinite(capturedAt) || capturedAt <= 0) throw new Error('invalid_maintenance_time');
  const dayStartAt = previousBeijingDayStart(capturedAt);
  if (dayStartAt == null) throw new Error('invalid_maintenance_day');

  const result = await db.prepare(COMPACT_CURRENT_SELECT_SQL).all();
  const rows = result.results || [];
  const updates = [];
  const seasons = new Set();

  for (const row of rows) {
    const seasonId = String(row.season_id || '').trim();
    const userId = String(row.user_id || '').trim();
    if (!seasonId || !userId) continue;
    seasons.add(seasonId);
    const sortValues = currentSortValues(row, capturedAt);
    if (sameSortValues(row, sortValues)) continue;
    updates.push(db.prepare(COMPACT_SORT_UPDATE_SQL).bind(
      sortValues.sort_legend_value,
      sortValues.sort_spend_usd,
      sortValues.sort_estimated_pulls,
      sortValues.sort_exchange_count,
      sortValues.sort_probability,
      sortValues.sort_today_estimated_pulls,
      sortValues.sort_today_probability,
      sortValues.sort_week_estimated_pulls,
      sortValues.sort_week_probability,
      sortValues.sort_month_estimated_pulls,
      sortValues.sort_month_probability,
      seasonId,
      userId
    ));
  }

  let usersChanged = 0;
  for (const chunk of chunks(updates, 50)) {
    if (!chunk.length) continue;
    const results = await db.batch(chunk);
    usersChanged += Array.isArray(results)
      ? results.filter((item) => Number(item && item.meta && item.meta.changes || 0) > 0).length
      : chunk.length;
  }

  const seasonUpdates = Array.from(seasons, (seasonId) => db.prepare(COMPACT_SEASON_UPDATE_SQL).bind(
    dayStartAt,
    capturedAt,
    seasonId
  ));
  for (const chunk of chunks(seasonUpdates, 50)) {
    if (chunk.length) await db.batch(chunk);
  }

  return {
    usersScanned: rows.length,
    usersChanged,
    dayStartAt
  };
}

function sameSortValues(row, next) {
  return [
    'sort_legend_value',
    'sort_spend_usd',
    'sort_estimated_pulls',
    'sort_exchange_count',
    'sort_probability',
    'sort_today_estimated_pulls',
    'sort_today_probability',
    'sort_week_estimated_pulls',
    'sort_week_probability',
    'sort_month_estimated_pulls',
    'sort_month_probability'
  ].every((column) => sameNullableNumber(row[column], next[column]));
}

function sameNullableNumber(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return Number(left) === Number(right);
}

function chunks(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}
