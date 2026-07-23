/**
 * League sync orchestration: fetch one league / all leagues and upsert into
 * D1. Provider per league (cfg.provider): football-data.org (6.5s throttle,
 * 10 req/min free tier) or API-Football (1s gap, 100/day quota guarded by the
 * client). Sequential across providers.
 */

import { LEAGUES } from "../config";
import { ApiFootballClient, afCallsUtcKey, apiFootballSeasons } from "./apiFootball";
import type { AfQuotaStore } from "./apiFootball";
import {
  fetchFdukText,
  fdukFixturesUrl,
  fdukLeagueFileUrl,
  fixturesRowsToIngest,
  leagueRowsToIngest,
  parseCsv,
} from "./fduk";
import type { SeasonStyle } from "./fduk";
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
  fixtures?: number;
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
 * current one (calendar-year seasons for API-Football leagues; most-recent
 * seasons present in the file for football-data.co.uk leagues).
 */
export async function syncLeague(
  db: D1Database,
  env: Env,
  leagueKey: string,
  seasons: number,
  clients?: { fdorg?: FootballDataClient; apifootball?: ApiFootballClient },
  fdukCache?: FdukRunCache,
): Promise<LeagueSyncResult> {
  const cfg = LEAGUES[leagueKey];
  if (!cfg) {
    throw new Error(`unknown league '${leagueKey}'`);
  }
  if (cfg.provider === "fduk") {
    return syncLeagueFduk(db, leagueKey, seasons, fdukCache ?? { seasonStyle: new Map() });
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

/** Run-scoped cache so fixtures.csv is fetched at most once per sync run. */
export interface FdukRunCache {
  fixturesRows?: string[][];
  seasonStyle: Map<string, SeasonStyle>;
}

/**
 * football-data.co.uk sync (no key needed): one league file + the shared
 * fixtures.csv per run. Be polite — each file is fetched at most once per
 * run; the daily cron is our only automated fetch.
 */
async function syncLeagueFduk(
  db: D1Database,
  leagueKey: string,
  seasons: number,
  cache: FdukRunCache,
): Promise<LeagueSyncResult> {
  const cfg = LEAGUES[leagueKey];
  const code = cfg.fdukCode as string;
  let apiCalls = 0;

  const text = await fetchFdukText(fdukLeagueFileUrl(code));
  apiCalls++;
  const ingest = leagueRowsToIngest(parseCsv(text), leagueKey, seasons);
  cache.seasonStyle.set(leagueKey, ingest.style);

  // Upsert season by season (reporting granularity matches other providers).
  const bySeason = new Map<string, IngestedMatch[]>();
  for (const m of ingest.matches) {
    const list = bySeason.get(m.season) ?? [];
    list.push(m);
    bySeason.set(m.season, list);
  }
  const seasonResults: SeasonSyncResult[] = [];
  let teamTotal = 0;
  for (const [season, ms] of [...bySeason.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const stored = await storeSeason(db, leagueKey, ms);
    teamTotal = Math.max(teamTotal, stored.teams);
    seasonResults.push({ season, matches: stored.result.matches, skipped: stored.result.skipped });
  }

  // Upcoming fixtures from the shared fixtures.csv (empty when the site's
  // file currently lists no fixtures for this league — that's normal).
  if (!cache.fixturesRows) {
    const ftext = await fetchFdukText(fdukFixturesUrl());
    apiCalls++;
    cache.fixturesRows = parseCsv(ftext);
  }
  const upcoming = fixturesRowsToIngest(cache.fixturesRows, new Map([[code, leagueKey]]), cache.seasonStyle);
  let fixturesStored = 0;
  if (upcoming.length > 0) {
    const stored = await storeSeason(db, leagueKey, upcoming);
    fixturesStored = stored.result.matches;
  }

  return {
    league: leagueKey,
    ok: true,
    provider: "fduk",
    teams: teamTotal,
    seasons: seasonResults,
    apiCalls,
    fixtures: fixturesStored,
  };
}

/** Sync every league in the registry, sequentially, sharing one client per provider. */
export async function syncAllLeagues(db: D1Database, env: Env, seasons: number): Promise<LeagueSyncResult[]> {
  const clients: { fdorg?: FootballDataClient; apifootball?: ApiFootballClient } = {};
  if (env.FOOTBALL_DATA_TOKEN) clients.fdorg = new FootballDataClient(env.FOOTBALL_DATA_TOKEN);
  if (env.API_FOOTBALL_KEY) clients.apifootball = new ApiFootballClient(env.API_FOOTBALL_KEY, afQuotaStore(db));
  const fdukCache: FdukRunCache = { seasonStyle: new Map() };
  const results: LeagueSyncResult[] = [];
  for (const key of Object.keys(LEAGUES)) {
    try {
      results.push(await syncLeague(db, env, key, seasons, clients, fdukCache));
      console.log(JSON.stringify({ message: "league synced", league: key, provider: LEAGUES[key].provider, seasons }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      console.error(JSON.stringify({ message: "league sync failed", league: key, provider: LEAGUES[key].provider, error: message }));
      results.push({ league: key, ok: false, provider: LEAGUES[key].provider, error: message });
    }
  }
  return results;
}
