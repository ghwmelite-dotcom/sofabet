-- Per-match disciplinary stats (from football-data.org match detail), and
-- model_cache gains a `kind` column so goals and cards params coexist.

CREATE TABLE IF NOT EXISTS match_stats (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id),
  home_yellow INTEGER,
  away_yellow INTEGER,
  home_red INTEGER,
  away_red INTEGER,
  fetched_at TEXT NOT NULL
);

-- Rebuild model_cache with composite PK (league, kind); preserve existing rows.
CREATE TABLE IF NOT EXISTS model_cache_new (
  league TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'goals',
  params_json TEXT NOT NULL,
  fitted_at TEXT NOT NULL,
  match_count INTEGER NOT NULL,
  PRIMARY KEY (league, kind)
);

INSERT INTO model_cache_new (league, kind, params_json, fitted_at, match_count)
  SELECT league, 'goals', params_json, fitted_at, match_count FROM model_cache;

DROP TABLE model_cache;

ALTER TABLE model_cache_new RENAME TO model_cache;
