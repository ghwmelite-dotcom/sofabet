import { describe, expect, it } from "vitest";
import { cardsGridToMarkets, fitCards, predictCardsGrid } from "../src/model/cards";
import { predictExpectedGoals } from "../src/model/dixonColes";
import type { CardMatch } from "../src/types";
import { mulberry32, samplePoisson, spearman } from "./helpers";

/**
 * Synthetic cards league with KNOWN ground-truth tendencies: 12 teams, 2 full
 * double-round-robin seasons (264 matches), seeded RNG. Each team has a
 * collect-tendency ca_i and an opponent-tendency cd_i:
 *   lambda_home = exp(0.65 + ca_home - cd_away + 0.15)
 *   lambda_away = exp(0.65 + ca_away - cd_home)
 */
const TEAM_COUNT = 12;
const SEASONS = 2;
const TRUE_CARDS_HOME_ADV = 0.15;

function generateCardsLeague(): {
  matches: CardMatch[];
  collectTendency: Map<number, number>;
} {
  const rand = mulberry32(99);
  const ca = new Map<number, number>();
  const cd = new Map<number, number>();
  for (let i = 1; i <= TEAM_COUNT; i++) {
    ca.set(i, -0.4 + ((i - 1) / (TEAM_COUNT - 1)) * 0.8 + (rand() - 0.5) * 0.04);
    const j = 1 + Math.floor(rand() * TEAM_COUNT);
    cd.set(j, -0.25 + ((i - 1) / (TEAM_COUNT - 1)) * 0.5 + (rand() - 0.5) * 0.04);
  }
  for (let i = 1; i <= TEAM_COUNT; i++) {
    if (!cd.has(i)) cd.set(i, (rand() - 0.5) * 0.5);
  }
  const matches: CardMatch[] = [];
  for (let season = 0; season < SEASONS; season++) {
    const seasonStart = Date.UTC(2024 + season, 7, 1);
    let matchIndex = 0;
    for (let h = 1; h <= TEAM_COUNT; h++) {
      for (let a = 1; a <= TEAM_COUNT; a++) {
        if (h === a) continue;
        const lambda = Math.exp(0.65 + (ca.get(h) as number) - (cd.get(a) as number) + TRUE_CARDS_HOME_ADV);
        const mu = Math.exp(0.65 + (ca.get(a) as number) - (cd.get(h) as number));
        matches.push({
          homeTeamId: h,
          awayTeamId: a,
          homeYellow: samplePoisson(lambda, rand),
          awayYellow: samplePoisson(mu, rand),
          utcDate: new Date(seasonStart + Math.floor(matchIndex * 1.2 * 86_400_000)).toISOString(),
        });
        matchIndex++;
      }
    }
  }
  return { matches, collectTendency: ca };
}

const { matches, collectTendency } = generateCardsLeague();
const params = fitCards(matches);

describe("cards model (synthetic league, known ground truth)", () => {
  it("generates the expected volume", () => {
    expect(matches.length).toBe(SEASONS * TEAM_COUNT * (TEAM_COUNT - 1));
  });

  it("recovers the yellow-collect tendency ranking (Spearman > 0.9)", () => {
    const fitted = params.teamIds.map((_, i) => params.attack[i]);
    const truth = params.teamIds.map((id) => collectTendency.get(id) as number);
    const corr = spearman(fitted, truth);
    expect(corr).toBeGreaterThan(0.9);
  });

  it("has rho = 0 (plain Poisson, no tau) and a sane home advantage", () => {
    expect(params.rho).toBe(0);
    expect(params.homeAdv).toBeGreaterThan(0);
    expect(params.homeAdv).toBeLessThan(0.5);
  });

  it("cards markets are internally consistent", () => {
    const grid = predictCardsGrid(params, 1, 2);
    let sum = 0;
    for (const row of grid) for (const p of row) sum += p;
    expect(sum).toBeCloseTo(1, 9);
    expect(grid.length).toBe(13); // 0..12 per side

    const markets = cardsGridToMarkets(grid);
    expect(markets.expectedTotalYellow).toBeCloseTo(
      markets.expectedHomeYellow + markets.expectedAwayYellow,
      10,
    );
    // Expected yellows match the raw lambdas from the params.
    const { lambda, mu } = predictExpectedGoals(params, 1, 2);
    expect(markets.expectedHomeYellow).toBeCloseTo(lambda, 2);
    expect(markets.expectedAwayYellow).toBeCloseTo(mu, 2);

    expect(markets.totalOverUnder.map((l) => l.line)).toEqual([1.5, 2.5, 3.5, 4.5, 5.5, 6.5]);
    expect(markets.homeOverUnder.map((l) => l.line)).toEqual([1.5, 2.5]);
    expect(markets.awayOverUnder.map((l) => l.line)).toEqual([1.5, 2.5]);
    for (const l of [...markets.totalOverUnder, ...markets.homeOverUnder, ...markets.awayOverUnder]) {
      expect(l.over + l.under).toBeCloseTo(1, 10);
      expect(l.over).toBeGreaterThanOrEqual(0);
      expect(l.over).toBeLessThanOrEqual(1);
    }
  });

  it("higher collect-tendency team is expected to get more yellows", () => {
    // Team 12 has the highest true ca, team 1 the lowest.
    const grid = predictCardsGrid(params, 12, 1);
    const markets = cardsGridToMarkets(grid);
    expect(markets.expectedHomeYellow).toBeGreaterThan(markets.expectedAwayYellow);
  });
});
