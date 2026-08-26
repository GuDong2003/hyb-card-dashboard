ALTER TABLE rank_user_current ADD COLUMN sort_today_estimated_pulls REAL;
ALTER TABLE rank_user_current ADD COLUMN sort_today_probability REAL;
ALTER TABLE rank_user_current ADD COLUMN sort_week_estimated_pulls REAL;
ALTER TABLE rank_user_current ADD COLUMN sort_week_probability REAL;
ALTER TABLE rank_user_current ADD COLUMN sort_month_estimated_pulls REAL;
ALTER TABLE rank_user_current ADD COLUMN sort_month_probability REAL;

CREATE INDEX IF NOT EXISTS idx_rank_user_current_today_pulls
  ON rank_user_current (season_id, sort_today_estimated_pulls DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_today_probability
  ON rank_user_current (season_id, sort_today_probability DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_week_pulls
  ON rank_user_current (season_id, sort_week_estimated_pulls DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_week_probability
  ON rank_user_current (season_id, sort_week_probability DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_month_pulls
  ON rank_user_current (season_id, sort_month_estimated_pulls DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_month_probability
  ON rank_user_current (season_id, sort_month_probability DESC, user_id);
