/**
 * Walk-forward backtest of the Dixon–Coles model (pure functions).
 *
 * Burn in on the first `burnIn` matches (default 60), then repeatedly:
 * refit on all matches so far (expanding window), predict the next block of
 * `refitEvery` matches (default 8). Reports 1X2 log loss, Brier score and RPS
 * for the model, a naive base-rate baseline (league H/D/A frequencies from the
 * same training window) and the uniform 1/3 predictor, plus a decile
 * calibration table for predicted home-win probability.
 */

import { fitDixonColes, predictScoreGrid } from "./dixonColes";
import { gridToMarkets } from "./markets";
import type { ModelMatch } from "../types";

export interface BacktestOptions {
  /** Minimum finished matches required (default 150). */
  minMatches?: number;
  /** Matches used before the first prediction (default 60). */
  burnIn?: number;
  /** Refit cadence in matches (default 8). */
  refitEvery?: number;
  /** Adam iterations per refit (default from fitDixonColes). */
  iterations?: number;
}

export interface MetricSet {
  logLoss: number;
  brier: number;
  rps: number;
}

export interface CalibrationRow {
  bucket: string;
  count: number;
  meanPredicted: number | null;
  empirical: number | null;
}

export interface BacktestResult {
  matchCount: number;
  burnIn: number;
  refitEvery: number;
  predicted: number;
  skipped: number;
  model: MetricSet;
  baseline: MetricSet;
  uniform: MetricSet;
  /** model minus baseline; negative means the model is better. */
  deltas: MetricSet;
  calibration: CalibrationRow[];
}

export class InsufficientDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InsufficientDataError";
  }
}

const OUTCOME_H = 0;
const OUTCOME_D = 1;
const OUTCOME_A = 2;

/** RPS for ordinal H<D<A: mean over r=1..K-1 of squared cumulative error, normalized by K-1. */
function rps(p: number[], o: number[]): number {
  let cumP = 0;
  let cumO = 0;
  let sum = 0;
  for (let k = 0; k < p.length - 1; k++) {
    cumP += p[k];
    cumO += o[k];
    const d = cumP - cumO;
    sum += d * d;
  }
  return sum / (p.length - 1);
}

export function runBacktest(matches: ModelMatch[], opts: BacktestOptions = {}): BacktestResult {
  const minMatches = opts.minMatches ?? 150;
  const burnIn = opts.burnIn ?? 60;
  const refitEvery = opts.refitEvery ?? 8;
  if (matches.length < minMatches) {
    throw new InsufficientDataError(
      `backtest needs at least ${minMatches} finished matches, got ${matches.length}`,
    );
  }
  const sorted = [...matches].sort((a, b) => a.utcDate.localeCompare(b.utcDate));

  let sumModel = [0, 0, 0];
  let sumBase = [0, 0, 0];
  let sumUniform = [0, 0, 0];
  let predicted = 0;
  let skipped = 0;
  const calBuckets = Array.from({ length: 10 }, () => ({ count: 0, sumPred: 0, sumHome: 0 }));

  const accumulate = (acc: number[], p: number[], o: number[]): void => {
    acc[0] += -Math.log(Math.max(p[o.indexOf(1)], 1e-12));
    let brier = 0;
    for (let k = 0; k < 3; k++) brier += (p[k] - o[k]) ** 2;
    acc[1] += brier;
    acc[2] += rps(p, o);
  };

  for (let i = burnIn; i < sorted.length; i += refitEvery) {
    const train = sorted.slice(0, i);
    const block = sorted.slice(i, Math.min(i + refitEvery, sorted.length));
    const params = fitDixonColes(train, { iterations: opts.iterations });
    const teamSet = new Set(params.teamIds);

    // Naive baseline: base rates of H/D/A in the training window.
    let hWins = 0;
    let draws = 0;
    for (const m of train) {
      if (m.homeGoals > m.awayGoals) hWins++;
      else if (m.homeGoals === m.awayGoals) draws++;
    }
    const n = train.length;
    const baseP = [hWins / n, draws / n, (n - hWins - draws) / n];
    const uniformP = [1 / 3, 1 / 3, 1 / 3];

    for (const m of block) {
      if (!teamSet.has(m.homeTeamId) || !teamSet.has(m.awayTeamId)) {
        skipped++;
        continue;
      }
      const grid = predictScoreGrid(params, m.homeTeamId, m.awayTeamId);
      const mk = gridToMarkets(grid);
      const modelP = [mk.homeWin, mk.draw, mk.awayWin];
      const outcome =
        m.homeGoals > m.awayGoals ? OUTCOME_H : m.homeGoals === m.awayGoals ? OUTCOME_D : OUTCOME_A;
      const o = [0, 0, 0];
      o[outcome] = 1;

      accumulate(sumModel, modelP, o);
      accumulate(sumBase, baseP, o);
      accumulate(sumUniform, uniformP, o);

      const bucket = Math.min(9, Math.floor(modelP[0] * 10));
      calBuckets[bucket].count++;
      calBuckets[bucket].sumPred += modelP[0];
      calBuckets[bucket].sumHome += outcome === OUTCOME_H ? 1 : 0;
      predicted++;
    }
  }

  if (predicted === 0) {
    throw new InsufficientDataError("backtest produced zero predictions (no known teams in test blocks)");
  }

  const toMetrics = (s: number[]): MetricSet => ({
    logLoss: s[0] / predicted,
    brier: s[1] / predicted,
    rps: s[2] / predicted,
  });
  const model = toMetrics(sumModel);
  const baseline = toMetrics(sumBase);
  const uniform = toMetrics(sumUniform);

  return {
    matchCount: sorted.length,
    burnIn,
    refitEvery,
    predicted,
    skipped,
    model,
    baseline,
    uniform,
    deltas: {
      logLoss: model.logLoss - baseline.logLoss,
      brier: model.brier - baseline.brier,
      rps: model.rps - baseline.rps,
    },
    calibration: calBuckets.map((b, i) => ({
      bucket: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
      count: b.count,
      meanPredicted: b.count > 0 ? b.sumPred / b.count : null,
      empirical: b.count > 0 ? b.sumHome / b.count : null,
    })),
  };
}
