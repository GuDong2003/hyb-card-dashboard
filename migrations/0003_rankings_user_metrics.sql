CREATE TABLE IF NOT EXISTS rank_user_metrics (
  season_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  board_key TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  value_snapshot_id INTEGER NOT NULL REFERENCES rank_snapshots(id) ON DELETE CASCADE,
  value_scope TEXT NOT NULL,
  value_captured_at INTEGER NOT NULL,
  last_snapshot_id INTEGER NOT NULL REFERENCES rank_snapshots(id) ON DELETE CASCADE,
  last_scope TEXT NOT NULL,
  last_captured_at INTEGER NOT NULL,
  first_captured_at INTEGER NOT NULL,
  source_scopes TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (season_id, user_id, board_key)
);

CREATE INDEX IF NOT EXISTS idx_rank_user_metrics_board_value
  ON rank_user_metrics (season_id, board_key, value DESC);

CREATE INDEX IF NOT EXISTS idx_rank_user_metrics_user
  ON rank_user_metrics (season_id, user_id);

WITH observations AS (
  SELECT
    s.id AS snapshot_id,
    s.season_id,
    s.scope,
    s.captured_at,
    e.board_key,
    e.user_id,
    e.user_name,
    e.avatar_url,
    e.value,
    e.rank,
    e.is_vip,
    e.active_name_decoration,
    e.name_display_preference,
    ROW_NUMBER() OVER (
      PARTITION BY s.season_id, e.user_id, e.board_key
      ORDER BY
        CASE WHEN e.board_key LIKE '%_total' THEN e.value ELSE 0 END DESC,
        s.captured_at DESC,
        s.id DESC
    ) AS value_order,
    ROW_NUMBER() OVER (
      PARTITION BY s.season_id, e.user_id, e.board_key
      ORDER BY s.captured_at DESC, s.id DESC
    ) AS latest_order
  FROM rank_entries e
  JOIN rank_snapshots s ON s.id = e.snapshot_id
), grouped AS (
  SELECT
    season_id,
    user_id,
    board_key,
    MIN(captured_at) AS first_captured_at,
    MAX(is_vip) AS is_vip,
    CASE
      WHEN MAX(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) = 1
       AND MAX(CASE WHEN scope = 'friends' THEN 1 ELSE 0 END) = 1
        THEN 'global,friends'
      WHEN MAX(CASE WHEN scope = 'global' THEN 1 ELSE 0 END) = 1
        THEN 'global'
      ELSE 'friends'
    END AS source_scopes
  FROM observations
  GROUP BY season_id, user_id, board_key
), value_rows AS (
  SELECT * FROM observations WHERE value_order = 1
), latest_rows AS (
  SELECT * FROM observations WHERE latest_order = 1
)
INSERT OR IGNORE INTO rank_user_metrics (
  season_id, user_id, board_key, user_name, avatar_url, value, rank,
  is_vip, active_name_decoration, name_display_preference,
  value_snapshot_id, value_scope, value_captured_at,
  last_snapshot_id, last_scope, last_captured_at, first_captured_at, source_scopes
)
SELECT
  value_rows.season_id,
  value_rows.user_id,
  value_rows.board_key,
  COALESCE(NULLIF(latest_rows.user_name, ''), value_rows.user_name, ''),
  COALESCE(NULLIF(latest_rows.avatar_url, ''), value_rows.avatar_url, ''),
  value_rows.value,
  value_rows.rank,
  grouped.is_vip,
  latest_rows.active_name_decoration,
  latest_rows.name_display_preference,
  value_rows.snapshot_id,
  value_rows.scope,
  value_rows.captured_at,
  latest_rows.snapshot_id,
  latest_rows.scope,
  latest_rows.captured_at,
  grouped.first_captured_at,
  grouped.source_scopes
FROM value_rows
JOIN latest_rows
  ON latest_rows.season_id = value_rows.season_id
 AND latest_rows.user_id = value_rows.user_id
 AND latest_rows.board_key = value_rows.board_key
JOIN grouped
  ON grouped.season_id = value_rows.season_id
 AND grouped.user_id = value_rows.user_id
 AND grouped.board_key = value_rows.board_key;
