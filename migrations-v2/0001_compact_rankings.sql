CREATE TABLE IF NOT EXISTS rank_seasons (
  season_id TEXT PRIMARY KEY,
  season_name TEXT NOT NULL,
  last_observed_at INTEGER NOT NULL,
  last_day_start_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rank_ingest_state (
  season_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  last_captured_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (season_id, scope)
);

CREATE TABLE IF NOT EXISTS rank_user_days (
  season_id TEXT NOT NULL,
  day_start_at INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  observed_at INTEGER NOT NULL,
  source_scopes TEXT NOT NULL DEFAULT '',
  sets_total_value INTEGER,
  sets_total_rank INTEGER,
  sets_total_observed_at INTEGER,
  sets_month_value INTEGER,
  sets_month_rank INTEGER,
  sets_month_observed_at INTEGER,
  sets_week_value INTEGER,
  sets_week_rank INTEGER,
  sets_week_observed_at INTEGER,
  sets_today_value INTEGER,
  sets_today_rank INTEGER,
  sets_today_observed_at INTEGER,
  epic_total_value INTEGER,
  epic_total_rank INTEGER,
  epic_total_observed_at INTEGER,
  epic_month_value INTEGER,
  epic_month_rank INTEGER,
  epic_month_observed_at INTEGER,
  epic_week_value INTEGER,
  epic_week_rank INTEGER,
  epic_week_observed_at INTEGER,
  epic_today_value INTEGER,
  epic_today_rank INTEGER,
  epic_today_observed_at INTEGER,
  spend_total_value INTEGER,
  spend_total_rank INTEGER,
  spend_total_observed_at INTEGER,
  spend_month_value INTEGER,
  spend_month_rank INTEGER,
  spend_month_observed_at INTEGER,
  spend_week_value INTEGER,
  spend_week_rank INTEGER,
  spend_week_observed_at INTEGER,
  spend_today_value INTEGER,
  spend_today_rank INTEGER,
  spend_today_observed_at INTEGER,
  PRIMARY KEY (season_id, day_start_at, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_user_days_user_day
  ON rank_user_days (season_id, user_id, day_start_at);
CREATE INDEX IF NOT EXISTS idx_rank_user_days_day_user
  ON rank_user_days (season_id, day_start_at, user_id);

CREATE TABLE IF NOT EXISTS rank_user_current (
  season_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  is_vip INTEGER NOT NULL DEFAULT 0,
  active_name_decoration TEXT,
  name_display_preference TEXT,
  first_observed_at INTEGER NOT NULL,
  last_observed_at INTEGER NOT NULL,
  source_scopes TEXT NOT NULL DEFAULT '',
  sets_total_value INTEGER,
  sets_total_rank INTEGER,
  sets_total_observed_at INTEGER,
  sets_month_value INTEGER,
  sets_month_rank INTEGER,
  sets_month_observed_at INTEGER,
  sets_week_value INTEGER,
  sets_week_rank INTEGER,
  sets_week_observed_at INTEGER,
  sets_today_value INTEGER,
  sets_today_rank INTEGER,
  sets_today_observed_at INTEGER,
  epic_total_value INTEGER,
  epic_total_rank INTEGER,
  epic_total_observed_at INTEGER,
  epic_month_value INTEGER,
  epic_month_rank INTEGER,
  epic_month_observed_at INTEGER,
  epic_week_value INTEGER,
  epic_week_rank INTEGER,
  epic_week_observed_at INTEGER,
  epic_today_value INTEGER,
  epic_today_rank INTEGER,
  epic_today_observed_at INTEGER,
  spend_total_value INTEGER,
  spend_total_rank INTEGER,
  spend_total_observed_at INTEGER,
  spend_month_value INTEGER,
  spend_month_rank INTEGER,
  spend_month_observed_at INTEGER,
  spend_week_value INTEGER,
  spend_week_rank INTEGER,
  spend_week_observed_at INTEGER,
  spend_today_value INTEGER,
  spend_today_rank INTEGER,
  spend_today_observed_at INTEGER,
  sort_legend_value REAL,
  sort_spend_usd REAL,
  sort_estimated_pulls REAL,
  sort_exchange_count REAL,
  sort_probability REAL,
  PRIMARY KEY (season_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_rank_user_current_last_user
  ON rank_user_current (season_id, last_observed_at DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_legend
  ON rank_user_current (season_id, sort_legend_value DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_spend
  ON rank_user_current (season_id, sort_spend_usd DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_pulls
  ON rank_user_current (season_id, sort_estimated_pulls DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_sets
  ON rank_user_current (season_id, sort_exchange_count DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_probability
  ON rank_user_current (season_id, sort_probability DESC, user_id);
CREATE INDEX IF NOT EXISTS idx_rank_user_current_name
  ON rank_user_current (season_id, user_name COLLATE NOCASE, user_id);
