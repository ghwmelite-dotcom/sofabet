-- Pre-kickoff prediction snapshots (the graded track record).
CREATE TABLE IF NOT EXISTS predictions (
  match_id INTEGER PRIMARY KEY REFERENCES matches(id),
  league TEXT NOT NULL,
  home_win REAL NOT NULL,
  draw REAL NOT NULL,
  away_win REAL NOT NULL,
  over25 REAL NOT NULL,
  btts_yes REAL NOT NULL,
  top_score TEXT NOT NULL,
  model_fitted_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_predictions_league ON predictions(league);
