CREATE TABLE IF NOT EXISTS rank_daily_metrics (
  season_id TEXT NOT NULL,
  day_start_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  board_key TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  snapshot_id INTEGER NOT NULL REFERENCES rank_snapshots(id),
  scope TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, day_start_at, user_id, board_key)
);

CREATE INDEX IF NOT EXISTS idx_rank_daily_metrics_board_day_rank
  ON rank_daily_metrics (season_id, board_key, day_start_at, rank);

CREATE INDEX IF NOT EXISTS idx_rank_daily_metrics_user_board_day
  ON rank_daily_metrics (season_id, user_id, board_key, day_start_at, captured_at, snapshot_id);

CREATE INDEX IF NOT EXISTS idx_rank_snapshots_season_scope_time
  ON rank_snapshots (season_id, scope, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_rank_snapshots_latest
  ON rank_snapshots (captured_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rank_snapshots_season_signature
  ON rank_snapshots (season_id, signature);

CREATE INDEX IF NOT EXISTS idx_rank_entries_snapshot_board_rank
  ON rank_entries (snapshot_id, board_key, rank);

CREATE INDEX IF NOT EXISTS idx_rank_user_metrics_season_last_user
  ON rank_user_metrics (season_id, last_captured_at DESC, user_id);
