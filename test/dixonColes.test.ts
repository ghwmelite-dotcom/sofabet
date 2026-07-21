import { describe, expect, it } from "vitest";
import { fitDixonColes, poissonPmf, predictScoreGrid, tau } from "../src/model/dixonColes";
import type { FittedParams } from "../src/model/dixonColes";
import { gridToMarkets } from "../src/model/markets";

describe("poissonPmf", () => {
  it("matches known values", () => {
    expect(poissonPmf(1.4, 0)).toBeCloseTo(Math.exp(-1.4), 10);
    expect(poissonPmf(1.4, 2)).toBeCloseTo(Math.exp(-1.4) * (1.4 ** 2) / 2, 10);
    expect(poissonPmf(2.0, 1)).toBeCloseTo(2 * Math.exp(-2), 10);
  });

  it("sums to 1 over a wide support", () => {
    for (const lambda of [0.3, 1.4, 3.7]) {
      let sum = 0;
      for (let k = 0; k <= 50; k++) sum += poissonPmf(lambda, k);
      expect(sum).toBeCloseTo(1, 10);
    }
  });

  it("returns 0 for negative or non-integer k", () => {
    expect(poissonPmf(1, -1)).toBe(0);
    expect(poissonPmf(1, 1.5)).toBe(0);
  });
});

describe("tau", () => {
  it("matches the Dixon-Coles correction values", () => {
    const lambda = 1.6;
    const mu = 1.1;
    const rho = -0.12;
    expect(tau(0, 0, lambda, mu, rho)).toBeCloseTo(1 - lambda * mu * rho, 12);
    expect(tau(1, 0, lambda, mu, rho)).toBeCloseTo(1 + mu * rho, 12);
    expect(tau(0, 1, lambda, mu, rho)).toBeCloseTo(1 + lambda * rho, 12);
    expect(tau(1, 1, lambda, mu, rho)).toBeCloseTo(1 - rho, 12);
    expect(tau(2, 1, lambda, mu, rho)).toBe(1);
    expect(tau(3, 3, lambda, mu, rho)).toBe(1);
  });
});

function twoTeamParams(homeAdv: number, rho: number): FittedParams {
  return { teamIds: [1, 2], attack: [0, 0], defence: [0, 0], homeAdv, rho };
}

describe("predictScoreGrid", () => {
  it("produces an 11x11 grid summing to ~1", () => {
    const grid = predictScoreGrid(twoTeamParams(0.3, -0.1), 1, 2);
    expect(grid.length).toBe(11);
    let sum = 0;
    for (const row of grid) {
      expect(row.length).toBe(11);
      for (const p of row) {
        expect(p).toBeGreaterThanOrEqual(0);
        sum += p;
      }
    }
    expect(sum).toBeCloseTo(1, 9);
  });

  it("equal teams with gamma > 0 => P(home win) > P(away win)", () => {
    const markets = gridToMarkets(predictScoreGrid(twoTeamParams(0.3, -0.1), 1, 2));
    expect(markets.homeWin).toBeGreaterThan(markets.awayWin);
  });

  it("equal teams with gamma = 0, rho = 0 => symmetric 1X2", () => {
    const markets = gridToMarkets(predictScoreGrid(twoTeamParams(0, 0), 1, 2));
    expect(markets.homeWin).toBeCloseTo(markets.awayWin, 10);
    expect(markets.homeWin + markets.draw + markets.awayWin).toBeCloseTo(1, 10);
    // With lambda = mu = 1: P(X>Y) for two iid Poisson(1) = (1 - e^-2 * I0(2)) / 2 ~ 0.3457.
    expect(markets.homeWin).toBeCloseTo(0.3457, 3);
  });

  it("stronger attack shifts expected goals", () => {
    const params: FittedParams = { teamIds: [1, 2], attack: [0.5, -0.5], defence: [0, 0], homeAdv: 0.2, rho: 0 };
    const grid = predictScoreGrid(params, 1, 2);
    const markets = gridToMarkets(grid);
    expect(markets.expectedHomeGoals).toBeGreaterThan(1.3);
    expect(markets.expectedAwayGoals).toBeLessThan(1);
  });
});

describe("gridToMarkets", () => {
  it("derives BTTS, over/under and top scores consistently", () => {
    const markets = gridToMarkets(predictScoreGrid(twoTeamParams(0.2, 0), 1, 2));
    expect(markets.bttsYes + markets.bttsNo).toBeCloseTo(1, 10);
    expect(markets.overUnder.map((l) => l.line)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5]);
    for (const { over, under } of markets.overUnder) {
      expect(over + under).toBeCloseTo(1, 10);
      expect(over).toBeGreaterThanOrEqual(0);
      expect(over).toBeLessThanOrEqual(1);
    }
    // Over probabilities must decrease as the line rises.
    const overs = markets.overUnder.map((l) => l.over);
    for (let i = 1; i < overs.length; i++) expect(overs[i]).toBeLessThan(overs[i - 1]);
    expect(markets.topScores.length).toBe(5);
    for (let i = 1; i < markets.topScores.length; i++) {
      expect(markets.topScores[i].prob).toBeLessThanOrEqual(markets.topScores[i - 1].prob);
    }
  });
});

describe("fitDixonColes", () => {
  it("keeps rho within [-0.2, 0.2] and returns finite params", () => {
    // Tiny synthetic set: team 1 always wins heavily at home.
    const matches = Array.from({ length: 40 }, (_, i) => ({
      homeTeamId: (i % 4) + 1,
      awayTeamId: ((i + 2) % 4) + 1,
      homeGoals: (i % 3) + 1,
      awayGoals: i % 2,
      utcDate: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(),
    }));
    const params = fitDixonColes(matches, { iterations: 200 });
    expect(params.rho).toBeGreaterThanOrEqual(-0.2);
    expect(params.rho).toBeLessThanOrEqual(0.2);
    for (const v of [...params.attack, ...params.defence, params.homeAdv]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    // Attack ratings re-centered to sum ~0.
    const sumAlpha = params.attack.reduce((a, b) => a + b, 0);
    expect(Math.abs(sumAlpha)).toBeLessThan(1e-9);
  });
});
