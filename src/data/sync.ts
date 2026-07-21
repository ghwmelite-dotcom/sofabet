/**
 * League sync orchestration: fetch one league / all leagues from
 * football-data.org and upsert into D1. Sequential with client-side
 * throttling (6.5s between calls; free tier is 10 requests/minute).
 */

import { LEAGUES } from "../config";
import { FootballDataClient } from "./footballData";
import { getTeamIdMap, upsertMatches, upsertTeams } from "./repo";
import { FootballDataError } from "../types";
import type { IngestedMatch } from "../types";

export interface SeasonSyncResult {
  season: string;
  matches: number;
  skipped: number;
}

export interface LeagueSyncResult {
  league: string;
  ok: boolean;
  teams?: number;
  seasons?: SeasonSyncResult[];
  apiCalls?: number;
  error?: string;
}

function collectTeams(matches: IngestedMatch[]): { apiId: number; name: string; shortName: string | null }[] {
  const teams = new Map<number, { apiId: number; name: string; shortName: string | null }>();
  for (const m of matches) {
    if (!teams.has(m.homeApiId)) teams.set(m.homeApiId, { apiId: m.homeApiId, name: m.homeName, shortName: m.homeShortName });
    if (!teams.has(m.awayApiId)) teams.set(m.awayApiId, { apiId: m.awayApiId, name: m.awayName, shortName: m.awayShortName });
  }
  return [...teams.values()];
}

async function storeSeason(
  db: D1Database,
  league: string,
  matches: IngestedMatch[],
): Promise<{ teams: number; result: SeasonSyncResult }> {
  const teams = collectTeams(matches);
  const teamCount = await upsertTeams(db, league, teams);
  const teamIdMap = await getTeamIdMap(db, league);
  const { upserted, skipped } = await upsertMatches(db, league, matches, teamIdMap);
  const season = matches[0]?.season ?? "unknown";
  return { teams: teamCount, result: { season, matches: upserted, skipped } };
}

/**
 * Sync one league. `seasons` = how many seasons to fetch including the
 * current one (e.g. 2 = current + previous), for backtest depth.
 */
export async function syncLeague(
  db: D1Database,
  client: FootballDataClient,
  leagueKey: string,
  seasons: number,
): Promise<LeagueSyncResult> {
  const cfg = LEAGUES[leagueKey];
  if (!cfg) {
    throw new Error(`unknown league '${leagueKey}'`);
  }
  const seasonResults: SeasonSyncResult[] = [];
  let apiCalls = 0;
  let teamTotal = 0;

  // Current season first: its response tells us the current season start year.
  const current = await client.getCompetitionMatches(cfg.fdOrgCode);
  apiCalls++;
  if (current.length === 0) {
    return { league: leagueKey, ok: true, teams: 0, seasons: [], apiCalls };
  }
  const storedCurrent = await storeSeason(db, leagueKey, current);
  teamTotal = Math.max(teamTotal, storedCurrent.teams);
  seasonResults.push(storedCurrent.result);
  const currentYear = Number(storedCurrent.result.season);

  // Previous seasons (seasons - 1 of them).
  for (let k = 1; k < seasons; k++) {
    const year = currentYear - k;
    try {
      const past = await client.getCompetitionMatches(cfg.fdOrgCode, year);
      apiCalls++;
      if (past.length === 0) continue;
      const stored = await storeSeason(db, leagueKey, past);
      teamTotal = Math.max(teamTotal, stored.teams);
      seasonResults.push(stored.result);
    } catch (e) {
      // Old seasons may be unavailable on the free tier — log and keep going.
      const message = e instanceof FootballDataError ? e.message : String(e);
      console.warn(JSON.stringify({ message: "season fetch failed", league: leagueKey, season: year, error: message }));
    }
  }

  return { league: leagueKey, ok: true, teams: teamTotal, seasons: seasonResults, apiCalls };
}

/** Sync every league in the registry, sequentially (rate limit friendly). */
export async function syncAllLeagues(
  db: D1Database,
  token: string,
  seasons: number,
): Promise<LeagueSyncResult[]> {
  const client = new FootballDataClient(token);
  const results: LeagueSyncResult[] = [];
  for (const key of Object.keys(LEAGUES)) {
    try {
      results.push(await syncLeague(db, client, key, seasons));
      console.log(JSON.stringify({ message: "league synced", league: key, seasons }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ message: "league sync failed", league: key, error: message }));
      results.push({ league: key, ok: false, error: message });
    }
  }
  return results;
}
