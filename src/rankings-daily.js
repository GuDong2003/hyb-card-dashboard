export const DAY_MS = 24 * 60 * 60 * 1000;
export const RESET_HOUR_MS = 4 * 60 * 60 * 1000;
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
export const DAY_BOUNDARY_OFFSET_MS = RESET_HOUR_MS - BEIJING_OFFSET_MS;

export const DAILY_AGGREGATION_SQL = `
  WITH candidates AS (
    SELECT s.season_id, s.id AS snapshot_id,
      CAST((s.captured_at - ${DAY_BOUNDARY_OFFSET_MS}) / ${DAY_MS} AS INTEGER) * ${DAY_MS} + ${DAY_BOUNDARY_OFFSET_MS} AS day_start_at,
      e.board_key, e.user_id, e.user_name, e.avatar_url, e.value, e.rank,
      e.is_vip, e.active_name_decoration, e.name_display_preference,
      s.scope, s.captured_at
    FROM rank_entries e
    JOIN rank_snapshots s ON s.id = e.snapshot_id
    WHERE s.accepted = 1 AND s.captured_at >= ? AND s.captured_at < ?
  ), ranked AS (
    SELECT candidates.*,
      ROW_NUMBER() OVER (
        PARTITION BY season_id, day_start_at, user_id, board_key
        ORDER BY captured_at DESC, value DESC, snapshot_id DESC, rank ASC
      ) AS day_order
    FROM candidates
  )
  SELECT season_id, day_start_at, user_id, board_key, user_name, avatar_url,
    value, rank, is_vip, active_name_decoration, name_display_preference,
    snapshot_id, scope, captured_at
  FROM ranked
  WHERE day_order = 1
`;

export const DAILY_UPSERT_SQL = `
  INSERT INTO rank_daily_metrics (
    season_id, day_start_at, user_id, board_key, user_name, avatar_url,
    value, rank, is_vip, active_name_decoration, name_display_preference,
    snapshot_id, scope, captured_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (season_id, day_start_at, user_id, board_key) DO UPDATE SET
    user_name = excluded.user_name,
    avatar_url = excluded.avatar_url,
    value = excluded.value,
    rank = excluded.rank,
    is_vip = excluded.is_vip,
    active_name_decoration = excluded.active_name_decoration,
    name_display_preference = excluded.name_display_preference,
    snapshot_id = excluded.snapshot_id,
    scope = excluded.scope,
    captured_at = excluded.captured_at
`;

export function buildDailyAggregationSql(dayStartAt) {
  const normalizedDayStartAt = dayStartAtForCapturedAt(dayStartAt);
  if (normalizedDayStartAt == null || normalizedDayStartAt !== Number(dayStartAt)) {
    throw new Error('invalid_day_start_at');
  }
  const dayEndAt = normalizedDayStartAt + DAY_MS;
  return `
    WITH candidates AS (
      SELECT s.season_id, s.id AS snapshot_id,
        CAST((s.captured_at - ${DAY_BOUNDARY_OFFSET_MS}) / ${DAY_MS} AS INTEGER) * ${DAY_MS} + ${DAY_BOUNDARY_OFFSET_MS} AS day_start_at,
        e.board_key, e.user_id, e.user_name, e.avatar_url, e.value, e.rank,
        e.is_vip, e.active_name_decoration, e.name_display_preference,
        s.scope, s.captured_at
      FROM rank_entries e
      JOIN rank_snapshots s ON s.id = e.snapshot_id
      WHERE s.accepted = 1
        AND s.captured_at >= ${normalizedDayStartAt}
        AND s.captured_at < ${dayEndAt}
    ), ranked AS (
      SELECT candidates.*,
        ROW_NUMBER() OVER (
          PARTITION BY season_id, day_start_at, user_id, board_key
          ORDER BY captured_at DESC, value DESC, snapshot_id DESC, rank ASC
        ) AS day_order
      FROM candidates
    )
    INSERT INTO rank_daily_metrics (
      season_id, day_start_at, user_id, board_key, user_name, avatar_url,
      value, rank, is_vip, active_name_decoration, name_display_preference,
      snapshot_id, scope, captured_at
    )
    SELECT season_id, day_start_at, user_id, board_key, user_name, avatar_url,
      value, rank, is_vip, active_name_decoration, name_display_preference,
      snapshot_id, scope, captured_at
    FROM ranked
    WHERE day_order = 1
    ON CONFLICT (season_id, day_start_at, user_id, board_key) DO UPDATE SET
      user_name = excluded.user_name,
      avatar_url = excluded.avatar_url,
      value = excluded.value,
      rank = excluded.rank,
      is_vip = excluded.is_vip,
      active_name_decoration = excluded.active_name_decoration,
      name_display_preference = excluded.name_display_preference,
      snapshot_id = excluded.snapshot_id,
      scope = excluded.scope,
      captured_at = excluded.captured_at;
  `;
}

export function dayStartAtForCapturedAt(capturedAt) {
  const value = Number(capturedAt);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor((value - DAY_BOUNDARY_OFFSET_MS) / DAY_MS) * DAY_MS + DAY_BOUNDARY_OFFSET_MS;
}

export function metricPairObservation(epicValue, epicObservedAt, spendValue, spendObservedAt) {
  const hasEpic = epicValue != null && epicValue !== '' && Number.isFinite(Number(epicValue));
  const hasSpend = spendValue != null && spendValue !== '' && Number.isFinite(Number(spendValue));
  if (!hasEpic && !hasSpend) return { status: 'missing_pair', paired: false, staleDayStartAt: null };
  if (!hasEpic) return { status: 'missing_epic', paired: false, staleDayStartAt: null };
  if (!hasSpend) return { status: 'missing_spend', paired: false, staleDayStartAt: null };

  const epicDayStartAt = dayStartAtForCapturedAt(epicObservedAt);
  const spendDayStartAt = dayStartAtForCapturedAt(spendObservedAt);
  if (epicDayStartAt == null && spendDayStartAt == null) {
    return { status: 'missing_current_pair', paired: false, staleDayStartAt: null };
  }
  if (epicDayStartAt == null) {
    return { status: 'missing_current_epic', paired: false, staleDayStartAt: null };
  }
  if (spendDayStartAt == null) {
    return { status: 'missing_current_spend', paired: false, staleDayStartAt: null };
  }
  if (epicDayStartAt === spendDayStartAt) {
    return { status: 'paired', paired: true, staleDayStartAt: null };
  }
  return epicDayStartAt > spendDayStartAt
    ? { status: 'missing_current_spend', paired: false, staleDayStartAt: spendDayStartAt }
    : { status: 'missing_current_epic', paired: false, staleDayStartAt: epicDayStartAt };
}

export function previousBeijingDayStart(now = Date.now()) {
  const currentDayStartAt = dayStartAtForCapturedAt(now);
  return currentDayStartAt == null ? null : currentDayStartAt - DAY_MS;
}

export async function aggregateRankingsDay(db, dayStartAt) {
  const normalizedDayStartAt = dayStartAtForCapturedAt(dayStartAt);
  if (normalizedDayStartAt == null || normalizedDayStartAt !== Number(dayStartAt)) {
    throw new Error('invalid_day_start_at');
  }
  const dayEndAt = normalizedDayStartAt + DAY_MS;
  const result = await db.prepare(DAILY_AGGREGATION_SQL)
    .bind(normalizedDayStartAt, dayEndAt)
    .all();
  const rows = result.results || [];
  for (const chunk of chunks(rows, 50)) {
    await db.batch(chunk.map((row) => db.prepare(DAILY_UPSERT_SQL).bind(
      row.season_id,
      row.day_start_at,
      row.user_id,
      row.board_key,
      row.user_name,
      row.avatar_url,
      row.value,
      row.rank,
      row.is_vip,
      row.active_name_decoration,
      row.name_display_preference,
      row.snapshot_id,
      row.scope,
      row.captured_at
    )));
  }
  return {
    dayStartAt: normalizedDayStartAt,
    dayEndAt,
    rows: rows.length
  };
}

function chunks(array, size) {
  const result = [];
  for (let index = 0; index < array.length; index += size) {
    result.push(array.slice(index, index + size));
  }
  return result;
}
