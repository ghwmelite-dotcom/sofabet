/**
 * Tiny hand-rolled router + JSON handlers. All responses are JSON; errors are
 * `{error: string}` with a sensible status code. No passThroughOnException —
 * everything goes through try/catch here.
 */

import { LEAGUES } from "../config";
import { FootballDataClient } from "../data/footballData";
import { countPendingStats, getMatchCountsByLeague, getScheduledMatches, getStatsCoverage, getTeams } from "../data/repo";
import { syncAllLeagues, syncLeague } from "../data/sync";
import { syncStatsBatch } from "../data/syncStats";
import { InsufficientDataError } from "../model/backtest";
import { predictScoreGrid } from "../model/dixonColes";
import { gridToMarkets } from "../model/markets";
import { backtestLeague, getOrFitCards, getOrFitParams, predictMatch } from "../model/service";
import { FootballDataError, HttpError, StatsRestrictedError } from "../types";
import { handleBets } from "./bets";
import { json, requireSyncKey } from "./util";

/** Raw ?league= value, uppercased. Throws 400 if absent. */
function requireLeagueParam(url: URL): string {
  const raw = url.searchParams.get("league");
  if (!raw) throw new HttpError(400, "missing required query parameter 'league'");
  return raw.toUpperCase();
}

/** Leagues that can be synced upstream must be in the registry. */
function requireRegisteredLeague(key: string): void {
  if (!(key in LEAGUES)) {
    throw new HttpError(400, `unknown league '${key}'. Valid: ${Object.keys(LEAGUES).join(", ")}, all`);
  }
}

/** Read endpoints accept registry leagues plus any league already in D1 (e.g. a seeded demo league). */
async function requireKnownLeague(env: Env, key: string): Promise<void> {
  if (key in LEAGUES) return;
  const counts = await getMatchCountsByLeague(env.DB);
  if (!counts.has(key)) {
    throw new HttpError(400, `unknown league '${key}'. Valid: ${[...Object.keys(LEAGUES), ...counts.keys()].join(", ")}`);
  }
}

function parseSeasons(url: URL): number {
  const raw = url.searchParams.get("seasons");
  if (raw === null) return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    throw new HttpError(400, "'seasons' must be an integer between 1 and 5");
  }
  return n;
}

function parseLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return 70;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 200) {
    throw new HttpError(400, "'limit' must be an integer between 1 and 200");
  }
  return n;
}

async function handleLeagues(env: Env): Promise<Response> {
  const counts = await getMatchCountsByLeague(env.DB);
  const toEntry = (key: string, name: string, fdOrgCode: string) => {
    const byStatus = counts.get(key) ?? {};
    const finished = byStatus["FINISHED"] ?? 0;
    const scheduled = (byStatus["SCHEDULED"] ?? 0) + (byStatus["TIMED"] ?? 0);
    return { key, name, fdOrgCode, matches: { finished, scheduled, total: finished + scheduled } };
  };
  const leagues = Object.entries(LEAGUES).map(([key, cfg]) => toEntry(key, cfg.name, cfg.fdOrgCode));
  // Leagues present in D1 but not in the registry (e.g. a seeded demo league).
  for (const key of counts.keys()) {
    if (!(key in LEAGUES)) leagues.push(toEntry(key, key, ""));
  }
  return json({ leagues });
}

/**
 * POST /api/sync can burn the upstream football-data.org rate quota, so when
 * the SYNC_KEY secret is configured the endpoint requires a matching
 * `Authorization: Bearer <key>` header. Unset = open (fine for local dev).
 * The guard itself lives in ./util (shared with /api/bets).
 */

async function handleSync(url: URL, env: Env, request: Request): Promise<Response> {
  requireSyncKey(env, request);
  const league = requireLeagueParam(url);
  const seasons = parseSeasons(url);
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new HttpError(500, "FOOTBALL_DATA_TOKEN secret is not configured");
  }
  if (league === "ALL") {
    // Synchronous by design: ctx.waitUntil() work after a response is cut off
    // after ~30s, which silently killed the throttled loop mid-sync. Held open,
    // the request survives the ~2-3 min the throttled loop needs (I/O-bound).
    const results = await syncAllLeagues(env.DB, token, seasons);
    const okCount = results.filter((r) => r.ok).length;
    return json({ ok: okCount === results.length, synced: okCount, failed: results.length - okCount, seasons, results });
  }
  requireRegisteredLeague(league);
  const client = new FootballDataClient(token);
  const result = await syncLeague(env.DB, client, league, seasons);
  return json(result);
}

/**
 * POST /api/sync-stats?league=PL[&limit=70] — SYNC_KEY-protected, synchronous.
 * Backfills bookings for up to `limit` FINISHED matches (throttled; ~6.5s per
 * match). 429 upstream stops the batch gracefully and returns partial counts;
 * a tier-restricted detail endpoint returns 403 with restricted: true.
 */
async function handleSyncStats(url: URL, env: Env, request: Request): Promise<Response> {
  requireSyncKey(env, request);
  const league = requireLeagueParam(url);
  const limit = parseLimit(url);
  const token = env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    throw new HttpError(500, "FOOTBALL_DATA_TOKEN secret is not configured");
  }
  if (league !== "ALL") requireRegisteredLeague(league);
  const scope = league === "ALL" ? "all" : league;
  const client = new FootballDataClient(token);
  try {
    const result = await syncStatsBatch(env.DB, client, scope, limit);
    return json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof StatsRestrictedError) {
      const leagues = scope === "all" ? Object.keys(LEAGUES) : [scope];
      const remaining = await countPendingStats(env.DB, leagues);
      return json({ ok: false, error: e.message, restricted: true, stored: 0, remaining }, 403);
    }
    throw e;
  }
}

/** GET /api/stats-coverage — bookings backfill coverage per league. */
async function handleStatsCoverage(env: Env): Promise<Response> {
  const rows = await getStatsCoverage(env.DB);
  const byLeague = new Map(rows.map((r) => [r.league, r]));
  const keys = [...new Set([...Object.keys(LEAGUES), ...rows.map((r) => r.league)])].sort();
  const leagues = keys.map((key) => {
    const row = byLeague.get(key);
    const finished = row?.finished ?? 0;
    const stats = row?.stats ?? 0;
    return {
      league: key,
      finished,
      stats,
      pct: finished > 0 ? Math.round((stats / finished) * 1000) / 10 : 0,
    };
  });
  return json({ leagues });
}

async function handleFixtures(url: URL, env: Env): Promise<Response> {
  const league = requireLeagueParam(url);
  await requireKnownLeague(env, league);
  const fixtures = await getScheduledMatches(env.DB, league);
  const { params, meta } = await getOrFitParams(env.DB, league);
  const teamIds = new Set(params.teamIds);
  const nameById = new Map((await getTeams(env.DB, league)).map((t) => [t.id, t.name]));
  const out = fixtures.map((f) => {
    const base = {
      matchId: f.id,
      utcDate: f.utc_date,
      matchday: f.matchday,
      status: f.status,
      homeTeamId: f.home_team_id,
      awayTeamId: f.away_team_id,
      homeTeamName: nameById.get(f.home_team_id) ?? `#${f.home_team_id}`,
      awayTeamName: nameById.get(f.away_team_id) ?? `#${f.away_team_id}`,
    };
    if (!teamIds.has(f.home_team_id) || !teamIds.has(f.away_team_id)) {
      return { ...base, prediction: null };
    }
    const markets = gridToMarkets(predictScoreGrid(params, f.home_team_id, f.away_team_id));
    return {
      ...base,
      prediction: {
        homeWin: markets.homeWin,
        draw: markets.draw,
        awayWin: markets.awayWin,
        bttsYes: markets.bttsYes,
        over25: markets.overUnder.find((l) => l.line === 2.5)?.over ?? null,
        expectedHomeGoals: markets.expectedHomeGoals,
        expectedAwayGoals: markets.expectedAwayGoals,
        mostLikelyScore: markets.topScores[0] ?? null,
        doubleChance: markets.doubleChance,
        // "Handicap straight win": home -0.5 (== home win) and away +0.5 (== X2).
        asianHandicap: {
          home: markets.asianHandicap.home.find((l) => l.line === -0.5) ?? null,
          away: markets.asianHandicap.away.find((l) => l.line === 0.5) ?? null,
        },
      },
    };
  });
  return json({ league, count: out.length, fixtures: out, model: meta });
}

async function handlePredict(url: URL, env: Env): Promise<Response> {
  const league = requireLeagueParam(url);
  await requireKnownLeague(env, league);
  const home = url.searchParams.get("home");
  const away = url.searchParams.get("away");
  if (!home || !away) {
    throw new HttpError(400, "missing required query parameters 'home' and 'away' (team name or id)");
  }
  const prediction = await predictMatch(env.DB, league, home, away);
  return json(prediction);
}

async function handleModel(league: string, url: URL, env: Env): Promise<Response> {
  await requireKnownLeague(env, league);
  const kind = url.searchParams.get("kind") ?? "goals";
  if (kind !== "goals" && kind !== "cards") {
    throw new HttpError(400, "'kind' must be 'goals' or 'cards'");
  }
  const { params, meta } =
    kind === "cards" ? await getOrFitCards(env.DB, league) : await getOrFitParams(env.DB, league);
  const teams = await getTeams(env.DB, league);
  const nameById = new Map(teams.map((t) => [t.id, t.name]));
  // Net-strength ranking: alpha_i + beta_i (log-goal supremacy over a league-
  // average opponent, up to a constant). Sign convention: higher attack =
  // scores more; higher defence = concedes FEWER (opponent xG carries -beta).
  // For cards: attack = collects yellows; defence = makes opponents collect.
  const ratings = params.teamIds
    .map((id, i) => ({
      teamId: id,
      name: nameById.get(id) ?? `#${id}`,
      attack: params.attack[i],
      defence: params.defence[i],
      rating: params.attack[i] + params.defence[i],
    }))
    .sort((a, b) => b.rating - a.rating);
  return json({ league, kind, homeAdv: params.homeAdv, rho: params.rho, ratings, model: meta });
}

async function handleBacktest(url: URL, env: Env): Promise<Response> {
  const league = requireLeagueParam(url);
  await requireKnownLeague(env, league);
  const result = await backtestLeague(env.DB, league);
  return json(result);
}

export async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  try {
    if (path === "/api/health" && method === "GET") return json({ ok: true });
    if (path === "/api/leagues" && method === "GET") return await handleLeagues(env);
    if (path === "/api/sync" && method === "POST") return await handleSync(url, env, request);
    if (path === "/api/sync-stats" && method === "POST") return await handleSyncStats(url, env, request);
    if (path === "/api/stats-coverage" && method === "GET") return await handleStatsCoverage(env);
    if (path === "/api/fixtures" && method === "GET") return await handleFixtures(url, env);
    if (path === "/api/predict" && method === "GET") return await handlePredict(url, env);
    if (path === "/api/backtest" && method === "GET") return await handleBacktest(url, env);
    if (path === "/api/bets" || path.startsWith("/api/bets/")) return await handleBets(request, env, url);
    const modelMatch = /^\/api\/model\/([A-Za-z0-9]+)$/.exec(path);
    if (modelMatch && method === "GET") return await handleModel(modelMatch[1].toUpperCase(), url, env);
    if (path.startsWith("/api/")) throw new HttpError(404, `no route for ${method} ${path}`);
    throw new HttpError(404, "not found; try /api/health or /api/leagues");
  } catch (e) {
    return errorResponse(e, path);
  }
}

function errorResponse(e: unknown, path: string): Response {
  if (e instanceof HttpError) {
    return json({ error: e.message }, e.status);
  }
  if (e instanceof InsufficientDataError) {
    return json({ error: e.message }, 400);
  }
  if (e instanceof FootballDataError) {
    // 429 from upstream is meaningful to callers; anything else is a bad gateway.
    const status = e.status === 429 ? 429 : 502;
    return json({ error: e.message, retryAfterSeconds: e.retryAfterSeconds ?? null }, status);
  }
  if (e instanceof StatsRestrictedError) {
    return json({ error: e.message, restricted: true }, 403);
  }
  const message = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ message: "unhandled error", path, error: message }));
  return json({ error: "internal server error" }, 500);
}
