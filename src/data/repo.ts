/**
 * D1 access layer: upserts for ingested teams/matches plus the read queries
 * the model service and API routes need. All functions take the D1 binding as
 * an argument — no global state.
 */

import type { CardMatch, FormMatchRow, IngestedMatch, MatchRow, ModelMatch, OddsSnapshotRow, PredictionRow, TeamRow } from "../types";

const BATCH_CHUNK = 50;

async function batchInChunks(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    await db.batch(statements.slice(i, i + BATCH_CHUNK));
  }
}

export interface TeamUpsert {
  apiId: number;
  name: string;
  shortName: string | null;
}

export async function upsertTeams(db: D1Database, league: string, teams: TeamUpsert[]): Promise<number> {
  if (teams.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT INTO teams (league, api_id, name, short_name) VALUES (?, ?, ?, ?)
     ON CONFLICT(league, api_id) DO UPDATE SET name = excluded.name, short_name = excluded.short_name`,
  );
  await batchInChunks(db, teams.map((t) => stmt.bind(league, t.apiId, t.name, t.shortName)));
  return teams.length;
}

/** Map of upstream api_id -> internal teams.id for one league. */
export async function getTeamIdMap(db: D1Database, league: string): Promise<Map<number, number>> {
  const { results } = await db
    .prepare("SELECT id, api_id FROM teams WHERE league = ?")
    .bind(league)
    .all<{ id: number; api_id: number }>();
  return new Map(results.map((r) => [r.api_id, r.id]));
}

export interface MatchUpsertResult {
  upserted: number;
  skipped: number;
}

export async function upsertMatches(
  db: D1Database,
  league: string,
  matches: IngestedMatch[],
  teamIdMap: Map<number, number>,
): Promise<MatchUpsertResult> {
  const stmt = db.prepare(
    `INSERT INTO matches
       (league, api_id, season, utc_date, matchday, status, home_team_id, away_team_id, home_goals, away_goals)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(api_id) DO UPDATE SET
       season = excluded.season,
       utc_date = excluded.utc_date,
       matchday = excluded.matchday,
       status = excluded.status,
       home_goals = excluded.home_goals,
       away_goals = excluded.away_goals`,
  );
  const bound: D1PreparedStatement[] = [];
  let skipped = 0;
  for (const m of matches) {
    const homeId = teamIdMap.get(m.homeApiId);
    const awayId = teamIdMap.get(m.awayApiId);
    if (homeId === undefined || awayId === undefined) {
      skipped++;
      continue;
    }
    bound.push(
      stmt.bind(league, m.apiId, m.season, m.utcDate, m.matchday, m.status, homeId, awayId, m.homeGoals, m.awayGoals),
    );
  }
  await batchInChunks(db, bound);
  return { upserted: bound.length, skipped };
}

/** Finished matches with goals, oldest first — the model's training input. */
export async function getFinishedMatches(db: D1Database, league: string): Promise<ModelMatch[]> {
  const { results } = await db
    .prepare(
      `SELECT home_team_id, away_team_id, home_goals, away_goals, utc_date
       FROM matches
       WHERE league = ? AND status = 'FINISHED' AND home_goals IS NOT NULL AND away_goals IS NOT NULL
       ORDER BY utc_date ASC`,
    )
    .bind(league)
    .all<{
      home_team_id: number;
      away_team_id: number;
      home_goals: number;
      away_goals: number;
      utc_date: string;
    }>();
  return results.map((r) => ({
    homeTeamId: r.home_team_id,
    awayTeamId: r.away_team_id,
    homeGoals: r.home_goals,
    awayGoals: r.away_goals,
    utcDate: r.utc_date,
  }));
}

export async function countFinishedMatches(db: D1Database, league: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM matches
       WHERE league = ? AND status = 'FINISHED' AND home_goals IS NOT NULL AND away_goals IS NOT NULL`,
    )
    .bind(league)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** Upcoming fixtures (not yet played), soonest first. */
export async function getScheduledMatches(db: D1Database, league: string): Promise<MatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM matches
       WHERE league = ? AND status IN ('SCHEDULED', 'TIMED')
       ORDER BY utc_date ASC
       LIMIT 100`,
    )
    .bind(league)
    .all<MatchRow>();
  return results;
}

export async function getTeams(db: D1Database, league: string): Promise<TeamRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM teams WHERE league = ? ORDER BY name ASC")
    .bind(league)
    .all<TeamRow>();
  return results;
}

/** Per-league match counts keyed by status, for every league present in D1. */
export async function getMatchCountsByLeague(db: D1Database): Promise<Map<string, Record<string, number>>> {
  const { results } = await db
    .prepare("SELECT league, status, COUNT(*) AS c FROM matches GROUP BY league, status")
    .all<{ league: string; status: string; c: number }>();
  const out = new Map<string, Record<string, number>>();
  for (const r of results) {
    const entry = out.get(r.league) ?? {};
    entry[r.status] = r.c;
    out.set(r.league, entry);
  }
  return out;
}

export interface ModelCacheRow {
  league: string;
  kind: string;
  params_json: string;
  fitted_at: string;
  match_count: number;
}

export async function getModelCache(db: D1Database, league: string, kind = "goals"): Promise<ModelCacheRow | null> {
  return db
    .prepare("SELECT * FROM model_cache WHERE league = ? AND kind = ?")
    .bind(league, kind)
    .first<ModelCacheRow>();
}

export async function setModelCache(
  db: D1Database,
  league: string,
  paramsJson: string,
  fittedAt: string,
  matchCount: number,
  kind = "goals",
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO model_cache (league, kind, params_json, fitted_at, match_count) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(league, kind) DO UPDATE SET
         params_json = excluded.params_json,
         fitted_at = excluded.fitted_at,
         match_count = excluded.match_count`,
    )
    .bind(league, kind, paramsJson, fittedAt, matchCount)
    .run();
}

/* ---- match_stats (bookings) ---- */

export interface MatchStatsUpsert {
  matchId: number;
  homeYellow: number;
  awayYellow: number;
  homeRed: number;
  awayRed: number;
}

export async function insertMatchStats(db: D1Database, stats: MatchStatsUpsert, fetchedAt: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO match_stats (match_id, home_yellow, away_yellow, home_red, away_red, fetched_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO NOTHING`,
    )
    .bind(stats.matchId, stats.homeYellow, stats.awayYellow, stats.homeRed, stats.awayRed, fetchedAt)
    .run();
}

export interface PendingStatsMatch {
  id: number;
  api_id: number;
  league: string;
  utc_date: string;
}

/** FINISHED matches in `leagues` with no match_stats row yet, newest first. */
export async function getPendingStatsMatches(
  db: D1Database,
  leagues: string[],
  limit: number,
): Promise<PendingStatsMatch[]> {
  if (leagues.length === 0) return [];
  const placeholders = leagues.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT m.id, m.api_id, m.league, m.utc_date
       FROM matches m
       LEFT JOIN match_stats s ON s.match_id = m.id
       WHERE m.status = 'FINISHED' AND s.match_id IS NULL AND m.league IN (${placeholders})
       ORDER BY m.utc_date DESC
       LIMIT ?`,
    )
    .bind(...leagues, limit)
    .all<PendingStatsMatch>();
  return results;
}

/** Count of FINISHED matches in `leagues` still missing match_stats. */
export async function countPendingStats(db: D1Database, leagues: string[]): Promise<number> {
  if (leagues.length === 0) return 0;
  const placeholders = leagues.map(() => "?").join(", ");
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM matches m
       LEFT JOIN match_stats s ON s.match_id = m.id
       WHERE m.status = 'FINISHED' AND s.match_id IS NULL AND m.league IN (${placeholders})`,
    )
    .bind(...leagues)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface StatsCoverageRow {
  league: string;
  finished: number;
  stats: number;
}

/** Per-league finished-match and bookings coverage counts. */
export async function getStatsCoverage(db: D1Database): Promise<StatsCoverageRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.league AS league, COUNT(*) AS finished, COUNT(s.match_id) AS stats
       FROM matches m
       LEFT JOIN match_stats s ON s.match_id = m.id
       WHERE m.status = 'FINISHED'
       GROUP BY m.league
       ORDER BY m.league ASC`,
    )
    .all<StatsCoverageRow>();
  return results;
}

/** Matches with booked-yellow counts, oldest first — the cards model's training input. */
export async function getCardTrainingRows(db: D1Database, league: string): Promise<CardMatch[]> {
  const { results } = await db
    .prepare(
      `SELECT m.home_team_id, m.away_team_id, s.home_yellow, s.away_yellow, m.utc_date
       FROM match_stats s
       JOIN matches m ON m.id = s.match_id
       WHERE m.league = ? AND s.home_yellow IS NOT NULL AND s.away_yellow IS NOT NULL
       ORDER BY m.utc_date ASC`,
    )
    .bind(league)
    .all<{
      home_team_id: number;
      away_team_id: number;
      home_yellow: number;
      away_yellow: number;
      utc_date: string;
    }>();
  return results.map((r) => ({
    homeTeamId: r.home_team_id,
    awayTeamId: r.away_team_id,
    homeYellow: r.home_yellow,
    awayYellow: r.away_yellow,
    utcDate: r.utc_date,
  }));
}

export async function countCardStats(db: D1Database, league: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM match_stats s
       JOIN matches m ON m.id = s.match_id
       WHERE m.league = ? AND s.home_yellow IS NOT NULL AND s.away_yellow IS NOT NULL`,
    )
    .bind(league)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/* ---- meta (key-value) ---- */

export async function getMeta(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function setMeta(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
}

/* ---- odds_snapshots ---- */

export interface OddsSnapshotInsert {
  matchId: number;
  market: string;
  selection: string;
  line: number | null;
  bestOdds: number;
  consensusOdds: number;
  bookmakers: number;
  modelProb: number;
  evPct: number;
  fetchedAt: string;
}

/**
 * Replace a league's snapshots for not-yet-started matches (delete + insert
 * in one batch = one transaction); snapshots of started matches are kept.
 */
export async function replaceLeagueOddsSnapshots(
  db: D1Database,
  league: string,
  nowIso: string,
  rows: OddsSnapshotInsert[],
): Promise<void> {
  const del = db.prepare(
    `DELETE FROM odds_snapshots
     WHERE match_id IN (SELECT id FROM matches WHERE league = ? AND utc_date > ?)`,
  ).bind(league, nowIso);
  const ins = db.prepare(
    `INSERT INTO odds_snapshots
       (match_id, market, selection, line, best_odds, consensus_odds, bookmakers, model_prob, ev_pct, fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const statements = [
    del,
    ...rows.map((r) =>
      ins.bind(r.matchId, r.market, r.selection, r.line, r.bestOdds, r.consensusOdds, r.bookmakers, r.modelProb, r.evPct, r.fetchedAt),
    ),
  ];
  await batchInChunks(db, statements);
}

/** Snapshot rows for a league, newest generation per match/market/selection. */
export async function getOddsSnapshotsForLeague(db: D1Database, league: string): Promise<OddsSnapshotRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.*, m.utc_date, ht.name AS home_name, at.name AS away_name
       FROM odds_snapshots s
       JOIN matches m ON m.id = s.match_id
       JOIN teams ht ON ht.id = m.home_team_id
       JOIN teams at ON at.id = m.away_team_id
       WHERE m.league = ?`,
    )
    .bind(league)
    .all<OddsSnapshotRow>();
  return results;
}

export async function countOddsSnapshots(db: D1Database, league: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS c
       FROM odds_snapshots s JOIN matches m ON m.id = s.match_id
       WHERE m.league = ?`,
    )
    .bind(league)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/**
 * A team's recent finished matches in a league, newest first (both venues).
 * 30 rows comfortably cover last-5 overall + last-5 home + last-5 away.
 */
export async function getRecentTeamMatches(
  db: D1Database,
  league: string,
  teamId: number,
  limit = 30,
): Promise<FormMatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT m.utc_date, m.home_team_id, m.away_team_id, m.home_goals, m.away_goals,
              ht.name AS home_name, at.name AS away_name
       FROM matches m
       JOIN teams ht ON ht.id = m.home_team_id
       JOIN teams at ON at.id = m.away_team_id
       WHERE m.league = ? AND m.status = 'FINISHED'
         AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
         AND (m.home_team_id = ? OR m.away_team_id = ?)
       ORDER BY m.utc_date DESC
       LIMIT ?`,
    )
    .bind(league, teamId, teamId, limit)
    .all<FormMatchRow>();
  return results;
}

/* ---- predictions (pre-kickoff snapshots) ---- */

export interface PredictionUpsert {
  matchId: number;
  league: string;
  homeWin: number;
  draw: number;
  awayWin: number;
  over25: number;
  bttsYes: number;
  topScore: string;
  modelFittedAt: string;
  nowIso: string;
}

/** Insert or refresh a pre-kickoff snapshot. created_at sticks on insert;
 * updated_at always moves (both are before kickoff by construction — the
 * writer only ever sees SCHEDULED/TIMED fixtures). */
export async function upsertPrediction(db: D1Database, p: PredictionUpsert): Promise<void> {
  await db
    .prepare(
      `INSERT INTO predictions
         (match_id, league, home_win, draw, away_win, over25, btts_yes, top_score, model_fitted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(match_id) DO UPDATE SET
         home_win = excluded.home_win,
         draw = excluded.draw,
         away_win = excluded.away_win,
         over25 = excluded.over25,
         btts_yes = excluded.btts_yes,
         top_score = excluded.top_score,
         model_fitted_at = excluded.model_fitted_at,
         updated_at = excluded.updated_at`,
    )
    .bind(p.matchId, p.league, p.homeWin, p.draw, p.awayWin, p.over25, p.bttsYes, p.topScore, p.modelFittedAt, p.nowIso, p.nowIso)
    .run();
}

export async function countPredictions(db: D1Database, league: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS c FROM predictions WHERE league = ?")
    .bind(league)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

export interface GradableMatchRow extends PredictionRow {
  utc_date: string;
  home_goals: number;
  away_goals: number;
  home_name: string;
  away_name: string;
}

/** FINISHED matches with a snapshot, newest first, within `sinceIso`. */
export async function getGradableMatches(db: D1Database, league: string, sinceIso: string): Promise<GradableMatchRow[]> {
  const { results } = await db
    .prepare(
      `SELECT p.*, m.utc_date, m.home_goals, m.away_goals, ht.name AS home_name, at.name AS away_name
       FROM predictions p
       JOIN matches m ON m.id = p.match_id
       JOIN teams ht ON ht.id = m.home_team_id
       JOIN teams at ON at.id = m.away_team_id
       WHERE m.league = ? AND m.status = 'FINISHED'
         AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL
         AND m.utc_date >= ?
       ORDER BY m.utc_date DESC`,
    )
    .bind(league, sinceIso)
    .all<GradableMatchRow>();
  return results;
}
