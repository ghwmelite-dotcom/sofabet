/**
 * League sync orchestration: fetch one league / all leagues and upsert into
 * D1. Provider per league (cfg.provider): football-data.org (6.5s throttle,
 * 10 req/min free tier) or API-Football (1s gap, 100/day quota guarded by the
 * client). Sequential across providers.
 */

import { LEAGUES } from "../config";
import { ApiFootballClient, afCallsUtcKey, apiFootballSeasons } from "./apiFootball";
import type { AfQuotaStore } from "./apiFootball";
import { FootballDataClient } from "./footballData";
import { getMeta, getTeamIdMap, setMeta, upsertMatches, upsertTeams } from "./repo";
import { FootballDataError, HttpError } from "../types";
import type { IngestedMatch } from "../types";

export interface SeasonSyncResult {
  season: string;
  matches: number;
  skipped: number;
  /** API-Football soft-error payload + upstream result count, present on empty seasons. */
  upstreamErrors?: unknown;
  upstreamResults?: number | null;
}

export interface LeagueSyncResult {
  league: string;
  ok: boolean;
  provider?: string;
  teams?: number;
  seasons?: SeasonSyncResult[];
  apiCalls?: number;
  quotaWarning?: boolean;
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

/** D1 meta-backed daily quota store for the API-Football client. */
export function afQuotaStore(db: D1Database): AfQuotaStore {
  const key = afCallsUtcKey(new Date());
  return {
    async get() {
      const raw = await getMeta(db, key);
      return raw !== null ? Number(raw) : 0;
    },
    async incr() {
      const raw = await getMeta(db, key);
      const next = (raw !== null ? Number(raw) : 0) + 1;
      await setMeta(db, key, String(next));
      return next;
    },
  };
}

async function syncLeagueFdorg(db: D1Database, client: FootballDataClient, leagueKey: string, seasons: number, fdOrgCode: string): Promise<LeagueSyncResult> {
  const seasonResults: SeasonSyncResult[] = [];
  let apiCalls = 0;
  let teamTotal = 0;

  // Current season first: its response tells us the current season start year.
  const current = await client.getCompetitionMatches(fdOrgCode);
  apiCalls++;
  if (current.length === 0) {
    return { league: leagueKey, ok: true, provider: "fdorg", teams: 0, seasons: [], apiCalls };
  }
  const storedCurrent = await storeSeason(db, leagueKey, current);
  teamTotal = Math.max(teamTotal, storedCurrent.teams);
  seasonResults.push(storedCurrent.result);
  const currentYear = Number(storedCurrent.result.season);

  // Previous seasons (seasons - 1 of them).
  for (let k = 1; k < seasons; k++) {
    const year = currentYear - k;
    try {
      const past = await client.getCompetitionMatches(fdOrgCode, year);
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

  return { league: leagueKey, ok: true, provider: "fdorg", teams: teamTotal, seasons: seasonResults, apiCalls };
}

async function syncLeagueApiFootball(db: D1Database, client: ApiFootballClient, leagueKey: string, seasons: number, apiFootballId: number): Promise<LeagueSyncResult> {
  const seasonResults: SeasonSyncResult[] = [];
  let apiCalls = 0;
  let teamTotal = 0;
  for (const season of apiFootballSeasons(seasons)) {
    const fixtures = await client.getLeagueFixtures(apiFootballId, season);
    apiCalls++;
    if (fixtures.length === 0) {
      // Empty season: surface the upstream soft-error so it isn't silent.
      seasonResults.push({
        season: String(season),
        matches: 0,
        skipped: 0,
        upstreamErrors: client.lastDiag?.errors,
        upstreamResults: client.lastDiag?.results ?? null,
      });
      continue;
    }
    const stored = await storeSeason(db, leagueKey, fixtures);
    teamTotal = Math.max(teamTotal, stored.teams);
    seasonResults.push({ season: String(season), matches: stored.result.matches, skipped: stored.result.skipped });
  }
  return {
    league: leagueKey,
    ok: true,
    provider: "apifootball",
    teams: teamTotal,
    seasons: seasonResults,
    apiCalls,
    quotaWarning: client.quotaWarning,
  };
}

/**
 * Sync one league. `seasons` = how many seasons to fetch including the
 * current one (calendar-year seasons for API-Football leagues).
 */
export async function syncLeague(
  db: D1Database,
  env: Env,
  leagueKey: string,
  seasons: number,
  clients?: { fdorg?: FootballDataClient; apifootball?: ApiFootballClient },
): Promise<LeagueSyncResult> {
  const cfg = LEAGUES[leagueKey];
  if (!cfg) {
    throw new Error(`unknown league '${leagueKey}'`);
  }
  if (cfg.provider === "apifootball") {
    const apiKey = env.API_FOOTBALL_KEY;
    if (!apiKey) throw new HttpError(500, "API_FOOTBALL_KEY secret is not configured");
    const client = clients?.apifootball ?? new ApiFootballClient(apiKey, afQuotaStore(db));
    return syncLeagueApiFootball(db, client, leagueKey, seasons, cfg.apiFootballId as number);
  }
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) throw new HttpError(500, "FOOTBALL_DATA_TOKEN secret is not configured");
  const client = clients?.fdorg ?? new FootballDataClient(token);
  return syncLeagueFdorg(db, client, leagueKey, seasons, cfg.fdOrgCode);
}

/** Sync every league in the registry, sequentially, sharing one client per provider. */
export async function syncAllLeagues(db: D1Database, env: Env, seasons: number): Promise<LeagueSyncResult[]> {
  const clients: { fdorg?: FootballDataClient; apifootball?: ApiFootballClient } = {};
  if (env.FOOTBALL_DATA_TOKEN) clients.fdorg = new FootballDataClient(env.FOOTBALL_DATA_TOKEN);
  if (env.API_FOOTBALL_KEY) clients.apifootball = new ApiFootballClient(env.API_FOOTBALL_KEY, afQuotaStore(db));
  const results: LeagueSyncResult[] = [];
  for (const key of Object.keys(LEAGUES)) {
    try {
      results.push(await syncLeague(db, env, key, seasons, clients));
      console.log(JSON.stringify({ message: "league synced", league: key, provider: LEAGUES[key].provider, seasons }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ message: "league sync failed", league: key, provider: LEAGUES[key].provider, error: message }));
      results.push({ league: key, ok: false, provider: LEAGUES[key].provider, error: message });
    }
  }
  return results;
}
