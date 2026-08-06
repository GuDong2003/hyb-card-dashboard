PRAGMA foreign_keys = OFF;

CREATE TABLE rank_snapshots_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season_id TEXT NOT NULL,
  season_name TEXT NOT NULL,
  scope TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  captured_bucket INTEGER NOT NULL,
  source TEXT NOT NULL,
  signature TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT INTO rank_snapshots_v2 (
  id, season_id, season_name, scope, captured_at, captured_bucket,
  source, signature, raw_json, created_at
)
SELECT
  id, season_id, season_name, scope, captured_at, captured_bucket,
  source, signature, raw_json, created_at
FROM rank_snapshots;

DROP TABLE rank_snapshots;
ALTER TABLE rank_snapshots_v2 RENAME TO rank_snapshots;

CREATE INDEX IF NOT EXISTS idx_rank_snapshots_season_time
  ON rank_snapshots (season_id, captured_at DESC);

PRAGMA foreign_keys = ON;
