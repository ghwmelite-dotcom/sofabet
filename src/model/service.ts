/**
 * Binding-aware model orchestration: load matches from D1, fit-or-cache
 * parameters in model_cache, produce predictions and backtests.
 */

import {
  countCardStats,
  countFinishedMatches,
  getCardTrainingRows,
  getFinishedMatches,
  getModelCache,
  getScheduledMatches,
  getTeams,
  setModelCache,
  upsertPrediction,
} from "../data/repo";
import { fitDixonColes, predictExpectedGoals, predictScoreGrid } from "./dixonColes";
import type { FittedParams } from "./dixonColes";
import { cardsGridToMarkets, fitCards, predictCardsGrid } from "./cards";
import type { CardsMarkets } from "./cards";
import { gridToMarkets } from "./markets";
import type { Markets } from "./markets";
import { runBacktest } from "./backtest";
import type { BacktestResult } from "./backtest";
import { HttpError } from "../types";
import type { TeamRow } from "../types";

const MODEL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const MIN_MATCHES_TO_FIT = 30;
/** Leagues need at least this many matches with bookings before cards predictions are served. */
export const MIN_STATS_TO_FIT = 60;

export interface ModelMeta {
  fittedAt: string;
  matchCount: number;
  fromCache: boolean;
  ageSeconds: number;
}

export interface FitResult {
  params: FittedParams;
  meta: ModelMeta;
}

function isFittedParams(value: unknown): value is FittedParams {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.teamIds) &&
    Array.isArray(v.attack) &&
    Array.isArray(v.defence) &&
    typeof v.homeAdv === "number" &&
    typeof v.rho === "number"
  );
}

async function fitAndStore(db: D1Database, league: string): Promise<FitResult> {
  const matches = await getFinishedMatches(db, league);
  if (matches.length < MIN_MATCHES_TO_FIT) {
    throw new HttpError(
      400,
      `not enough finished matches for league ${league}: ${matches.length} (need >= ${MIN_MATCHES_TO_FIT}); run POST /api/sync?league=${league} first`,
    );
  }
  const params = fitDixonColes(matches);
  const fittedAt = new Date().toISOString();
  await setModelCache(db, league, JSON.stringify(params), fittedAt, matches.length, "goals");
  return { params, meta: { fittedAt, matchCount: matches.length, fromCache: false, ageSeconds: 0 } };
}

async function fitCardsAndStore(db: D1Database, league: string): Promise<FitResult> {
  const rows = await getCardTrainingRows(db, league);
  if (rows.length < MIN_STATS_TO_FIT) {
    throw new HttpError(
      400,
      `not enough matches with bookings for league ${league}: ${rows.length} (need >= ${MIN_STATS_TO_FIT}); run POST /api/sync-stats?league=${league} first`,
    );
  }
  const params = fitCards(rows);
  const fittedAt = new Date().toISOString();
  await setModelCache(db, league, JSON.stringify(params), fittedAt, rows.length, "cards");
  return { params, meta: { fittedAt, matchCount: rows.length, fromCache: false, ageSeconds: 0 } };
}

/** Generic fit-or-cache against model_cache for one (league, kind). */
async function getOrFit(
  db: D1Database,
  league: string,
  kind: "goals" | "cards",
  currentCount: number,
  refit: () => Promise<FitResult>,
  opts: { forceRefresh?: boolean },
): Promise<FitResult> {
  if (!opts.forceRefresh) {
    const cached = await getModelCache(db, league, kind);
    if (cached && cached.match_count === currentCount) {
      const ageMs = Date.now() - Date.parse(cached.fitted_at);
      if (ageMs >= 0 && ageMs < MODEL_MAX_AGE_MS) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(cached.params_json);
        } catch {
          parsed = null;
        }
        if (isFittedParams(parsed)) {
          return {
            params: parsed,
            meta: {
              fittedAt: cached.fitted_at,
              matchCount: cached.match_count,
              fromCache: true,
              ageSeconds: Math.round(ageMs / 1000),
            },
          };
        }
      }
    }
  }
  return refit();
}

/**
 * Return fitted goals params for a league, using model_cache when it is fresh
 * (fitted within 6h AND match_count equals the current finished count);
 * otherwise refit, store, and return.
 */
export async function getOrFitParams(
  db: D1Database,
  league: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<FitResult> {
  const finishedCount = await countFinishedMatches(db, league);
  return getOrFit(db, league, "goals", finishedCount, () => fitAndStore(db, league), opts);
}

/**
 * Return fitted cards params for a league — same freshness rule as goals,
 * keyed on the current number of matches with bookings.
 */
export async function getOrFitCards(
  db: D1Database,
  league: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<FitResult> {
  const statsCount = await countCardStats(db, league);
  return getOrFit(db, league, "cards", statsCount, () => fitCardsAndStore(db, league), opts);
}

/** Force a refit + cache store (used by the cron handler). Returns null when
 * there is not enough data instead of throwing. */
export async function refitLeague(db: D1Database, league: string): Promise<ModelMeta | null> {
  const finishedCount = await countFinishedMatches(db, league);
  if (finishedCount < MIN_MATCHES_TO_FIT) return null;
  const { meta } = await fitAndStore(db, league);
  return meta;
}

export interface ResolvedTeam {
  id: number;
  name: string;
}

/** Resolve a team query (numeric internal id, exact name, or substring) to a team. */
export function resolveTeam(teams: TeamRow[], query: string): ResolvedTeam {
  const asId = Number(query);
  if (Number.isInteger(asId)) {
    const byId = teams.find((t) => t.id === asId);
    if (byId) return { id: byId.id, name: byId.name };
  }
  const q = query.trim().toLowerCase();
  if (q.length > 0) {
    const exact = teams.find(
      (t) => t.name.toLowerCase() === q || (t.short_name !== null && t.short_name.toLowerCase() === q),
    );
    if (exact) return { id: exact.id, name: exact.name };
    const partial = teams.filter((t) => t.name.toLowerCase().includes(q));
    if (partial.length === 1) return { id: partial[0].id, name: partial[0].name };
    if (partial.length > 1) {
      throw new HttpError(
        400,
        `team query '${query}' is ambiguous: ${partial.map((t) => t.name).join(", ")}`,
      );
    }
  }
  const sample = teams.slice(0, 10).map((t) => `${t.name} (id ${t.id})`).join(", ");
  throw new HttpError(404, `team '${query}' not found. Known teams include: ${sample}`);
}

export interface CardsCoverage {
  statsCount: number;
  required: number;
}

export interface Prediction {
  league: string;
  home: ResolvedTeam;
  away: ResolvedTeam;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  markets: Markets;
  model: ModelMeta;
  /** Yellow-card markets; null until the league has >= MIN_STATS_TO_FIT booked matches. */
  cards: CardsMarkets | null;
  cardsModel: ModelMeta | null;
  cardsCoverage: CardsCoverage;
}

export async function predictMatch(
  db: D1Database,
  league: string,
  homeQuery: string,
  awayQuery: string,
): Promise<Prediction> {
  const teams = await getTeams(db, league);
  if (teams.length === 0) {
    throw new HttpError(400, `no teams stored for league ${league}; run POST /api/sync?league=${league} first`);
  }
  const home = resolveTeam(teams, homeQuery);
  const away = resolveTeam(teams, awayQuery);
  if (home.id === away.id) {
    throw new HttpError(400, "home and away team must differ");
  }
  const { params, meta } = await getOrFitParams(db, league);
  if (!params.teamIds.includes(home.id) || !params.teamIds.includes(away.id)) {
    throw new HttpError(400, "one or both teams have no finished matches in the fitted window");
  }
  const grid = predictScoreGrid(params, home.id, away.id);
  const markets = gridToMarkets(grid);
  const { lambda, mu } = predictExpectedGoals(params, home.id, away.id);

  // Cards are best-effort: coverage below the threshold (or teams missing
  // from the cards window) yields cards: null, never an error.
  const statsCount = await countCardStats(db, league);
  let cards: CardsMarkets | null = null;
  let cardsModel: ModelMeta | null = null;
  if (statsCount >= MIN_STATS_TO_FIT) {
    try {
      const cardsFit = await getOrFitCards(db, league);
      if (cardsFit.params.teamIds.includes(home.id) && cardsFit.params.teamIds.includes(away.id)) {
        cards = cardsGridToMarkets(predictCardsGrid(cardsFit.params, home.id, away.id));
        cardsModel = cardsFit.meta;
      }
    } catch (e) {
      console.error(
        JSON.stringify({ message: "cards prediction failed", league, error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }

  return {
    league,
    home,
    away,
    expectedHomeGoals: lambda,
    expectedAwayGoals: mu,
    markets,
    model: meta,
    cards,
    cardsModel,
    cardsCoverage: { statsCount, required: MIN_STATS_TO_FIT },
  };
}

export async function backtestLeague(db: D1Database, league: string): Promise<BacktestResult & { league: string }> {
  const matches = await getFinishedMatches(db, league);
  const result = runBacktest(matches);
  return { league, ...result };
}

export interface SnapshotResult {
  written: number;
  skipped: number;
}

/**
 * Write pre-kickoff prediction snapshots for a league.
 *
 * HONESTY RULE: predictions are graded ONLY from snapshots taken BEFORE
 * kickoff. We never recompute "what the model would have said" for a finished
 * match — by then the model may have refit on the result, which would backfit
 * the record. Fixtures that finished before this feature shipped simply have
 * no snapshot: the track record starts empty and accumulates from deploy day.
 *
 * getScheduledMatches returns only SCHEDULED/TIMED rows, so IN_PLAY/PAUSED/
 * FINISHED matches never reach the upsert (a finished match's frozen row can
 * never be overwritten here); the status filter below is belt-and-braces.
 * Fixtures whose teams are missing from the fitted params (newcomers) are
 * skipped, same rule as the fixtures endpoint.
 */
export async function snapshotUpcomingPredictions(db: D1Database, league: string): Promise<SnapshotResult> {
  const fixtures = await getScheduledMatches(db, league);
  const { params, meta } = await getOrFitParams(db, league);
  const teamIds = new Set(params.teamIds);
  const nowIso = new Date().toISOString();
  let written = 0;
  let skipped = 0;
  for (const f of fixtures) {
    if (f.status !== "SCHEDULED" && f.status !== "TIMED") {
      skipped++;
      continue;
    }
    if (!teamIds.has(f.home_team_id) || !teamIds.has(f.away_team_id)) {
      skipped++;
      continue;
    }
    const markets = gridToMarkets(predictScoreGrid(params, f.home_team_id, f.away_team_id));
    const over25 = markets.overUnder.find((l) => l.line === 2.5)?.over ?? 0;
    const top = markets.topScores[0];
    await upsertPrediction(db, {
      matchId: f.id,
      league,
      homeWin: markets.homeWin,
      draw: markets.draw,
      awayWin: markets.awayWin,
      over25,
      bttsYes: markets.bttsYes,
      topScore: top ? `${top.home}-${top.away}` : "0-0",
      modelFittedAt: meta.fittedAt,
      nowIso,
    });
    written++;
  }
  return { written, skipped };
}
