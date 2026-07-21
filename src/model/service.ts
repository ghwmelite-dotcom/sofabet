/**
 * Binding-aware model orchestration: load matches from D1, fit-or-cache
 * parameters in model_cache, produce predictions and backtests.
 */

import {
  countFinishedMatches,
  getFinishedMatches,
  getModelCache,
  getTeams,
  setModelCache,
} from "../data/repo";
import { fitDixonColes, predictExpectedGoals, predictScoreGrid } from "./dixonColes";
import type { FittedParams } from "./dixonColes";
import { gridToMarkets } from "./markets";
import type { Markets } from "./markets";
import { runBacktest } from "./backtest";
import type { BacktestResult } from "./backtest";
import { HttpError } from "../types";
import type { TeamRow } from "../types";

const MODEL_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6h
const MIN_MATCHES_TO_FIT = 30;

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
  await setModelCache(db, league, JSON.stringify(params), fittedAt, matches.length);
  return { params, meta: { fittedAt, matchCount: matches.length, fromCache: false, ageSeconds: 0 } };
}

/**
 * Return fitted params for a league, using model_cache when it is fresh
 * (fitted within 6h AND match_count equals the current finished count);
 * otherwise refit, store, and return.
 */
export async function getOrFitParams(
  db: D1Database,
  league: string,
  opts: { forceRefresh?: boolean } = {},
): Promise<FitResult> {
  const finishedCount = await countFinishedMatches(db, league);
  if (!opts.forceRefresh) {
    const cached = await getModelCache(db, league);
    if (cached && cached.match_count === finishedCount) {
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
  return fitAndStore(db, league);
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

export interface Prediction {
  league: string;
  home: ResolvedTeam;
  away: ResolvedTeam;
  expectedHomeGoals: number;
  expectedAwayGoals: number;
  markets: Markets;
  model: ModelMeta;
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
  return {
    league,
    home,
    away,
    expectedHomeGoals: lambda,
    expectedAwayGoals: mu,
    markets,
    model: meta,
  };
}

export async function backtestLeague(db: D1Database, league: string): Promise<BacktestResult & { league: string }> {
  const matches = await getFinishedMatches(db, league);
  const result = runBacktest(matches);
  return { league, ...result };
}
