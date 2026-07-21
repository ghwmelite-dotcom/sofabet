-- Manual bet tracker. status: 'open' | 'won' | 'lost' | 'void'.
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  league TEXT,
  match_id INTEGER REFERENCES matches(id) NULL,
  match_label TEXT NOT NULL,
  bookmaker TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  line REAL,
  odds REAL NOT NULL,
  stake REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  settled_at TEXT,
  profit REAL
);

CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
