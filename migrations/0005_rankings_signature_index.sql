CREATE UNIQUE INDEX IF NOT EXISTS idx_rank_snapshots_season_signature
  ON rank_snapshots (season_id, signature)
  WHERE accepted = 1;
