import { describe, expect, it } from "vitest";
import { fitDixonColes } from "../src/model/dixonColes";
import { InsufficientDataError, runBacktest } from "../src/model/backtest";
import type { ModelMatch } from "../src/types";
import { mulberry32, samplePoisson, spearman } from "./helpers";

/**
 * Synthetic league with KNOWN ground-truth strengths: 20 teams, 3 full
 * double-round-robin seasons (1140 matches), generated with a seeded RNG.
 * Each team has separate attack and defence strengths (a_i, d_i):
 *   lambda = exp(0.15 + a_home - d_away + 0.25),
 *   mu     = exp(0.15 + a_away - d_home).
 * Overall team strength is a_i - d_i.
 */
const TEAM_COUNT = 20;
const SEASONS = 3;
const TRUE_HOME_ADV = 0.25;

function generateLeague(): { matches: ModelMatch[]; strengths: Map<number, number> } {
  const rand = mulberry32(42);
  const attack = new Map<number, number>();
  const defence = new Map<number, number>();
  for (let i = 1; i <= TEAM_COUNT; i++) {
    attack.set(i, -0.4 + ((i - 1) / (TEAM_COUNT - 1)) * 0.8 + (rand() - 0.5) * 0.04);
    // Shuffle defence independently so teams differ in style, not just quality.
    const j = 1 + Math.floor(rand() * TEAM_COUNT);
    defence.set(j, -0.4 + ((i - 1) / (TEAM_COUNT - 1)) * 0.8 + (rand() - 0.5) * 0.04);
  }
  // Fill any defence slots the random assignment missed.
  for (let i = 1; i <= TEAM_COUNT; i++) {
    if (!defence.has(i)) defence.set(i, (rand() - 0.5) * 0.8);
  }
  const strengths = new Map<number, number>();
  for (let i = 1; i <= TEAM_COUNT; i++) {
    strengths.set(i, (attack.get(i) as number) - (defence.get(i) as number));
  }
  const matches: ModelMatch[] = [];
  for (let season = 0; season < SEASONS; season++) {
    const seasonStart = Date.UTC(2022 + season, 7, 1);
    let matchIndex = 0;
    for (let h = 1; h <= TEAM_COUNT; h++) {
      for (let a = 1; a <= TEAM_COUNT; a++) {
        if (h === a) continue;
        const lambda = Math.exp(0.15 + (attack.get(h) as number) - (defence.get(a) as number) + TRUE_HOME_ADV);
        const mu = Math.exp(0.15 + (attack.get(a) as number) - (defence.get(h) as number));
        matches.push({
          homeTeamId: h,
          awayTeamId: a,
          homeGoals: samplePoisson(lambda, rand),
          awayGoals: samplePoisson(mu, rand),
          utcDate: new Date(seasonStart + Math.floor(matchIndex * 0.6 * 86_400_000)).toISOString(),
        });
        matchIndex++;
      }
    }
  }
  return { matches, strengths };
}

const { matches, strengths } = generateLeague();

describe("synthetic league (known ground truth)", () => {
  it("generates the expected volume of matches", () => {
    expect(matches.length).toBe(SEASONS * TEAM_COUNT * (TEAM_COUNT - 1));
  });

  it("fitted model recovers the true strength ranking (Spearman > 0.9)", () => {
    const params = fitDixonColes(matches);
    const fittedRating = params.teamIds.map((_, i) => params.attack[i] - params.defence[i]);
    const truth = params.teamIds.map((id) => strengths.get(id) as number);
    const corr = spearman(fittedRating, truth);
    expect(corr).toBeGreaterThan(0.9);
    // Home advantage should land near the true 0.25.
    expect(params.homeAdv).toBeGreaterThan(0.05);
    expect(params.homeAdv).toBeLessThan(0.5);
  });

  it("backtest beats the naive base-rate baseline and the uniform predictor", () => {
    const result = runBacktest(matches, { burnIn: 200, refitEvery: 20, iterations: 400 });
    expect(result.predicted).toBeGreaterThan(800);
    expect(result.skipped).toBe(0);
    const uniformLogLoss = -Math.log(1 / 3); // ~1.0986
    expect(result.model.logLoss).toBeLessThan(result.baseline.logLoss);
    expect(result.model.logLoss).toBeLessThan(uniformLogLoss);
    expect(result.model.brier).toBeLessThan(result.baseline.brier);
    expect(result.model.rps).toBeLessThan(result.baseline.rps);
    expect(result.deltas.logLoss).toBeLessThan(0);
    // Uniform predictor sanity: -ln(1/3).
    expect(result.uniform.logLoss).toBeCloseTo(uniformLogLoss, 6);
    // Calibration table: 10 decile rows, probabilities within [0,1] where populated.
    expect(result.calibration.length).toBe(10);
    for (const row of result.calibration) {
      if (row.count > 0) {
        expect(row.meanPredicted).toBeGreaterThanOrEqual(0);
        expect(row.meanPredicted).toBeLessThanOrEqual(1);
        expect(row.empirical).toBeGreaterThanOrEqual(0);
        expect(row.empirical).toBeLessThanOrEqual(1);
      }
    }
  });

  it("refuses to backtest with fewer than 150 matches", () => {
    expect(() => runBacktest(matches.slice(0, 149))).toThrow(InsufficientDataError);
    expect(() => runBacktest(matches.slice(0, 149))).toThrow(/at least 150/);
  });
});
