ALTER TABLE rank_metric_ingest_state
  ADD COLUMN final_window_start_at INTEGER NOT NULL DEFAULT 0;

ALTER TABLE rank_metric_ingest_state
  ADD COLUMN final_retry_count INTEGER NOT NULL DEFAULT 0;
