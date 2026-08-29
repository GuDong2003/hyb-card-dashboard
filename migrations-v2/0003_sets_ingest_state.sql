CREATE TABLE IF NOT EXISTS rank_metric_ingest_state (
  season_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  metric TEXT NOT NULL,
  window_start_at INTEGER NOT NULL,
  last_captured_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, scope, metric)
);
