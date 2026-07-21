/**
 * D1 access layer: upserts for ingested teams/matches plus the read queries
 * the model service and API routes need. All functions take the D1 binding as
 * an argument — no global state.
 */

import type { IngestedMatch, MatchRow, ModelMatch, TeamRow } from "../types";

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
  params_json: string;
  fitted_at: string;
  match_count: number;
}

export async function getModelCache(db: D1Database, league: string): Promise<ModelCacheRow | null> {
  return db.prepare("SELECT * FROM model_cache WHERE league = ?").bind(league).first<ModelCacheRow>();
}

export async function setModelCache(
  db: D1Database,
  league: string,
  paramsJson: string,
  fittedAt: string,
  matchCount: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO model_cache (league, params_json, fitted_at, match_count) VALUES (?, ?, ?, ?)
       ON CONFLICT(league) DO UPDATE SET
         params_json = excluded.params_json,
         fitted_at = excluded.fitted_at,
         match_count = excluded.match_count`,
    )
    .bind(league, paramsJson, fittedAt, matchCount)
    .run();
}
