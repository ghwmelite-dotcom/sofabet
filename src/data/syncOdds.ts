/**
 * Odds sync: fetch events from the-odds-api for one league, match them to
 * D1 fixtures, aggregate bookmaker prices (consensus/best/count), attach
 * model probabilities + EV, and replace the league's snapshots for
 * not-yet-started matches. Quota headers are persisted in meta.
 */

import { LEAGUES } from "../config";
import { predictScoreGrid } from "../model/dixonColes";
import { gridToMarkets } from "../model/markets";
import { getOrFitParams } from "../model/service";
import {
  aggregatePrices,
  dedupeEvents,
  evPct,
  gridProbTotalOver,
  matchEventToFixture,
  resolveSportByTitle,
} from "../model/odds";
import type { EventLike, FixtureLike } from "../model/odds";
import { OddsApiClient } from "./oddsApi";
import type { OddsEvent } from "./oddsApi";
import {
  getMeta,
  getScheduledMatches,
  getTeams,
  replaceLeagueOddsSnapshots,
  setMeta,
} from "./repo";
import type { OddsSnapshotInsert } from "./repo";
import { HttpError, OddsApiError } from "../types";

const META_SPORT_MAP = "odds_sport_map";
const META_QUOTA_REMAINING = "odds_quota_remaining";
const META_QUOTA_USED = "odds_quota_used";
const META_QUOTA_AT = "odds_quota_updated_at";

export interface OddsSyncResult {
  league: string;
  sportKey: string;
  events: number;
  matched: number;
  unmatched: string[];
  snapshots: number;
  quotaRemaining: number | null;
  quotaUsed: number | null;
}

async function readSportMap(db: D1Database): Promise<Record<string, string>> {
  const raw = await getMeta(db, META_SPORT_MAP);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function refreshSportMap(db: D1Database, client: OddsApiClient): Promise<Record<string, string>> {
  const sports = await client.listSports();
  const map: Record<string, string> = {};
  for (const [key, cfg] of Object.entries(LEAGUES)) {
    const hit = resolveSportByTitle(cfg.name, sports);
    if (hit) map[key] = hit.key;
  }
  await setMeta(db, META_SPORT_MAP, JSON.stringify(map));
  return map;
}

/** League key -> sport key: config pin first, then meta cache, then /sports resolution. */
async function sportKeyFor(db: D1Database, client: OddsApiClient, league: string): Promise<string> {
  const pinned = LEAGUES[league]?.oddsSportKey;
  if (pinned) return pinned;
  const cached = (await readSportMap(db))[league];
  if (cached) return cached;
  const refreshed = await refreshSportMap(db, client);
  const key = refreshed[league];
  if (!key) throw new HttpError(400, `could not resolve a the-odds-api sport key for league ${league}`);
  return key;
}

async function persistQuota(db: D1Database, client: OddsApiClient): Promise<void> {
  if (client.quotaRemaining !== null) await setMeta(db, META_QUOTA_REMAINING, String(client.quotaRemaining));
  if (client.quotaUsed !== null) await setMeta(db, META_QUOTA_USED, String(client.quotaUsed));
  await setMeta(db, META_QUOTA_AT, new Date().toISOString());
}

/** h2h outcome name -> canonical selection, using the event's own team names. */
function h2hSelection(outcomeName: string, event: OddsEvent): string | null {
  if (outcomeName === event.home_team) return "home";
  if (outcomeName === event.away_team) return "away";
  if (outcomeName.toLowerCase() === "draw") return "draw";
  return null;
}

/**
 * Sync one league's odds. `markets` is a the-odds-api markets string:
 * "h2h" (1 quota unit) or "h2h,totals" (2 units). Caller passes the client so
 * tests could inject a fake one; production code builds it from env below.
 */
export async function syncOddsLeagueWithClient(
  db: D1Database,
  client: OddsApiClient,
  league: string,
  markets: string,
): Promise<OddsSyncResult> {
  const cfg = LEAGUES[league];
  if (!cfg) throw new HttpError(400, `unknown league '${league}'`);

  let sportKey = await sportKeyFor(db, client, league);
  let events: OddsEvent[];
  try {
    events = await client.getEventOdds(sportKey, markets);
  } catch (e) {
    // Cached sport keys do go stale — refetch the map once and retry.
    if (e instanceof OddsApiError && e.status === 404) {
      const refreshed = await refreshSportMap(db, client);
      sportKey = refreshed[league] ?? sportKey;
      events = await client.getEventOdds(sportKey, markets);
    } else {
      throw e;
    }
  }
  await persistQuota(db, client);

  const fixtures = await getScheduledMatches(db, league);
  const nameById = new Map((await getTeams(db, league)).map((t) => [t.id, t.name]));
  const fixtureLikes: FixtureLike[] = fixtures.map((f) => ({
    id: f.id,
    utcDate: f.utc_date,
    homeTeamName: nameById.get(f.home_team_id) ?? "",
    awayTeamName: nameById.get(f.away_team_id) ?? "",
  }));
  const fixtureById = new Map(fixtures.map((f) => [f.id, f]));

  const { params } = await getOrFitParams(db, league);
  const modelTeamIds = new Set(params.teamIds);
  const fetchedAt = new Date().toISOString();
  const rows: OddsSnapshotInsert[] = [];
  const unmatched: string[] = [];

  for (const event of dedupeEvents(events)) {
    const fixture = matchEventToFixture(event as EventLike, fixtureLikes);
    if (!fixture) {
      unmatched.push(`${event.home_team} vs ${event.away_team}`);
      continue;
    }
    const row = fixtureById.get(fixture.id);
    if (!row || !modelTeamIds.has(row.home_team_id) || !modelTeamIds.has(row.away_team_id)) continue;
    const grid = predictScoreGrid(params, row.home_team_id, row.away_team_id);
    const mk = gridToMarkets(grid);
    const modelH2h: Record<string, number> = { home: mk.homeWin, draw: mk.draw, away: mk.awayWin };

    for (const marketKey of markets.split(",")) {
      // selection -> prices across bookmakers (+ line for totals)
      const bySelection = new Map<string, { prices: number[]; line: number | null }>();
      for (const book of event.bookmakers ?? []) {
        const market = (book.markets ?? []).find((m) => m.key === marketKey);
        if (!market?.outcomes) continue;
        for (const outcome of market.outcomes) {
          if (typeof outcome.price !== "number" || outcome.price <= 1) continue;
          let selection: string | null = null;
          let line: number | null = null;
          if (marketKey === "h2h") {
            selection = h2hSelection(outcome.name, event);
          } else if (marketKey === "totals") {
            const name = outcome.name.toLowerCase();
            if (name === "over" || name === "under") {
              selection = name;
              line = typeof outcome.point === "number" ? outcome.point : null;
            }
          }
          if (!selection) continue;
          const key = marketKey === "totals" ? `${selection}|${line}` : selection;
          const entry = bySelection.get(key) ?? { prices: [], line };
          entry.prices.push(outcome.price);
          bySelection.set(key, entry);
        }
      }

      // Overround (margin) logged for visibility; fair-implied normalization
      // is covered by unit tests in model/odds.
      const consensusPrices = [...bySelection.values()].map((e) => aggregatePrices(e.prices).consensus);
      if (consensusPrices.length > 1) {
        const margin = consensusPrices.reduce((a, p) => a + (p > 0 ? 1 / p : 0), 0) - 1;
        console.log(
          JSON.stringify({
            message: "odds market margin",
            league,
            matchId: fixture.id,
            market: marketKey,
            marginPct: Math.round(margin * 1000) / 10,
          }),
        );
      }

      for (const [key, entry] of bySelection) {
        const agg = aggregatePrices(entry.prices);
        if (agg.bookmakers === 0) continue;
        const selection = marketKey === "totals" ? key.split("|")[0] : key;
        let modelProb: number;
        if (marketKey === "h2h") {
          modelProb = modelH2h[selection];
        } else {
          const over = gridProbTotalOver(grid, entry.line ?? 2.5);
          modelProb = selection === "over" ? over : 1 - over;
        }
        rows.push({
          matchId: fixture.id,
          market: marketKey,
          selection,
          line: entry.line,
          bestOdds: agg.best,
          consensusOdds: Math.round(agg.consensus * 1000) / 1000,
          bookmakers: agg.bookmakers,
          modelProb,
          evPct: evPct(modelProb, agg.best),
          fetchedAt,
        });
      }
    }
  }

  await replaceLeagueOddsSnapshots(db, league, new Date().toISOString(), rows);
  return {
    league,
    sportKey,
    events: events.length,
    matched: events.length - unmatched.length,
    unmatched,
    snapshots: rows.length,
    quotaRemaining: client.quotaRemaining,
    quotaUsed: client.quotaUsed,
  };
}

/** Production entry: builds the client from the ODDS_API_KEY secret. */
export async function syncOddsLeague(
  db: D1Database,
  env: Env,
  league: string,
  markets: string,
): Promise<OddsSyncResult> {
  const apiKey = env.ODDS_API_KEY;
  if (!apiKey) throw new HttpError(500, "ODDS_API_KEY secret is not configured");
  return syncOddsLeagueWithClient(db, new OddsApiClient(apiKey), league, markets);
}
