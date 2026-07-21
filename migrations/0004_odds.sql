-- Bookmaker odds ingestion: key-value meta store + odds snapshots.

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS odds_snapshots (
  id INTEGER PRIMARY KEY,
  match_id INTEGER NOT NULL REFERENCES matches(id),
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  line REAL,
  best_odds REAL NOT NULL,
  consensus_odds REAL NOT NULL,
  bookmakers INTEGER NOT NULL,
  model_prob REAL NOT NULL,
  ev_pct REAL NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_odds_match_market ON odds_snapshots(match_id, market);
