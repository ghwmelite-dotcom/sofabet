-- Sofabet initial schema.
CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY,
  league TEXT NOT NULL,
  api_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  short_name TEXT,
  UNIQUE(league, api_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY,
  league TEXT NOT NULL,
  api_id INTEGER NOT NULL UNIQUE,
  season TEXT NOT NULL,
  utc_date TEXT NOT NULL,
  matchday INTEGER,
  status TEXT NOT NULL,
  home_team_id INTEGER NOT NULL REFERENCES teams(id),
  away_team_id INTEGER NOT NULL REFERENCES teams(id),
  home_goals INTEGER,
  away_goals INTEGER
);

CREATE INDEX IF NOT EXISTS idx_matches_league_status_date
  ON matches(league, status, utc_date);

CREATE TABLE IF NOT EXISTS model_cache (
  league TEXT PRIMARY KEY,
  params_json TEXT NOT NULL,
  fitted_at TEXT NOT NULL,
  match_count INTEGER NOT NULL
);
