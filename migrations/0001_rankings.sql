CREATE TABLE IF NOT EXISTS rank_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id TEXT NOT NULL,
  season_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  captured_bucket INTEGER NOT NULL,
  source TEXT NOT NULL,
  signature TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (season_id, scope, captured_bucket)
);

CREATE TABLE IF NOT EXISTS rank_entries (
  snapshot_id INTEGER NOT NULL REFERENCES rank_snapshots(id) ON DELETE CASCADE,
  board_key TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  avatar_url TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_id, board_key, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_snapshots_season_time
  ON rank_snapshots (season_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_rank_entries_board_snapshot
  ON rank_entries (board_key, snapshot_id, rank);

CREATE INDEX IF NOT EXISTS idx_rank_entries_user_board
  ON rank_entries (user_id, board_key, snapshot_id);
